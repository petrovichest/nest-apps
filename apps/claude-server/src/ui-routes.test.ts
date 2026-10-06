import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import type {
  Project,
  QueuedMessage,
  ServerFrame,
  ThreadDetail,
  ThreadDraft,
  ThreadFileAttachment,
} from "@codexnest/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { buildApp } from "./app";
import type { Config } from "./config";
import type { SessionManager } from "./manager";
import type { RunnerConnection } from "./rpc";
import { AppError, type CommandReceipt, type RunnerDescriptor, type RunnerSnapshot } from "./types";
import { UiService } from "./ui-service";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
async function fixture() {
  const directory = await mkdtemp("/tmp/claude-ui-http-");
  const clientDist = join(directory, "client");
  await mkdir(clientDist);
  await Promise.all([
    writeFile(
      join(clientDist, "index.html"),
      "<!doctype html><html><body>ClaudeNest test shell</body></html>",
    ),
    writeFile(join(clientDist, "sw.js"), "self.testOnly = true;"),
    writeFile(join(clientDist, "asset.js"), "window.testOnly = true;"),
  ]);
  const config: Config = {
    host: "127.0.0.1",
    port: 1,
    stateDir: join(directory, "state"),
    runtimeDir: join(directory, "runtime"),
    configDir: join(directory, "native"),
    claudeBin: "/fake/never-executed-claude",
    nodeBin: process.execPath,
    releasePath: "/test/release",
    runnerPath: "/test/release/runner.js",
    serverEnvFile: join(directory, "server.env"),
    token: "private-test-token-with-at-least-32-characters",
    allowedOrigins: new Set(["http://claude.home.arpa"]),
    clientDist,
  };
  const operations: string[] = [];
  const unexpected = (name: string) => {
    operations.push(name);
    throw new Error(`Unexpected native operation: ${name}`);
  };
  const manager = {
    config,
    accepting: false,
    list: async () => [],
    descriptor: async () => undefined,
    create: async () => unexpected("create"),
    send: async () => unexpected("send"),
    subscribe: async () => unexpected("subscribe"),
    snapshot: async () => unexpected("snapshot"),
    command: async () => unexpected("command"),
    close: async () => {},
  } as unknown as SessionManager;
  const ui = new UiService(manager);
  await ui.initialize({ probeModels: false });
  const app = await buildApp(manager, ui);
  await app.ready();
  cleanup.push(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const headers = { authorization: `Bearer ${config.token}`, origin: "http://claude.home.arpa" };
  const reserve = async () => {
    const projectResponse = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers,
      payload: { path: directory },
    });
    expect(projectResponse.statusCode).toBe(200);
    const project = projectResponse.json<Project>();
    const threadResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/threads`,
      headers,
      payload: { clientCreationId: randomUUID() },
    });
    expect(threadResponse.statusCode).toBe(200);
    return { project, id: threadResponse.json<{ thread: { id: string } }>().thread.id };
  };
  return { app, ui, manager, config, directory, headers, reserve, operations };
}

async function attachActive(state: Awaited<ReturnType<typeof fixture>>, id: string) {
  const owner: RunnerSnapshot = {
    sessionId: id,
    runnerInstanceId: randomUUID(),
    protocolVersion: 1,
    releasePath: state.config.releasePath,
    claudeVersion: "test",
    runnerPid: 999999,
    cwd: state.directory,
    state: "running",
    sequence: 0,
    pendingRequests: [],
    currentEvents: [],
    commands: [],
    permissionMode: "bypassPermissions",
    capabilities: {
      contentBlocks: true,
      uploadedImages: true,
      setModel: true,
      setPermissionMode: true,
      steer: true,
      livePermissionMode: true,
    },
  };
  const descriptor: RunnerDescriptor = {
    sessionId: id,
    cwd: owner.cwd,
    claudeBin: state.config.claudeBin,
    nodeBin: state.config.nodeBin,
    configDir: state.config.configDir,
    runnerPath: state.config.runnerPath,
    releasePath: state.config.releasePath,
    stateDirectory: join(state.config.stateDir, id),
    socketPath: join(state.config.runtimeDir, `${id}.sock`),
    resume: true,
    protocolVersion: 1,
  };
  class Connection extends EventEmitter {
    async request() {
      this.emit("message", { type: "snapshot", snapshot: structuredClone(owner) });
      return { sequence: owner.sequence };
    }
    close() {
      this.emit("close");
    }
  }
  state.manager.descriptor = async () => descriptor;
  state.manager.snapshot = async () => structuredClone(owner);
  state.manager.subscribe = async () => new Connection() as unknown as RunnerConnection;
  const steer = vi.fn(async (_id: string, requestId: string, prompt: string) => {
    const receipt: CommandReceipt = {
      requestId,
      kind: "steer",
      fingerprint: prompt,
      status: "completed",
    };
    owner.commands.push(receipt);
    return receipt;
  });
  state.manager.steer = steer;
  const command = vi.fn(async (_id: string, method: string, params: Record<string, unknown>) => {
    if (method === "setPermissionMode")
      owner.permissionMode = params.permissionMode as RunnerSnapshot["permissionMode"];
    return {
      requestId: String(params.requestId),
      kind: method,
      fingerprint: "control",
      status: "completed",
    };
  });
  state.manager.command = command;
  await state.ui.attach(id);
  state.manager.accepting = true;
  return { owner, steer, command };
}

describe("Claude browser UI HTTP and global stream", () => {
  it("sends turns and explicit steering straight to a busy owner while explicit FIFO waits", async () => {
    const state = await fixture(),
      { id } = await state.reserve();
    const { steer, command } = await attachActive(state, id);
    const queued = await state.app.inject({
      method: "POST",
      url: `/api/v1/threads/${id}/queue`,
      headers: state.headers,
      payload: { input: "FIFO later", clientMessageId: randomUUID() },
    });
    expect(queued.statusCode).toBe(202);
    const firstId = randomUUID(),
      secondId = randomUUID();
    const turn = await state.app.inject({
      method: "POST",
      url: `/api/v1/threads/${id}/turns`,
      headers: state.headers,
      payload: { input: "Active adjustment", clientMessageId: firstId },
    });
    expect(turn.statusCode).toBe(202);
    expect(turn.json()).toMatchObject({ turnId: firstId, deliveryReceipt: { clientId: firstId } });
    const explicit = await state.app.inject({
      method: "POST",
      url: `/api/v1/threads/${id}/steer`,
      headers: state.headers,
      payload: { input: "Another adjustment", clientMessageId: secondId },
    });
    expect(explicit.statusCode).toBe(202);
    await expect.poll(() => steer.mock.calls.length).toBe(2);
    await expect.poll(() => state.ui.thread(id).queue.length).toBe(1);
    expect(steer.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      [id, firstId, "Active adjustment"],
      [id, secondId, "Another adjustment"],
    ]);
    expect(state.ui.thread(id).queue[0]?.text).toBe("FIFO later");
    expect(command).not.toHaveBeenCalled();
    expect(state.operations).toEqual([]);
  });

  it("promotes a selected queued message to steering and preserves its original retry identity", async () => {
    const state = await fixture(),
      { id } = await state.reserve();
    const { steer, command } = await attachActive(state, id);
    const first = { input: "Leave first in FIFO", clientMessageId: randomUUID() },
      selected = {
        input: "Send selected now",
        clientMessageId: randomUUID(),
        pasteBlocks: [{ id: "paste", text: "Selected context" }],
      };
    for (const payload of [first, selected])
      expect(
        (
          await state.app.inject({
            method: "POST",
            url: `/api/v1/threads/${id}/queue`,
            headers: state.headers,
            payload,
          })
        ).statusCode,
      ).toBe(202);
    const response = await state.app.inject({
      method: "POST",
      url: `/api/v1/threads/${id}/queue/${selected.clientMessageId}/send`,
      headers: state.headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ turnId: selected.clientMessageId });
    await expect.poll(() => steer.mock.calls.length).toBe(1);
    await expect.poll(() => state.ui.thread(id).queue.length).toBe(1);
    expect(steer.mock.calls[0]?.[1]).toBe(selected.clientMessageId);
    expect(steer.mock.calls[0]?.[2]).toContain("Selected context");
    expect(state.ui.thread(id).queue[0]?.id).toBe(first.clientMessageId);
    const retry = await state.app.inject({
      method: "POST",
      url: `/api/v1/threads/${id}/queue`,
      headers: state.headers,
      payload: selected,
    });
    expect(retry.statusCode).toBe(202);
    expect(retry.json<QueuedMessage>().id).toBe(selected.clientMessageId);
    expect(steer).toHaveBeenCalledTimes(1);
    expect(command).not.toHaveBeenCalled();
    expect(state.operations).toEqual([]);
  });

  it("defaults to full access and applies permission settings live with optimistic version checks", async () => {
    const state = await fixture(),
      { id } = await state.reserve();
    const { command, owner } = await attachActive(state, id);
    const original = await state.app.inject({
      url: "/api/v1/settings/permissions",
      headers: state.headers,
    });
    expect(original.statusCode).toBe(200);
    expect(original.json()).toMatchObject({ preset: "full-access", version: "1" });
    const changed = await state.app.inject({
      method: "PUT",
      url: "/api/v1/settings/permissions",
      headers: state.headers,
      payload: { preset: "ask", expectedVersion: "1" },
    });
    expect(changed.statusCode).toBe(200);
    expect(owner.state).toBe("running");
    expect(owner.permissionMode).toBe("manual");
    expect(command.mock.calls.map((call) => [call[1], call[2].permissionMode])).toEqual([
      ["setPermissionMode", "manual"],
    ]);
    const stale = await state.app.inject({
      method: "PUT",
      url: "/api/v1/settings/permissions",
      headers: state.headers,
      payload: { preset: "full-access", expectedVersion: "1" },
    });
    expect(stale.statusCode).toBe(409);
    expect(command).toHaveBeenCalledTimes(1);
    expect(state.ui.snapshot().permissionSettings).toMatchObject({ preset: "ask", version: "2" });
  });
  it("serves the PWA shell without credentials while guarding APIs and foreign origins", async () => {
    const { app, headers } = await fixture();
    const shell = await app.inject({ url: "/" });
    expect(shell.statusCode).toBe(200);
    expect(shell.body).toContain("ClaudeNest test shell");
    expect(shell.headers["cache-control"]).toBe("no-cache");
    expect(shell.headers["x-content-type-options"]).toBe("nosniff");
    expect((await app.inject({ url: "/sw.js" })).headers["cache-control"]).toBe("no-cache");
    expect((await app.inject({ url: "/asset.js" })).statusCode).toBe(200);
    expect(
      (await app.inject({ url: "/project/route", headers: { accept: "text/html" } })).body,
    ).toBe(shell.body);
    expect((await app.inject({ url: "/api/v1/summary" })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          url: "/api/v1/health",
          headers: { ...headers, authorization: "Bearer wrong" },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          url: "/api/v1/summary",
          headers: { ...headers, origin: "https://unrelated.example" },
        })
      ).statusCode,
    ).toBe(403);
    expect((await app.inject({ url: "/api/v1/health", headers })).json()).toMatchObject({
      provider: "claude",
      app: "claudenest",
    });
  });

  it("keeps missing native/API/download responses as JSON instead of serving the SPA", async () => {
    const { app, headers } = await fixture();
    for (const url of [
      "/api/v1/unknown",
      `/api/v1/sessions/${randomUUID()}/history`,
      `/downloads/${randomUUID()}`,
    ]) {
      const response = await app.inject({ url, headers: { ...headers, accept: "text/html" } });
      expect(response.statusCode).toBe(404);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.json()).toMatchObject({ error: { code: "not_found" } });
      expect(response.body).not.toContain("test shell");
    }
  });

  it("rejects unauthenticated global WebSockets and sends one authenticated snapshot plus ordered UI events", async () => {
    const { app, headers, config, reserve, ui } = await fixture();
    await expect(
      app.injectWS("/api/v1/ui/events", { headers: { origin: "https://unrelated.example" } }),
    ).rejects.toThrow();
    const denied = await app.injectWS("/api/v1/ui/events", { headers });
    const deniedClose = once(denied, "close");
    denied.send(JSON.stringify({ type: "authenticate", token: "wrong" }));
    expect((await deniedClose)[0]).toBe(1008);
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const socket = new WebSocket(`${address.replace(/^http/, "ws")}/api/v1/ui/events`, {
      headers: { origin: headers.origin },
    });
    await once(socket, "open");
    const received: ServerFrame[] = [];
    socket.on("message", (raw) => received.push(JSON.parse(raw.toString()) as ServerFrame));
    socket.send(JSON.stringify({ type: "authenticate", token: config.token }));
    await expect.poll(() => received.length).toBe(1);
    expect(received[0]).toMatchObject({
      type: "snapshot",
      snapshot: { provider: "claude", instanceId: ui.instanceId, threads: [], attention: [] },
    });
    const { id } = await reserve();
    await expect.poll(() => received.filter((frame) => frame.type === "event").length).toBe(2);
    const events = received.filter((frame) => frame.type === "event");
    expect(events.map((frame) => frame.sequence)).toEqual([1, 2]);
    expect(events.map((frame) => frame.version)).toEqual([
      { instanceId: ui.instanceId, sequence: 1 },
      { instanceId: ui.instanceId, sequence: 2 },
    ]);
    expect(events[1]).toMatchObject({ event: { type: "thread.upserted", thread: { id } } });
    socket.send(JSON.stringify({ type: "ping" }));
    await expect.poll(() => received.at(-1)).toEqual({ type: "pong" });
    const closed = once(socket, "close");
    socket.close();
    await closed;
    await expect.poll(() => ui.listenerCount("frame")).toBe(0);
  });

  it("preserves shared project, blank-thread, draft conflict, and durable queue contracts", async () => {
    const { app, ui, directory, headers, reserve, operations } = await fixture();
    const { project, id } = await reserve();
    expect(project.path).toBe(directory);
    const detail = (
      await app.inject({ url: `/api/v1/threads/${id}`, headers })
    ).json<ThreadDetail>();
    expect(detail).toMatchObject({
      summary: { id, projectId: project.id, state: "idle" },
      turns: [],
      queuedMessages: [],
      draft: null,
    });
    const value = { input: "Draft text", images: [], goalMode: false, annotations: [] };
    const draftResponse = await app.inject({
      method: "PUT",
      url: `/api/v1/threads/${id}/draft?expectedUpdatedAt=none`,
      headers,
      payload: value,
    });
    expect(draftResponse.statusCode).toBe(200);
    expect(draftResponse.json()).toMatchObject(value);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/v1/threads/${id}/draft?expectedUpdatedAt=none`,
          headers,
          payload: { ...value, input: "Stale update" },
        })
      ).statusCode,
    ).toBe(409);
    const clientMessageId = randomUUID(),
      payload = { input: "Send later", clientMessageId };
    const queued = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${id}/queue`,
      headers,
      payload,
    });
    expect(queued.statusCode).toBe(202);
    expect(queued.json()).toMatchObject({
      id: clientMessageId,
      threadId: id,
      text: "Send later",
      status: "queued",
      deliveryVersion: 1,
    });
    expect(
      (
        await app.inject({ method: "POST", url: `/api/v1/threads/${id}/queue`, headers, payload })
      ).json<QueuedMessage>().id,
    ).toBe(clientMessageId);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/threads/${id}/queue`,
          headers,
          payload: { ...payload, input: "Different" },
        })
      ).statusCode,
    ).toBe(409);
    expect(ui.thread(id).queue).toHaveLength(1);
    const queuedDetail = (
      await app.inject({ url: `/api/v1/threads/${id}`, headers })
    ).json<ThreadDetail>();
    expect(queuedDetail.queuedMessages).toHaveLength(1);
    expect(queuedDetail.summary.state).toBe("queued");
    expect(JSON.parse(await readFile(ui.store.path, "utf8")).threads[id].queue[0].id).toBe(
      clientMessageId,
    );
    expect(operations).toEqual([]);
  });

  it("merges a stale editor's project draft changes while preserving newer remote input", async () => {
    const { app, headers, reserve } = await fixture();
    const { project } = await reserve();
    const empty = { input: "", images: [], goalMode: false, annotations: [] };
    const firstValue = { ...empty, input: "Original draft" };
    const first = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${project.id}/draft`,
      headers,
      payload: { base: empty, value: firstValue },
    });
    expect(first.statusCode).toBe(200);
    const base = first.json<ThreadDraft>();
    const remoteValue = { ...base, input: "Newer text from another device" };
    const remote = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${project.id}/draft`,
      headers,
      payload: { base, value: remoteValue },
    });
    expect(remote.statusCode).toBe(200);
    const image = { id: "local-image", name: "image.png", url: "data:image/png;base64,aW1hZ2U=" };
    const stale = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${project.id}/draft`,
      headers,
      payload: { base, value: { ...base, images: [image] } },
    });
    expect(stale.statusCode).toBe(200);
    expect(stale.json()).toMatchObject({
      input: "Newer text from another device",
      images: [image],
      goalMode: false,
    });
    const rejected = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${project.id}/draft?expectedUpdatedAt=${base.updatedAt}`,
      headers,
      payload: { base, value: { ...base, input: "Obsolete forced replacement" } },
    });
    expect(rejected.statusCode).toBe(409);
    const final = await app.inject({ url: `/api/v1/projects/${project.id}/draft`, headers });
    expect(final.json()).toMatchObject({
      input: "Newer text from another device",
      images: [image],
    });
  });

  it("retains a dispatchable delivery ledger when editing a queued message", async () => {
    const { app, ui, manager, headers, reserve } = await fixture();
    const { id } = await reserve(),
      clientMessageId = randomUUID();
    await app.inject({
      method: "POST",
      url: `/api/v1/threads/${id}/queue`,
      headers,
      payload: { input: "Original", clientMessageId },
    });
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/threads/${id}/queue/${clientMessageId}`,
      headers,
      payload: { input: "Edited" },
    });
    expect(updated.statusCode).toBe(200);
    const message = updated.json<QueuedMessage>();
    expect(message.text).toBe("Edited");
    expect(
      Object.values(ui.thread(id).deliveries).some((delivery) => delivery.messageId === message.id),
    ).toBe(true);
    expect(ui.thread(id).queue.map((entry) => entry.id)).toEqual([message.id]);
    const dispatched: Array<{ prompt: string; requestId: string }> = [];
    manager.create = async (input) => {
      dispatched.push({ prompt: input.prompt, requestId: input.requestId });
      throw new AppError("conflict", "Test owner refused delivery", 409);
    };
    manager.snapshot = async () => {
      throw new AppError("not_found", "No test owner", 404);
    };
    manager.accepting = true;
    ui.schedule(id);
    await expect
      .poll(() => ui.thread(id).queue[0]?.deliveryError?.message)
      .toBe("Test owner refused delivery");
    expect(dispatched).toEqual([{ prompt: "Edited", requestId: clientMessageId }]);
  });

  it("normalizes nullable model and effort selections before starting a new owner", async () => {
    const { app, ui, manager, headers, reserve } = await fixture();
    const { id } = await reserve();
    await ui.store.update((data) => {
      data.models = [
        { value: "default", displayName: "Default", description: "Claude default" },
        {
          value: "sonnet",
          displayName: "Sonnet",
          description: "Claude Sonnet",
          supportedEffortLevels: ["high"],
        },
      ];
    });
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/v1/threads/${id}/settings`,
          headers,
          payload: { model: "sonnet", reasoningEffort: "high" },
        })
      ).statusCode,
    ).toBe(200);
    const defaults = await app.inject({
      method: "PATCH",
      url: `/api/v1/threads/${id}/settings`,
      headers,
      payload: { model: null, reasoningEffort: null },
    });
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json()).toMatchObject({
      settings: { model: "default" },
      codexSettings: { model: "default", reasoningEffort: null },
    });
    expect(ui.thread(id).settings.reasoningEffort).toBeUndefined();
    const dispatched: Array<{ model?: string; effort?: string }> = [];
    manager.create = async (input) => {
      dispatched.push({ model: input.model, effort: input.effort });
      throw new AppError("conflict", "Test owner refused delivery", 409);
    };
    manager.snapshot = async () => {
      throw new AppError("not_found", "No test owner", 404);
    };
    manager.accepting = true;
    await app.inject({
      method: "POST",
      url: `/api/v1/threads/${id}/queue`,
      headers,
      payload: { input: "Use defaults", clientMessageId: randomUUID() },
    });
    await expect.poll(() => dispatched).toEqual([{ model: "default", effort: undefined }]);
  });

  it("streams private attachment uploads and limits download tickets to the owning session", async () => {
    const { app, headers, reserve, operations, directory } = await fixture();
    const { id } = await reserve(),
      { id: otherId } = await reserve();
    const chunks = [Buffer.from("First chunk\n"), Buffer.from("Second chunk\n")],
      contents = Buffer.concat(chunks);
    const upload = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${id}/attachments?name=notes.txt&mediaType=text%2Fplain`,
      headers: {
        ...headers,
        "content-type": "application/octet-stream",
        "content-length": String(contents.length),
      },
      payload: Readable.from(chunks),
    });
    expect(upload.statusCode).toBe(200);
    const attachment = upload.json<ThreadFileAttachment>();
    expect(attachment).toMatchObject({
      name: "notes.txt",
      mediaType: "text/plain",
      size: contents.length,
    });
    expect(await readFile(attachment.path)).toEqual(contents);
    expect((await stat(attachment.path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(dirname(attachment.path)))).mode & 0o777).toBe(0o700);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/threads/${otherId}/downloads`,
          headers,
          payload: { path: attachment.path },
        })
      ).statusCode,
    ).toBe(404);
    const workspace = join(directory, "workspace.txt");
    await writeFile(workspace, "workspace file");
    const workspaceTicket = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${id}/downloads`,
      headers,
      payload: { path: workspace },
    });
    expect(workspaceTicket.statusCode).toBe(200);
    expect(
      (await app.inject({ url: workspaceTicket.json<{ downloadUrl: string }>().downloadUrl })).body,
    ).toBe("workspace file");
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/threads/${id}/downloads`,
          payload: { path: attachment.path },
        })
      ).statusCode,
    ).toBe(401);
    const ticket = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${id}/downloads`,
      headers,
      payload: { path: attachment.path },
    });
    expect(ticket.statusCode).toBe(200);
    const url = ticket.json<{ downloadUrl: string }>().downloadUrl;
    expect(url).toMatch(/^\/downloads\/[0-9a-f-]+$/);
    const download = await app.inject({ url });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload).toEqual(contents);
    expect(download.headers["cache-control"]).toBe("private, no-store");
    expect(download.headers["content-disposition"]).toContain("notes.txt");
    expect((await app.inject({ url })).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/threads/${otherId}/queue`,
          headers,
          payload: { input: "Wrong session", files: [attachment] },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/threads/${id}/queue`,
          headers,
          payload: { input: "Read attachment", files: [attachment], clientMessageId: randomUUID() },
        })
      ).statusCode,
    ).toBe(202);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/v1/threads/${id}/attachments/${attachment.id}`,
          headers,
        })
      ).statusCode,
    ).toBe(409);
    expect(operations).toEqual([]);
  });

  it("downloads an exact external image only after a successful tool read in that session", async () => {
    const state = await fixture(),
      { id } = await state.reserve(),
      { id: otherId } = await state.reserve();
    const outside = await mkdtemp("/tmp/claude-ui-images-");
    cleanup.push(() => rm(outside, { recursive: true, force: true }));
    const viewed = join(outside, "viewed.png"),
      unseen = join(outside, "unseen.png"),
      failed = join(outside, "failed.png"),
      text = join(outside, "notes.txt"),
      alias = join(outside, "alias.png"),
      workspaceAlias = join(state.directory, "alias.png");
    const contents = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8T8AAAAASUVORK5CYII=",
      "base64",
    );
    await Promise.all([
      writeFile(viewed, contents),
      writeFile(unseen, contents),
      writeFile(failed, contents),
      writeFile(text, "private external text"),
      symlink(viewed, alias),
      symlink(viewed, workspaceAlias),
    ]);
    const download = (sessionId: string, path: string) =>
      state.app.inject({
        method: "POST",
        url: `/api/v1/threads/${sessionId}/downloads`,
        headers: state.headers,
        payload: { path },
      });
    expect((await download(id, viewed)).statusCode).toBe(403);
    const historyDirectory = join(state.config.configDir, "projects", "test");
    await mkdir(historyDirectory, { recursive: true });
    const events = [viewed, failed, text, alias, workspaceAlias].flatMap((path, index) => [
      {
        type: "assistant",
        uuid: `read-${index}`,
        cwd: state.directory,
        message: {
          id: `message-${index}`,
          stop_reason: "tool_use",
          content: [
            { type: "tool_use", id: `tool-${index}`, name: "Read", input: { file_path: path } },
          ],
        },
      },
      {
        type: "user",
        uuid: `result-${index}`,
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: `tool-${index}`,
              ...(path === failed ? { is_error: true } : {}),
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: contents.toString("base64"),
                  },
                },
              ],
            },
          ],
        },
      },
    ]);
    await writeFile(
      join(historyDirectory, `${id}.jsonl`),
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
    await state.ui.refresh(id);
    const ticket = await download(id, viewed);
    expect(ticket.statusCode).toBe(200);
    const response = await state.app.inject({
      url: ticket.json<{ downloadUrl: string }>().downloadUrl,
    });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(contents);
    expect(response.headers["content-length"]).toBe(String(contents.length));
    expect(response.headers["content-type"]).toBe("application/octet-stream");
    for (const path of [unseen, failed, text, alias, workspaceAlias])
      expect((await download(id, path)).statusCode).toBe(403);
    expect((await download(otherId, viewed)).statusCode).toBe(403);
  });

  it("rejects private attachment aliases and revalidates ticket paths before serving files", async () => {
    const { app, headers, reserve, directory } = await fixture();
    const { id } = await reserve(),
      { id: otherId } = await reserve();
    const upload = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${otherId}/attachments?name=private.png&mediaType=image%2Fpng`,
      headers: { ...headers, "content-type": "application/octet-stream" },
      payload: Buffer.from("private attachment"),
    });
    expect(upload.statusCode).toBe(200);
    const attachment = upload.json<ThreadFileAttachment>(),
      privateAlias = join(directory, "private-alias.png"),
      workspace = join(directory, "report.txt");
    await symlink(attachment.path, privateAlias);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/threads/${id}/downloads`,
          headers,
          payload: { path: privateAlias },
        })
      ).statusCode,
    ).toBe(404);
    await writeFile(workspace, "original workspace file");
    for (const [path, ownerId] of [
      [workspace, id],
      [attachment.path, otherId],
    ] as const) {
      const ticket = await app.inject({
        method: "POST",
        url: `/api/v1/threads/${ownerId}/downloads`,
        headers,
        payload: { path },
      });
      expect(ticket.statusCode).toBe(200);
      await rm(path);
      await symlink(workspace === path ? attachment.path : workspace, path);
      const url = ticket.json<{ downloadUrl: string }>().downloadUrl;
      expect((await app.inject({ url })).statusCode).toBe(404);
      expect((await app.inject({ url })).statusCode).toBe(404);
      await rm(path);
      await writeFile(path, "restored file");
    }
  });
});
