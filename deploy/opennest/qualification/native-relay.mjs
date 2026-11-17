import { createServer, request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

/** Transparent native HTTP transport: every response is produced by real OpenCode. */
export class NativeRelay {
  sockets = new Set();
  holdUntil = 0;
  unavailableUntil = 0;
  requests = 0;
  delayed = [];
  constructor(controlToken) {
    this.controlToken = controlToken;
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
  }
  server = createServer(async (incoming, outgoing) => {
    if (incoming.method === "POST" && incoming.url === "/__qualification/hold") {
      if (incoming.headers.authorization !== `Bearer ${this.controlToken}`) {
        outgoing.writeHead(401).end();
        return;
      }
      this.holdUntil = Date.now() + 75000;
      outgoing
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ until: this.holdUntil }));
      return;
    }
    this.requests++;
    const target = this.holdUntil;
    if (Date.now() < target && incoming.method === "GET" && !incoming.url.includes("/event")) {
      this.delayed.push({ path: incoming.url, at: Date.now(), until: target });
      await delay(target - Date.now());
    }
    if (Date.now() < this.unavailableUntil) {
      outgoing.writeHead(503).end();
      return;
    }
    if (outgoing.destroyed) return;
    const upstream = request(
      {
        hostname: "127.0.0.1",
        port: 4097,
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
    outgoing.once("close", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  async listen() {
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(9053, "127.0.0.1", resolve);
    });
    return this;
  }
  async close() {
    for (const socket of this.sockets) socket.destroy();
    await new Promise((resolve) => this.server.close(resolve));
  }
}
