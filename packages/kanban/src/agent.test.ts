import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { agentCapability, agentPrompt, installAgentHelper, shellQuote } from "./agent.js";
import { atomicJson, KanbanStore } from "./store.js";
import type { KanbanBoard, KanbanCard, KanbanRun } from "@codexnest/protocol";
const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe("agent file bridge", () => {
  it("quotes shell metacharacters and executable/capability paths literally", async () => {
    const input = "path with 'quotes' $(printf expanded) `printf substituted` $HOME";
    const { stdout } = await execute("bash", ["-c", `printf '%s' ${shellQuote(input)}`]);
    expect(stdout).toBe(input);
    const storeRoot = await mkdtemp(join(tmpdir(), "kanban-agent-"));
    directories.push(storeRoot);
    const project = join(storeRoot, "project");
    await mkdir(project);
    const store = new KanbanStore(storeRoot);
    await store.initialize();
    const { board } = await store.read(project);
    const run = {
      id: "r",
      kind: "execute",
      cardIds: [],
      provider: "codex",
    } as unknown as KanbanRun;
    await agentPrompt(board, run, input, join(storeRoot, "capability.json"));
    const instructions = await readFile(join(storeRoot, "r.md"), "utf8");
    expect(instructions).toContain(shellQuote(process.execPath));
    expect(instructions).toContain(shellQuote(input));
  });
  it.each(["execute", "review", "integrate"] as const)(
    "keeps %s assignments readable and writes the full protocol before returning",
    async (kind) => {
      const directory = await mkdtemp(join(tmpdir(), "kanban-prompt-"));
      directories.push(directory);
      const cards = [
        {
          id: "assigned",
          title: "Прикрепление изображения",
          description: "Добавить изображение при создании задачи.\n\nСохранить описание.",
          createdAt: 1793743358079,
        },
        { id: "other", title: "Unrelated task", description: "Do not execute this" },
      ] as KanbanCard[];
      const board = {
        projectPath: "/project",
        cards,
        stages: [{ id: "waiting", name: "Decision", description: "Ask the operator" }],
      } as KanbanBoard;
      const run = { id: "run", kind, cardIds: ["assigned"] } as KanbanRun;
      const comment = "Проверить вставку из буфера.\nНе менять остальные поля.";
      const prompt = await agentPrompt(
        board,
        run,
        "/agent.mjs",
        join(directory, "run.json"),
        comment,
      );
      expect(prompt).toContain(`## ${cards[0]!.title}\n\n${cards[0]!.description}`);
      expect(prompt).toContain(comment);
      expect(prompt).toContain(JSON.stringify(join(directory, "run.md")));
      expect(prompt).not.toContain(cards[1]!.title);
      expect(prompt).not.toMatch(/createdAt|Task assignments|COMMAND 'JSON'|1793743358079/);
      const instructions = await readFile(join(directory, "run.md"), "utf8");
      expect(instructions).toContain(`project-board ${kind} operation`);
      expect(instructions).toContain(JSON.stringify([cards[0]]));
      expect(instructions).toContain(comment);
      expect(instructions).toContain("AGENTS.md and CLAUDE.md");
      expect(instructions).toContain("prepare-repository");
      expect(instructions).toContain("The publish helper is the sole publication path");
      expect(instructions).toContain("Ask the operator");
      if (kind === "execute") {
        expect(instructions).toContain('report {outcome:"completed"');
        expect(instructions).toContain('next:"publish"');
        expect(instructions).toContain('next:"review"');
      } else if (kind === "review") {
        expect(instructions).toContain('outcome:"accepted"');
        expect(instructions).toContain('outcome:"rejected"');
      } else {
        expect(instructions).toContain("Finish all selected merges");
        expect(instructions).toContain("Once combined checks pass call publish {}");
      }
      expect((await stat(join(directory, "run.md"))).mode & 0o777).toBe(0o600);
    },
  );
  it("keeps classification self-contained without requiring an instructions file", async () => {
    const board = {
      cards: [{ id: "card", description: "Fix layout" }],
      categories: [],
    } as unknown as KanbanBoard;
    const prompt = await agentPrompt(
      board,
      { kind: "classify", cardIds: ["card"] } as KanbanRun,
      "/agent.mjs",
      "/nonexistent/capability.json",
    );
    expect(prompt).toContain("Classify this one task");
    expect(prompt).toContain("Fix layout");
    expect(prompt).toContain("/agent.mjs");
    expect(prompt).toContain("report");
    expect(prompt).not.toContain("read the board workflow instructions");
  });
  it("sends a durable request and wakes the CLI on an atomic response without polling", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kanban-cli-"));
    directories.push(directory);
    const helper = await installAgentHelper(directory);
    const capability = await agentCapability(
      directory,
      "board",
      { id: "run" } as KanbanRun,
      "token",
    );
    const child = spawn(process.execPath, [helper, capability, "read", "{}"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      errors = "";
    child.stdout.on("data", (value) => {
      output += String(value);
    });
    child.stderr.on("data", (value) => {
      errors += String(value);
    });
    const ended = new Promise<number | null>((resolve, reject) => {
      child.on("exit", resolve);
      child.on("error", reject);
    });
    const { readdir } = await import("node:fs/promises");
    let requestName = "";
    const deadline = Date.now() + 3000;
    while (!requestName) {
      requestName =
        (await readdir(join(directory, "inbox"))).find((name) => name.endsWith(".json")) ?? "";
      if (Date.now() > deadline) {
        child.kill();
        throw new Error(errors || "CLI request not created");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const request = JSON.parse(await readFile(join(directory, "inbox", requestName), "utf8"));
    expect(request).toMatchObject({
      boardId: "board",
      runId: "run",
      token: "token",
      command: "read",
      payload: {},
    });
    await atomicJson(join(directory, "results", requestName), {
      ok: true,
      result: { stage: "review" },
    });
    expect(await ended).toBe(0);
    expect(JSON.parse(output)).toEqual({ stage: "review" });
  });
});
