import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ChildProcess from "node:child_process";
import type * as FileSystem from "node:fs/promises";
import type { RunnerDescriptor } from "./types.js";

const { command, processes } = vi.hoisted(() => ({ command: vi.fn(), processes: vi.fn() }));
vi.mock("node:child_process", async (original) => {
  const module = await original<typeof ChildProcess>();
  const { promisify } = await import("node:util");
  const execFile = Object.assign(vi.fn(), { [promisify.custom]: command });
  return { ...module, execFile };
});
vi.mock("node:fs/promises", async (original) => {
  const module = await original<typeof FileSystem>();
  return {
    ...module,
    readFile: (...args: Parameters<typeof module.readFile>) =>
      String(args[0]).startsWith("/sys/fs/cgroup/") ? processes(...args) : module.readFile(...args),
  };
});
import { SystemdLauncher } from "./manager.js";

const id = "11111111-1111-4111-8111-111111111111";
const descriptor = {
  sessionId: id,
  nodeBin: "/node",
  runnerPath: "/runner",
  releasePath: "/release",
} as RunnerDescriptor;
const unit = `claudenest-session-${id}.service`;
let state: string;
beforeEach(() => {
  vi.clearAllMocks();
  state = "inactive";
  processes.mockResolvedValue("");
  command.mockImplementation(async (program: string, args: string[]) => {
    if (program === "systemctl" && args.includes("show"))
      return {
        stdout: args.includes("--value")
          ? `${state}\n`
          : `ActiveState=${state}\nControlGroup=/test-session\n`,
        stderr: "",
      };
    if (args.includes("reset-failed")) state = "inactive";
    if (args.includes("kill")) state = "inactive";
    return { stdout: "", stderr: "" };
  });
});

describe("session systemd lifecycle", () => {
  it("resets an empty failed session unit before starting the same session", async () => {
    state = "failed";
    await new SystemdLauncher("/private/server.env").start(descriptor, "/descriptor");
    const calls = command.mock.calls;
    const reset = calls.findIndex(
      ([program, args]) => program === "systemctl" && args.includes("reset-failed"),
    );
    const start = calls.findIndex(([program]) => program === "systemd-run");
    expect(reset).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThan(reset);
    expect(calls[reset]?.[1]).toContain(unit);
  });

  it.each(["active", "activating", "reloading", "deactivating"])(
    "does not replace a %s unit",
    async (active) => {
      state = active;
      await new SystemdLauncher("/env").start(descriptor, "/descriptor");
      expect(
        command.mock.calls.every(
          ([program, args]) => program === "systemctl" && args.includes("show"),
        ),
      ).toBe(true);
    },
  );

  it("keeps a failed unit with remaining privileged processes blocked", async () => {
    state = "failed";
    processes.mockResolvedValue("1234\n");
    await expect(new SystemdLauncher("/env").start(descriptor, "/descriptor")).rejects.toThrow(
      "still contains processes",
    );
    expect(
      command.mock.calls.some(
        ([program, args]) => program === "systemd-run" || args.includes("reset-failed"),
      ),
    ).toBe(false);
  });

  it("forces only the named session service after native grace has expired", async () => {
    state = "active";
    await new SystemdLauncher("/env").stop(id);
    expect(
      command.mock.calls.some(
        ([program, args]) =>
          program === "systemctl" &&
          args.includes("kill") &&
          args.includes(unit) &&
          args.includes("--signal=SIGKILL"),
      ),
    ).toBe(true);
    expect(command.mock.calls.every(([, args]) => args.includes(unit))).toBe(true);
  });

  it("accepts an already collected unit as successfully stopped", async () => {
    const normal = command.getMockImplementation()!;
    command.mockImplementation(async (program, args, options) => {
      if (args.includes("stop")) throw new Error("Unit not loaded");
      return normal(program, args, options);
    });
    await expect(new SystemdLauncher("/env").stop(id)).resolves.toBeUndefined();
    expect(command.mock.calls.some(([, args]) => args.includes("kill"))).toBe(false);
  });

  it("accepts collection between the active check and forced kill", async () => {
    state = "active";
    const normal = command.getMockImplementation()!;
    command.mockImplementation(async (program, args, options) => {
      if (args.includes("kill")) {
        state = "inactive";
        throw new Error("Unit already collected");
      }
      return normal(program, args, options);
    });
    await expect(new SystemdLauncher("/env").stop(id)).resolves.toBeUndefined();
  });
});
