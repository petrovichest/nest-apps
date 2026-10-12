import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import websocket from "@fastify/websocket";
import Fastify from "fastify";
import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BROWSER_EXTENSION_ORIGIN,
  BROWSER_EXTENSION_PROTOCOL,
  BROWSER_EXTENSION_PROTOCOL_VERSION,
  BROWSER_EXTENSION_WEBSOCKET_PATH,
  BROWSER_TOOL_NAMES,
  type AppSnapshot,
  type BrowserExtensionBindingSummary,
  type BrowserExtensionServerFrame,
  type BrowserThreadStatus,
  type ThreadSummary,
} from "@codexnest/protocol";

import { hashToken } from "./auth";
import { BrowserExtensionError, BrowserExtensionServer } from "./browser-extension";
import type { AppProjection } from "./projection";
import { StateStore } from "./state/store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("browser extension transport", () => {
  it("enforces origin, owner authentication, and the protocol version", async () => {
    const harness = await createHarness();

    const rejectedOrigin = await harness.app.injectWS(BROWSER_EXTENSION_WEBSOCKET_PATH, {
      headers: { origin: "http://rejected" },
    });
    expect(await closeCode(rejectedOrigin)).toBe(1008);

    const rejectedLegacyBrowserOrigin = await harness.app.injectWS(
      BROWSER_EXTENSION_WEBSOCKET_PATH,
      { headers: { origin: "moz-extension://123e4567-e89b-12d3-a456-426614174000" } },
    );
    expect(await closeCode(rejectedLegacyBrowserOrigin)).toBe(1008);

    const rejectedToken = await harness.app.injectWS(BROWSER_EXTENSION_WEBSOCKET_PATH, {
      headers: { origin: "http://allowed" },
    });
    rejectedToken.send(
      JSON.stringify({
        ...helloFrame("extension-instance-1"),
        token: "wrong",
      }),
    );
    expect(await closeCode(rejectedToken)).toBe(1008);

    const rejectedVersion = await harness.app.injectWS(BROWSER_EXTENSION_WEBSOCKET_PATH, {
      headers: { origin: "http://allowed" },
    });
    rejectedVersion.send(
      JSON.stringify({
        ...helloFrame("extension-instance-1"),
        version: BROWSER_EXTENSION_PROTOCOL_VERSION + 1,
      }),
    );
    expect(await closeCode(rejectedVersion)).toBe(1002);

    const acceptedExtensionOrigin = await harness.app.injectWS(BROWSER_EXTENSION_WEBSOCKET_PATH, {
      headers: { origin: BROWSER_EXTENSION_ORIGIN },
    });
    const acceptedFrames = frameReader(acceptedExtensionOrigin);
    acceptedExtensionOrigin.send(JSON.stringify(helloFrame("extension-instance-1")));
    expect((await acceptedFrames.next()).type).toBe("server.hello");
    acceptedExtensionOrigin.close();

    await harness.close();
  });

  it("pushes project and thread catalog changes to connected popups", async () => {
    const harness = await createHarness();
    const extension = await connect(harness.app, "extension-instance-1");
    expect((await extension.nextType("server.hello")).threads).toEqual([]);

    const second = { ...summary("second"), state: "running" } satisfies ThreadSummary;
    harness.projection.summaries.set(second.id, second);
    await harness.store.update((state) => {
      state.threadMeta.second = {
        pinned: false,
        lastReadUpdatedAt: 0,
        browserEnabled: true,
      };
    });
    harness.projection.emit("event", 2, { type: "thread.upserted", thread: second });

    const catalog = await extension.nextType("catalog.updated");
    expect(catalog.threads).toEqual([
      expect.objectContaining({ id: "second", projectId: "project" }),
    ]);
    extension.socket.close();
    await harness.close();
  });

  it("coalesces catalog bursts into one snapshot shared by separately filtered connections", async () => {
    const harness = await createHarness();
    for (const id of ["shared", "owned"]) harness.projection.summaries.set(id, summary(id));
    await harness.store.update((state) => {
      for (const id of ["shared", "owned"]) {
        state.threadMeta[id] = { pinned: false, lastReadUpdatedAt: 0, browserEnabled: true };
      }
      state.threadMeta.owned!.browserBinding = {
        bindingId: "owned-binding",
        instanceId: "extension-instance-1",
        attachedAt: 1,
      };
    });
    const first = await connect(harness.app, "extension-instance-1");
    const second = await connect(harness.app, "extension-instance-2");
    expect((await first.nextType("server.hello")).threads.map((thread) => thread.id)).toEqual([
      "shared",
      "owned",
    ]);
    expect((await second.nextType("server.hello")).threads.map((thread) => thread.id)).toEqual([
      "shared",
    ]);
    const snapshot = vi.spyOn(harness.projection, "snapshot");
    for (let index = 0; index < 1000; index += 1) {
      const thread = { ...summary("shared"), title: `Title ${index}` };
      harness.projection.summaries.set(thread.id, thread);
      harness.projection.emit("event", index, { type: "thread.upserted", thread });
    }
    expect(snapshot).not.toHaveBeenCalled();
    const firstCatalog = await first.nextType("catalog.updated");
    const secondCatalog = await second.nextType("catalog.updated");
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(firstCatalog.threads).toEqual([
      expect.objectContaining({ id: "shared", title: "Title 999" }),
      expect.objectContaining({ id: "owned" }),
    ]);
    expect(secondCatalog.threads).toEqual([
      expect.objectContaining({ id: "shared", title: "Title 999" }),
    ]);
    harness.projection.summaries.delete("shared");
    harness.projection.emit("event", 1000, { type: "thread.removed", threadId: "shared" });
    expect((await first.nextType("catalog.updated")).threads.map((thread) => thread.id)).toEqual([
      "owned",
    ]);
    expect((await second.nextType("catalog.updated")).threads).toEqual([]);
    expect(snapshot).toHaveBeenCalledTimes(2);
    first.socket.close();
    second.socket.close();
    await harness.close();
  });

  it("does not build catalogs without connections or after shutdown", async () => {
    const harness = await createHarness();
    const snapshot = vi.spyOn(harness.projection, "snapshot");
    harness.projection.emit("event", 1, { type: "resync.required" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(snapshot).not.toHaveBeenCalled();
    const extension = await connect(harness.app, "extension-instance-1");
    await extension.nextType("server.hello");
    snapshot.mockClear();
    harness.projection.emit("event", 2, { type: "resync.required" });
    await harness.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(snapshot).not.toHaveBeenCalled();
  });

  it("catalogs enabled root project sessions regardless of activity", async () => {
    const harness = await createHarness();
    const summaries = [
      { ...summary("running"), state: "running" },
      summary("idle"),
      { ...summary("completed-read"), state: "completed" },
      summary("disabled"),
      { ...summary("archived"), state: "running", archived: true },
      {
        ...summary("subagent"),
        state: "running",
        relation: {
          kind: "subagent",
          sessionId: "subagent-session",
          parentThreadId: "running",
          nickname: null,
          role: null,
        },
      },
      summary("managed-parent"),
      summary("foreign-binding"),
      { ...summary("missing-project"), projectId: null },
    ] satisfies ThreadSummary[];
    for (const thread of summaries) harness.projection.summaries.set(thread.id, thread);
    await harness.store.update((state) => {
      for (const thread of summaries) {
        if (thread.id === "disabled") continue;
        state.threadMeta[thread.id] = {
          pinned: false,
          lastReadUpdatedAt: 0,
          browserEnabled: true,
        };
      }
      state.threadMeta["managed-parent"] = {
        pinned: false,
        lastReadUpdatedAt: 0,
        browserEnabled: true,
        managedParent: { parentThreadId: "parent", taskId: "task" },
      };
      state.threadMeta["foreign-binding"] = {
        pinned: false,
        lastReadUpdatedAt: 0,
        browserEnabled: true,
        browserBinding: {
          bindingId: "foreign-binding-id",
          instanceId: "extension-instance-2",
          attachedAt: 1,
        },
      };
      state.threadMeta["detached-binding"] = {
        pinned: false,
        lastReadUpdatedAt: 0,
        browserEnabled: true,
        browserBinding: {
          bindingId: "detached-binding-id",
          instanceId: "extension-instance-2",
          attachedAt: 1,
          detachedAt: 2,
        },
      };
    });
    harness.projection.summaries.set("detached-binding", summary("detached-binding"));

    const extension = await connect(harness.app, "extension-instance-1");
    const hello = await extension.nextType("server.hello");

    expect(hello.threads.map((thread) => thread.id)).toEqual([
      "running",
      "idle",
      "completed-read",
      "detached-binding",
    ]);
    expect(hello.projects.map((project) => project.id)).toEqual(["project"]);

    extension.socket.close();
    await harness.close();
  });

  it("rejects creation and attaches, detaches, reconnects, and preserves ownership", async () => {
    const harness = await createHarness();
    harness.projection.summaries.set("thread", summary("thread"));
    const first = await connect(harness.app, "extension-instance-1");
    expect((await first.next()).type).toBe("server.hello");

    first.socket.send(
      JSON.stringify({
        type: "session.request",
        requestId: "create-1",
        target: { kind: "new", projectId: "project" },
        tab: tabSummary(),
      }),
    );
    expect(await first.nextType("session.error")).toMatchObject({
      requestId: "create-1",
      error: { code: "unsupported", message: expect.stringContaining("no longer supported") },
    });

    await harness.browser.enableThread("thread");
    expect(harness.status("thread")).toBe("disconnected");
    first.socket.send(
      JSON.stringify({
        type: "session.request",
        requestId: "attach-1",
        target: { kind: "existing", threadId: "thread" },
        tab: tabSummary(),
      }),
    );
    expect(await first.nextType("session.result")).toMatchObject({ action: "attached" });
    const attachedBinding = bindingSummary("thread");
    first.socket.send(JSON.stringify({ type: "binding.updated", binding: attachedBinding }));
    await vi.waitFor(() => expect(harness.status("thread")).toBe("connected"));
    const originalBindingId = harness.store.view().threadMeta.thread?.browserBinding?.bindingId;

    const other = await connect(harness.app, "extension-instance-2");
    expect((await other.nextType("server.hello")).threads).toEqual([]);
    other.socket.send(
      JSON.stringify({
        type: "session.request",
        requestId: "attach-active",
        target: { kind: "existing", threadId: "thread" },
        tab: tabSummary(2),
      }),
    );
    expect(await other.nextType("session.error")).toMatchObject({
      error: { code: "owned_by_another_instance" },
    });

    first.socket.send(
      JSON.stringify({
        type: "binding.detached",
        binding: attachedBinding,
      }),
    );
    await vi.waitFor(() =>
      expect(harness.store.view().threadMeta.thread?.browserBinding?.detachedAt).toEqual(
        expect.any(Number),
      ),
    );
    expect(harness.store.view().threadMeta.thread?.browserEnabled).toBe(true);
    expect(harness.status("thread")).toBe("disconnected");
    harness.projection.emit("event", 2, {
      type: "thread.upserted",
      thread: harness.projection.summary("thread")!,
    });

    expect((await other.nextType("catalog.updated")).threads.map((thread) => thread.id)).toEqual([
      "thread",
    ]);
    first.socket.send(
      JSON.stringify({
        type: "session.request",
        requestId: "reattach-owner",
        target: { kind: "existing", threadId: "thread" },
        tab: tabSummary(),
      }),
    );
    expect(await first.nextType("session.result")).toMatchObject({ action: "attached" });
    expect(harness.store.view().threadMeta.thread?.browserBinding?.bindingId).toBe(
      originalBindingId,
    );
    first.socket.send(JSON.stringify({ type: "binding.updated", binding: attachedBinding }));
    await vi.waitFor(() => expect(harness.status("thread")).toBe("connected"));
    expect(harness.store.view().threadMeta.thread?.browserBinding?.detachedAt).toBeUndefined();

    first.socket.send(JSON.stringify({ type: "binding.detached", binding: attachedBinding }));
    await vi.waitFor(() =>
      expect(harness.store.view().threadMeta.thread?.browserBinding?.detachedAt).toEqual(
        expect.any(Number),
      ),
    );
    harness.projection.emit("event", 3, {
      type: "thread.upserted",
      thread: harness.projection.summary("thread")!,
    });
    await other.nextType("catalog.updated");
    other.socket.send(
      JSON.stringify({
        type: "session.request",
        requestId: "attach-other",
        target: { kind: "existing", threadId: "thread" },
        tab: tabSummary(2),
      }),
    );
    expect(await other.nextType("session.result")).toMatchObject({ action: "attached" });
    expect(harness.store.view().threadMeta.thread?.browserBinding).toMatchObject({
      instanceId: "extension-instance-2",
    });
    expect(harness.store.view().threadMeta.thread?.browserBinding?.bindingId).not.toBe(
      originalBindingId,
    );
    expect(await first.nextType("binding.detach")).toMatchObject({ threadId: "thread" });
    const oldBindingResponse = await harness.mcp(originalBindingId!, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(oldBindingResponse.json()).toMatchObject({
      error: { message: "Browser binding not found" },
    });
    first.socket.send(
      JSON.stringify({
        type: "session.request",
        requestId: "reattach-old-owner",
        target: { kind: "existing", threadId: "thread" },
        tab: tabSummary(),
      }),
    );
    expect(await first.nextType("session.error")).toMatchObject({
      error: { code: "owned_by_another_instance" },
    });

    await harness.browser.deleteBinding("thread");
    expect(harness.store.view().threadMeta.thread?.browserBinding).toBeUndefined();
    expect(harness.store.view().threadMeta.thread?.browserEnabled).toBeUndefined();
    expect(harness.status("thread")).toBe("disabled");

    const replaced = closeCode(first.socket);
    const replacement = await connect(harness.app, "extension-instance-1");
    await replacement.next();
    expect(await replaced).toBe(4000);

    replacement.socket.close();
    other.socket.close();
    await harness.close();
  });

  it("denies legacy bindings until explicit enable and detaches stale clients", async () => {
    const harness = await createHarness();
    harness.projection.summaries.set("legacy", summary("legacy"));
    await harness.store.update((state) => {
      state.threadMeta.legacy = {
        pinned: false,
        lastReadUpdatedAt: 0,
        browserBinding: {
          bindingId: "legacy-binding",
          instanceId: "extension-instance-1",
          attachedAt: 1,
        },
      };
    });

    expect(harness.status("legacy")).toBe("disabled");
    expect(harness.browser.runtimeConfig("legacy")).not.toHaveProperty("mcp_servers");
    const extension = await connect(harness.app, "extension-instance-1", [
      bindingSummary("legacy"),
    ]);
    expect((await extension.nextType("server.hello")).threads).toEqual([]);
    expect(await extension.nextType("binding.detach")).toMatchObject({ threadId: "legacy" });

    const unlisted = await harness.mcp("legacy-binding", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(unlisted.json()).toMatchObject({ error: { message: "Browser binding not found" } });
    const denied = await harness.mcp("legacy-binding", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "tabs_context", arguments: {} },
    });
    expect(denied.json()).toMatchObject({ error: { message: "Browser binding not found" } });

    await harness.browser.enableThread("legacy");
    expect(harness.store.view().threadMeta.legacy?.browserEnabled).toBe(true);
    expect(harness.store.view().threadMeta.legacy?.browserBinding).toBeUndefined();
    extension.socket.send(
      JSON.stringify({
        type: "session.request",
        requestId: "fresh-attach",
        target: { kind: "existing", threadId: "legacy" },
        tab: tabSummary(),
      }),
    );
    expect(await extension.nextType("session.result")).toMatchObject({ action: "attached" });
    expect(harness.store.view().threadMeta.legacy?.browserBinding?.bindingId).not.toBe(
      "legacy-binding",
    );

    extension.socket.close();
    await harness.close();
  });

  it("advertises MCP tools, proxies results, and reports unknown outcome after dispatch loss", async () => {
    const harness = await createHarness();
    await harness.store.update((state) => {
      state.threadMeta.thread = {
        pinned: false,
        lastReadUpdatedAt: 0,
        browserEnabled: true,
        browserBinding: {
          bindingId: "binding-1",
          instanceId: "extension-instance-1",
          attachedAt: Date.now(),
        },
      };
    });
    harness.projection.summaries.set("thread", summary("thread"));
    const extension = await connect(harness.app, "extension-instance-1", [
      bindingSummary("thread"),
    ]);
    await extension.next();

    const denied = await harness.app.inject({
      method: "POST",
      url: "/api/v1/internal/browser-mcp/binding-1",
      headers: { "x-codexnest-browser-secret": "wrong" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(denied.statusCode).toBe(403);

    const initialized = await harness.mcp("binding-1", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: {} },
    });
    expect(initialized.json()).toMatchObject({
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "codexnest-browser" },
      },
    });

    const listed = await harness.mcp("binding-1", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect(listed.json().result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      ...BROWSER_TOOL_NAMES,
    ]);

    const pending = harness.mcp("binding-1", {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "navigate", arguments: { url: "https://example.com" } },
    });
    const call = await extension.nextType("tool.call");
    expect(call).toMatchObject({ tool: "navigate", arguments: { url: "https://example.com" } });
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

    const chunked = harness.mcp("binding-1", {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_page_text", arguments: {} },
    });
    const chunkedCall = await extension.nextType("tool.call");
    const chunkedResult = { content: [{ type: "text", text: "x".repeat(100_000) }] };
    const serialized = JSON.stringify(chunkedResult);
    const chunks = serialized.match(/[\s\S]{1,30000}/g) ?? [];
    for (const [chunkIndex, data] of chunks.entries()) {
      extension.socket.send(
        JSON.stringify({
          type: "tool.result.chunk",
          requestId: chunkedCall.requestId,
          chunkIndex,
          chunkCount: chunks.length,
          data,
        }),
      );
    }
    expect((await chunked).json()).toMatchObject({ result: chunkedResult });

    const lost = harness.mcp("binding-1", {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "tabs_create", arguments: {} },
    });
    await extension.nextType("tool.call");
    extension.socket.terminate();
    expect((await lost).json()).toMatchObject({
      result: {
        isError: true,
        content: [{ text: expect.stringContaining("outcome unknown") }],
      },
    });

    await harness.close();
  });

  it("waits only the configured reconnect window before failing an undispatched call", async () => {
    const harness = await createHarness({ disconnectWaitMs: 20 });
    await harness.store.update((state) => {
      state.threadMeta.thread = {
        pinned: false,
        lastReadUpdatedAt: 0,
        browserEnabled: true,
        browserBinding: {
          bindingId: "binding-offline",
          instanceId: "extension-instance-1",
          attachedAt: Date.now(),
        },
      };
    });
    const response = await harness.mcp("binding-offline", {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "tabs_context", arguments: {} },
    });
    expect(response.json()).toMatchObject({
      result: {
        isError: true,
        content: [{ text: expect.stringContaining("disconnected") }],
      },
    });
    await harness.close();
  });

  it("stores protocol-v2 captures and serves exchange and ranged body reads locally", async () => {
    const harness = await createHarness();
    await harness.store.update((state) => {
      state.threadMeta.thread = {
        pinned: false,
        lastReadUpdatedAt: 0,
        browserEnabled: true,
        browserBinding: {
          bindingId: "binding-v2",
          instanceId: "extension-instance-1",
          attachedAt: Date.now(),
        },
      };
    });
    const extension = await connect(
      harness.app,
      "extension-instance-1",
      [bindingSummary("thread")],
      2,
    );
    await extension.nextType("server.hello");
    const requestBody = Buffer.from("captured request");
    const metadata = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        provider: "chrome",
        exchange: {
          exchangeId: "exchange-v2",
          threadId: "thread",
          tabId: 1,
          redirect: {
            chainId: "chain-v2",
            index: 0,
            redirectedFromExchangeId: null,
            redirectedToExchangeId: null,
          },
          request: {
            url: "https://example.com/api",
            method: "POST",
            headers: [],
            timestamp: 10,
            wallTime: null,
            httpVersion: "h2",
            resourceType: "fetch",
            initiator: { type: "script" },
            body: {
              bodyId: "body-v2-request",
              byteLength: requestBody.length,
              sha256: digest(requestBody),
              mediaType: "text/plain",
              encoding: null,
            },
          },
          response: { body: null },
          failure: null,
          startedAt: 10,
          completedAt: 20,
        },
        rawEvents: [{ event: "Network.requestWillBeSent", payload: { providerSpecific: true } }],
      }),
    );
    extension.socket.send(
      JSON.stringify({
        type: "network.capture.start",
        captureId: "capture-v2",
        threadId: "thread",
        tabId: 1,
        exchangeId: "exchange-v2",
        provider: "chrome",
        parts: {
          metadata: { byteLength: metadata.length, sha256: digest(metadata) },
          requestBody: { byteLength: requestBody.length, sha256: digest(requestBody) },
        },
      }),
    );
    extension.socket.send(
      JSON.stringify({
        type: "network.capture.chunk",
        captureId: "capture-v2",
        part: "metadata",
        offset: 0,
        data: metadata.toString("base64"),
      }),
    );
    extension.socket.send(
      JSON.stringify({
        type: "network.capture.chunk",
        captureId: "capture-v2",
        part: "requestBody",
        offset: 0,
        data: requestBody.toString("base64"),
      }),
    );
    extension.socket.send(
      JSON.stringify({ type: "network.capture.commit", captureId: "capture-v2" }),
    );

    const listed = await pollNetworkList(harness, "binding-v2");
    expect(listed).toMatchObject({
      requests: [{ exchangeId: "exchange-v2" }],
      stats: { retained: 1, evicted: 0, dropped: 0 },
    });
    const exchange = mcpText(
      await harness.mcp("binding-v2", {
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: { name: "read_network_request", arguments: { exchangeId: "exchange-v2" } },
      }),
    );
    expect(exchange).toMatchObject({
      metadata: { rawEvents: [{ payload: { providerSpecific: true } }] },
      requestBody: { bodyId: "body-v2-request" },
    });
    const body = mcpText(
      await harness.mcp("binding-v2", {
        jsonrpc: "2.0",
        id: 22,
        method: "tools/call",
        params: {
          name: "read_network_body",
          arguments: { bodyId: "body-v2-request", offset: 2, length: 5 },
        },
      }),
    ) as { data: string };
    expect(Buffer.from(body.data, "base64").toString()).toBe("pture");

    extension.socket.close();
    await harness.close();
  });

  it("drops a capture it cannot store without answering, so the extension stays connected", async () => {
    const harness = await createHarness();
    await harness.store.update((state) => {
      state.threadMeta.thread = {
        pinned: false,
        lastReadUpdatedAt: 0,
        browserEnabled: true,
        browserBinding: {
          bindingId: "binding-v2",
          instanceId: "extension-instance-1",
          attachedAt: Date.now(),
        },
      };
    });
    const extension = await connect(
      harness.app,
      "extension-instance-1",
      [bindingSummary("thread")],
      2,
    );
    await extension.nextType("server.hello");
    const received: string[] = [];
    extension.socket.on("message", (data) =>
      received.push((JSON.parse(data.toString()) as { type: string }).type),
    );

    // Tab 2 is not part of the binding, like a capture still in flight when its tab was detached.
    // The extension never waits for an answer, so the chunk and the commit follow the start.
    const metadata = { byteLength: 2, sha256: "0".repeat(64) };
    for (const frame of [
      {
        type: "network.capture.start",
        threadId: "thread",
        tabId: 2,
        exchangeId: "stale-exchange",
        provider: "chrome",
        parts: { metadata },
      },
      { type: "network.capture.chunk", part: "metadata", offset: 0, data: "e30=" },
      { type: "network.capture.commit" },
    ]) {
      extension.socket.send(JSON.stringify({ captureId: "stale-capture", ...frame }));
    }
    extension.socket.send(JSON.stringify({ type: "client.ping", at: 1 }));
    await extension.nextType("server.pong");
    // Listing waits in the capture store's queue behind the chunk and the commit.
    const listed = await harness.mcp("binding-v2", {
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: { name: "read_network_requests", arguments: { limit: 10 } },
    });
    expect(listed.statusCode).toBe(200);

    // The extension closes its connection on any protocol.error.
    expect(received).not.toContain("protocol.error");
    extension.socket.close();
    await harness.close();
  });

  it("keeps v1 Chrome network fallback and reports update-required for v2-only tools", async () => {
    const harness = await createHarness();
    await harness.store.update((state) => {
      state.threadMeta.thread = {
        pinned: false,
        lastReadUpdatedAt: 0,
        browserEnabled: true,
        browserBinding: {
          bindingId: "binding-v1",
          instanceId: "extension-instance-1",
          attachedAt: Date.now(),
        },
      };
    });
    const socket = await harness.app.injectWS(BROWSER_EXTENSION_WEBSOCKET_PATH, {
      headers: { origin: "http://allowed" },
    });
    const frames = frameReader(socket);
    socket.send(
      JSON.stringify({
        ...helloFrame("extension-instance-1", [bindingSummary("thread")]),
        version: 1,
        capabilities: {
          ...helloFrame("extension-instance-1").capabilities,
          tools: BROWSER_TOOL_NAMES.filter(
            (name) => name !== "read_network_request" && name !== "read_network_body",
          ),
        },
      }),
    );
    await frames.nextType("server.hello");
    const fallback = harness.mcp("binding-v1", {
      jsonrpc: "2.0",
      id: 23,
      method: "tools/call",
      params: { name: "read_network_requests", arguments: {} },
    });
    const call = await frames.nextType("tool.call");
    expect(call.tool).toBe("read_network_requests");
    socket.send(
      JSON.stringify({
        type: "tool.result",
        requestId: call.requestId,
        result: { requests: [{ requestId: "legacy" }] },
      }),
    );
    expect((await fallback).json()).toMatchObject({ result: { content: expect.any(Array) } });
    const updateRequired = await harness.mcp("binding-v1", {
      jsonrpc: "2.0",
      id: 24,
      method: "tools/call",
      params: {
        name: "read_network_request",
        arguments: { exchangeId: "legacy" },
      },
    });
    expect(updateRequired.json()).toMatchObject({
      result: {
        isError: true,
        content: [{ text: expect.stringContaining("protocol v2") }],
      },
    });
    socket.close();
    await harness.close();
  });

  it("validates and streams project files without exposing paths to the extension", async () => {
    const harness = await createHarness();
    const project = join(harness.directory, "project");
    await mkdir(project);
    await writeFile(join(project, "inside.txt"), "browser upload");
    await writeFile(join(harness.directory, "outside.txt"), "private");
    await harness.store.update((state) => {
      state.threadMeta.thread = {
        pinned: false,
        lastReadUpdatedAt: 0,
        browserEnabled: true,
        browserBinding: {
          bindingId: "binding-upload",
          instanceId: "extension-instance-1",
          attachedAt: Date.now(),
        },
      };
    });
    harness.projection.summaries.set("thread", summary("thread", project));
    const extension = await connect(harness.app, "extension-instance-1", [
      bindingSummary("thread"),
    ]);
    await extension.nextType("server.hello");

    const pending = harness.mcp("binding-upload", {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "upload_file", arguments: { ref: "e_1", path: "inside.txt" } },
    });
    const call = await extension.nextType("tool.call");
    expect(call.arguments).toMatchObject({
      ref: "e_1",
      file: {
        kind: "project_file",
        name: "inside.txt",
        mediaType: "text/plain",
        size: 14,
      },
    });
    expect(call.arguments).not.toHaveProperty("path");
    const descriptor = (call.arguments as { file: { transferId: string } }).file;
    extension.socket.send(
      JSON.stringify({ type: "file.request", transferId: descriptor.transferId }),
    );
    const chunk = await extension.nextType("file.transfer");
    expect(Buffer.from(chunk.data, "base64").toString()).toBe("browser upload");
    extension.socket.send(
      JSON.stringify({
        type: "tool.result",
        requestId: call.requestId,
        result: { uploaded: true },
      }),
    );
    expect((await pending).json()).toMatchObject({ result: { content: expect.any(Array) } });

    const escaped = await harness.mcp("binding-upload", {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "upload_file",
        arguments: { ref: "e_1", path: join(harness.directory, "outside.txt") },
      },
    });
    expect(escaped.json()).toMatchObject({
      result: { isError: true, content: [{ text: expect.stringContaining("inside") }] },
    });

    const raced = harness.mcp("binding-upload", {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "upload_file", arguments: { ref: "e_1", path: "inside.txt" } },
    });
    const racedCall = await extension.nextType("tool.call");
    const racedDescriptor = (racedCall.arguments as { file: { transferId: string } }).file;
    await rename(join(project, "inside.txt"), join(project, "inside-original.txt"));
    await symlink(join(harness.directory, "outside.txt"), join(project, "inside.txt"));
    extension.socket.send(
      JSON.stringify({ type: "file.request", transferId: racedDescriptor.transferId }),
    );
    const fileError = await extension.nextType("file.error");
    expect(fileError).toMatchObject({ transferId: racedDescriptor.transferId });
    extension.socket.send(
      JSON.stringify({
        type: "tool.error",
        requestId: racedCall.requestId,
        error: { code: "file_transfer_failed", message: fileError.error },
      }),
    );
    expect((await raced).json()).toMatchObject({ result: { isError: true } });

    extension.socket.close();
    await harness.close();
  });
});

async function createHarness(options: { disconnectWaitMs?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "codexnest-browser-extension-test-"));
  directories.push(directory);
  const store = new StateStore(join(directory, "state.json"));
  await store.load();
  await store.update((state) => {
    state.auth.tokenSha256 = hashToken("correct");
  });
  const app = Fastify({ logger: false });
  await app.register(websocket);
  const projection = new FakeProjection();
  const browser = new BrowserExtensionServer({
    app,
    store,
    projection: projection as unknown as AppProjection,
    allowedOrigins: new Set(["http://allowed"]),
    port: 4310,
    authTimeoutMs: 50,
    heartbeatMs: 10_000,
    disconnectWaitMs: options.disconnectWaitMs,
    internalSecret: "internal-secret",
  });
  browser.setLifecycle({
    enable: async (threadId) => {
      await store.update((state) => {
        const meta = state.threadMeta[threadId] ?? { pinned: false, lastReadUpdatedAt: 0 };
        meta.browserEnabled = true;
        delete meta.browserBinding;
        state.threadMeta[threadId] = meta;
      });
    },
    attach: async (instanceId, threadId, bindingId) => {
      const current = store.view().threadMeta[threadId];
      if (current?.browserEnabled !== true) {
        throw new BrowserExtensionError("not_enabled", "Browser access is not enabled");
      }
      const existing = current.browserBinding;
      if (existing && existing.instanceId !== instanceId && existing.detachedAt === undefined) {
        throw new BrowserExtensionError(
          "owned_by_another_instance",
          "Browser binding belongs to another extension instance",
        );
      }
      await store.update((state) => {
        const meta = state.threadMeta[threadId] ?? { pinned: false, lastReadUpdatedAt: 0 };
        meta.browserBinding = {
          bindingId: existing?.instanceId === instanceId ? existing.bindingId : bindingId,
          instanceId,
          attachedAt: Date.now(),
        };
        state.threadMeta[threadId] = meta;
      });
      return projection.summaries.get(threadId) ?? summary(threadId);
    },
    disable: vi.fn(async (threadId: string) => {
      await store.update((state) => {
        const meta = state.threadMeta[threadId];
        if (meta) {
          delete meta.browserEnabled;
          delete meta.browserBinding;
        }
      });
    }),
  });
  browser.registerRoutes();
  await app.ready();
  return {
    app,
    store,
    projection,
    browser,
    directory,
    status: (threadId: string) => browser.browserStatus(threadId),
    mcp: (bindingId: string, payload: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: `/api/v1/internal/browser-mcp/${bindingId}`,
        headers: { "x-codexnest-browser-secret": "internal-secret" },
        payload,
      }),
    close: () => app.close(),
  };
}

class FakeProjection extends EventEmitter {
  summaries = new Map<string, ThreadSummary>();
  private statusProvider: (threadId: string) => BrowserThreadStatus = () => "disabled";

  setBrowserStatusProvider(provider: (threadId: string) => BrowserThreadStatus): void {
    this.statusProvider = provider;
  }

  setThreadResumeConfigProvider(): void {}

  publishThreadState(threadId: string): void {
    const current = this.summaries.get(threadId);
    if (current) current.browserStatus = this.statusProvider(threadId);
  }

  summary(threadId: string): ThreadSummary | undefined {
    return this.summaries.get(threadId);
  }

  snapshot(): AppSnapshot {
    return {
      sequence: 1,
      uiLanguage: "en",
      connection: { state: "ready", message: null, syncedAt: null },
      projects: [
        {
          id: "project",
          displayName: "Project",
          path: "/work",
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
        },
        {
          id: "unused-project",
          displayName: "Unused",
          path: "/unused",
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
        },
      ],
      threads: [...this.summaries.values()],
      attention: [],
      models: [],
    };
  }
}

function summary(id: string, cwd = "/work"): ThreadSummary {
  return {
    id,
    projectId: "project",
    title: id,
    preview: "",
    cwd,
    state: "idle",
    unread: false,
    unseen: false,
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    currentTurnId: null,
    queuedMessageCount: 0,
    browserStatus: "disconnected",
    settings: { collaborationMode: "default" },
    relation: { kind: "session", sessionId: id },
  };
}

async function connect(
  app: ReturnType<typeof Fastify>,
  instanceId: string,
  bindings: BrowserExtensionBindingSummary[] = [],
  version = BROWSER_EXTENSION_PROTOCOL_VERSION,
) {
  const socket = await app.injectWS(BROWSER_EXTENSION_WEBSOCKET_PATH, {
    headers: { origin: "http://allowed" },
  });
  const frames = frameReader(socket);
  socket.send(
    JSON.stringify({
      ...helloFrame(instanceId, bindings),
      version,
      browser: { name: "chrome", version: "128" },
    }),
  );
  return { socket, ...frames };
}

function helloFrame(instanceId: string, bindings: BrowserExtensionBindingSummary[] = []) {
  return {
    type: "client.hello",
    protocol: BROWSER_EXTENSION_PROTOCOL,
    version: BROWSER_EXTENSION_PROTOCOL_VERSION,
    token: "correct",
    instanceId,
    extensionVersion: "0.1.6",
    browser: { name: "chrome", version: "128" },
    capabilities: {
      tools: BROWSER_TOOL_NAMES,
      maxProjectFileBytes: 100 * 1024 * 1024,
      screenshots: ["image/jpeg", "image/png"],
    },
    bindings,
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

function tabSummary(id = 1) {
  return {
    id,
    windowId: 1,
    groupId: -1,
    active: true,
    title: "Tab",
    url: "https://example.com",
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
    next,
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

async function pollNetworkList(
  harness: Awaited<ReturnType<typeof createHarness>>,
  bindingId: string,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await harness.mcp(bindingId, {
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: { name: "read_network_requests", arguments: { limit: 10 } },
    });
    const value = mcpText(response) as { requests?: unknown[] };
    if (value.requests?.length) return value as Record<string, unknown>;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the committed network capture");
}

function mcpText(response: { json(): unknown }): unknown {
  const payload = response.json() as {
    result?: { content?: Array<{ type?: string; text?: string }> };
  };
  const text = payload.result?.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("Expected an MCP text result");
  return JSON.parse(text);
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
