import { access } from "node:fs/promises";
import { resolve } from "node:path";

import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { LogController, type FastifyInstance } from "fastify";

import { BROWSER_EXTENSION_ORIGIN, BROWSER_MAX_WEBSOCKET_MESSAGE_BYTES } from "@codexnest/protocol";

import { registerApi, type ApiServices } from "./api";
import { BrowserExtensionServer } from "./browser-extension";
import type { AppConfig } from "./config";
import { isAllowedRequestOrigin } from "./origin";
import { registerEventsWebSocket } from "./websocket";

export async function buildApp(config: AppConfig, services: ApiServices): Promise<FastifyInstance> {
  const allowedOrigins = new Set([...config.allowedOrigins, BROWSER_EXTENSION_ORIGIN]);
  const app = Fastify({
    logger: {
      level: process.env.CODEXNEST_LOG_LEVEL ?? "info",
      redact: {
        paths: [
          "req.headers.authorization",
          "headers.authorization",
          "req.headers.x-codexnest-restart-token",
          "headers.x-codexnest-restart-token",
          "req.headers.x-codexnest-browser-secret",
          "headers.x-codexnest-browser-secret",
          "req.body.params.arguments",
          "body.params.arguments",
          "arguments",
          "result",
          "token",
          "input",
          "images",
          "output",
          "prompt",
          "proxy",
          "req.body.proxy",
          "body.proxy",
          "openAiApiKey",
          "req.body.openAiApiKey",
          "body.openAiApiKey",
        ],
        censor: "[redacted]",
      },
    },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1_048_576,
    forceCloseConnections: true,
  });

  await app.register(cors, {
    origin(origin, callback) {
      callback(null, !origin || allowedOrigins.has(origin));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type", "x-codexnest-audio-duration-ms"],
  });
  await app.register(websocket, {
    options: { maxPayload: BROWSER_MAX_WEBSOCKET_MESSAGE_BYTES },
    preClose(done) {
      for (const client of this.websocketServer.clients) client.terminate();
      this.websocketServer.close(() => done());
    },
  });

  app.addContentTypeParser("application/octet-stream", (request, payload, done) => {
    done(null, payload);
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!isAllowedRequestOrigin(request, allowedOrigins)) {
      return reply
        .code(403)
        .send({ error: { code: "unauthorized", message: "Origin not allowed" } });
    }
  });

  // Framing stays forbidden unless the owner lists the sites that embed the floating window.
  const frameAncestors = config.embedOrigins.length
    ? `'self' ${config.embedOrigins.join(" ")}`
    : "'none'";
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    // Sandboxed srcDoc previews inherit this policy and need the report's inline CSS.
    reply.header(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' http: https: ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors ${frameAncestors}`,
    );
    return payload;
  });

  const browserExtension = new BrowserExtensionServer({
    app,
    store: services.store,
    projection: services.projection,
    allowedOrigins,
    port: config.port,
    authTimeoutMs: config.websocketAuthTimeoutMs,
  });
  registerApi(app, { ...services, browserExtension });
  browserExtension.registerRoutes();
  registerEventsWebSocket(
    app,
    services.projection,
    services.store,
    allowedOrigins,
    config.websocketAuthTimeoutMs,
  );

  if (await directoryExists(config.clientDist)) {
    await app.register(fastifyStatic, {
      root: config.clientDist,
      prefix: "/",
      wildcard: false,
      setHeaders(response, path) {
        if (path.endsWith("index.html")) response.header("Cache-Control", "no-cache");
      },
    });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: { code: "not_found", message: "Route not found" } });
      }
      return reply.type("text/html").sendFile("index.html", resolve(config.clientDist));
    });
  }

  return app;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
