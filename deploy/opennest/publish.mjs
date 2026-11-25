import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const repository = "petrovichest/nest-apps";
const candidate = process.env.GITHUB_SHA;
const version = process.env.OPENNEST_RELEASE_VERSION;
const rolling = "opennest-rolling";
const tag = `opennest-v${version}`;
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.GITHUB_EVENT_NAME, "push");
assert.equal(process.env.GITHUB_REF, "refs/heads/main");
assert.equal(process.env.GITHUB_REPOSITORY, repository);
assert.match(candidate, /^[0-9a-f]{40}$/);
assert.match(version, /^\d+\.\d+\.\d+-[0-9a-f]{7}$/);
assert.ok(version.endsWith(`-${candidate.slice(0, 7)}`));

const execute = promisify(execFile);
const gh = async (...args) => (await execute("gh", args)).stdout;
const api = async (path) => JSON.parse(await gh("api", `repos/${repository}/${path}`));
async function optional(path) {
  try {
    return await api(path);
  } catch (error) {
    if (/HTTP 404/.test(error.stderr ?? "")) return null;
    throw error;
  }
}

async function isCurrent() {
  if ((await api("git/ref/heads/main")).object.sha === candidate) return true;
  process.stdout.write(`Skipping stale OpenNest release ${candidate}.\n`);
  return false;
}

if (!(await isCurrent())) process.exit(0);
const published = await optional(`releases/tags/${tag}`);
const tagRef = await optional(`git/ref/tags/${tag}`);
if (tagRef) assert.equal(tagRef.object.sha, candidate, "OpenNest release tag was already used");
if (published?.draft) assert.equal(published.target_commitish, candidate);
if (published && !published.draft) assert.ok(tagRef, "OpenNest version tag is missing");

const files = {
  installer: "install-opennest.sh",
  android: "OpenNest-latest.apk",
  extension: "opennest-browser-latest.zip",
};
const manifestName = "OpenNest-latest.json";
const sumsName = "SHA256SUMS";
let directory = "release";
if (published && !published.draft) {
  // A rerun reuses already published assets even if the rebuilt APK differs byte for byte.
  directory = join(process.env.RUNNER_TEMP, "opennest-published");
  await mkdir(directory, { recursive: true });
  await gh("release", "download", tag, "-D", directory);
}

const assetUrl = `https://github.com/${repository}/releases/download/${tag}`;
const application = { runtime: "claude", restartProtocolVersion: 1 };
for (const [key, name] of Object.entries(files)) {
  const bytes = await readFile(join(directory, name));
  assert.ok(bytes.length, `Empty OpenNest release asset ${name}`);
  application[key] = {
    url: `${assetUrl}/${name}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
const manifest = {
  schemaVersion: 1,
  version,
  commit: candidate,
  applications: { opennest: application },
};
const manifestBytes = JSON.stringify(manifest, null, 2) + "\n";
const sums =
  Object.entries(files)
    .map(([id, name]) => `${application[id].sha256}  ${name}\n`)
    .join("") + `${createHash("sha256").update(manifestBytes).digest("hex")}  ${manifestName}\n`;
const manifestPath = join(directory, manifestName);
const sumsPath = join(directory, sumsName);
const assets = Object.values(files).map((name) => join(directory, name));

if (published && !published.draft) {
  assert.equal(await readFile(manifestPath, "utf8"), manifestBytes);
  assert.equal(await readFile(sumsPath, "utf8"), sums);
} else {
  await writeFile(manifestPath, manifestBytes);
  await writeFile(sumsPath, sums);
  if (!published)
    await gh(
      "release",
      "create",
      tag,
      "--draft",
      "--latest=false",
      "--target",
      candidate,
      "--title",
      `OpenNest ${version}`,
      "--notes",
      `Built from verified commit ${candidate}.`,
    );
  await gh("release", "upload", tag, ...assets, sumsPath, manifestPath, "--clobber");
  if (!(await isCurrent())) process.exit(0);
  await gh("release", "edit", tag, "--draft=false", "--latest=false");
}

const channel = await optional(`releases/tags/${rolling}`);
if (!channel)
  await gh(
    "release",
    "create",
    rolling,
    "--draft",
    "--latest=false",
    "--target",
    candidate,
    "--title",
    "OpenNest rolling channel",
  );
await gh("release", "upload", rolling, ...assets, sumsPath, "--clobber");
if (!(await isCurrent())) process.exit(0);
if (channel && !channel.draft)
  await gh(
    "api",
    "--method",
    "PATCH",
    `repos/${repository}/git/refs/tags/${rolling}`,
    "-f",
    `sha=${candidate}`,
    "-F",
    "force=true",
  );
// Existing manifests refer to immutable version assets while the aliases above are being updated.
await gh("release", "upload", rolling, manifestPath, "--clobber");
await gh(
  "release",
  "edit",
  rolling,
  "--draft=false",
  "--latest=false",
  "--title",
  `OpenNest ${version}`,
  "--notes",
  `[Current release](https://github.com/${repository}/releases/tag/${tag})`,
);
process.stdout.write(`Published OpenNest ${version}.\n`);
