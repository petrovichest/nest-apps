import "./popup.css";

import type {
  BindingSummary,
  BrowserTabSummary,
  ConnectionStatus,
  ProjectSummary,
  SessionTarget,
  ThreadSummary,
  UiLanguage,
} from "./protocol";
import { appName, defaultBaseUrl } from "./brand";
import { browserDisplayName, webext } from "./webext";

interface PopupSnapshot {
  configured: boolean;
  locale: UiLanguage;
  status: ConnectionStatus;
  error: string | null;
  projects: ProjectSummary[];
  threads: ThreadSummary[];
  activeTab: BrowserTabSummary | null;
  activeBinding: BindingSummary | null;
  bindings: BindingSummary[];
}

interface BackgroundResponse<T> {
  ok: boolean;
  result?: T;
  error?: string;
}

const copy = {
  en: {
    theme: "Theme",
    themeSystem: "System",
    themeLight: "Light",
    themeDark: "Dark",
    browser: browserDisplayName,
    setupTitle: `Connect this ${browserDisplayName}`,
    setupBody: `Use the address and owner token from your ${appName} instance.`,
    baseUrl: `${appName} address`,
    token: "Owner token",
    connect: "Connect",
    connected: "Connected",
    connecting: "Connecting",
    reconnecting: "Reconnecting",
    pending: "Setup needed",
    error: "Connection error",
    session: "Session",
    chooseSession: "Choose a session",
    busySession: "Busy",
    attach: "Attach current tab",
    currentTab: "Current tab",
    noTab: "No accessible active tab",
    attached: "Attached",
    detach: "Detach",
    open: `Open in ${appName}`,
    otherSessions: "Other browser sessions",
    emptyCatalog: `Enable Browser in a ${appName} session, or detach its tabs in another Chrome profile.`,
    editSetup: "Edit connection",
    openSidePanel: "Open side panel",
    savePending: "Saving…",
    tabCount: (count: number) => `${count} ${count === 1 ? "tab" : "tabs"}`,
  },
  ru: {
    theme: "Тема",
    themeSystem: "Системная",
    themeLight: "Светлая",
    themeDark: "Тёмная",
    browser: browserDisplayName,
    setupTitle: `Подключить ${browserDisplayName}`,
    setupBody: `Введите адрес и токен владельца из вашего ${appName}.`,
    baseUrl: `Адрес ${appName}`,
    token: "Токен владельца",
    connect: "Подключить",
    connected: "Подключено",
    connecting: "Подключение",
    reconnecting: "Переподключение",
    pending: "Нужна настройка",
    error: "Ошибка подключения",
    session: "Сессия",
    chooseSession: "Выберите сессию",
    busySession: "Занята",
    attach: "Подключить вкладку",
    currentTab: "Текущая вкладка",
    noTab: "Нет доступной активной вкладки",
    attached: "Подключена",
    detach: "Отключить",
    open: `Открыть в ${appName}`,
    otherSessions: "Другие браузерные сессии",
    emptyCatalog: `Включите Browser в сессии ${appName} или отключите её вкладки в другом профиле Chrome.`,
    editSetup: "Изменить подключение",
    openSidePanel: "Открыть сбоку",
    savePending: "Сохранение…",
    tabCount: (count: number) => `${count} ${pluralRu(count, "вкладка", "вкладки", "вкладок")}`,
  },
} as const;

const app = requirePopupRoot();
const surface = document.body.dataset.surface === "panel" ? "panel" : "popup";
const THEME_KEY = "codexnest.theme";
type ThemeMode = "system" | "light" | "dark";
const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
let theme = readTheme();
const themeLabel = el("label", { htmlFor: "extension-theme" });
const themeSelect = el("select", { id: "extension-theme" }, [
  el("option", { value: "system" }),
  el("option", { value: "light" }),
  el("option", { value: "dark" }),
]);
const appearance = el("footer", { className: "appearance" }, [themeLabel, themeSelect]);
app.after(appearance);
applyTheme();

themeSelect.addEventListener("change", () => {
  theme = normaliseTheme(themeSelect.value);
  localStorage.setItem(THEME_KEY, theme);
  applyTheme();
});
colorScheme.addEventListener("change", applyTheme);
window.addEventListener("storage", syncStoredTheme);
window.addEventListener(
  "pagehide",
  (event) => {
    if (event.persisted) return;
    colorScheme.removeEventListener("change", applyTheme);
    window.removeEventListener("storage", syncStoredTheme);
  },
  { once: true },
);

let snapshot: PopupSnapshot | null = null;
let browserWindowId: number | null = null;
let busy = false;
let localError: string | null = null;
let setupOverride = false;
let selectedTarget = "";
let interactingSelect: HTMLSelectElement | null = null;
let interactingAttachButton: HTMLButtonElement | null = null;
let deferredBackgroundRender = false;
let selectInteractionTimer: number | undefined;
let refreshGeneration = 0;

webext.runtime.onMessage.addListener((message) => {
  if (!isRecord(message) || message.type !== "background.stateChanged") return;
  if (browserWindowId === null) return;
  void refreshSnapshot().catch(showLocalError);
});

render();
void initialise().catch(showLocalError);

function normaliseTheme(value: string | null): ThemeMode {
  return value === "light" || value === "dark" ? value : "system";
}

function readTheme(): ThemeMode {
  return normaliseTheme(localStorage.getItem(THEME_KEY));
}

function applyTheme(): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.resolvedTheme =
    theme === "system" ? (colorScheme.matches ? "dark" : "light") : theme;
  themeSelect.value = theme;
}

function syncStoredTheme(event: StorageEvent): void {
  if (event.storageArea !== localStorage || (event.key !== THEME_KEY && event.key !== null)) return;
  theme = readTheme();
  applyTheme();
}

async function initialise(): Promise<void> {
  const currentWindow = await webext.windows.getCurrent();
  if (currentWindow.id === undefined) throw new Error("The current browser window is unavailable");
  browserWindowId = currentWindow.id;
  await refreshSnapshot(true);
}

async function refreshSnapshot(resetTarget = false): Promise<void> {
  const generation = ++refreshGeneration;
  const state = await request<PopupSnapshot>({ type: "popup.state" });
  if (generation !== refreshGeneration) return;
  applyBackgroundSnapshot(state, resetTarget);
}

function showLocalError(error: unknown): void {
  localError = errorMessage(error);
  if (interactingSelect) deferredBackgroundRender = true;
  else render();
}

function applyBackgroundSnapshot(state: PopupSnapshot, resetTarget = false): void {
  snapshot = state;
  if (interactingSelect) {
    deferredBackgroundRender = true;
    if (interactingAttachButton)
      interactingAttachButton.disabled = !canAttach(state, selectedTarget);
    return;
  }
  if (resetTarget || !targetAvailable(state, selectedTarget)) selectedTarget = "";
  render();
}

function render(): void {
  if (selectInteractionTimer !== undefined) clearTimeout(selectInteractionTimer);
  selectInteractionTimer = undefined;
  interactingSelect = null;
  interactingAttachButton = null;
  deferredBackgroundRender = false;
  app.replaceChildren();
  const language = snapshot?.locale ?? browserLanguage();
  document.documentElement.lang = language;
  const text = copy[language];
  themeLabel.textContent = text.theme;
  themeSelect.options[0]!.textContent = text.themeSystem;
  themeSelect.options[1]!.textContent = text.themeLight;
  themeSelect.options[2]!.textContent = text.themeDark;
  document.body.dataset.status = snapshot?.status ?? "pending";

  app.append(header(text));
  if (!snapshot) {
    app.append(el("section", { className: "loading-panel", textContent: `${appName}…` }));
    return;
  }
  if (!snapshot.configured || setupOverride) {
    app.append(setupView(snapshot, text));
    return;
  }
  app.append(sessionView(snapshot, text));
}

function header(text: (typeof copy)[UiLanguage]): HTMLElement {
  const wordmark = el("div", { className: "wordmark" }, [
    el("img", {
      className: "nest-logo",
      src: new URL("../../client/public/favicon.svg", import.meta.url).href,
      alt: "",
      width: 24,
      height: 24,
    }),
    el("span", { textContent: appName }),
    el("span", { className: "wordmark-context", textContent: text.browser }),
  ]);
  const topbar = el("header", { className: "topbar" }, [wordmark]);
  if (surface === "popup") {
    const openPanel = el("button", {
      className: "open-panel-button",
      type: "button",
      textContent: text.openSidePanel,
      ariaLabel: text.openSidePanel,
      disabled: browserWindowId === null,
    });
    openPanel.addEventListener("click", openPersistentPanel);
    topbar.append(openPanel);
  }
  return topbar;
}

function openPersistentPanel(): void {
  if (browserWindowId === null) return;
  try {
    if (!webext.sidePanel) throw new Error("Chrome Side Panel is unavailable");
    void webext.sidePanel.open({ windowId: browserWindowId }).catch(showLocalError);
  } catch (error) {
    showLocalError(error);
  }
}

function setupView(state: PopupSnapshot, text: (typeof copy)[UiLanguage]): HTMLElement {
  const form = el("form", { className: "setup" });
  const title = el("h1", { textContent: text.setupTitle });
  const description = el("p", { className: "lede", textContent: text.setupBody });
  const baseUrl = inputField("url", text.baseUrl, defaultBaseUrl, "base-url", true);
  const token = inputField("password", text.token, "••••••••••••", "owner-token", true);
  const submit = el("button", {
    className: "primary-button",
    type: "submit",
    textContent: busy ? text.savePending : text.connect,
    disabled: busy,
  });
  form.append(title, description, baseUrl.wrapper, token.wrapper);
  const setupError = errorNotice(localError ?? state.error);
  if (setupError) form.append(setupError);
  form.append(submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void act(async () => {
      const next = await request<PopupSnapshot>({
        type: "popup.configure",
        baseUrl: baseUrl.input.value,
        token: token.input.value,
      });
      snapshot = next;
      setupOverride = false;
    });
  });
  return form;
}

function sessionView(state: PopupSnapshot, text: (typeof copy)[UiLanguage]): HTMLElement {
  const section = el("section", { className: "sessions" });
  section.append(statusBar(state, text));
  const actionError = errorNotice(localError);
  if (actionError) section.append(actionError);
  const current = el("div", { className: "section-heading" }, [
    el("h1", { textContent: text.currentTab }),
    state.activeBinding
      ? el("span", { className: "attached-label", textContent: text.attached })
      : null,
  ]);
  section.append(current);
  if (!state.activeTab) {
    section.append(el("p", { className: "empty", textContent: text.noTab }));
  } else if (state.activeBinding) {
    section.append(bindingCard(state.activeBinding, state.activeTab, text, true));
  } else {
    section.append(unboundCard(state, text));
  }

  const others = state.bindings.filter(
    (binding) => binding.threadId !== state.activeBinding?.threadId,
  );
  if (others.length) {
    section.append(el("h2", { className: "other-heading", textContent: text.otherSessions }));
    const list = el("div", { className: "binding-list" });
    for (const binding of others) list.append(bindingCard(binding, null, text, false));
    section.append(list);
  }
  const edit = el("button", {
    className: "text-button",
    type: "button",
    textContent: text.editSetup,
  });
  edit.addEventListener("click", () => {
    setupOverride = true;
    localError = null;
    render();
  });
  section.append(edit);
  return section;
}

function statusBar(state: PopupSnapshot, text: (typeof copy)[UiLanguage]): HTMLElement {
  const labels: Record<ConnectionStatus, string> = {
    connected: text.connected,
    connecting: text.connecting,
    reconnecting: text.reconnecting,
    pending: text.pending,
    error: text.error,
  };
  const bar = el("div", { className: `status status-${state.status}` }, [
    el("span", { className: "status-dot", ariaHidden: "true" }),
    el("span", { textContent: labels[state.status] }),
  ]);
  if (state.error && state.status !== "connected") bar.title = state.error;
  return bar;
}

function unboundCard(state: PopupSnapshot, text: (typeof copy)[UiLanguage]): HTMLElement {
  const tab = state.activeTab!;
  const card = el("div", { className: "current-card" });
  card.append(tabIdentity(tab));
  const label = el("label", { className: "field compact-field" });
  label.append(el("span", { textContent: text.session }));
  const select = el("select", {
    disabled: state.status !== "connected" || busy,
  }) as HTMLSelectElement;
  select.append(el("option", { value: "", textContent: text.chooseSession }));
  let catalogThreadCount = 0;
  for (const project of state.projects) {
    const projectThreads = state.threads.filter((candidate) => candidate.projectId === project.id);
    if (!projectThreads.length) continue;
    const group = el("optgroup", {
      label: project.displayName || project.path,
    }) as HTMLOptGroupElement;
    for (const thread of projectThreads) {
      const threadBusy = isBusyThread(thread);
      group.append(
        el("option", {
          value: thread.id,
          textContent: threadBusy ? `${thread.title} — ${text.busySession}` : thread.title,
          disabled: threadBusy,
        }),
      );
      catalogThreadCount += 1;
    }
    select.append(group);
  }
  if (targetAvailable(state, selectedTarget)) select.value = selectedTarget;
  const button = el("button", {
    className: "primary-button",
    type: "button",
    textContent: text.attach,
    disabled: !canAttach(state, select.value),
  }) as HTMLButtonElement;
  select.addEventListener("focus", () => {
    if (selectInteractionTimer !== undefined) clearTimeout(selectInteractionTimer);
    selectInteractionTimer = undefined;
    interactingSelect = select;
    interactingAttachButton = button;
  });
  select.addEventListener("change", () => {
    selectedTarget = select.value;
    button.disabled = !canAttach(snapshot ?? state, selectedTarget);
  });
  select.addEventListener("blur", () => {
    selectedTarget = select.value;
    if (interactingSelect !== select) return;
    if (selectInteractionTimer !== undefined) clearTimeout(selectInteractionTimer);
    selectInteractionTimer = globalThis.setTimeout(() => {
      selectInteractionTimer = undefined;
      finishSelectInteraction(select, true);
    }, 0);
  });
  label.append(select);
  button.addEventListener("mousedown", (event) => {
    if (interactingSelect === select) event.preventDefault();
  });
  button.addEventListener("click", () => {
    const target = select.value;
    selectedTarget = target;
    const latestState = snapshot ?? state;
    if (!canAttach(latestState, target)) {
      finishSelectInteraction(select, true);
      return;
    }
    finishSelectInteraction(select, false);
    void act(async () => {
      snapshot = await request<PopupSnapshot>({
        type: "popup.createAttach",
        target: parseTarget(target),
        tabId: tab.id,
      });
    });
  });
  card.append(label);
  if (!catalogThreadCount)
    card.append(el("p", { className: "empty-inline", textContent: text.emptyCatalog }));
  const cardError = errorNotice(state.error);
  if (cardError) card.append(cardError);
  card.append(button);
  return card;
}

function finishSelectInteraction(select: HTMLSelectElement, applyDeferredState: boolean): void {
  if (interactingSelect !== select) return;
  if (selectInteractionTimer !== undefined) clearTimeout(selectInteractionTimer);
  selectInteractionTimer = undefined;
  interactingSelect = null;
  interactingAttachButton = null;
  if (!applyDeferredState || !deferredBackgroundRender) return;
  if (snapshot && !targetAvailable(snapshot, selectedTarget)) selectedTarget = "";
  render();
}

function targetAvailable(state: PopupSnapshot, value: string): boolean {
  if (!value) return false;
  const thread = state.threads.find((candidate) => candidate.id === value);
  return Boolean(thread && state.projects.some((project) => project.id === thread.projectId));
}

function canAttach(state: PopupSnapshot, value: string): boolean {
  if (busy || state.status !== "connected" || !targetAvailable(state, value)) return false;
  const thread = state.threads.find((candidate) => candidate.id === value);
  return Boolean(thread && !isBusyThread(thread));
}

function isBusyThread(thread: ThreadSummary): boolean {
  return (
    thread.state === "running" || thread.state === "queued" || thread.state === "needsAttention"
  );
}

function parseTarget(value: string): Extract<SessionTarget, { kind: "existing" }> {
  if (!value) throw new Error("Select a browser session");
  return { kind: "existing", threadId: value };
}

function bindingCard(
  binding: BindingSummary,
  activeTab: BrowserTabSummary | null,
  text: (typeof copy)[UiLanguage],
  prominent: boolean,
): HTMLElement {
  const card = el("article", { className: prominent ? "binding-card prominent" : "binding-card" });
  const identity = activeTab
    ? tabIdentity(activeTab)
    : el("div", { className: "binding-identity" }, [
        el("strong", { textContent: binding.title || "Browser session" }),
        el("span", { textContent: text.tabCount(binding.tabIds.length) }),
      ]);
  const actions = el("div", { className: "card-actions" });
  const open = el("button", {
    className: prominent ? "secondary-button" : "icon-button",
    type: "button",
    textContent: prominent ? text.open : "",
    title: text.open,
    ariaLabel: text.open,
  });
  if (!prominent) {
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [name, value] of Object.entries({
      "aria-hidden": "true",
      width: "18",
      height: "18",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.8",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    })) {
      icon.setAttribute(name, value);
    }
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute(
      "d",
      "M10 4.5H7a3 3 0 0 0-3 3v9.5a3 3 0 0 0 3 3h9.5a3 3 0 0 0 3-3v-3 M14 4h6v6M20 4l-9 9",
    );
    icon.append(path);
    open.append(icon);
  }
  open.addEventListener(
    "click",
    () => void act(() => request({ type: "popup.open", threadId: binding.threadId })),
  );
  const detach = el("button", {
    className: "danger-button",
    type: "button",
    textContent: text.detach,
    disabled: busy,
  });
  detach.addEventListener(
    "click",
    () =>
      void act(async () => {
        snapshot = await request<PopupSnapshot>({
          type: "popup.detach",
          threadId: binding.threadId,
        });
      }),
  );
  actions.append(open, detach);
  card.append(identity, actions);
  return card;
}

function tabIdentity(tab: BrowserTabSummary): HTMLElement {
  return el("div", { className: "tab-identity" }, [
    el("span", {
      className: "favicon-fallback",
      textContent: hostnameInitial(tab.url),
      ariaHidden: "true",
    }),
    el("span", { className: "tab-copy" }, [
      el("strong", {
        textContent: tab.title || hostname(tab.url) || "Untitled tab",
        title: tab.title,
      }),
      el("small", { textContent: hostname(tab.url) || tab.url, title: tab.url }),
    ]),
  ]);
}

function inputField(
  type: string,
  labelText: string,
  placeholder: string,
  id: string,
  required: boolean,
): { wrapper: HTMLElement; input: HTMLInputElement } {
  const wrapper = el("label", { className: "field", htmlFor: id });
  const label = el("span", { textContent: labelText });
  const input = el("input", {
    id,
    type,
    placeholder,
    required,
    autocomplete: type === "password" ? "current-password" : "url",
  }) as HTMLInputElement;
  wrapper.append(label, input);
  return { wrapper, input };
}

function errorNotice(message: string | null): HTMLElement | null {
  return message
    ? el("p", { className: "error-notice", textContent: message, role: "alert" })
    : null;
}

async function act(operation: () => Promise<unknown>): Promise<void> {
  if (busy) return;
  busy = true;
  localError = null;
  render();
  try {
    await operation();
  } catch (error) {
    localError = errorMessage(error);
  } finally {
    busy = false;
    render();
  }
}

async function request<T = void>(message: Record<string, unknown>): Promise<T> {
  if (browserWindowId === null) throw new Error("The current browser window is unavailable");
  const response = (await webext.runtime.sendMessage({
    ...message,
    windowId: browserWindowId,
  })) as BackgroundResponse<T>;
  if (!response?.ok) throw new Error(response?.error ?? `${appName} Browser did not respond`);
  return response.result as T;
}

type ElementOptions = {
  className?: string;
  textContent?: string;
  src?: string;
  alt?: string;
  width?: number;
  height?: number;
  type?: string;
  id?: string;
  value?: string;
  label?: string;
  placeholder?: string;
  title?: string;
  role?: string;
  ariaLabel?: string;
  ariaHidden?: string;
  htmlFor?: string;
  autocomplete?: string;
  required?: boolean;
  disabled?: boolean;
};

function el<Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  options: ElementOptions = {},
  children: Array<Node | null> = [],
): HTMLElementTagNameMap[Tag] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue;
    if (
      key === "className" ||
      key === "textContent" ||
      key === "title" ||
      key === "id" ||
      key === "role"
    ) {
      Object.assign(element, { [key]: value });
    } else if (key === "ariaLabel") element.setAttribute("aria-label", String(value));
    else if (key === "ariaHidden") element.setAttribute("aria-hidden", String(value));
    else if (key === "htmlFor") element.setAttribute("for", String(value));
    else if (key === "autocomplete") element.setAttribute("autocomplete", String(value));
    else if (typeof value === "boolean")
      (element as unknown as Record<string, unknown>)[key] = value;
    else element.setAttribute(key, String(value));
  }
  for (const child of children) if (child) element.append(child);
  return element;
}

function browserLanguage(): UiLanguage {
  return navigator.language.toLowerCase().startsWith("ru") ? "ru" : "en";
}

function requirePopupRoot(): HTMLElement {
  const root = document.querySelector<HTMLElement>("#app");
  if (!root) throw new Error("Popup root is missing");
  return root;
}

function hostname(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return "";
  }
}

function hostnameInitial(value: string): string {
  return (hostname(value)[0] ?? "•").toLocaleUpperCase();
}

function pluralRu(value: number, one: string, few: string, many: string): string {
  const tens = value % 100;
  const ones = value % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (ones === 1) return one;
  if (ones >= 2 && ones <= 4) return few;
  return many;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
