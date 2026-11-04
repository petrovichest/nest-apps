import { describe, expect, it } from "vitest";
import type { TurnView } from "@codexnest/protocol";
import { lastReply } from "./reply.js";

const message = (type: string, text: string) => ({ type, id: text, text, status: "completed" });
const turn = (...items: unknown[]) => ({ id: "t", items }) as unknown as TurnView;

describe("last reply", () => {
  it("reads the last agent message of the latest turn only", () => {
    expect(
      lastReply([
        turn(message("agentMessage", "Earlier question?")),
        turn(
          message("userMessage", "Do it"),
          message("agentMessage", "Working on it"),
          message("reasoning", "thinking"),
          message("agentMessage", "Done. Which branch?"),
          { type: "command", id: "c", command: "ls" },
        ),
      ]),
    ).toBe("Done. Which branch?");
    expect(
      lastReply([turn(message("agentMessage", "Old")), turn(message("userMessage", "Hi"))]),
    ).toBe(null);
    expect(lastReply([])).toBeNull();
  });
});
