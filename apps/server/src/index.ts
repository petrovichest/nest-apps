import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

import { buildApp } from "./app";
import { AttentionManager } from "./attention";
import { AppManager } from "./app-management";
import { CodexBridge } from "./codex/bridge";
import { connectUnixWebSocket, type JsonlProcess } from "./codex/transport";
import { CodexManager } from "./codex-management";
import { CodexAccounts } from "./codex-accounts";
import { childProcessEnvironment, loadConfig, SERVER_VERSION } from "./config";
import { safeError } from "./logging";
import { AppProjection } from "./projection";
import { RuntimeLifecycle } from "./runtime-lifecycle";
import { StateStore } from "./state/store";
import { ThreadTitleGenerator } from "./thread-title";
import { TranscriptionService } from "./transcription";
import { TranscriptRefiner } from "./transcript-refiner";

const config = loadConfig();
const store = new StateStore(config.statePath, { databasePath: config.databasePath });
await store.load();
let authRefreshTimer: NodeJS.Timeout | undefined;
const stateWatcher = watch(dirname(config.statePath), { persistent: false }, (_event, filename) => {
  if (filename && filename !== basename(config.statePath)) return;
  if (authRefreshTimer) clearTimeout(authRefreshTimer);
  authRefreshTimer = setTimeout(() => {
    authRefreshTimer = undefined;
    void store.refreshAuthVerifier().catch(() => undefined);
  }, 50);
});

const attention = new AttentionManager();
const bridge = new CodexBridge({
  codexBin: config.codexBin,
  spawnProcess: () =>
    config.codexTransport === "daemon"
      ? connectUnixWebSocket(
          resolve(
            process.env.CODEX_HOME?.trim() || resolve(homedir(), ".codex"),
            "app-server-control/app-server-control.sock",
          ),
        )
      : (spawn(config.codexBin, ["app-server", "--listen", "stdio://"], {
          stdio: ["pipe", "pipe", "pipe"],
          env: childProcessEnvironment(),
        }) as unknown as JsonlProcess),
});
const projection = new AppProjection(bridge, store, attention, config.sessionLimit);
const codexAccounts = new CodexAccounts(bridge, {
  stateDir: dirname(config.statePath),
  codexHome: resolve(process.env.CODEX_HOME?.trim() || resolve(homedir(), ".codex")),
  codexBin: config.codexBin,
  proxyEnvFile: config.codexProxyEnvFile,
  serverEnvFile: config.serverEnvFile,
  managedInstall: config.managedInstall,
  activeTurnCount: () =>
    projection.snapshot().threads.filter((thread) => thread.currentTurnId !== null).length,
});
await codexAccounts.initialize();
projection.setCodexAccounts(codexAccounts.status());
codexAccounts.on("changed", (status) => {
  projection.setCodexAccounts(status);
  const selected = status.accounts.find(
    (account: { id: string }) => account.id === status.currentAccountId,
  );
  if (selected) projection.setCodexRateLimits(selected.rateLimits);
});
const lifecycle = new RuntimeLifecycle({
  transport: config.codexTransport,
  tokenPath: config.restartTokenPath,
  bridgeReady: () => bridge.state === "ready",
  checkpoint: () => store.checkpoint(),
});
await lifecycle.initialize();
const threadTitles = new ThreadTitleGenerator(bridge);
const transcriptRefiner = new TranscriptRefiner(bridge);
const transcription = new TranscriptionService({
  provider: config.sttProvider,
  localUrl: config.sttLocalUrl,
  openAiApiKey: config.sttOpenAiApiKey,
  openAiModel: config.sttOpenAiModel,
  language: config.sttLanguage,
  refineLocal: config.sttRefineLocal,
  refinementModel: config.sttRefinementModel,
  timeoutMs: config.sttTimeoutMs,
  proxyEnvFile: config.codexProxyEnvFile,
  settingsEnvFile: config.serverEnvFile,
  cwd: process.cwd(),
  refiner: transcriptRefiner,
});
const codexManager = new CodexManager({
  codexBin: config.codexBin,
  managementBin: config.codexManagementBin,
  proxyEnvFile: config.codexProxyEnvFile,
  transport: config.codexTransport,
  activeTurnCount: () =>
    projection.snapshot().threads.filter((thread) => thread.currentTurnId !== null).length,
  bridgeState: () => bridge.state,
  bridgeVersion: () => bridge.actualVersion,
  pendingNativeDeliveryCount: () =>
    Object.values(store.view().messageReceipts ?? {}).filter(
      (receipt) =>
        receipt.deliveryVersion === 1 &&
        receipt.turnId === null &&
        (receipt.status === undefined || receipt.status === "prepared"),
    ).length,
});
let emergencyShutdownRequested = false;
const appManager = new AppManager({
  currentVersion: SERVER_VERSION,
  managedInstall: config.managedInstall,
  statusPath: config.updateStatusPath,
  managementCli: config.managementCli,
  transport: config.codexTransport,
  activeTurnCount: () =>
    projection.snapshot().threads.filter((thread) => thread.currentTurnId !== null).length,
  setEmergencyShutdown: (requested) => {
    emergencyShutdownRequested = requested;
  },
});
projection.on("projectionError", (error: Error) => {
  process.stderr.write(`CodexNest projection update failed (${error.name})\n`);
});
bridge.on("protocolError", (error: Error) => {
  process.stderr.write(`CodexNest app-server protocol error (${error.message})\n`);
});

bridge.on("state", (state, detail: unknown) => {
  if (state === "ready") {
    lifecycle.syncing();
    void codexAccounts
      .restore()
      .catch((error: Error) => {
        process.stderr.write(`CodexNest account needs attention (${error.name})\n`);
      })
      .then(() => projection.sync())
      .then(() => lifecycle.ready())
      .catch((error: Error) => {
        lifecycle.failed();
        process.stderr.write(`CodexNest initial sync failed (${error.name})\n`);
      });
  } else if (state === "unavailable") {
    lifecycle.unavailable();
    attention.expireAll();
    if (detail !== undefined) {
      const failure = safeError(detail);
      process.stderr.write(
        `CodexNest app-server connection lost (${failure.name}: ${failure.message})\n`,
      );
    }
  }
});
const app = await buildApp(config, {
  bridge,
  store,
  projection,
  attention,
  codexManager,
  codexAccounts,
  appManager,
  lifecycle,
  threadTitles,
  transcription,
});
await app.listen({ host: config.host, port: config.port });
void bridge.start();

let shutdownPromise: Promise<void> | undefined;
function shutdown(): Promise<void> {
  shutdownPromise ??= (async () => {
    stateWatcher.close();
    if (authRefreshTimer) clearTimeout(authRefreshTimer);
    if (emergencyShutdownRequested) {
      await within(app.close(), 2_000).catch(() => undefined);
      await within(store.flushed(), 2_000).catch(() => undefined);
    } else {
      await within(lifecycle.prepareShutdown(), 60_000).catch(() => undefined);
      await within(app.close(), 10_000).catch(() => undefined);
      await store.flushed().catch(() => undefined);
    }
    bridge.stop();
    await codexAccounts.close();
    await lifecycle.close();
  })();
  return shutdownPromise;
}

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out during CodexNest shutdown")),
      timeoutMs,
    );
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
