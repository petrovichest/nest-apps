import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire("/opt/qualification/package.json");
const WebSocket = require("ws");
const home = "/home/nest-qualification";
assert.equal(process.getuid(), 17001);
assert.equal(process.env.HOME, home);
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
const report = {
  candidate,
  baseline,
  native: process.env.NATIVE_VERSION,
  resources: { cpus: 4, memoryGiB: 10 },
  budgetsMs: { ready: 60_000, updaterHealth: 120_000, rollback: 420_000, build: 600_000 },
  cases: [],
  releaseQualified: false,
  pending: [
    "pending native approvals and managed background task results",
    "slow native RPC, unavailable daemon and transient recovery",
    "OAuth expiry and rotation through the surviving native daemon",
    "updater interruption at each switch/checkpoint/confirmation boundary",
    "protocol, artifact download/build and persistent state failure matrix",
    "candidate clean installer and other packaged applications",
  ],
};
let ownerToken;
let savedThread;
let failureNumber = 0;

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
  assert.ok(response.ok, `API ${method} ${path}: HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}

async function health() {
  try {
    return await api("/health");
  } catch {
    return null;
  }
}

async function ready(version, timeout = report.budgetsMs.ready) {
  const started = Date.now();
  const result = await until(
    `Ready ${version}`,
    async () => {
      const value = await health();
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
  );
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

async function pidIdentity() {
  return JSON.parse(
    await run("python3", [
      "-c",
      `
import json,os
from pathlib import Path
result=[]
for proc in Path('/proc').iterdir():
    if not proc.name.isdigit(): continue
    try:
        if proc.stat().st_uid != 17001: continue
        exe=os.readlink(proc/'exe')
        command=(proc/'cmdline').read_bytes().split(b'\\0')
        if Path(exe).name == 'codex' and b'app-server' in command:
            result.append({'pid':int(proc.name),'startTime':(proc/'stat').read_text().split(') ',1)[1].split()[19]})
    except (OSError,ValueError): pass
print(json.dumps(result))
`,
    ]),
  );
}

async function assertSurviving(previous) {
  assert.ok(previous.length, "Original native PID identity missing");
  const current = await pidIdentity();
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
    const detail = await api(`/threads/${thread}`);
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

async function nativeRpc(action) {
  const socket = new WebSocket(`ws+unix://${nativeSocket}:/`, { perMessageDeflate: false });
  let sequence = 0;
  const pending = new Map();
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Native RPC budget exceeded: ${method}`));
      }, 30_000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.method || !pending.has(message.id)) return;
    const entry = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error)
      entry.reject(new Error(`Native RPC returned error code ${message.error.code}`));
    else entry.resolve(message.result);
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
    assert.ok(long.thread.turns.length >= history[0].turns, "Long history lost turns");
    assert.ok((await snapshot()).threads.length >= 2000, "Nest omitted large history");
    return { index: counts, longThreadTurns: long.thread.turns.length };
  });
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
  return { held, queued, identity: await pidIdentity() };
}

async function finishWork(work) {
  const identity = await assertSurviving(work.identity);
  const detail = await api(`/threads/${savedThread}`);
  assert.ok(detail.summary.currentTurnId, "Active native turn lost during restart");
  assert.equal(detail.queuedMessages.length, 1, "Queued message lost or dispatched early");
  const state = await control();
  await control({ released: [...state.released, work.held] });
  await completed(savedThread, work.queued);
  const final = await control();
  assert.equal(final.requests[work.held], 1, "Active request replayed");
  assert.equal(final.requests[work.queued], 1, "Queued request replayed");
  return { ...identity, activeRequestCount: 1, queuedRequestCount: 1 };
}

async function update(expectedResult) {
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
  const state = await until(
    `Updater ${expectedResult}`,
    async () => {
      const value = JSON.parse(await readFile(statusPath, "utf8"));
      if (value.operation === "idle" && value.result === "failed")
        throw new Error(`Automatic recovery failed: ${value.message}`);
      return value.operation === "idle" && value.result === expectedResult ? value : null;
    },
    expectedResult === "updated" ? report.budgetsMs.ready : report.budgetsMs.rollback,
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
  ${mode === "no-http" ? "export CODEXNEST_PORT=0" : "export CODEXNEST_VERSION=0.0.0-qualification"}
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

async function stopNative() {
  await systemctl("stop", "codexnest.service");
  const units = (
    await systemctl("list-units", "--all", "--plain", "--no-legend", "codexnest-account-*.service")
  )
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((unit) => /^codexnest-account-[0-9a-f-]+\.service$/.test(unit));
  if (units.length) await systemctl("stop", ...units);
  await run("codex", ["app-server", "daemon", "stop"]);
  assert.equal((await pidIdentity()).length, 0, "Native still running during cold fixture setup");
}

try {
  await saveReport();
  await stage("published-installer-A", async () => {
    const log = join(privateRoot, "install-A.log");
    let installationError;
    const installation = run("bash", [join(input, "install-A.sh")], {
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
    const evidence = await ready(baseline.version);
    await installation;
    if (installationError) throw installationError;
    ownerToken = (await readFile(log, "utf8")).match(/Bearer token \(shown once\): ([^\s]+)/)?.[1];
    assert.ok(ownerToken, "Real installer did not generate an owner token");
    await writeFile(join(privateRoot, "owner-token"), ownerToken, { mode: 0o600 });
    await mkdir(join(home, "qualification-project"));
    const project = await api("/projects", { path: join(home, "qualification-project") });
    const created = await api(`/projects/${project.id}/threads`, {
      clientCreationId: randomUUID(),
    });
    savedThread = created.thread.id;
    return { ...evidence, ...(await request(savedThread, "initial")) };
  });
  await stage("representative-history-and-native-index-rebuild", async () => {
    await stopNative();
    await run("python3", [join(input, "history.py"), "create", savedThread], { timeout: 180_000 });
    return JSON.parse(await readFile(join(output, "history-profile.json"), "utf8"));
  });
  for (let index = 1; index <= 3; index++) {
    await stage(`cold-A-${index}`, async () => {
      await run("python3", [join(input, "history.py"), "evict"]);
      const started = Date.now();
      await run("codex", ["app-server", "daemon", "bootstrap"]);
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
      return { ...evidence, ...indexEvidence, ...requestEvidence };
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
      await run("codex", ["app-server", "daemon", "bootstrap"]);
      await systemctl("start", "codexnest.service");
      const evidence = await ready(
        candidateVersion,
        Math.max(1, report.budgetsMs.ready - (Date.now() - started)),
      );
      evidence.totalRecoveryMs = Date.now() - started;
      return {
        ...evidence,
        ...(await verifyIndex()),
        ...(await request(savedThread, `cold-B-${index}`)),
      };
    });
  }
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
  for (const mode of ["wrong-version", "no-http"]) {
    await stage(`failed-B-automatic-A-${mode}`, async () => {
      await fault(mode);
      const work = await holdWork(mode);
      return {
        ...(await update("rolled_back")),
        ...(await ready(baseline.version)),
        ...(await finishWork(work)),
        ...(await request(savedThread, `rolled-back-${mode}`)),
      };
    });
  }
  await stage("history-integrity-after-rollback", async () => {
    await run("python3", [join(input, "history.py"), "check"], { timeout: 120_000 });
    return verifyIndex();
  });
  // This diagnostic job must never be mistaken for the policy's complete gate.
  // Publication remains technically closed until every pending case is implemented.
  process.stdout.write(
    `Lifecycle diagnostics complete; releaseQualified=false; pending=${report.pending.length}\n`,
  );
} catch (error) {
  process.stderr.write(`Qualification stopped: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  await saveReport();
}
