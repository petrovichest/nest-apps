import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ActivityItem, ThreadSearchOccurrence, TurnView } from "@codexnest/protocol";

const BEFORE = 60;
const AFTER = 120;

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

function itemSearchTexts(item: ActivityItem): string[] {
  if (
    item.type === "userMessage" ||
    item.type === "agentMessage" ||
    item.type === "plan" ||
    item.type === "reasoning"
  ) {
    return [item.text];
  }
  if (item.type === "command") return [item.command, item.output];
  if (item.type === "fileChange") return [item.path ?? "", item.patch];
  if (item.type === "tool") return [item.title, item.detail];
  return [];
}

/** Every message occurrence in a rendered thread, in timeline order. */
export function turnOccurrences(turns: TurnView[], needle: string): ThreadSearchOccurrence[] {
  const query = needle.trim();
  if (!query) return [];
  const occurrences: ThreadSearchOccurrence[] = [];
  for (const turn of turns) {
    for (const item of turn.items) {
      for (const text of itemSearchTexts(item)) {
        const match = matchSnippet(text, query);
        if (match) {
          occurrences.push({
            turnId: turn.id,
            itemId: item.id,
            ...match,
            turnCursor: turn.id,
          });
          break;
        }
      }
    }
  }
  return occurrences;
}

export async function nativeTranscriptPath(
  nativeDir: string,
  nativeId: string | null | undefined,
): Promise<string | null> {
  if (!nativeId || !/^[a-zA-Z0-9._-]+$/.test(nativeId)) return null;
  const candidate = join(
    nativeDir,
    "gemininest",
    "brain",
    nativeId,
    ".system_generated",
    "logs",
    "transcript.jsonl",
  );
  try {
    await access(candidate);
    return candidate;
  } catch {
    return null;
  }
}

export async function threadMessageMatch(
  turns: TurnView[],
  nativeDir: string,
  nativeId: string | null | undefined,
  needle: string,
): Promise<{ snippet: string; turnId?: string } | null> {
  const query = needle.trim();
  if (!query) return null;
  for (const turn of turns) {
    for (const item of turn.items) {
      for (const text of itemSearchTexts(item)) {
        const match = matchSnippet(text, query);
        if (match) return { snippet: match.snippet, turnId: turn.id };
      }
    }
  }
  const transcriptPath = await nativeTranscriptPath(nativeDir, nativeId);
  if (!transcriptPath) return null;
  const stream = createReadStream(transcriptPath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const raw of lines) {
      if (!raw.trim()) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }
      for (const field of [parsed.content, parsed.thinking]) {
        if (typeof field !== "string" || !field) continue;
        const match = matchSnippet(field, query);
        if (match) return { snippet: match.snippet };
      }
    }
  } catch {
    return null;
  } finally {
    lines.close();
    stream.destroy();
  }
  return null;
}
