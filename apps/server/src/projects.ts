import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { DirectoryEntry, DirectoryListing, Project } from "@codexnest/protocol";

export async function canonicalProjectPath(input: string, root = homedir()): Promise<string> {
  const resolved = await resolveDirectory(input, root);
  return resolved.canonicalPath;
}

export async function listDirectories(
  input: string | undefined,
  root = homedir(),
): Promise<DirectoryListing> {
  const current = await resolveDirectory(input ?? resolve(root), root);
  const entries = await readdir(current.path, { withFileTypes: true }).catch((error: unknown) =>
    throwFilesystemError(error, "Directory could not be read"),
  );

  const directories = (
    await Promise.all(
      entries.map(async (entry): Promise<DirectoryEntry | null> => {
        const path = join(current.path, entry.name);
        if (entry.isDirectory()) return { name: entry.name, path };
        if (!entry.isSymbolicLink()) return null;
        try {
          const [info, canonicalPath] = await Promise.all([stat(path), realpath(path)]);
          if (!info.isDirectory() || !pathContains(current.rootCanonicalPath, canonicalPath)) {
            return null;
          }
          return { name: entry.name, path };
        } catch {
          return null;
        }
      }),
    )
  ).filter((entry): entry is DirectoryEntry => entry !== null);
  directories.sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }),
  );

  return {
    rootPath: current.rootPath,
    path: current.path,
    parentPath: current.path === current.rootPath ? null : dirname(current.path),
    directories,
  };
}

export async function createDirectory(
  parentPath: string,
  name: string,
  root = homedir(),
): Promise<DirectoryListing> {
  const trimmedName = name.trim();
  if (
    !trimmedName ||
    trimmedName === "." ||
    trimmedName === ".." ||
    /[\\/]/.test(trimmedName) ||
    trimmedName.includes("\0")
  ) {
    throw new ProjectValidationError("Invalid directory name");
  }
  const parent = await resolveDirectory(parentPath, root);
  const path = join(parent.path, trimmedName);
  try {
    await mkdir(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new ProjectConflictError("Directory already exists");
    throwFilesystemError(error, "Directory could not be created");
  }
  return {
    rootPath: parent.rootPath,
    path,
    parentPath: parent.path,
    directories: [],
  };
}

export function createProject(selectedPath: string, canonicalPath: string): Project {
  const displayName = basename(resolve(selectedPath)) || basename(canonicalPath) || canonicalPath;
  if (!displayName) throw new ProjectValidationError("Project name could not be determined");
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    displayName,
    path: canonicalPath,
    createdAt: now,
    updatedAt: now,
  };
}

export function assertUniqueProjectPath(
  projects: readonly Project[],
  path: string,
  exceptId?: string,
): void {
  if (projects.some((project) => project.id !== exceptId && project.path === path)) {
    throw new ProjectConflictError("This project directory is already registered");
  }
}

export function projectForCwd(projects: readonly Project[], cwd: string): Project | undefined {
  const normalized = resolve(cwd);
  return projects
    .filter((project) => pathContains(project.path, normalized))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

export function pathContains(parent: string, candidate: string): boolean {
  const difference = relative(parent, candidate);
  return (
    difference === "" ||
    (!difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference))
  );
}

async function resolveDirectory(input: string, root: string): Promise<ResolvedDirectory> {
  const rootPath = resolve(root);
  if (!isAbsolute(input)) throw new ProjectValidationError("Directory path must be absolute");
  const path = resolve(input);
  if (!pathContains(rootPath, path)) {
    throw new ProjectValidationError("Directory path must stay inside the project root");
  }

  let rootCanonicalPath: string;
  let canonicalPath: string;
  let info: Stats;
  try {
    [rootCanonicalPath, canonicalPath, info] = await Promise.all([
      realpath(rootPath),
      realpath(path),
      stat(path),
    ]);
  } catch (error) {
    throwFilesystemError(error, "Directory could not be opened");
  }
  if (!info.isDirectory()) throw new ProjectValidationError("Path must be a directory");
  if (!pathContains(rootCanonicalPath, canonicalPath)) {
    throw new ProjectValidationError("Directory path must stay inside the project root");
  }
  return { rootPath, rootCanonicalPath, path, canonicalPath };
}

function throwFilesystemError(error: unknown, fallback: string): never {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") {
    throw new ProjectNotFoundError("Directory does not exist");
  }
  if (code === "EACCES" || code === "EPERM") {
    throw new ProjectForbiddenError("Directory is not accessible");
  }
  if (code === "EINVAL" || code === "ENAMETOOLONG") {
    throw new ProjectValidationError("Invalid directory path");
  }
  throw new Error(fallback, { cause: error });
}

interface ResolvedDirectory {
  rootPath: string;
  rootCanonicalPath: string;
  path: string;
  canonicalPath: string;
}

export class ProjectValidationError extends Error {}
export class ProjectConflictError extends Error {}
export class ProjectNotFoundError extends Error {}
export class ProjectForbiddenError extends Error {}
