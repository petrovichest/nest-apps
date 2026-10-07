import { describe, expect, it } from "vitest";

import type {
  ActivityItem,
  CanonicalBrowserNetworkExchange,
  ForkOperationDetailResponse,
  ThreadArtifactsResponse,
  ThreadSummary,
  UpdateUserInputDraftRequest,
  UpdateThreadRequest,
  UserInputDraft,
} from "./index.js";
import {
  BROWSER_EXTENSION_PROTOCOL,
  BROWSER_EXTENSION_PROTOCOL_VERSION,
  BROWSER_EXTENSION_PROTOCOL_VERSION_V1,
  BROWSER_EXTENSION_PROTOCOL_VERSION_V2,
  BROWSER_MAX_NETWORK_BODY_BYTES,
  BROWSER_NETWORK_CAPTURE_CHUNK_BYTES,
  BROWSER_TOOL_RESULT_CHUNK_BYTES,
  BROWSER_TOOL_NAMES,
  bearerHeader,
  fastServiceTier,
  isFastServiceTier,
  mergeProjectDraft,
  isActiveFeedEligible,
  isBrowserExtensionClientFrame,
  isBrowserExtensionServerFrame,
  isClientFrame,
  isServerFrame,
} from "./index.js";

describe("Fast service tiers", () => {
  it.each(["fast", "priority"])("recognizes the %s alias", (tier) => {
    expect(isFastServiceTier(tier)).toBe(true);
  });

  it.each([undefined, null, "", "auto", "standard", 1])("does not enable Fast for %j", (tier) => {
    expect(isFastServiceTier(tier)).toBe(false);
  });

  it.each([
    { tiers: ["fast", "priority"], expected: "priority" },
    { tiers: ["fast"], expected: "fast" },
    { tiers: ["standard"], expected: null },
    { tiers: [], expected: null },
  ])("resolves advertised tiers $tiers to $expected", ({ tiers, expected }) => {
    expect(fastServiceTier({ serviceTiers: tiers.map((id) => ({ id, displayName: id })) })).toBe(
      expected,
    );
  });

  it("treats an absent model as unsupported", () => {
    expect(fastServiceTier(undefined)).toBeNull();
  });
});

const activeFeedThread: ThreadSummary = {
  id: "thread",
  projectId: "project",
  title: "Thread",
  preview: "",
  cwd: "/work",
  state: "idle",
  unread: false,
  unseen: false,
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  currentTurnId: null,
  queuedMessageCount: 0,
  browserStatus: "disabled",
  settings: { collaborationMode: "default" },
  relation: { kind: "session", sessionId: "session" },
};

describe("active feed eligibility", () => {
  it.each([
    { name: "running", overrides: { state: "running" }, eligible: true },
    { name: "queued", overrides: { state: "queued" }, eligible: true },
    { name: "needs attention", overrides: { state: "needsAttention" }, eligible: true },
    {
      name: "queued message on an idle session",
      overrides: { queuedMessageCount: 1 },
      eligible: true,
    },
    {
      name: "unread completion",
      overrides: { state: "completed", unread: true },
      eligible: true,
    },
    {
      name: "unread failure",
      overrides: { state: "failed", unread: true },
      eligible: true,
    },
    {
      name: "unread interruption",
      overrides: { state: "interrupted", unread: true },
      eligible: true,
    },
    { name: "idle", overrides: {}, eligible: false },
    { name: "unavailable", overrides: { state: "unavailable" }, eligible: false },
    { name: "read completion", overrides: { state: "completed" }, eligible: false },
    { name: "read failure", overrides: { state: "failed" }, eligible: false },
    { name: "read interruption", overrides: { state: "interrupted" }, eligible: false },
    {
      name: "archived active session",
      overrides: { state: "running", queuedMessageCount: 1, unread: true, archived: true },
      eligible: false,
    },
  ] satisfies Array<{
    name: string;
    overrides: Partial<ThreadSummary>;
    eligible: boolean;
  }>)("returns $eligible for $name", ({ overrides, eligible }) => {
    expect(isActiveFeedEligible({ ...activeFeedThread, ...overrides })).toBe(eligible);
  });
});

describe("protocol guards", () => {
  it("types fork-operation reload details as one pending-state response", () => {
    const detail: ForkOperationDetailResponse = {
      operation: {
        id: "operation",
        sourceThreadId: "source",
        lastTurnId: "turn",
        agentMessageId: "answer",
        mode: "compressed",
        status: "preparing",
        title: "Ответвление: Source",
        createdAt: 1,
        updatedAt: 1,
        targetThreadId: null,
        queuedMessageCount: 1,
        estimate: null,
        error: null,
      },
      queuedMessages: [
        {
          id: "queued",
          threadId: "operation",
          text: "Continue",
          createdAt: 1,
          status: "queued",
        },
      ],
      draft: {
        input: "Draft",
        images: [],
        goalMode: false,
        annotations: [],
        updatedAt: 1,
      },
    };
    expect(detail.operation.queuedMessageCount).toBe(detail.queuedMessages.length);
  });

  it("publishes the user-input draft snapshot types", () => {
    const update: UpdateUserInputDraftRequest = {
      answers: { choice: ["Yes"] },
      currentQuestionId: "choice",
    };
    const saved: UserInputDraft = { ...update, revision: 2, updatedAt: 123 };
    expect(saved).toEqual({
      answers: { choice: ["Yes"] },
      currentQuestionId: "choice",
      revision: 2,
      updatedAt: 123,
    });
  });

  it("carries browser opt-in on thread updates", () => {
    const update: UpdateThreadRequest = { browserEnabled: true };
    expect(update).toEqual({ browserEnabled: true });
  });

  it("accepts authentication and ping client frames", () => {
    expect(isClientFrame({ type: "authenticate", token: "secret" })).toBe(true);
    expect(isClientFrame({ type: "ping" })).toBe(true);
  });

  it("rejects malformed client frames", () => {
    expect(isClientFrame({ type: "authenticate", token: "" })).toBe(false);
    expect(isClientFrame({ type: "other" })).toBe(false);
  });

  it("recognizes server frames", () => {
    expect(isServerFrame({ type: "pong" })).toBe(true);
    expect(
      isServerFrame({
        type: "event",
        sequence: 1,
        version: { instanceId: "server", sequence: 1 },
        event: { type: "resync.required" },
      }),
    ).toBe(true);
    expect(isServerFrame({ type: "event", sequence: 1, event: { type: "resync.required" } })).toBe(
      true,
    );
    expect(
      isServerFrame({
        type: "event",
        sequence: 2,
        version: { instanceId: "server", sequence: 2 },
        event: { type: "projects.reordered", projects: [] },
      }),
    ).toBe(true);
    expect(
      isServerFrame({
        type: "event",
        sequence: 3,
        version: { instanceId: "server", sequence: 3 },
        event: { type: "skills.changed" },
      }),
    ).toBe(true);
    expect(
      isServerFrame({
        type: "event",
        sequence: 2,
        version: { instanceId: "server", sequence: 3 },
        event: { type: "skills.changed" },
      }),
    ).toBe(false);
    expect(isServerFrame({ type: "event", sequence: -1, event: { type: "resync.required" } })).toBe(
      false,
    );
  });

  it("formats bearer credentials without putting them in a URL", () => {
    expect(bearerHeader("abc")).toBe("Bearer abc");
  });

  it("guards the versioned browser-extension handshake and lifecycle requests", () => {
    expect(
      isBrowserExtensionClientFrame({
        type: "client.hello",
        protocol: BROWSER_EXTENSION_PROTOCOL,
        version: BROWSER_EXTENSION_PROTOCOL_VERSION,
        token: "owner-token",
        instanceId: "extension-instance-1",
        extensionVersion: "0.1.6",
        browser: { name: "chrome", version: "128" },
        capabilities: {
          tools: BROWSER_TOOL_NAMES,
          maxProjectFileBytes: 100,
          screenshots: ["image/jpeg"],
        },
        bindings: [],
      }),
    ).toBe(true);
    expect(
      isBrowserExtensionClientFrame({
        type: "client.hello",
        protocol: BROWSER_EXTENSION_PROTOCOL,
        version: BROWSER_EXTENSION_PROTOCOL_VERSION_V1,
        token: "owner-token",
        instanceId: "extension-instance-v1",
        extensionVersion: "0.1.6",
        browser: { name: "chrome", version: "128" },
        capabilities: { tools: BROWSER_TOOL_NAMES, maxProjectFileBytes: 100, screenshots: [] },
        bindings: [],
      }),
    ).toBe(true);
    expect(
      isBrowserExtensionClientFrame({
        type: "client.hello",
        protocol: BROWSER_EXTENSION_PROTOCOL,
        version: BROWSER_EXTENSION_PROTOCOL_VERSION_V2,
        token: "owner-token",
        instanceId: "extension-instance-firefox",
        extensionVersion: "0.2.0",
        browser: { name: "firefox", version: "130" },
        capabilities: { tools: BROWSER_TOOL_NAMES, maxProjectFileBytes: 100, screenshots: [] },
        bindings: [],
      }),
    ).toBe(false);
    expect(
      isBrowserExtensionClientFrame({
        type: "session.request",
        requestId: "request-1",
        target: { kind: "new", projectId: "project-1" },
        tab: { id: 1, windowId: 1, groupId: -1, active: true, title: "Tab", url: "https://x" },
      }),
    ).toBe(true);
    expect(
      isBrowserExtensionClientFrame({
        type: "session.request",
        requestId: "request-2",
        target: { kind: "existing", threadId: "thread-1" },
        tab: { id: 1, windowId: 1, groupId: -1, active: true, title: "Tab", url: "https://x" },
      }),
    ).toBe(true);
    expect(
      isBrowserExtensionClientFrame({
        type: "client.hello",
        protocol: BROWSER_EXTENSION_PROTOCOL,
        version: 1,
        token: "owner-token",
        instanceId: "spaces are rejected",
        extensionVersion: "0.1.6",
        browser: { name: "chrome", version: "128" },
        capabilities: { tools: [], maxProjectFileBytes: 100, screenshots: [] },
        bindings: [],
      }),
    ).toBe(false);
  });

  it("guards browser binding updates and tool calls", () => {
    expect(BROWSER_TOOL_NAMES).toContain("tabs_context");
    expect(BROWSER_TOOL_NAMES).toContain("upload_file");
    expect(BROWSER_TOOL_NAMES).toContain("read_network_request");
    expect(BROWSER_TOOL_NAMES).toContain("read_network_body");
    expect(
      isBrowserExtensionServerFrame({
        type: "server.hello",
        protocol: BROWSER_EXTENSION_PROTOCOL,
        version: BROWSER_EXTENSION_PROTOCOL_VERSION,
        locale: "en",
        projects: [],
        threads: [],
      }),
    ).toBe(true);
    expect(
      isBrowserExtensionServerFrame({
        type: "server.hello",
        protocol: BROWSER_EXTENSION_PROTOCOL,
        version: BROWSER_EXTENSION_PROTOCOL_VERSION_V1,
        locale: "en",
        projects: [],
        threads: [],
      }),
    ).toBe(true);
    expect(
      isBrowserExtensionServerFrame({
        type: "tool.call",
        requestId: "call-1",
        threadId: "thread-1",
        tool: "navigate",
        arguments: { url: "https://example.com" },
      }),
    ).toBe(true);
    expect(
      isBrowserExtensionServerFrame({
        type: "tool.call",
        requestId: "call-1",
        threadId: "thread-1",
        tool: "steal_credentials",
        arguments: {},
      }),
    ).toBe(false);
    expect(
      isBrowserExtensionClientFrame({
        type: "tool.result.chunk",
        requestId: "call-1",
        chunkIndex: 0,
        chunkCount: 2,
        data: "partial",
      }),
    ).toBe(true);
    expect(
      isBrowserExtensionClientFrame({
        type: "tool.result.chunk",
        requestId: "call-1",
        chunkIndex: 0,
        chunkCount: 2,
        data: "x".repeat(BROWSER_TOOL_RESULT_CHUNK_BYTES + 1),
      }),
    ).toBe(false);
  });

  it("accepts declared capture streams independently of the MCP result cap", () => {
    const sha256 = "a".repeat(64);
    expect(
      isBrowserExtensionClientFrame({
        type: "network.capture.start",
        captureId: "capture-1",
        threadId: "thread-1",
        tabId: 9,
        exchangeId: "exchange-1",
        provider: "chrome",
        parts: {
          metadata: { byteLength: 12_000, sha256 },
          requestBody: { byteLength: 0, sha256 },
          responseBody: { byteLength: BROWSER_MAX_NETWORK_BODY_BYTES, sha256 },
        },
      }),
    ).toBe(true);
    expect(
      isBrowserExtensionClientFrame({
        type: "network.capture.chunk",
        captureId: "capture-1",
        part: "responseBody",
        offset: BROWSER_MAX_NETWORK_BODY_BYTES - 1,
        data: "AA==",
      }),
    ).toBe(true);
    expect(
      isBrowserExtensionClientFrame({ type: "network.capture.commit", captureId: "capture-1" }),
    ).toBe(true);
    expect(
      isBrowserExtensionClientFrame({
        type: "network.capture.abort",
        captureId: "capture-1",
        reason: "tab closed",
      }),
    ).toBe(true);
  });

  it.each([
    {
      name: "negative offset",
      frame: {
        type: "network.capture.chunk",
        captureId: "capture-1",
        part: "metadata",
        offset: -1,
        data: "e30=",
      },
    },
    {
      name: "unknown part",
      frame: {
        type: "network.capture.chunk",
        captureId: "capture-1",
        part: "headers",
        offset: 0,
        data: "e30=",
      },
    },
    {
      name: "malformed base64",
      frame: {
        type: "network.capture.chunk",
        captureId: "capture-1",
        part: "metadata",
        offset: 0,
        data: "not base64",
      },
    },
    {
      name: "oversized websocket chunk",
      frame: {
        type: "network.capture.chunk",
        captureId: "capture-1",
        part: "metadata",
        offset: 0,
        data: "A".repeat(BROWSER_NETWORK_CAPTURE_CHUNK_BYTES + 4),
      },
    },
    {
      name: "chunk beyond maximum body",
      frame: {
        type: "network.capture.chunk",
        captureId: "capture-1",
        part: "responseBody",
        offset: BROWSER_MAX_NETWORK_BODY_BYTES,
        data: "AA==",
      },
    },
  ])("rejects malformed capture chunks: $name", ({ frame }) => {
    expect(isBrowserExtensionClientFrame(frame)).toBe(false);
  });

  it("types a canonical exchange with separate redirect hops and untouched raw events", () => {
    const exchange: CanonicalBrowserNetworkExchange = {
      schemaVersion: 1,
      provider: "chrome",
      exchange: {
        exchangeId: "exchange-2",
        threadId: "thread-1",
        tabId: 3,
        redirect: {
          chainId: "redirect-chain-1",
          index: 1,
          redirectedFromExchangeId: "exchange-1",
          redirectedToExchangeId: null,
        },
        request: {
          url: "https://example.com/final",
          method: "POST",
          headers: [{ name: "content-type", value: "application/json" }],
          timestamp: 1,
          wallTime: 2,
          httpVersion: "h2",
          resourceType: "fetch",
          initiator: { type: "script" },
          body: {
            bodyId: "opaque-request-body",
            byteLength: 2,
            sha256: "a".repeat(64),
            mediaType: "application/json",
            encoding: "identity",
          },
        },
        response: null,
        failure: {
          timestamp: 3,
          errorText: "connection reset",
          canceled: false,
          blockedReason: null,
        },
        startedAt: 1,
        completedAt: 3,
      },
      rawEvents: [
        {
          event: "Network.requestWillBeSent",
          payload: { requestId: "provider-id", futureProviderField: { nested: true } },
          providerSequence: 17,
        },
      ],
    };
    expect(exchange.rawEvents[0]?.payload).toHaveProperty("futureProviderField");
    expect(exchange.exchange.redirect.index).toBe(1);
  });

  it("keeps v1 orchestration notices valid while carrying optional v2 results", () => {
    const v1 = {
      type: "orchestrationNotice",
      id: "v1",
      status: "completed",
      agents: [
        {
          threadId: "child-v1",
          title: "Legacy child",
          nickname: null,
          outcome: "completed",
        },
      ],
      timestamp: 1,
      afterItemId: null,
    } satisfies ActivityItem;
    const v2 = {
      type: "orchestrationNotice",
      id: "v2",
      status: "completed",
      agents: [
        {
          threadId: "child-v2",
          taskId: "task-v2",
          title: "Rich child",
          nickname: "reviewer",
          outcome: "completed",
          result: {
            outcome: "partial",
            summary: "Implemented the focused change.",
            checks: [{ name: "client tests", outcome: "passed", details: "12 passed" }],
          },
          budgetReason: "tokenBudget",
          changedPaths: ["apps/client/src/components/ThreadPage.tsx"],
          changedPathCount: 24,
          workspaceIntegrationStatus: "integrated",
        },
      ],
      timestamp: 2,
      afterItemId: "continuation",
    } satisfies ActivityItem;

    expect(v1.agents[0]).not.toHaveProperty("result");
    expect(v2.agents[0]!.result).toMatchObject({ outcome: "partial" });
  });

  it("exposes explicit and unavailable artifact capability responses", () => {
    const explicit = {
      capability: "explicit",
      artifacts: [
        {
          id: "artifact-id",
          label: "Final report",
          path: "/work/deliverables/report.txt",
          relativePath: "deliverables/report.txt",
          fileName: "report.txt",
          turnId: "turn-1",
          createdAt: 1,
        },
      ],
    } satisfies ThreadArtifactsResponse;
    const unavailable = {
      capability: "unavailable",
      artifacts: [],
    } satisfies ThreadArtifactsResponse;
    expect(explicit.artifacts[0]?.label).toBe("Final report");
    expect(unavailable.artifacts).toEqual([]);
  });
});

describe("shared project draft edits", () => {
  const empty = { input: "", images: [], goalMode: false, annotations: [] };
  const one = { id: "one", name: "one.png", url: "data:image/png;base64,b25l" };
  const two = { id: "two", name: "two.png", url: "data:image/png;base64,dHdv" };

  it("keeps pasted text coherent while merging attachments from another device", () => {
    const remote = {
      ...empty,
      input: "Read [Paste #1]",
      pasteBlocks: [{ id: "log", text: "long log" }],
      images: [one],
    };
    const merged = mergeProjectDraft(remote, empty, { ...empty, images: [two] });
    expect(merged).toMatchObject({
      input: remote.input,
      pasteBlocks: remote.pasteBlocks,
      images: [one, two],
    });
    expect(mergeProjectDraft(merged, { ...empty, images: [one] }, empty).images).toEqual([two]);
  });

  it("keeps a cleared draft empty when a stale editor adds only an image", () => {
    const old = { ...empty, input: "Already sent", images: [one] };
    expect(mergeProjectDraft(empty, old, { ...old, images: [one, two] })).toMatchObject({
      input: "",
      images: [two],
    });
  });
});
