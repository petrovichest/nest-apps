import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  readlink,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { NativeRelay } from "./native-relay.mjs";

const require = createRequire("/opt/qualification/package.json");
const WebSocket = require("ws");
const home = "/home/nest-qualification";
assert.equal(process.getuid(), 17001);
assert.equal(process.env.HOME, home);
const cgroupPath = process.env.QUALIFICATION_CGROUP_PATH;
assert.equal(cgroupPath, "/sys/fs/cgroup/user.slice/user-17001.slice");
const input = "/qualification-input";
const output = "/qualification-output";
const privateRoot = "/qualification-private";
const root = join(home, ".local/share/codexnest");
const statusPath = join(home, ".local/state/codexnest/update.json");
const cli = join(home, ".local/bin/codexnest");
const nativeSocket = join(home, ".codex/app-server-control/app-server-control.sock");
const candidate = (await readFile(join(input, "candidate-sha"), "utf8")).trim();
assert.match(candidate, /^[0-9a-f]{40}$/);
const baseline = JSON.parse(await readFile(join(input, "baseline.json"), "utf8"));
const candidateVersion = `0.1.9-${candidate.slice(0, 7)}`;
const scope = process.env.QUALIFICATION_SCOPE ?? "all";
assert.ok(["all", "interruption", "clean"].includes(scope));
const report = {
  candidate,
  baseline,
  native: process.env.NATIVE_VERSION,
  scope,
  resources: { cpus: 4, memoryGiB: 10 },
  budgetsMs: {
    ready: 60_000,
    updaterHealth: 120_000,
    rollback: 420_000,
    build: 600_000,
    nativeStop: 10_000,
    fixtureImport: 1_380_000,
  },
  cases: [],
  originalDaemonRpc: {},
  releaseQualified: false,
  pending: [
    "expired and failed authorization during startup/recovery",
    "updater interruption at each switch/checkpoint/confirmation boundary",
    "candidate clean installer and other packaged applications",
  ],
};
if (scope !== "all")
  report.pending.push("full large-history lifecycle matrix not run in this scope");
let ownerToken;
let savedThread;
let projectId;
let failureNumber = 0;
let relay;

async function saveReport() {
  await writeFile(join(output, "lifecycle.json"), `${JSON.stringify(report, null, 2)}\n`);
}

async function stage(name, action) {
  const started = Date.now();
  process.stdout.write(`Qualification: ${name}\n`);
  try {
    const evidence = await action();
    report.cases.push({ name, status: "passed", durationMs: Date.now() - started, ...evidence });
  } catch (error) {
    report.cases.push({
      name,
      status: "failed",
      durationMs: Date.now() - started,
      error: String(error.message).replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[redacted]"),
    });
    throw error;
  } finally {
    await saveReport();
  }
}

async function run(command, args, { timeout = 120_000, log } = {}) {
  const destination = log ?? join(privateRoot, `command-${failureNumber++}.log`);
  const stream = createWriteStream(destination, { mode: 0o600 });
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let captured = "";
  let diagnostic = "";
  child.stdout.on("data", (data) => {
    captured += data;
    stream.write(data);
  });
  child.stderr.on("data", (data) => {
    diagnostic += data;
    stream.write(data);
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
      reject(new Error(`Command exceeded budget: ${command}`));
    }, timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", async (code, signal) => {
      clearTimeout(timer);
      await new Promise((finished) => stream.end(finished));
      if (code === 0) resolve();
      else {
        const clean = `${captured}\n${diagnostic}`
          .split("\n")
          .filter((line) => !/bearer|authorization|access.token|refresh.token|id.token/i.test(line))
          .slice(-35)
          .join("\n")
          .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[redacted]");
        await writeFile(join(output, "last-command-failure.txt"), clean);
        reject(
          new Error(
            `Command failed: ${command} (code=${code}, signal=${signal}); private diagnostic ${destination}`,
          ),
        );
      }
    });
  });
  return captured;
}

const systemctl = (...args) => run("systemctl", ["--user", ...args]);
async function until(name, action, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await action();
    if (Date.now() > deadline) break;
    if (result) return result;
    await delay(250);
  }
  throw new Error(`${name} exceeded its ${timeout} ms budget`);
}

async function api(path, body, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(`http://127.0.0.1:4310/api/v1${path}`, {
    method,
    headers: {
      ...(ownerToken ? { authorization: `Bearer ${ownerToken}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw Object.assign(new Error(`API ${method} ${path}: HTTP ${response.status}`), {
      status: response.status,
    });
  return response.status === 204 ? null : response.json();
}

async function health() {
  try {
    return await api("/health");
  } catch {
    return null;
  }
}

async function ready(version, timeout = report.budgetsMs.ready, observe) {
  const started = Date.now();
  const states = [];
  const result = await until(
    `Ready ${version}`,
    async () => {
      const value = await health();
      const state = value
        ? {
            status: value.status,
            version: value.serverVersion,
            recovery: value.recoveryState,
            native: value.appServer?.state,
            cli: value.appServer?.installedVersion,
          }
        : { status: "http-unavailable" };
      const serialized = JSON.stringify(state);
      if (states.at(-1)?.serialized !== serialized)
        states.push({ afterMs: Date.now() - started, serialized });
      observe?.(value);
      return value?.status === "ok" &&
        value.serverVersion === version &&
        value.recoveryState === "ready" &&
        value.transport === "daemon" &&
        value.appServer?.state === "ready" &&
        value.appServer.installedVersion === process.env.NATIVE_VERSION &&
        value.restartProtocolVersion === 2
        ? value
        : null;
    },
    timeout,
  ).catch((error) => {
    report.lastReadinessFailure = { expected: version, states: states.slice(-12) };
    throw error;
  });
  return { readyMs: Date.now() - started, health: result };
}

async function control(body) {
  const response = await fetch("http://127.0.0.1:9002", {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function pidIdentity(all = false) {
  return JSON.parse(
    await run("python3", [
      "-c",
      `
import json,os
from pathlib import Path
result=[]
bound=set()
for line in Path('/proc/net/unix').read_text().splitlines()[1:]:
    fields=line.split()
    if len(fields)>7 and fields[7]=='${nativeSocket}':
        bound.add('socket:['+fields[6]+']')
for proc in Path('/proc').iterdir():
    if not proc.name.isdigit(): continue
    try:
        if proc.stat().st_uid != 17001: continue
        exe=os.readlink(proc/'exe')
        command=(proc/'cmdline').read_bytes().split(b'\\0')
        if command[1:4] == [b'app-server',b'daemon',b'pid-update-loop']: continue
        sockets=set()
        for fd in (proc/'fd').iterdir():
            try: sockets.add(os.readlink(fd))
            except OSError: pass
        if Path(exe).name == 'codex' and b'app-server' in command and (${all ? "True" : "False"} or sockets.intersection(bound)):
            result.append({'pid':int(proc.name),'startTime':(proc/'stat').read_text().split(') ',1)[1].split()[19]})
    except (OSError,ValueError): pass
print(json.dumps(result))
`,
    ]),
  );
}

async function assertSurviving(previous, all = false) {
  assert.ok(previous.length, "Original native PID identity missing");
  const current = await pidIdentity(all);
  for (const process of previous)
    assert.ok(
      current.some((entry) => entry.pid === process.pid && entry.startTime === process.startTime),
      "Original native daemon was restarted or lost",
    );
  return { survivingNative: previous };
}

async function snapshot() {
  const socket = new WebSocket("ws://127.0.0.1:4310/api/v1/events", { origin: "http://localhost" });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Snapshot budget exceeded")), 15_000);
      socket.on("error", reject);
      socket.on("open", () =>
        socket.send(JSON.stringify({ type: "authenticate", token: ownerToken })),
      );
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.type === "snapshot") {
          clearTimeout(timer);
          resolve(frame.snapshot);
        }
      });
    });
  } finally {
    socket.close();
  }
}

async function completed(thread, marker) {
  return until(`Saved response ${marker}`, async () => {
    const detail = await api(`/threads/${thread}`).catch((error) => {
      if (error.status !== 503) throw error;
      report.transientDetailReadFailures = (report.transientDetailReadFailures ?? 0) + 1;
      return null;
    });
    if (!detail) return null;
    return JSON.stringify(detail.turns).includes(`QUALIFICATION_OK:${marker}`) &&
      !detail.summary.currentTurnId
      ? detail
      : null;
  });
}

async function request(thread, name) {
  const marker = `${name}-${randomUUID()}`;
  await api(`/threads/${thread}/turns`, {
    input: `QUALIFICATION_REQUEST:${marker}`,
    clientMessageId: randomUUID(),
  });
  await completed(thread, marker);
  const state = await control();
  assert.equal(state.requests[marker], 1, "Saved request replayed");
  assert.equal(state.directModelRequests, 0, "Model traffic bypassed the fixture proxy");
  return { savedChatRequest: "completed", acceptedRequests: state.requests[marker] };
}

async function nativeRpc(action, socketPath = nativeSocket) {
  const socket = new WebSocket(`ws+unix://${socketPath}:/`, { perMessageDeflate: false });
  let sequence = 0;
  const pending = new Map();
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Native RPC budget exceeded: ${method}`));
      }, 30_000);
      pending.set(id, { resolve, reject, timer, method });
      socket.send(JSON.stringify({ id, method, params }));
    });
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.method || !pending.has(message.id)) return;
    const entry = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      const detail = String(message.error.message ?? "");
      const safe = /bearer|authorization|access.token|refresh.token|id.token/i.test(detail)
        ? "credential error (details omitted)"
        : detail.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[redacted]").slice(0, 500);
      entry.reject(new Error(`Native RPC ${entry.method} (${message.error.code}): ${safe}`));
    } else entry.resolve(message.result);
  });
  try {
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    await rpc("initialize", {
      clientInfo: { name: "nest_qualification", version: "1" },
      capabilities: { experimentalApi: true },
    });
    socket.send(JSON.stringify({ method: "initialized" }));
    return await action(rpc);
  } finally {
    socket.close();
    for (const entry of pending.values()) clearTimeout(entry.timer);
  }
}

async function verifyIndex() {
  const history = JSON.parse(await readFile(join(privateRoot, "history-manifest.json"), "utf8"));
  const version = JSON.parse(await run("codex", ["app-server", "daemon", "version"]));
  assert.equal(version.appServerVersion, process.env.NATIVE_VERSION);
  assert.equal(version.cliVersion, process.env.NATIVE_VERSION);
  return nativeRpc(async (rpc) => {
    const counts = {};
    for (const archived of [false, true]) {
      const found = new Set();
      let cursor = null;
      let pages = 0;
      do {
        const result = await rpc("thread/list", {
          limit: 100,
          cursor,
          archived,
          sortKey: "updated_at",
          sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown", "subAgentThreadSpawn"],
        });
        for (const thread of result.data) {
          assert.ok(!found.has(thread.id), "Duplicate history page");
          found.add(thread.id);
        }
        cursor = result.nextCursor ?? null;
        pages++;
        assert.ok(pages < 100, "History cursor did not terminate");
      } while (cursor);
      for (const row of history.filter((row) => (row.kind === "archived") === archived)) {
        assert.ok(found.has(row.id), `Native index omitted ${row.kind} history`);
      }
      counts[archived ? "archived" : "nonArchived"] = { threads: found.size, pages };
    }
    const long = await rpc("thread/read", { threadId: history[0].id, includeTurns: true });
    assert.ok(
      long.thread.turns.length >= history[0].turns,
      `Long history lost turns: expected ${history[0].turns}, found ${long.thread.turns.length}`,
    );
    const turnIds = new Set();
    let turnCursor = null;
    let turnPages = 0;
    do {
      const page = await rpc("thread/turns/list", {
        threadId: history[0].id,
        cursor: turnCursor,
        limit: 50,
        sortDirection: "asc",
      });
      for (const turn of page.data) {
        assert.ok(!turnIds.has(turn.id), "Turn pagination repeated an entry");
        turnIds.add(turn.id);
      }
      turnCursor = page.nextCursor ?? null;
      assert.ok(++turnPages < 100, "Turn cursor did not terminate");
    } while (turnCursor);
    assert.equal(turnIds.size, long.thread.turns.length, "Turn pages disagree with native read");
    const nestThreads = new Map((await snapshot()).threads.map((thread) => [thread.id, thread]));
    for (const row of history) {
      assert.ok(nestThreads.has(row.id), `Nest omitted ${row.kind} history`);
      assert.equal(nestThreads.get(row.id).archived, row.kind === "archived");
    }
    return { index: counts, longThreadTurns: long.thread.turns.length, turnPages };
  });
}

function managedTasks(parent) {
  const database = new DatabaseSync(join(home, ".local/state/codexnest/state.sqlite"), {
    readOnly: true,
  });
  try {
    const row = database
      .prepare("SELECT json FROM state_entries WHERE namespace='threadMeta' AND entry_key=?")
      .get(parent);
    return Object.values(JSON.parse(row?.json ?? "{}").teamOrchestration?.tasks ?? {});
  } finally {
    database.close();
  }
}

async function holdWork(name) {
  const held = `held-${name}-${randomUUID()}`,
    queued = `queued-${name}-${randomUUID()}`;
  await api(`/threads/${savedThread}/turns`, {
    input: `QUALIFICATION_HOLD:${held}`,
    clientMessageId: randomUUID(),
  });
  await until("Native accepted held request", async () => (await control()).requests[held] === 1);
  await api(`/threads/${savedThread}/queue`, {
    input: `QUALIFICATION_REQUEST:${queued}`,
    clientMessageId: randomUUID(),
  });
  const approvalMarker = `approval-${name}-${randomUUID()}`;
  const approvalThread = (
    await api(`/projects/${projectId}/threads`, {
      clientCreationId: randomUUID(),
    })
  ).thread.id;
  await api(`/threads/${approvalThread}/turns`, {
    input: `QUALIFICATION_APPROVAL:${approvalMarker}`,
    clientMessageId: randomUUID(),
  });
  await until("Actual native approval is pending", async () =>
    (await snapshot()).attention.some(
      (request) => request.threadId === approvalThread && request.kind === "commandApproval",
    ),
  );
  assert.equal(
    await readFile(join(home, "qualification-approvals", approvalMarker), "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    }),
    null,
    "Command executed before approval",
  );
  const backgroundMarker = `background-${name}-${randomUUID()}`;
  const backgroundParent = (
    await api(`/projects/${projectId}/threads`, { clientCreationId: randomUUID() })
  ).thread.id;
  await api(`/threads/${backgroundParent}/settings`, { collaborationMode: "team" }, "PATCH");
  await api(`/threads/${backgroundParent}/turns`, {
    input: `QUALIFICATION_TEAM_PARENT:${backgroundMarker}`,
    clientMessageId: randomUUID(),
  });
  await until("Managed child accepted a real model request", async () => {
    const tasks = managedTasks(backgroundParent);
    assert.ok(tasks.length <= 1, "Managed child creation replayed");
    return (
      tasks.length === 1 &&
      tasks[0].status === "running" &&
      (await control()).requests[`team-child-${backgroundMarker}`] === 1
    );
  });
  return {
    held,
    queued,
    approvalMarker,
    approvalThread,
    backgroundMarker,
    backgroundParent,
    identity: await pidIdentity(true),
  };
}

async function finishWork(work) {
  const identity = await assertSurviving(work.identity, true);
  const approval = (await snapshot()).attention.find(
    (request) => request.threadId === work.approvalThread && request.kind === "commandApproval",
  );
  assert.ok(approval, "Pending native approval lost during application replacement");
  await api(`/attention/${approval.id}/respond`, { kind: "approval", decision: "accept" });
  await completed(work.approvalThread, work.approvalMarker);
  assert.deepEqual(
    (await readFile(join(home, "qualification-approvals", work.approvalMarker), "utf8"))
      .trim()
      .split("\n"),
    ["approved"],
    "Approved side effect replayed",
  );
  const detail = await api(`/threads/${savedThread}`);
  assert.ok(detail.summary.currentTurnId, "Active native turn lost during restart");
  assert.equal(detail.queuedMessages.length, 1, "Queued message lost or dispatched early");
  const state = await control();
  await control({
    released: [...state.released, work.held, `team-child-${work.backgroundMarker}`],
  });
  const finished = await completed(savedThread, work.queued);
  assert.ok(
    JSON.stringify(finished.turns).includes(`QUALIFICATION_OK:${work.held}`),
    "Active request's final response was lost",
  );
  const final = await control();
  assert.equal(final.requests[work.held], 1, "Active request replayed");
  assert.equal(final.requests[work.queued], 1, "Queued request replayed");
  assert.equal(
    final.requests[work.approvalMarker],
    2,
    "Native tool request or continuation replayed",
  );
  await completed(work.backgroundParent, `team-delivery-${work.backgroundMarker}`);
  const tasks = managedTasks(work.backgroundParent);
  assert.equal(tasks.length, 1, "Managed task creation replayed during recovery");
  assert.equal(tasks[0].status, "completed");
  assert.equal(tasks[0].result?.source, "submitted");
  assert.equal(tasks[0].result?.outcome, "success");
  assert.equal(
    tasks[0].result?.summary,
    `QUALIFICATION_BACKGROUND_RESULT:${work.backgroundMarker}`,
  );
  assert.equal(tasks[0].delivery?.status, "delivered");
  const background = await control();
  assert.equal(background.requests[`team-parent-${work.backgroundMarker}`], 2);
  assert.equal(background.requests[`team-child-${work.backgroundMarker}`], 2);
  assert.equal(background.requests[`team-delivery-${work.backgroundMarker}`], 1);
  return {
    ...identity,
    activeRequestCount: 1,
    queuedRequestCount: 1,
    restoredApproval: true,
    approvedSideEffects: 1,
    managedBackgroundResults: 1,
    managedBackgroundDeliveries: 1,
  };
}

async function update(expectedResult, afterRestart) {
  // Invoke the actual installed A unit/script, never source the new updater.
  const before = await readFile(cli);
  const baselineScript = await run("git", [
    "-C",
    join(root, "source"),
    "show",
    `${baseline.commit}:deploy/codexnest`,
  ]);
  assert.equal(
    before.toString(),
    baselineScript,
    "Update did not begin with the installed healthy release's updater",
  );
  await control({ manifest: { schemaVersion: 1, version: candidateVersion, commit: candidate } });
  await until("Previous updater exited", async () =>
    ["inactive", "failed"].includes(
      (await systemctl("show", "codexnest-update.service", "-p", "ActiveState", "--value")).trim(),
    ),
  );
  const previousStatus = await readFile(statusPath, "utf8").catch(() => "");
  await systemctl("reset-failed", "codexnest-update.service");
  await systemctl("start", "--no-block", "codexnest-update.service");
  await until(
    "Update entered restart",
    async () => {
      const raw = await readFile(statusPath, "utf8");
      if (raw === previousStatus) return false;
      const state = JSON.parse(raw);
      if (state.operation === "idle" && state.result === "failed")
        throw new Error(`Updater rejected candidate: ${state.message}`);
      return state.operation === "restarting" || state.result === expectedResult;
    },
    report.budgetsMs.build,
  );
  const switching = Date.now();
  const budget = expectedResult === "updated" ? report.budgetsMs.ready : report.budgetsMs.rollback;
  if (afterRestart) await afterRestart();
  const remaining = budget - (Date.now() - switching);
  assert.ok(remaining > 0, "Update fault injection exceeded the recovery budget");
  const state = await until(
    `Updater ${expectedResult}`,
    async () => {
      const value = JSON.parse(await readFile(statusPath, "utf8"));
      if (value.operation === "idle" && value.result === "failed")
        throw new Error(`Automatic recovery failed: ${value.message}`);
      if (value.operation !== "idle" || value.result !== expectedResult) return null;
      const active = (
        await systemctl("show", "codexnest-update.service", "-p", "ActiveState", "--value")
      ).trim();
      return ["inactive", "failed"].includes(active) ? value : null;
    },
    remaining,
  );
  return {
    updaterSha256: createHash("sha256").update(before).digest("hex"),
    recoveryMs: Date.now() - switching,
    updateStatus: state.result,
  };
}

async function fault(mode) {
  const directory = join(home, ".config/systemd/user/codexnest.service.d");
  await mkdir(directory, { recursive: true });
  const launcher = join(privateRoot, "candidate-launcher.sh");
  await writeFile(
    launcher,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$(cat '${root}/current/.codexnest-built')" == '${candidate}' ]]; then
  ${mode === "no-http" ? "export CODEXNEST_PORT=0" : ["wrong-version", "no-token", "rotated-auth"].includes(mode) ? "export CODEXNEST_VERSION=0.0.0-qualification" : ":"}
fi
exec '${root}/runtime/current/bin/node' '${root}/current/apps/server/dist/index.js'
`,
    { mode: 0o700 },
  );
  await chmod(launcher, 0o700);
  await writeFile(
    join(directory, "qualification.conf"),
    `[Service]\nExecStart=\nExecStart=${launcher}\n`,
  );
  await systemctl("daemon-reload");
}

async function rejectUpdate(expectedMessage) {
  const active = await readlink(join(root, "current"));
  const previous = await readlink(join(root, "previous"));
  const script = await readFile(cli);
  assert.equal(
    script.toString(),
    await run("git", ["-C", join(root, "source"), "show", `${baseline.commit}:deploy/codexnest`]),
    "Refusal case did not use the installed A updater",
  );
  await control({ manifest: { schemaVersion: 1, version: candidateVersion, commit: candidate } });
  await until("Previous updater exited", async () =>
    ["inactive", "failed"].includes(
      (await systemctl("show", "codexnest-update.service", "-p", "ActiveState", "--value")).trim(),
    ),
  );
  const before = await readFile(statusPath, "utf8");
  await systemctl("reset-failed", "codexnest-update.service");
  await systemctl("start", "--no-block", "codexnest-update.service");
  const rejected = await until(
    "Old updater rejected an unsafe candidate",
    async () => {
      const raw = await readFile(statusPath, "utf8");
      if (raw === before) return null;
      const value = JSON.parse(raw);
      if (value.operation !== "idle") return null;
      assert.equal(value.result, "failed", "Faulted update unexpectedly accepted");
      assert.match(value.message, expectedMessage);
      return value;
    },
    report.budgetsMs.build,
  );
  assert.equal(await readlink(join(root, "current")), active, "Rejected update changed current");
  assert.equal(
    await readlink(join(root, "previous")),
    previous,
    "Rejected update replaced rollback",
  );
  return { updateStatus: rejected.result, activeAndRollbackTargetsPreserved: true };
}

async function stopNative() {
  await systemctl("stop", "codexnest.service");
  await relay?.close();
  relay = undefined;
  const units = (
    await systemctl("list-units", "--all", "--plain", "--no-legend", "codexnest-account-*.service")
  )
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((unit) => /^codexnest-account-[0-9a-f-]+\.service$/.test(unit));
  if (units.length) await systemctl("stop", ...units);
  await run("codex", ["app-server", "daemon", "stop"]);
  await until(
    "Requested native stop completed",
    async () => (await pidIdentity(true)).length === 0,
    report.budgetsMs.nativeStop,
  );
  // Native's stop command deliberately leaves its PID update-loop helper alive.
  // It is not the app-server. Still reject any process retaining history/index
  // descriptors before moving SQLite files or evicting cold fixture history.
  const stopped = JSON.parse(
    await run("python3", [
      "-c",
      `
import json,os
from pathlib import Path
helpers=[]
history_fds=[]
for proc in Path('/proc').iterdir():
    if not proc.name.isdigit(): continue
    try:
        if proc.stat().st_uid != 17001: continue
        command=(proc/'cmdline').read_bytes().split(b'\\0')
        if command[1:4] == [b'app-server',b'daemon',b'pid-update-loop']:
            helpers.append(int(proc.name))
        for fd in (proc/'fd').iterdir():
            try: target=os.readlink(fd)
            except OSError: continue
            if target.startswith('${home}/.codex/') and ('.sqlite' in target or '/sessions/' in target or '/archived_sessions/' in target):
                history_fds.append({'pid':int(proc.name),'file':Path(target).name})
    except (OSError,ValueError): pass
print(json.dumps({'nativeUpdateLoopPids':helpers,'openHistoryDescriptors':history_fds}))
`,
    ]),
  );
  report.lastNativeStop = stopped;
  assert.deepEqual(stopped.openHistoryDescriptors, [], "History still open after native stop");
}

async function bootstrapColdNative(started) {
  const log = join(privateRoot, `cold-bootstrap-${failureNumber++}.log`);
  let bootstrapProbeTimedOut = false;
  try {
    await run("codex", ["app-server", "daemon", "bootstrap"], {
      timeout: report.budgetsMs.ready,
      log,
    });
  } catch (error) {
    // The published installer also allows the CLI's short readiness probe to
    // time out while its newly spawned real server continues initialization.
    // Never restart that server or extend the declared end-to-end cold budget.
    const diagnostic = await readFile(log, "utf8");
    if (
      !diagnostic.includes("app server did not become ready") ||
      !(await pidIdentity(true)).length
    )
      throw error;
    bootstrapProbeTimedOut = true;
  }
  await until(
    "Cold native listener created",
    async () => (await stat(nativeSocket).catch(() => null))?.isSocket(),
    Math.max(1, report.budgetsMs.ready - (Date.now() - started)),
  );
  return { bootstrapProbeTimedOut };
}

async function qualify() {
  await saveReport();
  const memoryMax = Number((await readFile(join(cgroupPath, "memory.max"), "utf8")).trim());
  const cpuMax = (await readFile(join(cgroupPath, "cpu.max"), "utf8"))
    .trim()
    .split(/\s+/)
    .map(Number);
  assert.equal(memoryMax, 10 * 1024 ** 3, "Fixture memory limit not enforced");
  assert.equal(cpuMax[0] / cpuMax[1], 4, "Fixture CPU limit not enforced");
  report.enforcedResources = { memoryMaxBytes: memoryMax, cpuQuota: cpuMax };
  const initialVersion = scope === "clean" ? candidateVersion : baseline.version;
  const initialInstaller = scope === "clean" ? "B" : "A";
  await stage(
    scope === "clean" ? "candidate-clean-installer-B" : "published-installer-A",
    async () => {
      const log = join(privateRoot, `install-${initialInstaller}.log`);
      let installationError;
      const installation = run("bash", [join(input, `install-${initialInstaller}.sh`)], {
        timeout: report.budgetsMs.build,
        log,
      }).catch((error) => {
        installationError = error;
      });
      // Building/downloads have their own budget. Startup starts at the first real PID.
      await until(
        "Installer created real service",
        async () => {
          if (installationError) throw installationError;
          try {
            return (
              Number(
                (await systemctl("show", "codexnest.service", "-p", "MainPID", "--value")).trim(),
              ) > 0
            );
          } catch {
            return false;
          }
        },
        report.budgetsMs.build,
      );
      const started = Date.now();
      const evidence = await ready(initialVersion);
      await installation;
      if (installationError) throw installationError;
      ownerToken = (await readFile(log, "utf8")).match(
        /Bearer token \(shown once\): ([^\s]+)/,
      )?.[1];
      assert.ok(ownerToken, "Real installer did not generate an owner token");
      await writeFile(join(privateRoot, "owner-token"), ownerToken, { mode: 0o600 });
      const permissions = await api("/settings/permissions", { preset: "ask" }, "PUT");
      assert.equal(permissions.preset, "ask");
      await mkdir(join(home, "qualification-project"));
      const project = await api("/projects", { path: join(home, "qualification-project") });
      projectId = project.id;
      const created = await api(`/projects/${project.id}/threads`, {
        clientCreationId: randomUUID(),
      });
      savedThread = created.thread.id;
      const requestEvidence = await request(savedThread, "initial");
      assert.ok(
        Date.now() - started <= report.budgetsMs.ready,
        "Initial ready and saved-chat response exceeded the startup budget",
      );
      const version = JSON.parse(await run("codex", ["app-server", "daemon", "version"]));
      assert.equal(version.appServerVersion, process.env.NATIVE_VERSION);
      await writeFile(join(output, "native-version.json"), `${JSON.stringify(version, null, 2)}\n`);
      // The native bootstrap command owns its control socket. Attach the fault
      // transport only after the real installer has finished bootstrapping it.
      relay = await NativeRelay.open(nativeSocket, report.originalDaemonRpc);
      return { ...evidence, ...requestEvidence };
    },
  );
  if (scope === "clean") {
    await stage("clean-install-confirmation-and-surviving-private-work", async () => {
      const health = (await ready(candidateVersion)).health;
      assert.equal(health.buildCommit, candidate);
      const journal = JSON.parse(await readFile(join(root, "recovery/journal.json"), "utf8"));
      assert.equal(journal.phase, "committed");
      assert.equal(journal.target.commit, candidate);
      assert.equal(
        (
          await systemctl("show", "codexnest-update.service", "-p", "TimeoutStopUSec", "--value")
        ).trim(),
        "7min",
        "Systemd would kill recovery before its declared deadline",
      );
      const work = await holdWork("clean-candidate-warm");
      const started = Date.now();
      await run(cli, ["restart"]);
      const recovered = { ...(await ready(candidateVersion)), ...(await finishWork(work)) };
      const recoveryMs = Date.now() - started;
      assert.ok(
        recoveryMs <= report.budgetsMs.ready,
        "Clean installed warm recovery exceeded its budget",
      );
      return {
        ...recovered,
        recoveryMs,
        confirmedBuild: candidate,
        systemdRecoveryStopSeconds: 420,
      };
    });
    return;
  }
  if (scope === "interruption") {
    await stage("old-updater-interrupted-between-pointer-and-version-write", async () => {
      const work = await holdWork("interrupted-switch");
      const oldTarget = await readlink(join(root, "current"));
      const originalCli = await readFile(cli);
      assert.equal(
        originalCli.toString(),
        await run("git", [
          "-C",
          join(root, "source"),
          "show",
          `${baseline.commit}:deploy/codexnest`,
        ]),
      );
      await control({
        manifest: { schemaVersion: 1, version: candidateVersion, commit: candidate },
      });
      await systemctl("start", "--no-block", "codexnest-update.service");
      const updaterPid = await until("Actual updater process started", async () => {
        const pid = Number(
          (await systemctl("show", "codexnest-update.service", "-p", "MainPID", "--value")).trim(),
        );
        return pid > 1 ? pid : null;
      });
      // A real FIFO blocks the unchanged script's shell redirection at its
      // existing server.env.$$ write. No updater, RPC or systemctl is mocked.
      const fifo = join(home, `.config/codexnest/server.env.${updaterPid}`);
      await run("mkfifo", ["--mode=600", fifo]);
      let interruptedAt;
      try {
        await until(
          "Old updater switched the real current pointer",
          async () => {
            const current = await readlink(join(root, "current"));
            const raw = await readFile(statusPath, "utf8").catch((error) => {
              if (error.code === "ENOENT") return null;
              throw error;
            });
            if (!raw) return false;
            const status = JSON.parse(raw);
            if (status.result === "failed")
              throw new Error(`Update failed before injection: ${status.message}`);
            return current.endsWith(`/v${candidateVersion}`);
          },
          report.budgetsMs.build,
        );
        assert.ok((await stat(fifo)).isFIFO());
        const config = await readFile(join(home, ".config/codexnest/server.env"), "utf8");
        assert.equal(config.match(/^CODEXNEST_VERSION=(.*)$/m)?.[1], baseline.version);
        interruptedAt = Date.now();
        report.interruption = {
          point: "current switched; existing version write blocked before mutation",
          originalUpdaterSha256: createHash("sha256").update(originalCli).digest("hex"),
          updaterPid,
          observations: [],
        };
        await systemctl("kill", "--kill-whom=all", "--signal=SIGKILL", "codexnest-update.service");
      } finally {
        await unlink(fifo);
      }
      await until(
        "Interrupted updater automatically restored A",
        async () => {
          const current = await readlink(join(root, "current"));
          const state = JSON.parse(await readFile(statusPath, "utf8"));
          const value = await health();
          const observation = {
            afterMs: Date.now() - interruptedAt,
            pointer: current === oldTarget ? "baseline" : "candidate",
            healthVersion: value?.serverVersion ?? null,
            recovery: value?.recoveryState ?? "unavailable",
            updaterOperation: state.operation,
            updaterResult: state.result,
          };
          const signature = JSON.stringify({ ...observation, afterMs: 0 });
          if (report.interruption.observations.at(-1)?.signature !== signature) {
            report.interruption.observations.push({ ...observation, signature });
            await saveReport();
          }
          return (
            current === oldTarget &&
            value?.serverVersion === baseline.version &&
            value.recoveryState === "ready" &&
            state.operation === "idle" &&
            ["failed", "rolled_back"].includes(state.result)
          );
        },
        Math.max(1, report.budgetsMs.rollback - (Date.now() - interruptedAt)),
      );
      const recovered = { ...(await ready(baseline.version)), ...(await finishWork(work)) };
      const fullRecoveryMs = Date.now() - interruptedAt;
      assert.ok(fullRecoveryMs <= report.budgetsMs.rollback);
      return { ...recovered, fullRecoveryMs };
    });
    return;
  }
  await stage("representative-synthetic-history-files", async () => {
    await stopNative();
    await run("python3", [join(input, "history.py"), "create", savedThread], { timeout: 180_000 });
    return JSON.parse(await readFile(join(output, "history-profile.json"), "utf8"));
  });
  await stage("actual-native-import-and-metadata-index-rebuild", async () => {
    const started = Date.now();
    // This constructs valid current-format data before measured cold starts.
    // A paginated JSONL file alone has no SQLite turns view. Native's own writer
    // builds that view; never synthesize its SQL or call an empty view success.
    await run("codex", ["app-server", "daemon", "bootstrap"]);
    const history = JSON.parse(await readFile(join(privateRoot, "history-manifest.json"), "utf8"));
    let next = 0;
    await nativeRpc(async (rpc) => {
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          while (next < history.length) {
            assert.ok(
              Date.now() - started < report.budgetsMs.fixtureImport,
              "Native fixture import budget exceeded",
            );
            const row = history[next++];
            await rpc("thread/resume", {
              threadId: row.id,
              cwd: join(home, "qualification-project"),
              excludeTurns: true,
            });
            // Archiving flushes the real writer and unloads its in-memory
            // conversation, keeping construction within the fixture RAM limit.
            await rpc("thread/archive", { threadId: row.id });
            if (row.kind !== "archived") await rpc("thread/unarchive", { threadId: row.id });
            const { thread } = await rpc("thread/read", { threadId: row.id, includeTurns: false });
            assert.ok(thread.path?.startsWith(`${home}/.codex/`));
            row.path = thread.path;
            if (next % 100 === 0)
              process.stdout.write(`Native fixture import: ${next}/${history.length}\n`);
          }
        }),
      );
    });
    await writeFile(join(privateRoot, "history-manifest.json"), JSON.stringify(history));
    await stopNative();
    await run("python3", [join(input, "history.py"), "freeze"], { timeout: 180_000 });
    assert.ok(
      Date.now() - started <= report.budgetsMs.fixtureImport,
      "Native fixture construction budget exceeded",
    );
    return {
      importedNativeHistories: history.length,
      fixtureImportMs: Date.now() - started,
      ...JSON.parse(await readFile(join(output, "history-profile.json"), "utf8")),
    };
  });
  for (let index = 1; index <= 3; index++) {
    await stage(`cold-A-${index}`, async () => {
      await run("python3", [join(input, "history.py"), "evict"]);
      const started = Date.now();
      const bootstrap = await bootstrapColdNative(started);
      relay = await NativeRelay.open(nativeSocket, report.originalDaemonRpc);
      await systemctl("start", "codexnest.service");
      const evidence = await ready(
        baseline.version,
        Math.max(1, report.budgetsMs.ready - (Date.now() - started)),
      );
      evidence.totalRecoveryMs = Date.now() - started;
      const indexEvidence = await verifyIndex();
      const requestEvidence = await request(savedThread, `cold-A-${index}`);
      if (index < 3) {
        await stopNative();
      }
      return { ...bootstrap, ...evidence, ...indexEvidence, ...requestEvidence };
    });
  }
  for (let index = 1; index <= 3; index++) {
    await stage(`warm-A-${index}`, async () => {
      const work = await holdWork(`warm-A-${index}`);
      const started = Date.now();
      await run(cli, ["restart"]);
      assert.ok(
        Date.now() - started <= report.budgetsMs.ready,
        "Warm restart exceeded startup budget",
      );
      return { ...(await ready(baseline.version)), ...(await finishWork(work)) };
    });
  }
  await stage("installed-old-updater-A-to-B", async () => {
    const work = await holdWork("upgrade");
    return {
      ...(await update("updated")),
      ...(await ready(candidateVersion)),
      ...(await finishWork(work)),
      ...(await request(savedThread, "upgraded")),
    };
  });
  for (let index = 1; index <= 3; index++) {
    await stage(`cold-B-${index}`, async () => {
      await stopNative();
      await run("python3", [join(input, "history.py"), "evict"]);
      const started = Date.now();
      const bootstrap = await bootstrapColdNative(started);
      relay = await NativeRelay.open(nativeSocket, report.originalDaemonRpc);
      await systemctl("start", "codexnest.service");
      const evidence = await ready(
        candidateVersion,
        Math.max(1, report.budgetsMs.ready - (Date.now() - started)),
      );
      evidence.totalRecoveryMs = Date.now() - started;
      return {
        ...bootstrap,
        ...evidence,
        ...(await verifyIndex()),
        ...(await request(savedThread, `cold-B-${index}`)),
      };
    });
  }
  await stage("transient-native-timeout-recovers-readiness", async () => {
    const work = await holdWork("transient-native-timeout");
    const delayedBefore = relay.delayedResponseCount("thread/list");
    relay.hold("thread/list", 35_000, true);
    const started = Date.now();
    await systemctl("restart", "codexnest.service");
    const serverPid = (
      await systemctl("show", "codexnest.service", "-p", "MainPID", "--value")
    ).trim();
    let observedFailed = false;
    const evidence = await ready(
      candidateVersion,
      Math.max(1, report.budgetsMs.ready - (Date.now() - started)),
      (health) => {
        if (health?.recoveryState === "failed") observedFailed = true;
      },
    );
    assert.ok(observedFailed, "The injected response did not exercise the real RPC timeout");
    assert.ok(
      relay.delayedResponseCount("thread/list") > delayedBefore,
      "Startup did not traverse the injected native transport",
    );
    assert.equal(
      (await systemctl("show", "codexnest.service", "-p", "MainPID", "--value")).trim(),
      serverPid,
      "Recovery required another application restart",
    );
    return {
      ...evidence,
      observedFailed,
      totalRecoveryMs: Date.now() - started,
      ...(await finishWork(work)),
    };
  });
  await stage("temporary-native-transport-unavailable", async () => {
    const work = await holdWork("temporary-native-unavailable");
    const started = Date.now();
    relay.disconnect(15_000);
    await until(
      "Bridge observed loss",
      async () => (await health())?.appServer?.state !== "ready",
      10_000,
    );
    return {
      ...(await ready(
        candidateVersion,
        Math.max(1, report.budgetsMs.ready - (Date.now() - started)),
      )),
      ...(await finishWork(work)),
      totalRecoveryMs: Date.now() - started,
    };
  });
  for (let index = 1; index <= 3; index++) {
    await stage(`warm-B-${index}`, async () => {
      const work = await holdWork(`warm-B-${index}`);
      const started = Date.now();
      await run(cli, ["restart"]);
      assert.ok(
        Date.now() - started <= report.budgetsMs.ready,
        "Warm restart exceeded startup budget",
      );
      return { ...(await ready(candidateVersion)), ...(await finishWork(work)) };
    });
  }
  await stage("restore-A-before-failed-upgrade", async () => {
    const identity = await pidIdentity();
    await run(cli, ["rollback"]);
    return {
      ...(await ready(baseline.version)),
      ...(await assertSurviving(identity)),
      ...(await request(savedThread, "restored")),
    };
  });
  for (const mode of ["wrong-version", "no-http", "no-token", "slow-rpc", "rotated-auth"]) {
    await stage(`failed-B-automatic-A-${mode}`, async () => {
      await fault(mode);
      const work = await holdWork(mode);
      const delayedBefore = relay.delayedResponseCount("thread/list");
      if (mode === "slow-rpc") relay.hold("thread/list", 145_000, true);
      const updateEvidence = await update(
        "rolled_back",
        ["wrong-version", "no-token", "rotated-auth"].includes(mode)
          ? async () => {
              await until("Candidate reached real recovery state", async () => {
                const value = await health();
                return (
                  value?.serverVersion === "0.0.0-qualification" && value.recoveryState === "ready"
                );
              });
              await assert.rejects(
                api(`/projects/${projectId}/threads`, { clientCreationId: randomUUID() }),
                (error) => error.status === 503,
                "Unconfirmed candidate accepted new native work",
              );
              const approval = (await snapshot()).attention.find(
                (request) =>
                  request.threadId === work.approvalThread && request.kind === "commandApproval",
              );
              assert.ok(approval);
              await assert.rejects(
                api(`/attention/${approval.id}/respond`, { kind: "approval", decision: "accept" }),
                (error) => error.status === 503,
                "Unconfirmed candidate accepted an approval",
              );
              if (mode === "no-token") {
                await unlink(join(home, ".local/state/codexnest/restart-token"));
              } else if (mode === "rotated-auth") {
                // Rotate through the same surviving real daemon while B is
                // running. Foreground candidate work remains admission-blocked.
                const before = (await control()).oauthGeneration;
                await nativeRpc((rpc) =>
                  rpc("getAuthStatus", { includeToken: true, refreshToken: true }),
                );
                const after = await control();
                assert.ok(
                  after.oauthGeneration > before,
                  "Real native OAuth rotation was not exercised",
                );
                assert.equal(after.directOAuthRequests, 0, "OAuth bypassed the account proxy");
              }
            }
          : mode === "slow-rpc"
            ? async () => {
                await until(
                  "Candidate sync response delayed",
                  async () => relay.delayedResponseCount("thread/list") > delayedBefore,
                );
                await until(
                  "Rollback started while native RPC was still delayed",
                  async () => {
                    assert.ok(relay.holding(), "Native delay ended before rollback began");
                    const value = await health();
                    if (value?.serverVersion !== baseline.version) return false;
                    assert.notEqual(value.recoveryState, "ready");
                    return true;
                  },
                  180_000,
                );
              }
            : undefined,
      );
      const confirmedAt = Date.now();
      const recovered = {
        ...(await ready(baseline.version)),
        ...(await finishWork(work)),
        ...(await request(savedThread, `rolled-back-${mode}`)),
      };
      const fullRecoveryMs = updateEvidence.recoveryMs + Date.now() - confirmedAt;
      assert.ok(
        fullRecoveryMs <= report.budgetsMs.rollback,
        "Recovered work exceeded rollback budget",
      );
      return { ...updateEvidence, ...recovered, fullRecoveryMs };
    });
  }
  await fault("none");
  await stage("unavailable-native-refuses-update-with-active-work", async () => {
    const work = await holdWork("permanent-native-unavailable");
    relay.disconnect(Infinity);
    let rejected;
    try {
      await until(
        "Native is persistently unavailable",
        async () => (await health())?.appServer?.state === "unavailable",
      );
      rejected = await rejectUpdate(/preflight|cannot recover|cannot safely recover/i);
      assert.notEqual((await health())?.appServer?.state, "ready");
    } finally {
      relay.reconnect();
    }
    return { ...rejected, ...(await ready(baseline.version)), ...(await finishWork(work)) };
  });
  await stage("artifact-download-failure-keeps-A", async () => {
    const work = await holdWork("artifact-download");
    await control({ registryUnavailable: true });
    let rejected;
    try {
      rejected = await rejectUpdate(/Failed to build/);
    } finally {
      await control({ registryUnavailable: false });
    }
    return { ...rejected, ...(await ready(baseline.version)), ...(await finishWork(work)) };
  });
  await stage("incompatible-artifact-protocol-keeps-A", async () => {
    const work = await holdWork("incompatible-protocol");
    const path = join(root, "releases", `v${candidateVersion}`, "deploy/restart-protocol.json");
    const original = await readFile(path);
    const incompatible = JSON.parse(original);
    incompatible.runtimeRecoveryProtocolVersion = 3;
    await writeFile(path, JSON.stringify(incompatible));
    let rejected;
    try {
      rejected = await rejectUpdate(/preflight|cannot recover|cannot safely recover/i);
    } finally {
      await writeFile(path, original);
    }
    return { ...rejected, ...(await ready(baseline.version)), ...(await finishWork(work)) };
  });
  await stage("failed-state-checkpoint-keeps-A", async () => {
    const work = await holdWork("state-checkpoint");
    const path = join(home, ".local/state/codexnest/state.json");
    const backup = join(privateRoot, "legacy-state-before-checkpoint-fault.json");
    await rename(path, backup);
    await mkdir(path);
    let rejected;
    try {
      rejected = await rejectUpdate(/preflight|internal server error|EISDIR|directory/i);
    } finally {
      await rmdir(path);
      await rename(backup, path);
    }
    return { ...rejected, ...(await ready(baseline.version)), ...(await finishWork(work)) };
  });
  await stage("missing-build-dependency-keeps-A", async () => {
    const work = await holdWork("build-dependency");
    const npm = join(root, "runtime/current/bin/npm");
    const backup = join(root, "runtime/current/bin/npm.qualification-unavailable");
    await unlink(join(root, "releases", `v${candidateVersion}`, ".codexnest-built"));
    await rename(npm, backup);
    let rejected;
    try {
      rejected = await rejectUpdate(/Failed to build/);
    } finally {
      await rename(backup, npm);
    }
    return { ...rejected, ...(await ready(baseline.version)), ...(await finishWork(work)) };
  });
  await stage("repeat-upgrade-after-failed-candidates", async () => {
    await fault("none");
    const work = await holdWork("repeat-upgrade");
    return {
      ...(await update("updated")),
      ...(await ready(candidateVersion)),
      ...(await finishWork(work)),
      ...(await request(savedThread, "repeated-upgrade")),
    };
  });
  await stage("history-integrity-after-rollback", async () => {
    await run("python3", [join(input, "history.py"), "check"], { timeout: 120_000 });
    return verifyIndex();
  });
  // This diagnostic job must never be mistaken for the policy's complete gate.
  // Publication remains technically closed until every pending case is implemented.
  process.stdout.write(
    `Lifecycle diagnostics complete; releaseQualified=false; pending=${report.pending.length}\n`,
  );
}

try {
  await qualify();
} catch (error) {
  process.stderr.write(`Qualification stopped: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  report.fixtureCounters = await control().catch(() => null);
  await relay?.close().catch((error) => {
    report.relayCleanupError = error.code ?? error.name;
    process.exitCode = 1;
  });
  report.memoryPeakBytes = Number(
    (await readFile(join(cgroupPath, "memory.peak"), "utf8").catch(() => "NaN")).trim(),
  );
  await run("python3", [
    "-c",
    `
from pathlib import Path
import re
root=Path('${home}/.codex')
logs=list(root.glob('app-server*/**/*stderr.log'))
lines=[]
for path in logs:
    lines.append('Native diagnostic '+path.name)
    for line in path.read_text(errors='replace').splitlines()[-50:]:
        if re.search(r'bearer|authorization|access.token|refresh.token|id.token',line,re.I): continue
        lines.append(re.sub(r'eyJ[\\w-]+\\.[\\w-]+\\.[\\w-]+','[redacted]',line))
Path('${output}/native-errors.log').write_text('\\n'.join(lines)+'\\n')
`,
  ]).catch(() => undefined);
  await saveReport();
}
