import assert from "node:assert/strict";
import { test } from "node:test";
import { healthyBaseline, requiredCases, validateScope } from "./report.mjs";

const candidate = "b".repeat(40);
function fixture() {
  return {
    schemaVersion: 1,
    candidate,
    native: "0.169.0",
    minimumNativeVersion: "0.167.0",
    baseline: { commit: healthyBaseline },
    scope: "all",
    completed: true,
    cases: requiredCases.all.map((name) => ({
      name,
      status: "passed",
      ...(name === "actual-native-import-and-metadata-index-rebuild"
        ? {
            nonArchivedSessions: 2000,
            archivedSessions: 40,
            nestedSessions: 8,
            longSessions: 8,
            bytes: 3 * 1024 ** 3,
            sparseFiles: false,
          }
        : {}),
    })),
    fixtureCounters: { directModelRequests: 0, directOAuthRequests: 0 },
    enforcedResources: { memoryMaxBytes: 10 * 1024 ** 3, cpuQuota: [400000, 100000] },
    budgetsMs: {
      ready: 60000,
      updaterHealth: 120000,
      rollback: 420000,
      threadListRpc: 120000,
      loadedListRpc: 30000,
    },
  };
}

test("accepts a complete native scope", () => {
  validateScope(fixture(), candidate, "0.169.0", "all", healthyBaseline);
});

for (const [name, mutate] of [
  [
    "another commit",
    (report) => {
      report.candidate = "a".repeat(40);
    },
  ],
  [
    "unfinished scope",
    (report) => {
      report.completed = false;
    },
  ],
  [
    "missing native rollback",
    (report) => {
      report.cases = report.cases.filter((entry) => entry.name !== "failed-B-automatic-A-slow-rpc");
    },
  ],
  [
    "skipped case",
    (report) => {
      report.cases[0].status = "skipped";
    },
  ],
  [
    "unresolved case",
    (report) => {
      report.pending = ["authorization"];
    },
  ],
  [
    "direct model egress",
    (report) => {
      report.fixtureCounters.directModelRequests = 1;
    },
  ],
  [
    "direct OAuth egress",
    (report) => {
      report.fixtureCounters.directOAuthRequests = 1;
    },
  ],
  [
    "smaller history",
    (report) => {
      report.cases.find((entry) => "bytes" in entry).bytes--;
    },
  ],
  [
    "weakened budget",
    (report) => {
      report.budgetsMs.ready = 120000;
    },
  ],
  [
    "late recovery",
    (report) => {
      report.cases.find((entry) => entry.name === "cold-B-1").savedWorkRecoveryMs = 60001;
    },
  ],
]) {
  test(`refuses qualification with ${name}`, () => {
    const report = fixture();
    mutate(report);
    assert.throws(() => validateScope(report, candidate, "0.169.0", "all", healthyBaseline));
  });
}
