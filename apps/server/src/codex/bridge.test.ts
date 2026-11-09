import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { AccountLoginRequiredError, AccountSwitchInProgressError, CodexBridge } from "./bridge";
import type { JsonlProcess } from "./transport";

class HandshakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly frames: Array<Record<string, unknown>> = [];
  constructor() {
    super();
    this.stdin.on("data", (chunk) => {
      for (const line of chunk.toString().trim().split("\n")) {
        const frame = JSON.parse(line) as Record<string, unknown>;
        this.frames.push(frame);
        if (frame.method === "initialize")
          this.stdout.write(`${JSON.stringify({ id: frame.id, result: { userAgent: "fake" } })}\n`);
      }
    });
  }
  kill(): boolean {
    queueMicrotask(() => this.emit("exit", 0, null));
    return true;
  }
}

describe("CodexBridge", () => {
  it("guards turn admission during account changes and tracks in-flight starts", async () => {
    const child = new HandshakeChild();
    const bridge = new CodexBridge({
      codexBin: "codex",
      checkVersion: async () => "0.154.0",
      spawnProcess: () => child as unknown as JsonlProcess,
    });
    await bridge.start();
    bridge.accountSwitching = true;
    await expect(bridge.request("turn/start", {})).rejects.toBeInstanceOf(
      AccountSwitchInProgressError,
    );
    expect(bridge.pendingTurnStarts).toBe(0);
    bridge.accountSwitching = false;
    bridge.accountLoginRequired = true;
    await expect(bridge.request("turn/start", {})).rejects.toBeInstanceOf(
      AccountLoginRequiredError,
    );
    bridge.accountLoginRequired = false;
    const pending = bridge.request("turn/start", { threadId: "thread" });
    expect(bridge.pendingTurnStarts).toBe(1);
    const frame = child.frames.at(-1)!;
    child.stdout.write(
      `${JSON.stringify({ id: frame.id, result: { turn: { id: "turn", status: "inProgress" } } })}\n`,
    );
    await pending;
    expect(bridge.pendingTurnStarts).toBe(0);
    expect(bridge.activeNativeTurnCount).toBe(1);
    child.stdout.write(
      `${JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn" } } })}\n`,
    );
    expect(bridge.activeNativeTurnCount).toBe(0);
    const fast = bridge.request("turn/start", { threadId: "thread" });
    const fastFrame = child.frames.at(-1)!;
    child.stdout.write(
      `${JSON.stringify({ id: fastFrame.id, result: { turn: { id: "fast", status: "inProgress" } } })}\n${JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "fast" } } })}\n`,
    );
    await fast;
    expect(bridge.activeNativeTurnCount).toBe(0);
    bridge.stop();
  });
  it("initializes before sending initialized", async () => {
    const child = new HandshakeChild();
    const bridge = new CodexBridge({
      codexBin: "codex",
      checkVersion: async () => "0.144.6",
      spawnProcess: () => child as unknown as JsonlProcess,
    });
    await bridge.start();
    expect(bridge.state).toBe("ready");
    expect(child.frames.map((frame) => frame.method)).toEqual(["initialize", "initialized"]);
    const initialize = child.frames[0]?.params as { capabilities: Record<string, boolean> };
    expect(initialize.capabilities).toMatchObject({
      experimentalApi: true,
      requestAttestation: false,
    });
    bridge.stop();
  });

  it("launches an installed CLI without requiring an exact version", async () => {
    const child = new HandshakeChild();
    const spawnProcess = vi.fn(() => child as unknown as JsonlProcess);
    const bridge = new CodexBridge({
      codexBin: "codex",
      checkVersion: async () => "0.145.0",
      spawnProcess,
    });
    await bridge.start();
    expect(bridge.state).toBe("ready");
    expect(bridge.actualVersion).toBe("0.145.0");
    expect(spawnProcess).toHaveBeenCalledOnce();
    bridge.stop();
  });

  it("stays unavailable when the CLI version cannot be read", async () => {
    const spawnProcess = vi.fn();
    const bridge = new CodexBridge({
      codexBin: "codex",
      checkVersion: async () => Promise.reject(new Error("version failed")),
      spawnProcess,
    });
    await bridge.start();
    expect(bridge.state).toBe("unavailable");
    expect(spawnProcess).not.toHaveBeenCalled();
    bridge.stop();
  });

  it("stays unavailable when app-server cannot be launched", async () => {
    const bridge = new CodexBridge({
      codexBin: "codex",
      checkVersion: async () => "0.145.0",
      spawnProcess: () => {
        throw new Error("spawn failed");
      },
    });
    await bridge.start();
    expect(bridge.state).toBe("unavailable");
    expect(bridge.actualVersion).toBe("0.145.0");
    bridge.stop();
  });

  it("retries after initialization fails before the child exits", async () => {
    vi.useFakeTimers();
    const children: HandshakeChild[] = [];
    const bridge = new CodexBridge({
      codexBin: "codex",
      checkVersion: async () => "0.145.0",
      random: () => 0.5,
      spawnProcess: () => {
        const child = new HandshakeChild();
        if (children.length === 0) child.stdin.removeAllListeners("data");
        children.push(child);
        return child as unknown as JsonlProcess;
      },
    });

    const started = bridge.start();
    await vi.advanceTimersByTimeAsync(10_001);
    await started;
    expect(bridge.state).toBe("unavailable");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(children).toHaveLength(2);
    expect(bridge.state).toBe("ready");
    bridge.stop();
  });
});
