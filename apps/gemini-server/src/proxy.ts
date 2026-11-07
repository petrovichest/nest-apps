import { Server } from "proxy-chain";
import { parseClaudeProxy as parseProxy } from "@codexnest/protocol";

export function proxyAddress(value: string) {
  try {
    return parseProxy(value, value.startsWith("socks") ? "socks5" : "http");
  } catch {
    throw new Error("Некорректный адрес прокси. Используйте http://, https:// или socks5://.");
  }
}

/** No direct fallback. The bridge belongs to the daemon, not its HTTP gateway. */
export async function proxyEnvironment(value: string, inherited = process.env) {
  if (!value) throw new Error("Сначала настройте прокси в настройках Gemini.");
  const proxy = proxyAddress(value);
  const upstream = new URL(proxy.url);
  if (proxy.protocol === "socks5") upstream.protocol = "socks5h:";
  const server = new Server({
    host: "127.0.0.1",
    port: 0,
    verbose: false,
    prepareRequestFunction: () => ({ upstreamProxyUrl: upstream.toString() }),
  });
  server.on("error", () => undefined);
  server.on("requestFailed", () => undefined);
  await server.listen();
  const env = { ...inherited };
  for (const key of Object.keys(env)) {
    if (
      /^(https?|all|no)_proxy$/i.test(key) ||
      /^(CODEXNEST_|CLAUDENEST_|GEMININEST_)/.test(key) ||
      /^(GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_GENAI_USE_VERTEXAI|AGY_LLM_GATEWAY_PROXY_URL|ANTIGRAVITY_SIDECAR_UI_TOKEN)$/.test(
        key,
      )
    )
      delete env[key];
  }
  const url = `http://127.0.0.1:${server.port}`;
  Object.assign(env, {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    ALL_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    all_proxy: url,
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1",
    AGY_CLI_DISABLE_AUTO_UPDATE: "true",
  });
  let closing: Promise<void> | undefined;
  return { env, close: () => (closing ??= server.close(true)) };
}
