import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { request } from "node:http";
import { proxyEnvironment } from "./proxy";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
it("requires a proxy and removes inherited provider credentials and bypasses", async () => {
  await expect(proxyEnvironment("")).rejects.toThrow("прокси");
  const proxy = await proxyEnvironment("http://user:secret@127.0.0.1:9", {
    HTTPS_PROXY: "http://old",
    NO_PROXY: "*",
    GEMINI_API_KEY: "key",
    GOOGLE_APPLICATION_CREDENTIALS: "/private",
    CODEXNEST_TOKEN: "parent-owner-token",
    GEMININEST_TOKEN: "gemini-owner-token",
  });
  cleanups.push(proxy.close);
  expect(proxy.env.HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:/);
  expect(proxy.env.NO_PROXY).toBe("localhost,127.0.0.1,::1");
  expect(proxy.env.GEMINI_API_KEY).toBeUndefined();
  expect(proxy.env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
  expect(proxy.env.CODEXNEST_TOKEN).toBeUndefined();
  expect(proxy.env.GEMININEST_TOKEN).toBeUndefined();
  expect(JSON.stringify(proxy.env)).not.toContain("secret");
});
it("tunnels to the configured authenticated upstream and never falls back on rejection", async () => {
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
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as { port: number };
  const proxy = await proxyEnvironment(`http://user:secret@127.0.0.1:${address.port}`);
  cleanups.push(proxy.close);
  const url = new URL(proxy.env.HTTPS_PROXY!);
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request({
      host: url.hostname,
      port: url.port,
      method: "CONNECT",
      path: "oauth2.googleapis.com:443",
    });
    req.on("connect", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
  expect(status).not.toBe(200);
  expect(calls).toEqual(["oauth2.googleapis.com:443"]);
});
