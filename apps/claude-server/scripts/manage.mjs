#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  realpath,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const configRoot = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "claudenest");
const envPath = join(configRoot, "server.env");
const tokenPath = join(configRoot, "token");
const root = join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "claudenest");
const serviceDirectory = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "systemd/user",
);
try {
  process.loadEnvFile(envPath);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const statusPath = join(
  process.env.CLAUDENEST_STATE_DIR ||
    join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "claudenest"),
  "update.json",
);
const repository =
  process.env.CLAUDENEST_REPOSITORY_URL || "https://github.com/petrovichest/nest-apps.git";
const manifestUrl =
  process.env.CLAUDENEST_UPDATE_MANIFEST_URL ||
  "https://github.com/petrovichest/nest-apps/releases/download/rolling-latest/NestApps-latest.json";
const command = process.argv[2];
const releaseArg = process.argv.indexOf("--release");
const release = releaseArg >= 0 ? await realpath(process.argv[releaseArg + 1]) : undefined;
const quote = (value) => {
  if (/[\r\n]/.test(value)) throw new Error("Environment values must be single-line");
  return JSON.stringify(String(value));
};
const unitQuote = (value) => quote(value.replaceAll("%", "%%"));
const executableQuote = (value) => unitQuote(value.replaceAll("$", "$$"));
// WorkingDirectory takes one literal path; unlike ExecStart it does not unquote.
const directoryValue = (value) => {
  if (/[\r\n]/.test(value)) throw new Error("Service paths must be single-line");
  return value.replaceAll("%", "%%");
};

async function configuration() {
  const values = {};
  const lines = (await readFile(envPath, "utf8")).split("\n");
  for (const line of lines) {
    const match = /^([A-Z_a-z][A-Z_a-z0-9]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    values[match[1]] = match[2].startsWith('"') ? JSON.parse(match[2]) : match[2];
  }
  return values;
}
async function api(route, body) {
  const env = await configuration();
  const token = (await readFile(env.CLAUDENEST_TOKEN_FILE || tokenPath, "utf8")).trim();
  const response = await fetch(`http://127.0.0.1:${env.CLAUDENEST_PORT || 4311}/api/v1/${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message || "ClaudeNest API request failed");
  return value;
}
async function setRelease(target, paused = false) {
  const env = await readFile(envPath, "utf8");
  const version = /^v?\d+\.\d+\.\d+(-[0-9a-f]{7})?$/.test(basename(target))
    ? basename(target).replace(/^v/, "")
    : "0.1.0";
  const replacement = `CLAUDENEST_VERSION=${quote(version)}\nCLAUDENEST_MANAGED_INSTALL="1"\nCLAUDENEST_RELEASE_PATH=${quote(target)}\nCLAUDENEST_RUNNER_PATH=${quote(join(target, "apps/claude-server/dist/runner-main.js"))}\nCLAUDENEST_START_PAUSED=${quote(paused ? "1" : "0")}`;
  const cleaned = env
    .split("\n")
    .filter(
      (line) =>
        !/^CLAUDENEST_(VERSION|MANAGED_INSTALL|RELEASE_PATH|RUNNER_PATH|START_PAUSED)=/.test(line),
    )
    .join("\n");
  const temporaryEnv = `${envPath}.${randomUUID()}.tmp`;
  await writeFile(temporaryEnv, `${cleaned.trimEnd()}\n${replacement}\n`, { mode: 0o600 });
  await rename(temporaryEnv, envPath);
  const temporary = join(root, `.current-${randomUUID()}`);
  await symlink(target, temporary);
  await rename(temporary, join(root, "current"));
}
async function verifyRelease(target) {
  if (!target) throw new Error("--release /absolute/immutable/git-checkout is required");
  await readFile(join(target, "apps/claude-server/dist/index.js"));
  await readFile(join(target, "apps/claude-server/dist/runner-main.js"));
  await readFile(join(target, "apps/client/dist-claude/index.html"));
  const { stdout: changes } = await exec("git", [
    "-C",
    target,
    "status",
    "--porcelain",
    "--untracked-files=no",
  ]);
  if (changes.trim()) throw new Error("Release checkout must have no tracked modifications");
  try {
    await exec("git", ["-C", target, "symbolic-ref", "-q", "HEAD"]);
    throw new Error("Use a detached immutable Git worktree for a release");
  } catch (error) {
    if (error.code !== 1) throw error;
  }
}
async function waitHealthy(target, recoveryState = "ready") {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const value = await api("health");
      if (value.recoveryState === recoveryState && value.releasePath === target) return;
    } catch {
      /* Restart still in progress. */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("ClaudeNest did not recover readiness");
}

async function supportedProtocols(target) {
  const manifest = JSON.parse(
    await readFile(join(target, "apps/claude-server/runner-protocol.json"), "utf8"),
  );
  if (
    !Array.isArray(manifest.supportedRunnerProtocols) ||
    !manifest.supportedRunnerProtocols.every(Number.isInteger)
  )
    throw new Error("Invalid runner protocol manifest");
  return manifest.supportedRunnerProtocols;
}
async function executable(name) {
  const candidates = name.includes("/")
    ? [resolve(name)]
    : (process.env.PATH || "").split(delimiter).map((directory) => join(directory, name));
  for (const candidate of candidates) {
    try {
      await access(candidate, 1);
      return await realpath(candidate);
    } catch {
      /* Try next PATH entry. */
    }
  }
  throw new Error("Installed Claude executable was not found");
}

async function writeService() {
  await mkdir(serviceDirectory, { recursive: true });
  const nodeBin = await realpath(process.execPath);
  const service = `[Unit]\nDescription=ClaudeNest API and web client (session services remain independent)\nAfter=network-online.target\n\n[Service]\nType=exec\nWorkingDirectory=${directoryValue(join(root, "current"))}\nEnvironmentFile=${directoryValue(envPath)}\nExecStart=${executableQuote(nodeBin)} ${executableQuote(join(root, "current/apps/claude-server/dist/index.js"))}\nRestart=on-failure\nRestartSec=2\nTimeoutStopSec=45\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
  await writeFile(join(serviceDirectory, "claudenest.service"), service, { mode: 0o600 });
  const cliDirectory = join(homedir(), ".local/bin");
  // XDG_DATA_HOME can relocate an isolated install; its CLI stays under that root.
  const cli = process.env.XDG_DATA_HOME
    ? join(root, "bin/claudenest")
    : join(cliDirectory, "claudenest");
  await mkdir(resolve(cli, ".."), { recursive: true });
  await copyFile(join(await realpath(join(root, "current")), "deploy/claudenest/claudenest"), cli);
  await chmod(cli, 0o755);
  const updater = `[Unit]\nDescription=Update ClaudeNest from its published release\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=oneshot\nEnvironmentFile=${directoryValue(envPath)}\nEnvironment=CLAUDENEST_NODE_BIN=${unitQuote(nodeBin)}\nExecStart=${executableQuote(cli)} update-worker\nTimeoutStartSec=30min\nNoNewPrivileges=true\nPrivateTmp=true\nUMask=0077\n`;
  await writeFile(join(serviceDirectory, "claudenest-update.service"), updater, { mode: 0o600 });
  await exec("systemctl", ["--user", "daemon-reload"]);
}

async function updateRelease(target) {
  await verifyRelease(target);
  const old = await realpath(join(root, "current"));
  const targetProtocols = await supportedProtocols(target);
  const oldProtocols = await supportedProtocols(old);
  const preflight = await api("internal/restart/prepare", {
    supportedRunnerProtocols: targetProtocols,
  });
  if (!preflight.supportedRunnerProtocols.every((version) => oldProtocols.includes(version))) {
    await api("internal/restart/resume", {});
    throw new Error("Previous release cannot safely recover these session protocols");
  }
  // New API starts with admission paused. Until success, no new-release owner
  // can invalidate the compatibility proof required by an offline rollback.
  try {
    await setRelease(target, true);
    await writeService();
    await exec("systemctl", ["--user", "restart", "claudenest.service"]);
    await waitHealthy(target, "draining");
    await api("internal/restart/prepare", { supportedRunnerProtocols: oldProtocols });
  } catch (error) {
    await exec("systemctl", ["--user", "stop", "claudenest.service"]);
    await setRelease(old, true);
    await exec("systemctl", ["--user", "start", "claudenest.service"]);
    await waitHealthy(old, "draining");
    await api("internal/restart/prepare", { supportedRunnerProtocols: oldProtocols });
    await setRelease(old);
    await api("internal/restart/resume", {});
    throw new Error(`Update failed; previous API release restored: ${error.message}`, {
      cause: error,
    });
  }
  await setRelease(target);
  await api("internal/restart/resume", {});
  const previousLink = join(root, `.previous-${randomUUID()}`);
  await symlink(old, previousLink);
  await rename(previousLink, join(root, "previous"));
  process.stdout.write("ClaudeNest API updated; existing session services were retained.\n");
}

async function writeStatus(operation, result, message, candidate = null) {
  const current = await realpath(join(root, "current"));
  const env = await configuration();
  const status = {
    supported: true,
    canUpdateWithActiveTurns: true,
    currentVersion: env.CLAUDENEST_VERSION || "0.1.0",
    latestVersion: candidate?.version ?? null,
    updateAvailable: candidate
      ? (await exec("git", ["-C", current, "rev-parse", "HEAD"])).stdout.trim() !== candidate.commit
      : null,
    operation,
    result,
    message,
    checkedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await mkdir(resolve(statusPath, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${statusPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(status) + "\n", { mode: 0o600 });
  await rename(temporary, statusPath);
  return status;
}

async function candidate() {
  const { stdout } = await exec(
    "curl",
    [
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--max-time",
      "30",
      "-H",
      "Cache-Control: no-cache",
      `${manifestUrl}${manifestUrl.includes("?") ? "&" : "?"}cache=${Date.now()}`,
    ],
    { timeout: 35_000, maxBuffer: 1024 * 1024 },
  );
  const value = JSON.parse(stdout);
  if (
    value.schemaVersion !== 1 ||
    !/^\d+\.\d+\.\d+-[0-9a-f]{7}$/.test(value.version) ||
    !/^[0-9a-f]{40}$/.test(value.commit) ||
    !value.version.endsWith(`-${value.commit.slice(0, 7)}`)
  )
    throw new Error("Invalid Nest Apps rolling release manifest");
  return value;
}

async function buildRelease(value) {
  const source = join(root, "source");
  const target = join(root, "releases", `v${value.version}`);
  await mkdir(join(root, "releases"), { recursive: true });
  try {
    await access(join(source, ".git"));
  } catch {
    await exec("git", ["clone", "--filter=blob:none", "--no-checkout", repository, source], {
      timeout: 120_000,
    });
  }
  await exec("git", ["-C", source, "remote", "set-url", "origin", repository]);
  await exec(
    "git",
    [
      "-C",
      source,
      "fetch",
      "--prune",
      "origin",
      "+refs/heads/*:refs/remotes/origin/*",
      "refs/tags/v*:refs/tags/v*",
    ],
    { timeout: 120_000 },
  );
  const resolved = (
    await exec("git", ["-C", source, "rev-parse", `${value.commit}^{commit}`])
  ).stdout.trim();
  if (resolved !== value.commit) throw new Error("Release commit does not match its manifest");
  try {
    await access(target);
    if ((await readFile(join(target, ".claudenest-built"), "utf8")).trim() !== resolved)
      throw new Error("Existing release build is incomplete; it will not be overwritten");
    await verifyRelease(target);
    await readFile(join(target, "apps/client/dist-claude/index.html"));
    return target;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // An existing incomplete checkout must never be rebuilt under a live owner.
    try {
      await access(target);
      throw new Error("Existing release is incomplete; choose a new release", { cause: error });
    } catch (existing) {
      if (existing.code !== "ENOENT") throw existing;
    }
  }
  await exec("git", ["-C", source, "worktree", "add", "--detach", target, resolved]);
  const env = {
    ...process.env,
    CLAUDENEST_VERSION: value.version,
    VITE_APP_VERSION: value.version,
  };
  try {
    await exec("npm", ["ci", "--include=dev"], {
      cwd: target,
      env,
      timeout: 15 * 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    await exec("npm", ["run", "build:claude"], {
      cwd: target,
      env,
      timeout: 10 * 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    await readFile(join(target, "apps/client/dist-claude/index.html"));
    await writeFile(join(target, ".claudenest-built"), resolved + "\n");
  } catch (error) {
    await exec("git", ["-C", source, "worktree", "remove", "--force", target]).catch(
      () => undefined,
    );
    throw new Error("Failed to build ClaudeNest release", { cause: error });
  }
  return target;
}

async function updateWorker() {
  let latest;
  try {
    await writeStatus("checking", "none", "Checking for ClaudeNest updates");
    latest = await candidate();
    const checked = await writeStatus("preparing", "none", "Preparing ClaudeNest update", latest);
    if (!checked.updateAvailable) {
      await writeStatus("idle", "none", "ClaudeNest is already up to date", latest);
      return;
    }
    await writeStatus("building", "none", "Building ClaudeNest server and web client", latest);
    const target = await buildRelease(latest);
    await writeStatus("restarting", "none", "Activating ClaudeNest release", latest);
    await updateRelease(target);
    await writeStatus("idle", "updated", "ClaudeNest was updated successfully", latest);
  } catch (error) {
    await writeStatus(
      "idle",
      error.message.includes("previous API release restored") ? "rolled_back" : "failed",
      error.message,
      latest,
    );
    throw error;
  }
}

// A kernel lock is released even if the updater is killed during a build.
if (
  ["setup", "update", "update-worker", "check-update", "restart", "stop"].includes(command) &&
  !process.argv.includes("--locked")
) {
  await mkdir(configRoot, { recursive: true, mode: 0o700 });
  try {
    const result = await exec(
      "flock",
      [
        "--nonblock",
        "--conflict-exit-code",
        "75",
        join(configRoot, "manage.lock"),
        process.execPath,
        ...process.argv.slice(1),
        "--locked",
      ],
      { timeout: 30 * 60_000, maxBuffer: 16 * 1024 * 1024 },
    );
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  } catch (error) {
    process.stderr.write(
      error.code === 75
        ? "ClaudeNest: Another management operation is active\n"
        : error.stderr || "ClaudeNest management operation failed\n",
    );
    process.exitCode = 1;
  }
} else
  try {
    if (command === "setup") {
      await verifyRelease(release);
      await exec("systemctl", ["--user", "show", "-p", "Version"]);
      const { stdout: serviceState } = await exec("systemctl", [
        "--user",
        "show",
        "claudenest.service",
        "-p",
        "ActiveState",
        "--value",
      ]);
      if (["active", "activating", "reloading"].includes(serviceState.trim()))
        throw new Error("ClaudeNest is already running; use update instead of setup");
      await mkdir(configRoot, { recursive: true, mode: 0o700 });
      await mkdir(root, { recursive: true, mode: 0o700 });
      await mkdir(serviceDirectory, { recursive: true });
      try {
        await writeFile(tokenPath, `${randomBytes(32).toString("base64url")}\n`, {
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const initial = {
        CLAUDENEST_HOST: "127.0.0.1",
        CLAUDENEST_PORT: "4311",
        CLAUDENEST_TOKEN_FILE: tokenPath,
        CLAUDENEST_SERVER_ENV_FILE: envPath,
        CLAUDENEST_CLAUDE_BIN: await executable(process.env.CLAUDENEST_CLAUDE_BIN || "claude"),
      };
      for (const key of [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
        "CLAUDE_CONFIG_DIR",
      ])
        if (process.env[key]) initial[key] = process.env[key];
      try {
        await writeFile(
          envPath,
          Object.entries(initial)
            .map(([key, value]) => `${key}=${quote(value)}`)
            .join("\n") + "\n",
          { flag: "wx", mode: 0o600 },
        );
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      await setRelease(release);
      await writeService();
      if (process.argv.includes("--start")) {
        await exec("systemctl", ["--user", "enable", "--now", "claudenest.service"]);
        await waitHealthy(release);
      }
      process.stdout.write(
        "ClaudeNest configured. Token is stored privately in ~/.config/claudenest/token.\n",
      );
    } else if (command === "update") {
      await updateRelease(release);
    } else if (command === "check-update") {
      const value = await candidate();
      const status = await writeStatus("idle", "none", "Update check completed", value);
      process.stdout.write(JSON.stringify(status) + "\n");
    } else if (command === "update-worker") {
      await updateWorker();
    } else if (command === "restart") {
      await api("internal/restart/prepare", {
        supportedRunnerProtocols: await supportedProtocols(await realpath(join(root, "current"))),
      });
      await exec("systemctl", ["--user", "restart", "claudenest.service"]);
      await waitHealthy(await realpath(join(root, "current")));
      process.stdout.write("ClaudeNest API restarted.\n");
    } else if (command === "status") {
      const health = await api("health");
      process.stdout.write(`${JSON.stringify(health, null, 2)}\n`);
    } else if (command === "stop") {
      await exec("systemctl", ["--user", "stop", "claudenest.service"]);
      process.stdout.write("ClaudeNest API stopped; session services keep running.\n");
    } else
      throw new Error(
        "Usage: node scripts/manage.mjs setup|update --release PATH [--start], or check-update|update-worker|restart|status|stop",
      );
  } catch (error) {
    process.stderr.write(`ClaudeNest: ${error.message}\n`);
    process.exitCode = 1;
  }
