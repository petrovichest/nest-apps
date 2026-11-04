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
