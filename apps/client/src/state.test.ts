import { describe, expect, it } from "vitest";

import type {
  VoiceTranscriptionJob,
  ActivityItem,
  AppSnapshot,
  ThreadDetail,
  ThreadSummary,
} from "@codexnest/protocol";

import { clientReducer, initialState, sortThreads } from "./state";
import { forkOperationsFromSnapshot, type ForkOperationSummary } from "./forks";

const baseThread: ThreadSummary = {
  id: "one",
  relation: { kind: "session", sessionId: "session" },
  projectId: null,
  title: "One",
  preview: "",
  cwd: "/work",
  state: "running",
  unread: false,
  unseen: false,
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  currentTurnId: "turn",
  queuedMessageCount: 0,
  browserStatus: "disabled",
  settings: { collaborationMode: "default" },
};

const snapshot: AppSnapshot = {
  instanceId: "legacy",
  sequence: 4,
  uiLanguage: "ru",
  connection: { state: "ready", message: null, syncedAt: null },
  projects: [],
  threads: [baseThread],
  forkOperations: [],
  attention: [],
  models: [],
};

describe("clientReducer", () => {
  it("updates native permissions from the global stream without polling", () => {
    const permissionSettings = {
      preset: "full-access" as const,
      version: "2",
      overridden: false,
      message: null,
    };
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: { type: "permissions.changed", permissionSettings },
    });
    expect(state.snapshot?.permissionSettings).toEqual(permissionSettings);
  });

  it("keeps a durable steer visible in the active turn until its native user echo arrives", () => {
    const message = {
      id: "steered",
      threadId: "one",
      text: "Уточнение",
      images: [],
      createdAt: 10,
    };
    const admission = {
      ...message,
      deliveryMode: "steer" as const,
      status: "dispatching" as const,
    };
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "optimistic.add",
      message: { ...message, destination: "turn", turnId: "turn" },
    });
    state = clientReducer(state, {
      type: "detail",
      detail: {
        summary: baseThread,
        turns: [turn("turn")],
        queuedMessages: [admission],
        olderTurnsCursor: null,
      },
    });
    expect(state.optimisticMessages.one?.[0]?.id).toBe("steered");
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: { type: "queue.changed", threadId: "one", messages: [admission] },
    });
    expect(state.optimisticMessages.one?.[0]?.id).toBe("steered");
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 6 },
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "turn",
        item: { ...message, type: "userMessage", status: "completed", timestamp: 10, phase: null },
      },
    });
    expect(state.optimisticMessages.one).toBeUndefined();
    expect(state.details.one?.queuedMessages).toEqual([]);
    expect(state.details.one?.turns[0]?.items.map((item) => item.id)).toContain("steered");
  });

  it("merges transcripts into dirty question answers once, including after a late save acknowledgement", () => {
    const job: VoiceTranscriptionJob = {
      id: "voice",
      threadId: "one",
      mode: "draft",
      userInput: { draftKey: "a".repeat(64), questionId: "first", order: 1 },
      status: "completed",
      transcript: "голос",
      createdAt: 1,
      startedAt: 2,
      audioDurationMs: 1000,
      estimatedTotalSeconds: 1,
      error: null,
    };
    const request = userInputAttention({
      answers: { first: ["Старый"] },
      currentQuestionId: "first",
      revision: 1,
      updatedAt: 1,
    });
    let state = clientReducer(initialState, {
      type: "snapshot",
      snapshot: { ...snapshot, attention: [request] },
    });
    state = clientReducer(state, {
      type: "userInputDraft.edit",
      attentionId: request.id,
      version: 1,
      draft: {
        answers: { first: ["Правка"], second: ["Другой ответ"] },
        currentQuestionId: "second",
      },
    });
    const updated = {
      ...request,
      draft: {
        answers: { first: ["Старый голос"] },
        currentQuestionId: "first",
        revision: 2,
        updatedAt: 2,
        recordings: [job],
        appliedRecordingIds: [job.id],
      },
    };
    for (const sequence of [5, 6])
      state = clientReducer(state, {
        type: "event",
        version: { instanceId: "legacy", sequence },
        event: { type: "attention.upserted", attention: updated },
      });
    expect(state.userInputDrafts[request.id]?.answers).toEqual({
      first: ["Правка голос"],
      second: ["Другой ответ"],
    });
    state = clientReducer(state, {
      type: "userInputDraft.saved",
      attentionId: request.id,
      version: 1,
      draft: {
        answers: { first: ["Правка"], second: ["Другой ответ"] },
        currentQuestionId: "second",
        revision: 1,
        updatedAt: 1,
      },
    });
    expect(state.userInputDrafts[request.id]?.answers).toEqual({
      first: ["Правка голос"],
      second: ["Другой ответ"],
    });
    expect(state.userInputDrafts[request.id]?.appliedRecordingIds).toEqual([job.id]);
  });

  it("moves a reused plan ID after its clarification and starts a fresh streaming revision", () => {
    const plan: ActivityItem = {
      type: "plan",
      id: "plan",
      text: "Original",
      status: "completed",
      timestamp: 10,
      images: [],
      phase: null,
    };
    const reply: ActivityItem = {
      ...plan,
      type: "userMessage",
      id: "reply",
      text: "Broaden scope",
      timestamp: 20,
    };
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "detail",
      detail: {
        summary: baseThread,
        queuedMessages: [],
        olderTurnsCursor: null,
        turns: [{ ...turn("turn"), items: [plan, reply] }],
      },
    });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "turn",
        item: { ...plan, status: "inProgress", text: "", timestamp: 30 },
      },
    });
    expect(state.details.one?.turns[0]?.items.map((item) => item.id)).toEqual(["reply", "plan"]);
    expect(state.details.one?.turns[0]?.items[1]).toMatchObject({ status: "inProgress", text: "" });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 6 },
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "turn",
        item: { ...plan, text: "Revised", timestamp: 40 },
      },
    });
    expect(state.details.one?.turns[0]?.items.map((item) => item.id)).toEqual(["reply", "plan"]);
    expect(state.details.one?.turns[0]?.items[1]).toMatchObject({
      status: "completed",
      text: "Revised",
    });
  });
  it("restores cached limits and applies only current, ordered server updates", () => {
    const codexRateLimits = {
      limits: {
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: null },
        secondary: null,
      },
      updatedAt: 1000,
      refreshing: false,
      refreshError: false,
    };
    let state = clientReducer(initialState, {
      type: "hydrate",
      snapshot: { ...snapshot, codexRateLimits },
      goals: {},
    });
    expect(state.snapshot?.codexRateLimits).toEqual(codexRateLimits);
    const event = {
      type: "codexRateLimits.changed" as const,
      codexRateLimits: { ...codexRateLimits, refreshError: true },
    };
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event,
    });
    expect(state.snapshot?.codexRateLimits).toEqual(event.codexRateLimits);
    expect(state.snapshot?.sequence).toBe(5);
    for (const version of [
      { instanceId: "legacy", sequence: 4 },
      { instanceId: "old", sequence: 6 },
    ]) {
      expect(clientReducer(state, { type: "event", version, event })).toBe(state);
    }
    state = clientReducer(state, {
      type: "snapshot",
      snapshot: { ...snapshot, sequence: 6, codexRateLimits },
    });
    expect(state.snapshot?.codexRateLimits).toEqual(codexRateLimits);
    state = clientReducer(state, { type: "network", network: "offline" });
    expect(state.snapshot?.codexRateLimits).toEqual(codexRateLimits);
  });

  it("keeps cached messages and the history cursor when a partial history read fails", () => {
    const original: ThreadDetail = {
      summary: baseThread,
      turns: [
        {
          ...turn("turn"),
          items: [
            {
              type: "userMessage",
              id: "accepted",
              text: "Не терять",
              images: [],
              status: "completed",
              timestamp: 1,
              phase: null,
            },
          ],
        },
      ],
      queuedMessages: [],
      olderTurnsCursor: "older",
    };
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, { type: "detail", detail: original });
    state = clientReducer(state, {
      type: "detail",
      detail: {
        ...original,
        turns: [],
        olderTurnsCursor: null,
        historyError: { message: "Unavailable", retryable: true },
      },
    });
    expect(state.details.one?.turns).toEqual(original.turns);
    expect(state.details.one?.olderTurnsCursor).toBe("older");
    expect(state.details.one?.historyError?.retryable).toBe(true);
  });

  it("keeps newer quiz answers and streamed text when a delayed technical read arrives", () => {
    const before: ActivityItem = {
      type: "agentMessage",
      id: "before",
      text: "Уточню восстановление",
      status: "completed",
      phase: "commentary",
      images: [],
      timestamp: 10,
    };
    const response: ActivityItem = {
      type: "userInputResponse",
      id: "response",
      status: "completed",
      entries: [{ header: "Вопрос", question: "Как?", answers: ["Что случилось?"] }],
      timestamp: 20,
      afterItemId: "before",
    };
    const reply: ActivityItem = {
      type: "agentMessage",
      id: "reply",
      text: "Не Titan целиком",
      status: "inProgress",
      phase: "commentary",
      images: [],
      timestamp: 21,
    };
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "detail",
      detail: {
        summary: baseThread,
        turns: [{ ...turn("turn"), status: "inProgress", itemsLoaded: false, items: [before] }],
        queuedMessages: [],
        olderTurnsCursor: null,
      },
    });
    // The assistant can start streaming before the quiz response is persisted and published.
    for (const [index, item] of [reply, response].entries()) {
      state = clientReducer(state, {
        type: "event",
        version: { instanceId: "legacy", sequence: 5 + index },
        event: { type: "activity.upserted", threadId: "one", turnId: "turn", item },
      });
    }
    const expected = ["before", "response", "reply"];
    expect(state.details.one?.turns[0]?.items.map((item) => item.id)).toEqual(expected);
    state = clientReducer(state, {
      type: "turn.items",
      threadId: "one",
      turnId: "turn",
      items: [before, { ...reply, text: "Не Titan" }],
    });
    const loaded = state.details.one!.turns[0]!;
    expect(loaded.itemsLoaded).toBe(true);
    expect(loaded.items.map((item) => item.id)).toEqual(expected);
    expect(loaded.items.at(-1)).toMatchObject({ text: "Не Titan целиком" });
    state = clientReducer(state, {
      type: "detail",
      detail: { summary: baseThread, turns: [loaded], queuedMessages: [], olderTurnsCursor: null },
    });
    expect(state.details.one?.turns[0]?.items.map((item) => item.id)).toEqual(expected);
  });

  it("remaps quiz anchors on full history loads without collapsing identical independent replies", () => {
    const first: ActivityItem = {
      type: "agentMessage",
      id: "first",
      status: "completed",
      phase: "commentary",
      text: "Да",
      images: [],
      timestamp: 10,
    };
    const second = { ...first, id: "stream-second", timestamp: 20 };
    const response: ActivityItem = {
      type: "userInputResponse",
      id: "response",
      status: "completed",
      entries: [],
      timestamp: 30,
      afterItemId: second.id,
    };
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "detail",
      detail: {
        summary: baseThread,
        turns: [{ ...turn("turn"), itemsLoaded: false, items: [first, second, response] }],
        queuedMessages: [],
        olderTurnsCursor: null,
      },
    });
    state = clientReducer(state, {
      type: "turn.items",
      threadId: "one",
      turnId: "turn",
      items: [first, { ...second, id: "canonical-second" }],
    });
    expect(state.details.one?.turns[0]?.items.map((item) => item.id)).toEqual([
      "first",
      "canonical-second",
      "response",
    ]);
    expect(state.details.one?.turns[0]?.items.at(-1)).toMatchObject({
      afterItemId: "canonical-second",
    });
  });

  it("clears unversioned projection data on the first backend snapshot", () => {
    const dirty = {
      ...initialState,
      details: {
        old: { summary: baseThread, turns: [], queuedMessages: [], olderTurnsCursor: null },
      },
    };
    const next = clientReducer(dirty, { type: "snapshot", snapshot });
    expect(next.snapshot).toEqual(snapshot);
    expect(next.network).toBe("connected");
    expect(next.details.old).toBeUndefined();
  });

  it("replaces cached sessions with the first authoritative backend instance", () => {
    const cached = { ...snapshot, instanceId: "cached", sequence: 40, threads: [baseThread] };
    let state = clientReducer(initialState, { type: "hydrate", snapshot: cached, goals: {} });
    state = clientReducer(state, {
      type: "snapshot",
      snapshot: { ...snapshot, sequence: 1, threads: [] },
    });
    expect(state.snapshot?.threads).toEqual([]);
    expect(state.snapshot?.sequence).toBe(1);

    state = clientReducer(state, {
      type: "snapshot",
      snapshot: {
        ...snapshot,
        sequence: 2,
        connection: { ...snapshot.connection, syncedAt: "2026-08-03T00:00:00.000Z" },
        threads: [],
      },
    });
    expect(state.snapshot?.threads).toEqual([]);
  });

  it("hydrates and applies newer complete user-input drafts including the current question", () => {
    const request = userInputAttention({
      answers: { second: ["С сервера"] },
      currentQuestionId: "second",
      revision: 2,
      updatedAt: 20,
    });
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "snapshot",
      snapshot: { ...snapshot, attention: [request] },
    });
    expect(state.userInputDrafts.questions).toMatchObject({
      answers: { second: ["С сервера"] },
      currentQuestionId: "second",
      serverRevision: 2,
    });

    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: {
        type: "attention.upserted",
        attention: {
          ...request,
          draft: {
            answers: { first: ["Новый ответ"] },
            currentQuestionId: "first",
            revision: 3,
            updatedAt: 30,
          },
        },
      },
    });
    expect(state.userInputDrafts.questions).toMatchObject({
      answers: { first: ["Новый ответ"] },
      currentQuestionId: "first",
      serverRevision: 3,
    });
  });

  it("clears a clean revisioned user-input draft when an authoritative snapshot or event has null", () => {
    const request = userInputAttention({
      answers: { first: ["Сохранённый"] },
      currentQuestionId: "first",
      revision: 2,
      updatedAt: 20,
    });
    let state = clientReducer(initialState, {
      type: "snapshot",
      snapshot: { ...snapshot, attention: [request] },
    });
    expect(state.userInputDrafts.questions?.serverRevision).toBe(2);

    state = clientReducer(state, {
      type: "snapshot",
      snapshot: { ...snapshot, sequence: 5, attention: [{ ...request, draft: null }] },
    });
    expect(state.userInputDrafts.questions).toBeUndefined();

    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 6 },
      event: { type: "attention.upserted", attention: request },
    });
    expect(state.userInputDrafts.questions?.serverRevision).toBe(2);
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 7 },
      event: {
        type: "attention.upserted",
        attention: { ...request, draft: null },
      },
    });
    expect(state.userInputDrafts.questions).toBeUndefined();
  });

  it("retains a dirty local user-input draft against an authoritative null draft", () => {
    const request = userInputAttention({
      answers: { first: ["Сохранённый"] },
      currentQuestionId: "first",
      revision: 2,
      updatedAt: 20,
    });
    let state = clientReducer(initialState, {
      type: "snapshot",
      snapshot: { ...snapshot, attention: [request] },
    });
    state = clientReducer(state, {
      type: "userInputDraft.edit",
      attentionId: "questions",
      version: 1,
      draft: { answers: { second: ["Локальный"] }, currentQuestionId: "second" },
    });

    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: {
        type: "attention.upserted",
        attention: { ...request, draft: null },
      },
    });
    expect(state.userInputDrafts.questions).toMatchObject({
      answers: { second: ["Локальный"] },
      currentQuestionId: "second",
      localVersion: 1,
      savedVersion: 0,
    });

    state = clientReducer(state, {
      type: "snapshot",
      snapshot: { ...snapshot, sequence: 6, attention: [{ ...request, draft: null }] },
    });
    expect(state.userInputDrafts.questions).toMatchObject({
      answers: { second: ["Локальный"] },
      currentQuestionId: "second",
      localVersion: 1,
      savedVersion: 0,
    });
  });

  it("protects dirty user-input drafts from remote echoes, then accepts remote state when clean", () => {
    const request = userInputAttention({
      answers: { first: ["Старый"] },
      currentQuestionId: "first",
      revision: 1,
      updatedAt: 10,
    });
    let state = clientReducer(initialState, {
      type: "snapshot",
      snapshot: { ...snapshot, attention: [request] },
    });
    state = clientReducer(state, {
      type: "userInputDraft.edit",
      attentionId: "questions",
      version: 1,
      draft: { answers: { second: ["Локальный"] }, currentQuestionId: "second" },
    });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: {
        type: "attention.upserted",
        attention: {
          ...request,
          draft: {
            answers: { first: ["Удалённый"] },
            currentQuestionId: "first",
            revision: 2,
            updatedAt: 20,
          },
        },
      },
    });
    expect(state.userInputDrafts.questions).toMatchObject({
      answers: { second: ["Локальный"] },
      currentQuestionId: "second",
      serverRevision: 2,
      localVersion: 1,
      savedVersion: 0,
    });

    state = clientReducer(state, {
      type: "userInputDraft.saved",
      attentionId: "questions",
      version: 1,
      draft: {
        answers: { second: ["Локальный"] },
        currentQuestionId: "second",
        revision: 3,
        updatedAt: 30,
      },
    });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 6 },
      event: {
        type: "attention.upserted",
        attention: {
          ...request,
          draft: {
            answers: {},
            currentQuestionId: "first",
            revision: 4,
            updatedAt: 40,
          },
        },
      },
    });
    expect(state.userInputDrafts.questions).toMatchObject({
      answers: {},
      currentQuestionId: "first",
      serverRevision: 4,
    });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 7 },
      event: { type: "attention.removed", attentionId: "questions" },
    });
    expect(state.userInputDrafts.questions).toBeUndefined();
  });

  it("appends compact activity deltas without replacing the whole item", () => {
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "detail",
      page: "latest",
      detail: {
        summary: baseThread,
        turns: [
          {
            ...turn("turn"),
            status: "inProgress",
            itemsLoaded: false,
            items: [
              {
                type: "agentMessage",
                id: "answer",
                status: "inProgress",
                text: "Начало",
                images: [],
                timestamp: 1,
                phase: "commentary",
              },
            ],
          },
        ],
        queuedMessages: [],
        olderTurnsCursor: null,
      },
    });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: {
        type: "activity.delta",
        threadId: "one",
        turnId: "turn",
        itemId: "answer",
        activityType: "agentMessage",
        delta: " ответа",
      },
    });
    expect(state.details.one?.turns[0]?.items[0]).toMatchObject({ text: "Начало ответа" });
  });

  it("replaces turn items with each authoritative server response", () => {
    const user = {
      type: "userMessage" as const,
      id: "user",
      status: "completed" as const,
      text: "Запрос",
      images: [],
      timestamp: 1,
      phase: null,
    };
    const answer = {
      type: "agentMessage" as const,
      id: "answer",
      status: "completed" as const,
      text: "Ответ",
      images: [],
      timestamp: 2,
      phase: "final_answer" as const,
    };
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "detail",
      page: "latest",
      detail: {
        summary: baseThread,
        turns: [{ ...turn("turn"), itemsLoaded: false, items: [user, answer] }],
        queuedMessages: [],
        olderTurnsCursor: null,
      },
    });
    state = clientReducer(state, {
      type: "turn.items",
      threadId: "one",
      turnId: "turn",
      items: [
        { ...user, timestamp: null },
        {
          type: "command",
          id: "command",
          status: "completed",
          kind: "command",
          command: "pwd",
          cwd: "/work",
          output: "/work",
          exitCode: 0,
        },
        { ...answer, timestamp: null },
      ],
    });
    expect(state.details.one?.turns[0]?.items.map((item) => item.id)).toEqual([
      "user",
      "command",
      "answer",
    ]);
    expect(state.details.one?.turns[0]?.itemsLoaded).toBe(true);

    state = clientReducer(state, {
      type: "detail",
      detail: {
        version: { instanceId: "legacy", sequence: 5 },
        summary: baseThread,
        turns: [{ ...turn("turn"), itemsLoaded: false, items: [user, answer] }],
        queuedMessages: [],
        olderTurnsCursor: null,
      },
    });
    expect(state.details.one?.turns[0]?.items.map((item) => item.id)).toEqual(["user", "answer"]);
    expect(state.details.one?.turns[0]?.itemsLoaded).toBe(false);
  });

  it("tracks the reasoning effort used for new sessions", () => {
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: { type: "defaultReasoningEffort.changed", reasoningEffort: "high" },
    });
    expect(state.snapshot?.defaultReasoningEffort).toBe("high");

    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 6 },
      event: { type: "defaultReasoningEffort.changed", reasoningEffort: null },
    });
    expect(state.snapshot?.defaultReasoningEffort).toBeUndefined();
  });

  it("applies the server-synchronized interface language", () => {
    const state = clientReducer(clientReducer(initialState, { type: "snapshot", snapshot }), {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: { type: "uiLanguage.changed", language: "en" },
    });

    expect(state.snapshot?.uiLanguage).toBe("en");
    expect(state.snapshot?.sequence).toBe(5);
  });

  it("invalidates loaded thread details when the server requires a resync", () => {
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    const epoch = state.snapshotEpoch;

    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: { type: "resync.required" },
    });

    expect(state.snapshot?.sequence).toBe(5);
    expect(state.snapshotEpoch).toBe(epoch + 1);
  });

  it("increments the skills revision for skills.changed events", () => {
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    const epoch = state.skillsEpoch;

    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: { type: "skills.changed" },
    });

    expect(state.snapshot?.sequence).toBe(5);
    expect(state.skillsEpoch).toBe(epoch + 1);
  });

  it("upserts and removes fork operations from streamed events", () => {
    const operation: ForkOperationSummary = {
      id: "fork",
      sourceThreadId: "one",
      lastTurnId: "turn",
      agentMessageId: "answer",
      mode: "compressed",
      status: "preparing",
      title: "",
      createdAt: 1,
      updatedAt: 1,
      targetThreadId: null,
      queuedMessageCount: 0,
      estimate: null,
      error: null,
    };
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: { type: "forkOperation.upserted", operation } as never,
    });
    expect(forkOperationsFromSnapshot(state.snapshot)).toEqual([operation]);

    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 6 },
      event: { type: "forkOperation.removed", operationId: operation.id } as never,
    });
    expect(forkOperationsFromSnapshot(state.snapshot)).toEqual([]);
  });

  it("applies task defaults and native goal events without polling", () => {
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: {
        type: "taskDefaults.changed",
        taskDefaults: { serviceTier: "fast", personality: "friendly" },
      },
    });
    const goal = {
      threadId: "one",
      objective: "Завершить задачу",
      status: "active" as const,
      tokenBudget: null,
      tokensUsed: 10,
      timeUsedSeconds: 2,
      createdAt: 1,
      updatedAt: 2,
    };
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 6 },
      event: { type: "goal.changed", threadId: "one", goal },
    });

    expect(state.snapshot?.taskDefaults).toEqual({
      serviceTier: "fast",
      personality: "friendly",
    });
    expect(state.goals.one).toEqual(goal);
  });

  it("tracks durable voice jobs from responses and server events", () => {
    const job = {
      id: "voice",
      threadId: "one",
      mode: "draft" as const,
      status: "queued" as const,
      createdAt: 10,
      startedAt: null,
      audioDurationMs: 2_000,
      estimatedTotalSeconds: null,
      error: null,
    };
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, { type: "voice.accepted", job });
    expect(state.snapshot?.voiceTranscriptions).toEqual([job]);

    const transcribing = { ...job, status: "transcribing" as const, startedAt: 11 };
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: { type: "voiceTranscription.upserted", job: transcribing },
    });
    expect(state.snapshot?.voiceTranscriptions).toEqual([transcribing]);

    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 6 },
      event: {
        type: "voiceTranscription.removed",
        threadId: "one",
        jobId: "voice",
        outcome: "draft",
      },
    });
    expect(state.snapshot?.voiceTranscriptions).toEqual([]);
    expect(state.voiceRemovals.one).toEqual({ jobId: "voice", outcome: "draft" });

    state = clientReducer(state, { type: "voice.accepted", job });
    expect(state.snapshot?.voiceTranscriptions).toEqual([]);
  });

  it("does not let a late upload acknowledgement roll transcription back to queued", () => {
    const queued = {
      id: "voice",
      threadId: "one",
      mode: "draft" as const,
      status: "queued" as const,
      createdAt: 10,
      startedAt: null,
      audioDurationMs: 2_000,
      estimatedTotalSeconds: null,
      error: null,
    };
    const transcribing = { ...queued, status: "transcribing" as const, startedAt: 11 };
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: { type: "voiceTranscription.upserted", job: transcribing },
    });

    state = clientReducer(state, { type: "voice.accepted", job: queued });

    expect(state.snapshot?.voiceTranscriptions).toEqual([transcribing]);
  });

  it("replaces an item completion after ordered streaming deltas", () => {
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "detail",
      detail: {
        summary: baseThread,
        turns: [
          {
            id: "turn",
            status: "inProgress",
            startedAt: null,
            completedAt: null,
            durationMs: null,
            progress: {
              startedAt: null,
              explanation: null,
              steps: [],
              filesChanged: 0,
              additions: 0,
              deletions: 0,
            },
            items: [],
          },
        ],
        queuedMessages: [],
        olderTurnsCursor: null,
      },
      page: "latest",
    });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "turn",
        item: {
          type: "agentMessage",
          id: "item",
          status: "inProgress",
          text: "Прив",
          images: [],
          timestamp: 1,
          phase: "commentary",
        },
      },
    });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 6 },
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "turn",
        item: {
          type: "agentMessage",
          id: "item",
          status: "completed",
          text: "Привет",
          images: [],
          timestamp: 2,
          phase: "final_answer",
        },
      },
    });
    expect(state.details.one?.turns[0]?.items).toEqual([
      {
        type: "agentMessage",
        id: "item",
        status: "completed",
        text: "Привет",
        images: [],
        timestamp: 2,
        phase: "final_answer",
      },
    ]);
  });

  it("reconciles a late live completion after canonical active detail", () => {
    const live = {
      type: "agentMessage" as const,
      id: "msg-live",
      status: "completed" as const,
      text: "Готово",
      images: [],
      timestamp: 2,
      phase: "final_answer" as const,
    };
    const canonical = {
      ...live,
      id: "item-20",
    };
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "detail",
      detail: {
        summary: baseThread,
        turns: [
          {
            ...turn("turn"),
            status: "inProgress",
            completedAt: null,
            items: [canonical],
            itemsLoaded: true,
          },
        ],
        queuedMessages: [],
        olderTurnsCursor: null,
      },
    });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "turn",
        item: live,
      },
    });

    expect(state.details.one?.turns[0]?.items).toEqual([canonical]);
  });

  it("reconciles canonical active detail after a live completion", () => {
    const live = {
      type: "agentMessage" as const,
      id: "msg-live",
      status: "completed" as const,
      text: "Готово",
      images: [],
      timestamp: 2,
      phase: "commentary" as const,
    };
    const canonical = { ...live, id: "item-20" };
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "turn",
        item: live,
      },
    });
    state = clientReducer(state, {
      type: "detail",
      detail: {
        summary: baseThread,
        turns: [
          {
            ...turn("turn"),
            status: "inProgress",
            completedAt: null,
            items: [canonical],
            itemsLoaded: true,
          },
        ],
        queuedMessages: [],
        olderTurnsCursor: null,
      },
    });

    expect(state.details.one?.turns[0]?.items).toEqual([canonical]);
  });

  it("reconciles a full late live lifecycle after canonical active detail", () => {
    const canonical = {
      type: "agentMessage" as const,
      id: "item-20",
      status: "completed" as const,
      text: "Готово",
      images: [],
      timestamp: 2,
      phase: "commentary" as const,
    };
    const liveId = "msg-live";
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "detail",
      detail: {
        summary: baseThread,
        turns: [
          {
            ...turn("turn"),
            status: "inProgress",
            completedAt: null,
            items: [canonical],
            itemsLoaded: true,
          },
        ],
        queuedMessages: [],
        olderTurnsCursor: null,
      },
    });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "turn",
        item: { ...canonical, id: liveId, status: "inProgress", text: "" },
      },
    });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 6 },
      event: {
        type: "activity.delta",
        threadId: "one",
        turnId: "turn",
        itemId: liveId,
        activityType: "agentMessage",
        delta: "Готово",
      },
    });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 7 },
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "turn",
        item: { ...canonical, id: liveId },
      },
    });

    expect(state.details.one?.turns[0]?.items).toEqual([canonical]);
  });

  it("heals a late live alias on the next canonical detail", () => {
    const canonical = {
      type: "agentMessage" as const,
      id: "item-20",
      status: "completed" as const,
      text: "Готово",
      images: [],
      timestamp: 2,
      phase: "commentary" as const,
    };
    const live = { ...canonical, id: "msg-live" };
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "detail",
      detail: {
        summary: baseThread,
        turns: [
          {
            ...turn("turn"),
            status: "inProgress",
            completedAt: null,
            items: [canonical, live],
            itemsLoaded: true,
          },
        ],
        queuedMessages: [],
        olderTurnsCursor: null,
      },
    });
    state = clientReducer(state, {
      type: "detail",
      detail: {
        summary: baseThread,
        turns: [
          {
            ...turn("turn"),
            status: "inProgress",
            completedAt: null,
            items: [canonical],
            itemsLoaded: true,
          },
        ],
        queuedMessages: [],
        olderTurnsCursor: null,
      },
    });

    expect(state.details.one?.turns[0]?.items).toEqual([canonical]);
  });

  it("preserves identical items when both are present in canonical detail", () => {
    const first = {
      type: "agentMessage" as const,
      id: "item-20",
      status: "completed" as const,
      text: "Повтор",
      images: [],
      timestamp: 2,
      phase: "commentary" as const,
    };
    const second = { ...first, id: "item-21" };
    const canonicalDetail = {
      summary: baseThread,
      turns: [{ ...turn("turn"), items: [first, second], itemsLoaded: true }],
      queuedMessages: [],
      olderTurnsCursor: null,
    };
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    for (const [sequence, id] of [
      [5, "msg-live-first"],
      [6, "msg-live-second"],
    ] as const) {
      state = clientReducer(state, {
        type: "event",
        version: { instanceId: "legacy", sequence },
        event: {
          type: "activity.upserted",
          threadId: "one",
          turnId: "turn",
          item: { ...first, id },
        },
      });
    }
    expect(state.details.one?.turns[0]?.items).toHaveLength(1);
    state = clientReducer(state, { type: "detail", detail: canonicalDetail });
    expect(state.details.one?.turns[0]?.items).toEqual([first, second]);
    state = clientReducer(state, { type: "detail", detail: canonicalDetail });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 7 },
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "turn",
        item: first,
      },
    });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 8 },
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "turn",
        item: { ...first, id: "msg-live" },
      },
    });

    expect(state.details.one?.turns[0]?.items).toEqual([first, second]);
  });

  it("keeps loaded completions with different phases", () => {
    const canonical = {
      type: "agentMessage" as const,
      id: "item-20",
      status: "completed" as const,
      text: "Одинаковый текст",
      images: [],
      timestamp: 2,
      phase: "commentary" as const,
    };
    const finalAnswer = { ...canonical, id: "msg-live", phase: "final_answer" as const };
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "detail",
      detail: {
        summary: baseThread,
        turns: [{ ...turn("turn"), items: [canonical], itemsLoaded: true }],
        queuedMessages: [],
        olderTurnsCursor: null,
      },
    });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "turn",
        item: finalAnswer,
      },
    });

    expect(state.details.one?.turns[0]?.items).toEqual([canonical, finalAnswer]);
  });

  it("replaces cached live aliases with the authoritative turn", () => {
    const commentary = {
      type: "agentMessage" as const,
      id: "live-commentary",
      status: "completed" as const,
      text: "Одинаковый текст",
      images: [],
      timestamp: 2,
      phase: "commentary" as const,
    };
    const finalAnswer = {
      ...commentary,
      id: "canonical-final",
      phase: "final_answer" as const,
    };
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "detail",
      detail: {
        summary: baseThread,
        turns: [{ ...turn("turn"), items: [commentary, finalAnswer], itemsLoaded: true }],
        queuedMessages: [],
        olderTurnsCursor: null,
      },
    });

    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: {
        type: "turn.replaced",
        threadId: "one",
        turn: { ...turn("turn"), items: [finalAnswer], itemsLoaded: true },
      },
    });

    expect(state.details.one?.turns[0]?.items).toEqual([finalAnswer]);
    expect(state.details.one?.version).toEqual({ instanceId: "legacy", sequence: 5 });
  });

  it("reconciles identical live completions before canonical items load", () => {
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "detail",
      detail: {
        summary: baseThread,
        turns: [
          {
            ...turn("turn"),
            status: "inProgress",
            completedAt: null,
            itemsLoaded: false,
          },
        ],
        queuedMessages: [],
        olderTurnsCursor: null,
      },
    });

    for (const [sequence, id, phase] of [
      [5, "first", "commentary"],
      [6, "second", "final_answer"],
    ] as const) {
      state = clientReducer(state, {
        type: "event",
        version: { instanceId: "legacy", sequence },
        event: {
          type: "activity.upserted",
          threadId: "one",
          turnId: "turn",
          item: {
            type: "agentMessage",
            id,
            status: "completed",
            text: "Повтор",
            images: [],
            timestamp: sequence,
            phase,
          },
        },
      });
    }

    expect(state.details.one?.turns[0]?.items.map((item) => item.id)).toEqual(["first"]);
  });

  it("inserts delayed activities by timestamp without disturbing untimed activities", () => {
    const message = (id: string, timestamp: number | null) => ({
      type: "agentMessage" as const,
      id,
      status: "completed" as const,
      text: id,
      images: [],
      timestamp,
      phase: "commentary" as const,
    });
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "detail",
      detail: {
        summary: baseThread,
        turns: [
          {
            ...turn("turn"),
            status: "inProgress",
            completedAt: null,
            items: [
              message("+50", 31),
              {
                type: "command",
                id: "command",
                status: "completed",
                kind: "command",
                command: "true",
                cwd: null,
                output: "",
                exitCode: 0,
              },
              message("+55", 36),
            ],
          },
        ],
        queuedMessages: [],
        olderTurnsCursor: null,
      },
      page: "latest",
    });

    for (const [sequence, item] of [
      [5, message("+40", 20)],
      [6, message("same-time", 36)],
      [7, message("unknown-time", null)],
    ] as const) {
      state = clientReducer(state, {
        type: "event",
        version: { instanceId: "legacy", sequence },
        event: { type: "activity.upserted", threadId: "one", turnId: "turn", item },
      });
    }

    expect(state.details.one?.turns[0]?.items.map((item) => item.id)).toEqual([
      "+40",
      "+50",
      "command",
      "+55",
      "same-time",
      "unknown-time",
    ]);
  });

  it("keeps the first user message ahead of a response that streamed before it", () => {
    const userMessage = (id: string, timestamp: number) => ({
      type: "userMessage" as const,
      id,
      status: "completed" as const,
      text: id,
      images: [],
      timestamp,
      phase: null,
    });
    const streamedResponse = {
      type: "agentMessage" as const,
      id: "answer",
      status: "inProgress" as const,
      text: "Ответ",
      images: [],
      timestamp: 100,
      phase: null,
    };
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "detail",
      detail: {
        summary: baseThread,
        turns: [
          {
            ...turn("turn"),
            status: "inProgress",
            completedAt: null,
            items: [streamedResponse],
          },
        ],
        queuedMessages: [],
        olderTurnsCursor: null,
      },
      page: "latest",
    });

    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "turn",
        item: userMessage("question", 101),
      },
    });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 6 },
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "turn",
        item: {
          ...streamedResponse,
          status: "completed",
          timestamp: 140,
          phase: "final_answer",
        },
      },
    });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 7 },
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "turn",
        item: userMessage("steer", 120),
      },
    });

    expect(state.details.one?.turns[0]?.items.map((item) => item.id)).toEqual([
      "question",
      "steer",
      "answer",
    ]);
  });

  it("applies server-owned settings to the list and loaded detail", () => {
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "detail",
      detail: { summary: baseThread, turns: [], queuedMessages: [], olderTurnsCursor: null },
      page: "latest",
    });
    const updated = {
      ...baseThread,
      settings: { collaborationMode: "plan" as const, model: "gpt" },
    };
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: { type: "thread.upserted", thread: updated },
    });
    expect(state.snapshot?.threads[0]?.settings).toEqual(updated.settings);
    expect(state.details.one?.summary.settings).toEqual(updated.settings);
  });

  it("applies the server-owned project order", () => {
    const one = {
      id: "one",
      displayName: "One",
      path: "/one",
      createdAt: "x",
      updatedAt: "x",
    };
    const two = { ...one, id: "two", displayName: "Two", path: "/two" };
    let state = clientReducer(initialState, {
      type: "snapshot",
      snapshot: { ...snapshot, projects: [one, two] },
    });

    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: { type: "projects.reordered", projects: [two, one] },
    });

    expect(state.snapshot?.projects.map((project) => project.id)).toEqual(["two", "one"]);
  });

  it("removes a project and all of its session state atomically", () => {
    const project = {
      id: "project",
      displayName: "Project",
      path: "/work",
      createdAt: "x",
      updatedAt: "x",
    };
    const projectThread = { ...baseThread, projectId: project.id };
    const unrelated = { ...baseThread, id: "other", projectId: null };
    let state = clientReducer(initialState, {
      type: "snapshot",
      snapshot: { ...snapshot, projects: [project], threads: [projectThread, unrelated] },
    });
    state = clientReducer(state, {
      type: "detail",
      detail: { summary: projectThread, turns: [], queuedMessages: [], olderTurnsCursor: null },
      page: "latest",
    });

    state = clientReducer(state, {
      type: "project.remove",
      projectId: project.id,
      threadIds: [projectThread.id],
    });

    expect(state.snapshot?.projects).toEqual([]);
    expect(state.snapshot?.threads).toEqual([unrelated]);
    expect(state.details[projectThread.id]).toBeUndefined();
  });

  it("applies live progress and the server-owned message queue", () => {
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "detail",
      detail: { summary: baseThread, turns: [], queuedMessages: [], olderTurnsCursor: null },
      page: "latest",
    });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: {
        type: "turn.progressed",
        threadId: "one",
        turnId: "turn",
        progress: {
          startedAt: 1,
          explanation: "Выполняю",
          steps: [{ step: "Проверка", status: "inProgress" }],
          filesChanged: 2,
          additions: 3,
          deletions: 1,
        },
      },
    });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 6 },
      event: {
        type: "queue.changed",
        threadId: "one",
        messages: [
          {
            id: "queued",
            threadId: "one",
            text: "Следом",
            createdAt: 2,
            status: "queued",
          },
        ],
      },
    });

    expect(state.details.one?.turns[0]?.progress.steps[0]?.step).toBe("Проверка");
    expect(state.details.one?.queuedMessages[0]?.text).toBe("Следом");
  });

  it("replaces inherited history when a subagent detail refreshes", () => {
    const subagent: ThreadSummary = {
      ...baseThread,
      relation: {
        kind: "subagent",
        sessionId: "child-session",
        parentThreadId: "parent",
        nickname: "reviewer",
        role: "worker",
      },
    };
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "detail",
      page: "latest",
      detail: {
        summary: subagent,
        turns: [turn("inherited-parent"), turn("child")],
        queuedMessages: [],
        olderTurnsCursor: "parent-page",
      },
    });
    state = clientReducer(state, {
      type: "detail",
      page: "older",
      detail: {
        summary: subagent,
        turns: [turn("older-parent")],
        queuedMessages: [],
        olderTurnsCursor: "more-parent",
      },
    });
    state = clientReducer(state, {
      type: "detail",
      page: "latest",
      detail: {
        summary: subagent,
        turns: [turn("child")],
        queuedMessages: [],
        olderTurnsCursor: "ignored-parent-page",
      },
    });

    expect(state.details.one?.turns.map((item) => item.id)).toEqual(["child"]);
    expect(state.details.one?.olderTurnsCursor).toBeNull();
    expect(state.expandedHistory.one).toBe(false);
  });

  it("reconciles an optimistic message whether the event arrives before or after acceptance", () => {
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "optimistic.add",
      message: {
        id: "client-message",
        threadId: "one",
        text: "Сразу видно",
        images: [],
        createdAt: 10,
        destination: "turn",
        turnId: null,
      },
    });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "server-turn",
        item: {
          type: "userMessage",
          id: "client-message",
          status: "completed",
          text: "Сразу видно",
          images: [],
          timestamp: 10,
          phase: null,
        },
      },
    });
    state = clientReducer(state, {
      type: "optimistic.accept",
      threadId: "one",
      messageId: "client-message",
      turnId: "server-turn",
    });

    expect(state.optimisticMessages.one).toBeUndefined();
    expect(state.details.one?.turns[0]?.items.map((item) => item.id)).toEqual(["client-message"]);

    state = clientReducer(state, {
      type: "optimistic.add",
      message: {
        id: "client-message",
        threadId: "one",
        text: "Сразу видно",
        images: [],
        createdAt: 10,
        destination: "turn",
        turnId: "server-turn",
      },
    });
    expect(state.optimisticMessages.one).toBeUndefined();
  });

  it("moves a confirmed user message to its canonical turn without rendering a duplicate", () => {
    const message = {
      type: "userMessage" as const,
      id: "client-message",
      status: "completed" as const,
      text: "Только один раз",
      images: [],
      timestamp: 10,
      phase: null,
    };
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "detail",
      page: "latest",
      detail: {
        summary: baseThread,
        turns: [
          { ...turn("canonical-turn"), items: [] },
          {
            ...turn("synthetic-turn"),
            items: [
              message,
              {
                type: "agentMessage",
                id: "keep-me",
                status: "completed",
                text: "Соседний элемент",
                images: [],
                timestamp: 11,
                phase: "final_answer",
              },
            ],
          },
        ],
        queuedMessages: [],
        olderTurnsCursor: null,
      },
    });
    state = {
      ...state,
      optimisticMessages: {
        one: [
          {
            id: message.id,
            threadId: "one",
            text: message.text,
            images: [],
            createdAt: message.timestamp,
            destination: "turn",
            turnId: "synthetic-turn",
          },
        ],
      },
      details: {
        ...state.details,
        one: {
          ...state.details.one!,
          queuedMessages: [
            {
              id: message.id,
              threadId: "one",
              text: message.text,
              createdAt: message.timestamp,
              status: "dispatching",
            },
          ],
        },
      },
    };

    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 5 },
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "canonical-turn",
        item: message,
      },
    });

    expect(
      state.details.one?.turns.flatMap((candidate) =>
        candidate.items.filter((item) => item.type === "userMessage" && item.id === message.id),
      ),
    ).toHaveLength(1);
    expect(state.details.one?.turns[0]?.items).toContainEqual(message);
    expect(state.details.one?.turns[1]?.items).toContainEqual(
      expect.objectContaining({ id: "keep-me" }),
    );
    expect(state.details.one?.queuedMessages).toEqual([]);
    expect(state.optimisticMessages.one).toBeUndefined();
  });

  it("keeps chronological plan checklists after their respective anchors", () => {
    let state = clientReducer(initialState, { type: "snapshot", snapshot });
    state = clientReducer(state, {
      type: "detail",
      page: "latest",
      detail: {
        summary: baseThread,
        turns: [
          {
            ...turn("turn"),
            status: "inProgress",
            items: [
              {
                type: "tool",
                id: "request",
                status: "completed",
                title: "Вопрос",
                detail: "",
              },
            ],
          },
        ],
        queuedMessages: [],
        olderTurnsCursor: null,
      },
    });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 6 },
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "turn",
        item: {
          type: "userInputResponse",
          id: "response",
          status: "completed",
          entries: [{ header: "Выбор", question: "Как?", answers: ["Так"] }],
          timestamp: 3,
          afterItemId: "request",
        },
      },
    });
    const checklist = {
      type: "planChecklist" as const,
      id: "checklist",
      status: "inProgress" as const,
      explanation: "Работаю",
      steps: [{ step: "Шаг", status: "inProgress" as const }],
      timestamp: 4,
      afterItemId: "response",
    };
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 7 },
      event: { type: "activity.upserted", threadId: "one", turnId: "turn", item: checklist },
    });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 8 },
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "turn",
        item: {
          type: "agentMessage",
          id: "progress-message",
          status: "completed",
          text: "Перехожу дальше",
          images: [],
          timestamp: 5,
          phase: "commentary",
        },
      },
    });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 9 },
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "turn",
        item: {
          ...checklist,
          id: "completed-checklist",
          timestamp: 6,
          afterItemId: "progress-message",
          steps: [{ step: "Шаг", status: "completed" }],
        },
      },
    });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "legacy", sequence: 10 },
      event: {
        type: "activity.upserted",
        threadId: "one",
        turnId: "turn",
        item: {
          type: "plan",
          id: "final",
          status: "completed",
          text: "План",
          images: [],
          timestamp: 7,
          phase: null,
        },
      },
    });

    expect(state.details.one?.turns[0]?.items.map((item) => item.id)).toEqual([
      "request",
      "response",
      "checklist",
      "progress-message",
      "completed-checklist",
      "final",
    ]);
    expect(
      state.details.one?.turns[0]?.items.find((item) => item.id === "completed-checklist"),
    ).toMatchObject({ steps: [{ status: "completed" }] });
  });

  it("accepts only forward detail versions from the active backend instance", () => {
    const authoritative = { ...snapshot, instanceId: "primary", sequence: 4 };
    let state = clientReducer(initialState, { type: "snapshot", snapshot: authoritative });
    const detail = (sequence: number, title: string): ThreadDetail => ({
      version: { instanceId: "primary", sequence },
      summary: { ...baseThread, title },
      turns: [turn(`turn-${sequence}`)],
      queuedMessages: [],
      olderTurnsCursor: null,
    });

    state = clientReducer(state, { type: "detail", detail: detail(10, "Актуально") });
    state = clientReducer(state, { type: "detail", detail: detail(9, "Откат") });
    expect(state.details.one?.summary.title).toBe("Актуально");
    expect(state.details.one?.version?.sequence).toBe(10);

    state = clientReducer(state, { type: "detail", detail: detail(11, "Новее") });
    expect(state.details.one?.summary.title).toBe("Новее");
    expect(state.details.one?.version?.sequence).toBe(11);
  });

  it("does not replay an older stream event into a newer HTTP detail", () => {
    let state = clientReducer(initialState, {
      type: "snapshot",
      snapshot: { ...snapshot, instanceId: "primary", sequence: 4 },
    });
    state = clientReducer(state, {
      type: "detail",
      detail: {
        version: { instanceId: "primary", sequence: 10 },
        summary: { ...baseThread, title: "Актуально" },
        turns: [turn("current")],
        queuedMessages: [],
        olderTurnsCursor: null,
      },
    });

    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "primary", sequence: 5 },
      event: {
        type: "thread.upserted",
        thread: { ...baseThread, title: "Старое событие" },
      },
    });

    expect(state.snapshot?.sequence).toBe(5);
    expect(state.details.one?.summary.title).toBe("Актуально");
    expect(state.details.one?.version?.sequence).toBe(10);
  });

  it("keeps rendered session history offline and clears it after a backend restart", () => {
    let state = clientReducer(initialState, {
      type: "snapshot",
      snapshot: { ...snapshot, instanceId: "first" },
    });
    state = clientReducer(state, {
      type: "detail",
      detail: {
        version: { instanceId: "first", sequence: 5 },
        summary: baseThread,
        turns: [turn("turn")],
        queuedMessages: [],
        olderTurnsCursor: null,
      },
    });
    expect(state.details.one).toBeDefined();

    state = clientReducer(state, { type: "network", network: "offline" });
    expect(state.details.one?.turns.map((candidate) => candidate.id)).toEqual(["turn"]);

    state = clientReducer(state, {
      type: "snapshot",
      snapshot: { ...snapshot, instanceId: "second", sequence: 0 },
    });
    expect(state.details).toEqual({});
  });

  it("applies older history only to the page anchor without replacing latest metadata", () => {
    const currentSummary = { ...baseThread, title: "Текущее состояние" };
    let state = clientReducer(initialState, {
      type: "snapshot",
      snapshot: { ...snapshot, instanceId: "primary" },
    });
    state = clientReducer(state, {
      type: "detail",
      detail: {
        version: { instanceId: "primary", sequence: 8 },
        summary: currentSummary,
        turns: [turn("newer"), turn("newest")],
        queuedMessages: [],
        olderTurnsCursor: "older-cursor",
      },
    });
    state = clientReducer(state, {
      type: "history",
      threadId: "one",
      page: {
        instanceId: "primary",
        anchorTurnId: "newer",
        turns: [turn("oldest"), turn("older")],
        olderTurnsCursor: null,
      },
    });

    expect(state.details.one?.turns.map((candidate) => candidate.id)).toEqual([
      "oldest",
      "older",
      "newer",
      "newest",
    ]);
    expect(state.details.one?.summary).toEqual(currentSummary);
    expect(state.details.one?.version?.sequence).toBe(8);

    const unchanged = clientReducer(state, {
      type: "history",
      threadId: "one",
      page: {
        instanceId: "primary",
        anchorTurnId: "stale-anchor",
        turns: [turn("must-not-apply")],
        olderTurnsCursor: null,
      },
    });
    expect(unchanged).toBe(state);
  });

  it("sorts sessions only by most recent activity", () => {
    const threads = [
      {
        ...baseThread,
        id: "blank",
        title: "Без названия",
        state: "idle" as const,
        currentTurnId: null,
        updatedAt: 10,
      },
      { ...baseThread, id: "normal", state: "idle" as const, currentTurnId: null, updatedAt: 100 },
      {
        ...baseThread,
        id: "pinned",
        state: "idle" as const,
        currentTurnId: null,
        pinned: true,
        updatedAt: 20,
      },
      {
        ...baseThread,
        id: "unread",
        state: "completed" as const,
        currentTurnId: null,
        unread: true,
        updatedAt: 30,
      },
      { ...baseThread, id: "running", updatedAt: 40 },
      { ...baseThread, id: "attention", state: "needsAttention" as const, updatedAt: 50 },
    ];
    expect(sortThreads(threads).map((thread) => thread.id)).toEqual([
      "normal",
      "attention",
      "running",
      "unread",
      "pinned",
      "blank",
    ]);
  });
});

function userInputAttention(draft: {
  answers: Record<string, string[]>;
  currentQuestionId: string | null;
  revision: number;
  updatedAt: number;
}) {
  return {
    id: "questions",
    threadId: "one",
    turnId: "turn",
    itemId: "item",
    createdAt: 1,
    kind: "userInput" as const,
    autoResolutionMs: null,
    draft,
    questions: [
      {
        id: "first",
        header: "Первый",
        question: "Первый?",
        isOther: true,
        isSecret: false,
        options: null,
      },
      {
        id: "second",
        header: "Второй",
        question: "Второй?",
        isOther: true,
        isSecret: false,
        options: null,
      },
    ],
  };
}

function turn(id: string) {
  return {
    id,
    status: "completed" as const,
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
  };
}

describe("shared project draft events", () => {
  it("applies versioned broadcasts and ignores older HTTP responses", () => {
    const draft = { input: "Shared", images: [], goalMode: false, annotations: [], updatedAt: 2 };
    let state = clientReducer(initialState, {
      type: "snapshot",
      snapshot: { ...snapshot, instanceId: "server", sequence: 1 },
    });
    state = clientReducer(state, {
      type: "event",
      version: { instanceId: "server", sequence: 2 },
      event: { type: "projectDraft.changed", projectId: "project", draft },
    });
    expect(state.projectDrafts?.project).toEqual(draft);
    expect(state.snapshot?.sequence).toBe(2);
    expect(
      clientReducer(state, {
        type: "projectDraft",
        projectId: "project",
        draft: { ...draft, input: "Stale", updatedAt: 1 },
      }),
    ).toBe(state);
  });
});
