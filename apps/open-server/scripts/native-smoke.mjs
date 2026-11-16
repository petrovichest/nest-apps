#!/usr/bin/env node
/** Native API compatibility probe, NOT installation/update/rollback qualification. */
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createWriteStream } from "node:fs";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { finished } from "node:stream/promises";

assert.ok(process.argv[2], "Pass an explicit isolated OpenCode binary path.");
const binary = await realpath(process.argv[2] ?? "").catch(() => null);
assert.ok(binary, "Pass an explicit isolated OpenCode binary path.");
const scratch = await mkdtemp(join(tmpdir(), "opennest-native-smoke-"));
const cwd = join(scratch, "project");
await mkdir(cwd);
const password = randomBytes(24).toString("hex");
const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
const model = "opennest/native-fixture";
const calls = [];
const held = new Set();
let releaseFirst;
let native;
let nativeExit;
let nativeLog;
let nativePort;
const report = {
  scope: "isolated native API contract only",
  nativeVersion: null,
  checks: [],
  steering: null,
  authRefresh: null,
  statusScope: null,
};
const fixture = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!req.url?.endsWith("/chat/completions")) {
    res
      .writeHead(404, { "content-type": "application/json" })
      .end('{"error":"fixture route not found"}');
    return;
  }
  const body = JSON.parse(raw);
  const messages = body.messages ?? [];
  calls.push(messages);
  const text = JSON.stringify(messages);
  const hasToolReply = messages.some((message) => message.role === "tool");
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (delta, finishReason = null) =>
    res.write(
      `data: ${JSON.stringify({
        id: `chatcmpl-${calls.length}`,
        object: "chat.completion.chunk",
        created: 1,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`,
    );
  const finish = (finishReason = "stop") => {
    send({}, finishReason);
    res.end("data: [DONE]\n\n");
  };
  if (text.includes("native-probe-question") && !hasToolReply) {
    send({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: "call_question_fixture",
          type: "function",
          function: {
            name: "question",
            arguments: JSON.stringify({
              questions: [
                {
                  header: "Contract",
                  question: "Continue native probe?",
                  options: [{ label: "Continue", description: "Finish isolated probe" }],
                },
              ],
            }),
          },
        },
      ],
    });
    finish("tool_calls");
  } else if (text.includes("native-probe-permission") && !hasToolReply) {
    send({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: "call_bash_fixture",
          type: "function",
          function: {
            name: "bash",
            arguments: JSON.stringify({
              command: "printf opennest-native-contract",
              description: "Isolated native contract probe",
            }),
          },
        },
      ],
    });
    finish("tool_calls");
  } else if (text.includes("native-probe-first") && !text.includes("native-probe-second")) {
    send({ role: "assistant", content: "First request has started. " });
    held.add(res);
    releaseFirst = () => {
      held.delete(res);
      send({ content: "First request is complete." });
      finish();
    };
    res.once("close", () => held.delete(res));
  } else {
    send({ role: "assistant", content: "Native fixture completed." });
    finish();
  }
});
async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}
async function waitFor(action, label, timeout = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const result = await action();
    if (result) return result;
    await delay(50);
  }
  throw new Error(`Native contract timed out: ${label}`);
}
async function api(method, path, body, { directory = cwd } = {}) {
  const url = new URL(path, `http://127.0.0.1:${nativePort}`);
  if (directory) url.searchParams.set("directory", directory);
  const response = await fetch(url, {
    method,
    headers: {
      authorization: auth,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  assert.ok(response.ok, `Native ${method} ${path} returned HTTP ${response.status}`);
  if (response.status === 204) return undefined;
  const result = await response.text();
  return result ? JSON.parse(result) : undefined;
}
const newSession = () => api("POST", "/session", { title: "OpenNest isolated contract" });
const send = (sessionID, text, messageID) =>
  api("POST", `/session/${sessionID}/prompt_async`, {
    ...(messageID ? { messageID } : {}),
    model: { providerID: "openrouter", modelID: model },
    parts: [{ type: "text", text }],
  });
const complete = (sessionID) =>
  waitFor(async () => {
    const messages = await api("GET", `/session/${sessionID}/message`);
    return (
      messages.some(
        (message) => message.info.role === "assistant" && message.info.time?.completed,
      ) &&
      !(await api("GET", "/session/status"))[sessionID] &&
      messages
    );
  }, "session completion");
try {
  const fixturePort = await listen(fixture);
  const portReservation = createServer();
  nativePort = await listen(portReservation);
  await new Promise((resolve) => portReservation.close(resolve));
  const env = {
    PATH: process.env.PATH,
    HOME: scratch,
    XDG_CONFIG_HOME: join(scratch, ".config"),
    XDG_DATA_HOME: join(scratch, ".local/share"),
    XDG_CACHE_HOME: join(scratch, ".cache"),
    XDG_STATE_HOME: join(scratch, ".local/state"),
    TMPDIR: scratch,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      autoupdate: false,
      share: "disabled",
      model: `openrouter/${model}`,
      small_model: `openrouter/${model}`,
      enabled_providers: ["openrouter"],
      permission: { bash: "ask", edit: "ask" },
      agent: { title: { disable: true } },
      provider: {
        openrouter: {
          options: {
            baseURL: `http://127.0.0.1:${fixturePort}/v1`,
          },
          models: {
            [model]: {
              name: "OpenNest native fixture",
              tool_call: true,
              limit: { context: 32768, output: 1024 },
            },
          },
        },
      },
    }),
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1",
  };
  report.nativeVersion = (
    await promisify(execFile)(binary, ["--version"], { env, cwd, timeout: 15_000 })
  ).stdout.trim();
  assert.equal(report.nativeVersion, "1.19.5");
  const log = (nativeLog = createWriteStream(join(scratch, "native.log"), { mode: 0o600 }));
  native = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(nativePort)], {
    env,
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  native.stdout.pipe(log, { end: false });
  native.stderr.pipe(log, { end: false });
  nativeExit = new Promise((resolve) => native.once("exit", () => resolve(true)));
  await waitFor(
    async () => {
      assert.equal(native.exitCode, null, "Native server exited before readiness");
      return api("GET", "/global/health", undefined, { directory: null }).catch(() => null);
    },
    "native startup",
    30_000,
  );
  report.checks.push("native version and health");
  const beforeAuth = await api("GET", "/provider");
  await api("PUT", "/auth/openrouter", { type: "api", key: "fixture-only-saved-key" });
  let providers = await api("GET", "/provider");
  const connectedAfterSave = providers.connected.includes("openrouter");
  const authSession = await newSession();
  await send(authSession.id, "native-probe-auth-after-save");
  const authMessages = await complete(authSession.id);
  const authError = authMessages.find((message) => message.info.role === "assistant")?.info.error;
  if (authError)
    assert.equal(authError.name, "ProviderAuthError", "Unexpected native auth probe error");
  if (authError || !connectedAfterSave) {
    // This probe is deliberately before any session/work. Never dispose an active instance.
    await api("POST", "/instance/dispose");
    providers = await api("GET", "/provider");
    const refreshed = await newSession();
    await send(refreshed.id, "native-probe-auth-after-refresh");
    assert.ok(
      !(await complete(refreshed.id)).some((message) => message.info.error),
      "Native auth refresh did not restore model execution",
    );
  }
  report.authRefresh = {
    connectedBeforeSave: beforeAuth.connected.includes("openrouter"),
    connectedAfterSave,
    modelAcceptedKeyWithoutRefresh: !authError,
    requiredIdleDispose: Boolean(authError) || !connectedAfterSave,
  };
  assert.ok(providers.connected.includes("openrouter"));
  assert.ok(providers.all.find((provider) => provider.id === "openrouter")?.models?.[model]);
  report.checks.push(
    "native auth save and OpenRouter catalog, including observed idle-refresh requirement",
  );
  const session = await newSession();
  assert.equal((await api("GET", `/session/${session.id}`)).id, session.id);
  const fork = await api("POST", `/session/${session.id}/fork`, {});
  assert.notEqual(fork.id, session.id);
  await api("POST", `/session/${fork.id}/abort`);
  await api("GET", "/permission");
  await api("GET", "/question");
  report.checks.push("create/load/fork/abort, permission and question inventories");
  const messageID = `msg_${Date.now().toString(16)}${randomBytes(7).toString("hex")}`;
  await send(session.id, "native-probe-first", messageID);
  await waitFor(() => releaseFirst, "held native model response");
  const otherCwd = join(scratch, "other-project");
  await mkdir(otherCwd);
  const ownStatuses = await api("GET", "/session/status");
  const otherStatuses = await api("GET", "/session/status", undefined, { directory: otherCwd });
  assert.equal(ownStatuses[session.id]?.type, "busy");
  assert.equal(otherStatuses[session.id], undefined);
  const allSessions = await api("GET", "/experimental/session", undefined, { directory: null });
  assert.ok(allSessions.some((entry) => entry.id === session.id && entry.directory === cwd));
  report.statusScope = { perDirectory: true, globalInventoryEndpoint: "/experimental/session" };
  await send(session.id, "native-probe-second");
  const whileBusy = await api("GET", `/session/${session.id}/message`);
  const userTexts = whileBusy
    .filter((message) => message.info.role === "user")
    .flatMap((message) =>
      message.parts.filter((part) => part.type === "text").map((part) => part.text),
    );
  assert.ok(userTexts.includes("native-probe-second"));
  releaseFirst();
  const final = await complete(session.id);
  assert.ok(final.some((message) => message.info.id === messageID));
  report.steering = {
    activeMessagePersisted: true,
    modelRequestsWithFirst: calls.filter((messages) =>
      JSON.stringify(messages).includes("native-probe-first"),
    ).length,
    modelRequestsWithSecond: calls.filter((messages) =>
      JSON.stringify(messages).includes("native-probe-second"),
    ).length,
    semantics:
      "Second message accepted and persisted during an active response; inspect request counts for native continuation. This is not a guarantee of tool-phase immediate steering.",
  };
  report.checks.push(
    "explicit native message ID, streaming response, active-turn message persistence and completion",
  );
  const question = await newSession();
  await send(question.id, "native-probe-question");
  const pendingQuestion = await waitFor(
    async () => (await api("GET", "/question")).find((entry) => entry.sessionID === question.id),
    "native question",
  );
  await api("POST", `/question/${pendingQuestion.id}/reply`, { answers: [["Continue"]] });
  await complete(question.id);
  report.checks.push("native question request and answer roundtrip");
  const permission = await newSession();
  await send(permission.id, "native-probe-permission");
  const pendingPermission = await waitFor(
    async () =>
      (await api("GET", "/permission")).find((entry) => entry.sessionID === permission.id),
    "native permission",
  );
  await api("POST", `/permission/${pendingPermission.id}/reply`, { reply: "reject" });
  await complete(permission.id);
  report.checks.push("native terminal permission request and denial roundtrip");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify(report)}\n`);
  process.stderr.write(
    `${error.name}: ${error.message}\nPrivate fixture logs: ${join(scratch, "native.log")}\n`,
  );
  process.exitCode = 1;
} finally {
  for (const response of held) response.destroy();
  fixture.closeAllConnections();
  await new Promise((resolve) => fixture.close(resolve));
  if (native?.pid) {
    if (native.exitCode === null && native.signalCode === null) {
      try {
        process.kill(-native.pid, "SIGTERM");
      } catch {
        /* Already stopped. */
      }
      const exited = await Promise.race([nativeExit, delay(3000).then(() => false)]);
      if (!exited && native.exitCode === null && native.signalCode === null) {
        try {
          process.kill(-native.pid, "SIGKILL");
        } catch {
          /* Already stopped. */
        }
        await nativeExit;
      }
    }
  }
  if (nativeLog) {
    nativeLog.end();
    await finished(nativeLog);
  }
  if (!process.exitCode) await rm(scratch, { recursive: true, force: true });
}
