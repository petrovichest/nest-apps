import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, realpath, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Config } from "./config";
import { listHistory, readHistory } from "./history";
import { readJson, writeJsonAtomic } from "./io";
import { RunnerConnection } from "./rpc";
import {
  AppError,
  assertUuid,
  RUNNER_PROTOCOL_VERSION,
  type RunnerDescriptor,
  type RunnerSnapshot,
  type RunnerAttachment,
  type ClaudePermissionMode,
} from "./types";

const exec = promisify(execFile);
export interface SessionLauncher {
  available(): Promise<void>;
  start(descriptor: RunnerDescriptor, descriptorPath: string): Promise<void>;
  active(sessionId: string): Promise<boolean>;
}

export class SystemdLauncher implements SessionLauncher {
  constructor(private readonly envFile: string) {}
  async available(): Promise<void> {
    try {
      await exec("systemctl", ["--user", "show", "-p", "Version"], { timeout: 5_000 });
    } catch {
      throw new AppError(
        "unavailable",
        "A systemd user manager is required; enable linger for unattended sessions",
        503,
      );
    }
  }
  async active(sessionId: string): Promise<boolean> {
    try {
      const { stdout } = await exec(
        "systemctl",
        [
          "--user",
          "show",
          `claudenest-session-${sessionId}.service`,
          "-p",
          "ActiveState",
          "--value",
        ],
        { timeout: 5_000 },
      );
      return ["active", "activating", "reloading"].includes(stdout.trim());
    } catch {
      throw new AppError("unavailable", "Cannot verify the session service state", 503);
    }
  }
  async start(descriptor: RunnerDescriptor, descriptorPath: string): Promise<void> {
    // ExecStart has systemd's own $ expansion even without a shell.
    const literal = (value: string) => value.replaceAll("$", "$$");
    try {
      await exec(
        "systemd-run",
        [
          "--user",
          "--collect",
          "--quiet",
          "--service-type=exec",
          `--unit=claudenest-session-${descriptor.sessionId}`,
          "--property=Restart=no",
          "--property=KillMode=control-group",
          "--property=UMask=0077",
          `--property=EnvironmentFile=${this.envFile}`,
          `--working-directory=${descriptor.releasePath}`,
          "--",
          literal(descriptor.nodeBin),
          literal(descriptor.runnerPath),
          "--descriptor",
          literal(descriptorPath),
        ],
        { timeout: 10_000 },
      );
    } catch {
      // A retry must reconnect to an existing owner, never replace its service.
      if (!(await this.active(descriptor.sessionId)))
        throw new AppError("unavailable", "Could not launch the Claude session service", 503);
    }
  }
}

type LaunchIntent = { sessionId: string; requestId: string; fingerprint: string };
type CreateSession = {
  sessionId: string;
  requestId: string;
  cwd: string;
  prompt: string;
  model?: string;
  effort?: string;
  permissionMode?: ClaudePermissionMode;
  files?: RunnerAttachment[];
  images?: RunnerAttachment[];
};

export class SessionManager {
  private connections = new Map<string, RunnerConnection>();
  private locks = new Map<string, Promise<unknown>>();
  private closing = false;
  private paused = false;
  private lease?: NodeJS.Timeout;
  constructor(
    readonly config: Config,
    readonly launcher: SessionLauncher = new SystemdLauncher(config.serverEnvFile),
  ) {}

  async initialize(): Promise<void> {
    await this.launcher.available();
    this.paused = this.config.startPaused ?? false;
  }

  private directory(id: string): string {
    assertUuid(id, "sessionId");
    return join(this.config.stateDir, "sessions", id.toLowerCase());
  }
  private descriptorPath(id: string): string {
    return join(this.directory(id), "descriptor.json");
  }

  private withLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.locks.get(id) ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.locks.set(id, result);
    void result
      .finally(() => {
        if (this.locks.get(id) === result) this.locks.delete(id);
      })
      .catch(() => undefined);
    return result;
  }

  private assertAccepting(): void {
    if (this.closing || this.paused)
      throw new AppError("unavailable", "ClaudeNest is preparing an application restart", 503);
  }

  async descriptor(id: string): Promise<RunnerDescriptor | undefined> {
    return readJson<RunnerDescriptor>(this.descriptorPath(id));
  }

  private async connect(id: string, timeoutMs = 1_000): Promise<RunnerConnection> {
    const saved = this.connections.get(id);
    if (saved) return saved;
    const descriptor = await this.descriptor(id);
    if (!descriptor) throw new AppError("not_found", "This session has no ClaudeNest owner", 404);
    const connection = await RunnerConnection.open(descriptor.socketPath, timeoutMs);
    try {
      const hello = await connection.request<RunnerSnapshot>("hello", undefined, timeoutMs);
      if (
        hello.sessionId !== id ||
        hello.protocolVersion !== RUNNER_PROTOCOL_VERSION ||
        hello.releasePath !== descriptor.releasePath ||
        !hello.runnerInstanceId
      ) {
        throw new AppError("conflict", "Runner ownership or protocol could not be verified", 409);
      }
    } catch (error) {
      connection.close();
      throw error;
    }
    if (this.closing) {
      connection.close();
      throw new AppError("unavailable", "Backend is closing", 503);
    }
    const other = this.connections.get(id);
    if (other) {
      connection.close();
      return other;
    }
    this.connections.set(id, connection);
    connection.once("close", () => {
      if (this.connections.get(id) === connection) this.connections.delete(id);
    });
    return connection;
  }

  private async launch(descriptor: RunnerDescriptor): Promise<RunnerConnection> {
    if (!(await this.launcher.active(descriptor.sessionId))) {
      try {
        const existing = await RunnerConnection.open(descriptor.socketPath, 500);
        existing.close();
        throw new AppError("conflict", "An unverified owner still holds this socket", 409);
      } catch (error) {
        if (error instanceof AppError) throw error;
        await unlink(descriptor.socketPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    }
    await writeJsonAtomic(this.descriptorPath(descriptor.sessionId), descriptor);
    await this.launcher.start(descriptor, this.descriptorPath(descriptor.sessionId));
    const until = Date.now() + 120_000;
    while (Date.now() < until) {
      try {
        const connection = await this.connect(descriptor.sessionId);
        const snapshot = await connection.request<RunnerSnapshot>("snapshot");
        if (snapshot.state === "failed" || snapshot.state === "closed")
          throw new AppError("conflict", "Claude session failed during initialization", 409);
        if (snapshot.state !== "starting") return connection;
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error) {
        if (error instanceof AppError && error.code === "conflict") throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new AppError(
      "unavailable",
      "Runner did not become ready; retry with the same IDs to reconcile",
      503,
    );
  }

  private async makeDescriptor(
    id: string,
    cwd: string,
    resume: boolean,
    model?: string,
    effort?: string,
    permissionMode?: ClaudePermissionMode,
  ): Promise<RunnerDescriptor> {
    const canonicalCwd = await realpath(cwd).catch(() => {
      throw new AppError("invalid_request", "Project directory does not exist");
    });
    if (!(await stat(canonicalCwd)).isDirectory())
      throw new AppError("invalid_request", "Project path must be a directory");
    return {
      sessionId: id,
      cwd: canonicalCwd,
      claudeBin: this.config.claudeBin,
      nodeBin: this.config.nodeBin,
      releasePath: this.config.releasePath,
      runnerPath: this.config.runnerPath,
      configDir: this.config.configDir,
      socketPath: join(this.config.runtimeDir, `${id}.sock`),
      stateDirectory: this.directory(id),
      resume,
      model,
      effort,
      permissionMode,
      attachmentRoot: join(this.config.stateDir, "attachments"),
      protocolVersion: RUNNER_PROTOCOL_VERSION,
    };
  }

  private async assertNotExternallyActive(id: string): Promise<void> {
    let sessions: Array<Record<string, unknown>>;
    try {
      const { stdout } = await exec(this.config.claudeBin, ["agents", "--json"], {
        timeout: 10_000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, CLAUDE_CONFIG_DIR: this.config.configDir },
      });
      const parsed: unknown = JSON.parse(stdout);
      if (!Array.isArray(parsed)) throw new Error("Invalid session roster");
      sessions = parsed as Array<Record<string, unknown>>;
    } catch {
      throw new AppError(
        "conflict",
        "Cannot verify whether the native session is already controlled elsewhere",
        409,
      );
    }
    const active = sessions.some((item) => {
      return [item.sessionId, item.session_id, item.id].some(
        (value) => typeof value === "string" && value.toLowerCase() === id,
      );
    });
    if (active)
      throw new AppError(
        "conflict",
        "This native session is controlled by another Claude process",
        409,
      );
  }

  async create(input: CreateSession): Promise<unknown> {
    this.assertAccepting();
    assertUuid(input.sessionId, "sessionId");
    assertUuid(input.requestId, "requestId");
    const id = input.sessionId.toLowerCase();
    return this.withLock(id, async () => {
      const descriptor = await this.makeDescriptor(
        id,
        input.cwd,
        false,
        input.model,
        input.effort,
        input.permissionMode,
      );
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            cwd: descriptor.cwd,
            prompt: input.prompt,
            model: input.model ?? null,
            ...(input.effort ? { effort: input.effort } : {}),
            ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
            ...(input.files?.length ? { files: input.files } : {}),
            ...(input.images?.length ? { images: input.images } : {}),
          }),
        )
        .digest("hex");
      const intentPath = join(this.directory(id), "launch.json");
      const intent = await readJson<LaunchIntent>(intentPath);
      if (intent && (intent.requestId !== input.requestId || intent.fingerprint !== fingerprint))
        throw new AppError(
          "conflict",
          "Session creation ID was already used for different input",
          409,
        );
      await mkdir(this.directory(id), { recursive: true, mode: 0o700 });
      let connection: RunnerConnection;
      if (intent) {
        try {
          connection = await this.connect(id);
        } catch (error) {
          if (error instanceof AppError && error.code === "conflict") throw error;
          if (await this.launcher.active(id))
            throw new AppError(
              "unavailable",
              "Existing owner is not reachable; it will not be replaced",
              503,
            );
          const state = await readJson<RunnerSnapshot>(
            join(this.directory(id), "runner-state.json"),
          );
          if (state || (await this.hasNativeHistory(id)))
            throw new AppError(
              "conflict",
              "The previous owner ended; explicitly resume with a new message ID",
              409,
            );
          connection = await this.launch(descriptor);
        }
      } else {
        if ((await this.hasNativeHistory(id)) || (await this.launcher.active(id)))
          throw new AppError("conflict", "Session ID already exists", 409);
        await writeJsonAtomic(intentPath, {
          sessionId: id,
          requestId: input.requestId,
          fingerprint,
        } satisfies LaunchIntent);
        connection = await this.launch(descriptor);
      }
      return connection.request("send", {
        requestId: input.requestId,
        text: input.prompt,
        ...(input.files?.length ? { files: input.files } : {}),
        ...(input.images?.length ? { images: input.images } : {}),
      });
    });
  }

  private async hasNativeHistory(id: string): Promise<boolean> {
    try {
      await readHistory(this.config.configDir, id);
      return true;
    } catch (error) {
      if ((error as any).code === "not_found" || (error as any).code === "ENOENT") return false;
      throw error;
    }
  }

  async send(
    id: string,
    requestId: string,
    prompt: string,
    content?: { files?: RunnerAttachment[]; images?: RunnerAttachment[] },
    launch?: { model?: string; effort?: string; permissionMode?: ClaudePermissionMode },
  ): Promise<unknown> {
    this.assertAccepting();
    assertUuid(id, "sessionId");
    assertUuid(requestId, "requestId");
    id = id.toLowerCase();
    return this.withLock(id, async () => {
      let connection: RunnerConnection;
      try {
        connection = await this.connect(id);
      } catch (error) {
        if (error instanceof AppError && error.code === "conflict") throw error;
        if (await this.launcher.active(id))
          throw new AppError("unavailable", "Existing session owner is not reachable", 503);
        const previous = await this.descriptor(id);
        const receipts = await readJson<Array<{ requestId: string }>>(
          join(this.directory(id), "commands.json"),
        );
        if (receipts?.some((receipt) => receipt.requestId === requestId))
          throw new AppError(
            "conflict",
            "Previous command outcome requires reconciliation; use a new ID only for an explicit new message",
            409,
          );
        const history = await readHistory(this.config.configDir, id);
        await this.assertNotExternallyActive(id);
        connection = await this.launch(
          await this.makeDescriptor(
            id,
            previous?.cwd ?? history.cwd,
            true,
            launch?.model ?? previous?.model,
            launch?.effort ?? previous?.effort,
            launch?.permissionMode ?? previous?.permissionMode,
          ),
        );
      }
      return connection.request("send", { requestId, text: prompt, ...content });
    });
  }

  /** Busy input never starts or replaces a missing native owner. */
  async steer(
    id: string,
    requestId: string,
    prompt: string,
    content?: { files?: RunnerAttachment[]; images?: RunnerAttachment[] },
  ): Promise<unknown> {
    this.assertAccepting();
    assertUuid(id, "sessionId");
    assertUuid(requestId, "requestId");
    id = id.toLowerCase();
    return this.withLock(id, async () =>
      (await this.connect(id)).request("steer", { requestId, text: prompt, ...content }),
    );
  }

  async command(
    id: string,
    method: "interrupt" | "respond" | "release" | "setModel" | "setPermissionMode",
    params: unknown,
  ): Promise<unknown> {
    this.assertAccepting();
    assertUuid(id, "sessionId");
    id = id.toLowerCase();
    return this.withLock(id, async () => (await this.connect(id)).request(method, params));
  }

  async snapshot(id: string): Promise<RunnerSnapshot> {
    assertUuid(id, "sessionId");
    return (await this.connect(id.toLowerCase())).request<RunnerSnapshot>("snapshot");
  }

  async subscribe(id: string): Promise<RunnerConnection> {
    assertUuid(id, "sessionId");
    id = id.toLowerCase();
    const descriptor = await this.descriptor(id);
    if (!descriptor) throw new AppError("not_found", "No live ClaudeNest owner", 404);
    const connection = await RunnerConnection.open(descriptor.socketPath);
    try {
      const hello = await connection.request<RunnerSnapshot>("hello");
      if (
        hello.sessionId !== id ||
        hello.protocolVersion !== RUNNER_PROTOCOL_VERSION ||
        hello.releasePath !== descriptor.releasePath ||
        !hello.runnerInstanceId
      )
        throw new AppError("conflict", "Runner ownership could not be verified", 409);
      return connection;
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  async list(cwd?: string): Promise<unknown[]> {
    const history = await listHistory(this.config.configDir, cwd);
    const items = new Map(
      history.map((item) => [
        item.sessionId,
        { ...item, managed: false } as Record<string, unknown>,
      ]),
    );
    const dirs = await readdir(join(this.config.stateDir, "sessions")).catch(() => [] as string[]);
    await Promise.all(
      dirs
        .filter((id) => /^[0-9a-f-]{36}$/.test(id))
        .map(async (id) => {
          const descriptor = await this.descriptor(id);
          if (!descriptor || (cwd && descriptor.cwd !== cwd)) return;
          let snapshot: RunnerSnapshot | undefined;
          try {
            snapshot = await this.snapshot(id);
          } catch {
            snapshot = await readJson<RunnerSnapshot>(
              join(this.directory(id), "runner-state.json"),
            );
          }
          items.set(id, {
            ...items.get(id),
            sessionId: id,
            cwd: descriptor.cwd,
            managed: true,
            state: this.connections.has(id) ? snapshot?.state : "unavailable",
            releasePath: descriptor.releasePath,
          });
        }),
    );
    return [...items.values()];
  }

  async prepare(
    protocols: number[],
  ): Promise<{ supportedRunnerProtocols: number[]; runners: number; releasePaths: string[] }> {
    this.paused = true;
    try {
      await Promise.all([...this.locks.values()].map((pending) => pending.catch(() => undefined)));
      const dirs = await readdir(join(this.config.stateDir, "sessions")).catch(
        () => [] as string[],
      );
      const snapshots: RunnerSnapshot[] = [];
      for (const id of dirs) {
        if (!/^[0-9a-f-]{36}$/.test(id)) continue;
        try {
          snapshots.push(await this.snapshot(id));
        } catch (error) {
          if (await this.launcher.active(id)) throw error;
        }
      }
      if (snapshots.some((snapshot) => !protocols.includes(snapshot.protocolVersion)))
        throw new AppError(
          "conflict",
          "Target backend cannot recover all live runner protocols",
          409,
        );
      if (this.lease) clearTimeout(this.lease);
      this.lease = setTimeout(() => this.resume(), 120_000);
      this.lease.unref();
      return {
        supportedRunnerProtocols: [RUNNER_PROTOCOL_VERSION],
        runners: snapshots.length,
        releasePaths: [...new Set(snapshots.map((snapshot) => snapshot.releasePath))],
      };
    } catch (error) {
      this.resume();
      throw error;
    }
  }

  resume(): void {
    this.paused = false;
    if (this.lease) clearTimeout(this.lease);
    this.lease = undefined;
  }
  get accepting(): boolean {
    return !this.paused && !this.closing;
  }
  async close(): Promise<void> {
    this.closing = true;
    this.resume();
    await Promise.all([...this.locks.values()].map((pending) => pending.catch(() => undefined)));
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
  }
}
