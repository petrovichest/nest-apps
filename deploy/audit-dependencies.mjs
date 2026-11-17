import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const advisory = "https://github.com/advisories/GHSA-fc5q-39xc-vjpf";
const patchUrl =
  "https://codeload.github.com/micromatch/picomatch/tar.gz/d705935d4ece5f406df01213330f1a04adad3fe0";
const patchIntegrity =
  "sha512-QKlkxr4yFWwICCFD+8dtKG6qYeWwd64fQ+JJiErne8xhZQZGuQXitvXsLZVyDrlIY+EO6BLh65rURN9d+jgQUA==";
const parserHash = "0182f9e169ea69cb4d34e34bf956cae7cbcac4fdd7d2899a800f25a558129c40";
const levels = ["none", "info", "low", "moderate", "high", "critical"];

// npm still reports the upstream patch as vulnerable because its package
// version remains 4.0.7. Only this advisory on these exact patched bytes is fixed.
export function blockingDependencies(report, lock, parser) {
  assert.equal(report.auditReportVersion, 2);
  assert.ok(!report.error, "npm audit could not retrieve a complete report");
  assert.ok(report.vulnerabilities && typeof report.vulnerabilities === "object");
  const severities = new Map();
  const severity = (name, parents = new Set()) => {
    if (severities.has(name)) return severities.get(name);
    assert.ok(!parents.has(name), "Unresolved cycle in npm audit report");
    const entry = report.vulnerabilities[name];
    assert.ok(
      entry && Array.isArray(entry.via) && entry.via.length > 0,
      "Incomplete npm audit dependency chain",
    );
    let highest = 0;
    for (const via of entry.via) {
      if (typeof via === "string") {
        highest = Math.max(highest, severity(via, new Set([...parents, name])));
      } else if (name === "picomatch" && via.url === advisory) {
        assert.equal(lock.packages["node_modules/picomatch"].resolved, patchUrl);
        assert.equal(lock.packages["node_modules/picomatch"].integrity, patchIntegrity);
        assert.equal(createHash("sha256").update(parser).digest("hex"), parserHash);
        assert.deepEqual(entry.nodes, ["node_modules/picomatch"]);
      } else {
        const level = levels.indexOf(via.severity);
        assert.ok(level > 0, "Unknown npm advisory severity");
        highest = Math.max(highest, level);
      }
    }
    severities.set(name, highest);
    return highest;
  };
  return Object.keys(report.vulnerabilities).filter(
    (name) => severity(name) >= levels.indexOf("high"),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = spawnSync("npm", ["audit", "--json", "--include=dev"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  });
  assert.ok(!result.error && [0, 1].includes(result.status), "npm audit failed to complete");
  const report = JSON.parse(result.stdout);
  const require = createRequire(import.meta.url);
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  const blocked = blockingDependencies(
    report,
    lock,
    readFileSync(require.resolve("picomatch/lib/parse.js")),
  );
  console.log(`npm audit: ${JSON.stringify(report.metadata.vulnerabilities)}`);
  if (report.vulnerabilities.picomatch) {
    console.log(
      "Verified pinned upstream fix for GHSA-fc5q-39xc-vjpf; all other advisories remain enforced.",
    );
  }
  assert.deepEqual(blocked, [], `High/critical vulnerabilities remain: ${blocked.join(", ")}`);
}
