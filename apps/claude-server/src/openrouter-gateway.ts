import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Agent, request } from "node:https";
import { pipeline } from "node:stream/promises";

export interface OpenRouterConnection {
  keyFile: string;
  endpoint?: { model: string; slug: string };
}

export function validOpenRouterSlug(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-z0-9-]+(?:\/[a-z0-9-]+){0,3}$/.test(value) &&
    value.length <= 160
  );
}

const messages = "/api/v1/messages";
const countTokens = "/api/v1/messages/count_tokens";
const requestLimit = 32 * 1024 * 1024;

class GatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function readOpenRouterKey(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.mode & 0o077 || metadata.size > 4096)
      throw new Error("OpenRouter key must be in a private regular file");
    const content = (await file.readFile("utf8")).trim();
    const key: unknown = content.startsWith('"') ? JSON.parse(content) : content;
    if (typeof key !== "string" || !/^[a-zA-Z0-9_-]+$/.test(key))
      throw new Error("Invalid OpenRouter key");
    return key;
  } finally {
    await file.close();
  }
}

export function routeOpenRouterMessage(
  payload: unknown,
  endpoint?: OpenRouterConnection["endpoint"],
) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new GatewayError(400, "Invalid model request");
  const body = { ...(payload as Record<string, unknown>) };
  if (
    typeof body.model !== "string" ||
    !/^[\w.-]+\/[\w.-]+$/.test(body.model) ||
    body.model.startsWith("openrouter/")
  )
    throw new GatewayError(400, "An explicit OpenRouter model is required");
  if (endpoint && endpoint.model !== body.model)
    throw new GatewayError(400, "The selected OpenRouter endpoint belongs to a different model");
  delete body.models;
  delete body.preset;
  delete body.route;
  body.provider = {
    data_collection: "deny",
    ...(endpoint ? { only: [endpoint.slug], allow_fallbacks: false } : {}),
  };
  return body;
}

async function readRequest(input: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    size += chunk.length;
    if (size > requestLimit) throw new GatewayError(413, "Model request exceeds size limit");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new GatewayError(400, "Invalid JSON");
  }
}

export async function startOpenRouterGateway(
  options: OpenRouterConnection,
  env: NodeJS.ProcessEnv,
) {
  const key = await readOpenRouterKey(options.keyFile);
  let endpoint = options.endpoint;
  const token = randomBytes(32).toString("hex");
  const authorization = Buffer.from(`Bearer ${token}`);
  const agent = new Agent({ keepAlive: true, proxyEnv: env });

  async function forward(incoming: IncomingMessage, outgoing: ServerResponse) {
    const received = Buffer.from(incoming.headers.authorization ?? "");
    if (received.length !== authorization.length || !timingSafeEqual(received, authorization))
      throw new GatewayError(401, "Unauthorized model gateway");
    const target = new URL(incoming.url ?? "/", "http://127.0.0.1");
    if (incoming.method !== "POST" || ![messages, countTokens].includes(target.pathname))
      throw new GatewayError(404, "Unknown model gateway endpoint");
    const payload = await readRequest(incoming);
    const data = JSON.stringify(
      target.pathname === messages ? routeOpenRouterMessage(payload, endpoint) : payload,
    );
    const headers: Record<string, string | number> = {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(data),
    };
    for (const name of [
      "anthropic-version",
      "anthropic-beta",
      "anthropic-dangerous-direct-browser-access",
    ] as const) {
      const value = incoming.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    const abort = new AbortController();
    const cancel = () => abort.abort();
    outgoing.once("close", cancel);
    try {
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const upstream = request(
          `https://openrouter.ai${target.pathname}${target.search}`,
          { method: "POST", headers, agent, signal: abort.signal },
          resolve,
        );
        upstream.on("error", reject);
        upstream.end(data);
      });
      const type = response.headers["content-type"];
      outgoing.writeHead(response.statusCode ?? 502, type ? { "content-type": type } : {});
      await pipeline(response, outgoing);
    } finally {
      outgoing.off("close", cancel);
    }
  }
  const server = createServer((incoming, outgoing) => {
    void forward(incoming, outgoing).catch((error: unknown) => {
      if (outgoing.destroyed) return;
      if (outgoing.headersSent) {
        outgoing.destroy();
        return;
      }
      const status = error instanceof GatewayError ? error.status : 502;
      const message =
        error instanceof GatewayError ? error.message : "OpenRouter connection failed";
      outgoing.writeHead(status, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ type: "error", error: { type: "api_error", message } }));
    });
  });
  let port: number;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Cannot bind model gateway");
    port = address.port;
  } catch (error) {
    server.close();
    agent.destroy();
    throw error;
  }
  return {
    url: `http://127.0.0.1:${port}/api`,
    token,
    setEndpoint(next?: OpenRouterConnection["endpoint"]) {
      endpoint = next;
    },
    async close() {
      agent.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
