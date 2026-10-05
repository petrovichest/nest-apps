export const RUNNER_PROTOCOL_VERSION = 1 as const;
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type RunnerState =
  "starting" | "idle" | "running" | "waiting" | "interrupted" | "failed" | "closed";

export interface RunnerDescriptor {
  sessionId: string;
  cwd: string;
  claudeBin: string;
  nodeBin: string;
  releasePath: string;
  runnerPath: string;
  configDir: string;
  socketPath: string;
  stateDirectory: string;
  resume: boolean;
  model?: string;
  protocolVersion: 1;
}

export interface CommandReceipt {
  requestId: string;
  kind: "send" | "interrupt" | "respond";
  fingerprint: string;
  status: "accepted" | "completed" | "unknown";
  error?: string;
}

export interface PendingRequest {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface RunnerSnapshot {
  sessionId: string;
  runnerInstanceId: string;
  protocolVersion: 1;
  releasePath: string;
  claudeVersion: string;
  runnerPid: number;
  claudePid?: number;
  cwd: string;
  state: RunnerState;
  sequence: number;
  pendingRequests: PendingRequest[];
  currentEvents: Record<string, unknown>[];
  commands: CommandReceipt[];
}

export interface RunnerEvent {
  sessionId: string;
  runnerInstanceId: string;
  sequence: number;
  kind: "native" | "request" | "request.cancelled" | "state" | "command";
  data: unknown;
}

export type RpcRequest = { id: string; method: string; params?: unknown };
export type RpcMessage =
  | { id: string; result: unknown }
  | { id: string; error: { code: string; message: string } }
  | { type: "event"; event: RunnerEvent }
  | { type: "snapshot"; snapshot: RunnerSnapshot };

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

export function assertUuid(value: unknown, name = "ID"): asserts value is string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new AppError("invalid_request", `${name} must be a UUID`);
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("invalid_request", "Expected a JSON object");
  }
  return value as Record<string, unknown>;
}
