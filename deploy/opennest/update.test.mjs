import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseEnvironment } from "../../apps/open-server/scripts/manage.mjs";
import {
  createUpdater,
  manifestCandidate,
  qualifyCandidate,
} from "../../apps/open-server/scripts/update.mjs";

const A = "a".repeat(40),
  B = "b".repeat(40),
  oldVersion = "0.1.9-aaaaaaa",
  version = "0.1.9-bbbbbbb";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const template =
  'opennest_default_version="__OPENNEST_VERSION__"\nopennest_default_ref="__OPENNEST_REF__"\n';
const installer = template.replace("__OPENNEST_VERSION__", version).replace("__OPENNEST_REF__", B);
const baseURL = "https://github.com/petrovichest/nest-apps/releases/download/opennest-latest/";
function report() {
  return {
    schemaVersion: 1,
    app: "opennest",
    candidate: B,
    baseline: A,
    baselineHealthy: true,
    status: "passed",
    installerSha256: hash(installer),
    nativeVersions: ["1.19.5"],
    restartProtocolVersion: 1,
    workload: { nonArchivedSessions: 2000, historyBytes: 3 * 1024 ** 3 },
    budgets: { startupMs: 60_000, rollbackMs: 420_000 },
    runs: {
      cold: [1, 2, 3].map(() => ({ result: "passed", durationMs: 100 })),
      warm: [1, 2, 3].map(() => ({ result: "passed", durationMs: 100 })),
    },
    rollback: {
      automatic: true,
      previousReady: true,
      workResumed: true,
      nativePidPreserved: true,
      durationMs: 100,
    },
    workflow: { event: "workflow_dispatch", conclusion: "success", headSha: B, runId: 123 },
    scopes: [
      "clean-install",
      "large-history-cold",
      "large-history-warm",
      "upgrade",
      "failed-update-rollback",
      "retry-after-failure",
      "active-work",
    ].map((name) => ({ name, result: "passed" })),
  };
}
function manifest(evidence = report()) {
  return {
    schemaVersion: 1,
    version,
    commit: B,
    applications: {
      opennest: {
        installer: { url: baseURL + "install-opennest.sh", sha256: hash(installer) },
        qualification: {
          url: baseURL + "opennest-qualification.json",
          sha256: hash(JSON.stringify(evidence)),
        },
      },
    },
  };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "opennest-updater-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const location = {
    root,
    config: join(root, "config"),
    env: join(root, "config/server.env"),
    units: join(root, "units"),
  };
  const previous = join(root, "releases/previous"),
    target = join(root, "releases", `v${version}`),
    state = join(root, "state");
  for (const path of [
    location.config,
    location.units,
    previous,
    target,
    state,
    join(target, "deploy/opennest"),
  ])
    await mkdir(path, { recursive: true });
  await writeFile(join(target, "deploy/opennest/install.sh"), template);
  await writeFile(join(target, ".opennest-built"), B + "\n");
  await symlink(previous, join(root, "current"));
  const initial = {
    OPENNEST_RELEASE_PATH: previous,
    OPENNEST_VERSION: oldVersion,
    OPENNEST_STATE_DIR: state,
    OPENNEST_OPENCODE_BIN: "/fixture/opencode",
    OPENNEST_NODE_BIN: process.execPath,
    OPENCODE_SERVER_PASSWORD: "private-native-auth",
  };
  await writeFile(
    location.env,
    Object.entries(initial)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join("\n") + "\n",
    { mode: 0o600 },
  );
  await writeFile(join(location.units, "opennest-daemon.service"), "original native unit\n");
  const configuration = async () => parseEnvironment(await readFile(location.env, "utf8"));
  const calls = [],
    apiCalls = [],
    healthStates = [];
  let prepareFailure = false,
    apiPid = 8181,
    apiAccepting = true;
  let failCandidate = false,
    changeNative = false,
    pid = 4242,
    legacy = false,
    nativeVersion = "1.19.5",
    nextRuntime,
    pendingWorkCount = 0;
  const evidence = () =>
    nextRuntime
      ? {
          ...report(),
          runtime: nextRuntime,
          nativeVersions: ["1.19.5", "2.1.289"],
          scopes: [...report().scopes, { name: "runtime-transition", result: "passed" }],
        }
      : report();
  const offered = () => {
    const publication = manifest(evidence());
    if (nextRuntime) publication.applications.opennest.runtime = nextRuntime;
    return publication;
  };
  const run = async (command, args) => {
    calls.push({ command, args });
    if (command === "curl") {
      const url = args.at(-1);
      if (!nextRuntime && url.includes("/opennest-claude-latest/"))
        throw Object.assign(new Error("Claude channel is not published"), {
          code: 22,
          stderr: "curl: (22) error: 404",
        });
      return {
        stdout: url.endsWith("OpenNest-latest.json")
          ? JSON.stringify(legacy ? { schemaVersion: 1, version, commit: B } : offered())
          : url.endsWith("opennest-qualification.json")
            ? JSON.stringify(evidence())
            : installer,
        stderr: "",
      };
    }
    if (command === "claude") return { stdout: "2.1.289 (Claude Code)\n", stderr: "" };
    if (command === "/fixture/opencode") return { stdout: nativeVersion + "\n", stderr: "" };
    if (command === "systemctl" && args.includes("MainPID"))
      return { stdout: String(pid), stderr: "" };
    if (command === "systemctl" && args.includes("--property=MainPID"))
      return { stdout: String(pid), stderr: "" };
    if (
      command === "systemctl" &&
      args.includes("restart") &&
      (await configuration()).OPENNEST_VERSION === version &&
      failCandidate
    ) {
      if (changeNative) pid++;
      throw new Error("fixture candidate startup failure");
    }
    if (command === "systemctl" && args.includes("restart") && args.at(-1) === "opennest.service") {
      apiPid++;
      apiAccepting = true;
    }
    return { stdout: "", stderr: "" };
  };
  const api = async (route) => {
    apiCalls.push(route);
    if (route.endsWith("prepare")) {
      apiAccepting = false;
      if (prepareFailure) throw new Error("Controlled checkpoint write failure");
    }
    if (route.endsWith("resume")) apiAccepting = true;
    if (route === "health") healthStates.push(apiAccepting ? "ready" : "draining");
    return route === "health"
      ? {
          app: "opennest",
          provider: "open",
          status: "ok",
          recoveryState: apiAccepting ? "ready" : "draining",
          serverVersion: (await configuration()).OPENNEST_VERSION,
          restartProtocolVersion: 1,
          appServer: {
            state: "ready",
            installedVersion:
              (await configuration()).OPENNEST_RUNTIME === "claude" ? "2.1.289" : "1.19.5",
          },
        }
      : route.endsWith("prepare")
        ? { ready: true, supportedRunnerProtocols: [1], activeTurnCount: 0, pendingWorkCount }
        : { resumed: true };
  };
  const updater = createUpdater({
    location,
    env: {},
    run,
    configuration,
    api,
    verifyRelease: async (release) => ({ release, commit: release === previous ? A : B }),
    apiUnitText: (release) => `API=${release}\n`,
  });
  return {
    root,
    location,
    previous,
    target,
    state,
    calls,
    apiCalls,
    healthStates,
    apiPid: () => apiPid,
    nativePid: () => pid,
    failPrepare: () => {
      prepareFailure = true;
    },
    configuration,
    updater,
    fail: (nativeToo = false) => {
      failCandidate = true;
      changeNative = nativeToo;
    },
    legacy: () => {
      legacy = true;
    },
    transition: (pending = 0) => {
      nextRuntime = "claude";
      pendingWorkCount = pending;
    },
    unsupportedNative: () => {
      nativeVersion = "1.20.0";
    },
  };
}

test("qualification is application-specific, exact-SHA and complete", () => {
  const candidate = manifestCandidate(manifest());
  assert.equal(qualifyCandidate(candidate, report(), A, "1.19.5").commit, B);
  for (const patch of [
    { app: "codexnest" },
    { candidate: A },
    { baseline: B },
    { status: "skipped" },
    { restartProtocolVersion: 2 },
    { scopes: report().scopes.slice(1) },
    { workload: { nonArchivedSessions: 2, historyBytes: 100 } },
    { rollback: { ...report().rollback, previousReady: false } },
    { runs: { ...report().runs, cold: [] } },
    { nativeVersions: ["1.20.0"] },
    { workflow: { event: "push", conclusion: "success", headSha: B, runId: 123 } },
  ])
    assert.throws(() => qualifyCandidate(candidate, { ...report(), ...patch }, A, "1.19.5"));
  assert.equal(manifestCandidate({ schemaVersion: 1, version, commit: B }), null);
});
test("legacy channels offer no OpenNest candidate and do not touch native state", async (t) => {
  const f = await fixture(t);
  f.legacy();
  assert.equal((await f.updater.checkUpdate()).updateAvailable, false);
  await f.updater.updateWorker();
  assert.ok(f.calls.every((call) => call.command === "curl"));
  assert.equal(await realpath(join(f.root, "current")), f.previous);
});
test("qualified API update preserves the native unit and process identity", async (t) => {
  const f = await fixture(t);
  await f.updater.updateWorker();
  assert.equal(await realpath(join(f.root, "current")), f.target);
  assert.equal((await f.configuration()).OPENCODE_SERVER_PASSWORD, "private-native-auth");
  assert.equal(
    await readFile(join(f.location.units, "opennest-daemon.service"), "utf8"),
    "original native unit\n",
  );
  assert.deepEqual(
    f.calls
      .filter((call) => call.command === "systemctl" && call.args.includes("restart"))
      .map((call) => call.args),
    [["--user", "restart", "opennest.service"]],
  );
  assert.equal(JSON.parse(await readFile(join(f.state, "update.json"), "utf8")).result, "updated");
});
test("failed candidate automatically restores a ready previous API with the same native owner", async (t) => {
  const f = await fixture(t);
  f.fail();
  await assert.rejects(f.updater.updateWorker(), /previous ready version was restored/);
  assert.equal(await realpath(join(f.root, "current")), f.previous);
  assert.equal((await f.configuration()).OPENNEST_VERSION, oldVersion);
  assert.equal(
    JSON.parse(await readFile(join(f.state, "update.json"), "utf8")).result,
    "rolled_back",
  );
  assert.ok(
    f.calls
      .filter((call) => call.command === "systemctl" && call.args.includes("restart"))
      .every((call) => call.args.at(-1) === "opennest.service"),
  );
  await assert.rejects(readFile(join(f.root, "update-transaction.json")), { code: "ENOENT" });
});
test("a changed native owner blocks a successful rollback claim and retains recovery evidence", async (t) => {
  const f = await fixture(t);
  f.fail(true);
  await assert.rejects(f.updater.updateWorker(), /recovery was not confirmed/);
  assert.equal(JSON.parse(await readFile(join(f.state, "update.json"), "utf8")).result, "failed");
  assert.ok(await readFile(join(f.root, "update-transaction.json"), "utf8"));
});
test("unsupported native versions are rejected before source build or service changes", async (t) => {
  const f = await fixture(t);
  f.unsupportedNative();
  await assert.rejects(f.updater.updateWorker(), /OpenNest update failed/);
  assert.ok(f.calls.every((call) => !["git", "npm", "systemctl"].includes(call.command)));
  assert.equal(await realpath(join(f.root, "current")), f.previous);
});
test("retry finalizes an unswitched healthy transaction without restarting the API", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.root, "update-transaction.json"),
    JSON.stringify({
      schemaVersion: 1,
      previousRelease: f.previous,
      previousVersion: oldVersion,
      previousCommit: A,
      candidateRelease: f.target,
      candidateCommit: B,
      nativePid: 4242,
    }),
    { mode: 0o600 },
  );
  await f.updater.updateWorker();
  assert.equal(JSON.parse(await readFile(join(f.state, "update.json"), "utf8")).result, "failed");
  assert.equal(await realpath(join(f.root, "current")), f.previous);
  assert.ok(f.calls.every((call) => call.command !== "curl"));
});

test("checkpoint refusal preserves the running healthy baseline and native owner without candidate activation", async (t) => {
  const f = await fixture(t),
    apiPid = f.apiPid(),
    nativePid = f.nativePid();
  f.failPrepare();
  await assert.rejects(f.updater.updateWorker(), /previous ready API was preserved/);
  assert.equal(await realpath(join(f.root, "current")), f.previous);
  assert.equal((await f.configuration()).OPENNEST_VERSION, oldVersion);
  assert.equal(f.apiPid(), apiPid);
  assert.equal(f.nativePid(), nativePid);
  assert.ok(f.apiCalls.includes("internal/restart/prepare"));
  assert.ok(f.apiCalls.includes("internal/restart/resume"));
  assert.ok(
    f.healthStates.includes("draining"),
    "Preparation must model actual admission drain before checkpoint failure",
  );
  assert.equal(f.healthStates.at(-1), "ready");
  assert.ok(
    f.calls.every(
      (call) =>
        call.command !== "systemctl" ||
        !call.args.some((value) => ["restart", "start", "stop", "daemon-reload"].includes(value)),
    ),
  );
  const status = JSON.parse(await readFile(join(f.state, "update.json"), "utf8"));
  assert.equal(status.result, "failed");
  assert.match(status.message, /до переключения/);
  await assert.rejects(readFile(join(f.root, "update-transaction.json")), { code: "ENOENT" });
});

test("Claude transition requires distinct exact qualification", () => {
  const value = manifest();
  value.applications.opennest.runtime = "claude";
  const candidate = manifestCandidate(value);
  assert.throws(
    () => qualifyCandidate(candidate, report(), A, "1.19.5"),
    /transition qualification/,
  );
});

test("Claude transition starts the new API while preserving OpenCode", async (t) => {
  const f = await fixture(t);
  f.transition();
  await f.updater.updateWorker();
  assert.equal((await f.configuration()).OPENNEST_RUNTIME, "claude");
  assert.equal(await realpath(join(f.root, "current")), f.target);
  assert.equal(f.nativePid(), 4242);
});

test("failed Claude transition restores the previous mode and original OpenCode", async (t) => {
  const f = await fixture(t);
  f.transition();
  f.fail();
  await assert.rejects(f.updater.updateWorker(), /previous ready version was restored/);
  assert.equal((await f.configuration()).OPENNEST_RUNTIME, undefined);
  assert.equal(await realpath(join(f.root, "current")), f.previous);
  assert.equal(f.nativePid(), 4242);
  assert.equal(f.healthStates.at(-1), "ready");
});

test("Claude transition leaves a queued OpenCode task with the unchanged API", async (t) => {
  const f = await fixture(t);
  f.transition(1);
  const pid = f.apiPid();
  await assert.rejects(f.updater.updateWorker(), /stopped before switching/);
  assert.equal(await realpath(join(f.root, "current")), f.previous);
  assert.equal(f.apiPid(), pid);
  assert.equal(f.nativePid(), 4242);
  assert.equal(f.healthStates.at(-1), "ready");
});
