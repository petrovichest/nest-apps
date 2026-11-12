import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  parseClaudeProxy,
  type ClaudeProxyInput,
  type CreateCodexLoginRequest,
  type ParsedClaudeProxy,
  type CodexAccount,
  type CodexAccountsStatus,
  type CodexLoginStatus,
  type CodexRateLimitsState,
  type CodexRateLimitsResponse,
} from "@codexnest/protocol";

import type { CodexBridge } from "./codex/bridge";
import type { ServerNotification } from "./codex/generated/index";
import type {
  ChatgptAuthTokensRefreshResponse,
  LoginAccountResponse,
} from "./codex/generated/v2/index";
import type { GetAuthStatusResponse } from "./codex/generated/GetAuthStatusResponse";
import { parseAccountRateLimits } from "./codex/guards";
import { JsonlTransport } from "./codex/transport";
import { readProxyUrl } from "./codex-management";
import { childProcessEnvironment } from "./config";
import { accountProxy, accountProxyStatus, createAccountProxyConnection } from "./account-proxy";
import {
  AccountRuntimePool,
  DetachedAccountRuntimeLauncher,
  type AccountRuntimeOptions,
  type AccountRuntimeDescriptor,
} from "./account-runtime";
import { CodexAccountRouter, type RoutedAccount } from "./account-router";
import type { Turn } from "./codex/generated/v2/Turn";

const POLL_MS = 5 * 60_000;
const FIVE_HOURS_MS = 5 * 60 * 60_000;
const WARM_RETRY_MS = 15 * 60_000;
const WARM_SLOT_TOLERANCE_MS = 60_000;
const LOGIN_TIMEOUT_MS = 15 * 60_000;
const unknownLimits = (): CodexRateLimitsState => ({
  limits: null,
  updatedAt: null,
  refreshing: false,
  refreshError: false,
});
type SavedAccount = Omit<CodexAccount, "proxy"> & {
  native?: boolean;
  identity: string;
  proxy: ParsedClaudeProxy | null;
  proxyConfigured: boolean;
  credentialId?: string;
  modelLimits?: Record<string, CodexRateLimitsResponse>;
};
type Registry = Omit<CodexAccountsStatus, "accounts"> & {
  version: 1;
  importedNative: boolean;
  accounts: SavedAccount[];
  runtimes: AccountRuntimeDescriptor[];
  threadOwners: Record<string, string>;
  legacyAccountId: string | null;
  failedAccountTurns: Record<string, string>;
  accountsRequired: boolean;
  retiredAccounts: SavedAccount[];
};
type NativeAccount = {
  email: string | null;
  plan: string;
  identity: string;
  tokens: ChatgptAuthTokensRefreshResponse;
};
export type AccountProcess = {
  transport: JsonlTransport;
  close(): void | Promise<void>;
};
type Login = {
  status: CodexLoginStatus;
  home: string;
  existingId?: string;
  proxy: ParsedClaudeProxy | null;
  process: AccountProcess;
  timer?: NodeJS.Timeout;
  completing: boolean;
  finishing?: boolean;
  cleanup?: Promise<void>;
  committing?: boolean;
};
export type CodexAccountsOptions = {
  stateDir: string;
  codexHome: string;
  codexBin: string;
  proxyEnvFile: string;
  activeTurnCount(): number;
  /** Isolated native auth processes, never a second conversation server. */
  openProcess?: (
    home: string,
    native: boolean,
    proxy: ParsedClaudeProxy | null,
  ) => Promise<AccountProcess>;
  serverEnvFile?: string;
  runtime?: Partial<AccountRuntimeOptions>;
  poll?: boolean;
  managedInstall?: boolean;
  workAllowed?(): boolean;
};

export class CodexAccountError extends Error {
  constructor(
    public readonly kind: "validation" | "conflict" | "not_found" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "CodexAccountError";
  }
}

/** Native Codex owns OAuth and token refresh. Nest stores only account metadata. */
export class CodexAccounts extends EventEmitter {
  private registry: Registry = {
    version: 1,
    importedNative: false,
    currentAccountId: null,
    cliVersion: null,
    autoSwitch: true,
    warmLimits: false,
    accounts: [],
    runtimes: [],
    threadOwners: {},
    legacyAccountId: null,
    failedAccountTurns: {},
    accountsRequired: false,
    retiredAccounts: [],
  };
  private updates: Promise<unknown> = Promise.resolve();
  private logins = new Map<string, Login>();
  private processes = new Set<AccountProcess>();
  private activeProcess?: { id: string; process: AccountProcess };
  private tokenRefresh?: Promise<ChatgptAuthTokensRefreshResponse>;
  private externalAccessToken?: string;
  private closed = false;
  private closing?: Promise<void>;
  private readonly root: string;
  private readonly registryPath: string;
  private router?: CodexAccountRouter;
  private warmTimer?: NodeJS.Timeout;
  private warmArmed = false;
  private warming = false;
  private warmAttempts = new Map<string, { at: number; succeeded: boolean }>();
  private warmSchedule = new Map<string, { at: number; resetAt: number | null }>();
  private persistence: Promise<void> = Promise.resolve();
  private changingConnections = new Set<string>();

  constructor(
    private readonly bridge: CodexBridge,
    private readonly options: CodexAccountsOptions,
  ) {
    super();
    this.root = join(options.stateDir, "codex-accounts");
    this.registryPath = join(options.stateDir, "codex-accounts.json");
  }

  async initialize(): Promise<void> {
    const saved = await readJson<Registry>(this.registryPath);
    if (
      saved &&
      (saved.version !== 1 ||
        !Array.isArray(saved.accounts) ||
        saved.accounts.some(
          (account) =>
            !validId(account.id) ||
            typeof account.identity !== "string" ||
            (account.credentialId !== undefined && !validId(account.credentialId)),
        ) ||
        new Set(saved.accounts.map((account) => account.id)).size !== saved.accounts.length ||
        (saved.currentAccountId !== null &&
          !saved.accounts.some((account) => account.id === saved.currentAccountId)))
    )
      throw new Error("Codex account registry is invalid");
    this.registry = { ...this.registry, ...saved };
    if (this.registry.accounts.length) this.registry.accountsRequired = true;
    const inherited = await readProxyUrl(this.options.proxyEnvFile);
    for (const account of this.registry.accounts) {
      account.rateLimits = { ...(account.rateLimits ?? unknownLimits()), refreshing: false };
      if (account.proxyConfigured === undefined) {
        try {
          account.proxy = inherited ? parseClaudeProxy(inherited) : null;
          account.proxyConfigured = true;
        } catch {
          account.proxy = null;
          account.proxyConfigured = false;
          account.connectionError = "Configure this account's connection before using it";
        }
      } else if (account.proxy !== null) {
        try {
          account.proxy = accountProxy({
            enabled: true,
            protocol: account.proxy?.protocol,
            value: account.proxy?.url,
          });
        } catch {
          account.proxy = null;
          account.proxyConfigured = false;
          account.connectionError = "Configure this account's connection before using it";
        }
      }
    }
    const pool = new AccountRuntimePool({
      stateDir: this.options.stateDir,
      historyHome: this.options.codexHome,
      codexBin: this.options.codexBin,
      envFile: this.options.serverEnvFile ?? "",
      descriptors: this.registry.runtimes,
      remember: () => this.save(),
      expectedDeliveryVersion: () => this.bridge.deliveryVersion,
      nativeVersion: () => this.bridge.actualVersion,
      ...(this.options.managedInstall === false || process.env.NODE_ENV === "development"
        ? { launcher: new DetachedAccountRuntimeLauncher() }
        : {}),
      ...this.options.runtime,
    });
    this.router = new CodexAccountRouter(this.bridge, pool, {
      state: this.registry,
      selected: () => this.launchAccount(),
      workAllowed: this.options.workAllowed,
      save: () => this.save(),
      observe: (descriptor, notice) => this.observeRuntime(descriptor, notice),
      userWork: () => {
        if (this.registry.warmLimits && !this.warmArmed) {
          this.warmArmed = true;
          this.planWarmup();
        }
      },
      account: (id) => {
        const account = this.registry.accounts.find((entry) => entry.id === id);
        return account ? this.profile(account) : null;
      },
      beforeStart: (id) => {
        if (this.changingConnections.has(id))
          throw new CodexAccountError(
            "conflict",
            "The account connection is changing; retry shortly",
          );
        const account = this.registry.accounts.find((entry) => entry.id === id);
        if (!account) throw new CodexAccountError("not_found", "Codex account not found");
        if (!account.proxyConfigured)
          throw new CodexAccountError(
            "conflict",
            "Configure this account's connection before using it",
          );
        if (account && !account.authenticated)
          throw new CodexAccountError("conflict", "Codex account needs a ChatGPT login");
      },
    });
  }

  status(): CodexAccountsStatus {
    return {
      cliVersion: this.bridge.actualVersion ?? this.registry.cliVersion,
      autoSwitch: this.registry.autoSwitch,
      warmLimits: this.registry.warmLimits,
      currentAccountId: this.registry.currentAccountId,
      accounts: this.registry.accounts.map(
        ({ id, email, plan, authenticated, rateLimits, connectionError, proxy }) => ({
          id,
          email,
          plan,
          authenticated,
          proxy: accountProxyStatus(proxy),
          rateLimits: structuredClone(rateLimits),
          connectionError,
        }),
      ),
    };
  }

  /** Import metadata only. Reconnecting never changes authentication on the surviving daemon. */
  restore(): Promise<void> {
    return this.serial(async () => {
      if (!this.registry.importedNative) {
        const auth = await this.bridge.requestNative<GetAuthStatusResponse>("getAuthStatus", {
          includeToken: true,
          refreshToken: false,
        });
        if (["chatgpt", "chatgptAuthTokens"].includes(auth.authMethod ?? "") && auth.authToken) {
          const native = await readNativeAccount(this.bridge, false, auth);
          const inherited = await readProxyUrl(this.options.proxyEnvFile);
          const account: SavedAccount = {
            id: randomUUID(),
            native: true,
            identity: native.identity,
            email: native.email,
            plan: native.plan,
            authenticated: true,
            rateLimits: unknownLimits(),
            connectionError: null,
            proxy: inherited ? parseClaudeProxy(inherited) : null,
            proxyConfigured: true,
          };
          this.registry.accounts.push(account);
          this.registry.accountsRequired = true;
          this.registry.currentAccountId ??= account.id;
          this.registry.legacyAccountId = account.id;
        }
        this.registry.importedNative = true;
        await this.save();
      }
      if (!this.registry.legacyAccountId && this.registry.accounts.length) {
        const auth = await this.bridge.requestNative<GetAuthStatusResponse>("getAuthStatus", {
          includeToken: true,
          refreshToken: false,
        });
        if (auth.authToken && ["chatgpt", "chatgptAuthTokens"].includes(auth.authMethod ?? "")) {
          const native = await readNativeAccount(this.bridge, false, auth);
          this.registry.legacyAccountId =
            this.registry.accounts.find((account) => account.identity === native.identity)?.id ??
            null;
          await this.save();
        }
      }
      this.changed();
      this.planWarmup();
      this.emit("selected");
    });
  }

  select(id: string): Promise<CodexAccountsStatus> {
    return this.serial(async () => {
      const account = this.find(id);
      if (!account.authenticated)
        throw new CodexAccountError("conflict", "Codex account needs a ChatGPT login");
      if (!account.proxyConfigured)
        throw new CodexAccountError(
          "conflict",
          "Configure this account's connection before using it",
        );
      this.registry.currentAccountId = id;
      await this.save();
      this.changed();
      this.emit("selected");
      return this.status();
    });
  }

  setAutoSwitch(enabled: boolean): Promise<CodexAccountsStatus> {
    return this.serial(async () => {
      this.registry.autoSwitch = enabled;
      this.preferEarlierReset();
      await this.save();
      this.changed();
      return this.status();
    });
  }

  setWarmLimits(enabled: boolean): Promise<CodexAccountsStatus> {
    return this.serial(async () => {
      this.registry.warmLimits = enabled;
      await this.save();
      this.changed();
      // Only an explicit settings change arms paid warm-up work. Startup/update never does.
      clearTimeout(this.warmTimer);
      this.warmArmed = enabled;
      this.planWarmup();
      return this.status();
    });
  }

  updateProxy(id: string, input: ClaudeProxyInput): Promise<CodexAccountsStatus> {
    const proxy = accountProxy(input);
    return this.serial(async () => {
      const account = this.find(id);
      if (
        [...this.logins.values()].some(
          (login) => login.existingId === id && !terminal(login.status),
        )
      )
        throw new CodexAccountError(
          "conflict",
          "Cancel the Codex login before changing its connection",
        );
      const previous = account.proxy;
      this.changingConnections.add(id);
      account.proxy = proxy;
      try {
        await this.router?.replaceAccountConnection(this.profile(account));
      } catch (error) {
        account.proxy = previous;
        await this.save();
        throw error;
      } finally {
        this.changingConnections.delete(id);
      }
      account.proxyConfigured = true;
      account.rateLimits = unknownLimits();
      account.connectionError = null;
      account.modelLimits = undefined;
      await this.save();
      this.changed();
      if (id === this.registry.currentAccountId) this.emit("selected");
      return this.status();
    });
  }

  remove(id: string): Promise<CodexAccountsStatus> {
    return this.serial(async () => {
      const removed = this.find(id);
      for (const login of this.logins.values()) {
        if (login.existingId === id && !terminal(login.status)) {
          login.status.state = "cancelled";
          await this.cleanLogin(login);
        }
      }
      this.registry.accounts = this.registry.accounts.filter((entry) => entry.id !== id);
      this.registry.retiredAccounts.push(removed);
      const selected = this.registry.currentAccountId === id;
      if (selected)
        this.registry.currentAccountId =
          this.registry.accounts.find((account) => account.authenticated)?.id ?? null;
      // Profiles, native history and existing owners survive removal, including active tasks.
      await this.save();
      this.changed();
      if (selected) this.emit("selected");
      return this.status();
    });
  }

  private refreshing = new Map<string, Promise<void>>();
  async refresh(id?: string): Promise<CodexAccountsStatus> {
    const accounts = id
      ? [this.find(id)]
      : this.registry.accounts.filter((account) => account.authenticated);
    await Promise.all(
      accounts.map((account) => {
        const pending = this.refreshing.get(account.id);
        if (pending) return pending;
        const profile = this.profile(account);
        const operation = (async () => {
          account.rateLimits = { ...account.rateLimits, refreshing: true, refreshError: false };
          this.changed();
          const unchanged = () =>
            !this.closed &&
            this.registry.accounts.includes(account) &&
            JSON.stringify(profile) === JSON.stringify(this.profile(account));
          try {
            if (!account.proxyConfigured)
              throw new CodexAccountError(
                "conflict",
                "Configure this account's connection before using it",
              );
            const runtime = await this.router!.pool.ensure(profile);
            const native = await readNativeAccount(runtime.bridge, !account.authenticated);
            if (native.identity !== account.identity)
              throw new CodexAccountError(
                "conflict",
                "Codex account identity changed; sign in again",
              );
            const response = await runtime.bridge.request<unknown>(
              "account/rateLimits/read",
              undefined,
            );
            const limits = parseAccountRateLimits(response);
            if (!unchanged()) return;
            this.updateIdentity(account, native);
            account.modelLimits = modelLimits(response);
            account.rateLimits = {
              limits,
              updatedAt: Date.now(),
              refreshing: false,
              refreshError: false,
            };
          } catch (error) {
            if (!unchanged()) return;
            account.rateLimits = { ...account.rateLimits, refreshing: false, refreshError: true };
            account.connectionError = "Could not refresh Codex account; sign in again or retry";
            if (
              error instanceof CodexAccountError &&
              error.message === "Codex account needs a ChatGPT login"
            )
              account.authenticated = false;
          }
          if (unchanged()) this.changed();
        })().finally(() => this.refreshing.delete(account.id));
        this.refreshing.set(account.id, operation);
        return operation;
      }),
    );
    if (!this.closed) {
      this.preferEarlierReset();
      await this.save();
      this.changed();
      if (!this.warming) this.planWarmup();
    }
    return this.status();
  }

  /** Answer only the native refresh request, without RPCs on ordinary turn starts. */
  refreshTokens(previousAccountId?: string | null): Promise<ChatgptAuthTokensRefreshResponse> {
    // Native callbacks have a ten-second deadline. Never queue them behind login or quota work.
    this.tokenRefresh ??= (async () => {
      const retained = [...this.registry.accounts, ...this.registry.retiredAccounts];
      const account = previousAccountId
        ? retained.find((entry) => entry.identity.split(":")[0] === previousAccountId)
        : retained.find((entry) => entry.id === this.registry.legacyAccountId);
      if (!account) throw new CodexAccountError("not_found", "Codex account not found");
      if (!this.activeProcess) {
        this.activeProcess = {
          id: account.id,
          process: await this.open(this.home(account), account.native === true, account.proxy),
        };
      }
      const native = await this.withProcess(account, async (process) => {
        const latest = await readNativeAccount(process.transport);
        // Native quota polling may have refreshed already. Do not rotate that token again.
        return latest.tokens.accessToken !== this.externalAccessToken
          ? latest
          : readNativeAccount(process.transport, true);
      });
      if (native.identity !== account.identity)
        throw new CodexAccountError("conflict", "Codex account changed during token refresh");
      this.updateIdentity(account, native);
      this.externalAccessToken = native.tokens.accessToken;
      this.changed();
      return native.tokens;
    })()
      .catch((error: unknown) => {
        const account = this.registry.accounts.find(
          (entry) => entry.identity.split(":")[0] === previousAccountId,
        );
        if (account) {
          account.connectionError = "Could not refresh Codex account; sign in again or retry";
          if (
            error instanceof CodexAccountError &&
            (error.message === "Codex account needs a ChatGPT login" ||
              error.message === "Codex account identity changed; sign in again")
          )
            account.authenticated = false;
          this.changed();
        }
        throw error;
      })
      .finally(() => {
        this.tokenRefresh = undefined;
      });
    return this.tokenRefresh.then((tokens) => {
      if (previousAccountId && tokens.chatgptAccountId !== previousAccountId)
        throw new CodexAccountError("conflict", "Codex account changed during token refresh");
      return tokens;
    });
  }

  observeLimits(state: CodexRateLimitsState): void {
    // A request begun before a selection must not attribute the old quota to the new account.
    if (this.bridge.accountSwitching) return;
    const account = this.registry.accounts.find(
      (entry) => entry.id === this.registry.currentAccountId,
    );
    if (!account) return;
    account.rateLimits = structuredClone(state);
    this.changed();
  }

  startLogin(request: CreateCodexLoginRequest = {}): Promise<CodexLoginStatus> {
    return this.serial(async () => {
      const existingId = request.accountId;
      const existing = existingId ? this.find(existingId) : undefined;
      if (request.proxy === undefined && !existing?.proxyConfigured)
        throw new CodexAccountError("validation", "Choose a connection before signing in");
      const proxy = request.proxy === undefined ? existing!.proxy : accountProxy(request.proxy);
      if ([...this.logins.values()].some((login) => !terminal(login.status)))
        throw new CodexAccountError("conflict", "A Codex login is already in progress");
      // Keep only the latest completed attempt; no tokens or native errors enter UI status.
      this.logins.clear();
      const id = randomUUID();
      const home = join(this.root, `login-${id}`);
      await mkdir(home, { recursive: true, mode: 0o700 });
      let process: AccountProcess;
      try {
        process = await this.open(home, false, proxy);
      } catch {
        await rm(home, { recursive: true, force: true });
        throw new CodexAccountError(
          "failed",
          "Could not start Codex login; check the connection and retry",
        );
      }
      const login: Login = {
        status: { id, state: "starting", url: null, userCode: null, accountId: null, error: null },
        home,
        existingId,
        proxy,
        process,
        completing: false,
      };
      this.logins.set(id, login);
      process.transport.on("notification", (notification: ServerNotification) => {
        if (terminal(login.status)) return;
        // Native announces login completion before it reloads its auth manager. Read credentials
        // only after account/updated, otherwise a fast client can observe the old unauthenticated state.
        if (notification.method === "account/updated" && login.completing && !login.finishing) {
          login.finishing = true;
          void this.serial(() => this.finishLogin(login)).catch(() => this.failLogin(login));
          return;
        }
        if (notification.method !== "account/login/completed") return;
        if (notification.params.success) {
          login.status.state = "checking";
          login.completing = true;
        } else {
          void this.failLogin(login);
        }
      });
      process.transport.on("exit", () => {
        if (!terminal(login.status) && !login.completing) void this.failLogin(login);
      });
      login.timer = setTimeout(() => {
        if (login.committing) return;
        void this.failLogin(login, "Codex sign-in expired; start again").catch(() => undefined);
      }, LOGIN_TIMEOUT_MS);
      login.timer.unref();
      try {
        const result = await process.transport.request<LoginAccountResponse>(
          "account/login/start",
          { type: "chatgptDeviceCode" },
          30_000,
        );
        if (result.type !== "chatgptDeviceCode") throw new Error("Unexpected Codex login response");
        if (!terminal(login.status) && !login.completing) {
          login.status.state = "waiting";
          login.status.url = result.verificationUrl;
          login.status.userCode = result.userCode;
        }
      } catch {
        await this.failLogin(login);
      }
      return { ...login.status };
    });
  }

  login(id: string): CodexLoginStatus {
    return { ...this.findLogin(id).status };
  }

  async cancelLogin(id: string): Promise<CodexLoginStatus> {
    const login = this.findLogin(id);
    if (login.committing) await this.updates.catch(() => undefined);
    if (!terminal(login.status)) {
      login.status.state = "cancelled";
      await this.cleanLogin(login);
    }
    return { ...login.status };
  }

  close(): Promise<void> {
    return (this.closing ??= this.dispose());
  }

  private async dispose(): Promise<void> {
    this.closed = true;
    clearTimeout(this.warmTimer);
    await this.router?.close();
    for (const login of this.logins.values()) {
      if (!terminal(login.status)) login.status.state = "cancelled";
      clearTimeout(login.timer);
    }
    await Promise.all([...this.processes].map((process) => process.close()));
    await this.updates.catch(() => undefined);
    await Promise.all([...this.logins.values()].map((login) => this.cleanLogin(login)));
    await this.persistence;
  }

  private async finishLogin(login: Login): Promise<void> {
    if (terminal(login.status) || this.closed) return;
    try {
      const native = await readNativeAccount(login.process.transport);
      if (terminal(login.status) || this.closed) return;
      const existing = login.existingId
        ? this.find(login.existingId)
        : this.registry.accounts.find((account) => account.identity === native.identity);
      if (existing && existing.identity !== native.identity)
        throw new Error("The login belongs to a different account");
      const account: SavedAccount = existing
        ? { ...existing }
        : {
            id: randomUUID(),
            identity: native.identity,
            email: native.email,
            plan: native.plan,
            authenticated: true,
            proxy: login.proxy,
            proxyConfigured: true,
            rateLimits: unknownLimits(),
            connectionError: null,
          };
      account.credentialId = login.status.id;
      const home = join(this.root, account.id, account.credentialId);
      // Only native OAuth credentials move out of staging, never an access-token-only snapshot.
      const credentials = await readJson<unknown>(join(login.home, "auth.json"));
      if (!credentials) throw new Error("Missing native credentials");
      await mkdir(home, { recursive: true, mode: 0o700 });
      await writeJson(join(home, "auth.json"), credentials);
      if (terminal(login.status) || this.closed) return;
      account.native = false;
      account.proxy = login.proxy;
      account.proxyConfigured = true;
      account.rateLimits = unknownLimits();
      account.modelLimits = undefined;
      this.updateIdentity(account, native);
      login.committing = true;
      if (!existing) this.registry.accounts.push(account);
      else this.registry.accounts[this.registry.accounts.indexOf(existing)] = account;
      // Existing native owners keep their verified credential generation until a safe handover.
      if (this.activeProcess?.id === account.id) {
        const previous = this.activeProcess.process;
        this.activeProcess = undefined;
        this.externalAccessToken = undefined;
        await previous.close();
        this.processes.delete(previous);
      }
      this.registry.currentAccountId ??= account.id;
      this.registry.accountsRequired = true;
      await this.save();
      login.status.state = "completed";
      login.status.accountId = account.id;
      this.changed();
      if (account.id === this.registry.currentAccountId) this.emit("selected");
    } catch {
      await this.failLogin(login);
    } finally {
      await this.cleanLogin(login);
    }
  }

  private async failLogin(
    login: Login,
    message = "Codex login failed; enable device code authorization in ChatGPT settings and retry",
  ): Promise<void> {
    if (!terminal(login.status)) {
      login.status.state = "failed";
      login.status.error = message;
    }
    await this.cleanLogin(login);
  }

  private async cleanLogin(login: Login): Promise<void> {
    return (login.cleanup ??= this.disposeLogin(login));
  }
  private async disposeLogin(login: Login): Promise<void> {
    clearTimeout(login.timer);
    await login.process.close();
    this.processes.delete(login.process);
    await rm(login.home, { recursive: true, force: true });
  }

  private updateIdentity(account: SavedAccount, native: NativeAccount): void {
    account.email = native.email;
    account.plan = native.plan;
    account.authenticated = true;
    account.connectionError = null;
  }
  launchAccount(): RoutedAccount | null {
    const account = this.registry.accounts.find(
      (entry) => entry.id === this.registry.currentAccountId,
    );
    if (!account) {
      if (this.registry.accountsRequired)
        throw new CodexAccountError("conflict", "Add and select a Codex account first");
      return null;
    }
    if (!account.authenticated)
      throw new CodexAccountError("conflict", "Codex account needs a ChatGPT login");
    if (this.changingConnections.has(account.id))
      throw new CodexAccountError("conflict", "The account connection is changing; retry shortly");
    if (!account.proxyConfigured)
      throw new CodexAccountError(
        "conflict",
        "Configure this account's connection before using it",
      );
    return this.profile(account);
  }
  private profile(account: SavedAccount): RoutedAccount {
    return {
      id: account.id,
      home: this.home(account),
      native: account.native === true,
      proxy: account.proxy,
    };
  }
  private observeRuntime(descriptor: AccountRuntimeDescriptor, notice: ServerNotification): void {
    if (notice.method === "turn/completed" && isAccountFailure(notice.params.turn)) {
      this.registry.failedAccountTurns[notice.params.turn.id] ??= descriptor.accountId;
      void this.save().catch(() => undefined);
    }
    const account = this.registry.accounts.find((entry) => entry.id === descriptor.accountId);
    if (!account || !this.router?.pool.matches(descriptor, this.profile(account))) return;
    if (
      notice.method === "account/updated" &&
      notice.params.authMode !== "chatgpt" &&
      notice.params.authMode !== "chatgptAuthTokens"
    ) {
      account.authenticated = false;
      account.connectionError = "Codex account needs a ChatGPT login";
      this.changed();
    }
    if (notice.method === "account/rateLimits/updated") {
      try {
        const snapshot = notice.params.rateLimits;
        const parsed = parseAccountRateLimits(notice.params);
        if (snapshot.limitId && snapshot.limitId !== "codex") {
          if (snapshot.normalModelSlug)
            (account.modelLimits ??= {})[snapshot.normalModelSlug] = parsed;
        } else
          account.rateLimits = {
            limits: parsed,
            updatedAt: Date.now(),
            refreshing: false,
            refreshError: false,
          };
        account.connectionError = null;
        this.changed();
      } catch {
        /* A native notification from an unsupported runtime cannot replace known limits. */
      }
    }
  }
  private eligible(account: SavedAccount, model?: string | null): boolean {
    const { rateLimits: state } = account;
    const limits = state.limits;
    return Boolean(
      account.authenticated &&
      account.proxyConfigured &&
      !account.connectionError &&
      !state.refreshError &&
      limits &&
      limits.ordinaryUsageAllowed !== false &&
      limits.spendControlReached !== true &&
      (model ? [account.modelLimits?.[model]] : Object.values(account.modelLimits ?? {})).every(
        (quota) =>
          !quota ||
          (quota.spendControlReached !== true &&
            [quota.primary, quota.secondary].every(
              (window) =>
                !window ||
                (window.usedPercent >= 0 &&
                  window.usedPercent < 100 &&
                  (window.resetsAt === null || window.resetsAt > Date.now())),
            )),
      ) &&
      [limits.primary, limits.secondary].every(
        (window) =>
          !window ||
          (Number.isFinite(window.usedPercent) &&
            window.usedPercent >= 0 &&
            window.usedPercent < 100 &&
            (window.resetsAt === null ||
              (Number.isFinite(window.resetsAt) && window.resetsAt > Date.now()))),
      ),
    );
  }
  private preferEarlierReset(): void {
    if (!this.registry.autoSwitch) return;
    const candidates = this.registry.accounts
      .filter((account) => this.eligible(account))
      .sort(spendFirst);
    const current = candidates.find((account) => account.id === this.registry.currentAccountId);
    const next = candidates[0];
    if (next && (!current || fiveHourReset(next) < fiveHourReset(current))) {
      this.registry.currentAccountId = next.id;
      this.emit("selected");
    }
  }
  canRecover(turn: Pick<Turn, "status" | "error">): boolean {
    return this.registry.autoSwitch && isAccountFailure(turn);
  }
  async recover(threadId: string, turn: Turn, model?: string | null): Promise<boolean> {
    if (!this.canRecover(turn) || !this.router) return false;
    const failedId = this.registry.failedAccountTurns[turn.id] ?? this.router.owner(threadId);
    if (failedId) this.registry.failedAccountTurns[turn.id] = failedId;
    const failed = this.registry.accounts.find((account) => account.id === failedId);
    if (failed) {
      if (turn.error?.codexErrorInfo === "unauthorized") {
        failed.authenticated = false;
        failed.connectionError = "Codex account needs a ChatGPT login";
      } else failed.rateLimits = { ...failed.rateLimits, refreshError: true };
      this.changed();
    }
    await this.refresh();
    if (!this.registry.autoSwitch || this.closed) return false;
    const next = this.registry.accounts
      .filter((account) => account.id !== failedId && this.eligible(account, model))
      .sort(spendFirst)[0];
    if (!next) return false;
    await this.router.move(threadId, this.profile(next));
    this.registry.currentAccountId = next.id;
    await this.save();
    this.changed();
    this.emit("selected");
    return true;
  }
  private computeWarmSchedule(): void {
    const now = Date.now();
    const accounts = this.registry.accounts.filter((account) => {
      const weekly = account.rateLimits.limits?.secondary;
      return (
        account.authenticated &&
        !account.connectionError &&
        !account.rateLimits.refreshError &&
        weekly &&
        Number.isFinite(weekly.usedPercent) &&
        weekly.usedPercent >= 0 &&
        weekly.usedPercent < 100
      );
    });
    if (!accounts.length) {
      this.warmSchedule.clear();
      return;
    }
    const previous = this.warmSchedule;
    const changedMembers =
      accounts.length !== previous.size || accounts.some((account) => !previous.has(account.id));
    const spacing = FIVE_HOURS_MS / accounts.length;
    const tolerance = Math.min(WARM_SLOT_TOLERANCE_MS, spacing / 4);
    const readyAt = (account: SavedAccount) => {
      const resetAt = fiveHourReset(account);
      const attempt = this.warmAttempts.get(account.id);
      // Reserve a successful window even while the usage endpoint still reports it as idle.
      return Math.max(
        Number.isFinite(resetAt) ? resetAt : -Infinity,
        attempt?.succeeded ? attempt.at + FIVE_HOURS_MS : -Infinity,
      );
    };
    let at = Math.min(...accounts.map((account) => previous.get(account.id)?.at ?? Infinity));
    if (changedMembers) {
      // Native windows also recover the most recent start after a server restart.
      const lastStart = Math.max(
        ...Array.from(this.warmAttempts.values(), (attempt) => attempt.at),
        ...accounts
          .map(readyAt)
          .map((resetAt) => resetAt - FIVE_HOURS_MS)
          .filter((start) => start <= now),
      );
      at = Math.max(now, Math.min(...accounts.map(readyAt)), lastStart + spacing);
    }
    // Only a started window consumes a slot. Reads, expiry and early user requests must not
    // repeatedly postpone the next waiting account. Late starts still leave a full gap.
    for (const account of accounts) {
      const slot = previous.get(account.id);
      const resetAt = readyAt(account);
      if (
        slot &&
        slot.at <= now &&
        resetAt > now &&
        (slot.resetAt == null || Math.abs(resetAt - slot.resetAt) > tolerance)
      )
        at = Math.max(at, Math.min(now, Math.max(slot.at, resetAt - FIVE_HOURS_MS)) + spacing);
    }
    const urgency = (account: SavedAccount) => {
      const weekly = account.rateLimits.limits!.secondary!;
      // An unknown weekly deadline gets a full week; a stale deadline cannot divide by zero.
      const remainingTime = Number.isFinite(weekly.resetsAt)
        ? Math.max(60_000, weekly.resetsAt! - now)
        : 7 * 24 * 60 * 60_000;
      return (100 - weekly.usedPercent) / remainingTime;
    };
    const remaining = accounts.sort((a, b) => urgency(b) - urgency(a));
    const schedule = new Map<string, { at: number; resetAt: number | null }>();
    while (remaining.length) {
      let index = remaining.findIndex((account) => readyAt(account) <= at + tolerance);
      if (index === -1) {
        const firstReady = Math.min(...remaining.map(readyAt));
        at += Math.ceil((firstReady - tolerance - at) / spacing) * spacing;
        index = remaining.findIndex((account) => readyAt(account) <= at + tolerance);
      }
      const account = remaining.splice(index, 1)[0]!;
      const resetAt = Number.isFinite(readyAt(account)) ? readyAt(account) : null;
      const observed = previous.get(account.id)?.resetAt;
      schedule.set(account.id, {
        at: Math.max(at, resetAt ?? -Infinity),
        // Keep the original observation so sub-second endpoint jitter cannot accumulate.
        resetAt:
          resetAt != null && observed != null && Math.abs(resetAt - observed) <= tolerance
            ? observed
            : resetAt,
      });
      at += spacing;
    }
    this.warmSchedule = schedule;
  }
  /** Shared quotas block every model; both exhausted windows must reset before reuse. */
  private quotaResetAt(account: SavedAccount): number | undefined {
    const resets = [account.rateLimits.limits?.primary, account.rateLimits.limits?.secondary]
      .filter(
        (window) =>
          window &&
          Number.isFinite(window.usedPercent) &&
          window.usedPercent >= 100 &&
          typeof window.resetsAt === "number" &&
          Number.isFinite(window.resetsAt),
      )
      .map((window) => window!.resetsAt!);
    return resets.length ? Math.max(...resets) : undefined;
  }
  private planWarmup(): void {
    clearTimeout(this.warmTimer);
    if (this.closed || this.options.poll === false) return;
    this.computeWarmSchedule();
    const now = Date.now();
    const scheduled = this.registry.accounts
      .filter((account) => account.authenticated && !account.rateLimits.refreshing)
      .map((account) => {
        const reset = this.quotaResetAt(account);
        const checked = account.rateLimits.updatedAt ?? now;
        let at =
          reset !== undefined && reset > now
            ? reset
            : account.rateLimits.refreshError
              ? now + POLL_MS
              : reset !== undefined && reset > checked
                ? reset
                : checked + POLL_MS;
        const slot = this.warmSchedule.get(account.id);
        if (
          this.warmArmed &&
          this.registry.warmLimits &&
          !this.warming &&
          slot &&
          !this.registry.runtimes.some(
            (runtime) => runtime.accountId === account.id && this.router!.pool.active(runtime.id),
          )
        )
          at = Math.min(
            at,
            Math.max(
              slot.at,
              (this.warmAttempts.get(account.id)?.at ?? -Infinity) + WARM_RETRY_MS,
              now,
            ),
          );
        return { id: account.id, at };
      });
    if (!scheduled.length) return;
    const at = Math.min(...scheduled.map((entry) => entry.at));
    const due = scheduled.filter((entry) => entry.at <= at).map((entry) => entry.id);
    this.warmTimer = setTimeout(
      () => {
        void (async () => {
          for (const id of due) {
            const account = this.registry.accounts.find((entry) => entry.id === id);
            if (account && (this.quotaResetAt(account) ?? 0) <= Date.now()) await this.refresh(id);
          }
          if (this.warmArmed && this.registry.warmLimits) await this.warmAccount();
        })()
          .catch(() => undefined)
          .finally(() => this.planWarmup());
      },
      Math.max(0, Math.min(at - now, 2_147_000_000)),
    );
    this.warmTimer.unref();
  }
  private async warmAccount(): Promise<void> {
    if (this.warming || this.closed || !this.registry.warmLimits || !this.router) return;
    this.warming = true;
    const account = this.registry.accounts.filter(
      (entry) =>
        this.eligible(entry) &&
        (this.warmSchedule.get(entry.id)?.at ?? Infinity) <= Date.now() &&
        Date.now() - (this.warmAttempts.get(entry.id)?.at ?? -Infinity) >= WARM_RETRY_MS &&
        !this.registry.runtimes.some(
          (runtime) => runtime.accountId === entry.id && this.router!.pool.active(runtime.id),
        ),
    )[0];
    try {
      if (!account) return;
      this.warmAttempts.set(account.id, { at: Date.now(), succeeded: false });
      const profile = this.profile(account);
      const { bridge } = await this.router.pool.ensure(profile);
      if (
        this.closed ||
        !this.registry.warmLimits ||
        !this.registry.accounts.includes(account) ||
        JSON.stringify(profile) !== JSON.stringify(this.profile(account)) ||
        bridge.activeNativeTurnCount ||
        bridge.pendingTurnStarts
      )
        return;
      const { thread } = await bridge.request<any>("thread/start", {
        ephemeral: true,
        cwd: this.options.stateDir,
        approvalPolicy: "never",
        sandbox: "read-only",
        developerInstructions:
          "This is an account warm-up. Reply OK only. Never call tools or change files.",
        dynamicTools: [],
        config: {
          "features.shell_tool": false,
          "features.unified_exec": false,
          "features.apply_patch_freeform": false,
          "features.multi_agent": false,
          "features.multi_agent_v2": false,
          web_search: "disabled",
        },
      });
      let timer: NodeJS.Timeout | undefined;
      let turnId: string | undefined;
      let completedHandler: (notice: ServerNotification) => void;
      const completed = new Promise<boolean>((resolve) => {
        completedHandler = (notice) => {
          if (notice.method === "turn/completed" && notice.params.threadId === thread.id) {
            bridge.off("notification", completedHandler);
            clearTimeout(timer);
            resolve(notice.params.turn.status === "completed");
          }
        };
        bridge.on("notification", completedHandler);
        timer = setTimeout(() => {
          bridge.off("notification", completedHandler);
          resolve(false);
        }, 30_000);
      });
      try {
        const result = await bridge.request<any>("turn/start", {
          threadId: thread.id,
          input: [
            { type: "text", text: "Reply with OK only. Do not use tools or change any files." },
          ],
        });
        turnId = result.turn.id;
        const succeeded = await completed;
        const attempt = this.warmAttempts.get(account.id);
        if (attempt) attempt.succeeded = succeeded;
      } finally {
        clearTimeout(timer);
        bridge.off("notification", completedHandler!);
        if (turnId)
          await bridge
            .request("turn/interrupt", { threadId: thread.id, turnId })
            .catch(() => undefined);
        await bridge.request("thread/unsubscribe", { threadId: thread.id }).catch(() => undefined);
      }
      await this.refresh(account.id);
    } finally {
      this.warming = false;
      if (this.registry.warmLimits && !this.closed) {
        this.planWarmup();
      }
    }
  }
  private home(account: SavedAccount): string {
    return account.native
      ? this.options.codexHome
      : join(this.root, account.id, account.credentialId ?? "");
  }
  private find(id: string): SavedAccount {
    const account = this.registry.accounts.find((entry) => entry.id === id);
    if (!account) throw new CodexAccountError("not_found", "Codex account not found");
    return account;
  }
  private findLogin(id: string): Login {
    const login = this.logins.get(id);
    if (!login) throw new CodexAccountError("not_found", "Codex login not found");
    return login;
  }
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const pending = this.updates
      .catch(() => undefined)
      .then(() => {
        if (this.closed) throw new CodexAccountError("failed", "Codex accounts are shutting down");
        return task();
      });
    this.updates = pending;
    return pending;
  }
  private changed(): void {
    this.bridge.accountLoginRequired =
      this.registry.accounts.length > 0 &&
      !this.registry.accounts.find((account) => account.id === this.registry.currentAccountId)
        ?.authenticated;
    if (!this.closed) this.emit("changed", this.status());
  }
  private save(): Promise<void> {
    this.persistence = this.persistence
      .catch(() => undefined)
      .then(() => writeJson(this.registryPath, this.registry));
    return this.persistence;
  }
  private async withProcess<T>(
    account: SavedAccount,
    task: (process: AccountProcess) => Promise<T>,
  ): Promise<T> {
    if (this.activeProcess?.id === account.id) return task(this.activeProcess.process);
    const process = await this.open(this.home(account), account.native === true, account.proxy);
    try {
      return await task(process);
    } catch (error) {
      if (error instanceof CodexAccountError) throw error;
      throw new CodexAccountError(
        "failed",
        "Could not open Codex account; check the connection and retry",
      );
    } finally {
      await process.close();
      this.processes.delete(process);
    }
  }

  private async open(
    home: string,
    native: boolean,
    proxy: ParsedClaudeProxy | null,
  ): Promise<AccountProcess> {
    const process = this.options.openProcess
      ? await this.options.openProcess(home, native, proxy)
      : await openAccountProcess(this.options, home, native, proxy);
    if (this.closed) {
      await process.close();
      throw new CodexAccountError("failed", "Codex accounts are shutting down");
    }
    this.processes.add(process);
    process.transport.once("exit", () => {
      if (this.activeProcess?.process === process) this.activeProcess = undefined;
      this.processes.delete(process);
    });
    return process;
  }

  private busy(): boolean {
    return (
      this.options.activeTurnCount() > 0 ||
      this.bridge.pendingTurnStarts > 0 ||
      this.bridge.activeNativeTurnCount > 0
    );
  }
}

async function openAccountProcess(
  options: CodexAccountsOptions,
  home: string,
  native: boolean,
  proxy: ParsedClaudeProxy | null,
): Promise<AccountProcess> {
  const connection = await createAccountProxyConnection(
    proxy,
    options.runtime?.environment ?? childProcessEnvironment(),
  );
  const env: NodeJS.ProcessEnv = { ...connection.env, CODEX_HOME: home };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  // The installed Codex wrapper must not replace this account's route with the global proxy.
  const proxyFile = join(options.stateDir, "account-auth-connections", `${randomUUID()}.env`);
  const { writeFile } = await import("node:fs/promises");
  const { renderProxyEnvironment } = await import("./codex-management");
  try {
    await mkdir(dirname(proxyFile), { recursive: true, mode: 0o700 });
    await writeFile(proxyFile, renderProxyEnvironment(connection.url), { mode: 0o600, flag: "wx" });
  } catch {
    await connection.close().catch(() => undefined);
    await rm(proxyFile, { force: true }).catch(() => undefined);
    throw new CodexAccountError(
      "failed",
      "Could not start Codex login; check the connection and retry",
    );
  }
  env.CODEXNEST_CODEX_PROXY_ENV_FILE = proxyFile;
  const child: ChildProcessWithoutNullStreams = spawn(
    options.codexBin,
    [
      "--enable",
      "respect_system_proxy",
      ...(native ? [] : ["-c", 'cli_auth_credentials_store="file"']),
      ...(options.runtime?.nativeArgs ?? []),
      "app-server",
      "--listen",
      "stdio://",
    ],
    { env, stdio: ["pipe", "pipe", "pipe"] },
  );
  // Native stderr can contain provider details. It never enters application logs or API errors.
  child.stderr.resume();
  const transport = new JsonlTransport(child);
  child.on("error", () => transport.shutdown(new Error("Codex account process failed")));
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= new Promise<void>((resolve) => {
      transport.shutdown();
      if (child.exitCode !== null || child.signalCode !== null) {
        void connection
          .close()
          .catch(() => undefined)
          .then(() => rm(proxyFile, { force: true }).catch(() => undefined))
          .finally(resolve);
        return;
      }
      const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      timer.unref();
      child.once("close", () => {
        clearTimeout(timer);
        void connection
          .close()
          .catch(() => undefined)
          .then(() => rm(proxyFile, { force: true }).catch(() => undefined))
          .finally(resolve);
      });
      child.kill("SIGTERM");
    }));
  try {
    await transport.request("initialize", {
      clientInfo: { name: "codexnest_accounts", title: "CodexNest accounts", version: "0.1.0" },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: false,
      },
    });
    transport.notify("initialized");
    return { transport, close };
  } catch {
    await close();
    throw new CodexAccountError(
      "failed",
      "Could not open Codex account; check the connection and retry",
    );
  }
}

async function readNativeAccount(
  rpc: Pick<CodexBridge, "request"> | JsonlTransport,
  refreshToken = false,
  loadedAuth?: GetAuthStatusResponse,
): Promise<NativeAccount> {
  const auth =
    loadedAuth ??
    (await rpc.request<GetAuthStatusResponse>("getAuthStatus", {
      includeToken: true,
      refreshToken,
    }));
  if (!["chatgpt", "chatgptAuthTokens"].includes(auth.authMethod ?? "") || !auth.authToken)
    throw new CodexAccountError("failed", "Codex account needs a ChatGPT login");
  const claims = JSON.parse(
    Buffer.from(auth.authToken.split(".")[1] ?? "", "base64url").toString(),
  ) as Record<string, any>;
  if (typeof claims.exp === "number" && claims.exp * 1_000 <= Date.now()) {
    if (!refreshToken) return readNativeAccount(rpc, true);
    throw new CodexAccountError("failed", "Codex account needs a ChatGPT login");
  }
  const identity = claims["https://api.openai.com/auth"];
  const accountId = identity?.chatgpt_account_id;
  const userId = identity?.chatgpt_user_id ?? identity?.user_id ?? claims.sub;
  if (typeof accountId !== "string" || typeof userId !== "string")
    throw new CodexAccountError("failed", "Could not read Codex account identity");
  const email = claims.email ?? claims["https://api.openai.com/profile"]?.email;
  const plan =
    typeof identity?.chatgpt_plan_type === "string" ? identity.chatgpt_plan_type : "unknown";
  return {
    email: typeof email === "string" ? email : null,
    plan,
    identity: `${accountId}:${userId}`,
    tokens: {
      accessToken: auth.authToken,
      chatgptAccountId: accountId,
      chatgptPlanType: plan,
    },
  };
}

function terminal(status: CodexLoginStatus): boolean {
  return ["completed", "failed", "cancelled"].includes(status.state);
}
export function isAccountFailure(turn: Pick<Turn, "status" | "error">): boolean {
  return (
    turn.status === "failed" &&
    ["usageLimitExceeded", "rateLimitExceeded", "unauthorized"].includes(
      String(turn.error?.codexErrorInfo),
    )
  );
}
function fiveHourReset(account: SavedAccount): number {
  return account.rateLimits.limits?.primary?.resetsAt ?? Number.POSITIVE_INFINITY;
}
function spendFirst(a: SavedAccount, b: SavedAccount): number {
  return (
    fiveHourReset(a) - fiveHourReset(b) ||
    (a.rateLimits.limits?.primary?.usedPercent ?? 0) -
      (b.rateLimits.limits?.primary?.usedPercent ?? 0) ||
    (a.rateLimits.limits?.secondary?.usedPercent ?? 0) -
      (b.rateLimits.limits?.secondary?.usedPercent ?? 0)
  );
}
function modelLimits(value: unknown): Record<string, CodexRateLimitsResponse> {
  const buckets = (
    value as { rateLimitsByLimitId?: Record<string, { normalModelSlug?: string | null }> | null }
  )?.rateLimitsByLimitId;
  const result: Record<string, CodexRateLimitsResponse> = {};
  for (const [id, snapshot] of Object.entries(buckets ?? {})) {
    if (id === "codex" || !snapshot?.normalModelSlug) continue;
    result[snapshot.normalModelSlug] = parseAccountRateLimits({ rateLimits: snapshot });
  }
  return result;
}
function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}
async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
