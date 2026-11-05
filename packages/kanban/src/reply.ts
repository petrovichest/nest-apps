import type { TurnView } from "@codexnest/protocol";

/** The agent's last message in the session's latest turn; null when that turn has none. */
export function lastReply(turns: readonly TurnView[]): string | null {
  const items = turns.at(-1)?.items ?? [];
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (item.type === "agentMessage" && item.text.trim()) return item.text;
  }
  return null;
}

/** The operator's first message in the session; null until it has one with text. */
export function firstRequest(turns: readonly TurnView[]): string | null {
  for (const turn of turns)
    for (const item of turn.items)
      if (item.type === "userMessage" && item.text.trim()) return item.text.trim();
  return null;
}

/** A finished turn's last reply: what the agent waits for, and whether it says it pushed its work. */
export type ReplyVerdict = { question: string | null; published: boolean };
