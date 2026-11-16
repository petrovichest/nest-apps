import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { promisify } from "node:util";
import type { OpenProxyStatus, OpenProxyTestResult } from "@codexnest/protocol";
import { writeJsonAtomic } from "../../claude-server/src/io";
import { proxyAddress, proxyEnvironment } from "../../gemini-server/src/proxy";
import type { Config } from "./config";

const execute = promisify(execFile);
type SavedConnection = { version: 1; proxy: string | null };
const empty = (): SavedConnection => ({ version: 1, proxy: null });

export class OpenConnectionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = "OpenConnectionError";
  }
}

function normalizeProxy(value: unknown): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 16_000 || /[\r\n\0]/.test(value))
    throw new OpenConnectionError("validation_failed", "Некорректный адрес прокси.");
  try {
    return proxyAddress(value.trim()).url;
  } catch {
    throw new OpenConnectionError(
      "validation_failed",
      "Некорректный адрес прокси. Используйте HTTP, HTTPS или SOCKS5.",
    );
  }
}

/** A malformed or nonprivate saved proxy must never turn into a direct connection. */
export async function readOpenConnection(configDir: string): Promise<SavedConnection> {
  const path = join(configDir, "connection.json");
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.mode & 0o077)
      throw new OpenConnectionError(
        "invalid_configuration",
        "Настройки прокси должны храниться в закрытом обычном файле (0600).",
        503,
      );
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path, "utf8"));
    } catch {
      throw new OpenConnectionError(
        "invalid_configuration",
        "Не удалось прочитать сохранённые настройки прокси.",
        503,
      );
    }
    const saved = value as Partial<SavedConnection> | null;
    if (!saved || saved.version !== 1 || !(saved.proxy === null || typeof saved.proxy === "string"))
      throw new OpenConnectionError(
        "invalid_configuration",
        "Некорректный формат настроек прокси.",
        503,
      );
    return { version: 1, proxy: normalizeProxy(saved.proxy) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
    if (error instanceof OpenConnectionError) throw error;
    throw new OpenConnectionError(
      "invalid_configuration",
      "Не удалось прочитать сохранённые настройки прокси.",
      503,
    );
  }
}

/** Child requests receive a local bridge address, never upstream credentials. */
export async function openProxyEnvironment(proxy: string | null, inherited = process.env) {
  const env = { ...inherited };
  for (const key of Object.keys(env)) {
    if (
      /^(https?|all|no)_proxy$/i.test(key) ||
      /^(CODEXNEST_|CLAUDENEST_|GEMININEST_)/.test(key) ||
      (/^OPENNEST_/.test(key) &&
        ![
          "OPENNEST_CONFIG_DIR",
          "OPENNEST_STATE_DIR",
          "OPENNEST_PORT",
          "OPENNEST_HOST",
          "OPENNEST_EVENT_SOCKET",
        ].includes(key)) ||
      /^(OPENAI_API_KEY|CODEX_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|GEMINI_API_KEY|GOOGLE_API_KEY|OPENROUTER_API_KEY)$/.test(
        key,
      )
    )
      delete env[key];
  }
  env.OPENCODE_DISABLE_AUTOUPDATE = "true";
  if (!proxy) return { env, close: async () => {} };
  const bridge = await proxyEnvironment(proxy, env);
  delete bridge.env.AGY_CLI_DISABLE_AUTO_UPDATE;
  return bridge;
}

async function probeProxy(proxy: string): Promise<void> {
  const connection = await openProxyEnvironment(proxy);
  try {
    await new Promise<void>((resolve, reject) => {
      const bridge = new URL(connection.env.HTTPS_PROXY!);
      const req = request({
        hostname: bridge.hostname,
        port: bridge.port,
        method: "CONNECT",
        path: "openrouter.ai:443",
        headers: { host: "openrouter.ai:443" },
      });
      let tunnel: ReturnType<typeof tlsConnect> | undefined;
      const timer = setTimeout(() => {
        req.destroy();
        tunnel?.destroy();
        reject(new Error("Proxy timeout"));
      }, 12_000);
      const fail = () => {
        clearTimeout(timer);
        req.destroy();
        tunnel?.destroy();
        reject(new Error("Proxy connection failed"));
      };
      req.once("error", fail);
      req.once("connect", (response, socket, head) => {
        if (response.statusCode !== 200 || head.length) {
          socket.destroy();
          fail();
          return;
        }
        tunnel = tlsConnect({ socket, servername: "openrouter.ai", rejectUnauthorized: true });
        tunnel.once("secureConnect", () => {
          clearTimeout(timer);
          tunnel?.destroy();
          resolve();
        });
        tunnel.once("error", fail);
      });
      req.end();
    });
  } finally {
    await connection.close();
  }
}

export type OpenConnectionOptions = {
  /** Holds native admission closed across idle verification, persistence and restart. */
  withIdleNative: <T>(action: () => Promise<T>) => Promise<T>;
  restartNative?: () => Promise<void>;
  probe?: (proxy: string) => Promise<void>;
};

export class OpenConnection {
  private data = empty();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly config: Pick<Config, "configDir" | "managedInstall">,
    private readonly options: OpenConnectionOptions,
  ) {}
  async initialize() {
    this.data = await readOpenConnection(this.config.configDir);
  }
  status(): OpenProxyStatus {
    const url = this.data.proxy ? new URL(this.data.proxy) : null;
    const hasPassword = Boolean(url?.password);
    if (url) {
      url.username = "";
      url.password = "";
    }
    return { configured: Boolean(url), address: url?.toString() ?? null, hasPassword };
  }
  setProxy(value: string | null): Promise<OpenProxyStatus> {
    const proxy = normalizeProxy(value);
    const operation = this.tail.then(() =>
      this.options.withIdleNative(async () => {
        if (proxy === this.data.proxy) return this.status();
        if (!this.options.restartNative && !this.config.managedInstall)
          throw new OpenConnectionError(
            "unavailable",
            "Прокси можно применить только к управляемому процессу OpenNest.",
            503,
          );
        const previous = this.data;
        const next: SavedConnection = { version: 1, proxy };
        const path = join(this.config.configDir, "connection.json");
        await writeJsonAtomic(path, next);
        this.data = next;
        try {
          if (this.options.restartNative) await this.options.restartNative();
          else
            await execute("systemctl", ["--user", "restart", "opennest-daemon.service"], {
              timeout: 30_000,
            });
        } catch {
          await writeJsonAtomic(path, previous);
          this.data = previous;
          throw new OpenConnectionError(
            "unavailable",
            "Не удалось применить прокси. Предыдущая настройка сохранена; проверьте состояние OpenCode.",
            503,
          );
        }
        return this.status();
      }),
    );
    this.tail = operation.catch(() => undefined);
    return operation;
  }
  async testProxy(): Promise<OpenProxyTestResult> {
    const proxy = this.data.proxy;
    if (!proxy) return { ok: false, message: "Сначала сохраните адрес прокси." };
    try {
      await (this.options.probe ?? probeProxy)(proxy);
      return {
        ok: true,
        message:
          "Соединение с OpenRouter через прокси установлено. API-ключ этой проверкой не проверяется.",
      };
    } catch {
      return {
        ok: false,
        message:
          "Не удалось подключиться к OpenRouter через прокси. Проверьте адрес и учётные данные.",
      };
    }
  }
}
