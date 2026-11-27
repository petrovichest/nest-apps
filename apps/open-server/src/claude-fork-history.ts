import { constants, createReadStream } from "node:fs";
import { link, lstat, open, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { ForkThreadRequest, ThreadFileAttachment } from "@codexnest/protocol";
import { transcriptPaths } from "../../claude-server/src/history";
import { hasNativeAssistantText, userContent } from "../../claude-server/src/native-view";
import { AppError, UUID_PATTERN } from "../../claude-server/src/types";
import type { UiService } from "../../claude-server/src/ui-service";

type Entry = Record<string, unknown> & { uuid: string; sessionId: string };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function entry(value: unknown, sessionId: string): value is Entry {
  return (
    object(value) &&
    value.isSidechain !== true &&
    !value.parent_tool_use_id &&
    typeof value.uuid === "string" &&
    UUID_PATTERN.test(value.uuid) &&
    typeof value.sessionId === "string" &&
    value.sessionId.toLowerCase() === sessionId
  );
}

async function* rows(path: string, start = 0): AsyncGenerator<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error("Transcript is not a regular file");
    const input = file.createReadStream({ start, encoding: "utf8", autoClose: false });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          // A concurrently appended final line may be incomplete. Missing chain links fail closed.
          continue;
        }
        yield value;
      }
    } finally {
      lines.close();
      input.destroy();
    }
  } finally {
    await file.close();
  }
}

const unavailable = () => new AppError("conflict", "The native fork boundary is unavailable", 409);

export async function readClaudeForkPoint(ui: UiService, id: string, point: ForkThreadRequest) {
  const source = ui.thread(id);
  if (source.subagent)
    throw new AppError("conflict", "A subagent is controlled by its parent session", 409);
  const detail = await ui.refresh(source.id);
  if (["running", "queued", "needsAttention"].includes(detail.summary.state))
    throw new AppError("conflict", "Finish the active turn before branching", 409);
  const turn = detail.turns.find((candidate) => candidate.id === point.lastTurnId);
  const answer = turn?.items.find((item) => item.id === point.agentMessageId);
  if (
    turn?.status !== "completed" ||
    answer?.type !== "agentMessage" ||
    answer.phase !== "final_answer"
  )
    throw new AppError("conflict", "The selected final answer is no longer available", 409);

  const configDir = ui.manager.config.configDir;
  const path = (await transcriptPaths(configDir)).get(source.id);
  if (!path) throw unavailable();
  const preceding = new Map<string, Entry>();
  let selected: Entry | undefined;
  for await (const value of rows(path)) {
    if (!entry(value, source.id)) continue;
    if (!selected) preceding.set(value.uuid, value);
    if (hasNativeAssistantText(value, answer.id, answer.text)) {
      if (selected && selected.uuid !== value.uuid) throw unavailable();
      selected = value;
    }
  }
  if (!selected) throw unavailable();

  // Match native resume-at semantics. A line before the cutoff is inherited only
  // if it belongs to that conversation chain, including pre-compaction display history.
  const prefix: Entry[] = [];
  for (let current: Entry | undefined = selected; current;) {
    prefix.push(current);
    preceding.delete(current.uuid);
    const parent: unknown = current.parentUuid;
    const logicalParent =
      current.type === "system" && current.subtype === "compact_boundary"
        ? current.logicalParentUuid
        : undefined;
    const previous: unknown = typeof parent === "string" ? parent : logicalParent;
    current = typeof previous === "string" ? preceding.get(previous) : undefined;
    if (typeof parent === "string" && !current) throw unavailable();
  }
  prefix.reverse();
  if (!prefix.some((value) => value.uuid === point.lastTurnId && value.type === "user"))
    throw unavailable();
  return {
    source,
    sourcePath: path,
    uuid: selected.uuid,
    prefix,
    bytes: prefix.reduce((total, value) => total + Buffer.byteLength(JSON.stringify(value)) + 1, 0),
  };
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

const stagingPath = (path: string) => `${path}.nest-fork`;

export async function stageClaudeFork(
  ui: UiService,
  point: Awaited<ReturnType<typeof readClaudeForkPoint>>,
  targetId: string,
): Promise<{ transcriptPath: string; prefixBytes: number }> {
  const transcriptPath = join(dirname(point.sourcePath), `${targetId}.jsonl`);
  const staged = stagingPath(transcriptPath);
  const paths = new Map<string, string>();
  const checked = new Set<string>();
  const escapePath = (path: string) => JSON.stringify(path).slice(1, -1);
  const rebind = (source: string, target: string) => {
    paths.set(source, target);
    paths.set(escapePath(source), escapePath(target));
  };
  // A native compact summary can invite the owner to read its full transcript.
  // Restrict that reference to the fork's frozen history as well.
  rebind(point.sourcePath, transcriptPath);
  const handle = await open(staged, "wx", 0o600);
  let prefixBytes = 0;
  try {
    for (const value of point.prefix) {
      if (value.type !== "user" || !object(value.message)) continue;
      for (const { path } of userContent(value.message.content).files) {
        if (checked.has(path)) continue;
        checked.add(path);
        const file = await ui.attachments.resolveDownload(point.source.id, path);
        if (!file) continue;
        const ref: ThreadFileAttachment = {
          id: basename(dirname(file.path)),
          name: file.fileName,
          mediaType: "application/octet-stream",
          path: file.path,
          size: file.size,
        };
        await ui.attachments.validate(point.source.id, [ref]);
        const copy = await ui.attachments.save(
          targetId,
          ref.name,
          ref.mediaType,
          createReadStream(ref.path),
          ref.size,
        );
        rebind(ref.path, copy.path);
      }
    }

    const rewritePath = (_key: string, value: unknown) => {
      if (typeof value !== "string") return value;
      let rewritten = value;
      for (const [from, to] of paths) rewritten = rewritten.replaceAll(from, to);
      return rewritten;
    };
    for (const value of point.prefix) {
      const line = JSON.stringify({ ...value, sessionId: targetId }, rewritePath) + "\n";
      await handle.writeFile(line);
      prefixBytes += Buffer.byteLength(line);
    }
    await handle.sync();
    await syncDirectory(staged);
    return { transcriptPath, prefixBytes };
  } catch (error) {
    await unlink(staged).catch(() => undefined);
    await ui.attachments.removeThread(targetId).catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
}

async function stagedStat(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
}

/** Install the frozen prefix without ever replacing an existing native session. */
export async function installClaudeFork(path: string, prefixBytes: number): Promise<void> {
  const staged = stagingPath(path);
  const source = await stagedStat(staged);
  const target = await stagedStat(path);
  if (!source) {
    if (target?.isFile() && target.size >= prefixBytes) return;
    throw new Error("The saved fork prefix is missing");
  }
  if (!source.isFile() || source.size !== prefixBytes)
    throw new Error("The saved fork prefix is incomplete");
  if (!target) await link(staged, path);
  else if (source.dev !== target.dev || source.ino !== target.ino)
    throw new Error("The native fork target belongs to another session");
  await syncDirectory(path);
  await unlink(staged);
  await syncDirectory(path);
}

export async function syncClaudeFork(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function discardStagedClaudeFork(path: string): Promise<void> {
  await unlink(stagingPath(path)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

/** Check for a fresh native summary linked to a manual boundary written by this fork. */
export async function hasClaudeForkCompaction(
  path: string,
  targetId: string,
  prefixBytes: number,
): Promise<boolean> {
  let boundary: string | undefined;
  for await (const value of rows(path, prefixBytes)) {
    if (!entry(value, targetId)) continue;
    if (
      value.type === "system" &&
      value.subtype === "compact_boundary" &&
      object(value.compactMetadata) &&
      value.compactMetadata.trigger === "manual"
    ) {
      boundary = value.uuid;
      continue;
    }
    if (
      boundary &&
      value.type === "user" &&
      value.isCompactSummary === true &&
      value.parentUuid === boundary &&
      object(value.message) &&
      userContent(value.message.content).text.trim()
    )
      return true;
  }
  return false;
}
