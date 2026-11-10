import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { openSync, closeSync } from "node:fs";
import { access, mkdir, open, readFile, stat, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { ParsedClaudeProxy } from "@codexnest/protocol";
import { CodexBridge } from "./codex/bridge";
import { connectUnixWebSocket } from "./codex/transport";
import type { ServerNotification, ServerRequest } from "./codex/generated/index";
import type { JsonlTransport } from "./codex/transport";

const exec = promisify(execFile);
export type AccountRuntimeDescriptor = {
  version: 1;
  id: string;
  accountId: string;
  fingerprint: string;
  home: string;
  historyHome: string;
  native: boolean;
  codexBin: string;
  proxy: ParsedClaudeProxy | null;
  socketPath: string;
  directory: string;
  retired?: boolean;
  /** Isolated-fixture overrides; production descriptors leave these unset. */
  nativeArgs?: string[];
  environment?: NodeJS.ProcessEnv;
};
export type AccountRuntimeState = {
  id: string;
  fingerprint: string;
  state: "starting" | "ready" | "failed";
  cliVersion: string | null;
  pid: number;
};
export type AccountRuntimeProfile = {
  id: string;
  home: string;
  native: boolean;
  proxy: ParsedClaudeProxy | null;
};
export type AccountRuntimeOptions = {
  stateDir: string;
  historyHome: string;
  codexBin: string;
  envFile: string;
  descriptors: AccountRuntimeDescriptor[];
  remember(descriptor: AccountRuntimeDescriptor): Promise<void>;
  workerPath?: string;
  socketRoot?: string;
  nativeArgs?: string[];
  environment?: NodeJS.ProcessEnv;
  launcher?: AccountRuntimeLauncher;
  expectedDeliveryVersion?: () => number | undefined;
  nativeVersion?: () => string | undefined;
};
export interface AccountRuntimeLauncher {
  start(descriptor: AccountRuntimeDescriptor, path: string, workerPath: string): Promise<void>;
  stop(descriptor: AccountRuntimeDescriptor): Promise<void>;
}

export class AccountRuntimeError extends Error {
  constructor(message = "Could not connect to the account runtime; check its proxy and retry") {
    super(message);
    this.name = "AccountRuntimeError";
  }
}

/** Each native process keeps its own immutable authentication and egress; API restarts only reconnect. */
export class AccountRuntimePool extends EventEmitter {
  private clients = new Map<string, CodexBridge>();
  private opening = new Map<string, Promise<CodexBridge>>();
  private persisting = new Map<string, Promise<void>>();
  private closed = false;
  private readonly socketRoot: string;
  private readonly launcher: AccountRuntimeLauncher;
  private readonly workerPath: string;
  constructor(private readonly options: AccountRuntimeOptions) {
    super();
    this.socketRoot =
      options.socketRoot ??
      join(
        process.env.XDG_RUNTIME_DIR || tmpdir(),
        `codexnest-accounts-${process.getuid?.() ?? "user"}`,
        createHash("sha256").update(resolve(options.stateDir)).digest("hex").slice(0, 8),
      );
    this.launcher = options.launcher ?? new SystemdAccountRuntimeLauncher(options.envFile);
    this.workerPath =
      options.workerPath ??
      fileURLToPath(
        new URL(
          import.meta.url.endsWith(".ts")
            ? "./account-runtime-main.ts"
            : "./account-runtime-main.js",
          import.meta.url,
        ),
      );
  }
  descriptors(): readonly AccountRuntimeDescriptor[] {
    return this.options.descriptors;
  }
  descriptor(id: string): AccountRuntimeDescriptor {
    const value = this.options.descriptors.find((entry) => entry.id === id);
    if (!value) throw new AccountRuntimeError("Account runtime not found");
    return value;
  }
  matches(descriptor: AccountRuntimeDescriptor, profile: AccountRuntimeProfile): boolean {
    return descriptor.fingerprint === fingerprint(profile, this.options.nativeVersion?.());
  }
  async ensure(
    profile: AccountRuntimeProfile,
  ): Promise<{ descriptor: AccountRuntimeDescriptor; bridge: CodexBridge }> {
    const key = fingerprint(profile, this.options.nativeVersion?.());
    let descriptor = this.options.descriptors.find(
      (entry) => !entry.retired && entry.accountId === profile.id && entry.fingerprint === key,
    );
    if (!descriptor) {
      // Resolve before the first await so concurrent first turns cannot reserve two owners.
      const id = randomUUID();
      descriptor = {
        version: 1,
        id,
        accountId: profile.id,
        fingerprint: key,
        home: profile.home,
        historyHome: this.options.historyHome,
        native: profile.native,
        codexBin: this.options.codexBin,
        proxy: structuredClone(profile.proxy),
        socketPath: join(this.socketRoot, `${id}.sock`),
        directory: join(this.options.stateDir, "account-runtimes", id),
        ...(this.options.nativeArgs ? { nativeArgs: this.options.nativeArgs } : {}),
        ...(this.options.environment ? { environment: this.options.environment } : {}),
      };
      this.options.descriptors.push(descriptor);
      this.persisting.set(id, this.options.remember(descriptor));
    }
    return { descriptor, bridge: await this.connect(descriptor.id) };
  }
  connect(id: string): Promise<CodexBridge> {
    if (this.closed)
      return Promise.reject(new AccountRuntimeError("Account runtimes are shutting down"));
    if (this.descriptor(id).retired)
      return Promise.reject(new AccountRuntimeError("Account connection has been replaced"));
    const ready = this.clients.get(id);
    if (ready?.ready) return Promise.resolve(ready);
    const opening = this.opening.get(id);
    if (opening) return opening;
    const pending = (async () => {
      await this.persisting.get(id);
      return this.open(this.descriptor(id));
    })().finally(() => this.opening.delete(id));
    this.opening.set(id, pending);
    return pending;
  }
  active(id: string): boolean {
    const client = this.clients.get(id);
    return Boolean(client && (client.activeNativeTurnCount || client.pendingTurnStarts));
  }
  async stop(id: string): Promise<void> {
    if (this.active(id))
      throw new AccountRuntimeError(
        "Wait for this account's active responses before changing its connection",
      );
    this.clients.get(id)?.stop();
    this.clients.delete(id);
    await this.launcher.stop(this.descriptor(id));
  }
  async close(): Promise<void> {
    this.closed = true;
    // Closing a Unix WebSocket disconnects this API client; it does not kill the native process.
    for (const client of this.clients.values()) client.stop();
    this.clients.clear();
    await Promise.allSettled(this.opening.values());
  }
  private async open(descriptor: AccountRuntimeDescriptor): Promise<CodexBridge> {
    await mkdir(descriptor.directory, { recursive: true, mode: 0o700 });
    await mkdir(dirname(descriptor.socketPath), { recursive: true, mode: 0o700 });
    const metadata = await stat(dirname(descriptor.socketPath));
    if ((metadata.mode & 0o077) !== 0 || (process.getuid && metadata.uid !== process.getuid()))
      throw new AccountRuntimeError("Account socket directory must be private");
    const path = join(descriptor.directory, "descriptor.json");
    await writePrivateJson(path, descriptor);
    const statePath = join(descriptor.directory, "runtime.json");
    let state = await readPrivateJson<AccountRuntimeState>(statePath);
    // A live socket is verified by the initialize handshake below. Never replace an existing owner on a failed handshake.
    const socketExists = await access(descriptor.socketPath).then(
      () => true,
      () => false,
    );
    if (
      socketExists &&
      (state?.id !== descriptor.id || state.fingerprint !== descriptor.fingerprint)
    )
      throw new AccountRuntimeError("Account runtime ownership could not be verified");
    // The launcher checks only this descriptor's service/process. A stale socket is not a live owner.
    await this.launcher.start(descriptor, path, this.workerPath);
    state = await readPrivateJson<AccountRuntimeState>(statePath);
    if (state?.state !== "ready") {
      const deadline = Date.now() + 15_000;
      do {
        state = await readPrivateJson<AccountRuntimeState>(statePath);
        if (state?.state === "ready") break;
        if (this.closed || Date.now() >= deadline)
          throw new AccountRuntimeError("Account runtime did not become ready");
        await new Promise((resolve) => setTimeout(resolve, 50));
      } while (Date.now() < deadline && !this.closed);
    }
    if (
      state?.id !== descriptor.id ||
      state.fingerprint !== descriptor.fingerprint ||
      state.state !== "ready"
    )
      throw new AccountRuntimeError("Account runtime ownership could not be verified");
    const old = this.clients.get(descriptor.id);
    old?.stop();
    const bridge = new CodexBridge({
      codexBin: descriptor.codexBin,
      checkVersion: async () => state?.cliVersion ?? "unknown",
      spawnProcess: () => connectUnixWebSocket(descriptor.socketPath),
    });
    bridge.on("notification", (notice: ServerNotification) =>
      this.emit("notification", descriptor, notice),
    );
    bridge.on("request", (request: ServerRequest, transport: JsonlTransport) =>
      this.emit("request", descriptor, request, transport),
    );
    bridge.on("state", (status: string) => this.emit("state", descriptor, status));
    await bridge.start();
    if (this.closed || !bridge.ready) {
      bridge.stop();
      throw new AccountRuntimeError();
    }
    if (
      this.options.expectedDeliveryVersion &&
      bridge.deliveryVersion !== this.options.expectedDeliveryVersion()
    ) {
      bridge.stop();
      throw new AccountRuntimeError(
        "Account runtime uses an incompatible message delivery protocol",
      );
    }
    this.clients.set(descriptor.id, bridge);
    return bridge;
  }
}

function fingerprint(profile: AccountRuntimeProfile, nativeVersion?: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        profile.id,
        resolve(profile.home),
        profile.native,
        profile.proxy?.url ?? null,
        nativeVersion ?? null,
      ]),
    )
    .digest("hex");
}

/** Uses the existing user service manager only for application-owned account units. */
export class SystemdAccountRuntimeLauncher implements AccountRuntimeLauncher {
  constructor(private readonly envFile: string) {}
  private unit(descriptor: AccountRuntimeDescriptor) {
    return `codexnest-account-${descriptor.id}.service`;
  }
  async start(
    descriptor: AccountRuntimeDescriptor,
    path: string,
    workerPath: string,
  ): Promise<void> {
    try {
      const { stdout } = await exec(
        "systemctl",
        ["--user", "show", this.unit(descriptor), "-p", "ActiveState", "-p", "ControlGroup"],
        { timeout: 5_000 },
      );
      const properties = Object.fromEntries(
        stdout
          .trim()
          .split("\n")
          .map((line) => line.split("=", 2)),
      );
      if (
        ["active", "activating", "reloading", "deactivating"].includes(properties.ActiveState ?? "")
      )
        return;
      if (properties.ControlGroup) {
        const members = await readFile(
          join("/sys/fs/cgroup", properties.ControlGroup, "cgroup.procs"),
          "utf8",
        ).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "";
          throw error;
        });
        if (members.trim())
          throw new AccountRuntimeError("The previous account runtime has not stopped");
      }
      if (properties.ActiveState === "failed")
        await exec("systemctl", ["--user", "reset-failed", this.unit(descriptor)], {
          timeout: 5_000,
        });
      await rm(join(descriptor.directory, "runtime.json"), { force: true });
      const literal = (value: string) => value.replaceAll("$", "$$");
      await exec(
        "systemd-run",
        [
          "--user",
          "--collect",
          "--quiet",
          "--service-type=exec",
          `--unit=${this.unit(descriptor)}`,
          "--property=Restart=no",
          "--property=KillMode=control-group",
          "--property=UMask=0077",
          `--property=EnvironmentFile=${this.envFile}`,
          `--working-directory=${dirname(workerPath)}`,
          "--",
          literal(process.execPath),
          literal(workerPath),
          "--descriptor",
          literal(path),
        ],
        { timeout: 10_000 },
      );
    } catch {
      throw new AccountRuntimeError("Could not launch the account runtime service");
    }
  }
  async stop(descriptor: AccountRuntimeDescriptor): Promise<void> {
    try {
      await exec("systemctl", ["--user", "stop", this.unit(descriptor)], { timeout: 15_000 });
    } catch {
      throw new AccountRuntimeError("Could not stop the idle account runtime service");
    }
  }
}

/** Development/native-fixture launcher; children still outlive an API connection. */
export class DetachedAccountRuntimeLauncher implements AccountRuntimeLauncher {
  private processes = new Map<string, ReturnType<typeof spawn>>();
  async start(
    descriptor: AccountRuntimeDescriptor,
    path: string,
    workerPath: string,
  ): Promise<void> {
    const previous = this.processes.get(descriptor.id);
    if (previous && previous.exitCode === null && previous.signalCode === null) return;
    const recorded = await readPrivateJson<AccountRuntimeState>(
      join(descriptor.directory, "runtime.json"),
    );
    if (
      recorded &&
      recorded.id === descriptor.id &&
      recorded.fingerprint === descriptor.fingerprint
    ) {
      try {
        const command = await readFile(`/proc/${recorded.pid}/cmdline`, "utf8");
        if (command.split("\0").includes(path)) return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await rm(join(descriptor.directory, "runtime.json"), { force: true });
    const log = openSync(join(descriptor.directory, "worker.log"), "a", 0o600);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        process.execPath,
        [
          ...(workerPath.endsWith(".ts") ? ["--import", "tsx"] : []),
          workerPath,
          "--descriptor",
          path,
        ],
        {
          detached: true,
          stdio: ["ignore", log, log],
          env: descriptor.environment ?? process.env,
        },
      );
    } finally {
      closeSync(log);
    }
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    this.processes.set(descriptor.id, child);
    child.unref();
  }
  async stop(descriptor: AccountRuntimeDescriptor): Promise<void> {
    const child = this.processes.get(descriptor.id);
    // After an API restart, verify both the descriptor argument and detached process group.
    if (!child) {
      const state = await readPrivateJson<AccountRuntimeState>(
        join(descriptor.directory, "runtime.json"),
      );
      if (
        !state ||
        state.id !== descriptor.id ||
        state.fingerprint !== descriptor.fingerprint ||
        state.pid <= 1
      )
        throw new AccountRuntimeError("Account runtime ownership could not be verified");
      const owns = async () => {
        try {
          const command = await readFile(`/proc/${state.pid}/cmdline`, "utf8");
          if (!command.split("\0").includes(join(descriptor.directory, "descriptor.json")))
            return false;
          const status = await readFile(`/proc/${state.pid}/stat`, "utf8");
          return Number(status.slice(status.lastIndexOf(")") + 2).split(" ")[2]) === state.pid;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      };
      if (!(await owns())) return;
      process.kill(-state.pid, "SIGTERM");
      const deadline = Date.now() + 3_000;
      while (await owns()) {
        if (Date.now() >= deadline) {
          process.kill(-state.pid, "SIGKILL");
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return;
    }
    // A child handle is ownership; a recorded PID by itself is insufficient.
    const pid = child?.pid;
    if (!pid) return;
    if (child!.exitCode !== null || child!.signalCode !== null) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      this.processes.delete(descriptor.id);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* The owned process group may already have exited. */
        }
      }, 3_000);
      timer.unref();
      child!.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        process.kill(-pid, "SIGTERM");
      } catch (error) {
        clearTimeout(timer);
        if ((error as NodeJS.ErrnoException).code === "ESRCH") resolve();
        else reject(error);
      }
    });
    this.processes.delete(descriptor.id);
  }
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function readPrivateJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
