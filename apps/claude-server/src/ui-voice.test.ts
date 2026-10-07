import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  QueueMessageRequest,
  QueuedMessage,
  ServerEvent,
  ThreadDraft,
} from "@codexnest/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UiService } from "./ui-service";
import { UiStore, type UiThread } from "./ui-store";
import { UiVoiceJobs } from "./ui-voice";
import { VoiceServiceError } from "./voice";

const fixtures: Array<{ directory: string; jobs: UiVoiceJobs }> = [];
afterEach(async () => {
  for (const { directory, jobs } of fixtures.splice(0)) {
    await jobs.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const draft = (input = "hello world", updatedAt = 10): ThreadDraft => ({
  input,
  updatedAt,
  images: [],
  annotations: [],
  goalMode: false,
});

async function fixture(transcribe = vi.fn(async () => "voice")) {
  const directory = await mkdtemp(join(tmpdir(), "claudenest-voice-jobs-test-"));
  const store = new UiStore(directory);
  await store.initialize();
  const threadId = randomUUID();
  const thread: UiThread = {
    id: threadId,
    cwd: directory,
    projectId: null,
    title: "thread",
    createdAt: 1,
    updatedAt: 1,
    readAt: 1,
    viewedAt: 1,
    pinned: false,
    archived: false,
    settings: {},
    draft: draft(),
    queue: [],
    deliveries: {},
  };
  await store.update((data) => {
    data.threads[threadId] = thread;
  });
  const events: ServerEvent[] = [];
  let failAfterEnqueue = false;
  const enqueue = vi.fn(async (id: string, input: QueueMessageRequest): Promise<QueuedMessage> => {
    const message = await store.update((data) => {
      const current = data.threads[id]!;
      const existing = current.deliveries[input.clientMessageId!];
      if (existing) return current.queue.find((item) => item.id === existing.messageId)!;
      const message: QueuedMessage = {
        id: randomUUID(),
        threadId: id,
        text: input.input,
        status: "queued",
        createdAt: Date.now(),
        ...(input.deliveryMode ? { deliveryMode: input.deliveryMode } : {}),
        ...(input.images?.length ? { images: input.images } : {}),
        ...(input.files?.length ? { files: input.files } : {}),
      };
      current.queue.push(message);
      current.deliveries[input.clientMessageId!] = {
        fingerprint: "test",
        messageId: message.id,
        accepted: false,
      };
      return message;
    });
    if (failAfterEnqueue) {
      failAfterEnqueue = false;
      throw new Error("Acknowledgement lost after enqueue");
    }
    return message;
  });
  const ui = {
    store,
    manager: { config: { stateDir: directory } },
    thread: (id: string) => {
      const thread = store.data.threads[id];
      if (!thread) throw new Error("missing thread");
      return thread;
    },
    publish: (event: ServerEvent) => events.push(event),
    enqueue,
  } as unknown as UiService;
  const voice = {
    transcribe,
    configuration: () => ({
      timingEstimate: {
        sampleCount: 5,
        estimatedFixedProcessingMs: 1000,
        estimatedProcessingMsPerAudioSecond: 500,
      },
    }),
  } as unknown as ClaudeVoiceService;
  const jobs = new UiVoiceJobs(ui, voice);
  fixtures.push({ directory, jobs });
  return {
    directory,
    store,
    ui,
    voice,
    jobs,
    events,
    threadId,
    enqueue,
    failNextEnqueue: () => {
      failAfterEnqueue = true;
    },
  };
}

function uploadQuery(mode = "draft", clientUploadId = randomUUID()) {
  return { mode, clientUploadId, selectionStart: "0", selectionEnd: "5", draftUpdatedAt: "10" };
}

describe("durable Claude UI voice jobs", () => {
  it("acknowledges private audio before STT and atomically applies its transcript once", async () => {
    const result = deferred<string>();
    const state = await fixture(vi.fn(() => result.promise));
    const query = uploadQuery();
    const job = await state.jobs.create(
      state.threadId,
      Buffer.from("recording"),
      "audio/webm;codecs=opus",
      query,
      1200,
    );
    const record = state.store.data.voice[job!.id]!;
    expect(job!.estimatedTotalSeconds).toBe(2);
    expect(await readFile(record.audioPath, "utf8")).toBe("recording");
    expect((await stat(record.audioPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(state.directory, "voice"))).mode & 0o777).toBe(0o700);
    await vi.waitFor(() => expect(state.voice.transcribe).toHaveBeenCalledTimes(1));
    result.resolve("recognised");
    await vi.waitFor(() => expect(state.store.data.voice[job!.id]!.applied).toBe(true));
    expect(state.store.data.threads[state.threadId]!.draft!.input).toBe("recognised world");
    await expect(readFile(record.audioPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await state.jobs.create(state.threadId, Buffer.from("recording"), "audio/webm", query, 1200),
    ).toBeNull();
    expect(
      state.events.filter((event) => event.type === "voiceTranscription.removed"),
    ).toMatchObject([{ threadId: state.threadId, jobId: job!.id, outcome: "draft" }]);
  });

  it("appends to a draft edited during STT instead of overwriting the user's new selection", async () => {
    const result = deferred<string>();
    const state = await fixture(vi.fn(() => result.promise));
    const job = await state.jobs.create(
      state.threadId,
      Buffer.from("audio"),
      "audio/mp4",
      uploadQuery(),
      1000,
    );
    await vi.waitFor(() => expect(state.voice.transcribe).toHaveBeenCalled());
    await state.store.update((data) => {
      data.threads[state.threadId]!.draft = {
        ...draft("newly typed", 11),
        images: [{ id: "image", name: "image", url: "data:image/png;base64,eA==" }],
      };
    });
    result.resolve("voice");
    await vi.waitFor(() => expect(state.store.data.voice[job!.id]!.applied).toBe(true));
    expect(state.store.data.threads[state.threadId]!.draft).toMatchObject({
      input: "newly typed voice",
      images: [{ id: "image" }],
    });
  });

  it("preserves pasted-text ranges when replacing an unchanged draft selection", async () => {
    const state = await fixture();
    await state.store.update((data) => {
      data.threads[state.threadId]!.draft = {
        ...draft(),
        inlinePastes: [{ id: "paste", start: 6, end: 11 }],
        pasteBlocks: [{ id: "block", text: "long pasted content" }],
      };
    });
    const job = await state.jobs.create(
      state.threadId,
      Buffer.from("audio"),
      "audio/webm",
      uploadQuery(),
      1000,
    );
    await vi.waitFor(() => expect(state.store.data.voice[job!.id]!.applied).toBe(true));
    expect(state.store.data.threads[state.threadId]!.draft).toMatchObject({
      input: "voice world",
      inlinePastes: [{ id: "paste", start: 6, end: 11 }],
      pasteBlocks: [{ id: "block", text: "long pasted content" }],
    });
  });

  it("persists cancellation before a late STT result can alter the draft", async () => {
    const result = deferred<string>();
    const state = await fixture(vi.fn(() => result.promise));
    const query = uploadQuery();
    const job = await state.jobs.create(
      state.threadId,
      Buffer.from("audio"),
      "audio/webm",
      query,
      1000,
    );
    await vi.waitFor(() => expect(state.voice.transcribe).toHaveBeenCalled());
    await state.jobs.cancel(state.threadId);
    result.resolve("must not appear");
    await state.jobs.close();
    expect(state.store.data.voice[job!.id]!.cancelled).toBe(true);
    expect(state.store.data.voice[job!.id]!.applied).toBeUndefined();
    expect(state.store.data.threads[state.threadId]!.draft!.input).toBe("hello world");
    await expect(state.jobs.retry(state.threadId, job!.id)).rejects.toMatchObject({ status: 409 });
  });

  it("resumes queued audio after backend shutdown without turning cancellation into a failure", async () => {
    const transcribe = vi.fn(
      async (_audio: Buffer, _type: string, signal?: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const state = await fixture(transcribe);
    const job = await state.jobs.create(
      state.threadId,
      Buffer.from("audio"),
      "audio/webm",
      uploadQuery(),
      1000,
    );
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalled());
    await state.jobs.close();
    expect(state.store.data.voice[job!.id]!.job).toMatchObject({ status: "queued", error: null });
    const restartedStore = new UiStore(state.directory);
    await restartedStore.initialize();
    const restarted = new UiVoiceJobs(
      {
        ...state.ui,
        store: restartedStore,
        thread: (id: string) => restartedStore.data.threads[id]!,
      } as UiService,
      { ...state.voice, transcribe: async () => "recovered" },
    );
    fixtures.push({ directory: state.directory, jobs: restarted });
    await restarted.initialize();
    await vi.waitFor(() => expect(restartedStore.data.voice[job!.id]!.applied).toBe(true));
    expect(restartedStore.data.threads[state.threadId]!.draft!.input).toBe("recovered world");
  });

  it.each(["send", "steer"])(
    "retries a persisted applying %s with the same steering payload after a lost enqueue acknowledgement",
    async (mode) => {
      const state = await fixture();
      state.failNextEnqueue();
      const job = await state.jobs.create(
        state.threadId,
        Buffer.from("audio"),
        "audio/webm",
        uploadQuery(mode),
        1000,
      );
      await vi.waitFor(() => expect(state.store.data.voice[job!.id]!.job.status).toBe("failed"));
      expect(state.store.data.threads[state.threadId]!.queue).toHaveLength(1);
      await expect(state.jobs.cancel(state.threadId)).rejects.toMatchObject({ status: 409 });
      await state.store.update((data) => {
        data.threads[state.threadId]!.draft = draft("new user typing", 99);
        data.voice[job!.id]!.job.status = "applying";
      });
      await state.jobs.close();
      const second = new UiVoiceJobs(state.ui, state.voice);
      fixtures.push({ directory: state.directory, jobs: second });
      await second.initialize();
      await vi.waitFor(() => expect(state.store.data.voice[job!.id]!.applied).toBe(true));
      expect(state.voice.transcribe).toHaveBeenCalledTimes(1);
      expect(state.enqueue).toHaveBeenCalledTimes(2);
      const first = state.enqueue.mock.calls[0]![1],
        replay = state.enqueue.mock.calls[1]![1];
      expect(replay).toEqual(first);
      expect(replay.clientMessageId).toBe(`voice:${job!.id}`);
      expect(replay.deliveryMode).toBe("steer");
      expect(state.store.data.threads[state.threadId]!.queue).toHaveLength(1);
      expect(state.store.data.threads[state.threadId]!.draft!.input).toBe("new user typing");
    },
  );

  it.each(["send", "steer", "queue"])(
    "enqueues %s input once and clears only the consumed draft",
    async (mode) => {
      const state = await fixture();
      const job = await state.jobs.create(
        state.threadId,
        Buffer.from("audio"),
        "audio/mp4",
        uploadQuery(mode),
        1000,
      );
      await vi.waitFor(() => expect(state.store.data.voice[job!.id]!.applied).toBe(true));
      expect(state.store.data.threads[state.threadId]!.queue).toMatchObject([
        { text: "voice world" },
      ]);
      expect(state.store.data.threads[state.threadId]!.draft).toBeNull();
      expect(state.enqueue.mock.calls[0]![1].deliveryMode).toBe(
        mode === "queue" ? undefined : "steer",
      );
    },
  );

  it("steers the revised draft with its attachments when typing continues during transcription", async () => {
    const result = deferred<string>();
    const state = await fixture(vi.fn(() => result.promise));
    const job = await state.jobs.create(
      state.threadId,
      Buffer.from("audio"),
      "audio/webm",
      uploadQuery("steer"),
      1000,
    );
    await vi.waitFor(() => expect(state.voice.transcribe).toHaveBeenCalledTimes(1));
    const image = { id: "image", name: "screen.png", url: "data:image/png;base64,aW1hZ2U=" };
    const file = {
      id: "file",
      name: "notes.txt",
      path: "/private/notes.txt",
      size: 4,
      mediaType: "text/plain",
    };
    await state.store.update((data) => {
      data.threads[state.threadId]!.draft = {
        ...draft("New instruction", 11),
        images: [image],
        files: [file],
      };
    });
    result.resolve("voice");
    await vi.waitFor(() => expect(state.store.data.voice[job!.id]!.applied).toBe(true));
    expect(state.enqueue).toHaveBeenCalledTimes(1);
    expect(state.enqueue.mock.calls[0]![1]).toMatchObject({
      input: "New instruction voice",
      images: [image.url],
      files: [file],
      deliveryMode: "steer",
      clientMessageId: `voice:${job!.id}`,
    });
    expect(state.store.data.threads[state.threadId]!.draft).toBeNull();
  });

  it("keeps failed audio for an explicit retry without making automatic inference calls", async () => {
    const transcribe = vi
      .fn(async () => "voice")
      .mockRejectedValueOnce(new VoiceServiceError("failed", "Local service unavailable"));
    const state = await fixture(transcribe);
    const job = await state.jobs.create(
      state.threadId,
      Buffer.from("audio"),
      "audio/webm",
      uploadQuery(),
      1000,
    );
    await vi.waitFor(() => expect(state.store.data.voice[job!.id]!.job.status).toBe("failed"));
    expect(await readFile(state.store.data.voice[job!.id]!.audioPath, "utf8")).toBe("audio");
    expect(transcribe).toHaveBeenCalledTimes(1);
    await state.jobs.retry(state.threadId, job!.id);
    await vi.waitFor(() => expect(state.store.data.voice[job!.id]!.applied).toBe(true));
    expect(transcribe).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent upload retries and rejects changed recording intent", async () => {
    const result = deferred<string>();
    const state = await fixture(vi.fn(() => result.promise));
    const query = uploadQuery();
    const [one, two] = await Promise.all([
      state.jobs.create(state.threadId, Buffer.from("audio"), "audio/webm", query, 1000),
      state.jobs.create(state.threadId, Buffer.from("audio"), "audio/webm", query, 1000),
    ]);
    expect(one!.id).toBe(two!.id);
    await expect(
      state.jobs.create(state.threadId, Buffer.from("different"), "audio/webm", query, 1000),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      state.jobs.create(state.threadId, Buffer.from("audio"), "audio/webm", uploadQuery(), 1000),
    ).rejects.toMatchObject({ status: 409 });
    expect(await readdir(join(state.directory, "voice"))).toHaveLength(1);
    result.resolve("voice");
  });

  it("does not acknowledge audio when its metadata persistence fails", async () => {
    const state = await fixture();
    await state.jobs.initialize();
    vi.spyOn(state.store, "update").mockRejectedValueOnce(new Error("Metadata disk failed"));
    await expect(
      state.jobs.create(state.threadId, Buffer.from("audio"), "audio/mp4", uploadQuery(), 1000),
    ).rejects.toThrow("Metadata disk failed");
    expect(Object.values(state.store.data.voice)).toHaveLength(0);
    expect(await readdir(join(state.directory, "voice"))).toHaveLength(0);
    expect(state.voice.transcribe).not.toHaveBeenCalled();
  });

  it("rejects unknown modes, stale revisions, invalid selections and excessive recording durations", async () => {
    const state = await fixture();
    const query = uploadQuery();
    await expect(
      state.jobs.create(
        state.threadId,
        Buffer.from("audio"),
        "audio/webm",
        { ...query, mode: "unknown" },
        1000,
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      state.jobs.create(
        state.threadId,
        Buffer.from("audio"),
        "audio/webm",
        { ...query, draftUpdatedAt: "9" },
        1000,
      ),
    ).rejects.toMatchObject({ code: "draft_conflict" });
    await expect(
      state.jobs.create(
        state.threadId,
        Buffer.from("audio"),
        "audio/webm",
        { ...query, selectionEnd: "999" },
        1000,
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      state.jobs.create(state.threadId, Buffer.from("audio"), "audio/webm", query, 300_001),
    ).rejects.toMatchObject({ status: 400 });
    expect(await readdir(join(state.directory, "voice"))).toHaveLength(0);
    expect(state.voice.transcribe).not.toHaveBeenCalled();
  });
});
