import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  BROWSER_EXTENSION_PROTOCOL,
  BROWSER_EXTENSION_PROTOCOL_VERSION,
  BROWSER_EXTENSION_WEBSOCKET_PATH,
  BROWSER_TOOL_NAMES,
  GEMINI_BROWSER_EXTENSION_ORIGIN,
} from "@codexnest/protocol";
import { writeJsonAtomic } from "../../claude-server/src/io";
import { Engine } from "./engine";
import { buildApp } from "./app";
import { createGateway } from "./gateway";
import { paths } from "./config";
import { GeminiVoiceService } from "./voice";
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
it("protects API and retains daemon state when its public gateway restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "gemininest-api-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const config = {
    ...paths({
      GEMININEST_CONFIG_DIR: root,
      GEMININEST_STATE_DIR: join(root, "state"),
      GEMININEST_RUNTIME_DIR: root,
      GEMININEST_AGY_BIN: "/bin/true",
    }),
    token: "t".repeat(48),
  };
  const engine = new Engine(config);
  await engine.initialize();
  cleanups.push(() => engine.close());
  const app = await buildApp(engine);
  await app.listen({ path: config.socket });
  cleanups.push(() => app.close());
  expect((await app.inject({ url: "/api/v1/health" })).statusCode).toBe(401);
  expect(
    (
      await app.inject({
        url: "/api/v1/health",
        headers: { authorization: `Bearer ${config.token}`, origin: "https://attacker.example" },
      })
    ).statusCode,
  ).toBe(403);
  const openGateway = async () => {
    const gateway = createGateway(config.socket);
    await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
    const port = (gateway.server.address() as { port: number }).port;
    return { gateway, url: `http://127.0.0.1:${port}` };
  };
  const first = await openGateway();
  const headers = { authorization: `Bearer ${config.token}`, "content-type": "application/json" };
  const project = (await fetch(`${first.url}/api/v1/projects`, {
    method: "POST",
    headers,
    body: JSON.stringify({ path: root }),
  }).then((r) => r.json())) as { id: string };
  await first.gateway.close();
  const second = await openGateway();
  cleanups.push(() => second.gateway.close());
  const projects = await fetch(`${second.url}/api/v1/projects`, { headers }).then((r) => r.json());
  expect(projects).toEqual([expect.objectContaining({ id: project.id })]);
  const created = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${project.id}/threads`,
    headers,
    payload: { clientCreationId: "one" },
  });
  const id = created.json().thread.id;
  const savedDraft = await app.inject({
    method: "PUT",
    url: `/api/v1/threads/${id}/draft?expectedUpdatedAt=none`,
    headers,
    payload: { input: "hello", images: [], annotations: [], goalMode: false },
  });
  expect(savedDraft.statusCode).toBe(200);
  const stale = await app.inject({
    method: "PUT",
    url: `/api/v1/threads/${id}/draft?expectedUpdatedAt=none`,
    headers,
    payload: { input: "stale", images: [], annotations: [], goalMode: false },
  });
  expect(stale.statusCode).toBe(409);
  const file = join(root, "report.txt");
  await writeFile(file, "result");
  const download = await app.inject({
    method: "POST",
    url: `/api/v1/threads/${id}/downloads`,
    headers,
    payload: { path: file },
  });
  expect(download.json()).toMatchObject({
    downloadUrl: expect.stringMatching(/^\/api\/v1\/downloads\//),
    fileName: "report.txt",
    expiresAt: expect.any(Number),
  });
  expect((await app.inject({ url: download.json().downloadUrl })).body).toBe("result");
});

it("keeps a real ACP subprocess and its approval alive across gateway WebSocket reconnects", async () => {
  const root = await mkdtemp(join(tmpdir(), "gemininest-owner-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const config = {
    ...paths({
      GEMININEST_CONFIG_DIR: root,
      GEMININEST_STATE_DIR: join(root, "state"),
      GEMININEST_RUNTIME_DIR: root,
      GEMININEST_AGY_BIN: resolve(import.meta.dirname, "../scripts/fixture-agent.mjs"),
    }),
    token: "t".repeat(48),
  };
  await writeJsonAtomic(join(root, "connection.json"), {
    proxy: "http://127.0.0.1:9",
    authenticated: true,
  });
  const engine = new Engine(config);
  await engine.initialize();
  cleanups.push(() => engine.close());
  const app = await buildApp(engine);
  await app.listen({ path: config.socket });
  cleanups.push(() => app.close());
  const open = async () => {
    const gateway = createGateway(config.socket);
    await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => gateway.close());
    const socket = new WebSocket(
      `ws://127.0.0.1:${(gateway.server.address() as { port: number }).port}/api/v1/ui/events`,
    );
    const snapshot = new Promise<any>((resolve) =>
      socket.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data));
        if (frame.type === "snapshot") resolve(frame.snapshot);
      }),
    );
    await new Promise<void>((resolve) =>
      socket.addEventListener("open", () => resolve(), { once: true }),
    );
    socket.send(JSON.stringify({ type: "authenticate", token: config.token }));
    return { gateway, socket, snapshot: await snapshot };
  };
  const project = await engine.addProject(root);
  const { thread } = await engine.createThread(project.id, "one");
  const first = await open();
  expect(first.snapshot.provider).toBe("gemini");
  await engine.send(thread.id, { input: "approval please", clientMessageId: "one" });
  await vi.waitFor(() => expect(engine.snapshot().attention).toHaveLength(1));
  const approval = engine.snapshot().attention[0]!;
  await first.gateway.close();
  const second = await open();
  expect(second.snapshot.attention).toEqual([approval]);
  expect(engine.detail(thread.id).summary.state).toBe("needsAttention");
  engine.respond(approval.id, { kind: "approval", decision: "accept" });
  await vi.waitFor(() => expect(engine.detail(thread.id).summary.state).toBe("completed"));
  expect(engine.detail(thread.id).turns[0]!.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "agentMessage", text: "Gemini fixture completed." }),
    ]),
  );
});

it("supports full-text search, skills, brain artifacts, voice transcriptions, kanban, browser MCP, and app updates", async () => {
  const root = await mkdtemp(join(tmpdir(), "gemininest-parity-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const config = {
    ...paths({
      GEMININEST_CONFIG_DIR: root,
      GEMININEST_STATE_DIR: join(root, "state"),
      GEMININEST_RUNTIME_DIR: root,
      GEMININEST_AGY_BIN: resolve(import.meta.dirname, "../scripts/fixture-agent.mjs"),
      GEMININEST_RELEASE_PATH: root,
      GEMININEST_MANAGED_INSTALL: "1",
    }),
    token: "t".repeat(48),
  };
  await writeJsonAtomic(join(root, "connection.json"), {
    proxy: "http://127.0.0.1:9",
    authenticated: true,
  });
  const engine = new Engine(config, undefined, {
    generateTitle: async (prompt) => `Автозаголовок: ${prompt.slice(0, 12)}`,
  });
  await engine.initialize();
  cleanups.push(() => engine.close());

  const voice = new GeminiVoiceService({
    fetch: (async () =>
      new Response(JSON.stringify({ text: "голос распознан" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    refine: async (text) => `${text} успешно`,
  });
  const app = await buildApp(engine, { voice });
  await app.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(() => app.close());
  const port = (app.addresses()[0] as { port: number }).port;
  const headers = { authorization: `Bearer ${config.token}`, "content-type": "application/json" };

  // 1. Project & thread creation + automatic title + task defaults
  const taskDefaultsRes = await app.inject({
    method: "PUT",
    url: "/api/v1/settings/task-defaults",
    headers,
    payload: {
      titleModel: "gemini-3-flash",
      classifyTasks: false,
      replyCheckModel: "gemini-3-flash",
    },
  });
  expect(taskDefaultsRes.statusCode).toBe(200);
  expect(taskDefaultsRes.json()).toMatchObject({
    titleModel: "gemini-3-flash",
    classifyTasks: false,
    replyCheckModel: "gemini-3-flash",
  });

  const project = await engine.addProject(root, "Parity Project");
  const { thread } = await engine.createThread(project.id, "parity-thread");
  await engine.send(thread.id, { input: "Проверка функций", clientMessageId: "m1" });
  await vi.waitFor(() => expect(engine.detail(thread.id).summary.state).toBe("completed"));
  await vi.waitFor(() =>
    expect(engine.detail(thread.id).summary.title).toBe("Автозаголовок: Проверка фун"),
  );

  // 2. Brain artifacts & native transcript search + reference
  const nativeId = engine.thread(thread.id).nativeId!;
  expect(nativeId).toBeTruthy();
  const brainDir = join(config.nativeDir, "gemininest", "brain", nativeId);
  const logsDir = join(brainDir, ".system_generated", "logs");
  await mkdir(logsDir, { recursive: true });
  await writeFile(
    join(logsDir, "transcript.jsonl"),
    `${JSON.stringify({ content: "Секретная фраза в транскрипте" })}\n`,
  );
  const artifactPath = join(brainDir, "implementation_plan.md");
  await writeFile(artifactPath, "# План реализации\nГотово.");
  await writeFile(
    `${artifactPath}.metadata.json`,
    JSON.stringify({ Summary: "План доработки GeminiNest", UserFacing: true }),
  );

  const refRes = await app.inject({
    method: "GET",
    url: `/api/v1/threads/${thread.id}/reference`,
    headers,
  });
  expect(refRes.statusCode).toBe(200);
  expect(refRes.json().historyPath).toBe(join(logsDir, "transcript.jsonl"));

  const msgSearchRes = await app.inject({
    method: "GET",
    url: `/api/v1/threads/search?scope=messages&q=${encodeURIComponent("Секретная фраза")}`,
    headers,
  });
  expect(msgSearchRes.statusCode).toBe(200);
  expect(msgSearchRes.json().data).toEqual([
    expect.objectContaining({
      thread: expect.objectContaining({ id: thread.id }),
      snippet: expect.stringContaining("Секретная фраза"),
    }),
  ]);

  const inThreadSearch = await app.inject({
    method: "GET",
    url: `/api/v1/threads/${thread.id}/search?q=completed`,
    headers,
  });
  expect(inThreadSearch.statusCode).toBe(200);
  expect(inThreadSearch.json().data).toHaveLength(1);

  const artifactsRes = await app.inject({
    method: "GET",
    url: `/api/v1/threads/${thread.id}/artifacts`,
    headers,
  });
  expect(artifactsRes.statusCode).toBe(200);
  expect(artifactsRes.json()).toMatchObject({
    capability: "explicit",
    artifacts: [
      expect.objectContaining({
        fileName: "implementation_plan.md",
        label: "План доработки GeminiNest",
      }),
    ],
  });

  const artifactDownload = await app.inject({
    method: "POST",
    url: `/api/v1/threads/${thread.id}/downloads`,
    headers,
    payload: { path: artifactPath },
  });
  expect(artifactDownload.statusCode).toBe(200);

  // 3. Skills discovery & config toggle
  const skillDir = join(root, ".agents", "skills", "custom-skill");
  await mkdir(skillDir, { recursive: true });
  const skillFile = join(skillDir, "SKILL.md");
  await writeFile(
    skillFile,
    "---\nname: custom-skill\ndescription: Custom test skill\n---\n# Custom Skill\n",
  );
  const skillsRes = await app.inject({
    method: "GET",
    url: `/api/v1/skills?cwd=${encodeURIComponent(root)}`,
    headers,
  });
  expect(skillsRes.statusCode).toBe(200);
  expect(skillsRes.json().skills).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "custom-skill", enabled: true })]),
  );
  const toggleSkillRes = await app.inject({
    method: "PUT",
    url: "/api/v1/skills/config",
    headers,
    payload: { cwd: root, path: skillFile, enabled: false },
  });
  expect(toggleSkillRes.statusCode).toBe(200);
  expect(toggleSkillRes.json()).toMatchObject({ enabled: false });
  const nativeSkillsConfig = JSON.parse(
    await readFile(join(config.nativeDir, "config", "skills.json"), "utf8"),
  );
  expect(nativeSkillsConfig.exclude).toContain("custom-skill");

  // 4. Voice transcription (sync & durable thread job)
  const syncVoice = await app.inject({
    method: "POST",
    url: "/api/v1/transcriptions",
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "audio/webm",
      "x-codexnest-audio-duration-ms": "2500",
    },
    payload: Buffer.from("fake-webm-audio"),
  });
  expect(syncVoice.statusCode).toBe(200);
  expect(syncVoice.json().text).toBe("голос распознан успешно");

  const asyncVoice = await app.inject({
    method: "POST",
    url: `/api/v1/threads/${thread.id}/voice-transcriptions?mode=draft&selectionStart=0&selectionEnd=0&draftUpdatedAt=none`,
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "audio/webm",
      "x-codexnest-audio-duration-ms": "2000",
    },
    payload: Buffer.from("fake-webm-audio-2"),
  });
  expect(asyncVoice.statusCode).toBe(202);
  await vi.waitFor(() =>
    expect(engine.detail(thread.id).draft?.input).toBe("голос распознан успешно"),
  );

  // 5. Kanban board routes
  const kanbanBoard = await app.inject({
    method: "GET",
    url: `/api/v1/projects/${project.id}/kanban`,
    headers,
  });
  expect(kanbanBoard.statusCode).toBe(200);
  const kanbanCard = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${project.id}/kanban/cards`,
    headers,
    payload: { description: "Новая задача на доске", clientCreationId: "card-1" },
  });
  expect(kanbanCard.statusCode).toBe(200);
  expect(kanbanCard.json().cards).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        title: "Новая задача на доске",
        description: "Новая задача на доске",
      }),
    ]),
  );

  // 6. Browser extension enable & WebSocket attach
  const enableBrowser = await app.inject({
    method: "PATCH",
    url: `/api/v1/threads/${thread.id}`,
    headers,
    payload: { browserEnabled: true },
  });
  expect(enableBrowser.statusCode).toBe(200);
  expect(enableBrowser.json().browserStatus).toBe("disconnected");

  const extSocket = new WebSocket(`ws://127.0.0.1:${port}${BROWSER_EXTENSION_WEBSOCKET_PATH}`, {
    headers: { origin: GEMINI_BROWSER_EXTENSION_ORIGIN },
  } as any);
  cleanups.push(async () => extSocket.close());
  const frames: any[] = [];
  extSocket.addEventListener("message", (event) => {
    frames.push(JSON.parse(String(event.data)));
  });
  await new Promise<void>((resolve) =>
    extSocket.addEventListener("open", () => resolve(), { once: true }),
  );
  extSocket.send(
    JSON.stringify({
      type: "client.hello",
      protocol: BROWSER_EXTENSION_PROTOCOL,
      version: BROWSER_EXTENSION_PROTOCOL_VERSION,
      token: config.token,
      instanceId: "ext-instance-1",
      extensionVersion: "0.1.9",
      browser: { name: "chrome", version: "128" },
      capabilities: {
        tools: BROWSER_TOOL_NAMES,
        maxProjectFileBytes: 100 * 1024 * 1024,
        screenshots: ["image/jpeg", "image/png"],
      },
      bindings: [],
    }),
  );
  await vi.waitFor(() =>
    expect(frames).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "server.hello" })]),
    ),
  );
  extSocket.send(
    JSON.stringify({
      type: "session.request",
      requestId: "attach-1",
      target: { kind: "existing", threadId: thread.id },
      tab: {
        id: 101,
        windowId: 1,
        groupId: -1,
        active: true,
        title: "Tab",
        url: "https://example.com",
      },
    }),
  );
  await vi.waitFor(() =>
    expect(frames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "session.result", action: "attached" }),
      ]),
    ),
  );
  extSocket.send(
    JSON.stringify({
      type: "binding.updated",
      binding: {
        threadId: thread.id,
        projectId: project.id,
        title: "Parity",
        groupId: 1,
        tabIds: [101],
        createdAt: 1,
        updatedAt: 1,
      },
    }),
  );
  await vi.waitFor(() => expect(engine.summary(thread.id).browserStatus).toBe("connected"));

  // 7. Rate limits & App update status & internal restart prepare/resume
  expect(engine.snapshot().capabilities?.rateLimits).toBe(true);
  const rateLimitsRes = await app.inject({
    method: "GET",
    url: "/api/v1/codex/rate-limits",
    headers,
  });
  expect(rateLimitsRes.statusCode).toBe(200);
  expect(rateLimitsRes.json()).toEqual({
    primary: {
      usedPercent: 20,
      windowDurationMins: 300,
      resetsAt: Date.parse("2026-11-08T14:24:41Z"),
    },
    secondary: {
      usedPercent: 18,
      windowDurationMins: 10_080,
      resetsAt: Date.parse("2026-11-14T23:24:41Z"),
    },
  });
  expect(engine.snapshot().codexRateLimits).toMatchObject({
    limits: rateLimitsRes.json(),
    refreshing: false,
    refreshError: false,
    updatedAt: expect.any(Number),
  });

  const appStatus = await app.inject({
    method: "GET",
    url: "/api/v1/settings/app",
    headers,
  });
  expect(appStatus.statusCode).toBe(200);
  expect(appStatus.json().supported).toBe(true);

  const prep = await app.inject({
    method: "POST",
    url: "/api/v1/internal/restart/prepare",
    headers,
    payload: { supportedRunnerProtocols: [1] },
  });
  expect(prep.statusCode).toBe(200);
  expect(prep.json().canRestart).toBe(true);
  expect(engine.accepting).toBe(false);

  const resume = await app.inject({
    method: "POST",
    url: "/api/v1/internal/restart/resume",
    headers,
    payload: {},
  });
  expect(resume.statusCode).toBe(200);
  expect(engine.accepting).toBe(true);
});
