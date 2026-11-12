import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

assert.equal(process.getuid(), 17001);
assert.equal(process.env.HOME, "/home/nest-qualification");
const release = await realpath(process.argv[2]);
assert.ok(release.startsWith("/home/nest-qualification/.local/share/codexnest/releases/"));
const candidate = (await readFile("/qualification-input/candidate-sha", "utf8")).trim();
assert.equal((await readFile(join(release, ".codexnest-built"), "utf8")).trim(), candidate);
const version = `0.1.9-${candidate.slice(0, 7)}`;
const home = await mkdtemp("/home/nest-qualification/packaged-smoke-");
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_STATE_HOME: join(home, ".local/state"),
  XDG_CACHE_HOME: join(home, ".cache"),
  CLAUDE_CONFIG_DIR: join(home, ".claude"),
  DISABLE_AUTOUPDATER: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  AGY_CLI_DISABLE_AUTO_UPDATE: "true",
  NODE_USE_ENV_PROXY: "1",
};
for (const key of [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
])
  delete env[key];
for (const key of [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
])
  env[key] = "http://127.0.0.1:9";
env.NO_PROXY = env.no_proxy = "localhost,127.0.0.1,::1";

const exec = promisify(execFile);
const children = [];
const report = {
  candidate,
  version,
  scope: "unconfigured application startup; no model execution",
  applications: [],
};
function start(name, entry, extra) {
  const log = createWriteStream(`/qualification-private/${name}-smoke.log`, { mode: 0o600 });
  const child = spawn(process.execPath, [join(release, entry)], {
    cwd: release,
    env: { ...env, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const record = { name, child, error: null, exited: false };
  child.on("error", (error) => {
    record.error = error;
  });
  child.once("close", () => {
    record.exited = true;
    log.end();
  });
  children.push(record);
}

try {
  for (const provider of ["claude", "gemini"]) {
    const name = `${provider}nest`;
    const config = join(home, ".config", name);
    await mkdir(config, { recursive: true, mode: 0o700 });
    await writeFile(join(config, "token"), randomBytes(32).toString("hex"), { mode: 0o600 });
    const native =
      provider === "claude"
        ? "/opt/qualification/node_modules/.bin/claude"
        : "/opt/qualification/agy";
    const nativeVersion = (
      await exec(native, ["--version"], { env, timeout: 15_000 })
    ).stdout.trim();
    assert.ok(nativeVersion.includes(provider === "claude" ? "2.1.289" : "1.5.6"));
    const nativeSha256 = (
      await exec("sha256sum", [await realpath(native)], { timeout: 15_000 })
    ).stdout.split(" ")[0];
    const port = provider === "claude" ? 4311 : 4312;
    const prefix = name.toUpperCase();
    const extra = {
      [`${prefix}_RELEASE_PATH`]: release,
      [`${prefix}_VERSION`]: version,
      [`${prefix}_PORT`]: String(port),
      [`${prefix}_HOST`]: "127.0.0.1",
      [`${prefix}_MANAGED_INSTALL`]: "0",
      [`${prefix}_RUNTIME_DIR`]: join(home, "run", provider[0]),
      ...(provider === "claude"
        ? { CLAUDENEST_CLAUDE_BIN: native }
        : { GEMININEST_AGY_BIN: native }),
    };
    const started = Date.now();
    if (provider === "gemini")
      start("gemininest-daemon", "apps/gemini-server/dist/daemon.js", extra);
    start(name, `apps/${provider}-server/dist/index.js`, extra);
    let health;
    while (Date.now() - started < 60_000) {
      for (const process of children) {
        assert.ifError(process.error);
        assert.ok(!process.exited, `${process.name} exited before startup completed`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok) health = await response.json();
      } catch {
        /* A real service is still starting. */
      }
      if (health?.recoveryState === "ready") break;
      await delay(100);
    }
    assert.equal(health?.status, "ok");
    assert.equal(health.app, name);
    assert.equal(health.provider, provider);
    assert.equal(health.serverVersion, version);
    assert.equal(health.recoveryState, "ready");
    assert.equal(health.transport, "daemon");
    assert.equal(health.appServer?.state, "ready");
    if (provider === "gemini") assert.ok(health.appServer.installedVersion?.includes("1.5.6"));
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    assert.ok(
      (await response.text()).includes(
        `<title>${provider === "claude" ? "ClaudeNest" : "GeminiNest"}</title>`,
      ),
    );
    report.applications.push({
      name,
      nativeVersion,
      nativeSha256,
      startupMs: Date.now() - started,
      uiServed: true,
    });
  }
  await writeFile(
    "/qualification-output/packaged-smoke.json",
    JSON.stringify(report, null, 2) + "\n",
  );
} finally {
  for (const { child, exited } of children.toReversed()) {
    if (exited) continue;
    const closed = new Promise((resolve) => child.once("close", resolve));
    child.kill("SIGTERM");
    await Promise.race([closed, delay(5000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await closed;
    }
  }
}
