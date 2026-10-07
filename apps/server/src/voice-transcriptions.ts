import {
  appendUserInputRecordings,
  replacePasteRanges,
  pastedText,
  trimPastedMessage,
} from "@codexnest/protocol";
import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type {
  ThreadDraft,
  UiLanguage,
  VoiceTranscriptionJob,
  VoiceTranscriptionMode,
  UserInputVoiceTarget,
  UpdateUserInputDraftRequest,
} from "@codexnest/protocol";

import type { MessageQueue } from "./message-queue";
import { userInputReplyMessageId, type AppProjection } from "./projection";
import type { StateStore, VoiceTranscriptionState } from "./state/store";
import { appendTranscriptionTimingSample, TranscriptionError } from "./transcription";

export const MAX_VOICE_QUEUE_BYTES = 240 * 1024 * 1024;
const VOICE_RETRY_DELAYS_MS = [60_000, 120_000, 300_000, 900_000, 1_800_000] as const;

type VoiceTranscriptionManagerOptions = {
  store: StateStore;
  projection: Pick<AppProjection, "publishVoiceTranscription" | "removeVoiceTranscription"> &
    Partial<Pick<AppProjection, "userInputVoiceRequest" | "publishUserInputDraft">>;
  transcription: {
    transcribe(audio: Buffer, contentType: string, signal?: AbortSignal): Promise<string>;
  };
  queue: Pick<MessageQueue, "enqueue" | "sendNow">;
  onWarning?(error: unknown, message: string): void;
};

type AcceptVoiceTranscription = {
  clientUploadId?: string;
  threadId: string;
  mode: VoiceTranscriptionMode;
  dismissUserInput?: VoiceTranscriptionJob["dismissUserInput"];
  userInput?: UserInputVoiceTarget;
  audio: Buffer;
  contentType: "audio/webm" | "audio/mp4";
  audioDurationMs: number;
  estimatedTotalSeconds: number | null;
  selectionStart: number;
  selectionEnd: number;
  expectedDraftUpdatedAt: number | null;
  timingProfile: string | null;
};

export class VoiceTranscriptionConflictError extends Error {}
export class VoiceTranscriptionDraftConflictError extends VoiceTranscriptionConflictError {}
export class VoiceTranscriptionQueueFullError extends Error {}

export class VoiceTranscriptionManager {
  private readonly directory: string;
  private acceptChain: Promise<void> = Promise.resolve();
  private worker: Promise<void> | null = null;
  private startup: Promise<void> | null = null;
  private stopped = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private activeJob: {
    jobId: string;
    controller: AbortController;
    settled: Promise<void>;
  } | null = null;

  constructor(private readonly options: VoiceTranscriptionManagerOptions) {
    this.directory = join(
      dirname(options.store.path),
      `${basename(options.store.path)}.voice-transcriptions`,
    );
  }

  start(): Promise<void> {
    this.startup ??= this.initialize();
    return this.startup;
  }

  private async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.options.store.update((state) => {
      for (const job of Object.values(state.voiceTranscriptions ?? {})) {
        if (job.status === "transcribing") {
          job.status = "queued";
          job.startedAt = null;
          job.error = null;
          job.nextAttemptAt = Date.now();
        }
      }
    });
    await this.removeOrphanedAudio();
    this.kick();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.activeJob?.controller.abort();
  }

  job(threadId: string): VoiceTranscriptionState | null {
    return this.options.store.view().voiceTranscriptions?.[threadId] ?? null;
  }

  active(threadId: string): boolean {
    const status = this.job(threadId)?.status;
    return status === "queued" || status === "transcribing" || status === "applying";
  }

  duplicate(threadId: string, clientUploadId: string): VoiceTranscriptionJob | null | undefined {
    const existing =
      this.options.store.view().voiceTranscriptions?.[`question:${clientUploadId}`] ??
      this.job(threadId);
    if (existing && existing.threadId !== threadId)
      throw new VoiceTranscriptionConflictError("Voice upload id belongs to another thread");
    if (existing?.id === clientUploadId) return publicJob(existing);
    if (
      this.options.store.view().voiceReceipts?.[clientUploadId] ||
      this.options.store.view().messageReceipts?.[clientUploadId]
    ) {
      return null;
    }
    return undefined;
  }

  accept(input: AcceptVoiceTranscription): Promise<VoiceTranscriptionJob | null> {
    let accepted!: VoiceTranscriptionJob | null;
    const task = this.acceptChain
      .catch(() => undefined)
      .then(async () => {
        await this.start();
        accepted = await this.acceptUnlocked(input);
      });
    this.acceptChain = task;
    return task.then(() => accepted);
  }

  async clearFailure(threadId: string): Promise<void> {
    const current = this.job(threadId);
    if (current?.status !== "failed") return;
    await this.options.store.update((state) => {
      if (state.voiceTranscriptions?.[threadId]?.id !== current.id) return;
      delete state.voiceTranscriptions[threadId];
    });
    if (current.audioFile) await unlink(this.audioPath(current.audioFile)).catch(() => undefined);
    this.options.projection.removeVoiceTranscription(threadId, current.id, "cancelled");
  }

  async cancelThread(threadId: string): Promise<void> {
    const current = this.job(threadId);
    if (!current) return;
    const active = this.activeJob?.jobId === current.id ? this.activeJob : null;
    await this.options.store.update((state) => {
      if (state.voiceTranscriptions?.[threadId]?.id === current.id) {
        delete state.voiceTranscriptions[threadId];
      }
    });
    active?.controller.abort();
    if (current.audioFile) await unlink(this.audioPath(current.audioFile)).catch(() => undefined);
    await active?.settled;
    this.options.projection.removeVoiceTranscription(threadId, current.id, "cancelled");
  }

  private async acceptUnlocked(
    input: AcceptVoiceTranscription,
  ): Promise<VoiceTranscriptionJob | null> {
    const requestedId = input.clientUploadId;
    const duplicate = requestedId ? this.duplicate(input.threadId, requestedId) : undefined;
    if (duplicate !== undefined) return duplicate;
    const existing = this.job(input.threadId);
    if (!input.userInput && existing && existing.status !== "failed") {
      throw new VoiceTranscriptionConflictError(
        "A voice transcription is already active in this thread",
      );
    }
    const activeBytes = Object.values(this.options.store.view().voiceTranscriptions ?? {}).reduce(
      (total, job) => total + job.audioBytes,
      0,
    );
    if (activeBytes + input.audio.length > MAX_VOICE_QUEUE_BYTES) {
      throw new VoiceTranscriptionQueueFullError("Voice transcription queue is full");
    }

    const id = requestedId ?? randomUUID();
    const extension = input.contentType === "audio/mp4" ? "mp4" : "webm";
    const audioFile = `${id}.${extension}`;
    const temporary = `${audioFile}.${process.pid}.tmp`;
    await this.writeAudio(temporary, audioFile, input.audio);
    const state: VoiceTranscriptionState = {
      id,
      threadId: input.threadId,
      mode: input.mode,
      ...(input.dismissUserInput ? { dismissUserInput: input.dismissUserInput } : {}),
      ...(input.userInput ? { userInput: input.userInput } : {}),
      status: "queued",
      createdAt: Date.now(),
      startedAt: null,
      audioDurationMs: input.audioDurationMs,
      estimatedTotalSeconds: input.estimatedTotalSeconds,
      error: null,
      contentType: input.contentType,
      audioFile,
      audioBytes: input.audio.length,
      selectionStart: input.selectionStart,
      selectionEnd: input.selectionEnd,
      attempts: 0,
      nextAttemptAt: Date.now(),
      ...(input.timingProfile ? { timingProfile: input.timingProfile } : {}),
    };
    try {
      await this.options.store.update((draft) => {
        draft.voiceTranscriptions ??= {};
        const current = draft.voiceTranscriptions[voiceJobKey(state)];
        if (current && current.status !== "failed") {
          throw new VoiceTranscriptionConflictError(
            "A voice transcription is already active in this thread",
          );
        }
        const queuedBytes = Object.values(draft.voiceTranscriptions).reduce(
          (total, job) => total + job.audioBytes,
          0,
        );
        if (queuedBytes + input.audio.length > MAX_VOICE_QUEUE_BYTES) {
          throw new VoiceTranscriptionQueueFullError("Voice transcription queue is full");
        }
        if (input.userInput) {
          const target = input.userInput;
          const questionDraft =
            draft.threadMeta[input.threadId]?.userInputDrafts?.[target.draftKey];
          if (!questionDraft || questionDraft.submission)
            throw new VoiceTranscriptionConflictError(
              "Question is closed or already being submitted",
            );
          if (
            Object.values(draft.voiceTranscriptions).some(
              (job) =>
                job.threadId === input.threadId &&
                job.userInput?.draftKey === target.draftKey &&
                job.userInput.questionId === target.questionId &&
                job.userInput.order === target.order,
            )
          ) {
            throw new VoiceTranscriptionConflictError("Recording order is already occupied");
          }
        } else {
          const threadDraft = draft.threadMeta[input.threadId]?.draft;
          if (
            (threadDraft?.updatedAt ?? null) !== input.expectedDraftUpdatedAt ||
            input.selectionStart > (threadDraft?.input.length ?? 0) ||
            input.selectionEnd > (threadDraft?.input.length ?? 0)
          ) {
            throw new VoiceTranscriptionDraftConflictError("The draft changed before voice upload");
          }
        }
        draft.voiceTranscriptions[voiceJobKey(state)] = state;
      });
    } catch (error) {
      await unlink(this.audioPath(audioFile)).catch(() => undefined);
      throw error;
    }
    this.options.projection.publishVoiceTranscription(state);
    setImmediate(() => this.kick());
    return publicJob(state);
  }

  private async writeAudio(temporary: string, target: string, audio: Buffer): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporaryPath = this.audioPath(temporary);
    const targetPath = this.audioPath(target);
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(audio);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporaryPath, targetPath);
      const directory = await open(this.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  wake(): void {
    if (this.worker) {
      this.wakeAgain = true;
      return;
    }
    this.kick();
  }

  private wakeAgain = false;

  private kick(): void {
    if (this.stopped || this.worker) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.worker = this.run()
      .catch((error: unknown) => {
        this.options.onWarning?.(error, "Voice transcription worker failed");
      })
      .finally(() => {
        this.worker = null;
        if (this.stopped) return;
        if (this.wakeAgain || this.nextJob()) {
          this.wakeAgain = false;
          this.kick();
        } else this.scheduleNextRetry();
      });
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      await this.cleanClosedUserInputs();
      await this.finishUserInputSubmissions();
      const job = this.nextJob();
      if (!job) return;
      const controller = new AbortController();
      let settle!: () => void;
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      this.activeJob = { jobId: job.id, controller, settled };
      try {
        if (job.status !== "applying") await this.transcribe(job, controller.signal);
        const current = this.options.store.view().voiceTranscriptions?.[voiceJobKey(job)];
        if (current?.id === job.id && current.status === "applying") {
          await this.apply(current);
        }
      } catch (error) {
        if (!this.stopped) await this.fail(job, error);
      } finally {
        if (this.activeJob?.jobId === job.id) this.activeJob = null;
        settle();
      }
    }
  }

  private nextJob(): VoiceTranscriptionState | null {
    const now = Date.now();
    return (
      Object.values(this.options.store.view().voiceTranscriptions ?? {})
        .filter(
          (job) =>
            ["queued", "transcribing", "applying"].includes(job.status) &&
            (job.nextAttemptAt ?? 0) <= now &&
            this.previousQuestionRecordingsComplete(job),
        )
        .sort((left, right) => left.createdAt - right.createdAt)[0] ?? null
    );
  }

  private previousQuestionRecordingsComplete(job: VoiceTranscriptionState): boolean {
    if (!job.userInput || job.userInput.order === 1) return true;
    const previous = Object.values(this.options.store.view().voiceTranscriptions ?? {}).filter(
      (candidate) =>
        candidate.threadId === job.threadId &&
        candidate.userInput?.draftKey === job.userInput!.draftKey &&
        candidate.userInput.questionId === job.userInput!.questionId &&
        candidate.userInput.order < job.userInput!.order,
    );
    return (
      previous.length === job.userInput.order - 1 &&
      previous.every((candidate) => candidate.status === "completed")
    );
  }

  async submitUserInput(
    threadId: string,
    draftKey: string,
    input: UpdateUserInputDraftRequest,
    recordingIds: string[],
  ): Promise<void> {
    await this.options.store.update((state) => {
      const draft = state.threadMeta[threadId]?.userInputDrafts?.[draftKey];
      if (!draft) throw new VoiceTranscriptionConflictError("Question is no longer available");
      if (draft.submission) {
        if (draft.submission.status === "failed") {
          draft.submission.status = "waiting";
          delete draft.submission.error;
        }
        return;
      }
      const recordings = Object.values(state.voiceTranscriptions ?? {}).filter(
        (job) => job.threadId === threadId && job.userInput?.draftKey === draftKey,
      );
      if (
        new Set(recordingIds).size !== recordings.length ||
        recordings.some((job) => !recordingIds.includes(job.id))
      ) {
        throw new VoiceTranscriptionConflictError(
          "Wait for all voice uploads before submitting answers",
        );
      }
      Object.assign(draft, appendUserInputRecordings(input, recordings));
      draft.submission = {
        recordingIds,
        clientMessageId: userInputReplyMessageId(threadId, draft.turnId, draft.itemId),
        status: "waiting",
      };
      draft.revision += 1;
      draft.updatedAt = Date.now();
    });
    this.options.projection.publishUserInputDraft?.(threadId, draftKey);
    this.wake();
  }

  async cancelUserInputSubmission(threadId: string, draftKey: string): Promise<void> {
    await this.options.store.update((state) => {
      const draft = state.threadMeta[threadId]?.userInputDrafts?.[draftKey];
      if (!draft) throw new VoiceTranscriptionConflictError("Question is no longer available");
      if (draft.submission?.status === "sending")
        throw new VoiceTranscriptionConflictError("Answers have already been sent");
      delete draft.submission;
      draft.revision += 1;
      draft.updatedAt = Date.now();
    });
    this.options.projection.publishUserInputDraft?.(threadId, draftKey);
  }

  async retryUserInputRecording(threadId: string, jobId: string): Promise<void> {
    let retrying: VoiceTranscriptionState | undefined;
    await this.options.store.update((state) => {
      const job = state.voiceTranscriptions?.[`question:${jobId}`];
      if (
        !job?.userInput ||
        job.threadId !== threadId ||
        !state.threadMeta[threadId]?.userInputDrafts?.[job.userInput.draftKey]
      ) {
        throw new VoiceTranscriptionConflictError("Recording is no longer available");
      }
      if (job.status === "failed" || job.status === "queued") {
        job.status = "queued";
        job.startedAt = null;
        job.error = null;
        job.nextAttemptAt = Date.now();
        retrying = { ...job };
      }
    });
    if (retrying) this.options.projection.publishVoiceTranscription(retrying);
    this.wake();
  }

  private async cleanClosedUserInputs(): Promise<void> {
    const snapshot = this.options.store.view();
    const closed = Object.values(snapshot.voiceTranscriptions ?? {}).filter(
      (job) =>
        job.userInput &&
        !snapshot.threadMeta[job.threadId]?.userInputDrafts?.[job.userInput.draftKey],
    );
    if (!closed.length) return;
    await this.options.store.update((state) => {
      for (const job of closed) delete state.voiceTranscriptions?.[voiceJobKey(job)];
    });
    for (const job of closed) {
      if (job.audioFile) await unlink(this.audioPath(job.audioFile)).catch(() => undefined);
      this.options.projection.removeVoiceTranscription(job.threadId, job.id, "cancelled");
    }
  }

  private async applyToUserInput(job: VoiceTranscriptionState, transcript: string): Promise<void> {
    let completed: VoiceTranscriptionState | undefined;
    await this.options.store.update((state) => {
      const current = state.voiceTranscriptions?.[voiceJobKey(job)];
      const draft = state.threadMeta[job.threadId]?.userInputDrafts?.[job.userInput!.draftKey];
      if (!current || current.id !== job.id || !draft || current.status === "completed") return;
      current.status = "completed";
      current.transcript = transcript;
      current.audioBytes = 0;
      delete current.audioFile;
      Object.assign(draft, appendUserInputRecordings(draft, [current]));
      draft.revision += 1;
      draft.updatedAt = Date.now();
      completed = { ...current };
    });
    if (completed) this.options.projection.publishVoiceTranscription(completed);
  }

  private async finishUserInputSubmissions(): Promise<void> {
    for (const [threadId, meta] of Object.entries(this.options.store.view().threadMeta)) {
      for (const [draftKey, saved] of Object.entries(meta.userInputDrafts ?? {})) {
        const submission = saved.submission;
        if (!submission || submission.status === "failed") continue;
        const request = this.options.projection.userInputVoiceRequest?.(threadId, draftKey);
        if (!request) continue;
        const snapshot = this.options.store.view();
        if (
          snapshot.messageQueues?.[threadId]?.some(
            (message) => message.id === submission.clientMessageId,
          ) ||
          snapshot.messageReceipts?.[submission.clientMessageId]?.status === "delivered"
        )
          continue;
        if (
          submission.recordingIds.some(
            (id) => snapshot.voiceTranscriptions?.[`question:${id}`]?.status !== "completed",
          )
        )
          continue;
        let answers: Record<string, string[]> | undefined;
        await this.options.store.update((state) => {
          const draft = state.threadMeta[threadId]?.userInputDrafts?.[draftKey];
          if (!draft?.submission || draft.submission.clientMessageId !== submission.clientMessageId)
            return;
          draft.submission.status = "sending";
          draft.revision += 1;
          answers = Object.fromEntries(
            Object.entries(draft.answers).map(([id, values]) => [id, [...values]]),
          );
        });
        if (!answers) continue;
        this.options.projection.publishUserInputDraft?.(threadId, draftKey);
        try {
          await this.options.queue.enqueue(
            threadId,
            request.questions
              .map(
                (question) => `${question.question}\n${(answers![question.id] ?? []).join("\n")}`,
              )
              .join("\n\n"),
            [],
            submission.clientMessageId,
            { replyToUserInput: { turnId: saved.turnId, itemId: saved.itemId, answers } },
          );
        } catch (error) {
          await this.options.store.update((state) => {
            const current = state.threadMeta[threadId]?.userInputDrafts?.[draftKey];
            if (
              !current?.submission ||
              current.submission.clientMessageId !== submission.clientMessageId
            )
              return;
            current.submission.status = "failed";
            current.submission.error =
              error instanceof Error ? error.message : "Could not submit answers";
            current.revision += 1;
          });
          this.options.projection.publishUserInputDraft?.(threadId, draftKey);
        }
      }
    }
  }

  private async transcribe(job: VoiceTranscriptionState, signal: AbortSignal): Promise<void> {
    if (!job.audioFile) throw new Error("Saved audio is missing");
    const startedAt = Date.now();
    let active: VoiceTranscriptionState | null = null;
    await this.options.store.update((state) => {
      const current = state.voiceTranscriptions?.[voiceJobKey(job)];
      if (!current || current.id !== job.id) return;
      current.status = "transcribing";
      current.startedAt = startedAt;
      current.error = null;
      delete current.nextAttemptAt;
      active = { ...current };
    });
    if (!active) return;
    this.options.projection.publishVoiceTranscription(active);

    const audio = await readFile(this.audioPath(job.audioFile));
    const transcript = await this.options.transcription.transcribe(audio, job.contentType, signal);
    const processingMs = Math.max(1, Date.now() - startedAt);
    let applying: VoiceTranscriptionState | null = null;
    await this.options.store.update((state) => {
      const current = state.voiceTranscriptions?.[voiceJobKey(job)];
      if (!current || current.id !== job.id) return;
      current.status = "applying";
      current.transcript = transcript.trim();
      current.error = null;
      current.attempts = 0;
      delete current.nextAttemptAt;
      if (current.timingProfile) {
        state.transcriptionTimings ??= {};
        state.transcriptionTimings[current.timingProfile] = appendTranscriptionTimingSample(
          state.transcriptionTimings[current.timingProfile],
          { audioDurationMs: current.audioDurationMs, processingMs },
        );
      }
      applying = { ...current };
    });
    if (applying) this.options.projection.publishVoiceTranscription(applying);
  }

  private async apply(job: VoiceTranscriptionState): Promise<void> {
    const transcript = job.transcript?.trim();
    if (!transcript) throw new Error("Transcription returned no text");
    if (job.userInput) {
      await this.applyToUserInput(job, transcript);
    } else if (job.mode === "draft") {
      await this.applyToDraft(job, transcript);
    } else {
      await this.applyToQueue(job, transcript);
    }
    if (job.audioFile) await unlink(this.audioPath(job.audioFile)).catch(() => undefined);
  }

  private async applyToDraft(job: VoiceTranscriptionState, transcript: string): Promise<void> {
    await this.options.store.update((state) => {
      const current = state.voiceTranscriptions?.[voiceJobKey(job)];
      if (!current || current.id !== job.id) return;
      const meta = state.threadMeta[job.threadId] ?? {
        pinned: false,
        lastReadUpdatedAt: 0,
      };
      const draft = meta.draft ?? emptyDraft();
      meta.draft = {
        ...insertTranscript(draft, job.selectionStart, job.selectionEnd, transcript),
        updatedAt: Math.max(Date.now(), (meta.draft?.updatedAt ?? -1) + 1),
      };
      state.threadMeta[job.threadId] = meta;
      state.voiceReceipts ??= {};
      state.voiceReceipts[job.id] = { threadId: job.threadId, createdAt: Date.now() };
      delete state.voiceTranscriptions![voiceJobKey(job)];
    });
    this.options.projection.removeVoiceTranscription(job.threadId, job.id, "draft");
  }

  private async applyToQueue(job: VoiceTranscriptionState, transcript: string): Promise<void> {
    const snapshot = this.options.store.view();
    const draft = structuredClone(snapshot.threadMeta[job.threadId]?.draft ?? emptyDraft()) as Omit<
      ThreadDraft,
      "updatedAt"
    >;
    const inserted = insertTranscript(draft, job.selectionStart, job.selectionEnd, transcript);
    const text = formatDraftMessage(inserted, snapshot.uiLanguage);
    await this.options.queue.enqueue(
      job.threadId,
      text,
      inserted.images.map((image) => image.url),
      job.id,
      {
        goal: inserted.goalMode,
        ...pastedText(trimPastedMessage(inserted.input, inserted)),
        ...(inserted.files?.length ? { files: inserted.files } : {}),
        completeVoiceTranscriptionId: job.id,
        ...(job.dismissUserInput ? { dismissUserInput: job.dismissUserInput } : {}),
      },
    );
    await this.options.store.update((state) => {
      state.voiceReceipts ??= {};
      state.voiceReceipts[job.id] = { threadId: job.threadId, createdAt: Date.now() };
    });
    if (job.mode === "steer") {
      try {
        await this.options.queue.sendNow(job.threadId, job.id);
      } catch (error) {
        this.options.onWarning?.(error, "Voice steering failed; the message remains in the queue");
      }
    }
    this.options.projection.removeVoiceTranscription(job.threadId, job.id, "send");
  }

  private async fail(job: VoiceTranscriptionState, error: unknown): Promise<void> {
    if (!(error instanceof TranscriptionError) || error.kind === "validation") {
      await this.failPermanently(job, error);
      return;
    }
    let retrying: VoiceTranscriptionState | null = null;
    await this.options.store.update((state) => {
      const current = state.voiceTranscriptions?.[voiceJobKey(job)];
      if (!current || current.id !== job.id) return;
      const attempts = (current.attempts ?? 0) + 1;
      const base =
        VOICE_RETRY_DELAYS_MS[Math.min(attempts - 1, VOICE_RETRY_DELAYS_MS.length - 1)] ??
        1_800_000;
      current.status = "queued";
      current.startedAt = null;
      current.attempts = attempts;
      current.nextAttemptAt = Date.now() + Math.round(base * (0.8 + Math.random() * 0.4));
      current.error = error.message;
      retrying = { ...current };
    });
    if (retrying) this.options.projection.publishVoiceTranscription(retrying);
  }

  private async failPermanently(job: VoiceTranscriptionState, error: unknown): Promise<void> {
    let failed: VoiceTranscriptionState | null = null;
    await this.options.store.update((state) => {
      const current = state.voiceTranscriptions?.[voiceJobKey(job)];
      if (!current || current.id !== job.id) return;
      current.status = "failed";
      current.error = error instanceof Error ? error.message : "Voice transcription failed";
      delete current.nextAttemptAt;
      delete current.transcript;
      failed = { ...current };
    });
    if (failed) this.options.projection.publishVoiceTranscription(failed);
  }

  private scheduleNextRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const nextAttemptAt = Object.values(this.options.store.view().voiceTranscriptions ?? {})
      .filter(
        (job) =>
          job.status === "queued" &&
          job.nextAttemptAt &&
          this.previousQuestionRecordingsComplete(job),
      )
      .reduce<number | null>(
        (earliest, job) =>
          earliest === null ? job.nextAttemptAt! : Math.min(earliest, job.nextAttemptAt!),
        null,
      );
    if (nextAttemptAt === null) return;
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null;
        this.kick();
      },
      Math.max(0, nextAttemptAt - Date.now()),
    );
    this.retryTimer.unref();
  }

  private async removeOrphanedAudio(): Promise<void> {
    const referenced = new Set(
      Object.values(this.options.store.view().voiceTranscriptions ?? {}).flatMap((job) =>
        job.audioFile ? [job.audioFile] : [],
      ),
    );
    const files = await readdir(this.directory).catch(() => []);
    await Promise.all(
      files
        .filter((file) => !referenced.has(file))
        .map((file) => unlink(this.audioPath(file)).catch(() => undefined)),
    );
  }

  private audioPath(file: string): string {
    return join(this.directory, file);
  }
}

export function voiceJobKey(
  job: Pick<VoiceTranscriptionState, "threadId" | "id" | "userInput">,
): string {
  return job.userInput ? `question:${job.id}` : job.threadId;
}

export function publicJob(job: VoiceTranscriptionState): VoiceTranscriptionJob {
  return {
    id: job.id,
    threadId: job.threadId,
    mode: job.mode,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    audioDurationMs: job.audioDurationMs,
    estimatedTotalSeconds: job.estimatedTotalSeconds,
    error: job.error,
    ...(job.dismissUserInput ? { dismissUserInput: job.dismissUserInput } : {}),
    ...(job.userInput
      ? { userInput: job.userInput, ...(job.transcript ? { transcript: job.transcript } : {}) }
      : {}),
  };
}

export function insertTranscript(
  draft: Omit<ThreadDraft, "updatedAt">,
  selectionStart: number,
  selectionEnd: number,
  transcript: string,
): Omit<ThreadDraft, "updatedAt"> {
  const clean = transcript.trim();
  if (!clean) throw new Error("Transcription returned no text");
  const start = Math.min(selectionStart, draft.input.length);
  const end = Math.max(start, Math.min(selectionEnd, draft.input.length));
  const before = draft.input.slice(0, start);
  const after = draft.input.slice(end);
  const leading = before && !/\s$/.test(before) ? " " : "";
  const trailing = after && !/^\s/.test(after) ? " " : "";
  const completeInsertion = `${leading}${clean}${trailing}`;
  const inserted = draft.goalMode
    ? completeInsertion.slice(0, Math.max(0, 4_000 - before.length - after.length))
    : completeInsertion;
  return {
    ...draft,
    input: `${before}${inserted}${after}`,
    ...(draft.inlinePastes?.length
      ? { inlinePastes: replacePasteRanges(draft.inlinePastes, start, end, inserted.length) }
      : {}),
  };
}

function emptyDraft(): Omit<ThreadDraft, "updatedAt"> {
  return { input: "", images: [], goalMode: false, annotations: [] };
}

function formatDraftMessage(draft: Omit<ThreadDraft, "updatedAt">, language: UiLanguage): string {
  const sections: string[] = [];
  const message = draft.input.trim();
  if (message) sections.push(message);
  if (draft.annotations.length) {
    const title =
      language === "en"
        ? "## Annotations for the agent's previous response"
        : "## Аннотации к предыдущему ответу агента";
    const annotationLabel = language === "en" ? "Annotation" : "Аннотация";
    const quoteLabel = language === "en" ? "Selected text:" : "Выделенный текст:";
    const commentLabel = language === "en" ? "Comment:" : "Комментарий:";
    sections.push(
      [
        title,
        ...draft.annotations.map((annotation, index) =>
          [
            `### ${annotationLabel} ${index + 1}`,
            quoteLabel,
            annotation.quote
              .split("\n")
              .map((line) => `> ${line}`)
              .join("\n"),
            commentLabel,
            annotation.comment.trim(),
          ].join("\n\n"),
        ),
      ].join("\n\n"),
    );
  }
  return sections.join("\n\n");
}
