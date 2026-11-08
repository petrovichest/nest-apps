import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Config = ReturnType<typeof paths> & { token: string };

export function paths(env = process.env) {
  const configDir = resolve(env.GEMININEST_CONFIG_DIR || join(homedir(), ".config/gemininest"));
  const stateDir = resolve(env.GEMININEST_STATE_DIR || join(homedir(), ".local/state/gemininest"));
  const runtimeDir = resolve(
    env.GEMININEST_RUNTIME_DIR ||
      join(env.XDG_RUNTIME_DIR || `/run/user/${process.getuid!()}`, "gemininest"),
  );
  const release = resolve(
    env.GEMININEST_RELEASE_PATH || fileURLToPath(new URL("../../../", import.meta.url)),
  );
  const releaseBase = basename(release);
  const derivedVersion = /^v\d+\.\d+\.\d+(-[0-9a-f]{7,40})?$/i.test(releaseBase)
    ? releaseBase.slice(1)
    : /^[0-9a-f]{40}$/i.test(releaseBase)
      ? `0.1.9-${releaseBase.slice(0, 7).toLowerCase()}`
      : "0.1.9";
  const port = Number(env.GEMININEST_PORT || 4312);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid GEMININEST_PORT");
  return {
    configDir,
    stateDir,
    runtimeDir,
    port,
    socket: join(runtimeDir, "daemon.sock"),
    host: env.GEMININEST_HOST || "127.0.0.1",
    agyBin: env.GEMININEST_AGY_BIN || "agy",
    nodeBin: env.GEMININEST_NODE_BIN || process.execPath,
    releasePath: release,
    version: env.GEMININEST_VERSION || derivedVersion,
    managedInstall:
      env.GEMININEST_MANAGED_INSTALL === "1" ||
      (env.GEMININEST_MANAGED_INSTALL !== "0" && Boolean(env.GEMININEST_RELEASE_PATH)),
    startPaused: env.GEMININEST_START_PAUSED === "1",
    nativeDir: join(stateDir, "native"),
    clientDist: resolve(env.GEMININEST_CLIENT_DIST || join(release, "apps/client/dist-gemini")),
    allowedOrigins: new Set(
      (
        env.GEMININEST_ALLOWED_ORIGINS ||
        `http://127.0.0.1:${port},http://localhost:${port},http://127.0.0.1:5175,http://localhost:5175`
      )
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .concat("http://localhost"),
    ),
  };
}

export async function loadConfig(): Promise<Config> {
  const envFile = process.env.GEMININEST_SERVER_ENV_FILE || join(paths().configDir, "server.env");
  try {
    process.loadEnvFile(envFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const config = paths();
  for (const dir of [config.configDir, config.stateDir, config.runtimeDir, config.nativeDir]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  }
  const tokenPath = join(config.configDir, "token");
  if ((await stat(tokenPath)).mode & 0o077)
    throw new Error("GeminiNest token must be private (0600)");
  const token = (await readFile(tokenPath, "utf8")).trim();
  if (token.length < 32 || /\s/.test(token)) throw new Error("Invalid GeminiNest token");
  return { ...config, token };
}
