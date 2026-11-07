import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { connect as tlsConnect } from "node:tls";
import { join } from "node:path";
import type { GeminiConnectionStatus, GeminiLoginStatus } from "@codexnest/protocol";
import { readJson, writeJsonAtomic } from "../../claude-server/src/io";
import type { Config } from "./config";
import { nativeArgs } from "./acp";
import { proxyAddress, proxyEnvironment } from "./proxy";

type SavedConnection = { proxy: string; authenticated: boolean };

export class Account {
  private data: SavedConnection = { proxy: "", authenticated: false };
  private loginState: GeminiLoginStatus | null = null;
  private running?: ChildProcessWithoutNullStreams;
  private loginConnection?: Awaited<ReturnType<typeof proxyEnvironment>>;
  private timer?: NodeJS.Timeout;
  cliVersion: string | null = null;
  constructor(
    readonly config: Config,
    readonly onChange: () => void = () => {},
  ) {}

  async initialize() {
    this.data =
      (await readJson<SavedConnection>(join(this.config.configDir, "connection.json"))) ??
      this.data;
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
    return Boolean(this.running);
  }

  async setProxy(value: string) {
    if (this.running) throw new Error("Завершите или отмените вход перед изменением прокси.");
    const previous = this.data.proxy;
    this.data.proxy = proxyAddress(value).url;
    try {
      await this.save();
    } catch (error) {
      this.data.proxy = previous;
      throw error;
    }
    return this.status();
  }

  async connection() {
    return proxyEnvironment(this.data.proxy);
  }

  async testProxy() {
    const connection = await this.connection();
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

  async startLogin() {
    if (this.running) return this.status();
    this.loginConnection = await this.connection();
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
        this.data.authenticated = true;
        try {
          await this.save();
        } catch {
          this.data.authenticated = false;
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

  private save() {
    return writeJsonAtomic(join(this.config.configDir, "connection.json"), this.data);
  }
  async close() {
    await this.cancelLogin();
  }
}
