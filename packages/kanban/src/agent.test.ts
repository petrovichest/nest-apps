import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { agentCapability, agentPrompt, installAgentHelper, shellQuote } from "./agent.js";
import { atomicJson, KanbanStore } from "./store.js";
import type { KanbanRun } from "@codexnest/protocol";
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
    const prompt = agentPrompt(board, run, input, input);
    expect(prompt).toContain(shellQuote(process.execPath));
    expect(prompt).toContain(shellQuote(input));
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
