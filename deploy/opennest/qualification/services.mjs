/** Controlled external model/registry/proxy for the real isolated native runtime. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as httpServer, request as httpRequest } from "node:http";
import { createServer as httpsServer, request as httpsRequest } from "node:https";
import { connect } from "node:net";
import { createReadStream } from "node:fs";
import { readFile, realpath, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const fixtureMarker = "OpenNest synthetic qualification fixture v1\n";
const text = (value) =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n")
      : "";
function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}
async function body(request, maximum) {
  let value = "";
  for await (const chunk of request) {
    value += chunk;
    if (Buffer.byteLength(value) > maximum)
      throw new Error("Fixture request exceeded its fixed body budget");
  }
  return value ? JSON.parse(value) : {};
}
function inside(root, path) {
  const nested = relative(root, path);
  return nested === "" || (!isAbsolute(nested) && nested !== ".." && !nested.startsWith("../"));
}
function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function createQualificationServices(options) {
  const fixtureHome = await realpath(options.home || "/home/opennest-qualification");
  assert.equal(await readFile(join(fixtureHome, ".opennest-qualification"), "utf8"), fixtureMarker);
  const privateDirectory = await realpath(
    options.privateDirectory || "/opennest-qualification-private",
  );
  const inputDirectory = await realpath(options.inputDirectory || "/opennest-qualification-input");
  const tls = {
    cert: await readFile(options.cert || join(privateDirectory, "fixture-cert.pem")),
    key: await readFile(options.key || join(privateDirectory, "fixture-key.pem")),
  };
  const auth =
    options.proxyAuthorization ||
    `Basic ${Buffer.from("fixture-user:fixture-proxy-password").toString("base64")}`;
  const state = {
    requests: {},
    auxiliaryRequests: 0,
    directModelRequests: 0,
    unexpectedExternalRequests: 0,
    proxiedModelRequests: 0,
    failedAuthRequests: 0,
    authUsed: {},
    proxyConnections: 0,
    proxyDenied: 0,
    publicRegistryConnections: 0,
    registryRequests: {},
    gitRequests: 0,
    gitFailures: 0,
    proxyDown: false,
    authFailure: false,
    authKey: "fixture-openrouter-key-1",
    manifest: null,
    files: {},
  };
  const acceptedAuthKeys = new Set([state.authKey]);
  const released = new Set(),
    held = new Map(),
    heldReleases = new WeakMap(),
    sockets = new Set(),
    proxiedOrigins = new Set();
  const servers = [];
  let modelPort, registryPort;
  const capture = (server) => {
    servers.push(server);
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    return server;
  };
  function fragment(response, marker, delta, finish = null) {
    if (response.destroyed || response.writableEnded) return;
    response.write(
      `data: ${JSON.stringify({ id: `qualification-${marker}`, object: "chat.completion.chunk", created: 1, model: "qualification/fixture", choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) })}\n\n`,
    );
  }
  function finish(response, marker, final = "stop") {
    fragment(response, marker, {}, final);
    if (!response.destroyed && !response.writableEnded) response.end("data: [DONE]\n\n");
  }
  function release(marker, chunk = "after|") {
    released.add(marker);
    for (const response of held.get(marker) || []) {
      fragment(response, marker, { content: chunk });
      const resume = heldReleases.get(response);
      if (resume) resume();
      else finish(response, marker);
    }
    held.delete(marker);
  }
  function toolReply(response, marker, name, args, callId) {
    fragment(response, marker, {
      tool_calls: [
        {
          index: 0,
          id: callId,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    });
    finish(response, marker, "tool_calls");
  }
  function hold(response, marker, resume) {
    fragment(response, marker, { content: "before|" });
    const responses = held.get(marker) || new Set();
    responses.add(response);
    held.set(marker, responses);
    if (resume) heldReleases.set(response, resume);
    response.once("close", () => {
      responses.delete(response);
      if (!responses.size) held.delete(marker);
    });
  }
  const model = capture(
    httpsServer(tls, async (request, response) => {
      try {
        if (request.method === "GET" && request.url === "/fixture/health") {
          json(response, 200, { fixture: "model", tls: true });
          return;
        }
        if (
          request.method !== "POST" ||
          !new URL(request.url, "https://fixture").pathname.endsWith("/chat/completions")
        ) {
          json(response, 404, {});
          return;
        }
        if (proxiedOrigins.has(request.socket.remotePort)) state.proxiedModelRequests++;
        else state.directModelRequests++;
        const suppliedKey = /^Bearer (.+)$/.exec(request.headers.authorization || "")?.[1];
        if (state.authFailure || !acceptedAuthKeys.has(suppliedKey)) {
          state.failedAuthRequests++;
          json(response, state.authFailure === "transient" ? 503 : 401, {
            error: {
              message: "Controlled fixture authorization rejected",
              type: "invalid_api_key",
            },
          });
          return;
        }
        const payload = await body(request, 64 * 1024 * 1024),
          messages = payload.messages || [];
        const latest = [...messages].reverse().find((message) => message.role === "user");
        const latestText = text(latest?.content);
        let markerMatch =
          /QUALIFICATION_(REQUEST|HOLD|QUESTION|APPROVAL|TEAM_PARENT|TEAM_CHILD|GOAL):([A-Za-z0-9_-]+)/.exec(
            latestText,
          );
        if (!markerMatch && latestText.includes("Application-managed task result")) {
          for (const message of [...messages].reverse()) {
            if (message.role === "user")
              markerMatch = /QUALIFICATION_(TEAM_PARENT):([A-Za-z0-9_-]+)/.exec(
                text(message.content),
              );
            if (markerMatch) break;
          }
        }
        const kind = markerMatch?.[1] || "REQUEST",
          marker = markerMatch?.[2] || "unmarked";
        const systems = messages
          .filter((message) => message.role === "system")
          .map((message) => text(message.content))
          .join("\n");
        const auxiliary =
          /title generator|generate[^\n]{0,60}(?:chat |session |conversation )?title|create[^\n]{0,40}conversation title/i.test(
            systems,
          );
        if (auxiliary) state.auxiliaryRequests++;
        else {
          state.requests[marker] = (state.requests[marker] || 0) + 1;
          const usage = (state.authUsed[marker] ||= { current: 0, previous: 0 });
          usage[suppliedKey === state.authKey ? "current" : "previous"]++;
        }
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "close",
        });
        fragment(response, marker, { role: "assistant" });
        if (auxiliary) {
          fragment(response, marker, { content: "Qualification fixture" });
          finish(response, marker);
          return;
        }
        const names = messages
          .filter((message) => message.role === "assistant")
          .flatMap((message) => (message.tool_calls || []).map((call) => call.function?.name));
        if (kind === "TEAM_PARENT") {
          if (!names.includes("codexnest_spawn_task"))
            toolReply(
              response,
              marker,
              "codexnest_spawn_task",
              {
                title: `Qualification child ${marker}`,
                prompt: `QUALIFICATION_TEAM_CHILD:${marker}-child`,
                access: { mode: "readOnly", network: false },
              },
              `qualification-call-spawn-${marker}`,
            );
          else {
            fragment(response, marker, {
              content: latestText.includes("Application-managed task result")
                ? `QUALIFICATION_TEAM_REVIEWED:${marker}`
                : `QUALIFICATION_TEAM_WAITING:${marker}`,
            });
            finish(response, marker);
          }
          return;
        }
        if (kind === "TEAM_CHILD" && !names.includes("codexnest_submit_result")) {
          const submit = () =>
            toolReply(
              response,
              marker,
              "codexnest_submit_result",
              {
                summary: `QUALIFICATION_TEAM_RESULT:${marker}`,
                outcome: "success",
                checks: [{ name: "Controlled native child", outcome: "passed" }],
              },
              `qualification-call-result-${marker}`,
            );
          if (released.has(marker)) submit();
          else hold(response, marker, submit);
          return;
        }
        if (kind === "GOAL") {
          if (!names.includes("create_goal"))
            toolReply(
              response,
              marker,
              "create_goal",
              { objective: `QUALIFICATION_GOAL:${marker} explicit fixture objective` },
              `qualification-call-create-goal-${marker}`,
            );
          else if (!names.includes("update_goal")) {
            const complete = () =>
              toolReply(
                response,
                marker,
                "update_goal",
                { status: "complete" },
                `qualification-call-complete-goal-${marker}`,
              );
            if (released.has(marker)) complete();
            else hold(response, marker, complete);
          } else {
            fragment(response, marker, { content: `QUALIFICATION_GOAL_COMPLETE:${marker}` });
            finish(response, marker);
          }
          return;
        }
        const callId = `qualification-call-${kind}-${marker}`;
        const answered = messages.some(
          (message) => message.role === "tool" && message.tool_call_id === callId,
        );
        if ((kind === "QUESTION" || kind === "APPROVAL") && !answered) {
          const command = `mkdir -p ${shellQuote(join(fixtureHome, "qualification-effects"))} && printf '%s\\n' ${shellQuote(marker)} >> ${shellQuote(join(fixtureHome, "qualification-effects", `${marker}.log`))}`;
          const parameters =
            kind === "QUESTION"
              ? {
                  questions: [
                    {
                      header: "Qualification",
                      question: `Continue controlled fixture ${marker}?`,
                      options: [
                        {
                          label: "Continue",
                          description: "Complete the isolated qualification request",
                        },
                      ],
                    },
                  ],
                }
              : { command, description: "Controlled qualification side effect" };
          fragment(response, marker, {
            tool_calls: [
              {
                index: 0,
                id: callId,
                type: "function",
                function: {
                  name: kind === "QUESTION" ? "question" : "bash",
                  arguments: JSON.stringify(parameters),
                },
              },
            ],
          });
          finish(response, marker, "tool_calls");
        } else if (kind === "HOLD" && !released.has(marker)) {
          hold(response, marker);
        } else {
          fragment(response, marker, { content: `QUALIFICATION_OK:${marker}` });
          finish(response, marker);
        }
      } catch {
        if (!response.headersSent)
          json(response, 500, { error: { message: "Controlled fixture request failed" } });
        else response.destroy();
      }
    }),
  );
  async function gitRequest(request, response, target) {
    const repository = await realpath(join(inputDirectory, "nest-apps.git"));
    assert.ok(inside(inputDirectory, repository));
    state.gitRequests++;
    const child = spawn("git", ["http-backend"], {
      env: {
        PATH: process.env.PATH,
        HOME: fixtureHome,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "safe.directory",
        GIT_CONFIG_VALUE_0: repository,
        GIT_CONFIG_KEY_1: "uploadpack.allowReachableSHA1InWant",
        GIT_CONFIG_VALUE_1: "true",
        GIT_PROJECT_ROOT: inputDirectory,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: target.pathname.replace("/petrovichest", ""),
        QUERY_STRING: target.search.slice(1),
        REQUEST_METHOD: request.method,
        CONTENT_TYPE: request.headers["content-type"] || "",
        CONTENT_LENGTH: request.headers["content-length"] || "",
        HTTP_GIT_PROTOCOL: request.headers["git-protocol"] || "",
        SERVER_PROTOCOL: "HTTP/1.1",
        REMOTE_ADDR: request.socket.remoteAddress || "127.0.0.1",
        REMOTE_USER: "qualification",
      },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let header = Buffer.alloc(0),
      started = false;
    child.stdout.on("data", (chunk) => {
      if (started) {
        if (!response.write(chunk)) {
          child.stdout.pause();
          response.once("drain", () => child.stdout.resume());
        }
        return;
      }
      header = Buffer.concat([header, chunk]);
      const delimiter = header.includes("\r\n\r\n") ? Buffer.from("\r\n\r\n") : Buffer.from("\n\n");
      const end = header.indexOf(delimiter);
      if (end === -1) {
        if (header.length > 65536) {
          child.kill();
          response.destroy();
        }
        return;
      }
      const lines = header.subarray(0, end).toString().split(/\r?\n/),
        headers = {};
      let status = 200;
      for (const line of lines) {
        const split = line.indexOf(":");
        if (split < 1) continue;
        const name = line.slice(0, split).toLowerCase(),
          value = line.slice(split + 1).trim();
        if (name === "status") status = Number(value.split(" ")[0]);
        else headers[name] = value;
      }
      response.writeHead(status, headers);
      started = true;
      response.write(header.subarray(end + delimiter.length));
      header = Buffer.alloc(0);
    });
    child.once("error", () => {
      state.gitFailures++;
      if (!response.headersSent) json(response, 500, { error: "Fixture Git backend failed" });
      else response.destroy();
    });
    child.once("close", (code) => {
      if (code !== 0 || !started) {
        state.gitFailures++;
        if (!response.headersSent) json(response, 500, { error: "Fixture Git backend failed" });
        else response.destroy();
      } else response.end();
    });
    request.once("aborted", () => child.kill());
    response.once("close", () => {
      if (child.exitCode === null) child.kill();
    });
    request.pipe(child.stdin);
    child.stdin.once("error", () => {
      /* Git can reject a request before reading its full body. */
    });
  }
  const registry = capture(
    httpsServer(tls, async (request, response) => {
      try {
        const target = new URL(request.url, "https://github.com"),
          path = target.pathname;
        if (
          (request.method === "GET" && path === "/petrovichest/nest-apps.git/info/refs") ||
          (request.method === "POST" && path === "/petrovichest/nest-apps.git/git-upload-pack")
        ) {
          await gitRequest(request, response, target);
          return;
        }
        state.registryRequests[path] = (state.registryRequests[path] || 0) + 1;
        if (request.method === "GET" && path === "/fixture/health") {
          json(response, 200, { fixture: "registry", tls: true });
          return;
        }
        if (
          request.method === "GET" &&
          [
            "/petrovichest/nest-apps/releases/download/rolling-latest/NestApps-latest.json",
            "/petrovichest/nest-apps/releases/download/opennest-latest/OpenNest-latest.json",
            "/petrovichest/nest-apps/releases/download/qualification/OpenNest-latest.json",
          ].includes(path) &&
          state.manifest
        ) {
          json(response, 200, state.manifest);
          return;
        }
        const file = state.files[path];
        if (request.method !== "GET" || !file) {
          json(response, 404, {});
          return;
        }
        const metadata = await stat(file);
        response.writeHead(200, {
          "content-type": path.endsWith(".json") ? "application/json" : "application/octet-stream",
          "content-length": metadata.size,
          "cache-control": "no-store",
        });
        createReadStream(file)
          .on("error", () => response.destroy())
          .pipe(response);
      } catch {
        if (!response.headersSent) json(response, 500, {});
        else response.destroy();
      }
    }),
  );
  const proxy = capture(
    httpServer(async (request, response) => {
      if (request.headers["proxy-authorization"] !== auth) {
        state.proxyDenied++;
        response
          .writeHead(407, { "proxy-authenticate": 'Basic realm="OpenNest qualification"' })
          .end();
        return;
      }
      if (state.proxyDown) {
        response.writeHead(503).end();
        return;
      }
      try {
        const target = new URL(request.url);
        if (
          !["http:", "https:"].includes(target.protocol) ||
          target.hostname !== "model.openrouter.fixture" ||
          Number(target.port) !== modelPort
        ) {
          state.proxyDenied++;
          state.unexpectedExternalRequests++;
          response.writeHead(403).end();
          return;
        }
        const headers = { ...request.headers };
        delete headers["proxy-authorization"];
        const outgoing = (target.protocol === "https:" ? httpsRequest : httpRequest)(
          {
            hostname: "127.0.0.2",
            port: modelPort,
            path: target.pathname + target.search,
            method: request.method,
            headers,
            ca: tls.cert,
            servername: "model.openrouter.fixture",
          },
          (upstream) => {
            response.writeHead(upstream.statusCode, upstream.headers);
            upstream.pipe(response);
          },
        );
        outgoing.once("socket", (socket) =>
          socket.once("connect", () => {
            const origin = socket.localPort;
            proxiedOrigins.add(origin);
            socket.once("close", () => proxiedOrigins.delete(origin));
          }),
        );
        outgoing.once("error", () => {
          if (!response.headersSent) response.writeHead(502);
          response.end();
        });
        request.pipe(outgoing);
      } catch {
        response.writeHead(400).end();
      }
    }),
  );
  proxy.on("connect", (request, client, head) => {
    if (request.headers["proxy-authorization"] !== auth) {
      state.proxyDenied++;
      client.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="OpenNest qualification"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
      );
      return;
    }
    if (state.proxyDown) {
      client.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      return;
    }
    let target;
    try {
      target = new URL(`http://${request.url}`);
    } catch {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    let host, port;
    const modelTarget =
      (["model.openrouter.fixture", "127.0.0.2"].includes(target.hostname) &&
        Number(target.port) === modelPort) ||
      (target.hostname === "openrouter.ai" && Number(target.port || 80) === 443);
    const registryTarget =
      target.hostname === "github.com" && Number(target.port || 80) === registryPort;
    const publicRegistry =
      ["registry.npmjs.org", "registry.npmjs.com"].includes(target.hostname) &&
      Number(target.port || 80) === 443;
    if (modelTarget) {
      host = "127.0.0.2";
      port = modelPort;
    } else if (registryTarget) {
      host = "127.0.0.2";
      port = registryPort;
    } else if (publicRegistry) {
      host = target.hostname;
      port = 443;
      state.publicRegistryConnections++;
    } else {
      state.proxyDenied++;
      state.unexpectedExternalRequests++;
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    state.proxyConnections++;
    const upstream = connect({ host, port });
    sockets.add(upstream);
    upstream.once("close", () => sockets.delete(upstream));
    upstream.once("connect", () => {
      if (modelTarget) {
        const origin = upstream.localPort;
        proxiedOrigins.add(origin);
        upstream.once("close", () => proxiedOrigins.delete(origin));
      }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.once("error", () => client.destroy());
    client.once("error", () => upstream.destroy());
    client.once("close", () => upstream.destroy());
  });
  async function publicState() {
    const sideEffects = {};
    for (const file of await readdir(join(fixtureHome, "qualification-effects")).catch(() => [])) {
      if (!/^[A-Za-z0-9_-]+\.log$/.test(file)) continue;
      const lines = (await readFile(join(fixtureHome, "qualification-effects", file), "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean);
      sideEffects[file.slice(0, -4)] = lines.length;
    }
    const { authKey: _authKey, files: _files, manifest: _manifest, ...publicValues } = state;
    void _authKey;
    void _files;
    void _manifest;
    return { ...publicValues, held: [...held.keys()], released: [...released], sideEffects };
  }
  const control = capture(
    httpServer(async (request, response) => {
      try {
        if (request.method === "GET" && request.url === "/state") {
          json(response, 200, await publicState());
          return;
        }
        if (request.method !== "POST" || request.url !== "/control") {
          json(response, 404, {});
          return;
        }
        const value = await body(request, 2 * 1024 * 1024);
        for (const [path, file] of Object.entries(value.files || {})) {
          assert.ok(
            path.startsWith("/petrovichest/nest-apps/releases/download/") && !path.includes(".."),
          );
          const canonical = await realpath(file);
          assert.ok(inside(privateDirectory, canonical) || inside(inputDirectory, canonical));
          assert.ok((await stat(canonical)).isFile());
          state.files[path] = canonical;
        }
        if (Object.hasOwn(value, "manifest")) state.manifest = value.manifest;
        if (Object.hasOwn(value, "authKey")) {
          assert.ok(typeof value.authKey === "string" && value.authKey.length > 5);
          state.authKey = value.authKey;
        }
        if (Object.hasOwn(value, "acceptedAuthKeys")) {
          assert.ok(
            Array.isArray(value.acceptedAuthKeys) &&
              value.acceptedAuthKeys.length > 0 &&
              value.acceptedAuthKeys.length <= 10 &&
              value.acceptedAuthKeys.every((key) => typeof key === "string" && key.length > 5),
          );
          assert.ok(value.acceptedAuthKeys.includes(state.authKey));
          acceptedAuthKeys.clear();
          for (const key of value.acceptedAuthKeys) acceptedAuthKeys.add(key);
        } else if (Object.hasOwn(value, "authKey")) {
          acceptedAuthKeys.clear();
          acceptedAuthKeys.add(state.authKey);
        }
        if (Object.hasOwn(value, "authFailure")) {
          assert.ok([false, "transient", "expired"].includes(value.authFailure));
          state.authFailure = value.authFailure;
        }
        if (Object.hasOwn(value, "proxyDown")) {
          assert.equal(typeof value.proxyDown, "boolean");
          state.proxyDown = value.proxyDown;
        }
        for (const marker of value.release || []) {
          assert.match(marker, /^[A-Za-z0-9_-]+$/);
          release(marker);
        }
        if (value.chunk) {
          const { marker, text: content, finish: completed } = value.chunk;
          assert.match(marker, /^[A-Za-z0-9_-]+$/);
          assert.equal(typeof content, "string");
          assert.ok(content.length < 100000);
          for (const stream of held.get(marker) || []) {
            fragment(stream, marker, { content });
            if (completed) {
              const resume = heldReleases.get(stream);
              if (resume) resume();
              else finish(stream, marker);
            }
          }
          if (completed) {
            released.add(marker);
            held.delete(marker);
          }
        }
        json(response, 200, await publicState());
      } catch {
        json(response, 400, { error: "Invalid fixture control request" });
      }
    }),
  );
  async function listen(server, host, port) {
    await new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolveListen);
    });
    return server.address().port;
  }
  modelPort = await listen(model, "127.0.0.2", options.modelPort ?? 9050);
  registryPort = await listen(registry, "127.0.0.2", options.registryPort ?? 443);
  const proxyPort = await listen(proxy, "127.0.0.1", options.proxyPort ?? 9051);
  const controlPort = await listen(control, "127.0.0.1", options.controlPort ?? 9052);
  const heartbeat = setInterval(() => {
    for (const [marker, streams] of held)
      for (const stream of streams) {
        if (stream.destroyed) streams.delete(stream);
        else stream.write(`: qualification keepalive ${marker}\n\n`);
      }
  }, 1000);
  heartbeat.unref();
  return {
    modelPort,
    registryPort,
    proxyPort,
    controlPort,
    state: publicState,
    async close() {
      clearInterval(heartbeat);
      for (const socket of sockets) socket.destroy();
      await Promise.all(
        servers.map((server) => new Promise((resolveClose) => server.close(resolveClose))),
      );
    },
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const services = await createQualificationServices({
    home: process.env.OPENNEST_QUALIFICATION_HOME,
    privateDirectory: process.env.OPENNEST_QUALIFICATION_PRIVATE,
    inputDirectory: process.env.OPENNEST_QUALIFICATION_INPUT,
  });
  process.stdout.write(
    `${JSON.stringify({ fixture: "OpenNest external services", modelPort: services.modelPort, registryPort: services.registryPort, proxyPort: services.proxyPort, controlPort: services.controlPort })}\n`,
  );
  const stop = async () => {
    await services.close();
    process.exitCode = 0;
  };
  process.once("SIGTERM", () => {
    void stop();
  });
  process.once("SIGINT", () => {
    void stop();
  });
}
