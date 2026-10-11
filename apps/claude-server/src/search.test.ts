import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { transcriptMatch } from "./search.js";

it("excludes internal continuation inputs from search while keeping real user messages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-search-"));
  try {
    const path = join(directory, "history.jsonl");
    await writeFile(
      path,
      [
        { type: "user", uuid: "internal", message: { content: "Resume unfinished task" } },
        { type: "user", uuid: "user", message: { content: "Resume user task" } },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n"),
    );
    expect(await transcriptMatch(path, "unfinished", ["internal"])).toBeNull();
    expect(await transcriptMatch(path, "user task", ["internal"])).toBe("Resume user task");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("searches and quotes a slash command the way it was typed, not Claude Code's tag record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-search-"));
  try {
    const path = join(directory, "history.jsonl");
    const record =
      "<command-message>grilling</command-message>\n<command-name>/grilling</command-name>\n<command-args>проверить идею</command-args>";
    await writeFile(
      path,
      JSON.stringify({ type: "user", uuid: "user", message: { content: record } }),
    );
    expect(await transcriptMatch(path, "проверить идею")).toBe("/grilling проверить идею");
    expect(await transcriptMatch(path, "command-name")).toBeNull();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
