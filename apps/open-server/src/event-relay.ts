import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

export type RelayPart = {
  id: string;
  messageID: string;
  sessionID: string;
  type: "text" | "reasoning";
  text: string;
  parentID?: string;
  time?: { start?: number; end?: number };
};
export type RelayFrame =
  | {
      type: "snapshot";
      protocolVersion: 1;
      instanceId: string;
      revision: number;
      healthy: boolean;
      parts: RelayPart[];
    }
  | { type: "part"; instanceId: string; revision: number; part: RelayPart; complete: boolean }
  | {
      type: "delta";
      instanceId: string;
      revision: number;
      sessionID: string;
      messageID: string;
      partID: string;
      offset: number;
      delta: string;
    }
  | { type: "heartbeat" }
  | { type: "error" };
type NativeEvent = { type: string; properties: Record<string, any>; id?: string };
const MAX_FRAME_BYTES = 12 * 1024 * 1024;
export class EventRelayError extends Error {
  constructor() {
    super("Native streaming state is unavailable. Reconnect to restore a consistent snapshot.");
    this.name = "EventRelayError";
  }
}
function authorized(value: unknown, token: string) {
  if (typeof value !== "string") return false;
  const supplied = Buffer.from(value),
    expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/** Native-owner memory only: active text parts, never completed conversations. */
export class NativeEventRelay {
  readonly instanceId = randomUUID();
  private revision = 0;
  private healthy = true;
  private bytes = 0;
  private parts = new Map<string, { part: RelayPart; bytes: number; lastEventId?: string }>();
  private parents = new Map<string, { parentID: string; sessionID: string }>();
  private clients = new Set<ServerResponse>();
  private server = createServer((req, res) => {
    if (
      req.method !== "GET" ||
      req.url !== "/events" ||
      !authorized(req.headers.authorization, this.options.token)
    ) {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
    // Snapshot and listener registration are synchronous in the native event
    // loop. No delta can fall between them or be represented twice.
    this.clients.add(res);
    this.write(res, {
      type: "snapshot",
      protocolVersion: 1,
      instanceId: this.instanceId,
      revision: this.revision,
      healthy: this.healthy,
      parts: [...this.parts.values()].map((value) => value.part),
    });
    res.once("close", () => this.clients.delete(res));
  });
  private heartbeat = setInterval(() => this.broadcast({ type: "heartbeat" }), 10_000);
  constructor(
    private readonly options: {
      socketPath: string;
      token: string;
      maxBytes?: number;
      maxParts?: number;
    },
  ) {
    this.heartbeat.unref();
    if (
      !isAbsolute(options.socketPath) ||
      Buffer.byteLength(options.socketPath) > 100 ||
      options.token.length < 32
    )
      throw new EventRelayError();
  }
  async listen() {
    const directory = dirname(this.options.socketPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.mode & 0o077 || metadata.uid !== process.getuid?.())
      throw new EventRelayError();
    try {
      const socket = await lstat(this.options.socketPath);
      if (!socket.isSocket() || socket.uid !== process.getuid?.()) throw new EventRelayError();
      const live = await new Promise<boolean>((resolve) => {
        const client = connect(this.options.socketPath);
        const done = (value: boolean) => {
          client.destroy();
          resolve(value);
        };
        client.setTimeout(500, () => done(true));
        client.once("connect", () => done(true));
        client.once("error", () => done(false));
      });
      if (live) throw new EventRelayError();
      await unlink(this.options.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.socketPath, resolve);
    });
    await chmod(this.options.socketPath, 0o600);
    return this;
  }
  private write(client: ServerResponse, frame: RelayFrame) {
    if (client.destroyed) return;
    client.write(`${JSON.stringify(frame)}\n`);
    if (client.writableLength > MAX_FRAME_BYTES) client.destroy();
  }
  private broadcast(frame: RelayFrame) {
    for (const client of this.clients) this.write(client, frame);
  }
  private fail() {
    if (this.healthy) {
      this.healthy = false;
      this.broadcast({ type: "error" });
    }
  }
  private complete(id: string) {
    const value = this.parts.get(id);
    if (!value) return;
    this.parts.delete(id);
    this.bytes -= value.bytes;
    this.broadcast({
      type: "part",
      instanceId: this.instanceId,
      revision: ++this.revision,
      part: value.part,
      complete: true,
    });
  }
  capture(event: NativeEvent) {
    if (!this.healthy) return;
    const p = event.properties;
    if (event.type === "message.part.updated") {
      const part = p.part;
      if (
        !part ||
        !["text", "reasoning"].includes(part.type) ||
        typeof part.id !== "string" ||
        typeof part.messageID !== "string" ||
        typeof part.sessionID !== "string" ||
        typeof part.text !== "string"
      )
        return;
      const old = this.parts.get(part.id);
      const bytes = Buffer.byteLength(part.text);
      if (
        this.bytes - (old?.bytes ?? 0) + bytes > (this.options.maxBytes ?? 8 * 1024 * 1024) ||
        (!old && this.parts.size >= (this.options.maxParts ?? 256))
      ) {
        this.fail();
        return;
      }
      const canonical: RelayPart = {
        id: part.id,
        messageID: part.messageID,
        sessionID: part.sessionID,
        type: part.type,
        text: part.text,
        ...(this.parents.has(part.messageID)
          ? { parentID: this.parents.get(part.messageID)!.parentID }
          : {}),
        ...(part.time ? { time: { ...part.time } } : {}),
      };
      this.parts.set(part.id, { part: canonical, bytes, lastEventId: event.id });
      this.bytes += bytes - (old?.bytes ?? 0);
      if (typeof part.time?.end === "number") this.complete(part.id);
      else
        this.broadcast({
          type: "part",
          instanceId: this.instanceId,
          revision: ++this.revision,
          part: canonical,
          complete: false,
        });
    } else if (
      event.type === "message.part.delta" &&
      p.field === "text" &&
      typeof p.delta === "string"
    ) {
      const value = this.parts.get(p.partID);
      if (!value) {
        this.fail();
        return;
      }
      if (event.id && value.lastEventId === event.id) return;
      const bytes = Buffer.byteLength(p.delta);
      if (this.bytes + bytes > (this.options.maxBytes ?? 8 * 1024 * 1024)) {
        this.fail();
        return;
      }
      const offset = value.part.text.length;
      value.part.text += p.delta;
      value.bytes += bytes;
      value.lastEventId = event.id;
      this.bytes += bytes;
      this.broadcast({
        type: "delta",
        instanceId: this.instanceId,
        revision: ++this.revision,
        sessionID: value.part.sessionID,
        messageID: value.part.messageID,
        partID: value.part.id,
        offset,
        delta: p.delta,
      });
    } else if (event.type === "message.updated") {
      if (
        p.info?.role === "assistant" &&
        typeof p.info.id === "string" &&
        typeof p.info.parentID === "string"
      ) {
        if (!p.info.time?.completed && this.parents.size >= 1024 && !this.parents.has(p.info.id)) {
          this.fail();
          return;
        }
        this.parents.set(p.info.id, {
          parentID: p.info.parentID,
          sessionID: String(p.info.sessionID ?? ""),
        });
      }
      if (p.info?.time?.completed) {
        for (const [id, value] of this.parts)
          if (value.part.messageID === p.info.id) this.complete(id);
        this.parents.delete(p.info.id);
      }
    } else if (event.type === "session.idle" || event.type === "session.error") {
      for (const [id, value] of this.parts)
        if (value.part.sessionID === p.sessionID) this.complete(id);
      for (const [id, value] of this.parents)
        if (value.sessionID === p.sessionID) this.parents.delete(id);
    }
  }
  async close() {
    clearInterval(this.heartbeat);
    for (const client of this.clients) client.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

const singletonKey = Symbol.for("opennest.native.active-text-relay");
export function nativeEventRelay(options: {
  socketPath: string;
  token: string;
}): Promise<NativeEventRelay> {
  const global = globalThis as typeof globalThis & { [singletonKey]?: Promise<NativeEventRelay> };
  return (global[singletonKey] ??= new NativeEventRelay(options).listen());
}

/** One authenticated persistent local socket, not an HTTP request per token. */
export async function* relayEvents(
  socketPath: string,
  token: string,
  signal: AbortSignal,
): AsyncGenerator<RelayFrame> {
  const req = request({
    socketPath,
    path: "/events",
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
    signal,
  });
  let response: IncomingMessage | undefined;
  try {
    response = await new Promise((resolve, reject) => {
      req.once("response", resolve);
      req.once("error", reject);
      req.setTimeout(15_000, () => req.destroy(new EventRelayError()));
      req.end();
    });
    if (response!.statusCode !== 200) throw new EventRelayError();
    response!.setTimeout(30_000, () => req.destroy(new EventRelayError()));
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of response!) {
      buffer += decoder.decode(chunk, { stream: true });
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) throw new EventRelayError();
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        let frame: RelayFrame;
        try {
          frame = JSON.parse(line) as RelayFrame;
        } catch {
          throw new EventRelayError();
        }
        if (!frame || !["snapshot", "part", "delta", "heartbeat", "error"].includes(frame.type))
          throw new EventRelayError();
        yield frame;
      }
    }
    if (!signal.aborted) throw new EventRelayError();
  } catch {
    throw new EventRelayError();
  } finally {
    req.destroy();
    response?.destroy();
  }
}
