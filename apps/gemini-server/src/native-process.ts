import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config";
import { proxyEnvironment } from "./proxy";

export type NativeConfig = Pick<Config, "agyBin" | "nativeDir"> & {
  isolation?: { credential: string; socket: string };
};

export function nativeCredentialPath(nativeDir: string) {
  return join(nativeDir, "gemininest", "antigravity-oauth-token");
}

export function spawnNative(config: NativeConfig, args: string[], env: NodeJS.ProcessEnv) {
  const options = { env, stdio: "pipe" as const };
  if (!config.isolation) return spawn(config.agyBin, args, options);
  const { credential, socket } = config.isolation;
  const port = new URL(env.HTTPS_PROXY!).port;
  const relay = fileURLToPath(new URL("../scripts/native-proxy.mjs", import.meta.url));
  // Mount the imported credential over the native cache inside the network namespace.
  // The CLI updates the mounted file when it refreshes OAuth.
  return spawn(
    "/usr/bin/bwrap",
    [
      "--unshare-net",
      "--unshare-pid",
      "--die-with-parent",
      "--bind",
      "/",
      "/",
      "--proc",
      "/proc",
      "--setenv",
      "DBUS_SESSION_BUS_ADDRESS",
      "unix:path=/dev/null",
      "--bind",
      credential,
      nativeCredentialPath(config.nativeDir),
      "--",
      process.execPath,
      relay,
      socket,
      port,
      config.agyBin,
      ...args,
    ],
    options,
  );
}

export async function nativeConnection(
  proxy: string,
  config: NativeConfig,
  credential?: string,
): Promise<{ env: NodeJS.ProcessEnv; native: NativeConfig; close: () => Promise<void> }> {
  const bridge = await proxyEnvironment(proxy);
  if (!credential) return { ...bridge, native: config };

  let directory: string | undefined;
  const sockets = new Set<Socket>();
  const port = Number(new URL(bridge.env.HTTPS_PROXY!).port);
  const listener = createServer((client) => {
    const upstream = connect(port, "127.0.0.1");
    sockets.add(client);
    client.once("close", () => {
      sockets.delete(client);
      upstream.destroy();
    });
    upstream.once("close", () => client.destroy());
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.pipe(upstream).pipe(client);
  });
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      for (const socket of sockets) socket.destroy();
      if (listener.listening) await new Promise<void>((resolve) => listener.close(() => resolve()));
      try {
        await bridge.close();
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    })());
  try {
    directory = await mkdtemp(join(tmpdir(), "gemini-proxy-"));
    const socket = join(directory, "proxy.sock");
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(socket, resolve);
    });
    return { env: bridge.env, native: { ...config, isolation: { credential, socket } }, close };
  } catch (error) {
    await close();
    throw error;
  }
}
