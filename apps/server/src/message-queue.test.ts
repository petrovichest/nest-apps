import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { QueuedMessage } from "@codexnest/protocol";

import { MessageQueue, MessageQueueInputUnavailableError } from "./message-queue";
import { RpcError } from "./codex/transport";
import { StateStore } from "./state/store";

const directories: string[] = [];
const queues: MessageQueue[] = [];

afterEach(async () => {
  await Promise.all(queues.splice(0).map((queue) => queue.pause()));
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("MessageQueue", () => {
  it("retains plan mode across storage recovery and binds it to the message ID", async () => {
    const { queue, store, delivery } = await setup("active");
    delivery.paused.mockReturnValue(true);
    await queue.enqueue("thread", "Implement", [], "accept-plan", {
      planImplementationMode: "team",
    });
    const reopened = new StateStore(store.path);
    await reopened.load();
    expect(reopened.view().messageQueues?.thread?.[0]).toMatchObject({
      planImplementationMode: "team",
    });
    await expect(
      queue.enqueue("thread", "Implement", [], "accept-plan", {
        planImplementationMode: "default",
      }),
    ).rejects.toThrow("already been used");
    delivery.paused.mockReturnValue(false);
    await expect(queue.sendNow("thread", "accept-plan")).rejects.toThrow("current turn");
    expect(delivery.steer).not.toHaveBeenCalled();
    delivery.currentTurnId.mockReturnValue(null);
    await queue.drain("thread");
    expect(delivery.start).toHaveBeenCalledWith(
      "thread",
      expect.objectContaining({ planImplementationMode: "team" }),
    );
    await expect(
      queue.enqueue("thread", "Implement", [], "accept-plan", {
        planImplementationMode: "default",
      }),
    ).rejects.toThrow("already been used");
  });
  it("persists paste-only messages and edits, with paste metadata included in idempotency", async () => {
    const { queue, store, delivery } = await setup("active");
    delivery.paused.mockReturnValue(true);
    const pasteBlocks = [{ id: "paste", text: "## Log\n42" }];
    await queue.enqueue("thread", "", [], "message-paste", { pasteBlocks });
    const reopened = new StateStore(store.path);
    await reopened.load();
    expect(reopened.view().messageQueues?.thread?.[0]?.pasteBlocks).toEqual(pasteBlocks);
    await expect(
      queue.enqueue("thread", "", [], "message-paste", {
        pasteBlocks: [{ id: "paste", text: "different" }],
      }),
    ).rejects.toThrow("already been used");
    const changed = await queue.update("thread", "message-paste", "  short  ", {
      pasteBlocks,
      inlinePastes: [{ id: "short", start: 2, end: 7 }],
    });
    expect(changed.text).toBe("short");
    expect(changed.inlinePastes).toEqual([{ id: "short", start: 0, end: 5 }]);
    const cleared = await queue.update("thread", "message-paste", "Typed", {
      inlinePastes: [],
      pasteBlocks: [],
    });
    expect(cleared.pasteBlocks).toBeUndefined();
    expect(cleared.inlinePastes).toBeUndefined();
    await queue.cancel("thread", "message-paste");
    await expect(queue.enqueue("thread", "Typed", [], "message-paste")).rejects.toThrow("canceled");
  });

  it("delivers an explicit answer after a permanently rejected dismissal", async () => {
    const { queue, store, delivery } = await setup("turn");
    delivery.paused.mockReturnValue(true);
    await queue.enqueue("thread", "Rejected guidance", [], "dismissal", {
      dismissUserInput: { turnId: "turn", itemId: "question" },
    });
    await store.update((state) => {
      state.messageQueues!.thread![0]!.deliveryError = { message: "Rejected", retryable: false };
    });
    await queue.enqueue("thread", "Answer from the restored form", [], "answer", {
      replyToUserInput: { turnId: "turn", itemId: "question", answers: { choice: ["First"] } },
    });
    delivery.paused.mockReturnValue(false);
    await queue.drain("thread");
    expect(delivery.steer).toHaveBeenCalledExactlyOnceWith(
      "thread",
      "turn",
      expect.objectContaining({ id: "answer" }),
    );
    expect(queue.list("thread").map((message) => message.id)).toEqual(["dismissal"]);
  });

  it("recovers a dismissal into the current turn without losing its original question identity", async () => {
    const { queue, store, delivery } = await setup("new-turn");
    delivery.paused.mockReturnValue(true);
    const dismissUserInput = { turnId: "old-turn", itemId: "old-question" };
    await queue.enqueue("thread", "New instruction", [], "dismissal", { dismissUserInput });
    const reopened = new StateStore(store.path);
    await reopened.load();
    const recovered = new MessageQueue(reopened, delivery);
    queues.push(recovered);
    delivery.paused.mockReturnValue(false);
    await recovered.recover();
    expect(delivery.steer).toHaveBeenCalledExactlyOnceWith(
      "thread",
      "new-turn",
      expect.objectContaining({ id: "dismissal", dismissUserInput }),
    );
    await expect(
      recovered.enqueue("thread", "New instruction", [], "dismissal", {
        dismissUserInput: { turnId: "new-turn", itemId: "new-question" },
      }),
    ).rejects.toThrow("Message id has already been used");
    expect(recovered.list("thread")).toEqual([]);
  });

  it("recovers messages blocked before dispatch by the incompatible-build regression", async () => {
    const { queue, store, delivery } = await setup("active");
    const image = "data:image/png;base64,aGVsbG8=";
    await queue.enqueue("thread", "Saved text", [image], "blocked");
    await store.update((state) => {
      const message = state.messageQueues!.thread![0]!;
      message.deliveryVersion = 1;
      message.deliveryError = {
        message: "Для надёжной отправки требуется совместимая сборка Codex. Сообщение сохранено.",
        retryable: false,
      };
    });
    delivery.currentTurnId.mockReturnValue(null);
    await queue.recover();
    expect(delivery.start).toHaveBeenCalledExactlyOnceWith(
      "thread",
      expect.objectContaining({ id: "blocked", text: "Saved text", images: [image] }),
    );
    expect(queue.list("thread")).toEqual([]);
  });

  it("keeps cancellation across restart and rejects a delayed enqueue replay", async () => {
    const { queue, store, delivery } = await setup("active");
    await queue.enqueue("thread", "Canceled text", [], "canceled");
    await queue.cancel("thread", "canceled");
    const reopened = new StateStore(store.path);
    await reopened.load();
    const recovered = new MessageQueue(reopened, delivery);
    queues.push(recovered);
    await expect(recovered.enqueue("thread", "Canceled text", [], "canceled")).rejects.toThrow(
      "Message has been canceled",
    );
    expect(recovered.list("thread")).toEqual([]);
    expect(delivery.start).not.toHaveBeenCalled();
    expect(delivery.steer).not.toHaveBeenCalled();
  });
  it("parks accepted messages without delivery RPCs while direct input is unavailable", async () => {
    const { queue, store, delivery } = await setup(null);
    delivery.acceptsInput.mockReturnValue(false);
    await queue.enqueue("thread", "Сохранить", [], "held");
    await queue.drain("thread");
    expect(queue.list("thread")).toEqual([
      expect.objectContaining({ id: "held", status: "queued" }),
    ]);
    expect(delivery.start).not.toHaveBeenCalled();
    expect(delivery.deliveredTurnId).not.toHaveBeenCalled();
    await expect(queue.sendNow("thread", "held")).rejects.toBeInstanceOf(
      MessageQueueInputUnavailableError,
    );
    await queue.update("thread", "held", "Исправлено");
    expect(queue.list("thread")[0]?.text).toBe("Исправлено");
    delivery.acceptsInput.mockReturnValue(true);
    await queue.drain("thread");
    expect(delivery.start).toHaveBeenCalledOnce();
    expect(store.view().messageReceipts?.held?.turnId).toBe("started");
  });

  it("restores queued status when a resume discovers unavailable input", async () => {
    const { queue, delivery } = await setup("active");
    await queue.enqueue("thread", "Ответ", [], "held");
    delivery.steer.mockRejectedValueOnce(new MessageQueueInputUnavailableError());
    await expect(queue.sendNow("thread", "held")).rejects.toBeInstanceOf(
      MessageQueueInputUnavailableError,
    );
    expect(queue.list("thread")[0]).toMatchObject({ status: "queued" });
    expect(delivery.deliveredTurnId).not.toHaveBeenCalled();
  });
  it("delivers an async reply during a turn without consuming the draft or ordinary queue", async () => {
    const { queue, store, delivery } = await setup("active");
    const ordinary = await queue.enqueue("thread", "Позже", [], "ordinary");
    const draft = {
      input: "Основной черновик",
      images: [],
      annotations: [],
      goalMode: false,
      updatedAt: 1,
    };
    await store.update((state) => {
      state.threadMeta.thread!.draft = draft;
    });
    const reference = { turnId: "active", itemId: "question" };
    await queue.enqueue("thread", "Как?\nБыстро", [], "answer", {
      replyToAsyncQuestion: reference,
    });
    await vi.waitFor(() =>
      expect(store.snapshot().messageReceipts?.answer?.turnId).toBe("steered"),
    );
    expect(delivery.steer).toHaveBeenCalledWith(
      "thread",
      "active",
      expect.objectContaining({
        id: "answer",
        replyToAsyncQuestion: reference,
      }),
    );
    expect(delivery.deliveredTurnId).not.toHaveBeenCalled();
    expect(queue.list("thread")).toEqual([ordinary]);
    expect(store.snapshot().threadMeta.thread?.draft).toEqual(draft);
    await queue.enqueue("thread", "Как?\nБыстро", [], "answer", {
      replyToAsyncQuestion: reference,
    });
    await queue.drain("thread");
    expect(delivery.steer).toHaveBeenCalledOnce();
    expect(store.snapshot().threadMeta.thread?.draft).toEqual(draft);
  });

  it("restores async reply metadata and steers it after a restart", async () => {
    const { queue, store, delivery } = await setup("active");
    await store.update((state) => {
      state.messageQueues = {
        thread: [
          queued("ordinary", "Позже", "queued"),
          {
            ...queued("answer", "Сейчас", "queued"),
            replyToAsyncQuestion: { turnId: "active", itemId: "q" },
          },
        ],
      };
    });
    const reopened = new StateStore(store.path);
    await reopened.load();
    expect(reopened.view().messageQueues?.thread?.[1]?.replyToAsyncQuestion).toEqual({
      turnId: "active",
      itemId: "q",
    });
    const recovered = new MessageQueue(reopened, delivery);
    queues.push(recovered);
    await recovered.recover();
    expect(delivery.steer).toHaveBeenCalledOnce();
    expect(recovered.list("thread").map((message) => message.id)).toEqual(["ordinary"]);
    await queue.pause();
  });

  it("starts a follow-up for a late async reply", async () => {
    const { queue, store, delivery } = await setup(null);
    await queue.enqueue("thread", "Поздний ответ", [], "late", {
      replyToAsyncQuestion: { turnId: "finished", itemId: "q" },
    });
    await vi.waitFor(() => expect(store.snapshot().messageReceipts?.late?.turnId).toBe("started"));
    expect(delivery.start).toHaveBeenCalledOnce();
    expect(delivery.steer).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "retries when the active turn ends (notification first: %s)",
    async (notificationFirst) => {
      const { queue, store, delivery, setCurrentTurn } = await setup("active");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      delivery.steer.mockImplementationOnce(async () => {
        if (notificationFirst) setCurrentTurn(null);
        throw new RpcError(-32600, "no active turn");
      });
      await queue.enqueue("thread", "Ответ на вопрос", [], "race", {
        replyToAsyncQuestion: { turnId: "active", itemId: "q" },
      });
      await vi.waitFor(() => expect(queue.list("thread")[0]?.deliveryError?.retryable).toBe(true));
      setCurrentTurn(null);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() =>
        expect(store.snapshot().messageReceipts?.race?.turnId).toBe("started"),
      );
      expect(delivery.steer).toHaveBeenCalledOnce();
      expect(delivery.deliveredTurnId).toHaveBeenCalledOnce();
      expect(delivery.start).toHaveBeenCalledOnce();
    },
  );

  it("reconciles an uncertain async reply without replaying it", async () => {
    const { queue, store, delivery } = await setup("active");
    delivery.steer.mockRejectedValueOnce(new Error("lost reply"));
    delivery.deliveredTurnId.mockResolvedValueOnce("active");
    await queue.enqueue("thread", "Один ответ", [], "once", {
      replyToAsyncQuestion: { turnId: "active", itemId: "q" },
    });
    await vi.waitFor(() => expect(store.snapshot().messageReceipts?.once?.turnId).toBe("active"));
    await queue.recover();
    expect(delivery.steer).toHaveBeenCalledOnce();
  });

  it("persists FIFO messages and starts one after the active turn completes", async () => {
    const { queue, delivery, setCurrentTurn } = await setup("active");
    const first = await queue.enqueue("thread", "Первое");
    const second = await queue.enqueue("thread", "Второе");

    expect(queue.list("thread").map((message) => message.text)).toEqual(["Первое", "Второе"]);
    expect(delivery.start).not.toHaveBeenCalled();

    setCurrentTurn(null);
    await queue.drain("thread");

    expect(delivery.start).toHaveBeenCalledWith("thread", first);
    expect(queue.list("thread")).toEqual([second]);
  });

  it("steers a selected queued message once and replays its receipt to duplicate requests", async () => {
    const { queue, delivery } = await setup("active");
    const message = await queue.enqueue("thread", "Сейчас");

    const [sent, duplicate] = await Promise.allSettled([
      queue.sendNow("thread", message.id),
      queue.sendNow("thread", message.id),
    ]);

    expect(sent).toMatchObject({ status: "fulfilled", value: "steered" });
    expect(duplicate).toMatchObject({ status: "fulfilled", value: "steered" });
    expect(delivery.steer).toHaveBeenCalledOnce();
    expect(queue.list("thread")).toEqual([]);
  });

  it("steers a newly queued answer without consuming older queued work", async () => {
    const { queue, delivery } = await setup("active");
    const older = await queue.enqueue("thread", "Сделать следующим ходом");
    delivery.shouldSteerQueuedMessage.mockReturnValue(true);

    const message = await queue.enqueue("thread", "Ответ без формы");

    await vi.waitFor(() => expect(queue.list("thread")).toEqual([older]));
    expect(delivery.steer).toHaveBeenCalledWith("thread", "active", message);
    await expect(queue.sendNow("thread", message.id)).resolves.toBe("steered");
    expect(delivery.steer).toHaveBeenCalledOnce();
  });

  it("queues an automatic worker result behind the active turn and preserves the draft", async () => {
    const { queue, store, delivery, setCurrentTurn } = await setup("active");
    delivery.shouldSteerQueuedMessage.mockReturnValue(true);
    const draft = { input: "Черновик", images: [], annotations: [], goalMode: false, updatedAt: 1 };
    await store.update((state) => {
      state.threadMeta.thread!.draft = draft;
    });

    const result = await queue.enqueue("thread", "Результат работника", [], "worker-result", {
      automatic: true,
    });
    await queue.drain("thread");
    expect(queue.list("thread")).toEqual([result]);
    expect(delivery.start).not.toHaveBeenCalled();
    expect(delivery.steer).not.toHaveBeenCalled();

    setCurrentTurn(null);
    await queue.drain("thread");
    expect(delivery.start).toHaveBeenCalledWith("thread", result);
    expect(store.snapshot().threadMeta.thread?.draft).toEqual(draft);
  });

  it("returns a failed delivery to queued state", async () => {
    const { queue, delivery } = await setup("active");
    delivery.steer.mockRejectedValueOnce(new Error("offline"));
    const message = await queue.enqueue("thread", "Не потерять");

    await expect(queue.sendNow("thread", message.id)).rejects.toThrow("offline");
    expect(queue.list("thread")).toMatchObject([
      { ...message, status: "queued", deliveryError: { retryable: true } },
    ]);
  });

  it("reconciles a delivery whose response was lost instead of sending it again", async () => {
    const { queue, delivery, store } = await setup("active");
    delivery.steer.mockRejectedValueOnce(new Error("response lost"));
    delivery.deliveredTurnId.mockResolvedValueOnce("active");
    const message = await queue.enqueue("thread", "Только один раз");

    await expect(queue.sendNow("thread", message.id)).resolves.toBe("active");
    expect(queue.list("thread")).toEqual([]);
    expect(store.snapshot().messageReceipts?.[message.id]).toMatchObject({
      threadId: "thread",
      turnId: "active",
    });
    expect(delivery.steer).toHaveBeenCalledOnce();
  });

  it("preserves accepted work when the daemon reports an unloaded thread", async () => {
    const { queue, delivery, store } = await setup("active");
    const message = queued("missing", "Исчезнувшее сообщение", "dispatching");
    await store.update((state) => {
      state.threadMeta.thread = {
        pinned: false,
        lastReadUpdatedAt: 0,
      };
      state.messageQueues = { thread: [message] };
    });
    delivery.deliveredTurnId.mockRejectedValueOnce(new RpcError(-32_600, "thread not loaded"));

    await expect(queue.recover()).resolves.toBeUndefined();

    expect(queue.list("thread")).toMatchObject([
      { ...message, deliveryError: { retryable: true } },
    ]);
    expect(store.snapshot().threadMeta.thread).toBeDefined();
    expect(store.snapshot().messageQueues?.thread).toHaveLength(1);
  });

  it("parks an ambiguous delivery while reconciliation is unavailable", async () => {
    const { queue, delivery } = await setup("active");
    delivery.steer.mockRejectedValueOnce(new Error("response lost"));
    delivery.deliveredTurnId.mockRejectedValueOnce(new Error("session unavailable"));
    const message = await queue.enqueue("thread", "Не отправлять повторно вслепую");

    await expect(queue.sendNow("thread", message.id)).rejects.toThrow("response lost");
    expect(queue.list("thread")).toMatchObject([
      { ...message, status: "dispatching", deliveryError: { retryable: true } },
    ]);
    await queue.drain("thread");
    expect(delivery.steer).toHaveBeenCalledOnce();
  });

  it("keeps a missing session's message durable and stops automatic retries", async () => {
    const { queue, delivery, store, setCurrentTurn } = await setup("active");
    const message = await queue.enqueue("thread", "Не удалять", ["data:image/png;base64,aW1hZ2U="]);
    await queue.drain("thread");
    delivery.start.mockRejectedValue(new RpcError(-32600, "no rollout found for thread id thread"));
    setCurrentTurn(null);
    await expect(queue.drain("thread")).rejects.toThrow("no rollout found");
    await queue.drain("thread");
    await queue.recover();
    expect(delivery.start).toHaveBeenCalledOnce();
    expect(queue.list("thread")).toMatchObject([
      { ...message, deliveryError: { retryable: false } },
    ]);
    const reopened = new StateStore(store.path);
    await reopened.load();
    expect(reopened.snapshot().messageQueues?.thread).toMatchObject([
      { id: message.id, text: message.text, images: message.images },
    ]);
  });

  it("retries a temporary rejection with backoff and the original message id", async () => {
    const { queue, delivery, setCurrentTurn } = await setup("active");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const message = await queue.enqueue("thread", "Повтори сам", [], "stable-id");
    await queue.drain("thread");
    delivery.start.mockRejectedValueOnce(new RpcError(-32600, "thread not loaded"));
    setCurrentTurn(null);
    await expect(queue.drain("thread")).rejects.toThrow("thread not loaded");
    await queue.drain("thread");
    expect(delivery.start).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(queue.list("thread")).toEqual([]));
    expect(delivery.start).toHaveBeenCalledTimes(2);
    expect(delivery.start.mock.calls[1]).toMatchObject([
      "thread",
      { id: message.id, text: message.text },
    ]);
  });

  it("reconciles an ambiguous delivery before any automatic resend", async () => {
    const { queue, delivery, setCurrentTurn } = await setup("active");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const message = await queue.enqueue("thread", "Ответ потерян");
    await queue.drain("thread");
    delivery.start.mockRejectedValueOnce(new Error("response lost"));
    delivery.deliveredTurnId.mockRejectedValueOnce(new Error("offline"));
    setCurrentTurn(null);
    await expect(queue.drain("thread")).rejects.toThrow("response lost");
    delivery.deliveredTurnId.mockResolvedValueOnce("already-delivered");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(queue.list("thread")).toEqual([]));
    expect(delivery.start).toHaveBeenCalledOnce();
    await expect(queue.sendNow("thread", message.id)).resolves.toBe("already-delivered");
  });

  it("persists image-only messages without changing queue delivery", async () => {
    const { queue, delivery } = await setup("active");
    const image = "data:image/png;base64,aW1hZ2U=";
    const message = await queue.enqueue("thread", "", [image]);

    expect(queue.list("thread")).toEqual([expect.objectContaining({ text: "", images: [image] })]);
    await queue.sendNow("thread", message.id);
    expect(delivery.steer).toHaveBeenCalledWith("thread", "active", message);
  });

  it("deduplicates retries with the same client message id", async () => {
    const { queue, store } = await setup("active");

    const first = await queue.enqueue("thread", "Один раз", [], "client-message");
    await store.update((state) => {
      state.threadMeta.thread!.draft = {
        input: "Следующий черновик",
        images: [],
        goalMode: false,
        annotations: [],
        updatedAt: 2,
      };
    });
    const retry = await queue.enqueue("thread", "Один раз", [], "client-message");

    expect(retry).toEqual(first);
    expect(queue.list("thread")).toEqual([first]);
    expect(store.snapshot().threadMeta.thread?.draft?.input).toBe("Следующий черновик");
    await expect(queue.enqueue("thread", "Другой текст", [], "client-message")).rejects.toThrow(
      "Message id has already been used",
    );
    expect(queue.list("thread")).toEqual([first]);
  });

  it("deduplicates a retry after the original message was delivered", async () => {
    const { queue, delivery, store } = await setup(null);

    await queue.enqueue("thread", "Один раз", [], "client-message");
    await vi.waitFor(() =>
      expect(store.snapshot().messageReceipts?.["client-message"]).toBeDefined(),
    );
    await store.update((state) => {
      state.threadMeta.thread!.draft = {
        input: "Следующий черновик",
        images: [],
        goalMode: false,
        annotations: [],
        updatedAt: 2,
      };
    });
    const retry = await queue.enqueue("thread", "Один раз", [], "client-message");

    expect(retry).toMatchObject({ id: "client-message", status: "dispatching" });
    expect(delivery.start).toHaveBeenCalledOnce();
    expect(queue.list("thread")).toEqual([]);
    expect(store.snapshot().threadMeta.thread?.draft?.input).toBe("Следующий черновик");
    await expect(queue.enqueue("thread", "Другой текст", [], "client-message")).rejects.toThrow(
      "Message id has already been used",
    );
  });

  it("atomically converts a completed voice job into a goal message", async () => {
    const { queue, store } = await setup("active");
    await store.update((state) => {
      state.threadMeta.thread = {
        pinned: false,
        lastReadUpdatedAt: 0,
        draft: {
          input: "Черновик",
          images: [],
          goalMode: true,
          annotations: [],
          updatedAt: 1,
        },
      };
      state.voiceTranscriptions = {
        thread: {
          id: "voice",
          threadId: "thread",
          mode: "send",
          status: "applying",
          createdAt: 1,
          startedAt: 2,
          audioDurationMs: 1_000,
          estimatedTotalSeconds: null,
          error: null,
          contentType: "audio/webm",
          audioFile: "voice.webm",
          audioBytes: 5,
          selectionStart: 0,
          selectionEnd: 0,
          transcript: "Текст",
        },
      };
    });

    const message = await queue.enqueue("thread", "Голос", [], "voice", {
      goal: true,
      completeVoiceTranscriptionId: "voice",
    });

    expect(message.goal).toBe(true);
    expect(store.snapshot().threadMeta.thread?.draft).toBeUndefined();
    expect(store.snapshot().voiceTranscriptions?.thread).toBeUndefined();
  });

  it("updates queued text without changing its metadata or images", async () => {
    const { queue, delivery } = await setup("active");
    const image = "data:image/png;base64,aW1hZ2U=";
    const first = await queue.enqueue("thread", "Старый текст", [image]);
    const second = await queue.enqueue("thread", "Следом");

    const updated = await queue.update("thread", first.id, "  Новый текст  ");

    expect(updated).toEqual({ ...first, text: "Новый текст" });
    expect(queue.list("thread")).toEqual([updated, second]);
    expect(delivery.publish).toHaveBeenLastCalledWith("thread", [updated, second]);
  });

  it("cancels a queued message without affecting the remaining order", async () => {
    const { queue, delivery } = await setup("active");
    const first = await queue.enqueue("thread", "Первое");
    const second = await queue.enqueue("thread", "Второе");

    await queue.cancel("thread", first.id);

    expect(queue.list("thread")).toEqual([second]);
    expect(delivery.publish).toHaveBeenLastCalledWith("thread", [second]);
  });

  it("rejects invalid, missing, and dispatching queue mutations", async () => {
    const { queue, store } = await setup("active");
    const message = await queue.enqueue("thread", "Сообщение");

    await expect(queue.update("thread", message.id, " ")).rejects.toThrow(
      "Queued message text must not be empty",
    );
    await expect(queue.cancel("thread", "missing")).rejects.toThrow("Queued message not found");

    await store.update((state) => {
      state.messageQueues!.thread = [{ ...message, status: "dispatching" }];
    });
    await expect(queue.update("thread", message.id, "Правка")).rejects.toThrow(
      "Queued message is already being sent",
    );
    await expect(queue.cancel("thread", message.id)).rejects.toThrow(
      "Queued message is already being sent",
    );
  });

  it("reconciles dispatching messages after a restart", async () => {
    const { queue, store, delivery } = await setup("active");
    const delivered = queued("delivered", "Доставлено", "dispatching");
    const pending = queued("pending", "Повторить", "dispatching");
    await store.update((state) => {
      state.messageQueues = { thread: [delivered, pending] };
    });
    delivery.deliveredTurnId.mockImplementation(async (_threadId, messageId) => {
      return messageId === delivered.id ? "delivered-turn" : null;
    });

    await queue.recover();

    expect(queue.list("thread")).toEqual([{ ...pending, status: "queued" }]);
    expect(store.snapshot().messageReceipts?.[delivered.id]?.turnId).toBe("delivered-turn");
  });

  it("keeps messages queued while delivery is paused and resumes afterwards", async () => {
    const { queue, delivery, setPaused } = await setup(null);
    setPaused(true);

    const message = await queue.enqueue("thread", "После обслуживания");
    await queue.drain("thread");

    expect(delivery.start).not.toHaveBeenCalled();
    expect(queue.list("thread")).toEqual([message]);

    setPaused(false);
    await queue.resume();
    expect(delivery.start).toHaveBeenCalledWith("thread", message);
    expect(queue.list("thread")).toEqual([]);
  });
});

async function setup(initialTurn: string | null) {
  const directory = await mkdtemp(join(tmpdir(), "codexnest-message-queue-test-"));
  directories.push(directory);
  const store = new StateStore(join(directory, "state.json"));
  await store.load();
  await store.update((state) => {
    state.threadMeta.thread = { pinned: false, lastReadUpdatedAt: 0 };
  });
  let currentTurn = initialTurn;
  let paused = false;
  const delivery = {
    acceptsInput: vi.fn(() => true),
    paused: vi.fn(() => paused),
    currentTurnId: vi.fn(() => currentTurn),
    shouldSteerQueuedMessage: vi.fn(() => false),
    start: vi.fn<(threadId: string, message: QueuedMessage) => Promise<string>>(async () => {
      currentTurn = "started";
      return "started";
    }),
    steer: vi.fn(async () => {
      currentTurn = "steered";
      return "steered";
    }),
    deliveredTurnId: vi.fn(async (): Promise<string | null> => null),
    publish: vi.fn(),
  };
  const queue = new MessageQueue(store, delivery);
  queues.push(queue);
  return {
    queue,
    store,
    delivery,
    setCurrentTurn(value: string | null) {
      currentTurn = value;
    },
    setPaused(value: boolean) {
      paused = value;
    },
  };
}

function queued(id: string, text: string, status: QueuedMessage["status"]): QueuedMessage {
  return { id, threadId: "thread", text, createdAt: 1, status };
}
