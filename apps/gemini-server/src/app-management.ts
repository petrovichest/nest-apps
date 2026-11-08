import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AppUpdateStatus, ForceRestartAccepted } from "@codexnest/protocol";
import type { Config } from "./config";
import { AppError } from "./engine";

const exec = promisify(execFile);
const operations = ["idle", "checking", "preparing", "building", "switching", "restarting"];
const results = ["none", "updated", "rolled_back", "failed"];

export class AppManager {
  private forceRestartQueued = false;
  constructor(
    private readonly config: Config,
    private readonly run: (
      command: string,
      args: string[],
      options: { timeout: number; maxBuffer?: number },
    ) => Promise<{ stdout: string; stderr: string }> = exec,
  ) {}

  async status(): Promise<AppUpdateStatus> {
    const status: AppUpdateStatus = {
      supported: this.config.managedInstall === true,
      canUpdateWithActiveTurns: this.config.managedInstall === true,
      currentVersion: this.config.version ?? "0.1.0",
      latestVersion: null,
      updateAvailable: null,
      operation: "idle",
      result: "none",
      message: this.config.managedInstall
        ? null
        : "Обновления доступны только для управляемой установки GeminiNest.",
      checkedAt: null,
      updatedAt: null,
    };
    try {
      const disk = JSON.parse(
        await readFile(join(this.config.stateDir, "update.json"), "utf8"),
      ) as Partial<AppUpdateStatus>;
      if (typeof disk.latestVersion === "string") status.latestVersion = disk.latestVersion;
      if (typeof disk.updateAvailable === "boolean") status.updateAvailable = disk.updateAvailable;
      if (operations.includes(String(disk.operation))) status.operation = disk.operation!;
      if (results.includes(String(disk.result))) status.result = disk.result!;
      if (typeof disk.message === "string" && status.supported) status.message = disk.message;
      if (typeof disk.checkedAt === "string") status.checkedAt = disk.checkedAt;
      if (typeof disk.updatedAt === "string") status.updatedAt = disk.updatedAt;
    } catch {
      /* No completed update or check yet. */
    }
    if (status.latestVersion === status.currentVersion) status.updateAvailable = false;
    if (status.supported && status.operation !== "idle") {
      const { stdout } = await this.run(
        "systemctl",
        ["--user", "show", "--property=ActiveState", "--value", "gemininest-update.service"],
        { timeout: 2_000 },
      ).catch(() => ({ stdout: "inactive" }));
      if (!["active", "activating", "reloading"].includes(stdout.trim())) {
        status.operation = "idle";
        status.result = "failed";
        status.message = "Обновление GeminiNest было прервано. Активная версия остаётся доступной.";
      }
    }
    return status;
  }

  private async available(): Promise<AppUpdateStatus> {
    const status = await this.status();
    if (!status.supported)
      throw new AppError("unavailable", "Установка GeminiNest не поддерживает обновления.", 503);
    if (status.operation !== "idle")
      throw new AppError("conflict", "Обновление GeminiNest уже выполняется.", 409);
    return status;
  }

  async check(): Promise<AppUpdateStatus> {
    await this.available();
    try {
      await this.run(
        this.config.nodeBin,
        [
          join(this.config.releasePath, "apps/gemini-server/scripts/manage.mjs"),
          "check-update",
          "--json",
        ],
        { timeout: 40_000, maxBuffer: 1024 * 1024 },
      );
      return this.status();
    } catch {
      throw new AppError("unavailable", "Не удалось проверить обновления GeminiNest.", 503);
    }
  }

  async update(): Promise<AppUpdateStatus> {
    const status = await this.available();
    const queued: AppUpdateStatus = {
      ...status,
      operation: "preparing",
      result: "none",
      message: "Обновление GeminiNest запущено.",
      updatedAt: new Date().toISOString(),
    };
    try {
      const temporary = join(this.config.stateDir, `.update-${randomUUID()}.json`);
      await writeFile(temporary, JSON.stringify(queued), { mode: 0o600 });
      await rename(temporary, join(this.config.stateDir, "update.json"));
      await this.run("systemctl", ["--user", "start", "--no-block", "gemininest-update.service"], {
        timeout: 10_000,
      });
    } catch {
      throw new AppError("unavailable", "Не удалось запустить обновление GeminiNest.", 503);
    }
    return queued;
  }

  /** Stops a stuck update and restarts only the gateway; the daemon keeps running. */
  async forceRestart(): Promise<ForceRestartAccepted> {
    if (this.config.managedInstall !== true)
      throw new AppError("unavailable", "Установка GeminiNest не поддерживает перезапуск.", 503);
    if (this.forceRestartQueued) return { accepted: true };
    this.forceRestartQueued = true;
    await this.run("systemctl", ["--user", "stop", "--no-block", "gemininest-update.service"], {
      timeout: 10_000,
    }).catch(() => undefined);
    try {
      await this.run(
        "systemctl",
        ["--user", "restart", "--no-block", "gemininest-daemon.service", "gemininest.service"],
        {
          timeout: 10_000,
        },
      );
    } catch {
      this.forceRestartQueued = false;
      throw new AppError("unavailable", "Не удалось перезапустить GeminiNest.", 503);
    }
    return { accepted: true };
  }
}
