export const RUNNER_PROTOCOL_VERSION = 1 as const;
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type RunnerState =
  "starting" | "idle" | "running" | "waiting" | "interrupted" | "failed" | "closed";

export type ClaudePermissionMode =
  "manual" | "default" | "acceptEdits" | "bypassPermissions" | "plan" | "auto" | "dontAsk";
export interface ClaudeModel {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
}
export interface RunnerAttachment {
  id: string;
  name: string;
  path: string;
  size: number;
  mediaType: string;
}

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
  effort?: string;
  permissionMode?: ClaudePermissionMode;
  attachmentRoot?: string;
  protocolVersion: 1;
}

export interface CommandReceipt {
  requestId: string;
  kind: "send" | "steer" | "interrupt" | "respond" | "setModel" | "setPermissionMode";
  fingerprint: string;
  status: "accepted" | "completed" | "unknown";
  error?: string;
}

export interface PendingRequest {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  kind?: "toolApproval" | "userQuestion" | "other";
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
  awaitingResult?: boolean;
  sequence: number;
  pendingRequests: PendingRequest[];
  currentEvents: Record<string, unknown>[];
  commands: CommandReceipt[];
  capabilities?: {
    contentBlocks: boolean;
    uploadedImages: boolean;
    setModel: boolean;
    setPermissionMode: boolean;
    steer?: boolean;
    livePermissionMode?: boolean;
  };
  supportedModels?: ClaudeModel[];
  model?: string;
  permissionMode?: ClaudePermissionMode;
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

/** Native interruption failures carry internal diagnostics, not a model failure. */
export function nativeResultInterrupted(event: Record<string, unknown>): boolean {
  if (
    event.claudenest_interrupted === true ||
    event.subtype === "interrupted" ||
    event.terminal_reason === "aborted_streaming" ||
    event.terminal_reason === "aborted_tools"
  )
    return true;
  const details = [event.result, ...(Array.isArray(event.errors) ? event.errors : [])]
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value ?? "")))
    .join("\n");
  return (
    /\[ede_diagnostic\]|request interrupted by user/i.test(details) &&
    /interrupt|cancel(?:led|ed) by user|aborterror/i.test(details)
  );
}

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
