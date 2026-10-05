import { application } from "./application";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type TouchEvent as ReactTouchEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router";

import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { isActiveFeedEligible } from "@codexnest/protocol";
import type {
  AppUpdateStatus,
  CodexRateLimitWindow,
  CodexRateLimitsResponse,
  MoveProjectRequest,
  Project,
  ThreadSummary,
  TranscriptionConfigResponse,
  TranscriptionTimingEstimate,
  UiLanguage,
} from "@codexnest/protocol";

import {
  getBrowserNotificationPermission,
  requestBrowserNotificationPermission,
} from "./browser-notifications";
import type { ConnectionSettings } from "./storage";
import { copyText } from "./clipboard";
import { AttentionPanel } from "./components/AttentionPanel";
import { Dialog } from "./components/Dialog";
import { ThreadSearchDialog } from "./components/ThreadSearchDialog";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BrowserIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  FolderIcon,
  GaugeIcon,
  GripVerticalIcon,
  MoreIcon,
  NewTaskIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  SlidersIcon,
  TeamIcon,
  TrashIcon,
} from "./components/Icons";
import { NewSession } from "./components/NewSession";
import { PendingForkPage } from "./components/PendingForkPage";
import { ProjectDialog } from "./components/ProjectDialog";
import {
  SettingsPage,
  type ProjectListDirection,
  type SidebarSide,
} from "./components/SettingsPage";
import { WorkspaceHeader } from "./components/WorkspaceHeader";
import { useConnection } from "./connection";
import { localizeKnownServerText, useI18n, type Translate } from "./i18n";
import { stopPushNotifications, usePushNotifications } from "./push";
import { groupedThreads } from "./state";
import { forkOperationsFromSnapshot, type ForkOperationSummary } from "./forks";
import { clearConnectionSettings } from "./storage";
import { hasAlwaysVisibleThreadStatus, threadStatusClasses } from "./thread-status";
import { useDrawerNavigation } from "./useDrawerNavigation";
import type { ThemeMode } from "./useTheme";

const SIDEBAR_SIDE_KEY = `${application.storagePrefix}.sidebarSide`;
const SIDEBAR_WIDTH_KEY = `${application.storagePrefix}.sidebarWidth`;
const DEFAULT_SIDEBAR_WIDTH = 292;
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 440;
const MIN_WORKSPACE_WIDTH = 420;
const DESKTOP_SIDEBAR_GUTTERS = 40;
const SIDEBAR_KEYBOARD_STEP = 10;
const PROJECT_LIST_DIRECTION_KEY = `${application.storagePrefix}.projectListDirection`;
const LAYOUT_DEFAULTS_VERSION_KEY = `${application.storagePrefix}.layoutDefaultsVersion`;
const LAYOUT_DEFAULTS_VERSION = "1";
const NOTIFICATION_PROMPT_DISMISSED_KEY = `${application.storagePrefix}.notificationPromptDismissed`;
const PROJECT_DRAG_START_DISTANCE = 6;
const PROJECT_LONG_PRESS_DELAY = 1_000;
const PROJECT_LONG_PRESS_MOVE_TOLERANCE = 10;
const PROJECT_DRAG_SCROLL_EDGE = 48;
const PROJECT_DRAG_SCROLL_SPEED = 12;
const THREAD_PREVIEW_LIMIT = 5;
const THREAD_TITLE_SCROLL_PX_PER_SECOND = 45;
const SIDEBAR_TREE_STATE_KEY_PREFIX = `${application.storagePrefix}.sidebarTree.v1:`;
const SESSION_LIST_MODE_KEY = `${application.storagePrefix}.sessionListMode`;

type ListExpansion = number | "all";
type SessionListMode = "projects" | "active";

type SidebarResizeGesture = {
  pointerId: number;
  startX: number;
  startWidth: number;
  startPreferredWidth: number;
  width: number;
};

type SidebarTreeState = {
  collapsedProjectIds: Set<string>;
  pinnedGroupCollapsed: boolean;
};

type ActiveFeedRunningOrder = {
  serverBaseUrl: string;
  byParent: Map<string | null, string[]>;
};

type ProjectDragGesture = {
  active: boolean;
  clientY: number;
  direction: ProjectListDirection;
  displayProjectIds: string[];
  element: HTMLElement;
  frameId: number | null;
  holdTimerId: number | null;
  insertionIndex: number;
  pointerId: number;
  projectId: string;
  source: "handle" | "long-press";
  startX: number;
  startY: number;
  touchCleanup: (() => void) | null;
};

type ProjectDragView = {
  insertionIndex: number;
  projectId: string;
};

export function App({
  settings,
  onDisconnected,
  theme,
  onThemeChange,
}: {
  settings: ConnectionSettings;
  onDisconnected(): void;
  theme: ThemeMode;
  onThemeChange(value: string): void;
}) {
  const { api, state, reconnect } = useConnection();
  const { language, setLanguage, t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const pendingForkMatch = location.pathname.match(/^\/fork-operations\/([^/]+)\/?$/u);
  const pendingForkOperationId = pendingForkMatch?.[1]
    ? decodeURIComponent(pendingForkMatch[1])
    : null;
  const sessionWorkspace =
    location.pathname === "/new" ||
    /^\/threads\/[^/]+\/?$/.test(location.pathname) ||
    pendingForkOperationId !== null;
  const newSessionWorkspaceId = (location.state as { newSessionWorkspaceId?: unknown } | null)
    ?.newSessionWorkspaceId;
  const sessionWorkspaceKey =
    typeof newSessionWorkspaceId === "string"
      ? `new:${newSessionWorkspaceId}`
      : location.pathname === "/new"
        ? `new:direct:${location.search}`
        : pendingForkOperationId
          ? `fork:${pendingForkOperationId}`
          : `thread:${location.pathname}`;
  const [drawer, setDrawer] = useState(false);
  const [newProject, setNewProject] = useState(false);
  const [initialLayout] = useState(readLayoutPreferences);
  const [sidebarSide, setSidebarSide] = useState<SidebarSide>(initialLayout.sidebarSide);
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [projectListDirection, setProjectListDirection] = useState<ProjectListDirection>(
    initialLayout.projectListDirection,
  );
  const [notificationPrompt, setNotificationPrompt] = useState(
    () =>
      getBrowserNotificationPermission() === "default" &&
      localStorage.getItem(NOTIFICATION_PROMPT_DISMISSED_KEY) !== "true",
  );
  const [notificationRequesting, setNotificationRequesting] = useState(false);
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [transcriptionConfig, setTranscriptionConfig] =
    useState<TranscriptionConfigResponse | null>(null);
  const updateTranscriptionTimingEstimate = useCallback(
    (timingEstimate: TranscriptionTimingEstimate) =>
      setTranscriptionConfig((current) => (current ? { ...current, timingEstimate } : current)),
    [],
  );
  const [transcriptionConfigError, setTranscriptionConfigError] = useState<string | null>(null);
  const [appUpdateStatus, setAppUpdateStatus] = useState<AppUpdateStatus | null>(null);
  const [installedApkVersion, setInstalledApkVersion] = useState<string | null>(null);
  const appUpdateCheckAttemptedRef = useRef(false);
  const {
    dragging: drawerDragging,
    frameRef,
    sidebarRef,
  } = useDrawerNavigation({
    open: drawer,
    routeKey: location.pathname,
    threadActive:
      /^\/threads\/[^/]+\/?$/.test(location.pathname) || pendingForkOperationId !== null,
    side: sidebarSide,
    setOpen: setDrawer,
  });
  const markManualNavigationIntent = usePushNotifications(navigate, language, state.snapshot);
  const localizationRef = useRef({ language, t });
  localizationRef.current = { language, t };
  const acceptAppUpdateStatus = useCallback((next: AppUpdateStatus) => {
    setAppUpdateStatus((current) =>
      appUpdateStatusTimestamp(next) >= appUpdateStatusTimestamp(current) ? next : current,
    );
  }, []);

  useEffect(() => {
    const serverLanguage = state.snapshot?.uiLanguage;
    if (serverLanguage === "en" || serverLanguage === "ru") setLanguage(serverLanguage);
  }, [setLanguage, state.snapshot?.uiLanguage]);

  useEffect(() => {
    if (
      !application.capabilities.appUpdates ||
      state.network !== "connected" ||
      !state.snapshot?.connection.syncedAt
    ) {
      return;
    }

    let active = true;
    const accept = (status: AppUpdateStatus) => {
      if (active) acceptAppUpdateStatus(status);
    };
    const timer = window.setTimeout(() => {
      if (!active) return;
      if (!appUpdateCheckAttemptedRef.current) {
        appUpdateCheckAttemptedRef.current = true;
        void api
          .checkAppUpdate()
          .then(accept)
          .catch(() =>
            api
              .readAppSettings()
              .then(accept)
              .catch(() => undefined),
          );
      } else {
        void api
          .readAppSettings()
          .then(accept)
          .catch(() => undefined);
      }
    }, 500);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [acceptAppUpdateStatus, api, state.network, state.snapshot?.connection.syncedAt]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let active = true;
    void CapacitorApp.getInfo()
      .then((info) => {
        if (active) setInstalledApkVersion(info.version);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_SIDE_KEY, sidebarSide);
  }, [sidebarSide]);

  useEffect(() => {
    localStorage.setItem(PROJECT_LIST_DIRECTION_KEY, projectListDirection);
  }, [projectListDirection]);

  useEffect(() => {
    let cancelled = false;
    setTranscriptionConfigError(null);
    void api
      .readTranscriptionConfig()
      .then((config) => {
        if (cancelled) return;
        setTranscriptionConfig(config);
        localStorage.removeItem(`${application.storagePrefix}.transcriptionProvider`);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setTranscriptionConfig(null);
        const localization = localizationRef.current;
        setTranscriptionConfigError(
          caught instanceof Error
            ? (localizeKnownServerText(localization.language, caught.message) ?? caught.message)
            : localization.t("Не удалось загрузить конфигурацию"),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  async function enableBrowserNotifications() {
    setNotificationRequesting(true);
    setNotificationError(null);
    try {
      const permission = await requestBrowserNotificationPermission();
      if (permission === "granted" || permission === "denied") {
        setNotificationPrompt(false);
      } else {
        setNotificationError(t("Браузер не выдал разрешение. Попробуйте ещё раз."));
      }
    } catch {
      setNotificationError(t("Не удалось запросить разрешение у браузера"));
    } finally {
      setNotificationRequesting(false);
    }
  }

  function dismissNotificationPrompt() {
    localStorage.setItem(NOTIFICATION_PROMPT_DISMISSED_KEY, "true");
    setNotificationPrompt(false);
  }

  useEffect(() => {
    function closePopupsOutside(event: MouseEvent) {
      if (!(event.target instanceof Node)) return;
      document
        .querySelectorAll<HTMLDetailsElement>("details[data-dismiss-on-outside-click][open]")
        .forEach((popup) => {
          if (!popup.contains(event.target as Node)) popup.open = false;
        });
    }

    document.addEventListener("click", closePopupsOutside);
    return () => document.removeEventListener("click", closePopupsOutside);
  }, []);

  const snapshot = state.snapshot;
  const openingThreadWithoutSnapshot =
    !snapshot && /^\/threads\/[^/]+\/?$/u.test(location.pathname);
  const attention = snapshot?.attention ?? [];
  const updateAvailable =
    appUpdateStatus?.updateAvailable === true ||
    (appUpdateStatus?.supported === true &&
      isRollingVersion(appUpdateStatus.latestVersion) &&
      installedApkVersion !== null &&
      installedApkVersion !== appUpdateStatus.latestVersion);
  return (
    <div
      className={`app-frame${drawerDragging ? " drawer-dragging" : ""}`}
      data-sidebar-side={sidebarSide}
      ref={frameRef}
      style={{ "--sidebar-preferred-width": `${sidebarWidth}px` } as CSSProperties}
    >
      {settings.baseUrl.startsWith("http://") && (
        <div className="http-warning">
          {t("Небезопасное HTTP-подключение: данные доступны перехватчику в LAN.")}
        </div>
      )}
      <Sidebar
        key={settings.baseUrl}
        containerRef={sidebarRef}
        drawer={drawer}
        onManualNavigationIntent={markManualNavigationIntent}
        onClose={() => setDrawer(false)}
        onNewProject={() => setNewProject(true)}
        projectListDirection={projectListDirection}
        serverBaseUrl={settings.baseUrl}
        updateAvailable={updateAvailable}
      />
      <SidebarResizeHandle
        frameRef={frameRef}
        onWidthCommit={setSidebarWidth}
        preferredWidth={sidebarWidth}
        side={sidebarSide}
        sidebarRef={sidebarRef}
      />
      {(drawer || drawerDragging) && (
        <button
          className="drawer-backdrop"
          aria-label={t("Закрыть меню")}
          onClick={() => setDrawer(false)}
        />
      )}
      <main className="content">
        {state.error && (
          <div className="offline-banner">
            <span>
              {t("{{error}}. Серверные задачи продолжат выполняться.", {
                error: localizeKnownServerText(language, state.error) ?? state.error,
              })}
            </span>
            <button onClick={reconnect}>{t("Повторить")}</button>
          </div>
        )}
        {!snapshot && !openingThreadWithoutSnapshot ? (
          <div className="center-state">
            <div className="spinner" />
            <p>{t("Получаем состояние Codex…")}</p>
          </div>
        ) : pendingForkOperationId ? (
          <PendingForkPage
            key={sessionWorkspaceKey}
            operationId={pendingForkOperationId}
            onOpenNavigation={() => setDrawer(true)}
          />
        ) : sessionWorkspace ? (
          <NewSession
            key={sessionWorkspaceKey}
            projects={snapshot?.projects ?? []}
            transcriptionProvider={activeTranscriptionProvider(transcriptionConfig)}
            transcriptionConfig={transcriptionConfig}
            onTranscriptionTimingEstimateChange={updateTranscriptionTimingEstimate}
            onOpenNavigation={() => setDrawer(true)}
          />
        ) : (
          <Routes>
            <Route
              path="/"
              element={
                <HomeRoute
                  threads={snapshot?.threads ?? []}
                  onOpenNavigation={() => setDrawer(true)}
                />
              }
            />
            <Route
              path="/settings"
              element={
                <SettingsPage
                  onOpenNavigation={() => setDrawer(true)}
                  onSwitchServer={() =>
                    void stopPushNotifications()
                      .catch(() => undefined)
                      .then(clearConnectionSettings)
                      .then(onDisconnected)
                  }
                  theme={theme}
                  onThemeChange={onThemeChange}
                  sidebarSide={sidebarSide}
                  onSidebarSideChange={setSidebarSide}
                  projectListDirection={projectListDirection}
                  onProjectListDirectionChange={setProjectListDirection}
                  transcriptionConfig={transcriptionConfig}
                  transcriptionConfigError={transcriptionConfigError}
                  onTranscriptionConfigChange={setTranscriptionConfig}
                  initialAppUpdateStatus={appUpdateStatus}
                  onAppUpdateStatusChange={acceptAppUpdateStatus}
                />
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </main>
      {attention.some((item) => !item.threadId) && (
        <div className="global-attention">
          <AttentionPanel
            requests={attention.filter((item) => !item.threadId)}
            transcriptionConfig={transcriptionConfig}
            transcriptionProvider={activeTranscriptionProvider(transcriptionConfig)}
            onTranscriptionTimingEstimateChange={updateTranscriptionTimingEstimate}
          />
        </div>
      )}
      {newProject && <ProjectDialog onClose={() => setNewProject(false)} />}
      {notificationPrompt && (
        <Dialog
          titleId="notification-permission-title"
          className="compact"
          closeOnBackdrop={false}
          closeOnEscape={false}
          onClose={dismissNotificationPrompt}
        >
          <div className="dialog-header">
            <div className="dialog-heading">
              <h2 id="notification-permission-title">{t("Разрешить уведомления?")}</h2>
              <p>{t("CodexNest сообщит, когда задача завершится или потребуется ваше решение.")}</p>
            </div>
          </div>
          {notificationError && (
            <div className="dialog-notice danger" role="alert">
              {notificationError}
            </div>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              disabled={notificationRequesting}
              onClick={dismissNotificationPrompt}
            >
              {t("Не сейчас")}
            </button>
            <button
              type="button"
              className="primary"
              disabled={notificationRequesting}
              onClick={() => void enableBrowserNotifications()}
            >
              {notificationRequesting ? t("Запрашиваем…") : t("Разрешить уведомления")}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function readSidebarWidth(): number {
  const stored = localStorage.getItem(SIDEBAR_WIDTH_KEY);
  if (stored === null) return DEFAULT_SIDEBAR_WIDTH;
  const width = Number(stored);
  return Number.isInteger(width) && width >= MIN_SIDEBAR_WIDTH && width <= MAX_SIDEBAR_WIDTH
    ? width
    : DEFAULT_SIDEBAR_WIDTH;
}

function maxSidebarWidth(): number {
  return Math.max(
    MIN_SIDEBAR_WIDTH,
    Math.min(MAX_SIDEBAR_WIDTH, window.innerWidth - MIN_WORKSPACE_WIDTH - DESKTOP_SIDEBAR_GUTTERS),
  );
}

function clampSidebarWidth(width: number): number {
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(maxSidebarWidth(), Math.round(width)));
}

function SidebarResizeHandle({
  frameRef,
  onWidthCommit,
  preferredWidth,
  side,
  sidebarRef,
}: {
  frameRef: RefObject<HTMLDivElement | null>;
  onWidthCommit(width: number): void;
  preferredWidth: number;
  side: SidebarSide;
  sidebarRef: RefObject<HTMLElement | null>;
}) {
  const { t } = useI18n();
  const gestureRef = useRef<SidebarResizeGesture | null>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const [liveWidth, setLiveWidth] = useState(preferredWidth);
  const [maximumWidth, setMaximumWidth] = useState(maxSidebarWidth);

  useEffect(() => setLiveWidth(preferredWidth), [preferredWidth]);
  useEffect(() => {
    const update = () => setMaximumWidth(maxSidebarWidth());
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  function showWidth(width: number) {
    frameRef.current?.style.setProperty("--sidebar-preferred-width", `${width}px`);
    setLiveWidth(width);
  }

  function finishDrag(pointerId: number, commit: boolean) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== pointerId) return;
    gestureRef.current = null;
    if (commit && gesture.width !== gesture.startWidth) {
      onWidthCommit(gesture.width);
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(gesture.width));
    } else {
      showWidth(gesture.startPreferredWidth);
    }
    const handle = handleRef.current;
    if (handle?.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && gestureRef.current) {
      event.preventDefault();
      finishDrag(gestureRef.current.pointerId, false);
      return;
    }
    const step = side === "left" ? SIDEBAR_KEYBOARD_STEP : -SIDEBAR_KEYBOARD_STEP;
    const next =
      event.key === "ArrowRight"
        ? clampSidebarWidth(liveWidth + step)
        : event.key === "ArrowLeft"
          ? clampSidebarWidth(liveWidth - step)
          : event.key === "Home"
            ? MIN_SIDEBAR_WIDTH
            : event.key === "End"
              ? maxSidebarWidth()
              : null;
    if (next === null || gestureRef.current) return;
    event.preventDefault();
    showWidth(next);
    onWidthCommit(next);
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
  }

  return (
    <div
      aria-controls="sidebar-navigation"
      aria-label={t("Ширина боковой панели")}
      aria-orientation="vertical"
      aria-valuemax={maximumWidth}
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuenow={Math.min(liveWidth, maximumWidth)}
      className="sidebar-resize-handle"
      onKeyDown={onKeyDown}
      onLostPointerCapture={(event) => finishDrag(event.pointerId, false)}
      onPointerCancel={(event) => finishDrag(event.pointerId, false)}
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0 || gestureRef.current) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        const startWidth =
          sidebarRef.current?.getBoundingClientRect().width || clampSidebarWidth(preferredWidth);
        gestureRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startWidth,
          startPreferredWidth: preferredWidth,
          width: startWidth,
        };
      }}
      onPointerMove={(event) => {
        const gesture = gestureRef.current;
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        const delta = (event.clientX - gesture.startX) * (side === "left" ? 1 : -1);
        gesture.width = clampSidebarWidth(gesture.startWidth + delta);
        showWidth(gesture.width);
      }}
      onPointerUp={(event) => finishDrag(event.pointerId, true)}
      ref={handleRef}
      role="separator"
      tabIndex={0}
    />
  );
}

function activeTranscriptionProvider(
  config: TranscriptionConfigResponse | null,
): "local" | "openai" | null {
  return config?.provider && config.providers.includes(config.provider) ? config.provider : null;
}

function readLayoutPreferences(): {
  sidebarSide: SidebarSide;
  projectListDirection: ProjectListDirection;
} {
  if (localStorage.getItem(LAYOUT_DEFAULTS_VERSION_KEY) !== LAYOUT_DEFAULTS_VERSION) {
    localStorage.setItem(SIDEBAR_SIDE_KEY, "left");
    localStorage.setItem(PROJECT_LIST_DIRECTION_KEY, "top-down");
    localStorage.setItem(LAYOUT_DEFAULTS_VERSION_KEY, LAYOUT_DEFAULTS_VERSION);
  }
  return {
    sidebarSide: localStorage.getItem(SIDEBAR_SIDE_KEY) === "right" ? "right" : "left",
    projectListDirection:
      localStorage.getItem(PROJECT_LIST_DIRECTION_KEY) === "bottom-up" ? "bottom-up" : "top-down",
  };
}

function emptySidebarTreeState(): SidebarTreeState {
  return {
    collapsedProjectIds: new Set(),
    pinnedGroupCollapsed: false,
  };
}

function readSessionListMode(): SessionListMode {
  try {
    return localStorage.getItem(SESSION_LIST_MODE_KEY) === "active" ? "active" : "projects";
  } catch {
    return "projects";
  }
}

function sidebarTreeStateStorageKey(serverBaseUrl: string): string {
  const normalizedBaseUrl = serverBaseUrl.replace(/\/+$/u, "");
  return `${SIDEBAR_TREE_STATE_KEY_PREFIX}${encodeURIComponent(normalizedBaseUrl)}`;
}

function readSidebarTreeState(serverBaseUrl: string): SidebarTreeState {
  try {
    const serialized = localStorage.getItem(sidebarTreeStateStorageKey(serverBaseUrl));
    if (!serialized) return emptySidebarTreeState();
    const parsed: unknown = JSON.parse(serialized);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return emptySidebarTreeState();
    }
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1) return emptySidebarTreeState();
    const collapsedProjectIds = readStringSet(record.collapsedProjectIds);
    return collapsedProjectIds
      ? { collapsedProjectIds, pinnedGroupCollapsed: record.pinnedGroupCollapsed === true }
      : emptySidebarTreeState();
  } catch {
    return emptySidebarTreeState();
  }
}

function readStringSet(value: unknown): Set<string> | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return null;
  return new Set(value);
}

function writeSidebarTreeState(serverBaseUrl: string, state: SidebarTreeState): void {
  try {
    localStorage.setItem(
      sidebarTreeStateStorageKey(serverBaseUrl),
      JSON.stringify({
        version: 1,
        collapsedProjectIds: [...state.collapsedProjectIds].sort(),
        pinnedGroupCollapsed: state.pinnedGroupCollapsed,
      }),
    );
  } catch {
    return;
  }
}

function toggleSidebarTreeEntry(
  state: SidebarTreeState,
  field: "collapsedProjectIds",
  id: string,
): SidebarTreeState {
  const values = new Set(state[field]);
  if (values.has(id)) values.delete(id);
  else values.add(id);
  return { ...state, [field]: values };
}

function pruneSidebarTreeState(state: SidebarTreeState, projectIds: Set<string>): SidebarTreeState {
  projectIds.add("ungrouped");
  const collapsedProjectIds = retainSidebarTreeEntries(state.collapsedProjectIds, projectIds);
  return collapsedProjectIds.size === state.collapsedProjectIds.size
    ? state
    : { ...state, collapsedProjectIds };
}

function retainSidebarTreeEntries(values: Set<string>, validIds: Set<string>): Set<string> {
  return new Set([...values].filter((id) => validIds.has(id)));
}

function retainSidebarTreeMap(
  values: Map<string, ListExpansion>,
  validIds: Set<string>,
): Map<string, ListExpansion> {
  if ([...values.keys()].every((id) => validIds.has(id))) return values;
  return new Map([...values].filter(([id]) => validIds.has(id)));
}

function toggleListExpansion(
  values: ReadonlyMap<string, ListExpansion>,
  id: string,
  total: number,
  initial: number,
): Map<string, ListExpansion> {
  const next = new Map(values);
  const expansion = next.get(id);
  const visible = expansion === "all" ? total : Math.max(expansion ?? initial, initial);
  if (expansion === "all" || visible >= total) {
    next.delete(id);
  } else if (visible + THREAD_PREVIEW_LIMIT >= total) {
    next.set(id, "all");
  } else {
    next.set(id, visible + THREAD_PREVIEW_LIMIT);
  }
  return next;
}

function HomeRoute({
  threads,
  onOpenNavigation,
}: {
  threads: ThreadSummary[];
  onOpenNavigation(): void;
}) {
  const { t } = useI18n();
  const childrenByParent = childThreadsByParent(threads);
  const latest = sortThreadBranchesByActivity(
    threads.filter((thread) => !thread.archived && thread.relation.kind === "session"),
    childrenByParent,
  )[0];
  if (latest) return <Navigate to={`/threads/${encodeURIComponent(latest.id)}`} replace />;
  return (
    <div className="thread-workspace">
      <div className="conversation-pane">
        <WorkspaceHeader
          leadingIcon={<NewTaskIcon />}
          title={t("Нет открытых сессий")}
          onOpenNavigation={onOpenNavigation}
        />
        <div className="new-session-empty">
          <span className="new-session-glyph">
            <NewTaskIcon />
          </span>
          <h2>{t("Создайте сессию в проекте")}</h2>
          <p>{t("Откройте список проектов и нажмите + рядом с нужным проектом.")}</p>
          <button type="button" onClick={onOpenNavigation}>
            {t("Открыть проекты")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Sidebar({
  containerRef,
  drawer,
  onManualNavigationIntent,
  onClose,
  onNewProject,
  projectListDirection,
  serverBaseUrl,
  updateAvailable,
}: {
  containerRef: RefObject<HTMLElement | null>;
  drawer: boolean;
  onManualNavigationIntent(): void;
  onClose(): void;
  onNewProject(): void;
  projectListDirection: ProjectListDirection;
  serverBaseUrl: string;
  updateAvailable: boolean;
}) {
  const { api, state, dispatch } = useConnection();
  const { language, t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarTree, setSidebarTree] = useState<SidebarTreeState>(() =>
    readSidebarTreeState(serverBaseUrl),
  );
  const [sessionListMode, setSessionListMode] = useState<SessionListMode>(readSessionListMode);
  const [projectListExpansions, setProjectListExpansions] = useState<Map<string, ListExpansion>>(
    () => new Map(),
  );
  const [branchHistoryExpansions, setBranchHistoryExpansions] = useState<
    Map<string, ListExpansion>
  >(() => new Map());
  const [movingProjectId, setMovingProjectId] = useState<string | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [projectDrag, setProjectDrag] = useState<ProjectDragView | null>(null);
  const [projectNotice, setProjectNotice] = useState<{
    projectId: string;
    kind: "success" | "error";
    message: string;
  } | null>(null);
  const projectDragRef = useRef<ProjectDragGesture | null>(null);
  const suppressedProjectToggleRef = useRef<string | null>(null);
  const suppressedProjectToggleTimerRef = useRef<number | undefined>(undefined);
  const noticeTimerRef = useRef<number | undefined>(undefined);
  const threadNavRef = useRef<HTMLElement>(null);
  const activeFeedRunningOrderRef = useRef<ActiveFeedRunningOrder>({
    serverBaseUrl,
    byParent: new Map(),
  });
  const [legacyRateLimits, setLegacyRateLimits] = useState<CodexRateLimitsResponse | null>(null);
  const [legacyRateLimitsUpdatedAt, setLegacyRateLimitsUpdatedAt] = useState<number | null>(null);
  const [manualRateLimitsLoading, setManualRateLimitsLoading] = useState(false);
  const [manualRateLimitsError, setManualRateLimitsError] = useState(false);
  const sharedRateLimits = state.snapshot?.codexRateLimits;
  const rateLimits = sharedRateLimits ? sharedRateLimits.limits : legacyRateLimits;
  const rateLimitsUpdatedAt = sharedRateLimits
    ? sharedRateLimits.updatedAt
    : legacyRateLimitsUpdatedAt;
  const rateLimitsLoading = manualRateLimitsLoading || sharedRateLimits?.refreshing === true;
  const rateLimitsError = manualRateLimitsError || sharedRateLimits?.refreshError === true;
  const [searchOpen, setSearchOpen] = useState(false);
  const rateLimitsGeneration = useRef(0);
  const rateLimitsRequestPending = useRef(false);
  useEffect(() => {
    rateLimitsGeneration.current++;
    rateLimitsRequestPending.current = false;
    setLegacyRateLimits(null);
    setLegacyRateLimitsUpdatedAt(null);
    setManualRateLimitsError(false);
    setManualRateLimitsLoading(false);
    return () => {
      rateLimitsGeneration.current++;
    };
  }, [api, state.snapshot?.instanceId]);
  useEffect(() => {
    setManualRateLimitsError(false);
  }, [sharedRateLimits]);
  if (activeFeedRunningOrderRef.current.serverBaseUrl !== serverBaseUrl) {
    activeFeedRunningOrderRef.current = { serverBaseUrl, byParent: new Map() };
  }
  const snapshot = state.snapshot;
  const snapshotReady = snapshot !== null;
  const allThreads = snapshot?.threads ?? [];
  const pendingForkSourceIds = new Set(
    forkOperationsFromSnapshot(snapshot)
      .filter((operation) => operation.status !== "ready")
      .map((operation) => operation.sourceThreadId),
  );
  const childrenByParent = childThreadsByParent(allThreads);
  const roots = sortThreadBranchesByActivity(topLevelThreads(allThreads), childrenByParent);
  const activeRoots = pinnedThreadsFirst(roots.filter((thread) => !thread.archived));
  const archivedRoots = roots.filter((thread) => thread.archived);
  const groups = groupedThreads(snapshot?.projects ?? [], activeRoots);
  const orderedGroups = projectListDirection === "bottom-up" ? [...groups].reverse() : groups;
  const activeFeedRoots = pinnedThreadsFirst(
    sortActiveFeedThreads(
      activeRoots.filter(
        (thread) =>
          thread.pinned || isActiveFeedEligible(thread) || pendingForkSourceIds.has(thread.id),
      ),
      childrenByParent,
      null,
      activeFeedRunningOrderRef.current.byParent,
    ),
  );
  const pinnedFeedRoots = activeFeedRoots.filter((thread) => thread.pinned);
  const unpinnedFeedRoots = activeFeedRoots.filter((thread) => !thread.pinned);
  const pinnedGroupExpanded =
    sessionListMode === "active" && pinnedFeedRoots.length > 0 && !sidebarTree.pinnedGroupCollapsed;
  const pinnedGroupLabel = pinnedGroupExpanded
    ? t("Свернуть закрепленные ({{count}})", { count: pinnedFeedRoots.length })
    : t("Показать закрепленные ({{count}})", { count: pinnedFeedRoots.length });
  const projectNames = new Map(
    (snapshot?.projects ?? []).map((project) => [project.id, project.displayName]),
  );
  const displayedProjectIds = orderedGroups.flatMap((group) =>
    group.project ? [group.project.id] : [],
  );
  const projectOrderKey = snapshot?.projects.map((project) => project.id).join(":") ?? "";

  useEffect(() => {
    writeSidebarTreeState(serverBaseUrl, sidebarTree);
  }, [serverBaseUrl, sidebarTree]);

  useEffect(() => {
    try {
      localStorage.setItem(SESSION_LIST_MODE_KEY, sessionListMode);
    } catch {
      return;
    }
  }, [sessionListMode]);

  useEffect(() => {
    if (!snapshot) return;
    setSidebarTree((current) =>
      pruneSidebarTreeState(current, new Set(snapshot.projects.map((project) => project.id))),
    );
    const projectIds = new Set(snapshot.projects.map((project) => project.id));
    projectIds.add("ungrouped");
    setProjectListExpansions((current) => retainSidebarTreeMap(current, projectIds));
    const threadIds = new Set(snapshot.threads.map((thread) => thread.id));
    setBranchHistoryExpansions((current) => retainSidebarTreeMap(current, threadIds));
  }, [snapshot]);

  useEffect(() => {
    const resetProjectLists = () =>
      setProjectListExpansions((current) => (current.size ? new Map() : current));
    const foreground = () => {
      if (document.visibilityState === "visible") resetProjectLists();
    };
    let disposed = false;
    let removeNativeListener: (() => Promise<void>) | undefined;
    if (Capacitor.isNativePlatform()) {
      void CapacitorApp.addListener("appStateChange", ({ isActive }) => {
        if (isActive) resetProjectLists();
      }).then((handle) => {
        if (disposed) void handle.remove();
        else removeNativeListener = () => handle.remove();
      });
    } else {
      document.addEventListener("visibilitychange", foreground);
    }
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", foreground);
      void removeNativeListener?.();
    };
  }, []);

  useEffect(() => {
    if (!snapshotReady) return;
    const navigation = threadNavRef.current;
    if (!navigation) return;
    navigation.scrollTop =
      sessionListMode === "projects" && projectListDirection === "bottom-up"
        ? navigation.scrollHeight
        : 0;
  }, [projectListDirection, sessionListMode, snapshotReady]);

  useEffect(() => {
    const navigation = threadNavRef.current;
    if (!navigation || !snapshotReady) return;

    const updateScrollFades = () => {
      const maxScroll = Math.max(0, navigation.scrollHeight - navigation.clientHeight);
      // Clamp elastic overscroll before calculating either edge.
      const scrollTop = Math.max(0, Math.min(maxScroll, navigation.scrollTop));
      const fadeSize = Math.min(28, navigation.clientHeight / 2);
      navigation.style.setProperty("--thread-nav-fade-top", `${Math.min(fadeSize, scrollTop)}px`);
      navigation.style.setProperty(
        "--thread-nav-fade-bottom",
        `${Math.min(fadeSize, maxScroll - scrollTop)}px`,
      );
    };

    updateScrollFades();
    navigation.addEventListener("scroll", updateScrollFades, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateScrollFades);
    observer?.observe(navigation);
    // Watch content as well: expanding groups and incoming sessions can change
    // the scroll extent without changing the navigation viewport.
    if (navigation.firstElementChild) observer?.observe(navigation.firstElementChild);
    return () => {
      navigation.removeEventListener("scroll", updateScrollFades);
      observer?.disconnect();
    };
  }, [projectListDirection, sessionListMode, snapshotReady]);

  useEffect(
    () => () => {
      if (noticeTimerRef.current !== undefined) window.clearTimeout(noticeTimerRef.current);
      if (suppressedProjectToggleTimerRef.current !== undefined) {
        window.clearTimeout(suppressedProjectToggleTimerRef.current);
      }
      const gesture = projectDragRef.current;
      if (gesture) releaseProjectDragResources(gesture);
      projectDragRef.current = null;
    },
    [],
  );

  useEffect(() => {
    function cancelWithEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      const gesture = projectDragRef.current;
      if (!gesture) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      clearProjectDragGesture(gesture);
    }

    window.addEventListener("keydown", cancelWithEscape, true);
    return () => window.removeEventListener("keydown", cancelWithEscape, true);
  }, []);

  useEffect(() => {
    const gesture = projectDragRef.current;
    if (!gesture) return;
    clearProjectDragGesture(gesture);
  }, [projectOrderKey]);

  function toggleCollapsed(key: string) {
    setSidebarTree((current) => toggleSidebarTreeEntry(current, "collapsedProjectIds", key));
  }

  function toggleProjectFromClick(projectId: string, key: string) {
    if (suppressedProjectToggleRef.current === projectId) {
      suppressedProjectToggleRef.current = null;
      if (suppressedProjectToggleTimerRef.current !== undefined) {
        window.clearTimeout(suppressedProjectToggleTimerRef.current);
        suppressedProjectToggleTimerRef.current = undefined;
      }
      return;
    }
    toggleCollapsed(key);
  }

  function suppressProjectToggleClick(projectId: string) {
    if (suppressedProjectToggleTimerRef.current !== undefined) {
      window.clearTimeout(suppressedProjectToggleTimerRef.current);
    }
    suppressedProjectToggleRef.current = projectId;
    suppressedProjectToggleTimerRef.current = window.setTimeout(() => {
      suppressedProjectToggleRef.current = null;
      suppressedProjectToggleTimerRef.current = undefined;
    }, 0);
  }

  function toggleProjectList(key: string, total: number, initial: number) {
    setProjectListExpansions((current) => toggleListExpansion(current, key, total, initial));
  }

  function toggleBranchHistory(threadId: string, total: number) {
    setBranchHistoryExpansions((current) =>
      toggleListExpansion(current, threadId, total, THREAD_PREVIEW_LIMIT),
    );
  }

  function renderActiveThread(thread: ThreadSummary) {
    return (
      <ActiveThreadBranch
        onNewSession={openNewSession}
        thread={thread}
        childrenByParent={childrenByParent}
        key={thread.id}
        onNavigate={onClose}
        runningOrderByParent={activeFeedRunningOrderRef.current.byParent}
        projectLabel={
          (thread.projectId ? projectNames.get(thread.projectId) : null) ?? t("Без проекта")
        }
      />
    );
  }

  function showProjectNotice(
    projectId: string,
    kind: "success" | "error",
    message: string,
    temporary = false,
  ) {
    if (noticeTimerRef.current !== undefined) window.clearTimeout(noticeTimerRef.current);
    setProjectNotice({ projectId, kind, message });
    if (temporary) {
      noticeTimerRef.current = window.setTimeout(() => setProjectNotice(null), 2_000);
    }
  }

  async function copyProjectPath(projectId: string, path: string, menu: HTMLDetailsElement | null) {
    try {
      await copyText(path);
      menu?.removeAttribute("open");
      showProjectNotice(projectId, "success", t("Путь скопирован"), true);
    } catch {
      showProjectNotice(projectId, "error", t("Не удалось скопировать путь"));
    }
  }

  async function moveProject(
    projectId: string,
    move: MoveProjectRequest,
    menu: HTMLDetailsElement | null,
  ) {
    if (movingProjectId || deletingProjectId) return;
    setMovingProjectId(projectId);
    setProjectNotice(null);
    try {
      await api.moveProject(projectId, move);
      menu?.removeAttribute("open");
    } catch (caught) {
      showProjectNotice(
        projectId,
        "error",
        caught instanceof Error
          ? (localizeKnownServerText(language, caught.message) ?? caught.message)
          : t("Не удалось изменить порядок проектов"),
      );
    } finally {
      setMovingProjectId(null);
    }
  }

  async function deleteProject(
    project: Project,
    projectThreads: ThreadSummary[],
    menu: HTMLDetailsElement | null,
  ) {
    if (deletingProjectId) return;
    if (
      projectThreads.some(
        (thread) =>
          thread.state === "running" ||
          thread.state === "queued" ||
          thread.state === "needsAttention" ||
          thread.queuedMessageCount > 0,
      )
    ) {
      menu?.removeAttribute("open");
      showProjectNotice(
        project.id,
        "error",
        t(
          "Нельзя удалить проект, пока его сессии выполняются, ждут решения или содержат сообщения в очереди",
        ),
      );
      return;
    }
    if (
      !window.confirm(
        t(
          "Удалить проект «{{project}}» из Codex Nest? Проект и его сессии исчезнут из приложения, но папка и история сохранятся.",
          { project: project.displayName },
        ),
      )
    ) {
      return;
    }
    setDeletingProjectId(project.id);
    setProjectNotice(null);
    try {
      await api.deleteProject(project.id);
      menu?.removeAttribute("open");
      dispatch({
        type: "project.remove",
        projectId: project.id,
        threadIds: projectThreads.map((thread) => thread.id),
      });
      if (
        projectThreads.some(
          (thread) => location.pathname === `/threads/${encodeURIComponent(thread.id)}`,
        )
      ) {
        onClose();
        navigate("/", { replace: true });
      }
    } catch (caught) {
      showProjectNotice(
        project.id,
        "error",
        caught instanceof Error
          ? (localizeKnownServerText(language, caught.message) ?? caught.message)
          : t("Не удалось удалить проект"),
      );
    } finally {
      setDeletingProjectId(null);
    }
  }

  function projectInsertionIndex(gesture: ProjectDragGesture): number {
    const navigation = threadNavRef.current;
    if (!navigation) return gesture.insertionIndex;
    const groups = Array.from(
      navigation.querySelectorAll<HTMLElement>(".project-group[data-project-id]"),
    ).filter((group) => group.dataset.projectId !== gesture.projectId);
    const insertionIndex = groups.findIndex((group) => {
      const header = group.querySelector<HTMLElement>(".project-title");
      if (!header) return false;
      const bounds = header.getBoundingClientRect();
      return gesture.clientY < bounds.top + bounds.height / 2;
    });
    return insertionIndex < 0 ? groups.length : insertionIndex;
  }

  function updateProjectDragTarget(gesture: ProjectDragGesture) {
    const insertionIndex = projectInsertionIndex(gesture);
    if (insertionIndex === gesture.insertionIndex) return;
    gesture.insertionIndex = insertionIndex;
    setProjectDrag({ projectId: gesture.projectId, insertionIndex });
  }

  function scheduleProjectDragFrame(gesture: ProjectDragGesture) {
    if (gesture.frameId !== null) return;
    gesture.frameId = window.requestAnimationFrame(() => {
      gesture.frameId = null;
      if (projectDragRef.current !== gesture || !gesture.active) return;
      updateProjectDragTarget(gesture);

      const navigation = threadNavRef.current;
      if (!navigation) return;
      const bounds = navigation.getBoundingClientRect();
      if (bounds.height <= 0) return;
      const topPressure = Math.max(
        0,
        Math.min(
          1,
          (bounds.top + PROJECT_DRAG_SCROLL_EDGE - gesture.clientY) / PROJECT_DRAG_SCROLL_EDGE,
        ),
      );
      const bottomPressure = Math.max(
        0,
        Math.min(
          1,
          (gesture.clientY - (bounds.bottom - PROJECT_DRAG_SCROLL_EDGE)) / PROJECT_DRAG_SCROLL_EDGE,
        ),
      );
      const scrollDelta = Math.round(PROJECT_DRAG_SCROLL_SPEED * (bottomPressure - topPressure));
      if (!scrollDelta) return;
      const previousScrollTop = navigation.scrollTop;
      navigation.scrollTop += scrollDelta;
      if (navigation.scrollTop === previousScrollTop) return;
      updateProjectDragTarget(gesture);
      scheduleProjectDragFrame(gesture);
    });
  }

  function beginProjectDrag(event: ReactPointerEvent<HTMLElement>, projectId: string) {
    if (
      movingProjectId ||
      deletingProjectId ||
      projectDragRef.current ||
      !event.isPrimary ||
      event.button !== 0
    ) {
      return;
    }
    const displayIndex = displayedProjectIds.indexOf(projectId);
    if (displayIndex < 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    projectDragRef.current = {
      active: false,
      clientY: event.clientY,
      direction: projectListDirection,
      displayProjectIds: displayedProjectIds,
      element: event.currentTarget,
      frameId: null,
      holdTimerId: null,
      insertionIndex: displayIndex,
      pointerId: event.pointerId,
      projectId,
      source: "handle",
      startX: event.clientX,
      startY: event.clientY,
      touchCleanup: null,
    };
    setProjectNotice(null);
  }

  function moveProjectDrag(event: ReactPointerEvent<HTMLElement>) {
    const gesture = projectDragRef.current;
    if (!gesture || gesture.source !== "handle" || gesture.pointerId !== event.pointerId) {
      return;
    }
    gesture.clientY = event.clientY;
    if (!gesture.active) {
      const distance = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY);
      if (distance < PROJECT_DRAG_START_DISTANCE) return;
      gesture.active = true;
      setProjectDrag({
        projectId: gesture.projectId,
        insertionIndex: gesture.insertionIndex,
      });
    }
    event.preventDefault();
    updateProjectDragTarget(gesture);
    scheduleProjectDragFrame(gesture);
  }

  function releaseProjectDragResources(gesture: ProjectDragGesture) {
    if (gesture.holdTimerId !== null) {
      window.clearTimeout(gesture.holdTimerId);
      gesture.holdTimerId = null;
    }
    if (gesture.frameId !== null) window.cancelAnimationFrame(gesture.frameId);
    gesture.frameId = null;
    gesture.touchCleanup?.();
    gesture.touchCleanup = null;
    if (gesture.source === "handle" && gesture.element.hasPointerCapture?.(gesture.pointerId)) {
      gesture.element.releasePointerCapture(gesture.pointerId);
    }
  }

  function clearProjectDragGesture(gesture: ProjectDragGesture) {
    if (projectDragRef.current !== gesture) return null;
    projectDragRef.current = null;
    releaseProjectDragResources(gesture);
    setProjectDrag(null);
    return gesture;
  }

  function cancelProjectDrag(event: ReactPointerEvent<HTMLElement>) {
    const gesture = projectDragRef.current;
    if (gesture?.source === "handle" && gesture.pointerId === event.pointerId) {
      clearProjectDragGesture(gesture);
    }
  }

  function finishProjectDrag(event: ReactPointerEvent<HTMLElement>) {
    const gesture = projectDragRef.current;
    if (!gesture || gesture.source !== "handle" || gesture.pointerId !== event.pointerId) {
      return;
    }
    completeProjectDrag(gesture);
  }

  function completeProjectDrag(gesture: ProjectDragGesture) {
    if (!clearProjectDragGesture(gesture)?.active) return;
    const remainingIds = gesture.displayProjectIds.filter((id) => id !== gesture.projectId);
    const desiredDisplayIds = [...remainingIds];
    desiredDisplayIds.splice(gesture.insertionIndex, 0, gesture.projectId);
    if (desiredDisplayIds.every((id, index) => id === gesture.displayProjectIds[index])) return;
    const desiredServerIds =
      gesture.direction === "bottom-up" ? [...desiredDisplayIds].reverse() : desiredDisplayIds;
    const targetIndex = desiredServerIds.indexOf(gesture.projectId);
    if (targetIndex < 0) return;
    void moveProject(gesture.projectId, { targetIndex }, null);
  }

  function beginProjectLongPress(event: ReactTouchEvent<HTMLElement>, projectId: string) {
    if (
      movingProjectId ||
      deletingProjectId ||
      projectDragRef.current ||
      event.touches.length !== 1
    ) {
      return;
    }
    const displayIndex = displayedProjectIds.indexOf(projectId);
    const touch = event.touches[0];
    if (displayIndex < 0 || !touch) return;

    const gesture: ProjectDragGesture = {
      active: false,
      clientY: touch.clientY,
      direction: projectListDirection,
      displayProjectIds: displayedProjectIds,
      element: event.currentTarget,
      frameId: null,
      holdTimerId: null,
      insertionIndex: displayIndex,
      pointerId: touch.identifier,
      projectId,
      source: "long-press",
      startX: touch.clientX,
      startY: touch.clientY,
      touchCleanup: null,
    };

    const matchingTouch = (touches: TouchList) => {
      for (let index = 0; index < touches.length; index += 1) {
        const candidate = touches[index];
        if (candidate?.identifier === gesture.pointerId) return candidate;
      }
      return null;
    };
    const cancelForAdditionalTouch = (touchEvent: TouchEvent) => {
      if (touchEvent.touches.length === 1) return;
      if (gesture.active) touchEvent.preventDefault();
      clearProjectDragGesture(gesture);
    };
    const moveTouch = (touchEvent: TouchEvent) => {
      if (projectDragRef.current !== gesture) return;
      if (touchEvent.touches.length !== 1) {
        if (gesture.active) touchEvent.preventDefault();
        clearProjectDragGesture(gesture);
        return;
      }
      const currentTouch = matchingTouch(touchEvent.touches);
      if (!currentTouch) {
        clearProjectDragGesture(gesture);
        return;
      }
      gesture.clientY = currentTouch.clientY;
      if (!gesture.active) {
        const distance = Math.hypot(
          currentTouch.clientX - gesture.startX,
          currentTouch.clientY - gesture.startY,
        );
        if (distance < PROJECT_LONG_PRESS_MOVE_TOLERANCE) return;
        clearProjectDragGesture(gesture);
        return;
      }
      touchEvent.preventDefault();
      updateProjectDragTarget(gesture);
      scheduleProjectDragFrame(gesture);
    };
    const endTouch = (touchEvent: TouchEvent) => {
      if (projectDragRef.current !== gesture) return;
      if (!matchingTouch(touchEvent.changedTouches)) return;
      if (gesture.active) {
        touchEvent.preventDefault();
        suppressProjectToggleClick(gesture.projectId);
        completeProjectDrag(gesture);
      } else {
        clearProjectDragGesture(gesture);
      }
    };
    const cancelTouch = () => clearProjectDragGesture(gesture);
    gesture.touchCleanup = () => {
      window.removeEventListener("touchstart", cancelForAdditionalTouch);
      window.removeEventListener("touchmove", moveTouch);
      window.removeEventListener("touchend", endTouch);
      window.removeEventListener("touchcancel", cancelTouch);
    };

    projectDragRef.current = gesture;
    window.addEventListener("touchstart", cancelForAdditionalTouch, { passive: false });
    window.addEventListener("touchmove", moveTouch, { passive: false });
    window.addEventListener("touchend", endTouch, { passive: false });
    window.addEventListener("touchcancel", cancelTouch);
    gesture.holdTimerId = window.setTimeout(() => {
      if (projectDragRef.current !== gesture || gesture.active) return;
      gesture.holdTimerId = null;
      gesture.active = true;
      setProjectNotice(null);
      setProjectDrag({ projectId: gesture.projectId, insertionIndex: gesture.insertionIndex });
      updateProjectDragTarget(gesture);
      scheduleProjectDragFrame(gesture);
    }, PROJECT_LONG_PRESS_DELAY);
  }

  function openNewSession(projectId: string) {
    onClose();
    navigate(`/new?${new URLSearchParams({ projectId })}`, {
      state: {
        newSessionProjectId: projectId,
        newSessionWorkspaceId:
          globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
      },
    });
  }

  async function refreshRateLimits() {
    if (
      !application.capabilities.rateLimits ||
      rateLimitsLoading ||
      rateLimitsRequestPending.current
    )
      return;
    const generation = ++rateLimitsGeneration.current;
    rateLimitsRequestPending.current = true;
    setManualRateLimitsLoading(true);
    setManualRateLimitsError(false);
    try {
      const limits = await api.readCodexRateLimits();
      if (generation !== rateLimitsGeneration.current) return;
      if (!sharedRateLimits) {
        setLegacyRateLimits(limits);
        setLegacyRateLimitsUpdatedAt(Date.now());
      }
    } catch {
      if (generation === rateLimitsGeneration.current) setManualRateLimitsError(true);
    } finally {
      if (generation === rateLimitsGeneration.current) {
        rateLimitsRequestPending.current = false;
        setManualRateLimitsLoading(false);
      }
    }
  }

  const rateLimitsText = rateLimitsLabel(rateLimits, rateLimitsError, language, t);
  const rateLimitsDescription = rateLimitsAriaLabel(
    rateLimitsText,
    rateLimitsLoading,
    rateLimitsError,
    rateLimitsUpdatedAt,
    language,
    t,
  );
  const projectDragTargets = projectDrag
    ? displayedProjectIds.filter((projectId) => projectId !== projectDrag.projectId)
    : [];
  const dropBeforeProjectId = projectDrag
    ? (projectDragTargets[projectDrag.insertionIndex] ?? null)
    : null;
  const dropAfterProjectId =
    projectDrag && dropBeforeProjectId === null ? (projectDragTargets.at(-1) ?? null) : null;
  const archive = archivedRoots.length > 0 && (
    <details className="archive-group">
      <summary>
        {t("Архив")}
        <span>{archivedRoots.length}</span>
      </summary>
      {archivedRoots.map((thread) => (
        <ThreadBranch
          branchHistoryExpansions={branchHistoryExpansions}
          thread={thread}
          childrenByParent={childrenByParent}
          key={thread.id}
          onNavigate={onClose}
          onToggleHistory={toggleBranchHistory}
        />
      ))}
    </details>
  );

  return (
    <aside className={`sidebar ${drawer ? "open" : ""}`} id="sidebar-navigation" ref={containerRef}>
      <div className="sidebar-controls">
        <NavLink className="sidebar-control-action" to="/settings" onClick={onClose}>
          <SlidersIcon />
          {t("Настройки")}
        </NavLink>
        {application.capabilities.appUpdates && (
          <NavLink
            aria-label={
              updateAvailable ? t("Доступно обновление CodexNest") : t("Обновление CodexNest")
            }
            className={`sidebar-compact-control app-update-indicator${
              updateAvailable ? " update-available" : ""
            }`}
            onClick={onClose}
            title={updateAvailable ? t("Доступно обновление CodexNest") : t("Обновление CodexNest")}
            to="/settings?section=maintenance"
          >
            <ArrowDownIcon />
          </NavLink>
        )}
        {application.capabilities.rateLimits && (
          <button
            aria-busy={rateLimitsLoading}
            aria-label={rateLimitsDescription}
            title={rateLimitsDescription}
            className="sidebar-control-action codex-limits"
            disabled={rateLimitsLoading}
            onClick={() => void refreshRateLimits()}
          >
            {rateLimitsLoading ? <span className="spinner small" /> : <GaugeIcon />}
            <span>{rateLimitsText}</span>
          </button>
        )}
        <div
          aria-label={t("Состояние сервера: {{state}}", {
            state: networkLabel(state.network, t),
          })}
          className="sidebar-compact-control server-connection"
          role="status"
        >
          <ConnectionDot state={state.network} />
          <span className="sr-only">{networkLabel(state.network, t)}</span>
        </div>
        <button className="sidebar-control-action" onClick={onNewProject}>
          <PlusIcon />
          {t("Добавить проект")}
        </button>
        <button
          aria-label={t("Поиск по диалогам")}
          className="icon-button sidebar-compact-control sidebar-search-action"
          onClick={() => setSearchOpen(true)}
          title={t("Поиск по диалогам")}
          type="button"
        >
          <SearchIcon />
        </button>
      </div>
      <div className="session-list-mode" role="group" aria-label={t("Режим списка сессий")}>
        <button
          aria-pressed={sessionListMode === "projects"}
          onClick={() => setSessionListMode("projects")}
          type="button"
        >
          {t("Проекты")}
        </button>
        <button
          aria-pressed={sessionListMode === "active"}
          onClick={() => setSessionListMode("active")}
          type="button"
        >
          {t("Активные")}
        </button>
        <button
          aria-controls={
            sessionListMode === "active" && pinnedFeedRoots.length > 0
              ? "active-pinned-sessions"
              : undefined
          }
          aria-expanded={pinnedGroupExpanded}
          aria-label={pinnedGroupLabel}
          className="pinned-group-toggle"
          onClick={() => {
            if (sessionListMode === "active" && pinnedFeedRoots.length === 0) return;
            setSidebarTree((current) => ({
              ...current,
              pinnedGroupCollapsed:
                sessionListMode === "active" ? !current.pinnedGroupCollapsed : false,
            }));
            setSessionListMode("active");
          }}
          title={pinnedGroupLabel}
          type="button"
        >
          {sidebarTree.pinnedGroupCollapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
          <PinIcon />
          <span aria-hidden="true">{pinnedFeedRoots.length}</span>
        </button>
      </div>
      <nav
        className={`thread-nav ${projectListDirection}`}
        aria-label={t("Задачи")}
        onClickCapture={(event) => {
          if (
            !(event.target instanceof Element) ||
            !event.target.closest("a.thread-link") ||
            event.defaultPrevented ||
            event.button !== 0 ||
            event.metaKey ||
            event.altKey ||
            event.ctrlKey ||
            event.shiftKey
          ) {
            return;
          }
          onManualNavigationIntent();
        }}
        ref={threadNavRef}
      >
        {sessionListMode === "active" ? (
          <div className="active-session-list">
            {pinnedFeedRoots.length > 0 && (
              <div
                className="active-pinned-sessions"
                hidden={sidebarTree.pinnedGroupCollapsed}
                id="active-pinned-sessions"
              >
                {pinnedFeedRoots.map(renderActiveThread)}
              </div>
            )}
            {unpinnedFeedRoots.map(renderActiveThread)}
            {!activeFeedRoots.length && (
              <div className="active-session-empty">{t("Нет активных сессий")}</div>
            )}
          </div>
        ) : (
          <div className={`project-list${projectDrag ? " project-list-dragging" : ""}`}>
            {projectListDirection === "bottom-up" && archive}
            {orderedGroups.map((group) => {
              const key = group.project?.id ?? "ungrouped";
              const groupCollapsed = sidebarTree.collapsedProjectIds.has(key);
              const alwaysVisibleThreads = group.threads.filter(
                (thread) =>
                  thread.pinned ||
                  hasAlwaysVisibleThreadStatus(thread) ||
                  pendingForkSourceIds.has(thread.id),
              );
              const collapsibleThreads = group.threads.filter(
                (thread) =>
                  !thread.pinned &&
                  !hasAlwaysVisibleThreadStatus(thread) &&
                  !pendingForkSourceIds.has(thread.id),
              );
              const initialCollapsibleLimit = Math.max(
                0,
                THREAD_PREVIEW_LIMIT - alwaysVisibleThreads.length,
              );
              const projectListExpansion = projectListExpansions.get(key);
              const requestedCollapsibleLimit =
                projectListExpansion === "all"
                  ? collapsibleThreads.length
                  : (projectListExpansion ?? initialCollapsibleLimit);
              const collapsibleLimit = Math.max(initialCollapsibleLimit, requestedCollapsibleLimit);
              const groupShowsAll =
                collapsibleThreads.length > initialCollapsibleLimit &&
                collapsibleLimit >= collapsibleThreads.length;
              const isBottomUp = projectListDirection === "bottom-up";
              const visibleCollapsibleIds = new Set(
                collapsibleThreads.slice(0, collapsibleLimit).map((thread) => thread.id),
              );
              const visible = group.threads.filter(
                (thread) =>
                  thread.pinned ||
                  hasAlwaysVisibleThreadStatus(thread) ||
                  pendingForkSourceIds.has(thread.id) ||
                  visibleCollapsibleIds.has(thread.id),
              );
              const projectThreads = group.project
                ? (snapshot?.threads.filter((thread) => thread.projectId === group.project!.id) ??
                  [])
                : [];
              const sessionsId = `project-sessions-${key}`;
              const projectIndex = group.project
                ? (snapshot?.projects.findIndex((project) => project.id === group.project!.id) ??
                  -1)
                : -1;
              const lastProjectIndex = (snapshot?.projects.length ?? 0) - 1;
              const moveAboveDirection = isBottomUp ? "down" : "up";
              const moveBelowDirection = isBottomUp ? "up" : "down";
              const cannotMoveAbove = projectIndex === (isBottomUp ? lastProjectIndex : 0);
              const cannotMoveBelow = projectIndex === (isBottomUp ? 0 : lastProjectIndex);
              const projectHeader = (
                <div className="project-title">
                  <button
                    aria-controls={sessionsId}
                    aria-expanded={!groupCollapsed}
                    className="project-toggle"
                    type="button"
                    onClick={() =>
                      group.project
                        ? toggleProjectFromClick(group.project.id, key)
                        : toggleCollapsed(key)
                    }
                    onContextMenu={(event) => {
                      const gesture = projectDragRef.current;
                      if (
                        gesture?.source === "long-press" &&
                        gesture.projectId === group.project?.id
                      ) {
                        event.preventDefault();
                      }
                    }}
                    onTouchStart={
                      group.project
                        ? (event) => beginProjectLongPress(event, group.project!.id)
                        : undefined
                    }
                  >
                    {groupCollapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
                    <FolderIcon />
                    <span>{group.project?.displayName ?? t("Без проекта")}</span>
                  </button>
                  {group.project && (
                    <>
                      <span
                        aria-hidden="true"
                        className="project-drag-handle"
                        data-project-drag-handle
                        onLostPointerCapture={cancelProjectDrag}
                        onPointerCancel={cancelProjectDrag}
                        onPointerDown={(event) => beginProjectDrag(event, group.project!.id)}
                        onPointerMove={moveProjectDrag}
                        onPointerUp={finishProjectDrag}
                        title={t("Перетащить проект {{project}}", {
                          project: group.project.displayName,
                        })}
                      >
                        <GripVerticalIcon />
                      </span>
                      <details className="project-action-menu" data-dismiss-on-outside-click>
                        <summary
                          aria-label={t("Действия с проектом {{project}}", {
                            project: group.project.displayName,
                          })}
                          className="project-icon-action"
                        >
                          <MoreIcon />
                        </summary>
                        <div className="project-action-popover">
                          <button
                            type="button"
                            onClick={(event) =>
                              void copyProjectPath(
                                group.project!.id,
                                group.project!.path,
                                event.currentTarget.closest("details"),
                              )
                            }
                          >
                            <CopyIcon /> {t("Копировать путь")}
                          </button>
                          <button
                            disabled={
                              cannotMoveAbove ||
                              movingProjectId !== null ||
                              deletingProjectId !== null
                            }
                            type="button"
                            onClick={(event) =>
                              void moveProject(
                                group.project!.id,
                                { direction: moveAboveDirection },
                                event.currentTarget.closest("details"),
                              )
                            }
                          >
                            <ArrowUpIcon /> {t("Переместить выше")}
                          </button>
                          <button
                            disabled={
                              cannotMoveBelow ||
                              movingProjectId !== null ||
                              deletingProjectId !== null
                            }
                            type="button"
                            onClick={(event) =>
                              void moveProject(
                                group.project!.id,
                                { direction: moveBelowDirection },
                                event.currentTarget.closest("details"),
                              )
                            }
                          >
                            <ArrowDownIcon /> {t("Переместить ниже")}
                          </button>
                          <button
                            className="danger"
                            disabled={deletingProjectId !== null}
                            type="button"
                            onClick={(event) =>
                              void deleteProject(
                                group.project!,
                                projectThreads,
                                event.currentTarget.closest("details"),
                              )
                            }
                          >
                            <TrashIcon />{" "}
                            {deletingProjectId === group.project.id
                              ? t("Удаляем…")
                              : t("Удалить проект")}
                          </button>
                        </div>
                      </details>
                      <button
                        aria-label={t("Создать новую сессию в проекте {{project}}", {
                          project: group.project.displayName,
                        })}
                        className="project-icon-action"
                        disabled={deletingProjectId !== null}
                        type="button"
                        onClick={() => openNewSession(group.project!.id)}
                      >
                        <PlusIcon />
                      </button>
                    </>
                  )}
                </div>
              );
              const feedback = (
                <>
                  {projectNotice && projectNotice.projectId === group.project?.id && (
                    <div
                      className={`project-action-notice ${projectNotice.kind}`}
                      role={projectNotice.kind === "error" ? "alert" : "status"}
                    >
                      {projectNotice.message}
                    </div>
                  )}
                </>
              );
              const sessions = (
                <div className="project-sessions" hidden={groupCollapsed} id={sessionsId}>
                  {visible.map((thread) => (
                    <ThreadBranch
                      branchHistoryExpansions={branchHistoryExpansions}
                      thread={thread}
                      childrenByParent={childrenByParent}
                      key={thread.id}
                      onNavigate={onClose}
                      onToggleHistory={toggleBranchHistory}
                    />
                  ))}
                  {collapsibleThreads.length > initialCollapsibleLimit && (
                    <button
                      className="show-more"
                      onClick={() =>
                        toggleProjectList(key, collapsibleThreads.length, initialCollapsibleLimit)
                      }
                    >
                      {groupShowsAll
                        ? t("Показать меньше")
                        : t("Показать ещё {{count}}", {
                            count: Math.min(
                              THREAD_PREVIEW_LIMIT,
                              collapsibleThreads.length - collapsibleLimit,
                            ),
                          })}
                    </button>
                  )}
                  {!group.threads.length && (
                    <span className="project-empty">{t("Пока нет задач")}</span>
                  )}
                </div>
              );
              const projectGroupClasses = [
                "project-group",
                group.project?.id === projectDrag?.projectId ? "project-group-dragging" : "",
                group.project?.id === dropBeforeProjectId ? "project-drop-before" : "",
                group.project?.id === dropAfterProjectId ? "project-drop-after" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <section
                  className={projectGroupClasses}
                  data-project-id={group.project?.id}
                  key={key}
                >
                  {projectHeader}
                  {feedback}
                  {sessions}
                </section>
              );
            })}
            {projectListDirection === "top-down" && archive}
          </div>
        )}
      </nav>
      <ThreadSearchDialog
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onNavigate={onClose}
      />
    </aside>
  );
}

function ThreadBranch({
  thread,
  childrenByParent,
  branchHistoryExpansions,
  onNavigate,
  onToggleHistory,
}: {
  thread: ThreadSummary;
  childrenByParent: Map<string, ThreadSummary[]>;
  branchHistoryExpansions: ReadonlyMap<string, ListExpansion>;
  onNavigate(): void;
  onToggleHistory(threadId: string, total: number): void;
}) {
  const { t } = useI18n();
  const { state } = useConnection();
  const [expanded, setExpanded] = useState(false);
  const childrenId = useId();
  const forkOperations = forkOperationsFromSnapshot(state.snapshot).filter(
    (operation) => operation.sourceThreadId === thread.id && operation.status !== "ready",
  );
  const children = sortThreadBranchesByActivity(
    childrenByParent.get(thread.id) ?? [],
    childrenByParent,
  );
  const activeChildren = children.filter((child) => child.state === "running");
  const historyChildren = children.filter((child) => child.state !== "running");
  const historyExpansion = branchHistoryExpansions.get(thread.id);
  const historyLimit =
    historyExpansion === "all"
      ? historyChildren.length
      : (historyExpansion ?? THREAD_PREVIEW_LIMIT);
  const showsAllHistory = historyChildren.length > 0 && historyLimit >= historyChildren.length;
  const visibleChildren = [...activeChildren, ...historyChildren.slice(0, historyLimit)];

  return (
    <div className="thread-branch">
      <ThreadLink
        thread={thread}
        onNavigate={onNavigate}
        subagentCount={children.length}
        subagentsExpanded={expanded}
        subagentsId={childrenId}
        onToggleSubagents={() => setExpanded((value) => !value)}
      />
      {((expanded && children.length > 0) || forkOperations.length > 0) && (
        <div className="thread-branch-children" id={childrenId}>
          {forkOperations.map((operation) => (
            <ForkOperationRow
              operation={operation}
              source={thread}
              key={operation.id}
              onNavigate={onNavigate}
            />
          ))}
          {expanded &&
            visibleChildren.map((child) => (
              <ThreadBranch
                branchHistoryExpansions={branchHistoryExpansions}
                thread={child}
                childrenByParent={childrenByParent}
                key={child.id}
                onNavigate={onNavigate}
                onToggleHistory={onToggleHistory}
              />
            ))}
          {expanded && historyChildren.length > THREAD_PREVIEW_LIMIT && (
            <button
              className="show-more"
              type="button"
              onClick={() => onToggleHistory(thread.id, historyChildren.length)}
            >
              {showsAllHistory
                ? t("Показать меньше")
                : t("Показать ещё {{count}}", {
                    count: Math.min(THREAD_PREVIEW_LIMIT, historyChildren.length - historyLimit),
                  })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ActiveThreadBranch({
  onNewSession,
  thread,
  childrenByParent,
  onNavigate,
  projectLabel,
  runningOrderByParent,
}: {
  onNewSession(projectId: string): void;
  thread: ThreadSummary;
  childrenByParent: Map<string, ThreadSummary[]>;
  onNavigate(): void;
  projectLabel?: string;
  runningOrderByParent: Map<string | null, string[]>;
}) {
  const { state } = useConnection();
  const [expanded, setExpanded] = useState(false);
  const childrenId = useId();
  const forkOperations = forkOperationsFromSnapshot(state.snapshot).filter(
    (operation) =>
      operation.sourceThreadId === thread.id &&
      (operation.status === "preparing" || operation.status === "reconciling"),
  );
  const children = sortActiveFeedThreads(
    (childrenByParent.get(thread.id) ?? []).filter(isActiveChildFeedEligible),
    childrenByParent,
    thread.id,
    runningOrderByParent,
  );

  return (
    <div className="thread-branch">
      <ThreadLink
        thread={thread}
        onNavigate={onNavigate}
        secondaryLabel={projectLabel}
        onNewSession={onNewSession}
        subagentCount={children.length}
        subagentsExpanded={expanded}
        subagentsId={childrenId}
        onToggleSubagents={() => setExpanded((value) => !value)}
      />
      {((expanded && children.length > 0) || forkOperations.length > 0) && (
        <div className="thread-branch-children" id={childrenId}>
          {forkOperations.map((operation) => (
            <ForkOperationRow
              operation={operation}
              source={thread}
              key={operation.id}
              onNavigate={onNavigate}
            />
          ))}
          {expanded &&
            children.map((child) => (
              <ActiveThreadBranch
                onNewSession={onNewSession}
                thread={child}
                childrenByParent={childrenByParent}
                key={child.id}
                onNavigate={onNavigate}
                runningOrderByParent={runningOrderByParent}
              />
            ))}
        </div>
      )}
    </div>
  );
}

function ForkOperationRow({
  operation,
  source,
  onNavigate,
}: {
  operation: ForkOperationSummary;
  source: ThreadSummary;
  onNavigate(): void;
}) {
  const { api, dispatch } = useConnection();
  const { language, t } = useI18n();
  const [working, setWorking] = useState<"retry" | "remove" | null>(null);
  const title =
    operation.title.trim() ||
    t("Ответвление от {{title}}", {
      title: localizeKnownServerText(language, source.title) ?? source.title,
    });
  const status =
    operation.status === "preparing"
      ? t("Готовим ветку")
      : operation.status === "reconciling"
        ? t("Сверяем контекст")
        : t("Создание остановлено");

  async function retry() {
    if (working) return;
    setWorking("retry");
    try {
      const result = await api.retryForkOperation(operation);
      dispatch({ type: "forkOperation", operation: result.operation });
    } catch {
      // The terminal row remains available for another retry.
    } finally {
      setWorking(null);
    }
  }

  async function remove() {
    if (working) return;
    setWorking("remove");
    try {
      await api.removeForkOperation(operation.id);
      dispatch({ type: "forkOperation.remove", operationId: operation.id });
    } catch {
      // Keep the failed operation visible when the server rejects removal.
    } finally {
      setWorking(null);
    }
  }

  return (
    <div className={`fork-operation-row ${operation.status}`}>
      <NavLink
        className={({ isActive }) => `thread-link fork-operation-link ${isActive ? "active" : ""}`}
        to={`/fork-operations/${encodeURIComponent(operation.id)}`}
        state={{ forkOperation: operation, focusComposer: true }}
        onClick={onNavigate}
      >
        {operation.status === "failed" ? (
          <span className="fork-operation-failed" aria-hidden="true">
            !
          </span>
        ) : (
          <span className="spinner small" aria-hidden="true" />
        )}
        <span className="thread-link-copy">
          <span className="thread-link-title">{title}</span>
          <span className="thread-link-project">{status}</span>
        </span>
      </NavLink>
      {operation.status === "failed" && (
        <span className="fork-operation-actions">
          <button type="button" disabled={working !== null} onClick={() => void retry()}>
            {t("Повторить")}
          </button>
          <button type="button" disabled={working !== null} onClick={() => void remove()}>
            {t("Удалить")}
          </button>
        </span>
      )}
    </div>
  );
}

function ThreadLink({
  thread,
  onNavigate,
  secondaryLabel,
  onNewSession,
  subagentCount = 0,
  subagentsExpanded = false,
  subagentsId,
  onToggleSubagents,
}: {
  thread: ThreadSummary;
  onNavigate(): void;
  secondaryLabel?: string;
  onNewSession?(projectId: string): void;
  subagentCount?: number;
  subagentsExpanded?: boolean;
  subagentsId?: string;
  onToggleSubagents?(): void;
}) {
  const { api, dispatch, state } = useConnection();
  const { language, t } = useI18n();
  const location = useLocation();
  const titleRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDetailsElement>(null);
  const keyboardActionsRef = useRef(true);
  const [pinning, setPinning] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [finishConfirmationUpdatedAt, setFinishConfirmationUpdatedAt] = useState<number | null>(
    null,
  );
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  const title = localizeKnownServerText(language, thread.title) ?? thread.title;
  const target = `/threads/${encodeURIComponent(thread.id)}`;
  const agentName =
    thread.relation.kind === "subagent"
      ? thread.relation.nickname?.trim() || thread.relation.role?.trim() || null
      : null;
  const displayTitle = agentName ? `${agentName} · ${title}` : title;
  const canPin = thread.relation.kind === "session";
  const project = onNewSession
    ? state.snapshot?.projects.find((candidate) => candidate.id === thread.projectId)
    : undefined;
  const pinLabel = thread.pinned
    ? t("Открепить сессию «{{title}}»", { title: displayTitle })
    : t("Закрепить сессию «{{title}}»", { title: displayTitle });
  const canFinish =
    thread.relation.kind === "session" && thread.state === "completed" && thread.unread;
  const finishConfirmationArmed = finishConfirmationUpdatedAt === thread.updatedAt;
  const finishLabel = finishing
    ? t("Заканчиваем сессию «{{title}}»", { title: displayTitle })
    : finishConfirmationArmed
      ? t("Нажмите ещё раз, чтобы закончить сессию «{{title}}»", { title: displayTitle })
      : t("Закончить сессию «{{title}}»", { title: displayTitle });

  function resetFinishInteraction() {
    if (finishing) return;
    setFinishConfirmationUpdatedAt(null);
    setFinishError(null);
  }

  function closeActions(restoreFocus = false) {
    const menu = menuRef.current;
    if (!menu) return;
    menu.open = false;
    resetFinishInteraction();
    if (restoreFocus) menu.querySelector("summary")?.focus();
  }

  async function togglePin() {
    if (pinning) return;
    setPinning(true);
    setPinError(null);
    try {
      const updated = await api.updateThread(thread.id, { pinned: !thread.pinned });
      dispatch({ type: "thread", thread: updated });
      closeActions(menuRef.current?.contains(document.activeElement));
    } catch (caught) {
      setPinError(
        caught instanceof Error
          ? (localizeKnownServerText(language, caught.message) ?? caught.message)
          : t("Не удалось изменить закрепление сессии"),
      );
    } finally {
      setPinning(false);
    }
  }

  async function finishThreadFromSidebar() {
    if (finishing) return;
    setFinishError(null);
    if (!finishConfirmationArmed) {
      setFinishConfirmationUpdatedAt(thread.updatedAt);
      return;
    }

    setFinishConfirmationUpdatedAt(null);
    setFinishing(true);
    try {
      await api.markRead(thread.id, { observedUpdatedAt: thread.updatedAt });
      closeActions(menuRef.current?.contains(document.activeElement));
    } catch (caught) {
      setFinishError(
        caught instanceof Error
          ? localizeKnownServerText(language, caught.message)
          : t("Не удалось закончить сессию"),
      );
    } finally {
      setFinishing(false);
    }
  }

  const actionCount = Number(Boolean(project)) + Number(canPin) + Number(canFinish);
  const hasActions = actionCount > 0;
  const hasBrowserStatus =
    thread.browserStatus === "connected" || thread.browserStatus === "disconnected";
  const actions = (
    <>
      {project && (
        <button
          aria-label={t("Создать новую сессию в проекте {{project}}", {
            project: project.displayName,
          })}
          className="thread-row-action thread-create-action"
          onClick={() => {
            closeActions();
            onNewSession?.(project.id);
          }}
          title={t("Создать новую сессию в проекте {{project}}", { project: project.displayName })}
          type="button"
        >
          <PlusIcon />
        </button>
      )}
      {canPin && (
        <button
          aria-busy={pinning}
          aria-label={pinLabel}
          aria-pressed={thread.pinned}
          className={`thread-row-action thread-pin-action${thread.pinned ? " pinned" : ""}${pinError ? " failed" : ""}`}
          disabled={pinning}
          onClick={() => void togglePin()}
          title={pinError ?? pinLabel}
          type="button"
        >
          {pinning ? <span className="spinner small" /> : <PinIcon />}
        </button>
      )}
      {canFinish && (
        <button
          aria-busy={finishing}
          aria-label={finishLabel}
          className={`thread-row-action thread-finish-action${finishConfirmationArmed ? " confirming" : ""}${finishError ? " failed" : ""}`}
          disabled={finishing}
          onClick={() => void finishThreadFromSidebar()}
          title={finishError ?? finishLabel}
          type="button"
        >
          {finishing ? <span className="spinner small" /> : <CheckIcon />}
        </button>
      )}
    </>
  );

  return (
    <>
      <div
        className="thread-branch-row"
        style={{ "--thread-action-count": actionCount } as CSSProperties}
        onMouseEnter={() => prepareThreadTitleScroll(titleRef.current)}
        onPointerDownCapture={() => {
          keyboardActionsRef.current = false;
        }}
        onKeyDownCapture={() => {
          keyboardActionsRef.current = true;
        }}
        onMouseLeave={(event) => {
          if (window.matchMedia("(hover: none), (pointer: coarse)").matches) return;
          const focused = document.activeElement;
          if (keyboardActionsRef.current && event.currentTarget.contains(focused)) return;
          closeActions();
          keyboardActionsRef.current = true;
          if (focused instanceof HTMLElement && event.currentTarget.contains(focused))
            focused.blur();
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            // Safari can omit relatedTarget while moving focus between controls
            // during a pointer tap. The document click handler still closes the
            // menu for an actual outside tap, so do not remove the tapped button
            // before its click is delivered.
            if (!keyboardActionsRef.current) return;
            closeActions();
            keyboardActionsRef.current = true;
          }
        }}
      >
        <span className="thread-branch-spacer" />
        <NavLink
          className={({ isActive }) =>
            `thread-link${hasActions ? " has-actions" : ""}${canFinish ? " finishable" : ""}${isActive ? " active" : ""}`
          }
          end
          state={{ focusComposer: true }}
          to={target}
          onClick={(event) => {
            if (
              location.pathname === target &&
              !event.defaultPrevented &&
              event.button === 0 &&
              !event.metaKey &&
              !event.altKey &&
              !event.ctrlKey &&
              !event.shiftKey
            ) {
              onNavigate();
            }
          }}
        >
          {secondaryLabel ? (
            <span className="thread-link-copy">
              <span className="thread-link-title" ref={titleRef}>
                <span className="thread-link-title-text">{displayTitle}</span>
              </span>
              <span className="thread-link-project">{secondaryLabel}</span>
            </span>
          ) : (
            <span className="thread-link-title" ref={titleRef}>
              <span className="thread-link-title-text">{displayTitle}</span>
            </span>
          )}
          {(thread.pinned || hasBrowserStatus) && (
            <span className="thread-markers">
              <span className="thread-marker-slot">
                {thread.pinned && (
                  <span
                    className="thread-pinned-marker"
                    title={t("Сессия закреплена")}
                    aria-hidden="true"
                  >
                    <PinIcon />
                  </span>
                )}
              </span>
              <span className="thread-marker-slot">
                {hasBrowserStatus && (
                  <span
                    aria-hidden="true"
                    className={`thread-browser-status thread-browser-status-${thread.browserStatus}`}
                    title={
                      thread.browserStatus === "connected"
                        ? t("Браузер подключён")
                        : t("Браузер включён")
                    }
                  >
                    <BrowserIcon />
                  </span>
                )}
              </span>
            </span>
          )}
          <span className={threadStatusClasses(thread)} title={thread.state} />
        </NavLink>
        {subagentCount > 0 && (
          <button
            type="button"
            className="thread-subagent-count"
            aria-label={t(subagentsExpanded ? "Свернуть субагентов" : "Показать субагентов")}
            aria-expanded={subagentsExpanded}
            aria-controls={subagentsExpanded ? subagentsId : undefined}
            onClick={onToggleSubagents}
          >
            <TeamIcon /> {subagentCount}
          </button>
        )}
        {hasActions && (
          <details
            className="thread-row-menu"
            data-dismiss-on-outside-click
            ref={menuRef}
            onToggle={(event) => {
              if (!event.currentTarget.open) resetFinishInteraction();
              prepareThreadTitleScroll(titleRef.current);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              closeActions(true);
            }}
          >
            <summary
              className="thread-more-action"
              aria-label={t("Действия с сессией «{{title}}»", { title: displayTitle })}
              onClick={(event) => {
                event.preventDefault();
                const menu = menuRef.current;
                if (!menu) return;
                menu.open = true;
                menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
              }}
            >
              <MoreIcon />
            </summary>
            <div className="thread-row-actions">{actions}</div>
          </details>
        )}
        {finishError && (
          <span className="sr-only" role="alert">
            {finishError}
          </span>
        )}
      </div>
      {pinError && (
        <div className="thread-action-error" role="alert">
          {pinError}
        </div>
      )}
    </>
  );
}

function prepareThreadTitleScroll(element: HTMLSpanElement | null): void {
  const text = element?.querySelector<HTMLSpanElement>(".thread-link-title-text");
  if (!element || !text) return;

  // Measure the text itself: the clipping container's scrollWidth changes as it moves.
  const overflow = Math.max(0, text.scrollWidth - element.clientWidth);
  if (overflow <= 1) {
    element.removeAttribute("data-overflowing");
    element.style.removeProperty("--thread-title-scroll-distance");
    element.style.removeProperty("--thread-title-scroll-duration");
    return;
  }

  const duration = (overflow / THREAD_TITLE_SCROLL_PX_PER_SECOND) * 1_000;
  element.dataset.overflowing = "true";
  element.style.setProperty("--thread-title-scroll-distance", `${overflow}px`);
  element.style.setProperty("--thread-title-scroll-duration", `${duration}ms`);
}

function topLevelThreads(threads: ThreadSummary[]): ThreadSummary[] {
  return threads.filter((thread) => thread.relation.kind === "session");
}

function pinnedThreadsFirst(threads: ThreadSummary[]): ThreadSummary[] {
  return [
    ...threads.filter((thread) => thread.pinned),
    ...threads.filter((thread) => !thread.pinned),
  ];
}

function isActiveChildFeedEligible(thread: ThreadSummary): boolean {
  return (
    isActiveFeedEligible(thread) &&
    (thread.queuedMessageCount > 0 ||
      (thread.state !== "completed" && thread.state !== "failed" && thread.state !== "interrupted"))
  );
}

function sortActiveFeedThreads(
  threads: ThreadSummary[],
  childrenByParent: ReadonlyMap<string, ThreadSummary[]>,
  parentThreadId: string | null,
  runningOrderByParent: Map<string | null, string[]>,
): ThreadSummary[] {
  const sortedByActivity = sortThreadBranchesByActivity(threads, childrenByParent);
  const runningById = new Map(
    sortedByActivity
      .filter((thread) => thread.state === "running")
      .map((thread) => [thread.id, thread] as const),
  );
  const previousOrder = runningOrderByParent.get(parentThreadId) ?? [];
  const previousIds = new Set(previousOrder);
  const runningOrder = [
    ...sortedByActivity
      .filter((thread) => thread.state === "running" && !previousIds.has(thread.id))
      .map((thread) => thread.id),
    ...previousOrder.filter((threadId) => runningById.has(threadId)),
  ];

  if (runningOrder.length) runningOrderByParent.set(parentThreadId, runningOrder);
  else runningOrderByParent.delete(parentThreadId);

  return [
    ...runningOrder.map((threadId) => runningById.get(threadId)!),
    ...sortedByActivity.filter((thread) => thread.state !== "running"),
  ];
}

function sortThreadBranchesByActivity(
  threads: ThreadSummary[],
  childrenByParent: ReadonlyMap<string, ThreadSummary[]>,
): ThreadSummary[] {
  const recencyById = new Map<string, number>();
  const visiting = new Set<string>();
  const branchUpdatedAt = (thread: ThreadSummary): number => {
    const cached = recencyById.get(thread.id);
    if (cached !== undefined) return cached;
    if (visiting.has(thread.id)) return thread.updatedAt;
    visiting.add(thread.id);
    const updatedAt = Math.max(
      thread.updatedAt,
      ...(childrenByParent.get(thread.id) ?? []).map(branchUpdatedAt),
    );
    visiting.delete(thread.id);
    recencyById.set(thread.id, updatedAt);
    return updatedAt;
  };
  return [...threads].sort((a, b) => branchUpdatedAt(b) - branchUpdatedAt(a));
}

function childThreadsByParent(threads: ThreadSummary[]): Map<string, ThreadSummary[]> {
  const result = new Map<string, ThreadSummary[]>();
  for (const thread of threads) {
    if (thread.relation.kind !== "subagent") continue;
    const children = result.get(thread.relation.parentThreadId) ?? [];
    children.push(thread);
    result.set(thread.relation.parentThreadId, children);
  }
  return result;
}

function rateLimitsLabel(
  limits: CodexRateLimitsResponse | null,
  error: boolean,
  language: UiLanguage,
  t: Translate,
): string {
  if (!limits) return error ? t("Повторить лимиты") : t("Лимиты Codex");
  const windows = [limits.primary, limits.secondary]
    .filter((window): window is CodexRateLimitWindow => window !== null)
    .map((window) => formatRateLimitWindow(window, language, t));
  return windows.length ? windows.join(" · ") : t("Лимиты недоступны");
}

function formatRateLimitWindow(
  window: CodexRateLimitWindow,
  language: UiLanguage,
  t: Translate,
): string {
  const remaining = Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent)));
  const reset =
    window.resetsAt === null
      ? rateLimitDuration(window.windowDurationMins, t)
      : new Intl.DateTimeFormat(language === "ru" ? "ru-RU" : "en-US", {
          day: "2-digit",
          month: "2-digit",
        }).format(new Date(window.resetsAt));
  return `${reset} ${remaining}%`;
}

function rateLimitDuration(minutes: number | null, t: Translate): string {
  if (minutes === null) return t("Лимит");
  if (minutes >= 1_440 && minutes % 1_440 === 0) {
    return t("{{count}} д", { count: minutes / 1_440 });
  }
  if (minutes >= 60 && minutes % 60 === 0) {
    return t("{{count}} ч", { count: minutes / 60 });
  }
  return t("{{count}} мин", { count: minutes });
}

function rateLimitsAriaLabel(
  text: string,
  loading: boolean,
  error: boolean,
  updatedAt: number | null,
  language: UiLanguage,
  t: Translate,
): string {
  const action = loading
    ? t("Обновляем лимиты Codex")
    : error
      ? t("Повторить обновление лимитов Codex")
      : text === t("Лимиты Codex")
        ? t("Показать лимиты Codex")
        : t("Обновить лимиты Codex: {{text}}", { text });
  if (updatedAt === null) return action;
  const time = new Intl.DateTimeFormat(language === "ru" ? "ru-RU" : "en-US", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(updatedAt);
  return [
    action,
    t("Последнее обновление: {{time}}", { time }),
    error ? t("Не удалось обновить лимиты Codex") : null,
  ]
    .filter(Boolean)
    .join(". ");
}

function ConnectionDot({ state }: { state: "connecting" | "connected" | "offline" }) {
  return <span aria-hidden="true" className={`connection-dot ${state}`} />;
}

function networkLabel(state: "connecting" | "connected" | "offline", t: Translate): string {
  return state === "connected"
    ? t("Подключено")
    : state === "connecting"
      ? t("Подключение…")
      : t("Нет связи");
}

function appUpdateStatusTimestamp(status: AppUpdateStatus | null): number {
  if (!status) return 0;
  const timestamp = Date.parse(status.updatedAt ?? status.checkedAt ?? "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isRollingVersion(version: string | null): version is string {
  return version !== null && /^\d+\.\d+\.\d+-[0-9a-f]{7}$/.test(version);
}
