import { describe, expect, it } from "vitest";
import { NativeView, normalizeNativeEvents } from "./native-view.js";

const user = {
  type: "user",
  uuid: "user-1",
  timestamp: "2026-10-05T12:00:00.000Z",
  message: { role: "user", content: "Hello" },
};
const assistant = {
  type: "assistant",
  uuid: "assistant-uuid",
  message: { id: "message-1", model: "sonnet", content: [{ type: "text", text: "Hello back" }] },
};
function stream(event: Record<string, unknown>) {
  return { type: "stream_event", event };
}

describe("native Claude view", () => {
  it("builds stable user-UUID turns and normalized historical messages", () => {
    const view = normalizeNativeEvents([user, assistant], {
      sessionId: "session",
      cwd: "/project",
    });
    expect(view.model).toBe("sonnet");
    expect(view.turns).toHaveLength(1);
    expect(view.turns[0]).toMatchObject({ id: "user-1", status: "completed", itemsLoaded: true });
    expect(view.turns[0]!.items.map((item) => item.id)).toEqual(["user-1", "message-1:0"]);
    expect(view.turns[0]!.items[1]).toMatchObject({
      type: "agentMessage",
      text: "Hello back",
      phase: "final_answer",
    });
  });
  it("streams deltas directly and replaces them with authoritative final blocks without duplicate text", () => {
    const view = new NativeView("session", "/project");
    view.apply(user);
    view.apply(stream({ type: "message_start", message: { id: "message-1", model: "sonnet" } }));
    view.apply(
      stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    );
    expect(
      view.apply(
        stream({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello " },
        }),
      ),
    ).toEqual([
      {
        type: "activity.delta",
        threadId: "session",
        turnId: "user-1",
        itemId: "message-1:0",
        activityType: "agentMessage",
        delta: "Hello ",
      },
    ]);
    view.apply(
      stream({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "back" },
      }),
    );
    view.apply(assistant);
    view.apply({ type: "result", subtype: "success", duration_ms: 500 });
    expect(view.turns()[0]!.items).toHaveLength(2);
    expect(view.turns()[0]!.items[1]).toMatchObject({
      id: "message-1:0",
      text: "Hello back",
      status: "completed",
    });
    expect(view.currentTurnId).toBeNull();
  });
  it("joins tool results by tool_use_id and does not mistake them for another user turn", () => {
    const view = new NativeView("session", "/project");
    view.apply(user);
    view.apply({
      type: "assistant",
      message: {
        id: "tools",
        content: [{ type: "tool_use", id: "bash-1", name: "Bash", input: { command: "pwd" } }],
      },
    });
    expect(
      view.apply({
        type: "user",
        uuid: "tool-result-user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "bash-1",
              content: [{ type: "text", text: "/project" }],
            },
          ],
        },
      }),
    ).toEqual([
      {
        type: "activity.upserted",
        threadId: "session",
        turnId: "user-1",
        item: {
          type: "command",
          id: "bash-1",
          status: "completed",
          kind: "command",
          command: "pwd",
          cwd: "/project",
          output: "/project",
          exitCode: null,
        },
      },
    ]);
    expect(view.turns()).toHaveLength(1);
    expect(view.turns()[0]!.items.filter((item) => item.type === "userMessage")).toHaveLength(1);
  });
  it("deduplicates echoed history and final messages on recovery", () => {
    const view = new NativeView("session", "/project");
    view.reset([user, assistant, user, assistant], { live: true });
    expect(view.turns()).toHaveLength(1);
    expect(view.turns()[0]!.items).toHaveLength(2);
    expect(view.currentTurnId).toBe("user-1");
  });
  it("keeps partial thinking separate and never displays signature deltas", () => {
    const view = new NativeView("session", "/project");
    view.apply(user);
    view.apply(stream({ type: "message_start", message: { id: "thinking" } }));
    view.apply(
      stream({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      }),
    );
    view.apply(
      stream({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Reasoning" },
      }),
    );
    expect(
      view.apply(
        stream({
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "secret-signature" },
        }),
      ),
    ).toEqual([]);
    expect(view.turns()[0]!.items[1]).toMatchObject({ type: "reasoning", text: "Reasoning" });
    expect(JSON.stringify(view.turns())).not.toContain("secret-signature");
  });
  it("reconstructs tool JSON and renders edit patches using only native arguments", () => {
    const view = new NativeView("session", "/project");
    view.apply(user);
    view.apply(stream({ type: "message_start", message: { id: "tools" } }));
    view.apply(
      stream({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "edit-1", name: "Edit", input: {} },
      }),
    );
    view.apply(
      stream({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"file_path":"a.txt",' },
      }),
    );
    view.apply(
      stream({
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: '"old_string":"before","new_string":"after"}',
        },
      }),
    );
    expect(view.turns()[0]!.items.find((item) => item.id === "edit-1")).toMatchObject({
      type: "fileChange",
      path: "a.txt",
      patch: "--- a.txt\n+++ a.txt\n-before\n+after",
    });
  });
  it("extracts file cards and images while hiding transport attachment context", () => {
    const content = [
      {
        type: "text",
        text: 'Inspect\n\n<claudenest_attachments>\nRead these:\n[{"name":"notes.txt","path":"/private/notes.txt"}]\n</claudenest_attachments>',
      },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } },
    ];
    const view = normalizeNativeEvents([{ ...user, message: { content } }, assistant], {
      sessionId: "session",
      cwd: "/project",
    });
    expect(view.turns[0]!.items[0]).toMatchObject({
      text: "Inspect",
      images: ["data:image/png;base64,aGk="],
      files: [{ name: "notes.txt", path: "/private/notes.txt" }],
    });
  });
  it("ignores sidechain activity and finishes error results visibly", () => {
    const view = new NativeView("session", "/project");
    view.apply(user);
    expect(view.apply({ ...assistant, parent_tool_use_id: "child-1" })).toEqual([]);
    view.apply({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["Tool failed"],
    });
    expect(view.turns()[0]).toMatchObject({
      status: "failed",
      items: [
        expect.anything(),
        { type: "error", id: "user-1:error", status: "failed", message: "Tool failed" },
      ],
    });
  });
});
