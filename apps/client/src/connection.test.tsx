import { useEffect } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppSnapshot, ThreadDetail, ThreadSummary } from "@codexnest/protocol";

import { ConnectionProvider, useConnection } from "./connection";
import type { CachedMeta, OutboxMessage, PendingVoiceRecording } from "./offline-store";

const capacitor = vi.hoisted(() => ({ native: false }));
const addAppListener = vi.hoisted(() => vi.fn());
const listPendingVoiceRecordings = vi.hoisted(() =>
  vi.fn<() => Promise<PendingVoiceRecording[]>>(() => Promise.resolve([])),
);
const deletePendingVoiceRecording = vi.hoisted(() =>
  vi.fn<(id: string) => Promise<void>>(() => Promise.resolve()),
);
const loadPendingVoiceRecording = vi.hoisted(() => vi.fn(() => Promise.resolve(null)));
const putPendingVoiceRecording = vi.hoisted(() =>
  vi.fn<(recording: PendingVoiceRecording) => Promise<boolean>>(() => Promise.resolve(true)),
);
const observeNativeNotificationEvent = vi.hoisted(() => vi.fn());
const observeNativeNotificationSnapshot = vi.hoisted(() => vi.fn());
const setNativeNotificationAppActive = vi.hoisted(() => vi.fn());
const loadCachedMeta = vi.hoisted(() =>
  vi.fn<() => Promise<CachedMeta | null>>(() => Promise.resolve(null)),
);
const listOutboxMessages = vi.hoisted(() =>
  vi.fn<() => Promise<OutboxMessage[]>>(() => Promise.resolve([])),
);
const putOutboxMessage = vi.hoisted(() =>
  vi.fn<(message: OutboxMessage) => Promise<boolean>>(() => Promise.resolve(true)),
);
const deleteOutboxMessage = vi.hoisted(() =>
  vi.fn<(id: string) => Promise<void>>(() => Promise.resolve()),
);
const acknowledgeOutboxMessage = vi.hoisted(() => vi.fn().mockResolvedValue(true));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => capacitor.native },
}));
vi.mock("@capacitor/app", () => ({ App: { addListener: addAppListener } }));
vi.mock("./push", () => ({
  observeNativeNotificationEvent,
  observeNativeNotificationSnapshot,
  setNativeNotificationAppActive,
}));
vi.mock("./offline-store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadCachedMeta,
  listPendingVoiceRecordings,
  deletePendingVoiceRecording,
  loadPendingVoiceRecording,
  putPendingVoiceRecording,
  listOutboxMessages,
  putOutboxMessage,
  deleteOutboxMessage,
  acknowledgeOutboxMessage,
}));

const summary: ThreadSummary = {
  id: "thread",
  relation: { kind: "session", sessionId: "session" },
  projectId: null,
  title: "Thread",
  preview: "",
  cwd: "/work",
  state: "idle",
  unread: false,
  unseen: false,
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  currentTurnId: null,
  queuedMessageCount: 0,
  browserStatus: "disabled",
  settings: { collaborationMode: "default" },
};

describe("ConnectionProvider", () => {
  beforeEach(() => {
    capacitor.native = false;
    addAppListener.mockReset();
    listPendingVoiceRecordings.mockReset();
    listPendingVoiceRecordings.mockResolvedValue([]);
    deletePendingVoiceRecording.mockReset();
    deletePendingVoiceRecording.mockResolvedValue();
    loadPendingVoiceRecording.mockReset();
    loadPendingVoiceRecording.mockResolvedValue(null);
    putPendingVoiceRecording.mockReset();
    putPendingVoiceRecording.mockResolvedValue(true);
    observeNativeNotificationEvent.mockReset();
    observeNativeNotificationSnapshot.mockReset();
    setNativeNotificationAppActive.mockReset();
    loadCachedMeta.mockReset();
    loadCachedMeta.mockResolvedValue(null);
    listOutboxMessages.mockReset();
    listOutboxMessages.mockResolvedValue([]);
    putOutboxMessage.mockReset();
    putOutboxMessage.mockResolvedValue(true);
    deleteOutboxMessage.mockReset();
    deleteOutboxMessage.mockResolvedValue();
    acknowledgeOutboxMessage.mockReset().mockResolvedValue(true);
    FakeWebSocket.instances = [];
  });

  afterEach(() => vi.useRealTimers());

  it("does not hydrate stale cached metadata over a newer stream snapshot", async () => {
    const stale = { ...summary, title: "Старый заголовок", updatedAt: 2 };
    const fresh = { ...summary, title: "Актуальный заголовок", updatedAt: 5 };
    let resolveCached!: (cached: CachedMeta | null) => void;
    loadCachedMeta.mockReturnValueOnce(
      new Promise<CachedMeta | null>((resolve) => {
        resolveCached = resolve;
      }),
    );
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("WebSocket", FakeWebSocket);

    function Probe() {
      const { state } = useConnection();
      return <span>{state.snapshot?.threads[0]?.title ?? "Ожидание"}</span>;
    }

    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <Probe />
      </ConnectionProvider>,
    );
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      socket.open();
      socket.receive({ type: "snapshot", snapshot: snapshot(5, [fresh]) });
    });
    expect(await screen.findByText("Актуальный заголовок")).toBeInTheDocument();

    await act(async () => {
      resolveCached({ snapshot: snapshot(1, [stale]), goals: {}, updatedAt: 1 });
      await Promise.resolve();
    });

    expect(screen.getByText("Актуальный заголовок")).toBeInTheDocument();
    view.unmount();
  });

  it("commits a reliable message as soon as its outbox record is durable", async () => {
    const stored = deferred<boolean>();
    const accepted = deferred<Response>();
    const fetchMock = vi.fn<typeof fetch>(() => accepted.promise);
    putOutboxMessage.mockReturnValueOnce(stored.promise);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let controls: ReturnType<typeof useConnection> | undefined;
    const committed = vi.fn();
    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <ConnectionProbe onConnection={(value) => (controls = value)} />
      </ConnectionProvider>,
    );

    const delivery = controls!.sendReliable(
      "thread",
      {
        input: "Не потерять",
        clientMessageId: "message",
        dismissUserInput: { turnId: "turn", itemId: "question" },
      },
      committed,
    );
    expect(committed).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => stored.resolve(true));

    expect(committed).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(putOutboxMessage.mock.calls[0]?.[0]).toMatchObject({
      dismissUserInput: { turnId: "turn", itemId: "question" },
    });
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      dismissUserInput: { turnId: "turn", itemId: "question" },
    });
    expect(deleteOutboxMessage).not.toHaveBeenCalled();

    accepted.resolve(
      new Response(
        JSON.stringify({
          id: "message",
          threadId: "thread",
          text: "Не потерять",
          createdAt: 1,
          status: "queued",
        }),
        { status: 202 },
      ),
    );
    await expect(delivery).resolves.toBe("delivered");
    expect(committed).toHaveBeenCalledOnce();
    expect(acknowledgeOutboxMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "message", accepted: true }),
    );
    expect(deleteOutboxMessage).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(controls!.state.optimisticMessages.thread).toEqual([
        expect.objectContaining({ id: "message", serverAccepted: true }),
      ]),
    );
    view.unmount();
  });

  it("preserves async question delivery metadata through outbox restoration and retries", async () => {
    const reference = { turnId: "question-turn", itemId: "question-item" };
    const message: OutboxMessage = {
      id: "answer",
      threadId: "thread",
      connectionKey: "https://codexnest.example",
      input: "Ответ",
      images: [],
      goal: false,
      createdAt: 1,
      attempts: 0,
      lastError: null,
      replyToAsyncQuestion: reference,
    };
    const actual = await import("./offline-store");
    message.connectionKey = actual.connectionCacheKey({
      baseUrl: "https://codexnest.example",
      token: "token",
    });
    listOutboxMessages.mockResolvedValue([message]);
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "answer",
            threadId: "thread",
            text: "Ответ",
            status: "queued",
            createdAt: 1,
            replyToAsyncQuestion: reference,
          }),
          { status: 202 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let controls: ReturnType<typeof useConnection> | undefined;
    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <ConnectionProbe onConnection={(value) => (controls = value)} />
      </ConnectionProvider>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(putOutboxMessage).toHaveBeenCalledWith(
        expect.objectContaining({ replyToAsyncQuestion: reference, attempts: 1 }),
      ),
    );
    await act(async () => {
      await controls!.retryReliableMessage("thread", "answer");
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, request] of fetchMock.mock.calls)
      expect(JSON.parse(request.body)).toMatchObject({
        clientMessageId: "answer",
        replyToAsyncQuestion: reference,
      });
    expect(acknowledgeOutboxMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "answer", accepted: true, replyToAsyncQuestion: reference }),
    );
    view.unmount();
  });

  it("preserves plan implementation mode through outbox restoration and retries", async () => {
    const planImplementationMode = "team" as const;
    const message: OutboxMessage = {
      id: "answer",
      threadId: "thread",
      connectionKey: "https://codexnest.example",
      input: "Ответ",
      images: [],
      goal: false,
      createdAt: 1,
      attempts: 0,
      lastError: null,
      planImplementationMode,
    };
    const actual = await import("./offline-store");
    message.connectionKey = actual.connectionCacheKey({
      baseUrl: "https://codexnest.example",
      token: "token",
    });
    listOutboxMessages.mockResolvedValue([message]);
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "answer",
            threadId: "thread",
            text: "Ответ",
            status: "queued",
            createdAt: 1,
            planImplementationMode,
          }),
          { status: 202 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let controls: ReturnType<typeof useConnection> | undefined;
    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <ConnectionProbe onConnection={(value) => (controls = value)} />
      </ConnectionProvider>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(putOutboxMessage).toHaveBeenCalledWith(
        expect.objectContaining({ planImplementationMode, attempts: 1 }),
      ),
    );
    await act(async () => {
      await controls!.retryReliableMessage("thread", "answer");
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, request] of fetchMock.mock.calls)
      expect(JSON.parse(request.body)).toMatchObject({
        clientMessageId: "answer",
        planImplementationMode,
      });
    expect(acknowledgeOutboxMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "answer", accepted: true, planImplementationMode }),
    );
    view.unmount();
  });

  it("preserves paste provenance through offline outbox restoration and retries", async () => {
    const pastes = {
      inlinePastes: [{ id: "short", start: 0, end: 5 }],
      pasteBlocks: [{ id: "log", text: "one\ntwo" }],
    };
    const message: OutboxMessage = {
      id: "answer",
      threadId: "thread",
      connectionKey: "https://codexnest.example",
      input: "Ответ",
      images: [],
      goal: false,
      createdAt: 1,
      attempts: 0,
      lastError: null,
      ...pastes,
    };
    const actual = await import("./offline-store");
    message.connectionKey = actual.connectionCacheKey({
      baseUrl: "https://codexnest.example",
      token: "token",
    });
    listOutboxMessages.mockResolvedValue([message]);
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "answer",
            threadId: "thread",
            text: "Ответ",
            status: "queued",
            createdAt: 1,
            ...pastes,
          }),
          { status: 202 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let controls: ReturnType<typeof useConnection> | undefined;
    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <ConnectionProbe onConnection={(value) => (controls = value)} />
      </ConnectionProvider>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(putOutboxMessage).toHaveBeenCalledWith(
        expect.objectContaining({ ...pastes, attempts: 1 }),
      ),
    );
    await act(async () => {
      await controls!.retryReliableMessage("thread", "answer");
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, request] of fetchMock.mock.calls)
      expect(JSON.parse(request.body)).toMatchObject({
        clientMessageId: "answer",
        ...pastes,
      });
    expect(acknowledgeOutboxMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "answer", accepted: true, ...pastes }),
    );
    expect(controls!.state.optimisticMessages.thread).toEqual([expect.objectContaining(pastes)]);
    view.unmount();
  });

  it.each([null, 42])(
    "retains submitted draft revision %s through durable staging and HTTP delivery",
    async (draftUpdatedAt) => {
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 202 }));
      vi.stubGlobal("fetch", fetchMock);
      vi.stubGlobal("WebSocket", FakeWebSocket);
      let controls: ReturnType<typeof useConnection> | undefined;
      const view = render(
        <ConnectionProvider settings={{ baseUrl: "https://claudenest.example", token: "token" }}>
          <ConnectionProbe onConnection={(value) => (controls = value)} />
        </ConnectionProvider>,
      );
      await act(async () => {
        await controls!.sendReliable("thread", {
          input: "Submitted draft",
          clientMessageId: "message",
          draftUpdatedAt,
        });
      });
      expect(putOutboxMessage.mock.calls[0]?.[0]).toMatchObject({ id: "message", draftUpdatedAt });
      expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toMatchObject({
        clientMessageId: "message",
        draftUpdatedAt,
      });
      view.unmount();
    },
  );

  it("does not send or clear the composer when the outbox write fails", async () => {
    putOutboxMessage.mockResolvedValue(false);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let controls: ReturnType<typeof useConnection> | undefined;
    const committed = vi.fn();
    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <ConnectionProbe onConnection={(value) => (controls = value)} />
      </ConnectionProvider>,
    );
    await expect(
      controls!.sendReliable(
        "thread",
        { input: "Сохранить сначала", clientMessageId: "message" },
        committed,
      ),
    ).rejects.toThrow("Не удалось сохранить сообщение на устройстве");
    expect(committed).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    view.unmount();
  });

  it("serializes each thread without blocking delivery in another thread", async () => {
    const firstResponse = deferred<Response>();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url, options: RequestInit) => {
        const body = JSON.parse(options.body as string) as { clientMessageId: string };
        calls.push(body.clientMessageId);
        return body.clientMessageId === "a1"
          ? firstResponse.promise
          : Promise.resolve(new Response("{}", { status: 202 }));
      }),
    );
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let controls: ReturnType<typeof useConnection> | undefined;
    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <ConnectionProbe onConnection={(value) => (controls = value)} />
      </ConnectionProvider>,
    );
    const first = controls!.sendReliable("a", { input: "First", clientMessageId: "a1" });
    await waitFor(() => expect(calls).toEqual(["a1"]));
    const second = controls!.sendReliable("a", { input: "Second", clientMessageId: "a2" });
    const independent = controls!.sendReliable("b", {
      input: "Independent",
      clientMessageId: "b1",
    });
    await act(async () => {
      await independent;
    });
    expect(calls).toEqual(["a1", "b1"]);
    await act(async () => {
      firstResponse.resolve(new Response("{}", { status: 202 }));
      await Promise.all([first, second]);
    });
    expect(calls).toEqual(["a1", "b1", "a2"]);
    expect(acknowledgeOutboxMessage).toHaveBeenCalledTimes(3);
    view.unmount();
  });

  it("keeps a rejected message visible and retries its original id only on request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "invalid", message: "Rejected" } }), {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let controls: ReturnType<typeof useConnection> | undefined;
    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <ConnectionProbe onConnection={(value) => (controls = value)} />
      </ConnectionProvider>,
    );
    const body = { input: "Keep me", clientMessageId: "rejected" };
    await act(async () => {
      expect(
        await controls!.sendReliable("thread", body, () =>
          controls!.dispatch({
            type: "optimistic.add",
            message: {
              id: body.clientMessageId,
              threadId: "thread",
              text: body.input,
              images: [],
              createdAt: 1,
              destination: "queue",
              turnId: null,
            },
          }),
        ),
      ).toBe("pending");
    });
    expect(controls!.state.optimisticMessages.thread).toEqual([
      expect.objectContaining({
        id: "rejected",
        deliveryError: { message: "Rejected", retryable: false },
      }),
    ]);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await flushPromises();
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    await act(async () => {
      await controls!.retryReliableMessage("thread", "rejected");
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => JSON.parse(call[1].body))).toEqual([body, body]);
    expect(controls!.state.optimisticMessages.thread?.[0]).toMatchObject({ serverAccepted: true });
    view.unmount();
  });

  it("does not resend an accepted fallback after a reload without history", async () => {
    const { connectionCacheKey } = await import("./offline-store");
    const settings = { baseUrl: "https://codexnest.example", token: "token" };
    listOutboxMessages.mockResolvedValue([
      {
        id: "accepted",
        connectionKey: connectionCacheKey(settings),
        threadId: "thread",
        input: "Safe fallback",
        images: [],
        goal: false,
        createdAt: 1,
        attempts: 0,
        lastError: null,
        accepted: true,
      },
    ]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let controls: ReturnType<typeof useConnection> | undefined;
    const view = render(
      <ConnectionProvider settings={settings}>
        <ConnectionProbe onConnection={(value) => (controls = value)} />
      </ConnectionProvider>,
    );
    await waitFor(() =>
      expect(controls!.state.optimisticMessages.thread?.[0]).toMatchObject({
        id: "accepted",
        text: "Safe fallback",
        serverAccepted: true,
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    view.unmount();
  });

  it("does not commit when neither the outbox nor the server accepts the message", async () => {
    putOutboxMessage.mockResolvedValue(false);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let controls: ReturnType<typeof useConnection> | undefined;
    const committed = vi.fn();
    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <ConnectionProbe onConnection={(value) => (controls = value)} />
      </ConnectionProvider>,
    );

    await expect(
      controls!.sendReliable(
        "thread",
        { input: "Оставить в поле", clientMessageId: "message" },
        committed,
      ),
    ).rejects.toThrow("Не удалось сохранить сообщение на устройстве");
    expect(committed).not.toHaveBeenCalled();
    expect(putOutboxMessage).toHaveBeenCalledOnce();
    view.unmount();
  });

  it.each(["draft", "queue"] as const)(
    "uploads a persisted %s voice recording after reload and deletes it only after acceptance",
    async (mode) => {
      const dismissUserInput = { turnId: "original-turn", itemId: "original-question" };
      listPendingVoiceRecordings.mockResolvedValue([
        {
          id: "stale-recording",
          connectionKey: "saved-connection",
          threadId: "thread",
          audio: new Blob(["audio"], { type: "audio/webm" }),
          durationMs: 1_000,
          mode,
          ...(mode === "queue" ? { dismissUserInput } : {}),
          selectionStart: 0,
          selectionEnd: 0,
          draftUpdatedAt: null,
          draft: { input: "", images: [], goalMode: false, annotations: [] },
          localDraftUpdatedAt: 1,
          serverDraftUpdatedAt: null,
          createdAt: 1,
          attempts: 1,
          lastError: "offline",
        },
      ]);
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      vi.stubGlobal("fetch", fetchMock);
      vi.stubGlobal("WebSocket", FakeWebSocket);

      const view = render(
        <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
          <span>ready</span>
        </ConnectionProvider>,
      );

      await waitFor(() =>
        expect(deletePendingVoiceRecording).toHaveBeenCalledWith("stale-recording"),
      );
      expect(fetchMock).toHaveBeenCalledOnce();
      const url = fetchMock.mock.calls[0]![0] as URL;
      expect(url.searchParams.get("dismissUserInput")).toBe(
        mode === "queue" ? JSON.stringify(dismissUserInput) : null,
      );
      view.unmount();
    },
  );

  it("leaves first-message voice recovery to its persisted new-session preparation", async () => {
    listPendingVoiceRecordings.mockResolvedValue([
      {
        id: "first-voice",
        connectionKey: "saved-connection",
        threadId: "thread",
        newSessionProjectId: "project",
        audio: new Blob(["audio"], { type: "audio/webm" }),
        durationMs: 60_000,
        mode: "send",
        selectionStart: 0,
        selectionEnd: 0,
        draftUpdatedAt: null,
        draft: { input: "", images: [], goalMode: false, annotations: [] },
        localDraftUpdatedAt: 1,
        serverDraftUpdatedAt: null,
        createdAt: 1,
        attempts: 1,
        lastError: "offline",
      },
    ]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let controls: ReturnType<typeof useConnection> | undefined;
    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <ConnectionProbe
          onConnection={(value) => {
            controls = value;
          }}
        />
      </ConnectionProvider>,
    );
    await waitFor(() => expect(controls!.pendingVoiceRecordingThreadIds).toEqual(["thread"]));
    act(() => window.dispatchEvent(new Event("online")));
    await act(async () => Promise.resolve());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deletePendingVoiceRecording).not.toHaveBeenCalled();
    view.unmount();
  });

  it("restores question recordings before submitting answers without touching the composer", async () => {
    const { connectionCacheKey } = await import("./offline-store");
    const settings = { baseUrl: "https://codexnest.example", token: "token" };
    const draftKey = "a".repeat(64);
    const recording: PendingVoiceRecording = {
      id: "question-clip",
      connectionKey: connectionCacheKey(settings),
      threadId: "thread",
      audio: new Blob(["audio"], { type: "audio/webm" }),
      durationMs: 1000,
      mode: "draft",
      userInput: { draftKey, questionId: "first", order: 1 },
      selectionStart: 0,
      selectionEnd: 0,
      draftUpdatedAt: null,
      draft: { input: "", images: [], annotations: [], goalMode: false },
      localDraftUpdatedAt: 1,
      createdAt: 1,
      attempts: 0,
      lastError: null,
    };
    listPendingVoiceRecordings.mockResolvedValue([recording]);
    deletePendingVoiceRecording.mockImplementation(async () => {
      listPendingVoiceRecordings.mockResolvedValue([]);
    });
    const submission = {
      draftKey,
      draft: { answers: { first: ["Edited"] }, currentQuestionId: "first" },
      recordingIds: [recording.id],
    };
    listOutboxMessages.mockResolvedValue([
      {
        id: "question-reply",
        connectionKey: connectionCacheKey(settings),
        threadId: "thread",
        input: "",
        images: [],
        goal: false,
        createdAt: 2,
        attempts: 0,
        lastError: null,
        userInputSubmission: submission,
      },
    ]);
    let finishUpload!: () => void;
    const paths: string[] = [];
    const fetchMock = vi.fn((url: URL) => {
      paths.push(url.pathname);
      if (url.pathname.endsWith("/voice-transcriptions")) {
        expect(JSON.parse(url.searchParams.get("userInput")!)).toEqual(recording.userInput);
        return new Promise<Response>((resolve) => {
          finishUpload = () => resolve(new Response(null, { status: 204 }));
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ accepted: true }), { status: 202 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let context: ReturnType<typeof useConnection> | undefined;
    function Probe() {
      context = useConnection();
      return null;
    }
    const view = render(
      <ConnectionProvider settings={settings}>
        <Probe />
      </ConnectionProvider>,
    );
    await waitFor(() => expect(finishUpload).toBeTypeOf("function"));
    expect(paths).toEqual(["/api/v1/threads/thread/voice-transcriptions"]);
    expect(context!.pendingVoiceRecordingThreadIds).toEqual([]);
    expect(context!.pendingQuestionRecordings).toHaveLength(1);
    await act(async () => {
      finishUpload();
    });
    await waitFor(() => expect(acknowledgeOutboxMessage).toHaveBeenCalled());
    expect(paths).toEqual([
      "/api/v1/threads/thread/voice-transcriptions",
      `/api/v1/threads/thread/user-input/${draftKey}/submit`,
    ]);
    expect(context!.state.optimisticMessages.thread ?? []).toEqual([]);
    view.unmount();
  });

  it("keeps a recovered recording without endlessly retrying a stale draft conflict", async () => {
    listPendingVoiceRecordings.mockResolvedValue([
      {
        id: "conflicted-recording",
        connectionKey: "saved-connection",
        threadId: "thread",
        audio: new Blob(["audio"], { type: "audio/webm" }),
        durationMs: 1_000,
        mode: "draft",
        selectionStart: 0,
        selectionEnd: 0,
        draftUpdatedAt: 10,
        draft: { input: "Старый черновик", images: [], goalMode: false, annotations: [] },
        localDraftUpdatedAt: 1,
        serverDraftUpdatedAt: 11,
        createdAt: 1,
        attempts: 1,
        lastError: "offline",
      },
    ]);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "draft_conflict", message: "The draft changed before voice upload" },
        }),
        { status: 409 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let pendingThreadIds: readonly string[] = [];
    let pendingErrors: Readonly<Record<string, string>> = {};
    let retryRecording: ReturnType<typeof useConnection>["retryPendingVoiceRecording"] | undefined;

    function Probe() {
      const connection = useConnection();
      pendingThreadIds = connection.pendingVoiceRecordingThreadIds;
      pendingErrors = connection.pendingVoiceRecordingErrors;
      retryRecording = connection.retryPendingVoiceRecording;
      return null;
    }

    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <Probe />
      </ConnectionProvider>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await new Promise((resolve) => window.setTimeout(resolve, 1_500));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(putPendingVoiceRecording).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "conflicted-recording",
        attempts: 2,
        lastError: "The draft changed before voice upload",
      }),
    );
    expect(deletePendingVoiceRecording).not.toHaveBeenCalledWith("conflicted-recording");
    expect(pendingThreadIds).toEqual(["thread"]);
    expect(pendingErrors).toEqual({
      thread: "The draft changed before voice upload",
    });

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { code: "draft_conflict", message: "The draft changed before voice upload" },
          }),
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            input: "Текущий черновик",
            images: [],
            goalMode: false,
            annotations: [],
            updatedAt: 21,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await act(async () => {
      await retryRecording!({
        threadId: "thread",
        mode: "draft",
        draft: { input: "Текущий черновик", images: [], goalMode: false, annotations: [] },
        draftUpdatedAt: 20,
      });
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toEqual(
      new URL("https://codexnest.example/api/v1/threads/thread/draft?expectedUpdatedAt=20"),
    );
    expect(
      putPendingVoiceRecording.mock.calls.some(
        ([recording]) =>
          recording.draft.input === "Текущий черновик" &&
          !Object.prototype.hasOwnProperty.call(recording, "serverDraftUpdatedAt"),
      ),
    ).toBe(true);
    await waitFor(() => expect(pendingThreadIds).toEqual([]));
    expect(pendingErrors).toEqual({});
    expect(deletePendingVoiceRecording).toHaveBeenCalledWith("conflicted-recording");
    view.unmount();
  });

  it("persists a new voice recording before upload and retains it after a failed upload", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("null", { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: "transcription_unavailable", message: "offline" } }),
          { status: 503 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let queueRecording: ReturnType<typeof useConnection>["queueVoiceRecording"] | undefined;

    function Probe() {
      queueRecording = useConnection().queueVoiceRecording;
      return null;
    }

    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <Probe />
      </ConnectionProvider>,
    );

    await act(async () => {
      await expect(
        queueRecording!({
          id: "recording",
          threadId: "thread",
          audio: new Blob(["audio"], { type: "audio/webm" }),
          durationMs: 1_000,
          mode: "draft",
          selectionStart: 0,
          selectionEnd: 0,
          draftUpdatedAt: null,
          draft: { input: "", images: [], goalMode: false, annotations: [] },
        }),
      ).rejects.toThrow("offline");
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toEqual(
      new URL("https://codexnest.example/api/v1/threads/thread/draft?expectedUpdatedAt=none"),
    );
    expect(putPendingVoiceRecording).toHaveBeenCalled();
    expect(putPendingVoiceRecording.mock.invocationCallOrder[0]).toBeLessThan(
      fetchMock.mock.invocationCallOrder[0]!,
    );
    expect(deletePendingVoiceRecording).not.toHaveBeenCalledWith("recording");

    act(() => window.dispatchEvent(new Event("online")));
    await act(async () => Promise.resolve());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("deduplicates concurrent reads of the same thread page", async () => {
    const detail: ThreadDetail = {
      summary,
      turns: [],
      queuedMessages: [],
      olderTurnsCursor: null,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(detail), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const requests: Array<Promise<ThreadDetail>> = [];

    function Probe() {
      const { refreshDetail } = useConnection();
      useEffect(() => {
        requests.push(refreshDetail("thread"), refreshDetail("thread"));
      }, [refreshDetail]);
      return null;
    }

    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <Probe />
      </ConnectionProvider>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await expect(Promise.all(requests)).resolves.toEqual([detail, detail]);
    view.unmount();
  });

  it("applies a versioned detail and rejects a late response after disconnect", async () => {
    const responses: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          responses.push(resolve);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let refresh!: () => Promise<ThreadDetail>;

    function Probe() {
      const connection = useConnection();
      refresh = () => connection.refreshDetail("thread", { force: true });
      return <span>{connection.state.details.thread?.summary.title ?? "Ожидание"}</span>;
    }

    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <Probe />
      </ConnectionProvider>,
    );
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      socket.open();
      socket.receive({ type: "snapshot", snapshot: snapshot(3) });
    });

    let pending!: Promise<ThreadDetail>;
    act(() => {
      pending = refresh();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const accepted: ThreadDetail = {
      version: { instanceId: "server-instance", sequence: 3 },
      summary: { ...summary, title: "Версия backend" },
      turns: [],
      queuedMessages: [],
      olderTurnsCursor: null,
    };
    await act(async () => {
      responses[0]?.(new Response(JSON.stringify(accepted), { status: 200 }));
      await pending;
    });
    expect(screen.getByText("Версия backend")).toBeInTheDocument();

    act(() => {
      pending = refresh();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    act(() => socket.close());
    const late: ThreadDetail = {
      ...accepted,
      version: { instanceId: "server-instance", sequence: 4 },
      summary: { ...summary, title: "Поздний ответ" },
    };
    await act(async () => {
      responses[1]?.(new Response(JSON.stringify(late), { status: 200 }));
      await pending;
    });
    expect(screen.getByText("Версия backend")).toBeInTheDocument();
    expect(screen.queryByText("Поздний ответ")).toBeNull();
    view.unmount();
  });

  it("rejects an HTTP detail older than a target-thread stream event", async () => {
    let resolveResponse!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let refresh!: () => Promise<ThreadDetail>;

    function Probe() {
      const connection = useConnection();
      refresh = () => connection.refreshDetail("thread", { force: true });
      return <span>{connection.state.snapshot?.threads[0]?.title ?? "Ожидание"}</span>;
    }

    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <Probe />
      </ConnectionProvider>,
    );
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      socket.open();
      socket.receive({ type: "snapshot", snapshot: snapshot(3) });
    });

    let pending!: Promise<ThreadDetail>;
    act(() => {
      pending = refresh();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    act(() => {
      socket.receive({
        type: "event",
        sequence: 4,
        version: { instanceId: "server-instance", sequence: 4 },
        event: {
          type: "thread.upserted",
          thread: { ...summary, title: "Событие новее", updatedAt: 4 },
        },
      });
    });
    expect(screen.getByText("Событие новее")).toBeInTheDocument();

    const rejection = expect(pending).rejects.toMatchObject({
      code: "projection_advanced",
      status: 425,
    });
    await act(async () => {
      resolveResponse(
        new Response(
          JSON.stringify({
            version: { instanceId: "server-instance", sequence: 3 },
            summary: { ...summary, title: "Устаревший HTTP" },
            turns: [],
            queuedMessages: [],
            olderTurnsCursor: null,
          } satisfies ThreadDetail),
          { status: 200 },
        ),
      );
      await rejection;
    });
    expect(screen.getByText("Событие новее")).toBeInTheDocument();
    expect(screen.queryByText("Устаревший HTTP")).toBeNull();
    view.unmount();
  });

  it("starts a new detail read after disconnect and ignores the old request", async () => {
    const responses: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          responses.push(resolve);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let refresh!: () => Promise<ThreadDetail>;

    function Probe() {
      const connection = useConnection();
      refresh = () => connection.refreshDetail("thread", { force: true });
      return <span>{connection.state.details.thread?.summary.title ?? "Ожидание"}</span>;
    }

    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <Probe />
      </ConnectionProvider>,
    );
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      socket.open();
      socket.receive({ type: "snapshot", snapshot: snapshot(3) });
    });

    let oldRequest!: Promise<ThreadDetail>;
    let newRequest!: Promise<ThreadDetail>;
    act(() => {
      oldRequest = refresh();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    act(() => {
      socket.close();
      newRequest = refresh();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      responses[1]?.(
        new Response(
          JSON.stringify({
            version: { instanceId: "server-instance", sequence: 3 },
            summary: { ...summary, title: "Новый запрос" },
            turns: [],
            queuedMessages: [],
            olderTurnsCursor: null,
          } satisfies ThreadDetail),
          { status: 200 },
        ),
      );
      await newRequest;
    });
    expect(screen.getByText("Новый запрос")).toBeInTheDocument();

    await act(async () => {
      responses[0]?.(
        new Response(
          JSON.stringify({
            version: { instanceId: "server-instance", sequence: 4 },
            summary: { ...summary, title: "Старый запрос" },
            turns: [],
            queuedMessages: [],
            olderTurnsCursor: null,
          } satisfies ThreadDetail),
          { status: 200 },
        ),
      );
      await oldRequest;
    });
    expect(screen.getByText("Новый запрос")).toBeInTheDocument();
    expect(screen.queryByText("Старый запрос")).toBeNull();
    view.unmount();
  });

  it("deduplicates concurrent technical item reads", async () => {
    let resolveResponse!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const requests: Array<Promise<void>> = [];

    function Probe() {
      const { loadTurnItems } = useConnection();
      useEffect(() => {
        requests.push(loadTurnItems("thread", "turn"), loadTurnItems("thread", "turn"));
      }, [loadTurnItems]);
      return null;
    }

    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <Probe />
      </ConnectionProvider>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await act(async () => {
      resolveResponse(new Response(JSON.stringify({ items: [] }), { status: 200 }));
      await Promise.all(requests);
    });
    view.unmount();
  });

  it("rebases a changed history cursor once and applies the new page atomically", async () => {
    const refreshedSummary = { ...summary, title: "После rebase", updatedAt: 4 };
    const rebasedDetail: ThreadDetail = {
      version: { instanceId: "server-instance", sequence: 4 },
      summary: refreshedSummary,
      turns: [detailTurn("rebased")],
      queuedMessages: [],
      olderTurnsCursor: "new-cursor",
    };
    const fetchMock = vi.fn(async (url: URL) => {
      if (url.pathname.endsWith("/history") && url.searchParams.get("cursor") === "stale-cursor") {
        return new Response(
          JSON.stringify({ error: { code: "history_changed", message: "changed" } }),
          { status: 409 },
        );
      }
      if (url.pathname.endsWith("/refresh")) {
        return new Response(
          JSON.stringify({
            snapshot: snapshot(4, [refreshedSummary]),
            detail: rebasedDetail,
          }),
          { status: 200 },
        );
      }
      if (url.pathname.endsWith("/history") && url.searchParams.get("cursor") === "new-cursor") {
        return new Response(
          JSON.stringify({
            instanceId: "server-instance",
            anchorTurnId: "rebased",
            turns: [detailTurn("older")],
            olderTurnsCursor: null,
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let controls: ReturnType<typeof useConnection> | undefined;

    function Probe() {
      const connection = useConnection();
      controls = connection;
      return (
        <span>{`${connection.state.snapshot?.sequence ?? "none"}:${
          connection.state.details.thread?.turns.map((turn) => turn.id).join(",") ?? "none"
        }`}</span>
      );
    }

    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <Probe />
      </ConnectionProvider>,
    );
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      socket.open();
      socket.receive({ type: "snapshot", snapshot: snapshot(3) });
      controls!.dispatch({
        type: "detail",
        detail: {
          version: { instanceId: "server-instance", sequence: 3 },
          summary,
          turns: [detailTurn("latest")],
          queuedMessages: [],
          olderTurnsCursor: "stale-cursor",
        },
      });
    });
    expect(await screen.findByText("3:latest")).toBeInTheDocument();

    await act(async () => {
      await controls!.loadOlderDetail("thread", "stale-cursor");
    });

    expect(screen.getByText("4:older,rebased")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      fetchMock.mock.calls.filter(([url]) => (url as URL).pathname.endsWith("/refresh")),
    ).toHaveLength(1);
    view.unmount();
  });

  it("reconnects a native app on resume without starting a global sync", async () => {
    capacitor.native = true;
    let appStateListener: ((state: { isActive: boolean }) => void) | undefined;
    addAppListener.mockImplementation((_event, listener) => {
      appStateListener = listener;
      return Promise.resolve({ remove: vi.fn().mockResolvedValue(undefined) });
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });

    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <SnapshotProbe />
        <ForegroundProbe />
        <AppActiveProbe />
      </ConnectionProvider>,
    );
    await waitFor(() =>
      expect(addAppListener).toHaveBeenCalledWith("appStateChange", expect.any(Function)),
    );

    act(() => appStateListener?.({ isActive: false }));
    expect(setNativeNotificationAppActive).toHaveBeenLastCalledWith(false);
    expect(screen.getByText("foreground:0")).toBeInTheDocument();
    expect(screen.getByText("active:false")).toBeInTheDocument();
    act(() => appStateListener?.({ isActive: true }));
    expect(setNativeNotificationAppActive).toHaveBeenLastCalledWith(true);
    expect(await screen.findByText("foreground:1")).toBeInTheDocument();
    expect(screen.getByText("active:true")).toBeInTheDocument();

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const resumed = FakeWebSocket.instances[1]!;
    act(() => {
      resumed.open();
      resumed.receive({ type: "snapshot", snapshot: snapshot(2, []) });
    });
    expect(await screen.findByText("snapshot:2")).toBeInTheDocument();
    view.unmount();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });

  it("tracks whether the web app is actually visible", () => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("WebSocket", FakeWebSocket);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <AppActiveProbe />
      </ConnectionProvider>,
    );
    expect(screen.getByText("active:true")).toBeInTheDocument();

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(screen.getByText("active:false")).toBeInTheDocument();

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(screen.getByText("active:true")).toBeInTheDocument();
    view.unmount();
  });

  it("requests detail recovery only after a subsequent stream snapshot", () => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("WebSocket", FakeWebSocket);

    function Probe() {
      const { streamRecoveryEpoch } = useConnection();
      return <span>{`recovery:${streamRecoveryEpoch}`}</span>;
    }

    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <Probe />
      </ConnectionProvider>,
    );
    const socket = FakeWebSocket.instances[0]!;
    expect(screen.getByText("recovery:0")).toBeInTheDocument();

    act(() => {
      socket.open();
      socket.receive({ type: "snapshot", snapshot: snapshot(1) });
    });
    expect(screen.getByText("recovery:0")).toBeInTheDocument();

    act(() => {
      socket.receive({ type: "snapshot", snapshot: snapshot(2) });
    });
    expect(screen.getByText("recovery:1")).toBeInTheDocument();
    view.unmount();
  });

  it("forwards only accepted native stream frames to the notification bridge", () => {
    capacitor.native = true;
    addAppListener.mockResolvedValue({ remove: vi.fn().mockResolvedValue(undefined) });
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <SnapshotProbe />
      </ConnectionProvider>,
    );
    const socket = FakeWebSocket.instances[0]!;
    const initial = snapshot(1);

    act(() => {
      socket.open();
      socket.receive({ type: "snapshot", snapshot: initial });
      socket.receive({
        type: "event",
        sequence: 2,
        version: { instanceId: "server-instance", sequence: 2 },
        event: { type: "thread.upserted", thread: summary },
      });
      socket.receive({
        type: "event",
        sequence: 2,
        version: { instanceId: "server-instance", sequence: 2 },
        event: { type: "attention.removed", attentionId: "late-duplicate" },
      });
    });

    expect(observeNativeNotificationSnapshot).toHaveBeenCalledOnce();
    expect(observeNativeNotificationSnapshot).toHaveBeenCalledWith(initial);
    expect(observeNativeNotificationEvent).toHaveBeenCalledOnce();
    expect(observeNativeNotificationEvent).toHaveBeenCalledWith(2, {
      type: "thread.upserted",
      thread: summary,
    });
    view.unmount();
  });

  it("closes an unresponsive socket after a heartbeat and isolates its late events", () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <SnapshotProbe />
      </ConnectionProvider>,
    );
    const first = FakeWebSocket.instances[0]!;

    act(() => {
      first.open();
      first.receive({ type: "snapshot", snapshot: snapshot(1) });
    });
    expect(first.sent).toContain(JSON.stringify({ type: "authenticate", token: "token" }));

    act(() => vi.advanceTimersByTime(15_000));
    expect(first.sent.at(-1)).toBe(JSON.stringify({ type: "ping" }));
    act(() => vi.advanceTimersByTime(10_000));
    expect(first.readyState).toBe(FakeWebSocket.CLOSED);

    act(() => vi.advanceTimersByTime(1_300));
    const second = FakeWebSocket.instances[1]!;
    act(() => {
      second.open();
      second.receive({ type: "snapshot", snapshot: snapshot(2) });
      first.receive({ invalid: true });
    });
    expect(second.readyState).toBe(FakeWebSocket.OPEN);
    expect(screen.getByText("snapshot:2")).toBeInTheDocument();
    view.unmount();
  });

  it("ignores late events from the socket replaced on resume", async () => {
    capacitor.native = true;
    let appStateListener: ((state: { isActive: boolean }) => void) | undefined;
    addAppListener.mockImplementation((_event, listener) => {
      appStateListener = listener;
      return Promise.resolve({ remove: vi.fn().mockResolvedValue(undefined) });
    });
    const synced = { ...summary, title: "Синхронизировано" };
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <ThreadTitleProbe />
      </ConnectionProvider>,
    );
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      socket.open();
      socket.receive({ type: "snapshot", snapshot: snapshot(1) });
    });
    await waitFor(() =>
      expect(addAppListener).toHaveBeenCalledWith("appStateChange", expect.any(Function)),
    );

    act(() => appStateListener?.({ isActive: true }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const resumedSocket = FakeWebSocket.instances[1]!;
    act(() => {
      resumedSocket.open();
      resumedSocket.receive({ type: "snapshot", snapshot: snapshot(3, [synced]) });
    });
    expect(await screen.findByText("Синхронизировано")).toBeInTheDocument();
    act(() => {
      socket.receive({
        type: "event",
        sequence: 2,
        version: { instanceId: "server-instance", sequence: 2 },
        event: { type: "thread.upserted", thread: { ...summary, title: "Устарело" } },
      });
    });

    expect(screen.getByText("Синхронизировано")).toBeInTheDocument();
    expect(screen.queryByText("Устарело")).toBeNull();
    view.unmount();
  });

  it("persists choices immediately, debounces typing, and flushes pending text on pagehide", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        answers: Record<string, string[]>;
        currentQuestionId: string | null;
      };
      return new Response(
        JSON.stringify({ ...body, revision: fetchMock.mock.calls.length, updatedAt: Date.now() }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let controls: ReturnType<typeof useConnection> | undefined;
    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <DraftProbe onConnection={(value) => (controls = value)} />
      </ConnectionProvider>,
    );

    act(() =>
      controls!.updateUserInputDraft(
        "questions",
        { answers: { first: ["Да"] }, currentQuestionId: "first" },
        "immediate",
      ),
    );
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "PUT", keepalive: true });

    act(() =>
      controls!.updateUserInputDraft(
        "questions",
        { answers: { first: ["Да"], second: ["т"] }, currentQuestionId: "second" },
        "debounced",
      ),
    );
    act(() => vi.advanceTimersByTime(499));
    expect(fetchMock).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(1));
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    act(() =>
      controls!.updateUserInputDraft(
        "questions",
        { answers: { second: ["готово"] }, currentQuestionId: "second" },
        "debounced",
      ),
    );
    act(() => window.dispatchEvent(new Event("pagehide")));
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      answers: { second: ["готово"] },
      currentQuestionId: "second",
    });
    view.unmount();
  });

  it("coalesces sequential saves and sends only the newest pending snapshot", async () => {
    const responses: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn<(url: URL, init?: RequestInit) => Promise<Response>>(
      () =>
        new Promise<Response>((resolve) => {
          responses.push(resolve);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let controls: ReturnType<typeof useConnection> | undefined;
    const view = render(
      <ConnectionProvider settings={{ baseUrl: "https://codexnest.example", token: "token" }}>
        <DraftProbe onConnection={(value) => (controls = value)} />
      </ConnectionProvider>,
    );

    act(() => {
      controls!.updateUserInputDraft(
        "questions",
        { answers: { first: ["A"] }, currentQuestionId: "first" },
        "immediate",
      );
      controls!.updateUserInputDraft(
        "questions",
        { answers: { first: ["C"] }, currentQuestionId: "third" },
        "immediate",
      );
      controls!.updateUserInputDraft(
        "questions",
        { answers: { first: ["D"] }, currentQuestionId: "fourth" },
        "immediate",
      );
    });
    expect(fetchMock).toHaveBeenCalledOnce();

    act(() =>
      responses[0]?.(
        new Response(
          JSON.stringify({
            answers: { first: ["A"] },
            currentQuestionId: "first",
            revision: 1,
            updatedAt: 1,
          }),
        ),
      ),
    );
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      answers: { first: ["D"] },
      currentQuestionId: "fourth",
    });
    act(() =>
      responses[1]?.(
        new Response(
          JSON.stringify({
            answers: { first: ["D"] },
            currentQuestionId: "fourth",
            revision: 2,
            updatedAt: 2,
          }),
        ),
      ),
    );
    await flushPromises();
    view.unmount();
  });

  it("keeps an optimistic draft across route unmount and retries a failure on the next edit", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "offline", message: "offline" } }), {
          status: 503,
        }),
      )
      .mockImplementation(async (_url: URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ ...body, revision: 1, updatedAt: 1 }));
      });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let controls: ReturnType<typeof useConnection> | undefined;
    const settings = { baseUrl: "https://codexnest.example", token: "token" };
    const content = (show: boolean) => (
      <ConnectionProvider settings={settings}>
        {show && <DraftProbe onConnection={(value) => (controls = value)} flushOnUnmount />}
      </ConnectionProvider>
    );
    const view = render(content(true));

    act(() =>
      controls!.updateUserInputDraft(
        "questions",
        { answers: { first: ["Локально"] }, currentQuestionId: "first" },
        "immediate",
      ),
    );
    await flushPromises();
    expect(screen.getByRole("status")).toHaveTextContent("offline");
    expect(screen.getByText("Локально")).toBeInTheDocument();

    act(() =>
      controls!.updateUserInputDraft(
        "questions",
        { answers: { first: ["Исправлено"] }, currentQuestionId: "first" },
        "debounced",
      ),
    );
    view.rerender(content(false));
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    view.rerender(content(true));
    expect(screen.getByText("Исправлено")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("ok");
    view.unmount();
  });
});

function snapshot(sequence: number, threads: ThreadSummary[] = [summary]): AppSnapshot {
  return {
    instanceId: "server-instance",
    sequence,
    uiLanguage: "ru",
    connection: { state: "ready", message: null, syncedAt: "2026-08-03T00:00:00.000Z" },
    projects: [],
    threads,
    forkOperations: [],
    attention: [],
    models: [],
  };
}

function detailTurn(id: string): ThreadDetail["turns"][number] {
  return {
    id,
    status: "completed",
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
    progress: {
      startedAt: 1,
      explanation: null,
      steps: [],
      filesChanged: 0,
      additions: 0,
      deletions: 0,
    },
    items: [],
    itemsLoaded: false,
  };
}

function SnapshotProbe() {
  const { state } = useConnection();
  return <span>snapshot:{state.snapshot?.sequence ?? "none"}</span>;
}

function ForegroundProbe() {
  const { foregroundEpoch } = useConnection();
  return <span>foreground:{foregroundEpoch}</span>;
}

function AppActiveProbe() {
  const { appActive } = useConnection();
  return <span>active:{String(appActive)}</span>;
}

function ConnectionProbe({
  onConnection,
}: {
  onConnection(value: ReturnType<typeof useConnection>): void;
}) {
  onConnection(useConnection());
  return null;
}

function ThreadTitleProbe() {
  const { state } = useConnection();
  return <span>{state.snapshot?.threads[0]?.title ?? "none"}</span>;
}

function DraftProbe({
  onConnection,
  flushOnUnmount = false,
}: {
  onConnection(value: ReturnType<typeof useConnection>): void;
  flushOnUnmount?: boolean;
}) {
  const connection = useConnection();
  const flush = connection.flushUserInputDraft;
  onConnection(connection);
  useEffect(
    () => () => {
      if (flushOnUnmount) flush("questions");
    },
    [flush, flushOnUnmount],
  );
  const draft = connection.state.userInputDrafts.questions;
  return (
    <>
      <span>{draft?.answers.first?.[0] ?? "empty"}</span>
      <span role="status">{draft?.error ?? "ok"}</span>
    </>
  );
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  receive(frame: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}
