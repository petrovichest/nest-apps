import type {
  WorkerProcess,
  WorkerProcessSession,
  WorkerSessionSummary,
} from "@codexnest/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiClientError } from "./api";
import { useConnection } from "./connection";
import { workerSessionActive } from "./worker-handoff";

const REFRESH_INTERVAL_MS = 4_000;

type WorkerChildren = {
  children: readonly WorkerProcessSession[];
  projectKey: WorkerProcess["projectKey"];
};

const emptyView: WorkerChildren = { children: [], projectKey: null };

export function useWorkerChildren(
  threadId: string,
  worker: WorkerSessionSummary | undefined,
  currentTurnId: string | null | undefined,
) {
  const {
    api,
    appActive,
    state: { network, snapshot },
    foregroundEpoch,
    streamRecoveryEpoch,
  } = useConnection();
  const processId = worker?.processId;
  const sessionId = worker?.sessionId;
  const instanceId = snapshot?.instanceId;
  const scope = useMemo(
    () =>
      threadId && processId && sessionId && instanceId
        ? { api, threadId, processId, sessionId, instanceId }
        : null,
    [api, instanceId, processId, sessionId, threadId],
  );
  const [view, setView] = useState<WorkerChildren & { scope: typeof scope }>();
  // Lifecycle signals can arrive during a read. Join it for this scope.
  const lastRead = useRef<{
    scope: typeof scope;
    startedAt: number;
    inFlight: Promise<WorkerProcess[]> | null;
  }>(null);

  useEffect(() => {
    if (!scope || !appActive || network !== "connected") return;
    let disposed = false;
    let timer: number | undefined;
    let active = Boolean(currentTurnId);
    let retry = true;

    async function refresh() {
      if (!scope || document.visibilityState === "hidden") return;
      const previous = lastRead.current;
      let request = previous?.scope === scope ? previous.inFlight : null;
      if (!request && previous?.scope === scope) {
        const delay = REFRESH_INTERVAL_MS - (performance.now() - previous.startedAt);
        if (delay > 0) {
          timer = window.setTimeout(refresh, delay);
          return;
        }
      }
      if (!request) {
        const read = {
          scope,
          startedAt: performance.now(),
          inFlight: api.workerProcesses(scope.processId),
        };
        lastRead.current = read;
        request = read.inFlight;
      }

      try {
        const processes = await request;
        if (disposed) return;
        const process = processes.find(({ id }) => id === scope.processId);
        const own = process?.sessions.find(({ id }) => id === scope.sessionId);
        const children =
          process?.sessions.filter(
            ({ parentId, kind }) => parentId === scope.sessionId && kind !== "session",
          ) ?? [];
        setView({ scope, children, projectKey: process?.projectKey ?? null });
        active = Boolean(
          currentTurnId ||
          (own && (workerSessionActive(own) || own.waitingFor.length)) ||
          children.some(workerSessionActive),
        );
        retry = true;
      } catch (error) {
        if (error instanceof ApiClientError && error.status === 404) {
          active = false;
          retry = false;
        } else if (retry && !disposed) {
          retry = false;
          timer = window.setTimeout(refresh, REFRESH_INTERVAL_MS);
          return;
        }
      } finally {
        if (lastRead.current?.inFlight === request) lastRead.current.inFlight = null;
      }
      if (!disposed && active) timer = window.setTimeout(refresh, REFRESH_INTERVAL_MS);
    }

    // The process view has no event stream. Refresh while the selected conversation has
    // work in flight, and once on turn changes, reconnect or return to the foreground.
    void refresh();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [api, appActive, currentTurnId, foregroundEpoch, network, scope, streamRecoveryEpoch]);

  return scope && view?.scope === scope ? view : emptyView;
}
