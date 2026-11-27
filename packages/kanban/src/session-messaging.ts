import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, unlink } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import {
  SESSION_MCP_NAME,
  SESSION_SEND_TOOL,
  type KanbanProvider,
  type ThreadSummary,
} from "@codexnest/protocol";

const names = {
  codex: "CodexNest",
  claude: "ClaudeNest",
  gemini: "GeminiNest",
  open: "OpenNest",
} as const;
const maxMessageLength = SESSION_SEND_TOOL.inputSchema.properties.message.maxLength;
const maxReferenceLength = SESSION_SEND_TOOL.inputSchema.properties.session.maxLength;
const maxPayloadBytes = 150_000;
const threadIdPattern = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$|^ses_[A-Za-z0-9_-]{1,196}$/i;
export const SESSION_MESSAGE_ID_PREFIX = "nest-message:";
const messageIdPattern = /^nest-message:[a-f\d]{64}$/;
const loopback = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export const SESSION_MCP_PATH = "/api/v1/internal/session-mcp/";

type Address = { provider: KanbanProvider; threadId: string };
type Delivery = {
  source: Address;
  target: Address;
  message: string;
  requestReply: boolean;
  messageId: string;
};
type Admission = { status: "queued"; messageId: string; session: string };
type SessionLookup = Pick<ThreadSummary, "archived" | "currentTurnId" | "relation">;
type Options = {
  provider: KanbanProvider;
  port: number;
  credential?: string;
  thread(id: string): SessionLookup | undefined;
  resolveThreadId?(id: string): string | undefined;
  enqueue(id: string, text: string, messageId: string): Promise<unknown>;
  artifactTool?: {
    definition: { name: string; description: string; inputSchema: unknown };
    available(id: string): Promise<boolean>;
    publish(id: string, args: unknown, metadata: unknown): Promise<unknown>;
  };
};

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function isSessionThreadId(value: unknown): value is string {
  return typeof value === "string" && threadIdPattern.test(value);
}

function validReferenceId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
}

function address(value: unknown): Address {
  const { provider, threadId } = object(value);
  if (
    typeof provider !== "string" ||
    !Object.hasOwn(names, provider) ||
    !validReferenceId(threadId)
  )
    throw new Error("Invalid Nest session address");
  return { provider: provider as KanbanProvider, threadId };
}

function reference(target: Address): string {
  return `Сессия: ${names[target.provider]}\nID: ${target.threadId}`;
}

function parseReference(value: unknown, current: KanbanProvider): Address {
  if (typeof value !== "string" || value.length > maxReferenceLength)
    throw new Error("Provide a copied Nest session reference or session ID");
  if (validReferenceId(value.trim())) return { provider: current, threadId: value.trim() };
  const app = /^(?:Сессия|Session):[^\S\r\n]*(\S+)[^\S\r\n]*$/im.exec(value)?.[1];
  const id = /^ID:[^\S\r\n]*(\S+)[^\S\r\n]*$/im.exec(value)?.[1];
  const provider = (Object.keys(names) as KanbanProvider[]).find(
    (key) => names[key].toLowerCase() === app?.toLowerCase(),
  );
  if (!provider || !validReferenceId(id))
    throw new Error("The session reference must contain a Nest application name and its ID");
  return { provider, threadId: id };
}

function messageText(value: unknown): string {
  if (typeof value !== "string" || value.length > maxMessageLength || !value.trim())
    throw new Error(`Message must contain between 1 and ${maxMessageLength} characters`);
  return value.trim();
}

function requireSession(options: Options, id: string): SessionLookup {
  const thread = options.thread(id);
  if (!thread) throw new Error(`Session ${id} was not found in ${names[options.provider]}`);
  if (thread.archived || thread.relation.kind !== "session")
    throw new Error("Session messaging requires an unarchived, standalone session");
  return thread;
}

function deliveryInput(delivery: Delivery): string {
  const identity = reference(delivery.source);
  const message = `Сообщение из другой сессии\n${identity}\n\n${delivery.message}`;
  if (!delivery.requestReply) return message;
  return (
    `${message}\n\nОтправитель просит ответить в его чат. Если можешь ответить в рамках текущей задачи и разрешений, ` +
    `отправь ответ инструментом send_message по приложению и ID отправителя из заголовка. Для ответа оставь requestReply выключенным.`
  );
}

function publicError(error: unknown): string {
  return error instanceof Error ? error.message : "Nest message could not be queued";
}

function socketDirectory(): string | undefined {
  return (
    process.env.NEST_SESSION_MESSAGING_DIR ||
    (process.env.NODE_ENV === "test" || process.env.VITEST
      ? undefined
      : join(process.env.XDG_RUNTIME_DIR || join(homedir(), ".local/state"), "nest-messages"))
  );
}

async function listen(server: Server, path: string): Promise<void> {
  const bind = () =>
    new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError).once("listening", onListening).listen(path);
    });
  try {
    await bind();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    const stale = await lstat(path);
    if (!stale.isSocket() || stale.uid !== process.getuid?.()) throw error;
    // Recover the socket left by a crashed process. A live peer keeps ownership.
    const refused = await new Promise<boolean>((resolve) => {
      const probe = connect(path);
      probe.setTimeout(1_000, () => {
        probe.destroy();
        resolve(false);
      });
      probe.once("connect", () => {
        probe.destroy();
        resolve(false);
      });
      probe.once("error", (failure: NodeJS.ErrnoException) =>
        resolve(failure.code === "ECONNREFUSED"),
      );
    });
    const current = await lstat(path);
    if (!refused || stale.ino !== current.ino || stale.dev !== current.dev) throw error;
    await unlink(path);
    await bind();
  }
}

async function readJson(stream: AsyncIterable<Uint8Array>): Promise<unknown> {
  const parts: Uint8Array[] = [];
  let length = 0;
  for await (const part of stream) {
    length += part.byteLength;
    if (length > maxPayloadBytes) throw new Error("Nest message is too large");
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}

async function sendToPeer(directory: string | undefined, delivery: Delivery): Promise<Admission> {
  const name = names[delivery.target.provider];
  if (!directory) throw new Error(`${name} is not connected to this Nest installation`);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: join(directory, `${delivery.target.provider}.sock`),
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      (res) => {
        void readJson(res).then((value) => {
          const response = object(value);
          if (res.statusCode === 202 && response.messageId === delivery.messageId)
            resolve(value as Admission);
          else
            reject(
              new Error(
                typeof response.error === "string"
                  ? response.error
                  : `${name} could not queue the message`,
              ),
            );
        }, reject);
      },
    );
    req.setTimeout(30_000, () => req.destroy(new Error("Message delivery could not be confirmed")));
    req.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "ENOENT" || error.code === "ECONNREFUSED"
          ? new Error(`${name} is unavailable on this computer`)
          : new Error("Message delivery could not be confirmed"),
      );
    });
    req.end(JSON.stringify(delivery));
  });
}

export function registerSessionMessaging(app: FastifyInstance, options: Options) {
  const directory = socketDirectory();
  let connectedDirectory: string | undefined;
  const key = options.credential || randomBytes(32);
  const sessionKey = (id: string) =>
    createHmac("sha256", key)
      .update(`nest-session-messaging\0${options.provider}\0${id}`)
      .digest("hex");

  const admit = async (delivery: Delivery): Promise<Admission> => {
    if (delivery.target.provider !== options.provider) throw new Error("Wrong Nest application");
    const requestedId = delivery.target.threadId;
    const id = options.resolveThreadId?.(requestedId) ?? requestedId;
    if (delivery.source.provider === options.provider && delivery.source.threadId === id)
      throw new Error("Choose another session");
    requireSession(options, id);
    await options.enqueue(id, deliveryInput(delivery), delivery.messageId);
    return {
      status: "queued",
      messageId: delivery.messageId,
      session: reference(delivery.target),
    };
  };

  if (directory) {
    const peer = createServer((req, res) => {
      void (async () => {
        if (req.method !== "POST" || req.url !== "/") {
          res.writeHead(405).end();
          return;
        }
        res.setHeader("Content-Type", "application/json");
        try {
          const body = object(await readJson(req));
          if (typeof body.messageId !== "string" || !messageIdPattern.test(body.messageId))
            throw new Error("Invalid Nest message identity");
          const result = await admit({
            source: address(body.source),
            target: address(body.target),
            message: messageText(body.message),
            requestReply: body.requestReply === true,
            messageId: body.messageId,
          });
          res.writeHead(202).end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(409).end(JSON.stringify({ error: publicError(error) }));
        }
      })();
    });
    app.addHook("onListen", async () => {
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const info = await lstat(directory);
        if (!info.isDirectory() || info.uid !== process.getuid?.() || info.mode & 0o077)
          throw new Error("Nest session messaging directory must be private");
        await listen(peer, join(directory, `${options.provider}.sock`));
        connectedDirectory = directory;
        peer.on("error", (error) => app.log.warn({ err: error }, "Session messaging socket error"));
      } catch (error) {
        app.log.warn({ err: error }, "Cross-application session messaging is unavailable");
      }
    });
    app.addHook("onClose", async () => {
      connectedDirectory = undefined;
      if (!peer.listening) return;
      await new Promise<void>((resolve) => {
        peer.close(() => resolve());
        peer.closeAllConnections();
      });
    });
  }

  const send = async (
    sourceId: string,
    value: unknown,
    callId: string | number,
    turnId?: string,
  ): Promise<Admission> => {
    if (!isSessionThreadId(sourceId)) throw new Error("Invalid sending session ID");
    const thread = requireSession(options, sourceId);
    const args = object(value);
    const target = parseReference(args.session, options.provider);
    if (args.requestReply !== undefined && typeof args.requestReply !== "boolean")
      throw new Error("requestReply must be a boolean");
    const message = messageText(args.message);
    const source = { provider: options.provider, threadId: sourceId };
    const requestReply = args.requestReply === true;
    const identity = createHash("sha256")
      .update(
        JSON.stringify([
          source,
          turnId ?? thread.currentTurnId,
          callId,
          target,
          message,
          requestReply,
        ]),
      )
      .digest("hex");
    const delivery = {
      source,
      target,
      message,
      requestReply,
      messageId: `${SESSION_MESSAGE_ID_PREFIX}${identity}`,
    };
    return target.provider === options.provider
      ? admit(delivery)
      : sendToPeer(connectedDirectory, delivery);
  };

  app.post<{ Params: { id: string } }>(
    `${SESSION_MCP_PATH}:id`,
    { bodyLimit: maxPayloadBytes },
    async (req, reply) => {
      const id = req.params.id;
      const token = /^Bearer ([\da-f]{64})$/.exec(req.headers.authorization ?? "")?.[1];
      const local = !req.socket.remoteAddress || loopback.has(req.socket.remoteAddress);
      if (
        !local ||
        !isSessionThreadId(id) ||
        !token ||
        !timingSafeEqual(Buffer.from(token), Buffer.from(sessionKey(id)))
      )
        return reply.code(403).send();
      reply.header("Cache-Control", "no-store");
      const message = object(req.body);
      const requestId =
        typeof message.id === "number" || typeof message.id === "string" ? message.id : null;
      const result = (value: unknown) => ({ jsonrpc: "2.0", id: requestId, result: value });
      const error = (code: number, message: string) => ({
        jsonrpc: "2.0",
        id: requestId,
        error: { code, message },
      });
      if (message.jsonrpc !== "2.0" || typeof message.method !== "string")
        return error(-32600, "Invalid Request");
      if (requestId === null) return reply.code(202).send();
      switch (message.method) {
        case "initialize": {
          const requested = object(message.params).protocolVersion;
          return result({
            protocolVersion: typeof requested === "string" ? requested : "2025-03-26",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SESSION_MCP_NAME, version: "1.0.0" },
          });
        }
        case "ping":
          return result({});
        case "tools/list": {
          const artifact = options.artifactTool;
          return result({
            tools: [
              SESSION_SEND_TOOL,
              ...(artifact && (await artifact.available(id)) ? [artifact.definition] : []),
            ],
          });
        }
        case "tools/call": {
          const params = object(message.params);
          const artifact = options.artifactTool;
          try {
            let receipt: unknown;
            if (params.name === SESSION_SEND_TOOL.name)
              receipt = await send(id, params.arguments, requestId);
            else if (artifact && params.name === artifact.definition.name) {
              requireSession(options, id);
              receipt = await artifact.publish(id, params.arguments, params._meta);
            } else return error(-32602, "Unknown tool");
            return result({ content: [{ type: "text", text: JSON.stringify(receipt) }] });
          } catch (error) {
            return result({ isError: true, content: [{ type: "text", text: publicError(error) }] });
          }
        }
        default:
          return error(-32601, "Method not found");
      }
    },
  );

  return {
    send,
    mcp(threadId: string) {
      const address = app.addresses().find((address) => typeof address === "object");
      return {
        url: `http://127.0.0.1:${address?.port ?? options.port}${SESSION_MCP_PATH}${encodeURIComponent(threadId)}`,
        headers: { Authorization: `Bearer ${sessionKey(threadId)}` },
      };
    },
  };
}
