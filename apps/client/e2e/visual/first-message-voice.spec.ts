import { expect, test, type Route } from "@playwright/test";
import type {
  QueuedMessage,
  ServerEvent,
  ThreadDraft,
  VoiceTranscriptionJob,
} from "@codexnest/protocol";

import { installVisualFixture, mainThread, PHONE_VIEWPORT, snapshot } from "./fixtures";

test.use({ hasTouch: true, viewport: PHONE_VIEWPORT });

async function json(route: Route, body: unknown) {
  await route.fulfill({
    json: body,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "Authorization, Content-Type, X-CodexNest-Audio-Duration-Ms",
      "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
    },
  });
}

for (const reloadDuring of ["creation", "upload"] as const) {
  test(`first voice survives reload during ${reloadDuring} and becomes one message`, async ({
    page,
  }) => {
    const seed = structuredClone(snapshot);
    seed.attention = [];
    const thread = {
      ...mainThread,
      id: "session-first-voice",
      title: "Без названия",
      state: "idle" as const,
      settings: { collaborationMode: "default" as const },
      relation: { kind: "session" as const, sessionId: "session-first-voice" },
    };
    seed.threads.push(thread);
    await installVisualFixture(page, {
      theme: "light",
      snapshot: seed,
      preserveLocalStorage: true,
    });
    await page.addInitScript(() => {
      const probe = { requests: 0, starts: 0, offset: 0 };
      Object.assign(window, { firstVoiceProbe: probe });
      Date.now = () => 1785758400000 + Math.floor(performance.now()) + probe.offset;
      class Recorder extends EventTarget {
        static isTypeSupported() {
          return true;
        }
        state = "inactive";
        start() {
          this.state = "recording";
          probe.starts++;
        }
        stop() {
          if (this.state === "inactive") return;
          this.state = "inactive";
          setTimeout(() => {
            const event = new Event("dataavailable");
            Object.defineProperty(event, "data", {
              value: new Blob(["saved-first-voice"], { type: "audio/webm;codecs=opus" }),
            });
            this.dispatchEvent(event);
            this.dispatchEvent(new Event("stop"));
          }, 25);
        }
      }
      Object.defineProperty(window, "MediaRecorder", { configurable: true, value: Recorder });
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: async () => {
            probe.requests++;
            return { getTracks: () => [{ stop() {} }] };
          },
        },
      });
    });
    let send!: (event: ServerEvent) => void;
    let sequence = seed.sequence;
    await page.routeWebSocket("wss://codexnest.visual/api/v1/events", (socket) => {
      send = (event) => socket.send(JSON.stringify({ type: "event", sequence: ++sequence, event }));
      socket.onMessage((message) => {
        const frame = JSON.parse(message.toString());
        if (frame.type === "authenticate")
          socket.send(JSON.stringify({ type: "snapshot", snapshot: { ...seed, sequence } }));
        if (frame.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
      });
    });
    let releaseCreation!: () => void;
    const creationGate = new Promise<void>((resolve) => {
      releaseCreation = resolve;
    });
    let releaseUpload!: () => void;
    const uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    if (reloadDuring === "upload") releaseCreation();
    else releaseUpload();
    const creationIds: string[] = [];
    const uploadIds: string[] = [];
    let draft: ThreadDraft | null = null;
    let projectDraft: ThreadDraft | null = null;
    let queued: QueuedMessage[] = [];
    await page.route("https://codexnest.visual/api/v1/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === "OPTIONS") return json(route, null);
      if (url.pathname === "/api/v1/projects/project-nest/draft") {
        if (request.method() === "PUT")
          projectDraft = { ...request.postDataJSON().value, updatedAt: Date.now() };
        return json(route, projectDraft);
      }
      if (url.pathname === "/api/v1/projects/project-nest/threads") {
        creationIds.push(request.postDataJSON().clientCreationId);
        await creationGate;
        return json(route, { thread, draft: null });
      }
      if (url.pathname === `/api/v1/threads/${thread.id}/draft`) {
        if (request.method() === "PUT")
          draft = { ...request.postDataJSON(), updatedAt: Date.now() };
        return json(route, draft);
      }
      if (url.pathname === `/api/v1/threads/${thread.id}/settings`) return json(route, thread);
      if (
        url.pathname === `/api/v1/threads/${thread.id}/voice-transcriptions` &&
        request.method() === "POST"
      ) {
        const id = url.searchParams.get("clientUploadId")!;
        uploadIds.push(id);
        expect(url.searchParams.get("mode")).toBe("send");
        expect(request.postDataBuffer()?.byteLength).toBe(17);
        await uploadGate;
        const job: VoiceTranscriptionJob = {
          id,
          threadId: thread.id,
          mode: "send",
          status: "transcribing",
          createdAt: Date.now(),
          startedAt: Date.now(),
          audioDurationMs: 60_000,
          estimatedTotalSeconds: null,
          error: null,
        };
        seed.voiceTranscriptions = [job];
        send({ type: "voiceTranscription.upserted", job });
        return json(route, job);
      }
      if (url.pathname === `/api/v1/threads/${thread.id}`) {
        return json(route, {
          summary: thread,
          turns: [],
          olderTurnsCursor: null,
          draft,
          queuedMessages: queued,
        });
      }
      return route.fallback();
    });
    try {
      await page.goto("/threads/session-main");
      await page.getByRole("button", { name: "Открыть список задач", exact: true }).click();
      await page.getByRole("button", { name: "Создать новую сессию в проекте CodexNest" }).click();
      await page.getByRole("button", { name: "Начать запись", exact: true }).tap();
      await expect(
        page.getByRole("button", { name: "Остановить запись", exact: true }),
      ).toBeVisible();
      expect(creationIds).toHaveLength(0);
      await page.evaluate(() => {
        (window as unknown as { firstVoiceProbe: { offset: number } }).firstVoiceProbe.offset =
          60_000;
      });
      await page.getByRole("button", { name: "Остановить запись", exact: true }).tap();
      await expect(page.locator(".voice-transcription-message")).toHaveCount(1);
      await expect(page.locator(".composer .microphone")).not.toHaveClass(/recording|timing/);
      let id = "";
      await expect
        .poll(async () =>
          page.evaluate(async () => {
            const database = await new Promise<IDBDatabase>((resolve) => {
              const request = indexedDB.open("codexnest-offline");
              request.onsuccess = () => resolve(request.result);
            });
            const saved = await new Promise<
              Array<{
                voiceSubmission?: { recording: { id: string; audio: { data: ArrayBuffer } } };
              }>
            >((resolve) => {
              const request = database.transaction("drafts").objectStore("drafts").getAll();
              request.onsuccess = () => resolve(request.result);
            });
            database.close();
            const voice = saved.find((entry) => entry.voiceSubmission)?.voiceSubmission;
            return { id: voice?.recording.id, size: voice?.recording.audio.data.byteLength };
          }),
        )
        .toMatchObject({ id: expect.any(String), size: 17 });
      await expect.poll(() => creationIds.length).toBe(1);
      if (reloadDuring === "upload") await expect.poll(() => uploadIds.length).toBe(1);
      await page.reload();
      await expect(page.locator(".voice-transcription-message")).toHaveCount(1);
      await expect(page.locator(".composer .microphone")).not.toHaveClass(/recording|timing/);
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { firstVoiceProbe: { requests: number } }).firstVoiceProbe
              .requests,
        ),
      ).toBe(0);
      // Only the preparation resumes first-message audio, even when it also
      // exists in the pending-upload store after a reload.
      if (reloadDuring === "upload") await expect.poll(() => uploadIds.length).toBe(2);
      releaseCreation();
      releaseUpload();
      await expect(page).toHaveURL(`/threads/${thread.id}`);
      await expect(page.locator(".voice-transcription-message")).toContainText("Распознаём");
      expect(new Set(creationIds).size).toBe(1);
      expect(new Set(uploadIds).size).toBe(1);
      expect(uploadIds).toHaveLength(reloadDuring === "upload" ? 2 : 1);
      id = uploadIds[0]!;
      queued = [
        {
          id,
          threadId: thread.id,
          text: "Расшифрованное первое голосовое",
          status: "queued",
          createdAt: Date.now(),
        },
      ];
      draft = null;
      seed.voiceTranscriptions = [];
      send({ type: "queue.changed", threadId: thread.id, messages: queued });
      send({ type: "voiceTranscription.removed", threadId: thread.id, jobId: id, outcome: "send" });
      await expect(page.locator(".queued-message-text")).toHaveText(
        "Расшифрованное первое голосовое",
      );
      await expect(page.locator(".voice-transcription-message")).toHaveCount(0);
      await expect(
        page.getByRole("textbox", { name: "Сообщение для Codex", exact: true }),
      ).toHaveValue("");
    } finally {
      releaseCreation();
      releaseUpload();
    }
  });
}
