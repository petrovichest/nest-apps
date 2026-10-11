import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  SkillCatalogError,
  SkillCatalogItem,
  SkillScope,
  SkillsCatalogResponse,
} from "@codexnest/protocol";
import { AppError } from "./types";

const SKILL_NAME = /^[\p{L}\p{N}_.:-]+$/u;
const OVERRIDES = new Set(["on", "name-only", "user-invocable-only", "off"]);
const MAX_SKILLS_PER_FOLDER = 500;
const MAX_DESCRIPTION = 1_024;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}
async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function quotedText(text: string): string {
  const quote = text[0];
  let result = "";
  for (let index = 1; index < text.length; index += 1) {
    const character = text[index]!;
    if (quote === '"' && character === "\\") {
      const next = text[(index += 1)] ?? "";
      if (next === "u" && /^[0-9a-f]{4}$/iu.test(text.slice(index + 1, index + 5))) {
        result += String.fromCharCode(Number.parseInt(text.slice(index + 1, index + 5), 16));
        index += 4;
      } else result += next === "n" ? "\n" : next === "t" ? "\t" : next;
    } else if (character === quote) {
      if (quote === "'" && text[index + 1] === "'") {
        result += "'";
        index += 1;
      } else return result;
    } else result += character;
  }
  return result;
}

/** The text of one header value, with the lines that continue it, shown on a single line. */
function headerText(first: string, continuation: string[]): string {
  const value = first.trim();
  const rest = continuation.filter(Boolean);
  const text = /^[>|][+-]?\d*$/u.test(value)
    ? rest.join(" ")
    : value.startsWith('"') || value.startsWith("'")
      ? quotedText([value, ...rest].join(" "))
      : [value, ...rest].filter(Boolean).join(" ");
  return text.replace(/\s+/gu, " ").trim();
}

/** Reads the top-level `key: value` pairs of a SKILL.md header; nested YAML is ignored. */
export function parseSkillHeader(text: string): { fields: Map<string, string>; body: string[] } {
  const lines = text.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  const fields = new Map<string, string>();
  if (lines[0]?.trimEnd() !== "---") return { fields, body: lines };
  const close = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (close < 0) return { fields, body: lines };
  const header = lines.slice(1, close);
  for (let index = 0; index < header.length; index += 1) {
    const match = /^([A-Za-z][\w-]*):(?:[ \t]+(.*))?$/u.exec(header[index]!);
    if (!match) continue;
    const continuation: string[] = [];
    while (index + 1 < header.length && /^(?:[ \t]|$)/u.test(header[index + 1]!))
      continuation.push(header[(index += 1)]!.trim());
    fields.set(match[1]!, headerText(match[2] ?? "", continuation));
  }
  return { fields, body: lines.slice(close + 1) };
}

async function readSkillFolder(
  root: string,
  scope: SkillScope,
  errors: SkillCatalogError[],
): Promise<SkillCatalogItem[]> {
  let folders: string[];
  try {
    folders = await readdir(root);
  } catch (error) {
    if (!missing(error)) errors.push({ path: root, message: "Could not read the skills folder" });
    return [];
  }
  const skills: SkillCatalogItem[] = [];
  for (const folder of folders.sort().slice(0, MAX_SKILLS_PER_FOLDER)) {
    if (folder.startsWith(".")) continue;
    const path = join(root, folder, "SKILL.md");
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (!missing(error)) errors.push({ path, message: "Could not read SKILL.md" });
      continue;
    }
    const { fields, body } = parseSkillHeader(text);
    // Claude answers "/name" for these with an error: only the model may run them.
    if (fields.get("user-invocable")?.toLowerCase() === "false") continue;
    const declared = fields.get("name") ?? "";
    const name = SKILL_NAME.test(declared) ? declared : folder;
    if (!SKILL_NAME.test(name) || name === "__proto__") continue;
    const heading = body.find((line) => line.trim())?.replace(/^#+\s*/u, "") ?? "";
    skills.push({
      name,
      displayName: name,
      description: (fields.get("description") || heading.trim()).slice(0, MAX_DESCRIPTION),
      shortDescription: null,
      path,
      scope,
      enabled: true,
    });
  }
  return skills;
}

/** Layers `skillOverrides` the way Claude Code layers its settings: user, project, then local. */
async function skillOverrides(configDir: string, cwd: string): Promise<Map<string, string>> {
  const merged = new Map<string, string>();
  for (const path of [
    join(configDir, "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
  ]) {
    const overrides = (await readJsonObject(path))?.skillOverrides;
    if (!isObject(overrides)) continue;
    for (const [name, value] of Object.entries(overrides))
      if (typeof value === "string" && OVERRIDES.has(value)) merged.set(name, value);
  }
  return merged;
}

/** Lists the skills Claude Code loads from folders: the user's own and the project's. */
export async function listClaudeSkills(
  configDir: string,
  cwd: string,
): Promise<SkillsCatalogResponse> {
  const errors: SkillCatalogError[] = [];
  const [user, repo, overrides] = await Promise.all([
    readSkillFolder(join(configDir, "skills"), "user", errors),
    readSkillFolder(join(cwd, ".claude", "skills"), "repo", errors),
    skillOverrides(configDir, cwd),
  ]);
  const skills = [...user, ...repo]
    .map((skill) => ({ ...skill, enabled: overrides.get(skill.name) !== "off" }))
    .sort(
      (left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path),
    );
  return { cwd, skills, errors };
}

async function writeOverride(configDir: string, name: string, enabled: boolean): Promise<void> {
  const target = await realpath(join(configDir, "settings.json")).catch(() =>
    join(configDir, "settings.json"),
  );
  const text = await readFile(target, "utf8").catch((error: unknown) => {
    if (missing(error)) return "";
    throw error;
  });
  const mode = await stat(target).then(
    (info) => info.mode & 0o777,
    () => 0o600,
  );
  let settings: Record<string, unknown> = {};
  if (text.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* Reported below. */
    }
    if (!isObject(parsed))
      throw new AppError(
        "conflict",
        "Claude settings.json is not a valid JSON object; skills were not changed",
        409,
      );
    settings = parsed;
  }
  const overrides = isObject(settings.skillOverrides) ? { ...settings.skillOverrides } : {};
  if (enabled) delete overrides[name];
  else overrides[name] = "off";
  if (Object.keys(overrides).length) settings.skillOverrides = overrides;
  else delete settings.skillOverrides;
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      JSON.stringify(settings, null, 2) + (text.endsWith("\n") ? "\n" : ""),
    );
    await chmod(temporary, mode);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

let settingsWrites: Promise<unknown> = Promise.resolve();

/**
 * Switches a skill with Claude Code's own `skillOverrides` setting in the user's settings.json.
 * Only that key changes; the file also holds the proxy and permissions. Running sessions pick it up.
 */
export function setClaudeSkillEnabled(
  configDir: string,
  name: string,
  enabled: boolean,
): Promise<void> {
  const write = settingsWrites.then(() => writeOverride(configDir, name, enabled));
  settingsWrites = write.catch(() => undefined);
  return write;
}
