import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { Worker } from "node:worker_threads";

export type NativeHistoryHit = {
  sessionId: string;
  turnId: string;
  messageId: string;
  itemId: string;
  snippet: string;
  snippetMatchRange: { start: number; end: number };
};
export type NativeHistorySearchOptions = {
  databasePath: string;
  query: string;
  /** Explicit Nest-managed session IDs; an empty scope never searches other sessions. */
  sessionIds: readonly string[];
  cursor?: string | null;
  limit?: number;
  distinctSessions?: boolean;
  timeoutMs?: number;
};
type ErrorCode =
  | "invalid_query"
  | "invalid_cursor"
  | "unavailable"
  | "unsupported_schema"
  | "invalid_data"
  | "timeout";
export class NativeHistorySearchError extends Error {
  constructor(public readonly code: ErrorCode) {
    super(
      {
        invalid_query: "Invalid native history search request.",
        invalid_cursor: "History search cursor does not match this request.",
        unavailable: "Native history could not be read.",
        unsupported_schema: "This native history format is not supported by the read-only search.",
        invalid_data: "Native history contains invalid records.",
        timeout: "Native history search exceeded its time budget. Narrow the search and retry.",
      }[code],
    );
    this.name = "NativeHistorySearchError";
  }
}
type Cursor = {
  version: 1;
  scope: string;
  upper: number;
  sessionId: string;
  time: number;
  messageId: string;
  itemId: string;
};

// Native SQLite exposes no progress handler through node:sqlite. Running the read
// in a disposable worker gives full scans a hard deadline without blocking the API.
const workerSource = String.raw`
(async () => {
const { parentPort, workerData: input } = await import('node:worker_threads');
const { DatabaseSync } = await import('node:sqlite');
let db;
let failure = 'unavailable';
let result;
try {
  db = new DatabaseSync(input.databasePath, { readOnly: true, timeout: 500 });
  db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN');
  failure = 'unsupported_schema';
  for (const [table, columns] of Object.entries({
    session: ['id'], message: ['id','session_id','time_created','data'],
    part: ['id','message_id','session_id','time_created','data']
  })) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw Error();
    const actual = new Set(db.prepare('PRAGMA table_info("' + table + '")').all().map(row => row.name));
    if (columns.some(column => !actual.has(column))) throw Error();
  }
  const scope = JSON.stringify(input.sessionIds);
  // V1 API writes message/part. Do not claim complete search over a newer writer
  // whose separate session_message representation this reader does not understand.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_message'").get()) {
    const modern = db.prepare('SELECT 1 FROM session_message WHERE session_id IN (SELECT value FROM json_each(?)) LIMIT 1').get(scope);
    if (modern) throw Error();
  }
  failure = 'invalid_data';
  const needle = input.query.toLocaleLowerCase();
  const normalNeedle = ![...input.query].some(character => character === '"' || character === '\\' || character === '/' || character.charCodeAt(0) < 32);
  function matchPart(raw) {
    const part = JSON.parse(raw);
    const state = part.state || {};
    const data = state.input || {};
    const fields = part.type === 'text' || part.type === 'reasoning' ? [part.text] : part.type === 'tool' ?
      [data.command, state.output, state.error, data.filePath, state.metadata && state.metadata.diff, state.title, part.tool] : [];
    for (const text of fields) {
      if (typeof text !== 'string' || !text) continue;
      const folded = text.toLocaleLowerCase();
      const position = folded.indexOf(needle);
      if (position < 0) continue;
      let start = position, end = position + needle.length;
      // Preserve UTF-16 offsets when lowercasing expands a character (e.g. İ).
      if (folded.length !== text.length) {
        let original = 0, lower = 0;
        for (const character of text) {
          const next = lower + character.toLocaleLowerCase().length;
          if (lower <= position) start = original;
          if (next >= position + needle.length) { end = original + character.length; break; }
          original += character.length;
          lower = next;
        }
      }
      const before = Math.max(0, start - 60), after = Math.min(text.length, end + 120);
      const prefix = before > 0 ? '…' : '';
      return {
        snippet: prefix + text.slice(before, after).replace(/\s/g, ' ') + (after < text.length ? '…' : ''),
        snippetMatchRange: { start: prefix.length + start - before, end: prefix.length + end - before }
      };
    }
    return null;
  }
  // Use the native-owned index if present; never add or modify a history index.
  const partIndex = db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='part_message_id_id_idx' AND tbl_name='part'").get() ? ' INDEXED BY part_message_id_id_idx' : '';
  const parts = db.prepare('SELECT id AS itemId,data,json_valid(data) AS valid FROM part' + partIndex + ' WHERE message_id=:messageId AND session_id=:sessionId AND id>:itemId AND time_created<=:upper ORDER BY id LIMIT 32');
  const messageInfo = db.prepare('SELECT data FROM message WHERE id=?');
  const previousUser = db.prepare("SELECT id FROM message WHERE session_id=:sessionId AND json_extract(data,'$.role')='user' AND (time_created<:time OR (time_created=:time AND id<=:messageId)) ORDER BY time_created DESC,id DESC LIMIT 1");
  const rows = [];
  let after = input.cursor ? { sessionId: input.cursor.sessionId, time: input.cursor.time, messageId: input.cursor.messageId, inclusive: !input.distinctSessions, skipSession: input.distinctSessions } : null;
  let matchedSession = input.distinctSessions ? input.cursor && input.cursor.sessionId : null;
  let initialPart = input.distinctSessions ? null : input.cursor;
  scan: while (rows.length < input.limit + 1) {
    const params = { scope, upper: input.upper };
    let boundary = '';
    if (after) {
      Object.assign(params, { time: after.time, messageId: after.messageId });
      const same = '(m.time_created>:time OR (m.time_created=:time AND m.id' + (after.inclusive ? '>=' : '>') + ':messageId))';
      if (input.distinctSessions) {
        params.sessionId = after.sessionId;
        boundary = after.skipSession ? 'AND m.session_id>:sessionId' : 'AND (m.session_id>:sessionId OR (m.session_id=:sessionId AND ' + same + '))';
        if (after.skipSession) { delete params.time; delete params.messageId; }
      } else boundary = 'AND ' + same;
    }
    const order = input.distinctSessions ? 'm.session_id,m.time_created,m.id' : 'm.time_created,m.id';
    // Sort bounded metadata pages, not transcript bodies. Matching outside an
    // SQLite JS UDF prevents callback handles retaining the whole scan in V8.
    const messages = db.prepare('SELECT m.session_id AS sessionId,m.id AS messageId,m.time_created AS time FROM message m JOIN session s ON s.id=m.session_id WHERE m.session_id IN (SELECT value FROM json_each(:scope)) AND m.time_created<=:upper ' + boundary + ' ORDER BY ' + order + ' LIMIT 512').all(params);
    if (!messages.length) break;
    for (const message of messages) {
      after = { ...message, inclusive: false, skipSession: false };
      if (input.distinctSessions && message.sessionId === matchedSession) continue;
      let partId = initialPart && message.messageId === initialPart.messageId ? initialPart.itemId : '';
      initialPart = null;
      while (true) {
        const batch = parts.all({ messageId: message.messageId, sessionId: message.sessionId, itemId: partId, upper: input.upper });
        if (!batch.length) break;
        for (const part of batch) {
          partId = part.itemId;
          if (!part.valid) throw Error('Invalid native part JSON');
          // For ordinary needles, raw JSON can only add false positives. Escaped
          // Unicode and JSON-special query characters retain full parsing.
          if (normalNeedle && part.data.trim() !== 'null' && !part.data.includes('\\u') && !part.data.toLocaleLowerCase().includes(needle)) continue;
          const match = matchPart(part.data);
          if (!match) continue;
          const info = JSON.parse(messageInfo.get(message.messageId).data);
          const turnId = info.role === 'user' ? message.messageId : typeof info.parentID === 'string' ? info.parentID : previousUser.get({ sessionId: message.sessionId, time: message.time, messageId: message.messageId })?.id || message.messageId;
          rows.push({ sessionId: message.sessionId, turnId, messageId: message.messageId, itemId: part.itemId, time: message.time, ...match });
          if (rows.length >= input.limit + 1) break scan;
          if (input.distinctSessions) { matchedSession = message.sessionId; break; }
        }
        if ((input.distinctSessions && message.sessionId === matchedSession) || batch.length < 32) break;
      }
    }
    if (input.distinctSessions && after.sessionId === matchedSession) after.skipSession = true;
    if (messages.length < 512) break;
  }
  result = { ok: true, rows };
} catch {
  result = { ok: false, code: failure };
} finally {
  try { if (db) db.close(); }
  catch { result = { ok: false, code: 'unavailable' }; }
}
// Completion is published only after releasing the native read transaction.
parentPort.postMessage(result);
})();
`;

export async function searchNativeHistory(
  options: NativeHistorySearchOptions,
): Promise<{ data: NativeHistoryHit[]; nextCursor: string | null }> {
  const query = typeof options.query === "string" ? options.query.trim() : "";
  const limit = options.limit ?? 50;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (
    !query ||
    query.length > 500 ||
    typeof options.databasePath !== "string" ||
    !isAbsolute(options.databasePath) ||
    (options.distinctSessions !== undefined && typeof options.distinctSessions !== "boolean") ||
    !Array.isArray(options.sessionIds) ||
    options.sessionIds.length > 100_000 ||
    options.sessionIds.some((id) => typeof id !== "string" || !id || id.length > 256) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000
  )
    throw new NativeHistorySearchError("invalid_query");
  const sessionIds = [...new Set(options.sessionIds)].sort();
  const scope = createHash("sha256")
    .update(
      JSON.stringify({
        query: query.toLocaleLowerCase(),
        sessionIds,
        distinct: options.distinctSessions === true,
      }),
    )
    .digest("hex");
  let cursor: Cursor | undefined;
  if (options.cursor) {
    try {
      if (options.cursor.length > 4096) throw new Error();
      const value = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")) as Cursor;
      if (
        value.version !== 1 ||
        value.scope !== scope ||
        !Number.isSafeInteger(value.upper) ||
        value.upper < 0 ||
        !Number.isSafeInteger(value.time) ||
        value.time < 0 ||
        value.time > value.upper ||
        !sessionIds.includes(value.sessionId) ||
        typeof value.messageId !== "string" ||
        !value.messageId ||
        value.messageId.length > 256 ||
        typeof value.itemId !== "string" ||
        !value.itemId ||
        value.itemId.length > 256
      )
        throw new Error();
      cursor = value;
    } catch {
      throw new NativeHistorySearchError("invalid_cursor");
    }
  }
  if (!sessionIds.length) return { data: [], nextCursor: null };
  const upper = cursor?.upper ?? Date.now();
  type Row = NativeHistoryHit & { time: number };
  const rows = await new Promise<Row[]>((resolve, reject) => {
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: { ...options, query, sessionIds, cursor, upper, limit },
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    let settled = false;
    const finish = async (error: NativeHistorySearchError | null, value?: Row[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Timeout/error paths can interrupt a read transaction too. Do not report
      // completion while worker teardown still holds native SQLite resources.
      try {
        await worker.terminate();
      } catch {
        error ??= new NativeHistorySearchError("unavailable");
      }
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(() => finish(new NativeHistorySearchError("timeout")), timeoutMs);
    worker.once("message", (message: { ok: boolean; rows?: Row[]; code?: ErrorCode }) =>
      finish(
        message.ok ? null : new NativeHistorySearchError(message.code ?? "unavailable"),
        message.rows,
      ),
    );
    worker.once("error", () => finish(new NativeHistorySearchError("unavailable")));
    worker.once("exit", () => {
      if (!settled) finish(new NativeHistorySearchError("unavailable"));
    });
  });
  const data = rows.slice(0, limit);
  const last = data.at(-1);
  const nextCursor =
    rows.length > limit && last
      ? Buffer.from(
          JSON.stringify({
            version: 1,
            scope,
            upper,
            sessionId: last.sessionId,
            time: last.time,
            messageId: last.messageId,
            itemId: last.itemId,
          } satisfies Cursor),
        ).toString("base64url")
      : null;
  return {
    data: data.map((row) => ({
      sessionId: row.sessionId,
      turnId: row.turnId,
      messageId: row.messageId,
      itemId: row.itemId,
      snippet: row.snippet,
      snippetMatchRange: row.snippetMatchRange,
    })),
    nextCursor,
  };
}
