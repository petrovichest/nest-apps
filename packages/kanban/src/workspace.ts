import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT = 120_000;
const METADATA_FILE = "workspace.json";
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "vendor",
  "venv",
  "env",
  "target",
  "dist",
  "build",
  "coverage",
  "__pycache__",
  "logs",
  "log",
  "reports",
  "artifacts",
  "output",
  "outputs",
  "data",
  "cache",
  "tmp",
  "temp",
  "worktrees",
]);

export type WorkspaceErrorCode =
  | "invalid_path"
  | "not_repository"
  | "unborn_repository"
  | "invalid_git_directory"
  | "branch_required"
  | "base_branch_required"
  | "invalid_branch"
  | "dirty_source"
  | "dirty_workspace"
  | "workspace_missing"
  | "workspace_mismatch"
  | "target_already_selected"
  | "target_changed"
  | "remote_changed"
  | "branch_changed"
  | "result_changed"
  | "unmerged_inputs"
  | "unsafe_gitlink"
  | "identity_required"
  | "git_failed"
  | "push_failed";

export class WorkspaceError extends Error {
  constructor(
    public readonly code: WorkspaceErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export interface WorkspaceRepository {
  id: string;
  sourcePath: string;
  relativePath: string;
  gitCommonDir: string;
  workspacePath: string;
  branch: string;
  targetBranch: string;
  baseSha: string;
  targetSha: string | null;
  remote: string | null;
  remoteBranch?: string;
  remoteFingerprint?: string;
}

export interface TaskWorkspace {
  id: string;
  projectPath: string;
  rootPath: string;
  repositories: WorkspaceRepository[];
}

export interface RepositoryResult {
  repository: WorkspaceRepository;
  sha: string;
  changed?: boolean;
}

export interface IntegrationRepository extends WorkspaceRepository {
  inputShas: string[];
  expectedTargetSha: string | null;
  mergeStatus: "pending" | "conflict" | "merged";
  mergeError?: { code: string; message: string };
  publishedSha?: string;
}

export interface IntegrationWorkspace extends Omit<TaskWorkspace, "repositories"> {
  repositories: IntegrationRepository[];
}

export interface PublicationResult {
  repositoryId: string;
  sha: string;
  targetBranch: string;
  remote: string | null;
  pushed: boolean;
  localOnly: boolean;
}

export interface RepositoryDiscovery {
  path: string;
  relativePath: string;
  gitCommonDir: string;
  branch: string | null;
  hasCommit: boolean;
}

interface GitRepository {
  path: string;
  commonDir: string;
  head: string | null;
}

/** A deterministic, empty task mirror. Infrastructure metadata lives outside its cwd. */
export async function createTaskWorkspace(options: {
  projectPath: string;
  workspaceRoot: string;
  taskId: string;
}): Promise<TaskWorkspace> {
  return createWorkspace(options.projectPath, options.workspaceRoot, options.taskId, "task");
}

/** Removes a deleted task's worktrees and mirror. Task branches stay in their repositories. */
export async function removeTaskWorkspace(
  workspace: TaskWorkspace,
  workspaceRoot: string,
): Promise<void> {
  const parent = resolve(workspace.rootPath, "..");
  if (
    parent !== resolve(workspaceRoot, `task-${safeId(workspace.id)}`) ||
    workspace.rootPath !== join(parent, "workspace")
  )
    throw new WorkspaceError(
      "workspace_mismatch",
      "The task workspace is outside the board storage",
    );
  const repositories = [...workspace.repositories].sort(
    (a, b) => b.workspacePath.length - a.workspacePath.length,
  );
  for (const repository of repositories) {
    if (!within(workspace.rootPath, repository.workspacePath)) continue;
    if (!(await exists(repository.workspacePath))) continue;
    if (
      !(await gitSucceeds(repository.sourcePath, [
        "worktree",
        "remove",
        "--force",
        repository.workspacePath,
      ]))
    )
      await rm(repository.workspacePath, { recursive: true, force: true });
  }
  for (const source of new Set(repositories.map((repository) => repository.sourcePath)))
    await gitSucceeds(source, ["worktree", "prune"]);
  await rm(parent, { recursive: true, force: true });
}

/** Find original repositories without traversing dependency/runtime/worktree directories. */
export async function discoverRepositories(projectPath: string): Promise<RepositoryDiscovery[]> {
  const project = await canonicalDirectory(projectPath);
  const results: RepositoryDiscovery[] = [];
  const seen = new Set<string>();
  let visited = 0;
  async function visit(path: string, depth: number): Promise<void> {
    if (++visited > 20_000 || depth > 12) return;
    if (await exists(join(path, ".git"))) {
      const repository = await resolveRepository(path).catch(() => null);
      if (repository && repository.path === path && !seen.has(repository.commonDir)) {
        seen.add(repository.commonDir);
        results.push({
          path,
          relativePath: portable(relative(project, path)),
          gitCommonDir: repository.commonDir,
          branch: await gitOptional(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
          hasCommit: repository.head !== null,
        });
      }
    }
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIRECTORIES.has(entry.name))
        continue;
      await visit(join(path, entry.name), depth + 1);
    }
  }
  await visit(project, 0);
  return results;
}

/**
 * Materialize a repository only after its target has been determined. This never overlays
 * uncommitted files. Callers persist the mutated workspace after the operation succeeds.
 */
export async function prepareRepository(
  workspace: TaskWorkspace,
  options: {
    repositoryPath: string;
    targetBranch?: string;
    baseBranch?: string;
    excludeDirty?: boolean;
    initialize?: boolean;
    /** Explicit root-owned files for a new local repository; sensitive paths are rejected. */
    initialFiles?: string[];
  },
): Promise<WorkspaceRepository> {
  await refreshWorkspace(workspace);
  const requested = await canonicalDirectory(
    isAbsolute(options.repositoryPath)
      ? options.repositoryPath
      : join(workspace.projectPath, options.repositoryPath),
  );
  if (!within(workspace.projectPath, requested)) {
    throw new WorkspaceError("invalid_path", "Repository must belong to this project");
  }
  let source: GitRepository;
  try {
    source = await resolveRepository(requested);
  } catch (error) {
    if (!options.initialize) throw error;
    await initializeLocalRepository(requested, options.initialFiles);
    source = await resolveRepository(requested);
  }
  if (!within(workspace.projectPath, source.path) && !within(source.path, workspace.projectPath)) {
    throw new WorkspaceError("invalid_path", "Repository root is outside this project");
  }
  if (!source.head && options.initialize) {
    if (!within(workspace.projectPath, source.path)) {
      throw new WorkspaceError(
        "invalid_path",
        "Prepare the parent repository's initial commit from its own project",
      );
    }
    await initializeLocalRepository(source.path, options.initialFiles);
    source = await resolveRepository(source.path);
  }
  if (!source.head)
    throw new WorkspaceError(
      "unborn_repository",
      "Create the initial commit before preparing a worktree",
    );
  if (!options.targetBranch) {
    throw new WorkspaceError(
      "branch_required",
      "Determine the target branch before preparing this repository",
      { repositoryPath: source.path },
    );
  }
  await validateBranch(source.path, options.targetBranch);
  const id = digest(source.commonDir).slice(0, 20);
  const existing = workspace.repositories.find((item) => item.id === id);
  if (existing) {
    if (existing.targetBranch !== options.targetBranch) {
      throw new WorkspaceError(
        "target_already_selected",
        "This repository already has a different target in this task",
        { targetBranch: existing.targetBranch },
      );
    }
    await materializeRepository(workspace, existing);
    return existing;
  }
  const dirty = await gitText(source.path, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (dirty && !options.excludeDirty) {
    throw new WorkspaceError(
      "dirty_source",
      "Commit the source changes or explicitly exclude them from this task",
      { repositoryPath: source.path },
    );
  }
  const targetSha = await branchSha(source.path, options.targetBranch);
  if (!targetSha && !options.baseBranch) {
    throw new WorkspaceError(
      "base_branch_required",
      "A new target branch needs an explicit base branch or commit",
      { targetBranch: options.targetBranch },
    );
  }
  const baseSha = options.baseBranch
    ? await commitSha(source.path, options.baseBranch)
    : targetSha!;
  const relativePath = within(workspace.projectPath, source.path)
    ? portable(relative(workspace.projectPath, source.path))
    : "";
  const workspacePath = join(workspace.rootPath, relativePath);
  const remote = await selectedRemote(source.path, options.targetBranch);
  const metadata: WorkspaceRepository = {
    id,
    sourcePath: source.path,
    relativePath,
    gitCommonDir: source.commonDir,
    workspacePath,
    branch: `nest/task-${safeId(workspace.id)}-${id.slice(0, 8)}`,
    targetBranch: options.targetBranch,
    baseSha,
    targetSha,
    remote,
    ...(remote
      ? {
          remoteBranch: options.targetBranch,
          remoteFingerprint: await remoteFingerprint(source.path, remote),
        }
      : {}),
  };
  // Persist intent before touching Git: a retry can adopt an already-created worktree.
  workspace.repositories.push(metadata);
  await saveWorkspace(workspace);
  await materializeRepository(workspace, metadata);
  await saveWorkspace(workspace);
  return metadata;
}

/** Validate the exact, committed task results; an ended turn is not a successful result. */
export async function validateTaskWorkspace(
  workspace: TaskWorkspace,
  repositoryIds?: readonly string[],
): Promise<RepositoryResult[]> {
  await refreshWorkspace(workspace);
  const results: RepositoryResult[] = [];
  for (const repository of workspace.repositories) {
    if (repositoryIds && !repositoryIds.includes(repository.id)) continue;
    const sha = await validateResult(repository);
    await validateGitlinks(repository, sha);
    const changed = !(await gitSucceeds(repository.workspacePath, [
      "diff",
      "--quiet",
      repository.baseSha,
      sha,
      "--",
    ]));
    if (changed) results.push({ repository, sha, changed });
  }
  return results;
}

/** Build a separately resumable integration mirror, grouping inputs by repository+target. */
export async function prepareIntegrationWorkspace(options: {
  projectPath: string;
  workspaceRoot: string;
  integrationId: string;
  results: RepositoryResult[];
}): Promise<IntegrationWorkspace> {
  const workspace = (await createWorkspace(
    options.projectPath,
    options.workspaceRoot,
    options.integrationId,
    "integration",
  )) as IntegrationWorkspace;
  const grouped = new Map<string, RepositoryResult[]>();
  for (const result of options.results) {
    validateSha(result.sha);
    const key = `${result.repository.gitCommonDir}\0${result.repository.targetBranch}`;
    const group = grouped.get(key) ?? [];
    group.push(result);
    grouped.set(key, group);
  }
  // A single mirror cannot expose two revisions of the same repository at one path.
  const relativeTargets = new Map<string, string>();
  for (const group of grouped.values()) {
    const first = group[0]!.repository;
    const previous = relativeTargets.get(first.relativePath);
    if (previous && previous !== first.targetBranch) {
      throw new WorkspaceError(
        "target_already_selected",
        "Select separate integrations for different targets of the same repository",
      );
    }
    relativeTargets.set(first.relativePath, first.targetBranch);
  }
  for (const group of [...grouped.values()].sort(
    (a, b) => a[0]!.repository.relativePath.length - b[0]!.repository.relativePath.length,
  )) {
    const first = group[0]!.repository;
    const inputShas = [...new Set(group.map((item) => item.sha))];
    const id = `${digest(first.gitCommonDir).slice(0, 20)}-${digest(first.targetBranch).slice(0, 8)}`;
    const existing = workspace.repositories.find((item) => item.id === id);
    if (existing) {
      if (JSON.stringify(existing.inputShas) !== JSON.stringify(inputShas)) {
        throw new WorkspaceError(
          "workspace_mismatch",
          "Integration inputs changed; start a new integration",
        );
      }
      await materializeRepository(workspace, existing);
      // An unfinished conflict is deliberately left to the integration agent.
      const dirty = await gitText(existing.workspacePath, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]);
      if (!dirty) await mergeInputs(existing);
      await saveWorkspace(workspace);
      continue;
    }
    await verifyRepository(first);
    const expectedTargetSha = await branchSha(first.sourcePath, first.targetBranch);
    const repository: IntegrationRepository = {
      ...first,
      id,
      workspacePath: join(workspace.rootPath, first.relativePath),
      branch: `nest/integration-${safeId(workspace.id)}-${id.slice(0, 8)}-${digest(first.targetBranch).slice(0, 6)}`,
      baseSha: expectedTargetSha ?? first.baseSha,
      targetSha: expectedTargetSha,
      expectedTargetSha,
      inputShas,
      mergeStatus: "pending",
    };
    workspace.repositories.push(repository);
    await saveWorkspace(workspace);
    await materializeRepository(workspace, repository);
    await mergeInputs(repository);
    await saveWorkspace(workspace);
  }
  return workspace;
}

export async function validateIntegrationWorkspace(
  workspace: IntegrationWorkspace,
  repositoryIds?: readonly string[],
): Promise<RepositoryResult[]> {
  await refreshWorkspace(workspace);
  const results: RepositoryResult[] = [];
  for (const repository of workspace.repositories) {
    if (repositoryIds && !repositoryIds.includes(repository.id)) continue;
    const sha = await validateResult(repository);
    for (const input of repository.inputShas) {
      if (
        !(await gitSucceeds(repository.workspacePath, ["merge-base", "--is-ancestor", input, sha]))
      ) {
        throw new WorkspaceError(
          "unmerged_inputs",
          "Not all selected task results are included in the integration",
          { repositoryId: repository.id, inputSha: input },
        );
      }
    }
    await validateGitlinks(repository, sha);
    repository.mergeStatus = "merged";
    results.push({ repository, sha });
  }
  await saveWorkspace(workspace);
  return results;
}

/**
 * Promote only a clean, exact integration result. Local promotion and remote publication
 * are individually idempotent so a failed push can be retried without replaying merges.
 * The caller serializes publication per canonical common-dir + target and records each
 * successful repository before proceeding to the next repository in a multi-repo batch.
 */
export async function publishIntegrationRepository(
  repository: IntegrationRepository,
  options: { expectedSha: string; push?: boolean },
): Promise<PublicationResult> {
  validateSha(options.expectedSha);
  const sha = await validateResult(repository);
  if (sha !== options.expectedSha)
    throw new WorkspaceError(
      "result_changed",
      "The integration changed after publication was requested",
    );
  for (const input of repository.inputShas) {
    if (
      !(await gitSucceeds(repository.workspacePath, ["merge-base", "--is-ancestor", input, sha]))
    ) {
      throw new WorkspaceError(
        "unmerged_inputs",
        "An accepted task result is missing from the integration",
      );
    }
  }
  await validateGitlinks(repository, sha);
  if (
    repository.remote &&
    repository.remoteFingerprint !==
      (await remoteFingerprint(repository.sourcePath, repository.remote))
  ) {
    throw new WorkspaceError(
      "remote_changed",
      "The repository remote configuration changed; review the publication destination",
    );
  }
  const currentTarget = await branchSha(repository.sourcePath, repository.targetBranch);
  if (currentTarget !== sha) {
    if (
      currentTarget &&
      !(await gitSucceeds(repository.sourcePath, [
        "merge-base",
        "--is-ancestor",
        currentTarget,
        sha,
      ]))
    ) {
      throw new WorkspaceError(
        "target_changed",
        "Merge the current target into the integration worktree, rerun its checks, then retry publication",
        { targetBranch: repository.targetBranch, currentTargetSha: currentTarget },
      );
    }
    if (!currentTarget && repository.expectedTargetSha) {
      throw new WorkspaceError(
        "target_changed",
        "The target branch was deleted; confirm its intended destination before publication",
      );
    }
    // A deliberate retry may include a newly advanced target. The exact candidate is
    // revalidated above, and Git's fast-forward/CAS checks protect this promotion.
    repository.expectedTargetSha = currentTarget;
    const checkedOut = await targetWorktrees(repository.sourcePath, repository.targetBranch);
    if (checkedOut.length > 1)
      throw new WorkspaceError("target_changed", "The target is checked out in multiple worktrees");
    const targetPath = checkedOut[0];
    if (targetPath) {
      const dirty = await gitText(targetPath, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]);
      if (dirty)
        throw new WorkspaceError(
          "dirty_source",
          "The checked-out target has local changes; commit or preserve them before promotion",
          { repositoryPath: targetPath },
        );
      if ((await branchSha(targetPath, repository.targetBranch)) !== currentTarget)
        throw new WorkspaceError("target_changed", "The target branch changed during publication");
      await git(targetPath, ["merge", "--ff-only", "--no-edit", sha]);
    } else {
      await git(repository.sourcePath, [
        "update-ref",
        `refs/heads/${repository.targetBranch}`,
        sha,
        currentTarget ?? "0".repeat(sha.length),
      ]);
    }
  }
  if (repository.remote && options.push !== false) {
    try {
      await git(repository.sourcePath, [
        "push",
        "--porcelain",
        repository.remote,
        `${sha}:refs/heads/${repository.targetBranch}`,
      ]);
    } catch {
      throw new WorkspaceError(
        "push_failed",
        "The local integration is preserved, but remote publication failed; retry or resolve the remote branch state",
        { repositoryId: repository.id, sha },
      );
    }
  }
  repository.publishedSha = sha;
  return {
    repositoryId: repository.id,
    sha,
    targetBranch: repository.targetBranch,
    remote: repository.remote,
    pushed: repository.remote !== null && options.push !== false,
    localOnly: repository.remote === null,
  };
}

async function createWorkspace(
  projectPath: string,
  workspaceRoot: string,
  id: string,
  kind: "task" | "integration",
): Promise<TaskWorkspace> {
  const project = await canonicalDirectory(projectPath);
  const parent = resolve(workspaceRoot, `${kind}-${safeId(id)}`);
  await mkdir(parent, { recursive: true });
  const rootPath = join(parent, "workspace");
  const filename = join(parent, METADATA_FILE);
  if (await exists(filename)) {
    const existing = JSON.parse(await readFile(filename, "utf8")) as TaskWorkspace;
    if (existing.id !== id || existing.projectPath !== project || existing.rootPath !== rootPath) {
      throw new WorkspaceError(
        "workspace_mismatch",
        "A different task already owns this workspace",
      );
    }
    await mkdir(rootPath, { recursive: true });
    return existing;
  }
  await mkdir(rootPath, { recursive: true });
  const workspace: TaskWorkspace = { id, projectPath: project, rootPath, repositories: [] };
  await saveWorkspace(workspace);
  return workspace;
}

async function refreshWorkspace(workspace: TaskWorkspace): Promise<void> {
  const filename = join(resolve(workspace.rootPath, ".."), METADATA_FILE);
  if (!(await exists(filename)))
    throw new WorkspaceError("workspace_missing", "Workspace metadata is missing");
  const saved = JSON.parse(await readFile(filename, "utf8")) as TaskWorkspace;
  if (
    saved.id !== workspace.id ||
    saved.rootPath !== workspace.rootPath ||
    saved.projectPath !== workspace.projectPath
  ) {
    throw new WorkspaceError("workspace_mismatch", "Workspace metadata does not match this task");
  }
  workspace.repositories = saved.repositories;
}

async function saveWorkspace(workspace: TaskWorkspace): Promise<void> {
  const filename = join(resolve(workspace.rootPath, ".."), METADATA_FILE);
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(workspace), { mode: 0o600 });
  await rename(temporary, filename);
}

async function materializeRepository(
  workspace: TaskWorkspace,
  repository: WorkspaceRepository,
): Promise<void> {
  await restoreParkedRepositories(workspace, repository);
  const existing = await resolveRepository(repository.workspacePath).catch(() => null);
  if (
    existing?.path === repository.workspacePath &&
    existing.commonDir === repository.gitCommonDir
  ) {
    await verifyRepository(repository);
    return;
  }
  await validateSourceSymlinks(workspace, repository);
  // A parent can be requested after nested worktrees were already prepared. Move only
  // managed child worktrees aside, create the parent, then restore their exact layout.
  const children = workspace.repositories.filter(
    (item) => item.id !== repository.id && within(repository.workspacePath, item.workspacePath),
  );
  const moved: Array<{ repository: WorkspaceRepository; path: string }> = [];
  const parking = join(resolve(workspace.rootPath, ".."), `moving-${repository.id}`);
  let failure: unknown;
  try {
    for (const child of [...children].sort(
      (a, b) => b.workspacePath.length - a.workspacePath.length,
    )) {
      if (!(await exists(join(child.workspacePath, ".git")))) continue;
      await mkdir(parking, { recursive: true });
      const path = join(parking, child.id);
      await git(child.sourcePath, ["worktree", "move", child.workspacePath, path]);
      moved.push({ repository: child, path });
    }
    await removeEmptyParents(
      repository.workspacePath,
      moved.map((item) => item.repository.workspacePath),
    );
    await mkdir(resolve(repository.workspacePath, ".."), { recursive: true });
    const branch = await branchSha(repository.sourcePath, repository.branch);
    if (branch) {
      await git(repository.sourcePath, [
        "worktree",
        "add",
        repository.workspacePath,
        repository.branch,
      ]);
    } else {
      await git(repository.sourcePath, [
        "worktree",
        "add",
        "-b",
        repository.branch,
        repository.workspacePath,
        repository.baseSha,
      ]);
    }
  } catch (error) {
    failure = error;
  }
  try {
    await restoreParkedRepositories(workspace, repository);
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;
  await verifyRepository(repository);
}

async function restoreParkedRepositories(
  workspace: TaskWorkspace,
  parent: WorkspaceRepository,
): Promise<void> {
  const parking = join(resolve(workspace.rootPath, ".."), `moving-${parent.id}`);
  if (!(await exists(parking))) return;
  const children = workspace.repositories
    .filter((item) => item.id !== parent.id && within(parent.workspacePath, item.workspacePath))
    .sort((a, b) => a.workspacePath.length - b.workspacePath.length);
  for (const child of children) {
    const parked = join(parking, child.id);
    if (!(await exists(parked))) continue;
    await mkdir(resolve(child.workspacePath, ".."), { recursive: true });
    if (await exists(child.workspacePath)) {
      if ((await readdir(child.workspacePath)).length) {
        throw new WorkspaceError(
          "workspace_mismatch",
          "A parent tracks files at a nested repository path; its isolated worktree is preserved in the parking directory",
          { path: child.workspacePath, preservedPath: parked },
        );
      }
      await rm(child.workspacePath, { recursive: true });
    }
    await git(child.sourcePath, ["worktree", "move", parked, child.workspacePath]);
  }
  if ((await readdir(parking)).length === 0) await rm(parking, { recursive: true });
}

async function removeEmptyParents(root: string, children: string[]): Promise<void> {
  for (const child of children.sort((a, b) => b.length - a.length)) {
    let parent = resolve(child, "..");
    while (parent !== root && within(root, parent)) {
      if ((await exists(parent)) && (await readdir(parent)).length === 0)
        await rm(parent, { recursive: true });
      parent = resolve(parent, "..");
    }
  }
}

async function mergeInputs(repository: IntegrationRepository): Promise<void> {
  for (const sha of repository.inputShas) {
    if (await gitSucceeds(repository.workspacePath, ["merge-base", "--is-ancestor", sha, "HEAD"]))
      continue;
    try {
      await git(repository.workspacePath, ["merge", "--no-edit", sha]);
    } catch (error) {
      repository.mergeStatus = "conflict";
      repository.mergeError = {
        code: error instanceof WorkspaceError ? error.code : "git_failed",
        message: error instanceof WorkspaceError ? error.message : "Git merge failed",
      };
      return;
    }
  }
  repository.mergeStatus = "merged";
  delete repository.mergeError;
}

async function validateResult(repository: WorkspaceRepository): Promise<string> {
  await verifyRepository(repository);
  const branch = await gitOptional(repository.workspacePath, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  if (branch !== repository.branch)
    throw new WorkspaceError(
      "branch_changed",
      "Use the task or integration branch; the target branch must remain unchanged until publication",
    );
  const dirty = await gitText(repository.workspacePath, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (dirty)
    throw new WorkspaceError(
      "dirty_workspace",
      "Commit all intended changes and resolve unfinished merges before submitting the result",
      { repositoryId: repository.id },
    );
  const sha = await commitSha(repository.workspacePath, "HEAD");
  const mirrorRoot = repository.relativePath
    ? resolve(repository.workspacePath, ...repository.relativePath.split("/").map(() => ".."))
    : repository.workspacePath;
  await validateSymlinks(repository, sha, mirrorRoot);
  return sha;
}

async function validateSourceSymlinks(
  workspace: TaskWorkspace,
  repository: WorkspaceRepository,
): Promise<void> {
  await validateSymlinks(repository, repository.baseSha, workspace.rootPath);
}

async function validateSymlinks(
  repository: WorkspaceRepository,
  sha: string,
  mirrorRoot: string,
): Promise<void> {
  const entries = (await gitText(repository.sourcePath, ["ls-tree", "-r", "-z", sha])).split("\0");
  for (const entry of entries) {
    if (!entry.startsWith("120000 ")) continue;
    const path = entry.slice(entry.indexOf("\t") + 1);
    const target = await gitText(repository.sourcePath, ["show", `${sha}:${path}`]);
    if (
      isAbsolute(target) ||
      !within(mirrorRoot, resolve(repository.workspacePath, path, "..", target))
    ) {
      throw new WorkspaceError(
        "invalid_path",
        "A tracked symlink points outside the isolated task workspace",
        { path },
      );
    }
  }
}

async function validateGitlinks(repository: WorkspaceRepository, sha: string): Promise<void> {
  const base = await gitText(repository.workspacePath, ["ls-tree", "-r", "-z", repository.baseSha]);
  const final = await gitText(repository.workspacePath, ["ls-tree", "-r", "-z", sha]);
  const original = new Set(
    base
      .split("\0")
      .filter((line) => line.startsWith("160000 "))
      .map((line) => line.slice(line.indexOf("\t") + 1)),
  );
  const introduced = final
    .split("\0")
    .filter((line) => line.startsWith("160000 "))
    .map((line) => line.slice(line.indexOf("\t") + 1))
    .filter((path) => !original.has(path));
  if (introduced.length)
    throw new WorkspaceError(
      "unsafe_gitlink",
      "Nested repositories must be committed in their own repositories, without converting the parent into a submodule project",
      { paths: introduced },
    );
}

async function verifyRepository(repository: WorkspaceRepository): Promise<void> {
  const actual = await resolveRepository(repository.workspacePath).catch(() => null);
  if (
    !actual ||
    actual.path !== repository.workspacePath ||
    actual.commonDir !== repository.gitCommonDir
  ) {
    throw new WorkspaceError(
      "workspace_missing",
      "The prepared worktree is missing or belongs to a different repository",
      { repositoryId: repository.id },
    );
  }
  const source = await resolveRepository(repository.sourcePath);
  if (source.commonDir !== repository.gitCommonDir)
    throw new WorkspaceError("workspace_mismatch", "The source repository changed");
}

async function initializeLocalRepository(path: string, initialFiles?: string[]): Promise<void> {
  if (
    (await gitOptional(path, ["rev-parse", "--is-bare-repository"])) === "true" ||
    (await gitOptional(path, ["rev-parse", "--is-inside-git-dir"])) === "true"
  ) {
    throw new WorkspaceError(
      "invalid_git_directory",
      "Select a project working directory, not a bare repository or Git administrative directory",
    );
  }
  const gitDirectory = join(path, ".git");
  const existingRepository = await resolveRepository(path).catch(() => null);
  if (existingRepository?.head) return;
  if ((await exists(gitDirectory)) && !existingRepository) {
    const info = await lstat(gitDirectory);
    const entries = info.isDirectory() ? await readdir(gitDirectory) : [];
    const infoPath = join(gitDirectory, "info");
    const excludePath = join(infoPath, "exclude");
    const safeInfo = !(await exists(infoPath)) || (await lstat(infoPath)).isDirectory();
    const safeExclude = !(await exists(excludePath)) || (await lstat(excludePath)).isFile();
    const safeSkeleton =
      info.isDirectory() &&
      safeInfo &&
      safeExclude &&
      entries.every((name) => name === "info") &&
      (!(await exists(join(gitDirectory, "info"))) ||
        (await readdir(join(gitDirectory, "info"))).every((name) => name === "exclude"));
    if (!safeSkeleton)
      throw new WorkspaceError(
        "invalid_git_directory",
        "Existing Git metadata is not a valid repository; repair it before initialization",
      );
  }
  const children = (await discoverRepositories(path)).filter((item) => item.path !== path);
  const excludes = [
    ...children.map((item) => `/${escapeIgnore(item.relativePath)}/`),
    "/.worktrees/",
    "/.nest/",
    "/.claude/",
    "/.codex/",
    "/.agents/",
    "/.base*/",
    "/node_modules/",
    "/.venv/",
    "/logs/",
    "/reports/",
    "/artifacts/",
    "/output/",
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "uv.lock",
  ];
  // Validate every requested file before Git initialization changes the source metadata.
  const files =
    initialFiles ??
    (await readdir(path)).filter((name) =>
      /^(?:README(?:\.[\w-]+)?|AGENTS\.md|LICENSE(?:\.[\w-]+)?|\.gitignore|\.gitattributes|\.editorconfig)$/i.test(
        name,
      ),
    );
  if (existingRepository) {
    const staged = (await gitText(path, ["diff", "--cached", "--name-only", "-z", "--"]))
      .split("\0")
      .filter(Boolean);
    if (staged.length && (!initialFiles || staged.some((file) => !initialFiles.includes(file)))) {
      throw new WorkspaceError(
        "dirty_source",
        "The unborn repository already has staged files; make its initial commit or explicitly select every safe staged file",
        { stagedPaths: staged },
      );
    }
    if (staged.length && !(await gitSucceeds(path, ["diff", "--quiet", "--", ...staged]))) {
      throw new WorkspaceError(
        "dirty_source",
        "Staged and working versions differ; preserve that split by creating the initial commit yourself",
      );
    }
  }
  for (const file of files) {
    if (!safeInitialPath(file) || !within(path, resolve(path, file)))
      throw new WorkspaceError("invalid_path", "An initial snapshot path is unsafe or sensitive", {
        path: file,
      });
    const info = await lstat(join(path, file));
    if (
      !info.isFile() ||
      (await realpath(join(path, file))) !== join(path, file) ||
      info.size > 2 * 1024 * 1024 ||
      children.some((child) => within(child.path, join(path, file)))
    ) {
      throw new WorkspaceError(
        "invalid_path",
        "Initial snapshots accept only explicit, small, root-owned regular files",
        { path: file },
      );
    }
  }
  // Identity errors are actionable and must not leave a half-initialized source repo.
  await git(path, ["var", "GIT_AUTHOR_IDENT"]);
  await git(path, ["var", "GIT_COMMITTER_IDENT"]);
  if (!existingRepository) await git(path, ["init", "--quiet"]);
  const repository = await resolveRepository(path);
  const excludePath = join(repository.commonDir, "info", "exclude");
  if ((await exists(excludePath)) && !(await lstat(excludePath)).isFile()) {
    throw new WorkspaceError(
      "invalid_path",
      "The repository exclusion file must be a regular file",
    );
  }
  const existing = await readFile(excludePath, "utf8").catch(() => "");
  await writeFile(
    excludePath,
    `${existing}\n# Local Nest workspace: independent repositories and runtime files\n${excludes.join("\n")}\n`,
  );
  if (files.length) await git(path, ["add", "--", ...files]);
  await git(path, [
    "commit",
    "--allow-empty",
    "--quiet",
    "-m",
    "Initialize local project workspace",
  ]);
}

function safeInitialPath(path: string): boolean {
  return (
    !!path &&
    !isAbsolute(path) &&
    !path
      .split(/[\\/]/)
      .some(
        (part) =>
          part === ".." ||
          part === ".git" ||
          part === "uv.lock" ||
          SKIP_DIRECTORIES.has(part) ||
          /^\.(?:env|ssh|aws|claude|codex|agents)(?:$|\.)/i.test(part) ||
          /(?:secret|credential|wallet|private[-_]?key|auth[-_]?token|id_rsa|id_ed25519)/i.test(
            part,
          ) ||
          /\.(?:key|pem|p12|pfx|sqlite|db)$/i.test(part),
      )
  );
}

async function resolveRepository(path: string): Promise<GitRepository> {
  try {
    if ((await gitText(path, ["rev-parse", "--is-inside-work-tree"])) !== "true")
      throw new Error("not worktree");
    const root = await realpath(await gitText(path, ["rev-parse", "--show-toplevel"]));
    const commonDir = await realpath(
      await gitText(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    );
    const head = await gitOptional(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
    return { path: root, commonDir, head };
  } catch {
    throw new WorkspaceError("not_repository", "The selected path is not a valid Git working tree");
  }
}

async function canonicalDirectory(path: string): Promise<string> {
  const canonical = await realpath(path).catch(() => {
    throw new WorkspaceError("invalid_path", "The directory does not exist");
  });
  if (!(await lstat(canonical)).isDirectory())
    throw new WorkspaceError("invalid_path", "Expected a directory");
  return canonical;
}

async function validateBranch(path: string, branch: string): Promise<void> {
  if (
    !branch ||
    branch.startsWith("-") ||
    branch === "HEAD" ||
    branch.startsWith("refs/") ||
    !(await gitSucceeds(path, ["check-ref-format", "--branch", branch]))
  ) {
    throw new WorkspaceError("invalid_branch", "Specify a valid local target branch name");
  }
}

async function commitSha(path: string, revision: string): Promise<string> {
  const sha = await gitOptional(path, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${revision}^{commit}`,
  ]);
  if (!sha)
    throw new WorkspaceError(
      "base_branch_required",
      "The selected branch or base commit does not exist",
    );
  validateSha(sha);
  return sha;
}

async function branchSha(path: string, branch: string): Promise<string | null> {
  return gitOptional(path, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
}

async function selectedRemote(path: string, branch: string): Promise<string | null> {
  const configured = await gitOptional(path, ["config", "--get", `branch.${branch}.remote`]);
  const remotes = (await gitText(path, ["remote"])).split("\n").filter(Boolean);
  if (configured && configured !== "." && remotes.includes(configured)) return configured;
  if (remotes.includes("origin")) return "origin";
  if (remotes.length === 1) return remotes[0]!;
  if (remotes.length > 1)
    throw new WorkspaceError(
      "branch_required",
      "Configure the target branch upstream to choose among multiple remotes",
    );
  return null;
}

async function remoteFingerprint(path: string, remote: string): Promise<string> {
  const urls = await gitOptional(path, ["config", "--get-all", `remote.${remote}.url`]);
  const pushUrls = await gitOptional(path, ["config", "--get-all", `remote.${remote}.pushurl`]);
  return digest(JSON.stringify([urls, pushUrls]));
}

async function targetWorktrees(path: string, branch: string): Promise<string[]> {
  const entries = (await gitText(path, ["worktree", "list", "--porcelain", "-z"])).split("\0");
  const results: string[] = [];
  let worktree: string | undefined;
  for (const entry of entries) {
    if (entry.startsWith("worktree ")) worktree = entry.slice(9);
    else if (entry === `branch refs/heads/${branch}` && worktree) results.push(worktree);
    else if (!entry) worktree = undefined;
  }
  return results;
}

async function git(path: string, args: string[]): Promise<string> {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      /^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)/.test(
        key,
      )
    )
      delete env[key];
  env.GIT_TERMINAL_PROMPT = "0";
  try {
    const result = await execFileAsync("git", ["-C", path, ...args], {
      env,
      timeout: GIT_TIMEOUT,
      maxBuffer: 32 * 1024 * 1024,
      encoding: "utf8",
    });
    return result.stdout;
  } catch (error) {
    // Git stderr can contain authenticated remote URLs; never expose it to UI/tool errors.
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : "";
    if (/identity unknown|unable to auto-detect email|empty ident name/i.test(stderr)) {
      throw new WorkspaceError(
        "identity_required",
        "Configure the Git author and committer identity according to this repository's instructions before creating commits",
      );
    }
    throw new WorkspaceError("git_failed", `Git ${args[0] ?? "operation"} failed`);
  }
}

async function gitText(path: string, args: string[]): Promise<string> {
  return (await git(path, args)).trimEnd();
}
async function gitOptional(path: string, args: string[]): Promise<string | null> {
  try {
    return (await gitText(path, args)) || null;
  } catch {
    return null;
  }
}
async function gitSucceeds(path: string, args: string[]): Promise<boolean> {
  try {
    await git(path, args);
    return true;
  } catch {
    return false;
  }
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function portable(path: string): string {
  return path.split(sep).join("/");
}
function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}
function safeId(id: string): string {
  if (!id || !/^[A-Za-z0-9_-]{1,120}$/.test(id))
    throw new WorkspaceError("invalid_path", "Invalid workspace identifier");
  return id;
}
function validateSha(sha: string): void {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sha))
    throw new WorkspaceError("result_changed", "Expected a complete Git commit SHA");
}
function escapeIgnore(path: string): string {
  return path.replace(/[\\*?[\]#! ]/g, "\\$&");
}
