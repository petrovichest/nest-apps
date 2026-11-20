import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildApp } from "../../claude-server/src/app";
import { executablePath } from "../../claude-server/src/config";
import { SessionManager } from "../../claude-server/src/manager";
import { UiService } from "../../claude-server/src/ui-service";
import type { Config } from "./config";
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
  const models = await loadModelCatalog(process.env);
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
    openRouter: {
      keyFile: join(config.configDir, "openrouter-key.json"),
      endpoints: (model) => loadModelEndpoints(model, process.env),
      runtimeVersion: version,
      models,
    },
  });
  const ui = new UiService(manager);
  try {
    await manager.initialize();
    await ui.initialize({ probeModels: false, pollRateLimits: false });
    return await buildApp(manager, ui);
  } catch (error) {
    await ui.close();
    await manager.close();
    throw error;
  }
}
