import { DebuggerController } from "./cdp";
import { streamNetworkCapture, streamNetworkCaptureDrop } from "./network-stream";
import {
  BROWSER_PROTOCOL,
  BROWSER_PROTOCOL_VERSION,
  BROWSER_TOOLS,
  MAX_PROJECT_FILE_BYTES,
  browserToolResultFrames,
  browserWebSocketUrl,
  isRecord,
  isServerFrame,
  normaliseBaseUrl,
  type BindingSummary,
  type BrowserTabSummary,
  type ClientFrame,
  type ConnectionStatus,
  type ProjectSummary,
  type SessionTarget,
  type ServerFrame,
  type ThreadSummary,
  type UiLanguage,
} from "./protocol";
import { appName } from "./brand";
import { ExtensionStore, type ExtensionSettings, type PersistedState } from "./storage";
import { BrowserToolDispatcher, BrowserToolError } from "./tools";
import { browserDisplayName, webext } from "./webext";

const RECONNECT_DELAYS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const;
const HEARTBEAT_INTERVAL_MS = 20_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const SESSION_REQUEST_TIMEOUT_MS = 30_000;
const RECONCILE_ALARM = "codexnest.reconcile";

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

type PopupRequest = { windowId: number } & (
  | { type: "popup.state" }
  | { type: "popup.configure"; baseUrl: string; token: string }
  | { type: "popup.reset" }
  | { type: "popup.createAttach"; target: SessionTarget; tabId: number }
  | { type: "popup.detach"; threadId: string }
  | { type: "popup.open"; threadId: string }
);

interface PendingSessionRequest {
  resolve: (result: { action: "created" | "attached"; thread: ThreadSummary }) => void;
  reject: (reason: Error) => void;
  timeout: number;
}

const store = new ExtensionStore(webext.storage.local);
let persisted: PersistedState;
let connectionStatus: ConnectionStatus = "pending";
let connectionError: string | null = null;
let projects: ProjectSummary[] = [];
let threads: ThreadSummary[] = [];
let socket: WebSocket | null = null;
let socketGeneration = 0;
let reconnectAttempt = 0;
let reconnectTimer: number | undefined;
let heartbeatTimer: number | undefined;
let heartbeatDeadline: number | undefined;
let helloAccepted = false;
let intentionalClose = false;
let reconcileTimer: number | undefined;
const pendingSessions = new Map<string, PendingSessionRequest>();
const readyBindingThreadIds = new Set<string>();
const debuggerController = new DebuggerController(
  (tabId) => invalidateRefs(tabId),
  (capture) => streamNetworkCapture(capture, sendPendingFrame),
  (tabId) =>
    Object.values(persisted?.bindings ?? {}).find((binding) => binding.tabIds.includes(tabId))
      ?.threadId ?? null,
  (capture) => streamNetworkCaptureDrop(capture, sendPendingFrame),
);
const dispatcher = new BrowserToolDispatcher(
  debuggerController,
  async () => (await store.load()).bindings,
  addTabToBinding,
  invalidateRefs,
  (transferId) => send({ type: "file.request", transferId }),
);

const ready = initialise();

webext.runtime.onInstalled.addListener(() => void wake());
webext.runtime.onStartup.addListener(() => void wake());
webext.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONCILE_ALARM) void wake();
});
webext.tabs.onRemoved.addListener((tabId) => void onTabRemoved(tabId));
webext.tabs.onActivated.addListener(() => void broadcastState());
webext.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status === "loading" || typeof change.url === "string") invalidateRefs(tabId);
  if ("groupId" in change) scheduleReconcile();
  if (tab.active && (typeof change.url === "string" || typeof change.title === "string"))
    void broadcastState();
});
webext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isPopupRequest(message)) return;
  const operation = ready
    .then(() => handlePopupRequest(message))
    .then((result) => ({ ok: true, result }))
    .catch((error) => ({ ok: false, error: errorMessage(error) }));
  void operation.then(sendResponse);
  return true;
});

async function initialise(): Promise<void> {
  persisted = await store.load();
  await reconcileBindings();
  await webext.alarms.create(RECONCILE_ALARM, { periodInMinutes: 1 });
  if (persisted.settings) connect(persisted.settings);
  else await setConnectionState("pending", null);
}

async function wake(): Promise<void> {
  await ready;
  persisted = await store.load();
  await reconcileBindings();
  if (persisted.settings && (!socket || socket.readyState === WebSocket.CLOSED))
    connect(persisted.settings);
}

async function handlePopupRequest(request: PopupRequest): Promise<unknown> {
  switch (request.type) {
    case "popup.state":
      return popupSnapshot(request.windowId);
    case "popup.configure": {
      const settings = validateSettings(request.baseUrl, request.token);
      persisted = await store.update((draft) => {
        draft.settings = settings;
      });
      reconnectAttempt = 0;
      connect(settings);
      return popupSnapshot(request.windowId);
    }
    case "popup.reset":
      closeSocket(true);
      projects = [];
      threads = [];
      persisted = await store.update((draft) => {
        draft.settings = null;
      });
      await setConnectionState("pending", null);
      return popupSnapshot(request.windowId);
    case "popup.createAttach":
      await createOrAttach(request.tabId, request.target);
      return popupSnapshot(request.windowId);
    case "popup.detach":
      await detachBinding(request.threadId);
      return popupSnapshot(request.windowId);
    case "popup.open":
      await openInCodexNest(request.threadId);
      return undefined;
  }
}

function connect(settings: ExtensionSettings): void {
  closeSocket(false);
  const generation = ++socketGeneration;
  intentionalClose = false;
  helloAccepted = false;
  void setConnectionState(reconnectAttempt === 0 ? "connecting" : "reconnecting", null);
  let candidate: WebSocket;
  try {
    candidate = new WebSocket(browserWebSocketUrl(settings.baseUrl));
  } catch (error) {
    void failAndReconnect(generation, errorMessage(error));
    return;
  }
  socket = candidate;
  candidate.addEventListener("open", () => {
    if (generation !== socketGeneration || socket !== candidate) return;
    void sendHello(settings);
  });
  candidate.addEventListener("message", (event) => {
    if (generation !== socketGeneration || socket !== candidate) return;
    acceptMessage(generation, event.data);
  });
  candidate.addEventListener("close", (event) => {
    if (generation !== socketGeneration || socket !== candidate) return;
    socket = null;
    clearHeartbeat();
    dispatcher.transfers.clear();
    if (intentionalClose) return;
    if (event.code === 1008 || event.code === 1002) {
      void setConnectionState(
        "error",
        event.reason || `${appName} rejected the browser connection`,
      );
      return;
    }
    void scheduleReconnect(generation, event.reason || "Connection closed");
  });
  candidate.addEventListener("error", () => {
    if (generation === socketGeneration && socket === candidate)
      connectionError = `Unable to reach ${appName}`;
  });
}

async function sendHello(settings: ExtensionSettings): Promise<void> {
  persisted = await store.load();
  send({
    type: "client.hello",
    protocol: BROWSER_PROTOCOL,
    version: BROWSER_PROTOCOL_VERSION,
    token: settings.token,
    instanceId: persisted.instanceId,
    extensionVersion: webext.runtime.getManifest().version,
    browser: { name: "chrome", version: browserVersion() },
    capabilities: {
      tools: BROWSER_TOOLS,
      maxProjectFileBytes: MAX_PROJECT_FILE_BYTES,
      screenshots: ["image/jpeg", "image/png"],
    },
    bindings: Object.values(persisted.bindings).filter((binding) =>
      readyBindingThreadIds.has(binding.threadId),
    ),
  });
}

function acceptMessage(generation: number, data: unknown): void {
  let frame: unknown;
  try {
    frame = JSON.parse(String(data));
  } catch {
    socket?.close(1002, "Malformed JSON frame");
    return;
  }
  if (!isServerFrame(frame)) {
    socket?.close(1002, "Invalid browser protocol frame");
    return;
  }
  if (!helloAccepted && frame.type !== "server.hello" && frame.type !== "protocol.error") {
    socket?.close(1002, "Expected server.hello");
    return;
  }
  if (frame.type === "server.hello") {
    helloAccepted = true;
    reconnectAttempt = 0;
    projects = frame.projects;
    threads = frame.threads;
    void store
      .update((draft) => {
        draft.locale = frame.locale;
      })
      .then((state) => {
        persisted = state;
        return setConnectionState("connected", null);
      });
    scheduleHeartbeat(generation);
    return;
  }
  if (frame.type === "protocol.error") {
    void setConnectionState("error", frame.message);
    intentionalClose = true;
    socket?.close(1002, frame.code);
    return;
  }
  noteSocketActivity(generation);
  routeServerFrame(frame);
}

function routeServerFrame(frame: ServerFrame): void {
  if (frame.type === "server.ping") {
    trySend({ type: "client.pong", at: frame.at });
    return;
  }
  if (frame.type === "server.pong") return;
  if (frame.type === "catalog.updated") {
    projects = frame.projects;
    threads = frame.threads;
    void broadcastState();
    return;
  }
  if (frame.type === "binding.detach") {
    void detachBinding(frame.threadId, false);
    return;
  }
  if (frame.type === "session.result") {
    const pending = pendingSessions.get(frame.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingSessions.delete(frame.requestId);
    pending.resolve({ action: frame.action, thread: frame.thread });
    return;
  }
  if (frame.type === "session.error") {
    const pending = pendingSessions.get(frame.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingSessions.delete(frame.requestId);
    pending.reject(new BrowserToolError(frame.error.code, frame.error.message));
    return;
  }
  if (frame.type === "file.transfer") {
    dispatcher.transfers.accept(frame);
    return;
  }
  if (frame.type === "file.error") {
    dispatcher.transfers.acceptError(frame.transferId, frame.error);
    return;
  }
  if (frame.type === "tool.call") {
    void dispatcher
      .dispatch({ threadId: frame.threadId, tool: frame.tool, arguments: frame.arguments })
      .then((result) => {
        for (const response of browserToolResultFrames(frame.requestId, result)) {
          if (!trySend(response)) break;
        }
      })
      .catch((error) => {
        const toolError =
          error instanceof BrowserToolError
            ? error
            : new BrowserToolError("browser_error", errorMessage(error));
        trySend({
          type: "tool.error",
          requestId: frame.requestId,
          error: { code: toolError.code, message: toolError.message.slice(0, 8_192) },
        });
      });
  }
}

async function createOrAttach(tabId: number, target: SessionTarget): Promise<void> {
  if (connectionStatus !== "connected") throw new Error(`${appName} is not connected yet`);
  if (target.kind === "new" && !projects.some((project) => project.id === target.projectId)) {
    throw new Error("Select an available project");
  }
  if (target.kind === "existing" && !threads.some((thread) => thread.id === target.threadId)) {
    throw new Error("Select an available session");
  }
  const tab = await webext.tabs.get(tabId);
  if (!isAccessibleTab(tab))
    throw new Error(`${browserDisplayName} does not allow extensions to control this page`);
  const current = await store.load();
  const owner = Object.values(current.bindings).find((binding) => binding.tabIds.includes(tabId));
  if (owner) throw new Error(`This tab already belongs to “${owner.title}”`);
  const summary = tabSummary(tab);
  if (!summary) throw new Error("The active tab is unavailable");
  const session = await requestSession(target, summary);
  const existing = current.bindings[session.thread.id];
  let groupId: number;
  if (existing) {
    const anchor = await firstLiveTab(existing.tabIds);
    if (!anchor || anchor.windowId !== tab.windowId)
      throw new Error("This session already has a tab group in another window");
    groupId = await webext.tabs.group({ tabIds: tabId, groupId: existing.groupId });
  } else {
    groupId = await webext.tabs.group({
      tabIds: tabId,
      createProperties: { windowId: tab.windowId },
    });
  }
  await decorateGroup(groupId, session.thread.title);
  const now = Date.now();
  const binding: BindingSummary = existing
    ? {
        ...existing,
        title: session.thread.title,
        tabIds: [...new Set([...existing.tabIds, tabId])],
        groupId,
        updatedAt: now,
      }
    : {
        threadId: session.thread.id,
        projectId: session.thread.projectId,
        title: session.thread.title,
        groupId,
        tabIds: [tabId],
        createdAt: now,
        updatedAt: now,
      };
  persisted = await store.update((draft) => {
    draft.bindings[binding.threadId] = binding;
  });
  dispatcher.activateThread(binding.threadId);
  trySend({ type: "binding.updated", binding });
  await dispatcher.attachTab(binding.threadId, tabId).catch(async (error) => {
    await detachBinding(binding.threadId);
    throw error;
  });
  readyBindingThreadIds.add(binding.threadId);
  await broadcastState();
}

function requestSession(
  target: SessionTarget,
  tab: BrowserTabSummary,
): Promise<{ action: "created" | "attached"; thread: ThreadSummary }> {
  const requestId = crypto.randomUUID();
  const promise = new Promise<{ action: "created" | "attached"; thread: ThreadSummary }>(
    (resolve, reject) => {
      const timeout = globalThis.setTimeout(() => {
        pendingSessions.delete(requestId);
        reject(new Error(`${appName} did not create or attach the browser session in time`));
      }, SESSION_REQUEST_TIMEOUT_MS);
      pendingSessions.set(requestId, { resolve, reject, timeout });
    },
  );
  send({ type: "session.request", requestId, target, tab });
  return promise;
}

async function detachBinding(threadId: string, notifyServer = true): Promise<void> {
  const current = await store.load();
  const binding = current.bindings[threadId];
  if (!binding) return;
  const live: number[] = [];
  for (const tabId of binding.tabIds) {
    const tab = await webext.tabs.get(tabId).catch(() => null);
    if (tab) live.push(tabId);
  }
  if (live.length) await webext.tabs.ungroup(live).catch(() => undefined);
  await dispatcher.releaseThread(threadId);
  readyBindingThreadIds.delete(threadId);
  persisted = await store.update((draft) => {
    delete draft.bindings[threadId];
  });
  if (notifyServer) trySend({ type: "binding.detached", binding });
  await broadcastState();
}

async function openInCodexNest(threadId: string): Promise<void> {
  const current = await store.load();
  if (!current.settings) throw new Error(`${appName} setup is incomplete`);
  const url = new URL(
    `/threads/${encodeURIComponent(threadId)}`,
    `${current.settings.baseUrl}/`,
  ).toString();
  await webext.tabs.create({ url, active: true });
}

async function addTabToBinding(threadId: string, tabId: number, groupId: number): Promise<void> {
  let updated: BindingSummary | undefined;
  persisted = await store.update((draft) => {
    const binding = draft.bindings[threadId];
    if (!binding) throw new Error("Browser session is detached");
    binding.tabIds = [...new Set([...binding.tabIds, tabId])];
    binding.groupId = groupId;
    binding.updatedAt = Date.now();
    updated = { ...binding };
  });
  if (updated) trySend({ type: "binding.updated", binding: updated });
  await broadcastState();
}

async function onTabRemoved(tabId: number): Promise<void> {
  await ready;
  const detached: BindingSummary[] = [];
  const updated: BindingSummary[] = [];
  persisted = await store.update((draft) => {
    for (const binding of Object.values(draft.bindings)) {
      if (!binding.tabIds.includes(tabId)) continue;
      binding.tabIds = binding.tabIds.filter((candidate) => candidate !== tabId);
      binding.updatedAt = Date.now();
      if (binding.tabIds.length === 0) {
        delete draft.bindings[binding.threadId];
        detached.push(binding);
      } else {
        updated.push(binding);
      }
    }
  });
  dispatcher.forgetTab(tabId);
  await Promise.all(detached.map((binding) => dispatcher.releaseThread(binding.threadId)));
  for (const binding of detached) readyBindingThreadIds.delete(binding.threadId);
  for (const binding of detached) trySend({ type: "binding.detached", binding });
  for (const binding of updated) trySend({ type: "binding.updated", binding });
  await broadcastState();
}

async function reconcileBindings(): Promise<void> {
  const current = await store.load();
  const allTabs = await webext.tabs.query({});
  const byId = new Map(
    allTabs.flatMap((tab) => (tab.id === undefined ? [] : [[tab.id, tab] as const])),
  );
  const owned = new Set<number>();
  const repaired: Record<string, BindingSummary> = {};
  for (const binding of Object.values(current.bindings).sort((a, b) => a.createdAt - b.createdAt)) {
    let tabs = binding.tabIds.flatMap((tabId) => {
      const tab = byId.get(tabId);
      return tab && !owned.has(tabId) ? [tab] : [];
    });
    if (!tabs.length) continue;
    const windowId = tabs[0]!.windowId;
    tabs = tabs.filter((tab) => tab.windowId === windowId);
    if (!tabs.length) continue;
    let groupId = tabs.find((tab) => tab.groupId >= 0)?.groupId ?? -1;
    try {
      groupId =
        groupId >= 0
          ? await webext.tabs.group({ tabIds: tabs.map((tab) => tab.id!), groupId })
          : await webext.tabs.group({
              tabIds: tabs.map((tab) => tab.id!),
              createProperties: { windowId },
            });
      await decorateGroup(groupId, binding.title);
    } catch {
      continue;
    }
    const groupTabs = allTabs.filter(
      (tab) => tab.groupId === groupId && tab.id !== undefined && !owned.has(tab.id),
    );
    const tabIds = [...new Set([...tabs, ...groupTabs].map((tab) => tab.id!))];
    for (const tabId of tabIds) owned.add(tabId);
    repaired[binding.threadId] = { ...binding, groupId, tabIds };
  }
  persisted = await store.update((draft) => {
    draft.bindings = repaired;
  });
  const previouslyReady = new Set(readyBindingThreadIds);
  readyBindingThreadIds.clear();
  for (const binding of Object.values(repaired)) dispatcher.activateThread(binding.threadId);
  await Promise.all(
    Object.values(repaired).map(async (binding) => {
      const attached = await Promise.all(
        binding.tabIds.map((tabId) =>
          dispatcher
            .attachTab(binding.threadId, tabId)
            .then(() => true)
            .catch(() => false),
        ),
      );
      if (attached.every(Boolean)) readyBindingThreadIds.add(binding.threadId);
    }),
  );
  if (connectionStatus === "connected") {
    for (const oldBinding of Object.values(current.bindings)) {
      if (!repaired[oldBinding.threadId])
        trySend({ type: "binding.detached", binding: oldBinding });
    }
    for (const binding of Object.values(repaired)) {
      if (readyBindingThreadIds.has(binding.threadId)) {
        trySend({ type: "binding.updated", binding });
      }
    }
    if (
      [...previouslyReady].some(
        (threadId) => repaired[threadId] && !readyBindingThreadIds.has(threadId),
      )
    ) {
      socket?.close(4000, "Browser debugger unavailable");
    }
  }
  await broadcastState();
}

function scheduleReconcile(): void {
  if (reconcileTimer !== undefined) clearTimeout(reconcileTimer);
  reconcileTimer = globalThis.setTimeout(() => {
    reconcileTimer = undefined;
    void reconcileBindings();
  }, 250);
}

function invalidateRefs(tabId: number): void {
  void webext.tabs
    .sendMessage(
      tabId,
      { type: "codexnest.content", action: "invalidate_refs", arguments: {} },
      { frameId: 0 },
    )
    .catch(() => undefined);
}

async function popupSnapshot(windowId: number): Promise<PopupSnapshot> {
  persisted = await store.load();
  const activeTab =
    (await webext.tabs.query({ active: true, windowId })).map(tabSummary).find(Boolean) ?? null;
  const bindings = Object.values(persisted.bindings).sort((a, b) => b.updatedAt - a.updatedAt);
  const activeBinding = activeTab
    ? (bindings.find((binding) => binding.tabIds.includes(activeTab.id)) ?? null)
    : null;
  return {
    configured: persisted.settings !== null,
    locale: persisted.locale,
    status: connectionStatus,
    error: connectionError,
    projects,
    threads,
    activeTab,
    activeBinding,
    bindings,
  };
}

async function setConnectionState(status: ConnectionStatus, error: string | null): Promise<void> {
  connectionStatus = status;
  connectionError = error;
  const badge = {
    pending: { text: "…", color: "#8a8d86" },
    connecting: { text: "↻", color: "#7b61b8" },
    connected: { text: "●", color: "#2b9a50" },
    reconnecting: { text: "↻", color: "#b0781d" },
    error: { text: "!", color: "#c53b43" },
  }[status];
  await Promise.all([
    webext.action.setBadgeText({ text: badge.text }),
    webext.action.setBadgeBackgroundColor({ color: badge.color }),
    webext.action.setTitle({ title: `${appName} Browser — ${status}` }),
  ]).catch(() => undefined);
  await broadcastState();
}

async function broadcastState(): Promise<void> {
  await webext.runtime.sendMessage({ type: "background.stateChanged" }).catch(() => undefined);
}

function scheduleHeartbeat(generation: number): void {
  clearHeartbeat();
  heartbeatTimer = globalThis.setTimeout(() => {
    if (generation !== socketGeneration || socket?.readyState !== WebSocket.OPEN) return;
    send({ type: "client.ping", at: Date.now() });
    heartbeatDeadline = globalThis.setTimeout(() => {
      if (generation === socketGeneration) socket?.close(4000, "Heartbeat timeout");
    }, HEARTBEAT_TIMEOUT_MS);
  }, HEARTBEAT_INTERVAL_MS);
}

function noteSocketActivity(generation: number): void {
  if (heartbeatDeadline !== undefined) clearTimeout(heartbeatDeadline);
  heartbeatDeadline = undefined;
  scheduleHeartbeat(generation);
}

function clearHeartbeat(): void {
  if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer);
  if (heartbeatDeadline !== undefined) clearTimeout(heartbeatDeadline);
  heartbeatTimer = undefined;
  heartbeatDeadline = undefined;
}

async function scheduleReconnect(generation: number, reason: string): Promise<void> {
  if (generation !== socketGeneration || intentionalClose) return;
  await setConnectionState("reconnecting", reason);
  const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)]!;
  reconnectAttempt += 1;
  if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
  reconnectTimer = globalThis.setTimeout(() => {
    reconnectTimer = undefined;
    if (generation !== socketGeneration || !persisted.settings) return;
    connect(persisted.settings);
  }, delay);
}

async function failAndReconnect(generation: number, reason: string): Promise<void> {
  socket = null;
  await scheduleReconnect(generation, reason);
}

function closeSocket(intentional: boolean): void {
  intentionalClose = intentional;
  socketGeneration += 1;
  clearHeartbeat();
  if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  const current = socket;
  socket = null;
  current?.close(1000, "Reconnecting");
  for (const [requestId, pending] of pendingSessions) {
    clearTimeout(pending.timeout);
    pending.reject(new Error("Browser connection closed"));
    pendingSessions.delete(requestId);
  }
  dispatcher.transfers.clear();
}

function sendPendingFrame(frame: ClientFrame): void {
  if (!socket || socket.readyState !== WebSocket.OPEN || !helloAccepted) {
    throw new Error(`${appName} browser connection is not open`);
  }
  socket.send(JSON.stringify(frame));
}

function send(frame: ClientFrame): void {
  if (!socket || socket.readyState !== WebSocket.OPEN)
    throw new Error(`${appName} browser connection is not open`);
  socket.send(JSON.stringify(frame));
}

function trySend(frame: ClientFrame): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN || !helloAccepted) return false;
  socket.send(JSON.stringify(frame));
  return true;
}

function validateSettings(baseUrl: string, token: string): ExtensionSettings {
  const normalised = normaliseBaseUrl(baseUrl);
  const ownerToken = token.trim();
  if (!ownerToken) throw new Error("Owner token is required");
  return { baseUrl: normalised, token: ownerToken };
}

function isPopupRequest(value: unknown): value is PopupRequest {
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    value.type.startsWith("popup.") &&
    typeof value.windowId === "number" &&
    Number.isInteger(value.windowId) &&
    value.windowId >= 0
  );
}

function tabSummary(tab: ChromeTab): BrowserTabSummary | null {
  if (tab.id === undefined) return null;
  return {
    id: tab.id,
    windowId: tab.windowId,
    groupId: tab.groupId,
    active: tab.active,
    title: tab.title ?? "",
    url: tab.url ?? tab.pendingUrl ?? "",
  };
}

function isAccessibleTab(tab: ChromeTab): boolean {
  const url = tab.url ?? tab.pendingUrl ?? "";
  return !/^(chrome|chrome-extension|moz-extension|devtools|edge|about):/i.test(url);
}

async function firstLiveTab(tabIds: number[]): Promise<ChromeTab | null> {
  for (const tabId of tabIds) {
    const tab = await webext.tabs.get(tabId).catch(() => null);
    if (tab) return tab;
  }
  return null;
}

async function decorateGroup(groupId: number, title: string): Promise<void> {
  await webext.tabGroups.update(groupId, {
    title: `${appName} · ${title || "Browser session"}`.slice(0, 80),
    color: "purple",
    collapsed: false,
  });
}

function browserVersion(): string {
  return /Chrome\/(\d+(?:\.\d+)*)/.exec(navigator.userAgent)?.[1] ?? "unknown";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
