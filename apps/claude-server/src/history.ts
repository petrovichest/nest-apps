import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type JsonObject = Record<string, unknown>;
export interface HistorySummary {
  sessionId: string;
  cwd: string;
  title: string;
  updatedAt: number;
}
export interface SessionHistory {
  sessionId: string;
  cwd: string;
  messages: JsonObject[];
}
type Transcript = { sessionId: string; path: string; updatedAt: number };

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function missing(error: unknown): boolean {
  return object(error) && error.code === "ENOENT";
}
function validateSessionId(sessionId: string): void {
  if (!UUID.test(sessionId)) throw new Error("Invalid Claude session UUID");
}

async function transcripts(configDir: string): Promise<Transcript[]> {
  const root = join(configDir, "projects");
  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  const files: Transcript[] = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    let entries;
    try {
      entries = await readdir(join(root, project.name), { withFileTypes: true });
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
    for (const entry of entries) {
      // Native subagent transcripts live in nested folders and are never imported.
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const sessionId = entry.name.slice(0, -6);
      if (!UUID.test(sessionId)) continue;
      const path = join(root, project.name, entry.name);
      try {
        files.push({ sessionId, path, updatedAt: (await stat(path)).mtimeMs });
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
  }
  return files.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function readTranscript(file: Transcript): Promise<SessionHistory & { title: string }> {
  const stream = createReadStream(file.path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let cwd = "";
  let firstUser = "";
  let summary = "";
  let customTitle = "";
  const messages: JsonObject[] = [];
  try {
    for await (const line of lines) {
      let entry: unknown;
      // A concurrently written last line can be incomplete. Metadata/corrupt lines
      // do not prevent the remaining native transcript from being read.
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!object(entry) || entry.isSidechain === true) continue;
      if (typeof entry.cwd === "string") cwd = entry.cwd;
      if (entry.type === "custom-title" && typeof entry.customTitle === "string")
        customTitle = entry.customTitle;
      if (entry.type === "summary" && typeof entry.summary === "string") summary = entry.summary;
      if (!["user", "assistant", "system"].includes(String(entry.type))) continue;
      messages.push(entry);
      if (!firstUser && entry.type === "user" && object(entry.message)) {
        const content = entry.message.content;
        if (typeof content === "string") firstUser = content;
        else if (Array.isArray(content)) {
          firstUser = content
            .filter(object)
            .filter((part) => part.type === "text" && typeof part.text === "string")
            .map((part) => part.text)
            .join(" ");
        }
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  const title =
    (customTitle || summary || firstUser).replace(/\s+/g, " ").trim().slice(0, 160) ||
    `Claude session ${file.sessionId.slice(0, 8)}`;
  return { sessionId: file.sessionId, cwd, messages, title };
}

/** Read-only native Claude history, with no index, copied history, or custom DB. */
export async function listHistory(configDir: string, cwd?: string): Promise<HistorySummary[]> {
  const result: HistorySummary[] = [];
  const seen = new Set<string>();
  for (const file of await transcripts(configDir)) {
    if (seen.has(file.sessionId)) continue;
    let history;
    try {
      history = await readTranscript(file);
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
    seen.add(file.sessionId);
    if (cwd !== undefined && (!history.cwd || resolve(history.cwd) !== resolve(cwd))) continue;
    result.push({
      sessionId: file.sessionId,
      cwd: history.cwd,
      title: history.title,
      updatedAt: file.updatedAt,
    });
  }
  return result;
}

export async function readHistory(configDir: string, sessionId: string): Promise<SessionHistory> {
  validateSessionId(sessionId);
  for (const file of await transcripts(configDir)) {
    if (file.sessionId.toLowerCase() !== sessionId.toLowerCase()) continue;
    try {
      const history = await readTranscript(file);
      return { sessionId: history.sessionId, cwd: history.cwd, messages: history.messages };
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  const error = new Error("Claude session history not found") as NodeJS.ErrnoException;
  error.code = "ENOENT";
  throw error;
}
