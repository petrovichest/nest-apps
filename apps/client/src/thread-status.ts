import type { ThreadSummary } from "@codexnest/protocol";

export function hasAlwaysVisibleThreadStatus(
  thread: Pick<ThreadSummary, "state" | "unread" | "queuedMessageCount">,
): boolean {
  return (
    thread.queuedMessageCount > 0 ||
    thread.state === "running" ||
    thread.state === "queued" ||
    thread.state === "needsAttention" ||
    ((thread.state === "completed" ||
      thread.state === "failed" ||
      thread.state === "interrupted") &&
      thread.unread)
  );
}

export function threadStatusClasses(
  thread: Pick<ThreadSummary, "state" | "unread" | "unseen" | "queuedMessageCount">,
): string {
  return `status ${threadMarkerClasses(thread)}`;
}

/** The marker classes without the base dot, for surfaces that draw their own marker shape. */
export function threadMarkerClasses(
  thread: Pick<ThreadSummary, "state" | "unread" | "unseen" | "queuedMessageCount">,
): string {
  const stateClass = threadStatusClass(thread);
  const pulsing =
    thread.state === "needsAttention" ||
    (thread.state === "completed" && thread.unread && thread.unseen);
  return `${stateClass}${thread.unseen ? " status-unseen" : ""}${pulsing ? " status-pulsing" : ""}`;
}

function threadStatusClass(
  thread: Pick<ThreadSummary, "state" | "unread" | "queuedMessageCount">,
): string {
  if (thread.queuedMessageCount > 0 && hasAcknowledgedOrNeutralState(thread)) {
    return "status-queued";
  }
  if (thread.state === "completed" && thread.unread) return "status-completed-unread";
  if (thread.state === "failed" && !thread.unread) return "status-failed-read";
  if (thread.state === "interrupted" && !thread.unread) return "status-interrupted-read";
  return `status-${thread.state}`;
}

function hasAcknowledgedOrNeutralState(thread: Pick<ThreadSummary, "state" | "unread">): boolean {
  return (
    thread.state === "idle" ||
    thread.state === "unavailable" ||
    ((thread.state === "completed" ||
      thread.state === "failed" ||
      thread.state === "interrupted") &&
      !thread.unread)
  );
}
