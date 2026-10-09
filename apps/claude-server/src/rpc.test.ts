import { createServer, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunnerConnection } from "./rpc.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Connects to a stand-in runner that answers each request line through `reply`. */
async function connectToRunner(reply: (socket: Socket, id: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "claude-rpc-"));
  const path = join(directory, "runner.sock");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    let received = "";
    socket.on("error", () => undefined);
    socket.on("data", (data) => {
      received += data.toString();
      let end: number;
      while ((end = received.indexOf("\n")) >= 0) {
        const { id } = JSON.parse(received.slice(0, end)) as { id: string };
        received = received.slice(end + 1);
        void reply(socket, id).catch(() => undefined);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const connection = await RunnerConnection.open(path, 1_000);
  cleanup.push(async () => connection.close());
  return connection;
}

describe("runner connection framing", () => {
  it("reassembles replies and events split at arbitrary byte offsets", async () => {
    const connection = await connectToRunner(async (socket, id) => {
      const event = JSON.stringify({ type: "state", text: "привет 🙂" });
      const reply = JSON.stringify({ id, result: { text: "ответ 🙂", count: 2 } });
      const bytes = Buffer.from(`${event}\n\n${reply}\n`);
      // Cuts land inside a multi-byte character, before a newline and between the two lines.
      const cuts = [bytes.indexOf("🙂") + 2, bytes.indexOf("\n\n"), bytes.indexOf("\n\n") + 2, 90];
      let from = 0;
      for (const to of [...cuts, bytes.length].sort((a, b) => a - b)) {
        socket.write(bytes.subarray(from, to));
        from = to;
        await pause(5);
      }
    });
    const events: unknown[] = [];
    connection.on("message", (message) => events.push(message));
    await expect(connection.request("hello")).resolves.toEqual({ text: "ответ 🙂", count: 2 });
    expect(events).toEqual([{ type: "state", text: "привет 🙂" }]);
  });

  it("answers requests that arrive back to back on one connection", async () => {
    const connection = await connectToRunner(async (socket, id) => {
      socket.write(`${JSON.stringify({ id, result: id })}\n`);
    });
    const [first, second] = await Promise.all([connection.request("a"), connection.request("b")]);
    expect(typeof first).toBe("string");
    expect(typeof second).toBe("string");
    expect(first).not.toBe(second);
  });

  // A long task keeps up to 8 MiB of events in the runner's hello and snapshot replies.
  // Rescanning the received text per chunk made such a reply slower than the 1 s connect budget.
  it("reads a reply of tens of megabytes in linear time", async () => {
    const megabytes = 24;
    const connection = await connectToRunner(async (socket, id) => {
      const line = `${JSON.stringify({ id, result: { events: "x".repeat(megabytes * 1024 * 1024) } })}\n`;
      for (let at = 0; at < line.length; at += 16 * 1024) {
        if (!socket.write(line.slice(at, at + 16 * 1024)))
          await new Promise((resolve) => socket.once("drain", resolve));
      }
    });
    const started = performance.now();
    const result = (await connection.request<{ events: string }>("hello", undefined, 60_000)) as {
      events: string;
    };
    const elapsed = performance.now() - started;
    expect(result.events).toHaveLength(megabytes * 1024 * 1024);
    expect(elapsed).toBeLessThan(3_000);
  }, 60_000);

  it("drops a connection whose unfinished line grows past the size limit", async () => {
    const connection = await connectToRunner(async (socket) => {
      const piece = "x".repeat(1024 * 1024);
      for (let sent = 0; sent < 34; sent++) {
        if (socket.destroyed) return;
        if (!socket.write(piece)) await new Promise((resolve) => socket.once("drain", resolve));
      }
    });
    await expect(connection.request("hello")).rejects.toThrow(/disconnected/);
  });
});
