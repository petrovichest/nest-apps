import type { Turn } from "./codex/generated/v2/Turn";
import type { RpcError } from "./codex/transport";

export const CAPACITY_RETRY_INTERVAL_MS = 5 * 60_000;
export const CAPACITY_RETRY_MESSAGE_PREFIX = "codexnest-capacity-retry:";
export const CAPACITY_RETRY_MESSAGE =
  "Continue the user's unfinished task from where model capacity interrupted it. Review the existing results and changes before acting, and preserve the current mode and settings.";
export const ACCOUNT_RETRY_MESSAGE =
  "Continue the user's unfinished task from where an account limit or expired authentication interrupted it. Read the existing results and changes first. Do not repeat completed actions, and preserve the current mode and settings.";

export function isCapacityFailure(turn: Pick<Turn, "status" | "error">): boolean {
  return turn.status === "failed" && turn.error?.codexErrorInfo === "serverOverloaded";
}

export function capacityRetryMessageId(turnId: string): string {
  return `${CAPACITY_RETRY_MESSAGE_PREFIX}${turnId}`;
}

/** Only known temporary RPC failures may keep a capacity retry alive. */
export function isTemporaryCapacityRpcError(error: RpcError): boolean {
  const data = error.data as {
    codexErrorInfo?: unknown;
    error?: { codexErrorInfo?: unknown };
  } | null;
  return (
    data?.codexErrorInfo === "serverOverloaded" ||
    data?.error?.codexErrorInfo === "serverOverloaded" ||
    /\b(at capacity|server overloaded|model overloaded|temporarily unavailable|service unavailable)\b/i.test(
      error.message,
    )
  );
}
