import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import type { Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { Server } from "proxy-chain";
import {
  parseClaudeProxy,
  type ClaudeProxyInput,
  type ClaudeProxyStatus,
  type ClaudeProxyTestResult,
  type ParsedClaudeProxy,
} from "@codexnest/protocol";
import { AppError } from "./types.js";

export type ClaudeProxyEnvironment = {
  env: NodeJS.ProcessEnv;
  close(): Promise<void>;
};
type ProxyServer = Pick<Server, "listen" | "close" | "port" | "on">;
export type ProxyEnvironmentOptions = {
  env?: NodeJS.ProcessEnv;
  createServer?: (options: ConstructorParameters<typeof Server>[0]) => ProxyServer;
};

export function proxyStatus(proxy: ParsedClaudeProxy | null): ClaudeProxyStatus {
  return {
    enabled: proxy !== null,
    protocol: proxy?.protocol ?? "http",
    host: proxy?.host ?? null,
    port: proxy?.port ?? null,
    username: proxy?.username ?? null,
    hasPassword: Boolean(proxy?.password),
  };
}

export function proxyFromInput(input: ClaudeProxyInput): ParsedClaudeProxy | null {
  if (
    !input ||
    typeof input.enabled !== "boolean" ||
    !["http", "https", "socks5"].includes(input.protocol)
  )
    throw new AppError("invalid_request", "Invalid proxy settings");
  if (!input.enabled) return null;
  try {
    return parseClaudeProxy(input.value, input.protocol);
  } catch {
    // Never reflect credentials, parser candidates or raw vendor input in server errors.
    throw new AppError(
      "invalid_request",
      "Proxy address is invalid or ambiguous; choose a parsed address",
    );
  }
}

/** Each CLI owns its SOCKS bridge, including runners that outlive the API server. */
export async function createClaudeProxyEnvironment(
  proxy: ParsedClaudeProxy | null,
  configDir: string,
  options: ProxyEnvironmentOptions = {},
): Promise<ClaudeProxyEnvironment> {
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  else delete env.CLAUDE_CONFIG_DIR;
  if (configDir) delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  for (const key of Object.keys(env)) {
    if (/^(?:https?|all|no)_proxy$/i.test(key)) delete env[key];
  }
  for (const key of [
    "CLAUDECODE",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "ANTHROPIC_CUSTOM_HEADERS",
  ])
    delete env[key];
  // Managed accounts must authenticate from their isolated native config.
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  let bridge: ProxyServer | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await bridge?.close(true);
  };
  try {
    let url = proxy?.url;
    if (proxy?.protocol === "socks5") {
      const upstream = new URL(proxy.url);
      upstream.protocol = "socks5h:";
      bridge = (options.createServer ?? ((settings) => new Server(settings)))({
        host: "127.0.0.1",
        port: 0,
        verbose: false,
        prepareRequestFunction: () => ({ upstreamProxyUrl: upstream.toString() }),
      });
      bridge.on("error", () => undefined);
      bridge.on("requestFailed", () => undefined);
      await bridge.listen();
      url = `http://127.0.0.1:${bridge.port}`;
    }
    if (url) {
      env.HTTP_PROXY = url;
      env.HTTPS_PROXY = url;
      // Local MCP servers, such as the browser tools, must not go through the account proxy.
      env.NO_PROXY = "localhost,127.0.0.1,::1";
    }
    return { env, close };
  } catch {
    await close().catch(() => undefined);
    throw new AppError("unavailable", "Could not start the account proxy connection", 503);
  }
}

/** Connect and verify TLS to Claude without sending account credentials. */
export async function testClaudeProxy(
  input: ClaudeProxyInput,
  options: ProxyEnvironmentOptions & {
    probe?: (proxyUrl: string | undefined) => Promise<void>;
  } = {},
): Promise<ClaudeProxyTestResult> {
  const proxy = proxyFromInput(input);
  const started = performance.now();
  let connection: ClaudeProxyEnvironment | undefined;
  try {
    connection = await createClaudeProxyEnvironment(proxy, "", options);
    await (options.probe ?? probeClaudeEndpoint)(connection.env.HTTPS_PROXY);
    return {
      ok: true,
      latencyMs: Math.round(performance.now() - started),
      error: null,
      proxy: proxyStatus(proxy),
    };
  } catch {
    return {
      ok: false,
      latencyMs: null,
      error: "Could not connect to Claude through the selected connection",
      proxy: proxyStatus(proxy),
    };
  } finally {
    await connection?.close().catch(() => undefined);
  }
}

function probeClaudeEndpoint(proxyUrl: string | undefined): Promise<void> {
  const target = "api.anthropic.com";
  return new Promise((resolve, reject) => {
    let destroyRequest = () => {};
    let socket: tls.TLSSocket | undefined;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      destroyRequest();
      socket?.destroy();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error("Connection timed out")), 10_000);
    const verify = (tunnel?: Socket) => {
      socket = tls.connect({
        host: tunnel ? undefined : target,
        port: tunnel ? undefined : 443,
        socket: tunnel,
        servername: target,
        rejectUnauthorized: true,
      });
      socket.once("secureConnect", () => {
        socket!.write(`HEAD /v1/models HTTP/1.1\r\nHost: ${target}\r\nConnection: close\r\n\r\n`);
      });
      let response = "";
      socket.on("data", (chunk: Buffer) => {
        response += chunk.toString("ascii");
        if (/^HTTP\/1\.[01] [1-5]\d\d\b/.test(response)) finish();
        else if (response.length > 1024) finish(new Error("Invalid endpoint response"));
      });
      socket.once("error", finish);
      socket.once("end", () => finish(new Error("Endpoint closed without a response")));
    };
    if (!proxyUrl) return verify();
    const upstream = new URL(proxyUrl);
    const headers: Record<string, string> = { Host: `${target}:443` };
    if (upstream.username || upstream.password) {
      const credentials = `${decodeURIComponent(upstream.username)}:${decodeURIComponent(upstream.password)}`;
      headers["Proxy-Authorization"] = `Basic ${Buffer.from(credentials).toString("base64")}`;
    }
    const transport = upstream.protocol === "https:" ? https : http;
    const request = transport.request({
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
      method: "CONNECT",
      path: `${target}:443`,
      headers,
      agent: false,
    });
    destroyRequest = () => request.destroy();
    request.once("connect", (response, tunnel, head) => {
      if (response.statusCode !== 200) {
        tunnel.destroy();
        return finish(new Error("Proxy connection rejected"));
      }
      if (head.length) tunnel.unshift(head);
      verify(tunnel);
    });
    request.once("error", finish);
    request.end();
  });
}
