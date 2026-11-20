import { createHash, randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const commitId = (value) => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
const checksum = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const openCodeVersion = "1.19.5";
const claudeVersion = "2.1.289";
const legacyChannel =
  "https://github.com/petrovichest/nest-apps/releases/download/opennest-latest/OpenNest-latest.json";
const claudeChannel = legacyChannel.replace("/opennest-latest/", "/opennest-claude-latest/");

function runtimeVersion(runtime) {
  if (runtime === undefined || runtime === "opencode") return openCodeVersion;
  if (runtime === "claude") return claudeVersion;
  throw new Error("Unsupported OpenNest runtime");
}

const requiredScopes = [
  "clean-install",
  "large-history-cold",
  "large-history-warm",
  "upgrade",
  "failed-update-rollback",
  "retry-after-failure",
  "active-work",
];

function artifact(value) {
  if (!value || !checksum(value.sha256) || typeof value.url !== "string")
    throw new Error("Invalid OpenNest qualification artifact");
  const url = new URL(value.url);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    !url.pathname.startsWith("/petrovichest/nest-apps/releases/download/")
  )
    throw new Error("Untrusted OpenNest qualification artifact address");
  return value;
}

/** Legacy shared manifests cannot implicitly qualify another native application. */
export function manifestCandidate(value) {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    !commitId(value.commit) ||
    typeof value.version !== "string" ||
    !/^\d+\.\d+\.\d+-[0-9a-f]{7}$/.test(value.version) ||
    !value.version.endsWith(`-${value.commit.slice(0, 7)}`)
  )
    throw new Error("Invalid Nest Apps release manifest");
  const application = value.applications?.opennest;
  if (!application || !application.qualification) return null;
  if (application.runtime !== undefined) runtimeVersion(application.runtime);
  return {
    version: value.version,
    commit: value.commit,
    installer: artifact(application.installer),
    qualification: artifact(application.qualification),
    ...(application.runtime === undefined ? {} : { runtime: application.runtime }),
  };
}

export function qualifyCandidate(candidate, report, baseline, nativeVersion) {
  if (!candidate) return null;
  if (
    !report ||
    report.schemaVersion !== 1 ||
    report.app !== "opennest" ||
    report.candidate !== candidate.commit ||
    report.status !== "passed" ||
    !commitId(report.baseline) ||
    report.baseline !== baseline ||
    report.baselineHealthy !== true ||
    report.installerSha256 !== candidate.installer.sha256 ||
    report.restartProtocolVersion !== 1 ||
    !Array.isArray(report.nativeVersions) ||
    !report.nativeVersions.includes(nativeVersion) ||
    report.workflow?.event !== "workflow_dispatch" ||
    report.workflow?.conclusion !== "success" ||
    report.workflow?.headSha !== candidate.commit ||
    !Number.isSafeInteger(report.workflow?.runId) ||
    report.workflow.runId < 1
  )
    throw new Error("OpenNest candidate lacks matching native lifecycle qualification");
  const scopes = report.scopes;
  if (
    candidate.runtime === "claude" &&
    (report.runtime !== "claude" ||
      !report.nativeVersions.includes(claudeVersion) ||
      !Array.isArray(scopes) ||
      !scopes.some((scope) => scope.name === "runtime-transition" && scope.result === "passed"))
  )
    throw new Error("OpenNest lacks Claude Code transition qualification");
  if (
    !Array.isArray(scopes) ||
    requiredScopes.some(
      (name) => !scopes.some((scope) => scope.name === name && scope.result === "passed"),
    ) ||
    scopes.some((scope) => scope.result !== "passed")
  )
    throw new Error("OpenNest native qualification is incomplete");
  const budget = report.budgets;
  const measured = (value, maximum) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 && value <= maximum;
  if (
    !report.workload ||
    !Number.isSafeInteger(report.workload.nonArchivedSessions) ||
    report.workload.nonArchivedSessions < 2000 ||
    !Number.isSafeInteger(report.workload.historyBytes) ||
    report.workload.historyBytes < 3 * 1024 ** 3 ||
    !measured(budget?.startupMs, 60_000) ||
    !measured(budget?.rollbackMs, 420_000) ||
    ![report.runs?.cold, report.runs?.warm].every(
      (runs) =>
        Array.isArray(runs) &&
        runs.length >= 3 &&
        runs.every((run) => run.result === "passed" && measured(run.durationMs, budget.startupMs)),
    ) ||
    report.rollback?.automatic !== true ||
    report.rollback?.previousReady !== true ||
    report.rollback?.workResumed !== true ||
    report.rollback?.nativePidPreserved !== true ||
    !measured(report.rollback?.durationMs, budget.rollbackMs)
  )
    throw new Error(
      "OpenNest qualification lacks required native workload and recovery measurements",
    );
  return { ...candidate, nativeVersion, baseline, restartProtocolVersion: 1 };
}

export function createUpdater({
  location,
  env,
  run,
  configuration,
  api,
  verifyRelease,
  apiUnitText,
}) {
  const transactionPath = join(location.root, "update-transaction.json");
  const control = (args) => run("systemctl", ["--user", ...args], { timeout: 30_000 });
  async function atomic(path, content) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, path);
  }
  async function writeStatus(operation, result, message, candidate = null) {
    const config = await configuration();
    const stateDir = config.OPENNEST_STATE_DIR;
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const status = {
      supported: true,
      canUpdateWithActiveTurns: true,
      currentVersion: config.OPENNEST_VERSION,
      latestVersion: candidate?.version ?? null,
      updateAvailable: candidate ? candidate.version !== config.OPENNEST_VERSION : false,
      operation,
      result,
      message,
      checkedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await atomic(join(stateDir, "update.json"), JSON.stringify(status) + "\n");
    return status;
  }
  async function download(url) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password)
      throw new Error("Release downloads require HTTPS without URL credentials");
    const config = await configuration();
    const { stdout } = await run(
      "curl",
      [
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--max-time",
        "30",
        "--max-filesize",
        "1048576",
        "-H",
        "Cache-Control: no-cache",
        parsed.href,
      ],
      { env: { ...env, ...config }, timeout: 35_000, maxBuffer: 2 * 1024 * 1024 },
    );
    if (Buffer.byteLength(stdout) > 1024 * 1024) throw new Error("Release metadata is too large");
    return stdout;
  }
  async function nativeIdentity() {
    const { stdout } = await control([
      "show",
      "--property=MainPID",
      "--value",
      "opennest-daemon.service",
    ]);
    const pid = Number(stdout.trim());
    if (!Number.isSafeInteger(pid) || pid < 2)
      throw new Error("The OpenNest native service is not running");
    return pid;
  }
  async function currentRelease() {
    const target = await realpath(join(location.root, "current"));
    return verifyRelease(target);
  }
  async function candidate() {
    const config = await configuration();
    const configured =
      config.OPENNEST_UPDATE_MANIFEST_URL || env.OPENNEST_UPDATE_MANIFEST_URL || legacyChannel;
    let raw;
    let fromClaudeChannel = false;
    if (configured !== legacyChannel) raw = await download(configured);
    else {
      try {
        raw = await download(claudeChannel);
        fromClaudeChannel = true;
      } catch (error) {
        if (
          config.OPENNEST_RUNTIME === "claude" ||
          error.code !== 22 ||
          !/\b404\b/.test(error.stderr ?? "")
        )
          throw error;
        raw = await download(legacyChannel);
      }
    }
    let manifest;
    try {
      manifest = JSON.parse(raw);
    } catch {
      throw new Error("Invalid release metadata");
    }
    const proposed = manifestCandidate(manifest);
    if (fromClaudeChannel && proposed?.runtime !== "claude")
      throw new Error("The Claude update channel requires a Claude Code release");
    if (!proposed) return null;
    const current = await currentRelease();
    const health = await api("health");
    if (
      health.app !== "opennest" ||
      health.provider !== "open" ||
      health.status !== "ok" ||
      health.recoveryState !== "ready" ||
      health.serverVersion !== config.OPENNEST_VERSION ||
      health.restartProtocolVersion !== 1 ||
      health.appServer?.state !== "ready"
    )
      throw new Error("The installed OpenNest baseline is not ready");
    const oldRuntime = config.OPENNEST_RUNTIME;
    const version = runtimeVersion(oldRuntime);
    const binary =
      oldRuntime === "claude"
        ? config.OPENNEST_CLAUDE_BIN || "claude"
        : config.OPENNEST_OPENCODE_BIN;
    const actual = (
      await run(binary, ["--version"], { timeout: 15_000, env: { ...env, ...config } })
    ).stdout
      .trim()
      .split(/\s+/)[0];
    if (actual !== version || health.appServer.installedVersion !== version)
      throw new Error("The native runtime is unsupported for this OpenNest updater");
    if (oldRuntime === "claude" && proposed.runtime !== "claude")
      throw new Error("A release for OpenCode cannot replace the active Claude Code runtime");
    if (proposed.runtime === "claude" && oldRuntime !== "claude") {
      const claude = config.OPENNEST_CLAUDE_BIN || "claude";
      const claimed = (
        await run(claude, ["--version"], {
          timeout: 15_000,
          env: { ...env, ...config },
        })
      ).stdout
        .trim()
        .split(/\s+/)[0];
      if (claimed !== claudeVersion)
        throw new Error("Install the qualified Claude Code version before switching runtimes");
    }
    const reportBytes = await download(proposed.qualification.url);
    if (sha(reportBytes) !== proposed.qualification.sha256)
      throw new Error("OpenNest qualification checksum does not match");
    let report;
    try {
      report = JSON.parse(reportBytes);
    } catch {
      throw new Error("Invalid OpenNest qualification metadata");
    }
    const qualified = qualifyCandidate(
      proposed,
      report,
      proposed.commit === current.commit ? report.baseline : current.commit,
      version,
    );
    const installer = await download(qualified.installer.url);
    if (sha(installer) !== qualified.installer.sha256)
      throw new Error("OpenNest installer checksum does not match");
    return { ...qualified, installerBytes: installer };
  }
  async function checkUpdate() {
    try {
      const next = await candidate();
      return writeStatus(
        "idle",
        "none",
        next
          ? next.version === (await configuration()).OPENNEST_VERSION
            ? "Установлена актуальная версия OpenNest."
            : "Доступно проверенное обновление OpenNest."
          : "В опубликованном канале нет квалифицированного выпуска OpenNest.",
        next,
      );
    } catch {
      await writeStatus("idle", "failed", "Не удалось проверить квалификацию обновления OpenNest.");
      throw new Error("OpenNest release qualification check failed");
    }
  }
  async function buildRelease(value) {
    const config = await configuration();
    const source = join(location.root, "source"),
      target = join(location.root, "releases", `v${value.version}`);
    await mkdir(join(location.root, "releases"), { recursive: true, mode: 0o700 });
    if (
      await lstat(target).then(
        () => true,
        (error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      )
    ) {
      const existing = await verifyRelease(target);
      if (
        existing.commit !== value.commit ||
        (await readFile(join(target, ".opennest-built"), "utf8")).trim() !== value.commit
      )
        throw new Error("Existing OpenNest release is incomplete or has a different identity");
      await verifyPackagedInstaller(target, value);
      return target;
    }
    const network = { env: { ...env, ...config }, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 };
    const repository =
      config.OPENNEST_REPOSITORY_URL ||
      env.OPENNEST_REPOSITORY_URL ||
      "https://github.com/petrovichest/nest-apps.git";
    if (
      !(await access(join(source, ".git")).then(
        () => true,
        () => false,
      ))
    )
      await run(
        "git",
        ["clone", "--filter=blob:none", "--no-checkout", repository, source],
        network,
      );
    await run("git", ["-C", source, "remote", "set-url", "origin", repository], network);
    await run("git", ["-C", source, "fetch", "--no-tags", "origin", value.commit], network);
    const head = (
      await run("git", ["-C", source, "rev-parse", `${value.commit}^{commit}`], network)
    ).stdout.trim();
    if (head !== value.commit)
      throw new Error("Fetched OpenNest source does not match its qualified SHA");
    await run(
      "git",
      ["-C", source, "merge-base", "--is-ancestor", value.baseline, value.commit],
      network,
    );
    await run("git", ["-C", source, "worktree", "add", "--detach", target, head], network);
    const buildEnv = {
      ...env,
      ...config,
      OPENNEST_VERSION: value.version,
      VITE_APP_VERSION: value.version,
    };
    try {
      await verifyPackagedInstaller(target, value);
      await run("npm", ["ci", "--include=dev"], {
        cwd: target,
        env: buildEnv,
        timeout: 15 * 60_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      await run("npm", ["run", "build:open"], {
        cwd: target,
        env: buildEnv,
        timeout: 10 * 60_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      const built = await verifyRelease(target);
      if (built.commit !== value.commit) throw new Error("Built source identity changed");
      await atomic(join(target, ".opennest-built"), value.commit + "\n");
      return target;
    } catch {
      await run("git", ["-C", source, "worktree", "remove", "--force", target], network).catch(
        () => undefined,
      );
      throw new Error("OpenNest candidate build failed");
    }
  }
  async function verifyPackagedInstaller(target, value) {
    const template = await readFile(join(target, "deploy/opennest/install.sh"), "utf8");
    const packaged = template
      .replace(/^opennest_default_version=.*$/m, `opennest_default_version="${value.version}"`)
      .replace(/^opennest_default_ref=.*$/m, `opennest_default_ref="${value.commit}"`);
    if (sha(packaged) !== value.installer.sha256)
      throw new Error("Qualified installer does not match the candidate source packaging");
  }
  async function setRelease(target, version, runtime) {
    const config = await configuration();
    const values = { ...config, OPENNEST_RELEASE_PATH: target, OPENNEST_VERSION: version };
    if (runtime === undefined) delete values.OPENNEST_RUNTIME;
    else values.OPENNEST_RUNTIME = runtime;
    await atomic(
      location.env,
      Object.entries(values)
        .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
        .join("\n") + "\n",
    );
    const link = join(location.root, `.current-${randomUUID()}`);
    await symlink(target, link);
    await rename(link, join(location.root, "current"));
    await atomic(
      join(location.units, "opennest.service"),
      apiUnitText(target, values.OPENNEST_NODE_BIN),
    );
    await control(["daemon-reload"]);
  }
  const nativeReady = (health, version, runtime) =>
    health?.app === "opennest" &&
    health.provider === "open" &&
    health.status === "ok" &&
    health.serverVersion === version &&
    health.restartProtocolVersion === 1 &&
    health.appServer?.state === "ready" &&
    health.appServer.installedVersion === runtimeVersion(runtime);
  const healthy = (health, version, runtime) =>
    nativeReady(health, version, runtime) && health.recoveryState === "ready";
  async function waitHealthy(version, nativePid, runtime) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if ((await nativeIdentity()) !== nativePid)
        throw new Error("The surviving native process changed during API replacement");
      try {
        const health = await api("health");
        if (healthy(health, version, runtime)) return;
      } catch {
        /* The API is still reconnecting to the same native owner. */
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("OpenNest API recovery exceeded its readiness budget");
  }
  async function recoverUpdate(restartApi = false) {
    let transaction;
    try {
      const metadata = await lstat(transactionPath);
      if (!metadata.isFile() || metadata.mode & 0o077)
        throw new Error("Unsafe OpenNest update transaction");
      transaction = JSON.parse(await readFile(transactionPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await api("internal/restart/resume", {}).catch(() => undefined);
      if (restartApi) await control(["restart", "opennest.service"]);
      return false;
    }
    if (
      transaction.schemaVersion !== 1 ||
      !commitId(transaction.previousCommit) ||
      !commitId(transaction.candidateCommit) ||
      !Number.isSafeInteger(transaction.nativePid) ||
      ![undefined, "opencode", "claude"].includes(transaction.previousRuntime)
    )
      throw new Error("Invalid OpenNest update recovery metadata");
    const previous = await verifyRelease(transaction.previousRelease);
    if (previous.commit !== transaction.previousCommit)
      throw new Error("The previous OpenNest source changed");
    const pointer = await realpath(join(location.root, "current")).catch(() => null);
    const config = await configuration();
    if (
      !restartApi &&
      pointer === previous.release &&
      config.OPENNEST_RELEASE_PATH === previous.release &&
      config.OPENNEST_VERSION === transaction.previousVersion &&
      config.OPENNEST_RUNTIME === transaction.previousRuntime &&
      (await nativeIdentity()) === transaction.nativePid
    ) {
      const health = await api("health").catch(() => null);
      if (
        nativeReady(health, transaction.previousVersion, transaction.previousRuntime) &&
        ["ready", "draining"].includes(health.recoveryState)
      ) {
        // Preparation can fail while A is still healthy (for example a temporary
        // checkpoint write error). Preserve its live state instead of restarting
        // it into the same transient failure. B has not been activated here.
        await api("internal/restart/resume", {});
        if (
          (await nativeIdentity()) !== transaction.nativePid ||
          !healthy(await api("health"), transaction.previousVersion, transaction.previousRuntime)
        )
          throw new Error("The unchanged OpenNest baseline did not remain ready");
        await writeStatus(
          "idle",
          "failed",
          "Обновление остановлено до переключения; действующий API и native-процесс OpenNest сохранены.",
        );
        await rm(transactionPath);
        return "unchanged";
      }
    }
    await setRelease(previous.release, transaction.previousVersion, transaction.previousRuntime);
    await control(["restart", "opennest.service"]);
    await waitHealthy(
      transaction.previousVersion,
      transaction.nativePid,
      transaction.previousRuntime,
    );
    await api("internal/restart/resume", {});
    await writeStatus(
      "idle",
      "rolled_back",
      "Предыдущая версия OpenNest восстановлена; native-процесс сохранён.",
    );
    await rm(transactionPath);
    return true;
  }
  async function updateWorker() {
    let next;
    try {
      if (
        await lstat(transactionPath).then(
          () => true,
          (error) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        )
      ) {
        await recoverUpdate();
        return;
      }
      await writeStatus("checking", "none", "Проверяем квалифицированный выпуск OpenNest.");
      next = await candidate();
      if (!next) {
        await writeStatus(
          "idle",
          "none",
          "В опубликованном канале нет квалифицированного выпуска OpenNest.",
        );
        return;
      }
      const config = await configuration();
      if (next.version === config.OPENNEST_VERSION) {
        await writeStatus("idle", "none", "Установлена актуальная версия OpenNest.", next);
        return;
      }
      const before = await currentRelease();
      const nativePid = await nativeIdentity();
      await writeStatus(
        "building",
        "none",
        "Собираем OpenNest из квалифицированного коммита.",
        next,
      );
      const target = await buildRelease(next);
      // Recheck the immutable candidate and healthy baseline after the long build.
      const confirmed = await candidate();
      if (
        !confirmed ||
        confirmed.commit !== next.commit ||
        confirmed.qualification.sha256 !== next.qualification.sha256 ||
        confirmed.baseline !== before.commit ||
        (await nativeIdentity()) !== nativePid
      )
        throw new Error("OpenNest release channel or healthy baseline changed during preparation");
      await atomic(
        transactionPath,
        JSON.stringify({
          schemaVersion: 1,
          previousRelease: before.release,
          previousVersion: config.OPENNEST_VERSION,
          previousRuntime: config.OPENNEST_RUNTIME,
          previousCommit: before.commit,
          candidateRelease: target,
          candidateCommit: next.commit,
          nativePid,
        }) + "\n",
      );
      const preparation = await api("internal/restart/prepare", {
        supportedRunnerProtocols: [1],
        ...(next.runtime === "claude" && config.OPENNEST_RUNTIME !== "claude"
          ? { targetRuntime: "claude" }
          : {}),
      });
      if (!preparation.ready || !preparation.supportedRunnerProtocols?.includes(1))
        throw new Error("Installed OpenNest refused the recovery protocol");
      if (
        next.runtime === "claude" &&
        config.OPENNEST_RUNTIME !== "claude" &&
        (preparation.activeTurnCount !== 0 || preparation.pendingWorkCount !== 0)
      )
        throw new Error("Finish active OpenCode sessions before switching runtimes");
      await writeStatus("switching", "none", "Переключаем только API OpenNest.", next);
      await setRelease(target, next.version, next.runtime ?? config.OPENNEST_RUNTIME);
      await control(["restart", "opennest.service"]);
      await waitHealthy(next.version, nativePid, next.runtime ?? config.OPENNEST_RUNTIME);
      await api("internal/restart/resume", {});
      await writeStatus("idle", "updated", "OpenNest обновлён; native-процесс сохранён.", next);
      await rm(transactionPath);
    } catch {
      let recovered;
      try {
        recovered = await recoverUpdate();
      } catch (error) {
        await writeStatus(
          "idle",
          "failed",
          "Автоматическое восстановление OpenNest не подтверждено. Данные и диагностика сохранены.",
          next,
        );
        throw new Error("OpenNest recovery was not confirmed", { cause: error });
      }
      if (recovered === "unchanged")
        throw new Error(
          "OpenNest update stopped before switching; the previous ready API was preserved",
        );
      if (recovered)
        throw new Error("OpenNest candidate failed; the previous ready version was restored");
      await writeStatus(
        "idle",
        "failed",
        "Обновление OpenNest остановлено до подтверждённого переключения.",
        next,
      );
      throw new Error("OpenNest update failed");
    }
  }
  return { checkUpdate, updateWorker, recoverUpdate };
}
