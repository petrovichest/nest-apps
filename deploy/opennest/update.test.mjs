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
const baseURL = "https://github.com/petrovichest/nest-apps/releases/download/rolling-latest/";
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
  const calls = [];
  let failCandidate = false,
    changeNative = false,
    pid = 4242,
    legacy = false,
    nativeVersion = "1.19.5";
  const run = async (command, args) => {
    calls.push({ command, args });
    if (command === "curl") {
      const url = args.at(-1);
      return {
        stdout: url.endsWith("NestApps-latest.json")
          ? JSON.stringify(legacy ? { schemaVersion: 1, version, commit: B } : manifest())
          : url.endsWith("opennest-qualification.json")
            ? JSON.stringify(report())
            : installer,
        stderr: "",
      };
    }
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
    return { stdout: "", stderr: "" };
  };
  const api = async (route) =>
    route === "health"
      ? {
          app: "opennest",
          provider: "open",
          status: "ok",
          recoveryState: "ready",
          serverVersion: (await configuration()).OPENNEST_VERSION,
          restartProtocolVersion: 1,
          appServer: { state: "ready", installedVersion: "1.19.5" },
        }
      : route.endsWith("prepare")
        ? { ready: true, supportedRunnerProtocols: [1] }
        : { resumed: true };
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
    configuration,
    updater,
    fail: (nativeToo = false) => {
      failCandidate = true;
      changeNative = nativeToo;
    },
    legacy: () => {
      legacy = true;
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
test("retry first recovers an orphaned transaction and preserves its confirmed rollback result", async (t) => {
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
  assert.equal(
    JSON.parse(await readFile(join(f.state, "update.json"), "utf8")).result,
    "rolled_back",
  );
  assert.equal(await realpath(join(f.root, "current")), f.previous);
  assert.ok(f.calls.every((call) => call.command !== "curl"));
});
