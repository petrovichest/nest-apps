import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildApp } from "../../../claude-server/src/app";
import { ClaudeAccounts } from "../../../claude-server/src/accounts";
import type { Config } from "../../../claude-server/src/config";
import { SessionManager, type SessionLauncher } from "../../../claude-server/src/manager";
import { SessionRunner, type RunnerTransport } from "../../../claude-server/src/runner";
import { UiService } from "../../../claude-server/src/ui-service";
import type { ClaudePermissionMode, RunnerDescriptor } from "../../../claude-server/src/types";

const models = [
  {
    value: "default",
    displayName: "Sonnet",
    description: "Default Claude model",
    supportedEffortLevels: ["low", "medium", "high"],
  },
  {
    value: "haiku",
    displayName: "Haiku",
    description: "Fast Claude model",
    supportedEffortLevels: [],
  },
];

/** Reuses the production session owner and API; no real CLI, systemd, credentials or app state. */
class SmokeClaude extends EventEmitter implements RunnerTransport {
  readonly pid = 600001;
  readonly supportedModels = models;
  permissionMode: ClaudePermissionMode;
  readonly livePermissionMode = true;
  model: string;
  sends = 0;
  interruptions = 0;
  responses: Record<string, unknown>[] = [];
  private requestId = "";
  constructor(private readonly descriptor: RunnerDescriptor) {
    super();
    this.model = descriptor.model ?? "default";
    this.permissionMode = descriptor.permissionMode ?? "bypassPermissions";
  }
  async start() {}
  async setModel(model: string) {
    this.model = model;
  }
  async setPermissionMode(mode: ClaudePermissionMode) {
    this.permissionMode = mode;
  }
  sendUser(requestId: string, text: string, content?: Record<string, unknown>[]) {
    this.sends++;
    this.native({
      type: "user",
      uuid: requestId,
      message: { role: "user", content: content ?? text },
    });
    if (this.sends === 1) {
      this.native({
        type: "assistant",
        uuid: randomUUID(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Начинаю тестовую задачу. Выберите возможности." }],
        },
      });
      this.requestId = "smoke-question";
      this.emit("request", {
        request_id: this.requestId,
        request: {
          subtype: "can_use_tool",
          tool_name: "AskUserQuestion",
          input: {
            questions: [
              {
                header: "Возможности",
                question: "Что включить в проверку?",
                multiSelect: true,
                options: [
                  { label: "Голос", description: "Локальное распознавание" },
                  { label: "Файлы", description: "Вложения" },
                ],
              },
            ],
          },
        },
      });
    } else if (this.requestId) {
      this.native({
        type: "assistant",
        uuid: randomUUID(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: `Дополнение принято: ${text}` }],
        },
      });
    } else {
      this.native({
        type: "assistant",
        uuid: randomUUID(),
        message: {
          role: "assistant",
          model: this.model,
          content: [
            {
              type: "text",
              text: `Получено сообщение ${this.sends}: ${text.split("<claudenest_attachments>")[0]!.trim()}`,
            },
          ],
        },
      });
      setTimeout(
        () =>
          this.native({
            type: "result",
            subtype: "success",
            result: "Тест выполнен",
            duration_ms: 50,
          }),
        100,
      );
    }
  }
  respond(requestId: string, response: Record<string, unknown>) {
    this.responses.push(response);
    this.requestId = "";
    this.emit("requestCancelled", requestId);
    this.native({
      type: "assistant",
      uuid: randomUUID(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Ответы приняты. Продолжаю работу." }],
      },
    });
    setTimeout(
      () =>
        this.native({
          type: "result",
          subtype: "success",
          result: "Ответы приняты",
          duration_ms: 50,
        }),
      100,
    );
  }
  async interrupt() {
    this.interruptions++;
    if (this.requestId) this.emit("requestCancelled", this.requestId);
    this.native({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["Interrupted"],
    });
  }
  async stop() {}
  private native(event: Record<string, unknown>) {
    const directory = join(this.descriptor.configDir, "projects", "smoke-project");
    mkdirSync(directory, { recursive: true });
    const value = {
      ...event,
      sessionId: this.descriptor.sessionId,
      cwd: this.descriptor.cwd,
      timestamp: new Date().toISOString(),
    };
    appendFileSync(
      join(directory, `${this.descriptor.sessionId}.jsonl`),
      `${JSON.stringify(value)}\n`,
    );
    this.emit("event", value);
  }
}
class SmokeLauncher implements SessionLauncher {
  readonly owners = new Map<string, { runner: SessionRunner; transport: SmokeClaude }>();
  async available() {}
  async active(id: string) {
    return this.owners.has(id) && this.owners.get(id)!.runner.snapshot().state !== "closed";
  }
  async start(descriptor: RunnerDescriptor) {
    const transport = new SmokeClaude(descriptor);
    const runner = new SessionRunner(descriptor, {
      transportFactory: () => transport,
      claudeVersion: "fake-smoke",
    });
    this.owners.set(descriptor.sessionId, { runner, transport });
    await runner.start();
  }
}
export async function startFixture(clientDist: string) {
  const directory = await mkdtemp(join(tmpdir(), "claudenest-browser-"));
  const projectPath = join(directory, "Browser smoke project");
  await mkdir(projectPath);
  const stt = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ text: "Голосовая проверка работает" }));
  });
  await new Promise<void>((resolve) => stt.listen(0, "127.0.0.1", resolve));
  const sttPort = (stt.address() as { port: number }).port;
  const token = "isolated-browser-smoke-token-does-not-access-installed-apps";
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    stateDir: join(directory, "state"),
    runtimeDir: join(directory, "run"),
    configDir: join(directory, "native"),
    claudeBin: "/unused/fake/claude",
    nodeBin: process.execPath,
    releasePath: directory,
    runnerPath: join(directory, "unused-runner.js"),
    serverEnvFile: join(directory, "unused.env"),
    token,
    allowedOrigins: new Set(),
    clientDist: resolve(clientDist),
  };
  const launcher = new SmokeLauncher();
  const accounts = new ClaudeAccounts(config, {
    poll: false,
    readVersion: async () => "2.1.289",
    readAuth: async () => ({
      loggedIn: true,
      authMethod: "claude.ai",
      email: "smoke@example.com",
      subscriptionType: "max",
    }),
    readUsage: async () => ({
      primary: { usedPercent: 38, windowDurationMins: 300, resetsAt: Date.now() + 3_600_000 },
      secondary: { usedPercent: 62, windowDurationMins: 10_080, resetsAt: Date.now() + 86_400_000 },
    }),
  });
  await accounts.initialize();
  await accounts.refresh();
  const manager = new SessionManager(config, launcher, accounts);
  await manager.initialize();
  const ui = new UiService(manager);
  await ui.initialize({ probeModels: false });
  await ui.store.update((data) => {
    data.models = models;
    data.taskDefaults = { model: "default" };
    data.voiceSettings = {
      provider: "local",
      localUrl: `http://127.0.0.1:${sttPort}`,
      language: "ru",
      refineLocal: false,
      refinementModel: "haiku",
    };
  });
  const project = await ui.createProject(projectPath);
  const app = await buildApp(manager, ui);
  const requests: Array<{ method: string; url: string; status: number }> = [];
  app.addHook("onResponse", async (request, reply) => {
    requests.push({ method: request.method, url: request.url, status: reply.statusCode });
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const baseUrl = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  config.allowedOrigins.add(baseUrl);
  return {
    baseUrl,
    token,
    project,
    ui,
    launcher,
    requests,
    async close() {
      const appResult = await Promise.allSettled([app.close(), manager.close()]);
      for (const { runner } of launcher.owners.values()) await runner.close();
      await new Promise<void>((resolve) => stt.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
      const failure = appResult.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    },
  };
}
