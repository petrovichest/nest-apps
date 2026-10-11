import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listClaudeSkills, parseSkillHeader, setClaudeSkillEnabled } from "./skills";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function workspace() {
  const root = await mkdtemp("/tmp/claude-skills-");
  directories.push(root);
  const configDir = join(root, "native");
  const cwd = join(root, "project");
  await Promise.all([mkdir(configDir), mkdir(cwd)]);
  return { root, configDir, cwd, settings: join(configDir, "settings.json") };
}
async function skill(folder: string, text: string) {
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "SKILL.md"), text);
}
const json = async (path: string) => JSON.parse(await readFile(path, "utf8")) as unknown;

describe("SKILL.md header", () => {
  it.each([
    ["a plain value with a colon", "description: Use it when X: Y", "Use it when X: Y"],
    ["a double-quoted value", 'description: "Say \\"hi\\": now \\u0041"', 'Say "hi": now A'],
    ["a single-quoted value", "description: 'It''s fine'", "It's fine"],
    [
      "a folded block",
      "description: >-\n  First line\n  second line\n\n  after blank",
      "First line second line after blank",
    ],
    ["a literal block", "description: |\n  One\n  Two", "One Two"],
    [
      "a plain value on two lines",
      "description: Starts here\n  and goes on",
      "Starts here and goes on",
    ],
    [
      "a value after a nested mapping",
      "metadata:\n  author: me\ndescription: After it",
      "After it",
    ],
  ])("reads %s", (_name, header, description) => {
    expect(
      parseSkillHeader(`---\nname: demo\n${header}\n---\nBody`).fields.get("description"),
    ).toBe(description);
  });

  it("copes with a byte order mark, CRLF line ends and a missing header", () => {
    const { fields, body } = parseSkillHeader(
      "\uFEFF---\r\nname: crlf\r\ndescription: Works\r\n---\r\nBody",
    );
    expect([fields.get("name"), fields.get("description"), body]).toEqual([
      "crlf",
      "Works",
      ["Body"],
    ]);
    expect(parseSkillHeader("# Title\nText").fields.size).toBe(0);
    expect(parseSkillHeader("---\nname: never closed\n").fields.size).toBe(0);
  });
});

describe("listClaudeSkills", () => {
  it("reads the user's and the project's skills, following symlinks and skipping what Claude cannot run", async () => {
    const { root, configDir, cwd } = await workspace();
    const skills = join(configDir, "skills");
    await skill(
      join(skills, "grilling"),
      "---\nname: grilling\ndescription: Grill the user\n---\nBody",
    );
    await skill(join(skills, "folder-name"), "# Heading text\n\nNo header at all");
    await skill(join(skills, "hidden"), "---\nname: hidden\nuser-invocable: false\n---\nBody");
    await skill(join(skills, ".dot"), "---\nname: dot\n---\nBody");
    await skill(
      join(skills, "bad-name"),
      "---\nname: has spaces\ndescription: Falls back to the folder\n---\n",
    );
    await skill(join(skills, "synced", "bucket", "docx"), "---\nname: docx\n---\nBody");
    await skill(
      join(root, "elsewhere", "linked"),
      "---\nname: linked\ndescription: Through a symlink\n---\n",
    );
    await symlink(join(root, "elsewhere", "linked"), join(skills, "linked"));
    await skill(
      join(cwd, ".claude", "skills", "deploy"),
      "---\nname: deploy\ndescription: Ship it\n---\n",
    );

    const catalog = await listClaudeSkills(configDir, cwd);

    expect(catalog.cwd).toBe(cwd);
    expect(catalog.errors).toEqual([]);
    expect(
      catalog.skills.map(({ name, scope, description, enabled }) => [
        name,
        scope,
        description,
        enabled,
      ]),
    ).toEqual([
      ["bad-name", "user", "Falls back to the folder", true],
      ["deploy", "repo", "Ship it", true],
      ["folder-name", "user", "Heading text", true],
      ["grilling", "user", "Grill the user", true],
      ["linked", "user", "Through a symlink", true],
    ]);
    expect(catalog.skills.find((item) => item.name === "grilling")).toEqual({
      name: "grilling",
      displayName: "grilling",
      description: "Grill the user",
      shortDescription: null,
      path: join(skills, "grilling", "SKILL.md"),
      scope: "user",
      enabled: true,
    });
  });

  it("returns an empty catalog when neither folder exists", async () => {
    const { root } = await workspace();
    expect(await listClaudeSkills(join(root, "none"), join(root, "nothing"))).toEqual({
      cwd: join(root, "nothing"),
      skills: [],
      errors: [],
    });
  });

  it("layers skillOverrides from the user, project and local settings and ignores bad values", async () => {
    const { configDir, cwd, settings } = await workspace();
    await skill(join(configDir, "skills", "grilling"), "---\nname: grilling\n---\n");
    await skill(join(configDir, "skills", "deploy"), "---\nname: deploy\n---\n");
    await skill(join(configDir, "skills", "quiet"), "---\nname: quiet\n---\n");
    await skill(join(configDir, "skills", "odd"), "---\nname: odd\n---\n");
    await writeFile(
      settings,
      JSON.stringify({
        skillOverrides: {
          grilling: "off",
          deploy: "name-only",
          quiet: "user-invocable-only",
          odd: "nonsense",
        },
      }),
    );
    await mkdir(join(cwd, ".claude"));
    await writeFile(
      join(cwd, ".claude", "settings.json"),
      JSON.stringify({ skillOverrides: { grilling: "on" } }),
    );
    await writeFile(join(cwd, ".claude", "settings.local.json"), "{ not json");

    const enabled = Object.fromEntries(
      (await listClaudeSkills(configDir, cwd)).skills.map((item) => [item.name, item.enabled]),
    );
    expect(enabled).toEqual({ deploy: true, grilling: true, odd: true, quiet: true });

    await writeFile(
      join(cwd, ".claude", "settings.local.json"),
      JSON.stringify({ skillOverrides: { deploy: "off" } }),
    );
    const local = await listClaudeSkills(configDir, cwd);
    expect(local.skills.filter((item) => !item.enabled).map((item) => item.name)).toEqual([
      "deploy",
    ]);
  });
});

describe("setClaudeSkillEnabled", () => {
  it("creates a private settings file when there is none", async () => {
    const { settings, configDir } = await workspace();
    await setClaudeSkillEnabled(configDir, "grilling", false);
    expect(await json(settings)).toEqual({ skillOverrides: { grilling: "off" } });
    expect((await stat(settings)).mode & 0o777).toBe(0o600);
  });

  it("changes only skillOverrides and keeps the rest, the file mode and the final newline", async () => {
    const { settings, configDir } = await workspace();
    const original = {
      env: { HTTPS_PROXY: "http://user:secret@proxy.example:8080" },
      permissions: { defaultMode: "acceptEdits" },
      skillOverrides: { other: "name-only" },
      theme: "dark",
    };
    await writeFile(settings, JSON.stringify(original, null, 2) + "\n");
    await chmod(settings, 0o640);

    await setClaudeSkillEnabled(configDir, "grilling", false);
    expect(await json(settings)).toEqual({
      ...original,
      skillOverrides: { other: "name-only", grilling: "off" },
    });
    expect(Object.keys((await json(settings)) as object)).toEqual(Object.keys(original));
    expect((await readFile(settings, "utf8")).endsWith("}\n")).toBe(true);
    expect((await stat(settings)).mode & 0o777).toBe(0o640);

    await setClaudeSkillEnabled(configDir, "grilling", true);
    expect(await json(settings)).toEqual(original);
  });

  it("drops the empty skillOverrides object and keeps a missing final newline missing", async () => {
    const { settings, configDir } = await workspace();
    await writeFile(
      settings,
      JSON.stringify({ theme: "dark", skillOverrides: { grilling: "off" } }, null, 2),
    );
    await setClaudeSkillEnabled(configDir, "grilling", true);
    expect(await readFile(settings, "utf8")).toBe(JSON.stringify({ theme: "dark" }, null, 2));
  });

  it("refuses to rewrite settings that are not a JSON object", async () => {
    const { settings, configDir } = await workspace();
    for (const text of ["{ not json", "[1, 2]"]) {
      await writeFile(settings, text);
      await expect(setClaudeSkillEnabled(configDir, "grilling", false)).rejects.toMatchObject({
        code: "conflict",
        status: 409,
      });
      expect(await readFile(settings, "utf8")).toBe(text);
    }
  });

  it("writes through a symlinked settings.json and keeps the link", async () => {
    const { root, settings, configDir } = await workspace();
    const real = join(root, "dotfiles-settings.json");
    await writeFile(real, JSON.stringify({ theme: "dark" }));
    await symlink(real, settings);
    await setClaudeSkillEnabled(configDir, "grilling", false);
    expect((await lstat(settings)).isSymbolicLink()).toBe(true);
    expect(await json(real)).toEqual({ theme: "dark", skillOverrides: { grilling: "off" } });
  });

  it("applies simultaneous changes one after another without losing any", async () => {
    const { settings, configDir } = await workspace();
    await Promise.all(
      ["a", "b", "c", "d"].map((name) => setClaudeSkillEnabled(configDir, name, false)),
    );
    expect(await json(settings)).toEqual({
      skillOverrides: { a: "off", b: "off", c: "off", d: "off" },
    });
  });
});
