import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";

import { useI18n } from "../i18n";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "./Icons";

type ModelChoice = { value: string; label: string };

const DROPDOWN_GAP = 6;
const DROPDOWN_MAX_HEIGHT = 320;
const VIEWPORT_GUTTER = 8;

export function TaskModelPicker({
  id,
  label,
  options,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  options: ModelChoice[];
  value: string;
  disabled: boolean;
  onChange(value: string): void;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const selected = options.find((option) => option.value === value);
  const listId = `${id}-options`;
  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus({ preventScroll: true });
  }, []);

  function handleTriggerKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    setOpen(true);
  }

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <>
      <button
        id={id}
        ref={buttonRef}
        className="task-model-trigger"
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-controls={open && !disabled ? listId : undefined}
        aria-expanded={open && !disabled}
        aria-describedby={`${id}-value`}
        onClick={() => (open ? close(true) : setOpen(true))}
        onKeyDown={handleTriggerKey}
        onMouseDown={(event) => {
          if (open) event.preventDefault();
        }}
      >
        <span id={`${id}-value`}>{selected?.label}</span>
        <ChevronDownIcon />
      </button>
      {open && !disabled && (
        <TaskModelDropdown
          label={label}
          listId={listId}
          options={options}
          value={value}
          opener={buttonRef}
          onClose={close}
          onChoose={(choice) => {
            onChange(choice);
            close(true);
          }}
        />
      )}
    </>
  );
}

function TaskModelDropdown({
  label,
  listId,
  options,
  value,
  opener,
  onClose,
  onChoose,
}: {
  label: string;
  listId: string;
  options: ModelChoice[];
  value: string;
  opener: RefObject<HTMLButtonElement | null>;
  onClose(restoreFocus?: boolean): void;
  onChoose(value: string): void;
}) {
  const { t } = useI18n();
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [activeValue, setActiveValue] = useState<string | null>(null);
  const term = query.trim().toLowerCase();
  const matches = term
    ? options.filter(
        (option) =>
          option.label.toLowerCase().includes(term) || option.value.toLowerCase().includes(term),
      )
    : options;
  const activeIndex = matches.findIndex((option) => option.value === activeValue);
  const highlight = activeIndex >= 0 ? activeIndex : term && matches.length ? 0 : -1;
  const searchLabel = t("Поиск моделей");

  useLayoutEffect(() => {
    const trigger = opener.current;
    const dropdown = dropdownRef.current;
    if (!trigger || !dropdown) return;
    const scrollArea = trigger.closest(".settings-scroll");
    const settingsHeader = scrollArea?.previousElementSibling;
    const viewport = window.visualViewport;

    function position() {
      if (!trigger || !dropdown) return;
      const anchor = trigger.getBoundingClientRect();
      const top = Math.max(
        viewport?.offsetTop ?? 0,
        scrollArea?.getBoundingClientRect().top ?? 0,
        settingsHeader?.getBoundingClientRect().bottom ?? 0,
      );
      const bottom = Math.min(
        viewport ? viewport.offsetTop + viewport.height : window.innerHeight,
        scrollArea?.getBoundingClientRect().bottom ?? window.innerHeight,
      );
      if (!anchor.width || anchor.bottom <= top || anchor.top >= bottom) {
        onClose();
        return;
      }

      const below = bottom - anchor.bottom - DROPDOWN_GAP - VIEWPORT_GUTTER;
      const above = anchor.top - top - DROPDOWN_GAP - VIEWPORT_GUTTER;
      const opensBelow = below >= DROPDOWN_MAX_HEIGHT || below >= above;
      dropdown.style.left = `${anchor.left}px`;
      dropdown.style.width = `${anchor.width}px`;
      dropdown.style.top = opensBelow ? `${anchor.bottom + DROPDOWN_GAP}px` : "auto";
      dropdown.style.bottom = opensBelow
        ? "auto"
        : `${window.innerHeight - anchor.top + DROPDOWN_GAP}px`;
      dropdown.style.maxHeight = `${Math.max(
        0,
        Math.min(DROPDOWN_MAX_HEIGHT, opensBelow ? below : above),
      )}px`;
    }

    function dismissOutside(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && !trigger?.contains(target) && !dropdown?.contains(target)) {
        onClose();
      }
    }

    position();
    inputRef.current?.focus({ preventScroll: true });
    document.addEventListener("pointerdown", dismissOutside, true);
    scrollArea?.addEventListener("scroll", position, { passive: true });
    window.addEventListener("resize", position);
    viewport?.addEventListener("resize", position);
    viewport?.addEventListener("scroll", position);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      scrollArea?.removeEventListener("scroll", position);
      window.removeEventListener("resize", position);
      viewport?.removeEventListener("resize", position);
      viewport?.removeEventListener("scroll", position);
    };
  }, [onClose, opener]);

  function handleSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) {
      if (event.key === "Escape") event.stopPropagation();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (highlight >= 0) onChoose(matches[highlight].value);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (!matches.length) return;
    const next =
      event.key === "ArrowDown"
        ? Math.min(highlight + 1, matches.length - 1)
        : highlight < 0
          ? matches.length - 1
          : Math.max(highlight - 1, 0);
    setActiveValue(matches[next].value);
    event.currentTarget.ownerDocument
      .getElementById(`${listId}-${next}`)
      ?.scrollIntoView({ block: "nearest" });
  }

  return (
    <div
      ref={dropdownRef}
      className="task-model-dropdown"
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) onClose();
      }}
    >
      <div className="task-model-search">
        <SearchIcon />
        <input
          ref={inputRef}
          role="combobox"
          type="search"
          aria-label={searchLabel}
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={highlight === -1 ? undefined : `${listId}-${highlight}`}
          placeholder={searchLabel}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setActiveValue(null);
            if (resultsRef.current) resultsRef.current.scrollTop = 0;
          }}
          onKeyDown={handleSearchKey}
        />
      </div>
      <div className="task-model-results" ref={resultsRef} tabIndex={-1}>
        <div id={listId} role="listbox" aria-label={label}>
          {matches.map((option, index) => (
            <div
              className="task-model-option"
              id={`${listId}-${index}`}
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              data-highlighted={index === highlight || undefined}
              onClick={() => onChoose(option.value)}
            >
              <span>{option.label}</span>
              {option.value === value && <CheckIcon />}
            </div>
          ))}
        </div>
        {!matches.length && (
          <p className="task-model-empty" role="status">
            {t("Модели не найдены")}
          </p>
        )}
      </div>
    </div>
  );
}
