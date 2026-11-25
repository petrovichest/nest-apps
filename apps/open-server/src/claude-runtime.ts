import { parseClaudeProxy, type Project, type UiLanguage } from "@codexnest/protocol";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildApp } from "../../claude-server/src/app";
import { executablePath } from "../../claude-server/src/config";
import { readJson } from "../../claude-server/src/io";
import { SessionManager } from "../../claude-server/src/manager";
import { claudeWorkerModelChooser } from "../../claude-server/src/title";
import { AppError } from "../../claude-server/src/types";
import { UiService } from "../../claude-server/src/ui-service";
import { AppManager } from "./app-management";
import type { Config } from "./config";
import { OpenConnection, openProxyEnvironment, readOpenConnection } from "./connection";
import { loadModelCatalog, loadModelEndpoints } from "./model-catalog";

const exec = promisify(execFile);

/** Run the Claude runtime on its own OpenNest state and session units. */
export async function startClaudeRuntime(config: Config) {
  const claudeBin = await executablePath(process.env.OPENNEST_CLAUDE_BIN || "claude");
  const { stdout } = await exec(claudeBin, ["--version"], {
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  const version = stdout.trim().split(" ")[0];
  if (version !== "2.1.289") throw new Error("OpenNest requires Claude Code 2.1.289");

  const stateDir = join(config.stateDir, "claude");
  const runtimeDir = join(config.runtimeDir, "claude");
  const configDir = join(config.configDir, "claude");
  const serverEnvFile = join(config.configDir, "server.env");
  await Promise.all(
    [stateDir, runtimeDir, configDir].map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
  );
  const saved = await readOpenConnection(config.configDir);
  let connection = saved.proxy ? await openProxyEnvironment(saved.proxy) : undefined;
  const environment = () => connection?.env ?? process.env;
  let models: Awaited<ReturnType<typeof loadModelCatalog>>;
  try {
    models = await loadModelCatalog(environment());
  } catch (error) {
    await connection?.close();
    throw error;
  }
  const manager = new SessionManager({
    host: config.host,
    port: config.port,
    stateDir,
    runtimeDir,
    configDir,
    claudeBin,
    nodeBin: config.nodeBin,
    releasePath: config.releasePath,
    runnerPath: join(config.releasePath, "apps/open-server/dist/claude-runner.js"),
    serverEnvFile,
    token: config.token,
    allowedOrigins: config.allowedOrigins,
    clientDist: config.clientDist,
    version: config.version,
    managedInstall: config.managedInstall,
    openRouter: {
      keyFile: join(config.configDir, "openrouter-key.json"),
      endpoints: (model) => loadModelEndpoints(model, environment()),
      ...(saved.proxy ? { proxy: parseClaudeProxy(saved.proxy) } : {}),
      runtimeVersion: version,
      models,
    },
  });
  const ui = new UiService(
    manager,
    undefined,
    undefined,
    claudeWorkerModelChooser({
      claudeBin,
      configDir,
      openRouter: {
        keyFile: manager.config.openRouter!.keyFile,
        environment,
        defaultModel: models.find((model) => model.isDefault)?.id,
      },
    }),
  );
  const proxy = new OpenConnection(config, {
    async withIdleNative(action) {
      if (!manager.accepting)
        throw new AppError("conflict", "OpenNest is preparing a restart", 409);
      await manager.prepare([1]);
      try {
        const { threads, attention } = ui.snapshot();
        if (attention.length || threads.some((thread) => thread.currentTurnId))
          throw new AppError(
            "conflict",
            "Finish active work before changing the network proxy",
            409,
          );
        return await action();
      } finally {
        manager.resume();
      }
    },
    async restartNative() {
      const saved = await readOpenConnection(config.configDir);
      const next = saved.proxy ? await openProxyEnvironment(saved.proxy) : undefined;
      const profile = manager.config.openRouter!;
      try {
        const settingsProxy = saved.proxy ? parseClaudeProxy(saved.proxy) : undefined;
        profile.models = await loadModelCatalog(next?.env ?? process.env);
        profile.proxy = settingsProxy;
      } catch (error) {
        await next?.close();
        throw error;
      }
      const previous = connection;
      connection = next;
      await previous?.close().catch(() => undefined);
    },
  });
  try {
    await proxy.initialize();
    await manager.initialize();
    await ui.initialize({
      probeModels: false,
      pollRateLimits: false,
      seed: async () => {
        const legacy = await readJson<{
          version: number;
          projects?: Project[];
          language?: UiLanguage;
        }>(join(config.stateDir, "ui.json"));
        if (legacy && (legacy.version !== 1 || !Array.isArray(legacy.projects)))
          throw new Error("OpenNest legacy project metadata is unavailable");
        return {
          projects: legacy?.projects ?? [],
          uiLanguage: legacy?.language === "en" ? "en" : "ru",
        };
      },
    });
    const app = await buildApp(manager, ui, {}, new AppManager(config), proxy);
    app.addHook("onClose", async () => {
      await connection?.close();
    });
    return app;
  } catch (error) {
    await ui.close();
    await manager.close();
    await connection?.close();
    throw error;
  }
}
