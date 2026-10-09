import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  listPendingVoiceRecordings,
  loadNewSessionDraft,
  loadPendingVoiceRecording,
  putPendingVoiceRecording,
  saveNewSessionDraft,
  connectionCacheKey,
  type PendingVoiceRecording,
} from "./offline-store";

const settings = { baseUrl: "https://nest.test", token: "token" };
const draft = { input: "", images: [], goalMode: false, annotations: [] };

type Row = Record<string, unknown>;

/** Just enough of IndexedDB for the offline store; `refuseBlobs` mimics WebKit failing such writes. */
function installIndexedDb({ refuseBlobs }: { refuseBlobs: boolean }) {
  const keyPaths: Record<string, string> = {
    meta: "key",
    threads: "key",
    drafts: "key",
    outbox: "id",
    recordings: "id",
  };
  const stores = new Map(Object.keys(keyPaths).map((name) => [name, new Map<unknown, Row>()]));
  const holdsBlob = (value: unknown): boolean =>
    value instanceof Blob ||
    (typeof value === "object" && value !== null && Object.values(value).some(holdsBlob));
  const request = <T>(result: T) => {
    const target = Object.assign(new EventTarget(), { result });
    queueMicrotask(() => target.dispatchEvent(new Event("success")));
    return target;
  };
  vi.stubGlobal("indexedDB", {
    open: () =>
      request({
        transaction: () => {
          let refused = false;
          const writes: Array<() => void> = [];
          const transaction = Object.assign(new EventTarget(), {
            error: null,
            objectStore: (name: string) => ({
              put: (value: Row) => {
                if (refuseBlobs && holdsBlob(value)) refused = true;
                else
                  writes.push(() =>
                    stores.get(name)!.set(value[keyPaths[name]!], structuredClone(value)),
                  );
                return request(undefined);
              },
              get: (key: unknown) => request(stores.get(name)!.get(key)),
              getAll: () => request([...stores.get(name)!.values()]),
              delete: (key: unknown) => request(stores.get(name)!.delete(key)),
            }),
          });
          queueMicrotask(() =>
            queueMicrotask(() => {
              if (refused) transaction.dispatchEvent(new Event("abort"));
              else {
                for (const write of writes) write();
                transaction.dispatchEvent(new Event("complete"));
              }
            }),
          );
          return transaction;
        },
        close: () => undefined,
      }),
  });
  return stores;
}

function pendingRecording(audio: Blob, id = "recording"): PendingVoiceRecording {
  return {
    id,
    connectionKey: connectionCacheKey(settings),
    threadId: "thread",
    audio,
    durationMs: 1_000,
    mode: "send",
    selectionStart: 0,
    selectionEnd: 0,
    draftUpdatedAt: null,
    draft,
    localDraftUpdatedAt: 1,
    createdAt: 1,
    attempts: 0,
    lastError: null,
  };
}

const preparation = {
  phase: "creating" as const,
  threadId: null,
  thread: null,
  revision: 1,
};

describe("offline store recordings", () => {
  beforeEach(() => {
    vi.stubGlobal("Blob", NodeBlob);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps a recording as bytes so a browser that refuses Blobs still saves it", async () => {
    installIndexedDb({ refuseBlobs: true });
    const recording = pendingRecording(new Blob(["voice"], { type: "audio/mp4" }));

    expect(await putPendingVoiceRecording(recording)).toBe(true);
    const loaded = await loadPendingVoiceRecording(recording.id);
    expect(loaded?.audio.type).toBe("audio/mp4");
    expect(await loaded?.audio.text()).toBe("voice");
    // A failed upload rewrites the record it read back.
    expect(await putPendingVoiceRecording({ ...loaded!, attempts: 1 })).toBe(true);
    expect(await listPendingVoiceRecordings(settings)).toHaveLength(1);
  });

  it("saves and restores a new-session preparation with its recording", async () => {
    installIndexedDb({ refuseBlobs: true });
    const voiceSubmission = {
      recording: {
        id: "recording",
        audio: new Blob(["voice"], { type: "audio/webm" }),
        durationMs: 1_000,
        selection: { start: 0, end: 0 },
      },
      draft,
    };
    expect(
      await saveNewSessionDraft(settings, "project", draft, {
        ...preparation,
        voiceSubmission,
      }),
    ).toBe(true);
    const loaded = await loadNewSessionDraft(settings, "project");
    expect(await loaded?.voiceSubmission?.recording.audio.text()).toBe("voice");
    expect(loaded?.voiceSubmission?.recording.audio.type).toBe("audio/webm");
    // Opening the page saves the preparation it just read back.
    expect(
      await saveNewSessionDraft(settings, "project", draft, {
        ...preparation,
        voiceSubmission: loaded?.voiceSubmission,
      }),
    ).toBe(true);
  });

  it("copies a Blob stored by an earlier version out of the database", async () => {
    const stores = installIndexedDb({ refuseBlobs: false });
    const legacy = pendingRecording(new Blob(["old"], { type: "audio/mp4" }));
    stores.get("recordings")!.set(legacy.id, legacy);

    const [loaded] = await listPendingVoiceRecordings(settings);
    expect(await loaded?.audio.text()).toBe("old");
    expect(loaded?.audio).not.toBe(legacy.audio);
  });

  it("hands out an earlier Blob that cannot be copied as it is instead of dropping it", async () => {
    const stores = installIndexedDb({ refuseBlobs: false });
    const unreadable = Object.assign(new Blob(["gone"], { type: "audio/mp4" }), {
      arrayBuffer: () => Promise.reject(new Error("unreadable")),
    });
    const legacy = pendingRecording(unreadable);
    stores.get("recordings")!.set(legacy.id, legacy);
    const key = `${connectionCacheKey(settings)}\0new-session:project`;
    stores.get("drafts")!.set(key, {
      key,
      connectionKey: connectionCacheKey(settings),
      projectId: "project",
      value: draft,
      ...preparation,
      voiceSubmission: {
        recording: {
          id: "recording",
          audio: unreadable,
          durationMs: 1,
          selection: { start: 0, end: 0 },
        },
        draft,
      },
      updatedAt: 1,
    });

    expect((await listPendingVoiceRecordings(settings))[0]?.audio).toBe(unreadable);
    expect((await loadPendingVoiceRecording(legacy.id))?.audio).toBe(unreadable);
    const loaded = await loadNewSessionDraft(settings, "project");
    expect(loaded?.voiceSubmission?.recording.audio).toBe(unreadable);
  });
});
