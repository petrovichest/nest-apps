import { application } from "../application";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type {
  ThreadOccurrencesPage,
  ThreadSearchOccurrence,
  ThreadSearchPage,
  ThreadSearchScope,
  ThreadSummary,
} from "@codexnest/protocol";

import { useConnection } from "../connection";
import { localizeKnownServerText, useI18n } from "../i18n";
import { Dialog } from "./Dialog";
import { SearchIcon, XIcon } from "./Icons";

export type SearchTarget = {
  threadId: string;
  query: string;
  occurrence: ThreadSearchOccurrence;
  instanceId?: string;
};

export function searchTargetFromState(state: unknown, threadId: string): SearchTarget | null {
  const target = (state as { searchTarget?: SearchTarget } | null)?.searchTarget;
  const occurrence = target?.occurrence;
  return target?.threadId === threadId &&
    typeof target.query === "string" &&
    typeof occurrence?.turnId === "string" &&
    typeof occurrence.itemId === "string" &&
    typeof occurrence.turnCursor === "string"
    ? target
    : null;
}

type PageState<T> = { page: T | null; loading: boolean; error: string | null };
type SearchPageRequest = { scope: ThreadSearchScope; cursor?: string };
type SearchGroup = {
  data: Array<ThreadSearchPage["data"][number] & { scope: ThreadSearchScope }>;
  next: SearchPageRequest | null;
  loading: boolean;
  error: string | null;
};
const emptyGroup = (): SearchGroup => ({
  data: [],
  next: { scope: "titles" },
  loading: false,
  error: null,
});

export function ThreadSearchDialog({
  open,
  onClose,
  onNavigate,
}: {
  open: boolean;
  onClose(): void;
  onNavigate(): void;
}) {
  const { api, state } = useConnection();
  const { language, t } = useI18n();
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [groups, setGroups] = useState([emptyGroup(), emptyGroup()]);
  const [selected, setSelected] = useState<ThreadSummary | null>(null);
  const [occurrences, setOccurrences] = useState<PageState<ThreadOccurrencesPage>>({
    page: null,
    loading: false,
    error: null,
  });
  const generation = useRef(0);
  const selectionGeneration = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const instanceId = state.snapshot?.instanceId;

  useEffect(() => {
    generation.current++;
    selectionGeneration.current++;
    setInput("");
    setQuery("");
    setGroups([emptyGroup(), emptyGroup()]);
    setSelected(null);
    setOccurrences({ page: null, loading: false, error: null });
    return () => {
      generation.current++;
      selectionGeneration.current++;
    };
  }, [api, instanceId]);

  function errorText(error: unknown): string {
    return error instanceof Error
      ? (localizeKnownServerText(language, error.message) ?? error.message)
      : t("Не удалось выполнить поиск");
  }

  async function loadGroup(
    index: number,
    term: string,
    requestGeneration: number,
    request: SearchPageRequest = { scope: "titles" },
  ) {
    setGroups((previous) =>
      previous.map((group, i) => (i === index ? { ...group, loading: true, error: null } : group)),
    );
    try {
      const page = await api.searchThreads(term, index === 1, request.cursor, request.scope);
      if (requestGeneration !== generation.current) return;
      const startMessages =
        application.capabilities.fullTextSearch && request.scope === "titles" && !page.nextCursor;
      const next: SearchPageRequest | null = page.nextCursor
        ? { scope: request.scope, cursor: page.nextCursor }
        : startMessages
          ? { scope: "messages" }
          : null;
      setGroups((previous) =>
        previous.map((group, i) => {
          if (i !== index) return group;
          const seen = new Set(group.data.map((entry) => entry.thread.id));
          const additions = page.data.filter(({ thread }) => {
            if (seen.has(thread.id)) return false;
            seen.add(thread.id);
            return true;
          });
          return {
            data: [
              ...group.data,
              ...additions.map((entry) => ({ ...entry, scope: request.scope })),
            ],
            next,
            loading: startMessages,
            error: null,
          };
        }),
      );
      if (startMessages) await loadGroup(index, term, requestGeneration, { scope: "messages" });
    } catch (error) {
      if (requestGeneration !== generation.current) return;
      setGroups((previous) =>
        previous.map((group, i) =>
          i === index ? { ...group, loading: false, error: errorText(error) } : group,
        ),
      );
    }
  }

  function submit() {
    const term = input.trim();
    if (!term) return;
    const requestGeneration = ++generation.current;
    selectionGeneration.current++;
    setQuery(term);
    setSelected(null);
    setGroups([emptyGroup(), emptyGroup()]);
    void loadGroup(0, term, requestGeneration);
    void loadGroup(1, term, requestGeneration);
  }

  async function loadOccurrences(thread: ThreadSummary, cursor?: string) {
    const requestGeneration = ++selectionGeneration.current;
    const queryGeneration = generation.current;
    setSelected(thread);
    setOccurrences((previous) => ({
      page: cursor ? previous.page : null,
      loading: true,
      error: null,
    }));
    try {
      const page = await api.searchOccurrences(thread.id, query, cursor);
      if (
        requestGeneration !== selectionGeneration.current ||
        queryGeneration !== generation.current
      )
        return;
      setOccurrences((previous) => ({
        page: {
          ...page,
          data: cursor ? [...(previous.page?.data ?? []), ...page.data] : page.data,
        },
        loading: false,
        error: null,
      }));
    } catch (error) {
      if (
        requestGeneration !== selectionGeneration.current ||
        queryGeneration !== generation.current
      )
        return;
      setOccurrences((previous) => ({ ...previous, loading: false, error: errorText(error) }));
    }
  }

  function openThread(thread: ThreadSummary, occurrence?: ThreadSearchOccurrence) {
    onClose();
    onNavigate();
    navigate(`/threads/${encodeURIComponent(thread.id)}`, {
      state: occurrence
        ? {
            searchTarget: {
              threadId: thread.id,
              query,
              occurrence,
              instanceId,
            } satisfies SearchTarget,
          }
        : null,
    });
  }

  if (!open) return null;
  return (
    <Dialog
      titleId="thread-search-title"
      className="thread-search-dialog"
      backdropClassName="thread-search-backdrop"
      closeOnBackdrop
      closeOnEscape
      onClose={onClose}
      initialFocusRef={inputRef}
    >
      <div className="dialog-header">
        <div className="dialog-heading">
          <h2 id="thread-search-title">{t("Поиск по диалогам")}</h2>
          <p className="search-context">
            {t(
              application.capabilities.fullTextSearch
                ? "Сообщения и названия во всех проектах, включая архив"
                : "Названия во всех проектах, включая архив",
            )}
          </p>
        </div>
        <button type="button" className="icon-button" aria-label={t("Закрыть")} onClick={onClose}>
          <XIcon />
        </button>
      </div>
      <form
        className="thread-search-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <input
          ref={inputRef}
          aria-label={t("Текст для поиска")}
          placeholder={t("Что вы помните из диалога?")}
          value={input}
          maxLength={500}
          onChange={(event) => setInput(event.target.value)}
        />
        <button className="primary" type="submit" disabled={!input.trim()}>
          <SearchIcon />
          {t("Найти")}
        </button>
      </form>
      <div className="thread-search-results" aria-live="polite">
        {selected ? (
          <section>
            <div className="search-section-heading">
              <button
                type="button"
                onClick={() => {
                  selectionGeneration.current++;
                  setSelected(null);
                }}
              >
                {t("К результатам")}
              </button>
              <button type="button" onClick={() => openThread(selected)}>
                {t("Открыть диалог")}
              </button>
            </div>
            <h3>{selected.title}</h3>
            <p className="search-context">
              {selected.cwd}
              {selected.archived ? ` · ${t("Архив")}` : ""}
            </p>
            {occurrences.page?.data.map((occurrence, index) => (
              <button
                type="button"
                className="thread-search-result"
                key={`${occurrence.turnId}:${occurrence.itemId}:${index}`}
                onClick={() => openThread(selected, occurrence)}
              >
                <span className="search-snippet">
                  <SearchSnippet occurrence={occurrence} />
                </span>
              </button>
            ))}
            {!occurrences.loading && occurrences.page?.data.length === 0 && (
              <p>
                {t(
                  "Совпадение найдено в названии или фрагмент больше недоступен. Можно открыть диалог.",
                )}
              </p>
            )}
            {occurrences.error && <p role="alert">{occurrences.error}</p>}
            {(occurrences.error || occurrences.page?.nextCursor) && (
              <button
                type="button"
                disabled={occurrences.loading}
                onClick={() =>
                  void loadOccurrences(selected, occurrences.page?.nextCursor ?? undefined)
                }
              >
                {occurrences.error ? t("Повторить") : t("Показать ещё")}
              </button>
            )}
            {occurrences.loading && (
              <p role="status">
                <span className="working-text">{t("Ищем…")}</span>
              </p>
            )}
          </section>
        ) : query ? (
          groups.map((group, index) => (
            <section key={index} aria-label={index ? t("Архив") : t("Не в архиве")}>
              <h3>{index ? t("Архив") : t("Не в архиве")}</h3>
              {group.data.map(({ thread, snippet, scope }) => (
                <button
                  type="button"
                  className="thread-search-result"
                  key={thread.id}
                  onClick={() =>
                    scope === "titles" ? openThread(thread) : void loadOccurrences(thread)
                  }
                >
                  {scope === "messages" && (
                    <span className="search-snippet">{snippet || thread.title}</span>
                  )}
                  <span className="search-result-title">{thread.title}</span>
                  <span className="search-context">
                    {thread.cwd} · {new Date(thread.updatedAt).toLocaleDateString(language)}
                  </span>
                </button>
              ))}
              {!group.loading && !group.error && !group.next && group.data.length === 0 && (
                <p className="search-context">{t("Совпадений нет")}</p>
              )}
              {group.error && <p role="alert">{group.error}</p>}
              {group.next && (
                <button
                  type="button"
                  disabled={group.loading}
                  onClick={() => void loadGroup(index, query, generation.current, group.next!)}
                >
                  {group.error ? t("Повторить") : t("Показать ещё")}
                </button>
              )}
              {group.loading && (
                <p role="status">
                  <span className="working-text">{t("Ищем…")}</span>
                </p>
              )}
            </section>
          ))
        ) : (
          <p className="search-context">
            {t(
              "Введите фразу и нажмите «Найти». Поиск не включает технические журналы инструментов.",
            )}
          </p>
        )}
      </div>
    </Dialog>
  );
}

export function SearchSnippet({ occurrence }: { occurrence: ThreadSearchOccurrence }) {
  const { snippet, snippetMatchRange: range } = occurrence;
  return (
    <>
      {snippet.slice(0, range.start)}
      <mark>{snippet.slice(range.start, range.end)}</mark>
      {snippet.slice(range.end)}
    </>
  );
}
