import { createHmac, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_EXTENSION_ORIGIN,
  BROWSER_EXTENSION_PROTOCOL,
  BROWSER_EXTENSION_PROTOCOL_VERSION,
  BROWSER_EXTENSION_WEBSOCKET_PATH,
  BROWSER_TOOL_NAMES,
  CLAUDE_BROWSER_EXTENSION_ORIGIN,
  type BrowserExtensionBindingSummary,
  type BrowserExtensionServerFrame,
  type Project,
} from "@codexnest/protocol";
import { buildApp } from "./app";
import type { Config } from "./config";
import type { SessionManager } from "./manager";
import { BROWSER_MCP_SERVER_NAME } from "./types";
import { UiService } from "./ui-service";

const TOKEN = "private-test-token-with-at-least-32-characters";
// Session owners outlive the server, so the secret derives from the owner token alone.
const SECRET = createHmac("sha256", TOKEN).update("claudenest-browser-mcp").digest("base64url");
type SessionLaunch = Parameters<SessionManager["setBrowserLaunch"]>[0];
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

describe("ClaudeNest browser extension transport", () => {
  it("enforces origin, owner authentication, and the protocol version", async () => {
    const harness = await createHarness();

    // Foreign origins never complete the upgrade; the CodexNest extension ID is one of them.
    for (const origin of ["http://rejected", BROWSER_EXTENSION_ORIGIN]) {
      await expect(
        harness.app.injectWS(BROWSER_EXTENSION_WEBSOCKET_PATH, { headers: { origin } }),
      ).rejects.toThrow("403");
    }

    const rejectedToken = await harness.app.injectWS(BROWSER_EXTENSION_WEBSOCKET_PATH, {
      headers: { origin: CLAUDE_BROWSER_EXTENSION_ORIGIN },
    });
    rejectedToken.send(JSON.stringify({ ...helloFrame("instance-1"), token: "wrong" }));
    expect(await closeCode(rejectedToken)).toBe(1008);

    const rejectedVersion = await harness.app.injectWS(BROWSER_EXTENSION_WEBSOCKET_PATH, {
      headers: { origin: CLAUDE_BROWSER_EXTENSION_ORIGIN },
    });
    rejectedVersion.send(
      JSON.stringify({
        ...helloFrame("instance-1"),
        version: BROWSER_EXTENSION_PROTOCOL_VERSION + 1,
      }),
    );
    expect(await closeCode(rejectedVersion)).toBe(1002);

    const accepted = await connect(harness, "instance-1");
    expect(await accepted.nextType("server.hello")).toMatchObject({
      locale: "ru",
      projects: [],
      threads: [],
    });
    accepted.socket.close();
  });

  it("offers only enabled root sessions and pushes catalog changes", async () => {
    const harness = await createHarness();
    const { project, thread } = await harness.thread();
    const other = await harness.thread(project);
    const extension = await connect(harness, "instance-1");
    expect((await extension.nextType("server.hello")).threads).toEqual([]);

    await harness.patch(thread, { browserEnabled: true });
    const catalog = await extension.nextType("catalog.updated");
    expect(catalog.projects).toEqual([
      expect.objectContaining({ id: project.id, path: project.path }),
    ]);
    expect(catalog.threads).toEqual([
      { id: thread, projectId: project.id, title: expect.any(String), state: "idle" },
    ]);
    expect(harness.ui.summary(thread).browserStatus).toBe("disconnected");
    expect(harness.ui.summary(other.thread).browserStatus).toBe("disabled");

    await harness.patch(thread, { browserEnabled: false });
    for (;;) {
      if ((await extension.nextType("catalog.updated")).threads.length === 0) break;
    }
    extension.socket.close();
  });

  it("attaches, detaches, transfers, and preserves binding ownership", async () => {
    const harness = await createHarness();
    const { thread } = await harness.thread();
    const first = await connect(harness, "instance-1");
    await first.nextType("server.hello");

    first.socket.send(JSON.stringify(sessionRequest("create", { kind: "new", projectId: "p" })));
    expect(await first.nextType("session.error")).toMatchObject({
      error: { code: "unsupported" },
    });
    first.socket.send(
      JSON.stringify(sessionRequest("early", { kind: "existing", threadId: thread })),
    );
    expect(await first.nextType("session.error")).toMatchObject({
      error: { code: "not_enabled" },
    });

    await harness.patch(thread, { browserEnabled: true });
    first.socket.send(
      JSON.stringify(sessionRequest("attach", { kind: "existing", threadId: thread })),
    );
    expect(await first.nextType("session.result")).toMatchObject({
      action: "attached",
      thread: { id: thread },
    });
    const binding = bindingSummary(thread);
    first.socket.send(JSON.stringify({ type: "binding.updated", binding }));
    await vi.waitFor(() => expect(harness.ui.summary(thread).browserStatus).toBe("connected"));
    const bindingId = harness.stored(thread).browserBinding!.bindingId;

    const second = await connect(harness, "instance-2");
    expect((await second.nextType("server.hello")).threads).toEqual([]);
    second.socket.send(
      JSON.stringify(sessionRequest("steal", { kind: "existing", threadId: thread })),
    );
    expect(await second.nextType("session.error")).toMatchObject({
      error: { code: "owned_by_another_instance" },
    });

    first.socket.send(JSON.stringify({ type: "binding.detached", binding }));
    await vi.waitFor(() =>
      expect(harness.stored(thread).browserBinding?.detachedAt).toEqual(expect.any(Number)),
    );
    expect(harness.stored(thread).browserEnabled).toBe(true);
    expect(harness.ui.summary(thread).browserStatus).toBe("disconnected");

    second.socket.send(
      JSON.stringify(sessionRequest("take", { kind: "existing", threadId: thread })),
    );
    expect(await second.nextType("session.result")).toMatchObject({ action: "attached" });
    expect(harness.stored(thread).browserBinding).toMatchObject({ instanceId: "instance-2" });
    expect(harness.stored(thread).browserBinding!.bindingId).not.toBe(bindingId);
    expect(await first.nextType("binding.detach")).toMatchObject({ threadId: thread });
    expect(
      (await harness.mcp(bindingId, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json(),
    ).toMatchObject({ error: { message: "Browser binding not found" } });

    expect((await harness.patch(thread, { browserEnabled: false })).statusCode).toBe(200);
    expect(harness.stored(thread).browserBinding).toBeUndefined();
    expect(harness.ui.summary(thread).browserStatus).toBe("disabled");
    first.socket.close();
    second.socket.close();
  });

  it("changes browser access only while the session is idle", async () => {
    const harness = await createHarness();
    const { thread } = await harness.thread();
    await harness.ui.store.update((data) => {
      data.threads[thread]!.queue.push({
        id: randomUUID(),
        text: "work",
        status: "queued",
      } as never);
    });
    const busy = await harness.patch(thread, { browserEnabled: true });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toMatchObject({ error: { code: "conflict" } });
    expect(harness.stored(thread).browserEnabled).toBeUndefined();

    const invalid = await harness.patch(thread, { browserEnabled: "yes" });
    expect(invalid.statusCode).toBe(400);
    const archivedThread = (await harness.thread()).thread;
    await harness.ui.store.update((data) => {
      data.threads[archivedThread]!.archived = true;
    });
    expect((await harness.patch(archivedThread, { browserEnabled: true })).statusCode).toBe(409);
  });

  it("hands session owners a private MCP endpoint for the current binding only", async () => {
    const harness = await createHarness();
    const { thread } = await harness.thread();
    expect(harness.launchConfig(thread)).toBeUndefined();
    await harness.attach(thread, "instance-1");

    const launch = harness.launchConfig(thread)!;
    expect(launch.bindingId).toBe(harness.stored(thread).browserBinding!.bindingId);
    const server = (
      launch.mcpConfig.mcpServers as Record<
        string,
        { type: string; url: string; headers: Record<string, string> }
      >
    )[BROWSER_MCP_SERVER_NAME]!;
    expect(server).toMatchObject({
      type: "http",
      url: `http://127.0.0.1:${harness.config.port}/api/v1/internal/browser-mcp/${launch.bindingId}`,
    });

    expect(server.headers).toEqual({ "x-claudenest-browser-secret": SECRET });
    const denied = await harness.app.inject({
      method: "POST",
      url: new URL(server.url).pathname,
      headers: { "x-claudenest-browser-secret": "wrong" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(denied.statusCode).toBe(403);
    // Neither the owner token nor a missing secret reaches the endpoint.
    const bearer = await harness.app.inject({
      method: "POST",
      url: new URL(server.url).pathname,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(bearer.statusCode).toBe(403);
    const allowed = await harness.app.inject({
      method: "POST",
      url: new URL(server.url).pathname,
      headers: server.headers,
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("advertises MCP tools, proxies results, and reports unknown outcome after dispatch loss", async () => {
    const harness = await createHarness();
    const { thread } = await harness.thread();
    const extension = await connect(harness, "instance-1", [bindingSummary(thread)]);
    await extension.nextType("server.hello");
    await harness.patch(thread, { browserEnabled: true });
    extension.socket.send(
      JSON.stringify(sessionRequest("attach", { kind: "existing", threadId: thread })),
    );
    await extension.nextType("session.result");
    extension.socket.send(
      JSON.stringify({ type: "binding.updated", binding: bindingSummary(thread) }),
    );
    await vi.waitFor(() => expect(harness.ui.summary(thread).browserStatus).toBe("connected"));
    const bindingId = harness.stored(thread).browserBinding!.bindingId;

    const initialized = await harness.mcp(bindingId, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: {} },
    });
    expect(initialized.json()).toMatchObject({
      result: { serverInfo: { name: "claudenest-browser" } },
    });
    const listed = await harness.mcp(bindingId, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(listed.json().result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      ...BROWSER_TOOL_NAMES,
    ]);

    const pending = harness.mcp(bindingId, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "navigate", arguments: { url: "https://example.com" } },
    });
    const call = await extension.nextType("tool.call");
    expect(call).toMatchObject({
      threadId: thread,
      tool: "navigate",
      arguments: { url: "https://example.com" },
    });
    extension.socket.send(
      JSON.stringify({
        type: "tool.result",
        requestId: call.requestId,
        result: { content: [{ type: "text", text: "navigated" }] },
      }),
    );
    expect((await pending).json()).toMatchObject({
      result: { content: [{ type: "text", text: "navigated" }] },
    });

    const lost = harness.mcp(bindingId, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "tabs_create", arguments: {} },
    });
    await extension.nextType("tool.call");
    extension.socket.terminate();
    expect((await lost).json()).toMatchObject({
      result: { isError: true, content: [{ text: expect.stringContaining("outcome unknown") }] },
    });
  });

  it("fails an undispatched call after the reconnect window", async () => {
    const harness = await createHarness({ disconnectWaitMs: 20 });
    const { thread } = await harness.thread();
    await harness.attach(thread, "instance-1");
    const bindingId = harness.stored(thread).browserBinding!.bindingId;
    const response = await harness.mcp(bindingId, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "tabs_context", arguments: {} },
    });
    expect(response.json()).toMatchObject({
      result: { isError: true, content: [{ text: "Browser extension is disconnected" }] },
    });
  });

  it("streams project files to the extension and rejects paths outside the project", async () => {
    const harness = await createHarness();
    const { project, thread } = await harness.thread();
    await writeFile(join(project.path, "upload.txt"), "hello upload");
    const extension = await connect(harness, "instance-1");
    await extension.nextType("server.hello");
    await harness.patch(thread, { browserEnabled: true });
    extension.socket.send(
      JSON.stringify(sessionRequest("attach", { kind: "existing", threadId: thread })),
    );
    await extension.nextType("session.result");
    extension.socket.send(
      JSON.stringify({ type: "binding.updated", binding: bindingSummary(thread) }),
    );
    await vi.waitFor(() => expect(harness.ui.summary(thread).browserStatus).toBe("connected"));
    const bindingId = harness.stored(thread).browserBinding!.bindingId;

    const outside = await harness.mcp(bindingId, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "upload_file", arguments: { ref: "f1", path: "/etc/hostname" } },
    });
    expect(outside.json()).toMatchObject({
      result: { isError: true, content: [{ text: expect.stringContaining("inside the thread") }] },
    });

    const pending = harness.mcp(bindingId, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "upload_file", arguments: { ref: "f1", path: "upload.txt" } },
    });
    const call = await extension.nextType("tool.call");
    const file = (call.arguments as { file: { transferId: string; size: number; name: string } })
      .file;
    expect(JSON.stringify(call.arguments)).not.toContain(project.path);
    expect(file).toMatchObject({ name: "upload.txt", size: 12 });
    extension.socket.send(JSON.stringify({ type: "file.request", transferId: file.transferId }));
    const transfer = await extension.nextType("file.transfer");
    expect(Buffer.from(transfer.data, "base64").toString()).toBe("hello upload");
    extension.socket.send(
      JSON.stringify({
        type: "tool.result",
        requestId: call.requestId,
        result: { content: [{ type: "text", text: "uploaded" }] },
      }),
    );
    expect((await pending).statusCode).toBe(200);
  });
});

async function createHarness(options: { disconnectWaitMs?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "claudenest-browser-"));
  const config: Config = {
    host: "127.0.0.1",
    port: 4311,
    stateDir: join(directory, "state"),
    runtimeDir: join(directory, "runtime"),
    configDir: join(directory, "native"),
    claudeBin: "/fake/never-executed-claude",
    nodeBin: process.execPath,
    releasePath: "/test/release",
    runnerPath: "/test/release/runner.js",
    serverEnvFile: join(directory, "server.env"),
    token: TOKEN,
    allowedOrigins: new Set(["http://localhost"]),
  };
  let launchConfig: (id: string) => ReturnType<NonNullable<SessionLaunch>> = () => undefined;
  const manager = {
    config,
    accepting: false,
    list: async () => [],
    descriptor: async () => undefined,
    close: async () => {},
    setBrowserLaunch: (provider: NonNullable<SessionLaunch>) => {
      launchConfig = provider;
    },
  } as unknown as SessionManager;
  const ui = new UiService(manager);
  await ui.initialize({ probeModels: false });
  const app = await buildApp(manager, ui, { disconnectWaitMs: options.disconnectWaitMs });
  await app.ready();
  cleanup.push(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const headers = { authorization: `Bearer ${TOKEN}` };
  const harness = {
    app,
    ui,
    config,
    launchConfig: (id: string) => launchConfig(id),
    stored: (id: string) => ui.store.data.threads[id]!,
    patch: (id: string, payload: Record<string, unknown>) =>
      app.inject({ method: "PATCH", url: `/api/v1/threads/${id}`, headers, payload }),
    thread: async (existing?: Project) => {
      let project = existing;
      if (!project) {
        const path = join(directory, `project-${randomUUID()}`);
        await mkdir(path);
        const response = await app.inject({
          method: "POST",
          url: "/api/v1/projects",
          headers,
          payload: { path },
        });
        project = response.json<Project>();
      }
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/threads`,
        headers,
        payload: { clientCreationId: randomUUID() },
      });
      return { project, thread: response.json<{ thread: { id: string } }>().thread.id };
    },
    attach: async (threadId: string, instanceId: string) => {
      const extension = await connect(harness, instanceId);
      await extension.nextType("server.hello");
      await harness.patch(threadId, { browserEnabled: true });
      extension.socket.send(
        JSON.stringify(sessionRequest("attach", { kind: "existing", threadId })),
      );
      await extension.nextType("session.result");
      return extension;
    },
    mcp: (bindingId: string, payload: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: `/api/v1/internal/browser-mcp/${bindingId}`,
        headers: { "x-claudenest-browser-secret": SECRET },
        payload,
      }),
  };
  return harness;
}

async function connect(
  harness: { app: Awaited<ReturnType<typeof buildApp>> },
  instanceId: string,
  bindings: BrowserExtensionBindingSummary[] = [],
) {
  const socket = await harness.app.injectWS(BROWSER_EXTENSION_WEBSOCKET_PATH, {
    headers: { origin: CLAUDE_BROWSER_EXTENSION_ORIGIN },
  });
  const frames = frameReader(socket);
  socket.send(JSON.stringify(helloFrame(instanceId, bindings)));
  return { socket, ...frames };
}

function helloFrame(instanceId: string, bindings: BrowserExtensionBindingSummary[] = []) {
  return {
    type: "client.hello",
    protocol: BROWSER_EXTENSION_PROTOCOL,
    version: BROWSER_EXTENSION_PROTOCOL_VERSION,
    token: TOKEN,
    instanceId,
    extensionVersion: "0.1.9",
    browser: { name: "chrome", version: "128" },
    capabilities: {
      tools: BROWSER_TOOL_NAMES,
      maxProjectFileBytes: 100 * 1024 * 1024,
      screenshots: ["image/jpeg", "image/png"],
    },
    bindings,
  };
}

function sessionRequest(requestId: string, target: Record<string, string>) {
  return {
    type: "session.request",
    requestId,
    target,
    tab: {
      id: 1,
      windowId: 1,
      groupId: -1,
      active: true,
      title: "Tab",
      url: "https://example.com",
    },
  };
}

function bindingSummary(threadId: string): BrowserExtensionBindingSummary {
  return {
    threadId,
    projectId: "project",
    title: threadId,
    groupId: 1,
    tabIds: [1],
    createdAt: 1,
    updatedAt: 1,
  };
}

function frameReader(socket: WebSocket) {
  const queued: BrowserExtensionServerFrame[] = [];
  const waiters: Array<(frame: BrowserExtensionServerFrame) => void> = [];
  socket.on("message", (data) => {
    const frame = JSON.parse(data.toString()) as BrowserExtensionServerFrame;
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else queued.push(frame);
  });
  const next = (): Promise<BrowserExtensionServerFrame> => {
    const frame = queued.shift();
    return frame ? Promise.resolve(frame) : new Promise((resolve) => waiters.push(resolve));
  };
  return {
    async nextType<Type extends BrowserExtensionServerFrame["type"]>(type: Type) {
      for (;;) {
        const frame = await next();
        if (frame.type === type)
          return frame as Extract<BrowserExtensionServerFrame, { type: Type }>;
      }
    },
  };
}

function closeCode(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}
