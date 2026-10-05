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

  it("renders steering inside the active task without finishing its prior output", () => {
    const view = new NativeView("session", "/project");
    view.apply(user);
    view.apply(stream({ type: "message_start", message: { id: "message-1" } }));
    view.apply(
      stream({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "Working" },
      }),
    );
    const steering = {
      ...user,
      uuid: "steer-1",
      claudenest_delivery: "steer",
      message: { content: "Refine the answer" },
    };
    view.apply(steering);
    view.apply(steering);
    expect(view.turns()).toHaveLength(1);
    expect(view.currentTurnId).toBe("user-1");
    expect(view.turns()[0]!.items.map((item) => item.id)).toEqual([
      "user-1",
      "message-1:0",
      "steer-1",
    ]);
    expect(
      view.apply(
        stream({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: " with refinement" },
        }),
      )[0],
    ).toMatchObject({ type: "activity.delta", turnId: "user-1" });
    expect(view.turns()[0]!.items[1]).toMatchObject({
      status: "inProgress",
      text: "Working with refinement",
    });
    view.apply({ type: "result", subtype: "success" });
    expect(view.turns()[0]!.status).toBe("completed");
  });

  it("recovers native steering during a tool call and preserves the following ordinary turn boundary", () => {
    const secondUser = {
      ...user,
      uuid: "steer-1",
      message: { content: "Refine while the command runs" },
    };
    const events = [
      user,
      {
        type: "assistant",
        message: {
          id: "tool-message",
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "bash", name: "Bash", input: { command: "pwd" } }],
        },
      },
      {
        type: "user",
        uuid: "tool-result",
        message: { content: [{ type: "tool_result", tool_use_id: "bash", content: "/project" }] },
      },
      secondUser,
      { ...assistant, message: { ...assistant.message, stop_reason: "end_turn" } },
      { ...user, uuid: "next-user", message: { content: "Next ordinary task" } },
      {
        ...assistant,
        message: {
          id: "next-answer",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Next answer" }],
        },
      },
    ];
    const view = normalizeNativeEvents(events, { sessionId: "session", cwd: "/project" });
    expect(view.turns.map((turn) => turn.id)).toEqual(["user-1", "next-user"]);
    expect(
      view.turns[0]!.items.filter((item) => item.type === "userMessage").map((item) => item.id),
    ).toEqual(["user-1", "steer-1"]);
    expect(view.turns[0]!.items.find((item) => item.id === "bash")).toMatchObject({
      output: "/project",
      status: "completed",
    });
    expect(view.turns[1]!.items.map((item) => item.id)).toEqual(["next-user", "next-answer:0"]);
  });

  it("starts a separate task when steering is echoed after the previous task's native result", () => {
    const view = new NativeView("session", "/project");
    view.apply(user);
    view.apply(assistant);
    view.apply({ type: "result", subtype: "success" });
    view.apply({
      ...user,
      uuid: "late-steer",
      claudenest_delivery: "steer",
      message: { content: "Late refinement" },
    });
    expect(view.turns().map((turn) => [turn.id, turn.status])).toEqual([
      ["user-1", "completed"],
      ["late-steer", "inProgress"],
    ]);
  });

  it("renders user interruption as an interrupted task and suppresses internal CLI diagnostics", () => {
    const view = new NativeView("session", "/project");
    view.apply(user);
    view.apply({
      type: "assistant",
      message: {
        id: "tools",
        content: [{ type: "tool_use", id: "bash", name: "Bash", input: { command: "pwd" } }],
      },
    });
    view.apply({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "bash",
            is_error: true,
            content: "[Request interrupted by user]",
          },
        ],
      },
    });
    view.apply({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["[ede_diagnostic] Request interrupted by user"],
    });
    expect(view.turns()[0]).toMatchObject({ status: "interrupted" });
    expect(view.turns()[0]!.items.some((item) => item.type === "error")).toBe(false);
    expect(JSON.stringify(view.turns())).not.toContain("ede_diagnostic");
    expect(JSON.stringify(view.turns())).not.toContain("Request interrupted by user");
    expect(view.turns()[0]!.items.find((item) => item.id === "bash")).toMatchObject({
      output: "",
      status: "completed",
    });
  });

  it("uses the explicit interrupt marker even when the native diagnostic has no interruption text", () => {
    const view = new NativeView("session", "/project");
    view.apply(user);
    view.apply(assistant);
    view.apply({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      claudenest_interrupted: true,
      errors: ["[ede_diagnostic] Internal abort state"],
    });
    expect(view.turns()[0]!.status).toBe("interrupted");
    expect(view.turns()[0]!.items.some((item) => item.type === "error")).toBe(false);
  });

  it.each(["aborted_streaming", "aborted_tools"])(
    "recognizes native %s terminal reasons whose diagnostic does not mention interruption",
    (terminal_reason) => {
      const view = new NativeView("session", "/project");
      view.apply(user);
      view.apply(assistant);
      view.apply({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason,
        errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"],
      });
      expect(view.turns()[0]!.status).toBe("interrupted");
      expect(view.turns()[0]!.items.some((item) => item.type === "error")).toBe(false);
      expect(JSON.stringify(view.turns())).not.toContain("ede_diagnostic");
    },
  );

  it("keeps genuine execution errors failed while hiding their internal diagnostic line", () => {
    const view = new NativeView("session", "/project");
    view.apply(user);
    view.apply({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: [
        "[ede_diagnostic] result_type=assistant stop_reason=error",
        "The selected model is unavailable",
      ],
    });
    expect(view.turns()[0]!.status).toBe("failed");
    expect(view.turns()[0]!.items.at(-1)).toMatchObject({
      type: "error",
      message: "The selected model is unavailable",
    });
    expect(JSON.stringify(view.turns())).not.toContain("ede_diagnostic");
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
