import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import type { FastifyInstance } from "fastify";
import type { SkillsCatalogResponse } from "@codexnest/protocol";
import { AppError, object, text, type Engine } from "./engine";

export type NativeSkill = {
  name: string;
  description?: string;
  location: string;
  content: string;
  slash?: boolean;
};
export async function nativeSkills(engine: Engine, directory: string): Promise<NativeSkill[]> {
  // The V1 sessions used by this facade load the V1 skill registry. The native
  // experimental /api/skill registry is separate and can legitimately be empty.
  const result = await engine.native.request<NativeSkill[]>("GET", "/skill", { directory });
  if (!Array.isArray(result))
    throw new AppError("app_server_unavailable", "OpenCode returned an invalid skill catalog", 503);
  return result;
}
export async function listOpenSkills(engine: Engine, cwd: string): Promise<SkillsCatalogResponse> {
  const directory = await realpath(cwd);
  const discovered = await nativeSkills(engine, directory);
  const skills = discovered.map((skill) => {
    const nested = relative(directory, skill.location);
    return {
      name: skill.name,
      displayName: skill.name,
      description: skill.description ?? "",
      shortDescription: null,
      path: skill.location,
      scope: (!isAbsolute(nested) && nested !== ".." && !nested.startsWith(`..${sep}`)
        ? "repo"
        : "user") as "repo" | "user",
      enabled: engine.data.skillOverrides?.[skill.location] !== false,
    };
  });
  return { cwd: directory, skills, errors: [] };
}
export async function expandSkill(engine: Engine, id: string, input: string): Promise<string> {
  const match = /^\/([A-Za-z0-9_.:-]+)(?:\s|$)/.exec(input);
  if (!match) return input;
  const skills = await nativeSkills(engine, engine.thread(id).summary.cwd);
  const skill = skills.find((candidate) => candidate.name === match[1]);
  if (!skill) return input;
  if (engine.data.skillOverrides?.[skill.location] === false)
    throw new AppError("validation_failed", "This skill is disabled for OpenNest");
  if (typeof skill.content !== "string" || Buffer.byteLength(skill.content) > 256 * 1024)
    throw new AppError("validation_failed", "The skill contents exceed the supported size");
  return `<skill name=${JSON.stringify(skill.name)} path=${JSON.stringify(skill.location)}>\n${skill.content}\n</skill>\n\n${input}`;
}
export function registerSkillRoutes(app: FastifyInstance, engine: Engine) {
  app.get<{ Querystring: { cwd?: string } }>("/api/v1/skills", (request) =>
    listOpenSkills(
      engine,
      request.query.cwd || engine.data.projects[0]?.path || engine.config.configDir,
    ),
  );
  app.put("/api/v1/skills/config", async (request) => {
    const body = object(request.body);
    if (typeof body.enabled !== "boolean")
      throw new AppError("validation_failed", "enabled must be a boolean");
    const cwd = body.cwd
      ? await realpath(text(body.cwd, "cwd", 4096))
      : engine.data.projects[0]?.path;
    if (!cwd || !engine.data.projects.some((project) => project.path === cwd))
      throw new AppError("forbidden", "Choose a managed project", 403);
    const path = text(body.path, "path", 4096);
    const skill = (await nativeSkills(engine, cwd)).find(
      (candidate) => candidate.location === path,
    );
    if (!skill)
      throw new AppError("forbidden", "The skill is not part of this native project catalog", 403);
    (engine.data.skillOverrides ??= {})[path] = body.enabled;
    (engine.data.skillNames ??= {})[path] = skill.name;
    engine.data.permissionVersion++;
    await engine.save();
    for (const [id, thread] of Object.entries(engine.data.threads))
      if (thread.summary.cwd === cwd && !engine.isBusy(id))
        await engine.applySessionPermissions(id);
    await engine.save();
    engine.publish({ type: "skills.changed" });
    return { path, enabled: body.enabled };
  });
}
