import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentCapability,
  classificationPrompt,
  installAgentHelper,
  PUBLISH_PROMPT,
  shellQuote,
  taskPrompt,
} from "./agent.js";
import { atomicJson } from "./store.js";
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
    const board = { cards: [{ id: "card", description: "Fix" }], categories: [] };
    const prompt = classificationPrompt(
      board as unknown as KanbanBoard,
      { kind: "classify", cardIds: ["card"] } as KanbanRun,
      input,
      "/capability.json",
    );
    expect(prompt).toContain(shellQuote(process.execPath));
    expect(prompt).toContain(shellQuote(input));
  });
  it("starts a task with exactly its own text, nothing about the board or pushing", () => {
    const card = {
      id: "card",
      title: "Прикрепление изображения",
      description: "Добавить изображение при создании задачи.\n\nСохранить описание.  ",
    } as KanbanCard;
    expect(taskPrompt([card])).toBe(
      "Добавить изображение при создании задачи.\n\nСохранить описание.",
    );
    expect(taskPrompt([card, { ...card, description: " Проверить на телефоне " }])).toBe(
      "## Задача 1\n\nДобавить изображение при создании задачи.\n\nСохранить описание." +
        "\n\n## Задача 2\n\nПроверить на телефоне",
    );
    expect(PUBLISH_PROMPT).toContain("GitHub Actions");
    expect(PUBLISH_PROMPT).toContain("только на GitHub");
    expect(PUBLISH_PROMPT).not.toMatch(/board|доск/i);
  });
  it("keeps classification self-contained and limited to a title and a category", () => {
    const board = {
      cards: [{ id: "card", description: "Fix layout" }],
      categories: [{ id: "ui", name: "Interface" }],
    } as unknown as KanbanBoard;
    const prompt = classificationPrompt(
      board,
      { kind: "classify", cardIds: ["card"] } as KanbanRun,
      "/agent.mjs",
      "/nonexistent/capability.json",
    );
    expect(prompt).toContain("Classify this task");
    expect(prompt).toContain("Fix layout");
    expect(prompt).toContain("/agent.mjs");
    expect(prompt).toContain('["Interface"]');
    expect(prompt).not.toContain('"ui"');
    expect(prompt).toContain("language of the task text");
    expect(prompt).toContain("report");
    expect(prompt).not.toContain("scope");
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
    // Hold the first missing-file read until the atomic response's event has
    // arrived. Dropping that event while checking would wait for five minutes.
    const hook = join(directory, "hold-first-read.mjs");
    await writeFile(
      hook,
      `
import promises from 'node:fs/promises';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const read=promises.readFile, watch=fs.watch;
let first=true;
promises.readFile=async(path,...args)=>{
  if(first&&String(path).includes('/results/')){
    first=false;
    await new Promise(resolve=>{
      process.once('message',()=>{process.disconnect();resolve();});
      process.send('read-pending');
    });
    throw Object.assign(new Error('controlled missing-file read'),{code:'ENOENT'});
  }
  return read(path,...args);
};
fs.watch=(...args)=>{
  const watcher=watch(...args);
  watcher.on('change',(_event,name)=>{if(process.connected&&String(name).endsWith('.json'))process.send('response-changed');});
  return watcher;
};
syncBuiltinESMExports();
`,
    );
    const child = spawn(process.execPath, ["--import", hook, helper, capability, "read", "{}"], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const signals = new Set();
    child.on("message", (message) => signals.add(message));
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
    await vi.waitFor(() => expect(signals.has("read-pending")).toBe(true));
    await atomicJson(join(directory, "results", requestName), {
      ok: true,
      result: { stage: "review" },
    });
    await vi.waitFor(() => expect(signals.has("response-changed")).toBe(true));
    child.send("finish-initial-read");
    expect(await ended).toBe(0);
    expect(JSON.parse(output)).toEqual({ stage: "review" });
  });
});
