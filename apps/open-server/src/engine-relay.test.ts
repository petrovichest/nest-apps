import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Engine } from "./engine";
import { cleanups, setup } from "./test-fixture";
import type { NativeMessage } from "./projection";
import type { RelayPart } from "./event-relay";

async function streaming() {
  const f = await setup();
  f.config.nativeEventSocket = join(f.scratch, "events.sock");
  const part: RelayPart = {
    id: "prt_relay",
    messageID: "msg_assistant",
    parentID: "msg_user",
    sessionID: f.thread.id,
    type: "text",
    text: "prefix",
  };
  const history: NativeMessage[] = [
    {
      info: { id: "msg_user", sessionID: f.thread.id, role: "user" },
      parts: [{ id: "prt_user", type: "text", text: "task" }],
    },
    {
      info: { id: part.messageID, sessionID: f.thread.id, parentID: "msg_user", role: "assistant" },
      parts: [{ ...part }],
    },
  ];
  f.native.messages.set(f.thread.id, history);
  f.engine.onRelayFrame({
    type: "snapshot",
    protocolVersion: 1,
    instanceId: "owner-one",
    revision: 10,
    healthy: true,
    parts: [{ ...part }],
  });
  await f.engine.refreshThread(f.thread.id);
  return { ...f, part, history };
}
function assistant(engine: Engine, id: string) {
  return engine
    .detail(id)
    .turns.flatMap((turn) => turn.items)
    .filter((item) => item.type === "agentMessage")
    .map((item) => item.text)
    .join("");
}
describe("versioned active-text recovery", () => {
  it("continues live deltas after snapshot and ignores overlapping raw native fragments", async () => {
    const { engine, thread, part } = await streaming();
    await engine.onNativeEvent({
      type: "message.part.delta",
      properties: {
        sessionID: thread.id,
        messageID: part.messageID,
        partID: part.id,
        field: "text",
        delta: "prefix",
      },
    });
    engine.onRelayFrame({
      type: "delta",
      instanceId: "owner-one",
      revision: 11,
      sessionID: thread.id,
      messageID: part.messageID,
      partID: part.id,
      offset: 6,
      delta: " + live",
    });
    expect(assistant(engine, thread.id)).toBe("prefix + live");
    await engine.refreshThread(thread.id);
    expect(assistant(engine, thread.id)).toBe("prefix + live");
  });
  it("resumes after API restart from the native owner's current prefix without replaying a prompt", async () => {
    const { engine, thread, part, native, config } = await streaming();
    await engine.close();
    const restored = new Engine(config, { native: native.client() });
    cleanups.push(() => restored.close());
    await restored.initialize({ watch: false });
    restored.onRelayFrame({
      type: "snapshot",
      protocolVersion: 1,
      instanceId: "owner-one",
      revision: 20,
      healthy: true,
      parts: [{ ...part, text: "prefix + offline" }],
    });
    await restored.refreshThread(thread.id);
    restored.onRelayFrame({
      type: "delta",
      instanceId: "owner-one",
      revision: 21,
      sessionID: thread.id,
      messageID: part.messageID,
      partID: part.id,
      offset: "prefix + offline".length,
      delta: " + resumed",
    });
    expect(assistant(restored, thread.id)).toBe("prefix + offline + resumed");
    expect(native.prompts()).toHaveLength(0);
  });
  it("keeps durable final text authoritative over delayed relay and native start events", async () => {
    const { engine, thread, part, history } = await streaming();
    history[1]!.info.time = { created: 1, completed: 2 };
    history[1]!.parts[0]!.text = "corrected final text";
    await engine.refreshThread(thread.id);
    await engine.onNativeEvent({
      type: "message.updated",
      properties: {
        info: {
          id: part.messageID,
          sessionID: thread.id,
          role: "assistant",
          parentID: "msg_user",
          time: { created: 1 },
        },
      },
    });
    engine.onRelayFrame({
      type: "delta",
      instanceId: "owner-one",
      revision: 11,
      sessionID: thread.id,
      messageID: part.messageID,
      partID: part.id,
      offset: 6,
      delta: " old queued delta",
    });
    await engine.onNativeEvent({
      type: "message.part.updated",
      properties: { part: { ...part, text: "" } },
    });
    expect(assistant(engine, thread.id)).toBe("corrected final text");
  });
  it("refuses gaps and unknown native-owner epochs rather than appending ambiguous text", async () => {
    const { engine, thread, part } = await streaming();
    expect(() =>
      engine.onRelayFrame({
        type: "delta",
        instanceId: "owner-two",
        revision: 11,
        sessionID: thread.id,
        messageID: part.messageID,
        partID: part.id,
        offset: 6,
        delta: "wrong",
      }),
    ).toThrow("Native streaming");
    expect(() =>
      engine.onRelayFrame({
        type: "delta",
        instanceId: "owner-one",
        revision: 12,
        sessionID: thread.id,
        messageID: part.messageID,
        partID: part.id,
        offset: 6,
        delta: "gap",
      }),
    ).toThrow("Native streaming");
    expect(assistant(engine, thread.id)).toBe("prefix");
  });
});
