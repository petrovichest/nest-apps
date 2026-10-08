import { useEffect, useRef, useState } from "react";

import type { ApiClient } from "../api";
import { application } from "../application";
import { copyText } from "../clipboard";
import { useI18n } from "../i18n";
import { CheckIcon, CopyIcon } from "./Icons";

/** Mounted by thread ID so navigation clears feedback and cancels pending clipboard writes. */
export function SessionReferenceCopy({
  api,
  threadId,
}: {
  api: Pick<ApiClient, "readSessionReference">;
  threadId: string;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<"idle" | "loading" | "copied" | "failed">("idle");
  const mounted = useRef(false);
  const pending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  async function copy() {
    if (pending.current) return;
    pending.current = true;
    clearTimeout(timer.current);
    setState("loading");
    try {
      const text = api.readSessionReference(threadId).then((reference) => {
        if (!mounted.current) throw new Error("Session changed before copying");
        return [
          `${t("Сессия")}: ${application.name}`,
          `ID: ${reference.threadId}`,
          `${t("Рабочая папка")}: ${reference.cwd}`,
          `${t("Файл истории")}: ${reference.historyPath ?? t("Файл истории недоступен")}`,
        ].join("\n");
      });
      await copyText(text);
      if (!mounted.current) return;
      setState("copied");
      timer.current = setTimeout(() => setState("idle"), 2_000);
    } catch {
      if (mounted.current) setState("failed");
    } finally {
      pending.current = false;
    }
  }

  return (
    <>
      <button
        className="session-reference-copy"
        type="button"
        disabled={state === "loading"}
        aria-busy={state === "loading"}
        onClick={() => void copy()}
      >
        {state === "copied" ? <CheckIcon /> : <CopyIcon />}
        {state === "copied" ? t("Скопировано") : t("Копировать ссылку на сессию")}
      </button>
      <span className="sr-only" aria-live="polite" role={state === "copied" ? "status" : undefined}>
        {state === "copied" ? t("Ссылка на сессию скопирована") : ""}
      </span>
      {state === "failed" && (
        <span className="inspector-copy-error" role="alert">
          {t("Не удалось скопировать ссылку на сессию. Попробуйте ещё раз.")}
        </span>
      )}
    </>
  );
}
