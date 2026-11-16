import { createServer } from "node:http";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WebSocket } from "ws";
import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_EXTENSION_PROTOCOL,
  BROWSER_EXTENSION_PROTOCOL_VERSION,
  BROWSER_EXTENSION_WEBSOCKET_PATH,
  BROWSER_TOOL_NAMES,
  OPEN_BROWSER_EXTENSION_ORIGIN,
} from "@codexnest/protocol";
import { buildApp } from "./app";
import { blankDraft } from "./engine";
import { cleanups, setup } from "./test-fixture";

const image = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
async function api() {
  const state = await setup();
  const app = await buildApp(state.engine);
  cleanups.push(() => app.close());
  return { ...state, app, headers: { authorization: `Bearer ${state.config.token}` } };
}

describe("common OpenNest features", () => {
  it("keeps uploads private and owned by one session, delivers file context and real image blocks", async () => {
    const { app, engine, native, thread, project, headers } = await api();
    const upload = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${thread.id}/attachments?name=notes.txt&mediaType=text%2Fplain`,
      headers: { ...headers, "content-type": "application/octet-stream" },
      payload: Buffer.from("private document"),
    });
    expect(upload.statusCode).toBe(200);
    const file = upload.json();
    expect((await stat(file.path)).mode & 0o077).toBe(0);
    const other = (await engine.createThread(project.id, "other")).thread;
    const wrongOwner = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${other.id}/turns`,
      headers,
      payload: { input: "read", files: [file], clientMessageId: "wrong-owner" },
    });
    expect(wrongOwner.statusCode).toBe(400);
    expect(native.prompts()).toHaveLength(0);
    await engine.send(thread.id, {
      input: "Read the document and image",
      files: [file],
      images: [image],
      clientMessageId: "attachments",
    });
    expect(native.prompts()).toHaveLength(1);
    const parts = native.prompts()[0]!.body.parts;
    expect(parts[0].text).toContain(file.path);
    expect(parts[1]).toMatchObject({ type: "file", mime: "image/gif", url: image });
    const detail = await engine.refreshThread(thread.id);
    expect(detail.turns[0]?.items[0]).toMatchObject({
      type: "userMessage",
      text: "Read the document and image",
      images: [image],
      files: [{ name: "notes.txt", path: file.path }],
    });
    const deletion = await app.inject({
      method: "DELETE",
      url: `/api/v1/threads/${thread.id}/attachments/${file.id}`,
      headers,
    });
    expect(deletion.statusCode).toBe(409);
  });
  it("rejects incompatible model images before consuming a draft or admitting native work", async () => {
    const { engine, native, thread } = await api();
    native.supportsImages = false;
    await engine.refreshModels();
    engine.thread(thread.id).draft = { ...blankDraft(), input: "keep this draft" };
    const revision = engine.thread(thread.id).draft!.updatedAt;
    await expect(
      engine.send(thread.id, {
        input: "with image",
        images: [image],
        draftUpdatedAt: revision,
        clientMessageId: "incompatible",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(engine.thread(thread.id).draft?.input).toBe("keep this draft");
    expect(engine.detail(thread.id).queuedMessages).toHaveLength(0);
    expect(native.prompts()).toHaveLength(0);
  });
  it("publishes only explicit project files and refuses outside/symlink download escapes", async () => {
    const { engine, app, headers, project, scratch, thread } = await api();
    const artifact = join(project.path, "result.md"),
      privateFile = join(scratch, "private.txt");
    await writeFile(artifact, "# Result\nDone");
    await writeFile(privateFile, "outside workspace");
    await symlink(privateFile, join(project.path, "escape.txt"));
    expect(
      (await app.inject({ url: `/api/v1/threads/${thread.id}/artifacts`, headers })).json()
        .artifacts,
    ).toHaveLength(0);
    await engine.publishArtifact(thread.id, { path: "result.md", label: "Result" });
    const listed = (
      await app.inject({ url: `/api/v1/threads/${thread.id}/artifacts`, headers })
    ).json();
    expect(listed.artifacts).toHaveLength(1);
    expect(listed.artifacts[0].label).toBe("Result");
    await expect(engine.publishArtifact(thread.id, { path: "escape.txt" })).rejects.toMatchObject({
      statusCode: 403,
    });
    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${thread.id}/downloads`,
      headers,
      payload: { path: "escape.txt" },
    });
    expect(denied.statusCode).toBe(403);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${thread.id}/downloads`,
      headers,
      payload: { path: "result.md" },
    });
    expect(created.statusCode).toBe(200);
    const download = await app.inject({ url: created.json().downloadUrl });
    expect(download.statusCode).toBe(200);
    expect(download.body).toContain("# Result");
    expect((await app.inject({ url: "/api/v1/downloads/not-a-ticket" })).statusCode).toBe(404);
  });
  it("uses native skill discovery and scoped denial, then expands the enabled skill without altering displayed user text", async () => {
    const { app, engine, native, project, thread, headers } = await api();
    const location = join(project.path, ".agents", "skills", "review", "SKILL.md");
    await mkdir(join(project.path, ".agents", "skills", "review"), { recursive: true });
    await writeFile(location, "Review carefully");
    native.skills = [
      { name: "review", description: "Review code", location, content: "Review carefully" },
    ];
    const catalog = await app.inject({
      url: `/api/v1/skills?cwd=${encodeURIComponent(project.path)}`,
      headers,
    });
    expect(catalog.json().skills[0]).toMatchObject({
      name: "review",
      path: location,
      enabled: true,
    });
    const disabled = await app.inject({
      method: "PUT",
      url: "/api/v1/skills/config",
      headers,
      payload: { cwd: project.path, path: location, enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(
      native.calls.filter((call) => call.method === "PATCH").at(-1)?.body.permission,
    ).toContainEqual({ permission: "skill", pattern: "review", action: "deny" });
    await engine.send(thread.id, { input: "/review my changes", clientMessageId: "skill-message" });
    expect(native.prompts()).toHaveLength(0);
    expect(engine.detail(thread.id).queuedMessages[0]?.deliveryError?.retryable).toBe(true);
    await app.inject({
      method: "PUT",
      url: "/api/v1/skills/config",
      headers,
      payload: { cwd: project.path, path: location, enabled: true },
    });
    await engine.sendQueued(thread.id, "skill-message");
    expect(native.prompts()[0]?.body.parts[0].text).toContain("Review carefully");
    expect((await engine.refreshThread(thread.id)).turns[0]?.items[0]).toMatchObject({
      text: "/review my changes",
    });
  });
  it("creates only one exact native fork for concurrent retries and keeps the source history untouched", async () => {
    const { app, engine, native, thread, headers } = await api();
    native.messages.set(thread.id, [
      {
        info: { id: "u1", role: "user", time: { created: 1 } },
        parts: [{ id: "request", type: "text", text: "Question" }],
      },
      {
        info: {
          id: "a1",
          role: "assistant",
          parentID: "u1",
          finish: "stop",
          time: { created: 2, completed: 3 },
        },
        parts: [{ id: "answer", type: "text", text: "Answer" }],
      },
    ]);
    const before = JSON.stringify(native.messages.get(thread.id));
    const payload = {
      operationId: "fork-one",
      lastTurnId: "u1",
      agentMessageId: "answer",
      mode: "exact",
    };
    const [first, duplicate] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/threads/${thread.id}/fork-operations`,
        headers,
        payload,
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/threads/${thread.id}/fork-operations`,
        headers,
        payload,
      }),
    ]);
    expect(first.statusCode).toBe(200);
    expect(duplicate.statusCode).toBe(200);
    await vi.waitFor(() =>
      expect(engine.data.forkOperations?.["fork-one"]?.summary.status).toBe("ready"),
    );
    expect(native.calls.filter((call) => call.path.endsWith("/fork"))).toHaveLength(1);
    expect(JSON.stringify(native.messages.get(thread.id))).toBe(before);
    const target = engine.data.forkOperations!["fork-one"]!.summary.targetThreadId!;
    expect(
      (await engine.refreshThread(target)).turns[0]?.items.some(
        (item) => item.type === "agentMessage" && item.text === "Answer",
      ),
    ).toBe(true);
    const conflict = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${thread.id}/fork-operations`,
      headers,
      payload: { ...payload, mode: "compressed" },
    });
    expect(conflict.statusCode).toBe(409);
  });
  it("transcribes into a durable draft once and keeps shared board routes functional", async () => {
    const { app, engine, project, thread, headers } = await api();
    let transcriptions = 0;
    const stt = createServer(async (request, response) => {
      for await (const chunk of request) {
        void chunk; /* consume recorded audio */
      }
      transcriptions++;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ text: "Распознанный голос" }));
    });
    await new Promise<void>((resolve) => stt.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => stt.close(() => resolve())));
    const speechUrl = `http://127.0.0.1:${(stt.address() as { port: number }).port}/inference`;
    const configured = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/transcription",
      headers,
      payload: {
        provider: "local",
        localUrl: speechUrl,
        language: "ru",
        refineLocal: false,
        refinementModel: "default",
        openAiModel: "gpt-4o-transcribe",
      },
    });
    expect(configured.statusCode).toBe(200);
    engine.thread(thread.id).draft = blankDraft();
    await engine.save();
    const revision = engine.thread(thread.id).draft!.updatedAt;
    const recording = {
      method: "POST" as const,
      url: `/api/v1/threads/${thread.id}/voice-transcriptions?mode=draft&selectionStart=0&selectionEnd=0&draftUpdatedAt=${revision}&clientUploadId=voice-once`,
      headers: {
        ...headers,
        "content-type": "audio/webm",
        "x-codexnest-audio-duration-ms": "1000",
      },
      payload: Buffer.from("recorded-audio-fixture"),
    };
    expect((await app.inject(recording)).statusCode).toBe(202);
    await vi.waitFor(() =>
      expect(engine.thread(thread.id).draft?.input).toBe("Распознанный голос"),
    );
    expect((await app.inject(recording)).statusCode).toBe(202);
    expect(transcriptions).toBe(1);
    engine.data.taskDefaults.classifyTasks = false;
    await engine.save();
    const board = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/kanban/cards`,
      headers,
      payload: { description: "Задача на доске", clientCreationId: "card-once" },
    });
    expect(board.statusCode).toBe(200);
    expect(board.json().cards[0]).toMatchObject({
      title: "Задача на доске",
      description: "Задача на доске",
    });
  });
  it("binds the actual extension protocol and delivers tools only through that session's binding", async () => {
    const { app, engine, thread, project, config, headers } = await api();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as { port: number };
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/v1/threads/${thread.id}`,
          headers,
          payload: { browserEnabled: true },
        })
      ).statusCode,
    ).toBe(200);
    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}${BROWSER_EXTENSION_WEBSOCKET_PATH}`,
      { headers: { origin: OPEN_BROWSER_EXTENSION_ORIGIN } },
    );
    cleanups.push(async () => {
      socket.terminate();
    });
    const frames: any[] = [];
    socket.on("message", (message) => frames.push(JSON.parse(message.toString())));
    await new Promise<void>((resolve) => socket.once("open", resolve));
    socket.send(
      JSON.stringify({
        type: "client.hello",
        protocol: BROWSER_EXTENSION_PROTOCOL,
        version: BROWSER_EXTENSION_PROTOCOL_VERSION,
        token: config.token,
        instanceId: "open-browser-fixture",
        extensionVersion: "0.1.9",
        browser: { name: "chrome", version: "128" },
        capabilities: {
          tools: BROWSER_TOOL_NAMES,
          maxProjectFileBytes: 100 * 1024 * 1024,
          screenshots: ["image/png", "image/jpeg"],
        },
        bindings: [],
      }),
    );
    await vi.waitFor(() =>
      expect(frames.some((frame) => frame.type === "server.hello")).toBe(true),
    );
    socket.send(
      JSON.stringify({
        type: "session.request",
        requestId: "attach",
        target: { kind: "existing", threadId: thread.id },
        tab: {
          id: 101,
          windowId: 1,
          groupId: -1,
          active: true,
          title: "Fixture",
          url: "https://example.test",
        },
      }),
    );
    await vi.waitFor(() =>
      expect(
        frames.some((frame) => frame.type === "session.result" && frame.action === "attached"),
      ).toBe(true),
    );
    socket.send(
      JSON.stringify({
        type: "binding.updated",
        binding: {
          threadId: thread.id,
          projectId: project.id,
          title: "Fixture",
          groupId: 1,
          tabIds: [101],
          createdAt: 1,
          updatedAt: 1,
        },
      }),
    );
    await vi.waitFor(() => expect(engine.summary(thread.id).browserStatus).toBe("connected"));
    const result = engine.invokeBrowserTool(thread.id, "get_page_text", { tabId: 101 });
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === "tool.call")).toBe(true));
    const call = frames.find((frame) => frame.type === "tool.call");
    socket.send(
      JSON.stringify({
        type: "tool.result",
        requestId: call.requestId,
        result: { content: [{ type: "text", text: "The bound page" }] },
      }),
    );
    expect(await result).toEqual({ content: [{ type: "text", text: "The bound page" }] });
    expect(() => engine.invokeBrowserTool("missing", "get_page_text", {})).toThrow(
      "Thread not found",
    );
    expect(await readFile(join(config.stateDir, "ui.json"), "utf8")).not.toContain(config.token);
  });
});
