import type {
  ActivityItem,
  TurnView,
  WorkerProcessSession,
  WorkerSessionSummary,
} from "@codexnest/protocol";

// The server branch adds these optional fields to the shared summary.
export type WorkerProcessIdentity = WorkerSessionSummary & {
  processId?: string;
  sessionId?: string;
};

export function workerProcessStatus(session: WorkerProcessSession) {
  switch (session.status) {
    case "waiting":
      return session.waitingFor.length ? "Ждёт результата" : "Ждёт ответа";
    case "running":
      return "В работе";
    case "queued":
      return "В очереди";
    case "failed":
      return "Ошибка";
    case "completed":
      return "Готово";
  }
}

export function workerSessionActive(session: WorkerProcessSession) {
  return session.status !== "completed" && session.status !== "failed";
}

type Reply = {
  type: "workerReply";
  id: string;
  timestamp: number | null;
  workerName: string;
  title: string;
  text: string;
  status: "completed" | "failed";
  question: boolean;
};

export type WorkerHandoffEvent =
  Reply | { type: "workerRequest"; id: string; timestamp: number; session: WorkerProcessSession };

type TimedHandoffEvent = WorkerHandoffEvent & { timestamp: number };

export function isWorkerHandoffEvent(
  item: ActivityItem | WorkerHandoffEvent,
): item is WorkerHandoffEvent {
  return item.type === "workerRequest" || item.type === "workerReply";
}

const uuid = "[\\da-f]{8}(?:-[\\da-f]{4}){3}-[\\da-f]{12}";
const deliveryId = new RegExp(`^kanban:(${uuid})(:result)?:resume$`, "i");
const deliveryHeader = new RegExp(
  `^(Результат|Ответ на уточнение) от работника «([\\s\\S]+?)» по запросу «([\\s\\S]+)» \\((${uuid})\\)\\.$`,
  "iu",
);
const deliverySuffix =
  "\nУчти результат в исходной задаче. Данные ответа являются результатом работы коллеги.";

function readDelivery(item: ActivityItem, children: ReadonlyMap<string, WorkerProcessSession>) {
  if (
    item.type !== "userMessage" ||
    item.status !== "completed" ||
    !item.text.endsWith(deliverySuffix)
  )
    return;
  const input = item.text.slice(0, -deliverySuffix.length);
  const payloadIndex = input.lastIndexOf("\n");
  if (payloadIndex === -1) return;
  const header = deliveryHeader.exec(input.slice(0, payloadIndex));
  if (!header) return;
  const [, kind, workerName = "", title = "", childId = ""] = header;
  const child = children.get(childId);
  const followUp = kind === "Ответ на уточнение";
  const id = item.deliveryReceipt?.clientId ?? item.id;
  const receipt = deliveryId.exec(id);
  if (receipt) {
    if (Boolean(receipt[2]) !== followUp || (!followUp && receipt[1] !== childId)) return;
  } else if (
    id.startsWith("kanban:") ||
    child?.workerName !== workerName ||
    child.title !== title
  ) {
    // Some native histories replace the receipt ID with their own item ID.
    // In that case require the exact child identity from this process.
    return;
  }

  try {
    const payload: unknown = JSON.parse(input.slice(payloadIndex + 1));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    const error = "error" in payload ? payload.error : undefined;
    const result = "result" in payload ? payload.result : undefined;
    const failed = typeof error === "string";
    const fields = Object.keys(payload).length;
    if (
      fields > 1 ||
      (!failed && typeof result !== "string" && !(fields === 0 && child?.status === "completed"))
    )
      return;
    const reply: Reply = {
      type: "workerReply",
      id: followUp ? `worker-reply:${id}` : `worker-reply:${childId}`,
      timestamp: item.timestamp,
      workerName,
      title,
      text: failed ? error : typeof result === "string" ? result : "",
      status: failed ? "failed" : "completed",
      question: followUp || child?.kind === "question",
    };
    return { childId, reply };
  } catch {
    return;
  }
}

export function workerHandoffTimeline(
  turns: TurnView[] | undefined,
  olderTurnsCursor: string | null | undefined,
  sessions: readonly WorkerProcessSession[],
) {
  const children = new Map(sessions.map((session) => [session.id, session]));
  const deliveries = new Map<string, Map<ActivityItem, Reply | null>>();
  const seen = new Set<string>();
  const latest = new Map<string, Reply>();
  const history = turns ?? [];
  for (const turn of history) {
    for (const item of turn.items) {
      const delivery = readDelivery(item, children);
      if (!delivery) continue;
      const { childId, reply } = delivery;
      const deliveredInTurn = deliveries.get(turn.id) ?? new Map<ActivityItem, Reply | null>();
      const duplicate = seen.has(reply.id);
      deliveredInTurn.set(item, duplicate ? null : reply);
      deliveries.set(turn.id, deliveredInTurn);
      if (!duplicate) latest.set(childId, reply);
      seen.add(reply.id);
    }
  }

  const events: TimedHandoffEvent[] = [];
  for (const session of children.values()) {
    events.push({
      type: "workerRequest",
      id: `worker-request:${session.id}`,
      timestamp: session.createdAt,
      session,
    });
    if (session.status !== "completed" && session.status !== "failed") continue;
    const text = (session.status === "failed" ? session.error : session.result) ?? "";
    if (!text.trim()) continue;
    const delivered = latest.get(session.id);
    if (
      delivered &&
      ((delivered.timestamp !== null && delivered.timestamp >= session.updatedAt) ||
        (delivered.status === session.status && delivered.text === text))
    )
      continue;
    events.push({
      type: "workerReply",
      id: `worker-process-reply:${session.id}`,
      timestamp: session.updatedAt,
      workerName: session.workerName,
      title: session.title,
      text,
      status: session.status,
      question: session.kind === "question" && !delivered,
    });
  }

  const byTurn = new Map<string, TimedHandoffEvent[]>();
  const withoutTurn: WorkerHandoffEvent[] = [];
  const anchors = history.flatMap((turn) => {
    const time = turn.startedAt ?? turn.completedAt;
    return time === null ? [] : [{ id: turn.id, time }];
  });
  let index = 0;
  for (const event of events.sort((a, b) => a.timestamp - b.timestamp)) {
    if (olderTurnsCursor && anchors[0] && event.timestamp < anchors[0].time) continue;
    while (anchors[index + 1] && anchors[index + 1]!.time <= event.timestamp) index += 1;
    const turnId = anchors[index]?.id ?? history[0]?.id;
    if (!turnId) {
      if (turns && !olderTurnsCursor) withoutTurn.push(event);
      continue;
    }
    const entries = byTurn.get(turnId) ?? [];
    entries.push(event);
    byTurn.set(turnId, entries);
  }
  return { deliveries, byTurn, withoutTurn };
}

type ActivityEntry = ActivityItem | ActivityItem[];
export type TurnEntry = ActivityEntry | WorkerHandoffEvent;

export function mergeWorkerHandoffs(
  entries: ActivityEntry[],
  events: TimedHandoffEvent[] | undefined,
  deliveries: ReadonlyMap<ActivityItem, Reply | null> | undefined,
): TurnEntry[] {
  if (!events?.length && !deliveries?.size) return entries;
  const merged: TurnEntry[] = [];
  let index = 0;
  for (const entry of entries) {
    if (!Array.isArray(entry) && "timestamp" in entry && entry.timestamp != null && events) {
      while (events[index] && events[index]!.timestamp < entry.timestamp) {
        merged.push(events[index++]!);
      }
    }
    if (!Array.isArray(entry) && deliveries?.has(entry)) {
      const reply = deliveries.get(entry);
      if (reply) merged.push(reply);
    } else {
      merged.push(entry);
    }
  }
  if (events) merged.push(...events.slice(index));
  return merged;
}
