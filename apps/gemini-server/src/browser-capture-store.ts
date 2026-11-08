import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  BROWSER_MAX_NETWORK_BODY_BYTES,
  BROWSER_MAX_NETWORK_BODY_READ_BYTES,
} from "@codexnest/protocol";

const DEFAULT_MAX_EXCHANGES_PER_TAB = 1_000;
const DEFAULT_MAX_BYTES_PER_BINDING = 1024 * 1024 * 1024;
const DEFAULT_MAX_BODY_BYTES = BROWSER_MAX_NETWORK_BODY_BYTES;
export const MAX_NETWORK_BODY_READ_BYTES = BROWSER_MAX_NETWORK_BODY_READ_BYTES;

export type BrowserCaptureBodyKind = "request" | "response";
export type BrowserCapturePartKind = "metadata" | "requestBody" | "responseBody";

export interface BrowserCapturePartDeclaration {
  byteLength: number;
  sha256: string;
}

export interface BrowserCaptureStreamStart {
  captureId: string;
  bindingId: string;
  threadId: string;
  tabId: number;
  exchangeId: string;
  provider: "chrome";
  parts: {
    metadata: BrowserCapturePartDeclaration;
    requestBody?: BrowserCapturePartDeclaration;
    responseBody?: BrowserCapturePartDeclaration;
  };
}

export interface BrowserCaptureBodyDeclaration {
  bodyId: string;
  length: number;
  sha256: string;
  mimeType?: string;
}

interface StoredManifestFields {
  bindingId: string;
  tabId: string | number;
  exchangeId: string;
  createdAt?: number;
  metadata: Record<string, unknown>;
  requestBody?: BrowserCaptureBodyDeclaration;
  responseBody?: BrowserCaptureBodyDeclaration;
}

export interface BrowserCaptureStats {
  retained: number;
  evicted: number;
  dropped: number;
  storedBytes: number;
}

export interface StoredBrowserCaptureBody extends BrowserCaptureBodyDeclaration {
  kind: BrowserCaptureBodyKind;
}

export interface StoredBrowserExchange {
  bindingId: string;
  tabId: string | number;
  exchangeId: string;
  createdAt: number;
  completedAt: number;
  metadata: Record<string, unknown>;
  requestBody?: StoredBrowserCaptureBody;
  responseBody?: StoredBrowserCaptureBody;
  storedBytes: number;
}

interface StoredManifest extends StoredBrowserExchange {
  version: 1;
  requestBody?: StoredBrowserCaptureBody & { file: string };
  responseBody?: StoredBrowserCaptureBody & { file: string };
}

interface IndexedExchange {
  manifest: StoredManifest;
  directory: string;
}

interface PendingStreamPart {
  declaration: BrowserCapturePartDeclaration;
  handle: FileHandle;
  path: string;
  offset: number;
  hash: ReturnType<typeof createHash>;
}

interface PendingStreamCapture {
  owner: object;
  start: BrowserCaptureStreamStart;
  directory: string;
  metadata: PendingStreamPart;
  requestBody?: PendingStreamPart;
  responseBody?: PendingStreamPart;
}

export interface BrowserCaptureStoreOptions {
  maxExchangesPerTab?: number;
  maxBytesPerBinding?: number;
  maxBodyBytes?: number;
}

/** File-backed storage for complete browser network exchanges. */
export class BrowserCaptureStore {
  readonly root: string;
  private readonly maxExchangesPerTab: number;
  private readonly maxBytesPerBinding: number;
  private readonly maxBodyBytes: number;
  private readonly pendingStreams = new Map<string, PendingStreamCapture>();
  private readonly exchanges = new Map<string, IndexedExchange>();
  private readonly bodyIndex = new Map<string, IndexedExchange>();
  private readonly stats = new Map<string, BrowserCaptureStats>();
  private operation: Promise<unknown> = Promise.resolve();
  private initialized?: Promise<void>;

  constructor(statePath: string, options: BrowserCaptureStoreOptions = {}) {
    this.root = resolve(dirname(statePath), ".browser-captures");
    this.maxExchangesPerTab = options.maxExchangesPerTab ?? DEFAULT_MAX_EXCHANGES_PER_TAB;
    this.maxBytesPerBinding = options.maxBytesPerBinding ?? DEFAULT_MAX_BYTES_PER_BINDING;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  }

  initialize(): Promise<void> {
    this.initialized ??= this.load();
    return this.initialized;
  }

  startStream(input: BrowserCaptureStreamStart, owner: object): Promise<void> {
    return this.enqueue(async () => {
      await this.initialize();
      validateStreamStart(input, this.maxBodyBytes);
      if (this.pendingStreams.has(input.captureId)) {
        await this.recordDropped(input.bindingId);
        throw new Error("Capture ID is already active");
      }
      const key = exchangeKey(input.bindingId, input.tabId, input.exchangeId);
      if (this.exchanges.has(key)) {
        await this.recordDropped(input.bindingId);
        throw new Error("Exchange is already stored");
      }
      const tabDirectory = this.tabDirectory(input.bindingId, input.tabId);
      await secureDirectory(tabDirectory);
      const directory = join(tabDirectory, `.tmp-${randomUUID()}`);
      await secureDirectory(directory);
      let metadata: PendingStreamPart | undefined;
      let requestBody: PendingStreamPart | undefined;
      let responseBody: PendingStreamPart | undefined;
      try {
        metadata = await openPendingStreamPart(directory, "metadata", input.parts.metadata);
        requestBody = input.parts.requestBody
          ? await openPendingStreamPart(directory, "requestBody", input.parts.requestBody)
          : undefined;
        responseBody = input.parts.responseBody
          ? await openPendingStreamPart(directory, "responseBody", input.parts.responseBody)
          : undefined;
        this.pendingStreams.set(input.captureId, {
          owner,
          start: structuredClone(input),
          directory,
          metadata,
          requestBody,
          responseBody,
        });
      } catch (error) {
        await closePendingStreamPart(metadata);
        await closePendingStreamPart(requestBody);
        await closePendingStreamPart(responseBody);
        await removeTemporaryDirectory(directory);
        await this.recordDropped(input.bindingId);
        throw error;
      }
    });
  }

  appendStream(
    captureId: string,
    owner: object,
    part: BrowserCapturePartKind,
    offset: number,
    data: Buffer,
  ): Promise<void> {
    return this.enqueue(async () => {
      await this.initialize();
      const capture = this.ownedPendingStream(captureId, owner);
      const pending = capture[part];
      if (!pending) throw new Error(`Capture did not declare ${part}`);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset !== pending.offset) {
        throw new Error(`Non-sequential ${part} offset`);
      }
      if (pending.offset + data.byteLength > pending.declaration.byteLength) {
        throw new Error(`${part} exceeds its declared length`);
      }
      if (data.byteLength === 0) return;
      const { bytesWritten } = await pending.handle.write(data, 0, data.byteLength, pending.offset);
      if (bytesWritten !== data.byteLength) throw new Error(`Incomplete ${part} write`);
      pending.hash.update(data);
      pending.offset += bytesWritten;
    });
  }

  commitStream(
    captureId: string,
    owner: object,
  ): Promise<{ exchange: StoredBrowserExchange; stats: BrowserCaptureStats }> {
    return this.enqueue(async () => {
      await this.initialize();
      const capture = this.ownedPendingStream(captureId, owner);
      this.pendingStreams.delete(captureId);
      try {
        await finishPendingStreamPart(capture.metadata, "metadata");
        if (capture.requestBody) await finishPendingStreamPart(capture.requestBody, "requestBody");
        if (capture.responseBody)
          await finishPendingStreamPart(capture.responseBody, "responseBody");
        const metadata: unknown = JSON.parse(await readFile(capture.metadata.path, "utf8"));
        const canonical = validateCanonicalMetadata(metadata, capture.start);
        const requestDescriptor = canonicalBodyDescriptor(canonical, "request");
        const responseDescriptor = canonicalBodyDescriptor(canonical, "response");
        validateStreamBody(capture.requestBody, requestDescriptor, "requestBody");
        validateStreamBody(capture.responseBody, responseDescriptor, "responseBody");
        if (capture.requestBody)
          await rename(capture.requestBody.path, join(capture.directory, "request.body"));
        if (capture.responseBody)
          await rename(capture.responseBody.path, join(capture.directory, "response.body"));
        await rm(capture.metadata.path, { force: true });

        const completedAt = canonicalCompletedAt(canonical);
        const manifest: StoredManifest = {
          version: 1,
          bindingId: capture.start.bindingId,
          tabId: capture.start.tabId,
          exchangeId: capture.start.exchangeId,
          createdAt: canonicalStartedAt(canonical),
          completedAt,
          metadata: canonical,
          ...(requestDescriptor
            ? { requestBody: { ...requestDescriptor, kind: "request", file: "request.body" } }
            : {}),
          ...(responseDescriptor
            ? { responseBody: { ...responseDescriptor, kind: "response", file: "response.body" } }
            : {}),
          storedBytes: 0,
        };
        const manifestPath = join(capture.directory, "manifest.json");
        this.assertBodyIdsAvailable(manifest);
        const serialized = serializeManifestWithSize(manifest);
        await writeFile(manifestPath, serialized, { mode: 0o600, flag: "wx" });
        await chmod(manifestPath, 0o600);
        const finalDirectory = this.exchangeDirectory(
          manifest.bindingId,
          manifest.tabId,
          manifest.exchangeId,
        );
        if (await pathExists(finalDirectory)) throw new Error("Exchange is already stored");
        await rename(capture.directory, finalDirectory);
        const indexed = { manifest, directory: finalDirectory };
        this.indexExchange(indexed);
        const evicted = await this.enforceLimits(manifest.bindingId, manifest.tabId);
        const current = this.recalculateStats(manifest.bindingId, evicted, 0);
        await this.persistStats(manifest.bindingId);
        return { exchange: publicExchange(manifest), stats: current };
      } catch (error) {
        await closePendingStreamPart(capture.metadata);
        await closePendingStreamPart(capture.requestBody);
        await closePendingStreamPart(capture.responseBody);
        await removeTemporaryDirectory(capture.directory);
        await this.recordDropped(capture.start.bindingId);
        throw error;
      }
    });
  }

  abortStream(captureId: string, owner: object): Promise<void> {
    return this.enqueue(async () => {
      await this.initialize();
      const capture = this.ownedPendingStream(captureId, owner);
      this.pendingStreams.delete(captureId);
      await closePendingStreamPart(capture.metadata);
      await closePendingStreamPart(capture.requestBody);
      await closePendingStreamPart(capture.responseBody);
      await removeTemporaryDirectory(capture.directory);
      await this.recordDropped(capture.start.bindingId);
    });
  }

  abortOwner(owner: object): Promise<void> {
    return this.enqueue(async () => {
      await this.initialize();
      const streams = [...this.pendingStreams.entries()].filter(
        ([, capture]) => capture.owner === owner,
      );
      for (const [captureId, capture] of streams) {
        this.pendingStreams.delete(captureId);
        await closePendingStreamPart(capture.metadata);
        await closePendingStreamPart(capture.requestBody);
        await closePendingStreamPart(capture.responseBody);
        await removeTemporaryDirectory(capture.directory);
        await this.recordDropped(capture.start.bindingId);
      }
    });
  }

  list(
    bindingId: string,
    options: { tabId?: string | number; since?: number; search?: string; limit?: number } = {},
  ): Promise<{ requests: StoredBrowserExchange[]; stats: BrowserCaptureStats }> {
    return this.enqueue(async () => {
      await this.initialize();
      const limit = Math.max(1, Math.min(1_000, options.limit ?? 100));
      const search = options.search?.toLocaleLowerCase();
      const requests = [...this.exchanges.values()]
        .map(({ manifest }) => manifest)
        .filter(
          (manifest) =>
            manifest.bindingId === bindingId &&
            (options.tabId === undefined || String(manifest.tabId) === String(options.tabId)) &&
            (options.since === undefined || manifest.createdAt >= options.since) &&
            (!search || JSON.stringify(manifest.metadata).toLocaleLowerCase().includes(search)),
        )
        .sort(compareNewest)
        .slice(0, limit)
        .map(publicExchangeSummary);
      return { requests, stats: this.bindingStats(bindingId) };
    });
  }

  get(bindingId: string, exchangeId: string): Promise<StoredBrowserExchange> {
    return this.enqueue(async () => {
      await this.initialize();
      const matches = [...this.exchanges.values()].filter(
        ({ manifest }) => manifest.bindingId === bindingId && manifest.exchangeId === exchangeId,
      );
      if (matches.length === 0) throw new Error("Network exchange not found");
      if (matches.length > 1)
        throw new Error("exchangeId is ambiguous; include a globally unique ID");
      return publicExchange(matches[0]!.manifest);
    });
  }

  readBody(
    bindingId: string,
    bodyId: string,
    offset = 0,
    length = MAX_NETWORK_BODY_READ_BYTES,
  ): Promise<{
    bodyId: string;
    offset: number;
    length: number;
    totalLength: number;
    eof: boolean;
    encoding: "base64";
    data: string;
  }> {
    return this.enqueue(async () => {
      await this.initialize();
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw new Error("offset must be non-negative");
      if (!Number.isSafeInteger(length) || length < 1 || length > MAX_NETWORK_BODY_READ_BYTES) {
        throw new Error(`length must be between 1 and ${MAX_NETWORK_BODY_READ_BYTES}`);
      }
      const indexed = this.bodyIndex.get(bodyKey(bindingId, bodyId));
      if (!indexed) {
        throw new Error("Network body not found");
      }
      const body =
        indexed.manifest.requestBody?.bodyId === bodyId
          ? indexed.manifest.requestBody
          : indexed.manifest.responseBody?.bodyId === bodyId
            ? indexed.manifest.responseBody
            : undefined;
      if (!body || offset > body.length) throw new Error("Network body range is invalid");
      const bytesToRead = Math.min(length, body.length - offset);
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const handle = await open(
        join(indexed.directory, body.file),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size !== body.length)
          throw new Error("Network body is unavailable");
        const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offset);
        if (bytesRead !== bytesToRead) throw new Error("Network body is unavailable");
      } finally {
        await handle.close();
      }
      return {
        bodyId,
        offset,
        length: bytesToRead,
        totalLength: body.length,
        eof: offset + bytesToRead === body.length,
        encoding: "base64",
        data: buffer.toString("base64"),
      };
    });
  }

  private async load(): Promise<void> {
    await secureDirectory(this.root);
    const bindingEntries = await readdir(this.root, { withFileTypes: true });
    for (const bindingEntry of bindingEntries) {
      if (!bindingEntry.isDirectory() || !bindingEntry.name.startsWith("b-")) continue;
      const bindingDirectory = join(this.root, bindingEntry.name);
      await chmod(bindingDirectory, 0o700);
      const persisted = await readStatsFile(join(bindingDirectory, "stats.json"));
      if (persisted) this.stats.set(persisted.bindingId, persisted.stats);
      const tabEntries = await readdir(bindingDirectory, { withFileTypes: true });
      for (const tabEntry of tabEntries) {
        if (!tabEntry.isDirectory() || !tabEntry.name.startsWith("t-")) continue;
        const tabDirectory = join(bindingDirectory, tabEntry.name);
        await chmod(tabDirectory, 0o700);
        const exchangeEntries = await readdir(tabDirectory, { withFileTypes: true });
        for (const exchangeEntry of exchangeEntries) {
          const directory = join(tabDirectory, exchangeEntry.name);
          if (exchangeEntry.isDirectory() && exchangeEntry.name.startsWith(".tmp-")) {
            await removeTemporaryDirectory(directory);
            continue;
          }
          if (!exchangeEntry.isDirectory() || !exchangeEntry.name.startsWith("e-")) continue;
          const indexed = await loadExchange(directory).catch(() => undefined);
          if (!indexed) continue;
          if (
            directory !==
            this.exchangeDirectory(
              indexed.manifest.bindingId,
              indexed.manifest.tabId,
              indexed.manifest.exchangeId,
            )
          ) {
            continue;
          }
          this.indexExchange(indexed);
        }
      }
    }
    for (const bindingId of new Set([
      ...this.stats.keys(),
      ...[...this.exchanges.values()].map(({ manifest }) => manifest.bindingId),
    ])) {
      const persisted = await this.readPersistedStats(bindingId);
      this.stats.set(bindingId, {
        retained: 0,
        storedBytes: 0,
        evicted: persisted?.evicted ?? 0,
        dropped: persisted?.dropped ?? 0,
      });
      this.recalculateStats(bindingId, 0, 0);
      const tabIds = new Set(
        [...this.exchanges.values()]
          .filter(({ manifest }) => manifest.bindingId === bindingId)
          .map(({ manifest }) => manifest.tabId),
      );
      let evicted = 0;
      for (const tabId of tabIds) evicted += await this.enforceLimits(bindingId, tabId);
      if (evicted) {
        this.recalculateStats(bindingId, evicted, 0);
        await this.persistStats(bindingId);
      }
    }
  }

  private ownedPendingStream(captureId: string, owner: object): PendingStreamCapture {
    const capture = this.pendingStreams.get(captureId);
    if (!capture) throw new Error("Capture is not active");
    if (capture.owner !== owner) throw new Error("Capture belongs to another connection");
    return capture;
  }

  private indexExchange(indexed: IndexedExchange): void {
    const key = exchangeKey(
      indexed.manifest.bindingId,
      indexed.manifest.tabId,
      indexed.manifest.exchangeId,
    );
    if (this.exchanges.has(key)) return;
    this.exchanges.set(key, indexed);
    if (indexed.manifest.requestBody) {
      this.bodyIndex.set(
        bodyKey(indexed.manifest.bindingId, indexed.manifest.requestBody.bodyId),
        indexed,
      );
    }
    if (indexed.manifest.responseBody) {
      this.bodyIndex.set(
        bodyKey(indexed.manifest.bindingId, indexed.manifest.responseBody.bodyId),
        indexed,
      );
    }
  }

  private unindexExchange(indexed: IndexedExchange): void {
    this.exchanges.delete(
      exchangeKey(indexed.manifest.bindingId, indexed.manifest.tabId, indexed.manifest.exchangeId),
    );
    if (indexed.manifest.requestBody) {
      this.bodyIndex.delete(
        bodyKey(indexed.manifest.bindingId, indexed.manifest.requestBody.bodyId),
      );
    }
    if (indexed.manifest.responseBody) {
      this.bodyIndex.delete(
        bodyKey(indexed.manifest.bindingId, indexed.manifest.responseBody.bodyId),
      );
    }
  }

  private assertBodyIdsAvailable(manifest: StoredManifest): void {
    for (const body of [manifest.requestBody, manifest.responseBody]) {
      if (body && this.bodyIndex.has(bodyKey(manifest.bindingId, body.bodyId))) {
        throw new Error("Network body ID is already stored for this binding");
      }
    }
  }

  private async enforceLimits(bindingId: string, tabId: string | number): Promise<number> {
    let evicted = 0;
    const tabExchanges = [...this.exchanges.values()]
      .filter(
        ({ manifest }) =>
          manifest.bindingId === bindingId && String(manifest.tabId) === String(tabId),
      )
      .sort(compareOldestIndexed);
    while (tabExchanges.length > this.maxExchangesPerTab) {
      const oldest = tabExchanges.shift()!;
      await this.evict(oldest);
      evicted += 1;
    }
    const bindingExchanges = [...this.exchanges.values()]
      .filter(({ manifest }) => manifest.bindingId === bindingId)
      .sort(compareOldestIndexed);
    let storedBytes = bindingExchanges.reduce(
      (total, { manifest }) => total + manifest.storedBytes,
      0,
    );
    while (storedBytes > this.maxBytesPerBinding && bindingExchanges.length) {
      const oldest = bindingExchanges.shift()!;
      storedBytes -= oldest.manifest.storedBytes;
      await this.evict(oldest);
      evicted += 1;
    }
    return evicted;
  }

  private async evict(indexed: IndexedExchange): Promise<void> {
    this.unindexExchange(indexed);
    await rm(indexed.directory, { recursive: true, force: true });
  }

  private bindingStats(bindingId: string): BrowserCaptureStats {
    return structuredClone(
      this.stats.get(bindingId) ?? { retained: 0, evicted: 0, dropped: 0, storedBytes: 0 },
    );
  }

  private recalculateStats(
    bindingId: string,
    evicted: number,
    dropped: number,
  ): BrowserCaptureStats {
    const previous = this.bindingStats(bindingId);
    const retained = [...this.exchanges.values()].filter(
      ({ manifest }) => manifest.bindingId === bindingId,
    );
    const current = {
      retained: retained.length,
      evicted: previous.evicted + evicted,
      dropped: previous.dropped + dropped,
      storedBytes: retained.reduce((total, { manifest }) => total + manifest.storedBytes, 0),
    };
    this.stats.set(bindingId, current);
    return structuredClone(current);
  }

  private async recordDropped(bindingId: string): Promise<void> {
    this.recalculateStats(bindingId, 0, 1);
    await this.persistStats(bindingId);
  }

  private async readPersistedStats(bindingId: string): Promise<BrowserCaptureStats | undefined> {
    return (await readStatsFile(this.statsPath(bindingId)))?.stats;
  }

  private async persistStats(bindingId: string): Promise<void> {
    const directory = this.bindingDirectory(bindingId);
    await secureDirectory(directory);
    const target = this.statsPath(bindingId);
    const temporary = join(directory, `.stats-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify({ bindingId, ...this.bindingStats(bindingId) }), {
      mode: 0o600,
      flag: "wx",
    });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
    await chmod(target, 0o600);
  }

  private bindingDirectory(bindingId: string): string {
    return join(this.root, `b-${digestPathPart(bindingId)}`);
  }

  private tabDirectory(bindingId: string, tabId: string | number): string {
    return join(this.bindingDirectory(bindingId), `t-${digestPathPart(String(tabId))}`);
  }

  private exchangeDirectory(bindingId: string, tabId: string | number, exchangeId: string): string {
    return join(this.tabDirectory(bindingId, tabId), `e-${digestPathPart(exchangeId)}`);
  }

  private statsPath(bindingId: string): string {
    return join(this.bindingDirectory(bindingId), "stats.json");
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operation.then(operation, operation);
    this.operation = next.catch(() => undefined);
    return next;
  }
}

async function openPendingStreamPart(
  directory: string,
  part: BrowserCapturePartKind,
  declaration: BrowserCapturePartDeclaration,
): Promise<PendingStreamPart> {
  const path = join(directory, `${part}.part`);
  const handle = await open(path, "wx", 0o600);
  await chmod(path, 0o600);
  return {
    declaration: structuredClone(declaration),
    handle,
    path,
    offset: 0,
    hash: createHash("sha256"),
  };
}

async function finishPendingStreamPart(
  pending: PendingStreamPart,
  part: BrowserCapturePartKind,
): Promise<void> {
  await pending.handle.sync();
  await pending.handle.close();
  if (pending.offset !== pending.declaration.byteLength) {
    throw new Error(`${part} length does not match its declaration`);
  }
  if (pending.hash.digest("hex") !== pending.declaration.sha256.toLowerCase()) {
    throw new Error(`${part} SHA-256 does not match its declaration`);
  }
}

async function closePendingStreamPart(part: PendingStreamPart | undefined): Promise<void> {
  if (!part) return;
  await part.handle.close().catch(() => undefined);
}

function validateStreamStart(input: BrowserCaptureStreamStart, maxPartBytes: number): void {
  if (!nonEmptyString(input.captureId) || input.captureId.length > 256)
    throw new Error("Invalid captureId");
  if (!nonEmptyString(input.bindingId) || input.bindingId.length > 256)
    throw new Error("Invalid bindingId");
  if (!nonEmptyString(input.threadId) || input.threadId.length > 1_024)
    throw new Error("Invalid threadId");
  if (!Number.isSafeInteger(input.tabId) || input.tabId < 0) throw new Error("Invalid tabId");
  if (!nonEmptyString(input.exchangeId) || input.exchangeId.length > 1_024)
    throw new Error("Invalid exchangeId");
  if (input.provider !== "chrome") throw new Error("Invalid provider");
  for (const part of [input.parts.metadata, input.parts.requestBody, input.parts.responseBody]) {
    if (!part) continue;
    if (
      !Number.isSafeInteger(part.byteLength) ||
      part.byteLength < 0 ||
      part.byteLength > maxPartBytes ||
      !/^[a-f\d]{64}$/iu.test(part.sha256)
    ) {
      throw new Error(`Capture part exceeds ${maxPartBytes} bytes or has an invalid digest`);
    }
  }
}

function validateCanonicalMetadata(
  value: unknown,
  start: BrowserCaptureStreamStart,
): Record<string, unknown> {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.provider !== start.provider ||
    !Array.isArray(value.rawEvents) ||
    !value.rawEvents.every(isRecord) ||
    !isRecord(value.exchange)
  ) {
    throw new Error("Invalid canonical network metadata");
  }
  const exchange = value.exchange;
  if (
    exchange.exchangeId !== start.exchangeId ||
    exchange.threadId !== start.threadId ||
    exchange.tabId !== start.tabId ||
    typeof exchange.startedAt !== "number" ||
    !Number.isFinite(exchange.startedAt) ||
    typeof exchange.completedAt !== "number" ||
    !Number.isFinite(exchange.completedAt) ||
    !isRecord(exchange.request) ||
    (exchange.response !== null && !isRecord(exchange.response)) ||
    (exchange.failure !== null && !isRecord(exchange.failure)) ||
    (exchange.response === null && exchange.failure === null)
  ) {
    throw new Error("Network exchange is incomplete or does not match its capture key");
  }
  return value;
}

function canonicalBodyDescriptor(
  canonical: Record<string, unknown>,
  kind: BrowserCaptureBodyKind,
): BrowserCaptureBodyDeclaration | undefined {
  const exchange = canonical.exchange as Record<string, unknown>;
  const endpoint = kind === "request" ? exchange.request : exchange.response;
  if (!isRecord(endpoint) || endpoint.body === null || endpoint.body === undefined)
    return undefined;
  if (!isRecord(endpoint.body)) throw new Error(`Invalid ${kind} body descriptor`);
  const body = endpoint.body;
  if (
    !nonEmptyString(body.bodyId) ||
    !Number.isSafeInteger(body.byteLength) ||
    Number(body.byteLength) < 0 ||
    !/^[a-f\d]{64}$/iu.test(String(body.sha256)) ||
    (body.mediaType !== null && body.mediaType !== undefined && typeof body.mediaType !== "string")
  ) {
    throw new Error(`Invalid ${kind} body descriptor`);
  }
  return {
    bodyId: body.bodyId,
    length: Number(body.byteLength),
    sha256: String(body.sha256).toLowerCase(),
    ...(typeof body.mediaType === "string" ? { mimeType: body.mediaType } : {}),
  };
}

function validateStreamBody(
  part: PendingStreamPart | undefined,
  descriptor: BrowserCaptureBodyDeclaration | undefined,
  name: "requestBody" | "responseBody",
): void {
  if (!part && !descriptor) return;
  if (!part || !descriptor) throw new Error(`${name} metadata and capture part do not agree`);
  if (
    part.declaration.byteLength !== descriptor.length ||
    part.declaration.sha256.toLowerCase() !== descriptor.sha256.toLowerCase()
  ) {
    throw new Error(`${name} descriptor does not match canonical metadata`);
  }
}

function canonicalStartedAt(canonical: Record<string, unknown>): number {
  return Number((canonical.exchange as Record<string, unknown>).startedAt);
}

function canonicalCompletedAt(canonical: Record<string, unknown>): number {
  return Number((canonical.exchange as Record<string, unknown>).completedAt);
}

function serializeManifestWithSize(manifest: StoredManifest): string {
  let serialized = JSON.stringify(manifest);
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const storedBytes =
      Buffer.byteLength(serialized) +
      (manifest.requestBody?.length ?? 0) +
      (manifest.responseBody?.length ?? 0);
    if (storedBytes === manifest.storedBytes) return serialized;
    manifest.storedBytes = storedBytes;
    serialized = JSON.stringify(manifest);
  }
  return serialized;
}

async function loadExchange(directory: string): Promise<IndexedExchange> {
  await chmod(directory, 0o700);
  const manifestPath = join(directory, "manifest.json");
  const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!isStoredManifest(parsed)) throw new Error("Invalid capture manifest");
  await chmod(manifestPath, 0o600);
  for (const body of [parsed.requestBody, parsed.responseBody]) {
    if (!body) continue;
    const path = join(directory, body.file);
    const info = await stat(path);
    if (!info.isFile() || info.size !== body.length) throw new Error("Invalid capture body");
    await chmod(path, 0o600);
  }
  return { manifest: parsed, directory };
}

function publicExchange(manifest: StoredManifest): StoredBrowserExchange {
  return {
    bindingId: manifest.bindingId,
    tabId: manifest.tabId,
    exchangeId: manifest.exchangeId,
    createdAt: manifest.createdAt,
    completedAt: manifest.completedAt,
    metadata: structuredClone(manifest.metadata),
    ...(manifest.requestBody ? { requestBody: publicBody(manifest.requestBody) } : {}),
    ...(manifest.responseBody ? { responseBody: publicBody(manifest.responseBody) } : {}),
    storedBytes: manifest.storedBytes,
  };
}

function publicExchangeSummary(manifest: StoredManifest): StoredBrowserExchange {
  const exchange = publicExchange(manifest);
  if (!Array.isArray(exchange.metadata.rawEvents)) return exchange;
  const metadata = structuredClone(exchange.metadata);
  delete metadata.rawEvents;
  return { ...exchange, metadata };
}

function publicBody(body: StoredBrowserCaptureBody): StoredBrowserCaptureBody {
  const { bodyId, kind, length, sha256, mimeType } = body;
  return { bodyId, kind, length, sha256, ...(mimeType ? { mimeType } : {}) };
}

function validateStoredManifestFields(input: StoredManifestFields, maxBodyBytes: number): void {
  if (!nonEmptyString(input.bindingId) || input.bindingId.length > 256)
    throw new Error("Invalid bindingId");
  if (!nonEmptyString(input.exchangeId) || input.exchangeId.length > 1_024)
    throw new Error("Invalid exchangeId");
  if (
    (typeof input.tabId !== "string" || !input.tabId || input.tabId.length > 1_024) &&
    (!Number.isSafeInteger(input.tabId) || Number(input.tabId) < 0)
  ) {
    throw new Error("Invalid tabId");
  }
  if (!isRecord(input.metadata)) throw new Error("Invalid capture metadata");
  if (input.createdAt !== undefined && (!Number.isFinite(input.createdAt) || input.createdAt < 0)) {
    throw new Error("Invalid capture timestamp");
  }
  for (const body of [input.requestBody, input.responseBody]) {
    if (!body) continue;
    if (!nonEmptyString(body.bodyId) || body.bodyId.length > 1_024)
      throw new Error("Invalid bodyId");
    if (!Number.isSafeInteger(body.length) || body.length < 0 || body.length > maxBodyBytes) {
      throw new Error(`Body length exceeds ${maxBodyBytes} bytes`);
    }
    if (!/^[a-f\d]{64}$/i.test(body.sha256)) throw new Error("Invalid body SHA-256");
    if (
      body.mimeType !== undefined &&
      (typeof body.mimeType !== "string" || body.mimeType.length > 1_024)
    ) {
      throw new Error("Invalid body mimeType");
    }
  }
  if (
    input.requestBody &&
    input.responseBody &&
    input.requestBody.bodyId === input.responseBody.bodyId
  ) {
    throw new Error("Request and response bodies require distinct body IDs");
  }
}

function isStoredManifest(value: unknown): value is StoredManifest {
  if (!isRecord(value)) return false;
  try {
    validateStoredManifestFields(
      {
        bindingId: value.bindingId as string,
        tabId: value.tabId as string | number,
        exchangeId: value.exchangeId as string,
        createdAt: value.createdAt as number,
        metadata: value.metadata as Record<string, unknown>,
        requestBody: value.requestBody as StoredBrowserCaptureBody | undefined,
        responseBody: value.responseBody as StoredBrowserCaptureBody | undefined,
      },
      DEFAULT_MAX_BODY_BYTES,
    );
  } catch {
    return false;
  }
  return (
    value.version === 1 &&
    typeof value.completedAt === "number" &&
    Number.isFinite(value.completedAt) &&
    typeof value.storedBytes === "number" &&
    Number.isSafeInteger(value.storedBytes) &&
    value.storedBytes >= 0 &&
    isStoredBody(value.requestBody, "request") &&
    isStoredBody(value.responseBody, "response")
  );
}

function isStoredBody(value: unknown, kind: BrowserCaptureBodyKind): boolean {
  if (value === undefined) return true;
  return isRecord(value) && value.kind === kind && value.file === `${kind}.body`;
}

function isCaptureStats(value: unknown): value is BrowserCaptureStats {
  return (
    isRecord(value) &&
    [value.retained, value.evicted, value.dropped, value.storedBytes].every(
      (item) => Number.isSafeInteger(item) && Number(item) >= 0,
    )
  );
}

async function readStatsFile(
  path: string,
): Promise<{ bindingId: string; stats: BrowserCaptureStats } | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed) || !nonEmptyString(parsed.bindingId) || !isCaptureStats(parsed)) {
      return undefined;
    }
    await chmod(path, 0o600);
    return {
      bindingId: parsed.bindingId,
      stats: {
        retained: Number(parsed.retained),
        evicted: Number(parsed.evicted),
        dropped: Number(parsed.dropped),
        storedBytes: Number(parsed.storedBytes),
      },
    };
  } catch {
    return undefined;
  }
}

function exchangeKey(bindingId: string, tabId: string | number, exchangeId: string): string {
  return `${bindingId}\0${String(tabId)}\0${exchangeId}`;
}

function bodyKey(bindingId: string, bodyId: string): string {
  return `${bindingId}\0${bodyId}`;
}

function digestPathPart(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareNewest(left: StoredManifest, right: StoredManifest): number {
  return right.createdAt - left.createdAt || right.completedAt - left.completedAt;
}

function compareOldestIndexed(left: IndexedExchange, right: IndexedExchange): number {
  return (
    left.manifest.createdAt - right.manifest.createdAt ||
    left.manifest.completedAt - right.manifest.completedAt
  );
}

async function secureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function removeTemporaryDirectory(path: string): Promise<void> {
  if (!path.split(/[\\/]/u).at(-1)?.startsWith(".tmp-")) return;
  await rm(path, { recursive: true, force: true });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
