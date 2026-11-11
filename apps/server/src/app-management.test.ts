import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AppManager } from "./app-management";

describe("AppManager", () => {
  it("does not announce success before the running build is admitted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-update-confirm-"));
    try {
      const statusPath = join(directory, "update.json");
      await writeFile(
        statusPath,
        JSON.stringify({
          operation: "idle",
          result: "updated",
          message: "Updated",
          updatedAt: new Date().toISOString(),
        }),
      );
      let pending = true;
      const runCommand = vi.fn();
      const manager = new AppManager({
        currentVersion: "0.1.9-1111111",
        managedInstall: true,
        transport: "daemon",
        statusPath,
        managementCli: "/missing/codexnest",
        activeTurnCount: () => 0,
        updatePending: () => pending,
        runCommand,
      });
      await expect(manager.status()).resolves.toMatchObject({
        operation: "restarting",
        result: "none",
      });
      pending = false;
      await expect(manager.status()).resolves.toMatchObject({
        operation: "idle",
        result: "updated",
      });
      expect(runCommand).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps status local until an explicit update check", async () => {
    const runCommand = vi.fn(async () => ({
      stdout: JSON.stringify({
        supported: true,
        currentVersion: "0.1.4-1111111",
        latestVersion: "0.1.4-2222222",
        updateAvailable: true,
        operation: "idle",
        result: "none",
        message: "Update check completed",
        checkedAt: "2026-07-22T10:00:00Z",
        updatedAt: "2026-07-22T10:00:00Z",
      }),
      stderr: "",
    }));
    const manager = new AppManager({
      currentVersion: "0.1.0",
      managedInstall: true,
      statusPath: "/missing/update.json",
      managementCli: "/home/user/.local/bin/codexnest",
      activeTurnCount: () => 0,
      runCommand,
    });

    await expect(manager.status()).resolves.toMatchObject({
      latestVersion: null,
      updateAvailable: null,
    });
    expect(runCommand).not.toHaveBeenCalled();
    await expect(manager.check()).resolves.toMatchObject({
      latestVersion: "0.1.4-2222222",
      updateAvailable: true,
    });
    expect(runCommand).toHaveBeenCalledWith(
      "/home/user/.local/bin/codexnest",
      ["check-update", "--json"],
      { timeout: 30_000 },
    );
  });

  it("starts the fixed updater unit without waiting for the application restart", async () => {
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const manager = new AppManager({
      currentVersion: "0.1.0",
      managedInstall: true,
      statusPath: "/missing/update.json",
      managementCli: "/home/user/.local/bin/codexnest",
      activeTurnCount: () => 0,
      runCommand,
    });

    await expect(manager.update()).resolves.toMatchObject({
      operation: "preparing",
      canUpdateWithActiveTurns: false,
    });
    expect(runCommand).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "start", "--no-block", "codexnest-update.service"],
      { timeout: 10_000 },
    );
  });

  it("does not start an update while an agent turn is active", async () => {
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const manager = new AppManager({
      currentVersion: "0.1.0",
      managedInstall: true,
      statusPath: "/missing/update.json",
      managementCli: "/home/user/.local/bin/codexnest",
      activeTurnCount: () => 1,
      runCommand,
    });

    await expect(manager.update()).rejects.toMatchObject({ kind: "active_turns" });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("allows the managed updater to coordinate active daemon turns at cutover", async () => {
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const manager = new AppManager({
      currentVersion: "0.1.0",
      managedInstall: true,
      statusPath: "/missing/update.json",
      managementCli: "/home/user/.local/bin/codexnest",
      transport: "daemon",
      activeTurnCount: () => 3,
      runCommand,
    });

    await expect(manager.update()).resolves.toMatchObject({
      operation: "preparing",
      canUpdateWithActiveTurns: true,
    });
    expect(runCommand).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "start", "--no-block", "codexnest-update.service"],
      { timeout: 10_000 },
    );
  });

  it("force restarts the app during active work and stops the updater first", async () => {
    const emergency = vi.fn();
    const runCommand = vi.fn(async (_command, args) => {
      if (args.includes("stop")) throw new Error("updater is stuck");
      return { stdout: "", stderr: "" };
    });
    const manager = new AppManager({
      currentVersion: "0.1.0",
      managedInstall: true,
      statusPath: "/missing/update.json",
      managementCli: "/home/user/.local/bin/codexnest",
      activeTurnCount: () => 4,
      setEmergencyShutdown: emergency,
      runCommand,
    });

    await expect(manager.forceRestart()).resolves.toEqual({ accepted: true });
    await expect(manager.forceRestart()).resolves.toEqual({ accepted: true });
    expect(runCommand.mock.calls).toEqual([
      [
        "systemctl",
        ["--user", "stop", "--no-block", "codexnest-update.service"],
        { timeout: 10_000 },
      ],
      ["systemctl", ["--user", "restart", "--no-block", "codexnest.service"], { timeout: 10_000 }],
    ]);
    expect(emergency).toHaveBeenCalledOnce();
    expect(emergency).toHaveBeenCalledWith(true);
  });

  it("resets emergency shutdown when systemd rejects the app restart", async () => {
    const emergency = vi.fn();
    const runCommand = vi.fn(async (_command, args) => {
      if (args.includes("restart")) throw new Error("systemd unavailable");
      return { stdout: "", stderr: "" };
    });
    const manager = new AppManager({
      currentVersion: "0.1.0",
      managedInstall: true,
      statusPath: "/missing/update.json",
      managementCli: "/home/user/.local/bin/codexnest",
      activeTurnCount: () => 0,
      setEmergencyShutdown: emergency,
      runCommand,
    });

    await expect(manager.forceRestart()).rejects.toMatchObject({ kind: "failed" });
    expect(emergency.mock.calls).toEqual([[true], [false]]);
  });

  it("recovers a stale in-progress status after a reboot", async () => {
    const statusDirectory = await mkdtemp(join(tmpdir(), "codexnest-interrupted-update-"));
    const statusPath = join(statusDirectory, "update.json");
    try {
      await writeFile(
        statusPath,
        JSON.stringify({
          latestVersion: "0.2.0",
          updateAvailable: true,
          operation: "building",
          result: "none",
        }),
      );
      const runCommand = vi.fn(async () => ({ stdout: "inactive\n", stderr: "" }));
      const manager = new AppManager({
        currentVersion: "0.1.0",
        managedInstall: true,
        statusPath,
        managementCli: "codexnest",
        activeTurnCount: () => 0,
        runCommand,
      });

      await expect(manager.status()).resolves.toMatchObject({
        operation: "idle",
        result: "failed",
        message: expect.stringContaining("interrupted"),
      });
      expect(runCommand).toHaveBeenCalledWith(
        "systemctl",
        ["--user", "show", "--property=ActiveState", "--value", "codexnest-update.service"],
        { timeout: 2_000 },
      );
    } finally {
      await rm(statusDirectory, { recursive: true, force: true });
    }
  });

  it("keeps a oneshot update in progress while systemd reports it as activating", async () => {
    const statusDirectory = await mkdtemp(join(tmpdir(), "codexnest-running-update-"));
    const statusPath = join(statusDirectory, "update.json");
    try {
      await writeFile(
        statusPath,
        JSON.stringify({
          latestVersion: "0.2.0",
          updateAvailable: true,
          operation: "restarting",
          result: "none",
          message: "Restarting CodexNest 0.2.0",
        }),
      );
      const runCommand = vi.fn(async () => ({ stdout: "activating\n", stderr: "" }));
      const manager = new AppManager({
        currentVersion: "0.1.0",
        managedInstall: true,
        statusPath,
        managementCli: "codexnest",
        activeTurnCount: () => 0,
        runCommand,
      });

      await expect(manager.status()).resolves.toMatchObject({
        operation: "restarting",
        result: "none",
        message: "Restarting CodexNest 0.2.0",
      });
    } finally {
      await rm(statusDirectory, { recursive: true, force: true });
    }
  });

  it("reads a completed rollback and blocks unmanaged installations", async () => {
    const statusDirectory = await mkdtemp(join(tmpdir(), "codexnest-app-manager-"));
    const statusPath = join(statusDirectory, "update.json");
    try {
      await writeFile(
        statusPath,
        JSON.stringify({
          latestVersion: "0.2.0",
          updateAvailable: true,
          operation: "idle",
          result: "rolled_back",
          message: "Rolled back",
        }),
      );
      const managed = new AppManager({
        currentVersion: "0.1.0",
        managedInstall: true,
        statusPath,
        managementCli: "codexnest",
        activeTurnCount: () => 0,
      });
      await expect(managed.status()).resolves.toMatchObject({
        result: "rolled_back",
        message: "Rolled back",
      });

      const unmanaged = new AppManager({
        currentVersion: "0.1.0",
        managedInstall: false,
        statusPath,
        managementCli: "codexnest",
        activeTurnCount: () => 0,
      });
      await expect(unmanaged.update()).rejects.toEqual(
        expect.objectContaining({ kind: "unsupported" }),
      );
      await expect(unmanaged.forceRestart()).rejects.toEqual(
        expect.objectContaining({ kind: "unsupported" }),
      );
    } finally {
      await rm(statusDirectory, { recursive: true, force: true });
    }
  });
});
