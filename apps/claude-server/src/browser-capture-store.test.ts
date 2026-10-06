import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BrowserCaptureStore, type BrowserCaptureStreamStart } from "./browser-capture-store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("BrowserCaptureStore", () => {
  it("streams and atomically exposes only complete exchanges with private permissions", async () => {
    const { directory, store } = await createStore();
    const owner = {};
    const requestBody = Buffer.from("request body");
    const metadata = metadataBytes("exchange-1", requestBody);
    const start = streamStart("exchange-1", metadata, requestBody);

    await store.startStream(start, owner);
    await store.appendStream(start.captureId, owner, "metadata", 0, metadata.subarray(0, 20));
    expect(await store.list("binding-1")).toMatchObject({ requests: [], stats: { retained: 0 } });
    await store.appendStream(start.captureId, owner, "metadata", 20, metadata.subarray(20));
    await store.appendStream(start.captureId, owner, "requestBody", 0, requestBody);
    const committed = await store.commitStream(start.captureId, owner);

    expect(committed.exchange).toMatchObject({
      exchangeId: "exchange-1",
      requestBody: { bodyId: "exchange-1-request", length: requestBody.length },
    });
    expect(committed.stats).toMatchObject({ retained: 1, evicted: 0, dropped: 0 });
    expect(
      Buffer.from(
        (await store.readBody("binding-1", "exchange-1-request", 1, 4)).data,
        "base64",
      ).toString(),
    ).toBe("eque");

    expect((await stat(store.root)).mode & 0o777).toBe(0o700);
    const paths = await listPaths(store.root);
    const manifest = paths.find((path) => path.endsWith("manifest.json"));
    const body = paths.find((path) => path.endsWith("request.body"));
    expect(manifest).toBeDefined();
    expect(body).toBeDefined();
    expect((await stat(manifest!)).mode & 0o777).toBe(0o600);
    expect((await stat(body!)).mode & 0o777).toBe(0o600);

    const reloaded = new BrowserCaptureStore(join(directory, "state.json"));
    expect(await reloaded.get("binding-1", "exchange-1")).toMatchObject({
      exchangeId: "exchange-1",
      metadata: { schemaVersion: 1, provider: "chrome" },
    });
  });

  it("rejects non-sequential and corrupt captures without exposing orphan parts", async () => {
    const { directory, store } = await createStore();
    const owner = {};
    const metadata = metadataBytes("exchange-bad");
    const start = streamStart("exchange-bad", metadata);
    await store.startStream(start, owner);
    await expect(
      store.appendStream(start.captureId, owner, "metadata", 1, metadata),
    ).rejects.toThrow("Non-sequential");
    await store.abortStream(start.captureId, owner);
    expect(await store.list("binding-1")).toMatchObject({
      requests: [],
      stats: { retained: 0, dropped: 1 },
    });

    const corrupt = streamStart("exchange-corrupt", metadata);
    corrupt.parts.metadata.sha256 = "0".repeat(64);
    await store.startStream(corrupt, owner);
    await store.appendStream(corrupt.captureId, owner, "metadata", 0, metadata);
    await expect(store.commitStream(corrupt.captureId, owner)).rejects.toThrow("SHA-256");
    expect(await store.list("binding-1")).toMatchObject({
      requests: [],
      stats: { retained: 0, dropped: 2 },
    });
    const reloaded = new BrowserCaptureStore(join(directory, "state.json"));
    expect(await reloaded.list("binding-1")).toMatchObject({
      requests: [],
      stats: { retained: 0, dropped: 2 },
    });
  });

  it("evicts the oldest whole exchanges and tracks retention counters", async () => {
    const { store } = await createStore({ maxExchangesPerTab: 2 });
    await commit(store, "exchange-1", 1);
    await commit(store, "exchange-2", 2);
    await commit(store, "exchange-3", 3);
    const listed = await store.list("binding-1", { limit: 10 });
    expect(listed.requests.map(({ exchangeId }) => exchangeId)).toEqual([
      "exchange-3",
      "exchange-2",
    ]);
    expect(listed.stats).toMatchObject({ retained: 2, evicted: 1, dropped: 0 });
    await expect(store.get("binding-1", "exchange-1")).rejects.toThrow("not found");
  });

  it("enforces the per-binding byte budget using whole-exchange eviction", async () => {
    const { store } = await createStore({ maxBytesPerBinding: 1 });
    await commit(store, "exchange-too-large", 1);
    expect(await store.list("binding-1")).toMatchObject({
      requests: [],
      stats: { retained: 0, evicted: 1, storedBytes: 0 },
    });
  });
});

async function createStore(
  options: { maxExchangesPerTab?: number; maxBytesPerBinding?: number } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "codexnest-browser-captures-"));
  directories.push(directory);
  const store = new BrowserCaptureStore(join(directory, "state.json"), options);
  await store.initialize();
  return { directory, store };
}

async function commit(store: BrowserCaptureStore, exchangeId: string, timestamp: number) {
  const owner = {};
  const metadata = metadataBytes(exchangeId, undefined, timestamp);
  const start = streamStart(exchangeId, metadata);
  await store.startStream(start, owner);
  await store.appendStream(start.captureId, owner, "metadata", 0, metadata);
  await store.commitStream(start.captureId, owner);
}

function streamStart(
  exchangeId: string,
  metadata: Buffer,
  requestBody?: Buffer,
): BrowserCaptureStreamStart {
  return {
    captureId: `capture-${exchangeId}`,
    bindingId: "binding-1",
    threadId: "thread-1",
    tabId: 7,
    exchangeId,
    provider: "chrome",
    parts: {
      metadata: descriptor(metadata),
      ...(requestBody ? { requestBody: descriptor(requestBody) } : {}),
    },
  };
}

function metadataBytes(exchangeId: string, requestBody?: Buffer, timestamp = 1): Buffer {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      provider: "chrome",
      exchange: {
        exchangeId,
        threadId: "thread-1",
        tabId: 7,
        redirect: {
          chainId: exchangeId,
          index: 0,
          redirectedFromExchangeId: null,
          redirectedToExchangeId: null,
        },
        request: {
          url: "https://example.test/",
          method: "GET",
          headers: [],
          timestamp,
          wallTime: null,
          httpVersion: "h2",
          resourceType: "document",
          initiator: null,
          body: requestBody
            ? {
                bodyId: `${exchangeId}-request`,
                byteLength: requestBody.length,
                sha256: sha256(requestBody),
                mediaType: "text/plain",
                encoding: null,
              }
            : null,
        },
        response: { body: null },
        failure: null,
        startedAt: timestamp,
        completedAt: timestamp + 1,
      },
      rawEvents: [{ event: "Network.requestWillBeSent", payload: { extra: true } }],
    }),
  );
}

function descriptor(value: Buffer) {
  return { byteLength: value.length, sha256: sha256(value) };
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function listPaths(root: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    paths.push(path);
    if (entry.isDirectory()) paths.push(...(await listPaths(path)));
  }
  return paths;
}
