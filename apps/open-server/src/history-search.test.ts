import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { searchNativeHistory } from "./history-search";

const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "opennest-search-test-"));
  fixtures.push(directory);
  const databasePath = join(directory, "opencode.db");
  const db = new DatabaseSync(databasePath);
  // Only the columns used from the native 1.19.5 V1 schema. Production never creates these tables.
  db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,data TEXT);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT);
    INSERT INTO session VALUES('ses_a'),('ses_b'),('ses_secret');`);
  function message(
    id: string,
    sessionId: string,
    created: number,
    role: string,
    parentID?: string,
  ) {
    db.prepare("INSERT INTO message VALUES(?,?,?,?)").run(
      id,
      sessionId,
      created,
      JSON.stringify({ role, ...(parentID ? { parentID } : {}) }),
    );
  }
  function part(id: string, messageId: string, sessionId: string, data: object, created = 10) {
    db.prepare("INSERT INTO part VALUES(?,?,?,?,?)").run(
      id,
      messageId,
      sessionId,
      created,
      JSON.stringify(data),
    );
  }
  return { db, databasePath, message, part };
}

describe("read-only native history search", () => {
  it("scopes every lookup to explicit managed sessions and treats SQL metacharacters literally", async () => {
    const f = await fixture();
    f.message("msg_a", "ses_a", 1, "user");
    f.part("prt_a", "msg_a", "ses_a", { type: "text", text: "Literal %_' OR 1=1 -- context" });
    f.message("msg_secret", "ses_secret", 1, "user");
    f.part("prt_secret", "msg_secret", "ses_secret", {
      type: "text",
      text: "Literal %_' OR 1=1 -- private",
    });
    f.db.close();
    const result = await searchNativeHistory({
      databasePath: f.databasePath,
      query: "%_' OR 1=1 --",
      sessionIds: ["ses_a"],
    });
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      sessionId: "ses_a",
      turnId: "msg_a",
      messageId: "msg_a",
      itemId: "prt_a",
    });
    expect(
      (
        await searchNativeHistory({
          databasePath: f.databasePath,
          query: "private",
          sessionIds: ["ses_a"],
        })
      ).data,
    ).toEqual([]);
    expect(
      await searchNativeHistory({ databasePath: f.databasePath, query: "private", sessionIds: [] }),
    ).toEqual({ data: [], nextCursor: null });
  });

  it("preserves native turn parentage, Unicode matching and UTF-16 snippet ranges", async () => {
    const f = await fixture();
    f.message("msg_user", "ses_a", 1, "user");
    f.message("msg_assistant", "ses_a", 2, "assistant", "msg_user");
    f.part("prt_answer", "msg_assistant", "ses_a", {
      type: "text",
      text: "🙂 ПРИВЕТ миру İСТОРИЯ",
    });
    f.db.close();
    const result = await searchNativeHistory({
      databasePath: f.databasePath,
      query: "привет",
      sessionIds: ["ses_a"],
    });
    const hit = result.data[0]!;
    expect(hit.turnId).toBe("msg_user");
    expect(hit.snippet.slice(hit.snippetMatchRange.start, hit.snippetMatchRange.end)).toBe(
      "ПРИВЕТ",
    );
    const expanded = (
      await searchNativeHistory({
        databasePath: f.databasePath,
        query: "стория",
        sessionIds: ["ses_a"],
      })
    ).data[0]!;
    expect(
      expanded.snippet.slice(expanded.snippetMatchRange.start, expanded.snippetMatchRange.end),
    ).toBe("СТОРИЯ");
  });

  it("searches command output and file patches without returning entire large tool payloads", async () => {
    const f = await fixture();
    f.message("msg_user", "ses_a", 1, "user");
    f.message("msg_assistant", "ses_a", 2, "assistant", "msg_user");
    f.part("prt_command", "msg_assistant", "ses_a", {
      type: "tool",
      tool: "bash",
      state: {
        input: { command: "npm test" },
        output: "prefix ".repeat(1000) + "needle" + " suffix".repeat(1000),
      },
    });
    f.part("prt_diff", "msg_assistant", "ses_a", {
      type: "tool",
      tool: "edit",
      state: { input: { filePath: "app.ts" }, metadata: { diff: "+ needle fix" } },
    });
    f.db.close();
    const result = await searchNativeHistory({
      databasePath: f.databasePath,
      query: "needle",
      sessionIds: ["ses_a"],
    });
    expect(result.data.map((hit) => hit.itemId)).toEqual(["prt_command", "prt_diff"]);
    expect(result.data[0]!.snippet.length).toBeLessThan(200);
  });

  it("paginates same-timestamp occurrences without duplicates and rejects foreign cursors", async () => {
    const f = await fixture();
    f.message("msg_a", "ses_a", 1, "user");
    for (const id of ["prt_a", "prt_b", "prt_c"])
      f.part(id, "msg_a", "ses_a", { type: "text", text: "find this" });
    f.db.close();
    const options = {
      databasePath: f.databasePath,
      query: "find",
      sessionIds: ["ses_a"],
      limit: 1,
    };
    const first = await searchNativeHistory(options);
    const second = await searchNativeHistory({ ...options, cursor: first.nextCursor });
    const third = await searchNativeHistory({ ...options, cursor: second.nextCursor });
    expect([...first.data, ...second.data, ...third.data].map((hit) => hit.itemId)).toEqual([
      "prt_a",
      "prt_b",
      "prt_c",
    ]);
    expect(third.nextCursor).toBeNull();
    await expect(
      searchNativeHistory({ ...options, query: "this", cursor: first.nextCursor }),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(
      searchNativeHistory({ ...options, sessionIds: ["ses_b"], cursor: first.nextCursor }),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
  });

  it("returns one matching occurrence per session across distinct-session pages", async () => {
    const f = await fixture();
    for (const session of ["ses_a", "ses_b"]) {
      f.message(`msg_${session}`, session, 1, "user");
      for (const suffix of ["a", "b"])
        f.part(`prt_${session}_${suffix}`, `msg_${session}`, session, {
          type: "text",
          text: "matching",
        });
    }
    f.db.close();
    const options = {
      databasePath: f.databasePath,
      query: "matching",
      sessionIds: ["ses_b", "ses_a"],
      limit: 1,
      distinctSessions: true,
    };
    const first = await searchNativeHistory(options);
    const second = await searchNativeHistory({
      ...options,
      sessionIds: ["ses_a", "ses_b"],
      cursor: first.nextCursor,
    });
    expect(first.data.map((hit) => hit.sessionId)).toEqual(["ses_a"]);
    expect(second.data.map((hit) => hit.sessionId)).toEqual(["ses_b"]);
    expect(second.nextCursor).toBeNull();
  });

  it("does not change the native database or add an index/cache", async () => {
    const f = await fixture();
    f.message("msg_a", "ses_a", 1, "user");
    f.part("prt_a", "msg_a", "ses_a", { type: "text", text: "matching" });
    f.db.close();
    const before = createHash("sha256")
      .update(await readFile(f.databasePath))
      .digest("hex");
    await searchNativeHistory({
      databasePath: f.databasePath,
      query: "matching",
      sessionIds: ["ses_a"],
    });
    expect(
      createHash("sha256")
        .update(await readFile(f.databasePath))
        .digest("hex"),
    ).toBe(before);
  });

  it("reports unreadable, unsupported, newer-writer and corrupt storage as errors", async () => {
    const f = await fixture();
    f.message("msg_a", "ses_a", 1, "user");
    f.db
      .prepare("INSERT INTO part VALUES(?,?,?,?,?)")
      .run("prt_bad", "msg_a", "ses_a", 1, "not-json");
    await expect(
      searchNativeHistory({ databasePath: f.databasePath, query: "x", sessionIds: ["ses_a"] }),
    ).rejects.toMatchObject({ code: "invalid_data" });
    f.db.prepare("INSERT INTO session_message VALUES(?,?,?)").run("modern", "ses_b", "{}");
    await expect(
      searchNativeHistory({ databasePath: f.databasePath, query: "x", sessionIds: ["ses_b"] }),
    ).rejects.toMatchObject({ code: "unsupported_schema" });
    f.db.exec("DROP TABLE part");
    f.db.close();
    await expect(
      searchNativeHistory({ databasePath: f.databasePath, query: "x", sessionIds: ["ses_a"] }),
    ).rejects.toMatchObject({ code: "unsupported_schema" });
    await expect(
      searchNativeHistory({
        databasePath: f.databasePath + ".missing",
        query: "x",
        sessionIds: ["ses_a"],
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it("enforces an external worker deadline without blocking the API thread", async () => {
    const f = await fixture();
    f.db.close();
    await expect(
      searchNativeHistory({
        databasePath: f.databasePath,
        query: "x",
        sessionIds: ["ses_a"],
        timeoutMs: 1,
      }),
    ).rejects.toMatchObject({ code: "timeout" });
  });
});
