import { describe, expect, it } from "vitest";
import { projectTurns, type NativeMessage } from "./projection";

describe("native history projection", () => {
  it("keeps intermediate tool-call commentary distinct from the final answer", () => {
    const messages: NativeMessage[] = [
      {
        info: { id: "user", role: "user", time: { created: 1 } },
        parts: [{ id: "request", type: "text", text: "inspect files" }],
      },
      {
        info: {
          id: "step",
          role: "assistant",
          parentID: "user",
          time: { created: 2, completed: 3 },
          finish: "tool-calls",
        },
        parts: [
          { id: "commentary", type: "text", text: "Reading files" },
          {
            id: "tool",
            type: "tool",
            tool: "read",
            state: { status: "completed", output: "content" },
          },
        ],
      },
      {
        info: {
          id: "final",
          role: "assistant",
          parentID: "user",
          time: { created: 4, completed: 5 },
          finish: "stop",
        },
        parts: [{ id: "answer", type: "text", text: "Done" }],
      },
    ];
    const [turn] = projectTurns(messages, false);
    expect(turn?.items.find((item) => item.id === "commentary")).toMatchObject({
      phase: "commentary",
    });
    expect(turn?.items.find((item) => item.id === "answer")).toMatchObject({
      phase: "final_answer",
    });
    expect(
      projectTurns(messages, true)[0]?.items.find((item) => item.id === "answer"),
    ).toMatchObject({ phase: "commentary" });
  });
  it("preserves failed native outcomes without fabricating a final answer", () => {
    const [turn] = projectTurns(
      [
        {
          info: {
            id: "failure",
            role: "assistant",
            error: { name: "ProviderError" },
            time: { created: 1, completed: 2 },
          },
          parts: [{ id: "partial", type: "text", text: "Partial response" }],
        },
      ],
      false,
    );
    expect(turn?.status).toBe("failed");
    expect(turn?.items[0]).toMatchObject({ status: "failed", phase: "commentary" });
  });
  it("keeps previous final answers final while a later turn is still streaming", () => {
    const messages: NativeMessage[] = [
      { info: { id: "u1", role: "user" }, parts: [{ id: "q1", type: "text", text: "First" }] },
      {
        info: {
          id: "a1",
          role: "assistant",
          parentID: "u1",
          finish: "stop",
          time: { completed: 1 },
        },
        parts: [{ id: "r1", type: "text", text: "First answer" }],
      },
      { info: { id: "u2", role: "user" }, parts: [{ id: "q2", type: "text", text: "Second" }] },
      {
        info: { id: "a2", role: "assistant", parentID: "u2" },
        parts: [{ id: "r2", type: "text", text: "Working" }],
      },
    ];
    const turns = projectTurns(messages, true);
    expect(turns[0]?.items.find((item) => item.id === "r1")).toMatchObject({
      phase: "final_answer",
    });
    expect(turns[1]).toMatchObject({ status: "inProgress" });
    expect(turns[1]?.items.find((item) => item.id === "r2")).toMatchObject({ phase: "commentary" });
    expect(projectTurns(messages, false)[1]?.status).toBe("interrupted");
  });
  it("projects native question answers and images from their actual tool metadata", () => {
    const [turn] = projectTurns(
      [
        {
          info: { id: "answer", role: "assistant", time: { completed: 1 } },
          parts: [
            {
              id: "question",
              type: "tool",
              tool: "question",
              state: {
                status: "completed",
                input: { questions: [{ header: "Choice", question: "Which route?" }] },
                metadata: { answers: [["First"]] },
              },
            },
            {
              id: "image",
              type: "tool",
              tool: "browser_take_screenshot",
              state: {
                status: "completed",
                output: "Screenshot",
                attachments: [{ mime: "image/png", url: "data:image/png;base64,AA==" }],
              },
            },
          ],
        },
      ],
      false,
    );
    expect(turn?.items[0]).toMatchObject({
      type: "userInputResponse",
      entries: [{ header: "Choice", question: "Which route?", answers: ["First"] }],
    });
    expect(turn?.items[1]).toMatchObject({ type: "tool", images: ["data:image/png;base64,AA=="] });
  });
  it("uses the original command only for host-managed sessions", () => {
    const messages: NativeMessage[] = [
      {
        info: { id: "tool", role: "assistant" },
        parts: [
          {
            id: "command",
            type: "tool",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "bwrap wrapper", opennestOriginalCommand: "git status" },
            },
          },
        ],
      },
    ];
    expect(projectTurns(messages, false)[0]?.items[0]).toMatchObject({ command: "bwrap wrapper" });
    expect(projectTurns(messages, false, { managedCommands: true })[0]?.items[0]).toMatchObject({
      command: "git status",
    });
  });
});
