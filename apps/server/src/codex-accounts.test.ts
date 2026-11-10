import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexAccounts, type AccountProcess, type CodexAccountsOptions } from "./codex-accounts";
import type { CodexBridge } from "./codex/bridge";
import { AccountRuntimePool } from "./account-runtime";
import { parseClaudeProxy, type ClaudeProxyInput } from "@codexnest/protocol";
import type { JsonlTransport } from "./codex/transport";

const directories: string[] = [];
const managers: CodexAccounts[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const direct: ClaudeProxyInput = { enabled: false, protocol: "http", value: "" };
const proxy: ClaudeProxyInput = {
  enabled: true,
  protocol: "socks5",
  value: "socks5://user:secret@proxy.example.test:1080",
};

describe("CodexAccounts", () => {
  it("imports native metadata without copying credentials or starting another native process", async () => {
    const h = await harness();
    await h.accounts.restore();
    const status = h.accounts.status();
    expect(status.accounts).toHaveLength(1);
    expect(status.accounts[0]).toMatchObject({
      email: "first@example.test",
      plan: "plus",
      authenticated: true,
      proxy: { enabled: false },
    });
    expect(h.openProcess).not.toHaveBeenCalled();
    expect(h.nativeRpc.mock.calls.map(([method]) => method)).not.toContain("account/login/start");
    const saved = await readFile(join(h.root, "codex-accounts.json"), "utf8");
    expect(saved).not.toContain("accessToken");
    expect(saved).not.toContain("refresh_token");
    expect(JSON.stringify(status)).not.toContain("identity");
    expect((await stat(join(h.root, "codex-accounts.json"))).mode & 0o777).toBe(0o600);
  });

  it("persists account selection during active work without mutating shared-daemon auth, including on reconnect", async () => {
    const h = await harness();
    await h.accounts.restore();
    const first = h.accounts.status().currentAccountId;
    const second = await add(h, "second");
    expect(h.accounts.status().currentAccountId).toBe(first);
    h.active.mockReturnValue(2);
    h.bridge.pendingTurnStarts = 1;
    await h.accounts.select(second);
    await h.accounts.restore();
    expect(h.accounts.status().currentAccountId).toBe(second);
    expect(h.nativeRpc.mock.calls.map(([method]) => method)).not.toContain("account/login/start");
    const restarted = new CodexAccounts(h.bridge as unknown as CodexBridge, h.options);
    managers.push(restarted);
    await restarted.initialize();
    await restarted.restore();
    expect(restarted.status().currentAccountId).toBe(second);
    const profile = restarted.launchAccount()!;
    expect(JSON.parse(await readFile(join(profile.home, "auth.json"), "utf8"))).toMatchObject({
      tokens: { refresh_token: "refresh-second" },
    });
    expect((await stat(profile.home)).mode & 0o777).toBe(0o700);
  });

  it("requires an explicit connection before new login and passes that exact proxy to native auth", async () => {
    const h = await harness();
    await h.accounts.restore();
    await expect(h.accounts.startLogin()).rejects.toThrow("Choose a connection");
    const login = await h.accounts.startLogin({ proxy });
    expect(login.state).toBe("waiting");
    expect(h.openProcess).toHaveBeenLastCalledWith(
      expect.any(String),
      false,
      parseClaudeProxy(proxy.value, "socks5"),
    );
    await h.complete("second");
    await vi.waitFor(() => expect(h.accounts.login(login.id).state).toBe("completed"));
    const saved = h.accounts
      .status()
      .accounts.find((account) => account.email === "second@example.test")!;
    expect(saved.proxy).toMatchObject({
      enabled: true,
      protocol: "socks5",
      host: "proxy.example.test",
      hasPassword: true,
    });
    const reauth = await h.accounts.startLogin({ accountId: saved.id });
    expect(h.openProcess).toHaveBeenLastCalledWith(
      expect.any(String),
      false,
      parseClaudeProxy(proxy.value, "socks5"),
    );
    await h.accounts.cancelLogin(reauth.id);
  });

  it("keeps a legacy refresh callback tied to its workspace after selecting another account", async () => {
    const h = await harness();
    await h.accounts.restore();
    const second = await add(h, "second");
    await h.accounts.select(second);
    const tokens = await h.accounts.refreshTokens("workspace-first");
    expect(tokens.chatgptAccountId).toBe("workspace-first");
    expect(h.accounts.status().currentAccountId).toBe(second);
    expect(JSON.stringify(h.accounts.status())).not.toContain(tokens.accessToken);
    await expect(h.accounts.refreshTokens("workspace-missing")).rejects.toThrow("not found");
  });

  it("cancels native login and ignores late successful completion", async () => {
    const h = await harness();
    await h.accounts.restore();
    const login = await h.accounts.startLogin({ proxy: direct });
    const process = h.lastProcess(),
      home = h.lastHome();
    await h.accounts.cancelLogin(login.id);
    process.emit("notification", { method: "account/login/completed", params: { success: true } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.accounts.login(login.id).state).toBe("cancelled");
    expect(h.accounts.status().accounts).toHaveLength(1);
    await expect(stat(home)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deduplicates repeated sign-in and rejects another identity during reauthentication", async () => {
    const h = await harness();
    await h.accounts.restore();
    const second = await add(h, "second");
    expect(await add(h, "second")).toBe(second);
    const login = await h.accounts.startLogin({ accountId: second });
    await h.complete("third");
    await vi.waitFor(() => expect(h.accounts.login(login.id).state).toBe("failed"));
    expect(h.accounts.status().accounts).toHaveLength(2);
    expect(h.accounts.status().accounts.find((account) => account.id === second)?.email).toBe(
      "second@example.test",
    );
  });

  it("expires a pending device login and stops its native polling without changing saved accounts", async () => {
    const h = await harness();
    await h.accounts.restore();
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
    try {
      const login = await h.accounts.startLogin({ proxy: direct });
      const process = h.lastProcess();
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(h.accounts.login(login.id)).toMatchObject({
        state: "failed",
        error: "Codex sign-in expired; start again",
      });
      expect(process.close).toHaveBeenCalled();
      expect(h.accounts.status().accounts).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains previous native credentials during reauthentication so live owners keep their generation", async () => {
    const h = await harness();
    await h.accounts.restore();
    const second = await add(h, "second");
    await h.accounts.select(second);
    const previous = h.accounts.launchAccount()!;
    await add(h, "second");
    const next = h.accounts.launchAccount()!;
    expect(next.home).not.toBe(previous.home);
    expect(await readFile(join(previous.home, "auth.json"), "utf8")).toContain("refresh-second");
    expect(await readFile(join(next.home, "auth.json"), "utf8")).toContain("refresh-second");
  });

  it("removes a selected account and cancels its login while preserving native history and profiles", async () => {
    const h = await harness();
    await h.accounts.restore();
    const first = h.accounts.status().currentAccountId!;
    const second = await add(h, "second");
    await h.accounts.select(second);
    const profile = h.accounts.launchAccount()!;
    const login = await h.accounts.startLogin({ accountId: second });
    await h.accounts.remove(second);
    expect(h.accounts.login(login.id).state).toBe("cancelled");
    expect(h.accounts.status().currentAccountId).toBe(first);
    expect(await readFile(join(profile.home, "auth.json"), "utf8")).toContain("refresh-second");
    await h.accounts.remove(first);
    expect(h.accounts.status().currentAccountId).toBeNull();
    expect(await readFile(join(h.nativeHome, "history.jsonl"), "utf8")).toBe("history");
    await expect(h.accounts.remove("../../outside")).rejects.toThrow("not found");
  });

  it("updates per-account proxy and never changes the global proxy environment file", async () => {
    const h = await harness();
    await h.accounts.restore();
    const id = h.accounts.status().currentAccountId!;
    const status = await h.accounts.updateProxy(id, proxy);
    expect(status.accounts[0]?.proxy).toMatchObject({
      enabled: true,
      protocol: "socks5",
      username: "user",
      hasPassword: true,
    });
    expect(h.nativeRpc.mock.calls.map(([method]) => method)).not.toContain("account/login/start");
    await expect(stat(h.options.proxyEnvFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await h.accounts.updateProxy(id, direct)).accounts[0]?.proxy.enabled).toBe(false);
  });

  it("blocks corrupt stored proxy settings instead of silently switching the account to direct", async () => {
    const h = await harness();
    await h.accounts.restore();
    const path = join(h.root, "codex-accounts.json");
    const saved = JSON.parse(await readFile(path, "utf8"));
    saved.accounts[0].proxyConfigured = true;
    delete saved.accounts[0].proxy;
    await writeFile(path, JSON.stringify(saved));
    const restarted = new CodexAccounts(h.bridge as unknown as CodexBridge, h.options);
    managers.push(restarted);
    await restarted.initialize();
    await restarted.restore();
    expect(() => restarted.launchAccount()).toThrow("Configure this account's connection");
    expect(h.ensure).not.toHaveBeenCalled();
  });

  it("prefers the earliest five-hour reset and excludes exhausted weekly limits without any turn-start RPC", async () => {
    const h = await harness();
    await h.accounts.restore();
    const first = h.accounts.status().currentAccountId!;
    const second = await add(h, "second");
    h.quota.set("first", {
      primary: {
        usedPercent: 10,
        windowDurationMins: 300,
        resetsAt: Math.floor(Date.now() / 1000) + 7200,
      },
      secondary: {
        usedPercent: 20,
        windowDurationMins: 10080,
        resetsAt: Math.floor(Date.now() / 1000) + 86400,
      },
    });
    h.quota.set("second", {
      primary: {
        usedPercent: 20,
        windowDurationMins: 300,
        resetsAt: Math.floor(Date.now() / 1000) + 3600,
      },
      secondary: {
        usedPercent: 30,
        windowDurationMins: 10080,
        resetsAt: Math.floor(Date.now() / 1000) + 86400,
      },
    });
    await h.accounts.refresh();
    expect(h.accounts.status().currentAccountId).toBe(second);
    const previousCalls = h.ensure.mock.calls.length;
    expect(h.accounts.launchAccount()?.id).toBe(second);
    expect(h.ensure).toHaveBeenCalledTimes(previousCalls);
    h.quota.get("second")!.secondary!.usedPercent = 100;
    await h.accounts.refresh();
    expect(h.accounts.status().currentAccountId).toBe(first);
    await h.accounts.setAutoSwitch(false);
    await h.accounts.select(second);
    await h.accounts.refresh();
    expect(h.accounts.status().currentAccountId).toBe(second);
  });

  it("shares concurrent quota reads and ignores an old connection result after proxy editing", async () => {
    const h = await harness();
    await h.accounts.restore();
    const id = h.accounts.status().currentAccountId!;
    let release!: () => void;
    h.beforeQuota = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const first = h.accounts.refresh(id),
      second = h.accounts.refresh(id);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await h.accounts.updateProxy(id, proxy);
    release();
    await Promise.all([first, second]);
    expect(h.ensure).toHaveBeenCalledTimes(1);
    expect(h.accounts.status().accounts[0]?.rateLimits.limits).toBeNull();
  });

  it("warms idle subscribed accounts in separate five-hour slots and stops scheduling when disabled", async () => {
    const h = await harness();
    await h.accounts.restore();
    await add(h, "second");
    for (const name of ["first", "second"])
      h.quota.set(name, {
        primary: null,
        secondary: {
          usedPercent: 20,
          windowDurationMins: 10080,
          resetsAt: Math.floor(Date.now() / 1000) + 86400,
        },
      });
    await h.accounts.refresh();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "setInterval"] });
    try {
      await h.accounts.setWarmLimits(true);
      await vi.advanceTimersByTimeAsync(1);
      await new Promise((resolve) => setImmediate(resolve));
      await vi.waitFor(() =>
        expect(h.runtimeRequests.filter((request) => request.method === "turn/start")).toHaveLength(
          1,
        ),
      );
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.runtimeRequests.filter((request) => request.method === "turn/start")).toHaveLength(
        1,
      );
      await h.accounts.setWarmLimits(false);
      await vi.advanceTimersByTimeAsync(5 * 60 * 60_000);
      expect(h.runtimeRequests.filter((request) => request.method === "turn/start")).toHaveLength(
        1,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists warm-up choice but sends no model request during initialization or reconnect", async () => {
    const h = await harness();
    await h.accounts.restore();
    await h.accounts.setWarmLimits(true);
    const restarted = new CodexAccounts(h.bridge as unknown as CodexBridge, h.options);
    managers.push(restarted);
    await restarted.initialize();
    await restarted.restore();
    expect(restarted.status().warmLimits).toBe(true);
    expect(h.ensure).not.toHaveBeenCalled();
    expect(h.nativeRpc.mock.calls.map(([method]) => method)).not.toContain("turn/start");
  });
});

function token(name: string): string {
  return `header.${Buffer.from(JSON.stringify({ sub: `user-${name}`, email: `${name}@example.test`, "https://api.openai.com/auth": { chatgpt_account_id: `workspace-${name}`, chatgpt_user_id: `user-${name}`, chatgpt_plan_type: "plus" } })).toString("base64url")}.signature`;
}
function responses(name: () => string) {
  return vi.fn<(method: string, params?: unknown) => Promise<any>>(
    async (method: string): Promise<any> => {
      if (method === "account/read")
        return { account: { type: "chatgpt", email: `${name()}@example.test`, planType: "plus" } };
      if (method === "getAuthStatus") return { authMethod: "chatgpt", authToken: token(name()) };
      if (method === "account/login/start")
        return {
          type: "chatgptDeviceCode",
          loginId: "native-login",
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "ABCD-EFGH",
        };
      if (method === "account/rateLimits/read")
        return {
          rateLimits: {
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: null },
            secondary: null,
          },
        };
      return {};
    },
  );
}
async function harness() {
  const root = await mkdtemp(join(tmpdir(), "codex-accounts-test-"));
  directories.push(root);
  const nativeHome = join(root, "native");
  await mkdir(nativeHome);
  await writeFile(join(nativeHome, "history.jsonl"), "history");
  const active = vi.fn(() => 0);
  const nativeRpc = responses(() => "first");
  const bridge = Object.assign(new EventEmitter(), {
    request: nativeRpc,
    requestNative: nativeRpc,
    setRequestRouter: vi.fn(),
    setNativeNotificationFilter: vi.fn(),
    threadActive: () => false,
    pendingTurnStarts: 0,
    activeNativeTurnCount: 0,
    accountSwitching: false,
    accountLoginRequired: false,
  });
  let current: EventEmitter & {
    request: ReturnType<typeof responses>;
    close: ReturnType<typeof vi.fn>;
  };
  let currentHome = "";
  const openProcess = vi.fn(async (home: string, native: boolean): Promise<AccountProcess> => {
    currentHome = home;
    let name = "first";
    if (!native && !home.includes("login-")) {
      const saved = JSON.parse(await readFile(join(home, "auth.json"), "utf8"));
      name = saved.name;
    }
    current = Object.assign(new EventEmitter(), { request: responses(() => name), close: vi.fn() });
    return { transport: current as unknown as JsonlTransport, close: current.close };
  });
  const options: CodexAccountsOptions = {
    stateDir: root,
    codexHome: nativeHome,
    codexBin: "unused",
    proxyEnvFile: join(root, "no-proxy.env"),
    activeTurnCount: active,
    openProcess,
  };
  const quota = new Map<string, any>();
  const runtimeRequests: Array<{ method: string; params: unknown }> = [];
  const h = { beforeQuota: undefined as (() => Promise<void>) | undefined };
  const ensure = vi
    .spyOn(AccountRuntimePool.prototype, "ensure")
    .mockImplementation(async (profile) => {
      const name = profile.native
        ? "first"
        : JSON.parse(await readFile(join(profile.home, "auth.json"), "utf8")).name;
      const request = responses(() => name);
      const client = Object.assign(new EventEmitter(), {
        request,
        activeNativeTurnCount: 0,
        pendingTurnStarts: 0,
      });
      const original = request.getMockImplementation()!;
      request.mockImplementation(async (method, params) => {
        runtimeRequests.push({ method, params });
        if (method === "thread/start") return { thread: { id: randomUUID() } };
        if (method === "turn/start") {
          const turn = { id: randomUUID(), status: "completed" };
          setImmediate(() =>
            client.emit("notification", {
              method: "turn/completed",
              params: { threadId: (params as any).threadId, turn },
            }),
          );
          return { turn };
        }
        if (method === "account/rateLimits/read") {
          await h.beforeQuota?.();
          if (quota.has(name)) return { rateLimits: quota.get(name) };
        }
        return original(method, params);
      });
      return { descriptor: { id: profile.id } as any, bridge: client as unknown as CodexBridge };
    });
  const accounts = new CodexAccounts(bridge as unknown as CodexBridge, options);
  managers.push(accounts);
  await accounts.initialize();
  return Object.assign(h, {
    accounts,
    nativeRpc,
    quota,
    ensure,
    runtimeRequests,
    bridge,
    openProcess,
    root,
    active,
    options,
    nativeHome,
    lastProcess: () => current!,
    lastHome: () => currentHome,
    complete: async (name: string) => {
      current!.request.mockImplementation(responses(() => name));
      await writeFile(
        join(currentHome, "auth.json"),
        JSON.stringify({ name, tokens: { refresh_token: `refresh-${name}` } }),
      );
      current!.emit("notification", {
        method: "account/login/completed",
        params: { success: true },
      });
      current!.emit("notification", { method: "account/updated", params: { authMode: "chatgpt" } });
    },
  });
}
async function add(h: Awaited<ReturnType<typeof harness>>, name: string): Promise<string> {
  const login = await h.accounts.startLogin({ proxy: direct });
  expect(login.state).toBe("waiting");
  expect(login.userCode).toBe("ABCD-EFGH");
  await h.complete(name);
  await vi.waitFor(() => expect(h.accounts.login(login.id).state).toBe("completed"));
  return h.accounts.login(login.id).accountId!;
}
