#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const configRoot = process.env.GEMININEST_CONFIG_DIR || join(homedir(), ".config/gemininest");
const command = process.argv[2];
const releaseIndex = process.argv.indexOf("--release");
const release = releaseIndex < 0 ? null : await realpath(process.argv[releaseIndex + 1]);
const unitDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd/user");
const quote = (value) => {
  if (/[\r\n\0]/.test(value)) throw new Error("Invalid service path");
  return JSON.stringify(value.replaceAll("%", "%%").replaceAll("$", "$$"));
};
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
if (command === "setup") {
  if (!release) throw new Error("--release /absolute/immutable/git-checkout is required");
  for (const path of [
    "apps/gemini-server/dist/index.js",
    "apps/gemini-server/dist/daemon.js",
    "apps/client/dist-gemini/index.html",
  ])
    await access(join(release, path));
  const { stdout: changes } = await exec("git", [
    "-C",
    release,
    "status",
    "--porcelain",
    "--untracked-files=no",
  ]);
  if (changes.trim()) throw new Error("Release must have no tracked modifications");
  try {
    await exec("git", ["-C", release, "symbolic-ref", "-q", "HEAD"]);
    throw new Error("Use a detached Git checkout");
  } catch (error) {
    if (error.code !== 1) throw error;
  }
  // Never replace a live owner during setup. A future upgrade must explicitly drain it first.
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
  const tokenPath = join(configRoot, "token");
  try {
    await writeFile(tokenPath, randomBytes(32).toString("hex") + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const envPath = join(configRoot, "server.env");
  let env = await readFile(envPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  env = env
    .split("\n")
    .filter((line) => !/^GEMININEST_(RELEASE_PATH|AGY_BIN)=/.test(line))
    .join("\n");
  await writeFile(
    envPath,
    `${env.trimEnd()}\nGEMININEST_RELEASE_PATH=${JSON.stringify(release)}\nGEMININEST_AGY_BIN=${JSON.stringify(agy)}\n`,
    { mode: 0o600 },
  );
  await chmod(envPath, 0o600);
  await mkdir(unitDir, { recursive: true });
  for (const [name, file, description] of [
    ["gemininest-daemon", "daemon", "GeminiNest ACP session owner"],
    ["gemininest", "index", "GeminiNest HTTP gateway"],
  ]) {
    const unit = `[Unit]\nDescription=${description}\nAfter=network-online.target${name === "gemininest" ? " gemininest-daemon.service\nWants=gemininest-daemon.service" : ""}\n\n[Service]\nType=exec\nEnvironment=GEMININEST_CONFIG_DIR=${quote(configRoot)}\nExecStart=${quote(await realpath(process.execPath))} ${quote(join(release, `apps/gemini-server/dist/${file}.js`))}\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=30\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
    await writeFile(join(unitDir, `${name}.service`), unit, { mode: 0o600 });
  }
  await exec("systemctl", ["--user", "daemon-reload"]);
  if (process.argv.includes("--start"))
    await exec("systemctl", [
      "--user",
      "enable",
      "--now",
      "gemininest-daemon.service",
      "gemininest.service",
    ]);
  process.loadEnvFile(envPath);
  process.stdout.write(
    `GeminiNest configured. Owner token: ${tokenPath}\nOpen http://127.0.0.1:${process.env.GEMININEST_PORT || 4312} and use Settings → Gemini to configure the proxy and sign in with Google.\n`,
  );
} else if (command === "status") {
  const result = await exec("systemctl", [
    "--user",
    "status",
    "gemininest.service",
    "gemininest-daemon.service",
    "--no-pager",
  ]).catch((error) => ({ stdout: error.stdout }));
  process.stdout.write(result.stdout || "GeminiNest is not installed.\n");
} else {
  throw new Error("Usage: manage.mjs setup --release PATH [--start] | status");
}
