import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { ThreadSearchOccurrence, TurnView } from "@codexnest/protocol";

type Json = Record<string, unknown>;
const BEFORE = 60;
const AFTER = 120;

function object(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A whitespace-flattened excerpt around the first case-insensitive match. */
export function matchSnippet(
  text: string,
  needle: string,
): { snippet: string; snippetMatchRange: { start: number; end: number } } | null {
  const index = text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
  if (index < 0 || !needle) return null;
  const start = Math.max(0, index - BEFORE);
  const end = Math.min(text.length, index + needle.length + AFTER);
  const prefix = start > 0 ? "…" : "";
  return {
    snippet: `${prefix}${text.slice(start, end).replace(/\s/g, " ")}${end < text.length ? "…" : ""}`,
    snippetMatchRange: {
      start: prefix.length + index - start,
      end: prefix.length + index - start + needle.length,
    },
  };
}

/** User-visible text of a native user or assistant transcript entry. */
function messageText(entry: Json): string {
  if (entry.isSidechain === true || entry.isMeta === true || entry.turnCompanion === true)
    return "";
  if (!object(entry.message) || (entry.type !== "user" && entry.type !== "assistant")) return "";
  const content = entry.message.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter(object)
            .filter((part) => part.type === "text" && typeof part.text === "string")
            .map((part) => part.text as string)
            .join("\n")
        : "";
  return text.replace(/<claudenest_attachments>[\s\S]*?<\/claudenest_attachments>/g, "").trim();
}

/** Scans one native transcript and returns the first message matching the search text. */
export async function transcriptMatch(path: string, needle: string): Promise<string | null> {
  const lowered = needle.toLocaleLowerCase();
  // JSON escapes only quotes, backslashes and control characters, so other text appears verbatim.
  const verbatim = !/["\\\u0000-\u001f]/.test(needle);
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (verbatim && !line.toLocaleLowerCase().includes(lowered)) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!object(entry)) continue;
      const match = matchSnippet(messageText(entry), needle);
      if (match) return match.snippet;
    }
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** Every message occurrence in a rendered thread, in timeline order. */
export function turnOccurrences(turns: TurnView[], needle: string): ThreadSearchOccurrence[] {
  const occurrences: ThreadSearchOccurrence[] = [];
  for (const turn of turns)
    for (const item of turn.items) {
      if (item.type !== "userMessage" && item.type !== "agentMessage" && item.type !== "plan")
        continue;
      const match = matchSnippet(item.text, needle);
      if (match)
        occurrences.push({ turnId: turn.id, itemId: item.id, ...match, turnCursor: turn.id });
    }
  return occurrences;
}
