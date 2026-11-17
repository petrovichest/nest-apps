import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { validatePublishedReport, validateSourceChecks } from "./qualification/report.mjs";

const execute = promisify(execFile);
const repository = "petrovichest/nest-apps";
const candidate = process.env.OPENNEST_CANDIDATE;
const runId = process.env.QUALIFIED_RUN_ID;
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_run");
assert.equal(process.env.GITHUB_REPOSITORY, repository);
assert.match(candidate, /^[0-9a-f]{40}$/);
assert.match(runId, /^[1-9][0-9]*$/);
const version = `0.1.9-${candidate.slice(0, 7)}`;
const tag = `opennest-v${version}`;
const channel = "opennest-latest";
const root = join(process.env.RUNNER_TEMP, "qualified-opennest-publication");
await mkdir(root, { recursive: true });
const gh = async (args) => (await execute("gh", args, { maxBuffer: 8 * 1024 * 1024 })).stdout;
const api = async (path) => JSON.parse(await gh(["api", `repos/${repository}/${path}`]));
async function release(name) {
  try {
    return await api(`releases/tags/${name}`);
  } catch (error) {
    if (/HTTP 404/.test(error.stderr ?? "")) return null;
    throw error;
  }
}
const run = await api(`actions/runs/${runId}`);
assert.equal(run.event, "workflow_dispatch");
assert.equal(run.status, "completed");
assert.equal(run.conclusion, "success");
assert.equal(run.head_sha, candidate);
assert.equal(run.head_branch, "main");
assert.equal(run.path, ".github/workflows/opennest-qualification.yml");
assert.equal(
  (await api("git/ref/heads/main")).object.sha,
  candidate,
  "Main moved after qualification",
);
const checks = await api(`commits/${candidate}/check-runs?per_page=100`);
validateSourceChecks(checks, candidate);
const evidence = join(root, "evidence");
await gh([
  "run",
  "download",
  runId,
  "-R",
  repository,
  "-n",
  `opennest-qualified-release-${candidate}`,
  "-D",
  evidence,
]);
const hash = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const installerHash = await hash(join(evidence, "install-opennest.sh"));
const report = JSON.parse(await readFile(join(evidence, "qualification.json"), "utf8"));
const current = await release(channel);
const publications = JSON.parse(
  await gh(["api", `repos/${repository}/releases?per_page=100`, "--paginate", "--slurp"]),
).flat();
if (!current || current.draft) {
  const other = publications.find(
    (value) => !value.draft && value.tag_name.startsWith("opennest-v") && value.tag_name !== tag,
  );
  assert.equal(
    other,
    undefined,
    "A prior public OpenNest version exists; restore its channel before a new first-release attempt",
  );
}

let baselineManifest = null;
if (current && !current.draft) {
  const previous = join(root, "previous");
  await gh([
    "release",
    "download",
    channel,
    "-R",
    repository,
    "-p",
    "OpenNest-latest.json",
    "-D",
    previous,
  ]);
  baselineManifest = JSON.parse(await readFile(join(previous, "OpenNest-latest.json"), "utf8"));
}
const publicationRecovery = baselineManifest?.commit === candidate;
let validationBaseline = baselineManifest;
if (publicationRecovery) {
  const priorVersion = await release(tag);
  assert.ok(
    priorVersion && !priorVersion.draft,
    "A current channel must have an immutable public version",
  );
  if (report.lifecycle.baseline.kind === "first-release") validationBaseline = null;
  else {
    const previousVersion = `opennest-v0.1.9-${report.baseline.slice(0, 7)}`;
    const previousDirectory = join(root, "recovery-baseline");
    await gh([
      "release",
      "download",
      previousVersion,
      "-R",
      repository,
      "-p",
      "OpenNest-latest.json",
      "-D",
      previousDirectory,
    ]);
    validationBaseline = JSON.parse(
      await readFile(join(previousDirectory, "OpenNest-latest.json"), "utf8"),
    );
  }
}
validatePublishedReport(report, candidate, installerHash, validationBaseline);
assert.equal(report.workflow.runId, Number(runId));
for (const entry of report.evidence) {
  assert.equal(resolve(evidence, entry.file).startsWith(resolve(evidence) + "/"), true);
  assert.equal(
    await hash(join(evidence, entry.file)),
    entry.sha256,
    `Changed native evidence ${entry.file}`,
  );
}
const packagedSums = await readFile(join(evidence, "package-SHA256SUMS"), "utf8");
for (const name of [
  "install-opennest.sh",
  "OpenNest-latest.apk",
  "opennest-browser-latest.zip",
  "qualification.json",
]) {
  const line = packagedSums.split("\n").find((v) => v.endsWith(`  ${name}`));
  assert.ok(line, `Missing package checksum ${name}`);
  assert.equal(await hash(join(evidence, name)), line.split(/\s/)[0]);
}
const assets = [
  "install-opennest.sh",
  "OpenNest-latest.apk",
  "opennest-browser-latest.zip",
  "qualification.json",
].map((name) => join(evidence, name));
const base = `https://github.com/${repository}/releases/download/${tag}`;
const manifest = {
  schemaVersion: 1,
  version,
  commit: candidate,
  applications: {
    opennest: {
      installer: { url: `${base}/install-opennest.sh`, sha256: installerHash },
      qualification: {
        url: `${base}/qualification.json`,
        sha256: await hash(join(evidence, "qualification.json")),
      },
      android: {
        url: `${base}/OpenNest-latest.apk`,
        sha256: await hash(join(evidence, "OpenNest-latest.apk")),
      },
      extension: {
        url: `${base}/opennest-browser-latest.zip`,
        sha256: await hash(join(evidence, "opennest-browser-latest.zip")),
      },
    },
  },
};
const manifestPath = join(root, "OpenNest-latest.json");
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
const sums = join(root, "SHA256SUMS");
await writeFile(
  sums,
  (
    await Promise.all(
      [...assets, manifestPath].map(async (path) => `${await hash(path)}  ${basename(path)}`),
    )
  ).join("\n") + "\n",
);
const notes = join(root, "notes.md");
await writeFile(
  notes,
  `OpenNest ${version}\n\nOpenCode + OpenRouter. Exact source: ${candidate}.\n\nRequirements: Linux x86_64, Node.js 24, npm, Git, flock, bubblewrap and OpenCode 1.19.5.\n\nInstall:\n\n\`\`\`sh\ncurl -fsSL https://github.com/${repository}/releases/download/${tag}/install-opennest.sh | bash\n\`\`\`\n\nOpen http://127.0.0.1:4313. The owner token is stored in ~/.config/opennest/token.\n\nThe API, state, browser extension and Android package are independent from the other Nest apps. Signed APK and extension are attached.\n\nQualification: https://github.com/${repository}/actions/runs/${runId}. Includes real install, representative native history, cold/warm startup and automatic rollback preserving the native process and work.\n`,
);
async function tagTarget(name) {
  let object;
  try {
    object = (await api(`git/ref/tags/${name}`)).object;
  } catch (error) {
    if (/HTTP 404/.test(error.stderr ?? "")) return null;
    throw error;
  }
  for (let depth = 0; object.type === "tag" && depth < 8; depth++)
    object = (await api(`git/tags/${object.sha}`)).object;
  assert.equal(object.type, "commit", "Version tag does not resolve to a commit");
  return object.sha;
}
const priorTag = await tagTarget(tag);
if (priorTag)
  assert.equal(priorTag, candidate, "Existing immutable version tag points to another commit");
const existing = await release(tag);
if (existing && !existing.draft) {
  assert.equal(priorTag, candidate);
} else {
  if (existing)
    assert.equal(existing.target_commitish, candidate, "Draft target differs from candidate");
  else
    await gh([
      "release",
      "create",
      tag,
      "-R",
      repository,
      "--draft",
      "--latest=false",
      "--target",
      candidate,
      "--title",
      `OpenNest ${version}`,
      "--notes-file",
      notes,
    ]);
  await gh([
    "release",
    "upload",
    tag,
    "-R",
    repository,
    ...assets,
    manifestPath,
    sums,
    "--clobber",
  ]);
  assert.equal(
    (await api("git/ref/heads/main")).object.sha,
    candidate,
    "Main moved during packaging",
  );
  const tagBeforePublish = await tagTarget(tag);
  if (tagBeforePublish) assert.equal(tagBeforePublish, candidate);
  await gh([
    "release",
    "edit",
    tag,
    "-R",
    repository,
    "--draft=false",
    "--prerelease=false",
    "--latest=false",
  ]);
}
assert.equal(await tagTarget(tag), candidate, "Published version tag differs from candidate");
const verify = join(root, "verify");
await gh(["release", "download", tag, "-R", repository, "-D", verify]);
for (const path of [...assets, manifestPath, sums])
  assert.equal(
    await hash(join(verify, basename(path))),
    await hash(path),
    `Uploaded artifact changed: ${basename(path)}`,
  );
if (publicationRecovery) {
  assert.deepEqual(
    baselineManifest,
    manifest,
    "Current channel bytes differ from this exact qualified publication",
  );
  process.stdout.write(`OpenNest ${version} is already published and verified.\n`);
} else {
  const stillCurrent = await release(channel);
  assert.equal(
    stillCurrent?.id ?? null,
    current?.id ?? null,
    "OpenNest channel changed during publication",
  );
  if (current && !current.draft) {
    const recheck = join(root, "recheck");
    await gh([
      "release",
      "download",
      channel,
      "-R",
      repository,
      "-p",
      "OpenNest-latest.json",
      "-D",
      recheck,
    ]);
    assert.deepEqual(
      JSON.parse(await readFile(join(recheck, "OpenNest-latest.json"), "utf8")),
      baselineManifest,
      "Healthy baseline changed",
    );
  } else if (!current) {
    await gh([
      "release",
      "create",
      channel,
      "-R",
      repository,
      "--draft",
      "--latest=false",
      "--target",
      candidate,
      "--title",
      "OpenNest update channel",
      "--notes",
      `Current qualified release: https://github.com/${repository}/releases/tag/${tag}`,
    ]);
  }
  await gh(["release", "upload", channel, "-R", repository, ...assets, sums, "--clobber"]);
  assert.equal(
    (await api("git/ref/heads/main")).object.sha,
    candidate,
    "Main moved before updating channel",
  );
  // The update pointer is the final write. Existing Nest Apps manifests are untouched.
  await gh(["release", "upload", channel, "-R", repository, manifestPath, "--clobber"]);
  await gh([
    "release",
    "edit",
    channel,
    "-R",
    repository,
    "--draft=false",
    "--prerelease=false",
    "--latest=false",
    "--title",
    "OpenNest update channel",
    "--notes",
    `Current qualified release: https://github.com/${repository}/releases/tag/${tag}`,
  ]);
  process.stdout.write(
    `Published OpenNest ${version}: https://github.com/${repository}/releases/tag/${tag}\n`,
  );
}
