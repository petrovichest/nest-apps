import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { KanbanRun } from "@codexnest/protocol";
import { KanbanService } from "./service.js";

const execute = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execute("git", ["-C", cwd, ...args], { timeout: 10_000 })).stdout.trim();
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 8000;
  while (true) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting for the real kanban workflow");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("real repository kanban workflow through the generated agent CLI", () => {
  it("classifies, executes in isolation, integrates and publishes a solo result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kanban-workflow-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const project = join(directory, "project");
    const remote = join(directory, "remote.git");
    const dataDir = join(directory, "state with 'quotes' $literal");
    await mkdir(project);
    await git(project, "init", "--quiet", "--initial-branch=main");
    await git(project, "config", "user.name", "Kanban Fixture");
    await git(project, "config", "user.email", "50870093+petrovichest@users.noreply.github.com");
    await writeFile(join(project, "code.txt"), "original\n");
    await git(project, "add", "code.txt");
    await git(project, "commit", "--quiet", "-m", "Fixture baseline");
    await git(project, "init", "--quiet", "--bare", "--initial-branch=main", remote);
    await git(project, "remote", "add", "origin", remote);
    await git(project, "push", "--quiet", "-u", "origin", "main");
    const baseline = await git(project, "rev-parse", "HEAD");
    const launches: string[] = [];
    const service = new KanbanService({
      provider: "codex",
      dataDir,
      adapter: {
        async launch(input) {
          launches.push(input.id);
          return { threadId: input.id, sessionUrl: `/threads/${input.id}` };
        },
        async resume() {},
      },
    });
    await service.initialize();
    cleanups.push(() => service.close());
    async function running(kind: KanbanRun["kind"], cardId: string): Promise<KanbanRun> {
      const board = await until(
        () => service.read(project),
        (board) =>
          board.runs.some(
            (run) => run.kind === kind && run.cardIds.includes(cardId) && run.status === "running",
          ),
      );
      return board.runs.find(
        (run) => run.kind === kind && run.cardIds.includes(cardId) && run.status === "running",
      )!;
    }
    async function command<T>(run: KanbanRun, name: string, payload: unknown): Promise<T> {
      const { stdout } = await execute(
        process.execPath,
        [
          join(dataDir, "agent.mjs"),
          join(dataDir, "capabilities", `${run.id}.json`),
          name,
          JSON.stringify(payload),
        ],
        { timeout: 10_000, maxBuffer: 1024 * 1024 },
      );
      return JSON.parse(stdout) as T;
    }
    const created = await service.createCard(project, {
      description: "Replace the contents of code.txt and publish to main",
      clientCreationId: randomUUID(),
    });
    const cardId = created.cards[0]!.id;
    const classifier = await running("classify", cardId);
    expect(
      await command(classifier, "report", {
        title: "Change code",
        category: "Implementation",
        scope: "task",
      }),
    ).toEqual({ next: "done" });
    expect((await service.read(project)).cards[0]?.classification).toBe("ready");
    await service.action(project, {
      action: "execute",
      cardIds: [cardId],
      clientActionId: randomUUID(),
    });
    const worker = await running("execute", cardId);
    const repository = await command<{ workspacePath: string; branch: string }>(
      worker,
      "prepare-repository",
      { repositoryPath: project, targetBranch: "main" },
    );
    expect(repository.workspacePath).not.toBe(project);
    expect(await git(repository.workspacePath, "branch", "--show-current")).toBe(repository.branch);
    await writeFile(join(repository.workspacePath, "code.txt"), "isolated result\n");
    await git(repository.workspacePath, "add", "code.txt");
    await git(repository.workspacePath, "commit", "--quiet", "-m", "Implement fixture task");
    const taskCommit = await git(repository.workspacePath, "rev-parse", "HEAD");
    expect(await readFile(join(project, "code.txt"), "utf8")).toBe("original\n");
    expect(await git(project, "rev-parse", "HEAD")).toBe(baseline);
    expect(await git(project, "rev-parse", "refs/remotes/origin/main")).toBe(baseline);
    expect(
      await command(worker, "report", {
        outcome: "completed",
        summary: "The task result was tested",
      }),
    ).toEqual({ next: "publish" });
    expect((await service.read(project)).cards[0]?.stageId).not.toBe("done");
    const integration = await command<{
      groups: { rootPath: string; repositories: { workspacePath: string }[] }[];
    }>(worker, "prepare-integration", {});
    expect(integration.groups).toHaveLength(1);
    expect(
      await readFile(
        join(integration.groups[0]!.repositories[0]!.workspacePath, "code.txt"),
        "utf8",
      ),
    ).toBe("isolated result\n");
    expect(await git(project, "rev-parse", "HEAD")).toBe(baseline);
    expect((await service.read(project)).cards[0]?.stageId).not.toBe("done");
    expect((await command<{ next: string }>(worker, "publish", {})).next).toBe("done");
    const completed = await service.read(project);
    expect(completed.cards[0]?.stageId).toBe("done");
    expect(completed.cards[0]?.repositories[0]).toMatchObject({
      targetBranch: "main",
      status: "published",
    });
    expect(await readFile(join(project, "code.txt"), "utf8")).toBe("isolated result\n");
    const published = await git(remote, "rev-parse", "refs/heads/main");
    expect(published).not.toBe(baseline);
    expect(await git(project, "rev-parse", "HEAD")).toBe(published);
    expect(await git(project, "merge-base", "--is-ancestor", taskCommit, published)).toBe("");
    expect(await git(remote, "show", "main:code.txt")).toBe("isolated result");
    expect(launches).toEqual([classifier.id, worker.id]);
  }, 30_000);
});
