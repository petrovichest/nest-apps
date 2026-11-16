import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NativeEventRelay, relayEvents, type RelayFrame } from "./event-relay";

const roots: string[] = [],
  relays: NativeEventRelay[] = [],
  feeds: AsyncGenerator<RelayFrame>[] = [];
const token = "isolated-event-relay-fixture-token";
afterEach(async () => {
  await Promise.all(feeds.splice(0).map((feed) => feed.return(undefined)));
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(maxBytes?: number) {
  const root = await mkdtemp(join(tmpdir(), "open-relay-"));
  roots.push(root);
  const socketPath = join(root, "events.sock");
  const relay = await new NativeEventRelay({ socketPath, token, maxBytes }).listen();
  relays.push(relay);
  const feed = () => {
    const value = relayEvents(socketPath, token, new AbortController().signal);
    feeds.push(value);
    return value;
  };
  return { relay, socketPath, feed };
}
const part = {
  id: "prt_text",
  messageID: "msg_assistant",
  sessionID: "ses_fixture",
  type: "text",
  text: "",
};
describe("native-owner active text relay", () => {
  it("atomically resumes active Unicode text with offsets after an API disconnect", async () => {
    const f = await fixture();
    const first = f.feed();
    expect((await first.next()).value).toMatchObject({
      type: "snapshot",
      parts: [],
      healthy: true,
    });
    f.relay.capture({ type: "message.part.updated", properties: { part } });
    expect((await first.next()).value).toMatchObject({
      type: "part",
      revision: 1,
      complete: false,
    });
    f.relay.capture({
      type: "message.part.delta",
      id: "evt_1",
      properties: { partID: part.id, field: "text", delta: "Привет 🙂" },
    });
    expect((await first.next()).value).toMatchObject({
      type: "delta",
      offset: 0,
      delta: "Привет 🙂",
    });
    await first.return(undefined);
    f.relay.capture({
      type: "message.part.delta",
      id: "evt_2",
      properties: { partID: part.id, field: "text", delta: ", offline" },
    });
    const resumed = f.feed();
    const snapshot = (await resumed.next()).value;
    expect(snapshot).toMatchObject({
      type: "snapshot",
      revision: 3,
      parts: [{ text: "Привет 🙂, offline" }],
    });
    f.relay.capture({
      type: "message.part.delta",
      id: "evt_3",
      properties: { partID: part.id, field: "text", delta: " + live" },
    });
    expect((await resumed.next()).value).toMatchObject({
      type: "delta",
      revision: 4,
      offset: "Привет 🙂, offline".length,
      delta: " + live",
    });
    expect((await stat(f.socketPath)).mode & 0o777).toBe(0o600);
  });
  it("keeps reasoning separately and drops completed parts instead of copying transcripts", async () => {
    const f = await fixture();
    f.relay.capture({
      type: "message.part.updated",
      properties: { part: { ...part, type: "reasoning", text: "reasoning" } },
    });
    const active = f.feed();
    expect((await active.next()).value).toMatchObject({
      type: "snapshot",
      parts: [{ type: "reasoning", text: "reasoning" }],
    });
    f.relay.capture({
      type: "message.updated",
      properties: { info: { id: part.messageID, time: { completed: 123 } } },
    });
    expect((await active.next()).value).toMatchObject({
      type: "part",
      complete: true,
      part: { text: "reasoning" },
    });
    const resumed = f.feed();
    expect((await resumed.next()).value).toMatchObject({ type: "snapshot", parts: [] });
  });
  it("rejects unauthorized clients without returning native content", async () => {
    const f = await fixture();
    const rejected = relayEvents(f.socketPath, "incorrect-key", new AbortController().signal);
    await expect(rejected.next()).rejects.toThrow("Native streaming state is unavailable");
  });
  it("fails readiness truthfully if active memory exceeds the configured bound", async () => {
    const f = await fixture(4);
    const active = f.feed();
    await active.next();
    f.relay.capture({
      type: "message.part.updated",
      properties: { part: { ...part, text: "1234" } },
    });
    await active.next();
    f.relay.capture({
      type: "message.part.delta",
      properties: { partID: part.id, field: "text", delta: "5" },
    });
    expect((await active.next()).value).toEqual({ type: "error" });
    const resumed = f.feed();
    expect((await resumed.next()).value).toMatchObject({ type: "snapshot", healthy: false });
  });
  it("refuses a second native owner on an already live socket", async () => {
    const f = await fixture();
    const second = new NativeEventRelay({ socketPath: f.socketPath, token });
    relays.push(second);
    await expect(second.listen()).rejects.toThrow("Native streaming state");
  });
  it("releases metadata for tool-only or interrupted assistants when their session ends", async () => {
    const f = await fixture();
    for (let index = 0; index < 1100; index++) {
      f.relay.capture({
        type: "message.updated",
        properties: {
          info: {
            id: `msg_${index}`,
            role: "assistant",
            parentID: `user_${index}`,
            sessionID: "session_empty",
          },
        },
      });
      f.relay.capture({ type: "session.idle", properties: { sessionID: "session_empty" } });
    }
    expect((await f.feed().next()).value).toMatchObject({
      type: "snapshot",
      healthy: true,
      parts: [],
    });
  });
});
