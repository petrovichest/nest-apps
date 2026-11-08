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
process.env.PATH = `${resolve(process.execPath, "..")}${delimiter}${process.env.PATH || ""}`;
const configRoot =
  process.env.GEMININEST_CONFIG_DIR ||
  join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "gemininest");
const envPath = join(configRoot, "server.env");
const tokenPath = join(configRoot, "token");
const root = join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "gemininest");
const unitDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd/user");
try {
  process.loadEnvFile(envPath);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const statusPath = join(
  process.env.GEMININEST_STATE_DIR ||
    join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "gemininest"),
  "update.json",
);
const repository =
  process.env.GEMININEST_REPOSITORY_URL || "https://github.com/petrovichest/nest-apps.git";
const manifestUrl =
  process.env.GEMININEST_UPDATE_MANIFEST_URL ||
  "https://github.com/petrovichest/nest-apps/releases/download/rolling-latest/NestApps-latest.json";
const command = process.argv[2];
const releaseIndex = process.argv.indexOf("--release");
const release = releaseIndex < 0 ? null : await realpath(process.argv[releaseIndex + 1]);
const quote = (value) => {
  if (/[\r\n\0]/.test(value)) throw new Error("Invalid service path");
  return JSON.stringify(String(value));
};
const unitQuote = (value) => quote(value.replaceAll("%", "%%").replaceAll("$", "$$"));
const directoryValue = (value) => {
  if (/[\r\n]/.test(value)) throw new Error("Service paths must be single-line");
  return value.replaceAll("%", "%%");
};

async function configuration() {
  const values = {};
  const lines = (await readFile(envPath, "utf8").catch(() => "")).split("\n");
  for (const line of lines) {
    const match = /^([A-Z_a-z][A-Z_a-z0-9]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    values[match[1]] = match[2].startsWith('"') ? JSON.parse(match[2]) : match[2];
  }
  return values;
}

async function api(route, body) {
  const env = await configuration();
  const token = (await readFile(env.GEMININEST_TOKEN_FILE || tokenPath, "utf8")).trim();
  const response = await fetch(`http://127.0.0.1:${env.GEMININEST_PORT || 4312}/api/v1/${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message || "GeminiNest API request failed");
  return value;
}

async function executable(name) {
  const candidates = name.includes("/")
    ? [resolve(name)]
    : (process.env.PATH || "").split(delimiter).map((dir) => join(dir, name));
  for (const candidate of candidates) {
    try {
      await access(candidate, 1);
      return await realpath(candidate);
    } catch {
      /* Next PATH entry. */
    }
  }
  throw new Error("Install Antigravity CLI (agy) or set GEMININEST_AGY_BIN first.");
}

async function verifyRelease(target) {
  if (!target) throw new Error("--release /absolute/immutable/git-checkout is required");
  for (const path of [
    "apps/gemini-server/dist/index.js",
    "apps/gemini-server/dist/daemon.js",
    "apps/client/dist-gemini/index.html",
  ])
    await access(join(target, path));
  const { stdout: changes } = await exec("git", [
    "-C",
    target,
    "status",
    "--porcelain",
    "--untracked-files=no",
  ]);
  if (changes.trim()) throw new Error("Release must have no tracked modifications");
  try {
    await exec("git", ["-C", target, "symbolic-ref", "-q", "HEAD"]);
    throw new Error("Use a detached Git checkout");
  } catch (error) {
    if (error.code !== 1) throw error;
  }
}

async function setRelease(target, paused = false, agyBin) {
  const env = await readFile(envPath, "utf8").catch(() => "");
  const name = basename(target);
  const version = /^v?\d+\.\d+\.\d+(-[0-9a-f]{7,40})?$/i.test(name)
    ? name.replace(/^v/, "")
    : /^[0-9a-f]{40}$/i.test(name)
      ? `0.1.9-${name.slice(0, 7).toLowerCase()}`
      : "0.1.9";
  const lines = [
    `GEMININEST_VERSION=${quote(version)}`,
    `GEMININEST_MANAGED_INSTALL="1"`,
    `GEMININEST_RELEASE_PATH=${quote(target)}`,
    `GEMININEST_START_PAUSED=${quote(paused ? "1" : "0")}`,
    ...(agyBin ? [`GEMININEST_AGY_BIN=${quote(agyBin)}`] : []),
  ];
  const cleaned = env
    .split("\n")
    .filter(
      (line) =>
        !/^GEMININEST_(VERSION|MANAGED_INSTALL|RELEASE_PATH|START_PAUSED)=/.test(line) &&
        !(agyBin && /^GEMININEST_AGY_BIN=/.test(line)),
    )
    .join("\n");
  const temporaryEnv = `${envPath}.${randomUUID()}.tmp`;
  await writeFile(temporaryEnv, `${cleaned.trimEnd()}\n${lines.join("\n")}\n`, { mode: 0o600 });
  await chmod(temporaryEnv, 0o600);
  await rename(temporaryEnv, envPath);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = join(root, `.current-${randomUUID()}`);
  await symlink(target, temporary);
  await rename(temporary, join(root, "current"));
}

async function currentReleasePath() {
  try {
    return await realpath(join(root, "current"));
  } catch {
    const env = await configuration();
    if (env.GEMININEST_RELEASE_PATH) return realpath(env.GEMININEST_RELEASE_PATH);
    throw new Error("Current GeminiNest release was not found");
  }
}

async function writeService(targetRelease) {
  const target = targetRelease || (await currentReleasePath());
  await mkdir(unitDir, { recursive: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temporaryLink = join(root, `.current-${randomUUID()}`);
  await symlink(target, temporaryLink);
  await rename(temporaryLink, join(root, "current"));

  const nodeBin = await realpath(process.execPath);
  for (const [name, file, description] of [
    ["gemininest-daemon", "daemon", "GeminiNest ACP session owner"],
    ["gemininest", "index", "GeminiNest HTTP gateway"],
  ]) {
    const unit = `[Unit]\nDescription=${description}\nAfter=network-online.target${name === "gemininest" ? " gemininest-daemon.service\nWants=gemininest-daemon.service" : ""}\n\n[Service]\nType=exec\nEnvironment=GEMININEST_CONFIG_DIR=${unitQuote(configRoot)}\nExecStart=${unitQuote(nodeBin)} ${unitQuote(join(target, `apps/gemini-server/dist/${file}.js`))}\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=30\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
    await writeFile(join(unitDir, `${name}.service`), unit, { mode: 0o600 });
  }
  const cliDirectory = join(homedir(), ".local/bin");
  const cli = process.env.XDG_DATA_HOME
    ? join(root, "bin/gemininest")
    : join(cliDirectory, "gemininest");
  await mkdir(resolve(cli, ".."), { recursive: true });
  const cliSource = join(target, "deploy/gemininest/gemininest");
  const hasCliWrapper = await access(cliSource).then(
    () => true,
    () => false,
  );
  if (hasCliWrapper) {
    await copyFile(cliSource, cli);
    await chmod(cli, 0o755);
  }
  const updaterExec = hasCliWrapper
    ? `${unitQuote(cli)} update-worker`
    : `${unitQuote(nodeBin)} ${unitQuote(join(target, "apps/gemini-server/scripts/manage.mjs"))} update-worker`;
  const updater = `[Unit]\nDescription=Update GeminiNest from its published release\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=oneshot\nEnvironmentFile=${directoryValue(envPath)}\nEnvironment=GEMININEST_CONFIG_DIR=${unitQuote(configRoot)}\nEnvironment=GEMININEST_NODE_BIN=${unitQuote(nodeBin)}\nExecStart=${updaterExec}\nTimeoutStartSec=30min\nNoNewPrivileges=true\nPrivateTmp=true\nUMask=0077\n`;
  await writeFile(join(unitDir, "gemininest-update.service"), updater, { mode: 0o600 });
  await exec("systemctl", ["--user", "daemon-reload"]);
}

async function waitHealthy(target, recoveryState = "ready") {
  for (let attempt = 0; attempt < 360; attempt++) {
    try {
      const value = await api("health");
      if (value.recoveryState === recoveryState && value.releasePath === target) return;
    } catch {
      /* Restart still in progress. */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("GeminiNest did not recover readiness");
}

async function updateRelease(target) {
  await verifyRelease(target);
  const old = await currentReleasePath();
  await api("internal/restart/prepare", { supportedRunnerProtocols: [1] }).catch(() => undefined);
  try {
    await setRelease(target, true);
    await writeService(target);
    await exec("systemctl", [
      "--user",
      "restart",
      "gemininest-daemon.service",
      "gemininest.service",
    ]);
    await waitHealthy(target, "draining");
  } catch (error) {
    await exec("systemctl", ["--user", "stop", "gemininest.service", "gemininest-daemon.service"]);
    await setRelease(old, false);
    await writeService(old);
    await exec("systemctl", ["--user", "start", "gemininest-daemon.service", "gemininest.service"]);
    await waitHealthy(old, "ready");
    throw new Error(`Update failed; previous GeminiNest release restored: ${error.message}`, {
      cause: error,
    });
  }
  await setRelease(target, false);
  await api("internal/restart/resume", {});
  const previousLink = join(root, `.previous-${randomUUID()}`);
  await symlink(old, previousLink);
  await rename(previousLink, join(root, "previous"));
  process.stdout.write("GeminiNest updated successfully.\n");
}

async function writeStatus(operation, result, message, candidate = null) {
  const current = await currentReleasePath();
  const env = await configuration();
  const currentHead = (await exec("git", ["-C", current, "rev-parse", "HEAD"])).stdout.trim();
  const currentVersion = env.GEMININEST_VERSION || `0.1.9-${currentHead.slice(0, 7).toLowerCase()}`;
  const status = {
    supported: true,
    canUpdateWithActiveTurns: true,
    currentVersion,
    latestVersion: candidate?.version ?? null,
    updateAvailable: candidate ? currentHead !== candidate.commit : null,
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
    if ((await readFile(join(target, ".gemininest-built"), "utf8")).trim() !== resolved)
      throw new Error("Existing release build is incomplete; it will not be overwritten");
    await verifyRelease(target);
    return target;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
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
    GEMININEST_VERSION: value.version,
    VITE_APP_VERSION: value.version,
  };
  try {
    await exec("npm", ["ci", "--include=dev"], {
      cwd: target,
      env,
      timeout: 15 * 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    await exec("npm", ["run", "build:gemini"], {
      cwd: target,
      env,
      timeout: 10 * 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    await verifyRelease(target);
    await writeFile(join(target, ".gemininest-built"), resolved + "\n");
  } catch (error) {
    await exec("git", ["-C", source, "worktree", "remove", "--force", target]).catch(
      () => undefined,
    );
    throw new Error("Failed to build GeminiNest release", { cause: error });
  }
  return target;
}

async function updateWorker() {
  let latest;
  try {
    await writeStatus("checking", "none", "Проверяем наличие обновлений GeminiNest");
    latest = await candidate();
    const checked = await writeStatus(
      "preparing",
      "none",
      "Подготавливаем обновление GeminiNest",
      latest,
    );
    if (!checked.updateAvailable) {
      await writeStatus("idle", "none", "Установлена актуальная версия GeminiNest", latest);
      return;
    }
    await writeStatus("building", "none", "Собираем сервер и веб-клиент GeminiNest", latest);
    const target = await buildRelease(latest);
    await writeStatus("restarting", "none", "Активируем новую версию GeminiNest", latest);
    await updateRelease(target);
    await writeStatus("idle", "updated", "GeminiNest успешно обновлён", latest);
  } catch (error) {
    await writeStatus(
      "idle",
      error.message.includes("previous GeminiNest release restored") ? "rolled_back" : "failed",
      error.message,
      latest,
    );
    throw error;
  }
}

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
        ? "GeminiNest: Another management operation is active\n"
        : error.stderr || "GeminiNest management operation failed\n",
    );
    process.exitCode = 1;
  }
} else
  try {
    if (command === "setup") {
      await verifyRelease(release);
      for (const name of ["gemininest.service", "gemininest-daemon.service"]) {
        const active = await exec("systemctl", ["--user", "is-active", name]).then(
          () => true,
          () => false,
        );
        if (active)
          throw new Error(
            `${name} is running. Setup only installs a new or stopped GeminiNest instance.`,
          );
      }
      const agy = await executable(process.env.GEMININEST_AGY_BIN || "agy");
      await mkdir(configRoot, { recursive: true, mode: 0o700 });
      await chmod(configRoot, 0o700);
      await mkdir(root, { recursive: true, mode: 0o700 });
      try {
        await writeFile(tokenPath, randomBytes(32).toString("hex") + "\n", {
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      await setRelease(release, false, agy);
      await writeService(release);
      if (process.argv.includes("--start")) {
        await exec("systemctl", [
          "--user",
          "enable",
          "--now",
          "gemininest-daemon.service",
          "gemininest.service",
        ]);
        await waitHealthy(release);
      }
      process.loadEnvFile(envPath);
      process.stdout.write(
        `GeminiNest configured. Owner token: ${tokenPath}\nOpen http://127.0.0.1:${process.env.GEMININEST_PORT || 4312} and use Settings → Gemini to configure the proxy and sign in with Google.\n`,
      );
    } else if (command === "update") {
      await updateRelease(release);
    } else if (command === "check-update") {
      const current = await currentReleasePath();
      await writeService(current);
      const value = await candidate();
      const status = await writeStatus("idle", "none", "Проверка обновлений завершена", value);
      process.stdout.write(JSON.stringify(status) + "\n");
    } else if (command === "update-worker") {
      await updateWorker();
    } else if (command === "restart") {
      const current = await currentReleasePath();
      await api("internal/restart/prepare", { supportedRunnerProtocols: [1] }).catch(
        () => undefined,
      );
      await exec("systemctl", [
        "--user",
        "restart",
        "gemininest-daemon.service",
        "gemininest.service",
      ]);
      await waitHealthy(current);
      process.stdout.write("GeminiNest restarted.\n");
    } else if (command === "status") {
      try {
        const health = await api("health");
        process.stdout.write(`${JSON.stringify(health, null, 2)}\n`);
      } catch {
        const result = await exec("systemctl", [
          "--user",
          "status",
          "gemininest.service",
          "gemininest-daemon.service",
          "--no-pager",
        ]).catch((error) => ({ stdout: error.stdout }));
        process.stdout.write(result.stdout || "GeminiNest is not installed.\n");
      }
    } else if (command === "stop") {
      await exec("systemctl", [
        "--user",
        "stop",
        "gemininest.service",
        "gemininest-daemon.service",
      ]);
      process.stdout.write("GeminiNest stopped.\n");
    } else {
      throw new Error(
        "Usage: manage.mjs setup|update --release PATH [--start] | check-update | update-worker | restart | status | stop",
      );
    }
  } catch (error) {
    process.stderr.write(`GeminiNest: ${error.message}\n`);
    process.exitCode = 1;
  }
