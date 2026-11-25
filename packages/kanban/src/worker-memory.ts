import { randomUUID } from "node:crypto";
import type { WorkerMemoryEntry } from "@codexnest/protocol";

export const memoryLimits = { notes: 2200, user: 1375 };
export type MemoryScope = "worker" | "project";
type MemoryKind = WorkerMemoryEntry["kind"];
type MemoryTarget = "memory" | "user";

export type WorkerMemoryFailure = {
  success: false;
  code: string;
  error: string;
  done?: true;
  usage?: string;
  current_entries?: string[];
  closest_entries?: string[];
  matches?: string[];
  characters_over?: number;
};

type WorkerMemorySuccess = {
  success: true;
  done: true;
  target: MemoryTarget;
  scope: MemoryScope;
  usage: string;
  entry_count: number;
  patched_entries?: Record<number, string>;
  patched_entries_after?: Record<number, string>;
  removed_entries?: Record<number, string>;
};

export type WorkerMemoryResult = WorkerMemorySuccess | WorkerMemoryFailure;

export function memorySize(entries: readonly WorkerMemoryEntry[]): number {
  return entries.reduce((size, { text }, index) => size + text.length + (index ? 2 : 0), 0);
}

export function memoryFailure(code: string, error: string): WorkerMemoryFailure {
  return { success: false, code, error };
}

function foldForMatch(value: string): string {
  return value
    .replaceAll("\\n", " ")
    .replace(/["\u0060\u2018-\u201f]/gu, "'")
    .replace(/[\u2010-\u2015\u2212]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim();
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{M}\p{N}_]+/gu) ?? []);
}

function locate(
  entries: readonly WorkerMemoryEntry[],
  oldText: string,
): WorkerMemoryEntry | WorkerMemoryFailure {
  const exact = entries.find(({ text }) => text === oldText);
  if (exact) return exact;
  let matches = entries.filter(({ text }) => text.includes(oldText));
  if (!matches.length) {
    const query = foldForMatch(oldText);
    if (/[\p{L}\p{N}]/u.test(query))
      matches = entries.filter(({ text }) => foldForMatch(text).includes(query));
  }
  const distinct = [...new Set(matches.map(({ text }) => text))];
  if (distinct.length > 1)
    return {
      ...memoryFailure("memory_ambiguous", "Several entries match. Use a longer, unique fragment."),
      matches: distinct.map((entry) => (entry.length > 80 ? `${entry.slice(0, 80)}…` : entry)),
    };
  if (matches[0]) return matches[0];
  const query = words(oldText);
  const closest = entries
    .map(({ text }) => ({
      text,
      score: [...words(text)].filter((word) => query.has(word)).length,
    }))
    .filter(({ score }) => score > 0 && score >= query.size * 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ text }) => text);
  return {
    ...memoryFailure(
      "memory_not_found",
      "No entry matches. Copy old_text from one current entry, or call memory_read to refresh it.",
    ),
    ...(closest.length ? { closest_entries: closest } : {}),
  };
}

export function memoryContentProblem(text: string): string | undefined {
  const normalized = text.normalize("NFKC");
  if (
    /[\u200b-\u200d\u202a-\u202e\u2060\u2062-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/u.test(
      normalized,
    )
  )
    return "Memory contains invisible control characters. Save the visible text.";
  if (
    /\b(?:ignore|override|disregard|bypass)\s[^\n]{0,64}\b(?:all|previous|prior|system|developer)\s[^\n]{0,32}\binstructions\b/iu.test(
      normalized,
    ) ||
    /\bsystem\s+prompt\s+override\b/iu.test(normalized) ||
    /\b(?:upload|exfiltrate|send|transmit)\s[^\n]{0,96}\b(?:secrets|credentials|api\s+keys|access\s+tokens)\b/iu.test(
      normalized,
    )
  )
    return "Save the underlying fact without instructions to override policy or transmit secrets.";
  return undefined;
}

export function workerMemoryPrompt(entries: readonly WorkerMemoryEntry[]): string[] {
  const lines: string[] = [];
  for (const project of [false, true]) {
    for (const kind of ["notes", "user"] as const) {
      const group = entries.filter(
        (entry) => entry.kind === kind && (entry.projectKey !== null) === project,
      );
      if (!group.length) continue;
      const heading = kind === "notes" ? "Рабочие заметки" : "Предпочтения пользователя";
      lines.push(
        `${heading}, ${project ? "проект" : "общая память"} (${memorySize(group)}/${memoryLimits[kind]} символов)`,
        ...group.map(({ text }) =>
          JSON.stringify(memoryContentProblem(text) ? "[Запись заблокирована при загрузке]" : text),
        ),
      );
    }
  }
  return lines;
}

export function curateMemory(
  original: readonly WorkerMemoryEntry[],
  kind: MemoryKind,
  projectKey: string | null,
  scope: MemoryScope,
  operations: readonly unknown[],
): { entries: WorkerMemoryEntry[]; result: WorkerMemorySuccess } | { result: WorkerMemoryFailure } {
  const target: MemoryTarget = kind === "notes" ? "memory" : "user";
  const limit = memoryLimits[kind];
  const usage = `${memorySize(original)}/${limit}`;
  const draft = original.slice();
  const patched: Record<number, string> = {};
  const patchedAfter: Record<number, string> = {};
  const removed: Record<number, string> = {};
  let grewOrEdited = false;
  let opNumber = 0;
  function failure(code: string, error: string): { result: WorkerMemoryFailure } {
    return {
      result: {
        ...memoryFailure(code, `Operation ${opNumber}: ${error}`),
        usage,
      },
    };
  }

  for (const raw of operations) {
    opNumber++;
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return failure("invalid_request", "Each memory operation must be an object.");
    const op = raw as Record<string, unknown>;
    if ((op.target != null && op.target !== target) || (op.scope != null && op.scope !== scope))
      return failure("invalid_request", "Apply each batch to one target and one scope.");
    const content =
      typeof op.content === "string" && op.content
        ? op.content
        : typeof op.new_text === "string"
          ? op.new_text
          : "";
    if (op.action === "add") {
      const text = content.trim();
      if (!text) return failure("invalid_request", "Supply content for the new entry.");
      const problem = memoryContentProblem(text);
      if (problem) return failure("memory_unsafe", problem);
      if (!draft.some((entry) => entry.text === text)) {
        draft.push({ id: randomUUID(), kind, projectKey, text });
        grewOrEdited = true;
      }
      continue;
    }
    if (op.action !== "patch" && op.action !== "remove")
      return failure("invalid_request", "Use add, patch, or remove. Patch edits one exact span.");
    const oldText = typeof op.old_text === "string" ? op.old_text : "";
    if (!oldText.trim())
      return failure("invalid_request", "Copy old_text from the intended entry.");
    if (op.action === "patch" && !content.trim())
      return failure(
        "invalid_request",
        "Patch requires replacement text. Remove deletes the entry.",
      );
    const matched = locate(draft, op.action === "patch" ? oldText : oldText.trim());
    if ("error" in matched)
      return { result: { ...matched, error: `Operation ${opNumber}: ${matched.error}`, usage } };
    const index = draft.indexOf(matched);
    if (op.action === "remove") {
      removed[opNumber] = matched.text;
      draft.splice(index, 1);
      continue;
    }
    const start = matched.text.indexOf(oldText);
    if (start < 0)
      return failure("memory_not_found", "Copy the patch span exactly as written in the entry.");
    if (matched.text.indexOf(oldText, start + 1) !== -1)
      return failure(
        "memory_ambiguous",
        "The patch span occurs more than once. Include more context.",
      );
    const text =
      matched.text.slice(0, start) + content + matched.text.slice(start + oldText.length);
    if (text === matched.text)
      return failure("invalid_request", "The patch leaves the entry unchanged.");
    const problem = memoryContentProblem(text);
    if (problem) return failure("memory_unsafe", problem);
    patched[opNumber] = matched.text;
    patchedAfter[opNumber] = text;
    draft[index] = { ...matched, text };
    grewOrEdited = true;
  }

  if (original.length && !draft.length && operations.length > 1)
    return {
      result: {
        ...memoryFailure(
          "memory_would_empty",
          "Keep a useful entry when consolidating. To delete the final entry deliberately, remove it in its own call.",
        ),
        usage,
      },
    };
  const size = memorySize(draft);
  if (grewOrEdited && size > limit)
    return {
      result: {
        ...memoryFailure(
          "memory_full",
          `The result would exceed the limit by ${size - limit} characters. Use one operations batch to shorten or remove stale entries and save the new fact.`,
        ),
        usage,
        characters_over: size - limit,
        ...(operations.length === 1 ? { current_entries: original.map(({ text }) => text) } : {}),
      },
    };
  return {
    entries: draft,
    result: {
      success: true,
      done: true,
      target,
      scope,
      usage: `${size}/${limit}`,
      entry_count: draft.length,
      ...(Object.keys(patched).length
        ? { patched_entries: patched, patched_entries_after: patchedAfter }
        : {}),
      ...(Object.keys(removed).length ? { removed_entries: removed } : {}),
    },
  };
}
