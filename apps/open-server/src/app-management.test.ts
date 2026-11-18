import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppUpdateStatus } from "@codexnest/protocol";
import { writeJsonAtomic } from "../../claude-server/src/io";
import { AppManager } from "./app-management";
import { paths, type Config } from "./config";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});
async function fixture(managed = true) {
  const root = await mkdtemp(join(tmpdir(), "opennest-app-update-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const config: Config = {
    ...paths({
      OPENNEST_CONFIG_DIR: join(root, "config"),
      OPENNEST_STATE_DIR: join(root, "state"),
      OPENNEST_RELEASE_PATH: join(root, "release"),
      OPENNEST_VERSION: "0.1.9-aaaaaaa",
      OPENNEST_MANAGED_INSTALL: managed ? "1" : "0",
    }),
    token: "fixture-token",
  };
  const calls: Array<{ command: string; args: string[] }> = [];
  let offered = false;
  const run = async (command: string, args: string[]) => {
    calls.push({ command, args });
    if (args.includes("check-update"))
      await writeJsonAtomic(join(config.stateDir, "update.json"), {
        latestVersion: offered ? "0.1.9-bbbbbbb" : null,
        updateAvailable: offered,
        operation: "idle",
        result: "none",
        message: offered ? "Qualified update" : "No qualified OpenNest release",
      });
    return { stdout: "inactive", stderr: "" };
  };
  return {
    config,
    calls,
    manager: new AppManager(config, run),
    offer: () => {
      offered = true;
    },
  };
}
describe("OpenNest app update controls", () => {
  it("reports unmanaged installation honestly and never launches a manager", async () => {
    const f = await fixture(false);
    expect((await f.manager.status()).supported).toBe(false);
    await expect(f.manager.check()).rejects.toMatchObject({ statusCode: 503 });
    await expect(f.manager.forceRestart()).rejects.toMatchObject({ statusCode: 503 });
    expect(f.calls).toHaveLength(0);
  });
  it("can check a managed install while refusing legacy channels without qualified OpenNest candidates", async () => {
    const f = await fixture();
    const result = await f.manager.check();
    expect(result.updateAvailable).toBe(false);
    expect(result.latestVersion).toBeNull();
    await expect(f.manager.update()).rejects.toMatchObject({ statusCode: 409 });
    expect(f.calls.every((call) => call.args.includes("check-update"))).toBe(true);
  });
  it("shares one release check across overlapping requests and checks afresh afterwards", async () => {
    const f = await fixture();
    const [background, manual] = await Promise.all([f.manager.check(), f.manager.check()]);
    expect(manual).toEqual(background);
    expect(f.calls).toHaveLength(1);

    f.offer();
    await expect(f.manager.check()).resolves.toMatchObject({ updateAvailable: true });
    expect(f.calls).toHaveLength(2);
  });
  it("queues only the updater service after checking a qualified candidate and persists admission", async () => {
    const f = await fixture();
    f.offer();
    const status = await f.manager.update();
    expect(status.operation).toBe("preparing");
    expect(f.calls.at(-1)?.args).toEqual([
      "--user",
      "start",
      "--no-block",
      "opennest-update.service",
    ]);
    const saved = JSON.parse(
      await readFile(join(f.config.stateDir, "update.json"), "utf8"),
    ) as AppUpdateStatus;
    expect(saved.latestVersion).toBe("0.1.9-bbbbbbb");
    expect(saved.operation).toBe("preparing");
    expect(f.calls.some((call) => call.args.some((arg) => arg === "opennest-daemon.service"))).toBe(
      false,
    );
  });
  it("queues emergency recovery once through the native-preserving recovery unit", async () => {
    const f = await fixture();
    expect(await f.manager.forceRestart()).toEqual({ accepted: true });
    expect(await f.manager.forceRestart()).toEqual({ accepted: true });
    expect(f.calls).toEqual([
      {
        command: "systemctl",
        args: ["--user", "start", "--no-block", "opennest-recovery.service"],
      },
    ]);
  });
});
