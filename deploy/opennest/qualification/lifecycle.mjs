import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  access,
  cp,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { NativeRelay } from "./native-relay.mjs";

const home = "/home/opennest-qualification",
  input = "/opennest-qualification-input",
  output = "/opennest-qualification-output",
  privateRoot = "/opennest-qualification-private";
assert.equal(process.getuid(), 17002);
assert.equal(process.env.HOME, home);
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(
  await readFile(join(home, ".opennest-qualification"), "utf8"),
  "OpenNest synthetic qualification fixture v1\n",
);
const candidate = (await readFile(join(input, "candidate-sha"), "utf8")).trim(),
  baseline = (await readFile(join(input, "baseline-sha"), "utf8")).trim();
const baselineDiagnostic = process.env.OPENNEST_DIAGNOSTIC_STARTUP_ONLY === "1";
const baselineRuntime = process.env.OPENNEST_QUALIFICATION_BASELINE_RUNTIME ?? "opencode";
assert.ok(["opencode", "claude"].includes(baselineRuntime));
for (const value of [candidate, baseline]) assert.match(value, /^[0-9a-f]{40}$/);
const version = (sha) =>
  sha === baseline && process.env.OPENNEST_QUALIFICATION_BASELINE_VERSION
    ? process.env.OPENNEST_QUALIFICATION_BASELINE_VERSION
    : `0.1.9-${sha.slice(0, 7)}`;
const root = join(home, ".local/share/opennest"),
  state = join(home, ".local/state/opennest"),
  configuration = join(home, ".config/opennest"),
  envPath = join(configuration, "server.env"),
  units = join(home, ".config/systemd/user"),
  nativeData = join(home, ".local/share/opencode"),
  database = join(nativeData, "opencode.db");
const report = {
  schemaVersion: 1,
  app: "opennest",
  candidate,
  native: "1.19.5",
  baseline: {
    commit: baseline,
    kind: process.env.OPENNEST_QUALIFICATION_BASELINE_KIND || "first-release",
    runtime: baselineRuntime,
    healthy: false,
    independentlyQualified: false,
    installerSha256: (await readFile(join(output, "baseline-installer-sha256.txt"), "utf8")).split(
      /\s/,
    )[0],
  },
  installerSha256: (await readFile(join(output, "candidate-installer-sha256.txt"), "utf8")).split(
    /\s/,
  )[0],
  completed: false,
  pending: [],
  cases: [],
  workload: null,
  budgetsMs: { ready: 30000, updaterHealth: 60000, rollback: 420000 },
  runs: { coldA: [], warmA: [], coldB: [], warmB: [] },
  resources: null,
  fixtureCounters: null,
  rollback: {
    automatic: false,
    previousReady: false,
    workResumed: false,
    nativePidPreserved: false,
    stateIntact: false,
    durationMs: 0,
  },
};
const relayControlToken = randomUUID();
let commandNumber = 0,
  token,
  profile,
  firstProject,
  seed,
  relay;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );
const save = () =>
  writeFile(join(output, "lifecycle.json"), JSON.stringify(report, null, 2) + "\n");
async function stage(name, action) {
  process.stdout.write(`OpenNest native qualification: ${name}\n`);
  const started = Date.now();
  try {
    const evidence = await action();
    report.cases.push({
      name,
      status: "passed",
      durationMs: Math.max(1, Date.now() - started),
      ...(evidence || {}),
    });
  } catch (error) {
    report.cases.push({
      name,
      status: "failed",
      durationMs: Math.max(1, Date.now() - started),
      error: String(error.message).slice(0, 1000),
    });
    throw error;
  } finally {
    await save();
  }
}
async function run(command, args, { timeout = 120000, env = {}, allowFailure = false } = {}) {
  const log = createWriteStream(join(privateRoot, `command-${commandNumber++}.log`), {
    mode: 0o600,
  });
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let text = "";
  child.stdout.on("data", (chunk) => {
    log.write(chunk);
    text = (text + chunk).slice(-2 * 1024 * 1024);
  });
  child.stderr.on("data", (chunk) => log.write(chunk));
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Command exceeded its fixed budget: ${command}`));
    }, timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (value) => {
      clearTimeout(timer);
      log.end();
      resolve(value);
    });
  });
  if (code !== 0 && !allowFailure)
    throw new Error(`Command failed: ${command} (exit ${code}); private command log retained`);
  return { text, code };
}
const systemctl = (...args) => run("systemctl", ["--user", ...args]);
async function until(name, action, budget = 60000) {
  const deadline = Date.now() + budget;
  let last;
  while (Date.now() < deadline) {
    try {
      const result = await action();
      if (result && Date.now() <= deadline) return result;
    } catch (error) {
      last = error;
    }
    await delay(100);
  }
  throw new Error(`${name} exceeded ${budget} ms${last ? `: ${last.message}` : ""}`);
}
async function fetchJSON(url, body, authorization, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(url, {
    method,
    headers: {
      ...(authorization ? { authorization } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  const raw = await response.text();
  if (!response.ok)
    throw Object.assign(new Error(`${method} ${new URL(url).pathname}: HTTP ${response.status}`), {
      status: response.status,
    });
  return raw ? JSON.parse(raw) : null;
}
const api = (path, body, method) =>
  fetchJSON(`http://127.0.0.1:4313/api/v1${path}`, body, `Bearer ${token}`, method);
const control = (body) => fetchJSON(`http://127.0.0.1:9052/${body ? "control" : "state"}`, body);
async function configurationValues() {
  const result = {};
  for (const line of (await readFile(envPath, "utf8")).split("\n")) {
    const match = /^([A-Z_a-z][A-Z_a-z0-9]*)=(.*)$/.exec(line);
    if (match) result[match[1]] = match[2].startsWith('"') ? JSON.parse(match[2]) : match[2];
  }
  return result;
}
async function writeConfiguration(values) {
  await writeFile(
    envPath,
    Object.entries(values)
      .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
      .join("\n") + "\n",
    { mode: 0o600 },
  );
}
async function native(path, body, directory, method) {
  const config = await configurationValues();
  const endpoint = new URL(`http://127.0.0.1:4097${path}`);
  if (directory) endpoint.searchParams.set("directory", directory);
  return fetchJSON(
    endpoint,
    body,
    `Basic ${Buffer.from(`${config.OPENCODE_SERVER_USERNAME}:${config.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`,
    method,
  );
}
async function identity() {
  const wrapper = Number(
    (
      await systemctl("show", "opennest-daemon.service", "--property=MainPID", "--value")
    ).text.trim(),
  );
  assert.ok(Number.isSafeInteger(wrapper) && wrapper > 1);
  const children = (await readFile(`/proc/${wrapper}/task/${wrapper}/children`, "utf8"))
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
  const binary = await realpath(process.env.OPENNEST_OPENCODE_BIN);
  const matching = [];
  for (const pid of children)
    if ((await readlink(`/proc/${pid}/exe`).catch(() => "")) === binary) matching.push(pid);
  assert.equal(matching.length, 1, "A real surviving OpenCode child process is required");
  return { wrapper, native: matching[0] };
}
async function sameIdentity(expected) {
  assert.deepEqual(await identity(), expected, "The actual OpenCode process changed");
}
async function apiPid() {
  const pid = Number(
    (await systemctl("show", "opennest.service", "--property=MainPID", "--value")).text.trim(),
  );
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  return pid;
}
async function ready(expected = version(baseline), budget = 30000, runtime = "1.19.5") {
  return until(
    "Native application readiness",
    async () => {
      const health = await api("/health");
      return (
        health.app === "opennest" &&
        health.provider === "open" &&
        health.status === "ok" &&
        health.serverVersion === expected &&
        health.recoveryState === "ready" &&
        health.restartProtocolVersion === 1 &&
        health.appServer?.state === "ready" &&
        health.appServer.installedVersion === runtime &&
        health
      );
    },
    budget,
  );
}
async function serviceStartupElapsed(
  includeNative = false,
  phase = "service-ready-with-work",
  enforceBudget = true,
) {
  const started = [];
  for (const unit of includeNative
    ? ["opennest.service", "opennest-daemon.service"]
    : ["opennest.service"]) {
    const timestamp = Number(
      (
        await systemctl("show", unit, "--property=ExecMainStartTimestampMonotonic", "--value")
      ).text.trim(),
    );
    assert.ok(timestamp > 0 && Number.isFinite(timestamp));
    started.push(timestamp / 1000);
  }
  // systemd's timestamp and hrtime both use CLOCK_MONOTONIC. /proc/uptime
  // includes suspend time (CLOCK_BOOTTIME), so it is diagnostic only.
  const monotonicMs = Number(process.hrtime.bigint()) / 1e6;
  const bootTimeMs = Number((await readFile("/proc/uptime", "utf8")).split(" ")[0]) * 1000;
  const earliestStartMs = Math.min(...started);
  assert.ok(monotonicMs >= earliestStartMs, "Service start is outside the monotonic clock domain");
  const elapsed = Math.max(1, Math.ceil(monotonicMs - earliestStartMs));
  const measurement = {
    phase,
    startedMonotonicMs: started,
    checkedMonotonicMs: monotonicMs,
    checkedBootTimeMs: bootTimeMs,
    bootMinusMonotonicMs: bootTimeMs - monotonicMs,
    elapsedMs: elapsed,
  };
  (report.serviceTimings ??= []).push(measurement);
  await save();
  process.stdout.write(`OpenNest service timing: ${JSON.stringify(measurement)}\n`);
  if (enforceBudget)
    assert.ok(
      elapsed <= 30000,
      `Real service startup/recovery exceeded half its updater health budget: ${elapsed} ms (${phase})`,
    );
  return elapsed;
}
const textOf = (detail) =>
  detail.turns
    .flatMap((turn) => turn.items)
    .filter((item) => item.type === "agentMessage")
    .map((item) => item.text)
    .join("");
async function thread() {
  return (await api(`/projects/${firstProject.id}/threads`, { clientCreationId: randomUUID() }))
    .thread;
}
async function send(id, kind, marker, queue = false) {
  return api(`/threads/${id}/${queue ? "queue" : "turns"}`, {
    input: `QUALIFICATION_${kind}:${marker}`,
    clientMessageId: marker,
  });
}
async function finish(id, marker) {
  return until(`Native work ${marker}`, async () => {
    const detail = await api(`/threads/${id}`);
    return (
      detail.turns.some((turn) =>
        turn.items.some(
          (item) =>
            item.type === "agentMessage" &&
            item.phase === "final_answer" &&
            item.text.includes(marker),
        ),
      ) && detail
    );
  });
}
async function finishApproved(id, marker) {
  let approvals = 0;
  return until(`Approved native work ${marker}`, async () => {
    const detail = await api(`/threads/${id}`);
    if (
      detail.turns.some((turn) =>
        turn.items.some(
          (item) =>
            item.type === "agentMessage" &&
            item.phase === "final_answer" &&
            item.text.includes(marker),
        ),
      )
    )
      return detail;
    for (const request of (await api("/attention")).filter(
      (item) => item.threadId === id && item.kind === "commandApproval",
    )) {
      assert.ok(++approvals <= 4, "Unexpected repeated approval in controlled native work");
      await api(`/attention/${encodeURIComponent(request.id)}/respond`, {
        kind: "approval",
        decision: "accept",
      });
    }
    return false;
  });
}
async function sampleHistory() {
  const snapshot = await api("/snapshot"),
    ids = new Set(snapshot.threads.map((item) => item.id));
  assert.ok(
    ids.size >= profile.nonArchivedSessions,
    "Complete native history inventory was truncated",
  );
  const sample =
    profile.samples.find((item) => item.kind === "live" && item.turns < 160) || profile.samples[0];
  const detail = await api(`/threads/${sample.id}`),
    turns = new Set(detail.turns.map((turn) => turn.id));
  assert.ok(
    turns.has(sample.firstUser) && turns.has(sample.lastUser),
    "Saved native conversation was truncated",
  );
  return sample;
}
async function savedWork(expected) {
  await ready(expected);
  const sample = await sampleHistory();
  const marker = `saved-${randomUUID()}`;
  await send(sample.id, "REQUEST", marker);
  await finish(sample.id, marker);
  return true;
}
async function history(operation) {
  return run(
    "python3",
    [join(input, "history.py"), operation, "--home", home, "--database", database],
    { timeout: 300000 },
  );
}
async function nativeHistoryIntegrity() {
  await history("verify");
  for (const sample of profile.samples) {
    const messages = await native(`/session/${sample.id}/message`, undefined, sample.directory);
    assert.ok(messages.some((message) => message.info.id === sample.firstUser));
    assert.ok(messages.some((message) => message.info.id === sample.lastAnswer));
  }
  const sessionId = profile.samples[0].id;
  const first = await api(`/threads/${sessionId}/search?q=QUALIFICATION_HISTORY`);
  assert.ok(
    first.data.length > 0 && first.nextCursor,
    "Long native history search did not return a continuation",
  );
  const second = await api(
    `/threads/${sessionId}/search?q=QUALIFICATION_HISTORY&cursor=${encodeURIComponent(first.nextCursor)}`,
  );
  assert.ok(second.data.length > 0);
  const original = new Set(first.data.map((hit) => hit.itemId));
  assert.ok(
    second.data.every((hit) => !original.has(hit.itemId)),
    "Native search pages repeated occurrences",
  );
  const manifest = JSON.parse(await readFile(join(privateRoot, "history-manifest.json"), "utf8")),
    document = manifest.files[0];
  assert.ok(document);
  const ticket = await api(`/threads/${document.sessionId}/downloads`, { path: document.path });
  const response = await fetch(`http://127.0.0.1:4313${ticket.downloadUrl}`, {
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200);
  assert.equal(
    sha(Buffer.from(await response.arrayBuffer())),
    document.sha256,
    "Native-referenced document download changed",
  );
  const globalFirst = await api("/threads/search?q=QUALIFICATION_HISTORY&scope=messages");
  assert.ok(
    globalFirst.data.length > 0 && globalFirst.nextCursor,
    "Global native history search omitted pages",
  );
  const globalSecond = await api(
    `/threads/search?q=QUALIFICATION_HISTORY&scope=messages&cursor=${encodeURIComponent(globalFirst.nextCursor)}`,
  );
  const globalIds = new Set(globalFirst.data.map((hit) => hit.thread.id));
  assert.ok(
    globalSecond.data.length > 0 && globalSecond.data.every((hit) => !globalIds.has(hit.thread.id)),
    "Global native history search repeated sessions",
  );
  return {
    nativeBodiesIntact: true,
    actualNativeReads: profile.samples.length,
    scopedSearchPages: 2,
    globalSearchPages: 2,
    nativeDocumentDownloadIntact: true,
  };
}
async function checkpoint() {
  // Full SQLite constraints and history hashes are verified by history("verify").
  // Before a cold start only flush the stopped native writer's committed WAL.
  await run("python3", [
    "-c",
    "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);assert c.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()[0]==0;c.close()",
    database,
  ]);
}
async function install(label, { allowFailure = false, extra = {} } = {}) {
  return run("bash", [join(input, `install-${label}.sh`)], {
    timeout: 900000,
    allowFailure,
    env: {
      OPENNEST_REPOSITORY_URL: "https://github.com/petrovichest/nest-apps.git",
      OPENNEST_OPENCODE_BIN: process.env.OPENNEST_OPENCODE_BIN,
      OPENNEST_NODE_BIN: process.execPath,
      OPENNEST_RUNTIME: "opencode",
      OPENNEST_UPDATE_MANIFEST_URL:
        "https://github.com/petrovichest/nest-apps/releases/download/qualification/OpenNest-latest.json",
      ...extra,
    },
  });
}
async function prepareNative() {
  for (const path of [
    configuration,
    nativeData,
    join(home, ".config/opencode"),
    join(home, "seed-project"),
  ])
    await mkdir(path, { recursive: true, mode: 0o700 });
  await writeFile(
    join(configuration, "connection.json"),
    JSON.stringify({
      version: 1,
      proxy: "http://fixture-user:fixture-proxy-password@127.0.0.1:9051",
    }) + "\n",
    { mode: 0o600 },
  );
  await writeFile(
    join(nativeData, "auth.json"),
    JSON.stringify({ openrouter: { type: "api", key: "fixture-openrouter-key-1" } }) + "\n",
    { mode: 0o600 },
  );
  await writeFile(
    join(home, ".config/opencode/opencode.json"),
    JSON.stringify({
      autoupdate: false,
      share: "disabled",
      model: "openrouter/qualification/fixture",
      small_model: "openrouter/qualification/fixture",
      enabled_providers: ["openrouter"],
      agent: { title: { disable: true } },
      provider: {
        openrouter: {
          options: { baseURL: "https://model.openrouter.fixture:9050/v1", maxRetries: 0 },
          models: {
            "qualification/fixture": {
              name: "Controlled native qualification",
              tool_call: true,
              limit: { context: 8000000, output: 1024 },
            },
          },
        },
      },
    }) + "\n",
    { mode: 0o600 },
  );
}
async function coldWarm(label, expected) {
  for (let index = 1; index <= 3; index++) {
    for (const cold of [true, false]) {
      const mode = cold ? "cold" : "warm",
        name = `${mode}-${label}-${index}`;
      await stage(name, async () => {
        await systemctl("stop", "opennest.service");
        let previous;
        if (cold) {
          await systemctl("stop", "opennest-daemon.service");
          await checkpoint();
          await history("evict");
        } else previous = await identity();
        const started = Date.now();
        await systemctl(
          "start",
          ...(cold ? ["opennest-daemon.service", "opennest.service"] : ["opennest.service"]),
        );
        await ready(expected, 30000 - (Date.now() - started));
        assert.equal(await savedWork(expected), true);
        const durationMs = Date.now() - started;
        assert.ok(
          durationMs > 0 && durationMs <= 30000,
          "Startup and saved work exceeded 30 seconds",
        );
        if (previous) await sameIdentity(previous);
        const record = {
          result: "passed",
          durationMs,
          savedWorkReady: true,
          nativeIdentity: await identity(),
        };
        report.runs[`${mode}${label}`].push(record);
        return { readyMs: durationMs, nativeIdentity: record.nativeIdentity, savedWorkReady: true };
      });
    }
  }
}
const snapshotPath = join(privateRoot, "baseline-snapshot");
async function snapshotA() {
  await systemctl("stop", "opennest.service", "opennest-daemon.service");
  await checkpoint();
  await mkdir(snapshotPath, { recursive: true });
  for (const [name, source] of [
    ["config", configuration],
    ["state", state],
    ["native", nativeData],
    ["units", units],
  ])
    await cp(source, join(snapshotPath, name), { recursive: true });
  await writeFile(join(snapshotPath, "current"), await realpath(join(root, "current")));
}
async function resetA() {
  await run(
    "systemctl",
    [
      "--user",
      "stop",
      "opennest-update.service",
      "opennest-recovery.service",
      "opennest.service",
      "opennest-daemon.service",
    ],
    { allowFailure: true },
  );
  relay.holdUntil = relay.unavailableUntil = 0;
  relay.delayed.length = 0;
  await control({ authKey: "fixture-openrouter-key-1", authFailure: false, proxyDown: false });
  for (const [name, target] of [
    ["config", configuration],
    ["state", state],
    ["native", nativeData],
    ["units", units],
  ]) {
    await rm(target, { recursive: true, force: true });
    await cp(join(snapshotPath, name), target, { recursive: true });
  }
  await rm(join(root, "current"), { force: true });
  await symlink(
    (await readFile(join(snapshotPath, "current"), "utf8")).trim(),
    join(root, "current"),
  );
  await rm(join(root, "update-transaction.json"), { force: true });
  for (const name of ["candidate-entered", "candidate-auth-rotated"])
    await rm(join(privateRoot, name), { force: true });
  await writeFile(join(privateRoot, "fault.json"), '{"mode":"none"}\n', { mode: 0o600 });
  await mkdir(join(units, "opennest.service.d"), { recursive: true });
  await writeFile(
    join(units, "opennest.service.d/qualification.conf"),
    `[Service]\nExecStart=\nExecStart=${process.execPath} ${join(input, "fault-entry.mjs")}\n`,
    { mode: 0o600 },
  );
  await systemctl("daemon-reload");
  // Fixture reset is between independent cases, never the measured rollback.
  // Inactive update/recovery units may have been unloaded by systemd already.
  await systemctl("reset-failed");
  token = (await readFile(join(configuration, "token"), "utf8")).trim();
  await systemctl("start", "opennest-daemon.service", "opennest.service");
  await ready();
}
async function authorizeCandidate(overrides = {}, runtime = undefined) {
  const bytes = await readFile(join(input, "install-B.sh")),
    installerPath = "/petrovichest/nest-apps/releases/download/qualification/OpenNest-install.sh",
    qualificationPath =
      "/petrovichest/nest-apps/releases/download/qualification/OpenNest-qualification.json";
  // Fixture-only authorization INPUT permits exercising the installed updater.
  // It is never used as qualification EVIDENCE or uploaded as a public report.
  const provisional = {
    fixture: true,
    provisional: true,
    schemaVersion: 1,
    app: "opennest",
    candidate,
    status: "passed",
    baseline,
    baselineHealthy: true,
    installerSha256: sha(bytes),
    restartProtocolVersion: 1,
    nativeVersions: ["1.19.5"],
    workflow: {
      event: "workflow_dispatch",
      conclusion: "success",
      headSha: candidate,
      runId: Number(process.env.GITHUB_RUN_ID),
    },
    scopes: [
      "clean-install",
      "large-history-cold",
      "large-history-warm",
      "upgrade",
      "failed-update-rollback",
      "retry-after-failure",
      "active-work",
    ].map((name) => ({ name, result: "passed" })),
    workload: { nonArchivedSessions: 2000, historyBytes: 3 * 1024 ** 3 },
    budgets: { startupMs: 30000, rollbackMs: 420000 },
    runs: {
      cold: [1, 2, 3].map(() => ({ result: "passed", durationMs: 1 })),
      warm: [1, 2, 3].map(() => ({ result: "passed", durationMs: 1 })),
    },
    rollback: {
      automatic: true,
      previousReady: true,
      workResumed: true,
      nativePidPreserved: true,
      durationMs: 1,
    },
    ...overrides,
  };
  if (runtime === "claude") {
    provisional.runtime = "claude";
    provisional.nativeVersions = ["1.19.5", "2.1.289"];
    provisional.scopes.push({ name: "runtime-transition", result: "passed" });
  }
  const reportBytes = JSON.stringify(provisional) + "\n",
    path = join(privateRoot, "fixture-updater-admission.json");
  await writeFile(path, reportBytes, { mode: 0o600 });
  const manifest = {
    schemaVersion: 1,
    version: version(candidate),
    commit: candidate,
    applications: {
      opennest: {
        ...(runtime ? { runtime } : {}),
        installer: { url: `https://github.com${installerPath}`, sha256: sha(bytes) },
        qualification: { url: `https://github.com${qualificationPath}`, sha256: sha(reportBytes) },
      },
    },
  };
  await control({
    files: { [installerPath]: join(input, "install-B.sh"), [qualificationPath]: path },
    manifest,
  });
  return manifest;
}
async function updater() {
  await run(join(home, ".local/bin/opennest"), ["update"]);
}
async function updateStatus() {
  return JSON.parse(await readFile(join(state, "update.json"), "utf8"));
}
async function workBundle() {
  const held = await thread(),
    queued = `queued-${randomUUID()}`,
    marker = `held-${randomUUID()}`;
  await send(held.id, "HOLD", marker);
  await until("Native held response", async () => (await control()).held.includes(marker));
  await send(held.id, "APPROVAL", queued, true);
  const question = await thread(),
    q = `question-${randomUUID()}`;
  await send(question.id, "QUESTION", q);
  const request = await until("Native pending question", async () =>
    (await api("/attention")).find(
      (item) => item.threadId === question.id && item.kind === "userInput",
    ),
  );
  await api(
    `/threads/${held.id}/draft`,
    { input: `Unsent controlled draft ${marker}`, images: [], annotations: [], goalMode: false },
    "PUT",
  );
  const questionDraft = await api(
    `/attention/${encodeURIComponent(request.id)}/draft`,
    { answers: { 0: ["Continue"] }, currentQuestionId: "0" },
    "PUT",
  );
  const approvalThread = await thread(),
    approvalMarker = `approval-${randomUUID()}`;
  await send(approvalThread.id, "APPROVAL", approvalMarker);
  const originalApproval = await until("Actual pending native approval", async () =>
    (await api("/attention")).find(
      (item) => item.threadId === approvalThread.id && item.kind === "commandApproval",
    ),
  );
  const team = await thread(),
    teamMarker = `team-${randomUUID()}`;
  await api(`/threads/${team.id}/settings`, { collaborationMode: "team" }, "PATCH");
  await send(team.id, "TEAM_PARENT", teamMarker);
  await until("Managed child held by real native", async () =>
    (await control()).held.includes(`${teamMarker}-child`),
  );
  const goal = await thread(),
    goalMarker = `goal-${randomUUID()}`;
  await send(goal.id, "GOAL", goalMarker);
  await until(
    "Actual persistent goal held",
    async () =>
      (await api(`/threads/${goal.id}/goal`))?.status === "active" &&
      (await control()).held.includes(goalMarker),
  );
  const teamState = JSON.parse(await readFile(join(state, "ui.json"), "utf8"));
  const tasks = Object.values(teamState.threads[team.id].teamOrchestration.tasks);
  assert.equal(tasks.length, 1);
  assert.ok(tasks[0].childThreadId);
  return {
    held: held.id,
    marker,
    queued,
    question: question.id,
    q,
    requestId: request.id,
    questionDraft,
    apiPid: await apiPid(),
    approvalThread: approvalThread.id,
    approvalMarker,
    approvalId: originalApproval.id,
    team: team.id,
    teamMarker,
    child: tasks[0].childThreadId,
    task: tasks[0].id,
    goal: goal.id,
    goalMarker,
    native: await identity(),
  };
}
async function resumeWork(bundle) {
  await sameIdentity(bundle.native);
  assert.equal(
    (await api(`/threads/${bundle.held}`)).draft?.input,
    `Unsent controlled draft ${bundle.marker}`,
    "Unsent conversation draft was lost",
  );
  const question = (await api("/attention")).find((item) => item.id === bundle.requestId);
  assert.ok(question, "Original pending native question was lost");
  const saved = JSON.parse(await readFile(join(state, "ui.json"), "utf8"));
  assert.deepEqual(
    saved.userInputDrafts?.[bundle.requestId],
    bundle.questionDraft,
    "Persisted pending question draft was lost or changed",
  );
  if ((await apiPid()) !== bundle.apiPid)
    assert.deepEqual(
      question.draft,
      bundle.questionDraft,
      "Recovered API did not restore the pending question draft",
    );
  await api(`/attention/${encodeURIComponent(bundle.requestId)}/respond`, {
    kind: "userInput",
    answers: { 0: ["Continue"] },
  });
  await finish(bundle.question, bundle.q);
  assert.ok(
    (await api("/attention")).some(
      (item) => item.id === bundle.approvalId && item.kind === "commandApproval",
    ),
    "Original native approval was lost",
  );
  await finishApproved(bundle.approvalThread, bundle.approvalMarker);
  await control({ release: [bundle.marker] });
  const approval = await until("Queued native side-effect approval", async () =>
    (await api("/attention")).find(
      (item) => item.threadId === bundle.held && item.kind === "commandApproval",
    ),
  );
  assert.ok(approval.id);
  await finishApproved(bundle.held, bundle.queued);
  assert.equal(
    (await api(`/threads/${bundle.goal}/goal`)).status,
    "active",
    "Persistent goal state was lost",
  );
  await control({ release: [`${bundle.teamMarker}-child`, bundle.goalMarker] });
  await until(
    "Goal resumes with current native work",
    async () => (await api(`/threads/${bundle.goal}/goal`)).status === "complete",
  );
  await finish(bundle.goal, bundle.goalMarker);
  await until("Application-owned Team result resumes parent", async () => {
    const saved = JSON.parse(await readFile(join(state, "ui.json"), "utf8"));
    const tasks = Object.values(saved.threads[bundle.team].teamOrchestration.tasks);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, bundle.task);
    assert.equal(tasks[0].childThreadId, bundle.child);
    const parent = await api(`/threads/${bundle.team}`);
    return (
      tasks[0].status === "completed" &&
      tasks[0].delivery?.status === "delivered" &&
      textOf(parent).includes(`QUALIFICATION_TEAM_REVIEWED:${bundle.teamMarker}`) &&
      parent.turns.some((turn) => turn.items.some((item) => item.type === "orchestrationNotice"))
    );
  });
  const stats = await control();
  assert.equal(stats.requests[bundle.marker], 1, "An admitted native request was repeated");
  assert.equal(stats.sideEffects[bundle.queued], 1, "Queued side effect was lost or repeated");
  assert.equal(
    stats.sideEffects[bundle.approvalMarker],
    1,
    "Approved side effect was lost or repeated",
  );
  assert.equal(stats.requests[bundle.q], 2, "Original pending question was replayed");
  await sameIdentity(bundle.native);
  return {
    nativeIdentity: bundle.native,
    modelRequests: 1,
    sideEffects: 2,
    questionDraftPreserved: true,
    pendingApprovalPreserved: true,
    managedChildPreserved: true,
    goalPreserved: true,
  };
}
async function failedUpdate(mode, interrupt = false) {
  await resetA();
  await authorizeCandidate();
  const bundle = await workBundle();
  const authBefore = await readFile(join(nativeData, "auth.json"));
  const started = Date.now();
  await writeFile(
    join(privateRoot, "fault.json"),
    JSON.stringify({
      mode,
      controlToken: relayControlToken,
    }),
    { mode: 0o600 },
  );
  await updater();
  if (interrupt) {
    await until(
      "Candidate actually entered",
      () => exists(join(privateRoot, "candidate-entered")),
      600000,
    );
    await systemctl("kill", "--kill-whom=all", "--signal=KILL", "opennest-update.service");
  }
  await until(
    "Actual automatic rollback",
    async () => (await updateStatus()).result === "rolled_back",
    420000,
  );
  await ready();
  const actualAReadyMs = await serviceStartupElapsed();
  assert.equal(
    await realpath(join(root, "current")),
    (await readFile(join(snapshotPath, "current"), "utf8")).trim(),
  );
  assert.equal(
    await exists(join(root, "update-transaction.json")),
    false,
    "Rollback journal was not finalized",
  );
  const authAfter = await readFile(join(nativeData, "auth.json"));
  if (mode === "rotated-auth") {
    assert.ok(
      await exists(join(privateRoot, "candidate-auth-rotated")),
      "Actual candidate did not rotate native credentials",
    );
    assert.notDeepEqual(authAfter, authBefore);
    assert.equal(
      JSON.parse(authAfter).openrouter.key,
      "fixture-openrouter-key-rotated",
      "Rollback restored stale native authentication",
    );
  } else assert.deepEqual(authAfter, authBefore, "Rollback changed native authentication");
  const work = await resumeWork(bundle);
  if (mode === "rotated-auth") {
    const freshPath = join(home, `rotated-auth-project-${randomUUID()}`);
    await mkdir(freshPath);
    const project = await api("/projects", { path: freshPath });
    const fresh = (await api(`/projects/${project.id}/threads`, { clientCreationId: randomUUID() }))
      .thread;
    const marker = `current-auth-${randomUUID()}`;
    await send(fresh.id, "REQUEST", marker);
    await finish(fresh.id, marker);
    const authUsed = (await control()).authUsed[marker];
    assert.equal(
      authUsed.current,
      1,
      "Recovered A did not use candidate's current native credential",
    );
    assert.equal(
      authUsed.previous,
      0,
      "Recovered A used stale native credentials for a fresh context",
    );
    assert.deepEqual(
      await readFile(join(nativeData, "auth.json")),
      authAfter,
      "Work restoration rewound authentication",
    );
  }
  if (mode === "slow-native") {
    const aEntered = Number(await readFile(join(privateRoot, "baseline-entered"), "utf8"));
    assert.ok(
      relay.delayed.some((item) => item.at >= aEntered && item.until > item.at),
      "The native delay did not survive into rollback A",
    );
  }
  await history("verify");
  const durationMs = Date.now() - started;
  assert.ok(durationMs <= 420000);
  report.rollback = {
    automatic: true,
    previousReady: true,
    workResumed: true,
    nativePidPreserved: true,
    stateIntact: true,
    durationMs: Math.max(report.rollback.durationMs, durationMs),
  };
  return {
    totalRecoveryMs: durationMs,
    readyMs: actualAReadyMs,
    ...work,
    updaterInterrupted: interrupt,
    authPreserved: true,
  };
}
async function removeFixtureInstallation() {
  await systemctl("stop", "opennest-update.service", "opennest.service", "opennest-daemon.service");
  await checkpoint();
  // Independent empty-install cases run after all history/state preservation
  // checks; teardown is explicit and never counted as successful rollback.
  for (const target of [
    configuration,
    state,
    nativeData,
    join(home, ".config/opencode"),
    join(home, ".cache/opencode"),
    root,
    join(home, ".local/bin/opennest"),
  ])
    await rm(target, { recursive: true, force: true });
  for (const name of [
    "opennest.service",
    "opennest-daemon.service",
    "opennest-update.service",
    "opennest-recovery.service",
    "opennest.service.d",
  ])
    await rm(join(units, name), { recursive: true, force: true });
  await systemctl("daemon-reload");
}
async function cleanInstallationB() {
  await removeFixtureInstallation();
  await prepareNative();
  await stage("failed-clean-install-retry", async () => {
    const failed = await install("B", {
      allowFailure: true,
      extra: { OPENNEST_NATIVE_URL: "http://127.0.0.1:9052" },
    });
    assert.notEqual(failed.code, 0, "Occupied native port unexpectedly produced a ready install");
    assert.equal(await exists(envPath), false, "Failed first install left active configuration");
    assert.equal(
      await exists(join(root, "current")),
      false,
      "Failed first install left release pointer",
    );
    const stopped = await run(
      "systemctl",
      ["--user", "is-active", "--quiet", "opennest.service", "opennest-daemon.service"],
      { allowFailure: true },
    );
    assert.notEqual(stopped.code, 0, "Failed first install left an application service active");
    return { cleanFailure: true, nativeServicesStopped: true };
  });
  await stage("candidate-clean-install", async () => {
    await install("B");
    token = (await readFile(join(configuration, "token"), "utf8")).trim();
    await ready(version(candidate));
    const firstReadyMs = await serviceStartupElapsed(true, "candidate-first-ready", false);
    const project = await api("/projects", { path: join(home, "seed-project") });
    firstProject = project;
    const t = await thread(),
      marker = `candidate-clean-${randomUUID()}`;
    await send(t.id, "REQUEST", marker);
    await finish(t.id, marker);
    return {
      actualInstaller: true,
      firstReadyMs,
      readyMs: await serviceStartupElapsed(true, "candidate-ready-with-work"),
      readyVersion: version(candidate),
      nativeIdentity: await identity(),
    };
  });
}

const claudeVersion = "2.1.289";
async function claudeTurn(id, marker) {
  await api(`/threads/${id}/turns`, {
    input: `QUALIFICATION_CLAUDE:${marker}`,
    clientMessageId: randomUUID(),
  });
  await finish(id, marker);
  await until(
    "Claude turn left no active work",
    async () => !(await api(`/threads/${id}`)).summary.currentTurnId,
  );
  assert.equal((await control()).requests[marker], 1, "Claude turn was dispatched twice");
}

async function createClaudeFixtureChat() {
  const project = await api("/projects", { path: join(home, "seed-project") });
  const { thread: t } = await api(`/projects/${project.id}/threads`, {
    clientCreationId: randomUUID(),
  });
  await api("/settings/open", { apiKey: "sk-or-fixture-claude" }, "PUT");
  await control({ acceptedAuthKeys: ["fixture-openrouter-key-1", "sk-or-fixture-claude"] });
  await api(`/threads/${t.id}/settings`, { openRouterEndpoint: "fixture-claude/us" }, "PATCH");
  await claudeTurn(t.id, `claude-start-${randomUUID()}`);
  return t.id;
}

async function stopClaudeFixtureOwner(id) {
  await systemctl("stop", `opennest-claude-session-${id}.service`);
}

async function qualifyClaudeTransition() {
  const exactBinary = process.env.OPENNEST_CLAUDE_BIN;
  assert.equal((await run(exactBinary, ["--version"])).text.trim().split(/\s+/)[0], claudeVersion);
  report.claude = { version: claudeVersion, cold: [], warm: [] };
  await resetA();
  await writeConfiguration({ ...(await configurationValues()), OPENNEST_CLAUDE_BIN: exactBinary });
  await authorizeCandidate({}, "claude");
  await stage("claude-refuses-active-legacy-work", async () => {
    const before = await apiPid();
    const active = await workBundle();
    await updater();
    await until(
      "Active legacy work blocks the transition",
      async () => (await updateStatus()).result === "failed",
    );
    assert.equal(await apiPid(), before);
    return resumeWork(active);
  });
  await resetA();
  await writeConfiguration({ ...(await configurationValues()), OPENNEST_CLAUDE_BIN: exactBinary });
  await authorizeCandidate({}, "claude");
  await stage("claude-failed-transition-rolls-back", async () => {
    const before = await identity();
    const oldThread = await thread();
    const original = `pre-claude-${randomUUID()}`;
    await send(oldThread.id, "REQUEST", original);
    await finish(oldThread.id, original);
    await writeFile(join(privateRoot, "fault.json"), '{"mode":"wrong-version"}\n', { mode: 0o600 });
    const started = Date.now();
    await updater();
    await until(
      "Claude failure restored the old API",
      async () => (await updateStatus()).result === "rolled_back",
      420000,
    );
    assert.ok(await exists(join(privateRoot, "candidate-entered")));
    await ready();
    assert.equal((await configurationValues()).OPENNEST_RUNTIME, undefined);
    await sameIdentity(before);
    const after = `after-claude-failure-${randomUUID()}`;
    await send(oldThread.id, "REQUEST", after);
    const detail = await finish(oldThread.id, after);
    assert.ok(textOf(detail).includes(original));
    report.claude.rollbackMs = Date.now() - started;
    assert.ok(report.claude.rollbackMs <= 420000);
    return { sameNative: true, resumedOldSession: true, rollbackMs: report.claude.rollbackMs };
  });
  let userThread;
  await stage("claude-installed-updater-transition", async () => {
    const before = await identity();
    await writeFile(join(privateRoot, "fault.json"), '{"mode":"none"}\n', { mode: 0o600 });
    await updater();
    await until(
      "Installed updater enabled Claude Code",
      async () => (await updateStatus()).result === "updated",
      900000,
    );
    await ready(version(candidate), 30000, claudeVersion);
    assert.equal((await configurationValues()).OPENNEST_RUNTIME, "claude");
    await sameIdentity(before);
    assert.ok((await api("/snapshot")).projects.some((project) => project.id === firstProject.id));
    userThread = await createClaudeFixtureChat();
    return { candidateReady: true, sameOldNative: true, nativeWork: true };
  });
  try {
    const helper = join(input, "claude-history.py");
    await systemctl("stop", "opennest.service");
    report.claude.workload = JSON.parse(
      (await run("python3", [helper, "seed"], { timeout: 300000 })).text,
    );
    for (let index = 1; index <= 3; index++) {
      for (const mode of ["cold", "warm"]) {
        await stage(`claude-${mode}-${index}`, async () => {
          const unit = `opennest-claude-session-${userThread}.service`;
          if (mode === "cold") {
            await stopClaudeFixtureOwner(userThread);
            await systemctl("stop", "opennest.service");
            await run("python3", [helper, "evict"], { timeout: 300000 });
          }
          const before =
            mode === "warm"
              ? (await systemctl("show", unit, "--property=MainPID", "--value")).text
              : null;
          const started = Date.now();
          await systemctl(mode === "warm" ? "restart" : "start", "opennest.service");
          await ready(version(candidate), 30000 - (Date.now() - started), claudeVersion);
          const threads = (await api("/snapshot")).threads;
          assert.ok(
            threads.filter((thread) => !thread.archived).length >=
              report.claude.workload.nonArchivedSessions,
          );
          assert.ok(
            threads.filter((thread) => thread.archived).length >=
              report.claude.workload.archivedSessions,
          );
          if (before !== null) {
            assert.notEqual(Number(before.trim()), 0);
            assert.equal(
              (await systemctl("show", unit, "--property=MainPID", "--value")).text,
              before,
            );
          }
          await claudeTurn(userThread, `claude-${mode}-${randomUUID()}`);
          const durationMs = Date.now() - started;
          assert.ok(durationMs > 0 && durationMs <= 30000);
          report.claude[mode].push({ durationMs, result: "passed" });
          return { readyMs: durationMs, nativeWork: true, ownerPreserved: before !== null };
        });
      }
    }
  } finally {
    if (userThread) await stopClaudeFixtureOwner(userThread);
  }
  await removeFixtureInstallation();
  await prepareNative();
  await stage("claude-clean-install", async () => {
    await install("B", { extra: { OPENNEST_RUNTIME: "claude", OPENNEST_CLAUDE_BIN: exactBinary } });
    token = (await readFile(join(configuration, "token"), "utf8")).trim();
    await ready(version(candidate), 30000, claudeVersion);
    const id = await createClaudeFixtureChat();
    await stopClaudeFixtureOwner(id);
    return { installer: true, freshNativeWork: true };
  });
}

async function qualifyPublishedClaudeUpgrade() {
  await removeFixtureInstallation();
  await prepareNative();
  await install("A", {
    extra: { OPENNEST_RUNTIME: "claude", OPENNEST_CLAUDE_BIN: process.env.OPENNEST_CLAUDE_BIN },
  });
  token = (await readFile(join(configuration, "token"), "utf8")).trim();
  await ready(version(baseline), 30000, claudeVersion);
  const id = await createClaudeFixtureChat();
  const owner = async () =>
    Number(
      (
        await systemctl(
          "show",
          `opennest-claude-session-${id}.service`,
          "--property=MainPID",
          "--value",
        )
      ).text.trim(),
    );
  const oldOwner = await owner();
  const oldNative = await identity();
  assert.ok(oldOwner > 1);
  try {
    await stage("claude-published-upgrade", async () => {
      const marker = `published-claude-${randomUUID()}`;
      await claudeTurn(id, marker);
      const project = (await api("/snapshot")).projects.find(
        (item) => item.path === join(home, "seed-project"),
      );
      assert.ok(project);
      const boardPath = `/projects/${project.id}/kanban`;
      await api("/settings/task-defaults", { classifyTasks: false }, "PUT");
      const board = await api(`${boardPath}/cards`, {
        description: "OpenNest session card",
        threadId: id,
        clientCreationId: randomUUID(),
      });
      const boardFile = join(home, ".local/share/nest-apps/kanban/boards", `${board.id}.json`);
      const privateFile = join(state, "claude/kanban/boards", `${board.id}.json`);
      if (await exists(privateFile)) {
        const sibling = JSON.parse(await readFile(privateFile, "utf8"));
        sibling.board.cards[0].title = "Shared card without an OpenNest session";
        sibling.board.runs[0].provider = "claude";
        sibling.board.runs[0].threadId = randomUUID();
        await mkdir(dirname(boardFile), { recursive: true });
        await writeFile(boardFile, JSON.stringify(sibling), { mode: 0o600 });
      } else {
        const shared = await api(`${boardPath}/cards`, {
          description: "Shared card without an OpenNest session",
          clientCreationId: randomUUID(),
        });
        assert.equal(shared.cards.length, 2);
      }
      await systemctl("stop", "opennest.service");
      const workload = JSON.parse(
        (await run("python3", [join(input, "claude-history.py"), "seed"], { timeout: 300000 }))
          .text,
      );
      const verifyOpenNestHistory = async () => {
        const rows = (await api("/snapshot")).threads;
        assert.ok(rows.filter((row) => !row.archived).length >= workload.nonArchivedSessions);
        assert.ok(rows.filter((row) => row.archived).length >= workload.archivedSessions);
      };
      await systemctl("start", "opennest.service");
      await ready(version(baseline), 30000, claudeVersion);
      await verifyOpenNestHistory();
      assert.equal(await owner(), oldOwner);

      const dropIn = join(units, "opennest.service.d");
      await mkdir(dropIn, { recursive: true });
      await writeFile(
        join(dropIn, "qualification.conf"),
        `[Service]\nExecStart=\nExecStart=${process.execPath} ${join(input, "fault-entry.mjs")}\n`,
        { mode: 0o600 },
      );
      await systemctl("daemon-reload");
      await authorizeCandidate({}, "claude");
      await rm(join(privateRoot, "candidate-entered"), { force: true });
      await writeFile(join(privateRoot, "fault.json"), '{"mode":"wrong-version"}\n', {
        mode: 0o600,
      });
      const started = Date.now();
      await updater();
      await until(
        "Published Claude runtime restored automatically",
        async () => (await updateStatus()).result === "rolled_back",
        420000,
      );
      assert.ok(await exists(join(privateRoot, "candidate-entered")));
      await ready(version(baseline), 30000, claudeVersion);
      const readyMs = await serviceStartupElapsed(false, "published-claude-rollback");
      assert.equal(await owner(), oldOwner);
      await sameIdentity(oldNative);
      await verifyOpenNestHistory();
      await claudeTurn(id, `after-claude-rollback-${randomUUID()}`);
      assert.ok(textOf(await api(`/threads/${id}`)).includes(marker));
      const totalRecoveryMs = Date.now() - started;
      assert.ok(totalRecoveryMs <= 420000);

      await writeFile(join(privateRoot, "fault.json"), '{"mode":"none"}\n', { mode: 0o600 });
      await updater();
      await until(
        "Retry upgraded the installed Claude runtime",
        async () => (await updateStatus()).result === "updated",
        900000,
      );
      await ready(version(candidate), 30000, claudeVersion);
      assert.equal(await owner(), oldOwner);
      await sameIdentity(oldNative);
      await verifyOpenNestHistory();
      const sharedBefore = sha(await readFile(boardFile));
      assert.deepEqual(
        (await api(boardPath)).cards.map(({ title }) => title),
        ["OpenNest session card"],
      );
      assert.ok((await api(boardPath)).runs.every((entry) => entry.provider === "open"));
      await claudeTurn(id, `after-claude-upgrade-${randomUUID()}`);
      assert.ok(textOf(await api(`/threads/${id}`)).includes(marker));
      await api("/settings/task-defaults", { classifyTasks: true }, "PUT");
      const classifierMarker = `isolated-board-${randomUUID()}`;
      await api(`${boardPath}/cards`, {
        description: `QUALIFICATION_CLAUDE:${classifierMarker}`,
        clientCreationId: randomUUID(),
      });
      const classifier = await until(
        "Classifier used the private OpenNest OpenRouter runtime",
        async () => {
          if (!(await control()).requests[classifierMarker]) return false;
          return (await api(boardPath)).runs.find(
            (entry) => entry.kind === "classify" && entry.threadId,
          );
        },
      );
      assert.equal(classifier.provider, "open");
      await finish(classifier.threadId, classifierMarker);
      assert.equal((await control()).requests[classifierMarker], 1);
      await stopClaudeFixtureOwner(classifier.threadId);
      assert.equal(
        sha(await readFile(boardFile)),
        sharedBefore,
        "OpenNest wrote into the shared board",
      );
      return {
        readyMs,
        totalRecoveryMs,
        sameOwner: true,
        workResumed: true,
        privateBoard: true,
        workload,
      };
    });
  } finally {
    await stopClaudeFixtureOwner(id);
  }
}

qualification: try {
  await save();
  relay = await new NativeRelay(relayControlToken).listen();
  await until("Controlled external services", () => control());
  await prepareNative();
  await stage("baseline-clean-install", async () => {
    await install("A");
    token = (await readFile(join(configuration, "token"), "utf8")).trim();
    await ready();
    const firstReadyMs = await serviceStartupElapsed(true, "baseline-first-ready", false);
    firstProject = await api("/projects", { path: join(home, "seed-project") });
    seed = await thread();
    const marker = `baseline-seed-${randomUUID()}`;
    await send(seed.id, "REQUEST", marker);
    await finish(seed.id, marker);
    return {
      actualInstaller: true,
      firstReadyMs,
      readyMs: await serviceStartupElapsed(true, "baseline-ready-with-work"),
      nativeIdentity: await identity(),
      readyVersion: version(baseline),
    };
  });
  report.fixtureCounterSnapshots = { baselineInstall: await control() };
  if (baselineDiagnostic) {
    await mkdir(join(units, "opennest.service.d"), { recursive: true });
    await writeFile(
      join(units, "opennest.service.d/10-native-http-trace.conf"),
      `[Service]\nEnvironment="NODE_OPTIONS=--import=${join(input, "native-http-trace.mjs")}"\nEnvironment="OPENNEST_QUALIFICATION_NATIVE_TRACE=${join(privateRoot, "native-http-trace.log")}"\n`,
      { mode: 0o600 },
    );
    await systemctl("daemon-reload");
  }
  await systemctl("stop", "opennest.service", "opennest-daemon.service");
  await run(
    "python3",
    [
      join(input, "history.py"),
      "seed",
      "--home",
      home,
      "--database",
      database,
      "--seed",
      seed.id,
      "--native-stopped",
    ],
    { timeout: 600000 },
  );
  profile = JSON.parse(await readFile(join(output, "history-profile.json"), "utf8"));
  report.workload = { ...profile, projects: profile.projectCount };
  await stage("seeded-history-startup", async () => {
    await systemctl("start", "opennest-daemon.service", "opennest.service");
    await ready();
    return { readyMs: await serviceStartupElapsed(true, "seeded-history-startup") };
  });
  for (const directory of profile.projects) await api("/projects", { path: directory });
  await sampleHistory();
  await coldWarm("A", version(baseline));
  await stage("baseline-native-history-integrity", nativeHistoryIntegrity);
  report.baseline.healthy = report.baseline.independentlyQualified = true;
  if (baselineDiagnostic) {
    report.fixtureCounters = await control();
    report.fixtureCounterSnapshots.baselineDiagnostic = report.fixtureCounters;
    assert.equal(report.fixtureCounters.directModelRequests, 0);
    assert.equal(report.fixtureCounters.unexpectedExternalRequests, 0);
    report.pending = ["baseline diagnostic only; full qualification not run"];
    await save();
    break qualification;
  }
  await snapshotA();
  await resetA();
  await stage("live-daemon-reconnect", async () => {
    const held = await thread(),
      marker = `reconnect-${randomUUID()}`,
      before = await identity();
    await send(held.id, "HOLD", marker);
    await until("Live native stream", async () => (await control()).held.includes(marker));
    await systemctl("stop", "opennest.service");
    await control({ chunk: { marker, text: "offline|" } });
    await systemctl("start", "opennest.service");
    await ready();
    await until(
      "Recovered active text",
      async () => textOf(await api(`/threads/${held.id}`)) === "before|offline|",
    );
    await control({ chunk: { marker, text: "live|" } });
    await until(
      "Live text before completion",
      async () => textOf(await api(`/threads/${held.id}`)) === "before|offline|live|",
    );
    await control({ release: [marker] });
    await sameIdentity(before);
    assert.equal((await control()).requests[marker], 1);
    return { actualNativeIdentity: before, liveBeforeCompletion: true, acceptedModelRequests: 1 };
  });
  for (const mode of [
    "wrong-version",
    "no-http",
    "no-token",
    "slow-native",
    "rotated-auth",
    "native-auth",
  ])
    await stage(`failed-B-automatic-A-${mode}`, () => failedUpdate(mode));
  await stage("interrupted-updater-recovery", () => failedUpdate("no-http", true));
  await stage("work-and-history-after-rollback", async () => {
    await history("verify");
    return { intact: true, ...(await identity()) };
  });
  await stage("failed-artifact-keeps-A", async () => {
    await resetA();
    const before = await identity(),
      pointer = await realpath(join(root, "current"));
    const manifest = await authorizeCandidate();
    manifest.applications.opennest.qualification.sha256 = "0".repeat(64);
    await control({ manifest });
    await updater();
    await until(
      "Rejected corrupt artifact",
      async () => (await updateStatus()).result === "failed",
    );
    await ready();
    await sameIdentity(before);
    assert.equal(await realpath(join(root, "current")), pointer);
    return { beforeSwitch: true };
  });
  await stage("incompatible-protocol-keeps-A", async () => {
    await resetA();
    const before = await identity(),
      pointer = await realpath(join(root, "current"));
    await authorizeCandidate({ restartProtocolVersion: 999 });
    await updater();
    await until(
      "Rejected incompatible protocol",
      async () => (await updateStatus()).result === "failed",
    );
    await ready();
    await sameIdentity(before);
    assert.equal(await realpath(join(root, "current")), pointer);
    return { beforeSwitch: true };
  });
  await stage("unavailable-native-refuses-update", async () => {
    await resetA();
    await authorizeCandidate();
    const pointer = await realpath(join(root, "current"));
    await systemctl("stop", "opennest-daemon.service");
    await until(
      "Native unavailable reflected in readiness",
      async () => (await api("/health")).recoveryState !== "ready",
    );
    await updater();
    await until(
      "Refused unavailable native",
      async () => (await updateStatus()).result === "failed",
    );
    assert.equal(await realpath(join(root, "current")), pointer);
    assert.equal(await exists(join(root, "update-transaction.json")), false);
    return { beforeSwitch: true };
  });
  await stage("transient-native-outage-recovers", async () => {
    await resetA();
    const work = await workBundle(),
      started = Date.now();
    relay.unavailableUntil = Date.now() + 15000;
    for (const socket of relay.sockets) socket.destroy();
    await until(
      "Native transport outage reflected",
      async () => (await api("/health")).recoveryState !== "ready",
      10000,
    );
    assert.equal(
      (await native("/global/health")).healthy,
      true,
      "Real native daemon did not survive its transport outage",
    );
    await ready(version(baseline), 30000 - (Date.now() - started));
    const evidence = await resumeWork(work),
      durationMs = Date.now() - started;
    assert.ok(durationMs <= 30000, "Transient outage and saved work exceeded recovery budget");
    return {
      ...evidence,
      readyMs: durationMs,
      outageKind: "native HTTP transport",
      automatic: true,
    };
  });
  await stage("failed-state-checkpoint-keeps-A", async () => {
    await resetA();
    await authorizeCandidate();
    const work = await workBundle(),
      pointer = await realpath(join(root, "current"));
    const apiPid = Number(
      (await systemctl("show", "opennest.service", "--property=MainPID", "--value")).text.trim(),
    );
    const target = join(state, "ui.json"),
      backup = join(privateRoot, "checkpoint-before-failure.json");
    await rename(target, backup);
    await mkdir(target);
    let restored = false;
    const restore = async () => {
      if (restored) return;
      restored = true;
      await rm(target, { recursive: true, force: true });
      await rename(backup, target);
    };
    const restoration = new Promise((resolve, reject) =>
      setTimeout(() => restore().then(resolve, reject), 15000),
    );
    try {
      await updater();
      await until(
        "Rejected failed durable checkpoint",
        async () => (await updateStatus()).result === "failed",
        420000,
      );
      await restoration;
      await ready();
      assert.equal(await realpath(join(root, "current")), pointer);
      assert.equal(
        Number(
          (
            await systemctl("show", "opennest.service", "--property=MainPID", "--value")
          ).text.trim(),
        ),
        apiPid,
        "Checkpoint failure restarted unchanged A",
      );
      assert.equal(
        await exists(join(privateRoot, "candidate-entered")),
        false,
        "Candidate started despite failed checkpoint",
      );
      const evidence = await resumeWork(work);
      return {
        ...evidence,
        beforeSwitch: true,
        injection: "ui.json atomic rename EISDIR",
        fixtureOutageMs: 15000,
      };
    } finally {
      await restore();
      await restoration;
    }
  });
  await stage("missing-build-dependency-keeps-A", async () => {
    await resetA();
    await authorizeCandidate();
    const target = join(root, "releases", `v${version(candidate)}`);
    if (await exists(target))
      await run("git", ["-C", join(root, "source"), "worktree", "remove", "--force", target]);
    const work = await workBundle(),
      pointer = await realpath(join(root, "current")),
      values = await configurationValues(),
      bin = join(privateRoot, "without-npm");
    await mkdir(bin, { recursive: true });
    for (const [name, path] of Object.entries({
      git: "/usr/bin/git",
      curl: "/usr/bin/curl",
      systemctl: "/usr/bin/systemctl",
      flock: "/usr/bin/flock",
      sh: "/bin/sh",
      node: process.execPath,
    }))
      if (!(await exists(join(bin, name)))) await symlink(path, join(bin, name));
    assert.equal(await exists(join(bin, "npm")), false);
    await writeConfiguration({ ...values, PATH: bin });
    try {
      await updater();
      await until(
        "Missing actual npm dependency refused",
        async () => (await updateStatus()).result === "failed",
        120000,
      );
      assert.equal(await realpath(join(root, "current")), pointer);
      assert.equal(await exists(join(root, "update-transaction.json")), false);
      assert.equal(await exists(join(privateRoot, "candidate-entered")), false);
      await sameIdentity(work.native);
    } finally {
      await writeConfiguration(values);
    }
    const evidence = await resumeWork(work);
    return { ...evidence, beforeSwitch: true, missingExecutable: "npm", cachedCandidate: false };
  });
  await stage("unsupported-native-refused", async () => {
    await resetA();
    await authorizeCandidate();
    const before = await identity(),
      pointer = await realpath(join(root, "current")),
      values = await configurationValues();
    const retainedWork = await workBundle();
    const unsupported = "/opt/opennest-qualification/unsupported/opencode";
    assert.equal((await run(unsupported, ["--version"])).text.trim(), "1.19.4");
    await writeConfiguration({ ...values, OPENNEST_OPENCODE_BIN: unsupported });
    await updater();
    await until(
      "Actual unsupported native CLI rejected",
      async () => (await updateStatus()).result === "failed",
    );
    await sameIdentity(before);
    await ready();
    assert.equal(await realpath(join(root, "current")), pointer);
    assert.equal(await exists(join(root, "update-transaction.json")), false);
    await writeConfiguration(values);
    const workEvidence = await resumeWork(retainedWork);
    return {
      ...workEvidence,
      actualNativeVersion: "1.19.4",
      survivingNativeVersion: "1.19.5",
      beforeSwitch: true,
      nativeIdentity: before,
    };
  });
  await resetA();
  await authorizeCandidate();
  await stage("repeated-update-after-rollback", async () => {
    const work = await workBundle();
    await updater();
    await until(
      "Installed updater completed retry",
      async () => (await updateStatus()).result === "updated",
      900000,
    );
    await ready(version(candidate));
    const evidence = await resumeWork(work);
    return { readyVersion: version(candidate), ...evidence };
  });
  await stage("installed-updater-A-to-B", async () => {
    await ready(version(candidate));
    assert.equal(
      await realpath(join(root, "current")),
      join(root, "releases", `v${version(candidate)}`),
    );
    const installedUpdater = await readFile(join(units, "opennest-update.service"), "utf8");
    assert.ok(
      installedUpdater.includes(`/v${version(baseline)}/apps/open-server/scripts/manage.mjs`),
      "The test replaced the old installed updater",
    );
    return { installedUpdaterSource: baseline, candidateReady: true };
  });
  await coldWarm("B", version(candidate));
  await stage("native-history-integrity", nativeHistoryIntegrity);
  await qualifyClaudeTransition();
  if (baselineRuntime === "claude") await qualifyPublishedClaudeUpgrade();
  await cleanInstallationB();
  report.fixtureCounters = await control();
  assert.equal(report.fixtureCounters.directModelRequests, 0);
  assert.equal(report.fixtureCounters.unexpectedExternalRequests, 0);
  const cgroup = "/sys/fs/cgroup/user.slice/user-17002.slice";
  const events = Object.fromEntries(
    (await readFile(join(cgroup, "memory.events"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => {
        const [name, value] = line.split(" ");
        return [name, Number(value)];
      }),
  );
  report.resources = {
    memoryMaxBytes: Number((await readFile(join(cgroup, "memory.max"), "utf8")).trim()),
    memoryHighBytes: Number((await readFile(join(cgroup, "memory.high"), "utf8")).trim()),
    memoryPeakBytes: Number((await readFile(join(cgroup, "memory.peak"), "utf8")).trim()),
    cpuQuota: (await readFile(join(cgroup, "cpu.max"), "utf8")).trim(),
    oomKills: events.oom_kill,
    oomEvents: events.oom,
  };
  await writeFile(join(output, "resources.json"), JSON.stringify(report.resources, null, 2) + "\n");
  report.completed = process.env.GITHUB_REF === "refs/heads/main";
  if (!report.completed)
    report.pending = ["full native diagnostic only; not release qualification"];
  await save();
} catch (error) {
  report.completed = false;
  report.fixtureCounters = await control().catch(() => report.fixtureCounters);
  report.failureHealth = await api("/health").catch(() => null);
  report.failureNativeHealth = await native("/global/health").catch(() => null);
  await save();
  process.stderr.write(`OpenNest native qualification failed: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  await relay?.close();
}
