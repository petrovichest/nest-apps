import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import type {
  CodexAccount,
  CodexAccountsStatus,
  CodexLoginStatus,
  CodexRateLimitsState,
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

const LOGIN_TIMEOUT_MS = 15 * 60_000;
const unknownLimits = (): CodexRateLimitsState => ({
  limits: null,
  updatedAt: null,
  refreshing: false,
  refreshError: false,
});
type SavedAccount = CodexAccount & { native?: boolean; identity: string };
type Registry = Omit<CodexAccountsStatus, "accounts"> & {
  version: 1;
  importedNative: boolean;
  accounts: SavedAccount[];
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
  process: AccountProcess;
  timer?: NodeJS.Timeout;
  completing: boolean;
};
export type CodexAccountsOptions = {
  stateDir: string;
  codexHome: string;
  codexBin: string;
  proxyEnvFile: string;
  activeTurnCount(): number;
  /** Isolated native auth processes, never a second conversation server. */
  openProcess?: (home: string, native: boolean) => Promise<AccountProcess>;
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
    accounts: [],
  };
  private updates: Promise<unknown> = Promise.resolve();
  private logins = new Map<string, Login>();
  private processes = new Set<AccountProcess>();
  private activeProcess?: { id: string; process: AccountProcess };
  private tokenRefresh?: Promise<ChatgptAuthTokensRefreshResponse>;
  private externalAccessToken?: string;
  private closed = false;
  private readonly root: string;
  private readonly registryPath: string;

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
    if (!saved) return;
    if (
      saved.version !== 1 ||
      !Array.isArray(saved.accounts) ||
      saved.accounts.some(
        (account) => !validId(account.id) || typeof account.identity !== "string",
      ) ||
      new Set(saved.accounts.map((account) => account.id)).size !== saved.accounts.length ||
      (saved.currentAccountId !== null &&
        !saved.accounts.some((account) => account.id === saved.currentAccountId))
    )
      throw new Error("Codex account registry is invalid");
    this.registry = saved;
    for (const account of this.registry.accounts) {
      account.rateLimits = { ...(account.rateLimits ?? unknownLimits()), refreshing: false };
    }
  }

  status(): CodexAccountsStatus {
    return {
      currentAccountId: this.registry.currentAccountId,
      accounts: this.registry.accounts.map(
        ({ id, email, plan, authenticated, rateLimits, connectionError }) => ({
          id,
          email,
          plan,
          authenticated,
          rateLimits: structuredClone(rateLimits),
          connectionError,
        }),
      ),
    };
  }

  /** Reapply external auth when the shared daemon reconnects, before accepting conversations. */
  restore(): Promise<void> {
    this.bridge.accountSwitching = true;
    return this.serial(async () => {
      if (!this.registry.importedNative) {
        const auth = await this.bridge.request<GetAuthStatusResponse>("getAuthStatus", {
          includeToken: true,
          refreshToken: false,
        });
        if (["chatgpt", "chatgptAuthTokens"].includes(auth.authMethod ?? "") && auth.authToken) {
          const native = await readNativeAccount(this.bridge, false, auth);
          this.registry.accounts.push({
            id: randomUUID(),
            native: true,
            identity: native.identity,
            email: native.email,
            plan: native.plan,
            authenticated: true,
            rateLimits: unknownLimits(),
            connectionError: null,
          });
          this.registry.currentAccountId = this.registry.accounts[0]!.id;
          // Keep native auth until the first selection; importing requires no extra process.
          this.registry.importedNative = true;
          this.bridge.accountLoginRequired = false;
          await this.save();
          this.changed();
          return;
        }
        this.registry.importedNative = true;
        await this.save();
      }
      if (!this.registry.currentAccountId) return;
      const account = this.find(this.registry.currentAccountId);
      const native = await this.activate(account, false);
      this.bridge.accountLoginRequired = false;
      this.updateIdentity(account, native);
      await this.save();
      this.changed();
    })
      .catch((error: unknown) => {
        if (this.registry.currentAccountId) {
          this.bridge.accountLoginRequired = true;
          const account = this.find(this.registry.currentAccountId);
          account.authenticated = false;
          account.connectionError = "Codex account needs a ChatGPT login";
          this.changed();
        }
        throw error;
      })
      .finally(() => {
        this.bridge.accountSwitching = false;
        if (!this.closed) this.emit("selected");
      });
  }

  select(id: string): Promise<CodexAccountsStatus> {
    return this.serial(async () => {
      const account = this.find(id);
      const native = await this.activate(account, true);
      this.registry.currentAccountId = id;
      this.bridge.accountLoginRequired = false;
      this.updateIdentity(account, native);
      await this.save();
      this.changed();
      this.emit("selected");
      return this.status();
    });
  }

  remove(id: string): Promise<CodexAccountsStatus> {
    return this.serial(async () => {
      const account = this.find(id);
      if (id === this.registry.currentAccountId)
        throw new CodexAccountError(
          "conflict",
          "Select another Codex account before removing the current account",
        );
      if (
        [...this.logins.values()].some(
          (login) => login.existingId === id && !terminal(login.status),
        )
      )
        throw new CodexAccountError(
          "conflict",
          "Cancel the Codex login before removing this account",
        );
      this.registry.accounts = this.registry.accounts.filter((entry) => entry.id !== id);
      await this.save();
      // Native ~/.codex and conversation history are never removed.
      if (!account.native) await rm(this.home(account), { recursive: true, force: true });
      this.changed();
      return this.status();
    });
  }

  refresh(id?: string): Promise<CodexAccountsStatus> {
    return this.serial(async () => {
      const accounts = id ? [this.find(id)] : [...this.registry.accounts];
      for (const account of accounts) {
        account.rateLimits = { ...account.rateLimits, refreshing: true, refreshError: false };
        this.changed();
        try {
          await this.withProcess(account, async (process) => {
            const native = await readNativeAccount(process.transport);
            if (native.identity !== account.identity) throw new Error("Account changed");
            this.updateIdentity(account, native);
            account.rateLimits = {
              limits: parseAccountRateLimits(
                await process.transport.request("account/rateLimits/read", undefined),
              ),
              updatedAt: Date.now(),
              refreshing: false,
              refreshError: false,
            };
          });
        } catch {
          account.rateLimits = { ...account.rateLimits, refreshing: false, refreshError: true };
          account.connectionError = "Could not refresh Codex account; sign in again or retry";
        }
        this.changed();
      }
      await this.save();
      return this.status();
    });
  }

  /** Answer only the native refresh request, without RPCs on ordinary turn starts. */
  refreshTokens(previousAccountId?: string | null): Promise<ChatgptAuthTokensRefreshResponse> {
    // Native callbacks have a ten-second deadline. Never queue them behind login or quota work.
    this.tokenRefresh ??= (async () => {
      const account = this.find(this.registry.currentAccountId ?? "");
      if (!this.activeProcess) {
        this.activeProcess = {
          id: account.id,
          process: await this.open(this.home(account), account.native === true),
        };
      }
      const native = await this.withProcess(account, async (process) => {
        const latest = await readNativeAccount(process.transport);
        // Native quota polling may have refreshed already. Do not rotate that token again.
        return latest.tokens.accessToken !== this.externalAccessToken
          ? latest
          : readNativeAccount(process.transport, true);
      });
      if (native.identity !== account.identity || this.registry.currentAccountId !== account.id)
        throw new CodexAccountError("conflict", "Codex account changed during token refresh");
      this.updateIdentity(account, native);
      this.externalAccessToken = native.tokens.accessToken;
      this.changed();
      return native.tokens;
    })()
      .catch((error: unknown) => {
        const account = this.registry.accounts.find(
          (entry) => entry.id === this.registry.currentAccountId,
        );
        if (account) {
          account.connectionError = "Could not refresh Codex account; sign in again or retry";
          if (
            error instanceof CodexAccountError &&
            error.message === "Codex account needs a ChatGPT login"
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

  startLogin(existingId?: string): Promise<CodexLoginStatus> {
    return this.serial(async () => {
      if (existingId) this.find(existingId);
      if ([...this.logins.values()].some((login) => !terminal(login.status)))
        throw new CodexAccountError("conflict", "A Codex login is already in progress");
      // Keep only the latest completed attempt; no tokens or native errors enter UI status.
      this.logins.clear();
      const id = randomUUID();
      const home = join(this.root, `login-${id}`);
      await mkdir(home, { recursive: true, mode: 0o700 });
      let process: AccountProcess;
      try {
        process = await this.open(home, false);
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
        process,
        completing: false,
      };
      this.logins.set(id, login);
      process.transport.on("notification", (notification: ServerNotification) => {
        if (notification.method !== "account/login/completed" || terminal(login.status)) return;
        if (notification.params.success) {
          login.status.state = "checking";
          login.completing = true;
          void this.serial(() => this.finishLogin(login)).catch(() => this.failLogin(login));
        } else {
          void this.failLogin(login);
        }
      });
      process.transport.on("exit", () => {
        if (!terminal(login.status) && !login.completing) void this.failLogin(login);
      });
      login.timer = setTimeout(() => {
        void this.cancelLogin(id).catch(() => undefined);
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

  cancelLogin(id: string): Promise<CodexLoginStatus> {
    return this.serial(async () => {
      const login = this.findLogin(id);
      if (!terminal(login.status)) {
        login.status.state = "cancelled";
        await this.cleanLogin(login);
      }
      return { ...login.status };
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const login of this.logins.values()) {
      if (!terminal(login.status)) login.status.state = "cancelled";
      clearTimeout(login.timer);
    }
    await Promise.all([...this.processes].map((process) => process.close()));
    await this.updates.catch(() => undefined);
    await Promise.all([...this.logins.values()].map((login) => this.cleanLogin(login)));
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
      const account: SavedAccount = existing ?? {
        id: randomUUID(),
        identity: native.identity,
        email: native.email,
        plan: native.plan,
        authenticated: true,
        rateLimits: unknownLimits(),
        connectionError: null,
      };
      const home = join(this.root, account.id);
      // Only native OAuth credentials move out of staging, never an access-token-only snapshot.
      const credentials = await readJson<unknown>(join(login.home, "auth.json"));
      if (!credentials) throw new Error("Missing native credentials");
      await mkdir(home, { recursive: true, mode: 0o700 });
      await writeJson(join(home, "auth.json"), credentials);
      if (terminal(login.status) || this.closed) return;
      account.native = false;
      this.updateIdentity(account, native);
      if (!existing) this.registry.accounts.push(account);
      if (account.id === this.registry.currentAccountId) {
        // A fresh native manager must load the newly saved refresh token.
        if (this.activeProcess) {
          const previous = this.activeProcess.process;
          this.activeProcess = undefined;
          await previous.close();
          this.processes.delete(previous);
        }
        if (!this.busy()) {
          await this.activate(account, true);
          this.bridge.accountLoginRequired = false;
        } else {
          this.activeProcess = { id: account.id, process: await this.open(home, false) };
        }
      }
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

  private async failLogin(login: Login): Promise<void> {
    if (!terminal(login.status)) {
      login.status.state = "failed";
      login.status.error =
        "Codex login failed; enable device code authorization in ChatGPT settings and retry";
    }
    await this.cleanLogin(login);
  }

  private async cleanLogin(login: Login): Promise<void> {
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
  private home(account: SavedAccount): string {
    return account.native ? this.options.codexHome : join(this.root, account.id);
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
    if (!this.closed) this.emit("changed", this.status());
  }
  private save(): Promise<void> {
    return writeJson(this.registryPath, this.registry);
  }
  private async withProcess<T>(
    account: SavedAccount,
    task: (process: AccountProcess) => Promise<T>,
  ): Promise<T> {
    if (this.activeProcess?.id === account.id) return task(this.activeProcess.process);
    const process = await this.open(this.home(account), account.native === true);
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

  private async activate(account: SavedAccount, checkIdle: boolean): Promise<NativeAccount> {
    const previous = this.activeProcess;
    const process =
      previous?.id === account.id
        ? previous.process
        : await this.open(this.home(account), account.native === true);
    let applied = false;
    try {
      const native = await readNativeAccount(process.transport);
      if (native.identity !== account.identity)
        throw new CodexAccountError("conflict", "Codex account identity changed; sign in again");
      if (checkIdle && this.busy())
        throw new CodexAccountError(
          "conflict",
          "Wait for active Codex responses before switching accounts",
        );
      this.bridge.accountSwitching = true;
      if (this.tokenRefresh) await this.tokenRefresh.catch(() => undefined);
      await this.bridge.request("account/login/start", {
        type: "chatgptAuthTokens",
        ...native.tokens,
      });
      this.activeProcess = { id: account.id, process };
      this.externalAccessToken = native.tokens.accessToken;
      this.registry.currentAccountId = account.id;
      applied = true;
      if (previous && previous.process !== process) {
        await previous.process.close();
        this.processes.delete(previous.process);
      }
      return native;
    } catch (error) {
      if (error instanceof CodexAccountError) throw error;
      throw new CodexAccountError(
        "failed",
        "Could not open Codex account; check the connection and retry",
      );
    } finally {
      this.bridge.accountSwitching = false;
      if (!applied && process !== previous?.process) {
        await process.close();
        this.processes.delete(process);
      }
    }
  }
  private async open(home: string, native: boolean): Promise<AccountProcess> {
    const process = this.options.openProcess
      ? await this.options.openProcess(home, native)
      : await openAccountProcess(this.options, home, native);
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
): Promise<AccountProcess> {
  const proxy = await readProxyUrl(options.proxyEnvFile);
  const env = childProcessEnvironment({ CODEX_HOME: home });
  if (!native) {
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
  }
  if (proxy) {
    for (const key of [
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "ALL_PROXY",
      "https_proxy",
      "http_proxy",
      "all_proxy",
    ])
      env[key] = proxy;
  }
  const child: ChildProcessWithoutNullStreams = spawn(
    options.codexBin,
    [
      "--enable",
      "respect_system_proxy",
      ...(native ? [] : ["-c", 'cli_auth_credentials_store="file"']),
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
        resolve();
        return;
      }
      const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      timer.unref();
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    }));
  try {
    await transport.request("initialize", {
      clientInfo: { name: "codexnest_accounts", title: "CodexNest accounts", version: "0.1.0" },
      capabilities: { experimentalApi: true },
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
  } finally {
    await rm(temporary, { force: true });
  }
}
