import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import type { AppUpdateStatus, ForceRestartAccepted } from "@codexnest/protocol";

const execFileAsync = promisify(execFile);

type RunCommand = (
  command: string,
  args: string[],
  options: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

export type AppManagerOptions = {
  currentVersion: string;
  managedInstall: boolean;
  statusPath: string;
  managementCli: string;
  activeTurnCount(): number;
  transport?: "stdio" | "daemon";
  systemctlBin?: string;
  setEmergencyShutdown?(requested: boolean): void;
  runCommand?: RunCommand;
  updatePending?(): boolean;
};

export class AppManagementError extends Error {
  constructor(
    public readonly kind: "unsupported" | "busy" | "active_turns" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "AppManagementError";
  }
}

export class AppManager {
  private readonly runCommand: RunCommand;
  private forceRestartQueued = false;

  constructor(private readonly options: AppManagerOptions) {
    this.runCommand = options.runCommand ?? defaultRunCommand;
  }

  async status(): Promise<AppUpdateStatus> {
    const disk = await readStatus(this.options.statusPath);
    const status = normalizeStatus(
      disk,
      this.options.currentVersion,
      this.options.managedInstall,
      this.options.transport === "daemon",
    );
    if (status.result === "updated" && this.options.updatePending?.()) {
      return {
        ...status,
        operation: "restarting",
        result: "none",
        message: "CodexNest is confirming the update",
      };
    }
    if (!status.supported || status.operation === "idle") return status;
    try {
      const { stdout } = await this.runCommand(
        this.options.systemctlBin ?? "systemctl",
        ["--user", "show", "--property=ActiveState", "--value", "codexnest-update.service"],
        { timeout: 2_000 },
      );
      if (["active", "activating", "reloading"].includes(stdout.trim())) return status;
    } catch {
      // Treat an unavailable unit the same as an inactive updater below.
    }
    return {
      ...status,
      operation: "idle",
      result: "failed",
      message: "CodexNest update was interrupted; the active release is still available",
      updatedAt: new Date().toISOString(),
    };
  }

  async check(): Promise<AppUpdateStatus> {
    this.assertSupported();
    const current = await this.status();
    if (current.operation !== "idle") {
      throw new AppManagementError("busy", "CodexNest update is already in progress");
    }
    try {
      const { stdout } = await this.runCommand(
        this.options.managementCli,
        ["check-update", "--json"],
        { timeout: 30_000 },
      );
      return normalizeStatus(
        JSON.parse(stdout) as unknown,
        this.options.currentVersion,
        this.options.managedInstall,
        this.options.transport === "daemon",
      );
    } catch (error) {
      if (error instanceof AppManagementError) throw error;
      throw new AppManagementError("failed", "Failed to check for CodexNest updates");
    }
  }

  async update(): Promise<AppUpdateStatus> {
    this.assertSupported();
    if (this.options.activeTurnCount() > 0 && this.options.transport !== "daemon") {
      throw new AppManagementError(
        "active_turns",
        "Дождитесь завершения активных ответов перед обновлением CodexNest.",
      );
    }
    const current = await this.status();
    if (current.operation !== "idle") {
      throw new AppManagementError("busy", "CodexNest update is already in progress");
    }
    try {
      await this.runCommand(
        this.options.systemctlBin ?? "systemctl",
        ["--user", "start", "--no-block", "codexnest-update.service"],
        { timeout: 10_000 },
      );
    } catch {
      throw new AppManagementError("failed", "Failed to start the CodexNest updater");
    }
    return {
      ...current,
      operation: "preparing",
      result: "none",
      message: "CodexNest update has been queued",
      updatedAt: new Date().toISOString(),
    };
  }

  async forceRestart(): Promise<ForceRestartAccepted> {
    this.assertSupported();
    if (this.forceRestartQueued) return { accepted: true };
    this.forceRestartQueued = true;
    const systemctl = this.options.systemctlBin ?? "systemctl";
    await this.runCommand(systemctl, ["--user", "stop", "--no-block", "codexnest-update.service"], {
      timeout: 10_000,
    }).catch(() => undefined);
    this.options.setEmergencyShutdown?.(true);
    try {
      await this.runCommand(systemctl, ["--user", "restart", "--no-block", "codexnest.service"], {
        timeout: 10_000,
      });
    } catch {
      this.forceRestartQueued = false;
      this.options.setEmergencyShutdown?.(false);
      throw new AppManagementError("failed", "Failed to restart CodexNest");
    }
    return { accepted: true };
  }

  private assertSupported(): void {
    if (!this.options.managedInstall) {
      throw new AppManagementError(
        "unsupported",
        "Application updates are available only for managed CodexNest installations",
      );
    }
  }
}

async function defaultRunCommand(
  command: string,
  args: string[],
  options: { timeout: number },
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, args, {
    encoding: "utf8",
    timeout: options.timeout,
    maxBuffer: 1024 * 1024,
  });
}

async function readStatus(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

function normalizeStatus(
  value: unknown,
  currentVersion: string,
  supported: boolean,
  canUpdateWithActiveTurns: boolean,
): AppUpdateStatus {
  const base: AppUpdateStatus = {
    supported,
    canUpdateWithActiveTurns: supported && canUpdateWithActiveTurns,
    currentVersion,
    latestVersion: null,
    updateAvailable: null,
    operation: "idle",
    result: "none",
    message: supported ? null : "Установка не управляется installer'ом CodexNest",
    checkedAt: null,
    updatedAt: null,
  };
  if (!isRecord(value)) return base;
  const latestVersion = stringOrNull(value.latestVersion);
  const operation = isOperation(value.operation) ? value.operation : "idle";
  const result = isResult(value.result) ? value.result : "none";
  return {
    ...base,
    latestVersion,
    updateAvailable:
      typeof value.updateAvailable === "boolean"
        ? value.updateAvailable
        : latestVersion
          ? compareVersions(latestVersion, currentVersion) > 0
          : null,
    operation,
    result,
    message: stringOrNull(value.message),
    checkedAt: stringOrNull(value.checkedAt),
    updatedAt: stringOrNull(value.updatedAt),
  };
}

function isOperation(value: unknown): value is AppUpdateStatus["operation"] {
  return ["idle", "checking", "preparing", "building", "switching", "restarting"].includes(
    String(value),
  );
}

function isResult(value: unknown): value is AppUpdateStatus["result"] {
  return ["none", "updated", "rolled_back", "failed"].includes(String(value));
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.replace(/^v/, "").split(".").map(Number);
  const rightParts = right.replace(/^v/, "").split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
