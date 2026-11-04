import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KanbanStore } from "./store.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "kanban-store-"));
  directories.push(directory);
  const project = join(directory, "project");
  await mkdir(project);
  const store = new KanbanStore(join(directory, "shared"));
  await store.initialize();
  return { directory, project, store };
}
describe("shared kanban storage", () => {
  it("identifies one board through canonical project paths across store instances", async () => {
    const { directory, project, store } = await fixture();
    await symlink(project, join(directory, "linked"));
    const other = new KanbanStore(store.directory);
    await other.initialize();
    const first = await store.read(project),
      second = await other.read(join(directory, "linked"));
    expect(first.board.id).toBe(second.board.id);
  });
  it("serializes concurrent mutations from separate provider stores without lost updates", async () => {
    const { project, store } = await fixture();
    const other = new KanbanStore(store.directory);
    await other.initialize();
    await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        (i % 2 ? store : other).update(project, (data) => {
          data.board.categories.push({ id: String(i), name: String(i) });
        }),
      ),
    );
    const { board } = await store.read(project);
    expect(board.categories).toHaveLength(24);
    expect(board.revision).toBe(24);
  });
  it("recovers a lock abandoned by a terminated owner", async () => {
    const { project, store } = await fixture();
    const { board } = await store.read(project);
    const path = join(store.locksDirectory, board.id);
    await mkdir(path);
    await writeFile(join(path, "owner.json"), JSON.stringify({ pid: 2147483647 }));
    await store.update(project, (data) => {
      data.board.revision = 7;
    });
    expect((await store.read(project)).board.revision).toBe(8);
  });
  it("does not overwrite an unsupported/corrupted persisted document", async () => {
    const { project, store } = await fixture();
    const { board } = await store.read(project);
    await writeFile(
      join(store.boardsDirectory, `${board.id}.json`),
      JSON.stringify({ version: 1, board: { id: board.id } }),
    );
    await expect(store.read(project)).rejects.toThrow("invalid kanban state");
  });
  it("turns an old Review stage into Waiting for answer and moves its cards to Ready", async () => {
    const { project, store } = await fixture();
    const { board } = await store.read(project);
    const old = {
      ...(await store.readById(board.id))!,
    };
    old.board.stages = [
      { id: "todo", name: "To do", description: "", role: "todo" },
      { id: "working", name: "In progress", description: "", role: "working" },
      { id: "review", name: "Проверено", description: "Look", role: "review", renamed: true },
      { id: "ready", name: "Ready for integration", description: "", role: "ready" },
      { id: "done", name: "Done", description: "", role: "done" },
    ] as never;
    old.board.cards = [
      { id: "a", stageId: "review" },
      { id: "b", stageId: "todo" },
    ] as never;
    await writeFile(join(store.boardsDirectory, `${board.id}.json`), JSON.stringify(old));
    const upgraded = (await store.read(project)).board;
    expect(upgraded.stages.map((stage) => stage.role)).toEqual([
      "todo",
      "working",
      "waiting",
      "ready",
      "done",
    ]);
    expect(upgraded.stages[2]).toEqual({
      id: "review",
      name: "Waiting for answer",
      description: "",
      role: "waiting",
    });
    expect(upgraded.cards.map((card) => card.stageId)).toEqual(["ready", "todo"]);
  });
});
