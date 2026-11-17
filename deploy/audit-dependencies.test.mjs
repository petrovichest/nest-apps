import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { blockingDependencies } from "./audit-dependencies.mjs";

const require = createRequire(import.meta.url);
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const parser = readFileSync(require.resolve("picomatch/lib/parse.js"));
const fixture = () => ({
  auditReportVersion: 2,
  vulnerabilities: {
    picomatch: {
      nodes: ["node_modules/picomatch"],
      via: [{ url: "https://github.com/advisories/GHSA-fc5q-39xc-vjpf", severity: "high" }],
    },
    tinyglobby: { via: ["picomatch"] },
    vite: { via: ["tinyglobby"] },
  },
});

test("accepts only the known advisory on the checksum-verified upstream patch", () => {
  assert.deepEqual(blockingDependencies(fixture(), lock, parser), []);
  const changedLock = structuredClone(lock);
  changedLock.packages["node_modules/picomatch"].resolved =
    "https://registry.npmjs.org/picomatch/-/picomatch-4.0.7.tgz";
  assert.throws(() => blockingDependencies(fixture(), changedLock, parser));
  assert.throws(() => blockingDependencies(fixture(), lock, Buffer.from("unpatched parser")));
});

test("still blocks a new advisory on the same package and its dependents", () => {
  const report = fixture();
  report.vulnerabilities.picomatch.via.push({
    url: "https://example.invalid/new-advisory",
    severity: "high",
  });
  assert.deepEqual(blockingDependencies(report, lock, parser), ["picomatch", "tinyglobby", "vite"]);
});

test("still blocks unrelated high and critical vulnerabilities", () => {
  for (const severity of ["high", "critical"]) {
    const report = fixture();
    report.vulnerabilities.other = { via: [{ severity }] };
    assert.deepEqual(blockingDependencies(report, lock, parser), ["other"]);
  }
});

test("refuses incomplete reports and unverified nested copies", () => {
  assert.throws(() => blockingDependencies({ error: {} }, lock, parser));
  const report = fixture();
  delete report.vulnerabilities.picomatch;
  assert.throws(() => blockingDependencies(report, lock, parser));
  const nested = fixture();
  nested.vulnerabilities.picomatch.nodes.push("node_modules/vite/node_modules/picomatch");
  assert.throws(() => blockingDependencies(nested, lock, parser));
});

test("the installed matcher rejects hostile repeated extglobs within a process deadline", () => {
  execFileSync(
    process.execPath,
    [
      "--input-type=commonjs",
      "-e",
      `
    const assert = require('node:assert/strict');
    const p = require('picomatch');
    for (const pattern of ['+(*)', '*(*)', '+(*a)', '*(*a)', '+(*a*)', '+(*a|b)', '*(a*|b)']) {
      assert.equal(p.isMatch('a'.repeat(5000) + '/', pattern), false);
    }
    assert.equal(p.isMatch('src/index.ts', '**/*.ts'), true);
    assert.equal(p.isMatch('src/index.js', '**/*.ts'), false);
    assert.equal(p.isMatch('xabb', '+(*a|b)'), true);
    assert.equal(p.isMatch('a/b', '+(*)'), false);
  `,
    ],
    { cwd: new URL("..", import.meta.url), timeout: 2000 },
  );
});
