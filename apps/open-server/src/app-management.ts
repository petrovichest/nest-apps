import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AppUpdateStatus, ForceRestartAccepted } from "@codexnest/protocol";
import { readJson, writeJsonAtomic } from "../../claude-server/src/io";
import type { Config } from "./config";
import { AppError } from "./engine";

type Runner = (
  command: string,
  args: string[],
  options: { timeout: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;
const execute = promisify(execFile);
const operations = new Set([
  "idle",
  "checking",
  "preparing",
  "building",
  "switching",
  "restarting",
]);
const results = new Set(["none", "updated", "rolled_back", "failed"]);

/** The updater owns API replacement; the separately managed native process survives. */
export class AppManager {
  private forceQueued = false;
  private checkInFlight: Promise<AppUpdateStatus> | null = null;
  constructor(
    private readonly config: Config,
    private readonly run: Runner = execute,
  ) {}
  async status(): Promise<AppUpdateStatus> {
    const status: AppUpdateStatus = {
      supported: this.config.managedInstall,
      canUpdateWithActiveTurns: this.config.managedInstall,
      currentVersion: this.config.version,
      latestVersion: null,
      updateAvailable: null,
      operation: "idle",
      result: "none",
      message: this.config.managedInstall
        ? null
        : "Обновления доступны только для управляемой установки OpenNest.",
      checkedAt: null,
      updatedAt: null,
    };
    if (!status.supported) return status;
    const saved = await readJson<Partial<AppUpdateStatus>>(
      join(this.config.stateDir, "update.json"),
    ).catch(() => undefined);
    if (saved) {
      if (typeof saved.latestVersion === "string") status.latestVersion = saved.latestVersion;
      if (typeof saved.updateAvailable === "boolean")
        status.updateAvailable = saved.updateAvailable;
      if (operations.has(String(saved.operation))) status.operation = saved.operation!;
      if (results.has(String(saved.result))) status.result = saved.result!;
      if (typeof saved.message === "string") status.message = saved.message;
      if (typeof saved.checkedAt === "string") status.checkedAt = saved.checkedAt;
      if (typeof saved.updatedAt === "string") status.updatedAt = saved.updatedAt;
    }
    if (status.latestVersion === status.currentVersion) status.updateAvailable = false;
    if (status.operation !== "idle") {
      const active = await this.run(
        "systemctl",
        ["--user", "show", "--property=ActiveState", "--value", "opennest-update.service"],
        { timeout: 2_000 },
      ).then(
        (result) => result.stdout.trim(),
        () => "unknown",
      );
      if (!["active", "activating", "reloading"].includes(active)) {
        status.operation = "idle";
        status.result = "failed";
        status.message =
          "Обновление OpenNest прервано. Проверьте восстановление установленной версии.";
      }
    }
    return status;
  }
  private async available() {
    const status = await this.status();
    if (!status.supported)
      throw new AppError("unavailable", "Установка OpenNest не поддерживает обновления.", 503);
    if (status.operation !== "idle")
      throw new AppError("conflict", "Обновление OpenNest уже выполняется.", 409);
    return status;
  }
  check(): Promise<AppUpdateStatus> {
    // A background check and a button press can overlap. The CLI rejects a second lock holder.
    return (this.checkInFlight ??= this.checkRelease().finally(() => {
      this.checkInFlight = null;
    }));
  }
  private async checkRelease() {
    await this.available();
    try {
      await this.run(
        this.config.nodeBin,
        [join(this.config.releasePath, "apps/open-server/scripts/manage.mjs"), "check-update"],
        { timeout: 45_000, maxBuffer: 1024 * 1024 },
      );
      return this.status();
    } catch {
      throw new AppError("unavailable", "Не удалось проверить проверенные выпуски OpenNest.", 503);
    }
  }
  async update() {
    const checked = await this.checkRelease();
    if (!checked.updateAvailable || !checked.latestVersion)
      throw new AppError("conflict", "Проверенного обновления OpenNest сейчас нет.", 409);
    const queued: AppUpdateStatus = {
      ...checked,
      operation: "preparing",
      result: "none",
      message: "Обновление OpenNest запущено.",
      updatedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(join(this.config.stateDir, "update.json"), queued);
    try {
      await this.run("systemctl", ["--user", "start", "--no-block", "opennest-update.service"], {
        timeout: 10_000,
      });
    } catch {
      await writeJsonAtomic(join(this.config.stateDir, "update.json"), {
        ...queued,
        operation: "idle",
        result: "failed",
        message: "Не удалось запустить обновление OpenNest.",
      });
      throw new AppError("unavailable", "Не удалось запустить обновление OpenNest.", 503);
    }
    return queued;
  }
  async forceRestart(): Promise<ForceRestartAccepted> {
    if (!this.config.managedInstall)
      throw new AppError("unavailable", "Установка OpenNest не поддерживает перезапуск.", 503);
    if (this.forceQueued) return { accepted: true };
    this.forceQueued = true;
    try {
      await this.run("systemctl", ["--user", "start", "--no-block", "opennest-recovery.service"], {
        timeout: 10_000,
      });
    } catch {
      this.forceQueued = false;
      throw new AppError("unavailable", "Не удалось запустить восстановление OpenNest.", 503);
    }
    return { accepted: true };
  }
}
