import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeClient, OpenCodeError } from "./opencode";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

async function server(handle: (req: IncomingMessage, res: ServerResponse) => void) {
  const instance = createServer(handle);
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    instance.closeAllConnections();
    await new Promise<void>((resolve) => instance.close(() => resolve()));
  });
  const address = instance.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  return `http://127.0.0.1:${address.port}`;
}

describe("OpenCode native transport", () => {
  it("keeps provider/model identifiers and directory paths intact and authenticates only to the native host", async () => {
    let received: Record<string, unknown> | undefined;
    const baseUrl = await server((req, res) => {
      let input = "";
      req.on("data", (chunk) => (input += chunk));
      req.on("end", () => {
        received = { url: req.url, auth: req.headers.authorization, body: JSON.parse(input) };
        res.writeHead(204).end();
      });
    });
    const client = new OpenCodeClient({ baseUrl, password: "native-secret" });
    await expect(
      client.request("POST", "/session/ses_123/prompt_async", {
        directory: "/project/a & b",
        body: { model: { providerID: "openrouter", modelID: "anthropic/claude-sonnet-4" } },
      }),
    ).resolves.toBeUndefined();
    expect(received).toEqual({
      url: "/session/ses_123/prompt_async?directory=%2Fproject%2Fa+%26+b",
      auth: `Basic ${Buffer.from("opencode:native-secret").toString("base64")}`,
      body: { model: { providerID: "openrouter", modelID: "anthropic/claude-sonnet-4" } },
    });
    await expect(client.request("GET", "https://other.example/session")).rejects.toThrow(
      "Invalid OpenCode API path",
    );
    await expect(client.request("GET", "//other.example/session")).rejects.toThrow(
      "Invalid OpenCode API path",
    );
  });

  it("never retries a mutation after a connection is lost or exposes upstream credentials/content", async () => {
    let accepted = 0;
    const baseUrl = await server((req) => {
      accepted++;
      req.socket.destroy(new Error("sk-private-user-key prompt: private conversation"));
    });
    const client = new OpenCodeClient({ baseUrl });
    const error = await client
      .request("POST", "/session", { body: { title: "private conversation" } })
      .catch((e) => e);
    expect(accepted).toBe(1);
    expect(error).toBeInstanceOf(OpenCodeError);
    expect(error.code).toBe("unavailable");
    expect(String(error)).not.toMatch(/private|prompt/);
  });

  it("returns safe HTTP status errors and rejects malformed native responses", async () => {
    const baseUrl = await server((req, res) => {
      if (req.url === "/failure") res.writeHead(401).end('{"error":"sk-private-key"}');
      else res.writeHead(200).end("private upstream diagnostic that is not JSON");
    });
    const client = new OpenCodeClient({ baseUrl });
    await expect(client.request("GET", "/failure")).rejects.toMatchObject({
      code: "http_error",
      status: 401,
    });
    await expect(client.request("GET", "/malformed")).rejects.toMatchObject({
      code: "invalid_response",
    });
    await expect(client.health()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("bounds a native request and distinguishes explicit caller cancellation", async () => {
    const baseUrl = await server(() => undefined);
    const client = new OpenCodeClient({ baseUrl, timeoutMs: 30 });
    await expect(client.request("POST", "/session")).rejects.toMatchObject({ code: "timeout" });
    const controller = new AbortController();
    const pending = client.request("GET", "/session", {
      signal: controller.signal,
      timeoutMs: 1000,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });

  it("decodes partial UTF-8, CRLF boundaries, comments and multiline global events", async () => {
    const encoded = new TextEncoder().encode(
      '\uFEFF: connected\r\ndata: {"directory":"/проект",\r\ndata: "payload":{"type":"message.updated","properties":{"info":{"id":"msg_1"}}}}\r\n\r\n' +
        'data: {"type":"session.idle","properties":{"sessionID":"ses_1"}}\n\n' +
        'data: {"type":"incomplete"}',
    );
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (let i = 0; i < encoded.length; i += 3)
                controller.enqueue(encoded.slice(i, i + 3));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4097", fetch: fetcher });
    const events = [];
    for await (const event of client.events()) events.push(event);
    expect(events).toEqual([
      { type: "message.updated", directory: "/проект", properties: { info: { id: "msg_1" } } },
      { type: "session.idle", properties: { sessionID: "ses_1" } },
    ]);
    expect(String(fetcher.mock.calls[0]![0])).toBe("http://127.0.0.1:4097/global/event");
  });

  it("cancels a native stream when its consumer leaves and rejects malformed events", async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('data: {"type":"server.connected","properties":{}}\n\n'),
              );
            },
            cancel,
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4097", fetch: fetcher });
    for await (const event of client.events("/project")) {
      expect(event.type).toBe("server.connected");
      break;
    }
    expect(cancel).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      "http://127.0.0.1:4097/event?directory=%2Fproject",
    );
    const malformed = new OpenCodeClient({
      baseUrl: "http://127.0.0.1:4097",
      fetch: async () =>
        new Response("data: private invalid response\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
    });
    await expect(malformed.events().next()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("bounds stalled streams while allowing active streams to outlive the request timeout", async () => {
    const baseUrl = await server((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"type":"server.connected","properties":{}}\n\n');
    });
    const client = new OpenCodeClient({ baseUrl, timeoutMs: 100, eventIdleTimeoutMs: 150 });
    const stream = client.events();
    await expect(stream.next()).resolves.toMatchObject({ value: { type: "server.connected" } });
    await expect(stream.next()).rejects.toMatchObject({ code: "timeout" });
  });

  it("bounds an unresponsive SSE handshake so reconnect can recover without shortening normal RPCs", async () => {
    let attempts = 0;
    const baseUrl = await server((req, res) => {
      if (req.url === "/slow") {
        setTimeout(() => res.writeHead(200).end('{"completed":true}'), 3500);
        return;
      }
      attempts++;
      if (attempts === 1) return;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"type":"server.connected","properties":{}}\n\n');
    });
    const client = new OpenCodeClient({ baseUrl, timeoutMs: 30_000 });
    const regularRpc = client.request("GET", "/slow");
    const started = performance.now();
    await expect(client.events().next()).rejects.toMatchObject({ code: "timeout" });
    expect(performance.now() - started).toBeLessThan(8000);
    const recovered = client.events();
    await expect(recovered.next()).resolves.toMatchObject({
      value: { type: "server.connected" },
    });
    await recovered.return(undefined);
    expect(attempts).toBe(2);
    await expect(regularRpc).resolves.toEqual({ completed: true });
  }, 10_000);

  it("cancels a blocked SSE read immediately on caller abort", async () => {
    const cancel = vi.fn();
    const client = new OpenCodeClient({
      baseUrl: "http://127.0.0.1:4097",
      eventIdleTimeoutMs: 30_000,
      fetch: async () =>
        new Response(new ReadableStream({ cancel }), {
          headers: { "content-type": "text/event-stream" },
        }),
    });
    const controller = new AbortController();
    const stream = client.events(undefined, controller.signal);
    const pending = stream.next();
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    { status: 401, contentType: "text/event-stream", code: "http_error" },
    { status: 200, contentType: "text/html", code: "invalid_response" },
  ])(
    "releases rejected event response bodies ($status / $contentType)",
    async ({ status, contentType, code }) => {
      const cancel = vi.fn();
      const client = new OpenCodeClient({
        baseUrl: "http://127.0.0.1:4097",
        fetch: async () =>
          new Response(new ReadableStream({ cancel }), {
            status,
            headers: { "content-type": contentType },
          }),
      });
      await expect(client.events().next()).rejects.toMatchObject({ code });
      expect(cancel).toHaveBeenCalledOnce();
    },
  );
});
