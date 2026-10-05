import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppManager } from "./app-management";
import type { Config } from "./config";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(managedInstall = true) {
  const stateDir = await mkdtemp("/tmp/cnu-");
  directories.push(stateDir);
  const config = {
    stateDir,
    managedInstall,
    version: "0.1.9-aaaaaaa",
    nodeBin: "/private/node",
    releasePath: "/release",
  } as Config;
  const run = vi.fn(async () => ({ stdout: "inactive", stderr: "" }));
  return {
    manager: new AppManager(config, run),
    run,
    write: (value: unknown) => writeFile(join(stateDir, "update.json"), JSON.stringify(value)),
  };
}

describe("ClaudeNest application updates", () => {
  it("reads local status without a command or GitHub request and rejects unmanaged mutations", async () => {
    const test = await fixture(false);
    expect(await test.manager.status()).toMatchObject({
      supported: false,
      currentVersion: "0.1.9-aaaaaaa",
    });
    await expect(test.manager.check()).rejects.toMatchObject({ status: 503 });
    await expect(test.manager.update()).rejects.toMatchObject({ status: 503 });
    expect(test.run).not.toHaveBeenCalled();
  });

  it("keeps status tied to the active API release instead of stale disk metadata", async () => {
    const test = await fixture();
    await test.write({
      currentVersion: "old",
      latestVersion: "0.1.9-aaaaaaa",
      updateAvailable: true,
      operation: "idle",
      result: "updated",
    });
    expect(await test.manager.status()).toMatchObject({
      currentVersion: "0.1.9-aaaaaaa",
      updateAvailable: false,
      result: "updated",
    });
    expect(test.run).not.toHaveBeenCalled();
  });

  it("queues only the independent Claude updater and permits live turns", async () => {
    const test = await fixture();
    expect(await test.manager.update()).toMatchObject({
      operation: "preparing",
      canUpdateWithActiveTurns: true,
    });
    expect(test.run).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "start", "--no-block", "claudenest-update.service"],
      { timeout: 10_000 },
    );
  });

  it("retains the accepted operation timestamp if systemd never activates the worker", async () => {
    const test = await fixture();
    const queued = await test.manager.update();
    expect(await test.manager.status()).toMatchObject({
      operation: "idle",
      result: "failed",
      updatedAt: queued.updatedAt,
    });
  });

  it("rejects another operation while the updater is active", async () => {
    const test = await fixture();
    await test.write({ operation: "building" });
    test.run.mockResolvedValue({ stdout: "active", stderr: "" });
    await expect(test.manager.update()).rejects.toMatchObject({ status: 409 });
    expect(test.run).toHaveBeenCalledTimes(1);
  });

  it("reports interruption when a persisted busy operation has no active worker", async () => {
    const test = await fixture();
    await test.write({ operation: "building" });
    expect(await test.manager.status()).toMatchObject({ operation: "idle", result: "failed" });
  });
});
