import { application } from "./application";
import { pastedText } from "@codexnest/protocol";
import type {
  ApiError,
  AppUpdateStatus,
  AttentionResponse,
  UpdateUserInputDraftRequest,
  UserInputDraft,
  UserInputVoiceTarget,
  CodexRateLimitsResponse,
  CodexManagementStatus,
  ClaudeAccountsStatus,
  ClaudeLoginStatus,
  ClaudeProxyInput,
  ClaudeProxyTestResult,
  CreateClaudeLoginRequest,
  CreateDirectoryRequest,
  CreateProjectRequest,
  CreateProjectThreadResponse,
  DirectoryListing,
  DismissPlanRequest,
  ForceRestartAccepted,
  GitChangesSummary,
  GlobalPermissionSettings,
  HealthResponse,
  MarkReadRequest,
  MarkViewedRequest,
  MoveProjectRequest,
  Project,
  QueuedMessage,
  QueueMessageRequest,
  RefreshThreadResponse,
  StartTurnRequest,
  SkillsCatalogResponse,
  SummaryResponse,
  SessionReference,
  ThreadDetail,
  ThreadArtifactsResponse,
  ThreadDraft,
  ThreadGoal,
  ThreadFileAttachment,
  ThreadHistoryPage,
  ThreadSummary,
  ThreadSearchPage,
  ThreadSearchScope,
  ThreadOccurrencesPage,
  ThreadSearchTurn,
  TurnItemsResponse,
  TranscriptionConfigResponse,
  TranscriptionResponse,
  UpdateTranscriptionSettingsRequest,
  TurnStartResult,
  UiLanguageSettings,
  UpdateGlobalPermissionSettingsRequest,
  UpdateCodexProxyRequest,
  UpdateQueuedMessageRequest,
  UpdateSkillConfigRequest,
  UpdateSkillConfigResponse,
  UpdateTaskDefaultsRequest,
  UpdateThreadDraftRequest,
  UpdateThreadGoalRequest,
  UpdateThreadSettingsRequest,
  UpdateThreadRequest,
  UpdateUiLanguageRequest,
  TaskDefaults,
  VoiceTranscriptionJob,
  VoiceTranscriptionMode,
} from "@codexnest/protocol";

import type { ConnectionSettings } from "./storage";
import { readInitialLanguage, translate } from "./i18n";
import {
  normalizeForkOperationDetail,
  type ForkEstimateResponse,
  type ForkMode,
  type ForkOperationDetail,
  type ForkOperationSummary,
} from "./forks";

export class ApiClient {
  constructor(public readonly settings: ConnectionSettings) {}

  health(): Promise<HealthResponse> {
    return this.request("/api/v1/health", { authenticated: application.isClaude });
  }

  summary(): Promise<SummaryResponse> {
    return this.request("/api/v1/summary");
  }

  readSessionReference(threadId: string): Promise<SessionReference> {
    return this.request(`/api/v1/threads/${encodeURIComponent(threadId)}/reference`);
  }

  searchThreads(
    query: string,
    archived: boolean,
    cursor?: string,
    scope: ThreadSearchScope = "messages",
  ): Promise<ThreadSearchPage> {
    const params = new URLSearchParams({ q: query, archived: String(archived), scope });
    if (cursor) params.set("cursor", cursor);
    return this.request(`/api/v1/threads/search?${params}`);
  }

  searchOccurrences(
    threadId: string,
    query: string,
    cursor?: string,
  ): Promise<ThreadOccurrencesPage> {
    const params = new URLSearchParams({ q: query });
    if (cursor) params.set("cursor", cursor);
    return this.request(`/api/v1/threads/${encodeURIComponent(threadId)}/search?${params}`);
  }

  readSearchTurn(threadId: string, turnId: string, cursor: string): Promise<ThreadSearchTurn> {
    const params = new URLSearchParams({ cursor });
    return this.request(
      `/api/v1/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}?${params}`,
    );
  }

  readAppSettings(): Promise<AppUpdateStatus> {
    return this.request("/api/v1/settings/app");
  }

  checkAppUpdate(): Promise<AppUpdateStatus> {
    return this.request("/api/v1/settings/app/check", { method: "POST", timeoutMs: null });
  }

  updateApp(): Promise<AppUpdateStatus> {
    return this.request("/api/v1/settings/app/update", { method: "POST", timeoutMs: null });
  }

  forceRestartApp(): Promise<ForceRestartAccepted> {
    return this.request("/api/v1/settings/app/force-restart", {
      method: "POST",
      timeoutMs: 10_000,
    });
  }

  readTranscriptionConfig(): Promise<TranscriptionConfigResponse> {
    return this.request("/api/v1/transcriptions/config");
  }

  updateTranscriptionSettings(
    body: UpdateTranscriptionSettingsRequest,
  ): Promise<TranscriptionConfigResponse> {
    return this.request("/api/v1/settings/transcription", { method: "PUT", body });
  }

  transcribe(audio: Blob, recordingDurationMs?: number): Promise<TranscriptionResponse> {
    return this.request("/api/v1/transcriptions", {
      method: "POST",
      rawBody: audio,
      contentType: audio.type,
      headers:
        recordingDurationMs === undefined
          ? undefined
          : {
              "X-CodexNest-Audio-Duration-Ms": String(Math.max(1, Math.round(recordingDurationMs))),
            },
      timeoutMs: null,
    });
  }

  createVoiceTranscription(
    threadId: string,
    audio: Blob,
    options: {
      recordingDurationMs: number;
      mode: VoiceTranscriptionMode;
      selectionStart: number;
      selectionEnd: number;
      draftUpdatedAt: number | null;
      clientUploadId: string;
      dismissUserInput?: QueuedMessage["dismissUserInput"];
      userInput?: UserInputVoiceTarget;
    },
  ): Promise<VoiceTranscriptionJob | null> {
    const query = new URLSearchParams({
      mode: options.mode,
      selectionStart: String(options.selectionStart),
      selectionEnd: String(options.selectionEnd),
      draftUpdatedAt: options.draftUpdatedAt === null ? "none" : String(options.draftUpdatedAt),
      clientUploadId: options.clientUploadId,
    });
    if (options.dismissUserInput) {
      query.set("dismissUserInput", JSON.stringify(options.dismissUserInput));
    }
    if (options.userInput) query.set("userInput", JSON.stringify(options.userInput));
    return this.request(
      `/api/v1/threads/${encodeURIComponent(threadId)}/voice-transcriptions?${query}`,
      {
        method: "POST",
        rawBody: audio,
        contentType: audio.type,
        headers: {
          "X-CodexNest-Audio-Duration-Ms": String(
            Math.max(1, Math.round(options.recordingDurationMs)),
          ),
        },
        timeoutMs: 60_000,
      },
    );
  }

  cancelVoiceTranscription(threadId: string): Promise<void> {
    return this.request(`/api/v1/threads/${encodeURIComponent(threadId)}/voice-transcriptions`, {
      method: "DELETE",
    });
  }

  submitUserInputVoices(
    threadId: string,
    draftKey: string,
    body: { draft: UpdateUserInputDraftRequest; recordingIds: string[]; clientMessageId: string },
  ): Promise<void> {
    return this.request(
      `/api/v1/threads/${encodeURIComponent(threadId)}/user-input/${encodeURIComponent(draftKey)}/submit`,
      { method: "POST", body },
    );
  }

  cancelUserInputSubmission(threadId: string, draftKey: string): Promise<void> {
    return this.request(
      `/api/v1/threads/${encodeURIComponent(threadId)}/user-input/${encodeURIComponent(draftKey)}/submit`,
      { method: "DELETE" },
    );
  }

  retryUserInputRecording(threadId: string, jobId: string): Promise<void> {
    return this.request(
      `/api/v1/threads/${encodeURIComponent(threadId)}/voice-transcriptions/${encodeURIComponent(jobId)}/retry`,
      { method: "POST" },
    );
  }

  readCodexRateLimits(): Promise<CodexRateLimitsResponse> {
    return this.request("/api/v1/codex/rate-limits");
  }

  readCodexSettings(): Promise<CodexManagementStatus> {
    return this.request("/api/v1/settings/codex");
  }

  readClaudeAccounts(): Promise<ClaudeAccountsStatus> {
    return this.request("/api/v1/settings/claude");
  }

  refreshClaudeAccounts(accountId?: string): Promise<ClaudeAccountsStatus> {
    return this.request("/api/v1/settings/claude/refresh", {
      method: "POST",
      body: accountId ? { accountId } : {},
      timeoutMs: null,
    });
  }

  updateClaudeAutoSwitch(autoSwitch: boolean): Promise<ClaudeAccountsStatus> {
    return this.request("/api/v1/settings/claude", { method: "PATCH", body: { autoSwitch } });
  }

  updateClaudeWarmLimits(warmLimits: boolean): Promise<ClaudeAccountsStatus> {
    return this.request("/api/v1/settings/claude", { method: "PATCH", body: { warmLimits } });
  }

  selectClaudeAccount(accountId: string): Promise<ClaudeAccountsStatus> {
    return this.request(
      `/api/v1/settings/claude/accounts/${encodeURIComponent(accountId)}/select`,
      {
        method: "POST",
      },
    );
  }

  removeClaudeAccount(accountId: string): Promise<ClaudeAccountsStatus> {
    return this.request(`/api/v1/settings/claude/accounts/${encodeURIComponent(accountId)}`, {
      method: "DELETE",
    });
  }

  updateClaudeAccountProxy(
    accountId: string,
    proxy: ClaudeProxyInput,
  ): Promise<ClaudeAccountsStatus> {
    return this.request(`/api/v1/settings/claude/accounts/${encodeURIComponent(accountId)}`, {
      method: "PATCH",
      body: { proxy },
    });
  }

  testClaudeProxy(proxy: ClaudeProxyInput): Promise<ClaudeProxyTestResult> {
    return this.request("/api/v1/settings/claude/proxy/test", {
      method: "POST",
      body: { proxy },
      timeoutMs: null,
    });
  }

  startClaudeLogin(body: CreateClaudeLoginRequest): Promise<ClaudeLoginStatus> {
    return this.request("/api/v1/settings/claude/logins", {
      method: "POST",
      body,
      timeoutMs: null,
    });
  }

  readClaudeLogin(loginId: string): Promise<ClaudeLoginStatus> {
    return this.request(`/api/v1/settings/claude/logins/${encodeURIComponent(loginId)}`);
  }

  submitClaudeLoginCode(loginId: string, code: string): Promise<ClaudeLoginStatus> {
    return this.request(`/api/v1/settings/claude/logins/${encodeURIComponent(loginId)}/code`, {
      method: "POST",
      body: { code },
      timeoutMs: null,
    });
  }

  cancelClaudeLogin(loginId: string): Promise<ClaudeLoginStatus> {
    return this.request(`/api/v1/settings/claude/logins/${encodeURIComponent(loginId)}`, {
      method: "DELETE",
    });
  }

  checkCodex(): Promise<CodexManagementStatus> {
    return this.request("/api/v1/settings/codex/check", { method: "POST", timeoutMs: null });
  }

  updateCodexProxy(body: UpdateCodexProxyRequest): Promise<CodexManagementStatus> {
    return this.request("/api/v1/settings/codex/proxy", {
      method: "PUT",
      body,
      timeoutMs: null,
    });
  }

  updateCodex(): Promise<CodexManagementStatus> {
    return this.request("/api/v1/settings/codex/update", { method: "POST", timeoutMs: null });
  }

  restartCodex(): Promise<CodexManagementStatus> {
    return this.request("/api/v1/settings/codex/restart", { method: "POST", timeoutMs: null });
  }

  forceRestartCodex(): Promise<CodexManagementStatus> {
    return this.request("/api/v1/settings/codex/force-restart", {
      method: "POST",
      timeoutMs: null,
    });
  }

  readPermissionSettings(): Promise<GlobalPermissionSettings> {
    return this.request("/api/v1/settings/permissions");
  }

  updatePermissionSettings(
    body: UpdateGlobalPermissionSettingsRequest,
  ): Promise<GlobalPermissionSettings> {
    return this.request("/api/v1/settings/permissions", { method: "PUT", body });
  }

  updateTaskDefaults(body: UpdateTaskDefaultsRequest): Promise<TaskDefaults> {
    return this.request("/api/v1/settings/task-defaults", { method: "PUT", body });
  }

  updateUiLanguage(body: UpdateUiLanguageRequest): Promise<UiLanguageSettings> {
    return this.request("/api/v1/settings/ui-language", { method: "PUT", body });
  }

  listDirectories(path?: string): Promise<DirectoryListing> {
    const query = path === undefined ? "" : `?${new URLSearchParams({ path })}`;
    return this.request(`/api/v1/directories${query}`);
  }

  listSkills(cwd: string, forceReload = false): Promise<SkillsCatalogResponse> {
    const query = new URLSearchParams({ cwd, forceReload: String(forceReload) });
    return this.request(`/api/v1/skills?${query}`);
  }

  updateSkillConfig(body: UpdateSkillConfigRequest): Promise<UpdateSkillConfigResponse> {
    return this.request("/api/v1/skills/config", { method: "PUT", body });
  }

  createDirectory(body: CreateDirectoryRequest): Promise<DirectoryListing> {
    return this.request("/api/v1/directories", { method: "POST", body });
  }

  createProject(body: CreateProjectRequest): Promise<Project> {
    return this.request("/api/v1/projects", { method: "POST", body });
  }

  moveProject(id: string, body: MoveProjectRequest): Promise<Project[]> {
    return this.request(`/api/v1/projects/${encodeURIComponent(id)}/move`, {
      method: "POST",
      body,
    });
  }

  deleteProject(id: string): Promise<void> {
    return this.request(`/api/v1/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  createProjectThread(
    projectId: string,
    clientCreationId: string = globalThis.crypto?.randomUUID?.() ??
      `${Date.now()}-${Math.random()}`,
    draft?: UpdateThreadDraftRequest,
  ): Promise<CreateProjectThreadResponse> {
    return this.request(`/api/v1/projects/${encodeURIComponent(projectId)}/threads`, {
      method: "POST",
      body: { clientCreationId, ...(draft ? { draft } : {}) },
      timeoutMs: draft?.images.length ? null : undefined,
      retry: true,
    });
  }

  readProjectDraft(id: string): Promise<ThreadDraft | null> {
    return this.request(`/api/v1/projects/${encodeURIComponent(id)}/draft`, { cache: "no-store" });
  }

  updateProjectDraft(
    id: string,
    base: UpdateThreadDraftRequest,
    value: UpdateThreadDraftRequest,
    options?: { keepalive?: boolean; expectedUpdatedAt?: number },
  ): Promise<ThreadDraft> {
    const query =
      options?.expectedUpdatedAt !== undefined
        ? `?expectedUpdatedAt=${options.expectedUpdatedAt}`
        : "";
    return this.request(`/api/v1/projects/${encodeURIComponent(id)}/draft${query}`, {
      method: "PUT",
      body: { base, value },
      keepalive:
        Boolean(options?.keepalive) &&
        new TextEncoder().encode(JSON.stringify({ base, value })).byteLength < 60_000,
      timeoutMs: base.images.length || value.images.length ? null : 15_000,
    });
  }

  uploadProjectAttachment(id: string, file: File): Promise<ThreadFileAttachment> {
    const query = new URLSearchParams({
      name: file.name || "file",
      mediaType: file.type || "application/octet-stream",
    });
    return this.request(`/api/v1/projects/${encodeURIComponent(id)}/attachments?${query}`, {
      method: "POST",
      rawBody: file,
      contentType: "application/octet-stream",
      timeoutMs: null,
    });
  }

  readThread(id: string, options?: { fresh?: boolean }): Promise<ThreadDetail> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}`, {
      cache: options?.fresh ? "no-store" : undefined,
    });
  }

  readLegacyThreadPage(id: string, cursor: string): Promise<ThreadDetail> {
    const query = new URLSearchParams({ cursor });
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}?${query}`, {
      cache: "no-store",
    });
  }

  refreshThread(id: string): Promise<RefreshThreadResponse> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/refresh`, {
      method: "POST",
    });
  }

  readTurnItems(threadId: string, turnId: string): Promise<TurnItemsResponse> {
    return this.request(
      `/api/v1/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/items`,
    );
  }

  readThreadHistory(id: string, cursor: string, anchorTurnId: string): Promise<ThreadHistoryPage> {
    const query = new URLSearchParams({
      cursor,
      anchorTurnId,
    });
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/history?${query}`, {
      cache: "no-store",
    });
  }

  updateThreadDraft(
    id: string,
    body: UpdateThreadDraftRequest,
    options?: {
      keepalive?: boolean;
      retry?: boolean;
      expectedUpdatedAt?: number | null;
    },
  ): Promise<ThreadDraft | null> {
    const expected =
      options && Object.prototype.hasOwnProperty.call(options, "expectedUpdatedAt")
        ? `?expectedUpdatedAt=${options.expectedUpdatedAt === null ? "none" : String(options.expectedUpdatedAt)}`
        : "";
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/draft${expected}`, {
      method: "PUT",
      body: {
        input: body.input,
        ...pastedText(body),
        images: body.images,
        ...(body.files?.length ? { files: body.files } : {}),
        goalMode: body.goalMode,
        annotations: body.annotations,
      },
      keepalive: options?.keepalive,
      timeoutMs: body.images.length ? null : 15_000,
      retry: options?.retry ?? false,
    });
  }

  readGitChanges(id: string): Promise<GitChangesSummary> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/git-changes`);
  }

  uploadAttachment(id: string, file: File): Promise<ThreadFileAttachment> {
    const query = new URLSearchParams({
      name: file.name || "file",
      mediaType: file.type || "application/octet-stream",
    });
    return this.request(
      `/api/v1/threads/${encodeURIComponent(id)}/attachments?${query.toString()}`,
      {
        method: "POST",
        rawBody: file,
        contentType: "application/octet-stream",
        timeoutMs: null,
      },
    );
  }

  deleteAttachment(id: string, attachmentId: string): Promise<void> {
    return this.request(
      `/api/v1/threads/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`,
      { method: "DELETE" },
    );
  }

  readThreadArtifacts(id: string): Promise<ThreadArtifactsResponse> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/artifacts`, {
      cache: "no-store",
    });
  }

  createDownload(id: string, path: string): Promise<DownloadTicketResponse> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/downloads`, {
      method: "POST",
      body: { path },
    });
  }

  estimateFork(
    id: string,
    body: { lastTurnId: string; agentMessageId: string },
  ): Promise<ForkEstimateResponse> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/fork-estimate`, {
      method: "POST",
      body,
      timeoutMs: null,
    });
  }

  createForkOperation(
    id: string,
    body: {
      operationId: string;
      lastTurnId: string;
      agentMessageId: string;
      mode: ForkMode;
    },
  ): Promise<{ operation: ForkOperationSummary }> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/fork-operations`, {
      method: "POST",
      body,
      timeoutMs: null,
    });
  }

  async readForkOperation(id: string): Promise<ForkOperationDetail> {
    const response = await this.request<
      | ForkOperationSummary
      | ForkOperationDetail
      | {
          operation: ForkOperationSummary;
          queuedMessages?: QueuedMessage[];
          draft?: ThreadDraft | null;
        }
    >(`/api/v1/fork-operations/${encodeURIComponent(id)}`, { cache: "no-store", retry: true });
    return normalizeForkOperationDetail(response);
  }

  updateForkOperationDraft(
    id: string,
    body: UpdateThreadDraftRequest,
    options?: { keepalive?: boolean },
  ): Promise<ThreadDraft | null> {
    return this.request(`/api/v1/fork-operations/${encodeURIComponent(id)}/draft`, {
      method: "PUT",
      body: {
        input: body.input,
        ...pastedText(body),
        images: body.images,
        ...(body.files?.length ? { files: body.files } : {}),
        goalMode: body.goalMode,
        annotations: body.annotations,
      },
      keepalive: options?.keepalive,
      timeoutMs: body.images.length ? null : 15_000,
    });
  }

  enqueueForkOperation(id: string, body: QueueMessageRequest): Promise<QueuedMessage> {
    return this.request(`/api/v1/fork-operations/${encodeURIComponent(id)}/queue`, {
      method: "POST",
      body,
      timeoutMs: body.images?.length ? null : 15_000,
    });
  }

  updateForkOperationQueued(
    id: string,
    messageId: string,
    body: UpdateQueuedMessageRequest,
  ): Promise<QueuedMessage> {
    return this.request(
      `/api/v1/fork-operations/${encodeURIComponent(id)}/queue/${encodeURIComponent(messageId)}`,
      { method: "PATCH", body },
    );
  }

  deleteForkOperationQueued(id: string, messageId: string): Promise<void> {
    return this.request(
      `/api/v1/fork-operations/${encodeURIComponent(id)}/queue/${encodeURIComponent(messageId)}`,
      { method: "DELETE" },
    );
  }

  retryForkOperation(
    operation: ForkOperationSummary,
  ): Promise<{ operation: ForkOperationSummary }> {
    return this.createForkOperation(operation.sourceThreadId, {
      operationId: operation.id,
      lastTurnId: operation.lastTurnId,
      agentMessageId: operation.agentMessageId,
      mode: operation.mode,
    });
  }

  removeForkOperation(id: string): Promise<void> {
    return this.request(`/api/v1/fork-operations/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  updateThread(id: string, body: UpdateThreadRequest): Promise<ThreadSummary> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}`, { method: "PATCH", body });
  }

  updateThreadSettings(id: string, body: UpdateThreadSettingsRequest): Promise<ThreadSummary> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/settings`, {
      method: "PATCH",
      body,
    });
  }

  startTurn(id: string, body: StartTurnRequest): Promise<TurnStartResult> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/turns`, {
      method: "POST",
      body,
      timeoutMs: null,
      retry: Boolean(body.clientMessageId),
    });
  }

  enqueue(id: string, body: QueueMessageRequest): Promise<QueuedMessage> {
    const action = application.isClaude && body.deliveryMode === "steer" ? "steer" : "queue";
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      body,
      timeoutMs: body.images?.length ? null : 15_000,
    });
  }

  readGoal(id: string): Promise<ThreadGoal | null> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/goal`);
  }

  updateGoal(id: string, body: UpdateThreadGoalRequest): Promise<ThreadGoal> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/goal`, {
      method: "PATCH",
      body,
    });
  }

  clearGoal(id: string): Promise<void> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/goal`, {
      method: "DELETE",
    });
  }

  sendQueuedNow(
    id: string,
    messageId: string,
    retryUnconfirmed = false,
  ): Promise<{ turnId: string; thread?: ThreadSummary }> {
    return this.request(
      `/api/v1/threads/${encodeURIComponent(id)}/queue/${encodeURIComponent(messageId)}/send`,
      { method: "POST", ...(retryUnconfirmed ? { body: { retryUnconfirmed: true } } : {}) },
    );
  }

  updateQueued(
    id: string,
    messageId: string,
    body: UpdateQueuedMessageRequest,
  ): Promise<QueuedMessage> {
    return this.request(
      `/api/v1/threads/${encodeURIComponent(id)}/queue/${encodeURIComponent(messageId)}`,
      { method: "PATCH", body },
    );
  }

  deleteQueued(id: string, messageId: string): Promise<void> {
    return this.request(
      `/api/v1/threads/${encodeURIComponent(id)}/queue/${encodeURIComponent(messageId)}`,
      { method: "DELETE" },
    );
  }

  interrupt(id: string, turnId?: string): Promise<void> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/interrupt`, {
      method: "POST",
      body: turnId ? { turnId } : {},
    });
  }

  archive(id: string, archived: boolean): Promise<void> {
    return this.request(
      `/api/v1/threads/${encodeURIComponent(id)}/${archived ? "archive" : "unarchive"}`,
      { method: "POST" },
    );
  }

  markRead(id: string, body: MarkReadRequest): Promise<void> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/read`, { method: "PUT", body });
  }

  dismissPlan(id: string, body: DismissPlanRequest): Promise<ThreadSummary> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/plan/dismiss`, {
      method: "POST",
      body,
    });
  }

  markViewed(id: string, body: MarkViewedRequest): Promise<void> {
    return this.request(`/api/v1/threads/${encodeURIComponent(id)}/viewed`, {
      method: "PUT",
      body,
      retry: true,
    });
  }

  respond(attentionId: string, body: AttentionResponse): Promise<void> {
    return this.request(`/api/v1/attention/${encodeURIComponent(attentionId)}/respond`, {
      method: "POST",
      body,
    });
  }

  updateUserInputDraft(
    attentionId: string,
    body: UpdateUserInputDraftRequest,
  ): Promise<UserInputDraft> {
    return this.request(`/api/v1/attention/${encodeURIComponent(attentionId)}/draft`, {
      method: "PUT",
      body,
      keepalive: true,
    });
  }

  webSocketUrl(): string {
    const url = new URL(application.eventsPath, `${this.settings.baseUrl}/`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }

  private async request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      rawBody?: BodyInit;
      contentType?: string;
      authenticated?: boolean;
      timeoutMs?: number | null;
      keepalive?: boolean;
      headers?: Record<string, string>;
      cache?: RequestCache;
      retry?: boolean;
    } = {},
  ): Promise<T> {
    const retryDelays = [1_000, 2_000, 4_000];
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.requestOnce<T>(path, options);
      } catch (error) {
        if (!options.retry || attempt >= retryDelays.length || !isRetryableApiError(error)) {
          throw error;
        }
        await delay(retryDelays[attempt]!);
      }
    }
  }

  private async requestOnce<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      rawBody?: BodyInit;
      contentType?: string;
      authenticated?: boolean;
      timeoutMs?: number | null;
      keepalive?: boolean;
      headers?: Record<string, string>;
      cache?: RequestCache;
    },
  ): Promise<T> {
    const headers = new Headers({ Accept: "application/json" });
    for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
    if (options.authenticated !== false)
      headers.set("Authorization", `Bearer ${this.settings.token}`);
    if (options.rawBody !== undefined) {
      headers.set("Content-Type", options.contentType || "application/octet-stream");
    } else if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    const controller = new AbortController();
    const timeout =
      options.timeoutMs === null
        ? null
        : window.setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
    try {
      let response: Response;
      try {
        response = await fetch(new URL(path, `${this.settings.baseUrl}/`), {
          method: options.method ?? "GET",
          headers,
          body:
            options.rawBody ??
            (options.body === undefined ? undefined : JSON.stringify(options.body)),
          signal: controller.signal,
          keepalive: options.keepalive,
          cache: options.cache,
        });
      } catch {
        throw new ApiClientError(
          "connection_failed",
          translate(readInitialLanguage(), "Не удалось подключиться к серверу"),
        );
      }
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as ApiError | null;
        throw new ApiClientError(
          payload?.error.code ?? "http_error",
          payload?.error.message ?? `HTTP ${response.status}`,
          response.status,
        );
      }
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    } finally {
      if (timeout !== null) window.clearTimeout(timeout);
    }
  }
}

export interface DownloadTicketResponse {
  downloadUrl: string;
  expiresAt: number;
  fileName: string;
  size: number;
}

export class ApiClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export function isRetryableApiError(error: unknown): boolean {
  if (!(error instanceof ApiClientError)) return false;
  return (
    error.code === "connection_failed" ||
    error.status === 408 ||
    error.status === 425 ||
    error.status === 429 ||
    (typeof error.status === "number" && error.status >= 500)
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
