import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, mkdir, rm, symlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import type {
  ClaudeAccount,
  ClaudeAccountsStatus,
  ClaudeLoginStatus,
  ClaudeProxyInput,
  CodexRateLimitsResponse,
  CodexRateLimitsState,
  CodexRateLimitWindow,
  CreateClaudeLoginRequest,
  ParsedClaudeProxy,
} from "@codexnest/protocol";
import type { Config } from "./config.js";
import { ClaudeProcess } from "./claude.js";
import { readJson, writeJsonAtomic } from "./io.js";
import { parseClaudeUsage } from "./rate-limits.js";
import { AppError, assertUuid, record, UUID_PATTERN } from "./types.js";
import {
  createClaudeProxyEnvironment,
  proxyFromInput,
  proxyStatus,
  type ClaudeProxyEnvironment,
} from "./proxy.js";

const POLL_MS = 5 * 60_000;
/** Spacing between warm-ups of one account, in case the usage endpoint lags behind the new window. */
const WARM_RETRY_MS = 15 * 60_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const IMPORTED_PROXY_ERROR =
  "The original Claude proxy needs configuration; choose a valid proxy or explicitly select direct connection";
const unknownLimits = (): CodexRateLimitsState => ({
  limits: null,
  updatedAt: null,
  refreshing: false,
  refreshError: false,
});

export type ClaudeLaunchAccount = {
  accountId: string;
  configDir: string;
  proxy?: ParsedClaudeProxy | null;
  /** Original native config uses the home global file without a CLI directory override. */
  defaultConfig?: boolean;
};
export type NativeClaudeAuth = {
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  subscriptionType?: string;
  plan?: string;
};
export type NativeClaudeUsage = CodexRateLimitsResponse & {
  modelLimits?: Record<string, CodexRateLimitWindow | null>;
};
type SavedAccount = Omit<ClaudeLaunchAccount, "proxy"> & {
  proxy: ParsedClaudeProxy | null;
  /** Explicit per-account choice, including direct; false marks an imported native connection. */
  proxyConfigured?: boolean;
  email: string | null;
  plan: string | null;
  authenticated: boolean;
  rateLimits: CodexRateLimitsState;
  connectionError: string | null;
  modelLimits?: Record<string, CodexRateLimitWindow | null>;
  previousConfigDirs?: string[];
};
type Registry = {
  version: 1;
  autoSwitch: boolean;
  /** Missing in older registries; warming stays on unless explicitly disabled. */
  warmLimits?: boolean;
  currentAccountId: string | null;
  accounts: SavedAccount[];
};
type Login = {
  status: ClaudeLoginStatus;
  account: SavedAccount;
  existingId?: string;
  child?: ChildProcessWithoutNullStreams;
  childClosed?: boolean;
  connection?: ClaudeProxyEnvironment;
  timer?: NodeJS.Timeout;
  output: string;
  bytes: number;
  finishing: boolean;
};
export type ClaudeAccountsOptions = {
  spawnProcess?: typeof spawn;
  readAuth?: (account: ClaudeLaunchAccount) => Promise<NativeClaudeAuth>;
  readUsage?: (account: ClaudeLaunchAccount) => Promise<NativeClaudeUsage>;
  readVersion?: () => Promise<string | null>;
  proxyEnvironment?: typeof createClaudeProxyEnvironment;
  now?: () => number;
  poll?: boolean;
  /** Test override for the native default ~/.claude location. */
  defaultConfigDir?: string;
  /** Native service environment; injectable so tests never inspect real proxy credentials. */
  env?: NodeJS.ProcessEnv;
};

/** Account metadata is application-owned; actual authentication stays native to Claude Code. */
export class ClaudeAccounts extends EventEmitter {
  private registry: Registry = {
    version: 1,
    autoSwitch: true,
    currentAccountId: null,
    accounts: [],
  };
  private initialized?: Promise<void>;
  private updates: Promise<unknown> = Promise.resolve();
  private rotation: Promise<unknown> = Promise.resolve();
  private refreshes = new Map<string, Promise<void>>();
  private warmedAt = new Map<string, number>();
  private logins = new Map<string, Login>();
  private timer?: NodeJS.Timeout;
  private closed = false;
  private cliVersion: string | null = null;
  private readonly registryPath: string;
  private readonly defaultConfigDir: string;
  private readonly ambientEnv: NodeJS.ProcessEnv;
  constructor(
    readonly config: Config,
    private readonly options: ClaudeAccountsOptions = {},
  ) {
    super();
    this.registryPath = join(config.stateDir, "claude-accounts.json");
    this.defaultConfigDir = resolve(options.defaultConfigDir ?? join(homedir(), ".claude"));
    this.ambientEnv = options.env ?? process.env;
  }

  initialize(): Promise<void> {
    this.initialized ??= this.initializeOnce();
    return this.initialized;
  }
  private async initializeOnce(): Promise<void> {
    const saved = await readJson<Registry>(this.registryPath);
    if (saved) {
      if (
        saved.version !== 1 ||
        !Array.isArray(saved.accounts) ||
        typeof saved.autoSwitch !== "boolean"
      )
        throw new Error("Claude account registry is invalid");
      for (const account of saved.accounts) {
        assertUuid(account.accountId, "accountId");
        const directory = resolve(account.configDir);
        const managed =
          dirname(directory) === resolve(this.config.stateDir, "claude-accounts") &&
          UUID_PATTERN.test(basename(directory));
        if (
          !isAbsolute(account.configDir) ||
          (directory !== resolve(this.config.configDir) && !managed)
        )
          throw new Error("Claude account config directory is invalid");
        account.rateLimits = { ...(account.rateLimits ?? unknownLimits()), refreshing: false };
        if (account.proxyConfigured === undefined)
          account.proxyConfigured =
            directory !== resolve(this.config.configDir) || account.proxy !== null;
      }
      this.registry = saved;
    } else {
      const account = this.blankAccount(resolve(this.config.configDir));
      account.proxyConfigured = false;
      if (
        resolve(this.config.configDir) === this.defaultConfigDir &&
        this.ambientEnv.CLAUDE_CONFIG_DIR === undefined
      )
        account.defaultConfig = true;
      this.registry.accounts.push(account);
      this.registry.currentAccountId = account.accountId;
      await this.save();
    }
    for (const account of this.registry.accounts) this.importNativeConnection(account);
    await Promise.all([
      this.readVersion()
        .then((version) => {
          this.cliVersion = version;
        })
        .catch(() => undefined),
      ...this.registry.accounts.map((account) => this.checkAuth(account).catch(() => undefined)),
    ]);
    await this.save();
    if (this.options.poll !== false && !this.closed) {
      this.timer = setInterval(() => {
        void this.refresh().catch(() => undefined);
      }, POLL_MS);
      this.timer.unref();
      void this.refresh().catch(() => undefined);
    }
  }

  status(): ClaudeAccountsStatus {
    return {
      cliVersion: this.cliVersion,
      autoSwitch: this.registry.autoSwitch,
      warmLimits: this.registry.warmLimits !== false,
      currentAccountId: this.registry.currentAccountId,
      accounts: this.registry.accounts.map((account): ClaudeAccount => ({
        id: account.accountId,
        email: account.email,
        plan: account.plan,
        authenticated: account.authenticated,
        proxy: proxyStatus(account.proxy),
        rateLimits: structuredClone(account.rateLimits),
        connectionError: account.connectionError,
      })),
    };
  }
  accountIdForConfigDir(configDir: string): string | undefined {
    return this.registry.accounts.find((account) =>
      [account.configDir, ...(account.previousConfigDirs ?? [])].some(
        (directory) => resolve(directory) === resolve(configDir),
      ),
    )?.accountId;
  }
  private emitChanged(): void {
    if (!this.closed) this.emit("changed", this.status());
  }
  private now(): number {
    return (this.options.now ?? Date.now)();
  }
  private async save(): Promise<void> {
    await writeJsonAtomic(this.registryPath, this.registry);
  }
  private edit<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.updates.catch(() => undefined).then(operation);
    this.updates = next;
    return next;
  }
  private account(id: string): SavedAccount {
    const found = this.registry.accounts.find((item) => item.accountId === id);
    if (!found) throw new AppError("not_found", "Claude account not found", 404);
    return found;
  }
  private launch(account: SavedAccount): ClaudeLaunchAccount {
    if (this.importConnectionBlocked(account))
      throw new AppError("unavailable", account.connectionError!, 503);
    const legacy =
      resolve(account.configDir) === resolve(this.config.configDir) &&
      !account.authenticated &&
      account.proxyConfigured !== true;
    return structuredClone({
      accountId: account.accountId,
      configDir: account.configDir,
      proxy: legacy ? undefined : account.proxy,
      ...(account.defaultConfig ? { defaultConfig: true } : {}),
    });
  }
  private blankAccount(configDir: string, proxy: ParsedClaudeProxy | null = null): SavedAccount {
    return {
      accountId: randomUUID(),
      configDir,
      proxy,
      proxyConfigured: true,
      email: null,
      plan: null,
      authenticated: false,
      rateLimits: unknownLimits(),
      connectionError: null,
    };
  }
  private importConnectionBlocked(account: SavedAccount): boolean {
    return (
      account.proxyConfigured === false &&
      account.proxy === null &&
      account.connectionError === IMPORTED_PROXY_ERROR
    );
  }
  private importNativeConnection(account: SavedAccount): void {
    if (
      resolve(account.configDir) !== resolve(this.config.configDir) ||
      account.proxyConfigured !== false ||
      account.proxy !== null
    )
      return;
    const value = [
      "HTTPS_PROXY",
      "https_proxy",
      "HTTP_PROXY",
      "http_proxy",
      "ALL_PROXY",
      "all_proxy",
    ]
      .map((key) => this.ambientEnv[key])
      .find((entry) => entry?.trim());
    if (!value) return;
    try {
      account.proxy = proxyFromInput({ enabled: true, protocol: "http", value });
      account.connectionError = null;
      account.rateLimits = unknownLimits();
    } catch {
      // Do not silently replace an unrecognized native proxy with direct traffic.
      account.connectionError = IMPORTED_PROXY_ERROR;
      account.rateLimits = { ...unknownLimits(), refreshError: true };
    }
  }

  async refresh(accountId?: string): Promise<ClaudeAccountsStatus> {
    await this.initialize();
    if (this.closed) throw new AppError("unavailable", "Claude account service is closing", 503);
    const accounts = accountId ? [this.account(accountId)] : [...this.registry.accounts];
    await Promise.all(accounts.map((account) => this.refreshAccount(account)));
    return this.status();
  }
  private refreshAccount(account: SavedAccount): Promise<void> {
    const pending = this.refreshes.get(account.accountId);
    if (pending) return pending;
    if (this.importConnectionBlocked(account)) {
      account.rateLimits = { ...account.rateLimits, refreshing: false, refreshError: true };
      this.emitChanged();
      return Promise.resolve();
    }
    account.rateLimits = { ...account.rateLimits, refreshing: true, refreshError: false };
    this.emitChanged();
    const launched = this.launch(account);
    const fingerprint = JSON.stringify([account.configDir, account.proxy]);
    const unchanged = () =>
      this.registry.accounts.includes(account) &&
      JSON.stringify([account.configDir, account.proxy]) === fingerprint;
    const request = (async () => {
      try {
        const auth = await this.readAuth(launched);
        if (!unchanged()) return;
        this.applyAuth(account, auth);
        if (!account.authenticated) {
          account.rateLimits = unknownLimits();
          return;
        }
        let usage = await this.readUsage(launched);
        if (!unchanged()) return;
        if (await this.warm(account, launched, usage)) {
          const warmed = await this.readUsage(launched).catch(() => undefined);
          if (!unchanged()) return;
          if (warmed) usage = warmed;
        }
        const { modelLimits, ...limits } = usage;
        const previousModels = Object.fromEntries(
          Object.entries(account.modelLimits ?? {}).filter(
            ([, window]) =>
              window && typeof window.resetsAt === "number" && window.resetsAt > this.now(),
          ),
        );
        account.modelLimits = { ...previousModels, ...modelLimits };
        account.rateLimits = {
          limits,
          updatedAt: this.now(),
          refreshing: false,
          refreshError: false,
        };
        account.connectionError = null;
      } catch {
        if (!unchanged()) return;
        account.rateLimits = { ...account.rateLimits, refreshing: false, refreshError: true };
        account.connectionError = "Could not refresh this account's connection or limits";
      } finally {
        await this.edit(async () => {
          await this.save();
          this.emitChanged();
        });
      }
    })().finally(() => {
      this.refreshes.delete(account.accountId);
    });
    this.refreshes.set(account.accountId, request);
    return request;
  }
  async confirmQuotaExhausted(id: string, model?: string): Promise<boolean> {
    await this.initialize();
    if (!this.registry.accounts.some((account) => account.accountId === id)) return false;
    try {
      await this.refresh(id);
    } catch (error) {
      if (error instanceof AppError && error.code === "not_found") return false;
      throw error;
    }
    const account = this.registry.accounts.find((account) => account.accountId === id);
    if (!account) return false;
    const state = account.rateLimits;
    return (
      !state.refreshError &&
      [state.limits?.primary, state.limits?.secondary, ...this.modelWindows(account, model)].some(
        (window) =>
          window &&
          Number.isFinite(window.usedPercent) &&
          window.usedPercent >= 100 &&
          typeof window.resetsAt === "number" &&
          Number.isFinite(window.resetsAt) &&
          window.resetsAt > this.now(),
      )
    );
  }
  async setAutoSwitch(enabled: boolean): Promise<ClaudeAccountsStatus> {
    await this.initialize();
    if (typeof enabled !== "boolean")
      throw new AppError("invalid_request", "autoSwitch must be a boolean");
    return this.edit(async () => {
      this.registry.autoSwitch = enabled;
      await this.save();
      this.emitChanged();
      return this.status();
    });
  }
  async setWarmLimits(enabled: boolean): Promise<ClaudeAccountsStatus> {
    await this.initialize();
    if (typeof enabled !== "boolean")
      throw new AppError("invalid_request", "warmLimits must be a boolean");
    return this.edit(async () => {
      this.registry.warmLimits = enabled;
      await this.save();
      this.emitChanged();
      return this.status();
    });
  }
  async select(id: string): Promise<ClaudeAccountsStatus> {
    await this.initialize();
    return this.edit(async () => {
      const account = this.account(id);
      if (!account.authenticated)
        throw new AppError("conflict", "Sign in to this Claude account first", 409);
      this.registry.currentAccountId = id;
      await this.save();
      this.emitChanged();
      return this.status();
    });
  }
  async remove(id: string): Promise<ClaudeAccountsStatus> {
    await this.initialize();
    const cancelled: Login[] = [];
    const status = await this.edit(async () => {
      const account = this.account(id);
      for (const login of this.logins.values()) {
        if (
          login.existingId !== id ||
          ["completed", "failed", "cancelled"].includes(login.status.state)
        )
          continue;
        login.status.state = "cancelled";
        login.status.url = null;
        login.finishing = true;
        cancelled.push(login);
      }
      this.registry.accounts = this.registry.accounts.filter((item) => item !== account);
      if (this.registry.currentAccountId === id)
        this.registry.currentAccountId =
          this.registry.accounts.find((item) => item.authenticated)?.accountId ?? null;
      // Removing an entry never logs out or deletes the user's original ~/.claude.
      await this.save();
      this.emitChanged();
      return this.status();
    });
    // Cleanup stays outside the registry edit lock, which verification also uses.
    await Promise.all(cancelled.map((login) => this.cleanupLogin(login, true)));
    return status;
  }
  async updateProxy(id: string, input: ClaudeProxyInput): Promise<ClaudeAccountsStatus> {
    const proxy = proxyFromInput(input);
    await this.initialize();
    return this.edit(async () => {
      const account = this.account(id);
      account.proxy = proxy;
      account.proxyConfigured = true;
      account.connectionError = null;
      account.rateLimits = unknownLimits();
      account.modelLimits = undefined;
      await this.save();
      this.emitChanged();
      return this.status();
    });
  }
  async launchAccount(): Promise<ClaudeLaunchAccount> {
    await this.initialize();
    const selected =
      this.registry.currentAccountId &&
      this.registry.accounts.find((item) => item.accountId === this.registry.currentAccountId);
    if (selected) return this.launch(selected);
    throw new AppError("unavailable", "Add and select a Claude account first", 503);
  }
  async rotate(failedAccountId?: string, model?: string): Promise<ClaudeLaunchAccount | null> {
    await this.initialize();
    const operation = this.rotation
      .catch(() => undefined)
      .then(async () => {
        if (!this.registry.autoSwitch || this.closed) return null;
        await this.refresh();
        if (!this.registry.autoSwitch || this.closed) return null;
        const eligible = this.registry.accounts.filter((account) => this.eligible(account, model));
        const current = eligible.find(
          (account) => account.accountId === this.registry.currentAccountId,
        );
        if (failedAccountId && this.registry.currentAccountId !== failedAccountId && current)
          return this.launch(current);
        const candidates = eligible
          .filter((account) => account.accountId !== failedAccountId)
          .sort((a, b) => {
            const aLimits = a.rateLimits.limits!,
              bLimits = b.rateLimits.limits!;
            // Spend the 5-hour window that resets first; unknown resets go last.
            return (
              (aLimits.primary!.resetsAt ?? Infinity) - (bLimits.primary!.resetsAt ?? Infinity) ||
              aLimits.primary!.usedPercent - bLimits.primary!.usedPercent ||
              aLimits.secondary!.usedPercent - bLimits.secondary!.usedPercent
            );
          });
        const next = candidates[0];
        if (!next) return null;
        await this.edit(async () => {
          this.registry.currentAccountId = next.accountId;
          await this.save();
          this.emitChanged();
        });
        return this.launch(next);
      });
    this.rotation = operation;
    return operation;
  }
  private modelWindows(
    account: SavedAccount,
    model?: string,
  ): Array<CodexRateLimitWindow | null | undefined> {
    const family =
      model && /opus/i.test(model) ? "opus" : model && /sonnet/i.test(model) ? "sonnet" : undefined;
    if (family) return [account.modelLimits?.[family]];
    if (!model || /^(?:default|auto)$/i.test(model))
      return Object.values(account.modelLimits ?? {});
    return [];
  }
  private eligible(account: SavedAccount, model?: string): boolean {
    const state = account.rateLimits;
    return (
      account.authenticated &&
      !account.connectionError &&
      !state.refreshError &&
      this.modelWindows(account, model).every(
        (window) =>
          !window ||
          (Number.isFinite(window.usedPercent) &&
            window.usedPercent >= 0 &&
            window.usedPercent < 100),
      ) &&
      [state.limits?.primary, state.limits?.secondary].every(
        (window) =>
          window &&
          Number.isFinite(window.usedPercent) &&
          window.usedPercent >= 0 &&
          window.usedPercent < 100 &&
          (window.resetsAt === null ||
            (Number.isFinite(window.resetsAt) && window.resetsAt > this.now())),
      )
    );
  }

  async startLogin(input: CreateClaudeLoginRequest): Promise<ClaudeLoginStatus> {
    await this.initialize();
    if (this.closed) throw new AppError("unavailable", "Claude account service is closing", 503);
    const existing = input.accountId ? this.account(input.accountId) : undefined;
    if (!input.proxy && !existing)
      throw new AppError("invalid_request", "Choose the account connection first");
    if (
      [...this.logins.values()].some(
        (login) => !["completed", "failed", "cancelled"].includes(login.status.state),
      )
    )
      throw new AppError("conflict", "Finish or cancel the current Claude sign-in first", 409);
    const account = this.blankAccount(
      "",
      input.proxy ? proxyFromInput(input.proxy) : existing!.proxy,
    );
    account.configDir = join(this.config.stateDir, "claude-accounts", account.accountId);
    const id = randomUUID();
    const login: Login = {
      status: { id, state: "starting", url: null, accountId: null, error: null },
      account,
      existingId: existing?.accountId,
      output: "",
      bytes: 0,
      finishing: false,
    };
    this.logins.set(id, login);
    const stopped = () => this.closed || login.status.state === "cancelled";
    try {
      await this.prepareDirectory(account.configDir);
      if (stopped()) {
        await this.cleanupLogin(login, true);
        return { ...login.status };
      }
      login.connection = await this.environment(account.proxy, account.configDir);
      if (stopped()) {
        await this.cleanupLogin(login, true);
        return { ...login.status };
      }
      login.child = (this.options.spawnProcess ?? spawn)(
        this.config.claudeBin,
        ["auth", "login", "--claudeai"],
        {
          cwd: this.config.stateDir,
          env: login.connection.env,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        },
      ) as ChildProcessWithoutNullStreams;
      login.child.stdout.setEncoding("utf8");
      login.child.stdout.on("data", (chunk: string) => this.loginOutput(login, chunk));
      login.child.stderr.resume();
      login.child.stderr.on("error", () => void this.failLogin(login));
      login.child.stdout.on("error", () => void this.failLogin(login));
      login.child.stdin.on("error", () => void this.failLogin(login));
      login.child.once("error", () => void this.failLogin(login));
      login.child.once("close", (code) => {
        login.childClosed = true;
        void this.finishLogin(login, code);
      });
      login.timer = setTimeout(
        () => void this.failLogin(login, "Claude sign-in expired; start again"),
        LOGIN_TIMEOUT_MS,
      );
      login.timer.unref();
    } catch {
      await this.failLogin(login);
    }
    return { ...login.status };
  }
  login(id: string): ClaudeLoginStatus {
    const login = this.logins.get(id);
    if (!login) throw new AppError("not_found", "Claude sign-in not found", 404);
    return { ...login.status };
  }
  async submitCode(id: string, input: string): Promise<ClaudeLoginStatus> {
    const login = this.logins.get(id);
    if (!login) throw new AppError("not_found", "Claude sign-in not found", 404);
    if (login.status.state !== "waitingCode" || !login.child || login.finishing)
      throw new AppError("conflict", "This Claude sign-in is not waiting for a code", 409);
    const code = authorizationCode(input);
    login.status.state = "checking";
    login.child.stdin.write(`${code}\n`);
    return { ...login.status };
  }
  async cancelLogin(id: string): Promise<ClaudeLoginStatus> {
    const login = this.logins.get(id);
    if (!login) throw new AppError("not_found", "Claude sign-in not found", 404);
    await this.edit(async () => {
      if (["completed", "failed", "cancelled"].includes(login.status.state)) return;
      login.status.state = "cancelled";
      login.status.url = null;
      login.finishing = true;
    });
    if (login.status.state !== "cancelled") return { ...login.status };
    await this.cleanupLogin(login, true);
    return { ...login.status };
  }
  private loginOutput(login: Login, chunk: string): void {
    if (login.finishing || ["completed", "failed", "cancelled"].includes(login.status.state))
      return;
    login.bytes += Buffer.byteLength(chunk);
    if (login.bytes > MAX_OUTPUT_BYTES) {
      void this.failLogin(login);
      return;
    }
    // Native login uses ANSI terminal sequences even when stdout is piped.
    // eslint-disable-next-line no-control-regex
    login.output += chunk.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
    const matches = login.output.match(/https:\/\/[^\s<>"']+(?=[\s<>"'])/g) ?? [];
    for (const candidate of matches) {
      try {
        const url = new URL(candidate);
        if (
          ["claude.ai", "claude.com", "platform.claude.com", "console.anthropic.com"].includes(
            url.hostname,
          ) &&
          !url.username &&
          !url.password &&
          url.pathname.includes("oauth")
        ) {
          login.status.url = url.toString();
          login.status.state = "waitingCode";
          login.output = "";
          break;
        }
      } catch {
        /* Wait for the next output fragment. */
      }
    }
  }
  private async finishLogin(login: Login, code: number | null): Promise<void> {
    if (login.finishing) return;
    login.finishing = true;
    if (code !== 0) return this.failLogin(login);
    login.status.state = "checking";
    try {
      const auth = await this.readAuth(this.launch(login.account));
      if (!auth.loggedIn || auth.authMethod !== "claude.ai" || !auth.email?.trim())
        throw new Error("Native sign-in is not verified");
      let committed = false;
      await this.edit(async () => {
        if (login.status.state === "cancelled" || this.closed) return;
        const duplicate = this.registry.accounts.find(
          (account) => account.email?.toLowerCase() === auth.email!.trim().toLowerCase(),
        );
        const existing = login.existingId
          ? this.registry.accounts.find((account) => account.accountId === login.existingId)
          : duplicate;
        if (login.existingId && !existing)
          throw new AppError("not_found", "The Claude account was removed during sign-in", 404);
        if (duplicate && existing && duplicate !== existing)
          throw new AppError(
            "conflict",
            "This email is already added; sign in to its account entry",
            409,
          );
        const account = login.account;
        account.email = auth.email!.trim();
        account.plan = auth.subscriptionType ?? auth.plan ?? null;
        account.authenticated = true;
        if (existing) {
          account.accountId = existing.accountId;
          account.previousConfigDirs = [
            ...new Set([existing.configDir, ...(existing.previousConfigDirs ?? [])]),
          ];
          // Keep the logical identity stable; the newly verified native directory is adopted below.
          const index = this.registry.accounts.indexOf(existing);
          this.registry.accounts[index] = account;
        } else this.registry.accounts.push(account);
        if (
          !this.registry.currentAccountId ||
          !this.registry.accounts.find((item) => item.accountId === this.registry.currentAccountId)
            ?.authenticated
        )
          this.registry.currentAccountId = account.accountId;
        await this.save();
        this.emitChanged();
        login.status.accountId = account.accountId;
        login.status.state = "completed";
        login.status.url = null;
        committed = true;
      });
      if (!committed) return;
      await this.cleanupLogin(login, false);
      void this.refresh(login.account.accountId).catch(() => undefined);
    } catch (error) {
      await this.failLogin(login, error instanceof AppError ? error.message : undefined);
    }
  }
  private async failLogin(
    login: Login,
    message = "Claude sign-in failed; check the connection and start again",
  ): Promise<void> {
    if (["completed", "cancelled", "failed"].includes(login.status.state)) return;
    login.finishing = true;
    login.status.state = "failed";
    login.status.error = message;
    login.status.url = null;
    await this.cleanupLogin(login, true);
  }
  private async cleanupLogin(login: Login, removeDirectory: boolean): Promise<void> {
    if (login.timer) clearTimeout(login.timer);
    login.output = "";
    if (login.child && login.child.exitCode === null && login.child.signalCode === null) {
      const child = login.child;
      await new Promise<void>((done) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(escalation);
          clearTimeout(deadline);
          child.off("close", finish);
          done();
        };
        const escalation = setTimeout(() => child.kill("SIGKILL"), 5_000);
        const deadline = setTimeout(finish, 10_000);
        child.once("close", finish);
        child.stdin.end();
        child.kill("SIGTERM");
      });
    }
    await login.connection?.close().catch(() => undefined);
    login.connection = undefined;
    const terminated =
      !login.child ||
      login.childClosed ||
      login.child.exitCode !== null ||
      login.child.signalCode !== null;
    if (removeDirectory && terminated)
      await rm(login.account.configDir, { recursive: true, force: true }).catch(() => undefined);
  }
  private async prepareDirectory(directory: string): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await mkdir(this.config.configDir, { recursive: true, mode: 0o700 });
    for (const name of [
      "projects",
      "tasks",
      "file-history",
      "settings.json",
      "CLAUDE.md",
      "agents",
      "skills",
      "plugins",
      "output-styles",
    ]) {
      const target = join(this.config.configDir, name);
      if (["projects", "tasks", "file-history"].includes(name))
        await mkdir(target, { recursive: true, mode: 0o700 });
      try {
        await access(target);
      } catch {
        continue;
      }
      await symlink(target, join(directory, name));
    }
    // Copy only MCP configuration, never native identity, credentials or account-policy caches.
    const originalDefault =
      (resolve(this.config.configDir) === this.defaultConfigDir &&
        this.ambientEnv.CLAUDE_CONFIG_DIR === undefined) ||
      this.registry.accounts.some(
        (account) =>
          account.defaultConfig && resolve(account.configDir) === resolve(this.config.configDir),
      );
    const sources = [
      join(this.config.configDir, ".config.json"),
      join(this.config.configDir, ".claude.json"),
      ...(originalDefault ? [join(dirname(this.defaultConfigDir), ".claude.json")] : []),
    ];
    let source: Record<string, unknown> | undefined;
    for (const path of sources) {
      source = await readJson<Record<string, unknown>>(path).catch(() => undefined);
      if (source) break;
    }
    if (source) {
      const seed: Record<string, unknown> = {};
      if (source.mcpServers && typeof source.mcpServers === "object")
        seed.mcpServers = source.mcpServers;
      if (
        source.projects &&
        typeof source.projects === "object" &&
        !Array.isArray(source.projects)
      ) {
        const projects: Record<string, unknown> = {};
        for (const [path, value] of Object.entries(source.projects as Record<string, unknown>)) {
          if (!value || typeof value !== "object" || Array.isArray(value)) continue;
          const project = value as Record<string, unknown>;
          const settings = Object.fromEntries(
            [
              "mcpServers",
              "enabledMcpjsonServers",
              "disabledMcpjsonServers",
              "allowedTools",
              "hasTrustDialogAccepted",
              "ignorePatterns",
            ]
              .filter((key) => key in project)
              .map((key) => [key, project[key]]),
          );
          if (Object.keys(settings).length) projects[path] = settings;
        }
        if (Object.keys(projects).length) seed.projects = projects;
      }
      if (Object.keys(seed).length) await writeJsonAtomic(join(directory, ".claude.json"), seed);
    }
  }
  private async checkAuth(account: SavedAccount): Promise<void> {
    const auth = await this.readAuth(this.launch(account));
    this.applyAuth(account, auth);
  }
  private applyAuth(account: SavedAccount, auth: NativeClaudeAuth): void {
    account.authenticated =
      auth.loggedIn && auth.authMethod === "claude.ai" && Boolean(auth.email?.trim());
    account.email = auth.email?.trim() || account.email;
    account.plan = auth.subscriptionType ?? auth.plan ?? account.plan;
    account.connectionError = null;
  }
  private environment(
    proxy: ParsedClaudeProxy | null,
    directory: string,
  ): Promise<ClaudeProxyEnvironment> {
    return (this.options.proxyEnvironment ?? createClaudeProxyEnvironment)(proxy, directory, {
      env: this.ambientEnv,
    });
  }
  private async readAuth(account: ClaudeLaunchAccount): Promise<NativeClaudeAuth> {
    if (this.options.readAuth) return this.options.readAuth(account);
    const output = await this.nativeCommand(["auth", "status", "--json"], account);
    try {
      const data = record(JSON.parse(output));
      return {
        loggedIn: data.loggedIn === true,
        ...(typeof data.authMethod === "string" ? { authMethod: data.authMethod } : {}),
        ...(typeof data.email === "string" ? { email: data.email } : {}),
        ...(typeof data.subscriptionType === "string"
          ? { subscriptionType: data.subscriptionType }
          : {}),
      };
    } catch {
      throw new Error("Could not verify the native Claude account");
    }
  }
  /** Starts the idle 5-hour window with one minimal request so its timer never sits unused. */
  private async warm(
    account: SavedAccount,
    launched: ClaudeLaunchAccount,
    usage: NativeClaudeUsage,
  ): Promise<boolean> {
    if (this.registry.warmLimits === false) return false;
    const now = this.now();
    // A present weekly window proves a subscription; API-key accounts report no limits at all.
    if (!usage.secondary || (usage.primary?.resetsAt ?? 0) > now) return false;
    if ((usage.secondary.usedPercent ?? 0) >= 100) return false;
    if (now - (this.warmedAt.get(account.accountId) ?? 0) < WARM_RETRY_MS) return false;
    this.warmedAt.set(account.accountId, now);
    try {
      await this.nativeCommand(
        ["-p", "ok", "--model", "haiku", "--tools", "", "--no-session-persistence"],
        launched,
      );
      return true;
    } catch {
      return false;
    }
  }
  private async readUsage(account: ClaudeLaunchAccount): Promise<NativeClaudeUsage> {
    if (this.options.readUsage) return this.options.readUsage(account);
    const cwd = join(this.config.stateDir, "account-probe");
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const process = new ClaudeProcess({
      claudeBin: this.config.claudeBin,
      cwd,
      sessionId: randomUUID(),
      resume: false,
      noSessionPersistence: true,
      proxy: account.proxy,
      env: { CLAUDE_CONFIG_DIR: account.defaultConfig ? undefined : account.configDir },
      spawnProcess: this.options.spawnProcess,
      proxyEnvironment: async (...args) => {
        const connection = await (this.options.proxyEnvironment ?? createClaudeProxyEnvironment)(
          ...args,
        );
        // The CLI treats the usage endpoint as nonessential and would answer without limits.
        delete connection.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
        return connection;
      },
    });
    process.on("error", () => undefined);
    try {
      await process.start();
      const raw = await process.readUsage();
      const limits = parseClaudeUsage(raw);
      const windows =
        raw.rate_limits && typeof raw.rate_limits === "object"
          ? (raw.rate_limits as Record<string, unknown>)
          : {};
      const modelLimits: Record<string, CodexRateLimitWindow | null> = {};
      for (const family of ["opus", "sonnet"])
        if (windows[`seven_day_${family}`] !== undefined) {
          modelLimits[family] = parseClaudeUsage({
            rate_limits_available: true,
            rate_limits: { seven_day: windows[`seven_day_${family}`] },
          }).secondary;
        }
      return { ...limits, modelLimits };
    } finally {
      await process.stop();
    }
  }
  private async readVersion(): Promise<string | null> {
    if (this.options.readVersion) return this.options.readVersion();
    const output = await this.nativeCommand(["--version"]);
    return /\b\d+\.\d+\.\d+(?:-[\w.]+)?\b/.exec(output)?.[0] ?? null;
  }
  private async nativeCommand(args: string[], account?: ClaudeLaunchAccount): Promise<string> {
    const connection =
      account && account.proxy !== undefined
        ? await this.environment(account.proxy, account.defaultConfig ? "" : account.configDir)
        : undefined;
    try {
      return await new Promise<string>((resolve, reject) => {
        let output = "",
          bytes = 0,
          done = false;
        const env = connection?.env ?? {
          ...this.ambientEnv,
          ...(account
            ? { CLAUDE_CONFIG_DIR: account.defaultConfig ? undefined : account.configDir }
            : {}),
        };
        if (account?.defaultConfig) delete env.CLAUDE_CONFIG_DIR;
        delete env.CLAUDECODE;
        const child = (this.options.spawnProcess ?? spawn)(this.config.claudeBin, args, {
          cwd: this.config.stateDir,
          env,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        }) as ChildProcessWithoutNullStreams;
        const finish = (error?: Error) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (error) {
            child.kill("SIGKILL");
            reject(error);
          } else resolve(output);
        };
        const timer = setTimeout(
          () => finish(new Error("Native Claude command timed out")),
          30_000,
        );
        child.stdin.end();
        child.stderr.resume();
        child.stdout.setEncoding("utf8");
        for (const stream of [child.stdin, child.stdout, child.stderr])
          stream.once("error", () => finish(new Error("Native Claude command stream failed")));
        child.stdout.on("data", (chunk: string) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > MAX_OUTPUT_BYTES)
            finish(new Error("Native Claude response exceeded its limit"));
          else output += chunk;
        });
        child.once("error", () => finish(new Error("Could not execute installed Claude CLI")));
        child.once("close", (code) =>
          finish(
            code === 0 || (args[0] === "auth" && output.trim())
              ? undefined
              : new Error("Native Claude command failed"),
          ),
        );
      });
    } finally {
      await connection?.close().catch(() => undefined);
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    for (const login of this.logins.values())
      if (!["completed", "failed", "cancelled"].includes(login.status.state))
        await this.cancelLogin(login.status.id);
    await Promise.allSettled([...this.refreshes.values(), this.updates, this.rotation]);
  }
}

export function authorizationCode(input: string): string {
  if (typeof input !== "string" || !input.trim() || input.length > 8192 || /[\r\n\0]/.test(input))
    throw new AppError("invalid_request", "Paste the complete Claude authorization code");
  let code = input.trim();
  if (/^https?:\/\//i.test(code)) {
    try {
      const url = new URL(code),
        value = url.searchParams.get("code"),
        state = url.searchParams.get("state");
      if (!value) throw new Error();
      code = state ? `${value}#${state}` : value;
    } catch {
      throw new AppError(
        "invalid_request",
        "The pasted authorization link does not contain a code",
      );
    }
  }
  if (/\s|[\r\n\0]/.test(code))
    throw new AppError("invalid_request", "Paste the complete Claude authorization code");
  return code;
}
