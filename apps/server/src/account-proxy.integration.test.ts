import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createTlsServer } from "node:https";
import {
  connect,
  createServer as createTcpServer,
  type Server as TcpServer,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseClaudeProxy } from "@codexnest/protocol";
import { createAccountProxyConnection } from "./account-proxy";
import { WebSocketServer } from "ws";
import {
  AccountRuntimePool,
  DetachedAccountRuntimeLauncher,
  readPrivateJson,
  type AccountRuntimeDescriptor,
  type AccountRuntimeState,
} from "./account-runtime";
import { fileURLToPath } from "node:url";

const binary = process.env.CODEXNEST_ACCOUNT_CODEX_BIN;
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

describe.skipIf(!binary)("native account proxy routing", () => {
  it.each(["http", "https", "socks5"] as const)(
    "%s: native TLS and WSS stay on the account proxy after API reconnect and proxy failure",
    async (protocol) => {
      const root = await mkdtemp(join(tmpdir(), "nest-proxy-native-"));
      await mkdir(join(root, "home"));
      cleanup.push(async () => {
        const { readdir } = await import("node:fs/promises");
        for (const entry of await readdir(join(root, "account-runtimes")).catch(() => [])) {
          const log = await readFile(
            join(root, "account-runtimes", entry, "worker.log"),
            "utf8",
          ).catch(() => "");
          if (log) process.stderr.write(log);
        }
        await rm(root, { recursive: true, force: true });
      });
      const key = join(root, "key.pem"),
        cert = join(root, "cert.pem"),
        ca = join(root, "ca.pem");
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          join(root, "ca-key.pem"),
          "-out",
          ca,
          "-days",
          "1",
          "-subj",
          "/CN=Nest fixture CA",
        ],
        { stdio: "ignore", env: { PATH: process.env.PATH } },
      );
      execFileSync(
        "openssl",
        [
          "req",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          key,
          "-out",
          join(root, "request.csr"),
          "-subj",
          "/CN=127.0.0.2",
        ],
        { stdio: "ignore", env: { PATH: process.env.PATH } },
      );
      await writeFile(
        join(root, "extensions"),
        "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.2,IP:127.0.0.1,DNS:nest-proxy.invalid\n",
      );
      execFileSync(
        "openssl",
        [
          "x509",
          "-req",
          "-in",
          join(root, "request.csr"),
          "-CA",
          ca,
          "-CAkey",
          join(root, "ca-key.pem"),
          "-CAcreateserial",
          "-out",
          cert,
          "-days",
          "1",
          "-extfile",
          join(root, "extensions"),
        ],
        { stdio: "ignore", env: { PATH: process.env.PATH } },
      );
      const proxiedPorts = new Set<number>();
      const routes = new Map<number, string>();
      const requests: Array<{ route: string; body: string }> = [];
      let releaseResponse: (() => void) | undefined;
      let holdResponse = false;
      let directRequests = 0,
        proxiedRequests = 0,
        tunnels = 0,
        websocketMessages = 0;

      const backend = createTlsServer(
        { key: await readFile(key), cert: await readFile(cert) },
        async (request, response) => {
          let body = "";
          for await (const chunk of request) body += chunk.toString();
          requests.push({ route: routes.get(request.socket.remotePort!) ?? "direct", body });
          if (proxiedPorts.has(request.socket.remotePort!)) proxiedRequests++;
          else directRequests++;
          if (!request.url?.endsWith("/responses")) {
            response.writeHead(404).end();
            return;
          }
          const events = modelEvents();
          response.writeHead(200, { "content-type": "text/event-stream" });
          if (holdResponse)
            await new Promise<void>((resolve) => {
              releaseResponse = resolve;
            });
          response.end(
            events
              .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
              .join(""),
          );
        },
      );
      function modelEvents() {
        const item = {
          id: "assistant",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "PROXY_ACK", annotations: [] }],
        };
        return [
          { type: "response.created", response: { id: "r" } },
          { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
          {
            type: "response.output_text.delta",
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            delta: "PROXY_ACK",
          },
          { type: "response.output_item.done", output_index: 0, item },
          {
            type: "response.completed",
            response: {
              id: "r",
              status: "completed",
              output: [item],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          },
        ];
      }
      const websockets = new WebSocketServer({ server: backend });
      websockets.on("connection", (socket, request) => {
        socket.on("message", async (body) => {
          websocketMessages++;
          const route = routes.get(request.socket.remotePort!) ?? "direct";
          requests.push({ route, body: body.toString() });
          if (proxiedPorts.has(request.socket.remotePort!)) proxiedRequests++;
          else directRequests++;
          if (holdResponse)
            await new Promise<void>((resolve) => {
              releaseResponse = resolve;
            });
          for (const event of modelEvents()) socket.send(JSON.stringify(event));
        });
      });
      cleanup.push(async () => {
        for (const socket of websockets.clients) socket.terminate();
        await new Promise<void>((resolve) => websockets.close(() => resolve()));
      });
      await listen(backend, "127.0.0.2");
      cleanup.push(() => stop(backend));
      const target = `127.0.0.2:${port(backend)}`;
      const sockets = new Set<Socket>();
      const socksDestinations: string[] = [];
      const tlsErrors: string[] = [];
      backend.on("tlsClientError", (error) => tlsErrors.push(error.message));
      let available = true;
      const makeProxy = async (name: string) => {
        if (protocol === "socks5") {
          const server = createTcpServer((client) => {
            sockets.add(client);
            let stage = 0,
              buffer = Buffer.alloc(0);
            const consume = (chunk: Buffer) => {
              buffer = Buffer.concat([buffer, chunk]);
              if (stage === 0) {
                if (buffer.length < 2 || buffer.length < 2 + buffer[1]!) return;
                buffer = buffer.subarray(2 + buffer[1]!);
                client.write(Buffer.from([5, 2]));
                stage = 1;
              }
              if (stage === 1) {
                if (buffer.length < 2 || buffer.length < 3 + buffer[1]!) return;
                const length = buffer[1]!,
                  passwordLength = buffer[2 + length]!;
                if (buffer.length < 3 + length + passwordLength) return;
                const user = buffer.subarray(2, 2 + length).toString(),
                  password = buffer.subarray(3 + length, 3 + length + passwordLength).toString();
                if (!available || user !== "user" || password !== "password") {
                  client.end(Buffer.from([1, 1]));
                  return;
                }
                buffer = buffer.subarray(3 + length + passwordLength);
                client.write(Buffer.from([1, 0]));
                stage = 2;
              }
              if (stage === 2) {
                if (buffer.length < 5) return;
                const size = buffer[3] === 1 ? 4 : buffer[3] === 3 ? 1 + buffer[4]! : 16;
                if (buffer.length < 6 + size) return;
                const host =
                  buffer[3] === 1
                    ? Array.from(buffer.subarray(4, 8)).join(".")
                    : buffer[3] === 3
                      ? buffer.subarray(5, 5 + buffer[4]!).toString()
                      : "";
                const targetPort = buffer.readUInt16BE(4 + size);
                socksDestinations.push(host);
                if (
                  !["127.0.0.2", "nest-proxy.invalid"].includes(host) ||
                  targetPort !== port(backend)
                ) {
                  client.destroy();
                  return;
                }
                const rest = buffer.subarray(6 + size);
                client.off("data", consume);
                stage = 3;
                tunnels++;
                const upstream = connect(targetPort, "127.0.0.2");
                sockets.add(upstream);
                upstream.on("error", () => client.destroy());
                client.on("error", () => upstream.destroy());
                upstream.once("connect", () => {
                  proxiedPorts.add(upstream.localPort!);
                  routes.set(upstream.localPort!, name);
                  client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
                  if (rest.length) upstream.write(rest);
                  client.pipe(upstream);
                  upstream.pipe(client);
                });
              }
            };
            client.on("data", consume);
            client.on("error", () => undefined);
          });
          await listen(server);
          cleanup.push(async () => {
            for (const socket of sockets) socket.destroy();
            await stop(server);
          });
          return server;
        }
        const handler = (_request: IncomingMessage, response: ServerResponse) =>
          response.writeHead(400).end();
        const proxy =
          protocol === "https"
            ? createTlsServer({ key: await readFile(key), cert: await readFile(cert) }, handler)
            : createServer(handler);
        proxy.on("connect", (request, client, head) => {
          sockets.add(client as Socket);
          if (
            !available ||
            request.headers["proxy-authorization"] !==
              `Basic ${Buffer.from("user:password").toString("base64")}`
          ) {
            client.end("HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n");
            return;
          }
          if (request.url !== target) {
            client.destroy();
            return;
          }
          tunnels++;
          const upstream = connect(port(backend), "127.0.0.2");
          sockets.add(upstream);
          upstream.on("error", () => client.destroy());
          client.on("error", () => upstream.destroy());
          upstream.once("connect", () => {
            proxiedPorts.add(upstream.localPort!);
            routes.set(upstream.localPort!, name);
            client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head.length) upstream.write(head);
            client.pipe(upstream);
            upstream.pipe(client);
          });
        });
        await listen(proxy);
        cleanup.push(async () => {
          for (const socket of sockets) socket.destroy();
          await stop(proxy);
        });
        return proxy;
      };
      const proxy = await makeProxy("A");
      const otherProxy = await makeProxy("B");
      const connection = await createAccountProxyConnection(
        parseClaudeProxy(`${protocol}://user:password@127.0.0.1:${port(proxy)}`),
        {
          PATH: process.env.PATH,
          NO_PROXY: "*",
          no_proxy: "*",
          HTTPS_PROXY: "http://wrong.invalid:1",
          CODEX_HOME: root,
          CODEX_CA_CERTIFICATE: ca,
          SSL_CERT_FILE: ca,
          NODE_EXTRA_CA_CERTS: ca,
          HOME: join(root, "home"),
          XDG_CONFIG_HOME: join(root, "home", ".config"),
          XDG_STATE_HOME: join(root, "home", ".state"),
        },
      );
      cleanup.push(() => connection.close());
      delete connection.env.OPENAI_API_KEY;
      delete connection.env.CODEX_API_KEY;
      const config: Record<string, unknown> = {
        model: "gpt-5.4",
        model_provider: "proxy_proof",
        "model_providers.proxy_proof.name": "Proxy proof",
        "model_providers.proxy_proof.base_url": `https://${target}/v1`,
        "model_providers.proxy_proof.wire_api": "responses",
        "model_providers.proxy_proof.requires_openai_auth": false,
        "model_providers.proxy_proof.supports_websockets": false,
        "model_providers.proxy_proof.request_max_retries": 0,
        "model_providers.proxy_proof.stream_max_retries": 0,
        "features.respect_system_proxy": true,
        "analytics.enabled": false,
      };
      const launcher = new DetachedAccountRuntimeLauncher();
      const descriptors: AccountRuntimeDescriptor[] = [];
      const options = {
        stateDir: root,
        historyHome: join(root, "history"),
        codexBin: binary!,
        envFile: join(root, "fixture.env"),
        socketRoot: join(root, "sockets"),
        descriptors,
        remember: async () => {},
        workerPath:
          process.env.CODEXNEST_ACCOUNT_WORKER ??
          fileURLToPath(new URL("./account-runtime-main.ts", import.meta.url)),
        launcher,
        nativeArgs: Object.entries(config).flatMap(([key, value]) => [
          "-c",
          `${key}=${JSON.stringify(value)}`,
        ]),
        environment: { ...connection.env, NODE_ENV: "test" },
      };
      let pool = new AccountRuntimePool(options);
      cleanup.push(async () => {
        releaseResponse?.();
        await pool.close();
        for (const descriptor of descriptors) await launcher.stop(descriptor);
      });
      const first = await pool.ensure({
        id: "A",
        native: false,
        home: join(root, "account-A"),
        proxy: parseClaudeProxy(`${protocol}://user:password@127.0.0.1:${port(proxy)}`),
      });
      const second = await pool.ensure({
        id: "B",
        native: false,
        home: join(root, "account-B"),
        proxy: parseClaudeProxy(`${protocol}://user:password@127.0.0.1:${port(otherProxy)}`),
      });
      let rpc = first.bridge;
      const completed: Array<(turn: any) => void> = [];
      let currentTurn: { threadId: string; turnId: string } | undefined;
      const observed: string[] = [];
      const attach = () =>
        rpc.on("notification", (notice) => {
          observed.push(notice.method);
          if (notice.method === "turn/started")
            currentTurn = { threadId: notice.params.threadId, turnId: notice.params.turn.id };
          if (notice.method === "error") {
            observed.push(
              String(notice.params.error?.message ?? notice.params.message).replace(
                /https?:\/\/[^\s/@]+:[^\s/@]+@/g,
                "http://[redacted]@",
              ),
            );
            // Native Codex keeps retrying a network failure. Bound this fixture with a real interrupt,
            // after observing the failure; it must not reach the directly accessible target meanwhile.
            if (!available && currentTurn)
              void rpc.request("turn/interrupt", currentTurn).catch(() => undefined);
          }
          if (notice.method === "turn/completed") completed.shift()?.(notice.params.turn);
        });
      attach();
      pool.on("request", (_descriptor, request, transport) => {
        observed.push(`request:${request.method}`);
        transport.respondError(request.id, -32601, "Unsupported fixture request");
      });
      const start = async (existingThread?: string) => {
        const { thread } = await rpc.request<any>(
          existingThread ? "thread/resume" : "thread/start",
          {
            ...(existingThread ? { threadId: existingThread } : {}),
            cwd: root,
            model: "gpt-5.4",
            approvalPolicy: "never",
            sandbox: "danger-full-access",
          },
        );
        const done = new Promise<any>((resolve) => completed.push(resolve));
        const result = await rpc.request<any>("turn/start", {
          threadId: thread.id,
          input: [{ type: "text", text: "Reply PROXY_ACK" }],
        });
        currentTurn = { threadId: thread.id, turnId: result.turn.id };
        let timer: NodeJS.Timeout;
        try {
          return await Promise.race([
            done,
            new Promise((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error(
                      JSON.stringify({
                        available,
                        directRequests,
                        proxiedRequests,
                        tunnels,
                        observed,
                        tlsErrors,
                      }),
                    ),
                  ),
                8_000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer!);
        }
      };
      expect((await start()).status).toBe("completed");
      expect(proxiedRequests).toBeGreaterThan(0);
      expect(tunnels).toBeGreaterThan(0);
      expect(directRequests).toBe(0);
      expect(requests.at(-1)?.route).toBe("A");
      const firstThread = currentTurn!.threadId;
      rpc = second.bridge;
      attach();
      expect((await start()).status).toBe("completed");
      expect(requests.at(-1)?.route).toBe("B");
      // Both account processes see the same native history without sharing auth or a model connection.
      expect(
        (await rpc.request<any>("thread/list", { limit: 100 })).data.map(
          (thread: any) => thread.id,
        ),
      ).toContain(firstThread);
      rpc = first.bridge;
      holdResponse = true;
      const pending = start(firstThread);
      while (!releaseResponse) await new Promise((resolve) => setTimeout(resolve, 20));
      const beforeRestart = await readPrivateJson<AccountRuntimeState>(
        join(first.descriptor.directory, "runtime.json"),
      );
      await pool.close();
      pool = new AccountRuntimePool(options);
      rpc = await pool.connect(first.descriptor.id);
      attach();
      expect(
        await readPrivateJson<AccountRuntimeState>(
          join(first.descriptor.directory, "runtime.json"),
        ),
      ).toEqual(beforeRestart);
      const resumed = await rpc.request<any>("thread/resume", { threadId: firstThread });
      expect(resumed.thread.id).toBe(firstThread);
      holdResponse = false;
      releaseResponse!();
      await pending;
      // Reconnect to the live native task and finish it without resending user input.
      expect(requests.at(-1)?.route).toBe("A");
      // Force a second context generation with WebSocket model transport, leaving the SSE owners intact.
      const sseRpc = rpc;
      config["model_providers.proxy_proof.supports_websockets"] = true;
      if (protocol === "socks5")
        config["model_providers.proxy_proof.base_url"] =
          `https://nest-proxy.invalid:${port(backend)}/v1`;
      const wsPool = new AccountRuntimePool({
        ...options,
        descriptors: [],
        nativeArgs: Object.entries(config).flatMap(([key, value]) => [
          "-c",
          `${key}=${JSON.stringify(value)}`,
        ]),
        stateDir: join(root, "wss-state"),
      });
      cleanup.push(async () => {
        await wsPool.close();
        for (const descriptor of wsPool.descriptors()) await launcher.stop(descriptor);
      });
      const wsAccount = await wsPool.ensure({
        id: "WSS",
        native: false,
        home: join(root, "account-WSS"),
        proxy: parseClaudeProxy(`${protocol}://user:password@127.0.0.1:${port(proxy)}`),
      });
      rpc = wsAccount.bridge;
      attach();
      expect((await start()).status).toBe("completed");
      expect(websocketMessages).toBeGreaterThan(0);
      if (protocol === "socks5") expect(socksDestinations).toContain("nest-proxy.invalid");
      const before = proxiedRequests;
      available = false;
      for (const socket of sockets) socket.destroy();
      expect(["failed", "interrupted"]).toContain((await start()).status);
      expect(proxiedRequests).toBe(before);
      expect(directRequests).toBe(0);
      // The HTTP transport still targets a directly reachable IP, including in the SOCKS case.
      rpc = sseRpc;
      expect(["failed", "interrupted"]).toContain((await start()).status);
      expect(directRequests).toBe(0);
      await stop(proxy); // Connection refusal, rather than an authentication rejection.
      expect(["failed", "interrupted"]).toContain((await start()).status);
      expect(directRequests).toBe(0);
    },
    60_000,
  );
});

async function listen(server: HttpServer | TcpServer, host = "127.0.0.1") {
  server.listen(0, host);
  await once(server, "listening");
}
function port(server: HttpServer | TcpServer) {
  return (server.address() as { port: number }).port;
}
async function stop(server: HttpServer | TcpServer) {
  if ("closeAllConnections" in server) server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
