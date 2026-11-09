import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexAccounts, type AccountProcess, type CodexAccountsOptions } from "./codex-accounts";
import type { CodexBridge } from "./codex/bridge";
import type { JsonlTransport } from "./codex/transport";

const directories: string[] = [];
const managers: CodexAccounts[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("CodexAccounts", () => {
  it("imports native auth without copying secrets or starting another process", async () => {
    const { accounts, bridge, openProcess, root } = await harness();
    await accounts.restore();
    const status = accounts.status();
    expect(status.accounts).toHaveLength(1);
    expect(status.accounts[0]).toMatchObject({
      email: "first@example.test",
      plan: "plus",
      authenticated: true,
    });
    expect(status.currentAccountId).toBe(status.accounts[0]!.id);
    expect(openProcess).not.toHaveBeenCalled();
    expect(bridge.request.mock.calls.some(([method]) => method === "account/login/start")).toBe(
      false,
    );
    const saved = await readFile(join(root, "codex-accounts.json"), "utf8");
    expect(saved).not.toContain("accessToken");
    expect(saved).not.toContain("refresh_token");
    expect(JSON.stringify(status)).not.toContain("identity");
    expect((await stat(join(root, "codex-accounts.json"))).mode & 0o777).toBe(0o600);
  });

  it("saves a native device login, switches accounts, and restores the choice after restart", async () => {
    const h = await harness();
    await h.accounts.restore();
    const original = h.accounts.status().currentAccountId!;
    const added = await add(h, "second");
    expect(h.accounts.status().currentAccountId).toBe(original);
    const selected = await h.accounts.select(added);
    expect(selected.currentAccountId).toBe(added);
    expect(h.bridge.request).toHaveBeenLastCalledWith(
      "account/login/start",
      expect.objectContaining({ chatgptAccountId: "workspace-second" }),
    );
    const home = join(h.root, "codex-accounts", added);
    expect(JSON.parse(await readFile(join(home, "auth.json"), "utf8"))).toMatchObject({
      tokens: { refresh_token: "refresh-second" },
    });
    expect((await stat(join(home, "auth.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
    const restarted = new CodexAccounts(h.bridge as unknown as CodexBridge, h.options);
    managers.push(restarted);
    await restarted.initialize();
    await restarted.restore();
    expect(restarted.status().currentAccountId).toBe(added);
    expect(h.bridge.request).toHaveBeenLastCalledWith(
      "account/login/start",
      expect.objectContaining({ chatgptAccountId: "workspace-second" }),
    );
  });

  it("refreshes tokens through native auth only when requested and verifies workspace ownership", async () => {
    const h = await harness();
    await h.accounts.restore();
    const added = await add(h, "second");
    await h.accounts.select(added);
    h.openProcess.mockClear();
    const tokens = await h.accounts.refreshTokens("workspace-second");
    expect(tokens.chatgptAccountId).toBe("workspace-second");
    expect(h.openProcess).not.toHaveBeenCalled();
    expect(h.lastProcess().request).toHaveBeenCalledWith("getAuthStatus", {
      refreshToken: true,
      includeToken: true,
    });
    await expect(h.accounts.refreshTokens("workspace-first")).rejects.toThrow("account changed");
    expect(JSON.stringify(h.accounts.status())).not.toContain(tokens.accessToken);
  });

  it("rejects a switch if a response starts during native auth lookup", async () => {
    const h = await harness();
    await h.accounts.restore();
    const added = await add(h, "second");
    const original = h.accounts.status().currentAccountId;
    h.active.mockReturnValue(1);
    await expect(h.accounts.select(added)).rejects.toThrow("Wait for active Codex responses");
    expect(h.accounts.status().currentAccountId).toBe(original);
    h.active.mockReturnValue(0);
    h.bridge.pendingTurnStarts = 1;
    await expect(h.accounts.select(added)).rejects.toThrow("Wait for active Codex responses");
    h.bridge.pendingTurnStarts = 0;
    h.bridge.activeNativeTurnCount = 1;
    await expect(h.accounts.select(added)).rejects.toThrow("Wait for active Codex responses");
    expect(h.bridge.accountSwitching).toBe(false);
  });

  it("serializes simultaneous selections and protects quota ownership during a switch", async () => {
    const h = await harness();
    await h.accounts.restore();
    const added = await add(h, "second");
    const first = h.accounts.status().currentAccountId!;
    const original = h.bridge.request.getMockImplementation()!;
    h.bridge.request.mockImplementation(async (method: string, params: any) => {
      if (method === "account/login/start") {
        expect(h.bridge.accountSwitching).toBe(true);
        h.accounts.observeLimits({
          limits: null,
          updatedAt: 99,
          refreshing: false,
          refreshError: true,
        });
      }
      return original(method, params);
    });
    await Promise.all([h.accounts.select(added), h.accounts.select(first)]);
    expect(h.accounts.status().currentAccountId).toBe(first);
    expect(
      h.accounts.status().accounts.every((account) => account.rateLimits.updatedAt === null),
    ).toBe(true);
  });

  it("cancels a login, ignores late completion, and keeps existing credentials untouched", async () => {
    const h = await harness();
    await h.accounts.restore();
    const login = await h.accounts.startLogin();
    const process = h.lastProcess();
    const home = h.lastHome();
    await h.accounts.cancelLogin(login.id);
    process.emit("notification", { method: "account/login/completed", params: { success: true } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.accounts.login(login.id).state).toBe("cancelled");
    expect(h.accounts.status().accounts).toHaveLength(1);
    expect(process.close).toHaveBeenCalled();
    await expect(stat(home)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deduplicates repeated sign-in and refuses a different identity during reauthentication", async () => {
    const h = await harness();
    await h.accounts.restore();
    const id = await add(h, "second");
    expect(await add(h, "second")).toBe(id);
    expect(h.accounts.status().accounts).toHaveLength(2);
    const login = await h.accounts.startLogin(id);
    await h.complete("third");
    await vi.waitFor(() => expect(h.accounts.login(login.id).state).toBe("failed"));
    expect(h.accounts.status().accounts.find((account) => account.id === id)?.email).toBe(
      "second@example.test",
    );
  });

  it("keeps account recovery available after expired auth and never switches to the native account silently", async () => {
    const h = await harness();
    await h.accounts.restore();
    const id = await add(h, "second");
    await h.accounts.select(id);
    h.lastProcess().emit("exit");
    h.openProcess.mockRejectedValueOnce(new Error("provider failure containing sensitive data"));
    await expect(h.accounts.restore()).rejects.toThrow();
    expect(h.bridge.accountLoginRequired).toBe(true);
    expect(h.accounts.status().currentAccountId).toBe(id);
    expect(h.accounts.status().accounts.find((account) => account.id === id)?.authenticated).toBe(
      false,
    );
    const login = await h.accounts.startLogin(id);
    await h.complete("second");
    await vi.waitFor(() => expect(h.accounts.login(login.id).state).toBe("completed"));
    expect(h.bridge.accountLoginRequired).toBe(false);
    expect(JSON.stringify(h.accounts.status())).not.toContain("sensitive data");
  });

  it("does not remove the native home or chats and refuses to remove an active account", async () => {
    const h = await harness();
    await h.accounts.restore();
    const first = h.accounts.status().currentAccountId!;
    await expect(h.accounts.remove(first)).rejects.toThrow("Select another");
    const second = await add(h, "second");
    await h.accounts.select(second);
    await h.accounts.remove(first);
    expect(await readFile(join(h.nativeHome, "history.jsonl"), "utf8")).toBe("history");
    await expect(h.accounts.remove("../../outside")).rejects.toThrow("not found");
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
  const bridge = {
    request: responses(() => "first"),
    pendingTurnStarts: 0,
    activeNativeTurnCount: 0,
    accountSwitching: false,
    accountLoginRequired: false,
  };
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
    proxyEnvFile: "unused",
    activeTurnCount: active,
    openProcess,
  };
  const accounts = new CodexAccounts(bridge as unknown as CodexBridge, options);
  managers.push(accounts);
  await accounts.initialize();
  return {
    accounts,
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
    },
  };
}
async function add(h: Awaited<ReturnType<typeof harness>>, name: string): Promise<string> {
  const login = await h.accounts.startLogin();
  expect(login.state).toBe("waiting");
  expect(login.userCode).toBe("ABCD-EFGH");
  await h.complete(name);
  await vi.waitFor(() => expect(h.accounts.login(login.id).state).toBe("completed"));
  return h.accounts.login(login.id).accountId!;
}
