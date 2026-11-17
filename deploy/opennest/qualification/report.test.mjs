import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bootstrapBaseline,
  bootstrapInstallerSha256,
  requiredCases,
  validateLifecycle,
  validatePublishedReport,
  validateSourceChecks,
} from "./report.mjs";
const candidate = "b".repeat(40),
  installer = "c".repeat(64);
function lifecycle() {
  return {
    schemaVersion: 1,
    app: "opennest",
    candidate,
    native: "1.19.5",
    completed: true,
    pending: [],
    installerSha256: installer,
    baseline: {
      commit: bootstrapBaseline,
      kind: "first-release",
      healthy: true,
      independentlyQualified: true,
      installerSha256: bootstrapInstallerSha256,
    },
    cases: requiredCases.map((name) => ({ name, status: "passed", durationMs: 1 })),
    workload: {
      nonArchivedSessions: 2000,
      archivedSessions: 40,
      nestedSessions: 8,
      longSessions: 8,
      projects: 20,
      nativeDatabaseBytes: 3 * 1024 ** 3,
      referencedFileBytes: 4096,
      historyBytes: 3 * 1024 ** 3 + 4096,
      sparseFiles: false,
      storageRepresentation: "opencode-v1-sqlite-and-file-parts",
    },
    budgetsMs: { ready: 30000, updaterHealth: 60000, rollback: 420000 },
    runs: Object.fromEntries(
      ["coldA", "warmA", "coldB", "warmB"].map((mode) => [
        mode,
        [1, 2, 3].map(() => ({ result: "passed", durationMs: 1, savedWorkReady: true })),
      ]),
    ),
    fixtureCounters: { directModelRequests: 0, unexpectedExternalRequests: 0 },
    resources: {
      memoryMaxBytes: 10 * 1024 ** 3,
      memoryHighBytes: 9 * 1024 ** 3,
      cpuQuota: "400000 100000",
      memoryPeakBytes: 1024,
      oomKills: 0,
      oomEvents: 0,
    },
    rollback: {
      automatic: true,
      previousReady: true,
      workResumed: true,
      nativePidPreserved: true,
      stateIntact: true,
      durationMs: 1,
    },
  };
}
function report() {
  return {
    schemaVersion: 1,
    app: "opennest",
    candidate,
    status: "passed",
    baseline: bootstrapBaseline,
    baselineHealthy: true,
    workload: lifecycle().workload,
    budgets: { startupMs: 30000, rollbackMs: 420000 },
    runs: { cold: lifecycle().runs.coldB, warm: lifecycle().runs.warmB },
    rollback: lifecycle().rollback,
    scopes: [
      "clean-install",
      "large-history-cold",
      "large-history-warm",
      "upgrade",
      "failed-update-rollback",
      "retry-after-failure",
      "active-work",
    ].map((name) => ({ name, result: "passed" })),
    installerSha256: installer,
    nativeVersions: ["1.19.5"],
    restartProtocolVersion: 1,
    workflow: { event: "workflow_dispatch", conclusion: "success", headSha: candidate, runId: 123 },
    lifecycle: lifecycle(),
    evidence: [
      "lifecycle.json",
      "resources.json",
      "candidate-installer-sha256.txt",
      "native-binary-sha256.txt",
    ].map((file) => ({ file, sha256: installer })),
  };
}
test("accepts complete native evidence for the independent first-release baseline", () =>
  validateLifecycle(lifecycle(), candidate, bootstrapBaseline, installer));
for (const [name, mutate] of [
  [
    "missing native scenario",
    (v) => {
      v.cases = v.cases.slice(1);
    },
  ],
  [
    "skipped native scenario",
    (v) => {
      v.cases[0].status = "skipped";
    },
  ],
  [
    "unfinished matrix",
    (v) => {
      v.completed = false;
    },
  ],
  [
    "provisional registry authorization",
    (v) => {
      v.provisional = true;
    },
  ],
  [
    "fixture registry metadata",
    (v) => {
      v.fixture = true;
    },
  ],
  [
    "another source",
    (v) => {
      v.candidate = "a".repeat(40);
    },
  ],
  [
    "another native version",
    (v) => {
      v.native = "1.19.4";
    },
  ],
  [
    "unqualified baseline",
    (v) => {
      v.baseline.independentlyQualified = false;
    },
  ],
  [
    "less representative history",
    (v) => {
      v.workload.nonArchivedSessions = 1999;
    },
  ],
  [
    "padding instead of history",
    (v) => {
      v.workload.storageRepresentation = "padding";
    },
  ],
  [
    "less than3GiB",
    (v) => {
      v.workload.historyBytes = 2 * 1024 ** 3;
    },
  ],
  [
    "missing actual attachments",
    (v) => {
      v.workload.referencedFileBytes = 0;
    },
  ],
  [
    "incomplete cold repeats",
    (v) => {
      v.runs.coldB.pop();
    },
  ],
  [
    "startup over budget",
    (v) => {
      v.runs.warmA[0].durationMs = 30001;
    },
  ],
  [
    "weakened budget",
    (v) => {
      v.budgetsMs.ready = 120000;
    },
  ],
  [
    "OOM",
    (v) => {
      v.resources.oomKills = 1;
    },
  ],
  [
    "missing memory pressure budget",
    (v) => {
      delete v.resources.memoryHighBytes;
    },
  ],
  [
    "unenforced memory budget",
    (v) => {
      v.resources.memoryMaxBytes = 20 * 1024 ** 3;
    },
  ],
  [
    "direct model egress",
    (v) => {
      v.fixtureCounters.directModelRequests = 1;
    },
  ],
  [
    "work not resumed",
    (v) => {
      v.rollback.workResumed = false;
    },
  ],
  [
    "native owner replaced",
    (v) => {
      v.rollback.nativePidPreserved = false;
    },
  ],
  [
    "late rollback",
    (v) => {
      v.rollback.durationMs = 420001;
    },
  ],
])
  test(`rejects ${name}`, () => {
    const v = lifecycle();
    mutate(v);
    assert.throws(() => validateLifecycle(v, candidate, bootstrapBaseline, installer));
  });
test("first-release report cannot replace an already published OpenNest channel", () => {
  assert.throws(() =>
    validatePublishedReport(report(), candidate, installer, {
      commit: bootstrapBaseline,
      applications: { opennest: {} },
    }),
  );
});
test("published report binds the completed manual workflow and installer", () => {
  validatePublishedReport(report(), candidate, installer, null);
  const v = report();
  v.workflow.headSha = "d".repeat(40);
  assert.throws(() => validatePublishedReport(v, candidate, installer, null));
});

test("newer failed or unfinished source checks cannot be hidden by older successes", () => {
  const make = (id, name, conclusion = "success", status = "completed") => ({
    id,
    name,
    conclusion,
    status,
    head_sha: candidate,
    app: { slug: "github-actions" },
  });
  const checks = { check_runs: [make(1, "verify"), make(2, "opennest-native-contract")] };
  validateSourceChecks(checks, candidate);
  checks.check_runs.push(make(3, "verify", "failure"));
  assert.throws(() => validateSourceChecks(checks, candidate));
  checks.check_runs.push(make(4, "verify", null, "in_progress"));
  assert.throws(() => validateSourceChecks(checks, candidate));
  checks.check_runs.push(make(5, "verify"));
  validateSourceChecks(checks, candidate);
});
