import {
  pastedText,
  trimPastedMessage,
  rebasePastedText,
  type PastedText,
} from "@codexnest/protocol";
import { createHash, randomUUID } from "node:crypto";

import type {
  AsyncQuestionReference,
  UserInputReply,
  QueuedMessage,
  ThreadFileAttachment,
} from "@codexnest/protocol";

import type { StateStore } from "./state/store";
import { RpcError } from "./codex/transport";
import { isMissingThreadError, isThreadNotLoadedError } from "./thread-state";
import { DeliveryContractError } from "./durable-delivery";

export interface MessageQueueDelivery {
  requiresDurableReceipt?: boolean;
  paused(): boolean;
  acceptsInput?(threadId: string): boolean;
  currentTurnId(threadId: string): string | null;
  shouldSteerQueuedMessage(threadId: string, turnId: string): boolean;
  start(threadId: string, message: QueuedMessage): Promise<string>;
  steer(threadId: string, turnId: string, message: QueuedMessage): Promise<string>;
  deliveredTurnId(
    threadId: string,
    messageId: string,
    retryUnconfirmed?: boolean,
  ): Promise<string | null>;
  publish(threadId: string, messages: QueuedMessage[]): void;
}

export class MessageQueueNotFoundError extends Error {}
export class MessageQueuePausedError extends Error {}
export class MessageQueueInputUnavailableError extends MessageQueuePausedError {
  constructor() {
    super("Codex пока не принимает сообщения в эту сессию. Черновик и очередь сохранены.");
  }
}
export class MessageQueueConflictError extends Error {}
export class MessageQueueValidationError extends Error {}

export class MessageQueue {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly retries = new Map<string, { attempt: number; timer?: NodeJS.Timeout }>();
  private suspended = false;

  constructor(
    private readonly store: StateStore,
    private readonly delivery: MessageQueueDelivery,
  ) {}

  list(threadId: string): QueuedMessage[] {
    return structuredClone(this.store.view().messageQueues?.[threadId] ?? []) as QueuedMessage[];
  }

  count(threadId: string): number {
    return this.list(threadId).length;
  }

  async enqueue(
    threadId: string,
    text: string,
    images: string[] = [],
    messageId: string = randomUUID(),
    options: PastedText & {
      goal?: boolean;
      planImplementationMode?: QueuedMessage["planImplementationMode"];
      files?: ThreadFileAttachment[];
      completeVoiceTranscriptionId?: string;
      replyToAsyncQuestion?: AsyncQuestionReference;
      replyToUserInput?: UserInputReply;
      dismissUserInput?: AsyncQuestionReference;
      /** Background system messages keep the user's draft and wait for the next turn. */
      automatic?: boolean;
    } = {},
  ): Promise<QueuedMessage> {
    const message: QueuedMessage = {
      id: messageId,
      threadId,
      text: text.trim(),
      ...pastedText(trimPastedMessage(text, options)),
      ...(images.length ? { images } : {}),
      ...(options.files?.length ? { files: options.files } : {}),
      ...(options.goal ? { goal: true } : {}),
      ...(options.planImplementationMode
        ? { planImplementationMode: options.planImplementationMode }
        : {}),
      ...(options.replyToAsyncQuestion
        ? { replyToAsyncQuestion: options.replyToAsyncQuestion }
        : {}),
      ...(options.replyToUserInput ? { replyToUserInput: options.replyToUserInput } : {}),
      ...(options.dismissUserInput ? { dismissUserInput: options.dismissUserInput } : {}),
      createdAt: Date.now(),
      status: "queued",
    };
    const contentHash = messageContentHash(
      message.text,
      message.images ?? [],
      message.files ?? [],
      !!message.goal,
      message.replyToUserInput ?? message.replyToAsyncQuestion,
      message.dismissUserInput,
      message,
    );
    let stored = message;
    await this.store.update((state) => {
      const receipt = state.messageReceipts?.[messageId];
      if (receipt && (receipt.threadId !== threadId || receipt.contentHash !== contentHash)) {
        throw new MessageQueueConflictError("Message id has already been used");
      }
      if (receipt && receipt.status !== "prepared" && receipt.status !== "rejected") {
        if (receipt.status === "canceled") {
          throw new MessageQueueConflictError("Message has been canceled");
        }
        if (receipt.threadId !== threadId || receipt.contentHash !== contentHash) {
          throw new MessageQueueConflictError("Message id has already been used");
        }
        if (
          this.delivery.requiresDurableReceipt &&
          receipt.deliveryVersion !== 1 &&
          receipt.status !== "delivered"
        ) {
          throw new DeliveryContractError("Доставка старого сообщения не подтверждена Codex.");
        }
        stored = { ...message, status: "dispatching" };
        const queue = state.messageQueues?.[threadId];
        if (queue?.some((candidate) => candidate.id === messageId)) {
          state.messageQueues![threadId] = queue.filter((candidate) => candidate.id !== messageId);
          if (!state.messageQueues![threadId].length) delete state.messageQueues![threadId];
        }
        // This is only an acknowledgement replay. The draft may already belong
        // to the user's next message, so do not clear it again.
        if (
          options.completeVoiceTranscriptionId &&
          state.voiceTranscriptions?.[threadId]?.id === options.completeVoiceTranscriptionId
        ) {
          delete state.voiceTranscriptions[threadId];
        }
        return;
      }
      if (!state.threadMeta[threadId]) {
        throw new MessageQueueNotFoundError("Thread not found");
      }
      state.messageQueues ??= {};
      const queue = (state.messageQueues[threadId] ??= []);
      const existing = queue.find((candidate) => candidate.id === messageId);
      if (existing) {
        if (
          messageContentHash(
            existing.text,
            existing.images ?? [],
            existing.files ?? [],
            !!existing.goal,
            existing.replyToUserInput ?? existing.replyToAsyncQuestion,
            existing.dismissUserInput,
            existing,
          ) !== contentHash ||
          JSON.stringify(existing.replyToAsyncQuestion) !==
            JSON.stringify(message.replyToAsyncQuestion)
        ) {
          throw new MessageQueueConflictError("Message id has already been used");
        }
        stored = existing;
        if (
          options.completeVoiceTranscriptionId &&
          state.voiceTranscriptions?.[threadId]?.id === options.completeVoiceTranscriptionId
        ) {
          delete state.voiceTranscriptions[threadId];
        }
        return;
      }
      queue.push(message);
      const meta = state.threadMeta[threadId];
      if (meta && !options.automatic && !message.replyToAsyncQuestion && !message.replyToUserInput)
        delete meta.draft;
      if (
        options.completeVoiceTranscriptionId &&
        state.voiceTranscriptions?.[threadId]?.id === options.completeVoiceTranscriptionId
      ) {
        delete state.voiceTranscriptions[threadId];
      }
    });
    this.publish(threadId);
    const activeTurnId = this.delivery.currentTurnId(threadId);
    if (
      !options.automatic &&
      !stored.replyToAsyncQuestion &&
      !stored.planImplementationMode &&
      activeTurnId &&
      this.delivery.shouldSteerQueuedMessage(threadId, activeTurnId)
    ) {
      void this.sendNow(threadId, stored.id).catch(() => undefined);
    } else {
      void this.drain(threadId).catch(() => undefined);
    }
    return stored;
  }

  sendNow(threadId: string, messageId: string, retryUnconfirmed = false): Promise<string> {
    return this.withLock(threadId, async () => {
      if (this.delivery.paused())
        throw new MessageQueuePausedError("Codex maintenance is in progress");
      const message = this.list(threadId).find((candidate) => candidate.id === messageId);
      if (!message) {
        const receipt = this.store.view().messageReceipts?.[messageId];
        if (receipt?.threadId === threadId && receipt.turnId) return receipt.turnId;
        throw new MessageQueueNotFoundError("Queued message not found");
      }
      if (message.status === "dispatching") {
        if (!(await this.reconcile(threadId, message, retryUnconfirmed))) {
          throw new MessageQueueConflictError("Delivery is still being confirmed");
        }
        const receipt = this.store.view().messageReceipts?.[messageId];
        if (receipt?.turnId) return receipt.turnId;
      }
      return this.dispatch(threadId, message, true);
    });
  }

  update(
    threadId: string,
    messageId: string,
    text: string,
    pastes?: PastedText,
  ): Promise<QueuedMessage> {
    return this.withLock(threadId, async () => {
      const current = this.list(threadId).find((candidate) => candidate.id === messageId);
      if (!current) throw new MessageQueueNotFoundError("Queued message not found");
      if (this.store.view().messageReceipts?.[messageId]?.status === "rejected") {
        throw new MessageQueueConflictError(
          "Отклонённое сообщение можно отменить и отправить заново.",
        );
      }
      const receipt = this.store.view().messageReceipts?.[messageId];
      if ((current.status !== "queued" && receipt?.status !== "rejected") || receipt?.request) {
        throw new MessageQueueConflictError("Queued message is already being sent");
      }
      const presentation = trimPastedMessage(
        text,
        pastes ?? rebasePastedText(current.text, text, current),
      );
      const trimmed = presentation.input;
      if (
        !trimmed &&
        !current.images?.length &&
        !current.files?.length &&
        !presentation.pasteBlocks?.length
      ) {
        throw new MessageQueueValidationError("Queued message text must not be empty");
      }
      const updated = {
        ...current,
        text: trimmed,
        inlinePastes: presentation.inlinePastes,
        pasteBlocks: presentation.pasteBlocks,
      };
      await this.store.update((state) => {
        const messages = state.messageQueues?.[threadId];
        if (!messages?.some((message) => message.id === messageId)) {
          throw new MessageQueueNotFoundError("Queued message not found");
        }
        state.messageQueues![threadId] = messages.map((message) =>
          message.id === messageId ? updated : message,
        );
      });
      this.publish(threadId);
      return updated;
    });
  }

  cancel(threadId: string, messageId: string): Promise<void> {
    return this.withLock(threadId, async () => {
      const current = this.list(threadId).find((candidate) => candidate.id === messageId);
      if (!current) throw new MessageQueueNotFoundError("Queued message not found");
      const receipt = this.store.view().messageReceipts?.[messageId];
      if ((current.status !== "queued" && receipt?.status !== "rejected") || receipt?.request) {
        throw new MessageQueueConflictError("Queued message is already being sent");
      }
      await this.store.update((state) => {
        state.messageReceipts ??= {};
        state.messageReceipts[messageId] = {
          ...state.messageReceipts[messageId],
          threadId,
          turnId: null,
          contentHash: messageContentHash(
            current.text,
            current.images ?? [],
            current.files ?? [],
            !!current.goal,
            current.replyToUserInput ?? current.replyToAsyncQuestion,
            current.dismissUserInput,
            current,
          ),
          status: "canceled",
          createdAt: Date.now(),
        };
        state.messageQueues![threadId] = (state.messageQueues?.[threadId] ?? []).filter(
          (message) => message.id !== messageId,
        );
        if (!state.messageQueues![threadId].length) delete state.messageQueues![threadId];
      });
      this.clearRetry(threadId);
      this.publish(threadId);
    });
  }

  drain(threadId: string): Promise<void> {
    return this.withLock(threadId, async () => {
      if (this.delivery.paused() || this.delivery.acceptsInput?.(threadId) === false) return;
      const messages = this.list(threadId);
      // Reconcile uncertain sends before allowing another message past them.
      if (messages.some((message) => message.status === "dispatching")) return;
      const active = this.delivery.currentTurnId(threadId) !== null;
      const message = active
        ? messages.find(
            (candidate) =>
              candidate.deliveryError?.retryable !== false &&
              (candidate.replyToAsyncQuestion ||
                candidate.replyToUserInput ||
                candidate.dismissUserInput),
          )
        : messages[0];
      if (!message || message.status !== "queued" || message.deliveryError?.retryable === false)
        return;
      if (this.retries.get(threadId)?.timer) return;
      await this.dispatch(
        threadId,
        message,
        Boolean(
          message.replyToAsyncQuestion || message.replyToUserInput || message.dismissUserInput,
        ),
      );
      if (message.replyToAsyncQuestion || message.replyToUserInput || message.dismissUserInput)
        void this.drain(threadId).catch(() => undefined);
    });
  }

  async recover(): Promise<void> {
    await Promise.all(
      Object.keys(this.store.view().messageQueues ?? {}).map((id) => this.recoverThread(id)),
    );
  }

  private async recoverThread(threadId: string): Promise<void> {
    await this.withLock(threadId, async () => {
      for (const message of this.list(threadId)) {
        // This regression rejected the command before contacting Codex. Only
        // unblock those unsent messages; ambiguous attempts must be reconciled.
        if (
          message.status === "queued" &&
          !this.store.view().messageReceipts?.[message.id] &&
          message.deliveryError?.message ===
            "Для надёжной отправки требуется совместимая сборка Codex. Сообщение сохранено."
        ) {
          await this.setStatus(threadId, message.id, "queued");
        }
        if (message.status !== "dispatching" || message.deliveryError?.retryable === false)
          continue;
        if (!(await this.reconcile(threadId, message))) break;
      }
    });
    await this.drain(threadId).catch(() => undefined);
  }

  private async reconcile(
    threadId: string,
    message: QueuedMessage,
    retryUnconfirmed = false,
  ): Promise<boolean> {
    try {
      const receipt = this.store.view().messageReceipts?.[message.id];
      if (
        this.delivery.requiresDurableReceipt !== undefined &&
        message.deliveryVersion !== 1 &&
        !receipt
      ) {
        throw new DeliveryContractError(
          "Старый Codex не подтвердил доставку. Автоматическая повторная отправка остановлена, чтобы избежать дубля.",
        );
      }
      const turnId =
        receipt?.turnId ??
        (await (retryUnconfirmed
          ? this.delivery.deliveredTurnId(threadId, message.id, true)
          : this.delivery.deliveredTurnId(threadId, message.id)));
      if (turnId) await this.remove(threadId, message.id, turnId, message);
      else await this.setStatus(threadId, message.id, "queued");
      return true;
    } catch (error) {
      await this.recordFailure(threadId, message.id, "dispatching", error);
      if (retryUnconfirmed) throw error;
      return false;
    }
  }

  async resume(): Promise<void> {
    this.suspended = false;
    const threadIds = Object.keys(this.store.view().messageQueues ?? {});
    await Promise.all(
      threadIds.map(async (threadId) => {
        if (
          this.list(threadId).some(
            (message) =>
              message.status === "dispatching" && message.deliveryError?.retryable !== false,
          )
        ) {
          this.scheduleRetry(threadId);
        } else {
          await this.drain(threadId).catch(() => undefined);
        }
      }),
    );
  }

  async pause(): Promise<void> {
    this.suspended = true;
    for (const retry of this.retries.values()) {
      if (retry.timer) clearTimeout(retry.timer);
      retry.timer = undefined;
    }
    await Promise.all([...this.locks.values()].map((pending) => pending.catch(() => undefined)));
  }

  async removeThread(threadId: string): Promise<void> {
    this.clearRetry(threadId);
    if (!this.store.view().messageQueues?.[threadId]) return;
    await this.store.update((state) => {
      if (state.messageQueues) delete state.messageQueues[threadId];
    });
    this.publish(threadId);
  }

  private async dispatch(
    threadId: string,
    message: QueuedMessage,
    allowSteer: boolean,
  ): Promise<string> {
    if (this.suspended) throw new MessageQueuePausedError("CodexNest is preparing to restart");
    if (this.delivery.acceptsInput?.(threadId) === false)
      throw new MessageQueueInputUnavailableError();
    const activeTurnId = message.replyToUserInput?.turnId ?? this.delivery.currentTurnId(threadId);
    if (activeTurnId && message.planImplementationMode) {
      throw new MessageQueueConflictError("Wait for the current turn before implementing the plan");
    }
    if (activeTurnId && !allowSteer) return activeTurnId;
    await this.setStatus(threadId, message.id, "dispatching");
    let turnId: string;
    try {
      if (this.delivery.acceptsInput?.(threadId) === false)
        throw new MessageQueueInputUnavailableError();
      turnId = activeTurnId
        ? await this.delivery.steer(threadId, activeTurnId, message)
        : await this.delivery.start(threadId, message);
    } catch (error) {
      if (error instanceof MessageQueueInputUnavailableError) {
        await this.setStatus(threadId, message.id, "queued");
        return Promise.reject(error);
      }
      if (isMissingThreadError(error) || isThreadNotLoadedError(error)) {
        await this.recordFailure(threadId, message.id, "queued", error);
        throw error;
      }
      try {
        const deliveredTurnId = await this.delivery.deliveredTurnId(threadId, message.id);
        if (deliveredTurnId) {
          await this.remove(threadId, message.id, deliveredTurnId, message);
          return deliveredTurnId;
        }
      } catch (deliveryError) {
        // Keep an ambiguous delivery parked until a later recovery can reconcile it.
        await this.recordFailure(threadId, message.id, "dispatching", deliveryError);
        throw error;
      }
      if (
        (message.replyToAsyncQuestion || message.dismissUserInput) &&
        activeTurnId &&
        (activeTurnId !== this.delivery.currentTurnId(threadId) ||
          (error instanceof RpcError && /no active turn|turn.*mismatch/i.test(error.message)))
      ) {
        // History confirmed that the reply was not delivered. Retry against the
        // new current turn (or start a follow-up if the previous one completed),
        // including when the completion notification follows the RPC error.
        await this.recordFailure(threadId, message.id, "queued", new Error("Active turn changed"));
        throw error;
      }
      await this.recordFailure(threadId, message.id, "queued", error);
      throw error;
    }
    await this.remove(threadId, message.id, turnId, message);
    return turnId;
  }

  private async setStatus(
    threadId: string,
    messageId: string,
    status: QueuedMessage["status"],
    deliveryError?: QueuedMessage["deliveryError"],
  ): Promise<void> {
    await this.store.update((state) => {
      const queue = state.messageQueues?.[threadId];
      if (!queue?.some((message) => message.id === messageId)) {
        throw new MessageQueueNotFoundError("Queued message not found");
      }
      state.messageQueues![threadId] = queue.map((message) =>
        message.id === messageId
          ? {
              ...message,
              status: state.messageReceipts?.[messageId]?.request ? "dispatching" : status,
              ...(this.delivery.requiresDurableReceipt ? { deliveryVersion: 1 as const } : {}),
              deliveryError,
            }
          : message,
      );
    });
    this.publish(threadId);
  }

  private async remove(
    threadId: string,
    messageId: string,
    deliveredTurnId?: string,
    deliveredMessage?: QueuedMessage,
  ): Promise<void> {
    await this.store.update((state) => {
      const queue = state.messageQueues?.[threadId] ?? [];
      state.messageQueues![threadId] = queue.filter((message) => message.id !== messageId);
      if (!state.messageQueues![threadId].length) delete state.messageQueues![threadId];
      if (deliveredTurnId && deliveredMessage) {
        state.messageReceipts ??= {};
        if (
          this.delivery.requiresDurableReceipt &&
          state.messageReceipts[messageId]?.status !== "delivered"
        ) {
          throw new DeliveryContractError("Codex не подтвердил сохранение сообщения.");
        }
        state.messageReceipts[messageId] = {
          ...state.messageReceipts[messageId],
          threadId,
          turnId: deliveredTurnId,
          ...(Object.keys(pastedText(deliveredMessage)).length
            ? { presentation: trimPastedMessage(deliveredMessage.text, deliveredMessage) }
            : {}),
          contentHash: messageContentHash(
            deliveredMessage.text,
            deliveredMessage.images ?? [],
            deliveredMessage.files ?? [],
            !!deliveredMessage.goal,
            deliveredMessage.replyToUserInput ?? deliveredMessage.replyToAsyncQuestion,
            deliveredMessage.dismissUserInput,
            deliveredMessage,
          ),
          createdAt: Date.now(),
        };
      }
    });
    this.clearRetry(threadId);
    this.publish(threadId);
  }

  private publish(threadId: string): void {
    this.delivery.publish(threadId, this.list(threadId));
  }

  private async recordFailure(
    threadId: string,
    messageId: string,
    status: QueuedMessage["status"],
    error: unknown,
  ): Promise<void> {
    const missing = isMissingThreadError(error);
    const retryable =
      !missing &&
      !(error instanceof MessageQueueValidationError) &&
      !(error instanceof DeliveryContractError) &&
      !(
        error instanceof RpcError &&
        [-32600, -32602].includes(error.code) &&
        !isThreadNotLoadedError(error)
      );
    await this.setStatus(threadId, messageId, status, {
      message: missing
        ? "Сессия недоступна. Сообщение сохранено."
        : error instanceof DeliveryContractError || error instanceof MessageQueueValidationError
          ? error.message
          : status === "dispatching"
            ? "Проверяем, было ли сообщение отправлено."
            : retryable
              ? "Codex временно недоступен. Повторим отправку. Сообщение сохранено."
              : "Не удалось отправить сообщение. Оно сохранено.",
      retryable,
    });
    if (retryable) this.scheduleRetry(threadId);
  }

  private scheduleRetry(threadId: string): void {
    if (this.suspended || this.retries.get(threadId)?.timer) return;
    const attempt = (this.retries.get(threadId)?.attempt ?? 0) + 1;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5));
    const timer = setTimeout(() => {
      const retry = this.retries.get(threadId);
      if (retry) retry.timer = undefined;
      void this.recoverThread(threadId).catch(() => this.scheduleRetry(threadId));
    }, delay);
    timer.unref();
    this.retries.set(threadId, { attempt, timer });
  }

  private clearRetry(threadId: string): void {
    const retry = this.retries.get(threadId);
    if (retry?.timer) clearTimeout(retry.timer);
    this.retries.delete(threadId);
  }

  private withLock<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(threadId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.locks.set(threadId, next);
    const cleanup = () => {
      if (this.locks.get(threadId) === next) this.locks.delete(threadId);
    };
    void next.then(cleanup, cleanup);
    return next;
  }
}

export function messageContentHash(
  text: string,
  images: readonly string[],
  files: readonly ThreadFileAttachment[],
  goal: boolean,
  reply?: unknown,
  dismissUserInput?: AsyncQuestionReference,
  pastes: PastedText & Pick<QueuedMessage, "planImplementationMode"> = {},
  planImplementationMode = pastes.planImplementationMode,
): string {
  const content: unknown[] = dismissUserInput
    ? [text.trim(), images, files, goal, reply ?? null, { dismissUserInput }]
    : reply !== undefined
      ? [text.trim(), images, files, goal, reply]
      : files.length
        ? [text.trim(), images, files, goal]
        : [text.trim(), images, goal];
  const normalized = pastedText(trimPastedMessage(text, pastes));
  if (Object.keys(normalized).length) content.push(normalized);
  if (planImplementationMode) content.push({ planImplementationMode });
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}
