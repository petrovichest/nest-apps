import { afterEach, describe, expect, it, vi } from "vitest";

import type { ThreadDraft, UpdateThreadDraftRequest } from "@codexnest/protocol";

import { ApiClient } from "./api";

describe("ApiClient", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("uses authenticated Claude account management endpoints and encodes account/login identifiers", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(
        async () => new Response("{}", { headers: { "Content-Type": "application/json" } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient({ baseUrl: "https://claudenest.example", token: "token" });
    const proxy = {
      enabled: true,
      protocol: "socks5" as const,
      value: "socks5h://user:secret@proxy.example:1080",
    };
    await api.readClaudeAccounts();
    await api.refreshClaudeAccounts("account/id");
    await api.updateClaudeAutoSwitch(false);
    await api.selectClaudeAccount("account/id");
    await api.removeClaudeAccount("account/id");
    await api.updateClaudeAccountProxy("account/id", proxy);
    await api.testClaudeProxy(proxy);
    await api.startClaudeLogin({ proxy });
    await api.startClaudeLogin({ accountId: "account/id" });
    await api.readClaudeLogin("login/id");
    await api.submitClaudeLoginCode("login/id", "complete-code#state");
    await api.cancelClaudeLogin("login/id");

    expect(fetchMock.mock.calls.map(([url, init]) => [url.pathname, init.method])).toEqual([
      ["/api/v1/settings/claude", "GET"],
      ["/api/v1/settings/claude/refresh", "POST"],
      ["/api/v1/settings/claude", "PATCH"],
      ["/api/v1/settings/claude/accounts/account%2Fid/select", "POST"],
      ["/api/v1/settings/claude/accounts/account%2Fid", "DELETE"],
      ["/api/v1/settings/claude/accounts/account%2Fid", "PATCH"],
      ["/api/v1/settings/claude/proxy/test", "POST"],
      ["/api/v1/settings/claude/logins", "POST"],
      ["/api/v1/settings/claude/logins", "POST"],
      ["/api/v1/settings/claude/logins/login%2Fid", "GET"],
      ["/api/v1/settings/claude/logins/login%2Fid/code", "POST"],
      ["/api/v1/settings/claude/logins/login%2Fid", "DELETE"],
    ]);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(init.headers.get("Authorization")).toBe("Bearer token");
      expect(url.search).toBe("");
    }
    expect(JSON.parse(fetchMock.mock.calls[5][1].body)).toEqual({ proxy });
    expect(JSON.parse(fetchMock.mock.calls[8][1].body)).toEqual({ accountId: "account/id" });
    expect(JSON.parse(fetchMock.mock.calls[10][1].body)).toEqual({ code: "complete-code#state" });
  });

  it("lists and updates skills for an encoded workspace", async () => {
    const catalog = { cwd: "/work/one two", skills: [], errors: [] };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(catalog), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ path: "/skill/SKILL.md", enabled: false }), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient({ baseUrl: "https://codexnest.example", token: "token" });

    await expect(api.listSkills("/work/one two")).resolves.toEqual(catalog);
    await expect(
      api.updateSkillConfig({
        cwd: "/work/one two",
        path: "/skill/SKILL.md",
        enabled: false,
      }),
    ).resolves.toEqual({ path: "/skill/SKILL.md", enabled: false });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      new URL("https://codexnest.example/api/v1/skills?cwd=%2Fwork%2Fone+two&forceReload=false"),
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      new URL("https://codexnest.example/api/v1/skills/config"),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          cwd: "/work/one two",
          path: "/skill/SKILL.md",
          enabled: false,
        }),
      }),
    );
  });

  it("uses keepalive only for small project draft writes during page exit", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient({ baseUrl: "https://codexnest.example", token: "token" });
    const empty = { input: "", images: [], annotations: [], goalMode: false };
    await api.updateProjectDraft("project", empty, { ...empty, input: "Текст" });
    expect(fetchMock.mock.calls.at(-1)?.[1].keepalive).toBe(false);
    await api.updateProjectDraft(
      "project",
      empty,
      { ...empty, input: "Текст" },
      { keepalive: true },
    );
    expect(fetchMock.mock.calls.at(-1)?.[1].keepalive).toBe(true);
    await api.updateProjectDraft(
      "project",
      empty,
      { ...empty, input: "я".repeat(40_000) },
      { keepalive: true },
    );
    expect(fetchMock.mock.calls.at(-1)?.[1].keepalive).toBe(false);
    await api.updateProjectDraft(
      "project",
      empty,
      {
        ...empty,
        images: [
          { id: "image", name: "image.png", url: `data:image/png;base64,${"a".repeat(100_000)}` },
        ],
      },
      { keepalive: true },
    );
    expect(fetchMock.mock.calls.at(-1)?.[1].keepalive).toBe(false);
  });

  it("does not send the server-only draft timestamp back to the draft endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient({ baseUrl: "https://codexnest.example", token: "token" });
    const restoredDraft: ThreadDraft = {
      input: "Текст",
      images: [],
      goalMode: false,
      annotations: [],
      updatedAt: 123,
    };

    await api.updateThreadDraft("thread", restoredDraft, { expectedUpdatedAt: 123 });

    expect(fetchMock.mock.calls[0]?.[0]).toEqual(
      new URL("https://codexnest.example/api/v1/threads/thread/draft?expectedUpdatedAt=123"),
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      input: "Текст",
      images: [],
      goalMode: false,
      annotations: [],
    });
  });

  const emptyDraft: UpdateThreadDraftRequest = {
    input: "",
    images: [],
    annotations: [],
    goalMode: false,
  };
  const imageDraft: UpdateThreadDraftRequest = {
    ...emptyDraft,
    input: "Текст с тремя фото",
    images: Array.from({ length: 3 }, (_, index) => ({
      id: `image-${index}`,
      name: `photo-${index}.png`,
      url: `data:image/png;base64,${index}AA=`,
    })),
  };
  const imageMessage = {
    input: imageDraft.input,
    clientMessageId: "stable-message",
    images: imageDraft.images.map((image) => image.url),
  };
  const imageUploads: Array<[string, (api: ApiClient) => Promise<unknown>]> = [
    ["project draft", (api) => api.updateProjectDraft("project", emptyDraft, imageDraft)],
    ["removing project images", (api) => api.updateProjectDraft("project", imageDraft, emptyDraft)],
    [
      "creation with attachments",
      (api) => api.createProjectThread("project", "stable-creation", imageDraft),
    ],
    ["thread draft", (api) => api.updateThreadDraft("thread", imageDraft)],
    ["thread queue", (api) => api.enqueue("thread", imageMessage)],
    ["fork draft", (api) => api.updateForkOperationDraft("fork", imageDraft)],
    ["fork queue", (api) => api.enqueueForkOperation("fork", imageMessage)],
  ];

  it.each(imageUploads)("allows a slow %s image upload to finish once", async (_label, send) => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn(
      (_url: URL, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          finish = resolve;
          init.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Upload aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient({ baseUrl: "https://codexnest.example", token: "token" });
    const request = send(api);
    const result = expect(request).resolves.toBeUndefined();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledOnce();
    const sent = fetchMock.mock.calls[0]![1];
    expect(sent.signal?.aborted).toBe(false);
    for (const image of imageDraft.images) expect(String(sent.body)).toContain(image.url);
    finish(new Response(null, { status: 204 }));
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  const textWrites: Array<[string, (api: ApiClient) => Promise<unknown>]> = [
    [
      "project draft",
      (api) => api.updateProjectDraft("project", emptyDraft, { ...emptyDraft, input: "text" }),
    ],
    ["thread draft", (api) => api.updateThreadDraft("thread", { ...emptyDraft, input: "text" })],
    ["thread queue", (api) => api.enqueue("thread", { input: "text", clientMessageId: "message" })],
    ["fork draft", (api) => api.updateForkOperationDraft("fork", { ...emptyDraft, input: "text" })],
    [
      "fork queue",
      (api) => api.enqueueForkOperation("fork", { input: "text", clientMessageId: "message" }),
    ],
  ];
  it.each(textWrites)(
    "keeps the 15-second timeout for a %s without images",
    async (_label, send) => {
      vi.useFakeTimers();
      const fetchMock = vi.fn(
        (_url: URL, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Request aborted", "AbortError")),
              { once: true },
            );
          }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const request = send(new ApiClient({ baseUrl: "https://codexnest.example", token: "token" }));
      const failure = expect(request).rejects.toMatchObject({ code: "connection_failed" });
      await vi.advanceTimersByTimeAsync(14_999);
      expect(fetchMock.mock.calls[0]![1].signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await failure;
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("cancels a voice transcription without deleting its thread", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient({ baseUrl: "https://codexnest.example", token: "token" });

    await api.cancelVoiceTranscription("thread/id");

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://codexnest.example/api/v1/threads/thread%2Fid/voice-transcriptions"),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("reads semantic artifacts for an encoded thread without caching", async () => {
    const response = { capability: "explicit", artifacts: [] };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient({ baseUrl: "https://codexnest.example", token: "token" });

    await expect(api.readThreadArtifacts("thread/id")).resolves.toEqual(response);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://codexnest.example/api/v1/threads/thread%2Fid/artifacts"),
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
  });

  it("marks an encoded thread as viewed and retries an ambiguous failure", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient({ baseUrl: "https://codexnest.example", token: "token" });

    const request = api.markViewed("thread/id", { observedUpdatedAt: 123 });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(request).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      new URL("https://codexnest.example/api/v1/threads/thread%2Fid/viewed"),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ observedUpdatedAt: 123 }),
      }),
    );
  });

  it("estimates and starts a reliable fork operation with the stable client id", async () => {
    const estimate = {
      sourceBytes: 100,
      compressed: {
        available: true,
        estimatedBytes: 30,
        estimatedSeconds: null,
        unavailableReason: null,
      },
      exact: {
        available: true,
        estimatedBytes: 100,
        estimatedSeconds: null,
        unavailableReason: null,
      },
    };
    const operation = { id: "operation" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(estimate), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ operation }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient({ baseUrl: "https://codexnest.example", token: "token" });

    await api.estimateFork("thread/id", { lastTurnId: "turn", agentMessageId: "answer" });
    await api.createForkOperation("thread/id", {
      operationId: "stable-id",
      lastTurnId: "turn",
      agentMessageId: "answer",
      mode: "compressed",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      new URL("https://codexnest.example/api/v1/threads/thread%2Fid/fork-estimate"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ lastTurnId: "turn", agentMessageId: "answer" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      new URL("https://codexnest.example/api/v1/threads/thread%2Fid/fork-operations"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          operationId: "stable-id",
          lastTurnId: "turn",
          agentMessageId: "answer",
          mode: "compressed",
        }),
      }),
    );
  });

  it("uses operation-scoped pending draft and queue endpoints", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "message" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient({ baseUrl: "https://codexnest.example", token: "token" });

    await api.updateForkOperationDraft("fork/id", {
      input: "Черновик",
      images: [],
      goalMode: false,
      annotations: [],
    });
    await api.enqueueForkOperation("fork/id", { input: "Следом", clientMessageId: "message" });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      new URL("https://codexnest.example/api/v1/fork-operations/fork%2Fid/draft"),
      expect.objectContaining({ method: "PUT" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      new URL("https://codexnest.example/api/v1/fork-operations/fork%2Fid/queue"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("targets the separate force-restart endpoints", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accepted: true }), {
          headers: { "Content-Type": "application/json" },
          status: 202,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ operation: "idle" }), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient({ baseUrl: "https://codexnest.example", token: "token" });

    await expect(api.forceRestartApp()).resolves.toEqual({ accepted: true });
    await expect(api.forceRestartCodex()).resolves.toMatchObject({ operation: "idle" });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      new URL("https://codexnest.example/api/v1/settings/app/force-restart"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      new URL("https://codexnest.example/api/v1/settings/codex/force-restart"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("retries project thread creation after an ambiguous connection failure", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ thread: { id: "thread" } }), {
          headers: { "Content-Type": "application/json" },
          status: 201,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient({ baseUrl: "https://codexnest.example", token: "token" });

    const creation = api.createProjectThread("project");
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(creation).resolves.toMatchObject({ thread: { id: "thread" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("marks only an explicit queued-message retry as an unconfirmed resend", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient({ baseUrl: "https://codexnest.example", token: "token" });
    await api.sendQueuedNow("thread", "message");
    expect(fetchMock.mock.calls[0]![1].body).toBeUndefined();
    await api.sendQueuedNow("thread", "message", true);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({ retryUnconfirmed: true });
  });

  it.each([
    ["successful", 200],
    ["error", 500],
  ])("keeps the default timeout active while consuming a %s JSON body", async (_label, status) => {
    vi.useFakeTimers();
    const jsonMock = vi.fn();
    const fetchMock = vi.fn().mockImplementation((_url: URL, init: RequestInit) => {
      jsonMock.mockImplementation(
        () =>
          new Promise((_, reject) => {
            init.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("The operation was aborted", "AbortError")),
              { once: true },
            );
          }),
      );
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: jsonMock,
      } as unknown as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient({ baseUrl: "https://codexnest.example", token: "token" });

    const request = api.summary();
    const rejection = expect(request).rejects.toMatchObject(
      status === 200 ? { name: "AbortError" } : { code: "http_error", status: 500 },
    );
    await vi.advanceTimersByTimeAsync(29_999);

    expect(jsonMock).toHaveBeenCalledOnce();
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);

    await rejection;
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not automatically retry turn item reads", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error("connection lost"));
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient({ baseUrl: "https://codexnest.example", token: "token" });

    const request = api.readTurnItems("thread/id", "turn/id");
    const rejection = expect(request).rejects.toMatchObject({ code: "connection_failed" });
    await vi.runAllTimersAsync();

    await rejection;
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
