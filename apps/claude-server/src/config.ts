import { access, chmod, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { constants } from "node:fs";
import { AppError } from "./types";

export interface Config {
  host: string;
  port: number;
  stateDir: string;
  runtimeDir: string;
  configDir: string;
  claudeBin: string;
  nodeBin: string;
  releasePath: string;
  runnerPath: string;
  serverEnvFile: string;
  token: string;
  allowedOrigins: Set<string>;
  startPaused?: boolean;
  clientDist?: string;
}

export async function executablePath(name: string): Promise<string> {
  const candidates = name.includes("/")
    ? [resolve(name)]
    : (process.env.PATH ?? "").split(delimiter).map((directory) => join(directory, name));
  for (const path of candidates) {
    try {
      await access(path, constants.X_OK);
      return await realpath(path);
    } catch {
      /* Try next PATH entry. */
    }
  }
  throw new AppError("unavailable", `Executable ${name} was not found`, 503);
}

export async function loadConfig(): Promise<Config> {
  const configRoot = resolve(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "claudenest",
  );
  const serverEnvFile = resolve(
    process.env.CLAUDENEST_SERVER_ENV_FILE || join(configRoot, "server.env"),
  );
  try {
    process.loadEnvFile(serverEnvFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const stateDir = resolve(
    process.env.CLAUDENEST_STATE_DIR ||
      join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "claudenest"),
  );
  const runtimeDir = resolve(
    process.env.CLAUDENEST_RUNTIME_DIR ||
      join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid!()}`, "claudenest"),
  );
  const releasePath = await realpath(
    process.env.CLAUDENEST_RELEASE_PATH || fileURLToPath(new URL("../../../", import.meta.url)),
  );
  const port = Number(process.env.CLAUDENEST_PORT || 4311);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("CLAUDENEST_PORT must be between 1 and 65535");
  const tokenPath = process.env.CLAUDENEST_TOKEN_FILE || join(configRoot, "token");
  const tokenStat = await stat(tokenPath);
  if ((tokenStat.mode & 0o077) !== 0)
    throw new Error("ClaudeNest token file must be private (mode 0600)");
  const token = (await readFile(tokenPath, "utf8")).trim();
  if (token.length < 32 || /\s/.test(token))
    throw new Error("ClaudeNest bearer token must have at least 32 characters and no whitespace");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  await chmod(runtimeDir, 0o700);
  if (Buffer.byteLength(join(runtimeDir, "00000000-0000-4000-8000-000000000000.sock")) > 103)
    throw new Error("CLAUDENEST_RUNTIME_DIR is too long for Unix sockets");
  return {
    host: process.env.CLAUDENEST_HOST || "127.0.0.1",
    port,
    stateDir,
    runtimeDir,
    configDir: resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")),
    claudeBin: await executablePath(process.env.CLAUDENEST_CLAUDE_BIN || "claude"),
    nodeBin: await realpath(process.execPath),
    releasePath,
    runnerPath: await realpath(
      process.env.CLAUDENEST_RUNNER_PATH ||
        join(releasePath, "apps/claude-server/dist/runner-main.js"),
    ),
    serverEnvFile,
    token,
    startPaused: process.env.CLAUDENEST_START_PAUSED === "1",
    clientDist: resolve(
      process.env.CLAUDENEST_CLIENT_DIST || join(releasePath, "apps/client/dist-claude"),
    ),
    allowedOrigins: new Set(
      (
        process.env.CLAUDENEST_ALLOWED_ORIGINS ||
        `http://127.0.0.1:${port},http://localhost:${port},http://127.0.0.1:5174,http://localhost:5174`
      )
        .split(",")
        .map((value) => value.trim()),
    ),
  };
}
