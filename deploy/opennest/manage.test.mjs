import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createManager,
  parseEnvironment,
  paths,
  serviceUnits,
} from "../../apps/open-server/scripts/manage.mjs";
import { manifestCandidate } from "../../apps/open-server/scripts/update.mjs";

const commit = "1234567890abcdef1234567890abcdef12345678";

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "opennest-manager-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const release = join(home, "release");
  for (const directory of ["apps/open-server/dist", "apps/client/dist-open", "deploy/opennest"])
    await mkdir(join(release, directory), { recursive: true });
  await writeFile(join(release, "apps/open-server/dist/index.js"), "");
  await writeFile(join(release, "apps/open-server/dist/native.js"), "");
  await writeFile(join(release, "apps/open-server/dist/plugin.js"), "");
  await writeFile(
    join(release, "apps/client/dist-open/index.html"),
    '<html data-application="opennest"><title>OpenNest</title></html>',
  );
  await writeFile(join(release, "deploy/opennest/opennest"), "#!/bin/sh\n");
  const binary = join(home, "opencode");
  await writeFile(binary, "#!/bin/sh\n", { mode: 0o700 });
  const env = {
    HOME: home,
    PATH: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_STATE_HOME: join(home, "state"),
    XDG_RUNTIME_DIR: join(home, "run"),
    OPENNEST_OPENCODE_BIN: binary,
    OPENNEST_NODE_BIN: process.execPath,
  };
  const calls = [];
  const run = async (command, args) => {
    calls.push({ command, args });
    if (command === "systemctl" && args.includes("is-active"))
      throw Object.assign(new Error("inactive"), { code: 3 });
    if (command === "git" && args.includes("symbolic-ref"))
      throw Object.assign(new Error("detached"), { code: 1 });
    return {
      stdout:
        command === binary
          ? "1.19.5\n"
          : command === process.execPath
            ? process.version
            : args.includes("rev-parse")
              ? commit
              : "",
      stderr: "",
    };
  };
  let requests = 0;
  const fetcher = async () => {
    requests++;
    return new Response(
      JSON.stringify({
        app: "opennest",
        provider: "open",
        status: "ok",
        recoveryState: "ready",
        serverVersion: "0.1.9-1234567",
        restartProtocolVersion: 1,
        appServer: { state: "ready", installedVersion: "1.19.5" },
      }),
    );
  };
  return {
    home,
    release,
    env,
    calls,
    run,
    fetcher,
    manager: createManager({ env, run, fetcher }),
    requests: () => requests,
  };
}

test("setup writes private credentials and independent services without starting either", async (t) => {
  const f = await fixture(t);
  const result = await f.manager.setup(f.release);
  const location = paths(f.env);
  const config = parseEnvironment(await readFile(location.env, "utf8"));
  assert.equal(config.OPENNEST_NATIVE_URL, "http://127.0.0.1:4097");
  assert.equal(config.OPENNEST_VERSION, "0.1.9-1234567");
  assert.equal(config.OPENNEST_PORT, "4313");
  assert.equal(
    config.OPENNEST_UPDATE_MANIFEST_URL,
    "https://github.com/petrovichest/nest-apps/releases/download/opennest-latest/OpenNest-latest.json",
  );
  assert.equal(
    config.OPENNEST_EVENT_SOCKET,
    join(config.OPENNEST_RUNTIME_DIR, "native-events.sock"),
  );
  assert.equal(config.XDG_DATA_HOME, f.env.XDG_DATA_HOME);
  assert.equal(config.XDG_CONFIG_HOME, f.env.XDG_CONFIG_HOME);
  assert.equal(config.OPENCODE_SERVER_PASSWORD.length, 64);
  const token = (await readFile(location.token, "utf8")).trim();
  assert.equal(token.length, 64);
  assert.notEqual(token, config.OPENCODE_SERVER_PASSWORD);
  assert.equal((await stat(location.env)).mode & 0o777, 0o600);
  assert.equal((await stat(location.token)).mode & 0o777, 0o600);
  assert.equal(result.started, false);
  assert.equal(f.requests(), 0);
  assert.deepEqual(
    f.calls.filter((c) => c.command === "systemctl").map((c) => c.args),
    [
      ["--user", "is-active", "opennest.service"],
      ["--user", "is-active", "opennest-daemon.service"],
      ["--user", "daemon-reload"],
    ],
  );
  const native = await readFile(join(location.units, "opennest-daemon.service"), "utf8");
  const api = await readFile(join(location.units, "opennest.service"), "utf8");
  assert.ok(native.includes("apps/open-server/dist/native.js"));
  assert.ok(!native.includes(" serve "));
  assert.ok(!native.includes(config.OPENCODE_SERVER_PASSWORD));
  assert.ok(!api.includes(token));
  assert.ok(!native.includes("PartOf="));
  assert.ok(!api.includes("BindsTo="));
  await assert.rejects(f.manager.setup(f.release), /already configured/);
  assert.equal((await readFile(location.token, "utf8")).trim(), token);
});

test("API restart preserves the native service and verifies the expected application identity", async (t) => {
  const f = await fixture(t);
  await f.manager.setup(f.release);
  f.calls.length = 0;
  await f.manager.restart();
  assert.deepEqual(f.calls, [
    { command: "systemctl", args: ["--user", "restart", "opennest.service"] },
  ]);
  assert.equal(f.requests(), 1);
});

test("setup refuses an active installation before writing any credentials", async (t) => {
  const f = await fixture(t);
  const manager = createManager({
    env: f.env,
    run: async (command, args, options) =>
      command === "systemctl" ? { stdout: "active", stderr: "" } : f.run(command, args, options),
  });
  await assert.rejects(manager.setup(f.release), /is running/);
  await assert.rejects(readFile(paths(f.env).env), { code: "ENOENT" });
});

test("setup refuses an unsupported native version and unsafe native URLs before configuration", async (t) => {
  const f = await fixture(t);
  const wrongVersion = createManager({
    env: f.env,
    run: async (command, args, options) =>
      command === f.env.OPENNEST_OPENCODE_BIN
        ? { stdout: "1.20.0", stderr: "" }
        : f.run(command, args, options),
  });
  await assert.rejects(wrongVersion.setup(f.release), /requires OpenCode 1.19.5/);
  for (const url of [
    "http://0.0.0.0:4097",
    "http://127.0.0.1:4313",
    "http://user:secret@127.0.0.1:4097",
    "https://127.0.0.1:4097",
    "http://127.0.0.1:4097/path",
  ]) {
    const manager = createManager({ env: { ...f.env, OPENNEST_NATIVE_URL: url }, run: f.run });
    await assert.rejects(manager.setup(f.release), /distinct API\/native ports/);
  }
  await assert.rejects(readFile(paths(f.env).env), { code: "ENOENT" });
});

test("status rejects nonprivate authentication instead of making a request", async (t) => {
  const f = await fixture(t);
  await f.manager.setup(f.release);
  await chmod(paths(f.env).token, 0o644);
  await assert.rejects(f.manager.status(), /private regular file/);
  assert.equal(f.requests(), 0);
});

test("setup rejects an unsupported Node runtime before writing credentials", async (t) => {
  const f = await fixture(t);
  const manager = createManager({
    env: f.env,
    run: async (command, args, options) =>
      command === process.execPath
        ? { stdout: "v22.0.0\n", stderr: "" }
        : f.run(command, args, options),
  });
  await assert.rejects(manager.setup(f.release), /requires Node.js 24/);
  await assert.rejects(readFile(paths(f.env).env), { code: "ENOENT" });
});

test("status refuses a malformed port before sending the bearer token", async (t) => {
  const f = await fixture(t);
  await f.manager.setup(f.release);
  const location = paths(f.env);
  const source = await readFile(location.env, "utf8");
  await writeFile(
    location.env,
    source.replace('OPENNEST_PORT="4313"', 'OPENNEST_PORT="4313@example.com"'),
    { mode: 0o600 },
  );
  await assert.rejects(f.manager.status(), /Invalid OpenNest API port/);
  assert.equal(f.requests(), 0);
});

test("unit quoting protects literal percent/dollar paths and rejects newlines", () => {
  const units = serviceUnits({
    configuration: "/tmp/test%/server.env",
    release: "/tmp/release$X",
    node: "/tmp/node%$",
    binary: "/tmp/bin%$",
    nativePort: 4097,
    home: "/tmp/a b",
  });
  assert.ok(units["opennest.service"].includes('"/tmp/node%%$$"'));
  assert.ok(units["opennest.service"].includes('"/tmp/release$$X/apps/open-server/dist/index.js"'));
  assert.ok(units["opennest-daemon.service"].includes("WorkingDirectory=/tmp/a b\n"));
  assert.ok(units["opennest.service"].includes("EnvironmentFile=/tmp/test%%/server.env\n"));
  assert.throws(
    () =>
      serviceUnits({
        configuration: "bad\npath",
        release: "/tmp",
        node: "/node",
        binary: "/native",
        nativePort: 4097,
        home: "/tmp",
      }),
    /single-line/,
  );
});

test("legacy manifests cannot qualify OpenNest implicitly", async () => {
  assert.equal(manifestCandidate({ schemaVersion: 1, version: "0.1.9-1234567", commit }), null);
  assert.throws(() => parseEnvironment('SECRET="bad secret'), /invalid environment value/);
});

test("failed first startup removes only its own service/configuration files and can be retried", async (t) => {
  const f = await fixture(t);
  const location = paths(f.env);
  await mkdir(location.config, { recursive: true });
  await writeFile(join(location.config, "connection.json"), '{"version":1,"proxy":null}');
  await mkdir(join(f.home, "state/opennest"), { recursive: true });
  await writeFile(join(f.home, "state/opennest/owner-state"), "preserved");
  let failed = false;
  const manager = createManager({
    env: f.env,
    fetcher: f.fetcher,
    run: async (command, args, options) => {
      const response = await f.run(command, args, options);
      if (!failed && command === "systemctl" && args.includes("enable")) {
        failed = true;
        throw new Error("controlled initial start failure");
      }
      return response;
    },
  });
  await assert.rejects(manager.setup(f.release, true), /installation can be retried/);
  for (const path of [
    location.env,
    location.token,
    join(location.root, "current"),
    join(location.bin, "opennest"),
    ...Object.keys(
      serviceUnits({
        configuration: location.env,
        release: f.release,
        node: process.execPath,
        home: f.home,
      }),
    ).map((name) => join(location.units, name)),
  ])
    await assert.rejects(readFile(path), { code: "ENOENT" });
  assert.equal(
    await readFile(join(location.config, "connection.json"), "utf8"),
    '{"version":1,"proxy":null}',
  );
  assert.equal(await readFile(join(f.home, "state/opennest/owner-state"), "utf8"), "preserved");
  assert.ok(
    f.calls.some(
      (call) =>
        call.command === "systemctl" &&
        call.args.join(" ") === "--user disable --now opennest.service opennest-daemon.service",
    ),
  );
  await manager.setup(f.release, true);
  assert.equal((await manager.status()).recoveryState, "ready");
});

test("first setup preserves a pre-existing private token when startup fails", async (t) => {
  const f = await fixture(t),
    location = paths(f.env);
  await mkdir(location.config, { recursive: true });
  const token = "fixture-private-owner-token".repeat(3);
  await writeFile(location.token, token, { mode: 0o600 });
  const manager = createManager({
    env: f.env,
    fetcher: f.fetcher,
    run: async (command, args, options) => {
      const response = await f.run(command, args, options);
      if (command === "systemctl" && args.includes("enable"))
        throw new Error("controlled startup failure");
      return response;
    },
  });
  await assert.rejects(manager.setup(f.release, true), /installation can be retried/);
  assert.equal(await readFile(location.token, "utf8"), token);
});

test("setup refuses to overwrite existing inactive service or command files", async (t) => {
  const f = await fixture(t),
    location = paths(f.env);
  await mkdir(location.units, { recursive: true });
  const path = join(location.units, "opennest-daemon.service");
  await writeFile(path, "owner-defined service");
  await assert.rejects(f.manager.setup(f.release), /does not overwrite/);
  assert.equal(await readFile(path, "utf8"), "owner-defined service");
  await assert.rejects(readFile(location.token), { code: "ENOENT" });
});

test("managed services preserve explicit TLS trust configuration", async (t) => {
  const f = await fixture(t);
  const manager = createManager({
    env: {
      ...f.env,
      NODE_EXTRA_CA_CERTS: "/fixture/ca.pem",
      SSL_CERT_FILE: "/fixture/ca.pem",
      CURL_CA_BUNDLE: "/fixture/ca.pem",
      GIT_SSL_CAINFO: "/fixture/ca.pem",
    },
    run: f.run,
    fetcher: f.fetcher,
  });
  await manager.setup(f.release);
  const config = parseEnvironment(await readFile(paths(f.env).env, "utf8"));
  for (const key of ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO"])
    assert.equal(config[key], "/fixture/ca.pem");
});
