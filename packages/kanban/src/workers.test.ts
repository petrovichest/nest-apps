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
    const shared = await first.create(fields, null);
    expect((await second.list(sameProjectKey)).map((worker) => worker.id)).toContain(
      projectWorker.id,
    );
    await expect(second.snapshot(projectWorker.id, otherKey)).rejects.toMatchObject({
      code: "worker_not_found",
    });
    await Promise.all([
      first.changeMemory(shared.id, projectKey, {
        action: "add",
        scope: "project",
        kind: "notes",
        text: "Use npm test",
      }),
      second.changeMemory(shared.id, otherKey, {
        action: "add",
        scope: "worker",
        kind: "user",
        text: "Keep replies short",
      }),
    ]);
    expect(
      (await first.snapshot(shared.id, sameProjectKey)).memory.map((entry) => entry.text).sort(),
    ).toEqual(["Keep replies short", "Use npm test"]);
    expect((await first.snapshot(shared.id, otherKey)).memory.map((entry) => entry.text)).toEqual([
      "Keep replies short",
    ]);
    await second.edit(shared.id, null, shared.revision, { ...fields, name: "Team lead" });
    await expect(first.edit(shared.id, null, shared.revision, fields)).rejects.toMatchObject({
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
