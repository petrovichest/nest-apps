import { randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { parseClaudeProxy } from "@codexnest/protocol";
import { CodexAccounts } from "./codex-accounts";
import { CodexBridge } from "./codex/bridge";
import { DetachedAccountRuntimeLauncher, type AccountRuntimeDescriptor } from "./account-runtime";
import { createAccountProxyConnection } from "./account-proxy";

const binary = process.env.CODEXNEST_ACCOUNT_CODEX_BIN;

it.skipIf(!binary)(
  "routes model, usage, refresh and device OAuth by account, preserving history through account handover",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "nest-account-native-"));
    const home = join(root, "home"),
      history = join(root, "native-history");
    await mkdir(home);
    await mkdir(history);
    const ids = [randomUUID(), randomUUID()];
    const requests: Array<{ route: string; path: string; body: string; auth?: string }> = [];
    const ports = new Map<number, string>();
    let failFirst = false;
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
      "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.2\n",
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
    const backend = createTlsServer(
      { key: await readFile(key), cert: await readFile(cert) },
      async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk.toString();
        const route = ports.get(request.socket.remotePort!) ?? "direct";
        requests.push({ route, path: request.url!, body, auth: request.headers.authorization });
        response.setHeader("content-type", "application/json");
        if (request.url?.includes("/wham/accounts/check")) {
          const claims = JSON.parse(
            Buffer.from(
              (request.headers.authorization ?? "").split(".")[1] ?? "e30",
              "base64url",
            ).toString(),
          );
          const id = claims["https://api.openai.com/auth"]?.chatgpt_account_id ?? "workspace-C";
          response.end(
            JSON.stringify({
              accounts: [
                {
                  id,
                  name: "Fixture",
                  structure: "personal",
                  can_access_with_session: true,
                  workspace_backend_origin: "NO_CONSTRAINT",
                  account_routing_override: "NO_CONSTRAINT",
                  plan_type: "plus",
                },
              ],
              account_ordering: [id],
              default_account_id: id,
            }),
          );
          return;
        }
        if (request.url?.includes("/deviceauth/usercode")) {
          response.end(
            JSON.stringify({
              device_auth_id: "fixture-device",
              user_code: "TEST-CODE",
              interval: "0",
            }),
          );
          return;
        }
        if (request.url?.includes("/deviceauth/token")) {
          response.end(
            JSON.stringify({
              authorization_code: "fixture-code",
              code_verifier: "fixture-verifier",
              code_challenge: "fixture-challenge",
            }),
          );
          return;
        }
        if (request.url === "/oauth/token") {
          const account = body.includes("refresh-B")
            ? "B"
            : body.includes("fixture-code")
              ? "C"
              : "A";
          response.end(
            JSON.stringify({
              access_token: jwt(account),
              id_token: jwt(account),
              refresh_token: `refresh-${account}-new`,
              token_type: "Bearer",
              expires_in: 3600,
            }),
          );
          return;
        }
        if (request.url?.includes("/usage")) {
          response.end(
            JSON.stringify({
              account_id: `workspace-${route}`,
              user_id: `user-${route}`,
              plan_type: "plus",
              rate_limit: {
                allowed: true,
                limit_reached: false,
                primary_window: {
                  used_percent: 10,
                  limit_window_seconds: 18000,
                  reset_after_seconds: 3600,
                  reset_at: Math.floor(Date.now() / 1000) + 3600,
                },
                secondary_window: {
                  used_percent: 20,
                  limit_window_seconds: 604800,
                  reset_after_seconds: 86400,
                  reset_at: Math.floor(Date.now() / 1000) + 86400,
                },
              },
            }),
          );
          return;
        }
        if (request.url?.endsWith("/responses")) {
          if (failFirst && route === "A") {
            response.writeHead(429);
            response.end(
              JSON.stringify({
                error: {
                  type: "usage_limit_reached",
                  plan_type: "plus",
                  resets_at: Math.floor(Date.now() / 1000) + 3600,
                },
              }),
            );
            return;
          }
          const item = {
            id: "assistant",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "ACCOUNT_OK", annotations: [] }],
          };
          const events = [
            { type: "response.created", response: { id: randomUUID() } },
            { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
            {
              type: "response.output_text.delta",
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              delta: "ACCOUNT_OK",
            },
            { type: "response.output_item.done", output_index: 0, item },
            {
              type: "response.completed",
              response: {
                id: randomUUID(),
                status: "completed",
                output: [item],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
            },
          ];
          response.setHeader("content-type", "text/event-stream");
          response.end(
            events
              .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
              .join(""),
          );
          return;
        }
        response.writeHead(404).end("{}");
      },
    );
    await listen(backend, "127.0.0.2");
    const base = `https://127.0.0.2:${port(backend)}`;
    const proxies: Server[] = [];
    const sockets = new Set<Socket>();
    for (const name of ["A", "B", "native"]) {
      const proxy = createServer((request, response) => {
        if (
          request.headers["proxy-authorization"] !==
          `Basic ${Buffer.from(`${name}:secret`).toString("base64")}`
        ) {
          response.writeHead(407).end();
          return;
        }
        const target = new URL(request.url!);
        if (target.origin !== base) {
          response.writeHead(502).end();
          return;
        }
        const headers = { ...request.headers };
        delete headers["proxy-authorization"];
        const outgoing = httpRequest(
          target,
          { method: request.method, headers, agent: false },
          (upstream) => {
            response.writeHead(upstream.statusCode!, upstream.headers);
            upstream.pipe(response);
          },
        );
        outgoing.on("socket", (socket) =>
          socket.once("connect", () => ports.set(socket.localPort!, name)),
        );
        outgoing.on("error", () => response.destroy());
        request.pipe(outgoing);
      });
      proxy.on("connect", (request, client, head) => {
        sockets.add(client as Socket);
        if (
          request.url !== `127.0.0.2:${port(backend)}` ||
          request.headers["proxy-authorization"] !==
            `Basic ${Buffer.from(`${name}:secret`).toString("base64")}`
        ) {
          client.end("HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n");
          return;
        }
        const outgoing = connect(port(backend), "127.0.0.2");
        sockets.add(outgoing);
        outgoing.on("error", () => client.destroy());
        client.on("error", () => outgoing.destroy());
        outgoing.once("connect", () => {
          ports.set(outgoing.localPort!, name);
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length) outgoing.write(head);
          client.pipe(outgoing);
          outgoing.pipe(client);
        });
      });
      await listen(proxy);
      proxies.push(proxy);
    }
    const accounts = ids.map((id, index) => ({
      id,
      identity: `workspace-${index ? "B" : "A"}:user-${index ? "B" : "A"}`,
      native: false,
      email: null,
      plan: null,
      authenticated: true,
      proxyConfigured: true,
      proxy: parseClaudeProxy(
        `http://${index ? "B" : "A"}:secret@127.0.0.1:${port(proxies[index]!)}`,
      ),
      rateLimits: { limits: null, updatedAt: null, refreshing: false, refreshError: false },
      connectionError: null,
    }));
    for (let index = 0; index < ids.length; index++) {
      const name = index ? "B" : "A";
      const directory = join(root, "codex-accounts", ids[index]!);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(
        join(directory, "auth.json"),
        JSON.stringify({
          auth_mode: "chatgpt",
          OPENAI_API_KEY: null,
          tokens: {
            id_token: jwt(name),
            access_token: jwt(name),
            refresh_token: `refresh-${name}`,
            account_id: `workspace-${name}`,
          },
          last_refresh: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
    }
    await writeFile(
      join(root, "codex-accounts.json"),
      JSON.stringify({
        version: 1,
        importedNative: true,
        currentAccountId: ids[0],
        accounts,
        autoSwitch: false,
      }),
      { mode: 0o600 },
    );
    const config: Record<string, unknown> = {
      model: "gpt-5.4",
      model_provider: "fixture",
      "model_providers.fixture.name": "Fixture",
      "model_providers.fixture.base_url": `${base}/v1`,
      "model_providers.fixture.wire_api": "responses",
      "model_providers.fixture.requires_openai_auth": true,
      "model_providers.fixture.supports_websockets": false,
      "model_providers.fixture.request_max_retries": 0,
      "model_providers.fixture.stream_max_retries": 0,
      chatgpt_base_url: `${base}/backend-api`,
      "analytics.enabled": false,
    };
    const args = Object.entries(config).flatMap(([key, value]) => [
      "-c",
      `${key}=${JSON.stringify(value)}`,
    ]);
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      CODEX_CA_CERTIFICATE: ca,
      SSL_CERT_FILE: ca,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_STATE_HOME: join(home, ".state"),
      CODEX_HOME: history,
      NO_PROXY: "*",
      no_proxy: "*",
      CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${base}/oauth/token`,
      CODEX_APP_SERVER_LOGIN_ISSUER: base,
    };
    delete environment.OPENAI_API_KEY;
    delete environment.CODEX_API_KEY;
    // The original shared daemon has its own configured route. Its unauthenticated
    // background discovery must also remain inside the fixture, distinct from A/B.
    const controllerConnection = await createAccountProxyConnection(
      parseClaudeProxy(`http://native:secret@127.0.0.1:${port(proxies[2]!)}`),
      environment,
    );
    let controller: ReturnType<typeof spawn> | undefined;
    const bridge = new CodexBridge({
      codexBin: binary!,
      checkVersion: async () => "fixture",
      spawnProcess: () => {
        const child = spawn(
          binary!,
          ["--enable", "respect_system_proxy", ...args, "app-server", "--listen", "stdio://"],
          {
            env: controllerConnection.env,
            stdio: ["pipe", "pipe", "pipe"],
            cwd: root,
            detached: true,
          },
        );
        controller = child;
        return child;
      },
    });
    const launcher = new DetachedAccountRuntimeLauncher();
    const managerOptions = {
      stateDir: root,
      codexHome: history,
      codexBin: binary!,
      proxyEnvFile: join(root, "absent.env"),
      activeTurnCount: () => 0,
      poll: false,
      runtime: {
        launcher,
        socketRoot: join(root, "sockets"),
        workerPath:
          process.env.CODEXNEST_ACCOUNT_WORKER ??
          fileURLToPath(new URL("./account-runtime-main.ts", import.meta.url)),
        nativeArgs: args,
        environment,
      },
    };
    let manager = new CodexAccounts(bridge, managerOptions);
    const turns: any[] = [];
    bridge.on("notification", (notice) => {
      if (notice.method === "turn/completed") turns.push(notice.params.turn);
    });
    bridge.on("request", (request, transport) =>
      transport.respondError(request.id, -32601, "Unsupported fixture request"),
    );
    const run = async (threadId: string, text: string) => {
      const before = turns.length;
      await bridge.request("turn/start", { threadId, input: [{ type: "text", text }] });
      await vi.waitFor(() => expect(turns.length).toBeGreaterThan(before), { timeout: 8000 });
      return turns.at(-1);
    };
    try {
      await bridge.start();
      await manager.initialize();
      await manager.restore();
      const { thread } = await bridge.request<any>("thread/start", {
        cwd: root,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
      expect((await run(thread.id, "Reply ACCOUNT_OK")).status).toBe("completed");
      expect(requests.filter((request) => request.path.endsWith("/responses")).at(-1)?.route).toBe(
        "A",
      );
      await manager.select(ids[1]!);
      const other = await bridge.request<any>("thread/start", {
        cwd: root,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
      expect((await run(other.thread.id, "Reply ACCOUNT_OK")).status).toBe("completed");
      expect(requests.filter((request) => request.path.endsWith("/responses")).at(-1)?.route).toBe(
        "B",
      );
      const authBeforeRestart = await bridge.requestNative("getAuthStatus", {
        includeToken: true,
        refreshToken: false,
      });
      const savedRuntimes = JSON.parse(await readFile(join(root, "codex-accounts.json"), "utf8"))
        .runtimes as AccountRuntimeDescriptor[];
      const beforeRestart = await Promise.all(
        savedRuntimes.map(
          async (runtime) =>
            JSON.parse(await readFile(join(runtime.directory, "runtime.json"), "utf8")).pid,
        ),
      );
      await manager.close();
      manager = new CodexAccounts(bridge, {
        ...managerOptions,
        runtime: { ...managerOptions.runtime, launcher: new DetachedAccountRuntimeLauncher() },
      });
      await manager.initialize();
      await manager.restore();
      expect(manager.status().currentAccountId).toBe(ids[1]);
      const loaded = await bridge.request<{ data: string[] }>("thread/loaded/list", { limit: 100 });
      expect(loaded.data).toEqual(expect.arrayContaining([thread.id, other.thread.id]));
      await bridge.request("thread/resume", { threadId: thread.id });
      expect((await run(thread.id, "Reply ACCOUNT_OK after reconnect")).status).toBe("completed");
      expect(requests.filter((request) => request.path.endsWith("/responses")).at(-1)?.route).toBe(
        "A",
      );
      expect(
        await bridge.requestNative("getAuthStatus", { includeToken: true, refreshToken: false }),
      ).toEqual(authBeforeRestart);
      expect(
        await Promise.all(
          savedRuntimes.map(
            async (runtime) =>
              JSON.parse(await readFile(join(runtime.directory, "runtime.json"), "utf8")).pid,
          ),
        ),
      ).toEqual(beforeRestart);
      await manager.refresh();
      expect(
        manager.status().accounts.map((account) => ({
          email: account.email,
          authenticated: account.authenticated,
          error: account.connectionError,
        })),
      ).toEqual([
        { email: "A@example.test", authenticated: true, error: null },
        { email: "B@example.test", authenticated: true, error: null },
      ]);
      expect(
        requests.some((request) => request.path.includes("/usage") && request.route === "A"),
      ).toBe(true);
      expect(
        requests.some((request) => request.path.includes("/usage") && request.route === "B"),
      ).toBe(true);
      await bridge.request("getAuthStatus", { includeToken: true, refreshToken: true });
      expect(
        requests.some((request) => request.path === "/oauth/token" && request.route === "B"),
      ).toBe(true);
      await manager.setAutoSwitch(true);
      failFirst = true;
      const failed = await run(thread.id, "Continue ACCOUNT_OK");
      expect(failed.status).toBe("failed");
      expect(manager.canRecover(failed)).toBe(true);
      expect(await manager.recover(thread.id, failed)).toBe(true);
      expect(
        (await run(thread.id, "Continue the unfinished task. Review existing results first."))
          .status,
      ).toBe("completed");
      const modelRequests = requests.filter((request) => request.path.endsWith("/responses"));
      expect(modelRequests.at(-1)?.route).toBe("B");
      expect(modelRequests.at(-1)?.body).toContain("Continue ACCOUNT_OK"); // shared native conversation, not a blank chat
      expect(requests.filter((request) => request.route === "direct")).toEqual([]);
      const login = await manager.startLogin({
        proxy: {
          enabled: true,
          protocol: "http",
          value: `http://B:secret@127.0.0.1:${port(proxies[1]!)}`,
        },
      });
      await vi.waitFor(
        () =>
          expect(
            manager.login(login.id).state,
            JSON.stringify(requests.map(({ route, path }) => ({ route, path }))),
          ).toBe("completed"),
        { timeout: 8000 },
      );
      expect(
        requests.some(
          (request) => request.path.includes("/deviceauth/usercode") && request.route === "B",
        ),
      ).toBe(true);
      expect(requests.filter((request) => request.route === "direct")).toEqual([]);
      expect(JSON.stringify(manager.status())).not.toContain("refresh-B");
      await manager.updateProxy(ids[0]!, {
        enabled: true,
        protocol: "http",
        value: `http://B:secret@127.0.0.1:${port(proxies[1]!)}`,
      });
      await bridge.request("thread/resume", { threadId: thread.id });
      expect((await run(thread.id, "Reply ACCOUNT_OK after proxy editing")).status).toBe(
        "completed",
      );
      expect(requests.filter((request) => request.path.endsWith("/responses")).at(-1)?.route).toBe(
        "B",
      );
      expect(requests.filter((request) => request.route === "direct")).toEqual([]);
    } finally {
      await manager.close();
      const controllerStopped =
        controller?.exitCode === null ? once(controller, "close") : Promise.resolve();
      bridge.stop();
      let killTimer: NodeJS.Timeout | undefined;
      if (controller?.pid) {
        const pid = controller.pid;
        terminateFixtureGroup(pid);
        killTimer = setTimeout(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            /* The isolated process group has exited. */
          }
        }, 2_000);
        killTimer.unref();
      }
      await controllerStopped;
      clearTimeout(killTimer);
      const descriptors = JSON.parse(await readFile(join(root, "codex-accounts.json"), "utf8"))
        .runtimes as AccountRuntimeDescriptor[];
      for (const descriptor of descriptors) await launcher.stop(descriptor);
      for (const socket of sockets) socket.destroy();
      await controllerConnection.close();
      for (const proxy of proxies) await stop(proxy);
      await stop(backend);
      await rm(root, { recursive: true, force: true });
    }
  },
  45000,
);
function jwt(name: string): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub: `user-${name}`, email: `${name}@example.test`, exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: `workspace-${name}`, chatgpt_user_id: `user-${name}`, chatgpt_plan_type: "plus" } })).toString("base64url")}.signature`;
}
function terminateFixtureGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
async function listen(server: Server, host = "127.0.0.1") {
  server.listen(0, host);
  await once(server, "listening");
}
function port(server: Server) {
  return (server.address() as { port: number }).port;
}
async function stop(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
