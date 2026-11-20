import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { qualifyCandidate } from "../../../apps/open-server/scripts/update.mjs";

export const bootstrapBaseline = "7b742ce0ad920f8b247c4295365be7057948a905";
export const nativeVersion = "1.19.5";
export const bootstrapInstallerSha256 =
  "192393d039b10982cdead831cd53c5662402d4149f3bfeea28b618bb9ac4bb71";
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
  assert.equal(resources.memoryHighBytes, 9 * 1024 ** 3);
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

const claudeVersion = "2.1.289";
export function validateClaudeLifecycle(lifecycle) {
  const evidence = lifecycle.claude;
  assert.equal(evidence?.version, claudeVersion);
  assert.ok(Number.isSafeInteger(evidence.workload?.nonArchivedSessions));
  assert.ok(evidence.workload.nonArchivedSessions >= 2000);
  assert.ok(evidence.workload.archivedSessions >= 50);
  assert.ok(evidence.workload.childTranscripts >= 20);
  assert.ok(Number.isSafeInteger(evidence.workload.historyBytes));
  assert.ok(evidence.workload.historyBytes >= 3 * 1024 ** 3);
  measured(evidence.rollbackMs, 420000);
  const cases = new Map(lifecycle.cases.map((entry) => [entry.name, entry]));
  const check = (name) => {
    const value = cases.get(name);
    assert.equal(value?.status, "passed", `Missing exact Claude evidence: ${name}`);
    return value;
  };
  assert.equal(check("claude-clean-install").freshNativeWork, true);
  assert.equal(check("claude-installed-updater-transition").sameOldNative, true);
  assert.equal(check("claude-installed-updater-transition").nativeWork, true);
  assert.equal(check("claude-failed-transition-rolls-back").sameNative, true);
  assert.equal(check("claude-failed-transition-rolls-back").resumedOldSession, true);
  check("claude-refuses-active-legacy-work");
  if (lifecycle.baseline.runtime === "claude") {
    const upgrade = check("claude-published-upgrade");
    assert.equal(upgrade.sameOwner, true);
    assert.equal(upgrade.workResumed, true);
    assert.equal(upgrade.privateBoard, true);
    measured(upgrade.readyMs, 30000);
    measured(upgrade.totalRecoveryMs, 420000);
    assert.ok(upgrade.workload.nonArchivedSessions >= 2000);
    assert.ok(upgrade.workload.archivedSessions >= 50);
    assert.ok(upgrade.workload.childTranscripts >= 20);
    assert.ok(upgrade.workload.historyBytes >= 3 * 1024 ** 3);
  }
  for (const mode of ["cold", "warm"]) {
    assert.equal(evidence[mode]?.length, 3);
    for (const [index, result] of evidence[mode].entries()) {
      assert.equal(result.result, "passed");
      measured(result.durationMs, 30000);
      const run = check(`claude-${mode}-${index + 1}`);
      assert.equal(run.nativeWork, true);
      assert.equal(run.ownerPreserved, mode === "warm");
    }
  }
  return evidence;
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
      lifecycle.baseline.runtime ?? "opencode",
      baselineManifest.applications.opennest.runtime ?? "opencode",
      "Published OpenNest baseline runtime differs from the tested runtime",
    );
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
  if (report.runtime === "claude") {
    assert.deepEqual(report.nativeVersions, [nativeVersion, claudeVersion]);
    validateClaudeLifecycle(lifecycle);
  } else {
    assert.equal(report.runtime, undefined);
    assert.deepEqual(report.nativeVersions, [nativeVersion]);
  }
  assert.equal(report.restartProtocolVersion, 1);
  qualifyCandidate(
    {
      version: `0.1.9-${candidate.slice(0, 7)}`,
      commit: candidate,
      installer: { sha256: installerSha256 },
      ...(report.runtime ? { runtime: report.runtime } : {}),
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
  validateClaudeLifecycle(lifecycle);
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
    runtime: "claude",
    nativeVersions: [nativeVersion, claudeVersion],
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
      "runtime-transition",
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
          applications: {
            opennest: {
              installer: { sha256: lifecycle.baseline.installerSha256 },
              runtime: lifecycle.baseline.runtime,
            },
          },
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
