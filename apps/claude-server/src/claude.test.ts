import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeProcess } from "./claude.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const MESSAGE = "22222222-2222-4222-8222-222222222222";
type ObjectMessage = Record<string, any>;

class FakeChild extends EventEmitter {
  readonly pid = 900001;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly sent: ObjectMessage[] = [];
  autoInitialize = true;
  exitAfterInitialize = false;
  autoInterrupt = true;
  autoFinish = true;
  initializeResponse: ObjectMessage = {};
  permissionResponse: ObjectMessage = {};
  rejectSettings = false;
  readonly kill = vi.fn(() => true);

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      const message = JSON.parse(chunk.toString().trim()) as ObjectMessage;
      this.sent.push(message);
      if (message.type !== "control_request") return;
      if (
        (message.request.subtype === "initialize" && this.autoInitialize) ||
        (message.request.subtype === "interrupt" && this.autoInterrupt) ||
        ["set_model", "set_permission_mode"].includes(message.request.subtype)
      ) {
        this.output({
          type: "control_response",
          response: {
            subtype:
              this.rejectSettings && message.request.subtype.startsWith("set_")
                ? "error"
                : "success",
            request_id: message.request_id,
            response:
              message.request.subtype === "initialize"
                ? this.initializeResponse
                : message.request.subtype === "set_permission_mode"
                  ? this.permissionResponse
                  : {},
          },
        });
        if (message.request.subtype === "initialize" && this.exitAfterInitialize) this.close();
      }
    });
    this.stdin.on("finish", () => {
      if (this.autoFinish) this.close();
    });
  }
  output(message: ObjectMessage): void {
    this.stdout.write(JSON.stringify(message) + "\n");
  }
  close(code: number | null = 0, signal: string | null = null): void {
    this.stdout.end();
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

function setup(overrides: Partial<ConstructorParameters<typeof ClaudeProcess>[0]> = {}) {
  const child = new FakeChild();
  const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
  const process = new ClaudeProcess({
    claudeBin: "/installed/claude",
    cwd: "/test/project",
    sessionId: SESSION,
    resume: false,
    spawnProcess,
    ...overrides,
  });
  const errors: Error[] = [];
  process.on("error", (error: Error) => errors.push(error));
  return { child, process, spawnProcess, errors };
}

describe("Claude model metadata and controls", () => {
  it("captures initialize models and uses explicit startup effort and temporary-probe flags", async () => {
    const { child, process, spawnProcess } = setup({
      effort: "high",
      permissionMode: "acceptEdits",
      noSessionPersistence: true,
    });
    child.initializeResponse = {
      models: [
        {
          value: "sonnet",
          resolvedModel: "claude-test",
          displayName: "Sonnet",
          description: "Balanced",
          supportsEffort: true,
          supportedEffortLevels: ["low", "high"],
        },
        { invalid: true },
      ],
    };
    await process.start();
    expect(process.supportedModels).toEqual([
      {
        value: "sonnet",
        resolvedModel: "claude-test",
        displayName: "Sonnet",
        description: "Balanced",
        supportsEffort: true,
        supportedEffortLevels: ["low", "high"],
      },
    ]);
    const args = spawnProcess.mock.calls[0]![1] as string[];
    expect(args).toContain("--no-session-persistence");
    expect(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2)).toEqual([
      "--effort",
      "high",
    ]);
    await process.stop();
  });
  it("changes model and permission mode only after matching success acknowledgements", async () => {
    const { child, process } = setup();
    await process.start();
    await process.setModel("opus");
    await process.setPermissionMode("acceptEdits");
    expect(process.model).toBe("opus");
    expect(process.permissionMode).toBe("acceptEdits");
    expect(
      child.sent
        .filter((item) => item.request?.subtype.startsWith("set_"))
        .map((item) => item.request),
    ).toEqual([
      { subtype: "set_model", model: "opus" },
      { subtype: "set_permission_mode", mode: "acceptEdits" },
    ]);
    child.rejectSettings = true;
    await expect(process.setModel("missing-model")).rejects.toThrow("rejected");
    expect(process.model).toBe("opus");
    await process.stop();
  });
  it("opts into later bypass without selecting it until the CLI confirms the mode", async () => {
    const { child, process, spawnProcess } = setup();
    await process.start();
    expect(spawnProcess.mock.calls[0]![1]).toContain("--allow-dangerously-skip-permissions");
    expect(process.livePermissionMode).toBe(true);
    expect(process.permissionMode).toBe("manual");
    child.permissionResponse = { mode: "bypassPermissions" };
    await process.setPermissionMode("bypassPermissions");
    expect(process.permissionMode).toBe("bypassPermissions");
    child.permissionResponse = { mode: "bypassPermissions" };
    await expect(process.setPermissionMode("manual")).rejects.toThrow("requested permission mode");
    expect(process.permissionMode).toBe("bypassPermissions");
    child.permissionResponse = { mode: "default" };
    await process.setPermissionMode("manual");
    expect(process.permissionMode).toBe("manual");
    child.rejectSettings = true;
    await expect(process.setPermissionMode("acceptEdits")).rejects.toThrow("rejected");
    expect(process.permissionMode).toBe("manual");
    await process.stop();
  });
  it("starts directly in bypass only when explicitly selected", async () => {
    const { process, spawnProcess } = setup({ permissionMode: "bypassPermissions" });
    await process.start();
    const args = spawnProcess.mock.calls[0]![1] as string[];
    expect(
      args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2),
    ).toEqual(["--permission-mode", "bypassPermissions"]);
    expect(args).toContain("--allow-dangerously-skip-permissions");
    await process.stop();
  });
  it("preserves native image content blocks and observes actual model initialization", async () => {
    const { child, process } = setup();
    await process.start();
    const content = [
      { type: "text", text: "look" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } },
    ];
    process.sendUser(MESSAGE, "look", content);
    expect(child.sent.at(-1).message.content).toEqual(content);
    child.output({ type: "system", subtype: "init", model: "resolved-model" });
    expect(process.model).toBe("resolved-model");
    await process.stop();
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ClaudeProcess stream-json transport", () => {
  it("writes active-turn steering without interrupting, replaying or auto-answering questions", async () => {
    const { child, process } = setup({ permissionMode: "bypassPermissions" });
    const requests: ObjectMessage[] = [];
    process.on("request", (request: ObjectMessage) => requests.push(request));
    await process.start();
    process.sendUser(MESSAGE, "Original task");
    child.output({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool", name: "Bash", input: { command: "sleep 1" } }],
      },
    });
    const steering = "33333333-3333-4333-8333-333333333333";
    process.sendUser(steering, "Adjust the active task");
    child.output({
      type: "control_request",
      request_id: "question",
      request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [] } },
    });
    expect(
      child.sent.filter((message) => message.type === "user").map((message) => message.uuid),
    ).toEqual([MESSAGE, steering]);
    expect(
      child.sent
        .filter((message) => message.type === "control_request")
        .map((message) => message.request.subtype),
    ).toEqual(["initialize"]);
    expect(child.sent.some((message) => message.type === "control_response")).toBe(false);
    expect(requests).toHaveLength(1);
    process.respond("question", {
      behavior: "allow",
      updatedInput: { answers: { colour: "Blue" } },
    });
    await process.stop();
  });
  it("uses installed CLI and normal settings/auth, strips only the nested CLI marker, and initializes control", async () => {
    const { child, process, spawnProcess } = setup({
      model: "sonnet",
      env: { CLAUDECODE: "1", CLAUDE_CONFIG_DIR: "/test/auth", CUSTOM_TEST_SETTING: "preserved" },
    });
    await process.start();
    const [command, args, options] = vi.mocked(spawnProcess).mock.calls[0]!;
    expect(command).toBe("/installed/claude");
    expect(args).toEqual(
      expect.arrayContaining([
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "--verbose",
        "--include-partial-messages",
        "--replay-user-messages",
        "--permission-mode",
        "manual",
        "--permission-prompt-tool",
        "stdio",
        "--session-id",
        SESSION,
        "--model",
        "sonnet",
      ]),
    );
    expect(args).not.toContain("--bare");
    expect(options).toMatchObject({
      cwd: "/test/project",
      shell: false,
      env: { CLAUDE_CONFIG_DIR: "/test/auth", CUSTOM_TEST_SETTING: "preserved" },
    });
    expect(options?.env?.CLAUDECODE).toBeUndefined();
    expect(child.sent[0]?.request).toEqual({ subtype: "initialize", hooks: null });
    expect(process.pid).toBe(child.pid);
    await process.stop();
  });

  it("sends stable user UUIDs and resumes the specified native session", async () => {
    const { child, process, spawnProcess } = setup({ resume: true });
    await process.start();
    process.sendUser(MESSAGE, "Continue");
    expect(vi.mocked(spawnProcess).mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(["--resume", SESSION]),
    );
    expect(child.sent.at(-1)).toEqual({
      type: "user",
      uuid: MESSAGE,
      session_id: SESSION,
      parent_tool_use_id: null,
      message: { role: "user", content: "Continue" },
    });
    expect(() => process.sendUser("../bad", "x")).toThrow("UUID");
    await process.stop();
  });

  it("does not block event consumption on permissions and preserves fragmented UTF-8/unknown events", async () => {
    const { child, process } = setup();
    const requests: ObjectMessage[] = [];
    const events: ObjectMessage[] = [];
    process.on("request", (request: ObjectMessage) => requests.push(request));
    process.on("event", (event: ObjectMessage) => events.push(event));
    await process.start();
    child.output({
      type: "control_request",
      request_id: "permission-1",
      request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "pwd" } },
    });
    const line = Buffer.from(
      JSON.stringify({ type: "future_native_event", text: "Привет 🐣" }) + "\r\n",
    );
    const split = line.indexOf(Buffer.from("Привет")) + 1;
    child.stdout.write(line.subarray(0, split));
    child.stdout.write(line.subarray(split, line.length - 1));
    child.stdout.write(line.subarray(line.length - 1));
    expect(requests).toHaveLength(1);
    expect(events).toEqual([{ type: "future_native_event", text: "Привет 🐣" }]);
    process.respond("permission-1", { behavior: "allow", updatedInput: { command: "pwd" } });
    expect(child.sent.at(-1)).toEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "permission-1",
        response: { behavior: "allow", updatedInput: { command: "pwd" } },
      },
    });
    expect(() => process.respond("permission-1", {})).toThrow("no longer pending");
    await process.stop();
  });

  it("withdraws cancelled questions and passes user acknowledgements through unchanged", async () => {
    const { child, process } = setup();
    const cancelled = vi.fn();
    const event = vi.fn();
    process.on("requestCancelled", cancelled);
    process.on("event", event);
    await process.start();
    child.output({
      type: "control_request",
      request_id: "question",
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        input: { questions: [] },
      },
    });
    child.output({ type: "control_cancel_request", request_id: "question" });
    expect(cancelled).toHaveBeenCalledWith("question");
    expect(() => process.respond("question", { behavior: "allow" })).toThrow("no longer pending");
    const ack = { type: "user", uuid: MESSAGE, message: { role: "user", content: "hi" } };
    child.output(ack);
    expect(event).toHaveBeenCalledWith(ack);
    await process.stop();
  });

  it("matches control responses by ID, ignores unrelated responses, and rejects on timeout", async () => {
    vi.useFakeTimers();
    const { child, process } = setup();
    await process.start();
    child.autoInterrupt = false;
    const promise = process.interrupt();
    const rejection = expect(promise).rejects.toThrow("timed out: interrupt");
    child.output({
      type: "control_response",
      response: { subtype: "success", request_id: "other", response: {} },
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
    child.close();
  });

  it("rejects a pending initialization on exit without exposing stderr or vendor error payloads", async () => {
    const { child, process, errors } = setup();
    child.autoInitialize = false;
    child.autoFinish = false;
    const promise = process.start();
    const rejection = expect(promise).rejects.toThrow("exited");
    child.stderr.write("AUTH_SECRET_NOT_FOR_ERRORS");
    child.close(1);
    await rejection;
    expect(errors).toEqual([]);
  });

  it("does not report ready if the CLI exits immediately after its initialization reply", async () => {
    const { child, process } = setup();
    child.exitAfterInitialize = true;
    await expect(process.start()).rejects.toThrow("exited during initialization");
    expect(() => process.sendUser(MESSAGE, "late")).toThrow("not ready");
  });

  it("rejects failed control replies without echoing confidential payloads", async () => {
    const { child, process } = setup();
    await process.start();
    child.autoInterrupt = false;
    const promise = process.interrupt();
    const rejection = expect(promise).rejects.toThrow(/^Claude CLI rejected the control request$/);
    child.output({
      type: "control_response",
      response: {
        subtype: "error",
        request_id: child.sent.at(-1)?.request_id,
        error: "CONFIDENTIAL_TOOL_OUTPUT",
      },
    });
    await rejection;
    child.close();
  });

  it("fails bounded oversized or malformed output without retaining or exposing raw JSON", async () => {
    const first = setup();
    await first.process.start();
    first.child.stdout.write("x".repeat(16 * 1024 * 1024 + 1));
    expect(first.errors.map((error) => error.message)).toEqual([
      "Claude output line limit exceeded",
    ]);
    expect(first.child.kill).toHaveBeenCalledWith("SIGTERM");
    first.child.close();
    const second = setup();
    await second.process.start();
    second.child.stdout.write("AUTH_SECRET_INVALID_JSON\n");
    expect(second.errors.map((error) => error.message)).toEqual([
      "Claude CLI returned invalid stream JSON",
    ]);
    second.child.close();
  });

  it("interrupts then closes stdin for a graceful stop without changing other processes", async () => {
    const { child, process } = setup();
    await process.start();
    await process.stop();
    expect(child.sent.at(-1)?.request).toEqual({ subtype: "interrupt" });
    expect(child.stdin.writableEnded).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
    expect(() => process.sendUser(MESSAGE, "late")).toThrow("not ready");
    await process.stop();
  });
});
