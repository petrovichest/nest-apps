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
  db.function('opennest_match_part', { deterministic: true }, raw => {
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
      return JSON.stringify({
        snippet: prefix + text.slice(before, after).replace(/\s/g, ' ') + (after < text.length ? '…' : ''),
        snippetMatchRange: { start: prefix.length + start - before, end: prefix.length + end - before }
      });
    }
    return null;
  });
  const turn = "CASE WHEN json_extract(m.data,'$.role')='user' THEN m.id ELSE COALESCE(json_extract(m.data,'$.parentID'),(SELECT previous.id FROM message previous WHERE previous.session_id=m.session_id AND json_extract(previous.data,'$.role')='user' AND (previous.time_created < m.time_created OR (previous.time_created=m.time_created AND previous.id <= m.id)) ORDER BY previous.time_created DESC, previous.id DESC LIMIT 1),m.id) END";
  const params = { scope, upper: input.upper, count: input.limit + 1 };
  let cursor = '';
  if (input.cursor) {
    if (input.distinctSessions) { cursor = 'AND m.session_id > :sessionId'; params.sessionId = input.cursor.sessionId; }
    else {
      cursor = 'AND (m.time_created > :time OR (m.time_created=:time AND (m.id > :messageId OR (m.id=:messageId AND p.id > :itemId))))';
      Object.assign(params, { time: input.cursor.time, messageId: input.cursor.messageId, itemId: input.cursor.itemId });
    }
  }
  const select = 'SELECT m.session_id AS sessionId,' + turn + ' AS turnId,m.id AS messageId,p.id AS itemId,m.time_created AS time,opennest_match_part(p.data) AS match FROM message m JOIN part p ON p.message_id=m.id AND p.session_id=m.session_id JOIN session s ON s.id=m.session_id WHERE m.session_id IN (SELECT value FROM json_each(:scope)) AND m.time_created <= :upper AND p.time_created <= :upper ' + cursor + ' AND opennest_match_part(p.data) IS NOT NULL';
  const sql = input.distinctSessions ?
    'SELECT * FROM (SELECT *,ROW_NUMBER() OVER (PARTITION BY sessionId ORDER BY time,messageId,itemId) AS occurrence FROM (' + select + ')) WHERE occurrence=1 ORDER BY sessionId LIMIT :count' :
    select + ' ORDER BY m.time_created,m.id,p.id LIMIT :count';
  const rows = db.prepare(sql).all(params).map(row => ({
    sessionId: row.sessionId, turnId: row.turnId, messageId: row.messageId,
    itemId: row.itemId, time: row.time, ...JSON.parse(row.match)
  }));
  parentPort.postMessage({ ok: true, rows });
} catch {
  parentPort.postMessage({ ok: false, code: failure });
} finally {
  if (db) db.close();
}
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
    const finish = (error: NativeHistorySearchError | null, value?: Row[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value!);
      void worker.terminate();
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
