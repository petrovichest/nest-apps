#!/usr/bin/env node
/** Real native proxy routing probe. This is not native release qualification. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, request } from "node:http";
import { createWriteStream } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";

const binary = await realpath(process.argv[2] || "");
const entry = await realpath(process.argv[3] || "apps/open-server/dist/native.js");
const actualPlugin = process.argv[4] ? await realpath(process.argv[4]) : null;
const scratch = await mkdtemp(join(tmpdir(), "opennest-proxy-smoke-"));
const config = join(scratch, "config"),
  release = join(scratch, "release"),
  project = join(scratch, "project");
for (const directory of [config, join(release, "apps/open-server/dist"), project])
  await mkdir(directory, { recursive: true, mode: 0o700 });
const apiToken = randomBytes(32).toString("hex");
await writeFile(join(config, "token"), apiToken, { mode: 0o600 });
await writeFile(
  join(release, "apps/open-server/dist/plugin.js"),
  actualPlugin
    ? await readFile(actualPlugin, "utf8")
    : "export const Fixture = async () => ({});\n",
);
await writeFile(join(release, "package.json"), '{"type":"module"}');
await symlink(
  resolve(import.meta.dirname, "../../../node_modules"),
  join(release, "node_modules"),
  "dir",
);
const password = randomBytes(24).toString("hex");
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
const expectedProxyAuth = `Basic ${Buffer.from("fixture-user:fixture-proxy-password").toString("base64")}`;
let deny = false,
  proxyCalls = 0,
  native,
  exited,
  log;
const modelCalls = [];
const toolCalls = [];
const sockets = new Set();
const model = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const messages = JSON.parse(raw).messages ?? [];
  modelCalls.push({
    viaProxy: req.headers["x-opennest-proxy-fixture"] === "configured",
    path: req.url,
  });
  res.writeHead(200, { "content-type": "text/event-stream" });
  const userText = JSON.stringify(messages),
    hasToolReply = messages.some((message) => message.role === "tool");
  assert.ok(!userText.includes(apiToken), "Plugin bearer token entered model context");
  if (actualPlugin && !hasToolReply && /plugin-probe-(goal|task)/.test(userText)) {
    const task = userText.includes("plugin-probe-task");
    const nativeCalls = task
      ? [
          {
            index: 0,
            id: "call_native_task",
            type: "function",
            function: {
              name: "task",
              arguments: JSON.stringify({
                description: "Denied native task",
                prompt: "Do not execute real work",
                subagent_type: "explore",
              }),
            },
          },
        ]
      : [0, 1].map((index) => ({
          index,
          id: `call_plugin_goal_${index + 1}`,
          type: "function",
          function: { name: "get_goal", arguments: "{}" },
        }));
    res.end(
      `data: ${JSON.stringify({ id: "fixture-tool", object: "chat.completion.chunk", created: 1, model: "native-fixture", choices: [{ index: 0, delta: { role: "assistant", tool_calls: nativeCalls }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
    );
    return;
  }
  res.end(
    `data: ${JSON.stringify({ id: "fixture-completion", object: "chat.completion.chunk", created: 1, model: "native-fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Proxied native fixture completed." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
  );
});
const apiFixture = createServer(async (req, res) => {
  assert.equal(req.url, "/api/v1/internal/tools");
  assert.equal(req.headers.authorization, `Bearer ${apiToken}`);
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const tool = JSON.parse(raw);
  toolCalls.push(tool);
  assert.equal(tool.tool, "get_goal");
  assert.equal(typeof tool.callID, "string");
  res.writeHead(200, { "content-type": "application/json" }).end('{"goal":null}');
});
const proxy = createServer((req, res) => {
  proxyCalls++;
  assert.equal(req.headers["proxy-authorization"], expectedProxyAuth);
  if (deny) {
    res.writeHead(502).end("fixture upstream unavailable");
    return;
  }
  const destination = new URL(req.url);
  if (destination.hostname !== "127.0.0.2") {
    res.writeHead(403).end();
    return;
  }
  const headers = { ...req.headers, "x-opennest-proxy-fixture": "configured" };
  delete headers["proxy-authorization"];
  const upstream = request(destination, { method: req.method, headers }, (response) => {
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res);
  });
  upstream.on("error", () => {
    res.writeHead(502).end();
  });
  req.pipe(upstream);
});
proxy.on("connect", (_req, socket) => {
  proxyCalls++;
  socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
});
for (const server of [model, proxy, apiFixture])
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
async function listen(server, host = "127.0.0.1") {
  await new Promise((resolve) => server.listen(0, host, resolve));
  return server.address().port;
}
async function waitFor(action, name, budget = 20_000) {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    const result = await action();
    if (result) return result;
    await delay(50);
  }
  throw new Error(`Proxy smoke timed out: ${name}`);
}
let nativePort;
async function api(method, path, body) {
  const url = new URL(path, `http://127.0.0.1:${nativePort}`);
  url.searchParams.set("directory", project);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        authorization,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
  } catch {
    throw new Error(`Native ${method} ${path} did not respond within its request budget`);
  }
  assert.ok(response.ok, `Native ${method} ${path}: ${response.status}`);
  const value = await response.text();
  return value ? JSON.parse(value) : undefined;
}
const send = (id, text = "Complete the isolated proxy fixture.") =>
  api("POST", `/session/${id}/prompt_async`, {
    model: { providerID: "openrouter", modelID: "opennest/native-fixture" },
    parts: [{ type: "text", text }],
  });
try {
  const modelPort = await listen(model, "127.0.0.2"),
    proxyPort = await listen(proxy),
    apiPort = await listen(apiFixture);
  const reserve = createServer();
  nativePort = await listen(reserve);
  await new Promise((resolve) => reserve.close(resolve));
  await writeFile(
    join(config, "connection.json"),
    JSON.stringify({
      version: 1,
      proxy: `http://fixture-user:fixture-proxy-password@127.0.0.1:${proxyPort}`,
    }),
    { mode: 0o600 },
  );
  const nativeData = join(scratch, ".local/share/opencode");
  await mkdir(nativeData, { recursive: true, mode: 0o700 });
  await writeFile(
    join(nativeData, "auth.json"),
    JSON.stringify({ openrouter: { type: "api", key: "fixture-only-native-key" } }),
    { mode: 0o600 },
  );
  const nativeConfig = join(scratch, ".config/opencode");
  await mkdir(nativeConfig, { recursive: true });
  await writeFile(
    join(nativeConfig, "package.json"),
    '{"dependencies":{"@opencode-ai/plugin":"1.19.5"}}',
  );
  await writeFile(
    join(nativeConfig, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: { "": { dependencies: { "@opencode-ai/plugin": "1.19.5" } } },
    }),
  );
  await symlink(
    resolve(import.meta.dirname, "../../../node_modules"),
    join(nativeConfig, "node_modules"),
    "dir",
  );
  const env = {
    PATH: process.env.PATH,
    HOME: scratch,
    XDG_CONFIG_HOME: join(scratch, ".config"),
    XDG_DATA_HOME: join(scratch, ".local/share"),
    XDG_STATE_HOME: join(scratch, ".local/state"),
    XDG_CACHE_HOME: join(scratch, ".cache"),
    TMPDIR: scratch,
    OPENNEST_CONFIG_DIR: config,
    OPENNEST_PORT: String(apiPort),
    OPENNEST_STATE_DIR: join(scratch, "state"),
    OPENNEST_RUNTIME_DIR: join(scratch, "run"),
    OPENNEST_RELEASE_PATH: release,
    OPENNEST_OPENCODE_BIN: binary,
    OPENNEST_NATIVE_URL: `http://127.0.0.1:${nativePort}`,
    OPENCODE_SERVER_PASSWORD: password,
    HTTP_PROXY: "http://discarded-inherited-proxy:9",
    HTTPS_PROXY: "http://discarded-inherited-proxy:9",
    NO_PROXY: "*",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      autoupdate: false,
      share: "disabled",
      model: "openrouter/opennest/native-fixture",
      small_model: "openrouter/opennest/native-fixture",
      enabled_providers: ["openrouter"],
      agent: { title: { disable: true } },
      provider: {
        openrouter: {
          options: { baseURL: `http://127.0.0.2:${modelPort}/v1`, maxRetries: 0 },
          models: {
            "opennest/native-fixture": {
              name: "Native proxy fixture",
              tool_call: true,
              limit: { context: 32768, output: 1024 },
            },
          },
        },
      },
    }),
  };
  log = createWriteStream(join(scratch, "native.log"), { mode: 0o600 });
  native = spawn(process.execPath, [entry], {
    env,
    cwd: project,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  exited = new Promise((resolve) => {
    native.once("exit", resolve);
    native.once("error", resolve);
  });
  native.stdout.pipe(log, { end: false });
  native.stderr.pipe(log, { end: false });
  await waitFor(
    async () => {
      assert.equal(native.exitCode, null, "Native wrapper exited before readiness");
      return api("GET", "/global/health").catch(() => null);
    },
    "native wrapper readiness",
    30_000,
  );
  const session = await api("POST", "/session", { title: "Native proxy fixture" });
  await send(session.id, actualPlugin ? "plugin-probe-goal" : undefined);
  await waitFor(async () => {
    const messages = await api("GET", `/session/${session.id}/message`);
    return messages.some(
      (message) => message.info.role === "assistant" && message.info.time?.completed,
    );
  }, "proxied native model completion");
  assert.ok(modelCalls.length > 0, "Native did not reach the local model fixture");
  assert.ok(
    modelCalls.every((call) => call.viaProxy),
    "Native bypassed its configured proxy",
  );
  if (actualPlugin) {
    assert.equal(toolCalls.length, 2);
    assert.equal(toolCalls[0].sessionID, session.id);
    assert.match(toolCalls[0].messageID, /^msg_/);
    assert.equal(toolCalls[0].messageID, toolCalls[1].messageID);
    assert.deepEqual(toolCalls.map((call) => call.callID).sort(), [
      "call_plugin_goal_1",
      "call_plugin_goal_2",
    ]);
    assert.deepEqual(toolCalls[0].args, toolCalls[1].args);
    const scoped = await api("POST", "/session", { title: "Managed native hook fixture" });
    const policyDir = join(scratch, "state/tool-scopes");
    await mkdir(policyDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(policyDir, `${scoped.id}.json`),
      JSON.stringify({
        mode: "readOnly",
        directory: project,
        writePaths: [],
        network: false,
        nodeBin: process.execPath,
        protectedPaths: [config, join(scratch, "state")],
      }),
      { mode: 0o600 },
    );
    await send(scoped.id, "plugin-probe-task");
    const denied = await waitFor(async () => {
      const messages = await api("GET", `/session/${scoped.id}/message`);
      const part = messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === "tool" && part.tool === "task");
      return part?.state?.error?.includes("native subagents are disabled") && part;
    }, "actual native plugin hook rejection");
    assert.equal(denied.state.status, "error");
    assert.deepEqual(await api("GET", `/session/${scoped.id}/children`), []);
  }
  const children = (await readFile(`/proc/${native.pid}/task/${native.pid}/children`, "utf8"))
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  assert.ok(children.length > 0);
  const nativeChild = Number(children.at(-1));
  const environment = await readFile(`/proc/${nativeChild}/environ`, "utf8");
  assert.ok(
    !environment.includes("fixture-proxy-password"),
    "Upstream password leaked into native env",
  );
  assert.ok(
    !environment.includes("discarded-inherited-proxy"),
    "Native retained an inherited proxy bypass",
  );
  deny = true;
  const before = { proxy: proxyCalls, model: modelCalls.length };
  const rejected = await api("POST", "/session", { title: "Failed native proxy fixture" });
  await send(rejected.id);
  await waitFor(() => proxyCalls > before.proxy, "failed upstream attempt");
  await delay(500);
  assert.equal(
    modelCalls.length,
    before.model,
    "Native directly reached the model after proxy failure",
  );
  await api("POST", `/session/${rejected.id}/abort`);
  assert.ok((await api("GET", "/global/health")).healthy);
  process.stdout.write(
    JSON.stringify(
      {
        scope: "isolated native proxy routing only; not release qualification",
        nativeVersion: "1.19.5",
        checks: [
          "wrapper uses stored authenticated HTTP upstream",
          "actual native model request traverses bridge",
          "inherited bypass and upstream credentials absent in native env",
          "upstream rejection does not fall back to direct model",
          "native HTTP stays available for proxy recovery",
          ...(actualPlugin
            ? [
                "actual OpenNest plugin routes authenticated tool with native session/message context",
                "identical parallel calls in one assistant message retain distinct native call IDs",
                "actual native hook blocks managed native subagents before creation",
              ]
            : []),
        ],
      },
      null,
      2,
    ) + "\n",
  );
} catch (error) {
  process.stderr.write(
    `${error.name}: ${error.message}\nPrivate fixture logs: ${join(scratch, "native.log")}\n`,
  );
  process.exitCode = 1;
} finally {
  if (native?.exitCode === null && native.signalCode === null) {
    native.kill("SIGTERM");
    await Promise.race([exited, delay(5000)]);
    if (native.exitCode === null && native.signalCode === null) {
      try {
        process.kill(-native.pid, "SIGKILL");
      } catch {
        /* Already gone. */
      }
      await exited;
    }
  }
  log?.end();
  if (log) await finished(log).catch(() => undefined);
  for (const socket of sockets) socket.destroy();
  for (const server of [model, proxy, apiFixture])
    await new Promise((resolve) => server.close(resolve));
  if (!process.exitCode) await rm(scratch, { recursive: true, force: true });
}
