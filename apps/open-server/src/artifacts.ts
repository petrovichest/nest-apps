import { randomUUID } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { FastifyInstance } from "fastify";
import type { SessionArtifact } from "@codexnest/protocol";
import { AppError, object, text, type Engine } from "./engine";
import { nativeFilePath } from "./projection";

function inside(root: string, path: string) {
  const nested = relative(root, path);
  return nested !== ".." && !nested.startsWith(`..${sep}`) && !isAbsolute(nested);
}
export async function publishArtifact(
  engine: Engine,
  id: string,
  input: { path: string; label?: string },
): Promise<SessionArtifact> {
  const thread = engine.thread(id);
  const root = await realpath(thread.summary.cwd);
  const path = await realpath(resolve(root, text(input.path, "path", 4096)));
  if (!inside(root, path))
    throw new AppError("forbidden", "The artifact must be inside the task directory", 403);
  if (!(await stat(path)).isFile())
    throw new AppError("validation_failed", "The artifact must be a regular file");
  const artifact = {
    id: randomUUID(),
    label: input.label ? text(input.label, "label", 500) : basename(path),
    path,
    relativePath: relative(root, path),
    fileName: basename(path),
    createdAt: Date.now(),
    turnId: thread.summary.currentTurnId ?? engine.detail(id).turns.at(-1)?.id ?? "",
  };
  thread.artifacts = [
    artifact,
    ...(thread.artifacts ?? []).filter((previous) => previous.path !== path),
  ];
  thread.summary.updatedAt = Date.now();
  await engine.save();
  engine.changed(id);
  return artifact;
}
export function registerArtifactRoutes(app: FastifyInstance, engine: Engine) {
  const tickets = new Map<
    string,
    { path: string; name: string; expiresAt: number; dev: number; ino: number }
  >();
  app.get<{ Params: { id: string } }>("/api/v1/threads/:id/artifacts", async (request) => {
    const thread = engine.thread(request.params.id),
      root = await realpath(thread.summary.cwd);
    const artifacts: SessionArtifact[] = [];
    for (const artifact of thread.artifacts ?? []) {
      try {
        const path = await realpath(artifact.path);
        if (inside(root, path) && (await stat(path)).isFile())
          artifacts.push({ ...artifact, path });
      } catch {
        /* Deleted artifacts are not offered as available downloads. */
      }
    }
    return { capability: "explicit", artifacts };
  });
  app.post<{ Params: { id: string } }>("/api/v1/threads/:id/downloads", async (request) => {
    const id = request.params.id,
      cwd = await realpath(engine.thread(id).summary.cwd);
    const path = await realpath(resolve(cwd, text(object(request.body).path, "path", 4096)));
    let attachment = await engine.attachments.resolveDownload(id, path);
    let ancestor = engine.thread(id).summary.relation;
    const visited = new Set<string>([id]);
    while (
      !attachment &&
      ancestor.kind === "session" &&
      ancestor.forkedFromId &&
      !visited.has(ancestor.forkedFromId)
    ) {
      const parentId = ancestor.forkedFromId;
      visited.add(parentId);
      if (!engine.data.threads[parentId]) break;
      attachment = await engine.attachments.resolveDownload(parentId, path);
      ancestor = engine.thread(parentId).summary.relation;
    }
    const nativeAttachment = engine
      .nativeMessages(id)
      .some((message) =>
        message.parts.some(
          (part) =>
            (part.type === "file" && nativeFilePath(part.url) === path) ||
            part.state?.attachments?.some((candidate) => nativeFilePath(candidate.url) === path),
        ),
      );
    if (!inside(cwd, path) && !attachment && !nativeAttachment)
      throw new AppError("forbidden", "The file is outside this task directory", 403);
    const info = await stat(path);
    if (!info.isFile()) throw new AppError("validation_failed", "Choose a regular file");
    const token = randomUUID(),
      expiresAt = Date.now() + 60_000;
    for (const [key, value] of tickets) if (value.expiresAt <= Date.now()) tickets.delete(key);
    tickets.set(token, { path, name: basename(path), expiresAt, dev: info.dev, ino: info.ino });
    return {
      downloadUrl: `/api/v1/downloads/${token}`,
      expiresAt,
      fileName: basename(path),
      size: info.size,
    };
  });
  app.get<{ Params: { ticket: string } }>("/api/v1/downloads/:ticket", async (request, reply) => {
    const ticket = tickets.get(request.params.ticket);
    if (!ticket || ticket.expiresAt <= Date.now())
      throw new AppError("not_found", "Download link expired", 404);
    const handle = await open(ticket.path, "r");
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.dev !== ticket.dev ||
        info.ino !== ticket.ino ||
        (await realpath(ticket.path)) !== ticket.path
      )
        throw new AppError("conflict", "The file changed. Request a new download link.", 409);
      return reply
        .header(
          "Content-Disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(ticket.name)}`,
        )
        .header("Cache-Control", "no-store")
        .send(handle.createReadStream());
    } catch (error) {
      await handle.close();
      throw error;
    }
  });
}
