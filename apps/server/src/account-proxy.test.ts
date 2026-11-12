import { afterEach, expect, it } from "vitest";
import { request } from "node:http";
import type { ParsedClaudeProxy } from "@codexnest/protocol";
import { accountProxy, createAccountProxyConnection } from "./account-proxy";

const connections: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
});

it("rejects missing or corrupt proxy metadata instead of treating it as a direct choice", async () => {
  await expect(
    createAccountProxyConnection(undefined as unknown as ParsedClaudeProxy),
  ).rejects.toThrow("Invalid account proxy settings");
  await expect(
    createAccountProxyConnection({
      url: "http://user:private-password@bad/path",
      protocol: "http",
    } as ParsedClaudeProxy),
  ).rejects.toThrow("Invalid account proxy settings");
  expect(() =>
    accountProxy({ enabled: true, protocol: "http", value: "invalid-private-password" }),
  ).toThrow("Proxy address is invalid");
});

it("requires authentication on the private relay and removes inherited wildcard bypasses even for explicit direct mode", async () => {
  const connection = await createAccountProxyConnection(null, {
    HTTP_PROXY: "http://old.invalid:1",
    hTTps_pRoXY: "http://old.invalid:2",
    NO_PROXY: "*",
    no_proxy: "*",
  });
  connections.push(connection);
  expect(connection.env.NO_PROXY).toBe("localhost,127.0.0.1,::1");
  expect(connection.env.hTTps_pRoXY).toBeUndefined();
  expect(connection.env.HTTPS_PROXY).toBe(connection.env.HTTP_PROXY);
  const url = new URL(connection.url);
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const pending = request(
      {
        hostname: url.hostname,
        port: url.port,
        method: "GET",
        path: "http://blocked.invalid/",
        agent: false,
        timeout: 2_000,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    pending.once("error", reject);
    pending.once("timeout", () => pending.destroy(new Error("Relay authentication timed out")));
    pending.end();
  });
  expect(status).toBe(407);
});
