/** OpenCode's native HTTP boundary. Mutations are deliberately never retried here. */
export type OpenCodeEvent = {
  type: string;
  properties: Record<string, unknown>;
  id?: string;
  directory?: string;
};

export type OpenCodeErrorCode =
  "timeout" | "aborted" | "unavailable" | "invalid_response" | "http_error";

export class OpenCodeError extends Error {
  constructor(
    public readonly code: OpenCodeErrorCode,
    public readonly status: number | null = null,
  ) {
    // Neither upstream response bodies nor fetch error messages may expose credentials/content.
    super(
      code === "http_error"
        ? `OpenCode request failed (HTTP ${status}).`
        : {
            timeout: "OpenCode request timed out.",
            aborted: "OpenCode request was cancelled.",
            unavailable: "OpenCode is unavailable.",
            invalid_response: "OpenCode returned an invalid response.",
          }[code],
    );
    this.name = "OpenCodeError";
  }
}

export type OpenCodeRequestOptions = {
  directory?: string;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type OpenCodeClientOptions = {
  baseUrl: string;
  username?: string;
  password?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  eventIdleTimeoutMs?: number;
};

function deadline(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000)
    throw new Error("Invalid OpenCode request timeout.");
  return value;
}

function cancelled(signal?: AbortSignal, timedOut = false): OpenCodeError {
  return new OpenCodeError(signal?.aborted ? "aborted" : timedOut ? "timeout" : "unavailable");
}

/** Split SSE lines, including CRLF sequences divided between network chunks. */
async function* readEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  idleTimeoutMs: number,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const maxEventLength = 16 * 1024 * 1024;
  let buffer = "";
  let data: string[] = [];
  let eventLength = 0;
  let firstLine = true;
  let done = false;
  while (!done) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      if (signal.aborted) throw new OpenCodeError("aborted");
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new OpenCodeError("aborted"));
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
          timeout = setTimeout(() => reject(new OpenCodeError("timeout")), idleTimeoutMs);
          timeout.unref();
        }),
      ]);
      done = chunk.done;
      buffer += decoder.decode(chunk.value, { stream: !done });
    } finally {
      clearTimeout(timeout);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
    if (buffer.length + eventLength > maxEventLength) throw new OpenCodeError("invalid_response");
    while (buffer.length) {
      const end = buffer.search(/[\r\n]/);
      if (end < 0) break;
      if (buffer[end] === "\r" && end === buffer.length - 1 && !done) break;
      let line = buffer.slice(0, end);
      buffer = buffer.slice(end + (buffer[end] === "\r" && buffer[end + 1] === "\n" ? 2 : 1));
      if (firstLine) {
        line = line.replace(/^\uFEFF/, "");
        firstLine = false;
      }
      if (!line) {
        if (data.length) yield data.join("\n");
        data = [];
        eventLength = 0;
      } else if (line.startsWith("data:")) {
        const value = line.slice(5).replace(/^ /, "");
        data.push(value);
        eventLength += value.length;
      }
    }
  }
  // SSE dispatches only complete events terminated by a blank line. An interrupted
  // final packet is discarded; the consumer must reconcile its native snapshot.
}

function eventValue(value: unknown): OpenCodeEvent {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new OpenCodeError("invalid_response");
  const outer = value as Record<string, unknown>;
  const payload = (outer.payload ?? outer) as Record<string, unknown>;
  if (!payload || typeof payload !== "object" || typeof payload.type !== "string")
    throw new OpenCodeError("invalid_response");
  const properties = payload.properties ?? {};
  if (!properties || typeof properties !== "object" || Array.isArray(properties))
    throw new OpenCodeError("invalid_response");
  return {
    type: payload.type,
    properties: properties as Record<string, unknown>,
    ...(typeof payload.id === "string" ? { id: payload.id } : {}),
    ...(typeof outer.directory === "string" ? { directory: outer.directory } : {}),
  };
}

export class OpenCodeClient {
  private readonly origin: string;
  private readonly headers: Record<string, string>;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly eventIdleTimeoutMs: number;

  constructor(options: OpenCodeClientOptions) {
    let url: URL;
    try {
      url = new URL(options.baseUrl);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        throw new Error();
    } catch {
      throw new Error("Invalid OpenCode server address.");
    }
    this.origin = url.origin;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = deadline(options.timeoutMs ?? 30_000);
    this.eventIdleTimeoutMs = deadline(options.eventIdleTimeoutMs ?? 45_000);
    this.headers = options.password
      ? {
          authorization: `Basic ${Buffer.from(`${options.username ?? "opencode"}:${options.password}`).toString("base64")}`,
        }
      : {};
  }

  private url(path: string, directory?: string): URL {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("#"))
      throw new Error("Invalid OpenCode API path.");
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin) throw new Error("Invalid OpenCode API path.");
    if (directory !== undefined) url.searchParams.set("directory", directory);
    return url;
  }

  async request<T = unknown>(
    method: string,
    path: string,
    options: OpenCodeRequestOptions = {},
  ): Promise<T> {
    const url = this.url(path, options.directory);
    const timeout = AbortSignal.timeout(deadline(options.timeoutMs ?? this.timeoutMs));
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    try {
      const response = await this.fetcher(url, {
        method,
        headers: {
          ...this.headers,
          accept: "application/json",
          ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal,
        redirect: "error",
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new OpenCodeError("http_error", response.status);
      }
      if (response.status === 204) return undefined as T;
      const body = await response.text();
      if (!body) return undefined as T;
      try {
        return JSON.parse(body) as T;
      } catch {
        throw new OpenCodeError("invalid_response");
      }
    } catch (error) {
      if (error instanceof OpenCodeError) throw error;
      throw cancelled(options.signal, timeout.aborted);
    }
  }

  async health(): Promise<{ healthy: boolean; version: string }> {
    const health = await this.request<{ healthy?: unknown; version?: unknown }>(
      "GET",
      "/global/health",
    );
    if (!health || typeof health.healthy !== "boolean" || typeof health.version !== "string")
      throw new OpenCodeError("invalid_response");
    return { healthy: health.healthy, version: health.version };
  }

  async *events(directory?: string, signal?: AbortSignal): AsyncGenerator<OpenCodeEvent> {
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    // A stalled loopback handshake must leave time for reconnection during
    // startup. This deadline ends at the headers; stream idle/RPC limits stay separate.
    const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 3_000));
    timer.unref();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let body: ReadableStream<Uint8Array> | null = null;
    try {
      const response = await this.fetcher(
        this.url(directory === undefined ? "/global/event" : "/event", directory),
        {
          headers: { ...this.headers, accept: "text/event-stream" },
          signal: combined,
          redirect: "error",
        },
      );
      clearTimeout(timer);
      body = response.body;
      if (!response.ok) throw new OpenCodeError("http_error", response.status);
      if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream"))
        throw new OpenCodeError("invalid_response");
      reader = response.body.getReader();
      for await (const data of readEvents(reader, combined, this.eventIdleTimeoutMs)) {
        let value: unknown;
        try {
          value = JSON.parse(data);
        } catch {
          throw new OpenCodeError("invalid_response");
        }
        yield eventValue(value);
      }
    } catch (error) {
      if (error instanceof OpenCodeError) {
        if (error.code === "aborted" && !signal?.aborted && controller.signal.aborted)
          throw new OpenCodeError("timeout");
        throw error;
      }
      throw cancelled(signal, controller.signal.aborted);
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (reader) {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      } else void body?.cancel().catch(() => undefined);
    }
  }
}
