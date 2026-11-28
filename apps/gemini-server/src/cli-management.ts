import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type {
  GeminiCliUpdateOperation,
  GeminiCliUpdateResult,
  GeminiCliUpdateStatus,
} from "@codexnest/protocol";
import { readJson, writeJsonAtomic } from "../../claude-server/src/io";
import type { Config } from "./config";
import { AppError, type Engine } from "./engine";

const exec = promisify(execFile);
const DEFAULT_MANIFEST_BASE =
  "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";
const SAFE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z._-]+)?$/;
const SHA512_HEX_PATTERN = /^[0-9a-f]{128}$/i;

type SavedCliUpdateState = {
  latestVersion: string | null;
  updateAvailable: boolean | null;
  result: GeminiCliUpdateResult;
  message: string | null;
  checkedAt: string | null;
  updatedAt: string | null;
};

type AntigravityManifest = {
  version: string;
  url: string;
  sha512: string;
};

export interface GeminiCliManagerOptions {
  manifestUrl?: string;
  platform?: NodeJS.Platform;
  arch?: string;
}

export function resolveAntigravityPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  if (platform === "linux" && arch === "x64") return "linux_amd64";
  if (platform === "linux" && arch === "arm64") return "linux_arm64";
  if (platform === "darwin" && arch === "x64") return "darwin_amd64";
  if (platform === "darwin" && arch === "arm64") return "darwin_arm64";
  return null;
}

export function compareCliVersions(left: string, right: string): number {
  const parse = (raw: string) => {
    const match = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z._-]+))?\s*$/.exec(raw);
    if (!match) return null;
    return {
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3]),
      prerelease: match[4] ?? null,
    };
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return left.trim() === right.trim() ? 0 : 1;
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

async function sha512File(path: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha512");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex").toLowerCase()));
  });
}

function isLocalLoopbackHttp(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1")
  );
}

export class GeminiCliManager {
  private operation: GeminiCliUpdateOperation = "idle";
  private readonly platformName: string | null;
  private readonly customManifestUrl: string | undefined;

  constructor(
    private readonly engine: Engine,
    options: GeminiCliManagerOptions = {},
  ) {
    this.platformName = resolveAntigravityPlatform(options.platform, options.arch);
    this.customManifestUrl = options.manifestUrl ?? process.env.GEMININEST_AGY_MANIFEST_URL;
  }

  private get config(): Config {
    return this.engine.config;
  }

  private get statePath(): string {
    return join(this.config.stateDir, "cli-update.json");
  }

  private manifestEndpoint(): { url: string; allowLoopbackHttp: boolean } {
    if (this.customManifestUrl) {
      const parsed = new URL(this.customManifestUrl);
      const allowLoopbackHttp = isLocalLoopbackHttp(parsed);
      if (parsed.protocol !== "https:" && !allowLoopbackHttp) {
        throw new AppError("unavailable", "Некорректный адрес манифеста Antigravity CLI.", 503);
      }
      return { url: parsed.toString(), allowLoopbackHttp };
    }
    if (!this.platformName) {
      throw new AppError(
        "unavailable",
        "Платформа сервера не поддерживается автообновлением Antigravity CLI.",
        503,
      );
    }
    return {
      url: `${DEFAULT_MANIFEST_BASE}/${this.platformName}.json`,
      allowLoopbackHttp: false,
    };
  }

  async status(): Promise<GeminiCliUpdateStatus> {
    const supported = this.config.managedInstall === true && this.platformName !== null;
    const accountStatus = this.engine.account.status();
    const proxyConfigured = accountStatus.proxy.configured;
    const activeTurnCount = this.engine.activeCount + (this.engine.account.loggingIn ? 1 : 0);
    const cliVersion = accountStatus.cliVersion;
    const disk = await readJson<Partial<SavedCliUpdateState>>(this.statePath);

    const latestVersion = typeof disk?.latestVersion === "string" ? disk.latestVersion : null;
    const result: GeminiCliUpdateResult =
      disk?.result === "updated" || disk?.result === "failed" ? disk.result : "none";
    const checkedAt = typeof disk?.checkedAt === "string" ? disk.checkedAt : null;
    const updatedAt = typeof disk?.updatedAt === "string" ? disk.updatedAt : null;

    let updateAvailable: boolean | null =
      typeof disk?.updateAvailable === "boolean" ? disk.updateAvailable : null;
    if (latestVersion && cliVersion) {
      updateAvailable = compareCliVersions(latestVersion, cliVersion) > 0;
    }

    let message = typeof disk?.message === "string" ? disk.message : null;
    if (!supported) {
      message = "Управление Antigravity CLI доступно только для управляемой установки GeminiNest.";
    } else if (this.operation === "checking") {
      message = "Проверяем доступную версию Antigravity CLI…";
    } else if (this.operation === "updating") {
      message = "Скачиваем и проверяем новую версию Antigravity CLI…";
    } else if (!proxyConfigured && result !== "failed") {
      message = "Сначала настройте прокси в разделе Gemini.";
    } else if (
      updateAvailable === false &&
      message &&
      message.startsWith("Доступна новая версия Antigravity CLI")
    ) {
      message = "Установлена актуальная версия Antigravity CLI.";
    }

    return {
      supported,
      proxyConfigured,
      activeTurnCount,
      cliVersion,
      latestVersion,
      updateAvailable,
      operation: this.operation,
      result,
      message,
      checkedAt,
      updatedAt,
    };
  }

  private assertAvailable(): void {
    if (this.config.managedInstall !== true || !this.platformName) {
      throw new AppError(
        "unavailable",
        "Управление Antigravity CLI доступно только для управляемой установки GeminiNest.",
        503,
      );
    }
    if (this.operation !== "idle") {
      throw new AppError(
        "conflict",
        "Проверка или обновление Antigravity CLI уже выполняется.",
        409,
      );
    }
    if (!this.engine.account.status().proxy.configured) {
      throw new AppError("conflict", "Сначала настройте прокси в разделе Gemini.", 409);
    }
  }

  private async saveState(patch: Partial<SavedCliUpdateState>): Promise<void> {
    const previous = await readJson<Partial<SavedCliUpdateState>>(this.statePath);
    const next: SavedCliUpdateState = {
      latestVersion:
        patch.latestVersion !== undefined ? patch.latestVersion : (previous?.latestVersion ?? null),
      updateAvailable:
        patch.updateAvailable !== undefined
          ? patch.updateAvailable
          : (previous?.updateAvailable ?? null),
      result:
        patch.result ??
        (previous?.result === "updated" || previous?.result === "failed"
          ? previous.result
          : "none"),
      message: patch.message !== undefined ? patch.message : (previous?.message ?? null),
      checkedAt: patch.checkedAt !== undefined ? patch.checkedAt : (previous?.checkedAt ?? null),
      updatedAt: patch.updatedAt !== undefined ? patch.updatedAt : (previous?.updatedAt ?? null),
    };
    await writeJsonAtomic(this.statePath, next);
  }

  private async fetchManifest(env: NodeJS.ProcessEnv): Promise<AntigravityManifest> {
    const { url, allowLoopbackHttp } = this.manifestEndpoint();
    const requestUrl = `${url}${url.includes("?") ? "&" : "?"}cache=${Date.now()}`;
    let stdout: string;
    try {
      const res = await exec(
        "curl",
        [
          "--fail",
          "--silent",
          "--show-error",
          "--location",
          "--max-time",
          "30",
          "-H",
          "Cache-Control: no-cache",
          requestUrl,
        ],
        { env, timeout: 35_000, maxBuffer: 1024 * 1024 },
      );
      stdout = res.stdout;
    } catch {
      throw new AppError(
        "unavailable",
        "Не удалось проверить обновления Antigravity CLI через прокси.",
        503,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new AppError("unavailable", "Получен некорректный манифест Antigravity CLI.", 503);
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new AppError("unavailable", "Получен некорректный манифест Antigravity CLI.", 503);
    }
    const record = parsed as Record<string, unknown>;
    const version = typeof record.version === "string" ? record.version.trim() : "";
    const archiveUrlRaw = typeof record.url === "string" ? record.url.trim() : "";
    const sha512 = typeof record.sha512 === "string" ? record.sha512.trim() : "";

    if (!SAFE_VERSION_PATTERN.test(version) || !SHA512_HEX_PATTERN.test(sha512) || !archiveUrlRaw) {
      throw new AppError("unavailable", "Манифест Antigravity CLI не прошёл проверку.", 503);
    }

    let archiveUrl: URL;
    try {
      archiveUrl = new URL(archiveUrlRaw);
    } catch {
      throw new AppError("unavailable", "Некорректная ссылка на архив Antigravity CLI.", 503);
    }
    if (
      archiveUrl.protocol !== "https:" &&
      !(allowLoopbackHttp && isLocalLoopbackHttp(archiveUrl))
    ) {
      throw new AppError("unavailable", "Архив Antigravity CLI должен загружаться по HTTPS.", 503);
    }

    return {
      version,
      url: archiveUrl.toString(),
      sha512: sha512.toLowerCase(),
    };
  }

  private async updateServerEnvBin(agyBinPath: string): Promise<void> {
    if (/[\r\n\0]/.test(agyBinPath)) {
      throw new AppError("internal_error", "Invalid Antigravity CLI path", 500);
    }
    const envFile = this.config.envFile;
    await mkdir(dirname(envFile), { recursive: true, mode: 0o700 });
    const existing = await readFile(envFile, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const keptLines = existing
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0 && !/^GEMININEST_AGY_BIN=/.test(line));
    keptLines.push(`GEMININEST_AGY_BIN=${JSON.stringify(agyBinPath)}`);
    const tempPath = `${envFile}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${keptLines.join("\n")}\n`, { mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, envFile);
  }

  async check(): Promise<GeminiCliUpdateStatus> {
    this.assertAvailable();
    this.operation = "checking";
    let connection: Awaited<ReturnType<Engine["account"]["connection"]>> | undefined;
    try {
      connection = await this.engine.account.connection();
      const manifest = await this.fetchManifest(connection.env);
      const cliVersion = await this.engine.account.refreshCliVersion();
      const updateAvailable = cliVersion
        ? compareCliVersions(manifest.version, cliVersion) > 0
        : true;
      const now = new Date().toISOString();
      await this.saveState({
        latestVersion: manifest.version,
        updateAvailable,
        result: "none",
        message: updateAvailable
          ? `Доступна новая версия Antigravity CLI (${manifest.version}).`
          : "Установлена актуальная версия Antigravity CLI.",
        checkedAt: now,
      });
      this.engine.pollModels();
      this.operation = "idle";
      return await this.status();
    } catch (error) {
      const message =
        error instanceof AppError
          ? error.message
          : "Не удалось проверить обновления Antigravity CLI.";
      await this.saveState({
        result: "failed",
        message,
        checkedAt: new Date().toISOString(),
      }).catch(() => undefined);
      if (error instanceof AppError) throw error;
      throw new AppError("unavailable", message, 503);
    } finally {
      this.operation = "idle";
      await connection?.close();
    }
  }

  async update(): Promise<GeminiCliUpdateStatus> {
    this.assertAvailable();
    if (this.engine.account.loggingIn || this.engine.activeCount > 0) {
      throw new AppError(
        "conflict",
        "Дождитесь завершения активных задач перед обновлением Antigravity CLI.",
        409,
      );
    }
    this.operation = "updating";
    let connection: Awaited<ReturnType<Engine["account"]["connection"]>> | undefined;
    const runtimeRoot = join(this.config.dataDir, "runtime");
    const stagingDir = join(runtimeRoot, `.staging-${randomUUID()}`);
    try {
      connection = await this.engine.account.connection();
      const manifest = await this.fetchManifest(connection.env);
      const currentVersion = await this.engine.account.refreshCliVersion();
      const now = new Date().toISOString();
      if (currentVersion && compareCliVersions(manifest.version, currentVersion) <= 0) {
        await this.saveState({
          latestVersion: manifest.version,
          updateAvailable: false,
          result: "none",
          message: "Установлена актуальная версия Antigravity CLI.",
          checkedAt: now,
        });
        this.engine.pollModels();
        this.operation = "idle";
        return await this.status();
      }

      await mkdir(stagingDir, { recursive: true, mode: 0o700 });
      await chmod(runtimeRoot, 0o700);
      const archivePath = join(stagingDir, "cli.tar.gz");
      const extractDir = join(stagingDir, "extract");
      await mkdir(extractDir, { recursive: true, mode: 0o700 });

      try {
        await exec(
          "curl",
          [
            "--fail",
            "--silent",
            "--show-error",
            "--location",
            "--max-time",
            "300",
            "--output",
            archivePath,
            manifest.url,
          ],
          { env: connection.env, timeout: 310_000, maxBuffer: 1024 * 1024 },
        );
      } catch {
        throw new AppError(
          "unavailable",
          "Не удалось скачать архив Antigravity CLI через прокси.",
          503,
        );
      }

      const actualSha512 = await sha512File(archivePath);
      if (actualSha512 !== manifest.sha512) {
        throw new AppError(
          "unavailable",
          "Контрольная сумма архива Antigravity CLI не совпала. Обновление отменено.",
          503,
        );
      }

      try {
        await exec("tar", ["-xzf", archivePath, "-C", extractDir, "--no-same-owner"], {
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
        });
      } catch {
        throw new AppError("unavailable", "Не удалось распаковать архив Antigravity CLI.", 503);
      }

      let binaryName: string | null = null;
      for (const candidate of ["antigravity", "agy"]) {
        const candidatePath = join(extractDir, candidate);
        const isFile = await stat(candidatePath).then(
          (info) => info.isFile(),
          () => false,
        );
        if (isFile) {
          binaryName = candidate;
          break;
        }
      }
      if (!binaryName) {
        throw new AppError(
          "unavailable",
          "В архиве обновления не найден исполняемый файл Antigravity CLI.",
          503,
        );
      }

      const stagedBin = join(extractDir, binaryName);
      await chmod(stagedBin, 0o755);

      let verifiedVersion = "";
      try {
        const checkRun = await exec(stagedBin, ["--version"], {
          env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
          timeout: 10_000,
          maxBuffer: 64 * 1024,
        });
        verifiedVersion = checkRun.stdout.trim();
      } catch {
        throw new AppError(
          "unavailable",
          "Скачанный бинарник Antigravity CLI не запустился при проверке.",
          503,
        );
      }
      if (!verifiedVersion || verifiedVersion !== manifest.version) {
        throw new AppError(
          "unavailable",
          `Версия бинарника (${verifiedVersion || "неизвестно"}) не совпадает с манифестом (${manifest.version}).`,
          503,
        );
      }

      await this.engine.reconfigure(async () => {
        const targetDir = join(runtimeRoot, `antigravity-${manifest.version}`);
        await rm(targetDir, { recursive: true, force: true });
        await rename(extractDir, targetDir);
        await chmod(targetDir, 0o700);
        await chmod(join(targetDir, binaryName), 0o755);

        const currentLink = join(runtimeRoot, "antigravity-current");
        const tempLink = join(runtimeRoot, `.current-${randomUUID()}`);
        const nextBin = join(currentLink, binaryName);
        const previousTarget = await readlink(currentLink).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        try {
          await symlink(targetDir, tempLink);
          await rename(tempLink, currentLink);
          try {
            await this.updateServerEnvBin(nextBin);
          } catch (error) {
            if (previousTarget === null) await rm(currentLink, { force: true });
            else {
              await symlink(previousTarget, tempLink);
              await rename(tempLink, currentLink);
            }
            throw error;
          }
        } finally {
          await rm(tempLink, { force: true }).catch(() => undefined);
        }
        (this.config as { agyBin: string }).agyBin = nextBin;
        await this.engine.account.refreshCliVersion();
        this.engine.emit("account");
      });

      const finishedAt = new Date().toISOString();
      await this.saveState({
        latestVersion: manifest.version,
        updateAvailable: false,
        result: "updated",
        message: `Antigravity CLI обновлён до версии ${manifest.version}.`,
        checkedAt: finishedAt,
        updatedAt: finishedAt,
      });
      this.operation = "idle";
      return await this.status();
    } catch (error) {
      const message =
        error instanceof AppError ? error.message : "Не удалось обновить Antigravity CLI.";
      await this.saveState({
        result: "failed",
        message,
      }).catch(() => undefined);
      if (error instanceof AppError) throw error;
      throw new AppError("unavailable", message, 503);
    } finally {
      this.operation = "idle";
      await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      await connection?.close();
    }
  }
}
