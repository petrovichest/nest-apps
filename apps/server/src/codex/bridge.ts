import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";

import type { AppServerState } from "@codexnest/protocol";

import { safeError } from "../logging";
import type { InitializeResponse, ServerNotification, ServerRequest } from "./generated/index";
import { JsonlTransport, type JsonlProcess } from "./transport";

const execFileAsync = promisify(execFile);
const BACKOFF_SECONDS = [1, 2, 4, 8, 16, 30] as const;

export interface SpawnBridgeProcess {
  (): JsonlProcess;
}

export interface BridgeOptions {
  codexBin: string;
  spawnProcess: SpawnBridgeProcess;
  checkVersion?: () => Promise<string>;
  random?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export class CodexBridge extends EventEmitter {
  private transport?: JsonlTransport;
  private child?: JsonlProcess;
  private restartTimer?: NodeJS.Timeout;
  private stableTimer?: NodeJS.Timeout;
  private restartAttempt = 0;
  private stopping = false;
  private _state: AppServerState = "unavailable";
  private _actualVersion?: string;
  private _deliveryVersion?: number;
  private _pendingTurnStarts = 0;
  private nativeTurns = new Map<string, { id: string; active: boolean }>();
  private requestRouter?: (method: string, params: unknown, timeoutMs: number) => Promise<unknown>;
  private nativeNotificationFilter?: (notification: ServerNotification) => boolean;
  accountSwitching = false;
  accountLoginRequired = false;

  constructor(private readonly options: BridgeOptions) {
    super();
  }

  get state(): AppServerState {
    return this._state;
  }

  get actualVersion(): string | undefined {
    return this._actualVersion;
  }

  get deliveryVersion(): number | undefined {
    return this._deliveryVersion;
  }

  get ready(): boolean {
    return this._state === "ready" && !!this.transport;
  }

  get pendingTurnStarts(): number {
    return this._pendingTurnStarts;
  }

  get activeNativeTurnCount(): number {
    return [...this.nativeTurns.values()].filter((turn) => turn.active).length;
  }

  setRequestRouter(
    router?: (method: string, params: unknown, timeoutMs: number) => Promise<unknown>,
  ): void {
    this.requestRouter = router;
  }
  setNativeNotificationFilter(filter?: (notification: ServerNotification) => boolean): void {
    this.nativeNotificationFilter = filter;
  }

  threadActive(id: string): boolean {
    return this.nativeTurns.get(id)?.active === true;
  }

  acceptNotification(notification: ServerNotification): void {
    if (notification.method === "turn/started" || notification.method === "turn/completed") {
      this.nativeTurns.set(notification.params.threadId, {
        id: notification.params.turn.id,
        active: notification.method === "turn/started",
      });
    }
    this.emit("notification", notification);
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.setState("starting");
    const checkVersion =
      this.options.checkVersion ?? (() => readCodexVersion(this.options.codexBin));
    try {
      this._actualVersion = await checkVersion();
    } catch (error) {
      this.setState("unavailable", safeError(error));
      this.scheduleRestart();
      return;
    }
    await this.launch();
  }

  stop(): void {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.restartTimer = undefined;
    this.stableTimer = undefined;
    this.transport?.shutdown();
    this.transport = undefined;
    this.child?.kill("SIGTERM");
    this.child = undefined;
    this.setState("unavailable");
  }

  async request<T>(method: string, params: unknown, timeoutMs = 15_000): Promise<T> {
    if (!this.transport || !this.ready) {
      throw new BridgeUnavailableError(this._state);
    }
    const startsTurn = ["turn/start", "review/start", "thread/realtime/start"].includes(method);
    if (startsTurn && this.accountSwitching) throw new AccountSwitchInProgressError();
    if (startsTurn && this.accountLoginRequired && !this.requestRouter)
      throw new AccountLoginRequiredError();
    if (startsTurn) this._pendingTurnStarts++;
    try {
      const result = this.requestRouter
        ? ((await this.requestRouter(method, params, timeoutMs)) as T)
        : await this.requestNative<T>(method, params, timeoutMs);
      if (method === "turn/start" || method === "review/start") {
        const response = result as {
          turn?: { id: string; status: string };
          reviewThreadId?: string;
        };
        const threadId = response.reviewThreadId ?? (params as { threadId?: string })?.threadId;
        if (
          threadId &&
          response.turn?.status === "inProgress" &&
          this.nativeTurns.get(threadId)?.id !== response.turn.id
        )
          this.nativeTurns.set(threadId, { id: response.turn.id, active: true });
      }
      if (["thread/read", "thread/resume"].includes(method)) {
        const { thread } = result as {
          thread?: {
            id: string;
            status?: { type: string };
            turns?: Array<{ id: string; status: string }>;
          };
        };
        if (thread?.status?.type === "active") {
          const turn = thread.turns
            ?.slice()
            .reverse()
            .find((turn) => turn.status === "inProgress");
          this.nativeTurns.set(thread.id, {
            id: turn?.id ?? this.nativeTurns.get(thread.id)?.id ?? "unknown",
            active: true,
          });
        } else if (thread?.id && this.nativeTurns.has(thread.id)) {
          const previous = this.nativeTurns.get(thread.id)!;
          this.nativeTurns.set(thread.id, { ...previous, active: false });
        }
      }
      return result;
    } finally {
      if (startsTurn) this._pendingTurnStarts--;
    }
  }

  /** The original daemon connection. Account routing uses this only for history/global settings. */
  async requestNative<T>(method: string, params: unknown, timeoutMs = 15_000): Promise<T> {
    if (!this.transport || !this.ready) throw new BridgeUnavailableError(this._state);
    return this.transport.request<T>(method, params, timeoutMs);
  }

  respond(id: number | string, result: unknown): void {
    if (!this.transport || !this.ready) throw new BridgeUnavailableError(this._state);
    this.transport.respond(id, result);
  }

  private async launch(): Promise<void> {
    if (this.stopping) return;
    this._deliveryVersion = undefined;
    this.setState("starting");
    let child: JsonlProcess;
    try {
      child = this.options.spawnProcess();
    } catch (error) {
      this.setState("unavailable", safeError(error));
      this.scheduleRestart();
      return;
    }
    this.child = child;
    let transportDetail = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      transportDetail = `${transportDetail}${chunk.toString()}`.slice(-2_000);
    });
    child.stderr?.resume();
    const transport = new JsonlTransport(child);
    this.transport = transport;
    transport.on("notification", (notification: ServerNotification) => {
      this.emit("nativeNotification", notification);
      if (this.nativeNotificationFilter?.(notification) !== false)
        this.acceptNotification(notification);
    });
    transport.on("request", (request: ServerRequest) => this.emit("request", request, transport));
    transport.on("unknownResponse", (id: number) => this.emit("unknownResponse", id));
    transport.on("protocolError", (error: Error) => this.emit("protocolError", error));
    transport.on("exit", () => {
      if (this.stableTimer) clearTimeout(this.stableTimer);
      this.stableTimer = undefined;
      if (this.transport === transport) this.transport = undefined;
      if (this.child === child) this.child = undefined;
      if (!this.stopping) {
        const message = transportDetail.trim() || "Codex app-server transport exited";
        this.setState("unavailable", new Error(message));
        this.scheduleRestart();
      }
    });

    try {
      const initialized = await transport.request<
        InitializeResponse & { durableDeliveryVersion?: number | null }
      >(
        "initialize",
        {
          clientInfo: { name: "codexnest", title: "CodexNest", version: "0.1.0" },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
            mcpServerOpenaiFormElicitation: false,
          },
        },
        10_000,
      );
      this._deliveryVersion = initialized.durableDeliveryVersion ?? undefined;
      transport.notify("initialized");
      this.setState("ready");
      this.stableTimer = setTimeout(() => {
        this.restartAttempt = 0;
      }, 60_000);
      this.stableTimer.unref();
    } catch (error) {
      transport.shutdown(error instanceof Error ? error : new Error(String(error)));
      child.kill("SIGTERM");
      this.setState("unavailable", safeError(error));
      this.scheduleRestart();
    }
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer) return;
    const index = Math.min(this.restartAttempt, BACKOFF_SECONDS.length - 1);
    const baseMs = (BACKOFF_SECONDS[index] ?? 30) * 1_000;
    this.restartAttempt += 1;
    const random = this.options.random ?? Math.random;
    const jitteredMs = Math.round(baseMs * (0.8 + random() * 0.4));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.start();
    }, jitteredMs);
    this.restartTimer.unref();
  }

  private setState(state: AppServerState, detail?: unknown): void {
    if (state !== "ready") this.nativeTurns.clear();
    this._state = state;
    this.emit("state", state, detail);
  }
}

export class AccountSwitchInProgressError extends Error {
  constructor() {
    super("Codex account is switching; retry the message shortly");
    this.name = "AccountSwitchInProgressError";
  }
}

export class AccountLoginRequiredError extends Error {
  constructor() {
    super("Codex account needs a ChatGPT login");
    this.name = "AccountLoginRequiredError";
  }
}

export class BridgeUnavailableError extends Error {
  constructor(public readonly bridgeState: AppServerState) {
    super("Codex app-server is unavailable");
    this.name = "BridgeUnavailableError";
  }
}

async function readCodexVersion(codexBin: string): Promise<string> {
  const { stdout } = await execFileAsync(codexBin, ["--version"], { timeout: 10_000 });
  const match = /codex-cli\s+([^\s]+)/.exec(stdout);
  if (!match) throw new Error("Unable to parse Codex CLI version");
  return match[1]!;
}
