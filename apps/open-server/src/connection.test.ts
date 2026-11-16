import { createServer, request } from "node:http";
import { createServer as tcpServer } from "node:net";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenConnection, openProxyEnvironment, readOpenConnection } from "./connection";
import { nativeConfiguration } from "./native";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});
async function configuration() {
  const configDir = await mkdtemp(join(tmpdir(), "opennest-connection-"));
  cleanup.push(() => rm(configDir, { recursive: true, force: true }));
  return { configDir, managedInstall: true };
}
async function tunnel(proxy: string, destination: string) {
  const bridge = new URL(proxy);
  return new Promise<number | undefined>((resolve, reject) => {
    const req = request({
      hostname: bridge.hostname,
      port: bridge.port,
      method: "CONNECT",
      path: destination,
    });
    req.once("connect", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode);
    });
    req.once("error", reject);
    req.end();
  });
}

describe("OpenNest private proxy connection", () => {
  it("persists private credentials, returns only a redacted address, and restarts inside the idle gate", async () => {
    const config = await configuration();
    let gated = false;
    const restartNative = vi.fn(async () => {
      expect(gated).toBe(true);
      expect((await readOpenConnection(config.configDir)).proxy).toContain("secret");
    });
    const connection = new OpenConnection(config, {
      withIdleNative: async (action) => {
        gated = true;
        try {
          return await action();
        } finally {
          gated = false;
        }
      },
      restartNative,
    });
    await connection.initialize();
    expect(connection.status()).toEqual({ configured: false, address: null, hasPassword: false });
    const result = await connection.setProxy("http://user:secret@127.0.0.1:8080");
    expect(result).toEqual({
      configured: true,
      address: "http://127.0.0.1:8080/",
      hasPassword: true,
    });
    expect(JSON.stringify(result)).not.toMatch(/user|secret/);
    expect((await stat(join(config.configDir, "connection.json"))).mode & 0o777).toBe(0o600);
    await connection.setProxy("http://user:secret@127.0.0.1:8080");
    expect(restartNative).toHaveBeenCalledOnce();
    const reloaded = new OpenConnection(config, {
      withIdleNative: async (action) => action(),
      restartNative,
    });
    await reloaded.initialize();
    expect(reloaded.status()).toEqual(result);
  });
  it("refuses busy changes before saving, and restores the previous setting if restart fails", async () => {
    const config = await configuration();
    const busy = new OpenConnection(config, {
      withIdleNative: async () => {
        throw new Error("native busy");
      },
      restartNative: vi.fn(),
    });
    await busy.initialize();
    await expect(busy.setProxy("http://localhost:8080")).rejects.toThrow("native busy");
    await expect(readFile(join(config.configDir, "connection.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const restartNative = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("password-secret upstream details"));
    const connection = new OpenConnection(config, {
      withIdleNative: async (action) => action(),
      restartNative,
    });
    await connection.initialize();
    await connection.setProxy("http://old:old-secret@localhost:8080");
    await expect(connection.setProxy("socks5://new:new-secret@localhost:1080")).rejects.toThrow(
      "Предыдущая настройка сохранена",
    );
    expect((await readOpenConnection(config.configDir)).proxy).toBe(
      "http://old:old-secret@localhost:8080",
    );
    expect(connection.status().address).toBe("http://localhost:8080/");
  });
  it("refuses malformed, nonprivate and symlinked saved settings instead of connecting directly", async () => {
    const config = await configuration();
    const path = join(config.configDir, "connection.json");
    await writeFile(path, '{"version":1,"proxy":"http://secret-private-key', { mode: 0o600 });
    await expect(readOpenConnection(config.configDir)).rejects.toThrow("Не удалось прочитать");
    await writeFile(path, JSON.stringify({ version: 1, proxy: "ftp://private:secret@host" }));
    await expect(readOpenConnection(config.configDir)).rejects.toThrow("Некорректный адрес");
    await writeFile(path, JSON.stringify({ version: 1, proxy: null }));
    await chmod(path, 0o644);
    await expect(readOpenConnection(config.configDir)).rejects.toThrow("0600");
    await rm(path);
    await symlink(join(config.configDir, "missing"), path);
    await expect(readOpenConnection(config.configDir)).rejects.toThrow("0600");
  });
  it("uses a separate test tunnel and does not expose upstream failure details", async () => {
    const config = await configuration();
    const connection = new OpenConnection(config, {
      withIdleNative: async (action) => action(),
      restartNative: async () => {},
      probe: async () => {
        throw new Error("user:secret@host private failure");
      },
    });
    await connection.initialize();
    expect((await connection.testProxy()).ok).toBe(false);
    await connection.setProxy("http://user:secret@localhost:8080");
    const result = await connection.testProxy();
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/secret|private failure/);
  });
  it("strips inherited provider secrets and bypasses, and keeps upstream credentials out of native env", async () => {
    const connection = await openProxyEnvironment("http://user:secret@localhost:8080", {
      OPENNEST_CONFIG_DIR: "/private/config",
      OPENNEST_PORT: "4313",
      OPENNEST_TOKEN: "owner-secret",
      OPENROUTER_API_KEY: "old-key",
      HTTPS_PROXY: "http://old-secret",
      NO_PROXY: "*",
    });
    cleanup.push(connection.close);
    expect(connection.env.OPENNEST_CONFIG_DIR).toBe("/private/config");
    expect(connection.env.OPENNEST_PORT).toBe("4313");
    expect(connection.env.OPENNEST_TOKEN).toBeUndefined();
    expect(connection.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(connection.env.NO_PROXY).toBe("localhost,127.0.0.1,::1");
    expect(connection.env.HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(JSON.stringify(connection.env)).not.toContain("secret");
    const direct = await openProxyEnvironment(null, {
      HTTP_PROXY: "http://old-secret",
      NO_PROXY: "*",
    });
    expect(direct.env.HTTP_PROXY).toBeUndefined();
    expect(direct.env.NO_PROXY).toBeUndefined();
  });
  it("requires the authenticated upstream and never connects directly after rejection", async () => {
    const server = createServer();
    const calls: string[] = [];
    server.on("connect", (req, socket) => {
      calls.push(req.url!);
      expect(req.headers["proxy-authorization"]).toBe(
        `Basic ${Buffer.from("user:secret").toString("base64")}`,
      );
      socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as { port: number }).port;
    const connection = await openProxyEnvironment(`http://user:secret@127.0.0.1:${port}`);
    cleanup.push(connection.close);
    expect(await tunnel(connection.env.HTTPS_PROXY!, "should-use-upstream.invalid:443")).not.toBe(
      200,
    );
    expect(calls).toEqual(["should-use-upstream.invalid:443"]);
  });
  it("sends SOCKS5 destination names to the upstream for remote DNS", async () => {
    let hostname: string | undefined;
    const server = tcpServer((socket) => {
      let phase = 0,
        buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (phase === 0 && buffer.length >= 2 && buffer.length >= 2 + buffer[1]!) {
          buffer = buffer.subarray(2 + buffer[1]!);
          phase = 1;
          socket.write(Buffer.from([5, 0]));
        }
        if (
          phase === 1 &&
          buffer.length >= 5 &&
          buffer[3] === 3 &&
          buffer.length >= 7 + buffer[4]!
        ) {
          hostname = buffer.subarray(5, 5 + buffer[4]!).toString();
          phase = 2;
          socket.end(Buffer.from([5, 5, 0, 1, 127, 0, 0, 1, 0, 0]));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as { port: number }).port;
    const connection = await openProxyEnvironment(`socks5://127.0.0.1:${port}`);
    cleanup.push(connection.close);
    expect(await tunnel(connection.env.HTTPS_PROXY!, "upstream-dns-only.invalid:443")).not.toBe(
      200,
    );
    expect(hostname).toBe("upstream-dns-only.invalid");
  });
  it("injects the local plugin without changing inherited provider settings", () => {
    const original = JSON.stringify({ model: "openrouter/vendor/model", plugin: ["existing"] });
    const merged = nativeConfiguration(original, "file:///private/opennest/plugin.js");
    expect(JSON.parse(merged)).toEqual({
      model: "openrouter/vendor/model",
      plugin: ["existing", "file:///private/opennest/plugin.js"],
    });
    expect(nativeConfiguration(merged, "file:///private/opennest/plugin.js")).toBe(merged);
    expect(() => nativeConfiguration("private-invalid-secret", "plugin")).toThrow(
      "Invalid process-local",
    );
  });
});
