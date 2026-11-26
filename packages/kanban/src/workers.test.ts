import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WORKER_ARCHITECT_ID } from "@codexnest/protocol";
import { WorkerStore } from "./workers.js";

it("shares profiles across app owners and confines memory to the canonical project", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nest-workers-"));
  try {
    const first = new WorkerStore(directory);
    const second = new WorkerStore(directory);
    const project = join(directory, "project");
    const other = join(directory, "other");
    const alias = join(directory, "alias");
    await Promise.all([mkdir(project), mkdir(other)]);
    await symlink(project, alias);
    const [projectKey, sameProjectKey, otherKey] = await Promise.all([
      first.projectKey(project),
      second.projectKey(alias),
      second.projectKey(other),
    ]);
    const fields = { name: "Lead", role: "Plan work", instructions: "Check results", settings: {} };
    const projectWorker = await first.create(fields, projectKey);
    const architect = WORKER_ARCHITECT_ID;
    await expect(
      first.propose({
        ...fields,
        provider: "codex",
        projectKey: null,
        settings: { collaborationMode: "default" },
      }),
    ).rejects.toMatchObject({ code: "worker_project_required" });
    expect((await second.list(sameProjectKey)).map((worker) => worker.id)).toContain(
      projectWorker.id,
    );
    await expect(second.snapshot(projectWorker.id, otherKey)).rejects.toMatchObject({
      code: "worker_not_found",
    });
    await Promise.all([
      first.changeMemory(architect, projectKey, {
        action: "add",
        scope: "project",
        kind: "notes",
        text: "Use npm test",
      }),
      second.changeMemory(architect, otherKey, {
        action: "add",
        scope: "worker",
        kind: "user",
        text: "Keep replies short",
      }),
    ]);
    expect(
      (await first.snapshot(architect, sameProjectKey)).memory.map((entry) => entry.text).sort(),
    ).toEqual(["Keep replies short", "Use npm test"]);
    expect((await first.snapshot(architect, otherKey)).memory.map((entry) => entry.text)).toEqual([
      "Keep replies short",
    ]);
    await second.edit(projectWorker.id, sameProjectKey, projectWorker.revision, {
      ...fields,
      name: "Team lead",
    });
    await expect(
      first.edit(projectWorker.id, sameProjectKey, projectWorker.revision, fields),
    ).rejects.toMatchObject({
      code: "worker_changed",
    });
    await first.edit(WORKER_ARCHITECT_ID, null, 0, {
      ...fields,
      settings: { codex: { collaborationMode: "default", model: "pinned" } },
    });
    expect((await second.snapshot(WORKER_ARCHITECT_ID, null)).profile.settings).toEqual({});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("fits an atomic consolidation against the final budget and preserves existing scope and entry IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nest-worker-memory-"));
  try {
    const first = new WorkerStore(directory);
    const second = new WorkerStore(directory);
    const project = "this-project";
    const id = WORKER_ARCHITECT_ID;
    const keep = "Default command: npm test. Reports include file paths.";
    const obsolete = "x".repeat(2200 - keep.length - 2);
    for (const text of [keep, obsolete])
      await first.changeMemory(id, project, {
        action: "add",
        kind: "notes",
        scope: "project",
        text,
      });
    await first.changeMemory(id, project, {
      action: "add",
      kind: "notes",
      scope: "worker",
      text: "Review the tests first",
    });
    await first.changeMemory(id, "other-project", {
      action: "add",
      kind: "notes",
      scope: "project",
      text: "Use another test runner",
    });

    const original = (await first.snapshot(id, project)).memory;
    const add = { action: "add", content: "Use fixtures from the current project." };
    expect(await second.curate(id, project, { target: "memory", operations: [add] })).toMatchObject(
      {
        success: false,
        code: "memory_full",
        usage: "2200/2200",
        current_entries: [keep, obsolete],
      },
    );
    const patch = { action: "patch", old_text: "npm test", content: "npm test -- --run" };
    expect(
      await second.curate(id, project, {
        target: "memory",
        operations: [patch, { action: "remove", old_text: "missing entry" }],
      }),
    ).toMatchObject({ success: false, code: "memory_not_found" });
    expect((await first.snapshot(id, project)).memory).toEqual(original);

    const requestId = randomUUID();
    const batch = {
      target: "memory",
      scope: "project",
      operations: [add, patch, { action: "remove", old_text: obsolete }],
    };
    const result = await first.curate(id, project, batch, requestId);
    expect(result).toMatchObject({
      success: true,
      done: true,
      entry_count: 2,
      patched_entries: { 2: keep },
      patched_entries_after: {
        2: "Default command: npm test -- --run. Reports include file paths.",
      },
      removed_entries: { 3: obsolete },
    });
    expect(await second.curate(id, project, batch, requestId)).toEqual(result);
    expect(await second.curate(id, "other-project", batch, requestId)).toMatchObject({
      success: false,
      code: "invalid_request",
    });
    await second.acknowledgeMemory(id, project, requestId);
    expect(await second.curate(id, project, { target: "memory", operations: [add] })).toMatchObject(
      {
        success: true,
        entry_count: 2,
      },
    );
    expect((await first.snapshot(id, project)).memory).toEqual([
      { ...original[0], text: "Default command: npm test -- --run. Reports include file paths." },
      original[2],
      expect.objectContaining({ kind: "notes", projectKey: project, text: add.content }),
    ]);
    expect((await first.snapshot(id, "other-project")).memory.map(({ text }) => text)).toEqual([
      "Review the tests first",
      "Use another test runner",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("uses whole-entry matches before substrings and rejects an ambiguous patch or a bulk wipe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nest-worker-memory-matches-"));
  try {
    const workers = new WorkerStore(directory);
    const { id } = await workers.create(
      { name: "Reviewer", role: "Review", instructions: "", settings: {} },
      "project",
    );
    const call = (operations: unknown[]) =>
      workers.curate(id, "project", { target: "user", scope: "worker", operations });
    const add = (content: string) => ({ action: "add", content });
    const remove = (old_text: string) => ({ action: "remove", old_text });
    expect(
      await call([add("tea"), add("Refer to ‘tea’ — twice: tea"), add("tea is the default")]),
    ).toMatchObject({
      success: true,
      entry_count: 3,
    });
    expect(await call([remove("tea")])).toMatchObject({
      success: true,
      removed_entries: { 1: "tea" },
    });
    expect(await call([{ action: "patch", old_text: "tea", content: "coffee" }])).toMatchObject({
      success: false,
      code: "memory_ambiguous",
    });
    expect(
      await call([remove("Refer to 'tea' - twice: tea"), remove("tea is the default")]),
    ).toMatchObject({
      success: false,
      code: "memory_would_empty",
    });
    expect(await call([remove("Refer to 'tea' - twice: tea")])).toMatchObject({
      success: true,
      entry_count: 1,
    });
    expect(await call([remove("tea is the default"), add("Invisible\u200b text")])).toMatchObject({
      success: false,
      code: "memory_unsafe",
    });
    expect((await workers.snapshot(id, "project")).memory.map(({ text }) => text)).toEqual([
      "tea is the default",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
