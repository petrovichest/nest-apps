import { spawn, execFile, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { loadConfig, SUPPORTED_OPENCODE_VERSION, type Config } from "./config";
import { openProxyEnvironment, readOpenConnection } from "./connection";

/** Merge process-local configuration; never edit ordinary OpenCode configuration. */
export function nativeConfiguration(inherited: string | undefined, plugin: string): string {
  let config: Record<string, unknown> = {};
  if (inherited) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(inherited);
    } catch {
      throw new Error("Invalid process-local OpenCode configuration");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Invalid process-local OpenCode configuration");
    config = parsed as Record<string, unknown>;
  }
  if (
    config.plugin !== undefined &&
    (!Array.isArray(config.plugin) || !config.plugin.every((value) => typeof value === "string"))
  )
    throw new Error("Invalid process-local OpenCode plugin configuration");
  return JSON.stringify({
    ...config,
    plugin: [...new Set([...((config.plugin as string[] | undefined) ?? []), plugin])],
  });
}

export async function runNative(config: Config, inherited = process.env): Promise<number> {
  const saved = await readOpenConnection(config.configDir);
  const connection = await openProxyEnvironment(saved.proxy, inherited);
  let child: ChildProcess | undefined;
  let stopping = false;
  let force: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    child?.kill("SIGTERM");
    force = setTimeout(() => {
      if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 10_000);
    force.unref();
  };
  try {
    const plugin = join(config.releasePath, "apps/open-server/dist/plugin.js");
    await access(plugin);
    const env = {
      ...connection.env,
      OPENNEST_CONFIG_DIR: config.configDir,
      OPENNEST_STATE_DIR: config.stateDir,
      OPENNEST_PORT: String(config.port),
      OPENNEST_HOST: config.host,
      ...(config.nativeEventSocket ? { OPENNEST_EVENT_SOCKET: config.nativeEventSocket } : {}),
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_SERVER_USERNAME: config.nativeUsername,
      OPENCODE_SERVER_PASSWORD: config.nativePassword,
      OPENCODE_CONFIG_CONTENT: nativeConfiguration(
        connection.env.OPENCODE_CONFIG_CONTENT,
        pathToFileURL(plugin).href,
      ),
    };
    if (!env.OPENCODE_SERVER_PASSWORD)
      throw new Error("A private native server password is required");
    const version = (
      await promisify(execFile)(config.opencodeBin, ["--version"], { env, timeout: 15_000 })
    ).stdout.trim();
    if (version !== SUPPORTED_OPENCODE_VERSION)
      throw new Error("Unsupported OpenCode runtime version");
    const address = new URL(config.nativeUrl);
    child = spawn(
      config.opencodeBin,
      [
        "serve",
        "--hostname",
        address.hostname.replace(/^\[|\]$/g, ""),
        "--port",
        address.port || "80",
      ],
      { env, stdio: ["ignore", "inherit", "inherit"], shell: false },
    );
    const exited = new Promise<number>((resolve, reject) => {
      child!.once("error", () => reject(new Error("OpenCode native process could not start")));
      child!.once("exit", (code) => resolve(stopping ? 0 : (code ?? 1)));
    });
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    return await exited;
  } finally {
    clearTimeout(force);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    await connection.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadConfig()
    .then((config) => runNative(config))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.stderr.write(
        "OpenNest native runtime could not start. Check its private configuration, proxy and supported OpenCode version.\n",
      );
      process.exitCode = 1;
    });
}
