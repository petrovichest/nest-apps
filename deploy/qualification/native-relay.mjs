import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { rename, unlink } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire("/opt/qualification/package.json");
const WebSocket = require("ws");

// A transparent fault-injection transport. Every RPC result comes from the
// actual native daemon. Never synthesize RPC, readiness or systemctl responses.
export class NativeRelay {
  constructor(socketPath, metrics) {
    this.path = socketPath;
    this.upstream = `${socketPath}.qualification-native`;
    this.metrics = metrics;
    this.sockets = new Set();
    this.httpSockets = new Set();
    this.delayed = new Set();
    this.unavailableUntil = 0;
    this.holdUntil = 0;
    this.server = createServer((incoming, outgoing) => {
      const upstream = request(
        {
          socketPath: this.upstream,
          path: incoming.url,
          method: incoming.method,
          headers: incoming.headers,
        },
        (response) => {
          outgoing.writeHead(response.statusCode, response.headers);
          response.pipe(outgoing);
        },
      );
      upstream.on("error", () => {
        if (!outgoing.headersSent) outgoing.writeHead(503);
        outgoing.end();
      });
      incoming.pipe(upstream);
    });
    this.websocket = new WebSocket.WebSocketServer({ noServer: true, perMessageDeflate: false });
    this.server.on("connection", (socket) => {
      this.httpSockets.add(socket);
      socket.once("close", () => this.httpSockets.delete(socket));
    });
    this.server.on("upgrade", (incoming, socket, head) => {
      if (Date.now() < this.unavailableUntil) {
        socket.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      this.websocket.handleUpgrade(incoming, socket, head, (downstream) =>
        this.connect(downstream),
      );
    });
  }

  static async open(path, metrics) {
    const relay = new NativeRelay(path, metrics);
    await rename(relay.path, relay.upstream);
    try {
      await new Promise((resolve, reject) => {
        relay.server.once("error", reject);
        relay.server.listen(relay.path, resolve);
      });
    } catch (error) {
      await rename(relay.upstream, relay.path);
      throw error;
    }
    return relay;
  }

  connect(downstream) {
    const upstream = new WebSocket(`ws+unix://${this.upstream}:/`, { perMessageDeflate: false });
    const pending = new Map();
    const queued = [];
    let client = "unknown";
    this.sockets.add(downstream);
    this.sockets.add(upstream);
    const send = (target, data, binary) => {
      if (target.readyState === WebSocket.OPEN) target.send(data, { binary });
    };
    upstream.on("open", () => {
      for (const [data, binary] of queued.splice(0)) send(upstream, data, binary);
    });
    downstream.on("message", (data, binary) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.method === "initialize") client = message.params?.clientInfo?.name ?? "unknown";
        if (message.method && Object.hasOwn(message, "id")) {
          const key = `${client}:${message.method}`;
          this.metrics[key] ??= { requests: 0, maxNativeResponseMs: 0, delayedResponses: 0 };
          this.metrics[key].requests++;
          pending.set(message.id, { key, method: message.method, started: Date.now() });
        }
      } catch {
        /* Plain forwarding does not depend on decoding a notification. */
      }
      if (upstream.readyState === WebSocket.CONNECTING) queued.push([data, binary]);
      else send(upstream, data, binary);
    });
    upstream.on("message", (data, binary) => {
      let observed;
      try {
        const message = JSON.parse(data.toString());
        if (!message.method) {
          observed = pending.get(message.id);
          pending.delete(message.id);
        }
      } catch {
        /* The native peer/client retain responsibility for protocol errors. */
      }
      if (observed) {
        const metric = this.metrics[observed.key];
        metric.maxNativeResponseMs = Math.max(
          metric.maxNativeResponseMs,
          Date.now() - observed.started,
        );
        if (observed.method === this.heldMethod && this.armedDuration) {
          const duration = this.armedDuration;
          this.armedDuration = 0;
          this.holdUntil = Date.now() + duration;
          this.holdTimer = setTimeout(() => this.release(), duration);
        }
        if (observed.method === this.heldMethod && Date.now() < this.holdUntil) {
          metric.delayedResponses++;
          this.delayed.add(() => send(downstream, data, binary));
          return;
        }
      }
      send(downstream, data, binary);
    });
    const close = () => {
      this.sockets.delete(upstream);
      this.sockets.delete(downstream);
      upstream.terminate();
      downstream.terminate();
    };
    upstream.on("error", close);
    downstream.on("error", close);
    upstream.on("close", close);
    downstream.on("close", close);
  }

  hold(method, durationMs, onNextReply = false) {
    assert.ok(["model/list", "thread/list", "thread/loaded/list"].includes(method));
    assert.ok(durationMs > 0 && durationMs <= 150_000);
    this.release();
    this.heldMethod = method;
    if (onNextReply) this.armedDuration = durationMs;
    else {
      this.holdUntil = Date.now() + durationMs;
      this.holdTimer = setTimeout(() => this.release(), durationMs);
    }
  }

  release() {
    clearTimeout(this.holdTimer);
    this.holdUntil = 0;
    this.armedDuration = 0;
    for (const send of this.delayed) send();
    this.delayed.clear();
  }

  disconnect(durationMs) {
    assert.ok(durationMs > 0 && durationMs <= 30_000);
    this.unavailableUntil = Date.now() + durationMs;
    for (const socket of this.sockets) socket.terminate();
  }

  async close() {
    this.release();
    for (const socket of this.sockets) socket.terminate();
    for (const socket of this.httpSockets) socket.destroy();
    await new Promise((resolve) => this.server.close(resolve));
    await unlink(this.path).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rename(this.upstream, this.path);
  }
}
