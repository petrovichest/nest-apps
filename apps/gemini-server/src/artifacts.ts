import { constants } from "node:fs";
import { access, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SessionArtifact, ThreadArtifactsResponse } from "@codexnest/protocol";

export type StoredArtifactRecord = {
  id: string;
  label?: string;
  path: string;
  summary?: string | null;
  createdAt: number;
  updatedAt?: number;
  turnId: string | null;
};

const IGNORED_BRAIN_DIRS = new Set([".system_generated", ".user_uploaded", "scratch"]);

function pathContains(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function brainDirectory(
  nativeDir: string,
  nativeId: string | null | undefined,
): string | null {
  if (!nativeId || !/^[a-zA-Z0-9._-]+$/.test(nativeId)) return null;
  return join(nativeDir, "gemininest", "brain", nativeId);
}

export async function isAuthorizedBrainArtifactPath(
  nativeDir: string,
  nativeId: string | null | undefined,
  filePath: string,
): Promise<{ root: string; path: string } | null> {
  const brainDir = brainDirectory(nativeDir, nativeId);
  if (!brainDir) return null;
  let resolvedBrain: string;
  let resolvedFile: string;
  try {
    [resolvedBrain, resolvedFile] = await Promise.all([realpath(brainDir), realpath(filePath)]);
  } catch {
    return null;
  }
  if (!pathContains(resolvedBrain, resolvedFile)) return null;
  const rel = relative(resolvedBrain, resolvedFile).split(sep);
  if (
    !rel.length ||
    rel.some((segment) => !segment || segment.startsWith(".")) ||
    IGNORED_BRAIN_DIRS.has(rel[0]!)
  ) {
    return null;
  }
  if (resolvedFile.endsWith(".metadata.json")) return null;
  return { root: resolvedBrain, path: resolvedFile };
}

async function walkBrainArtifacts(rootDir: string, currentDir = rootDir): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || IGNORED_BRAIN_DIRS.has(entry.name)) continue;
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkBrainArtifacts(rootDir, fullPath)));
    } else if (entry.isFile() && !entry.name.endsWith(".metadata.json")) {
      files.push(fullPath);
    }
  }
  return files;
}

async function readMetadataSummary(
  filePath: string,
): Promise<{ summary: string | null; hidden: boolean }> {
  try {
    const raw = await readFile(`${filePath}.metadata.json`, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const hidden = parsed.UserFacing === false || parsed.userFacing === false;
    const summaryText =
      typeof parsed.Summary === "string"
        ? parsed.Summary.trim()
        : typeof parsed.summary === "string"
          ? parsed.summary.trim()
          : "";
    return { summary: summaryText || null, hidden };
  } catch {
    return { summary: null, hidden: false };
  }
}

export async function resolveGeminiSessionArtifacts(options: {
  cwd: string;
  nativeDir: string;
  nativeId: string | null | undefined;
  stored?: StoredArtifactRecord[];
  latestTurnId?: string | null;
}): Promise<ThreadArtifactsResponse & { stored: StoredArtifactRecord[] }> {
  const artifacts: SessionArtifact[] = [];
  const seenPaths = new Set<string>();
  const cwdRoot = await realpath(options.cwd).catch(() => resolve(options.cwd));
  const fallbackTurnId = options.latestTurnId ?? "";

  for (const item of options.stored ?? []) {
    const rawPath = item.path.trim();
    if (!rawPath) continue;
    const candidatePath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwdRoot, rawPath);
    try {
      const [realCandidate, info] = await Promise.all([
        realpath(candidatePath),
        stat(candidatePath),
        access(candidatePath, constants.R_OK),
      ]);
      if (!pathContains(cwdRoot, realCandidate) || !info.isFile()) continue;
      if (seenPaths.has(realCandidate)) continue;
      seenPaths.add(realCandidate);
      const relativePath = relative(cwdRoot, realCandidate).split(sep).join("/");
      const fileName = basename(realCandidate);
      artifacts.push({
        id: item.id,
        label: item.label?.trim() || item.summary?.trim() || fileName,
        path: realCandidate,
        relativePath: relativePath || fileName,
        fileName,
        turnId: item.turnId ?? fallbackTurnId,
        createdAt: item.createdAt,
      });
    } catch {
      continue;
    }
  }

  const brainDir = brainDirectory(options.nativeDir, options.nativeId);
  if (brainDir) {
    const resolvedBrain = await realpath(brainDir).catch(() => null);
    if (resolvedBrain) {
      const files = await walkBrainArtifacts(resolvedBrain);
      for (const filePath of files) {
        try {
          const [resolvedFile, info, meta] = await Promise.all([
            realpath(filePath),
            stat(filePath),
            readMetadataSummary(filePath),
          ]);
          if (meta.hidden || !info.isFile() || !pathContains(resolvedBrain, resolvedFile)) continue;
          if (seenPaths.has(resolvedFile)) continue;
          seenPaths.add(resolvedFile);
          const relPath = relative(resolvedBrain, resolvedFile).split(sep).join("/");
          const fileName = basename(resolvedFile);
          const createdAt = Math.trunc(info.mtimeMs || info.ctimeMs || Date.now());
          artifacts.push({
            id: `brain:${relPath}`,
            label: meta.summary || fileName,
            path: resolvedFile,
            relativePath: relPath || fileName,
            fileName,
            turnId: fallbackTurnId,
            createdAt,
          });
        } catch {
          continue;
        }
      }
    }
  }

  artifacts.sort(
    (left, right) =>
      right.createdAt - left.createdAt || left.fileName.localeCompare(right.fileName),
  );
  return {
    capability: "explicit",
    artifacts,
    stored: options.stored ?? [],
  };
}
