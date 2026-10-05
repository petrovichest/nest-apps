#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
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
  const replacement = `CLAUDENEST_RELEASE_PATH=${quote(target)}\nCLAUDENEST_RUNNER_PATH=${quote(join(target, "apps/claude-server/dist/runner-main.js"))}\nCLAUDENEST_START_PAUSED=${quote(paused ? "1" : "0")}`;
  const cleaned = env
    .split("\n")
    .filter((line) => !/^CLAUDENEST_(RELEASE_PATH|RUNNER_PATH|START_PAUSED)=/.test(line))
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
  await exec("systemctl", ["--user", "daemon-reload"]);
}

let operationLock;
try {
  if (["setup", "update", "restart", "stop"].includes(command)) {
    await mkdir(configRoot, { recursive: true, mode: 0o700 });
    operationLock = await open(join(configRoot, "manage.lock"), "wx", 0o600).catch(() => {
      throw new Error(
        "Another management operation is active; if its process ended, remove ~/.config/claudenest/manage.lock",
      );
    });
    await operationLock.writeFile(String(process.pid));
  }
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
    await verifyRelease(release);
    const old = await realpath(join(root, "current"));
    const targetProtocols = await supportedProtocols(release);
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
      await setRelease(release, true);
      await writeService();
      await exec("systemctl", ["--user", "restart", "claudenest.service"]);
      await waitHealthy(release, "draining");
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
    await setRelease(release);
    await api("internal/restart/resume", {});
    process.stdout.write("ClaudeNest API updated; existing session services were retained.\n");
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
      "Usage: node scripts/manage.mjs setup|update --release PATH [--start], or restart|status|stop",
    );
} catch (error) {
  process.stderr.write(`ClaudeNest: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  if (operationLock) {
    await operationLock.close();
    await unlink(join(configRoot, "manage.lock"));
  }
}
