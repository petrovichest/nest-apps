import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaudeProxyInput } from "@codexnest/protocol";
import {
  ClaudeAccounts,
  authorizationCode,
  type NativeClaudeAuth,
  type NativeClaudeUsage,
  type ClaudeAccountsOptions,
} from "./accounts.js";
import type { Config } from "./config.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.unstubAllEnvs();
});
const NOW = 1_800_000_000_000;
const direct: ClaudeProxyInput = { enabled: false, protocol: "http", value: "" };
const usage = (fiveUsed = 20, weeklyUsed = 30): NativeClaudeUsage => ({
  primary: { usedPercent: fiveUsed, windowDurationMins: 300, resetsAt: NOW + 10_000_000 },
  secondary: { usedPercent: weeklyUsed, windowDurationMins: 10080, resetsAt: NOW + 100_000_000 },
});
class LoginChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  inputs: string[] = [];
  kill = vi.fn((signal: string) => {
    this.signalCode = signal;
    this.emit("close", null, signal);
    return true;
  });
  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => this.inputs.push(chunk.toString()));
  }
  output(value: string) {
    this.stdout.write(value);
  }
  close(code = 0) {
    this.exitCode = code;
    this.emit("exit", code, null);
    this.emit("close", code, null);
  }
}
async function fixture(overrides: ClaudeAccountsOptions = {}, nativeDefault = false) {
  const directory = await mkdtemp("/tmp/claude-accounts-");
  const config: Config = {
    host: "localhost",
    port: 1,
    stateDir: join(directory, "state"),
    configDir: nativeDefault ? join(directory, "home", ".claude") : join(directory, "native"),
    runtimeDir: join(directory, "runtime"),
    claudeBin: "/fake/claude",
    nodeBin: process.execPath,
    releasePath: "/release",
    runnerPath: "/release/runner",
    serverEnvFile: "/env",
    token: "test-private-token",
    allowedOrigins: new Set(),
  };
  await mkdir(config.configDir, { recursive: true });
  await mkdir(config.stateDir, { recursive: true });
  const auth = new Map<string, NativeClaudeAuth>([
    [
      config.configDir,
      {
        loggedIn: true,
        authMethod: "claude.ai",
        email: "first@example.com",
        subscriptionType: "max",
      },
    ],
  ]);
  const limits = new Map<string, NativeClaudeUsage>();
  const children: Array<{ child: LoginChild; env: NodeJS.ProcessEnv; args: string[] }> = [];
  let nextEmail = "second@example.com";
  const options: ClaudeAccountsOptions = {
    env: {},
    poll: false,
    now: () => NOW,
    readVersion: async () => "2.1.289",
    readAuth: async (account) => auth.get(account.configDir) ?? { loggedIn: false },
    readUsage: async (account) => limits.get(account.configDir) ?? usage(),
    spawnProcess: vi.fn((_bin, args, options) => {
      const env = options.env as NodeJS.ProcessEnv;
      const child = new LoginChild();
      auth.set(env.CLAUDE_CONFIG_DIR!, {
        loggedIn: true,
        authMethod: "claude.ai",
        email: nextEmail,
        subscriptionType: "max",
      });
      children.push({ child, env, args: args as string[] });
      return child;
    }) as unknown as typeof spawn,
    proxyEnvironment: async (proxy, configDir) => ({
      env: { CLAUDE_CONFIG_DIR: configDir, ...(proxy ? { HTTPS_PROXY: proxy.url } : {}) },
      close: vi.fn(async () => {}),
    }),
    ...(nativeDefault ? { defaultConfigDir: config.configDir } : {}),
    ...overrides,
  };
  const accounts = new ClaudeAccounts(config, options);
  await accounts.initialize();
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  cleanup.push(() => accounts.close());
  async function add(email: string, input = direct) {
    nextEmail = email;
    const login = await accounts.startLogin({ proxy: input });
    const child = children.at(-1)!.child;
    child.output(
      "If the browser didn't open, visit: https://claude.ai/oauth/authorize?state=test\n",
    );
    await accounts.submitCode(login.id, "code#test");
    child.close();
    await vi.waitFor(() => expect(accounts.login(login.id).state).toBe("completed"));
    const id = accounts.login(login.id).accountId!;
    await accounts.refresh(id);
    return { id, configDir: children.at(-1)!.env.CLAUDE_CONFIG_DIR!, child };
  }
  return {
    accounts,
    config,
    options,
    auth,
    limits,
    children,
    add,
    setEmail: (email: string) => {
      nextEmail = email;
    },
  };
}

describe("native Claude account storage and login", () => {
  it("retains the service HTTPS proxy after verifying the original authenticated native account", async () => {
    const upstream = "https://native-user:native-secret@proxy.example:8443";
    const readUsage = vi.fn(
      async (account: Parameters<NonNullable<ClaudeAccountsOptions["readUsage"]>>[0]) => {
        if (!account.proxy || account.proxy.url !== upstream)
          throw new Error("Direct native usage is unavailable");
        return usage(35, 40);
      },
    );
    const { accounts, config, options, add } = await fixture(
      { env: { HTTPS_PROXY: upstream, HTTP_PROXY: "http://other-proxy.example:8080" }, readUsage },
      true,
    );
    const original = accounts.status().currentAccountId!;
    await accounts.refresh(original);
    expect(accounts.status().accounts[0]).toMatchObject({
      authenticated: true,
      proxy: {
        enabled: true,
        protocol: "https",
        host: "proxy.example",
        port: 8443,
        hasPassword: true,
      },
      rateLimits: { refreshError: false, limits: { primary: { usedPercent: 35 } } },
    });
    expect(readUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultConfig: true,
        proxy: expect.objectContaining({ url: upstream }),
      }),
    );
    expect(JSON.stringify(accounts.status())).not.toContain("native-secret");
    expect((await stat(join(config.stateDir, "claude-accounts.json"))).mode & 0o777).toBe(0o600);
    const added = await add("direct@example.com");
    await accounts.select(added.id);
    expect((await accounts.launchAccount()).proxy).toBeNull();
    await accounts.updateProxy(original, direct);
    const reopened = new ClaudeAccounts(config, options);
    cleanup.push(() => reopened.close());
    await reopened.initialize();
    await reopened.select(original);
    expect((await reopened.launchAccount()).proxy).toBeNull();
    expect(
      reopened.status().accounts.find((account) => account.id === original)?.proxy.enabled,
    ).toBe(false);
  });
  it("upgrades an already saved original null proxy without overwriting explicit or managed direct choices", async () => {
    const { accounts, config, options, add } = await fixture();
    const original = accounts.status().currentAccountId!;
    const managed = await add("direct@example.com");
    const path = join(config.stateDir, "claude-accounts.json");
    const saved = JSON.parse(await readFile(path, "utf8"));
    for (const account of saved.accounts) delete account.proxyConfigured;
    await writeFile(path, JSON.stringify(saved), { mode: 0o600 });
    const reopened = new ClaudeAccounts(config, {
      ...options,
      env: { https_proxy: "http://user:private@proxy.example:8080" },
    });
    cleanup.push(() => reopened.close());
    await reopened.initialize();
    expect(
      reopened.status().accounts.find((account) => account.id === original)?.proxy,
    ).toMatchObject({ enabled: true, host: "proxy.example" });
    expect(
      reopened.status().accounts.find((account) => account.id === managed.id)?.proxy.enabled,
    ).toBe(false);
    await reopened.updateProxy(original, {
      enabled: true,
      protocol: "http",
      value: "chosen.example:3128",
    });
    const explicitlySaved = JSON.parse(await readFile(path, "utf8"));
    delete explicitlySaved.accounts.find(
      (account: { accountId: string }) => account.accountId === original,
    ).proxyConfigured;
    await writeFile(path, JSON.stringify(explicitlySaved), { mode: 0o600 });
    const preserved = new ClaudeAccounts(config, {
      ...options,
      env: { HTTPS_PROXY: "http://wrong.example:8080" },
    });
    cleanup.push(() => preserved.close());
    await preserved.initialize();
    expect(preserved.status().accounts.find((account) => account.id === original)?.proxy.host).toBe(
      "chosen.example",
    );
  });
  it.each(["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"])(
    "imports the original native %s connection without exposing credentials",
    async (name) => {
      const { accounts } = await fixture({
        env: { [name]: "socks5://user:private@proxy.example:1080" },
      });
      expect(accounts.status().accounts[0]?.proxy).toMatchObject({
        enabled: true,
        protocol: "socks5",
        host: "proxy.example",
        port: 1080,
      });
      expect(JSON.stringify(accounts.status())).not.toContain("private");
    },
  );
  it("keeps settings available for an invalid imported proxy and never falls back to direct", async () => {
    const readUsage = vi.fn(async () => usage());
    const { accounts } = await fixture({
      env: { HTTPS_PROXY: "invalid-proxy-with-private-password" },
      readUsage,
    });
    expect(accounts.status().accounts[0]?.connectionError).toContain("needs configuration");
    await expect(accounts.launchAccount()).rejects.toThrow("needs configuration");
    await accounts.refresh();
    expect(readUsage).not.toHaveBeenCalled();
    expect(accounts.status().accounts[0]?.rateLimits).toMatchObject({
      refreshing: false,
      refreshError: true,
    });
    expect(JSON.stringify(accounts.status())).not.toContain("private-password");
    const id = accounts.status().currentAccountId!;
    await accounts.updateProxy(id, direct);
    expect((await accounts.launchAccount()).proxy).toBeNull();
    await accounts.refresh(id);
    expect(accounts.status().accounts[0]?.rateLimits.refreshError).toBe(false);
  });
  it.each([false, true])(
    "uses native default auth/global settings only for the original default slot=%s",
    async (nativeDefault) => {
      vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
      const envs: NodeJS.ProcessEnv[] = [];
      const spawned = vi.fn((_bin: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
        const child = new LoginChild();
        envs.push(options.env);
        queueMicrotask(() => {
          if (args.includes("status"))
            child.output(
              JSON.stringify({
                loggedIn: true,
                authMethod: "claude.ai",
                email: "native@example.com",
                subscriptionType: "max",
              }),
            );
          child.close();
        });
        return child;
      }) as unknown as typeof spawn;
      const { accounts, config, options } = await fixture(
        { readAuth: undefined, spawnProcess: spawned },
        nativeDefault,
      );
      expect(accounts.status().accounts[0]?.email).toBe("native@example.com");
      expect((await accounts.launchAccount()).defaultConfig).toBe(nativeDefault ? true : undefined);
      expect(envs[0]?.CLAUDE_CONFIG_DIR).toBe(nativeDefault ? undefined : config.configDir);
      const reopened = new ClaudeAccounts(config, options);
      cleanup.push(() => reopened.close());
      await reopened.initialize();
      expect((await reopened.launchAccount()).defaultConfig).toBe(nativeDefault ? true : undefined);
    },
  );
  it("copies native default MCP configuration from the home global file without identity", async () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
    const { accounts, config, children } = await fixture({}, true);
    const globalPath = join(config.configDir, "..", ".claude.json");
    const contents = JSON.stringify({
      mcpServers: { fromHome: { command: "echo" } },
      oauthAccount: { emailAddress: "private@example.com" },
      userID: "private",
    });
    await writeFile(globalPath, contents);
    const login = await accounts.startLogin({ proxy: direct });
    const managed = children.at(-1)!.env.CLAUDE_CONFIG_DIR!;
    expect(await readFile(join(managed, ".claude.json"), "utf8")).toContain("fromHome");
    expect(await readFile(join(managed, ".claude.json"), "utf8")).not.toContain("private");
    expect(await readFile(globalPath, "utf8")).toBe(contents);
    await accounts.cancelLogin(login.id);
    await accounts.remove(accounts.status().currentAccountId!);
    const next = await accounts.startLogin({ proxy: direct });
    expect(
      await readFile(join(children.at(-1)!.env.CLAUDE_CONFIG_DIR!, ".claude.json"), "utf8"),
    ).toContain("fromHome");
    await accounts.cancelLogin(next.id);
  });
  it("never copies an outside home global file for custom native directories", async () => {
    const { accounts, config, children } = await fixture();
    await writeFile(
      join(config.configDir, "..", ".claude.json"),
      JSON.stringify({ mcpServers: { wrongHome: { command: "echo" } } }),
    );
    const login = await accounts.startLogin({ proxy: direct });
    await expect(
      stat(join(children.at(-1)!.env.CLAUDE_CONFIG_DIR!, ".claude.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await accounts.cancelLogin(login.id);
  });
  it("prefers native legacy global config and never reads home fallback for a custom slot", async () => {
    const { accounts, config, children } = await fixture();
    await writeFile(
      join(config.configDir, "..", ".claude.json"),
      JSON.stringify({ mcpServers: { wrongHome: { command: "echo" } } }),
    );
    await writeFile(
      join(config.configDir, ".claude.json"),
      JSON.stringify({ mcpServers: { modern: { command: "echo" } } }),
    );
    await writeFile(
      join(config.configDir, ".config.json"),
      JSON.stringify({
        mcpServers: { legacy: { command: "echo" } },
        oauthAccount: { secret: true },
      }),
    );
    const login = await accounts.startLogin({ proxy: direct });
    const seeded = await readFile(
      join(children.at(-1)!.env.CLAUDE_CONFIG_DIR!, ".claude.json"),
      "utf8",
    );
    expect(seeded).toContain("legacy");
    expect(seeded).not.toContain("modern");
    expect(seeded).not.toContain("wrongHome");
    expect(seeded).not.toContain("secret");
    await accounts.cancelLogin(login.id);
  });
  it("imports existing identity without moving credentials and keeps status secret-free", async () => {
    const { accounts, config } = await fixture();
    expect(accounts.status()).toMatchObject({
      cliVersion: "2.1.289",
      autoSwitch: true,
      accounts: [{ email: "first@example.com", plan: "max", authenticated: true }],
    });
    const current = await accounts.launchAccount();
    expect(current.configDir).toBe(config.configDir);
    expect(accounts.accountIdForConfigDir(config.configDir)).toBe(current.accountId);
    expect((await stat(join(config.stateDir, "claude-accounts.json"))).mode & 0o777).toBe(0o600);
  });
  it("isolates credentials while sharing history/settings and copying only MCP config", async () => {
    const { accounts, config, children, setEmail } = await fixture();
    await writeFile(join(config.configDir, "settings.json"), JSON.stringify({ theme: "dark" }));
    await writeFile(
      join(config.configDir, ".claude.json"),
      JSON.stringify({
        oauthAccount: { email: "secret" },
        policyCache: "private",
        mcpServers: { test: { command: "echo" } },
        projects: {
          "/project": {
            mcpServers: { project: { command: "echo" } },
            hasTrustDialogAccepted: true,
            accountCache: "secret",
          },
        },
      }),
    );
    setEmail("new@example.com");
    const login = await accounts.startLogin({
      proxy: { enabled: true, protocol: "http", value: "http://user:secret@proxy.example:8080" },
    });
    const { child, env, args } = children.at(-1)!;
    expect(args).toEqual(["auth", "login", "--claudeai"]);
    expect(env.HTTPS_PROXY).toBe("http://user:secret@proxy.example:8080");
    expect(env.CLAUDE_CONFIG_DIR).not.toBe(config.configDir);
    expect(await readlink(join(env.CLAUDE_CONFIG_DIR!, "projects"))).toBe(
      join(config.configDir, "projects"),
    );
    expect(await readlink(join(env.CLAUDE_CONFIG_DIR!, "settings.json"))).toBe(
      join(config.configDir, "settings.json"),
    );
    const seeded = await readFile(join(env.CLAUDE_CONFIG_DIR!, ".claude.json"), "utf8");
    expect(seeded).toContain("mcpServers");
    expect(seeded).not.toContain("secret");
    expect(seeded).not.toContain("policyCache");
    child.output("https://claude.ai/oauth/auth");
    expect(accounts.login(login.id).url).toBeNull();
    child.output("orize?state=test\n");
    expect(accounts.login(login.id).url).toBe("https://claude.ai/oauth/authorize?state=test");
    await accounts.submitCode(login.id, "http://localhost/callback?code=abc&state=test");
    expect(child.inputs).toEqual(["abc#test\n"]);
    child.close();
    await vi.waitFor(() => expect(accounts.login(login.id).state).toBe("completed"));
    expect(JSON.stringify(accounts.status())).not.toContain("secret");
  });
  it("reauthenticates the same email under its stable account ID and survives restart", async () => {
    const { accounts, config, options, add } = await fixture();
    const first = accounts.status().currentAccountId!;
    await add("first@example.com");
    expect(accounts.status().accounts).toHaveLength(1);
    expect(accounts.status().currentAccountId).toBe(first);
    expect(accounts.accountIdForConfigDir(config.configDir)).toBe(first);
    const reopened = new ClaudeAccounts(config, options);
    cleanup.push(() => reopened.close());
    await reopened.initialize();
    expect(reopened.status().accounts[0]?.id).toBe(first);
    expect(reopened.accountIdForConfigDir(config.configDir)).toBe(first);
  });
  it("preserves a saved proxy when reauthentication omits proxy input", async () => {
    const { accounts, add, children, setEmail } = await fixture();
    const account = await add("proxied@example.com", {
      enabled: true,
      protocol: "https",
      value: "https://user:secret@proxy.example:443",
    });
    setEmail("proxied@example.com");
    const login = await accounts.startLogin({ accountId: account.id });
    expect(children.at(-1)!.env.HTTPS_PROXY).toBe("https://user:secret@proxy.example");
    await accounts.cancelLogin(login.id);
    expect(accounts.login(login.id).state).toBe("cancelled");
  });
  it("requires verified native Claude.ai identity after login exit", async () => {
    const { accounts, children, auth } = await fixture();
    const login = await accounts.startLogin({ proxy: direct });
    const child = children.at(-1)!;
    auth.set(child.env.CLAUDE_CONFIG_DIR!, { loggedIn: true, authMethod: "api_key" });
    child.child.close();
    await vi.waitFor(() => expect(accounts.login(login.id).state).toBe("failed"));
    expect(accounts.status().accounts).toHaveLength(1);
  });
  it("cancels verification without storing an account after auth status completes", async () => {
    let verify: ((value: NativeClaudeAuth) => void) | undefined;
    const { accounts, children } = await fixture({
      readAuth: async (account) =>
        account.configDir.endsWith("native")
          ? { loggedIn: true, authMethod: "claude.ai", email: "first@example.com" }
          : new Promise((resolve) => {
              verify = resolve;
            }),
    });
    const login = await accounts.startLogin({ proxy: direct });
    const entry = children.at(-1)!;
    entry.child.close();
    await vi.waitFor(() => expect(verify).toBeDefined());
    await accounts.cancelLogin(login.id);
    verify!({ loggedIn: true, authMethod: "claude.ai", email: "cancelled@example.com" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(accounts.status().accounts).toHaveLength(1);
    expect(accounts.login(login.id).state).toBe("cancelled");
    await expect(stat(entry.env.CLAUDE_CONFIG_DIR!)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("deleting an account cancels its pending reauthentication without restoring the entry", async () => {
    const { accounts, config, children } = await fixture();
    const id = accounts.status().currentAccountId!;
    const original = join(config.configDir, ".credentials.json");
    await writeFile(original, "fixture original credentials");
    const login = await accounts.startLogin({ accountId: id });
    const entry = children.at(-1)!;
    entry.child.output("https://claude.ai/oauth/authorize?state=test\n");
    expect(accounts.login(login.id).state).toBe("waitingCode");
    await accounts.remove(id);
    expect(accounts.login(login.id).state).toBe("cancelled");
    expect(entry.child.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(stat(entry.env.CLAUDE_CONFIG_DIR!)).rejects.toMatchObject({ code: "ENOENT" });
    entry.child.close();
    await new Promise((resolve) => setImmediate(resolve));
    expect(accounts.status().accounts).toEqual([]);
    expect(await readFile(original, "utf8")).toBe("fixture original credentials");
  });
  it("deleting during reauthentication verification cannot resurrect the removed account", async () => {
    let verify: ((value: NativeClaudeAuth) => void) | undefined;
    const { accounts, config, children } = await fixture({
      readAuth: async (account) =>
        account.configDir.endsWith("native")
          ? { loggedIn: true, authMethod: "claude.ai", email: "first@example.com" }
          : new Promise((resolve) => {
              verify = resolve;
            }),
    });
    const id = accounts.status().currentAccountId!;
    const login = await accounts.startLogin({ accountId: id });
    const entry = children.at(-1)!;
    entry.child.close();
    await vi.waitFor(() => expect(verify).toBeDefined());
    await accounts.remove(id);
    verify!({ loggedIn: true, authMethod: "claude.ai", email: "first@example.com" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(accounts.login(login.id).state).toBe("cancelled");
    expect(accounts.status().accounts).toEqual([]);
    expect(
      JSON.parse(await readFile(join(config.stateDir, "claude-accounts.json"), "utf8")).accounts,
    ).toEqual([]);
    await expect(stat(entry.env.CLAUDE_CONFIG_DIR!)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("preserves inherited native auth for an unsigned legacy account", async () => {
    const { accounts } = await fixture({ readAuth: async () => ({ loggedIn: false }) });
    expect((await accounts.launchAccount()).proxy).toBeUndefined();
  });
  it("accepts complete codes and callback links but rejects multiline input", () => {
    expect(authorizationCode(" code#state ")).toBe("code#state");
    expect(authorizationCode("https://callback.example?code=foo&state=bar")).toBe("foo#bar");
    expect(() => authorizationCode("code\nother")).toThrow("complete");
  });
});

describe("Claude quota account selection", () => {
  it("chooses greatest five-hour remainder and excludes exhausted weekly/model quotas", async () => {
    const { accounts, config, limits, add } = await fixture();
    const failed = accounts.status().currentAccountId!;
    limits.set(config.configDir, usage(100, 10));
    const weekly = await add("weekly@example.com");
    limits.set(weekly.configDir, usage(1, 100));
    const model = await add("opus@example.com");
    limits.set(model.configDir, {
      ...usage(5, 10),
      modelLimits: { opus: usage(10, 100).secondary },
    });
    const good = await add("ready@example.com");
    limits.set(good.configDir, usage(20, 70));
    expect((await accounts.rotate(failed, "claude-opus-4-6"))?.accountId).toBe(good.id);
    expect(await accounts.confirmQuotaExhausted(model.id, "opus")).toBe(true);
    await accounts.select(failed);
    expect((await accounts.rotate(failed, "default"))?.accountId).toBe(good.id);
    await accounts.select(failed);
    expect((await accounts.rotate(failed, "haiku"))?.accountId).toBe(model.id);
  });
  it("coalesces concurrent failures against the globally selected account", async () => {
    const { accounts, config, limits, add } = await fixture();
    const failed = accounts.status().currentAccountId!;
    limits.set(config.configDir, usage(100));
    const good = await add("ready@example.com");
    const results = await Promise.all([accounts.rotate(failed), accounts.rotate(failed)]);
    expect(results.map((result) => result?.accountId)).toEqual([good.id, good.id]);
  });
  it("does not switch when disabled, exhausted or windows unknown", async () => {
    const { accounts, config, limits } = await fixture();
    const id = accounts.status().currentAccountId!;
    await accounts.setAutoSwitch(false);
    expect(await accounts.rotate(id)).toBeNull();
    await accounts.setAutoSwitch(true);
    limits.set(config.configDir, { primary: null, secondary: null });
    expect(await accounts.rotate(id)).toBeNull();
    limits.set(config.configDir, usage(100, 100));
    expect(await accounts.rotate(id)).toBeNull();
  });
  it("ignores a stale in-flight usage result after proxy settings change", async () => {
    let release: ((usage: NativeClaudeUsage) => void) | undefined;
    const { accounts } = await fixture({
      readUsage: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const id = accounts.status().currentAccountId!;
    const refreshing = accounts.refresh(id);
    await vi.waitFor(() => expect(release).toBeDefined());
    await accounts.updateProxy(id, {
      enabled: true,
      protocol: "http",
      value: "proxy.example:8080",
    });
    release!(usage(1));
    await refreshing;
    expect(accounts.status().accounts[0]?.rateLimits.limits).toBeNull();
  });
});
