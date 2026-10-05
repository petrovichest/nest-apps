import { application } from "./application";
import { useCallback, useEffect, useRef, useState } from "react";

import type { SkillsCatalogResponse } from "@codexnest/protocol";

import type { ApiClient } from "./api";
import { useConnection } from "./connection";

type CatalogRequest = {
  api: ApiClient;
  cwd: string;
  forceReload: boolean;
  generation: number;
};

export function useSkillsCatalog(cwd: string | null, skillsEpoch: number, active = true) {
  active = active && application.capabilities.skills;
  const { api } = useConnection();
  const [catalog, setCatalog] = useState<SkillsCatalogResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const latestRef = useRef({ active, api, cwd });
  const generationRef = useRef(0);
  const pendingRef = useRef<CatalogRequest | null>(null);
  const runningRef = useRef<Promise<void> | null>(null);
  const startDrainRef = useRef<() => void>(() => undefined);
  const identityRef = useRef<{ api: ApiClient; cwd: string | null } | null>(null);
  latestRef.current = { active, api, cwd };

  const startDrain = useCallback(() => {
    if (runningRef.current) return;
    const running = (async () => {
      while (pendingRef.current) {
        const request = pendingRef.current;
        pendingRef.current = null;
        const latest = latestRef.current;
        if (
          request.generation !== generationRef.current ||
          !latest.active ||
          latest.api !== request.api ||
          latest.cwd !== request.cwd
        ) {
          continue;
        }
        setLoading(true);
        setError(null);
        try {
          const response = await request.api.listSkills(request.cwd, request.forceReload);
          const current = latestRef.current;
          if (
            request.generation === generationRef.current &&
            current.active &&
            current.api === request.api &&
            current.cwd === request.cwd
          ) {
            setCatalog(response);
          }
        } catch (caught) {
          const current = latestRef.current;
          if (
            request.generation === generationRef.current &&
            current.active &&
            current.api === request.api &&
            current.cwd === request.cwd
          ) {
            setError(caught);
          }
        } finally {
          const current = latestRef.current;
          if (
            request.generation === generationRef.current &&
            current.active &&
            current.api === request.api &&
            current.cwd === request.cwd
          ) {
            setLoading(false);
          }
        }
      }
    })().finally(() => {
      if (runningRef.current === running) runningRef.current = null;
      if (pendingRef.current) startDrainRef.current();
    });
    runningRef.current = running;
  }, []);
  startDrainRef.current = startDrain;

  const enqueue = useCallback((forceReload: boolean) => {
    const latest = latestRef.current;
    if (!latest.active || !latest.cwd) return;
    const next: CatalogRequest = {
      api: latest.api,
      cwd: latest.cwd,
      forceReload,
      generation: generationRef.current,
    };
    const pending = pendingRef.current;
    pendingRef.current =
      pending &&
      pending.api === next.api &&
      pending.cwd === next.cwd &&
      pending.generation === next.generation
        ? { ...pending, forceReload: pending.forceReload || forceReload }
        : next;
    startDrainRef.current();
  }, []);

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    const identityChanged = identityRef.current?.api !== api || identityRef.current?.cwd !== cwd;
    identityRef.current = { api, cwd };
    pendingRef.current = null;
    if (!active || !cwd) {
      setLoading(false);
      setError(null);
      if (identityChanged) setCatalog(null);
    } else {
      if (identityChanged) {
        setCatalog(null);
        setError(null);
      }
      enqueue(false);
    }
    return () => {
      if (generationRef.current === generation) generationRef.current += 1;
      if (pendingRef.current?.generation === generation) pendingRef.current = null;
    };
  }, [active, api, cwd, enqueue, skillsEpoch]);

  return {
    catalog,
    error,
    loading,
    mutate: useCallback(
      (update: (current: SkillsCatalogResponse) => SkillsCatalogResponse) =>
        setCatalog((current) => (current ? update(current) : current)),
      [],
    ),
    refresh: useCallback(() => enqueue(true), [enqueue]),
  };
}
