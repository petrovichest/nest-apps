import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const nativeVersions = ["0.167.0", "0.167.1", "0.167.2", "0.169.0", "0.170.0", "0.171.0"];
export const healthyBaseline = "5779121e2e58ad4b73a8cacda22d704a619137ec";
export const installedBaseline = "f42edbee78b582bb54c96ab7bfc732286f10a667";
const incidentBaseline = "fe3c5c858344b5f03c2619250b01d351930c891b";
const baselineHashes = {
  [healthyBaseline]: "98869c3475a265637ea876d63c6bb3a769f2e641fdc66f7923e51810d5aa6a86",
  [installedBaseline]: "263410a46f2af777c215463f6754af2d4c06637a963c269ecb0f64805b9b90f1",
  [incidentBaseline]: "0642c7e8a4cfbd5d3cef539d797d7f109cfa0453399b2640830dc02f3745e316",
};
export const requiredCases = {
  unsupported: ["published-installer-A", "unsupported-native-update-refused-with-work-intact"],
  clean: [
    "candidate-clean-installer-B",
    "clean-install-confirmation-and-surviving-private-work",
    "expired-credentials-on-native-startup",
    "failed-oauth-on-native-startup",
    "transient-native-timeout-recovers-readiness",
    "legacy-rollback-writer-handover",
    "other-packaged-applications-startup",
  ],
  interruption: [
    "published-installer-A",
    "busy-upgrade-preserves-work",
    ...["prepared", "pointer", "candidate-recovery", "candidate-confirmation"].map(
      (point) => `old-updater-interrupted-${point}`,
    ),
    "completed-upgrade-after-interruptions",
    "restore-A-before-failed-upgrade",
    "repeat-upgrade-after-manual-rollback",
  ],
  all: [
    "published-installer-A",
    "representative-synthetic-history-files",
    "actual-native-import-and-metadata-index-rebuild",
    ...["cold-A", "warm-A-idle", "cold-B", "warm-B"].flatMap((name) =>
      [1, 2, 3].map((index) => `${name}-${index}`),
    ),
    "busy-upgrade-preserves-work",
    "installed-old-updater-A-to-B",
    "expired-credentials-on-native-startup",
    "failed-oauth-on-native-startup",
    "transient-native-timeout-recovers-readiness",
    "temporary-native-transport-unavailable",
    "restore-A-before-failed-upgrade",
    ...["wrong-version", "no-http", "no-token", "slow-rpc", "rotated-auth"].map(
      (mode) => `failed-B-automatic-A-${mode}`,
    ),
    "unavailable-native-refuses-update",
    "artifact-download-failure-keeps-A",
    "incompatible-artifact-protocol-keeps-A",
    "failed-state-checkpoint-keeps-A",
    "missing-build-dependency-keeps-A",
    "repeat-upgrade-after-failed-candidates",
    "history-integrity-after-rollback",
  ],
};

export function validateScope(report, candidate, native, scope, baseline) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.candidate, candidate, "Qualification SHA mismatch");
  assert.equal(report.native, native);
  assert.equal(report.minimumNativeVersion, nativeVersions[0]);
  assert.equal(report.scope, scope);
  assert.equal(report.baseline.commit, baseline);
  assert.equal(report.completed, true, "Native scope did not complete");
  assert.deepEqual(report.pending ?? [], []);
  assert.equal(new Set(report.cases.map((entry) => entry.name)).size, report.cases.length);
  for (const name of requiredCases[scope]) {
    const entry = report.cases.find((entry) => entry.name === name);
    assert.equal(entry?.status, "passed", `Missing or failed mandatory case: ${name}`);
  }
  assert.ok(report.cases.every((entry) => entry.status === "passed"));
  if (["all", "interruption"].includes(scope)) {
    const busy = report.cases.find((entry) => entry.name === "busy-upgrade-preserves-work");
    assert.equal(busy.updateResult, baseline === healthyBaseline ? "updated" : "refused");
    for (const key of [
      "activeRequestCount",
      "queuedRequestCount",
      "managedBackgroundResults",
      "managedBackgroundDeliveries",
    ])
      assert.equal(busy[key], 1, `Busy upgrade did not preserve ${key}`);
    assert.equal(busy.restoredApproval, true);
    if (baseline === healthyBaseline) {
      for (const entry of report.cases.filter(
        (entry) =>
          entry.name.startsWith("failed-B-automatic-A-") ||
          entry.name.startsWith("old-updater-interrupted-"),
      )) {
        assert.equal(entry.activeRequestCount, 1, `${entry.name}: active work was not recovered`);
        assert.equal(entry.queuedRequestCount, 1);
        assert.equal(entry.restoredApproval, true);
        assert.equal(entry.managedBackgroundResults, 1);
        assert.equal(entry.managedBackgroundDeliveries, 1);
      }
    }
    if (scope === "interruption" && baseline === installedBaseline) {
      const selection = report.cases.find(
        (entry) => entry.name === "configured-cli-over-shared-runtime",
      );
      assert.equal(selection?.status, "passed");
      assert.equal(selection.shadowed, "codex-cli 0.144.6");
      assert.equal(selection.configured, `codex-cli ${native}`);
    }
  }
  assert.equal(report.fixtureCounters.directModelRequests, 0);
  assert.equal(report.fixtureCounters.directOAuthRequests, 0);
  assert.equal(report.enforcedResources.memoryMaxBytes, 10 * 1024 ** 3);
  assert.equal(report.enforcedResources.cpuQuota[0] / report.enforcedResources.cpuQuota[1], 4);
  assert.equal(report.budgetsMs.ready, 60_000);
  assert.equal(report.budgetsMs.updaterHealth, 120_000);
  assert.equal(report.budgetsMs.rollback, 420_000);
  assert.equal(report.budgetsMs.threadListRpc, 120_000);
  assert.equal(report.budgetsMs.loadedListRpc, 30_000);
  if (scope === "unsupported") {
    const refusal = report.cases.find(
      (entry) => entry.name === "unsupported-native-update-refused-with-work-intact",
    );
    assert.equal(refusal.nativeRefusalBeforeSwitch, true);
    assert.equal(refusal.activeAndRollbackTargetsPreserved, true);
  }
  if (scope === "all") {
    const history = report.cases.find(
      (entry) => entry.name === "actual-native-import-and-metadata-index-rebuild",
    );
    assert.ok(history.nonArchivedSessions >= 2200 && history.archivedSessions > 0);
    assert.ok(history.nestedSessions > 0 && history.longSessions > 0);
    assert.ok(history.bytes >= 12 * 1024 ** 3 && history.sparseFiles === false);
  }
  for (const entry of report.cases) {
    for (const key of ["savedWorkRecoveryMs", "totalRecoveryMs", "readyMs"])
      if (key in entry) assert.ok(entry[key] <= report.budgetsMs.ready, `${entry.name}: ${key}`);
    if ("fullRecoveryMs" in entry) assert.ok(entry.fullRecoveryMs <= report.budgetsMs.rollback);
  }
}

const environmentNativeVersions = ["0.154.0", ...nativeVersions];
const lifecycleScopes = [
  ...nativeVersions.map((native) => ["lifecycle", native, "all", healthyBaseline]),
  ["clean-install", "0.169.0", "clean", healthyBaseline],
  ["interruption", "0.167.2", "interruption", healthyBaseline],
  ["interruption", "0.169.0", "interruption", healthyBaseline],
  ["interruption", "0.169.0", "interruption", incidentBaseline],
  ["interruption", "0.169.0", "interruption", installedBaseline],
  ["unsupported-native", "0.154.0", "unsupported", installedBaseline],
];

async function collect(directory, candidate, installerHash) {
  const evidence = [];
  const read = async (artifact, file) => {
    const bytes = await readFile(join(directory, artifact, file));
    evidence.push({ artifact, file, sha256: createHash("sha256").update(bytes).digest("hex") });
    return bytes.toString();
  };
  for (const native of environmentNativeVersions) {
    const artifact = `release-environment-${candidate}-${native}`;
    const environment = JSON.parse(await read(artifact, "environment.json"));
    assert.equal(environment.phase, "environment-only");
    assert.equal(environment.candidate, candidate);
    assert.equal(environment.native, native);
    const version = JSON.parse(await read(artifact, "native-version.json"));
    assert.equal(version.cliVersion, native);
    assert.equal(version.appServerVersion, native);
  }
  for (const [kind, native, scope, baseline] of lifecycleScopes) {
    const suffix =
      kind === "clean-install"
        ? ""
        : `-${native}${kind === "interruption" ? `-${baseline === healthyBaseline ? "current" : baseline === installedBaseline ? "installed" : "incident"}` : ""}`;
    const artifact = `${kind}-diagnostics-${candidate}${suffix}`;
    const report = JSON.parse(await read(artifact, "lifecycle.json"));
    validateScope(report, candidate, native, scope, baseline);
    assert.equal(
      (await read(artifact, "candidate-installer-sha256.txt")).split(/\s/)[0],
      installerHash,
    );
    assert.equal(
      (await read(artifact, "baseline-installer-sha256.txt")).split(/\s/)[0],
      baselineHashes[baseline],
    );
    await read(artifact, "native-binary-sha256.txt");
    const resources = JSON.parse(await read(artifact, "resources.json"));
    assert.equal(Number(resources["memory.max"]), 10 * 1024 ** 3);
    assert.equal(resources["cpu.max"], "400000 100000");
    for (const counter of ["oom", "oom_kill", "oom_group_kill"])
      assert.match(resources["memory.events"], new RegExp(`(?:^|\\n)${counter} 0(?:\\n|$)`));
  }
  return {
    schemaVersion: 1,
    candidate,
    installerHash,
    baseline: healthyBaseline,
    nativeVersions,
    minimumNativeVersion: nativeVersions[0],
    legacyTransition: "legacy updates idle only; compatible current updates preserve active work",
    qualified: true,
    sourceRun: process.env.GITHUB_RUN_ID,
    evidence,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, directory, candidate, installerHash] = process.argv.slice(2);
  assert.match(candidate, /^[0-9a-f]{40}$/);
  assert.match(installerHash, /^[0-9a-f]{64}$/);
  if (mode === "collect") {
    const result = await collect(directory, candidate, installerHash);
    await writeFile("qualification.json", `${JSON.stringify(result, null, 2)}\n`);
  } else {
    assert.equal(mode, "check");
    const result = JSON.parse(await readFile(join(directory, "qualification.json"), "utf8"));
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.candidate, candidate);
    assert.equal(result.installerHash, installerHash);
    assert.equal(result.baseline, healthyBaseline);
    assert.deepEqual(result.nativeVersions, nativeVersions);
    assert.equal(result.minimumNativeVersion, nativeVersions[0]);
    assert.equal(result.qualified, true);
    assert.equal(result.sourceRun, process.env.QUALIFIED_RUN_ID);
    assert.equal(
      result.evidence.length,
      environmentNativeVersions.length * 2 + lifecycleScopes.length * 5,
    );
  }
}
