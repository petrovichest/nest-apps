import { createServer, request } from "node:http";
import { connect, type Socket } from "node:net";

/** Restarting this public listener never closes the ACP owner or its pending decisions. */
export function createGateway(socketPath: string) {
  const server = createServer((req, res) => {
    const upstream = request(
      { socketPath, path: req.url, method: req.method, headers: req.headers },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
        response.once("error", () => res.destroy());
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(503, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { code: "app_server_unavailable", message: "GeminiNest daemon is unavailable" },
        }),
      );
    });
    req.on("aborted", () => upstream.destroy());
    req.pipe(upstream);
  });
  const sockets = new Set<Socket>();
  server.on("upgrade", (req, socket, head) => {
    const upstream = connect(socketPath);
    sockets.add(upstream);
    upstream.once("connect", () => {
      const headers = req.rawHeaders.reduce((lines: string[], value, i) => {
        if (i % 2 === 0) lines.push(`${value}: ${req.rawHeaders[i + 1]}`);
        return lines;
      }, []);
      upstream.write(
        `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers.join("\r\n")}\r\n\r\n`,
      );
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.once("error", () => socket.destroy());
    upstream.once("close", () => socket.destroy());
    socket.once("error", () => upstream.destroy());
    socket.once("close", () => {
      upstream.destroy();
      sockets.delete(upstream);
    });
  });
  return {
    server,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
