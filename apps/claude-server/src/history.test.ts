import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listHistory, readHistory } from "./history.js";

const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";
let configDir: string;
let project: string;
const nativeUser = (sessionId: string, content: unknown, cwd = "/work/repo") => ({
  type: "user",
  uuid: "message-1",
  sessionId,
  cwd,
  isSidechain: false,
  message: { role: "user", content },
  timestamp: "2026-10-05T10:00:00.000Z",
});
const lines = (...entries: unknown[]) =>
  entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "claudenest-native-history-"));
  project = join(configDir, "projects", "-work-repo");
  await mkdir(project, { recursive: true });
});
afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

describe("native Claude history", () => {
  it("lists native main transcripts by mtime, filters cwd, and leaves their contents unchanged", async () => {
    const first = join(project, `${FIRST}.jsonl`);
    const second = join(project, `${SECOND}.jsonl`);
    const original = lines(nativeUser(FIRST, "  Inspect\nthe project  "));
    await writeFile(first, original);
    await writeFile(
      second,
      lines(nativeUser(SECOND, [{ type: "text", text: "Other project" }], "/work/other")),
    );
    await utimes(first, new Date(1000), new Date(1000));
    await utimes(second, new Date(2000), new Date(2000));
    expect(await listHistory(configDir)).toEqual([
      { sessionId: SECOND, cwd: "/work/other", title: "Other project", updatedAt: 2000 },
      { sessionId: FIRST, cwd: "/work/repo", title: "Inspect the project", updatedAt: 1000 },
    ]);
    expect(await listHistory(configDir, "/work/repo/")).toEqual([
      { sessionId: FIRST, cwd: "/work/repo", title: "Inspect the project", updatedAt: 1000 },
    ]);
    expect(await readFile(first, "utf8")).toBe(original);
    expect((await stat(first)).mtimeMs).toBe(1000);
  });

  it("reads conversation objects and tolerates a partial final line without importing child agents", async () => {
    const user = nativeUser(FIRST, "Work on this");
    const assistant = {
      type: "assistant",
      cwd: "/work/repo",
      sessionId: FIRST,
      message: { role: "assistant", content: [{ type: "text", text: "Answer" }] },
    };
    await writeFile(
      join(project, `${FIRST}.jsonl`),
      lines(
        { type: "file-history-snapshot", snapshot: {} },
        user,
        assistant,
        { type: "progress", data: { type: "bash_progress" } },
        {
          type: "assistant",
          isSidechain: true,
          message: { role: "assistant", content: "Subagent" },
        },
      ) + '{"type":"user","message":',
    );
    const childDir = join(project, FIRST, "subagents");
    await mkdir(childDir, { recursive: true });
    await writeFile(join(childDir, "agent-child.jsonl"), lines(nativeUser(SECOND, "Child work")));
    await writeFile(
      join(project, "agent-child.jsonl"),
      lines(nativeUser(SECOND, "Old child filename")),
    );
    expect(await listHistory(configDir)).toHaveLength(1);
    expect(await readHistory(configDir, FIRST)).toEqual({
      sessionId: FIRST,
      cwd: "/work/repo",
      messages: [user, assistant],
    });
  });

  it("honors native custom titles and does not use tool results as user titles", async () => {
    await writeFile(
      join(project, `${FIRST}.jsonl`),
      lines(
        nativeUser(FIRST, [{ type: "tool_result", tool_use_id: "tool-1", content: "Tool stdout" }]),
        nativeUser(FIRST, [{ type: "text", text: "Actual task" }]),
        { type: "summary", summary: "Compact context" },
        { type: "custom-title", customTitle: "Chosen title", sessionId: FIRST },
      ),
    );
    expect((await listHistory(configDir))[0]?.title).toBe("Chosen title");
  });

  it("retains mid-turn queued commands and ignores image companions when choosing the title", async () => {
    const companion = {
      ...nativeUser(FIRST, "[Image: original 2880x1800]"),
      isMeta: true,
      turnCompanion: true,
    };
    const user = nativeUser(FIRST, "Actual task");
    const queued = {
      type: "attachment",
      attachment: {
        type: "queued_command",
        source_uuid: "steer-1",
        prompt: "Show the screenshots",
        timestamp: "2026-10-05T10:02:00.000Z",
      },
    };
    const original = lines(companion, user, queued, {
      type: "attachment",
      attachment: { type: "environment" },
    });
    const path = join(project, `${FIRST}.jsonl`);
    await writeFile(path, original);
    expect((await listHistory(configDir))[0]?.title).toBe("Actual task");
    expect((await readHistory(configDir, FIRST)).messages).toEqual([companion, user, queued]);
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("returns empty history lists for a fresh installation and rejects traversal/non-UUID IDs", async () => {
    expect(await listHistory(join(configDir, "absent"))).toEqual([]);
    await expect(readHistory(configDir, "../projects")).rejects.toThrow(
      "Invalid Claude session UUID",
    );
    await expect(readHistory(configDir, FIRST)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses the newest native file if a session UUID appears in two project directories", async () => {
    const other = join(configDir, "projects", "-work-new");
    await mkdir(other);
    const oldPath = join(project, `${FIRST}.jsonl`);
    const newPath = join(other, `${FIRST}.jsonl`);
    await writeFile(oldPath, lines(nativeUser(FIRST, "Older", "/work/old")));
    await writeFile(newPath, lines(nativeUser(FIRST, "Newer", "/work/new")));
    await utimes(oldPath, new Date(1000), new Date(1000));
    await utimes(newPath, new Date(2000), new Date(2000));
    expect(await listHistory(configDir)).toEqual([
      { sessionId: FIRST, cwd: "/work/new", title: "Newer", updatedAt: 2000 },
    ]);
    expect((await readHistory(configDir, FIRST)).cwd).toBe("/work/new");
  });
});
