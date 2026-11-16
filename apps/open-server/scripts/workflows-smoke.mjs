#!/usr/bin/env node
/** Actual native + production plugin + facade workflows. Not release qualification. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";

const binary = await realpath(process.argv[2] || "");
const nativeEntry = await realpath("apps/open-server/dist/native.js");
const apiEntry = await realpath("apps/open-server/dist/index.js");
const pluginEntry = await realpath("apps/open-server/dist/plugin.js");
const scratch = await mkdtemp(join(tmpdir(), "opennest-workflows-smoke-"));
const config = join(scratch, "config"),
  release = join(scratch, "release"),
  project = join(scratch, "project");
for (const directory of [config, join(release, "apps/open-server/dist"), project])
  await mkdir(directory, { recursive: true, mode: 0o700 });
const skillDirectory = join(project, ".agents/skills/controlled");
await mkdir(skillDirectory, { recursive: true });
await writeFile(
  join(skillDirectory, "SKILL.md"),
  "---\nname: controlled\ndescription: Controlled isolated smoke skill\n---\nFollow only this isolated fixture's explicit requests.\n",
);
const token = randomBytes(32).toString("hex"),
  password = randomBytes(24).toString("hex");
await writeFile(join(config, "token"), token, { mode: 0o600 });
await writeFile(join(release, "package.json"), '{"type":"module"}');
await writeFile(join(release, "apps/open-server/dist/plugin.js"), await readFile(pluginEntry));
await symlink(resolve("node_modules"), join(release, "node_modules"), "dir");
const modelCalls = [],
  children = [],
  sockets = new Set();
let env, facade, held;
function fragment(response, text, done = false) {
  response.write(
    `data: ${JSON.stringify({ id: "fixture-held", object: "chat.completion.chunk", created: 1, model: "native-fixture", choices: [{ index: 0, delta: { content: text }, finish_reason: done ? "stop" : null }] })}\n\n`,
  );
  if (done) response.end("data: [DONE]\n\n");
}
const tool = (name, args, id) => ({
  index: 0,
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const model = createServer(async (req, res) => {
  try {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body),
      messages = request.messages ?? [];
    const context = JSON.stringify(messages);
    assert.ok(!context.includes(token), "Private API token entered model context");
    const names = messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => (message.tool_calls ?? []).map((call) => call.function.name));
    const latestUser = [...messages].reverse().find((message) => message.role === "user");
    const latestInput = JSON.stringify(latestUser?.content ?? "");
    if (
      latestInput.includes("WORKFLOW_STREAM_SMOKE") ||
      latestInput.includes("WORKFLOW_EXTERNAL_BUSY")
    ) {
      modelCalls.push({
        phase: latestInput.includes("WORKFLOW_STREAM_SMOKE") ? "stream" : "external",
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      held = res;
      fragment(res, "before|");
      return;
    }
    let phase = "other",
      call,
      content = "Fixture finished.";
    if (latestInput.includes("WORKFLOW_CHILD_SMOKE")) {
      phase = "child";
      if (!names.includes("codexnest_submit_result"))
        call = tool(
          "codexnest_submit_result",
          {
            summary: "Controlled child finished",
            outcome: "success",
            checks: [{ name: "Controlled fixture", outcome: "passed" }],
          },
          "call_child_result",
        );
      else content = "Managed child final answer.";
    } else if (context.includes("WORKFLOW_GOAL_SMOKE")) {
      phase = "goal";
      if (!names.includes("create_goal"))
        call = tool(
          "create_goal",
          { objective: "WORKFLOW_GOAL_SMOKE explicit objective" },
          "call_create_goal",
        );
      else if (!names.includes("update_goal"))
        call = tool("update_goal", { status: "complete" }, "call_complete_goal");
      else content = "Goal achieved.";
    } else if (context.includes("WORKFLOW_TEAM_SMOKE")) {
      phase = "parent";
      if (!names.includes("bash"))
        call = tool(
          "bash",
          {
            command: "printf controlled_permission_probe",
            description: "Controlled permission probe",
          },
          "call_parent_approval",
        );
      else if (!names.includes("codexnest_spawn_task"))
        call = tool(
          "codexnest_spawn_task",
          {
            title: "Controlled managed child",
            prompt: "WORKFLOW_CHILD_SMOKE: finish this controlled task and submit its result.",
            access: { mode: "readOnly", network: false },
          },
          "call_spawn_child",
        );
      else
        content = latestInput.includes("Application-managed task result")
          ? "Parent reviewed the delivered child result."
          : "Parent awaits the managed result.";
    }
    const toolNames = (request.tools ?? []).map((item) => item.function?.name);
    if (phase === "parent" || phase === "child")
      assert.ok(!toolNames.includes("task"), "Managed workflow exposed native subagents");
    modelCalls.push({ phase, tool: call?.function.name, input: latestInput });
    res.writeHead(200, { "content-type": "text/event-stream" });
    const delta = call ? { role: "assistant", tool_calls: [call] } : { role: "assistant", content };
    res.end(
      `data: ${JSON.stringify({ id: `fixture-${modelCalls.length}`, object: "chat.completion.chunk", created: 1, model: "native-fixture", choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`,
    );
  } catch (error) {
    modelCalls.push({ error: error.message });
    res.writeHead(500).end("Invalid controlled fixture request");
  }
});
model.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});
async function port(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const value = server.address().port;
  return value;
}
async function waitFor(action, name, budget = 25_000) {
  const deadline = Date.now() + budget;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await action();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await delay(50);
  }
  throw new Error(`${name} timed out${last ? `: ${last.message}` : ""}`);
}
function start(entry, name) {
  const log = createWriteStream(join(scratch, `${name}.log`), { mode: 0o600 });
  const child = spawn(process.execPath, [entry], {
    env,
    cwd: project,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise((resolve) => {
    child.once("exit", resolve);
    child.once("error", resolve);
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const item = { child, exited, log };
  children.push(item);
  return item;
}
async function stop(item) {
  if (item.child.exitCode === null && item.child.signalCode === null) {
    item.child.kill("SIGTERM");
    await Promise.race([item.exited, delay(5000)]);
    if (item.child.exitCode === null && item.child.signalCode === null) {
      try {
        process.kill(-item.child.pid, "SIGKILL");
      } catch {
        /* The isolated process group already exited. */
      }
      await item.exited;
    }
  }
}
async function request(method, path, body, native = false) {
  const response = await fetch(
    `${native ? env.OPENNEST_NATIVE_URL : `http://127.0.0.1:${env.OPENNEST_PORT}`}${path}`,
    {
      method,
      headers: {
        authorization: native
          ? `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
          : `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    },
  );
  const raw = await response.text();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${raw.slice(0, 200)}`);
  return raw ? JSON.parse(raw) : undefined;
}
try {
  const apiReservation = createServer(),
    nativeReservation = createServer();
  const [modelPort, apiPort, nativePort] = await Promise.all([
    port(model),
    port(apiReservation),
    port(nativeReservation),
  ]);
  await Promise.all(
    [apiReservation, nativeReservation].map(
      (server) => new Promise((resolve) => server.close(resolve)),
    ),
  );
  const nativeData = join(scratch, ".local/share/opencode"),
    nativeConfig = join(scratch, ".config/opencode");
  await mkdir(nativeData, { recursive: true, mode: 0o700 });
  await mkdir(nativeConfig, { recursive: true });
  await writeFile(
    join(nativeData, "auth.json"),
    JSON.stringify({ openrouter: { type: "api", key: "fixture-only-key" } }),
    { mode: 0o600 },
  );
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
  await symlink(resolve("node_modules"), join(nativeConfig, "node_modules"), "dir");
  env = {
    PATH: process.env.PATH,
    HOME: scratch,
    XDG_CONFIG_HOME: join(scratch, ".config"),
    XDG_DATA_HOME: join(scratch, ".local/share"),
    XDG_STATE_HOME: join(scratch, ".local/state"),
    XDG_CACHE_HOME: join(scratch, ".cache"),
    TMPDIR: scratch,
    OPENNEST_CONFIG_DIR: config,
    OPENNEST_STATE_DIR: join(scratch, "state"),
    OPENNEST_RUNTIME_DIR: join(scratch, "run"),
    OPENNEST_EVENT_SOCKET: join(scratch, "run/native-events.sock"),
    OPENNEST_RELEASE_PATH: release,
    OPENNEST_CLIENT_DIST: join(scratch, "no-client"),
    OPENNEST_OPENCODE_BIN: binary,
    OPENNEST_NATIVE_URL: `http://127.0.0.1:${nativePort}`,
    OPENNEST_PORT: String(apiPort),
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    NO_PROXY: "127.0.0.1,localhost",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      autoupdate: false,
      share: "disabled",
      model: "openrouter/opennest/native-fixture",
      small_model: "openrouter/opennest/native-fixture",
      enabled_providers: ["openrouter"],
      agent: { title: { disable: true } },
      provider: {
        openrouter: {
          options: { baseURL: `http://127.0.0.1:${modelPort}/v1`, maxRetries: 0 },
          models: {
            "opennest/native-fixture": {
              name: "Native workflow fixture",
              tool_call: true,
              limit: { context: 32768, output: 1024 },
            },
          },
        },
      },
    }),
  };
  const native = start(nativeEntry, "native");
  await waitFor(() => request("GET", "/global/health", undefined, true), "native health");
  facade = start(apiEntry, "api-before-restart");
  await waitFor(
    async () => (await request("GET", "/api/v1/health")).status === "ok",
    "facade readiness",
  );
  const savedProject = await request("POST", "/api/v1/projects", { path: project });
  const skills = await request("GET", `/api/v1/skills?cwd=${encodeURIComponent(project)}`);
  assert.ok(
    skills.skills.some(
      (skill) => skill.name === "controlled" && skill.path === join(skillDirectory, "SKILL.md"),
    ),
    `Real native skill discovery omitted the fixture skill: ${JSON.stringify(skills)}`,
  );
  const goal = (
    await request("POST", `/api/v1/projects/${savedProject.id}/threads`, {
      clientCreationId: "goal-thread",
    })
  ).thread;
  await request("POST", `/api/v1/threads/${goal.id}/turns`, {
    input:
      "WORKFLOW_GOAL_SMOKE: I explicitly request a goal. Create the objective, achieve it, and mark it complete.",
    clientMessageId: "goal-request",
  });
  await waitFor(
    async () => (await request("GET", `/api/v1/threads/${goal.id}/goal`))?.status === "complete",
    "actual create_goal/update_goal",
  );
  await waitFor(
    async () =>
      (await request("GET", `/api/v1/threads/${goal.id}`)).turns
        .at(-1)
        ?.items.some((item) => item.type === "agentMessage" && item.phase === "final_answer"),
    "goal final answer",
  );
  const parent = (
    await request("POST", `/api/v1/projects/${savedProject.id}/threads`, {
      clientCreationId: "team-thread",
    })
  ).thread;
  await request("PATCH", `/api/v1/threads/${parent.id}/settings`, { collaborationMode: "team" });
  await request("POST", `/api/v1/threads/${parent.id}/turns`, {
    input:
      "WORKFLOW_TEAM_SMOKE: Delegate one controlled task through OpenNest Team and review its returned result.",
    clientMessageId: "team-request",
  });
  const approval = await waitFor(
    async () =>
      (await request("GET", "/api/v1/attention")).find(
        (item) => item.threadId === parent.id && item.kind === "commandApproval",
      ),
    "Team retains ask permission for shell commands",
  );
  const nativeParent = await request("GET", `/session/${parent.id}`, undefined, true);
  assert.ok(
    nativeParent.permission.some((rule) => rule.permission === "*" && rule.action === "ask"),
    "Team discarded the ask preset",
  );
  assert.ok(
    nativeParent.permission.some((rule) => rule.permission === "task" && rule.action === "deny"),
    "Team did not disable native task",
  );
  await request("POST", `/api/v1/attention/${encodeURIComponent(approval.id)}/respond`, {
    kind: "approval",
    decision: "accept",
  });
  const state = await waitFor(async () => {
    const saved = JSON.parse(await readFile(join(env.OPENNEST_STATE_DIR, "ui.json"), "utf8"));
    const tasks = Object.values(saved.threads[parent.id].teamOrchestration?.tasks ?? {});
    return (
      tasks.length === 1 &&
      tasks[0].status === "completed" &&
      tasks[0].delivery?.status === "delivered" &&
      saved
    );
  }, "managed child result and parent delivery");
  const task = Object.values(state.threads[parent.id].teamOrchestration.tasks)[0];
  assert.equal(task.result.summary, "Controlled child finished");
  assert.equal(task.result.outcome, "success");
  await waitFor(async () => {
    const detail = await request("GET", `/api/v1/threads/${parent.id}`);
    return (
      detail.turns.some((turn) => turn.items.some((item) => item.type === "orchestrationNotice")) &&
      detail.turns
        .at(-1)
        ?.items.some(
          (item) =>
            item.type === "agentMessage" &&
            item.phase === "final_answer" &&
            item.text.includes("Parent reviewed"),
        )
    );
  }, "parent notice and reviewed final answer");
  assert.deepEqual(
    await request("GET", `/session/${parent.id}/children`, undefined, true),
    [],
    "Team used native task children",
  );
  const stream = (
    await request("POST", `/api/v1/projects/${savedProject.id}/threads`, {
      clientCreationId: "stream-thread",
    })
  ).thread;
  await request("POST", `/api/v1/threads/${stream.id}/turns`, {
    input: "WORKFLOW_STREAM_SMOKE",
    clientMessageId: "one-held-stream",
  });
  const streamText = async () =>
    (await request("GET", `/api/v1/threads/${stream.id}`)).turns
      .flatMap((turn) => turn.items)
      .filter((item) => item.type === "agentMessage")
      .map((item) => item.text)
      .join("");
  await waitFor(
    async () => held && (await streamText()) === "before|",
    "initial live stream prefix",
  );
  const nativePid = native.child.pid,
    before = structuredClone(modelCalls);
  assert.equal(before.filter((call) => call.tool === "create_goal").length, 1);
  assert.equal(before.filter((call) => call.tool === "update_goal").length, 1);
  assert.equal(before.filter((call) => call.tool === "codexnest_spawn_task").length, 1);
  assert.equal(before.filter((call) => call.tool === "codexnest_submit_result").length, 1);
  assert.ok(!before.some((call) => call.error), JSON.stringify(before));
  await stop(facade);
  assert.equal(native.child.exitCode, null);
  fragment(held, "offline|");
  facade = start(apiEntry, "api-after-restart");
  await waitFor(
    async () => (await request("GET", "/api/v1/health")).status === "ok",
    "facade restart readiness",
  );
  await waitFor(
    async () => (await streamText()) === "before|offline|",
    "offline stream recovered without duplicates",
  );
  fragment(held, "live|");
  await waitFor(
    async () => (await streamText()) === "before|offline|live|",
    "live stream continues before completion after restart",
  );
  assert.ok(!held.writableEnded, "Stream completed before the live continuity assertion");
  fragment(held, "", true);
  held = undefined;
  await waitFor(
    async () => !(await request("GET", `/api/v1/threads/${stream.id}`)).summary.currentTurnId,
    "held stream completes",
  );
  await delay(1200);
  assert.equal(native.child.pid, nativePid);
  assert.equal(native.child.exitCode, null);
  assert.deepEqual(modelCalls, before, "API restart repeated paid workflow work");
  assert.equal(modelCalls.filter((call) => call.phase === "stream").length, 1);
  assert.equal((await request("GET", `/api/v1/threads/${goal.id}/goal`)).status, "complete");
  const restored = JSON.parse(await readFile(join(env.OPENNEST_STATE_DIR, "ui.json"), "utf8"));
  assert.equal(Object.keys(restored.threads[parent.id].teamOrchestration.tasks).length, 1);
  assert.equal(
    restored.threads[parent.id].teamOrchestration.tasks[task.id].delivery.status,
    "delivered",
  );
  const externalDirectory = join(scratch, "external-project");
  await mkdir(externalDirectory);
  const externalQuery = `directory=${encodeURIComponent(externalDirectory)}`;
  const external = await request(
    "POST",
    `/session?${externalQuery}`,
    {
      title: "External archived busy fixture",
      permission: [{ permission: "*", pattern: "*", action: "deny" }],
    },
    true,
  );
  await request(
    "PATCH",
    `/session/${external.id}?${externalQuery}`,
    { time: { archived: Date.now() } },
    true,
  );
  await request(
    "POST",
    `/session/${external.id}/prompt_async?${externalQuery}`,
    {
      model: { providerID: "openrouter", modelID: "opennest/native-fixture" },
      parts: [{ type: "text", text: "WORKFLOW_EXTERNAL_BUSY" }],
    },
    true,
  );
  await waitFor(
    () => held && modelCalls.some((call) => call.phase === "external"),
    "external native session starts work",
  );
  const allNative = await request(
    "GET",
    "/experimental/session?archived=true&limit=2147483647",
    undefined,
    true,
  );
  assert.ok(
    allNative.some((session) => session.id === external.id),
    "Archived native inventory omitted active external work",
  );
  const activeOnly = await request(
    "GET",
    "/experimental/session?limit=2147483647",
    undefined,
    true,
  );
  assert.ok(
    !activeOnly.some((session) => session.id === external.id),
    "Native archived inventory check did not exercise the archived flag",
  );
  for (const [path, body] of [
    ["/api/v1/settings/open/proxy", { proxy: "http://127.0.0.1:9" }],
    ["/api/v1/settings/open", { apiKey: "fixture-replacement-must-not-be-saved" }],
  ]) {
    const response = await fetch(`http://127.0.0.1:${env.OPENNEST_PORT}${path}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(
      response.status,
      409,
      `Connection change ${path} missed external archived busy work`,
    );
    await response.arrayBuffer();
  }
  await request("POST", `/session/${external.id}/abort?${externalQuery}`, undefined, true);
  held?.end();
  held = undefined;
  assert.equal(native.child.exitCode, null, "Connection guard restarted the native owner");
  process.stdout.write(
    JSON.stringify(
      {
        scope:
          "isolated actual native, production plugin, facade and workflows; not release qualification",
        nativeVersion: "1.19.5",
        checks: [
          "actual create_goal and update_goal tools",
          "actual managed child spawn and submit_result",
          "managed tools exclude native task",
          "Team keeps the ask preset and native shell approval while denying native task",
          "actual V1 native skill discovery",
          "configured private relay recovers offline text and continues live before completion",
          "one surviving native model request across an active API restart",
          "proxy and key changes reject archived external cwd work",
          "parent orchestration notice and result response",
          "completed workflows survive API restart without repeated model work",
          "native process survives API restart",
          "private bearer token stays out of model context",
        ],
      },
      null,
      2,
    ) + "\n",
  );
} catch (error) {
  process.exitCode = 1;
  process.stderr.write(`${error.name}: ${error.message}\nPrivate fixture logs: ${scratch}\n`);
} finally {
  for (const item of children.reverse()) {
    await stop(item);
    item.log.end();
    await finished(item.log).catch(() => {});
  }
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => model.close(resolve));
  if (!process.exitCode) await rm(scratch, { recursive: true, force: true });
}
