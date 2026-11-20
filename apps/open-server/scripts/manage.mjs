#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createUpdater } from "./update.mjs";

const execute = promisify(execFile);
const nativeVersion = "1.19.5";
const apiUnit = "opennest.service";
const nativeUnit = "opennest-daemon.service";

function quoted(value, dollars = false) {
  const text = String(value);
  if (/[\r\n\0]/.test(text)) throw new Error("Service values must be single-line");
  return JSON.stringify(text.replaceAll("%", "%%").replaceAll("$", () => (dollars ? "$$" : "$")));
}

function envValue(value) {
  if (/[\r\n\0]/.test(String(value))) throw new Error("Environment values must be single-line");
  return JSON.stringify(String(value));
}

function directoryValue(value) {
  if (/[\r\n\0]/.test(String(value))) throw new Error("Service paths must be single-line");
  return String(value).replaceAll("%", "%%");
}

export function parseEnvironment(source) {
  const env = {};
  for (const line of source.split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    try {
      env[match[1]] = match[2].startsWith('"') ? JSON.parse(match[2]) : match[2];
    } catch {
      throw new Error("OpenNest configuration contains an invalid environment value");
    }
  }
  return env;
}

export function paths(env = process.env) {
  const home = env.HOME || homedir();
  const config = resolve(
    env.OPENNEST_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, ".config"), "opennest"),
  );
  return {
    config,
    env: join(config, "server.env"),
    token: join(config, "token"),
    root: join(env.XDG_DATA_HOME || join(home, ".local/share"), "opennest"),
    units: join(env.XDG_CONFIG_HOME || join(home, ".config"), "systemd/user"),
    bin: join(home, ".local/bin"),
    home,
  };
}

export function serviceUnits({ configuration, release, node, home }) {
  const environment = `EnvironmentFile=${directoryValue(configuration)}\n`;
  const common = "Restart=on-failure\nRestartSec=3\nTimeoutStopSec=30\nUMask=0077\n";
  return {
    [nativeUnit]:
      `[Unit]\nDescription=OpenNest OpenCode runtime\nAfter=network-online.target\n\n[Service]\nType=exec\n` +
      environment +
      `WorkingDirectory=${directoryValue(home)}\nExecStart=${quoted(node, true)} ${quoted(join(release, "apps/open-server/dist/native.js"), true)}\n` +
      common +
      "\n[Install]\nWantedBy=default.target\n",
    [apiUnit]:
      `[Unit]\nDescription=OpenNest API\nAfter=network-online.target ${nativeUnit}\nWants=${nativeUnit}\n\n[Service]\nType=exec\n` +
      environment +
      `ExecStart=${quoted(node, true)} ${quoted(join(release, "apps/open-server/dist/index.js"), true)}\n` +
      common +
      "\n[Install]\nWantedBy=default.target\n",
    "opennest-update.service":
      "[Unit]\nDescription=Update qualified OpenNest API\nAfter=network-online.target\n\n[Service]\nType=oneshot\n" +
      environment +
      `ExecStart=${quoted(node, true)} ${quoted(join(release, "apps/open-server/scripts/manage.mjs"), true)} update-worker\n` +
      `ExecStopPost=${quoted(node, true)} ${quoted(join(release, "apps/open-server/scripts/manage.mjs"), true)} recover-update\n` +
      "TimeoutStartSec=30min\nTimeoutStopSec=120\nUMask=0077\n",
    "opennest-recovery.service":
      "[Unit]\nDescription=Recover and restart OpenNest API\nConflicts=opennest-update.service\nAfter=opennest-update.service\n\n[Service]\nType=oneshot\n" +
      environment +
      `ExecStart=${quoted(node, true)} ${quoted(join(release, "apps/open-server/scripts/manage.mjs"), true)} recover-update --restart-api\n` +
      "TimeoutStartSec=180\nUMask=0077\n",
  };
}

async function exists(path) {
  return lstat(path).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
}

async function atomicFile(path, content, mode = 0o600) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode });
  await rename(temporary, path);
}

export function createManager({ env = process.env, run = execute, fetcher = fetch } = {}) {
  const location = paths(env);
  const systemctl = (args) => run("systemctl", ["--user", ...args], { timeout: 15_000 });

  async function configuration() {
    const metadata = await lstat(location.env);
    if (!metadata.isFile() || metadata.mode & 0o077)
      throw new Error("OpenNest server.env must be a private regular file (0600)");
    return parseEnvironment(await readFile(location.env, "utf8"));
  }

  async function token() {
    const metadata = await lstat(location.token);
    if (!metadata.isFile() || metadata.mode & 0o077)
      throw new Error("OpenNest token must be a private regular file (0600)");
    const value = (await readFile(location.token, "utf8")).trim();
    if (value.length < 32 || /\s/.test(value)) throw new Error("Invalid OpenNest token");
    return value;
  }

  async function api(route, body) {
    const config = await configuration();
    const port = Number(config.OPENNEST_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Invalid OpenNest API port");
    const response = await fetcher(`http://127.0.0.1:${port}/api/v1/${route}`, {
      headers: {
        authorization: `Bearer ${await token()}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined
        ? {}
        : {
            method: "POST",
            body: JSON.stringify(body),
          }),
      signal: AbortSignal.timeout(body === undefined ? 2_000 : 35_000),
    });
    if (!response.ok) throw new Error("OpenNest API is unavailable");
    return response.json();
  }

  async function waitHealthy() {
    const config = await configuration();
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try {
        const health = await api("health");
        if (
          health.app === "opennest" &&
          health.provider === "open" &&
          health.status === "ok" &&
          health.recoveryState === "ready" &&
          health.serverVersion === config.OPENNEST_VERSION &&
          health.restartProtocolVersion === 1 &&
          health.appServer?.state === "ready" &&
          health.appServer.installedVersion ===
            (config.OPENNEST_RUNTIME === "claude" ? "2.1.289" : nativeVersion)
        )
          return;
      } catch {
        // An unavailable API is not considered ready.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(
      "OpenNest did not become ready within 60 seconds; installation is not qualified",
    );
  }

  async function ensureStopped() {
    for (const unit of [apiUnit, nativeUnit]) {
      try {
        await systemctl(["is-active", unit]);
      } catch (error) {
        if ([3, 4].includes(error.code)) continue;
        throw new Error("Cannot inspect the systemd user manager", { cause: error });
      }
      throw new Error(`${unit} is running; setup does not replace a running installation`);
    }
  }

  async function executable(name) {
    const candidates = name.includes("/")
      ? [resolve(name)]
      : (env.PATH || "").split(delimiter).map((directory) => join(directory, name));
    for (const candidate of candidates) {
      try {
        await access(candidate, constants.X_OK);
        return await realpath(candidate);
      } catch {
        // Try the next executable path.
      }
    }
    throw new Error("Install OpenCode or set OPENNEST_OPENCODE_BIN first");
  }

  async function verifyRelease(target) {
    if (!target) throw new Error("--release /absolute/immutable/git-checkout is required");
    const release = await realpath(target);
    await access(join(release, "apps/open-server/dist/index.js"));
    await access(join(release, "apps/open-server/dist/native.js"));
    await access(join(release, "apps/open-server/dist/plugin.js"));
    const html = await readFile(join(release, "apps/client/dist-open/index.html"), "utf8");
    if (!/<title>OpenNest<\/title>/.test(html) || !/data-application=["']opennest["']/.test(html))
      throw new Error("Release must contain the OpenNest client build");
    const { stdout: changes } = await run(
      "git",
      ["-C", release, "status", "--porcelain", "--untracked-files=no"],
      { timeout: 15_000 },
    );
    if (changes.trim()) throw new Error("Release must have no tracked modifications");
    let detached = false;
    try {
      await run("git", ["-C", release, "symbolic-ref", "-q", "HEAD"], { timeout: 15_000 });
    } catch (error) {
      if (error.code !== 1)
        throw new Error("Cannot inspect release Git identity", { cause: error });
      detached = true;
    }
    if (!detached) throw new Error("Use a detached immutable Git checkout for a release");
    const { stdout } = await run("git", ["-C", release, "rev-parse", "HEAD"], {
      timeout: 15_000,
    });
    const commit = stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Invalid release Git identity");
    return { release, commit };
  }

  async function setup(target, start = false) {
    const { release, commit } = await verifyRelease(target);
    await ensureStopped();
    if ((await exists(join(location.root, "current"))) || (await exists(location.env)))
      throw new Error("OpenNest is already configured; use its qualified updater");
    const ownedFiles = [
      ...Object.keys(
        serviceUnits({
          configuration: location.env,
          release,
          node: process.execPath,
          home: location.home,
        }),
      ).map((name) => join(location.units, name)),
      join(location.bin, "opennest"),
    ];
    for (const path of ownedFiles)
      if (await exists(path))
        throw new Error(
          "OpenNest service or command files already exist; setup does not overwrite them",
        );
    await access("/usr/bin/bwrap", constants.X_OK).catch(() => {
      throw new Error(
        "Install bubblewrap (/usr/bin/bwrap) before configuring OpenNest Team isolation",
      );
    });
    const binary = await executable(env.OPENNEST_OPENCODE_BIN || "opencode");
    const { stdout } = await run(binary, ["--version"], { timeout: 15_000 });
    if (stdout.trim().replace(/^v/, "") !== nativeVersion)
      throw new Error(`This OpenNest candidate requires OpenCode ${nativeVersion}`);
    const apiPort = Number(env.OPENNEST_PORT || 4313);
    const native = new URL(env.OPENNEST_NATIVE_URL || "http://127.0.0.1:4097");
    const nativePort = Number(native.port || 80);
    if (
      native.protocol !== "http:" ||
      native.hostname !== "127.0.0.1" ||
      native.pathname !== "/" ||
      native.search ||
      native.hash ||
      native.username ||
      native.password ||
      !Number.isInteger(nativePort) ||
      nativePort < 1 ||
      nativePort > 65535 ||
      !Number.isInteger(apiPort) ||
      apiPort < 1 ||
      apiPort > 65535 ||
      apiPort === nativePort
    )
      throw new Error("Use distinct API/native ports and an http://127.0.0.1:PORT native URL");
    const node = await realpath(env.OPENNEST_NODE_BIN || process.execPath);
    const { stdout: nodeVersion } = await run(node, ["--version"], { timeout: 15_000 });
    if (!/^v24\./.test(nodeVersion.trim())) throw new Error("OpenNest requires Node.js 24");
    const runtimeMode = env.OPENNEST_RUNTIME;
    if (runtimeMode !== undefined && runtimeMode !== "opencode" && runtimeMode !== "claude")
      throw new Error("Unsupported OpenNest runtime");
    const claudeBin = env.OPENNEST_CLAUDE_BIN || "claude";
    if (runtimeMode === "claude") {
      const { stdout } = await run(claudeBin, ["--version"], { timeout: 15_000 });
      if (stdout.trim().split(/\s+/)[0] !== "2.1.289")
        throw new Error("OpenNest requires Claude Code 2.1.289");
      await access(join(release, "apps/open-server/dist/claude-runner.js"));
    }
    const state = resolve(
      env.OPENNEST_STATE_DIR ||
        join(env.XDG_STATE_HOME || join(location.home, ".local/state"), "opennest"),
    );
    const runtime = resolve(
      env.OPENNEST_RUNTIME_DIR ||
        join(env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`, "opennest"),
    );
    for (const directory of [location.config, location.root, state, runtime]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }
    await mkdir(location.units, { recursive: true });
    await mkdir(location.bin, { recursive: true });
    let tokenCreated = false;
    let servicesStarted = false;
    const created = [];
    try {
      try {
        await writeFile(location.token, randomBytes(32).toString("hex") + "\n", {
          flag: "wx",
          mode: 0o600,
        });
        tokenCreated = true;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      await token();
      const values = {
        OPENNEST_CONFIG_DIR: location.config,
        OPENNEST_STATE_DIR: state,
        OPENNEST_RUNTIME_DIR: runtime,
        OPENNEST_EVENT_SOCKET: resolve(
          env.OPENNEST_EVENT_SOCKET || join(runtime, "native-events.sock"),
        ),
        OPENNEST_RELEASE_PATH: release,
        OPENNEST_VERSION: env.OPENNEST_VERSION || `0.1.9-${commit.slice(0, 7)}`,
        OPENNEST_MANAGED_INSTALL: "1",
        ...(runtimeMode ? { OPENNEST_RUNTIME: runtimeMode } : {}),
        ...(runtimeMode === "claude" ? { OPENNEST_CLAUDE_BIN: claudeBin } : {}),
        OPENNEST_PORT: String(apiPort),
        OPENNEST_HOST: env.OPENNEST_HOST || "127.0.0.1",
        OPENNEST_NATIVE_URL: native.origin,
        OPENNEST_OPENCODE_BIN: binary,
        OPENNEST_NODE_BIN: node,
        OPENCODE_SERVER_USERNAME: "opencode",
        OPENCODE_SERVER_PASSWORD: randomBytes(32).toString("hex"),
        ...(env.OPENNEST_NATIVE_DATABASE_PATH
          ? { OPENNEST_NATIVE_DATABASE_PATH: env.OPENNEST_NATIVE_DATABASE_PATH }
          : {}),
        OPENNEST_UPDATE_MANIFEST_URL:
          env.OPENNEST_UPDATE_MANIFEST_URL ||
          "https://github.com/petrovichest/nest-apps/releases/download/opennest-latest/OpenNest-latest.json",
        ...(env.OPENNEST_REPOSITORY_URL
          ? { OPENNEST_REPOSITORY_URL: env.OPENNEST_REPOSITORY_URL }
          : {}),
        ...(env.PATH ? { PATH: env.PATH } : {}),
        ...(env.OPENNEST_ALLOWED_ORIGINS
          ? { OPENNEST_ALLOWED_ORIGINS: env.OPENNEST_ALLOWED_ORIGINS }
          : {}),
      };
      for (const key of [
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
        "XDG_CACHE_HOME",
        "XDG_RUNTIME_DIR",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
        "NODE_EXTRA_CA_CERTS",
        "SSL_CERT_FILE",
        "CURL_CA_BUNDLE",
        "GIT_SSL_CAINFO",
      ])
        if (env[key]) values[key] = env[key];
      created.push(location.env);
      await atomicFile(
        location.env,
        Object.entries(values)
          .map(([key, value]) => `${key}=${envValue(value)}`)
          .join("\n") + "\n",
      );
      for (const [name, content] of Object.entries(
        serviceUnits({
          configuration: location.env,
          release,
          node,
          binary,
          nativePort,
          home: location.home,
        }),
      )) {
        const path = join(location.units, name);
        created.push(path);
        await atomicFile(path, content);
      }
      const temporary = join(location.root, `.current-${randomUUID()}`);
      await symlink(release, temporary);
      const current = join(location.root, "current");
      created.push(current);
      await rename(temporary, current);
      created.push(join(location.bin, "opennest"));
      await atomicFile(
        join(location.bin, "opennest"),
        await readFile(join(release, "deploy/opennest/opennest"), "utf8"),
        0o700,
      );
      await systemctl(["daemon-reload"]);
      if (start) {
        servicesStarted = true;
        await systemctl(["enable", "--now", nativeUnit, apiUnit]);
        await waitHealthy();
      }
      return {
        configDir: location.config,
        tokenPath: location.token,
        port: apiPort,
        started: start,
      };
    } catch (error) {
      try {
        if (servicesStarted) await systemctl(["disable", "--now", apiUnit, nativeUnit]);
        for (const path of created.reverse()) await rm(path, { force: true });
        if (tokenCreated) await rm(location.token, { force: true });
        await systemctl(["daemon-reload"]);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "OpenNest setup failed and cleanup was not confirmed; configuration and diagnostics must be inspected before retrying",
          { cause: cleanupError },
        );
      }
      throw new Error(
        "OpenNest setup failed; its new services and configuration were removed so installation can be retried",
        { cause: error },
      );
    }
  }

  const updater = createUpdater({
    location,
    env,
    run,
    configuration,
    api,
    verifyRelease,
    apiUnitText: (release, node) =>
      serviceUnits({ configuration: location.env, release, node, home: location.home })[apiUnit],
  });
  return {
    setup,
    ...updater,
    async queueUpdate() {
      const configured = await configuration();
      const current = await verifyRelease(join(location.root, "current"));
      if (configured.OPENNEST_RELEASE_PATH !== current.release)
        throw new Error("OpenNest is already switching releases");
      const units = serviceUnits({
        configuration: location.env,
        release: current.release,
        node: configured.OPENNEST_NODE_BIN,
        home: location.home,
      });
      const updaterUnits = ["opennest-update.service", "opennest-recovery.service"];
      const changes = [];
      for (const unit of updaterUnits) {
        const path = join(location.units, unit);
        if ((await readFile(path, "utf8")) !== units[unit]) changes.push(unit);
      }
      if (changes.length) {
        for (const unit of updaterUnits) {
          const { stdout } = await systemctl(["show", "--property=ActiveState", "--value", unit]);
          if (!["inactive", "failed"].includes(stdout.trim()))
            throw new Error("An OpenNest update or recovery is already active");
        }
        for (const unit of changes) await atomicFile(join(location.units, unit), units[unit]);
        await systemctl(["daemon-reload"]);
      }
      await systemctl(["start", "--no-block", "opennest-update.service"]);
    },
    async start() {
      await configuration();
      await systemctl(["start", nativeUnit, apiUnit]);
      await waitHealthy();
    },
    async restart() {
      await configuration();
      await systemctl(["restart", apiUnit]);
      await waitHealthy();
    },
    async stop() {
      await configuration();
      await systemctl(["stop", apiUnit, nativeUnit]);
    },
    async status() {
      return api("health");
    },
  };
}

export async function main(args = process.argv.slice(2)) {
  const command = args[0];
  const manager = createManager();
  if (command === "setup") {
    const position = args.indexOf("--release");
    const result = await manager.setup(
      position < 0 ? null : args[position + 1],
      args.includes("--start"),
    );
    process.stdout.write(
      `OpenNest configured. Owner token file: ${result.tokenPath}\nOpen http://127.0.0.1:${result.port}.\n`,
    );
  } else if (command === "check-update") {
    process.stdout.write(JSON.stringify(await manager.checkUpdate()) + "\n");
  } else if (command === "update-worker") {
    await manager.updateWorker();
  } else if (command === "recover-update") {
    await manager.recoverUpdate(args.includes("--restart-api"));
  } else if (command === "update") {
    await manager.queueUpdate();
  } else if (["start", "restart", "stop"].includes(command)) {
    await manager[command]();
    process.stdout.write(
      command === "restart"
        ? "OpenNest API restarted; its native runtime was preserved.\n"
        : `OpenNest ${command === "start" ? "started" : "stopped"}.\n`,
    );
  } else if (command === "status") {
    const health = await manager.status();
    process.stdout.write(JSON.stringify(health, null, 2) + "\n");
  } else
    throw new Error(
      "Usage: opennest setup --release PATH [--start] | start | restart | stop | status | check-update | update",
    );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const operation = async () => {
    if (
      [
        "setup",
        "start",
        "restart",
        "stop",
        "check-update",
        "update-worker",
        "recover-update",
      ].includes(args[0]) &&
      !args.includes("--locked")
    ) {
      const location = paths();
      await mkdir(location.config, { recursive: true, mode: 0o700 });
      await execute(
        "flock",
        [
          "--nonblock",
          "--conflict-exit-code",
          "75",
          join(location.config, "management.lock"),
          process.execPath,
          fileURLToPath(import.meta.url),
          ...args,
          "--locked",
        ],
        {
          timeout:
            args[0] === "update-worker"
              ? 30 * 60_000
              : args[0] === "recover-update"
                ? 180_000
                : 90_000,
        },
      ).then(({ stdout }) => process.stdout.write(stdout));
    } else await main(args);
  };
  operation().catch((error) => {
    // Only our already-sanitized one-line diagnostic may cross the flock boundary.
    const childMessage = args.includes("--locked")
      ? null
      : /^OpenNest: ([^\r\n]+)\n$/.exec(error.stderr || "")?.[1];
    const message =
      childMessage ||
      (typeof error.code === "number"
        ? error.code === 75
          ? "Another OpenNest management operation is running"
          : "OpenNest management failed; inspect its private service logs"
        : error.message);
    process.stderr.write(`OpenNest: ${message}\n`);
    process.exitCode = 1;
  });
}
