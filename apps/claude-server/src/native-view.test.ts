import { describe, expect, it } from "vitest";
import { NativeView, normalizeNativeEvents } from "./native-view.js";
import { subagentThreadId } from "./types.js";

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
const taskPrompt =
  '<task-notification>\n<task-id>background-1</task-id>\n<summary>Background command "Wait for CI run to finish" completed (exit code 0)</summary>\n</task-notification>';
const taskNotification = {
  type: "attachment",
  uuid: "task-attachment",
  timestamp: "2026-10-05T12:01:00.000Z",
  renderedRole: "system",
  attachment: {
    type: "queued_command",
    source_uuid: "task-input",
    commandMode: "task-notification",
    origin: { kind: "task-notification", producer: "session-task" },
    prompt: taskPrompt,
  },
};
const taskEcho = {
  type: "user",
  uuid: "task-input",
  isReplay: true,
  origin: taskNotification.attachment.origin,
  message: { role: "user", content: taskPrompt },
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
  it("projects ExitPlanMode as a completed plan from its plan file even after ClaudeNest declines it", () => {
    const planTool = (id: string, file: string, content: string) => [
      {
        type: "assistant",
        uuid: `${id}-write`,
        message: {
          id: `${id}-write-message`,
          content: [
            {
              type: "tool_use",
              id: `${id}-write`,
              name: "Write",
              input: { file_path: file, content },
            },
          ],
          stop_reason: "tool_use",
        },
      },
      {
        type: "assistant",
        uuid: `${id}-uuid`,
        message: {
          id: `${id}-message`,
          content: [{ type: "tool_use", id, name: "ExitPlanMode", input: {} }],
          stop_reason: "tool_use",
        },
      },
      {
        type: "user",
        uuid: `${id}-result`,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: "Declined" }],
        },
      },
    ];
    const view = normalizeNativeEvents(
      [
        user,
        ...planTool("plan-tool", "/home/user/.claude/plans/first.md", "1. Do it"),
        { type: "result", subtype: "success" },
      ],
      { sessionId: "session", cwd: "/project" },
    );
    expect(view.turns[0]).toMatchObject({ status: "completed" });
    expect(view.turns[0]!.items.at(-1)).toEqual({
      type: "plan",
      id: "plan-tool",
      status: "completed",
      text: "1. Do it",
      images: [],
      timestamp: null,
      phase: null,
    });
  });
  it("fills a live ExitPlanMode plan from its permission request and keeps it across replay", () => {
    const view = new NativeView("session", "/project");
    const exit = {
      type: "assistant",
      uuid: "plan-uuid",
      message: {
        id: "message-plan",
        content: [{ type: "tool_use", id: "plan-tool", name: "ExitPlanMode", input: {} }],
        stop_reason: "tool_use",
      },
    };
    view.apply(user);
    view.apply(exit);
    const legacy = view.presentPlan(undefined, "1. Do it");
    expect(legacy?.toolUseId).toBe("plan-tool");
    expect(legacy?.events).toEqual([
      expect.objectContaining({
        type: "activity.upserted",
        item: expect.objectContaining({ type: "plan", text: "1. Do it" }),
      }),
    ]);
    view.reset([user, exit]);
    expect(view.turns()[0]!.items.at(-1)).toMatchObject({ type: "plan", text: "1. Do it" });
    const restored = new NativeView("session", "/project");
    restored.rememberPlanText("plan-tool", "1. Do it");
    restored.reset([user, exit]);
    expect(restored.turns()[0]!.items.at(-1)).toMatchObject({ type: "plan", text: "1. Do it" });
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

  it("recovers the 01:45 steering before the 01:47 replies without synthetic user turns", () => {
    const view = new NativeView("session", "/project");
    const first = { ...user, timestamp: "2026-10-05T22:43:06.493Z" };
    const queued = {
      type: "attachment",
      uuid: "attachment-1",
      timestamp: "2026-10-05T22:45:36.334Z",
      attachment: {
        type: "queued_command",
        source_uuid: "steer-1",
        timestamp: "2026-10-05T22:45:36.334Z",
        prompt: "Show the variants",
      },
    };
    const comment = {
      ...assistant,
      apiBlockIndex: 1,
      timestamp: "2026-10-05T22:47:11.144Z",
      message: {
        id: "comment",
        stop_reason: "tool_use",
        content: [{ type: "text", text: "Checking the screenshots" }],
      },
    };
    const companion = {
      ...user,
      uuid: "image-companion",
      isMeta: true,
      turnCompanion: true,
      message: { content: "[Image: original 2880x1800]" },
    };
    const final = {
      ...assistant,
      timestamp: "2026-10-05T22:47:28.511Z",
      message: {
        id: "final",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Here are the variants" }],
      },
    };
    const history = [first, queued, comment, companion, final];
    view.reset(history);
    const expected = view.turns();
    expect(expected).toHaveLength(1);
    expect(expected[0]!.items.map((item) => item.id)).toEqual([
      "user-1",
      "steer-1",
      "comment:1",
      "final:0",
    ]);
    expect(expected[0]!.items.map((item) => "timestamp" in item && item.timestamp)).toEqual([
      Date.parse(first.timestamp),
      Date.parse(queued.timestamp),
      Date.parse(comment.timestamp),
      Date.parse(final.timestamp),
    ]);
    view.reset([...history, first, queued, comment, final]);
    expect(view.turns()).toEqual(expected);
  });

  it("keeps historical block IDs, completed text and time when live blocks are replayed", () => {
    const view = new NativeView("session", "/project");
    const history = [
      { ...user, timestamp: 10 },
      {
        ...assistant,
        apiBlockIndex: 0,
        timestamp: 100,
        message: {
          id: "message-1",
          content: [{ type: "thinking", thinking: "Thought" }],
        },
      },
      {
        ...assistant,
        apiBlockIndex: 1,
        timestamp: 200,
        message: {
          id: "message-1",
          content: [{ type: "text", text: "Complete answer" }],
        },
      },
    ];
    view.reset(history, { live: true });
    view.apply(stream({ type: "message_start", message: { id: "message-1" } }));
    for (const [index, content_block] of [
      [0, { type: "thinking", thinking: "" }],
      [1, { type: "text", text: "" }],
    ] as const) {
      expect(view.apply(stream({ type: "content_block_start", index, content_block }))).toEqual([]);
      expect(
        view.apply(
          stream({
            type: "content_block_delta",
            index,
            delta: {
              type: index === 0 ? "thinking_delta" : "text_delta",
              text: "Partial",
              thinking: "Partial",
            },
          }),
        ),
      ).toEqual([]);
      expect(view.apply(stream({ type: "content_block_stop", index }))).toEqual([]);
    }
    view.apply({
      ...assistant,
      message: {
        ...assistant.message,
        content: [
          { type: "thinking", thinking: "Thought" },
          { type: "text", text: "Complete answer" },
        ],
      },
    });
    expect(view.turns()[0]!.items).toMatchObject([
      { id: "user-1" },
      {
        id: "message-1:0",
        type: "reasoning",
        text: "Thought",
        timestamp: 100,
        status: "completed",
      },
      {
        id: "message-1:1",
        type: "agentMessage",
        text: "Complete answer",
        timestamp: 200,
        status: "completed",
      },
    ]);
  });

  it("uses block completion time and keeps a repeated assistant attached to its original turn", () => {
    const view = new NativeView("session", "/project");
    view.apply({ ...user, timestamp: 10 });
    view.apply(stream({ type: "message_start", message: { id: "message-1" } }));
    view.apply({
      ...stream({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "text",
          text: "Hello back",
        },
      }),
      timestamp: 20,
    });
    view.apply({ ...stream({ type: "content_block_stop", index: 0 }), timestamp: 30 });
    view.apply(assistant);
    view.apply({ type: "result", timestamp: 40 });
    view.apply({ ...user, uuid: "next-user", timestamp: 50 });
    view.apply(assistant);
    expect(view.turns()[0]!.items[1]).toMatchObject({ timestamp: 30, phase: "final_answer" });
    expect(view.turns()[1]!.items.map((item) => item.id)).toEqual(["next-user"]);
    expect(view.currentTurnId).toBe("next-user");
  });

  it("records accepted steering by send time and deduplicates a later native echo", () => {
    const view = new NativeView("session", "/project");
    view.apply({ ...user, timestamp: 10 });
    view.apply({ ...assistant, timestamp: 30 });
    view.recordUserMessage({
      id: "steer-1",
      threadId: "session",
      text: "Refine",
      createdAt: 20,
      status: "dispatching",
      deliveryMode: "steer",
    });
    view.apply({ ...user, uuid: "steer-1", timestamp: 40, message: { content: "Refine" } });
    expect(view.turns()).toHaveLength(1);
    expect(view.turns()[0]!.items.map((item) => item.id)).toEqual([
      "user-1",
      "steer-1",
      "message-1:0",
    ]);
    expect(view.turns()[0]!.items[1]).toMatchObject({ timestamp: 20 });
  });

  it("retains accepted input through an empty snapshot before the native echo", () => {
    const view = new NativeView("session", "/project");
    view.recordUserMessage({
      id: "initial",
      threadId: "session",
      text: "Inspect",
      createdAt: 10,
      status: "dispatching",
      deliveryMode: "queue",
      images: ["data:image/png;base64,aW1hZ2U="],
      files: [{ name: "note.txt", path: "/project/note.txt" }],
    });
    const expected = view.turns()[0]!.items[0];
    view.reset([], { live: true, preserveInputs: true });
    view.apply(stream({ type: "message_start", message: { id: "reply" } }));
    view.apply({ ...assistant, timestamp: 20, message: { ...assistant.message, id: "reply" } });
    view.apply({ ...user, uuid: "initial", timestamp: 30, message: { content: "Inspect" } });
    expect(view.turns()).toHaveLength(1);
    expect(view.turns()[0]!.id).toBe("initial");
    expect(view.turns()[0]!.items[0]).toEqual(expected);
    expect(view.turns()[0]!.items[1]).toMatchObject({ id: "reply:0" });
  });

  it("retains the initial input ahead of an assistant-only recovery snapshot", () => {
    const view = new NativeView("session", "/project");
    view.recordUserMessage({
      id: "initial",
      threadId: "session",
      text: "Inspect",
      createdAt: 10,
      status: "dispatching",
      deliveryMode: "queue",
    });
    view.reset(
      [
        stream({ type: "message_start", message: { id: "reply" } }),
        { ...assistant, timestamp: 20, message: { ...assistant.message, id: "reply" } },
        { type: "result", timestamp: 30 },
      ],
      { preserveInputs: true },
    );
    expect(view.turns()).toHaveLength(1);
    expect(view.turns()[0]).toMatchObject({ id: "initial", status: "completed", completedAt: 30 });
    expect(view.turns()[0]!.items.map((item) => item.id)).toEqual(["initial", "reply:0"]);
  });

  it("preserves missing steering between its known responses across snapshot replay", () => {
    const view = new NativeView("session", "/project");
    const first = { ...user, timestamp: 10 };
    const comment = { ...assistant, timestamp: 20 };
    const final = { ...assistant, timestamp: 40, message: { ...assistant.message, id: "final" } };
    view.apply(first);
    view.apply(comment);
    view.recordUserMessage({
      id: "steer",
      threadId: "session",
      text: "Refine",
      createdAt: 30,
      status: "dispatching",
      deliveryMode: "steer",
    });
    view.apply(final);
    const snapshot = [first, comment, final, first, comment, final];
    for (let attempt = 0; attempt < 2; attempt++) {
      view.reset(snapshot, { live: true, preserveInputs: true });
      expect(view.turns()).toHaveLength(1);
      expect(view.turns()[0]!.items.map((item) => item.id)).toEqual([
        "user-1",
        "message-1:0",
        "steer",
        "final:0",
      ]);
      expect(view.turns()[0]!.items[2]).toMatchObject({ timestamp: 30 });
    }
  });

  it("preserves an ordinary input after the previous result and before a new response", () => {
    const view = new NativeView("session", "/project");
    const history = [
      { ...user, timestamp: 10 },
      { ...assistant, timestamp: 20 },
      { type: "result", timestamp: 30 },
    ];
    view.reset(history);
    view.recordUserMessage({
      id: "next",
      threadId: "session",
      text: "Next",
      createdAt: 40,
      status: "dispatching",
      deliveryMode: "queue",
    });
    view.reset(
      [
        ...history,
        stream({ type: "message_start", message: { id: "next-reply" } }),
        { ...assistant, timestamp: 50, message: { ...assistant.message, id: "next-reply" } },
        { type: "result", timestamp: 60 },
      ],
      { preserveInputs: true },
    );
    expect(view.turns().map((turn) => turn.items.map((item) => item.id))).toEqual([
      ["user-1", "message-1:0"],
      ["next", "next-reply:0"],
    ]);
    expect(view.turns().map((turn) => turn.completedAt)).toEqual([30, 60]);
  });

  it("retains steering before its original result even when there is no later response", () => {
    const view = new NativeView("session", "/project");
    const history = [
      { ...user, timestamp: 10 },
      { ...assistant, timestamp: 20 },
    ];
    view.reset(history, { live: true });
    view.recordUserMessage({
      id: "steer",
      threadId: "session",
      text: "Refine",
      createdAt: 30,
      status: "dispatching",
      deliveryMode: "steer",
    });
    view.apply({ type: "result", timestamp: 40 });
    view.reset([...history, { type: "result", timestamp: 40 }], { preserveInputs: true });
    expect(view.turns()).toHaveLength(1);
    expect(view.turns()[0]).toMatchObject({ id: "user-1", completedAt: 40 });
    expect(view.turns()[0]!.items.map((item) => item.id)).toEqual([
      "user-1",
      "message-1:0",
      "steer",
    ]);
  });

  it("moves a late native echo back to its send position when its receipt is acknowledged", () => {
    const view = new NativeView("session", "/project");
    view.apply({ ...user, timestamp: 10 });
    view.apply({ ...assistant, timestamp: 30 });
    view.apply({
      ...user,
      uuid: "steer-1",
      timestamp: 40,
      claudenest_delivery: "steer",
      message: { content: "Refine" },
    });
    view.recordUserMessage({
      id: "steer-1",
      threadId: "session",
      text: "Refine",
      createdAt: 20,
      status: "dispatching",
      deliveryMode: "steer",
    });
    expect(view.turns()[0]!.items.map((item) => item.id)).toEqual([
      "user-1",
      "steer-1",
      "message-1:0",
    ]);
    expect(view.turns()[0]!.items[1]).toMatchObject({ timestamp: 20 });
  });

  it("maps compact CLI blocks to their active streamed indices before the block stops", () => {
    const view = new NativeView("session", "/project");
    view.apply({ ...user, timestamp: 10 });
    view.apply(stream({ type: "message_start", message: { id: "compact" } }));
    const blocks = [
      { type: "thinking", thinking: "Thought" },
      { type: "text", text: "Answer" },
      { type: "tool_use", id: "read-tool", name: "Read", input: { file_path: "/project/a.txt" } },
    ];
    blocks.forEach((block, index) => {
      view.apply(stream({ type: "content_block_start", index, content_block: block }));
      view.apply({
        type: "assistant",
        uuid: `compact-${index}`,
        timestamp: 20 + index,
        message: { id: "compact", stop_reason: null, content: [block] },
      });
      view.apply(stream({ type: "content_block_stop", index }));
    });
    expect(view.turns()[0]!.items.map((item) => item.id)).toEqual([
      "user-1",
      "compact:0",
      "compact:1",
      "read-tool",
    ]);
    expect(view.turns()[0]!.items[1]).toMatchObject({ type: "reasoning", text: "Thought" });
    expect(view.turns()[0]!.items[2]).toMatchObject({
      type: "agentMessage",
      text: "Answer",
      timestamp: 21,
      status: "completed",
    });
  });

  it("keeps separate compact text blocks and applies full final arrays from index zero", () => {
    const view = new NativeView("session", "/project");
    view.apply(user);
    view.apply(stream({ type: "message_start", message: { id: "multi" } }));
    for (const [index, text] of ["First", "Second"].entries()) {
      view.apply(
        stream({ type: "content_block_start", index, content_block: { type: "text", text } }),
      );
      view.apply({
        type: "assistant",
        uuid: `multi-${index}`,
        message: { id: "multi", stop_reason: null, content: [{ type: "text", text }] },
      });
      view.apply(stream({ type: "content_block_stop", index }));
    }
    view.apply({
      type: "assistant",
      uuid: "full-multi",
      message: {
        id: "multi",
        stop_reason: "end_turn",
        content: [
          { type: "text", text: "First" },
          { type: "text", text: "Second" },
        ],
      },
    });
    expect(view.turns()[0]!.items.map((item) => item.id)).toEqual(["user-1", "multi:0", "multi:1"]);
    expect(
      view
        .turns()[0]!
        .items.slice(1)
        .map((item) => "text" in item && item.text),
    ).toEqual(["First", "Second"]);
    view.apply(
      stream({
        type: "content_block_start",
        index: 2,
        content_block: { type: "text", text: "Pending" },
      }),
    );
    const update = view.apply({
      type: "assistant",
      uuid: "full-single",
      message: {
        id: "multi",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Full single" }],
      },
    });
    expect(update[0]).toMatchObject({ item: { id: "multi:0", text: "Full single" } });
  });

  it("uses canonical UUID metadata when SDK replay strips block indices and companion flags", () => {
    const view = new NativeView("session", "/project");
    const thought = {
      type: "assistant",
      uuid: "thought-source",
      apiBlockIndex: 0,
      timestamp: 20,
      message: {
        id: "canonical",
        stop_reason: "end_turn",
        content: [{ type: "thinking", thinking: "" }],
      },
    };
    const answer = {
      type: "assistant",
      uuid: "answer-source",
      apiBlockIndex: 1,
      timestamp: 30,
      message: {
        id: "canonical",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Answer" }],
      },
    };
    const companion = {
      type: "user",
      uuid: "note-source",
      isMeta: true,
      turnCompanion: true,
      message: { content: "Transport note" },
    };
    const history = [{ ...user, timestamp: 10 }, thought, answer, companion];
    const replay = [
      user,
      stream({ type: "message_start", message: { id: "canonical" } }),
      stream({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      }),
      { ...thought, apiBlockIndex: undefined, message: { ...thought.message, stop_reason: null } },
      stream({ type: "content_block_stop", index: 0 }),
      stream({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
      { ...answer, apiBlockIndex: undefined, message: { ...answer.message, stop_reason: null } },
      stream({ type: "content_block_stop", index: 1 }),
      {
        ...companion,
        isMeta: undefined,
        turnCompanion: undefined,
        message: { content: [{ type: "text", text: "Transport note" }] },
      },
      { type: "result", timestamp: 40 },
    ];
    for (const preserveInputs of [false, true]) {
      view.reset([...history, ...replay], { preserveInputs });
      expect(view.turns()).toHaveLength(1);
      expect(view.turns()[0]!.items).toMatchObject([
        { id: "user-1" },
        { id: "canonical:0", type: "reasoning" },
        {
          id: "canonical:1",
          type: "agentMessage",
          text: "Answer",
          timestamp: 30,
          phase: "final_answer",
        },
      ]);
      expect(view.turns()[0]!.items).toHaveLength(3);
    }
  });

  it("drops a formerly rendered companion input when canonical metadata becomes available", () => {
    const view = new NativeView("session", "/project");
    const companion = { ...user, uuid: "companion-source", message: { content: "Transport note" } };
    view.apply(user);
    view.apply(assistant);
    view.apply(companion);
    expect(view.turns()).toHaveLength(2);
    view.reset(
      [
        user,
        assistant,
        { ...companion, isMeta: true, turnCompanion: true },
        { ...companion, message: { content: [{ type: "text", text: "Transport note" }] } },
      ],
      { preserveInputs: true },
    );
    expect(view.turns()).toHaveLength(1);
    expect(view.turns()[0]!.items.map((item) => item.id)).toEqual(["user-1", "message-1:0"]);
  });

  it.each([
    {
      ...taskNotification,
      attachment: { ...taskNotification.attachment, origin: undefined },
    },
    {
      ...taskNotification,
      attachment: { ...taskNotification.attachment, commandMode: undefined },
    },
    taskEcho,
  ])(
    "keeps background task notifications out of user input without changing the active turn ($type)",
    (event) => {
      const view = new NativeView("session", "/project");
      view.apply(user);
      view.apply(assistant);
      const before = view.turns();
      expect(view.apply(event)).toEqual([]);
      expect(view.turns()).toEqual(before);
      expect(view.currentTurnId).toBe("user-1");
      view.apply({ ...assistant, message: { id: "after-task", content: "Continuing" } });
      expect(view.turns()).toHaveLength(1);
      expect(view.turns()[0]!.items.at(-1)).toMatchObject({
        id: "after-task:0",
        type: "agentMessage",
        text: "Continuing",
      });
    },
  );

  it.each([false, true])(
    "uses canonical notification source UUIDs for origin-stripped replay (preserveInputs=%s)",
    (preserveInputs) => {
      const view = new NativeView("session", "/project");
      view.apply(user);
      view.apply(assistant);
      view.reset(
        [user, assistant, { ...taskEcho, origin: undefined }, taskNotification, taskEcho],
        { live: true, preserveInputs },
      );
      expect(view.turns()).toHaveLength(1);
      expect(view.currentTurnId).toBe("user-1");
      expect(view.turns()[0]!.items.map((item) => item.id)).toEqual(["user-1", "message-1:0"]);
    },
  );

  it("removes a formerly rendered notification while retaining genuine steering on recovery", () => {
    const view = new NativeView("session", "/project");
    view.apply(user);
    view.apply(assistant);
    view.apply({
      ...user,
      uuid: "steer-1",
      claudenest_delivery: "steer",
      message: { content: "Keep investigating" },
    });
    view.apply({ ...taskEcho, origin: undefined });
    expect(view.turns()).toHaveLength(2);
    view.reset([user, assistant, taskNotification, { ...taskEcho, origin: undefined }], {
      live: true,
      preserveInputs: true,
    });
    expect(view.turns()).toHaveLength(1);
    expect(view.turns()[0]!.items.filter((item) => item.type === "userMessage")).toMatchObject([
      { id: "user-1", text: "Hello" },
      { id: "steer-1", text: "Keep investigating" },
    ]);
    expect(view.currentTurnId).toBe("user-1");
  });

  it("shows genuine queued prompts and user input containing task notification XML", () => {
    const queued = {
      ...taskNotification,
      attachment: {
        ...taskNotification.attachment,
        source_uuid: "steer-1",
        commandMode: "prompt",
        origin: undefined,
      },
    };
    const view = normalizeNativeEvents(
      [user, queued, { ...taskEcho, uuid: "human-xml", origin: undefined }],
      { sessionId: "session", cwd: "/project" },
    );
    expect(
      view.turns.flatMap((turn) => turn.items).filter((item) => item.type === "userMessage"),
    ).toMatchObject([
      { id: "user-1", text: "Hello" },
      { id: "steer-1", text: taskPrompt },
      { id: "human-xml", text: taskPrompt },
    ]);
  });

  it("processes tool results from a notification without creating user input", () => {
    const view = new NativeView("session", "/project");
    view.apply(user);
    view.apply({
      type: "assistant",
      message: {
        id: "command-message",
        content: [{ type: "tool_use", id: "command-1", name: "Bash", input: { command: "pwd" } }],
      },
    });
    const updates = view.apply({
      ...taskEcho,
      message: {
        content: [
          { type: "tool_result", tool_use_id: "command-1", content: "/project" },
          { type: "text", text: taskPrompt },
        ],
      },
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      type: "activity.upserted",
      item: { id: "command-1", type: "command", status: "completed", output: "/project" },
    });
    expect(view.turns()).toHaveLength(1);
    expect(view.turns()[0]!.items.filter((item) => item.type === "userMessage")).toHaveLength(1);
  });

  it("suppresses only the standalone SDK coordinate note after a completed image Read", () => {
    const note =
      "[Image: original 2880x1800, displayed at 2000x1250. Multiply coordinates by 1.44 to map to original image.]";
    const image = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" },
    };
    const sdk = {
      type: "user",
      uuid: "note",
      message: { content: [{ type: "text", text: note }] },
    };
    const ready = () => {
      const view = new NativeView("session", "/project");
      view.apply(user);
      view.apply({
        type: "assistant",
        message: {
          id: "read",
          content: [
            {
              type: "tool_use",
              id: "read-image",
              name: "Read",
              input: { file_path: "/project/shot.png" },
            },
          ],
        },
      });
      view.apply({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "read-image", content: [image] }],
        },
      });
      return view;
    };
    const view = ready();
    view.apply(sdk);
    expect(view.turns()[0]!.items.filter((item) => item.type === "userMessage")).toHaveLength(1);
    for (const event of [
      { ...sdk, message: { content: note } },
      { ...sdk, claudenest_delivery: "steer" },
      {
        ...sdk,
        message: {
          content: [
            { type: "text", text: note },
            { type: "text", text: "User explanation" },
          ],
        },
      },
      { ...sdk, message: { content: [{ type: "text", text: note }, image] } },
    ]) {
      const actual = ready();
      actual.apply(event);
      expect(actual.turns()[0]!.items.filter((item) => item.type === "userMessage")).toHaveLength(
        2,
      );
    }
    const known = ready();
    known.recordUserMessage({
      id: "note",
      threadId: "session",
      text: note,
      createdAt: Date.now(),
      status: "dispatching",
      deliveryMode: "steer",
    });
    known.apply(sdk);
    expect(known.turns()[0]!.items.filter((item) => item.type === "userMessage")).toHaveLength(2);
    const unread = new NativeView("session", "/project");
    unread.apply(user);
    unread.apply(sdk);
    expect(
      unread
        .turns()
        .flatMap((turn) => turn.items)
        .filter((item) => item.type === "userMessage"),
    ).toHaveLength(2);
  });

  it("keeps Read images in tool details and ignores flagged companions without dropping real uploads", () => {
    const view = new NativeView("session", "/project");
    const image = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" },
    };
    const read = {
      type: "assistant",
      message: {
        id: "read",
        content: [
          {
            type: "tool_use",
            id: "read-image",
            name: "Read",
            input: { file_path: "/tmp/shot.png" },
          },
        ],
      },
    };
    const result = {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "read-image", content: [image] }] },
    };
    const events = [
      { ...user, message: { content: [{ type: "text", text: "Inspect" }, image] } },
      read,
      result,
      {
        ...user,
        uuid: "companion",
        isMeta: true,
        turnCompanion: true,
        message: { content: "[Image: original 2880x1800]" },
      },
      assistant,
    ];
    for (const replay of [false, true]) {
      if (replay) view.reset(events);
      else for (const event of events) view.apply(event);
      expect(view.turns()).toHaveLength(1);
      expect(view.turns()[0]!.items.filter((item) => item.type === "userMessage")).toMatchObject([
        { id: "user-1", images: ["data:image/png;base64,aW1hZ2U="] },
      ]);
      expect(view.turns()[0]!.items.find((item) => item.id === "read-image")).toMatchObject({
        type: "tool",
        status: "completed",
        images: ["/tmp/shot.png"],
      });
      expect(view.hasToolImagePath("/tmp/shot.png")).toBe(true);
    }
    view.apply(read);
    expect(view.hasToolImagePath("/tmp/shot.png")).toBe(true);
    expect(JSON.stringify(view.turns())).not.toContain("[Image: original");
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

  it("renders native task tools as one checklist that moves to the latest update", () => {
    const tool = (id: string, name: string, input: Record<string, unknown>) => ({
      type: "assistant",
      timestamp: "2026-10-05T12:00:01.000Z",
      message: { id: `m-${id}`, content: [{ type: "tool_use", id, name, input }] },
    });
    const result = (id: string, content: string, native: Record<string, unknown>) => ({
      type: "user",
      timestamp: "2026-10-05T12:00:02.000Z",
      tool_use_result: native,
      message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
    });
    const view = new NativeView("session", "/project");
    view.apply(user);
    view.apply(tool("t1", "TaskCreate", { subject: "Say hi", description: "Greet" }));
    view.apply(result("t1", "Task #1 created successfully: Say hi", { task: { id: "1" } }));
    view.apply(tool("t2", "TaskCreate", { subject: "Count" }));
    // Older CLIs report the created ID only in the tool result text.
    view.apply(result("t2", "Task #2 created successfully: Count", {}));
    view.apply({ ...assistant, timestamp: "2026-10-05T12:00:03.000Z" });
    view.apply(tool("t3", "TaskUpdate", { taskId: "1", status: "in_progress" }));
    const events = view.apply(result("t3", "Updated task #1 status", { success: true }));
    expect(events).toEqual([expect.objectContaining({ type: "turn.replaced" })]);
    const items = view.turns()[0]!.items;
    expect(items.map((item) => item.type)).toEqual([
      "userMessage",
      "agentMessage",
      "planChecklist",
    ]);
    expect(items[2]).toMatchObject({
      id: "user-1:tasks",
      status: "inProgress",
      afterItemId: "message-1:0",
      steps: [
        { step: "Say hi", status: "inProgress" },
        { step: "Count", status: "pending" },
      ],
    });
    view.apply({ type: "result", subtype: "success" });
    expect(view.turns()[0]!.items[2]).toMatchObject({ type: "planChecklist", status: "completed" });

    const legacy = new NativeView("session", "/project");
    legacy.apply(user);
    legacy.apply(
      tool("todo", "TodoWrite", {
        todos: [
          { content: "Read", status: "completed", activeForm: "Reading" },
          { content: "Write", status: "in_progress", activeForm: "Writing" },
        ],
      }),
    );
    legacy.apply(result("todo", "Todos have been modified", {}));
    expect(legacy.turns()[0]!.items.at(-1)).toMatchObject({
      type: "planChecklist",
      steps: [
        { step: "Read", status: "completed" },
        { step: "Write", status: "inProgress" },
      ],
    });
  });

  it("shows answered questions instead of the AskUserQuestion tool call", () => {
    const questions = [
      {
        question: "Which color?",
        header: "Color",
        options: [{ label: "Red" }],
        multiSelect: false,
      },
      { question: "Which size?", header: "Size", options: [{ label: "M" }], multiSelect: false },
    ];
    const view = new NativeView("session", "/project");
    view.apply(user);
    view.apply({
      type: "assistant",
      message: {
        id: "ask",
        content: [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions } }],
      },
    });
    expect(view.turns()[0]!.items.map((item) => item.type)).toEqual(["userMessage"]);
    view.apply({
      type: "user",
      timestamp: "2026-10-05T12:00:05.000Z",
      // Native transcripts spell the structured result in camel case.
      toolUseResult: { questions, answers: { "Which color?": "Red", "Which size?": "M" } },
      message: {
        content: [
          { type: "tool_result", tool_use_id: "q1", content: "Your questions have been answered" },
        ],
      },
    });
    expect(view.turns()[0]!.items[1]).toEqual({
      type: "userInputResponse",
      id: "q1:response",
      status: "completed",
      entries: [
        { header: "Color", question: "Which color?", answers: ["Red"] },
        { header: "Size", question: "Which size?", answers: ["M"] },
      ],
      timestamp: Date.parse("2026-10-05T12:00:05.000Z"),
      afterItemId: "user-1",
    });
  });

  it("links native subagent launches to their own read-only transcript view", () => {
    const launch = {
      type: "assistant",
      timestamp: "2026-10-05T12:00:01.000Z",
      message: {
        id: "launch",
        content: [
          {
            type: "tool_use",
            id: "agent-tool",
            name: "Agent",
            input: { description: "Inspect repo", subagent_type: "Explore", prompt: "Look" },
          },
        ],
      },
    };
    const child = {
      type: "assistant",
      parent_tool_use_id: "agent-tool",
      message: { id: "child-message", content: [{ type: "text", text: "Found it" }] },
    };
    const parent = new NativeView("session", "/project");
    parent.apply(user);
    parent.apply(launch);
    expect(parent.apply(child)).toEqual([]);
    const threadId = subagentThreadId("session", "agent-tool");
    expect(parent.turns()[0]!.items[1]).toMatchObject({
      type: "subagentLaunch",
      status: "inProgress",
      title: "Inspect repo",
      threadId,
      source: "claude",
    });
    expect(parent.subagents()).toEqual([
      {
        toolUseId: "agent-tool",
        threadId,
        title: "Inspect repo",
        agentType: "Explore",
        status: "running",
        startedAt: Date.parse("2026-10-05T12:00:01.000Z"),
      },
    ]);
    // Background agents report their lifecycle through native system task events.
    parent.apply({
      type: "system",
      subtype: "task_started",
      task_id: "a1",
      tool_use_id: "agent-tool",
    });
    parent.apply({
      type: "system",
      subtype: "task_updated",
      task_id: "a1",
      patch: { status: "killed" },
    });
    expect(parent.subagents()[0]!.status).toBe("interrupted");

    const view = new NativeView(threadId, "/project", "agent-tool");
    view.reset(
      [{ type: "user", uuid: "prompt", isSidechain: true, message: { content: "Look" } }],
      {
        live: true,
      },
    );
    view.apply(child);
    expect(view.apply({ ...child, parent_tool_use_id: "nested-tool" })).toEqual([]);
    expect(view.turns()[0]!.items.map((item) => item.id)).toEqual(["prompt", "child-message:0"]);
    expect(view.settle("completed")).toEqual([
      expect.objectContaining({
        type: "turn.replaced",
        turn: expect.objectContaining({ status: "completed" }),
      }),
    ]);
  });
});
