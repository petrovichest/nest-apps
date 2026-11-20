/** Supplemental installer control tests; native lifecycle qualification is separate. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const template = await readFile(new URL("./install.sh", import.meta.url), "utf8");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "opennest-installer-control-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repository"),
    home = join(root, "home"),
    bin = join(root, "bin");
  for (const path of [repository, home, bin]) await mkdir(path);
  await writeFile(join(repository, "README.fixture"), "Private installer control fixture\n");
  await run("git", ["init", "-q", repository]);
  await run("git", ["-C", repository, "add", "README.fixture"]);
  await run("git", [
    "-C",
    repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=50870093+petrovichest@users.noreply.github.com",
    "commit",
    "-qm",
    "fixture",
  ]);
  const commit = (await run("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim();
  const version = `0.1.9-${commit.slice(0, 7)}`;
  const installer = join(root, "install.sh");
  await writeFile(
    installer,
    template.replace("__OPENNEST_VERSION__", version).replace("__OPENNEST_REF__", commit),
  );
  await writeFile(join(bin, "opencode"), "#!/bin/sh\nprintf '1.19.5\\n'\n", { mode: 0o700 });
  await writeFile(
    join(bin, "npm"),
    "#!/bin/sh\n[ \"$1\" = ci ] && exit 0\nprintf 'controlled build failure\\n' >&2\nexit 42\n",
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    OPENNEST_CONFIG_DIR: join(home, ".config/opennest"),
    OPENNEST_RUNTIME: "opencode",
    OPENNEST_OPENCODE_BIN: join(bin, "opencode"),
    OPENNEST_REPOSITORY_URL: repository,
  };
  const releases = join(env.XDG_DATA_HOME, "opennest/releases"),
    target = join(releases, `v${version}`);
  return {
    root,
    bin,
    home,
    installer,
    env,
    releases,
    target,
    run: () => run("bash", [installer], { env, cwd: root, timeout: 15_000 }),
  };
}

test("unpublished source installer refuses before writing installation state", async (t) => {
  const f = await fixture(t);
  await writeFile(f.installer, template);
  await assert.rejects(f.run(), (error) => {
    assert.match(error.stderr, /no qualified published installer/);
    return true;
  });
  await assert.rejects(readdir(f.releases), { code: "ENOENT" });
});

test("failed build leaves no installed pointer or final release and cleans its staging checkout", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run(), (error) => {
    assert.equal(error.code, 42);
    assert.match(error.stderr, /controlled build failure/);
    return true;
  });
  assert.deepEqual(await readdir(f.releases), []);
  await assert.rejects(readFile(join(dirname(f.releases), "current")), { code: "ENOENT" });
  await assert.rejects(readFile(join(f.env.OPENNEST_CONFIG_DIR, "server.env")), { code: "ENOENT" });
  await assert.rejects(f.run(), (error) => error.code === 42);
  assert.deepEqual(await readdir(f.releases), []);
});

test("an existing release directory is preserved when setup refuses to replace it", async (t) => {
  const f = await fixture(t);
  await mkdir(f.target, { recursive: true });
  await writeFile(join(f.target, "owner-file"), "preserved");
  await assert.rejects(f.run(), (error) => {
    assert.match(error.stderr, /refusing to overwrite/);
    return true;
  });
  assert.equal(await readFile(join(f.target, "owner-file"), "utf8"), "preserved");
  assert.deepEqual(await readdir(f.releases), [f.target.slice(f.target.lastIndexOf("/") + 1)]);
});

test("unqualified platform is refused before preparing install directories", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.bin, "uname"), "#!/bin/sh\nprintf 'Darwin\\n'\n", { mode: 0o700 });
  await assert.rejects(f.run(), (error) => {
    assert.match(error.stderr, /qualified only for Linux x86_64/);
    return true;
  });
  await assert.rejects(readdir(f.releases), { code: "ENOENT" });
});
