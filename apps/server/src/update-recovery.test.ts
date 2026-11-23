import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const exec = promisify(execFile);

type NativeCheck = {
  configBin?: "supported" | "unsupported" | "quoted" | "empty";
  environmentBin?: "supported" | "unsupported";
  pathVersion?: string;
};

async function checkNative({ configBin, environmentBin, pathVersion = "0.144.6" }: NativeCheck) {
  const directory = await mkdtemp(join(tmpdir(), "codexnest-native-selection-"));
  const root = join(directory, "installation");
  const release = join(root, "releases/v0.1.9");
  const config = join(directory, "config/codexnest");
  const pathBin = join(directory, "bin");
  const supported = join(directory, "configured cli/codex");
  const unsupported = join(directory, "old cli/codex");
  const env = {
    ...process.env,
    HOME: directory,
    XDG_CONFIG_HOME: join(directory, "config"),
    CODEXNEST_ROOT: root,
    CODEXNEST_CODEX_BIN:
      environmentBin === "supported" ? supported : environmentBin ? unsupported : "",
    PATH: `${pathBin}:${process.env.PATH}`,
    GIT_AUTHOR_NAME: "petrovichest",
    GIT_COMMITTER_NAME: "petrovichest",
    GIT_AUTHOR_EMAIL: "50870093+petrovichest@users.noreply.github.com",
    GIT_COMMITTER_EMAIL: "50870093+petrovichest@users.noreply.github.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  try {
    await mkdir(join(release, "deploy"), { recursive: true });
    await mkdir(config, { recursive: true });
    await mkdir(pathBin, { recursive: true });
    await mkdir(join(directory, "configured cli"), { recursive: true });
    await mkdir(join(directory, "old cli"), { recursive: true });
    for (const [path, version] of [
      [supported, "0.171.0"],
      [unsupported, "0.144.6"],
      [join(pathBin, "codex"), pathVersion],
    ]) {
      await writeFile(path, `#!/bin/sh\nprintf 'codex-cli ${version}\\n'\n`, { mode: 0o700 });
    }
    if (configBin !== undefined) {
      const value =
        configBin === "unsupported" ? unsupported : configBin === "empty" ? "" : supported;
      await writeFile(
        join(config, "server.env"),
        `CODEXNEST_CODEX_BIN=${configBin === "quoted" ? JSON.stringify(value) : value}\n`,
      );
    }
    await writeFile(
      join(release, "deploy/restart-protocol.json"),
      JSON.stringify({
        schemaVersion: 1,
        recoveryProtocolVersion: 1,
        minimumNativeVersion: "0.171.0",
      }),
    );
    const git = (...args: string[]) => exec("git", args, { cwd: release, env, timeout: 5_000 });
    await git("init", "--quiet");
    await git("add", "deploy/restart-protocol.json");
    await git(
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "--no-verify",
      "-m",
      "Native probe fixture",
    );
    await writeFile(join(release, ".codexnest-built"), (await git("rev-parse", "HEAD")).stdout);
    return await exec(
      process.execPath,
      [resolve("../../deploy/update-recovery.mjs"), "check-native"],
      {
        cwd: release,
        env,
        timeout: 5_000,
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

it.each<NativeCheck>([
  { configBin: "supported" },
  { configBin: "quoted" },
  { configBin: "unsupported", environmentBin: "supported" },
  { pathVersion: "0.171.0" },
  { configBin: "empty", pathVersion: "0.171.0" },
])("checks the selected CLI despite a shadowing runtime: %j", async (options) => {
  await expect(checkNative(options)).resolves.toMatchObject({ stdout: "", stderr: "" });
});

it.each<NativeCheck>([
  {},
  { pathVersion: "0.170.0" },
  { configBin: "unsupported", pathVersion: "0.171.0" },
  { configBin: "supported", environmentBin: "unsupported", pathVersion: "0.171.0" },
])("still refuses an unsupported selected CLI: %j", async (options) => {
  await expect(checkNative(options)).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("UNSUPPORTED_NATIVE_RUNTIME"),
  });
});

it("never installs recovery hooks when building an ordinary checkout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codexnest-build-no-install-"));
  try {
    await promisify(execFile)(
      process.execPath,
      [resolve("../../deploy/update-recovery.mjs"), "install-from-build"],
      {
        cwd: resolve("../.."),
        env: { ...process.env, CODEXNEST_ROOT: join(directory, "absent-managed-root") },
        timeout: 5_000,
      },
    );
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
