import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  createTaskWorkspace,
  discoverRepositories,
  prepareIntegrationWorkspace,
  prepareRepository,
  publishIntegrationRepository,
  validateIntegrationWorkspace,
  validateTaskWorkspace,
} from "./workspace.js";

const exec = promisify(execFile);
const directories: string[] = [];
const identity = {
  GIT_AUTHOR_NAME: "Workspace Test",
  GIT_AUTHOR_EMAIL: "workspace-test@users.noreply.github.com",
  GIT_COMMITTER_NAME: "Workspace Test",
  GIT_COMMITTER_EMAIL: "workspace-test@users.noreply.github.com",
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Kanban multi-repository Git workspaces", () => {
  it("keeps parallel tasks and multiple repositories isolated with their original relative layout", async () => {
    const project = await temporary();
    const api = await repository(join(project, "api"), { "api.txt": "base\n" });
    const ui = await repository(join(project, "ui"), { "ui.txt": "base\n" });
    const storage = await temporary();
    const one = await createTaskWorkspace({
      projectPath: project,
      workspaceRoot: storage,
      taskId: "one",
    });
    const two = await createTaskWorkspace({
      projectPath: project,
      workspaceRoot: storage,
      taskId: "two",
    });
    const oneApi = await prepareRepository(one, { repositoryPath: api, targetBranch: "main" });
    const oneUi = await prepareRepository(one, { repositoryPath: ui, targetBranch: "main" });
    const twoApi = await prepareRepository(two, { repositoryPath: api, targetBranch: "main" });
    expect(oneApi.workspacePath).toBe(join(one.rootPath, "api"));
    expect(oneUi.workspacePath).toBe(join(one.rootPath, "ui"));
    await writeFile(join(oneApi.workspacePath, "api.txt"), "task one\n");
    expect(await readFile(join(twoApi.workspacePath, "api.txt"), "utf8")).toBe("base\n");
    expect(await readFile(join(api, "api.txt"), "utf8")).toBe("base\n");
    await expect(validateTaskWorkspace(one)).rejects.toMatchObject({ code: "dirty_workspace" });
    await commit(oneApi.workspacePath, "task one");
    const results = await validateTaskWorkspace(one);
    expect(results).toHaveLength(1);
    expect(results[0]!.repository.id).toBe(oneApi.id);
    expect(await git(api, "branch", "--show-current")).toBe("main");
    const resumed = await createTaskWorkspace({
      projectPath: project,
      workspaceRoot: storage,
      taskId: "one",
    });
    expect(
      (await prepareRepository(resumed, { repositoryPath: api, targetBranch: "main" }))
        .workspacePath,
    ).toBe(oneApi.workspacePath);
  });

  it("requires an explicit decision for dirty source files and never copies them", async () => {
    const source = await repository(undefined, { "file.txt": "saved\n" });
    await writeFile(join(source, "file.txt"), "unsaved\n");
    await writeFile(join(source, ".env"), "SECRET=value\n");
    const task = await createTaskWorkspace({
      projectPath: source,
      workspaceRoot: await temporary(),
      taskId: "dirty",
    });
    await expect(
      prepareRepository(task, { repositoryPath: source, targetBranch: "main" }),
    ).rejects.toMatchObject({ code: "dirty_source" });
    const prepared = await prepareRepository(task, {
      repositoryPath: source,
      targetBranch: "main",
      excludeDirty: true,
    });
    expect(await readFile(join(prepared.workspacePath, "file.txt"), "utf8")).toBe("saved\n");
    await expect(readFile(join(prepared.workspacePath, ".env"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(source, "file.txt"), "utf8")).toBe("unsaved\n");
  });

  it("supports new target branches without silently choosing a base", async () => {
    const source = await repository(undefined, { "file.txt": "base\n" });
    const task = await createTaskWorkspace({
      projectPath: source,
      workspaceRoot: await temporary(),
      taskId: "new-target",
    });
    await expect(
      prepareRepository(task, { repositoryPath: source, targetBranch: "feature/test" }),
    ).rejects.toMatchObject({ code: "base_branch_required" });
    const prepared = await prepareRepository(task, {
      repositoryPath: source,
      targetBranch: "feature/test",
      baseBranch: "main",
    });
    await writeFile(join(prepared.workspacePath, "file.txt"), "feature\n");
    await commit(prepared.workspacePath, "feature");
    const integration = await prepareIntegrationWorkspace({
      projectPath: source,
      workspaceRoot: await temporary(),
      integrationId: "new-target",
      results: await validateTaskWorkspace(task),
    });
    const [result] = await validateIntegrationWorkspace(integration);
    const published = await publishIntegrationRepository(integration.repositories[0]!, {
      expectedSha: result!.sha,
    });
    expect(published.localOnly).toBe(true);
    expect(await git(source, "show", "feature/test:file.txt")).toBe("feature");
    expect(await readFile(join(source, "file.txt"), "utf8")).toBe("base\n");
  });

  it("preserves a .git/info/exclude skeleton and commits only explicit safe bootstrap files", async () => {
    const source = await temporary();
    await mkdir(join(source, ".git", "info"), { recursive: true });
    await writeFile(join(source, ".git", "info", "exclude"), "existing-rule\n");
    await writeFile(join(source, "README.md"), "Workspace\n");
    await writeFile(join(source, ".env"), "SECRET=value\n");
    const nested = await repository(join(source, "child"), { "code.txt": "child\n" });
    const task = await createTaskWorkspace({
      projectPath: source,
      workspaceRoot: await temporary(),
      taskId: "bootstrap",
    });
    // Configure identity outside the repository so the helper uses existing configuration.
    const oldConfigCount = process.env.GIT_CONFIG_COUNT;
    const oldKey = process.env.GIT_CONFIG_KEY_0;
    const oldValue = process.env.GIT_CONFIG_VALUE_0;
    const oldKey1 = process.env.GIT_CONFIG_KEY_1;
    const oldValue1 = process.env.GIT_CONFIG_VALUE_1;
    process.env.GIT_CONFIG_COUNT = "2";
    process.env.GIT_CONFIG_KEY_0 = "user.name";
    process.env.GIT_CONFIG_VALUE_0 = "Workspace Test";
    process.env.GIT_CONFIG_KEY_1 = "user.email";
    process.env.GIT_CONFIG_VALUE_1 = "workspace-test@users.noreply.github.com";
    try {
      await expect(
        prepareRepository(task, {
          repositoryPath: source,
          targetBranch: "feature/bootstrap",
          initialize: true,
          excludeDirty: true,
        }),
      ).rejects.toMatchObject({ code: "base_branch_required" });
    } finally {
      restoreEnvironment("GIT_CONFIG_COUNT", oldConfigCount);
      restoreEnvironment("GIT_CONFIG_KEY_0", oldKey);
      restoreEnvironment("GIT_CONFIG_VALUE_0", oldValue);
      restoreEnvironment("GIT_CONFIG_KEY_1", oldKey1);
      restoreEnvironment("GIT_CONFIG_VALUE_1", oldValue1);
    }
    expect((await git(source, "ls-files")).split("\n")).toEqual(["README.md"]);
    expect(await readFile(join(source, ".git", "info", "exclude"), "utf8")).toContain(
      "existing-rule",
    );
    expect(await git(nested, "branch", "--show-current")).toBe("main");
    expect((await discoverRepositories(source)).map((item) => item.path)).toEqual([source, nested]);
  });

  it("can prepare a root worktree after a nested repository was already prepared", async () => {
    const source = await repository(undefined, { ".gitignore": "child/\n", "README.md": "Root\n" });
    const child = await repository(join(source, "child"), { "file.txt": "child\n" });
    const task = await createTaskWorkspace({
      projectPath: source,
      workspaceRoot: await temporary(),
      taskId: "root-later",
    });
    const preparedChild = await prepareRepository(task, {
      repositoryPath: child,
      targetBranch: "main",
    });
    await writeFile(join(preparedChild.workspacePath, "file.txt"), "child task\n");
    const preparedRoot = await prepareRepository(task, {
      repositoryPath: source,
      targetBranch: "main",
    });
    expect(preparedRoot.workspacePath).toBe(task.rootPath);
    expect(await readFile(join(task.rootPath, "README.md"), "utf8")).toBe("Root\n");
    expect(await readFile(join(preparedChild.workspacePath, "file.txt"), "utf8")).toBe(
      "child task\n",
    );
    expect(await git(preparedChild.workspacePath, "branch", "--show-current")).toBe(
      preparedChild.branch,
    );
  });

  it("merges independent task results and publishes a local-only target without resetting the source", async () => {
    const source = await repository(undefined, { "one.txt": "one\n", "two.txt": "two\n" });
    const storage = await temporary();
    const one = await changedTask(source, storage, "one", "one.txt", "changed one\n");
    const two = await changedTask(source, storage, "two", "two.txt", "changed two\n");
    const integration = await prepareIntegrationWorkspace({
      projectPath: source,
      workspaceRoot: storage,
      integrationId: "combine",
      results: [...(await validateTaskWorkspace(one)), ...(await validateTaskWorkspace(two))],
    });
    expect(integration.repositories[0]!.mergeStatus).toBe("merged");
    const [result] = await validateIntegrationWorkspace(integration);
    expect(await readFile(join(source, "one.txt"), "utf8")).toBe("one\n");
    const published = await publishIntegrationRepository(integration.repositories[0]!, {
      expectedSha: result!.sha,
    });
    expect(published).toMatchObject({ pushed: false, localOnly: true });
    expect(await readFile(join(source, "one.txt"), "utf8")).toBe("changed one\n");
    expect(await readFile(join(source, "two.txt"), "utf8")).toBe("changed two\n");
    await expect(
      publishIntegrationRepository(integration.repositories[0]!, { expectedSha: result!.sha }),
    ).resolves.toMatchObject({ sha: result!.sha });
  });

  it("returns a resumable integration on conflicts and validates every selected input", async () => {
    const source = await repository(undefined, { "file.txt": "base\n" });
    const storage = await temporary();
    const one = await changedTask(source, storage, "conflict-one", "file.txt", "one\n");
    const two = await changedTask(source, storage, "conflict-two", "file.txt", "two\n");
    const options = {
      projectPath: source,
      workspaceRoot: storage,
      integrationId: "conflict",
      results: [...(await validateTaskWorkspace(one)), ...(await validateTaskWorkspace(two))],
    };
    const integration = await prepareIntegrationWorkspace(options);
    expect(integration.repositories[0]!.mergeStatus).toBe("conflict");
    const resumed = await prepareIntegrationWorkspace(options);
    expect(resumed.rootPath).toBe(integration.rootPath);
    await expect(validateIntegrationWorkspace(resumed)).rejects.toMatchObject({
      code: "dirty_workspace",
    });
    await writeFile(join(integration.rootPath, "file.txt"), "one and two\n");
    await commit(integration.rootPath, "resolve conflict");
    const [result] = await validateIntegrationWorkspace(resumed);
    expect(result!.sha).toMatch(/^[a-f0-9]{40}$/);
    expect(await readFile(join(source, "file.txt"), "utf8")).toBe("base\n");
  });

  it("rejects target advancement and dirty checked-out targets", async () => {
    const source = await repository(undefined, { "file.txt": "base\n", "other.txt": "other\n" });
    const storage = await temporary();
    const task = await changedTask(source, storage, "advance", "file.txt", "task\n");
    const integration = await prepareIntegrationWorkspace({
      projectPath: source,
      workspaceRoot: storage,
      integrationId: "advance",
      results: await validateTaskWorkspace(task),
    });
    const [result] = await validateIntegrationWorkspace(integration);
    await writeFile(join(source, "other.txt"), "uncommitted\n");
    await expect(
      publishIntegrationRepository(integration.repositories[0]!, { expectedSha: result!.sha }),
    ).rejects.toMatchObject({ code: "dirty_source" });
    await commit(source, "external change");
    await expect(
      publishIntegrationRepository(integration.repositories[0]!, { expectedSha: result!.sha }),
    ).rejects.toMatchObject({ code: "target_changed" });
    expect(await readFile(join(source, "other.txt"), "utf8")).toBe("uncommitted\n");
    await git(integration.rootPath, "merge", "--no-edit", "main");
    const [updated] = await validateIntegrationWorkspace(integration);
    await expect(
      publishIntegrationRepository(integration.repositories[0]!, { expectedSha: updated!.sha }),
    ).resolves.toMatchObject({ sha: updated!.sha });
    expect(await readFile(join(source, "file.txt"), "utf8")).toBe("task\n");
  });

  it("preserves existing nested gitlinks and keeps commits in their owning repositories", async () => {
    const source = await repository(undefined, { "README.md": "parent\n" });
    const child = await repository(join(source, "child"), { "file.txt": "child\n" });
    await commit(source, "record existing nested repository");
    const originalTree = await git(source, "ls-tree", "HEAD", "child");
    expect(originalTree).toMatch(/^160000 commit /);
    const task = await createTaskWorkspace({
      projectPath: source,
      workspaceRoot: await temporary(),
      taskId: "gitlinks",
    });
    const parentResult = await prepareRepository(task, {
      repositoryPath: source,
      targetBranch: "main",
    });
    const childResult = await prepareRepository(task, {
      repositoryPath: child,
      targetBranch: "main",
    });
    await writeFile(join(childResult.workspacePath, "file.txt"), "new child\n");
    await commit(childResult.workspacePath, "change child");
    await commit(parentResult.workspacePath, "update existing gitlink");
    expect(await validateTaskWorkspace(task)).toHaveLength(2);
    expect(await git(source, "ls-tree", "HEAD", "child")).toBe(originalTree);
    expect(await readFile(join(child, "file.txt"), "utf8")).toBe("child\n");
  });

  it("rejects new gitlinks and symlinks that escape the task mirror", async () => {
    const source = await repository(undefined, { "README.md": "parent\n", "file.txt": "source\n" });
    const child = await repository(join(source, "child"), { "code.txt": "child\n" });
    const task = await createTaskWorkspace({
      projectPath: source,
      workspaceRoot: await temporary(),
      taskId: "new-gitlink",
    });
    const parentResult = await prepareRepository(task, {
      repositoryPath: source,
      targetBranch: "main",
      excludeDirty: true,
    });
    await prepareRepository(task, { repositoryPath: child, targetBranch: "main" });
    await commit(parentResult.workspacePath, "accidental git add child");
    await expect(validateTaskWorkspace(task)).rejects.toMatchObject({ code: "unsafe_gitlink" });
    const cleanSource = await repository(undefined, { "file.txt": "source\n" });
    await symlink(join(cleanSource, "file.txt"), join(cleanSource, "outside"));
    await commit(cleanSource, "absolute symlink");
    const cleanTask = await createTaskWorkspace({
      projectPath: cleanSource,
      workspaceRoot: await temporary(),
      taskId: "outside-symlink",
    });
    await expect(
      prepareRepository(cleanTask, { repositoryPath: cleanSource, targetBranch: "main" }),
    ).rejects.toMatchObject({ code: "invalid_path" });
  });

  it("preserves a promoted local result when push fails and safely retries publication", async () => {
    const source = await repository(undefined, { "file.txt": "base\n" });
    const bare = join(await temporary(), "remote.git");
    await exec("git", ["init", "--bare", "--quiet", bare]);
    await git(source, "remote", "add", "origin", bare);
    await git(source, "push", "--quiet", "origin", "main");
    const storage = await temporary();
    const task = await changedTask(source, storage, "push", "file.txt", "task\n");
    const integration = await prepareIntegrationWorkspace({
      projectPath: source,
      workspaceRoot: storage,
      integrationId: "push",
      results: await validateTaskWorkspace(task),
    });
    const [result] = await validateIntegrationWorkspace(integration);
    await writeFile(join(bare, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await expect(
      publishIntegrationRepository(integration.repositories[0]!, { expectedSha: result!.sha }),
    ).rejects.toMatchObject({ code: "push_failed" });
    expect(await git(source, "rev-parse", "main")).toBe(result!.sha);
    await rm(join(bare, "hooks", "pre-receive"));
    const published = await publishIntegrationRepository(integration.repositories[0]!, {
      expectedSha: result!.sha,
    });
    expect(published).toMatchObject({ pushed: true, localOnly: false });
    expect((await exec("git", ["--git-dir", bare, "rev-parse", "main"])).stdout.trim()).toBe(
      result!.sha,
    );
  });

  it("publishes to the explicit feature target even when it tracks remote main", async () => {
    const source = await repository(undefined, { "file.txt": "base\n" });
    const originalMain = await git(source, "rev-parse", "main");
    const bare = join(await temporary(), "remote.git");
    await exec("git", ["init", "--bare", "--quiet", bare]);
    await git(source, "remote", "add", "origin", bare);
    await git(source, "push", "--quiet", "origin", "main");
    await git(source, "checkout", "--quiet", "-b", "feature/experiment");
    await git(source, "config", "branch.feature/experiment.remote", "origin");
    await git(source, "config", "branch.feature/experiment.merge", "refs/heads/main");
    const storage = await temporary();
    const task = await createTaskWorkspace({
      projectPath: source,
      workspaceRoot: storage,
      taskId: "feature-remote",
    });
    const prepared = await prepareRepository(task, {
      repositoryPath: source,
      targetBranch: "feature/experiment",
    });
    expect(prepared.remoteBranch).toBe("feature/experiment");
    await writeFile(join(prepared.workspacePath, "file.txt"), "experiment\n");
    await commit(prepared.workspacePath, "experiment");
    const integration = await prepareIntegrationWorkspace({
      projectPath: source,
      workspaceRoot: storage,
      integrationId: "feature-remote",
      results: await validateTaskWorkspace(task),
    });
    const [result] = await validateIntegrationWorkspace(integration);
    await publishIntegrationRepository(integration.repositories[0]!, { expectedSha: result!.sha });
    expect((await exec("git", ["--git-dir", bare, "rev-parse", "main"])).stdout.trim()).toBe(
      originalMain,
    );
    expect(
      (await exec("git", ["--git-dir", bare, "rev-parse", "feature/experiment"])).stdout.trim(),
    ).toBe(result!.sha);
  });

  it("bootstraps an empty initialized repository and preserves unrelated staged files on rejection", async () => {
    const source = await temporary();
    await git(source, "init", "--quiet", "--initial-branch=main");
    await git(source, "config", "user.name", "Workspace Test");
    await git(source, "config", "user.email", "workspace-test@users.noreply.github.com");
    await writeFile(join(source, "README.md"), "initial\n");
    const task = await createTaskWorkspace({
      projectPath: source,
      workspaceRoot: await temporary(),
      taskId: "unborn-empty",
    });
    const prepared = await prepareRepository(task, {
      repositoryPath: source,
      targetBranch: "main",
      initialize: true,
    });
    expect(await readFile(join(prepared.workspacePath, "README.md"), "utf8")).toBe("initial\n");
    const stagedSource = await temporary();
    await git(stagedSource, "init", "--quiet", "--initial-branch=main");
    await git(stagedSource, "config", "user.name", "Workspace Test");
    await git(stagedSource, "config", "user.email", "workspace-test@users.noreply.github.com");
    await writeFile(join(stagedSource, "unrelated.txt"), "keep staged\n");
    await git(stagedSource, "add", "unrelated.txt");
    const index = await readFile(join(stagedSource, ".git", "index"));
    const config = await readFile(join(stagedSource, ".git", "config"));
    const stagedTask = await createTaskWorkspace({
      projectPath: stagedSource,
      workspaceRoot: await temporary(),
      taskId: "unborn-staged",
    });
    await expect(
      prepareRepository(stagedTask, {
        repositoryPath: stagedSource,
        targetBranch: "main",
        initialize: true,
      }),
    ).rejects.toMatchObject({ code: "dirty_source" });
    expect(await readFile(join(stagedSource, ".git", "index"))).toEqual(index);
    expect(await readFile(join(stagedSource, ".git", "config"))).toEqual(config);
    expect(await git(stagedSource, "diff", "--cached", "--name-only")).toBe("unrelated.txt");
  });

  it("validates only pending repositories during a partial publication retry", async () => {
    const project = await temporary();
    const a = await repository(join(project, "a"), { "file.txt": "a\n" });
    const b = await repository(join(project, "b"), { "file.txt": "b\n" });
    const storage = await temporary();
    const task = await createTaskWorkspace({
      projectPath: project,
      workspaceRoot: storage,
      taskId: "partial",
    });
    const preparedA = await prepareRepository(task, { repositoryPath: a, targetBranch: "main" });
    const preparedB = await prepareRepository(task, { repositoryPath: b, targetBranch: "main" });
    await writeFile(join(preparedA.workspacePath, "file.txt"), "a task\n");
    await commit(preparedA.workspacePath, "a task");
    await writeFile(join(preparedB.workspacePath, "file.txt"), "b task\n");
    await commit(preparedB.workspacePath, "b task");
    const integration = await prepareIntegrationWorkspace({
      projectPath: project,
      workspaceRoot: storage,
      integrationId: "partial",
      results: await validateTaskWorkspace(task),
    });
    const results = await validateIntegrationWorkspace(integration);
    const integrationA = integration.repositories.find((item) => item.relativePath === "a")!;
    const integrationB = integration.repositories.find((item) => item.relativePath === "b")!;
    await publishIntegrationRepository(integrationA, {
      expectedSha: results.find((item) => item.repository.id === integrationA.id)!.sha,
    });
    await writeFile(join(preparedA.workspacePath, "file.txt"), "later task editing\n");
    await writeFile(join(integrationA.workspacePath, "file.txt"), "later integration editing\n");
    expect(
      (await validateTaskWorkspace(task, [preparedB.id])).map((item) => item.repository.id),
    ).toEqual([preparedB.id]);
    expect(
      (await validateIntegrationWorkspace(integration, [integrationB.id])).map(
        (item) => item.repository.id,
      ),
    ).toEqual([integrationB.id]);
    expect(integration.repositories).toHaveLength(2);
    expect(task.repositories).toHaveLength(2);
  });

  it("does not initialize inside bare repositories or Git administrative directories", async () => {
    const bare = await temporary();
    await exec("git", ["init", "--bare", "--quiet", bare]);
    const bareTask = await createTaskWorkspace({
      projectPath: bare,
      workspaceRoot: await temporary(),
      taskId: "bare",
    });
    await expect(
      prepareRepository(bareTask, { repositoryPath: bare, targetBranch: "main", initialize: true }),
    ).rejects.toMatchObject({ code: "invalid_git_directory" });
    await expect(readFile(join(bare, ".git", "HEAD"))).rejects.toMatchObject({ code: "ENOENT" });
    const source = await repository(undefined, { "README.md": "root\n" });
    const task = await createTaskWorkspace({
      projectPath: source,
      workspaceRoot: await temporary(),
      taskId: "git-dir",
    });
    await expect(
      prepareRepository(task, {
        repositoryPath: join(source, ".git"),
        targetBranch: "main",
        initialize: true,
      }),
    ).rejects.toMatchObject({ code: "invalid_git_directory" });
    await expect(readFile(join(source, ".git", ".git", "HEAD"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

async function temporary(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "nest-kanban-workspace-test-"));
  directories.push(path);
  return path;
}

async function repository(path?: string, files: Record<string, string> = {}): Promise<string> {
  const root = path ?? (await temporary());
  await mkdir(root, { recursive: true });
  await git(root, "init", "--quiet", "--initial-branch=main");
  await git(root, "config", "user.name", "Workspace Test");
  await git(root, "config", "user.email", "workspace-test@users.noreply.github.com");
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), contents);
  }
  await commit(root, "initial");
  return root;
}

async function changedTask(
  source: string,
  storage: string,
  id: string,
  file: string,
  contents: string,
) {
  const task = await createTaskWorkspace({
    projectPath: source,
    workspaceRoot: storage,
    taskId: id,
  });
  const prepared = await prepareRepository(task, { repositoryPath: source, targetBranch: "main" });
  await writeFile(join(prepared.workspacePath, file), contents);
  await commit(prepared.workspacePath, id);
  return task;
}

async function git(path: string, ...args: string[]): Promise<string> {
  return (
    await exec("git", ["-C", path, ...args], { env: { ...process.env, ...identity } })
  ).stdout.trim();
}

async function commit(path: string, message: string): Promise<void> {
  await git(path, "add", "--all");
  await git(path, "commit", "--allow-empty", "--quiet", "-m", message);
}

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
