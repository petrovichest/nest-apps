import { Capacitor } from "@capacitor/core";

import type { AppSnapshot, ServerEvent, ThreadSummary, UiLanguage } from "@codexnest/protocol";

import { localizeKnownServerText, translate } from "./i18n";

export type BrowserNotificationPermission = NotificationPermission | "unsupported";

export function getBrowserNotificationPermission(): BrowserNotificationPermission {
  if (Capacitor.isNativePlatform() || typeof Notification === "undefined") {
    return "unsupported";
  }
  return Notification.permission;
}

export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationPermission> {
  if (getBrowserNotificationPermission() === "unsupported") return "unsupported";
  return Notification.requestPermission();
}

export class BrowserNotificationTracker {
  private readonly threadStates = new Map<string, string>();
  private readonly threadTitles = new Map<string, string>();
  private readonly notifiableThreadIds = new Set<string>();
  private readonly attentionThreads = new Map<string, string | null>();
  private serviceWorkerRegistration: Promise<ServiceWorkerRegistration> | null = null;
  private lastObservedAt = 0;

  constructor(private language: UiLanguage = "ru") {}

  setLanguage(language: UiLanguage): void {
    this.language = language;
  }

  acceptSnapshot(snapshot: AppSnapshot): void {
    this.language =
      snapshot.uiLanguage === "en" || snapshot.uiLanguage === "ru" ? snapshot.uiLanguage : "ru";
    const cutoff = this.lastObservedAt;
    const firstConnection = cutoff === 0;
    const previousThreadStates = new Map(this.threadStates);
    let newest = cutoff;
    this.threadStates.clear();
    this.threadTitles.clear();
    this.notifiableThreadIds.clear();
    this.attentionThreads.clear();
    const missedThreads: AppSnapshot["threads"] = [];
    const missedAttention = new Map<string, AppSnapshot["attention"][number]>();

    for (const thread of snapshot.threads) {
      this.threadStates.set(thread.id, notificationState(thread));
      this.threadTitles.set(thread.id, thread.title);
      if (isNotifiableThread(thread)) this.notifiableThreadIds.add(thread.id);
      newest = Math.max(newest, thread.updatedAt);
      if (
        !firstConnection &&
        this.notifiableThreadIds.has(thread.id) &&
        (thread.updatedAt > cutoff ||
          (thread.state === "needsAttention" && previousThreadStates.has(thread.id))) &&
        (thread.unread || thread.state === "needsAttention") &&
        (thread.state !== "needsAttention" ||
          previousThreadStates.get(thread.id) !== "needsAttention")
      ) {
        missedThreads.push(thread);
      }
    }

    for (const attention of snapshot.attention) {
      this.attentionThreads.set(attention.id, attention.threadId);
      newest = Math.max(newest, attention.createdAt);
      if (
        !firstConnection &&
        attention.threadId !== null &&
        this.notifiableThreadIds.has(attention.threadId) &&
        attention.createdAt > cutoff &&
        previousThreadStates.get(attention.threadId) !== "needsAttention"
      ) {
        missedAttention.set(attention.threadId, attention);
      }
    }
    for (const thread of missedThreads) {
      this.showThreadState(thread);
    }
    for (const attention of missedAttention.values()) {
      this.show(
        translate(this.language, "Codex ждёт решения"),
        this.titleFor(attention.threadId),
        `attention:${attention.id}`,
        attention.threadId,
      );
    }
    this.lastObservedAt = newest;
  }

  acceptEvent(event: ServerEvent): void {
    if (event.type === "uiLanguage.changed") {
      this.language = event.language;
    } else if (event.type === "thread.upserted") {
      const previous = this.threadStates.get(event.thread.id);
      const state = notificationState(event.thread);
      this.threadStates.set(event.thread.id, state);
      this.threadTitles.set(event.thread.id, event.thread.title);
      if (isNotifiableThread(event.thread)) {
        this.notifiableThreadIds.add(event.thread.id);
      } else {
        this.notifiableThreadIds.delete(event.thread.id);
      }
      if (previous !== state) {
        this.showThreadState(event.thread);
      }
      this.lastObservedAt = Math.max(this.lastObservedAt, event.thread.updatedAt);
    } else if (event.type === "thread.removed") {
      this.threadStates.delete(event.threadId);
      this.threadTitles.delete(event.threadId);
      this.notifiableThreadIds.delete(event.threadId);
    } else if (event.type === "attention.upserted") {
      if (!this.attentionThreads.has(event.attention.id)) {
        this.attentionThreads.set(event.attention.id, event.attention.threadId);
        if (
          event.attention.threadId !== null &&
          this.notifiableThreadIds.has(event.attention.threadId) &&
          this.threadStates.get(event.attention.threadId) !== "needsAttention"
        ) {
          this.show(
            translate(this.language, "Codex ждёт решения"),
            this.titleFor(event.attention.threadId),
            `attention:${event.attention.id}`,
            event.attention.threadId,
          );
        }
      }
      this.lastObservedAt = Math.max(this.lastObservedAt, event.attention.createdAt);
    } else if (event.type === "attention.removed") {
      this.attentionThreads.delete(event.attentionId);
    }
  }

  private showThreadState(thread: ThreadSummary): void {
    const { id: threadId, title: threadTitle } = thread;
    const state = notificationState(thread);
    if (!this.notifiableThreadIds.has(threadId)) return;
    if (state === "completed") {
      this.show(
        translate(this.language, "Задача завершена"),
        this.displayThreadTitle(threadTitle),
        `completed:${threadId}`,
        threadId,
      );
    } else if (state === "failed") {
      this.show(
        translate(this.language, "Задача завершилась с ошибкой"),
        this.displayThreadTitle(threadTitle),
        `failed:${threadId}`,
        threadId,
      );
    } else if (state === "needsAttention" && !this.hasAttentionForThread(threadId)) {
      this.show(
        translate(this.language, "Codex ждёт решения"),
        this.displayThreadTitle(threadTitle),
        `needs-attention:${threadId}`,
        threadId,
      );
    }
  }

  private hasAttentionForThread(threadId: string): boolean {
    return [...this.attentionThreads.values()].includes(threadId);
  }

  private titleFor(threadId: string | null): string {
    if (!threadId) return translate(this.language, "Откройте CodexNest для подробностей");
    const title = this.threadTitles.get(threadId);
    return title ? this.displayThreadTitle(title) : translate(this.language, "Задача Codex");
  }

  private displayThreadTitle(title: string): string {
    return localizeKnownServerText(this.language, title) ?? title;
  }

  private show(title: string, body: string, tag: string, threadId: string | null): void {
    if (
      getBrowserNotificationPermission() !== "granted" ||
      document.visibilityState === "visible"
    ) {
      return;
    }
    void this.showSystemNotification(title, body, tag, threadId).catch(() => {
      // Permission and browser support can change while the page is open.
    });
  }

  private async showSystemNotification(
    title: string,
    body: string,
    tag: string,
    threadId: string | null,
  ): Promise<void> {
    if ("serviceWorker" in navigator) {
      try {
        this.serviceWorkerRegistration ??=
          navigator.serviceWorker.register("/notification-worker.js");
        const registration = await this.serviceWorkerRegistration;
        await registration.showNotification(title, { body, tag, data: { threadId } });
        return;
      } catch {
        this.serviceWorkerRegistration = null;
      }
    }

    const notification = new Notification(title, { body, tag });
    notification.onclick = () => {
      notification.close();
      window.focus();
      if (!threadId) return;
      window.history.pushState(null, "", `/threads/${encodeURIComponent(threadId)}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    };
  }
}

function isNotifiableThread(thread: ThreadSummary): boolean {
  const worker = thread.workerSession;
  // Older servers only expose the parent thread for delegated workers.
  return (
    thread.relation.kind === "session" && worker?.delegated !== true && !worker?.parentThreadId
  );
}

function notificationState(thread: ThreadSummary): ThreadSummary["state"] {
  return (thread.state === "completed" || thread.state === "failed") &&
    (thread.currentTurnId || thread.capacityRetry || thread.queuedMessageCount > 0)
    ? "running"
    : thread.state;
}
