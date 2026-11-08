import { chmod, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  SkillCatalogError,
  SkillCatalogItem,
  SkillScope,
  SkillsCatalogResponse,
} from "@codexnest/protocol";
import { AppError } from "./engine";

type Frontmatter = Record<string, unknown>;

const SKILL_FILE = "SKILL.md";
const MAX_SKILL_BYTES = 256 * 1024;
const BOOLEAN_WORDS = new Set(["true", "false", "yes", "no", "on", "off"]);

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\nrt])/g, (_, char: string) => {
      if (char === "n") return "\n";
      if (char === "r") return "\r";
      if (char === "t") return "\t";
      return char;
    });
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function parseScalar(raw: string): unknown {
  const value = raw.trim();
  if (!value) return "";
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return unquote(value);
  }
  const lower = value.toLowerCase();
  if (BOOLEAN_WORDS.has(lower)) return ["true", "yes", "on"].includes(lower);
  return value;
}

function parseFrontmatter(text: string): { data: Frontmatter; body: string } {
  const normalized = text.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(normalized);
  if (!match) return { data: {}, body: normalized.trim() };
  const lines = match[1]!.split(/\r?\n/);
  const data: Frontmatter = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const field = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line);
    if (!field || line.startsWith(" ") || line.startsWith("\t")) continue;
    const key = field[1]!;
    const rest = (field[2] ?? "").trim();
    if (rest === "|" || rest === ">" || rest === "|-" || rest === ">-") {
      const block: string[] = [];
      while (index + 1 < lines.length && /^(?: {2,}|\t)/.test(lines[index + 1]!)) {
        index += 1;
        block.push(lines[index]!.replace(/^(?: {2}|\t)/, ""));
      }
      data[key] = rest.startsWith(">") ? block.join(" ").trim() : block.join("\n").trim();
    } else {
      data[key] = parseScalar(rest);
    }
  }
  return { data, body: normalized.slice(match[0].length).trim() };
}

function firstParagraph(body: string): string {
  const lines: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      if (lines.length) break;
      continue;
    }
    if (line.startsWith("#")) continue;
    lines.push(line);
  }
  return lines.join(" ").slice(0, 400);
}

function textField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function pathContains(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function existingDirectory(path: string): Promise<string | null> {
  try {
    const resolved = await realpath(path);
    return (await stat(resolved)).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

async function discoverRootSkills(
  rootPath: string,
  scope: SkillScope,
  overrides: Record<string, boolean>,
): Promise<SkillCatalogItem[]> {
  const root = await existingDirectory(rootPath);
  if (!root) return [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const skills: SkillCatalogItem[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const skillDir = join(root, entry.name);
    const candidate = join(skillDir, SKILL_FILE);
    let resolvedFile: string;
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      resolvedFile = await realpath(candidate);
      info = await stat(resolvedFile);
    } catch {
      continue;
    }
    if (
      !info.isFile() ||
      info.size > MAX_SKILL_BYTES ||
      (!pathContains(root, resolvedFile) && scope === "repo")
    ) {
      continue;
    }
    let content: string;
    try {
      content = await readFile(resolvedFile, "utf8");
    } catch {
      continue;
    }
    const { data, body } = parseFrontmatter(content);
    if (data["user-invocable"] === false || data.userInvocable === false) continue;
    const name = textField(data.name) ?? entry.name;
    const description = textField(data.description) ?? firstParagraph(body) ?? name;
    const shortDescription =
      textField(data["short-description"]) ??
      textField(data.shortDescription) ??
      textField(data.when_to_use) ??
      null;
    const displayName = textField(data["display-name"]) ?? textField(data.displayName) ?? name;
    const enabled = overrides[resolvedFile] ?? data.enabled !== false;
    skills.push({
      name,
      displayName,
      description,
      shortDescription,
      path: resolvedFile,
      scope,
      enabled,
    });
  }
  return skills;
}

function candidateSkillRoots(
  cwd: string,
  configDir: string,
  nativeDir: string,
): Array<{ path: string; scope: SkillScope }> {
  const userHome = homedir();
  return [
    { path: join(cwd, ".agents", "skills"), scope: "repo" },
    { path: join(cwd, ".agent", "skills"), scope: "repo" },
    { path: join(cwd, ".gemini", "skills"), scope: "repo" },
    { path: join(cwd, ".claude", "skills"), scope: "repo" },
    { path: join(cwd, "skills"), scope: "repo" },
    { path: join(nativeDir, "config", "skills"), scope: "user" },
    { path: join(nativeDir, "gemininest", "builtin", "skills"), scope: "system" },
    { path: join(configDir, "skills"), scope: "user" },
    { path: join(userHome, ".gemini", "config", "skills"), scope: "user" },
  ];
}

export async function listGeminiSkills(options: {
  cwd: string;
  configDir: string;
  nativeDir: string;
  overrides?: Record<string, boolean>;
}): Promise<SkillsCatalogResponse> {
  const overrides = options.overrides ?? {};
  const roots = candidateSkillRoots(options.cwd, options.configDir, options.nativeDir);
  const seenPaths = new Set<string>();
  const seenNames = new Set<string>();
  const skills: SkillCatalogItem[] = [];
  const errors: SkillCatalogError[] = [];
  for (const root of roots) {
    const discovered = await discoverRootSkills(root.path, root.scope, overrides);
    for (const skill of discovered) {
      if (seenPaths.has(skill.path) || seenNames.has(skill.name)) continue;
      seenPaths.add(skill.path);
      seenNames.add(skill.name);
      skills.push(skill);
    }
  }
  skills.sort((left, right) => {
    if (left.scope !== right.scope) return left.scope === "repo" ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
  return {
    cwd: options.cwd,
    skills,
    errors,
  };
}

export async function syncNativeSkillsConfig(
  nativeDir: string,
  overrides: Record<string, boolean>,
): Promise<void> {
  const configDir = join(nativeDir, "config");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const skillsConfigPath = join(configDir, "skills.json");
  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(skillsConfigPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    /* Start from empty skills.json. */
  }
  const excluded = new Set<string>();
  for (const [skillPath, enabled] of Object.entries(overrides)) {
    if (enabled === false) {
      excluded.add(basename(dirname(skillPath)));
      excluded.add(skillPath);
    }
  }
  const payload = {
    ...existing,
    exclude: [...excluded].sort(),
  };
  await writeFile(skillsConfigPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await chmod(skillsConfigPath, 0o600);
}

export async function resolveGeminiSkillPath(options: {
  path: string;
  cwd?: string;
  projectPaths: string[];
  threadCwds: string[];
  configDir: string;
  nativeDir: string;
}): Promise<string> {
  if (typeof options.path !== "string" || !options.path.trim() || !isAbsolute(options.path)) {
    throw new AppError("invalid_request", "Skill path must be an absolute path");
  }
  if (basename(options.path) !== SKILL_FILE) {
    throw new AppError("invalid_request", "Skill path must point to SKILL.md");
  }
  let resolvedFile: string;
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    resolvedFile = await realpath(options.path);
    info = await stat(resolvedFile);
  } catch {
    throw new AppError("not_found", "Skill file does not exist", 404);
  }
  if (!info.isFile() || basename(resolvedFile) !== SKILL_FILE) {
    throw new AppError("invalid_request", "Skill path must point to SKILL.md");
  }
  const cwds = new Set<string>([
    ...options.projectPaths,
    ...options.threadCwds,
    ...(options.cwd ? [options.cwd] : []),
  ]);
  const allowedRoots: string[] = [];
  for (const cwd of cwds) {
    for (const root of candidateSkillRoots(cwd, options.configDir, options.nativeDir)) {
      const existing = await existingDirectory(root.path);
      if (existing) allowedRoots.push(existing);
    }
  }
  for (const root of candidateSkillRoots(
    resolve(options.configDir),
    options.configDir,
    options.nativeDir,
  )) {
    const existing = await existingDirectory(root.path);
    if (existing) allowedRoots.push(existing);
  }
  if (!allowedRoots.some((root) => pathContains(root, resolvedFile))) {
    throw new AppError("forbidden", "Skill path is outside configured skill directories", 403);
  }
  return resolvedFile;
}
