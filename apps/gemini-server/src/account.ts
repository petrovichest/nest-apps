import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { connect as tlsConnect } from "node:tls";
import { join } from "node:path";
import type { GeminiConnectionStatus, GeminiLoginStatus } from "@codexnest/protocol";
import { readJson, writeJsonAtomic } from "../../claude-server/src/io";
import type { Config } from "./config";
import { nativeArgs } from "./acp";
import { readGeminiModels } from "./models";
import { nativeConnection } from "./native-process";
import { proxyAddress, proxyEnvironment } from "./proxy";

type SavedConnection = { proxy: string; authenticated: boolean; method?: "refresh_token" };
type NativeConnection = Awaited<ReturnType<typeof nativeConnection>>;

export class RefreshTokenLoginError extends Error {}

export class Account {
  private data: SavedConnection = { proxy: "", authenticated: false };
  private loginState: GeminiLoginStatus | null = null;
  private running?: ChildProcessWithoutNullStreams;
  private loginConnection?: Awaited<ReturnType<typeof proxyEnvironment>>;
  private timer?: NodeJS.Timeout;
  private importing?: Promise<void>;
  private connectionGeneration = 0;
  private readonly connections = new Set<NativeConnection>();
  private closed = false;
  cliVersion: string | null = null;
  constructor(
    readonly config: Config,
    readonly onChange: () => void = () => {},
  ) {}

  async initialize() {
    this.data =
      (await readJson<SavedConnection>(join(this.config.configDir, "connection.json"))) ??
      this.data;
    await this.refreshCliVersion();
  }

  async refreshCliVersion(): Promise<string | null> {
    const child = spawn(this.config.agyBin, ["--version"], {
      env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let version = "";
    child.stdout.on("data", (chunk) => {
      if (version.length < 100) version += chunk.toString();
    });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 5_000);
      child.once("error", () => {
        clearTimeout(timer);
        resolve();
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) this.cliVersion = version.trim();
        resolve();
      });
    });
    return this.cliVersion;
  }

  status(): GeminiConnectionStatus {
    const proxy = this.data.proxy ? proxyAddress(this.data.proxy) : null;
    const address = proxy ? new URL(proxy.url) : null;
    if (address) {
      address.username = "";
      address.password = "";
    }
    return {
      cliVersion: this.cliVersion,
      authenticated: this.data.authenticated,
      proxy: {
        configured: Boolean(proxy),
        address: address?.toString() ?? null,
        hasPassword: Boolean(proxy?.password),
      },
      login: this.loginState ? { ...this.loginState } : null,
    };
  }

  get loggingIn() {
    return Boolean(this.running || this.importing);
  }

  async setProxy(value: string) {
    if (this.loggingIn) throw new Error("Завершите или отмените вход перед изменением прокси.");
    const next = { ...this.data, proxy: proxyAddress(value).url };
    await this.disconnect();
    await this.save(next);
    this.data = next;
    this.onChange();
    return this.status();
  }

  private get importedCredential() {
    return join(this.config.configDir, "imported-antigravity-oauth-token");
  }

  async connection(): Promise<NativeConnection> {
    if (this.closed || this.loggingIn) throw new Error("Gemini connection is unavailable");
    const generation = this.connectionGeneration;
    const data = this.data;
    const connection = await nativeConnection(
      data.proxy,
      this.config,
      data.method === "refresh_token" ? this.importedCredential : undefined,
    );
    if (
      this.closed ||
      this.loggingIn ||
      this.data !== data ||
      this.connectionGeneration !== generation
    ) {
      await connection.close();
      throw new Error("Gemini connection changed");
    }
    const tracked = {
      ...connection,
      close: () => {
        this.connections.delete(tracked);
        return connection.close();
      },
    };
    this.connections.add(tracked);
    return tracked;
  }

  async disconnect() {
    this.connectionGeneration++;
    await Promise.all([...this.connections].map((connection) => connection.close()));
  }

  async testProxy() {
    const connection = await proxyEnvironment(this.data.proxy);
    try {
      await new Promise<void>((resolve, reject) => {
        const proxy = new URL(connection.env.HTTPS_PROXY!);
        const req = request({
          hostname: proxy.hostname,
          port: proxy.port,
          method: "CONNECT",
          path: "oauth2.googleapis.com:443",
          headers: { host: "oauth2.googleapis.com:443" },
        });
        const timer = setTimeout(() => {
          req.destroy();
          reject(new Error("Proxy timeout"));
        }, 12_000);
        req.on("error", () => {
          clearTimeout(timer);
          reject(new Error("Proxy connection failed"));
        });
        req.on("connect", (response, socket, head) => {
          if (response.statusCode !== 200 || head.length) {
            clearTimeout(timer);
            socket.destroy();
            reject(new Error("Proxy refused connection"));
            return;
          }
          const tls = tlsConnect({
            socket,
            servername: "oauth2.googleapis.com",
            rejectUnauthorized: true,
          });
          tls.once("secureConnect", () => {
            clearTimeout(timer);
            tls.destroy();
            resolve();
          });
          tls.once("error", () => {
            clearTimeout(timer);
            tls.destroy();
            reject(new Error("TLS failed"));
          });
        });
        req.end();
      });
      return { ok: true, message: "Соединение с Google через прокси установлено." };
    } catch {
      return {
        ok: false,
        message: "Не удалось подключиться к Google через прокси. Проверьте адрес и учётные данные.",
      };
    } finally {
      await connection.close();
    }
  }

  async importRefreshToken(refreshToken: string) {
    if (this.loggingIn) throw new RefreshTokenLoginError("Дождитесь завершения текущего входа.");
    if (!this.data.proxy) throw new RefreshTokenLoginError("Сначала сохраните прокси Gemini.");
    if (!this.cliVersion) throw new RefreshTokenLoginError("Antigravity CLI не найден.");
    if (!refreshToken || /\s/.test(refreshToken))
      throw new RefreshTokenLoginError("Введите действующий refresh-токен Google.");
    this.loginState = null;
    const attempt = this.verifyAndSaveToken(refreshToken);
    this.importing = attempt;
    try {
      await attempt;
    } finally {
      this.importing = undefined;
    }
    this.onChange();
    return this.status();
  }

  private async verifyAndSaveToken(refreshToken: string) {
    await access("/usr/bin/bwrap").catch(() => {
      throw new RefreshTokenLoginError(
        "Для входа по токену установите bubblewrap на сервере GeminiNest.",
      );
    });
    await mkdir(this.config.stateDir, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(this.config.stateDir, "token-login-"));
    const credential = join(directory, "credential");
    const profile = { agyBin: this.config.agyBin, nativeDir: join(directory, "native") };
    let connection: NativeConnection | undefined;
    try {
      // An expired cache entry makes agy use its own OAuth client for the first exchange.
      await writeJsonAtomic(credential, {
        auth_method: "consumer",
        token: { refresh_token: refreshToken, expiry: "1970-01-01T00:00:00Z" },
      });
      connection = await nativeConnection(this.data.proxy, profile, credential);
      try {
        await readGeminiModels(connection.native, connection.env);
      } catch {
        throw new RefreshTokenLoginError(
          "Не удалось войти через сохранённый прокси. Проверьте токен и соединение.",
        );
      }
      const session = await readJson<{ token?: { access_token?: string; refresh_token?: string } }>(
        credential,
      );
      if (!session?.token?.access_token || !session.token.refresh_token)
        throw new RefreshTokenLoginError("Antigravity CLI не сохранил сессию Google.");
      if (this.closed) throw new Error("Gemini account is closing");
      await mkdir(join(this.config.nativeDir, "gemininest"), { recursive: true, mode: 0o700 });
      const next = { ...this.data, authenticated: true, method: "refresh_token" } as const;
      await writeJsonAtomic(this.importedCredential, session);
      if (this.data.method !== "refresh_token" || !this.data.authenticated) {
        await this.save(next);
        this.data = next;
      }
    } finally {
      await connection?.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async startLogin() {
    if (this.loggingIn) return this.status();
    this.loginConnection = await proxyEnvironment(this.data.proxy);
    const id = randomUUID();
    this.loginState = { id, state: "starting", url: null, error: null };
    const child = spawn(this.config.agyBin, [...nativeArgs(this.config), "--login"], {
      env: this.loginConnection.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    this.running = child;
    let output = "";
    const consume = (chunk: Buffer) => {
      if (this.running !== child || this.loginState?.state !== "starting") return;
      output = (output + chunk.toString("utf8")).slice(-64_000);
      // Native terminal output can contain ANSI escape delimiters.
      // eslint-disable-next-line no-control-regex
      const match = /https:\/\/accounts\.google\.com\/[^\s\x1b]+/.exec(output);
      if (!match || !output.includes("press Enter")) return;
      this.loginState = { id, state: "awaiting_code", url: match[0], error: null };
      output = "";
      this.onChange();
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.stdin.on("error", () => undefined);
    const finish = async (ok: boolean) => {
      if (this.running !== child) return;
      clearTimeout(this.timer);
      const connection = this.loginConnection;
      this.loginConnection = undefined;
      await connection?.close();
      if (this.running !== child) return;
      if (ok) {
        const next = { proxy: this.data.proxy, authenticated: true };
        try {
          await this.save(next);
          this.data = next;
        } catch {
          ok = false;
        }
      }
      if (this.running !== child) return;
      this.running = undefined;
      this.loginState = {
        id,
        state: ok ? "completed" : "failed",
        url: null,
        error: ok
          ? null
          : "Вход не завершён. Проверьте прокси и повторите вход с новой ссылкой Google.",
      };
      this.onChange();
    };
    let finished = false;
    const finishOnce = (ok: boolean) => {
      if (finished) return;
      finished = true;
      void finish(ok).catch(() => {
        if (this.running !== child) return;
        this.running = undefined;
        this.loginState = {
          id,
          state: "failed",
          url: null,
          error: "Не удалось завершить вход. Повторите попытку.",
        };
        this.onChange();
      });
    };
    child.once("error", () => {
      finishOnce(false);
    });
    child.once("close", (code) => {
      finishOnce(code === 0);
    });
    this.timer = setTimeout(() => {
      child.kill();
    }, 10 * 60_000);
    this.onChange();
    return this.status();
  }

  submitCode(id: string, value: string) {
    if (this.loginState?.id !== id || this.loginState.state !== "awaiting_code" || !this.running)
      throw new Error("Этот запрос входа уже закрыт. Начните вход заново.");
    const code = value.trim();
    if (!code || code.length > 16_000 || /[\r\n\0]/.test(code))
      throw new Error("Введите код или URL после входа в Google.");
    this.loginState = { ...this.loginState, state: "exchanging", url: null };
    this.running.stdin.end(`${code}\n`);
    this.onChange();
    return this.status();
  }

  async cancelLogin() {
    const child = this.running;
    this.running = undefined;
    clearTimeout(this.timer);
    child?.kill();
    await this.loginConnection?.close();
    this.loginConnection = undefined;
    if (this.loginState)
      this.loginState = { ...this.loginState, state: "cancelled", url: null, error: null };
    this.onChange();
    return this.status();
  }

  private save(data: SavedConnection) {
    return writeJsonAtomic(join(this.config.configDir, "connection.json"), data);
  }
  async close() {
    this.closed = true;
    await this.disconnect();
    await this.cancelLogin();
    await this.importing?.catch(() => undefined);
  }
}
