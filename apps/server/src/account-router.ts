import type { ParsedClaudeProxy } from "@codexnest/protocol";
import type { CodexBridge } from "./codex/bridge";
import type { ServerNotification, ServerRequest } from "./codex/generated/index";
import type { JsonlTransport } from "./codex/transport";
import {
  AccountRuntimeError,
  type AccountRuntimePool,
  type AccountRuntimeDescriptor,
} from "./account-runtime";

export type AccountRoutingState = {
  threadOwners: Record<string, string>;
  legacyAccountId: string | null;
};
export type RoutedAccount = {
  id: string;
  home: string;
  native: boolean;
  proxy: ParsedClaudeProxy | null;
};
type Options = {
  state: AccountRoutingState;
  selected(): RoutedAccount | null;
  save(): Promise<void>;
  observe(descriptor: AccountRuntimeDescriptor, notification: ServerNotification): void;
  userWork(): void;
  account(id: string): RoutedAccount | null;
  beforeStart(id: string): void;
  workAllowed?(): boolean;
};
const LEGACY = "native";

/** Conversation ownership is local and persisted. Ordinary turns add no routing RPC. */
export class CodexAccountRouter {
  private migrations = new Map<string, Promise<CodexBridge>>();
  private pendingSave: Promise<void> = Promise.resolve();
  private closed = false;
  private ephemeral = new Set<string>();
  constructor(
    private readonly bridge: CodexBridge,
    readonly pool: AccountRuntimePool,
    private readonly options: Options,
  ) {
    bridge.setRequestRouter((method, params, timeout) => this.request(method, params, timeout));
    bridge.setNativeNotificationFilter((notice) => {
      if (notice.method.startsWith("account/")) return false;
      const id =
        notice.method === "thread/started"
          ? notice.params.thread.id
          : "threadId" in notice.params
            ? notice.params.threadId
            : undefined;
      const owner = typeof id === "string" ? options.state.threadOwners[id] : undefined;
      return !owner || owner === LEGACY;
    });
    bridge.on("nativeNotification", this.nativeNotification);
    pool.on("notification", this.notification);
    pool.on("request", this.serverRequest);
  }
  owner(threadId: string): string | null {
    const owner = this.options.state.threadOwners[threadId];
    return owner === LEGACY
      ? this.options.state.legacyAccountId
      : owner
        ? this.pool.descriptor(owner).accountId
        : null;
  }
  async selected(): Promise<{ descriptor: AccountRuntimeDescriptor; bridge: CodexBridge } | null> {
    const profile = this.options.selected();
    return profile ? this.pool.ensure(profile) : null;
  }
  async move(threadId: string, account: RoutedAccount): Promise<void> {
    await this.migrate(threadId, account);
  }
  async replaceAccountConnection(account: RoutedAccount): Promise<void> {
    if (
      account.id === this.options.state.legacyAccountId &&
      Object.entries(this.options.state.threadOwners).some(
        ([id, owner]) => owner === LEGACY && this.bridge.threadActive(id),
      )
    )
      throw new AccountRuntimeError(
        "Wait for this account's active responses before changing its connection",
      );
    const descriptors = this.pool
      .descriptors()
      .filter(
        (descriptor) =>
          !descriptor.retired &&
          descriptor.accountId === account.id &&
          !this.pool.matches(descriptor, account),
      );
    if (!descriptors.length) return;
    // Connect before checking activity: a surviving daemon may still be working after an API restart.
    for (const descriptor of descriptors) {
      const client = await this.pool.connect(descriptor.id);
      const loaded = await client.request<{ data: string[] }>("thread/loaded/list", { limit: 100 });
      for (const threadId of loaded.data) {
        const { thread } = await client.request<any>("thread/read", {
          threadId,
          includeTurns: false,
        });
        if (thread.status?.type === "active")
          throw new AccountRuntimeError(
            "Wait for this account's active responses before changing its connection",
          );
      }
      if (this.pool.active(descriptor.id))
        throw new AccountRuntimeError(
          "Wait for this account's active responses before changing its connection",
        );
    }
    const next = await this.pool.ensure(account);
    for (const descriptor of descriptors) {
      await this.pool.stop(descriptor.id);
      descriptor.retired = true;
      for (const [threadId, owner] of Object.entries(this.options.state.threadOwners)) {
        if (owner === descriptor.id) this.options.state.threadOwners[threadId] = next.descriptor.id;
      }
    }
    await this.save();
  }
  async close(): Promise<void> {
    this.closed = true;
    this.bridge.setRequestRouter();
    this.bridge.setNativeNotificationFilter();
    this.bridge.off("nativeNotification", this.nativeNotification);
    this.pool.off("notification", this.notification);
    this.pool.off("request", this.serverRequest);
    await this.pendingSave;
    await this.pool.close();
  }
  private nativeNotification = (notice: ServerNotification) => {
    const id =
      notice.method === "thread/started"
        ? notice.params.thread.id
        : "threadId" in notice.params
          ? notice.params.threadId
          : undefined;
    if (typeof id === "string" && !this.options.state.threadOwners[id]) {
      this.options.state.threadOwners[id] = LEGACY;
      void this.save().catch(() => undefined);
    }
  };
  private notification = (descriptor: AccountRuntimeDescriptor, notice: ServerNotification) => {
    this.options.observe(descriptor, notice);
    if (notice.method.startsWith("account/")) return;
    const id =
      notice.method === "thread/started"
        ? notice.params.thread.id
        : "threadId" in notice.params
          ? notice.params.threadId
          : undefined;
    if (notice.method === "thread/started" && notice.params.thread.ephemeral)
      this.ephemeral.add(notice.params.thread.id);
    if (typeof id === "string" && this.ephemeral.has(id)) {
      // Internal title/refinement callers still need their completion events.
      // Projection already hides ephemeral threads from the client interface.
      if (notice.method === "thread/closed" || notice.method === "thread/deleted")
        this.ephemeral.delete(id);
    } else if (typeof id === "string") {
      const owner = this.options.state.threadOwners[id];
      if (owner && owner !== descriptor.id) return; // Late events from a released owner cannot change the new owner.
      if (!owner) {
        this.options.state.threadOwners[id] = descriptor.id;
        void this.save().catch(() => undefined);
      }
    }
    this.bridge.acceptNotification(
      notice.method === "serverRequest/resolved"
        ? {
            ...notice,
            params: {
              ...notice.params,
              requestId: scopedRequestId(descriptor.id, notice.params.requestId),
            },
          }
        : notice,
    );
  };
  private serverRequest = (
    descriptor: AccountRuntimeDescriptor,
    request: ServerRequest,
    transport: JsonlTransport,
  ) => {
    if ("threadId" in request.params && this.ephemeral.has(String(request.params.threadId))) {
      transport.respondError(
        request.id,
        -32600,
        "Account warm-up cannot request tools or approvals",
      );
      return;
    }
    const id = scopedRequestId(descriptor.id, request.id);
    const responseTransport = new Proxy(transport, {
      get(target, key) {
        if (key === "respond")
          return (_id: string | number, result: unknown) => target.respond(request.id, result);
        if (key === "respondError")
          return (_id: string | number, code: number, message: string) =>
            target.respondError(request.id, code, message);
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    this.bridge.emit("request", { ...request, id }, responseTransport);
  };
  private async request(method: string, raw: unknown, timeout: number): Promise<unknown> {
    const params = raw as Record<string, unknown> | undefined;
    if (method === "thread/loaded/list") return this.loaded(params, timeout);
    const threadId = typeof params?.threadId === "string" ? params.threadId : undefined;
    const startsWork = [
      "turn/start",
      "review/start",
      "thread/realtime/start",
      "thread/compact/start",
      "thread/shellCommand",
      "thread/goal/set",
      "thread/queue/start",
    ].includes(method);
    const workAllowed = this.options.workAllowed?.() !== false;
    if (!workAllowed && (startsWork || method === "thread/start" || method === "thread/fork")) {
      throw new AccountRuntimeError("CodexNest is finalizing the update; retry after confirmation");
    }
    if (method === "turn/start" && !this.ephemeral.has(threadId ?? "")) this.options.userWork();
    let client: CodexBridge | undefined;
    let descriptor: AccountRuntimeDescriptor | undefined;
    if (threadId) {
      const owner = this.options.state.threadOwners[threadId];
      if (owner && owner !== LEGACY) {
        descriptor = this.pool.descriptor(owner);
        if (startsWork) this.options.beforeStart(descriptor.accountId);
        client = await this.pool.connect(owner);
        const account = this.options.account(descriptor.accountId);
        if (
          account &&
          !this.pool.matches(descriptor, account) &&
          ["turn/start", "thread/goal/set", "review/start"].includes(method)
        ) {
          client = await this.migrate(threadId, account);
          descriptor = this.pool.descriptor(this.options.state.threadOwners[threadId]!);
        }
      } else if (method === "thread/resume" && !owner && workAllowed) {
        const selected = await this.selected();
        if (selected) {
          client = selected.bridge;
          descriptor = selected.descriptor;
          await this.bind(threadId, descriptor.id);
        }
      } else if ((!owner || owner === LEGACY) && startsWork) {
        if (this.bridge.threadActive(threadId)) {
          if (method === "turn/start")
            throw new AccountRuntimeError(
              "Wait for the active response before changing its account",
            );
        } else {
          const selected = this.options.selected();
          if (selected) {
            client = await this.migrate(threadId, selected);
            descriptor = this.pool.descriptor(this.options.state.threadOwners[threadId]!);
          }
        }
      }
    } else if (
      method === "thread/start" ||
      method.startsWith("account/") ||
      method.startsWith("model/") ||
      method.startsWith("modelProvider/") ||
      method.startsWith("app/") ||
      method.startsWith("mcpServer/") ||
      method.startsWith("mcpServerStatus/") ||
      method === "thread/realtime/listVoices" ||
      method === "getAuthStatus" ||
      method === "feedback/upload"
    ) {
      const selected = await this.selected();
      if (selected) {
        client = selected.bridge;
        descriptor = selected.descriptor;
      }
    }
    const safeParams =
      client && params && ["thread/start", "thread/resume", "thread/fork"].includes(method)
        ? {
            ...params,
            config: {
              ...(params.config as object | undefined),
              "features.respect_system_proxy": true,
            },
          }
        : raw;
    if (client && descriptor && startsWork) this.options.beforeStart(descriptor.accountId);
    const result = client
      ? await client.request<any>(method, safeParams, timeout)
      : await this.bridge.requestNative<any>(method, safeParams, timeout);
    const newId = result?.thread?.id ?? result?.reviewThreadId;
    if (
      typeof newId === "string" &&
      ["thread/start", "thread/fork", "thread/resume", "review/start"].includes(method)
    ) {
      await this.bind(
        newId,
        descriptor?.id ??
          (threadId ? this.options.state.threadOwners[threadId] : undefined) ??
          LEGACY,
      );
    }
    return result;
  }
  private migrate(threadId: string, account: RoutedAccount): Promise<CodexBridge> {
    const existing = this.migrations.get(threadId);
    if (existing) return existing;
    const pending = (async () => {
      const owner = this.options.state.threadOwners[threadId];
      const previous = owner && owner !== LEGACY ? await this.pool.connect(owner) : this.bridge;
      const native =
        previous === this.bridge
          ? previous.requestNative.bind(previous)
          : previous.request.bind(previous);
      // Only a completed native turn can hand over its history. Never interrupt or replay an unknown turn.
      const { thread } = await native<any>(
        "thread/read",
        { threadId, includeTurns: false },
        30_000,
      );
      if (thread.status?.type === "active" || previous.threadActive(threadId))
        throw new AccountRuntimeError("Wait for the active response before changing its account");
      const next = await this.pool.ensure(account);
      if (owner === next.descriptor.id) return next.bridge;
      await native("thread/unsubscribe", { threadId }, 30_000);
      // Persist before subscribing: replayed events must already belong to the new owner.
      await this.bind(threadId, next.descriptor.id);
      try {
        await next.bridge.request(
          "thread/resume",
          { threadId, excludeTurns: true, config: { "features.respect_system_proxy": true } },
          30_000,
        );
      } catch (error) {
        if (owner) await this.bind(threadId, owner);
        else {
          delete this.options.state.threadOwners[threadId];
          await this.save();
        }
        throw error;
      }
      return next.bridge;
    })().finally(() => this.migrations.delete(threadId));
    this.migrations.set(threadId, pending);
    return pending;
  }
  private async loaded(
    params: Record<string, unknown> | undefined,
    timeout: number,
  ): Promise<unknown> {
    const first = await this.bridge.requestNative<{ data: string[]; nextCursor: string | null }>(
      "thread/loaded/list",
      params,
      timeout,
    );
    for (const id of first.data) {
      if (!this.options.state.threadOwners[id]) this.options.state.threadOwners[id] = LEGACY;
    }
    // Projection already pages the original daemon. Add all account-owned pages on the first page only.
    if (params?.cursor) return first;
    const ids = new Set(first.data);
    const owners = new Set(
      this.pool
        .descriptors()
        .filter((descriptor) => !descriptor.retired)
        .map((descriptor) => descriptor.id),
    );
    for (const owner of owners) {
      const client = await this.pool.connect(owner);
      let cursor: string | null = null;
      do {
        const page: { data: string[]; nextCursor: string | null } = await client.request(
          "thread/loaded/list",
          { cursor, limit: 100 },
          timeout,
        );
        for (const id of page.data) {
          this.options.state.threadOwners[id] ??= owner;
          if (this.options.state.threadOwners[id] === owner) ids.add(id);
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
    await this.save();
    return { ...first, data: [...ids] };
  }
  private async bind(threadId: string, owner: string): Promise<void> {
    this.options.state.threadOwners[threadId] = owner;
    await this.save();
  }
  private save(): Promise<void> {
    if (this.closed) return this.pendingSave;
    this.pendingSave = this.pendingSave.catch(() => undefined).then(() => this.options.save());
    return this.pendingSave;
  }
}

function scopedRequestId(runtime: string, id: string | number): string {
  return `account:${runtime}:${typeof id}:${id}`;
}
