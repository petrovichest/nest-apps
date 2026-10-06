import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type { GitChangesSummary } from "@codexnest/protocol";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;

type GitOptions = {
  binary?: string;
  timeoutMs?: number;
  maxBuffer?: number;
};

type GitRuntimeOptions = GitOptions & { deadline: number };

export async function readGitChanges(
  cwd: string,
  options: GitOptions = {},
): Promise<GitChangesSummary> {
  const runtimeOptions = {
    ...options,
    deadline: Date.now() + (options.timeoutMs ?? GIT_TIMEOUT_MS),
  };
  let repositoryRoot: string;
  try {
    repositoryRoot = (await git(cwd, ["rev-parse", "--show-toplevel"], runtimeOptions)).trim();
  } catch (error) {
    if (isNotRepository(error)) return emptySummary("notRepository");
    throw error;
  }

  const statusOutput = await git(
    cwd,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    runtimeOptions,
  );
  const entries = parseStatus(statusOutput);
  if (entries.length === 0) return emptySummary("clean");

  const hasHead = await gitHasHead(cwd, runtimeOptions);
  if (!hasHead) {
    const additions = await countCurrentLines(repositoryRoot, entries, runtimeOptions.deadline);
    return {
      state: "dirty",
      filesChanged: entries.length,
      additions,
      deletions: 0,
    };
  }

  const trackedStats = parseNumstat(
    await git(cwd, ["diff", "--numstat", "-z", "HEAD"], runtimeOptions),
  );
  const untrackedAdditions = await countCurrentLines(
    repositoryRoot,
    entries.filter((entry) => entry.status === "??"),
    runtimeOptions.deadline,
  );
  return {
    state: "dirty",
    filesChanged: entries.length,
    additions: trackedStats.additions + untrackedAdditions,
    deletions: trackedStats.deletions,
  };
}

type StatusEntry = {
  status: string;
  path: string;
};

function parseStatus(output: string): StatusEntry[] {
  const fields = output.split("\0");
  const entries: StatusEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    const status = field.slice(0, 2);
    entries.push({ status, path: field.slice(3) });
    if (status.includes("R") || status.includes("C")) index += 1;
  }
  return entries;
}

function parseNumstat(output: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const field of output.split("\0")) {
    const match = /^(\d+|-)\t(\d+|-)\t/.exec(field);
    if (!match) continue;
    if (match[1] !== "-") additions += Number(match[1]);
    if (match[2] !== "-") deletions += Number(match[2]);
  }
  return { additions, deletions };
}

async function gitHasHead(cwd: string, options: GitRuntimeOptions): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--verify", "HEAD"], options);
    return true;
  } catch (error) {
    if (isExitCode(error, 128)) return false;
    throw error;
  }
}

async function countCurrentLines(
  repositoryRoot: string,
  entries: StatusEntry[],
  deadline: number,
): Promise<number> {
  let additions = 0;
  for (const entry of entries) {
    if (entry.status.includes("D")) continue;
    additions += await countTextLines(resolve(repositoryRoot, entry.path), deadline);
  }
  return additions;
}

async function countTextLines(path: string, deadline: number): Promise<number> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) return (await readlink(path)).length > 0 ? 1 : 0;
  if (!metadata.isFile() || metadata.size === 0) return 0;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remainingTime(deadline));
  let lines = 0;
  let lastByte = -1;
  try {
    for await (const chunk of createReadStream(path, { signal: controller.signal })) {
      const buffer = chunk as Buffer;
      if (buffer.includes(0)) return 0;
      for (const byte of buffer) if (byte === 10) lines += 1;
      lastByte = buffer.at(-1) ?? lastByte;
    }
    return lines + (lastByte === 10 ? 0 : 1);
  } finally {
    clearTimeout(timer);
  }
}

async function git(cwd: string, args: string[], options: GitRuntimeOptions): Promise<string> {
  const { stdout } = await execFileAsync(options.binary ?? "git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: remainingTime(options.deadline),
    maxBuffer: options.maxBuffer ?? GIT_MAX_BUFFER,
  });
  return stdout;
}

function remainingTime(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function isNotRepository(error: unknown): boolean {
  return (
    isExitCode(error, 128) &&
    typeof (error as { stderr?: unknown }).stderr === "string" &&
    (error as { stderr: string }).stderr.includes("not a git repository")
  );
}

function isExitCode(error: unknown, code: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function emptySummary(state: "clean" | "notRepository"): GitChangesSummary {
  return { state, filesChanged: 0, additions: 0, deletions: 0 };
}
