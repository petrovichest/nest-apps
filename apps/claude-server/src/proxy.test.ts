import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { parseClaudeProxy } from "@codexnest/protocol";
import { createClaudeProxyEnvironment, proxyStatus, testClaudeProxy } from "./proxy.js";

describe("managed Claude proxy connections", () => {
  it("empty config directory preserves the native default global-file location", async () => {
    const connection = await createClaudeProxyEnvironment(null, "", {
      env: {
        CLAUDE_CONFIG_DIR: "/inherited/override",
        CLAUDE_SECURESTORAGE_CONFIG_DIR: "/original/storage",
      },
    });
    expect(Object.hasOwn(connection.env, "CLAUDE_CONFIG_DIR")).toBe(false);
    expect(connection.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe("/original/storage");
    await connection.close();
  });
  it("explicit direct connection clears inherited proxies and token overrides", async () => {
    const connection = await createClaudeProxyEnvironment(null, "/account", {
      env: {
        HTTPS_PROXY: "private",
        http_proxy: "private",
        ALL_PROXY: "private",
        no_proxy: "*",
        ANTHROPIC_API_KEY: "private",
        CLAUDE_CODE_OAUTH_TOKEN: "private",
        CLAUDECODE: "1",
        CLAUDE_SECURESTORAGE_CONFIG_DIR: "/shared/wrong-account",
        CUSTOM_SETTING: "kept",
      },
    });
    expect(connection.env).toEqual({
      CLAUDE_CONFIG_DIR: "/account",
      CUSTOM_SETTING: "kept",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    await connection.close();
  });
  it.each(["http", "https"] as const)(
    "uses %s upstream directly and exposes only masked status",
    async (protocol) => {
      const proxy = parseClaudeProxy(`${protocol}://user:secret@proxy.example:443`);
      const createServer = vi.fn();
      const connection = await createClaudeProxyEnvironment(proxy, "/account", {
        env: {},
        createServer,
      });
      expect(connection.env.HTTPS_PROXY).toBe(proxy.url);
      expect(createServer).not.toHaveBeenCalled();
      expect(proxyStatus(proxy)).toEqual({
        enabled: true,
        protocol,
        host: "proxy.example",
        port: 443,
        username: "user",
        hasPassword: true,
      });
      expect(JSON.stringify(proxyStatus(proxy))).not.toContain("secret");
      await connection.close();
    },
  );
  it("owns a loopback SOCKS bridge with remote DNS and closes once", async () => {
    const server = Object.assign(new EventEmitter(), {
      port: 12345,
      listen: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    });
    const createServer = vi.fn(() => server);
    const connection = await createClaudeProxyEnvironment(
      parseClaudeProxy("socks5://user:secret@proxy.example:1080"),
      "/account",
      { env: {}, createServer },
    );
    expect(createServer.mock.calls[0]?.[0]).toMatchObject({
      host: "127.0.0.1",
      port: 0,
      verbose: false,
    });
    const settings = createServer.mock.calls[0]![0]!;
    expect(await settings.prepareRequestFunction!({} as never)).toEqual({
      upstreamProxyUrl: "socks5h://user:secret@proxy.example:1080",
    });
    expect(connection.env.HTTPS_PROXY).toBe("http://127.0.0.1:12345");
    await connection.close();
    await connection.close();
    expect(server.close).toHaveBeenCalledExactlyOnceWith(true);
  });
  it("closes a failed bridge and never discloses the upstream error", async () => {
    const server = Object.assign(new EventEmitter(), {
      port: 0,
      listen: vi.fn(async () => {
        throw new Error("SECRET");
      }),
      close: vi.fn(async () => {}),
    });
    await expect(
      createClaudeProxyEnvironment(
        parseClaudeProxy("socks5://user:secret@proxy.example:1080"),
        "/account",
        { createServer: () => server },
      ),
    ).rejects.toThrow("Could not start the account proxy connection");
    expect(server.close).toHaveBeenCalledWith(true);
  });
  it("tests the selected connection without account auth or secret errors", async () => {
    const probe = vi.fn(async () => {});
    const input = {
      enabled: true,
      protocol: "http" as const,
      value: "http://user:secret@proxy.example:8080",
    };
    const result = await testClaudeProxy(input, { env: {}, probe });
    expect(result.ok).toBe(true);
    expect(probe).toHaveBeenCalledWith("http://user:secret@proxy.example:8080");
    const failed = await testClaudeProxy(input, {
      probe: async () => {
        throw new Error("secret");
      },
    });
    expect(failed.ok).toBe(false);
    expect(JSON.stringify(failed)).not.toContain("secret");
  });
});
