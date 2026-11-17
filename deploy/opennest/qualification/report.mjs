import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { qualifyCandidate } from "../../../apps/open-server/scripts/update.mjs";

export const bootstrapBaseline = "2088ee59d442bd0882c7c65d671d8a8f37aa00d6";
export const nativeVersion = "1.19.5";
export const bootstrapInstallerSha256 =
  "5067427e8523cdb369f669e7c552de3998da1062f279e1acdc820150d125c879";
export const nativeBinarySha256 =
  "7df4e4136301f16589b0f30bf91a61380fca5f8ef22dd36570f5ebe1d4ec802c";
export const requiredCases = [
  "baseline-clean-install",
  "candidate-clean-install",
  "failed-clean-install-retry",
  "native-history-integrity",
  "baseline-native-history-integrity",
  "transient-native-outage-recovers",
  "failed-state-checkpoint-keeps-A",
  "missing-build-dependency-keeps-A",
  ...["cold-A", "warm-A", "cold-B", "warm-B"].flatMap((mode) =>
    [1, 2, 3].map((index) => `${mode}-${index}`),
  ),
  "live-daemon-reconnect",
  "installed-updater-A-to-B",
  ...["wrong-version", "no-http", "no-token", "slow-native", "rotated-auth"].map(
    (mode) => `failed-B-automatic-A-${mode}`,
  ),
  "failed-B-automatic-A-native-auth",
  "interrupted-updater-recovery",
  "unavailable-native-refuses-update",
  "failed-artifact-keeps-A",
  "incompatible-protocol-keeps-A",
  "repeated-update-after-rollback",
  "work-and-history-after-rollback",
  "unsupported-native-refused",
];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const commit = (value) => assert.match(value, /^[0-9a-f]{40}$/);
const checksum = (value) => assert.match(value, /^[0-9a-f]{64}$/);
function measured(value, maximum = Number.MAX_SAFE_INTEGER) {
  assert.ok(
    typeof value === "number" && Number.isFinite(value) && value > 0 && value <= maximum,
    `Invalid or excessive measurement: ${value}`,
  );
}
/** An older green run must not conceal a later failed or unfinished check. */
export function validateSourceChecks(value, candidate) {
  commit(candidate);
  for (const name of ["verify", "opennest-native-contract"]) {
    const checks = value.check_runs
      .filter(
        (entry) =>
          entry.name === name &&
          entry.app?.slug === "github-actions" &&
          entry.head_sha === candidate,
      )
      .sort((a, b) => b.id - a.id);
    assert.ok(checks.length, `Missing exact source check: ${name}`);
    assert.equal(checks[0].status, "completed", `Latest ${name} is unfinished`);
    assert.equal(checks[0].conclusion, "success", `Latest ${name} did not pass`);
  }
}

export function validateLifecycle(report, candidate, baseline, installerSha256) {
  commit(candidate);
  commit(baseline);
  checksum(installerSha256);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.app, "opennest");
  assert.equal(report.candidate, candidate);
  assert.equal(report.native, nativeVersion);
  assert.equal(report.completed, true);
  assert.notEqual(report.fixture, true);
  assert.notEqual(report.provisional, true);
  assert.deepEqual(report.pending ?? [], []);
  assert.equal(report.installerSha256, installerSha256);
  assert.equal(report.baseline.commit, baseline);
  assert.equal(report.baseline.healthy, true);
  assert.equal(report.baseline.independentlyQualified, true);
  checksum(report.baseline.installerSha256);
  assert.ok(["first-release", "published"].includes(report.baseline.kind));
  if (report.baseline.kind === "first-release") {
    assert.equal(baseline, bootstrapBaseline);
    assert.equal(report.baseline.installerSha256, bootstrapInstallerSha256);
  }
  const entries = report.cases;
  assert.ok(Array.isArray(entries));
  assert.equal(new Set(entries.map((entry) => entry.name)).size, entries.length);
  for (const name of requiredCases)
    assert.equal(
      entries.find((entry) => entry.name === name)?.status,
      "passed",
      `Missing or failed native case: ${name}`,
    );
  for (const entry of entries) {
    assert.equal(entry.status, "passed");
    measured(entry.durationMs);
    if (entry.readyMs !== undefined) measured(entry.readyMs, 30000);
    if (entry.totalRecoveryMs !== undefined) measured(entry.totalRecoveryMs, 420000);
  }
  const workload = report.workload;
  assert.ok(
    Number.isSafeInteger(workload.nonArchivedSessions) && workload.nonArchivedSessions >= 2000,
  );
  for (const name of ["archivedSessions", "nestedSessions", "longSessions", "projects"])
    measured(workload[name]);
  measured(workload.nativeDatabaseBytes);
  measured(workload.referencedFileBytes);
  assert.ok(workload.historyBytes >= 3 * 1024 ** 3);
  assert.equal(workload.historyBytes, workload.nativeDatabaseBytes + workload.referencedFileBytes);
  assert.equal(workload.sparseFiles, false);
  assert.equal(workload.storageRepresentation, "opencode-v1-sqlite-and-file-parts");
  assert.deepEqual(report.budgetsMs, { ready: 30000, updaterHealth: 60000, rollback: 420000 });
  for (const mode of ["coldA", "warmA", "coldB", "warmB"]) {
    const runs = report.runs[mode];
    assert.ok(Array.isArray(runs) && runs.length === 3);
    for (const run of runs) {
      assert.equal(run.result, "passed");
      measured(run.durationMs, 30000);
      assert.equal(run.savedWorkReady, true);
    }
  }
  for (const key of ["directModelRequests", "unexpectedExternalRequests"])
    assert.equal(report.fixtureCounters[key], 0);
  const resources = report.resources;
  assert.equal(resources.memoryMaxBytes, 10 * 1024 ** 3);
  assert.equal(resources.cpuQuota, "400000 100000");
  measured(resources.memoryPeakBytes, resources.memoryMaxBytes);
  assert.equal(resources.oomKills, 0);
  assert.equal(resources.oomEvents, 0);
  for (const key of [
    "automatic",
    "previousReady",
    "workResumed",
    "nativePidPreserved",
    "stateIntact",
  ])
    assert.equal(report.rollback[key], true);
  measured(report.rollback.durationMs, 420000);
  return report;
}

export function validatePublishedReport(
  report,
  candidate,
  installerSha256,
  baselineManifest = null,
) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.app, "opennest");
  assert.equal(report.status, "passed");
  assert.notEqual(report.fixture, true);
  assert.notEqual(report.provisional, true);
  assert.equal(report.candidate, candidate);
  assert.equal(report.installerSha256, installerSha256);
  const lifecycle = validateLifecycle(
    report.lifecycle,
    candidate,
    report.baseline,
    installerSha256,
  );
  if (lifecycle.baseline.kind === "first-release")
    assert.equal(
      baselineManifest,
      null,
      "First-release exception cannot replace an existing OpenNest publication",
    );
  else {
    assert.ok(baselineManifest?.applications?.opennest);
    assert.equal(baselineManifest.commit, report.baseline, "Published OpenNest baseline moved");
    assert.equal(
      baselineManifest.applications.opennest.installer.sha256,
      lifecycle.baseline.installerSha256,
      "Published baseline installer changed",
    );
  }
  assert.equal(report.workflow.event, "workflow_dispatch");
  assert.equal(report.workflow.conclusion, "success");
  assert.equal(report.workflow.headSha, candidate);
  assert.ok(Number.isSafeInteger(report.workflow.runId) && report.workflow.runId > 0);
  assert.deepEqual(report.nativeVersions, [nativeVersion]);
  assert.equal(report.restartProtocolVersion, 1);
  qualifyCandidate(
    {
      version: `0.1.9-${candidate.slice(0, 7)}`,
      commit: candidate,
      installer: { sha256: installerSha256 },
    },
    report,
    report.baseline,
    nativeVersion,
  );
  assert.ok(Array.isArray(report.evidence) && report.evidence.length >= 4);
  for (const entry of report.evidence) {
    assert.ok(typeof entry.file === "string" && !entry.file.includes(".."));
    checksum(entry.sha256);
  }
  return report;
}

export async function collect(directory, candidate, installerSha256, runId) {
  const evidence = [];
  const read = async (file) => {
    const bytes = await readFile(join(directory, file));
    evidence.push({ file, sha256: hash(bytes) });
    return bytes.toString();
  };
  const lifecycle = JSON.parse(await read("lifecycle.json"));
  validateLifecycle(lifecycle, candidate, lifecycle.baseline.commit, installerSha256);
  assert.equal((await read("candidate-installer-sha256.txt")).split(/\s/)[0], installerSha256);
  assert.equal(
    (await read("baseline-installer-sha256.txt")).split(/\s/)[0],
    lifecycle.baseline.installerSha256,
  );
  assert.equal((await read("native-binary-sha256.txt")).split(/\s/)[0], nativeBinarySha256);
  const resources = JSON.parse(await read("resources.json"));
  assert.deepEqual(resources, lifecycle.resources);
  const result = {
    schemaVersion: 1,
    app: "opennest",
    candidate,
    status: "passed",
    baseline: lifecycle.baseline.commit,
    baselineHealthy: true,
    baselineKind: lifecycle.baseline.kind,
    installerSha256,
    restartProtocolVersion: 1,
    nativeVersions: [nativeVersion],
    workload: lifecycle.workload,
    budgets: { startupMs: 30000, rollbackMs: 420000 },
    runs: { cold: lifecycle.runs.coldB, warm: lifecycle.runs.warmB },
    rollback: lifecycle.rollback,
    scopes: [
      "clean-install",
      "large-history-cold",
      "large-history-warm",
      "upgrade",
      "failed-update-rollback",
      "retry-after-failure",
      "active-work",
    ].map((name) => ({ name, result: "passed" })),
    workflow: {
      event: "workflow_dispatch",
      conclusion: "success",
      headSha: candidate,
      runId: Number(runId),
    },
    lifecycle,
    evidence,
  };
  validatePublishedReport(
    result,
    candidate,
    installerSha256,
    lifecycle.baseline.kind === "published"
      ? {
          commit: lifecycle.baseline.commit,
          applications: { opennest: { installer: { sha256: lifecycle.baseline.installerSha256 } } },
        }
      : null,
  );
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, directory, candidate, installerSha256, extra] = process.argv.slice(2);
  if (mode === "collect") {
    await writeFile(
      join(directory, "qualification.json"),
      JSON.stringify(
        await collect(directory, candidate, installerSha256, process.env.GITHUB_RUN_ID),
        null,
        2,
      ) + "\n",
    );
  } else {
    assert.equal(mode, "check");
    const report = JSON.parse(await readFile(join(directory, "qualification.json"), "utf8"));
    const baseline = extra ? JSON.parse(await readFile(extra, "utf8")) : null;
    validatePublishedReport(report, candidate, installerSha256, baseline);
    if (process.env.QUALIFIED_RUN_ID)
      assert.equal(report.workflow.runId, Number(process.env.QUALIFIED_RUN_ID));
    for (const entry of report.evidence)
      assert.equal(
        hash(await readFile(join(directory, entry.file))),
        entry.sha256,
        `Qualification evidence changed: ${entry.file}`,
      );
  }
}
