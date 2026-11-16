import { chmod, lstat, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Config = ReturnType<typeof paths> & { token: string };
export const SUPPORTED_OPENCODE_VERSION = "1.19.5";

export function paths(env = process.env) {
  const configDir = resolve(env.OPENNEST_CONFIG_DIR || join(homedir(), ".config/opennest"));
  const stateDir = resolve(env.OPENNEST_STATE_DIR || join(homedir(), ".local/state/opennest"));
  const runtimeDir = resolve(
    env.OPENNEST_RUNTIME_DIR ||
      join(env.XDG_RUNTIME_DIR || `/run/user/${process.getuid!()}`, "opennest"),
  );
  const releasePath = resolve(
    env.OPENNEST_RELEASE_PATH || fileURLToPath(new URL("../../../", import.meta.url)),
  );
  const releaseName = basename(releasePath);
  const port = Number(env.OPENNEST_PORT || 4313);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid OPENNEST_PORT");
  const nativeUrl = new URL(env.OPENNEST_NATIVE_URL || "http://127.0.0.1:4097");
  if (
    nativeUrl.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(nativeUrl.hostname) ||
    nativeUrl.username ||
    nativeUrl.password ||
    nativeUrl.pathname !== "/" ||
    nativeUrl.search ||
    nativeUrl.hash
  ) {
    throw new Error("OPENNEST_NATIVE_URL must be a loopback HTTP origin");
  }
  return {
    configDir,
    stateDir,
    runtimeDir,
    releasePath,
    port,
    host: env.OPENNEST_HOST || "127.0.0.1",
    version:
      env.OPENNEST_VERSION ||
      (/^[a-f0-9]{40}$/i.test(releaseName) ? `0.1.9-${releaseName.slice(0, 7)}` : "0.1.9"),
    nodeBin: env.OPENNEST_NODE_BIN || process.execPath,
    opencodeBin: env.OPENNEST_OPENCODE_BIN || "opencode",
    nativeUrl: nativeUrl.origin,
    nativeEventSocket: env.OPENNEST_EVENT_SOCKET ? resolve(env.OPENNEST_EVENT_SOCKET) : undefined,
    nativeDatabasePath: resolve(
      env.OPENNEST_NATIVE_DATABASE_PATH ||
        join(env.XDG_DATA_HOME || join(homedir(), ".local/share"), "opencode/opencode.db"),
    ),
    nativeUsername: env.OPENNEST_NATIVE_USERNAME || env.OPENCODE_SERVER_USERNAME || "opencode",
    nativePassword: env.OPENNEST_NATIVE_PASSWORD || env.OPENCODE_SERVER_PASSWORD,
    managedInstall: env.OPENNEST_MANAGED_INSTALL === "1",
    clientDist: resolve(env.OPENNEST_CLIENT_DIST || join(releasePath, "apps/client/dist-open")),
    allowedOrigins: new Set(
      (
        env.OPENNEST_ALLOWED_ORIGINS ||
        `http://127.0.0.1:${port},http://localhost:${port},http://127.0.0.1:5176,http://localhost:5176`
      )
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .concat("http://localhost"),
    ),
  };
}

export async function loadConfig(): Promise<Config> {
  try {
    const envFile = process.env.OPENNEST_SERVER_ENV_FILE || join(paths().configDir, "server.env");
    const metadata = await lstat(envFile);
    if (!metadata.isFile() || metadata.mode & 0o077)
      throw new Error("OpenNest server.env must be a private regular file (0600)");
    process.loadEnvFile(envFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const config = paths();
  for (const directory of [config.configDir, config.stateDir, config.runtimeDir]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  const tokenPath = join(config.configDir, "token");
  const metadata = await lstat(tokenPath);
  if (!metadata.isFile() || metadata.mode & 0o077)
    throw new Error("OpenNest token must be a private regular file (0600)");
  const token = (await readFile(tokenPath, "utf8")).trim();
  if (token.length < 32 || /\s/.test(token)) throw new Error("Invalid OpenNest token");
  return { ...config, token };
}
