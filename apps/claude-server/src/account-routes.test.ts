import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaudeAccounts } from "./accounts.js";
import { registerAccountRoutes } from "./account-routes.js";
import { AppError } from "./types.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});
async function fixture() {
  const status = {
    cliVersion: "2.1.289",
    autoSwitch: true,
    currentAccountId: "account",
    accounts: [],
  };
  const login = {
    id: "login",
    state: "waitingCode",
    url: "https://claude.ai/oauth/authorize?state=test",
    accountId: null,
    error: null,
  };
  const accounts = {
    status: vi.fn(() => status),
    setAutoSwitch: vi.fn(async () => status),
    refresh: vi.fn(async () => status),
    updateProxy: vi.fn(async () => status),
    select: vi.fn(async () => status),
    remove: vi.fn(async () => status),
    startLogin: vi.fn(async () => login),
    login: vi.fn(() => login),
    cancelLogin: vi.fn(async () => ({ ...login, state: "cancelled" })),
    submitCode: vi.fn(async () => ({ ...login, state: "checking" })),
  };
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) =>
    reply
      .code(error instanceof AppError ? error.status : 500)
      .send({ message: error instanceof AppError ? error.message : "Operation failed" }),
  );
  await registerAccountRoutes(app, accounts as unknown as ClaudeAccounts);
  await app.ready();
  cleanup.push(() => app.close());
  return { app, accounts };
}
const prefix = "/api/v1/settings/claude";
describe("Claude account management API", () => {
  it("returns status and validates the auto-switch setting", async () => {
    const { app, accounts } = await fixture();
    expect((await app.inject({ method: "GET", url: prefix })).json()).toMatchObject({
      autoSwitch: true,
    });
    expect(
      (await app.inject({ method: "PATCH", url: prefix, payload: { autoSwitch: "true" } }))
        .statusCode,
    ).toBe(400);
    await app.inject({ method: "PATCH", url: prefix, payload: { autoSwitch: false } });
    expect(accounts.setAutoSwitch).toHaveBeenCalledExactlyOnceWith(false);
  });
  it("refreshes all or one account and dispatches account actions", async () => {
    const { app, accounts } = await fixture();
    await app.inject({ method: "POST", url: `${prefix}/refresh` });
    expect(accounts.refresh).toHaveBeenLastCalledWith(undefined);
    await app.inject({ method: "POST", url: `${prefix}/refresh`, payload: { accountId: "first" } });
    expect(accounts.refresh).toHaveBeenLastCalledWith("first");
    await app.inject({ method: "POST", url: `${prefix}/accounts/first/select` });
    expect(accounts.select).toHaveBeenCalledWith("first");
    await app.inject({ method: "DELETE", url: `${prefix}/accounts/first` });
    expect(accounts.remove).toHaveBeenCalledWith("first");
    const proxy = { enabled: true, protocol: "socks5", value: "proxy.example:1080" };
    await app.inject({ method: "PATCH", url: `${prefix}/accounts/first`, payload: { proxy } });
    expect(accounts.updateProxy).toHaveBeenCalledWith("first", proxy);
  });
  it("supports reauthentication without overwriting the saved proxy and code flow", async () => {
    const { app, accounts } = await fixture();
    await app.inject({ method: "POST", url: `${prefix}/logins`, payload: { accountId: "first" } });
    expect(accounts.startLogin).toHaveBeenCalledWith({ accountId: "first" });
    const result = await app.inject({ method: "GET", url: `${prefix}/logins/login` });
    expect(result.json().url).toBe("https://claude.ai/oauth/authorize?state=test");
    await app.inject({
      method: "POST",
      url: `${prefix}/logins/login/code`,
      payload: { code: "complete#state" },
    });
    expect(accounts.submitCode).toHaveBeenCalledWith("login", "complete#state");
    await app.inject({ method: "DELETE", url: `${prefix}/logins/login` });
    expect(accounts.cancelLogin).toHaveBeenCalledWith("login");
  });
  it("rejects malformed code/account input before invoking the backend", async () => {
    const { app, accounts } = await fixture();
    expect(
      (await app.inject({ method: "POST", url: `${prefix}/logins`, payload: { accountId: 42 } }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${prefix}/logins/login/code`,
          payload: { code: 42 },
        })
      ).statusCode,
    ).toBe(400);
    expect(accounts.startLogin).not.toHaveBeenCalled();
    expect(accounts.submitCode).not.toHaveBeenCalled();
  });
});
