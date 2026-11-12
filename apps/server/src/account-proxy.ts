import { randomBytes } from "node:crypto";
import { Server } from "proxy-chain";
import { fetch, ProxyAgent } from "undici";
import {
  parseClaudeProxy,
  type ClaudeProxyInput,
  type ClaudeProxyStatus,
  type ParsedClaudeProxy,
  type ClaudeProxyTestResult,
} from "@codexnest/protocol";

export class AccountProxyError extends Error {
  constructor(
    public readonly kind: "validation" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "AccountProxyError";
  }
}

export function accountProxy(input: ClaudeProxyInput): ParsedClaudeProxy | null {
  if (
    !input ||
    typeof input.enabled !== "boolean" ||
    !["http", "https", "socks5"].includes(input.protocol)
  )
    throw new AccountProxyError("validation", "Invalid account proxy settings");
  if (!input.enabled) return null;
  try {
    return parseClaudeProxy(input.value, input.protocol);
  } catch {
    throw new AccountProxyError(
      "validation",
      "Proxy address is invalid or ambiguous; choose a parsed address",
    );
  }
}

export function accountProxyStatus(proxy: ParsedClaudeProxy | null): ClaudeProxyStatus {
  return {
    enabled: proxy !== null,
    protocol: proxy?.protocol ?? "http",
    host: proxy?.host ?? null,
    port: proxy?.port ?? null,
    username: proxy?.username ?? null,
    hasPassword: Boolean(proxy?.password),
    url: proxy?.url ?? null,
  };
}

export type AccountProxyConnection = {
  env: NodeJS.ProcessEnv;
  /** Private loopback credentials, not the upstream proxy credentials. Never expose in API/logs. */
  url: string;
  close(): Promise<void>;
};

/** One immutable egress route for one native account process. No upstream-error fallback. */
export async function createAccountProxyConnection(
  proxy: ParsedClaudeProxy | null,
  ambient: NodeJS.ProcessEnv = process.env,
): Promise<AccountProxyConnection> {
  // Only null means an explicit direct route. Missing/corrupt metadata must fail closed.
  if (proxy !== null) {
    try {
      if (!proxy || !proxy.url || !["http", "https", "socks5"].includes(proxy.protocol))
        throw new Error("Missing proxy");
      proxy = parseClaudeProxy(proxy.url, proxy.protocol);
    } catch {
      throw new AccountProxyError("validation", "Invalid account proxy settings");
    }
  }
  const env = { ...ambient };
  for (const key of Object.keys(env)) if (/^(https?|all|no)_proxy$/i.test(key)) delete env[key];
  const password = randomBytes(24).toString("hex");
  let upstream = proxy?.url;
  if (proxy?.protocol === "socks5") {
    const url = new URL(proxy.url);
    url.protocol = "socks5h:"; // Resolve destination names at the SOCKS server, not on this host.
    upstream = url.toString();
  }
  const server = new Server({
    host: "127.0.0.1",
    port: 0,
    verbose: false,
    prepareRequestFunction: (request) => ({
      requestAuthentication: request.username !== "codexnest" || request.password !== password,
      // Undefined is allowed only for the user's explicit direct-connection choice.
      upstreamProxyUrl: upstream,
    }),
  });
  server.on("error", () => undefined);
  server.on("requestFailed", () => undefined);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await server.close(true);
  };
  try {
    await server.listen();
  } catch {
    await close().catch(() => undefined);
    throw new AccountProxyError("failed", "Could not start the account proxy connection");
  }
  const url = `http://codexnest:${password}@127.0.0.1:${server.port}`;
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ])
    env[key] = url;
  // Local MCP endpoints and the local OAuth callback must remain local. Never inherit '*' or LAN exclusions.
  env.NO_PROXY = "localhost,127.0.0.1,::1";
  env.no_proxy = env.NO_PROXY;
  return { env, url, close };
}

/** The probe uses the same private relay as native, including for explicit direct mode. */
export async function testAccountProxy(input: ClaudeProxyInput): Promise<ClaudeProxyTestResult> {
  const proxy = accountProxy(input);
  const started = performance.now();
  let connection: AccountProxyConnection | undefined;
  let dispatcher: ProxyAgent | undefined;
  try {
    connection = await createAccountProxyConnection(proxy);
    const url = new URL(connection.url);
    const token = `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}`;
    url.username = "";
    url.password = "";
    dispatcher = new ProxyAgent({ uri: url.toString(), token });
    for (const endpoint of ["https://auth.openai.com/", "https://chatgpt.com/"]) {
      const response = await fetch(endpoint, {
        method: "HEAD",
        dispatcher,
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel();
    }
    return {
      ok: true,
      latencyMs: Math.round(performance.now() - started),
      error: null,
      proxy: accountProxyStatus(proxy),
    };
  } catch {
    return {
      ok: false,
      latencyMs: null,
      error: "Could not connect to Codex through the selected connection",
      proxy: accountProxyStatus(proxy),
    };
  } finally {
    await dispatcher?.close().catch(() => undefined);
    await connection?.close().catch(() => undefined);
  }
}
