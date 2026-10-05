import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import { replacePasteRanges, serializePastedMessage } from "@codexnest/protocol";
import type { QueueMessageRequest, ThreadDraft, VoiceTranscriptionJob } from "@codexnest/protocol";

import type { UiService } from "./ui-service";
import type { StoredVoice } from "./ui-store";
import { AppError } from "./types";
import {
  MAX_RECORDING_SECONDS,
  MAX_TRANSCRIPTION_BYTES,
  VoiceServiceError,
  type ClaudeVoiceService,
} from "./voice";

export const MAX_VOICE_QUEUE_BYTES = 240 * 1024 * 1024;

export interface VoiceUploadQuery {
  mode?: unknown;
  selectionStart?: unknown;
  selectionEnd?: unknown;
  draftUpdatedAt?: unknown;
  clientUploadId?: unknown;
  userInput?: unknown;
  dismissUserInput?: unknown;
}

type VoiceRecord = StoredVoice & {
  fingerprint?: string;
  audioBytes?: number;
  sendInput?: QueueMessageRequest;
  sendDraftUpdatedAt?: number | null;
};

/** Durable upload admission and application; conversation delivery stays in UiService. */
export class UiVoiceJobs {
  private readonly directory: string;
  private initialization?: Promise<void>;
  private admissions: Promise<unknown> = Promise.resolve();
  private worker?: Promise<void>;
  private active?: { id: string; controller: AbortController };
  private closed = false;

  constructor(
    private readonly ui: UiService,
    private readonly voice: Pick<ClaudeVoiceService, "transcribe">,
  ) {
    this.directory = join(ui.manager.config.stateDir, "voice");
  }

  initialize(): Promise<void> {
    this.initialization ??= (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await chmod(this.directory, 0o700);
      await this.ui.store.update((data) => {
        for (const record of Object.values(data.voice)) {
          if (record.cancelled || record.applied) continue;
          if (!data.threads[record.job.threadId]) {
            record.cancelled = true;
            continue;
          }
          if (record.job.status === "transcribing") {
            record.job.status = "queued";
            record.job.startedAt = null;
            record.job.error = null;
          }
        }
      });
      for (const record of this.records()) {
        if (record.cancelled || record.applied) await this.removeAudio(record);
      }
      this.kick();
    })();
    return this.initialization;
  }

  create(
    threadId: string,
    audio: Buffer,
    contentType: string,
    query: VoiceUploadQuery,
    audioDurationMs: number,
  ): Promise<VoiceTranscriptionJob | null> {
    const operation = this.admissions
      .catch(() => undefined)
      .then(async () => {
        await this.initialize();
        if (this.closed) throw new AppError("unavailable", "Voice processing is stopping", 503);
        this.ui.thread(threadId);
        const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
        if (mediaType !== "audio/webm" && mediaType !== "audio/mp4")
          throw new AppError("invalid_request", "Audio must be WebM or MP4");
        if (!Buffer.isBuffer(audio) || !audio.length || audio.length > MAX_TRANSCRIPTION_BYTES)
          throw new AppError("invalid_request", "Audio must be nonempty and at most 24 MiB");
        if (
          !Number.isFinite(audioDurationMs) ||
          audioDurationMs <= 0 ||
          audioDurationMs > MAX_RECORDING_SECONDS * 1000
        )
          throw new AppError("invalid_request", "Audio duration must be at most 300 seconds");
        const mode = query.mode ?? "draft";
        if (mode !== "draft" && mode !== "send" && mode !== "queue")
          throw new AppError("invalid_request", "Voice mode must be draft, send, or queue");
        if (query.userInput !== undefined || query.dismissUserInput !== undefined)
          throw new AppError(
            "invalid_request",
            "Claude question recording uses the synchronous transcription endpoint",
          );
        const selectionStart = integer(query.selectionStart ?? 0, "selectionStart");
        const selectionEnd = integer(query.selectionEnd ?? selectionStart, "selectionEnd");
        if (selectionEnd < selectionStart)
          throw new AppError("invalid_request", "Invalid voice selection");
        const revision =
          query.draftUpdatedAt === "none" || query.draftUpdatedAt === null
            ? null
            : query.draftUpdatedAt === undefined
              ? (this.ui.thread(threadId).draft?.updatedAt ?? null)
              : integer(query.draftUpdatedAt, "draftUpdatedAt");
        const uploadId = query.clientUploadId;
        if (
          uploadId !== undefined &&
          (typeof uploadId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(uploadId))
        )
          throw new AppError("invalid_request", "Invalid voice upload ID");
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify({
              threadId,
              mode,
              mediaType,
              selectionStart,
              selectionEnd,
              revision,
              audioDurationMs,
            }),
          )
          .update(audio)
          .digest("hex");
        const oldId =
          uploadId === undefined ? undefined : this.ui.store.data.voiceUploads[uploadId as string];
        if (oldId) {
          const existing = this.ui.store.data.voice[oldId] as VoiceRecord | undefined;
          if (
            !existing ||
            existing.job.threadId !== threadId ||
            existing.fingerprint !== fingerprint
          )
            throw new AppError(
              "conflict",
              "Voice upload ID was reused for a different recording",
              409,
            );
          return existing.cancelled || existing.applied ? null : structuredClone(existing.job);
        }
        const id = randomUUID();
        const audioPath = join(
          this.directory,
          `${id}.${mediaType === "audio/mp4" ? "mp4" : "webm"}`,
        );
        const record: VoiceRecord = {
          job: {
            id,
            threadId,
            mode,
            status: "queued",
            createdAt: Date.now(),
            startedAt: null,
            audioDurationMs,
            estimatedTotalSeconds: null,
            error: null,
          },
          audioPath,
          contentType: mediaType,
          selectionStart,
          selectionEnd,
          draftUpdatedAt: revision,
          fingerprint,
          audioBytes: audio.length,
        };
        const retired: VoiceRecord[] = [];
        await this.writeAudio(audioPath, audio);
        try {
          await this.ui.store.update((data) => {
            if (this.closed) throw new AppError("unavailable", "Voice processing is stopping", 503);
            const thread = data.threads[threadId];
            if (!thread) throw new AppError("not_found", "Session not found", 404);
            if ((thread.draft?.updatedAt ?? null) !== revision)
              throw new AppError(
                "draft_conflict",
                "Draft changed before the recording upload",
                409,
              );
            if (selectionEnd > (thread.draft?.input.length ?? 0))
              throw new AppError("invalid_request", "Voice selection is outside the draft");
            let bytes = audio.length;
            for (const value of Object.values(data.voice) as VoiceRecord[]) {
              if (value.cancelled || value.applied) continue;
              bytes += value.audioBytes ?? 0;
              if (value.job.threadId === threadId) {
                if (value.job.status !== "failed")
                  throw new AppError(
                    "conflict",
                    "Voice transcription is already active in this session",
                    409,
                  );
                if (value.sendInput)
                  throw new AppError(
                    "conflict",
                    "Retry or reconcile the previous voice delivery before creating another",
                    409,
                  );
                value.cancelled = true;
                retired.push(structuredClone(value));
              }
            }
            if (bytes > MAX_VOICE_QUEUE_BYTES)
              throw new AppError("conflict", "Voice transcription queue is full", 409);
            data.voice[id] = record;
            if (typeof uploadId === "string") data.voiceUploads[uploadId] = id;
          });
        } catch (error) {
          await unlink(audioPath).catch(() => undefined);
          throw error;
        }
        for (const prior of retired) {
          await this.removeAudio(prior);
          this.ui.publish({
            type: "voiceTranscription.removed",
            threadId,
            jobId: prior.job.id,
            outcome: "cancelled",
          });
        }
        this.ui.publish({ type: "voiceTranscription.upserted", job: structuredClone(record.job) });
        this.kick();
        return structuredClone(record.job);
      });
    this.admissions = operation;
    return operation;
  }

  async cancel(threadId: string): Promise<void> {
    const cancelled: VoiceRecord[] = [];
    await this.ui.store.update((data) => {
      const current = (Object.values(data.voice) as VoiceRecord[]).filter(
        (record) => record.job.threadId === threadId && !record.cancelled && !record.applied,
      );
      if (current.some((record) => Boolean(record.sendInput)))
        throw new AppError(
          "conflict",
          "Voice input is already being queued; manage its message in the queue",
          409,
        );
      for (const record of current) {
        record.cancelled = true;
        cancelled.push(structuredClone(record));
      }
    });
    for (const record of cancelled) {
      if (this.active?.id === record.job.id)
        this.active.controller.abort(new Error("Voice transcription cancelled"));
      await this.removeAudio(record);
      this.ui.publish({
        type: "voiceTranscription.removed",
        threadId,
        jobId: record.job.id,
        outcome: "cancelled",
      });
    }
  }

  async retry(threadId: string, jobId: string): Promise<void> {
    let changed: VoiceTranscriptionJob | undefined;
    await this.ui.store.update((data) => {
      const value = data.voice[jobId];
      if (!value || value.job.threadId !== threadId || value.cancelled || value.applied)
        throw new AppError("conflict", "Voice recording is no longer available", 409);
      if (value.job.status !== "failed") return;
      value.job.status = value.job.transcript ? "applying" : "queued";
      value.job.startedAt = null;
      value.job.error = null;
      changed = structuredClone(value.job);
    });
    if (changed) this.ui.publish({ type: "voiceTranscription.upserted", job: changed });
    this.kick();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.active?.controller.abort(new Error("ClaudeNest voice processing is restarting"));
    await this.admissions.catch(() => undefined);
    await this.worker?.catch(() => undefined);
    await this.ui.store.update((data) => {
      for (const record of Object.values(data.voice))
        if (!record.cancelled && !record.applied && record.job.status === "transcribing") {
          record.job.status = "queued";
          record.job.startedAt = null;
          record.job.error = null;
        }
    });
  }

  private records(): VoiceRecord[] {
    return Object.values(this.ui.store.data.voice);
  }
  private next(): VoiceRecord | undefined {
    return this.records()
      .filter(
        (record) =>
          !record.cancelled &&
          !record.applied &&
          ["queued", "applying"].includes(record.job.status),
      )
      .sort((a, b) => a.job.createdAt - b.job.createdAt)[0];
  }
  private kick(): void {
    if (this.closed || this.worker || !this.next()) return;
    let failed = false;
    this.worker = this.run()
      .catch(() => {
        failed = true;
        this.ui.publish({ type: "resync.required" });
      })
      .finally(() => {
        this.worker = undefined;
        if (!failed && !this.closed && this.next()) this.kick();
      });
  }

  private async run(): Promise<void> {
    while (!this.closed) {
      const record = this.next();
      if (!record) return;
      const controller = new AbortController();
      this.active = { id: record.job.id, controller };
      try {
        if (record.job.status !== "applying") await this.transcribe(record, controller.signal);
        if (!this.closed) await this.apply(record.job.id);
      } catch (error) {
        if (!this.closed) {
          let failed: VoiceTranscriptionJob | undefined;
          await this.ui.store.update((data) => {
            const current = data.voice[record.job.id];
            if (!current || current.cancelled || current.applied) return;
            current.job.status = "failed";
            current.job.error =
              error instanceof VoiceServiceError || error instanceof AppError
                ? error.message
                : "Voice transcription failed; the recording is saved for retry";
            failed = structuredClone(current.job);
          });
          if (failed) this.ui.publish({ type: "voiceTranscription.upserted", job: failed });
        }
      } finally {
        this.active = undefined;
      }
    }
  }

  private async transcribe(record: VoiceRecord, signal: AbortSignal): Promise<void> {
    let started: VoiceTranscriptionJob | undefined;
    await this.ui.store.update((data) => {
      const current = data.voice[record.job.id];
      if (!current || current.cancelled || current.applied || this.closed) return;
      current.job.status = "transcribing";
      current.job.startedAt = Date.now();
      current.job.error = null;
      started = structuredClone(current.job);
    });
    if (!started) return;
    this.ui.publish({ type: "voiceTranscription.upserted", job: started });
    if (record.audioPath !== this.expectedAudioPath(record))
      throw new AppError("conflict", "Invalid saved voice recording path", 409);
    const audio = await readFile(record.audioPath);
    const transcript = await this.voice.transcribe(audio, record.contentType, signal, {
      audioDurationMs: record.job.audioDurationMs,
    });
    signal.throwIfAborted();
    let applying: VoiceTranscriptionJob | undefined;
    await this.ui.store.update((data) => {
      const current = data.voice[record.job.id];
      if (!current || current.cancelled || current.applied || this.closed) return;
      if (!transcript.trim())
        throw new AppError("invalid_request", "Voice transcription returned no text");
      current.job.status = "applying";
      current.job.transcript = transcript.trim();
      current.job.error = null;
      applying = structuredClone(current.job);
    });
    if (applying) this.ui.publish({ type: "voiceTranscription.upserted", job: applying });
  }

  private async apply(id: string): Promise<void> {
    let input: QueueMessageRequest | undefined;
    let completed: VoiceRecord | undefined;
    await this.ui.store.update((data) => {
      const record = data.voice[id] as VoiceRecord | undefined;
      if (
        !record ||
        record.cancelled ||
        record.applied ||
        this.closed ||
        record.job.status !== "applying"
      )
        return;
      const thread = data.threads[record.job.threadId];
      if (!thread) {
        record.cancelled = true;
        return;
      }
      const transcript = record.job.transcript?.trim();
      if (!transcript)
        throw new AppError("invalid_request", "Voice transcription returned no text");
      if (record.sendInput) {
        input = structuredClone(record.sendInput);
        return;
      }
      const currentRevision = thread.draft?.updatedAt ?? null;
      const draft = thread.draft ?? blankDraft();
      const unchanged = currentRevision === record.draftUpdatedAt;
      const inserted = insertTranscript(
        draft,
        unchanged ? record.selectionStart : draft.input.length,
        unchanged ? record.selectionEnd : draft.input.length,
        transcript,
      );
      if (record.job.mode === "draft") {
        thread.draft = { ...inserted, updatedAt: Math.max(Date.now(), (currentRevision ?? 0) + 1) };
        record.applied = true;
        record.job.status = "completed";
        completed = structuredClone(record);
      } else {
        record.sendDraftUpdatedAt = currentRevision;
        record.sendInput = {
          input: formatInput(inserted),
          images: inserted.images.map((image) => image.url),
          ...(inserted.files?.length ? { files: inserted.files } : {}),
          clientMessageId: `voice:${record.job.id}`,
        };
        input = structuredClone(record.sendInput);
      }
    });
    if (input && !this.closed) {
      const record = this.ui.store.data.voice[id] as VoiceRecord;
      await this.ui.enqueue(record.job.threadId, input);
      await this.ui.store.update((data) => {
        const current = data.voice[id] as VoiceRecord | undefined;
        if (!current || current.cancelled || current.applied) return;
        current.applied = true;
        current.job.status = "completed";
        const thread = data.threads[current.job.threadId];
        if (thread && (thread.draft?.updatedAt ?? null) === current.sendDraftUpdatedAt)
          thread.draft = null;
        completed = structuredClone(current);
      });
    }
    if (completed) {
      await this.removeAudio(completed);
      this.ui.publish({
        type: "voiceTranscription.removed",
        threadId: completed.job.threadId,
        jobId: completed.job.id,
        outcome: completed.job.mode === "draft" ? "draft" : "send",
      });
    }
  }

  private expectedAudioPath(record: StoredVoice): string {
    if (
      !/^[0-9a-f-]{36}$/i.test(record.job.id) ||
      !["audio/webm", "audio/mp4"].includes(record.contentType)
    )
      throw new AppError("conflict", "Invalid saved recording metadata", 409);
    return join(
      this.directory,
      `${record.job.id}.${record.contentType === "audio/mp4" ? "mp4" : "webm"}`,
    );
  }
  private async removeAudio(record: StoredVoice): Promise<void> {
    if (record.audioPath === this.expectedAudioPath(record))
      await unlink(record.audioPath).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
  }
  private async writeAudio(target: string, audio: Buffer): Promise<void> {
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(audio);
      await handle.sync();
      await handle.close();
      await rename(temporary, target);
      const directory = await open(this.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      await unlink(target).catch(() => undefined);
      throw error;
    }
  }
}

function integer(value: unknown, name: string): number {
  const result = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0)
    throw new AppError("invalid_request", `${name} must be a nonnegative integer`);
  return result;
}
function blankDraft(): ThreadDraft {
  return { input: "", images: [], annotations: [], goalMode: false, updatedAt: 0 };
}
function insertTranscript(
  draft: ThreadDraft,
  start: number,
  end: number,
  transcript: string,
): ThreadDraft {
  const before = draft.input.slice(0, start),
    after = draft.input.slice(end);
  const insertion = `${before && !/\s$/.test(before) ? " " : ""}${transcript}${after && !/^\s/.test(after) ? " " : ""}`;
  return {
    ...draft,
    input: `${before}${insertion}${after}`,
    ...(draft.inlinePastes?.length
      ? { inlinePastes: replacePasteRanges(draft.inlinePastes, start, end, insertion.length) }
      : {}),
  };
}
function formatInput(draft: ThreadDraft): string {
  const text = serializePastedMessage(draft.input, draft).trim();
  if (!draft.annotations.length) return text;
  return [
    text,
    "Annotations for the agent's previous response:",
    ...draft.annotations.map((annotation) => `${annotation.quote}\n${annotation.comment}`),
  ]
    .filter(Boolean)
    .join("\n\n");
}
