import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

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
