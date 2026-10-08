import {
  fastServiceTier,
  isFastServiceTier,
  mergeProjectDraft,
  copyPastedMessage,
  pastedText,
  trimPastedMessage,
  rebasePastedText,
  serializePastedMessage,
  validPastedText,
  type PastedText,
} from "@codexnest/protocol";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants, createReadStream, type Stats } from "node:fs";
import { access, lstat, mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Readable } from "node:stream";

import type { FastifyInstance, FastifyReply } from "fastify";

import type {
  ApiErrorCode,
  AsyncQuestionReference,
  UserInputReply,
  AppUpdateStatus,
  ForceRestartAccepted,
  CreateForkOperationRequest,
  ForkEstimateResponse,
  ForkOperationDetailResponse,
  ForkOperationResponse,
  ForkThreadRequest,
  ForkThreadResponse,
  AttentionResponse,
  CodexManagementStatus,
  CodexRateLimitsResponse,
  CreateDirectoryRequest,
  CreateProjectRequest,
  CreateProjectThreadResponse,
  GlobalPermissionSettings,
  InterruptTurnRequest,
  DismissPlanRequest,
  MarkReadRequest,
  MarkViewedRequest,
  ModelOption,
  MoveProjectRequest,
  PermissionPreset,
  PlanImplementationMode,
  Project,
  QueueMessageRequest,
  QueuedMessage,
  RefreshThreadResponse,
  ServerEvent,
  SessionSettings,
  SessionArtifact,
  SessionReference,
  SkillCatalogItem,
  SkillsCatalogResponse,
  StartTurnRequest,
  TaskDefaults,
  ThreadGoal,
  ThreadDraft,
  ThreadFileAttachment,
  ThreadChanges,
  ThreadArtifactsResponse,
  ThreadHistoryPage,
  ThreadOutcome,
  ThreadSummary,
  TranscriptionConfigResponse,
  TranscriptionResponse,
  TurnItemsResponse,
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
  UpdateTranscriptionSettingsRequest,
  UpdateUiLanguageRequest,
  UpdateUserInputDraftRequest,
  UserInputQuestion,
  UserInputVoiceTarget,
  VoiceTranscriptionMode,
  VoiceTranscriptionJob,
} from "@codexnest/protocol";

import { AttentionValidationError, type AttentionManager } from "./attention";
import { DurableDelivery, DeliveryContractError, requireDeliveryReceipt } from "./durable-delivery";
import {
  AttachmentStore,
  AttachmentTooLargeError,
  AttachmentValidationError,
  MAX_ATTACHMENT_BYTES,
  MAX_MESSAGE_ATTACHMENT_BYTES,
  appendAttachmentContext,
  isAttachmentShape,
} from "./attachments";
import { AppManagementError, type AppManager } from "./app-management";
import { bearerToken, verifyToken } from "./auth";
import { BrowserExtensionError, type BrowserExtensionServer } from "./browser-extension";
import { BridgeUnavailableError, type CodexBridge } from "./codex/bridge";
import type { ServerNotification, ServerRequest } from "./codex/generated/index";
import type {
  DynamicToolCallResponse,
  SkillMetadata,
  SkillsListEntry,
  Thread,
  ThreadItem,
  ThreadResumeResponse,
  Turn,
  UserInput,
} from "./codex/generated/v2/index";
import {
  parseAccountRateLimits,
  parseSkillsConfigWrite,
  parseSkillsList,
  parseThreadList,
  parseThreadRead,
  parseThreadStart,
  parseTurnsList,
  parseTurnStart,
  parseTurnSteer,
  ProtocolShapeError,
} from "./codex/guards";
import { RpcError, RpcTimeoutError, type JsonlTransport } from "./codex/transport";
import { CodexManagementError, type CodexManager } from "./codex-management";
import { SERVER_VERSION } from "./config";
import {
  CAPACITY_RETRY_INTERVAL_MS,
  CAPACITY_RETRY_MESSAGE,
  capacityRetryMessageId,
  isCapacityFailure,
  isTemporaryCapacityRpcError,
} from "./capacity-retry";
import { readGitChanges } from "./git-changes";
import { safeError } from "./logging";
import {
  assertUniqueProjectPath,
  canonicalProjectPath,
  createDirectory,
  createProject,
  listDirectories,
  pathContains,
  ProjectConflictError,
  ProjectForbiddenError,
  ProjectNotFoundError,
  ProjectValidationError,
} from "./projects";
import {
  analyzeForkRollout,
  freshCompressedForkEstimate,
  hasForkMaterializedCompaction,
  readFreshCompaction,
} from "./fork-rollout";
import {
  ThreadDraftConflictError,
  ThreadHistoryConflictError,
  ThreadSearchUnavailableError,
  ThreadSearchNotFoundError,
  ThreadViewUnavailableError,
  publicForkOperation,
  type AppProjection,
} from "./projection";
import {
  RESTART_RECOVERY_PROTOCOL_VERSION,
  RestartPreparationTimeoutError,
  RestartTokenError,
  type RuntimeLifecycle,
} from "./runtime-lifecycle";
import {
  MessageQueue,
  MessageQueueConflictError,
  MessageQueueNotFoundError,
  MessageQueuePausedError,
  MessageQueueInputUnavailableError,
  MessageQueueValidationError,
  messageContentHash,
} from "./message-queue";
import type {
  CodexNestState,
  CodexNestStateView,
  DeepReadonly,
  ForkOperationState,
  ManagedTeamTaskAccessState,
  ManagedTeamTaskResultArtifact,
  ManagedTeamTaskResultCheck,
  ManagedTeamTaskResult,
  ManagedTeamTaskState,
  SessionArtifactState,
  StateStore,
  TeamToolOperationState,
} from "./state/store";
import type { ThreadTitleGenerator } from "./thread-title";
import { isMissingThreadError, isThreadResumeRequiredError } from "./thread-state";
import {
  computeTeamWorkspaceDelta,
  createTeamWorkspace,
  discardTeamWorkspace,
  integrateTeamWorkspace,
  TeamWorkspaceConflictError,
  TeamWorkspaceError,
  TeamWorkspacePathError,
} from "./team-workspace";
import {
  appendTranscriptionTimingSample,
  MAX_TRANSCRIPTION_BYTES,
  MAX_RECORDING_SECONDS,
  normalizeAudioType,
  TranscriptionError,
  transcriptionTimingEstimate,
  transcriptionTimingProfile,
  type TranscriptionService,
} from "./transcription";
import {
  VoiceTranscriptionConflictError,
  VoiceTranscriptionDraftConflictError,
  VoiceTranscriptionManager,
  VoiceTranscriptionQueueFullError,
} from "./voice-transcriptions";

const CHAT_BODY_LIMIT = Number.MAX_SAFE_INTEGER;
const DOWNLOAD_TICKET_TTL_MS = 60_000;
const MAX_DOWNLOAD_TICKETS = 128;
const FORK_RPC_TIMEOUT_MS = 10 * 60_000;
const FORK_ATTEMPT_SETTLE_MS = FORK_RPC_TIMEOUT_MS + 30_000;
const TEAM_MAX_ACTIVE_TASKS = 10;
const TEAM_TASK_HISTORY_LIMIT = 50;
const TEAM_NOTICE_CHANGED_PATH_LIMIT = 20;
const TEAM_WATCHDOG_MS = 10 * 60_000;
const TEAM_ACTIVITY_PERSIST_MS = 1_000;
const TEAM_CHILD_MODEL_ID = "gpt-5.6-sol";
const TEAM_SANDBOX_MOUNTPOINTS = [".agents", ".codex"] as const;

type ManagedTeamTaskView = DeepReadonly<ManagedTeamTaskState>;
type ManagedTeamTaskMapView = DeepReadonly<Record<string, ManagedTeamTaskState>>;
type TeamToolOperationView = DeepReadonly<TeamToolOperationState>;
const TEAM_CONTINUATION_MARKER_TEXT =
  "Continue CodexNest Team orchestration using the attached managed-task results.";
const TEAM_SESSION_UPGRADE_MESSAGE =
  "Эта сессия создана до появления managed Team tools. Создайте новую Team-сессию.";
const PLAN_MODE_CONTEXT = [
  "This session is in CodexNest Plan mode. Follow the built-in Plan mode instructions.",
  "When the user continues discussing an already proposed plan, incorporate all agreed clarifications into the complete current plan.",
  "Once the discussion is resolved, end your final response with one full replacement <proposed_plan> block, even if the plan itself is unchanged. Do not merely describe changes or promise to update the plan.",
  "If material questions remain unresolved, continue clarifying and do not present an incomplete plan as ready for implementation.",
].join(" ");
const TEAM_MODE_CONTEXT = [
  "This session is in CodexNest Team mode. You are the root agent and may perform any part of the user's task directly, including inspecting, analyzing, editing, and testing code.",
  "Managed tasks are event-driven: when a child finishes, CodexNest automatically delivers its result and resumes this parent session.",
  "Never keep the parent turn open merely because managed tasks are queued or running, and never call tools merely to keep the turn alive. After scheduling ready tasks and finishing all independent parent work, immediately finish the turn.",
  "Never call sleep, run shell sleep commands, or call codexnest.list_tasks or codexnest.inspect_task merely to check whether a child is done; repeated status checks and any other waiting loop are polling.",
  "Delegate only when you judge that a managed child is materially useful. Use only the codexnest managed-task tools for delegation and never use native subagent tools.",
  "Use the smallest sufficient solution that resolves the user's main problem. Add complexity only to address a concrete, confirmed risk.",
  "Before calling codexnest.spawn_task, confirm that the task is necessary to achieve the user's original goal.",
  "Honor an explicit user request to work in the main session unless delegation is necessary to achieve the request.",
  "Do not create managed tasks for optional improvements, speculative risks, extra completeness, or checks without a concrete target.",
  "When the user asks to stop or cancel subagents, use codexnest.list_tasks when needed and codexnest.cancel_task for every queued, starting, or running managed task. Do not create replacement tasks unless the user asks for them.",
  "After every meaningful stage, pause and reassess the remaining plan against the user's original goal. Continue without asking the user only with steps that are still necessary; never proceed merely because a step was previously planned.",
  "Every test, command run, and checklist item must target a specific product risk or an observed defect. Omit it otherwise.",
  "Keep the full conversation and complete plan only in the root coordinator's context.",
  "In each managed child prompt, include only the single assigned plan step and the minimum task-specific context needed to complete it: its objective, relevant constraints, affected scope, and expected result.",
  "Never copy or summarize the conversation, the full plan, unrelated plan steps, or prior agent messages in a subagent prompt.",
  "Once work is delegated, do not duplicate the same scope in the parent session unless integration or repair requires it.",
  "When a task explicitly requires checking results after a fixed delay or deadline, delegate the complete start, initial health check, sleep, and final inspection cycle to one managed child; never wait in the parent.",
  "On a CodexNest orchestration continuation, process the named child results and continue reasoning about the original task before deciding the next action.",
  "If an explicit user message is present, answer it first without forgetting any active or newly completed subagents.",
  "Grant network access only when a managed task requires external access such as documentation, package downloads, remote APIs, or health checks; set access.network to true in that case and leave it false for local-only work.",
  "Choose sequential or parallel delegation based on dependencies and workspace overlap.",
  "Do not run multiple repository-wide builds, full test suites, or similarly resource-heavy commands in parallel; schedule those tasks sequentially.",
  "Never run parallel sharedWrite tasks whose write paths overlap.",
  "Parallel isolatedWrite tasks may edit overlapping files when comparing alternatives or when their results will be synthesized; their worktrees remain separate.",
  "Integrate isolated results sequentially. If an isolated result conflicts after another result changed the parent, call codexnest.inspect_task to obtain workspacePath, compare that workspace with the parent, manually merge the required changes in the parent, and then call codexnest.discard_task_changes for that workspace.",
  "Use codexnest.inspect_task, codexnest.steer_task, or codexnest.cancel_task when a watchdog reports that a task is silent.",
  "You may write managed-task prompts and steering messages in English whenever you judge that it improves efficiency or precision, regardless of the user's language.",
  "Keep concise task titles and the consolidated user-facing response in the user's language.",
  "When the required results are ready, return one consolidated result to the user.",
  "The user should not need to coordinate subagents directly.",
].join(" ");
const TEAM_CHILD_INSTRUCTIONS = [
  "You are a CodexNest managed child agent. Complete exactly the assigned task in this thread.",
  "Do not create or delegate to subagents.",
  "Honor the enforced workspace, writable-path, and network limits. Never attempt to escape them or request broader approval.",
  "Do not commit, push, deploy, or change Git refs; the root agent alone integrates and publishes changes.",
  "When the task explicitly requires checking results after a fixed delay or deadline, start the workload asynchronously, perform one brief startup check, and use the built-in sleep tool once for only the remaining time.",
  "Before finishing, call codexnest.submit_result with outcome, a concise summary, optional details, checks, risks, and artifacts.",
  "The submitted value is a result candidate; still provide a normal final answer after the tool call.",
].join(" ");
const SESSION_ARTIFACT_INSTRUCTIONS =
  "Use codexnest.publish_artifact only for standalone final deliverables intentionally delivered to the user. Never publish ordinary source references, intermediate files, plans or checklists, or every edited file.";
const IMAGE_DELIVERY_CONTEXT = [
  "In CodexNest, images returned by tools (including image viewing and generation) appear only in expandable technical details, not in the main conversation.",
  "To show an image to the user, explicitly include a Markdown image or a labeled image-file link in your commentary, plan, or final message, using an absolute local path or an HTTPS image URL.",
  "Prefer files in the thread's working directory. Before linking a local image outside that directory, open it with view_image in this thread, then link its exact path. If a tool returns only image data, save the chosen image in the working directory before linking it.",
  "Viewing, generating, or forwarding an image through a tool output such as image(...) does not attach it to your message. Do not claim to have shown an image unless you have included it in a user-facing message.",
].join(" ");

interface DownloadTicket {
  root: string;
  path: string;
  fileName: string;
  expiresAt: number;
}

interface TeamResultClaim {
  claimId: string;
  results: Array<{
    taskId: string;
    childThreadId: string;
    terminalTurnId: string;
    outcome: ThreadOutcome;
    title: string;
    result: ManagedTeamTaskResult;
  }>;
  watchdogs: Array<{
    taskId: string;
    childThreadId: string;
    title: string;
    status: ManagedTeamTaskState["status"];
    lastActivityAt: number;
  }>;
}

interface ManagedTaskOptions {
  dependsOn: string[];
  access: ManagedTeamTaskAccessState;
  model: string;
  reasoningEffort: string | null;
}

interface ManagedChildRuntime {
  cwd: string;
  runtimeWorkspaceRoots?: string[];
  sandboxPolicy?:
    | { type: "readOnly"; networkAccess: boolean }
    | {
        type: "workspaceWrite";
        writableRoots: string[];
        networkAccess: boolean;
        excludeTmpdirEnvVar: boolean;
        excludeSlashTmp: boolean;
      };
}

const TEAM_ACCESS_SCHEMA = {
  type: "object",
  properties: {
    mode: {
      type: "string",
      enum: ["readOnly", "isolatedWrite", "sharedWrite"],
      description: "Workspace access mode. Defaults to readOnly.",
    },
    writePaths: {
      type: "array",
      items: { type: "string" },
      description: "Repository-relative writable paths. Required for write modes.",
    },
    network: {
      type: "boolean",
      description:
        "Allow network access when the task requires documentation, downloads, remote APIs, or health checks. Defaults to false.",
    },
  },
  additionalProperties: false,
} as const;

const TEAM_TASK_OPTIONS_SCHEMA = {
  dependsOn: { type: "array", items: { type: "string" }, maxItems: 50 },
  access: TEAM_ACCESS_SCHEMA,
  reasoningEffort: { type: "string" },
} as const;

const ROOT_DYNAMIC_TOOLS = [
  {
    type: "namespace",
    name: "codexnest",
    description: "Publish session deliverables and manage isolated CodexNest child tasks.",
    tools: [
      dynamicTool("publish_artifact", "Publish one standalone final file to the user.", {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository-relative path to one local file." },
          label: { type: "string", description: "Optional user-facing label." },
        },
        required: ["path"],
        additionalProperties: false,
      }),
      dynamicTool("spawn_task", "Create one managed child task.", {
        type: "object",
        properties: {
          title: { type: "string", description: "Concise task-specific title." },
          prompt: { type: "string", description: "Self-contained task instructions." },
          ...TEAM_TASK_OPTIONS_SCHEMA,
        },
        required: ["title", "prompt"],
        additionalProperties: false,
      }),
      dynamicTool("followup_task", "Continue a delivered managed task in the same child thread.", {
        type: "object",
        properties: {
          taskId: { type: "string" },
          title: { type: "string" },
          prompt: { type: "string", description: "Self-contained follow-up instructions." },
          access: TEAM_ACCESS_SCHEMA,
          reasoningEffort: { type: "string" },
        },
        required: ["taskId", "prompt"],
        additionalProperties: false,
      }),
      dynamicTool(
        "list_tasks",
        "Get a one-time snapshot of managed tasks for an explicit status request, cancellation, or a concrete coordination decision. Never use this tool to wait or poll; task completion automatically resumes the parent.",
        {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      ),
      dynamicTool(
        "inspect_task",
        "Inspect one managed task for an explicit status request, watchdog investigation, corrective action, or terminal-result workspace review and synthesis. Never use this tool to monitor progress, wait, or poll; task completion automatically resumes the parent.",
        {
          type: "object",
          properties: { taskId: { type: "string" } },
          required: ["taskId"],
          additionalProperties: false,
        },
      ),
      dynamicTool("steer_task", "Send corrective guidance to a running managed task.", {
        type: "object",
        properties: { taskId: { type: "string" }, message: { type: "string" } },
        required: ["taskId", "message"],
        additionalProperties: false,
      }),
      dynamicTool("cancel_task", "Cancel a queued or running managed task.", {
        type: "object",
        properties: { taskId: { type: "string" }, reason: { type: "string" } },
        required: ["taskId"],
        additionalProperties: false,
      }),
      dynamicTool("integrate_task", "Apply an isolated task's verified changes to the parent.", {
        type: "object",
        properties: { taskId: { type: "string" } },
        required: ["taskId"],
        additionalProperties: false,
      }),
      dynamicTool("discard_task_changes", "Discard an isolated task's unapplied changes.", {
        type: "object",
        properties: { taskId: { type: "string" } },
        required: ["taskId"],
        additionalProperties: false,
      }),
    ],
  },
] as const;

const TEAM_CHILD_DYNAMIC_TOOLS = [
  {
    type: "namespace",
    name: "codexnest",
    description: "Return the structured result of the current CodexNest managed task.",
    tools: [
      dynamicTool("submit_result", "Submit the result candidate for this managed task.", {
        type: "object",
        properties: {
          outcome: { type: "string", enum: ["success", "partial", "blocked", "failed"] },
          summary: { type: "string", description: "Concise non-empty result summary." },
          details: { type: "string", description: "Optional Markdown details." },
          checks: {
            type: "array",
            maxItems: 100,
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                outcome: { type: "string", enum: ["passed", "failed", "notRun"] },
                details: { type: "string" },
              },
              required: ["name", "outcome"],
              additionalProperties: false,
            },
          },
          risks: { type: "array", maxItems: 100, items: { type: "string" } },
          artifacts: {
            type: "array",
            maxItems: 100,
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                path: { type: "string" },
                url: { type: "string" },
              },
              required: ["label"],
              additionalProperties: false,
            },
          },
        },
        required: ["outcome", "summary"],
        additionalProperties: false,
      }),
    ],
  },
] as const;

export interface ApiServices {
  bridge: CodexBridge;
  store: StateStore;
  projection: AppProjection;
  attention: AttentionManager;
  codexManager?: CodexManager;
  appManager?: AppManager;
  lifecycle?: RuntimeLifecycle;
  threadTitles?: Pick<ThreadTitleGenerator, "generate">;
  transcription?: Pick<
    TranscriptionService,
    "configuration" | "updateConfiguration" | "transcribe"
  >;
  projectRoot?: string;
  browserExtension?: BrowserExtensionServer;
}

export function registerApi(app: FastifyInstance, services: ApiServices): void {
  const {
    bridge,
    store,
    projection,
    attention,
    codexManager,
    appManager,
    lifecycle,
    threadTitles,
    browserExtension,
  } = services;
  const attachments = new AttachmentStore(store.path);
  const downloadTickets = new Map<string, DownloadTicket>();
  const projectThreadCreations = new Map<string, Promise<ThreadSummary>>();
  const turnStartLocks = new Map<string, Promise<unknown>>();
  const firstSessionRecoveryLocks = new Map<string, Promise<unknown>>();
  const teamParentLocks = new Map<string, Promise<unknown>>();
  const teamToolOperationLocks = new Map<string, Promise<unknown>>();
  const stoppedTeamParents = new Set<string>();
  const skillsByCwd = new Map<string, SkillsListEntry>();
  projection.on("event", (_sequence: number, event: ServerEvent) => {
    if (event.type === "skills.changed") skillsByCwd.clear();
  });
  app.addContentTypeParser(/^audio\//i, { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });
  const scheduleThreadTitle = (threadId: string, input: string, summary: ThreadSummary): void => {
    if (!threadTitles || !input.trim() || projection.hasExplicitName(threadId)) return;
    const model = effectiveTitleModel(
      summary.settings,
      store.view().taskDefaults,
      projection.availableModels,
    );
    const pending = threadTitles
      .generate(input, {
        cwd: summary.cwd,
        model: model?.id,
        effort: model?.reasoningEfforts[0]?.value,
      })
      .then(async (name) => {
        if (projection.hasExplicitName(threadId)) return;
        await bridge.request("thread/name/set", { threadId, name });
      })
      .catch((error: unknown) => {
        app.log.warn({ err: safeError(error), threadId }, "Failed to generate thread title");
      });
    void (lifecycle?.track(pending, "thread title generation") ?? pending);
  };
  const durableDelivery = new DurableDelivery(store, bridge);

  const updateThreadSettings = async (
    threadId: string,
    patch: UpdateThreadSettingsRequest,
  ): Promise<ThreadSummary> => {
    const summary = projection.summary(threadId);
    if (!summary) throw new ProjectNotFoundError("Thread not found");
    assertWritableThread(summary);
    if (
      patch.collaborationMode !== undefined &&
      patch.collaborationMode !== "team" &&
      summary.settings.collaborationMode === "team" &&
      teamOrchestrationHasWork(store, threadId)
    ) {
      throw new ProjectConflictError(
        "Нельзя выключить Team, пока субагенты работают или их результаты ещё не обработаны. Попросите главного агента завершить или отменить их.",
      );
    }
    if (summary.currentTurnId || summary.capacityRetry) {
      throw new ProjectConflictError("Settings cannot be changed while a turn is running");
    }
    const settings = mergeSettings(summary.settings, patch, projection.availableModels);
    if (
      settings.collaborationMode === "team" &&
      summary.settings.collaborationMode !== "team" &&
      store.view().threadMeta[threadId]?.managedTeamToolsAvailable !== true
    ) {
      throw new ProjectConflictError(TEAM_SESSION_UPGRADE_MESSAGE);
    }
    if (
      settings.collaborationMode === "team" &&
      summary.settings.collaborationMode !== "team" &&
      (await readThreadGoal(bridge, threadId))
    ) {
      throw new ProjectConflictError("Team mode cannot be combined with a goal");
    }
    if (settings.collaborationMode === "team" && summary.settings.collaborationMode !== "team") {
      const resumeParams = {
        threadId,
        cwd: summary.cwd,
        excludeTurns: true,
        ...threadSettings(settings, projection.availableModels),
        ...(store.view().threadMeta[threadId]?.sessionArtifactsVersion === 1
          ? { developerInstructions: SESSION_ARTIFACT_INSTRUCTIONS }
          : {}),
        config:
          browserExtension?.runtimeConfig(threadId, teamRuntimeConfig()) ?? teamRuntimeConfig(),
      };
      try {
        await bridge.request<ThreadResumeResponse>("thread/resume", resumeParams, 30_000);
      } catch (error) {
        if (
          !projection.canMaterializeEmptySession(threadId) ||
          !(error instanceof RpcError) ||
          error.code !== -32_600 ||
          ![
            `no rollout found for thread id ${threadId}`,
            `invalid paginated history lineage for ${threadId}: missing source rollout`,
          ].includes(error.message)
        ) {
          throw error;
        }
        await projection.materializeEmptySession(threadId);
        await bridge.request<ThreadResumeResponse>("thread/resume", resumeParams, 30_000);
      }
    }
    const thread = await projection.setSettings(threadId, settings);
    if (patch.reasoningEffort !== undefined) {
      await projection.setDefaultReasoningEffort(settings.reasoningEffort);
    }
    return thread;
  };

  const startTurnUnlocked = async (
    threadId: string,
    input: string,
    images: string[],
    files: ThreadFileAttachment[],
    clientMessageId: string | null,
    goal = false,
    replyToAsyncQuestion?: AsyncQuestionReference,
    dismissUserInput?: AsyncQuestionReference,
    pastes: PastedText = {},
    planImplementationMode?: PlanImplementationMode,
  ): Promise<TurnStartResult> => {
    if (clientMessageId) {
      const receipt = store.view().messageReceipts?.[clientMessageId];
      if (receipt) {
        if (receipt.status === "canceled") {
          throw new MessageQueueConflictError("Message has been canceled");
        }
        if (
          receipt.threadId !== threadId ||
          receipt.contentHash !==
            messageContentHash(
              input,
              images,
              files,
              goal,
              replyToAsyncQuestion,
              dismissUserInput,
              pastes,
              planImplementationMode,
            )
        ) {
          throw new MessageQueueConflictError("Message id has already been used");
        }
        if (receipt.status !== "prepared" && receipt.status !== "rejected" && receipt.turnId) {
          return { turnId: receipt.turnId };
        }
      }
    }
    let summary = projection.summary(threadId);
    if (!summary) throw new MessageQueueNotFoundError("Thread not found");
    assertWritableThread(summary);
    const validatedFiles = await attachments.validate(threadId, files);
    assertDirectInput(summary);
    if (store.view().threadMeta[threadId]?.capacityRetry) {
      throw new MessageQueueConflictError("Model capacity retry is pending");
    }
    if (planImplementationMode) {
      try {
        summary = await updateThreadSettings(threadId, {
          collaborationMode: planImplementationMode === "team" ? "team" : "default",
        });
      } catch (error) {
        if (error instanceof ProjectConflictError || error instanceof ProjectValidationError) {
          throw new MessageQueueValidationError(error.message);
        }
        throw error;
      }
    }
    if (summary.settings.collaborationMode === "team") {
      const automaticContinuation =
        !clientMessageId && !input.trim() && !images.length && !validatedFiles.length;
      if (automaticContinuation && stoppedTeamParents.has(threadId)) {
        throw new TeamContinuationStoppedError();
      }
      if (!automaticContinuation) stoppedTeamParents.delete(threadId);
    }
    const shouldGenerateTitle =
      (!summary.preview.trim() || projection.isUnmaterialized(threadId)) &&
      !projection.hasExplicitName(threadId);
    if (
      summary.settings.collaborationMode === "team" &&
      store.view().threadMeta[threadId]?.managedTeamToolsAvailable !== true
    ) {
      throw new ProjectConflictError(TEAM_SESSION_UPGRADE_MESSAGE);
    }
    if (goal) {
      if (summary.settings.collaborationMode === "team") {
        throw new ProjectConflictError("Team mode cannot be combined with a goal");
      }
      if (summary.settings.collaborationMode === "plan") {
        summary = await projection.setSettings(threadId, {
          ...summary.settings,
          collaborationMode: "default",
        });
      }
      await setThreadGoal(bridge, threadId, { objective: input.trim(), status: "paused" });
    }
    const teamClaim =
      summary.settings.collaborationMode === "team"
        ? await claimTeamResults(store, threadId)
        : null;
    const teamMarkerId = teamClaim
      ? (clientMessageId ?? teamContinuationMarkerId(teamClaim.claimId))
      : null;
    const automaticTeamContinuation = Boolean(
      teamClaim && !input.trim() && !images.length && !validatedFiles.length,
    );
    const turnInput = automaticTeamContinuation ? TEAM_CONTINUATION_MARKER_TEXT : input;
    if (teamClaim && teamMarkerId) {
      await markTeamClaimDispatch(
        store,
        threadId,
        teamClaim.claimId,
        teamMarkerId,
        teamContinuationContext(store, threadId, teamClaim),
      );
    }
    let turnId: string;
    let acceptedTurn: Turn | undefined;
    try {
      const resume = async () => {
        const currentSummary = summary!;
        const resumed = await bridge.request<ThreadResumeResponse>(
          "thread/resume",
          {
            threadId,
            cwd: currentSummary.cwd,
            excludeTurns: true,
            ...threadSettings(currentSummary.settings, projection.availableModels),
            ...(store.view().threadMeta[threadId]?.sessionArtifactsVersion === 1
              ? { developerInstructions: SESSION_ARTIFACT_INSTRUCTIONS }
              : {}),
            ...runtimeConfigOverride(
              browserExtension,
              threadId,
              currentSummary.settings.collaborationMode === "team" ? teamRuntimeConfig() : {},
            ),
          },
          30_000,
        );
        summary = projection.upsertThread(resumed.thread, currentSummary.archived);
        assertDirectInput(summary);
      };
      const startParams = {
        threadId,
        clientUserMessageId: teamMarkerId ?? clientMessageId,
        input: skillAwareMessageInput(
          skillsByCwd.get(summary.cwd),
          turnInput,
          images,
          validatedFiles,
          goal,
          pastes,
        ),
        ...turnSettings(
          summary.settings,
          projection.availableModels,
          teamClaim ? teamContinuationContext(store, threadId, teamClaim) : undefined,
        ),
      };
      const send = async () => {
        const clientId = startParams.clientUserMessageId;
        if (!clientId) {
          const { turn } = parseTurnStart(await bridge.request<unknown>("turn/start", startParams));
          return { turnId: turn.id, turn };
        }
        return durableDelivery.send(
          threadId,
          clientId,
          messageContentHash(
            input,
            images,
            validatedFiles,
            goal,
            replyToAsyncQuestion,
            dismissUserInput,
            pastes,
            planImplementationMode,
          ),
          "turn/start",
          startParams,
          undefined,
          Object.keys(pastedText(pastes)).length ? trimPastedMessage(input, pastes) : undefined,
        );
      };
      let started: Awaited<ReturnType<typeof send>>;
      try {
        started = await send();
      } catch (error) {
        // Restore unloaded sessions only after an explicit rejection; ambiguous
        // sends still use durable replay or history reconciliation inside send().
        if (!isThreadResumeRequiredError(error, threadId)) throw error;
        await resume();
        started = await send();
      }
      if (!started.turnId) throw new DeliveryContractError("Codex не подтвердил ход сообщения.");
      turnId = started.turnId;
      acceptedTurn = started.turn;
    } catch (error) {
      if (teamClaim && teamMarkerId) {
        let recoveredTurnId: string | null;
        try {
          recoveredTurnId = await deliveredClientMessageTurnId(
            bridge,
            store,
            threadId,
            teamMarkerId,
          );
        } catch {
          // Keep the durable claim parked until bridge recovery can reconcile it.
          throw error;
        }
        if (recoveredTurnId) {
          turnId = recoveredTurnId;
        } else {
          await releaseTeamClaim(store, threadId, teamClaim.claimId);
          if (goal) await clearThreadGoal(bridge, threadId).catch(() => undefined);
          throw error;
        }
      } else {
        if (goal) await clearThreadGoal(bridge, threadId).catch(() => undefined);
        throw error;
      }
    }
    await projection.markMaterialized(threadId);
    if (acceptedTurn) await projection.restoreDeliveredTurn(threadId, acceptedTurn);
    if (clientMessageId) {
      projection.recordUserMessage(
        threadId,
        turnId,
        clientMessageId,
        input,
        images,
        validatedFiles.map(({ name, path }) => ({ name, path })),
      );
    }
    if (teamClaim) {
      await deliverTeamClaim(store, threadId, teamClaim.claimId, turnId);
      await recordTeamNotice(
        store,
        projection,
        threadId,
        turnId,
        teamClaim.results,
        clientMessageId,
      );
      projection.publishThreadState(threadId);
      scheduleTeamTasks(threadId);
    }
    if (shouldGenerateTitle) {
      scheduleThreadTitle(threadId, copyPastedMessage(input, pastes), summary);
    }
    if (!goal) return { turnId };
    try {
      await setThreadGoal(bridge, threadId, { status: "active" });
      return { turnId };
    } catch {
      return {
        turnId,
        goalWarning: "Первый ход начат, но цель осталась на паузе. Продолжите её вручную.",
      };
    }
  };
  const startTurn = (
    threadId: string,
    input: string,
    images: string[],
    files: ThreadFileAttachment[],
    clientMessageId: string | null,
    goal = false,
    replyToAsyncQuestion?: AsyncQuestionReference,
    dismissUserInput?: AsyncQuestionReference,
    pastes: PastedText = {},
    planImplementationMode?: PlanImplementationMode,
  ): Promise<TurnStartResult> => {
    return withKeyLock(turnStartLocks, threadId, async () => {
      const release = codexManager?.beginTurn();
      const run = () =>
        startTurnUnlocked(
          threadId,
          input,
          images,
          files,
          clientMessageId,
          goal,
          replyToAsyncQuestion,
          dismissUserInput,
          pastes,
          planImplementationMode,
        );
      const result =
        planImplementationMode === "team" ||
        projection.summary(threadId)?.settings.collaborationMode === "team"
          ? withKeyLock(teamParentLocks, threadId, run)
          : run();
      return result.finally(() => release?.());
    });
  };

  function getOrCreateProjectThread(
    projectId: string,
    clientCreationId: string,
  ): Promise<ThreadSummary> {
    const key = `${projectId}:${clientCreationId}`;
    const current = projectThreadCreations.get(key);
    if (current) return current;
    const request = (async () => {
      const previous = store.view().threadCreations?.[clientCreationId];
      if (previous && previous.projectId !== projectId)
        throw new ProjectConflictError("Creation id has already been used");
      if (previous?.threadId) {
        const existing = projection.summary(previous.threadId);
        if (existing) {
          if (projection.isUnmaterialized(existing.id)) {
            await projection.materializeEmptySession(existing.id);
          }
          return existing;
        }
      }
      codexManager?.assertTurnsAllowed();
      const project = store.view().projects.find((candidate) => candidate.id === projectId);
      if (!project) throw new ProjectNotFoundError("Project not found");
      const settings = projection.newSessionSettings;
      if (!previous) {
        const params = {
          clientCreationId,
          cwd: project.path,
          ...threadSettings(settings, projection.availableModels),
          developerInstructions: SESSION_ARTIFACT_INSTRUCTIONS,
          dynamicTools: ROOT_DYNAMIC_TOOLS,
          ...(settings.collaborationMode === "team" ? { config: teamRuntimeConfig() } : {}),
        };
        await store.update((state) => {
          state.threadCreations ??= {};
          state.threadCreations[clientCreationId] ??= {
            projectId,
            params,
            settings,
            threadId: null,
          };
        });
      }
      const prepared = store.view().threadCreations![clientCreationId]!;
      const response = await bridge.request<unknown>("thread/start", prepared.params);
      const started = parseThreadStart(response);
      if (bridge.deliveryVersion === 1)
        requireDeliveryReceipt(response, clientCreationId, started.thread.id);
      projection.upsertThread(started.thread);
      if (bridge.deliveryVersion !== 1) await projection.markUnmaterialized(started.thread.id);
      await store.update((state) => {
        state.threadCreations![clientCreationId]!.threadId = started.thread.id;
      });
      await markRootToolsAvailable(store, started.thread.id);
      if (bridge.deliveryVersion !== 1) {
        await projection.materializeEmptySession(started.thread.id);
      }
      // Both receivers now have a persisted empty thread before the first message.
      return projection.setSettings(started.thread.id, prepared.settings ?? settings);
    })().finally(() => {
      if (projectThreadCreations.get(key) === request) projectThreadCreations.delete(key);
    });
    projectThreadCreations.set(key, request);
    return request;
  }

  async function sendRecoveredFirstMessage(thread: ThreadSummary, messageId: string) {
    const draft = cloneView<ThreadDraft | null>(store.view().threadMeta[thread.id]?.draft ?? null);
    try {
      return {
        turnId: await queue.sendNow(thread.id, messageId),
        thread: projection.summary(thread.id)!,
      };
    } finally {
      // Accepting the first turn clears its composer draft. Restore the next,
      // unsent draft copied from the missing session without replacing newer edits.
      if (draft && !store.view().threadMeta[thread.id]?.draft) {
        await projection.setDraft(thread.id, draft, { expectedUpdatedAt: null });
      }
    }
  }

  async function recoverMissingFirstSession(source: ThreadSummary): Promise<ThreadSummary> {
    if (!source.projectId || !projection.canRecoverMissingFirstSession(source.id)) {
      throw new ProjectConflictError("The missing session cannot be recovered automatically");
    }
    const pending = cloneView<QueuedMessage[]>(store.view().messageQueues![source.id]!);
    const draft = cloneView<ThreadDraft | null>(store.view().threadMeta[source.id]?.draft ?? null);
    const thread = await getOrCreateProjectThread(source.projectId, `recover-first:${source.id}`);
    const target = await updateThreadSettings(thread.id, {
      ...source.settings,
      serviceTier: source.settings.serviceTier ?? null,
    });
    const copiedFiles = new Map<string, ThreadFileAttachment>();
    for (const file of [
      ...pending.flatMap((message) => message.files ?? []),
      ...(draft?.files ?? []),
    ]) {
      if (copiedFiles.has(file.id)) continue;
      await attachments.validate(source.id, [file]);
      copiedFiles.set(
        file.id,
        await attachments.save(
          target.id,
          file.name,
          file.mediaType,
          createReadStream(file.path),
          file.size,
        ),
      );
    }
    const copyFiles = (files: ThreadFileAttachment[] | undefined) =>
      files?.map((file) => copiedFiles.get(file.id)!);
    await store.update((state) => {
      if (
        !projection.canRecoverMissingFirstSession(source.id) ||
        JSON.stringify(state.messageQueues?.[source.id]) !== JSON.stringify(pending) ||
        JSON.stringify(state.threadMeta[source.id]?.draft ?? null) !== JSON.stringify(draft)
      ) {
        throw new ProjectConflictError("The saved message changed during recovery");
      }
      state.messageQueues![target.id] = pending.map((message) => ({
        ...message,
        threadId: target.id,
        files: copyFiles(message.files),
        deliveryError: undefined,
      }));
      state.messageQueues![source.id] = [];
      if (draft) state.threadMeta[target.id]!.draft = { ...draft, files: copyFiles(draft.files) };
      delete state.threadMeta[source.id]!.draft;
      for (const [id, receipt] of Object.entries(state.messageReceipts ?? {})) {
        if (receipt.threadId === source.id) delete state.messageReceipts![id];
      }
    });
    projection.publishQueue(source.id, []);
    projection.publishQueue(target.id, queue.list(target.id));
    return projection.summary(target.id)!;
  }

  browserExtension?.setLifecycle({
    enable: async (threadId) =>
      withKeyLock(turnStartLocks, threadId, async () => {
        const summary = projection.summary(threadId);
        if (!summary) throw new BrowserExtensionError("not_found", "Thread not found");
        assertBrowserWritable(summary, store);
        const meta = store.view().threadMeta[threadId];
        if (meta?.browserEnabled === true) return;
        if (!browserThreadIsIdle(summary)) {
          throw new BrowserExtensionError(
            "thread_busy",
            "Browser access cannot be enabled while the thread is busy",
          );
        }
        const staleBinding = meta?.browserBinding;
        const persist = async () => {
          await store.update((state) => {
            const current = state.threadMeta[threadId] ?? {
              pinned: false,
              lastReadUpdatedAt: 0,
            };
            if (staleBinding && current.browserBinding?.bindingId !== staleBinding.bindingId) {
              throw new BrowserExtensionError("conflict", "Browser binding changed");
            }
            current.browserEnabled = true;
            delete current.browserBinding;
            state.threadMeta[threadId] = current;
          });
        };
        if (!staleBinding) {
          await persist();
          return;
        }
        const baseConfig = summary.settings.collaborationMode === "team" ? teamRuntimeConfig() : {};
        await coldResumeThread(
          bridge,
          threadId,
          browserResumeParams(store, summary, projection.availableModels, baseConfig),
          browserResumeParams(
            store,
            summary,
            projection.availableModels,
            browserExtension.mcpConfig(staleBinding.bindingId, baseConfig),
          ),
          persist,
        );
      }),
    attach: async (instanceId, threadId, bindingId) =>
      withKeyLock(turnStartLocks, threadId, async () => {
        const summary = projection.summary(threadId);
        if (!summary) throw new BrowserExtensionError("not_found", "Thread not found");
        assertBrowserWritable(summary, store);
        const meta = store.view().threadMeta[threadId];
        if (meta?.browserEnabled !== true) {
          throw new BrowserExtensionError("not_enabled", "Browser access is not enabled");
        }
        if (!browserThreadIsIdle(summary)) {
          throw new BrowserExtensionError(
            "thread_busy",
            "Browser extension cannot attach while the thread is busy",
          );
        }
        const existing = meta.browserBinding;
        if (existing && existing.instanceId !== instanceId && existing.detachedAt === undefined) {
          throw new BrowserExtensionError(
            "owned_by_another_instance",
            "Browser binding belongs to another extension instance",
          );
        }
        const transferring = existing !== undefined && existing.instanceId !== instanceId;
        const effectiveBindingId = transferring ? bindingId : (existing?.bindingId ?? bindingId);
        const baseConfig = summary.settings.collaborationMode === "team" ? teamRuntimeConfig() : {};
        const baselineConfig = existing
          ? browserExtension.mcpConfig(existing.bindingId, baseConfig)
          : baseConfig;
        const browserConfig = browserExtension.mcpConfig(effectiveBindingId, baseConfig);
        const baseParams = browserResumeParams(
          store,
          summary,
          projection.availableModels,
          baselineConfig,
        );
        const browserParams = browserResumeParams(
          store,
          summary,
          projection.availableModels,
          browserConfig,
        );
        await coldResumeThread(bridge, threadId, browserParams, baseParams, async () => {
          await store.update((state) => {
            const meta = state.threadMeta[threadId];
            if (!meta) throw new BrowserExtensionError("not_found", "Thread not found");
            if (meta.browserEnabled !== true) {
              throw new BrowserExtensionError("not_enabled", "Browser access is not enabled");
            }
            const current = meta.browserBinding;
            if (
              (existing &&
                (current?.bindingId !== existing.bindingId ||
                  current.instanceId !== existing.instanceId)) ||
              (!existing && current)
            ) {
              throw new BrowserExtensionError("conflict", "Browser binding changed");
            }
            if (current && current.instanceId !== instanceId && current.detachedAt === undefined) {
              throw new BrowserExtensionError(
                "owned_by_another_instance",
                "Browser binding belongs to another extension instance",
              );
            }
            meta.browserBinding = {
              bindingId: effectiveBindingId,
              instanceId,
              attachedAt: Date.now(),
            };
          });
        });
        projection.publishThreadState(threadId);
        return projection.summary(threadId)!;
      }),
    disable: async (threadId) =>
      withKeyLock(turnStartLocks, threadId, async () => {
        const summary = projection.summary(threadId);
        if (!summary) throw new BrowserExtensionError("not_found", "Thread not found");
        assertBrowserWritable(summary, store);
        const meta = store.view().threadMeta[threadId];
        const binding = meta?.browserBinding;
        if (meta?.browserEnabled !== true && !binding) return;
        if (!browserThreadIsIdle(summary)) {
          throw new BrowserExtensionError(
            "thread_busy",
            "Browser access cannot be disabled while the thread is busy",
          );
        }
        if (!binding) {
          await store.update((state) => {
            const current = state.threadMeta[threadId];
            if (!current) return;
            delete current.browserEnabled;
            delete current.browserBinding;
          });
          return;
        }
        const baseConfig = summary.settings.collaborationMode === "team" ? teamRuntimeConfig() : {};
        const browserParams = browserResumeParams(
          store,
          summary,
          projection.availableModels,
          browserExtension.mcpConfig(binding.bindingId, baseConfig),
        );
        const baseParams = browserResumeParams(
          store,
          summary,
          projection.availableModels,
          baseConfig,
        );
        await coldResumeThread(bridge, threadId, baseParams, browserParams, async () => {
          await store.update((state) => {
            const meta = state.threadMeta[threadId];
            if (!meta?.browserBinding || meta.browserBinding.bindingId !== binding.bindingId) {
              throw new BrowserExtensionError("conflict", "Browser binding changed");
            }
            delete meta.browserEnabled;
            delete meta.browserBinding;
          });
        });
      }),
  });

  const pendingUserInput = (
    threadId: string,
    turnId: string,
    reference?: AsyncQuestionReference,
  ) => {
    for (const request of attention.list()) {
      if (
        request.kind === "userInput" &&
        (reference
          ? request.itemId === reference.itemId && request.turnId === reference.turnId
          : request.isBlocking !== false) &&
        request.threadId === threadId &&
        request.turnId === turnId
      ) {
        return request;
      }
    }
    return undefined;
  };

  const steerTurnUnlocked = async (
    threadId: string,
    turnId: string,
    input: string,
    images: string[],
    files: ThreadFileAttachment[],
    clientMessageId: string | null,
    replyToAsyncQuestion?: AsyncQuestionReference,
    replyToUserInput?: UserInputReply,
    dismissUserInput?: AsyncQuestionReference,
    pastes: PastedText = {},
  ): Promise<string> => {
    codexManager?.assertTurnsAllowed();
    const summary = projection.summary(threadId);
    if (!summary) throw new MessageQueueNotFoundError("Thread not found");
    assertDirectInput(summary);
    const validatedFiles = await attachments.validate(threadId, files);
    const structuredInput = skillAwareMessageInput(
      skillsByCwd.get(summary.cwd),
      input,
      images,
      validatedFiles,
      false,
      pastes,
    );
    const userInput = replyToAsyncQuestion
      ? undefined
      : pendingUserInput(threadId, turnId, replyToUserInput ?? dismissUserInput);
    const questionReply =
      replyToUserInput ??
      (userInput?.itemId
        ? {
            turnId,
            itemId: userInput.itemId,
            answers: {},
          }
        : undefined);
    const teamClaim =
      summary.settings.collaborationMode === "team"
        ? await claimTeamResults(store, threadId)
        : null;
    const teamMarkerId = teamClaim
      ? (clientMessageId ?? teamContinuationMarkerId(teamClaim.claimId))
      : null;
    if (teamClaim && teamMarkerId) {
      await markTeamClaimDispatch(
        store,
        threadId,
        teamClaim.claimId,
        teamMarkerId,
        teamContinuationContext(store, threadId, teamClaim),
      );
    }
    let resultTurnId: string;
    try {
      const params = {
        threadId,
        expectedTurnId: turnId,
        clientUserMessageId: teamMarkerId ?? clientMessageId,
        input: structuredInput,
        ...(questionReply && bridge.deliveryVersion === 1
          ? {
              userInputResponse: {
                itemId: questionReply.itemId,
                response: {
                  answers: Object.fromEntries(
                    Object.entries(questionReply.answers).map(([id, answers]) => [id, { answers }]),
                  ),
                },
              },
            }
          : {}),
        ...(teamClaim
          ? {
              additionalContext: {
                "codexnest.team.results": {
                  kind: "application",
                  value: teamContinuationContext(store, threadId, teamClaim),
                },
              },
            }
          : {}),
      };
      const clientId = params.clientUserMessageId;
      const result = clientId
        ? {
            turnId: (
              await durableDelivery.send(
                threadId,
                clientId,
                messageContentHash(
                  input,
                  images,
                  validatedFiles,
                  false,
                  replyToUserInput ?? replyToAsyncQuestion,
                  dismissUserInput,
                  pastes,
                ),
                "turn/steer",
                params,
                questionReply && bridge.deliveryVersion !== 1
                  ? async () => {
                      if (!userInput || userInput.itemId !== questionReply.itemId)
                        throw new RpcError(
                          -32602,
                          "Вопрос больше не ожидает ответа. Сообщение сохранено.",
                        );
                      const response: AttentionResponse = {
                        kind: "userInput",
                        answers: questionReply.answers,
                      };
                      // Accept the instruction before retiring the question, so a
                      // rejected steer leaves the form available for a retry.
                      if (!replyToUserInput) {
                        const steered = await bridge.request("turn/steer", params);
                        const resolved = attention.resolve(userInput.id, response);
                        if (resolved)
                          await projection.recordAttentionResponse(resolved, response, false);
                        return steered;
                      }
                      const resolved = attention.resolve(userInput.id, response);
                      if (!resolved) throw new RpcError(-32602, "Вопрос больше не ожидает ответа.");
                      await projection.recordAttentionResponse(resolved, response);
                      if (!images.length && !validatedFiles.length) return { turnId };
                      return bridge.request("turn/steer", params);
                    }
                  : undefined,
                Object.keys(pastedText(pastes)).length
                  ? trimPastedMessage(input, pastes)
                  : undefined,
              )
            ).turnId!,
          }
        : parseTurnSteer(await bridge.request("turn/steer", params));
      if (result.turnId !== turnId) {
        app.log.warn(
          { threadId, expectedTurnId: turnId, returnedTurnId: result.turnId },
          "turn/steer returned an unexpected turn ID",
        );
      }
      resultTurnId = result.turnId;
    } catch (error) {
      if (teamClaim && teamMarkerId) {
        let recoveredTurnId: string | null;
        try {
          recoveredTurnId = await deliveredClientMessageTurnId(
            bridge,
            store,
            threadId,
            teamMarkerId,
          );
        } catch {
          throw error;
        }
        if (recoveredTurnId) {
          resultTurnId = recoveredTurnId;
        } else {
          await releaseTeamClaim(store, threadId, teamClaim.claimId);
          throw error;
        }
      } else {
        throw error;
      }
    }
    if (
      bridge.deliveryVersion === 1 &&
      questionReply &&
      userInput &&
      userInput.itemId === questionReply.itemId
    ) {
      await projection.recordAttentionResponse(
        userInput,
        { kind: "userInput", answers: questionReply.answers },
        Boolean(replyToUserInput),
      );
      attention.expire(userInput.id);
    }
    if (clientMessageId) {
      projection.recordUserMessage(
        threadId,
        resultTurnId,
        clientMessageId,
        input,
        images,
        validatedFiles.map(({ name, path }) => ({ name, path })),
      );
    }
    if (teamClaim) {
      await deliverTeamClaim(store, threadId, teamClaim.claimId, resultTurnId);
      await recordTeamNotice(
        store,
        projection,
        threadId,
        resultTurnId,
        teamClaim.results,
        clientMessageId,
      );
      projection.publishThreadState(threadId);
      scheduleTeamTasks(threadId);
    }
    return resultTurnId;
  };
  const steerTurn = (
    threadId: string,
    turnId: string,
    input: string,
    images: string[],
    files: ThreadFileAttachment[],
    clientMessageId: string | null,
    replyToAsyncQuestion?: AsyncQuestionReference,
    replyToUserInput?: UserInputReply,
    dismissUserInput?: AsyncQuestionReference,
    pastes: PastedText = {},
  ): Promise<string> => {
    const run = () =>
      steerTurnUnlocked(
        threadId,
        turnId,
        input,
        images,
        files,
        clientMessageId,
        replyToAsyncQuestion,
        replyToUserInput,
        dismissUserInput,
        pastes,
      );
    return projection.summary(threadId)?.settings.collaborationMode === "team"
      ? withKeyLock(teamParentLocks, threadId, run)
      : run();
  };
  const queue = new MessageQueue(store, {
    get requiresDurableReceipt() {
      return bridge.deliveryVersion === 1;
    },
    paused: () => codexManager?.maintenanceActive ?? false,
    acceptsInput: (threadId) =>
      projection.summary(threadId)?.canAcceptDirectInput !== false &&
      !store.view().threadMeta[threadId]?.capacityRetry,
    currentTurnId: (threadId) => projection.summary(threadId)?.currentTurnId ?? null,
    shouldSteerQueuedMessage: (threadId, turnId) => Boolean(pendingUserInput(threadId, turnId)),
    start: (threadId, message) =>
      startTurn(
        threadId,
        message.text,
        message.images ?? [],
        message.files ?? [],
        message.id,
        message.goal ?? false,
        message.replyToAsyncQuestion,
        message.dismissUserInput,
        message,
        message.planImplementationMode,
      ).then((result) => result.turnId),
    steer: (threadId, turnId, message) =>
      steerTurn(
        threadId,
        turnId,
        message.text,
        message.images ?? [],
        message.files ?? [],
        message.id,
        message.replyToAsyncQuestion,
        message.replyToUserInput,
        message.dismissUserInput,
        message,
      ),
    deliveredTurnId: async (threadId, messageId, retryUnconfirmed = false) => {
      const receipt = store.view().messageReceipts?.[messageId];
      if (receipt?.threadId !== threadId) return null;
      let delivered;
      const retry = retryUnconfirmed && !projection.summary(threadId)?.currentTurnId;
      try {
        delivered = await durableDelivery.replay(messageId, retry);
      } catch (error) {
        if (!isThreadResumeRequiredError(error, threadId)) throw error;
        await bridge.request("thread/resume", { threadId, excludeTurns: true });
        delivered = await durableDelivery.replay(messageId, retry);
      }
      const message = store
        .view()
        .messageQueues?.[threadId]?.find((message) => message.id === messageId);
      if (delivered.turnId && message)
        projection.recordUserMessage(
          threadId,
          delivered.turnId,
          messageId,
          message.text,
          [...(message.images ?? [])],
          [...(message.files ?? [])],
        );
      return delivered.turnId;
    },
    publish: (threadId, messages) => projection.publishQueue(threadId, messages),
  });
  const forkOperationLocks = new Map<string, Promise<unknown>>();
  const forkOperationRuns = new Set<Promise<unknown>>();
  const forkOperationTimers = new Map<string, NodeJS.Timeout>();
  let forkOperationsClosed = false;
  const resolveForkRolloutPath = async (threadId: string): Promise<string | null> => {
    const cachedPath = projection.rolloutPath(threadId);
    if (cachedPath) return cachedPath;
    try {
      return parseThreadRead(
        await bridge.request<unknown>("thread/read", { threadId, includeTurns: false }, 30_000),
      ).thread.path;
    } catch (error) {
      app.log.warn(
        { err: safeError(error), threadId },
        "Failed to read the source rollout path for a fork",
      );
      return null;
    }
  };
  const publishForkOperation = (operationId: string): void =>
    projection.publishForkOperation(operationId);
  const removeReadyForkOperationsForThread = async (threadId: string): Promise<void> => {
    const operationIds = Object.values(store.view().forkOperations ?? {})
      .filter((operation) => operation.status === "ready" && operation.targetThreadId === threadId)
      .map((operation) => operation.id);
    if (!operationIds.length) return;
    await store.update((state) => {
      for (const operationId of operationIds) delete state.forkOperations?.[operationId];
    });
    for (const operationId of operationIds) projection.removeForkOperation(operationId);
  };
  const updateForkOperation = async (
    operationId: string,
    update: (operation: ForkOperationState) => void,
  ): Promise<void> => {
    await store.update((state) => {
      const operation = state.forkOperations?.[operationId];
      if (!operation) return;
      update(operation);
      operation.updatedAt = Date.now();
    });
    publishForkOperation(operationId);
  };
  const scheduleForkTitle = (operationId: string, target: Thread, agentText: string): void => {
    const operation = store.view().forkOperations?.[operationId];
    if (!operation) return;
    const temporaryTitle = operation.title;
    const pending = bridge
      .request("thread/name/set", { threadId: target.id, name: temporaryTitle }, 30_000)
      .catch(() => undefined)
      .then(async () => {
        if (!threadTitles || !agentText.trim()) return;
        const model = effectiveTitleModel(
          operation.sourceSettings,
          store.view().taskDefaults,
          projection.availableModels,
        );
        const title = await threadTitles.generate(agentText, {
          cwd: operation.sourceCwd,
          model: model?.id,
          effort: model?.reasoningEfforts[0]?.value,
        });
        await bridge.request("thread/name/set", { threadId: target.id, name: title }, 30_000);
        await updateForkOperation(operationId, (current) => {
          if (current.status === "ready") current.title = title;
        });
        projection.upsertThread({ ...target, name: title });
      })
      .catch((error: unknown) => {
        app.log.warn(
          { err: safeError(error), operationId, threadId: target.id },
          "Failed to generate fork title",
        );
      });
    void (lifecycle?.track(pending, "fork title generation") ?? pending);
  };
  const finishForkOperation = async (
    operationId: string,
    target: Thread,
    agentText: string,
  ): Promise<void> => {
    const observed = store.view().forkOperations?.[operationId];
    if (!observed || observed.status === "ready") return;
    const reconciliationTimer = forkOperationTimers.get(operationId);
    if (reconciliationTimer) clearTimeout(reconciliationTimer);
    forkOperationTimers.delete(operationId);
    projection.upsertThread({ ...target, name: observed.title });
    const sourceMeta = store.view().threadMeta[observed.sourceThreadId];
    const sourceSettings = cloneView<SessionSettings>(observed.sourceSettings);
    const pendingDraft = observed.draft
      ? cloneView<NonNullable<ForkOperationState["draft"]>>(observed.draft)
      : undefined;
    const pendingMessages = cloneView<QueuedMessage[]>(observed.queuedMessages);
    await store.update((state) => {
      const operation = state.forkOperations?.[operationId];
      if (!operation || operation.status === "ready") return;
      const now = Date.now();
      const targetMeta = state.threadMeta[target.id] ?? {
        pinned: false,
        lastReadUpdatedAt: 0,
      };
      targetMeta.settings = sourceSettings;
      targetMeta.lastOutcome = "completed";
      targetMeta.outcomeUpdatedAt = target.updatedAt * 1_000;
      targetMeta.logicalFork = {
        sourceThreadId: operation.sourceThreadId,
        operationId,
        mode: operation.mode,
      };
      if (sourceMeta?.managedTeamToolsAvailable === true)
        targetMeta.managedTeamToolsAvailable = true;
      if (sourceMeta?.sessionArtifactsVersion === 1) targetMeta.sessionArtifactsVersion = 1;
      if (pendingDraft) targetMeta.draft = pendingDraft;
      state.threadMeta[target.id] = targetMeta;
      if (pendingMessages.length) {
        state.messageQueues ??= {};
        state.messageQueues[target.id] = pendingMessages.map((message) => ({
          ...message,
          threadId: target.id,
          status: "queued" as const,
        }));
      }
      operation.draft = undefined;
      operation.queuedMessages = [];
      operation.agentText = agentText;
      operation.targetThreadId = target.id;
      operation.status = "ready";
      operation.error = null;
      operation.updatedAt = now;
    });
    projection.revealThread({ ...target, name: observed.title });
    publishForkOperation(operationId);
    projection.publishQueue(target.id, queue.list(target.id));
    void queue.drain(target.id).catch(() => undefined);
    scheduleForkTitle(operationId, target, agentText);
  };
  const scheduleForkReconciliation = (operationId: string, delayMs = 5_000): void => {
    if (forkOperationsClosed || forkOperationTimers.has(operationId)) return;
    const timer = setTimeout(
      () => {
        forkOperationTimers.delete(operationId);
        scheduleForkOperation(operationId);
      },
      Math.max(0, Math.min(delayMs, 2_147_000_000)),
    );
    timer.unref();
    forkOperationTimers.set(operationId, timer);
  };
  const scheduleForkAttemptSettlement = (operationId: string, startedAt: number): void => {
    scheduleForkReconciliation(
      operationId,
      Math.max(0, startedAt + FORK_ATTEMPT_SETTLE_MS - Date.now()),
    );
  };
  const compressedForkCompaction = (
    items: Record<string, unknown>[],
  ): { id: string | null; encryptedContent: string } => {
    const last = items.at(-1);
    if (!last) throw new ProjectValidationError("Compressed fork context is empty");
    if (last.type !== "compaction") {
      throw new ProjectValidationError("Compressed fork context does not end with compaction");
    }
    if (last.id !== undefined && (typeof last.id !== "string" || !last.id)) {
      throw new ProjectValidationError("Compressed fork compaction has an invalid item ID");
    }
    if (typeof last.encrypted_content !== "string") {
      throw new ProjectValidationError("Compressed fork compaction has no encrypted content");
    }
    return {
      id: typeof last.id === "string" ? last.id : null,
      encryptedContent: last.encrypted_content,
    };
  };
  const materializeCompressedFork = async (
    operationId: string,
    target: Thread,
    items: Record<string, unknown>[],
  ): Promise<boolean> => {
    const operation = store.view().forkOperations?.[operationId];
    if (!operation) return false;
    if (operation.compressedMaterialization?.phase === "injected") return true;
    const compaction = compressedForkCompaction(items);

    const startedAt = Date.now();
    await updateForkOperation(operationId, (current) => {
      current.status = "reconciling";
      current.compressedMaterialization = { phase: "injecting", startedAt };
    });
    try {
      await bridge.request(
        "thread/inject_items",
        { threadId: target.id, items },
        FORK_RPC_TIMEOUT_MS,
      );
    } catch (error) {
      const materialized = await hasForkMaterializedCompaction(
        target.path ?? (await resolveForkRolloutPath(target.id)),
        compaction,
      );
      if (!materialized) {
        if (error instanceof RpcTimeoutError) {
          scheduleForkAttemptSettlement(operationId, startedAt);
          return false;
        }
        throw error;
      }
    }
    await updateForkOperation(operationId, (current) => {
      current.compressedMaterialization = { phase: "injected", startedAt };
    });
    return true;
  };
  const waitForFreshCompaction = async (operationId: string, threadId: string): Promise<Turn> => {
    let settled = false;
    let compactTurnId: string | null = null;
    let turnPersistence = Promise.resolve();
    let resolveCompletion!: (turn: Turn) => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<Turn>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const finish = (turn?: Turn, error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) rejectCompletion(error);
      else if (turn) resolveCompletion(turn);
    };
    const persistTurn = (turn: Turn): Promise<void> => {
      if (compactTurnId === turn.id) return turnPersistence;
      compactTurnId = turn.id;
      turnPersistence = turnPersistence.then(() =>
        updateForkOperation(operationId, (current) => {
          if (current.compressedPreparation) {
            current.compressedPreparation.compactTurnId = turn.id;
          }
        }),
      );
      return turnPersistence;
    };
    const notificationHandler = (notification: ServerNotification) => {
      if (
        (notification.method === "turn/started" || notification.method === "turn/completed") &&
        notification.params.threadId === threadId
      ) {
        const turn = notification.params.turn;
        void persistTurn(turn)
          .then(() => {
            if (notification.method !== "turn/completed") return;
            if (turn.status === "completed") finish(turn);
            else {
              finish(
                undefined,
                new Error(turn.error?.message ?? `Native compaction ${turn.status}`),
              );
            }
          })
          .catch((error: unknown) =>
            finish(undefined, error instanceof Error ? error : new Error(String(error))),
          );
      } else if (
        notification.method === "error" &&
        notification.params.threadId === threadId &&
        !notification.params.willRetry
      ) {
        finish(undefined, new Error(notification.params.error.message));
      }
    };
    const stateHandler = (state: string) => {
      if (state !== "ready") finish(undefined, new BridgeUnavailableError(bridge.state));
    };
    bridge.on("notification", notificationHandler);
    bridge.on("state", stateHandler);
    const timer = setTimeout(
      () => finish(undefined, new RpcTimeoutError("thread/compact/start", FORK_RPC_TIMEOUT_MS)),
      FORK_RPC_TIMEOUT_MS,
    );
    timer.unref();
    try {
      const [, turn] = await Promise.all([
        bridge.request("thread/compact/start", { threadId }, FORK_RPC_TIMEOUT_MS),
        completion,
      ]);
      return turn;
    } finally {
      clearTimeout(timer);
      bridge.off("notification", notificationHandler);
      bridge.off("state", stateHandler);
    }
  };
  const readFreshCompactionTurn = async (
    operationId: string,
    preparation: NonNullable<ForkOperationState["compressedPreparation"]>,
  ): Promise<Turn | null> => {
    const page = parseTurnsList(
      await bridge.request<unknown>(
        "thread/turns/list",
        {
          threadId: preparation.temporaryThreadId,
          limit: 20,
          sortDirection: "desc",
          itemsView: "summary",
        },
        30_000,
      ),
    );
    const turn = preparation.compactTurnId
      ? page.data.find((candidate) => candidate.id === preparation.compactTurnId)
      : page.data.find(
          (candidate) =>
            candidate.startedAt !== null &&
            candidate.startedAt * 1_000 >= preparation.startedAt - 1_000,
        );
    if (turn && preparation.compactTurnId !== turn.id) {
      await updateForkOperation(operationId, (current) => {
        if (current.compressedPreparation) current.compressedPreparation.compactTurnId = turn.id;
      });
    }
    return turn ?? null;
  };
  const prepareFreshCompressedFork = async (
    operationId: string,
  ): Promise<Record<string, unknown>[] | null> => {
    const temporarySource = `codexnest-fork-temp:${operationId}`;
    let operation = store.view().forkOperations?.[operationId];
    if (!operation) return null;
    let preparation = operation.compressedPreparation;
    let temporary: Thread | null = null;
    if (preparation) {
      try {
        temporary = parseThreadRead(
          await bridge.request<unknown>(
            "thread/read",
            { threadId: preparation.temporaryThreadId, includeTurns: false },
            30_000,
          ),
        ).thread;
      } catch (error) {
        if (!isMissingThreadError(error)) throw error;
      }
      if (!temporary) {
        throw new ProjectValidationError("The temporary compact fork no longer exists");
      }
    } else {
      temporary = await findThreadBySource(bridge, temporarySource);
      if (!temporary) {
        if (
          operation.nativeAttempt &&
          Date.now() < operation.nativeAttempt.startedAt + FORK_ATTEMPT_SETTLE_MS
        ) {
          scheduleForkAttemptSettlement(operationId, operation.nativeAttempt.startedAt);
          return null;
        }
        const startedAt = Date.now();
        const sequence = (operation.nativeAttempt?.sequence ?? 0) + 1;
        await updateForkOperation(operationId, (current) => {
          current.status = "reconciling";
          current.error = null;
          current.nativeAttempt = { startedAt, sequence };
        });
        try {
          temporary = parseThreadStart(
            await bridge.request<unknown>(
              "thread/fork",
              {
                threadId: operation.sourceThreadId,
                lastTurnId: operation.lastTurnId,
                excludeTurns: true,
                serviceTier: sessionServiceTier(
                  operation.sourceSettings,
                  projection.availableModels,
                ),
                threadSource: temporarySource,
              },
              FORK_RPC_TIMEOUT_MS,
            ),
          ).thread;
        } catch (error) {
          temporary = await findThreadBySource(bridge, temporarySource);
          if (!temporary && error instanceof RpcTimeoutError) {
            scheduleForkAttemptSettlement(operationId, startedAt);
            return null;
          }
          if (!temporary) throw error;
        }
      }
      const rolloutPath = temporary.path ?? (await resolveForkRolloutPath(temporary.id));
      if (!rolloutPath) {
        throw new ProjectValidationError("The temporary compact fork rollout is unavailable");
      }
      const compactFromBytes = (await stat(rolloutPath)).size;
      await updateForkOperation(operationId, (current) => {
        current.compressedPreparation = {
          temporaryThreadId: temporary!.id,
          rolloutPath,
          compactFromBytes,
          phase: "ready",
          startedAt: 0,
          sequence: 0,
        };
        delete current.nativeAttempt;
      });
      operation = store.view().forkOperations?.[operationId];
      if (!operation?.compressedPreparation) return null;
      preparation = operation.compressedPreparation;
    }

    let items: Record<string, unknown>[] | null = null;
    if (preparation.phase === "compacted") {
      items = await readFreshCompaction(preparation.rolloutPath, preparation.compactFromBytes);
      if (!items) {
        throw new ProjectValidationError("The fresh compact context could not be recovered");
      }
    } else if (preparation.phase === "compacting") {
      let compactTurn: Turn | null;
      try {
        compactTurn = await readFreshCompactionTurn(operationId, preparation);
      } catch (error) {
        if (bridge.state !== "ready") {
          scheduleForkReconciliation(operationId);
          return null;
        }
        throw error;
      }
      if (!compactTurn) {
        if (temporary.status.type === "active") {
          scheduleForkReconciliation(operationId);
          return null;
        }
        if (Date.now() < preparation.startedAt + FORK_ATTEMPT_SETTLE_MS) {
          scheduleForkAttemptSettlement(operationId, preparation.startedAt);
          return null;
        }
        throw new ProjectValidationError("Native compaction completion could not be verified");
      }
      if (compactTurn.status === "inProgress") {
        scheduleForkReconciliation(operationId);
        return null;
      }
      if (compactTurn.status !== "completed") {
        throw new ProjectValidationError(
          compactTurn.error?.message ?? `Native compaction ${compactTurn.status}`,
        );
      }
      items = await readFreshCompaction(preparation.rolloutPath, preparation.compactFromBytes);
      if (!items) {
        throw new ProjectValidationError("Native compaction completed without fresh context");
      }
    }
    if (!items) {
      const startedAt = Date.now();
      const sequence = preparation.sequence + 1;
      await updateForkOperation(operationId, (current) => {
        if (!current.compressedPreparation) return;
        current.status = "reconciling";
        current.error = null;
        current.compressedPreparation.phase = "compacting";
        current.compressedPreparation.startedAt = startedAt;
        current.compressedPreparation.sequence = sequence;
        delete current.compressedPreparation.compactTurnId;
      });
      try {
        await waitForFreshCompaction(operationId, temporary.id);
      } catch (error) {
        if (
          error instanceof RpcTimeoutError ||
          error instanceof BridgeUnavailableError ||
          bridge.state !== "ready"
        ) {
          scheduleForkAttemptSettlement(operationId, startedAt);
          return null;
        }
        throw error;
      }
      items = await readFreshCompaction(preparation.rolloutPath, preparation.compactFromBytes);
      if (!items) {
        throw new ProjectValidationError("Native compaction completed without fresh context");
      }
    }
    const estimatedBytes = Buffer.byteLength(JSON.stringify(items));
    await updateForkOperation(operationId, (current) => {
      if (current.compressedPreparation) current.compressedPreparation.phase = "compacted";
      current.estimate = {
        ...freshCompressedForkEstimate(),
        estimatedBytes,
      };
    });
    return items;
  };
  const deleteTemporaryFork = async (operationId: string): Promise<void> => {
    const preparation = store.view().forkOperations?.[operationId]?.compressedPreparation;
    if (!preparation) return;
    try {
      await bridge.request("thread/delete", { threadId: preparation.temporaryThreadId }, 30_000);
    } catch (error) {
      if (!isMissingThreadError(error)) throw error;
    }
    await updateForkOperation(operationId, (current) => {
      delete current.compressedPreparation;
    });
  };
  const deleteForkOperationThreads = async (operation: {
    readonly targetThreadId: string | null;
    readonly compressedPreparation?: { readonly temporaryThreadId: string };
  }): Promise<void> => {
    const threadIds = [
      operation.compressedPreparation?.temporaryThreadId,
      operation.targetThreadId,
    ].filter((threadId): threadId is string => typeof threadId === "string");
    for (const threadId of new Set(threadIds)) {
      try {
        await bridge.request("thread/delete", { threadId }, 30_000);
      } catch (error) {
        if (!isMissingThreadError(error)) throw error;
      }
    }
    if (operation.targetThreadId) {
      await projection.removeOrphanedThread(operation.targetThreadId);
    }
  };
  const runForkOperation = async (operationId: string): Promise<void> => {
    const initial = store.view().forkOperations?.[operationId];
    if (!initial || initial.status === "ready" || initial.status === "failed") return;
    const sourceName = `codexnest-fork:${operationId}`;
    try {
      let target = await findThreadBySource(bridge, sourceName);
      let operation = store.view().forkOperations?.[operationId];
      if (!operation) return;
      if (!operation.rolloutPath) {
        const rolloutPath = await resolveForkRolloutPath(operation.sourceThreadId);
        if (rolloutPath) {
          await updateForkOperation(operationId, (current) => {
            current.rolloutPath = rolloutPath;
          });
          operation = store.view().forkOperations?.[operationId];
          if (!operation) return;
        }
      }
      if (
        target &&
        operation.mode === "compressed" &&
        operation.compressedMaterialization?.phase === "injected"
      ) {
        await deleteTemporaryFork(operationId);
        await finishForkOperation(operationId, target, operation.agentText);
        return;
      }
      if (!target && operation.mode === "compressed" && operation.compressedMaterialization) {
        await updateForkOperation(operationId, (current) => {
          current.targetThreadId = null;
          delete current.compressedMaterialization;
        });
        operation = store.view().forkOperations?.[operationId];
        if (!operation) return;
      }

      const point = await validateForkPoint(bridge, operation.sourceThreadId, operation.lastTurnId);
      if (operation.mode === "exact") {
        const rollout = await analyzeForkRollout(operation.rolloutPath, operation.lastTurnId);
        await updateForkOperation(operationId, (current) => {
          current.estimate = structuredClone(rollout.estimate.exact);
          current.agentText = point.text;
        });
        operation = store.view().forkOperations?.[operationId];
        if (!operation) return;
        if (
          !target &&
          operation.nativeAttempt &&
          Date.now() < operation.nativeAttempt.startedAt + FORK_ATTEMPT_SETTLE_MS
        ) {
          scheduleForkAttemptSettlement(operationId, operation.nativeAttempt.startedAt);
          return;
        }
        if (!target) {
          const attemptStartedAt = Date.now();
          const attemptSequence = (operation.nativeAttempt?.sequence ?? 0) + 1;
          await updateForkOperation(operationId, (current) => {
            current.status = "reconciling";
            current.error = null;
            current.nativeAttempt = {
              startedAt: attemptStartedAt,
              sequence: attemptSequence,
            };
          });
          try {
            target = parseThreadStart(
              await bridge.request<unknown>(
                "thread/fork",
                {
                  threadId: operation.sourceThreadId,
                  lastTurnId: operation.lastTurnId,
                  excludeTurns: true,
                  serviceTier: sessionServiceTier(
                    operation.sourceSettings,
                    projection.availableModels,
                  ),
                  threadSource: sourceName,
                },
                FORK_RPC_TIMEOUT_MS,
              ),
            ).thread;
          } catch (error) {
            target = await findThreadBySource(bridge, sourceName);
            if (!target && error instanceof RpcTimeoutError) {
              scheduleForkAttemptSettlement(operationId, attemptStartedAt);
              return;
            }
            if (!target) throw error;
          }
          await updateForkOperation(operationId, (current) => {
            current.targetThreadId = target!.id;
            delete current.nativeAttempt;
          });
        } else if (operation.nativeAttempt || operation.targetThreadId !== target.id) {
          await updateForkOperation(operationId, (current) => {
            current.targetThreadId = target!.id;
            delete current.nativeAttempt;
          });
        }
        await bridge
          .request("thread/goal/clear", { threadId: target.id }, 30_000)
          .catch(() => undefined);
        await finishForkOperation(operationId, target, point.text);
        return;
      }

      await updateForkOperation(operationId, (current) => {
        current.estimate = freshCompressedForkEstimate();
        current.agentText = point.text;
      });
      const compressedItems = await prepareFreshCompressedFork(operationId);
      if (!compressedItems) return;
      operation = store.view().forkOperations?.[operationId];
      if (!operation) return;
      if (target && operation.compressedMaterialization?.phase === "injecting") {
        const materialization = operation.compressedMaterialization;
        const materialized = await hasForkMaterializedCompaction(
          target.path ?? (await resolveForkRolloutPath(target.id)),
          compressedForkCompaction(compressedItems),
        );
        if (materialized) {
          await updateForkOperation(operationId, (current) => {
            current.targetThreadId = target!.id;
            current.compressedMaterialization = {
              phase: "injected",
              startedAt: materialization.startedAt,
            };
          });
          await deleteTemporaryFork(operationId);
          await finishForkOperation(operationId, target, operation.agentText);
          return;
        }
        if (Date.now() < materialization.startedAt + FORK_ATTEMPT_SETTLE_MS) {
          scheduleForkAttemptSettlement(operationId, materialization.startedAt);
          return;
        }
        try {
          await bridge.request("thread/delete", { threadId: target.id }, 30_000);
        } catch (error) {
          if (!isMissingThreadError(error)) throw error;
        }
        await projection.removeOrphanedThread(target.id);
        await updateForkOperation(operationId, (current) => {
          current.targetThreadId = null;
          delete current.compressedMaterialization;
          delete current.nativeAttempt;
        });
        target = null;
        operation = store.view().forkOperations?.[operationId];
        if (!operation) return;
      }
      if (
        !target &&
        operation.nativeAttempt &&
        Date.now() < operation.nativeAttempt.startedAt + FORK_ATTEMPT_SETTLE_MS
      ) {
        scheduleForkAttemptSettlement(operationId, operation.nativeAttempt.startedAt);
        return;
      }
      if (!target) {
        const attemptStartedAt = Date.now();
        const attemptSequence = (operation.nativeAttempt?.sequence ?? 0) + 1;
        await updateForkOperation(operationId, (current) => {
          current.status = "reconciling";
          current.error = null;
          current.nativeAttempt = {
            startedAt: attemptStartedAt,
            sequence: attemptSequence,
          };
        });
        try {
          target = parseThreadStart(
            await bridge.request<unknown>(
              "thread/start",
              {
                cwd: operation.sourceCwd,
                ...threadSettings(operation.sourceSettings, projection.availableModels),
                threadSource: sourceName,
                developerInstructions: SESSION_ARTIFACT_INSTRUCTIONS,
                dynamicTools: ROOT_DYNAMIC_TOOLS,
              },
              FORK_RPC_TIMEOUT_MS,
            ),
          ).thread;
        } catch (error) {
          target = await findThreadBySource(bridge, sourceName);
          if (!target && error instanceof RpcTimeoutError) {
            scheduleForkAttemptSettlement(operationId, attemptStartedAt);
            return;
          }
          if (!target) throw error;
        }
        await updateForkOperation(operationId, (current) => {
          current.targetThreadId = target!.id;
          delete current.nativeAttempt;
        });
      } else if (operation.nativeAttempt || operation.targetThreadId !== target.id) {
        await updateForkOperation(operationId, (current) => {
          current.targetThreadId = target!.id;
          delete current.nativeAttempt;
        });
      }
      if (!(await materializeCompressedFork(operationId, target, compressedItems))) return;
      await deleteTemporaryFork(operationId);
      await finishForkOperation(operationId, target, point.text);
    } catch (error) {
      const preparation = store.view().forkOperations?.[operationId]?.compressedPreparation;
      if (preparation) {
        await bridge
          .request("thread/delete", { threadId: preparation.temporaryThreadId }, 30_000)
          .catch((cleanupError: unknown) => {
            app.log.warn(
              { err: safeError(cleanupError), operationId },
              "Failed to delete a temporary compact fork",
            );
          });
      }
      await updateForkOperation(operationId, (operation) => {
        operation.status = "failed";
        operation.error = safeError(error).message;
      });
    }
  };
  const scheduleForkOperation = (operationId: string): void => {
    if (forkOperationsClosed || bridge.state !== "ready") return;
    const pending = withKeyLock(forkOperationLocks, operationId, () =>
      runForkOperation(operationId),
    );
    forkOperationRuns.add(pending);
    const cleanup = () => forkOperationRuns.delete(pending);
    void pending.then(cleanup, cleanup);
  };
  const recoverForkOperations = (): void => {
    for (const operation of Object.values(store.view().forkOperations ?? {})) {
      if (operation.status === "preparing" || operation.status === "reconciling") {
        scheduleForkOperation(operation.id);
      }
    }
  };
  const forkBridgeStateHandler = (state: string): void => {
    if (state === "ready") recoverForkOperations();
  };
  bridge.on("state", forkBridgeStateHandler);
  const initialForkRecovery = setImmediate(recoverForkOperations);
  app.addHook("onClose", async () => {
    forkOperationsClosed = true;
    clearImmediate(initialForkRecovery);
    for (const timer of forkOperationTimers.values()) clearTimeout(timer);
    forkOperationTimers.clear();
    bridge.off("state", forkBridgeStateHandler);
  });
  const scheduledTeamContinuations = new Set<string>();
  const scheduledTeamTaskStarts = new Set<string>();
  const teamContinuationImmediates = new Map<string, NodeJS.Immediate>();
  const teamTaskStartImmediates = new Map<string, NodeJS.Immediate>();
  const managedActivity = new Map<string, number>();
  const managedTokenUsage = new Map<string, { tokens: number; persistedAt: number }>();
  const teamBackgroundRuns = new Set<Promise<unknown>>();
  const deferredServerRequests = new Map<string, [ServerRequest, JsonlTransport]>();
  let teamNotificationQueue = Promise.resolve();
  let recoveryPromise: Promise<void> | undefined;
  let teamContinuationsClosed = false;
  let teamContinuationsPaused = false;
  const trackTeamBackground = <T>(promise: Promise<T>): Promise<T> => {
    teamBackgroundRuns.add(promise);
    const cleanup = () => teamBackgroundRuns.delete(promise);
    void promise.then(cleanup, cleanup);
    return lifecycle?.track(promise, "Team background run") ?? promise;
  };
  const capacityRetryTimers = new Map<string, NodeJS.Timeout>();
  const cancelCapacityRetry = async (threadId: string): Promise<void> => {
    const timer = capacityRetryTimers.get(threadId);
    if (timer) clearTimeout(timer);
    capacityRetryTimers.delete(threadId);
    await projection.cancelCapacityRetry(threadId, undefined, false);
  };
  const runCapacityRetry = async (threadId: string): Promise<void> => {
    const retry = store.view().threadMeta[threadId]?.capacityRetry;
    const summary = projection.summary(threadId);
    if (!retry || !summary || summary.archived || retry.nextAttemptAt > Date.now()) return;
    if (
      teamContinuationsClosed ||
      teamContinuationsPaused ||
      bridge.state !== "ready" ||
      codexManager?.maintenanceActive
    )
      return;
    const managed = managedTaskForChild(store.view(), threadId);
    if (managed && isTerminalTask(managed.task)) {
      await projection.cancelCapacityRetry(threadId, retry.failedTurnId);
      return;
    }
    const release = codexManager?.beginTurn();
    try {
      // Only the retry path reads history. It also recovers a start whose reply was lost.
      const page = parseTurnsList(
        await bridge.request<unknown>(
          "thread/turns/list",
          {
            threadId,
            limit: 1,
            sortDirection: "desc",
            itemsView: "full",
          },
          30_000,
        ),
      );
      const latest = page.data[0];
      if (
        store.view().threadMeta[threadId]?.capacityRetry?.failedTurnId !== retry.failedTurnId ||
        teamContinuationsPaused ||
        teamContinuationsClosed ||
        summary.archived
      )
        return;
      if (latest && latest.id !== retry.failedTurnId) {
        if (managed) {
          await store.update((state) => {
            const task =
              state.threadMeta[managed.parentThreadId]?.teamOrchestration?.tasks[managed.task.id];
            if (task && !isTerminalTask(task)) task.childTurnId = latest.id;
          });
        }
        await projection.restoreDeliveredTurn(threadId, latest);
        if (isCapacityFailure(latest) && retry.dispatching) {
          const goal = retry.goal ? await readThreadGoal(bridge, threadId) : null;
          const sameGoal =
            goal &&
            retry.goal &&
            goal.createdAt === retry.goal.createdAt &&
            goal.objective === retry.goal.objective;
          if (retry.goal && (!sameGoal || goal?.status !== "blocked")) {
            await projection.cancelCapacityRetry(threadId, latest.id);
            await projection.cancelCapacityRetry(threadId, retry.failedTurnId);
            return;
          }
          await projection.prepareCapacityRetry(threadId, latest, sameGoal ? goal : undefined);
        } else {
          await projection.cancelCapacityRetry(threadId, retry.failedTurnId);
          if (managed && latest.status !== "inProgress") {
            const affected = await handleManagedTeamNotification(
              {
                method: "turn/completed",
                params: { threadId, turn: latest },
              },
              bridge,
              store,
              projection,
              managedActivity,
              managedTokenUsage,
            );
            for (const parentThreadId of affected) {
              projection.publishThreadState(parentThreadId);
              scheduleTeamTasks(parentThreadId);
              scheduleTeamContinuation(parentThreadId);
            }
          }
        }
        return;
      }
      if (!latest || !isCapacityFailure(latest)) {
        await projection.cancelCapacityRetry(threadId, retry.failedTurnId);
        return;
      }
      if (summary.currentTurnId && summary.currentTurnId !== retry.failedTurnId) return;
      const parent = managed ? projection.summary(managed.parentThreadId) : summary;
      if (!parent) return;
      await store.update((state) => {
        const current = state.threadMeta[threadId]?.capacityRetry;
        if (current?.failedTurnId === retry.failedTurnId) current.dispatching = true;
      });
      if (retry.goal) {
        const goal = await readThreadGoal(bridge, threadId);
        if (
          !goal ||
          goal.createdAt !== retry.goal.createdAt ||
          goal.objective !== retry.goal.objective ||
          (goal.status !== "active" &&
            (goal.status !== "blocked" || goal.updatedAt !== retry.goal.updatedAt))
        ) {
          await projection.cancelCapacityRetry(threadId, retry.failedTurnId);
          return;
        }
        await bridge.request(
          "thread/resume",
          {
            threadId,
            cwd: summary.cwd,
            excludeTurns: true,
            ...threadSettings(summary.settings, projection.availableModels),
            ...runtimeConfigOverride(browserExtension, threadId, {}),
          },
          30_000,
        );
        if (store.view().threadMeta[threadId]?.capacityRetry?.failedTurnId !== retry.failedTurnId)
          return;
        // Reactivation starts the native goal continuation; do not also send turn/start.
        await setThreadGoal(bridge, threadId, { status: "active" });
        await projection.cancelCapacityRetry(threadId, retry.failedTurnId);
        return;
      }
      const runtime = managed
        ? await managedChildRuntime(
            managed.task,
            parent.cwd,
            managed.task.workspace
              ? cloneView<NonNullable<ManagedTeamTaskState["workspace"]>>(managed.task.workspace)
              : null,
          )
        : undefined;
      const settings = managed
        ? managedChildTurnSettings(
            parent.settings,
            projection.availableModels,
            managed.task,
            runtime,
          )
        : turnSettings(summary.settings, projection.availableModels);
      const markerId = capacityRetryMessageId(retry.failedTurnId);
      const params = {
        threadId,
        clientUserMessageId: markerId,
        input: messageInput(CAPACITY_RETRY_MESSAGE, []),
        ...settings,
      };
      const send = () =>
        durableDelivery.send(
          threadId,
          markerId,
          messageContentHash(CAPACITY_RETRY_MESSAGE, [], [], false),
          "turn/start",
          params,
        );
      if (store.view().threadMeta[threadId]?.capacityRetry?.failedTurnId !== retry.failedTurnId)
        return;
      let delivered: Awaited<ReturnType<typeof send>>;
      try {
        delivered = await send();
      } catch (error) {
        if (!isThreadResumeRequiredError(error, threadId)) throw error;
        await bridge.request(
          "thread/resume",
          {
            threadId,
            cwd: runtime?.cwd ?? summary.cwd,
            excludeTurns: true,
            ...(managed
              ? {
                  ...managedChildResumeSettings(
                    parent.settings,
                    projection.availableModels,
                    managed.task,
                  ),
                  ...(runtime?.runtimeWorkspaceRoots
                    ? { runtimeWorkspaceRoots: runtime.runtimeWorkspaceRoots }
                    : {}),
                  developerInstructions: TEAM_CHILD_INSTRUCTIONS,
                  config: teamRuntimeConfig(),
                }
              : {
                  ...threadSettings(summary.settings, projection.availableModels),
                  ...runtimeConfigOverride(
                    browserExtension,
                    threadId,
                    summary.settings.collaborationMode === "team" ? teamRuntimeConfig() : {},
                  ),
                }),
          },
          30_000,
        );
        if (store.view().threadMeta[threadId]?.capacityRetry?.failedTurnId !== retry.failedTurnId)
          return;
        delivered = await send();
      }
      if (managed && delivered.turnId) {
        await store.update((state) => {
          const task =
            state.threadMeta[managed.parentThreadId]?.teamOrchestration?.tasks[managed.task.id];
          if (task && !isTerminalTask(task)) {
            task.childTurnId = delivered.turnId!;
            task.lastActivityAt = Date.now();
            delete task.watchdog;
          }
        });
      }
      if (delivered.turn) await projection.restoreDeliveredTurn(threadId, delivered.turn);
      await projection.cancelCapacityRetry(threadId, retry.failedTurnId);
    } catch (error) {
      app.log.warn({ err: safeError(error), threadId }, "Failed to continue after model overload");
      if (error instanceof RpcError && !isTemporaryCapacityRpcError(error)) {
        await projection.cancelCapacityRetry(threadId, retry.failedTurnId);
      } else {
        await store.update((state) => {
          const current = state.threadMeta[threadId]?.capacityRetry;
          if (current?.failedTurnId === retry.failedTurnId) {
            current.nextAttemptAt = Date.now() + CAPACITY_RETRY_INTERVAL_MS;
            // A rejected command cannot have been accepted. An uncertain delivery
            // stays prepared and must still be reconciled before another start.
            const markerId = capacityRetryMessageId(retry.failedTurnId);
            const receipt = state.messageReceipts?.[markerId];
            if (receipt?.status === "rejected") delete state.messageReceipts![markerId];
          }
        });
        projection.publishThreadState(threadId);
      }
    } finally {
      release?.();
    }
  };
  const scheduleCapacityRetry = (threadId: string): void => {
    const retry = store.view().threadMeta[threadId]?.capacityRetry;
    const timer = capacityRetryTimers.get(threadId);
    if (!retry || teamContinuationsClosed) {
      if (timer) clearTimeout(timer);
      capacityRetryTimers.delete(threadId);
      return;
    }
    if (timer || teamContinuationsPaused || bridge.state !== "ready") return;
    const next = setTimeout(
      () => {
        capacityRetryTimers.delete(threadId);
        const managed = managedTaskForChild(store.view(), threadId);
        const run = () => runCapacityRetry(threadId);
        void trackTeamBackground(
          withKeyLock(turnStartLocks, threadId, () =>
            withKeyLock(teamParentLocks, managed?.parentThreadId ?? threadId, run),
          ),
        )
          .finally(async () => {
            // A busy or unloaded thread must not create a zero-delay retry loop.
            const pending = store.view().threadMeta[threadId]?.capacityRetry;
            if (
              pending &&
              pending.nextAttemptAt <= Date.now() &&
              !teamContinuationsClosed &&
              !teamContinuationsPaused
            ) {
              await store.update((state) => {
                const current = state.threadMeta[threadId]?.capacityRetry;
                if (current && current.nextAttemptAt <= Date.now()) {
                  current.nextAttemptAt = Date.now() + CAPACITY_RETRY_INTERVAL_MS;
                }
              });
              projection.publishThreadState(threadId);
            }
            scheduleCapacityRetry(threadId);
          })
          .catch(() => undefined);
      },
      Math.max(0, Math.min(retry.nextAttemptAt - Date.now(), 2_147_000_000)),
    );
    next.unref();
    capacityRetryTimers.set(threadId, next);
  };
  const resumeCapacityRetries = (): void => {
    for (const [threadId, meta] of Object.entries(store.view().threadMeta)) {
      if (meta.capacityRetry) scheduleCapacityRetry(threadId);
    }
  };
  const scheduleTeamContinuation = (threadId: string): void => {
    if (
      teamContinuationsClosed ||
      teamContinuationsPaused ||
      scheduledTeamContinuations.has(threadId)
    )
      return;
    scheduledTeamContinuations.add(threadId);
    const immediate = setImmediate(() => {
      teamContinuationImmediates.delete(threadId);
      void trackTeamBackground(
        (async () => {
          try {
            if (teamContinuationsClosed || teamContinuationsPaused) return;
            const summary = projection.summary(threadId);
            if (stoppedTeamParents.has(threadId)) {
              const tasks = Object.values(
                store.view().threadMeta[threadId]?.teamOrchestration?.tasks ?? {},
              );
              const hasPendingWorkspace = tasks.some(managedTaskHasPendingWorkspace);
              if (tasks.length && tasks.every(isTerminalTask) && !hasPendingWorkspace) {
                await store.update((state) => {
                  const meta = state.threadMeta[threadId];
                  if (meta) delete meta.teamOrchestration;
                });
                projection.publishThreadState(threadId);
              }
              return;
            }
            if (
              !summary ||
              summary.relation.kind !== "session" ||
              summary.currentTurnId ||
              summary.capacityRetry ||
              !hasPendingTeamContinuation(store, threadId)
            ) {
              return;
            }
            if (queue.count(threadId)) {
              await queue.drain(threadId);
              return;
            }
            await startTurn(threadId, "", [], [], null);
          } catch (error) {
            if (!(error instanceof TeamContinuationStoppedError)) {
              app.log.warn(
                { err: safeError(error), threadId },
                "Failed to continue Team orchestration",
              );
            }
          } finally {
            scheduledTeamContinuations.delete(threadId);
          }
        })(),
      );
    });
    teamContinuationImmediates.set(threadId, immediate);
  };
  const scheduleTeamTasks = (parentThreadId: string): void => {
    if (
      teamContinuationsClosed ||
      teamContinuationsPaused ||
      scheduledTeamTaskStarts.has(parentThreadId)
    )
      return;
    scheduledTeamTaskStarts.add(parentThreadId);
    const immediate = setImmediate(() => {
      teamTaskStartImmediates.delete(parentThreadId);
      void trackTeamBackground(
        withKeyLock(teamParentLocks, parentThreadId, async () => {
          try {
            if (teamContinuationsPaused) return;
            await startQueuedTeamTasks(bridge, store, projection, parentThreadId);
            projection.publishThreadState(parentThreadId);
            scheduleTeamContinuation(parentThreadId);
          } catch (error) {
            app.log.warn(
              { err: safeError(error), parentThreadId },
              "Failed to start managed Team task",
            );
          } finally {
            scheduledTeamTaskStarts.delete(parentThreadId);
          }
        }),
      );
    });
    teamTaskStartImmediates.set(parentThreadId, immediate);
  };
  const resumeTeamContinuations = (): void => {
    resumeCapacityRetries();
    for (const threadId of pendingTeamParents(store)) {
      scheduleTeamTasks(threadId);
      scheduleTeamContinuation(threadId);
    }
  };
  const teamNotificationHandler = (notification: ServerNotification) => {
    if (teamContinuationsPaused) return;
    if (
      notification.method === "turn/completed" &&
      Object.values(store.view().teamToolOperations ?? {}).some(
        (operation) =>
          operation.status === "applied" &&
          operation.threadId === notification.params.threadId &&
          operation.turnId === notification.params.turn.id,
      )
    ) {
      void pruneAppliedTeamToolOperations(
        store,
        notification.params.threadId,
        notification.params.turn.id,
      ).catch(() => undefined);
    }
    const childThreadId = notificationThreadId(notification);
    const managed = childThreadId
      ? managedTaskForNotification(store.view(), notification)
      : undefined;
    const capacityStartedTaskId =
      notification.method === "turn/started" &&
      childThreadId &&
      store.view().threadMeta[childThreadId]?.capacityRetry?.dispatching
        ? managed?.task.id
        : undefined;
    if (childThreadId && managed) {
      managedActivity.set(childThreadId, Date.now());
    }
    if (!isManagedTeamNotification(notification, store)) return;
    teamNotificationQueue = teamNotificationQueue
      .catch(() => undefined)
      .then(async () => {
        const run = () =>
          handleManagedTeamNotification(
            notification,
            bridge,
            store,
            projection,
            managedActivity,
            managedTokenUsage,
            capacityStartedTaskId,
          );
        const affected = managed
          ? await withKeyLock(teamParentLocks, managed.parentThreadId, run)
          : await run();
        for (const threadId of affected) {
          projection.publishThreadState(threadId);
          scheduleTeamTasks(threadId);
          scheduleTeamContinuation(threadId);
        }
      })
      .catch((error: unknown) => {
        app.log.warn({ err: safeError(error) }, "Failed to process Team orchestration event");
      });
  };
  const teamRequestHandler = (request: ServerRequest, transport: JsonlTransport) => {
    if (
      teamContinuationsPaused ||
      (lifecycle && lifecycle.state !== "ready" && lifecycle.state !== "draining")
    ) {
      deferredServerRequests.set(`${request.method}:${String(request.id)}`, [request, transport]);
      return;
    }
    if (request.method === "item/tool/call" && request.params.namespace === "codexnest") {
      if (request.params.tool === "publish_artifact") {
        const pending = withKeyLock(teamParentLocks, request.params.threadId, () =>
          handlePublishArtifact(request, store, projection),
        );
        void (lifecycle?.track(pending, "Artifact publication") ?? pending)
          .then((response) => transport.respond(request.id, response))
          .catch((error: unknown) => {
            try {
              transport.respond(request.id, dynamicToolError(safeError(error).message));
            } catch {
              // The caller disconnected before the response was delivered.
            }
          });
        return;
      }
      const operationKey = teamToolOperationKey(request);
      const caller = request.params.threadId;
      const parent =
        projection.summary(caller)?.relation.kind === "session"
          ? caller
          : managedTaskForChild(store.view(), caller)?.parentThreadId;
      const operation = () => handleManagedTeamToolCall(request, bridge, store, projection);
      const pending = withKeyLock(teamToolOperationLocks, operationKey, () =>
        parent ? withKeyLock(teamParentLocks, parent, operation) : operation(),
      );
      void (lifecycle?.track(pending, "Team tool operation") ?? pending)
        .then(async (response) => {
          try {
            transport.respond(request.id, response);
          } catch {
            // The durable receipt will answer the replay on the next connection.
            return;
          }
          if (parent) {
            scheduleTeamTasks(parent);
            projection.publishThreadState(parent);
          }
        })
        .catch(async (error: unknown) => {
          const response = dynamicToolError(safeError(error).message);
          if (isMutatingTeamTool(request.params.tool)) {
            await completeTeamToolOperation(store, operationKey, response).catch(() => undefined);
          }
          try {
            transport.respond(request.id, response);
          } catch {
            // A durable response, when persisted, will answer the replay.
          }
        });
      return;
    }
    try {
      attention.receive(request, transport);
    } catch {
      transport.respondError(request.id, -32_602, "Invalid request parameters");
    }
  };
  bridge.on("notification", teamNotificationHandler);
  bridge.on("request", teamRequestHandler);
  const teamWatchdogTimer = setInterval(() => {
    if (teamContinuationsPaused) return;
    teamNotificationQueue = teamNotificationQueue
      .catch(() => undefined)
      .then(async () => {
        const now = Date.now();
        const affected = await triggerTeamWatchdogs(store, managedActivity, now);
        for (const parentThreadId of affected) {
          projection.publishThreadState(parentThreadId);
          scheduleTeamContinuation(parentThreadId);
        }
      })
      .catch((error: unknown) => {
        app.log.warn({ err: safeError(error) }, "Failed to run Team watchdog");
      });
  }, 30_000);
  teamWatchdogTimer.unref();
  const bridgeTeamStateHandler = (state: string) => {
    if (state === "ready" || teamContinuationsClosed) return;
    teamContinuationsPaused = true;
    for (const timer of capacityRetryTimers.values()) clearTimeout(timer);
    capacityRetryTimers.clear();
    void queue.pause().catch(() => undefined);
  };
  bridge.on("state", bridgeTeamStateHandler);
  app.addHook("onClose", async () => {
    teamContinuationsClosed = true;
    teamContinuationsPaused = true;
    clearInterval(teamWatchdogTimer);
    for (const timer of capacityRetryTimers.values()) clearTimeout(timer);
    capacityRetryTimers.clear();
    clearImmediate(initialCapacityRecovery);
    for (const immediate of teamContinuationImmediates.values()) clearImmediate(immediate);
    for (const immediate of teamTaskStartImmediates.values()) clearImmediate(immediate);
    teamContinuationImmediates.clear();
    teamTaskStartImmediates.clear();
    deferredServerRequests.clear();
    managedTokenUsage.clear();
    scheduledTeamContinuations.clear();
    scheduledTeamTaskStarts.clear();
    bridge.off("state", bridgeTeamStateHandler);
    bridge.off("notification", teamNotificationHandler);
    bridge.off("request", teamRequestHandler);
    await queue.pause();
    await teamNotificationQueue;
    await recoveryPromise?.catch(() => undefined);
    await Promise.all(
      [
        ...teamBackgroundRuns,
        ...teamParentLocks.values(),
        ...teamToolOperationLocks.values(),
        ...turnStartLocks.values(),
      ].map((pending) => pending.catch(() => undefined)),
    );
  });
  let voiceTranscriptions: VoiceTranscriptionManager | null = null;
  voiceTranscriptions = services.transcription
    ? new VoiceTranscriptionManager({
        store,
        projection,
        transcription: services.transcription,
        queue,
        onWarning: (error, message) => app.log.warn({ err: safeError(error) }, message),
      })
    : null;
  if (voiceTranscriptions) {
    const wakeVoice = () => voiceTranscriptions?.wake();
    const wakeVoiceForAttention = (_sequence: number, event: ServerEvent) => {
      if (event.type === "attention.upserted") wakeVoice();
    };
    projection.on("event", wakeVoiceForAttention);
    projection.on("userInputVoiceChanged", wakeVoice);
    app.addHook("onClose", async () => {
      projection.off("event", wakeVoiceForAttention);
      projection.off("userInputVoiceChanged", wakeVoice);
    });
    void voiceTranscriptions.start().catch((error: unknown) => {
      app.log.error({ err: safeError(error) }, "Failed to start voice transcription worker");
    });
    app.addHook("onClose", async () => voiceTranscriptions?.stop());
  }
  projection.setMissingThreadCleanup(async (threadId) => {
    browserExtension?.forgetThread(threadId);
    await attachments.removeThread(threadId).catch((error: unknown) => {
      app.log.warn({ err: safeError(error), threadId }, "Failed to remove thread attachments");
    });
    if (voiceTranscriptions) {
      await voiceTranscriptions.cancelThread(threadId).catch((error: unknown) => {
        app.log.warn(
          { err: safeError(error), threadId },
          "Failed to cancel voice transcription for orphaned thread",
        );
      });
    }
  });

  let recoveryAgain = false;
  const runRecovery = (): Promise<void> => {
    if (recoveryPromise) {
      recoveryAgain = true;
      return recoveryPromise;
    }
    const pending = (async () => {
      do {
        recoveryAgain = false;
        if (lifecycle && lifecycle.state !== "ready" && lifecycle.state !== "draining") {
          lifecycle.recovering();
        }
        await queue.recover();
        await pruneCompletedTeamToolOperations(bridge, store);
        const threadIds = new Set<string>();
        const parentThreadIds = Object.entries(store.view().threadMeta)
          .filter(([, meta]) => Boolean(meta.teamOrchestration))
          .map(([threadId]) => threadId);
        for (const parentThreadId of parentThreadIds) {
          const reconciled = await withKeyLock(teamParentLocks, parentThreadId, () =>
            reconcileTeamOrchestration(bridge, store, projection, parentThreadId),
          );
          for (const threadId of reconciled) threadIds.add(threadId);
        }
        if (
          Object.values(store.view().threadMeta).some((meta) =>
            Object.values(meta.teamOrchestration?.tasks ?? {}).some(
              (task) => task.recoveryMisses === 1,
            ),
          )
        ) {
          recoveryAgain = true;
        }
        for (const threadId of threadIds) {
          projection.publishThreadState(threadId);
          if (!teamContinuationsPaused) {
            scheduleTeamTasks(threadId);
            scheduleTeamContinuation(threadId);
          }
        }
      } while (recoveryAgain && !teamContinuationsClosed);
      if (bridge.state === "ready" && lifecycle?.state !== "draining" && !teamContinuationsClosed) {
        teamContinuationsPaused = false;
        await queue.resume();
        resumeTeamContinuations();
        lifecycle?.ready();
        const deferred = [...deferredServerRequests.values()];
        deferredServerRequests.clear();
        for (const [request, transport] of deferred) teamRequestHandler(request, transport);
      }
    })()
      .catch((error: unknown) => {
        lifecycle?.failed();
        app.log.warn({ err: safeError(error) }, "Failed to reconcile durable runtime state");
        throw error;
      })
      .finally(() => {
        recoveryPromise = undefined;
      });
    recoveryPromise = lifecycle?.track(pending, "durable runtime recovery") ?? pending;
    return recoveryPromise;
  };

  const unregisterLifecycleParticipant = lifecycle?.register({
    pause: async () => {
      teamContinuationsPaused = true;
      for (const timer of capacityRetryTimers.values()) clearTimeout(timer);
      capacityRetryTimers.clear();
      await queue.pause();
      await teamNotificationQueue.catch(() => undefined);
      await Promise.all(
        [
          ...teamBackgroundRuns,
          ...teamParentLocks.values(),
          ...teamToolOperationLocks.values(),
          ...turnStartLocks.values(),
        ].map((pending) => pending.catch(() => undefined)),
      );
      await recoveryPromise?.catch(() => undefined);
    },
    resume: async () => {
      if (teamContinuationsClosed) return;
      await runRecovery().catch(() => undefined);
      teamContinuationsPaused = false;
      await queue.resume();
      const deferred = [...deferredServerRequests.values()];
      deferredServerRequests.clear();
      for (const [request, transport] of deferred) teamRequestHandler(request, transport);
      resumeTeamContinuations();
    },
  });

  projection.on("event", (_sequence, event) => {
    if (event.type === "resync.required") {
      void runRecovery().catch(() => undefined);
    } else if (event.type === "thread.upserted") {
      scheduleCapacityRetry(event.thread.id);
      void queue.drain(event.thread.id).catch(() => undefined);
      if (!event.thread.currentTurnId && event.thread.relation.kind === "session") {
        if (hasClaimedTeamContinuation(store, event.thread.id)) {
          // Recovery publishes thread state itself. An unresolved legacy claim
          // must not turn that publication into an endless recovery loop.
          if (!recoveryPromise) void runRecovery().catch(() => undefined);
        } else {
          scheduleTeamContinuation(event.thread.id);
        }
      }
    } else if (event.type === "thread.removed") {
      const timer = capacityRetryTimers.get(event.threadId);
      if (timer) clearTimeout(timer);
      capacityRetryTimers.delete(event.threadId);
      void queue.removeThread(event.threadId).catch(() => undefined);
      void removeReadyForkOperationsForThread(event.threadId).catch(() => undefined);
    }
  });

  const initialCapacityRecovery = setImmediate(resumeCapacityRetries);

  app.addHook("onClose", async () => {
    unregisterLifecycleParticipant?.();
  });

  if (lifecycle) {
    app.addHook("onRoute", (routeOptions) => {
      const methods = Array.isArray(routeOptions.method)
        ? routeOptions.method
        : [routeOptions.method];
      if (
        !routeOptions.url.startsWith("/api/v1/") ||
        !methods.some((method) => isTrackedMutation(method, routeOptions.url))
      ) {
        return;
      }
      const handler = routeOptions.handler;
      routeOptions.handler = function trackedMutationHandler(request, reply) {
        if (!isTrackedMutation(request.method, routeOptions.url)) {
          return handler.call(this, request, reply);
        }
        const pending = (async () => handler.call(this, request, reply))();
        return lifecycle.track(pending, `HTTP ${request.method} ${routeOptions.url}`);
      };
    });
  }
  app.addHook("onRequest", async (request, reply) => {
    if (!lifecycle || !request.url.startsWith("/api/v1/")) return;
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (!isTrackedMutation(request.method, pathname)) return;
    if (!lifecycle.acceptsMutations) {
      reply.header("Retry-After", "2");
      return apiError(
        reply,
        503,
        "app_server_unavailable",
        `CodexNest is ${lifecycle.state}; retry after recovery`,
      );
    }
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/v1/")) return;
    const parsed = new URL(request.url, "http://localhost");
    if (parsed.searchParams.has("token") || parsed.searchParams.has("access_token")) {
      return apiError(reply, 400, "validation_failed", "Token must not be passed in the URL");
    }
    if (
      request.method === "OPTIONS" ||
      parsed.pathname === "/api/v1/health" ||
      parsed.pathname.startsWith("/api/v1/internal/restart/") ||
      parsed.pathname.startsWith("/api/v1/internal/browser-mcp/") ||
      parsed.pathname === "/api/v1/events" ||
      parsed.pathname === "/api/v1/browser-extension/events"
    )
      return;
    const token = bearerToken(request);
    if (!token || !verifyToken(token, store.view().auth.tokenSha256)) {
      return apiError(reply, 401, "unauthorized", "Invalid or missing bearer token");
    }
  });

  app.get("/api/v1/health", async () => ({
    status:
      bridge.state === "ready" && (!lifecycle || lifecycle.state === "ready") ? "ok" : "degraded",
    serverVersion: SERVER_VERSION,
    recoveryState:
      lifecycle?.state ??
      (bridge.state === "ready" ? ("ready" as const) : ("unavailable" as const)),
    restartProtocolVersion: RESTART_RECOVERY_PROTOCOL_VERSION,
    transport: lifecycle?.transport ?? ("stdio" as const),
    appServer: {
      state: bridge.state,
      installedVersion: bridge.actualVersion ?? null,
      message: bridge.state === "ready" ? null : "Codex app-server is unavailable",
    },
  }));

  app.post("/api/v1/internal/restart/prepare", async (request, reply) => {
    if (!lifecycle) {
      return apiError(reply, 409, "conflict", "Restart coordination is unavailable");
    }
    if (!isLoopbackAddress(request.ip)) {
      return apiError(reply, 403, "forbidden", "Restart coordination is loopback-only");
    }
    const token = request.headers["x-codexnest-restart-token"];
    if (typeof token !== "string") {
      return apiError(reply, 403, "forbidden", "Restart token is required");
    }
    try {
      await lifecycle.prepare(token);
    } catch (error) {
      if (error instanceof RestartTokenError) {
        return apiError(reply, 403, "forbidden", error.message);
      }
      if (error instanceof RestartPreparationTimeoutError) {
        return apiError(reply, 503, "app_server_unavailable", error.message);
      }
      throw error;
    }
    const snapshot = store.view();
    const activeTurnCount = projection
      .snapshot()
      .threads.filter((thread) => thread.currentTurnId !== null).length;
    const hasManagedWork = Object.values(snapshot.threadMeta).some((meta) =>
      Object.values(meta.teamOrchestration?.tasks ?? {}).some(managedTeamTaskHasWork),
    );
    const hasDispatchingMessages = Object.values(snapshot.messageQueues ?? {}).some((messages) =>
      messages.some((message) => message.status === "dispatching"),
    );
    const hasQueuedMessages = Object.values(snapshot.messageQueues ?? {}).some(
      (messages) => messages.length > 0,
    );
    const pendingToolOperationCount = Object.values(snapshot.teamToolOperations ?? {}).filter(
      (operation) => operation.status === "prepared",
    ).length;
    const pendingAttentionCount = attention.list().length;
    const hasActiveVoiceTranscriptions = Object.values(snapshot.voiceTranscriptions ?? {}).some(
      (job) => ["queued", "transcribing", "applying"].includes(job.status),
    );
    return {
      restartProtocolVersion: RESTART_RECOVERY_PROTOCOL_VERSION,
      transport: lifecycle.transport,
      appServerReady: bridge.state === "ready",
      recoveryState: lifecycle.state,
      activeTurnCount,
      hasManagedWork,
      pendingToolOperationCount,
      pendingAttentionCount,
      hasDispatchingMessages,
      hasQueuedMessages,
      hasActiveVoiceTranscriptions,
      quiescent:
        activeTurnCount === 0 &&
        !hasManagedWork &&
        pendingToolOperationCount === 0 &&
        pendingAttentionCount === 0 &&
        !hasQueuedMessages &&
        !hasActiveVoiceTranscriptions,
    };
  });

  app.post("/api/v1/internal/restart/resume", async (request, reply) => {
    if (!lifecycle) {
      return apiError(reply, 409, "conflict", "Restart coordination is unavailable");
    }
    if (!isLoopbackAddress(request.ip)) {
      return apiError(reply, 403, "forbidden", "Restart coordination is loopback-only");
    }
    const token = request.headers["x-codexnest-restart-token"];
    if (typeof token !== "string") {
      return apiError(reply, 403, "forbidden", "Restart token is required");
    }
    try {
      await lifecycle.resume(token);
    } catch (error) {
      if (error instanceof RestartTokenError) {
        return apiError(reply, 403, "forbidden", error.message);
      }
      throw error;
    }
    return reply.code(204).send();
  });

  app.get("/api/v1/summary", async () => ({
    threadCount: projection.threadCount,
    projectCount: store.view().projects.length,
    pendingAttentionCount: attention.list().length,
    syncedAt: projection.lastSyncedAt,
  }));

  app.get<{
    Querystring: { cwd?: unknown; forceReload?: unknown } & Record<string, unknown>;
  }>("/api/v1/skills", async (request): Promise<SkillsCatalogResponse> => {
    const query = request.query;
    if (Object.keys(query).some((key) => !["cwd", "forceReload"].includes(key))) {
      throw new ProjectValidationError("Unknown skills query field");
    }
    if (typeof query.cwd !== "string" || !query.cwd) {
      throw new ProjectValidationError("cwd is required");
    }
    if (
      query.forceReload !== undefined &&
      query.forceReload !== "true" &&
      query.forceReload !== "false"
    ) {
      throw new ProjectValidationError("forceReload must be true or false");
    }
    assertSkillsCwdAllowed(query.cwd, store, projection);
    const entry = await listSkillsForCwd(bridge, query.cwd, query.forceReload === "true");
    skillsByCwd.set(query.cwd, entry);
    return publicSkillsCatalog(entry);
  });

  app.put<{ Body: UpdateSkillConfigRequest }>(
    "/api/v1/skills/config",
    async (request): Promise<UpdateSkillConfigResponse> => {
      const body = requireRecord<UpdateSkillConfigRequest>(request.body);
      if (Object.keys(body).some((key) => !["cwd", "path", "enabled"].includes(key))) {
        throw new ProjectValidationError("Unknown skill config field");
      }
      if (typeof body.cwd !== "string" || !body.cwd) {
        throw new ProjectValidationError("cwd is required");
      }
      if (typeof body.path !== "string" || !body.path) {
        throw new ProjectValidationError("path is required");
      }
      if (typeof body.enabled !== "boolean") {
        throw new ProjectValidationError("enabled must be boolean");
      }
      assertSkillsCwdAllowed(body.cwd, store, projection);
      const entry = skillsByCwd.get(body.cwd) ?? (await listSkillsForCwd(bridge, body.cwd, false));
      skillsByCwd.set(body.cwd, entry);
      const skill = entry.skills.find((candidate) => candidate.path === body.path);
      if (!skill) throw new ProjectNotFoundError("Skill not found");
      const result = parseSkillsConfigWrite(
        await bridge.request<unknown>("skills/config/write", {
          path: body.path,
          enabled: body.enabled,
        }),
      );
      skill.enabled = result.effectiveEnabled;
      return { path: body.path, enabled: result.effectiveEnabled };
    },
  );

  app.get("/api/v1/transcriptions/config", async (): Promise<TranscriptionConfigResponse> => {
    return withTranscriptionTiming(
      services.transcription?.configuration() ?? {
        providers: [],
        provider: null,
        localUrl: null,
        openAiApiKeyConfigured: false,
        openAiModel: "gpt-4o-transcribe",
        language: "ru",
        refineLocal: true,
        refinementModel: "gpt-5.6-luna",
        maxRecordingSeconds: 300,
        maxUploadBytes: MAX_TRANSCRIPTION_BYTES,
        timingEstimate: {
          sampleCount: 0,
          estimatedFixedProcessingMs: null,
          estimatedProcessingMsPerAudioSecond: null,
        },
      },
      store,
    );
  });

  app.put<{ Body: UpdateTranscriptionSettingsRequest }>(
    "/api/v1/settings/transcription",
    async (request): Promise<TranscriptionConfigResponse> => {
      if (!services.transcription) {
        throw new TranscriptionError("unavailable", "Transcription is not configured");
      }
      if (
        typeof request.body?.openAiApiKey === "string" &&
        request.protocol !== "https" &&
        !isLoopbackAddress(request.ip)
      ) {
        throw new TranscriptionError(
          "validation",
          "OpenAI API key can only be set over HTTPS or a local connection",
        );
      }
      return withTranscriptionTiming(
        await services.transcription.updateConfiguration(request.body),
        store,
      );
    },
  );

  app.post<{
    Body: Buffer;
  }>(
    "/api/v1/transcriptions",
    { bodyLimit: MAX_TRANSCRIPTION_BYTES },
    async (request, reply): Promise<TranscriptionResponse | undefined> => {
      if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
        return apiError(reply, 400, "validation_failed", "Audio body is required");
      }
      const contentType = request.headers["content-type"] ?? "";
      if (
        typeof contentType !== "string" ||
        !["audio/webm", "audio/mp4"].includes(normalizeAudioType(contentType))
      ) {
        return apiError(reply, 400, "validation_failed", "Audio must be WebM or MP4");
      }
      if (!services.transcription) {
        return apiError(reply, 503, "transcription_unavailable", "Transcription is not configured");
      }
      const audioDurationMs = parseAudioDurationHeader(
        request.headers["x-codexnest-audio-duration-ms"],
      );
      const config = withTranscriptionTiming(services.transcription.configuration(), store);
      const timingProfile = transcriptionTimingProfile(config);
      const startedAt = Date.now();
      const text = await services.transcription.transcribe(request.body, contentType);
      let timingEstimate = config.timingEstimate;
      if (audioDurationMs !== null && timingProfile) {
        const processingMs = Math.max(1, Date.now() - startedAt);
        try {
          const nextState = await store.update((state) => {
            state.transcriptionTimings ??= {};
            state.transcriptionTimings[timingProfile] = appendTranscriptionTimingSample(
              state.transcriptionTimings[timingProfile],
              { audioDurationMs, processingMs },
            );
          });
          timingEstimate = transcriptionTimingEstimate(
            nextState.transcriptionTimings?.[timingProfile],
          );
        } catch (error) {
          app.log.warn({ err: safeError(error) }, "Failed to save transcription timing");
        }
      }
      return { text, timingEstimate };
    },
  );

  app.post<{
    Params: { id: string };
    Querystring: {
      mode?: string;
      selectionStart?: string;
      selectionEnd?: string;
      draftUpdatedAt?: string;
      clientUploadId?: string;
      dismissUserInput?: string;
      userInput?: string;
    };
    Body: Buffer;
  }>(
    "/api/v1/threads/:id/voice-transcriptions",
    { bodyLimit: MAX_TRANSCRIPTION_BYTES },
    async (request, reply): Promise<VoiceTranscriptionJob | null | undefined> => {
      const summary = projection.summary(request.params.id);
      if (!summary) {
        return apiError(reply, 404, "not_found", "Thread not found");
      }
      assertWritableThread(summary);
      if (!voiceTranscriptions || !services.transcription) {
        return apiError(reply, 503, "transcription_unavailable", "Transcription is not configured");
      }
      if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
        return apiError(reply, 400, "validation_failed", "Audio body is required");
      }
      const normalizedType = normalizeAudioType(request.headers["content-type"] ?? "");
      if (normalizedType !== "audio/webm" && normalizedType !== "audio/mp4") {
        return apiError(reply, 400, "validation_failed", "Audio must be WebM or MP4");
      }
      if (!["draft", "send", "queue", "steer"].includes(request.query.mode ?? "")) {
        return apiError(reply, 400, "validation_failed", "Voice input mode is invalid");
      }
      let userInput: UserInputVoiceTarget | undefined;
      if (request.query.userInput !== undefined) {
        try {
          const target: unknown = JSON.parse(request.query.userInput);
          if (
            !isRecord(target) ||
            typeof target.draftKey !== "string" ||
            !/^[a-f\d]{64}$/iu.test(target.draftKey) ||
            typeof target.questionId !== "string" ||
            !target.questionId ||
            !Number.isSafeInteger(target.order) ||
            Number(target.order) < 1 ||
            request.query.mode !== "draft" ||
            request.query.dismissUserInput
          ) {
            throw new Error("Invalid voice target");
          }
          userInput = target as UserInputVoiceTarget;
        } catch {
          return apiError(reply, 400, "validation_failed", "Invalid question voice target");
        }
        const active = projection.userInputVoiceRequest(request.params.id, userInput.draftKey);
        if (
          !active ||
          !active.questions.some(
            (question) =>
              question.id === userInput!.questionId && (question.isOther || !question.options),
          )
        ) {
          return apiError(reply, 409, "conflict", "Question is no longer available");
        }
        await projection.ensureUserInputVoiceDraft(active);
      }
      let dismissUserInput: AsyncQuestionReference | undefined;
      if (request.query.dismissUserInput !== undefined) {
        try {
          dismissUserInput = validateDismissUserInput(JSON.parse(request.query.dismissUserInput));
        } catch {
          return apiError(reply, 400, "validation_failed", "Invalid user input dismissal");
        }
        if (request.query.mode === "draft") {
          return apiError(reply, 400, "validation_failed", "A draft cannot dismiss questions");
        }
      }
      const clientUploadId =
        request.query.clientUploadId === undefined
          ? undefined
          : optionalVoiceUploadId(request.query.clientUploadId);
      if (request.query.clientUploadId !== undefined && clientUploadId === null) {
        return apiError(reply, 400, "validation_failed", "Voice upload id is invalid");
      }
      if (clientUploadId) {
        const duplicate = voiceTranscriptions.duplicate(request.params.id, clientUploadId);
        if (duplicate !== undefined) {
          return duplicate ? reply.code(202).send(duplicate) : reply.code(204).send();
        }
      }
      const selectionStart = parseNonNegativeInteger(request.query.selectionStart);
      const selectionEnd = parseNonNegativeInteger(request.query.selectionEnd);
      if (selectionStart === null || selectionEnd === null || selectionEnd < selectionStart) {
        return apiError(reply, 400, "validation_failed", "Voice selection is invalid");
      }
      const expectedDraftUpdatedAt =
        request.query.draftUpdatedAt === "none"
          ? null
          : parseNonNegativeInteger(request.query.draftUpdatedAt);
      const currentDraft = store.view().threadMeta[request.params.id]?.draft;
      const currentDraftUpdatedAt = currentDraft?.updatedAt ?? null;
      if (
        !userInput &&
        (expectedDraftUpdatedAt === null
          ? request.query.draftUpdatedAt !== "none" || currentDraftUpdatedAt !== null
          : currentDraftUpdatedAt !== expectedDraftUpdatedAt)
      ) {
        return apiError(reply, 409, "draft_conflict", "The draft changed before voice upload");
      }
      const inputLength = currentDraft?.input.length ?? 0;
      if (!userInput && (selectionStart > inputLength || selectionEnd > inputLength)) {
        return apiError(reply, 400, "validation_failed", "Voice selection is outside the draft");
      }
      const audioDurationMs = parseAudioDurationHeader(
        request.headers["x-codexnest-audio-duration-ms"],
      );
      if (audioDurationMs === null) {
        return apiError(reply, 400, "validation_failed", "Audio duration is required");
      }
      const config = withTranscriptionTiming(services.transcription.configuration(), store);
      if (!config.provider || !config.providers.includes(config.provider)) {
        return apiError(reply, 503, "transcription_unavailable", "Transcription is not configured");
      }
      const accepted = await voiceTranscriptions.accept({
        ...(clientUploadId ? { clientUploadId } : {}),
        threadId: request.params.id,
        mode: request.query.mode as VoiceTranscriptionMode,
        ...(dismissUserInput ? { dismissUserInput } : {}),
        ...(userInput ? { userInput } : {}),
        audio: request.body,
        contentType: normalizedType,
        audioDurationMs,
        estimatedTotalSeconds: estimatedTranscriptionSeconds(config, audioDurationMs),
        selectionStart,
        selectionEnd,
        expectedDraftUpdatedAt,
        timingProfile: transcriptionTimingProfile(config),
      });
      return accepted ? reply.code(202).send(accepted) : reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/threads/:id/voice-transcriptions",
    async (request, reply) => {
      const summary = projection.summary(request.params.id);
      if (!summary) {
        return apiError(reply, 404, "not_found", "Thread not found");
      }
      assertWritableThread(summary);
      await voiceTranscriptions?.cancelThread(request.params.id);
      return reply.code(204).send();
    },
  );

  app.post<{
    Params: { id: string; draftKey: string };
    Body: { draft: UpdateUserInputDraftRequest; recordingIds: string[]; clientMessageId?: string };
  }>("/api/v1/threads/:id/user-input/:draftKey/submit", async (request, reply) => {
    const summary = projection.summary(request.params.id);
    if (!summary) return apiError(reply, 404, "not_found", "Thread not found");
    assertWritableThread(summary);
    const body = requireRecord<{
      draft: UpdateUserInputDraftRequest;
      recordingIds: string[];
      clientMessageId?: string;
    }>(request.body);
    const clientMessageId = optionalClientMessageId(body.clientMessageId);
    if (clientMessageId) {
      const receipt = store.view().messageReceipts?.[clientMessageId];
      const queued = store
        .view()
        .messageQueues?.[request.params.id]?.some(
          (message) => message.id === clientMessageId && message.replyToUserInput,
        );
      if (queued || (receipt?.threadId === request.params.id && receipt.status === "delivered"))
        return reply.code(202).send({ accepted: true });
    }
    const active = projection.userInputVoiceRequest(request.params.id, request.params.draftKey);
    if (!active) return apiError(reply, 409, "conflict", "Question is no longer available");
    if (!voiceTranscriptions)
      return apiError(reply, 503, "transcription_unavailable", "Transcription is not configured");
    if (
      !Array.isArray(body.recordingIds) ||
      body.recordingIds.some((id) => typeof id !== "string" || !optionalVoiceUploadId(id))
    ) {
      return apiError(reply, 400, "validation_failed", "Invalid recording ids");
    }
    await voiceTranscriptions.submitUserInput(
      request.params.id,
      request.params.draftKey,
      validateUserInputDraft(body.draft, active.questions),
      body.recordingIds,
    );
    return reply.code(202).send({ accepted: true });
  });
  app.delete<{ Params: { id: string; draftKey: string } }>(
    "/api/v1/threads/:id/user-input/:draftKey/submit",
    async (request, reply) => {
      const summary = projection.summary(request.params.id);
      if (!summary) return apiError(reply, 404, "not_found", "Thread not found");
      assertWritableThread(summary);
      await voiceTranscriptions?.cancelUserInputSubmission(
        request.params.id,
        request.params.draftKey,
      );
      return reply.code(204).send();
    },
  );
  app.post<{ Params: { id: string; jobId: string } }>(
    "/api/v1/threads/:id/voice-transcriptions/:jobId/retry",
    async (request, reply) => {
      const summary = projection.summary(request.params.id);
      if (!summary) return apiError(reply, 404, "not_found", "Thread not found");
      assertWritableThread(summary);
      await voiceTranscriptions?.retryUserInputRecording(request.params.id, request.params.jobId);
      return reply.code(202).send({ accepted: true });
    },
  );

  let rateLimitsRequest: Promise<CodexRateLimitsResponse> | undefined;
  let rateLimitsGeneration = 0;
  let rateLimitsClosed = false;
  let rateLimitsTimer: NodeJS.Timeout | undefined;
  const refreshRateLimits = (): Promise<CodexRateLimitsResponse> => {
    if (rateLimitsRequest) return rateLimitsRequest;
    if (rateLimitsClosed) return Promise.reject(new BridgeUnavailableError(bridge.state));
    const generation = ++rateLimitsGeneration;
    projection.setCodexRateLimits({
      ...projection.codexRateLimits,
      refreshing: true,
      refreshError: false,
    });
    rateLimitsRequest = bridge
      .request<unknown>("account/rateLimits/read", undefined)
      .then(parseAccountRateLimits)
      .then((limits) => {
        if (generation === rateLimitsGeneration) {
          projection.setCodexRateLimits({
            limits,
            updatedAt: Date.now(),
            refreshing: false,
            refreshError: false,
          });
        }
        return limits;
      })
      .catch((error: unknown) => {
        if (generation === rateLimitsGeneration) {
          projection.setCodexRateLimits({
            ...projection.codexRateLimits,
            refreshing: false,
            refreshError: true,
          });
        }
        throw error;
      })
      .finally(() => {
        if (generation === rateLimitsGeneration) rateLimitsRequest = undefined;
      });
    return rateLimitsRequest;
  };
  const pollRateLimits = () => {
    if (rateLimitsClosed || bridge.state !== "ready") return;
    void refreshRateLimits().catch((error: unknown) => {
      app.log.warn({ err: safeError(error) }, "Failed to refresh Codex rate limits");
    });
  };
  const rateLimitsBridgeStateHandler = (state: string) => {
    if (state === "ready") {
      pollRateLimits();
      return;
    }
    rateLimitsGeneration++;
    rateLimitsRequest = undefined;
    projection.setCodexRateLimits({
      ...projection.codexRateLimits,
      refreshing: false,
      refreshError: true,
    });
  };
  app.addHook("onReady", async () => {
    bridge.on("state", rateLimitsBridgeStateHandler);
    rateLimitsTimer = setInterval(pollRateLimits, 300_000);
    rateLimitsTimer.unref();
    pollRateLimits();
  });
  app.addHook("onClose", async () => {
    rateLimitsClosed = true;
    rateLimitsGeneration++;
    clearInterval(rateLimitsTimer);
    bridge.off("state", rateLimitsBridgeStateHandler);
  });
  app.get("/api/v1/codex/rate-limits", refreshRateLimits);

  app.get("/api/v1/settings/permissions", async () => readPermissionSettings(bridge));

  app.put<{ Body: UpdateGlobalPermissionSettingsRequest }>(
    "/api/v1/settings/permissions",
    async (request, reply) => {
      const body = validatePermissionSettings(request.body);
      const values = PERMISSION_PRESETS[body.preset];
      let writeResult: ConfigWriteResult;
      try {
        writeResult = parseConfigWriteResult(
          await bridge.request<unknown>(
            "config/batchWrite",
            compact({
              edits: [
                configEdit("sandbox_mode", values.sandboxMode),
                configEdit("approval_policy", values.approvalPolicy),
                configEdit("approvals_reviewer", values.approvalsReviewer),
              ],
              expectedVersion: body.expectedVersion ?? undefined,
              reloadUserConfig: true,
            }),
          ),
        );
      } catch (error) {
        if (isConfigVersionConflict(error)) {
          return apiError(
            reply,
            409,
            "conflict",
            "Codex configuration changed; reload settings and try again",
          );
        }
        throw error;
      }
      const effective = await readPermissionSettings(bridge);
      if (writeResult.status === "okOverridden") {
        effective.overridden = true;
        effective.message =
          writeResult.message ?? "A managed Codex configuration overrides this setting";
      }
      return effective;
    },
  );

  app.put<{ Body: UpdateTaskDefaultsRequest }>(
    "/api/v1/settings/task-defaults",
    async (request) => {
      const patch = validateTaskDefaults(request.body);
      const current = store.view().taskDefaults ?? {};
      const taskDefaults = mergeTaskDefaults(current, patch, projection.availableModels);
      await projection.setTaskDefaults(taskDefaults);
      return taskDefaults;
    },
  );

  app.put<{ Body: UpdateUiLanguageRequest }>(
    "/api/v1/settings/ui-language",
    async (request): Promise<UiLanguageSettings> => {
      const body = requireRecord<Record<string, unknown>>(request.body);
      if (
        Object.keys(body).some((key) => key !== "language") ||
        !["en", "ru"].includes(String(body.language))
      ) {
        throw new ProjectValidationError("language must be en or ru");
      }
      const language = body.language as UiLanguageSettings["language"];
      await projection.setUiLanguage(language);
      return { language };
    },
  );

  app.get("/api/v1/settings/codex", async (): Promise<CodexManagementStatus> => {
    return requireCodexManager(codexManager).status();
  });

  app.post("/api/v1/settings/codex/check", async (): Promise<CodexManagementStatus> => {
    return requireCodexManager(codexManager).check();
  });

  app.put<{ Body: UpdateCodexProxyRequest }>(
    "/api/v1/settings/codex/proxy",
    async (request): Promise<CodexManagementStatus> => {
      const body = requireRecord<UpdateCodexProxyRequest>(request.body);
      if (Object.keys(body).some((key) => key !== "proxy") || typeof body.proxy !== "string") {
        throw new CodexManagementError("validation", "proxy must be a string");
      }
      try {
        return await requireCodexManager(codexManager).applyProxy(body.proxy);
      } finally {
        await queue.resume();
        resumeTeamContinuations();
      }
    },
  );

  app.post("/api/v1/settings/codex/update", async (): Promise<CodexManagementStatus> => {
    try {
      return await requireCodexManager(codexManager).update();
    } finally {
      await queue.resume();
      resumeTeamContinuations();
    }
  });

  app.post("/api/v1/settings/codex/restart", async (): Promise<CodexManagementStatus> => {
    try {
      return await requireCodexManager(codexManager).restart();
    } finally {
      await queue.resume();
      resumeTeamContinuations();
    }
  });

  app.post("/api/v1/settings/codex/force-restart", async (): Promise<CodexManagementStatus> => {
    const manager = requireCodexManager(codexManager);
    try {
      return await manager.forceRestart();
    } finally {
      if (!manager.maintenanceActive) {
        await queue.resume();
        resumeTeamContinuations();
      }
    }
  });

  app.get("/api/v1/settings/app", async (): Promise<AppUpdateStatus> => {
    return requireAppManager(appManager).status();
  });

  app.post("/api/v1/settings/app/check", async (): Promise<AppUpdateStatus> => {
    return requireAppManager(appManager).check();
  });

  app.post("/api/v1/settings/app/update", async (): Promise<AppUpdateStatus> => {
    return requireAppManager(appManager).update();
  });

  app.post(
    "/api/v1/settings/app/force-restart",
    async (request, reply): Promise<ForceRestartAccepted> => {
      const result = await requireAppManager(appManager).forceRestart();
      return reply.code(202).send(result);
    },
  );

  app.get<{ Querystring: { path?: string } }>("/api/v1/directories", async (request) => {
    if (request.query.path !== undefined && typeof request.query.path !== "string") {
      throw new ProjectValidationError("path must be a string");
    }
    const listing = await listDirectories(request.query.path, services.projectRoot);
    if (!browserExtension) return listing;
    if (pathContains(browserExtension.captureRoot, listing.path)) {
      throw new ProjectForbiddenError("Browser capture storage cannot be used as a project");
    }
    return {
      ...listing,
      directories: listing.directories.filter(
        (directory) => resolve(directory.path) !== resolve(browserExtension.captureRoot),
      ),
    };
  });

  app.post<{ Body: CreateDirectoryRequest }>("/api/v1/directories", async (request, reply) => {
    const body = requireRecord<CreateDirectoryRequest>(request.body);
    if (typeof body.parentPath !== "string" || typeof body.name !== "string") {
      return apiError(reply, 400, "validation_failed", "parentPath and name are required");
    }
    return reply
      .code(201)
      .send(await createDirectory(body.parentPath, body.name, services.projectRoot));
  });

  app.post<{ Body: CreateProjectRequest }>("/api/v1/projects", async (request, reply) => {
    const body = requireRecord<CreateProjectRequest>(request.body);
    if (typeof body.path !== "string") {
      return apiError(reply, 400, "validation_failed", "path is required");
    }
    const canonical = await canonicalProjectPath(body.path, services.projectRoot);
    const existing = store.view().projects;
    assertUniqueProjectPath(existing, canonical);
    const project = createProject(body.path, canonical);
    await store.update((state) => {
      state.projects.push(project);
      restoreDismissedProjectPath(state, canonical);
    });
    projection.publishProject(project.id);
    return reply.code(201).send(project);
  });

  app.post<{ Params: { id: string }; Body: MoveProjectRequest }>(
    "/api/v1/projects/:id/move",
    async (request, reply) => {
      const body = requireRecord<MoveProjectRequest>(request.body);
      const hasDirection = body.direction !== undefined;
      const hasTargetIndex = body.targetIndex !== undefined;
      if (hasDirection === hasTargetIndex) {
        return apiError(
          reply,
          400,
          "validation_failed",
          "exactly one of direction or targetIndex is required",
        );
      }
      if (hasDirection && body.direction !== "up" && body.direction !== "down") {
        return apiError(reply, 400, "validation_failed", "direction must be up or down");
      }
      const currentProjects = store.view().projects;
      const index = currentProjects.findIndex((project) => project.id === request.params.id);
      if (index < 0) return apiError(reply, 404, "not_found", "Project not found");
      let targetIndex: number;
      if (hasTargetIndex) {
        if (
          typeof body.targetIndex !== "number" ||
          !Number.isInteger(body.targetIndex) ||
          body.targetIndex < 0
        ) {
          return apiError(
            reply,
            400,
            "validation_failed",
            "targetIndex must be a non-negative integer",
          );
        }
        targetIndex = body.targetIndex;
      } else {
        targetIndex = body.direction === "up" ? index - 1 : index + 1;
      }
      if (hasTargetIndex && targetIndex >= currentProjects.length) {
        return apiError(reply, 400, "validation_failed", "targetIndex is outside the project list");
      }
      if (targetIndex < 0 || targetIndex >= currentProjects.length) {
        return cloneView<Project[]>(currentProjects);
      }
      if (targetIndex === index) return cloneView<Project[]>(currentProjects);

      const updated = await store.update((state) => {
        const currentIndex = state.projects.findIndex(
          (project) => project.id === request.params.id,
        );
        if (currentIndex < 0) throw new ProjectNotFoundError("Project not found");
        const [project] = state.projects.splice(currentIndex, 1);
        state.projects.splice(targetIndex, 0, project!);
      });
      const projects = cloneView<Project[]>(updated.projects);
      projection.publishProjectsReordered(projects);
      return projects;
    },
  );

  app.delete<{ Params: { id: string } }>("/api/v1/projects/:id", async (request, reply) => {
    const project = store.view().projects.find((candidate) => candidate.id === request.params.id);
    if (!project) {
      return apiError(reply, 404, "not_found", "Project not found");
    }
    const hasActiveSessions = projection
      .snapshot()
      .threads.some(
        (thread) =>
          thread.projectId === project.id &&
          (thread.state === "running" ||
            thread.state === "needsAttention" ||
            thread.queuedMessageCount > 0),
      );
    if (hasActiveSessions) {
      return apiError(
        reply,
        409,
        "conflict",
        "Нельзя удалить проект, пока его сессии выполняются, ждут решения или содержат сообщения в очереди",
      );
    }
    await store.update((state) => {
      state.projects = state.projects.filter((candidate) => candidate.id !== project.id);
      if (state.projectDrafts) delete state.projectDrafts[project.id];
      state.dismissedProjectPaths = [
        ...new Set([...(state.dismissedProjectPaths ?? []), project.path]),
      ];
    });
    await attachments.removeThread(`project:${project.id}`);
    projection.removeProject(project.id);
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>("/api/v1/projects/:id/draft", async (request, reply) => {
    if (!store.view().projects.some((project) => project.id === request.params.id))
      return apiError(reply, 404, "not_found", "Project not found");
    return cloneView<ThreadDraft | null>(store.view().projectDrafts?.[request.params.id] ?? null);
  });

  app.put<{
    Params: { id: string };
    Querystring: { expectedUpdatedAt?: string };
    Body: { base: UpdateThreadDraftRequest; value: UpdateThreadDraftRequest };
  }>("/api/v1/projects/:id/draft", { bodyLimit: CHAT_BODY_LIMIT * 2 }, async (request, reply) => {
    if (!store.view().projects.some((project) => project.id === request.params.id))
      return apiError(reply, 404, "not_found", "Project not found");
    const base = validateThreadDraft(request.body?.base);
    const value = validateThreadDraft(request.body?.value);
    const expectedUpdatedAt = parseExpectedDraftRevision(request.query.expectedUpdatedAt);
    await attachments.validate(`project:${request.params.id}`, value.files ?? []);
    const updated = await store.update((state) => {
      const current = state.projectDrafts?.[request.params.id];
      if (expectedUpdatedAt !== undefined && (current?.updatedAt ?? null) !== expectedUpdatedAt) {
        throw new ThreadDraftConflictError("Project draft was updated elsewhere");
      }
      const merged = validateThreadDraft(
        mergeProjectDraft(
          current ?? { input: "", images: [], goalMode: false, annotations: [] },
          base,
          value,
        ),
      );
      (state.projectDrafts ??= {})[request.params.id] = {
        ...merged,
        updatedAt: Math.max(Date.now(), (current?.updatedAt ?? 0) + 1),
      };
    });
    const draft = cloneView<ThreadDraft>(updated.projectDrafts![request.params.id]!);
    projection.publishProjectDraft(request.params.id, draft);
    return draft;
  });

  app.post<{
    Params: { id: string };
    Querystring: { name?: string; mediaType?: string };
    Body: Readable;
  }>(
    "/api/v1/projects/:id/attachments",
    { bodyLimit: MAX_ATTACHMENT_BYTES },
    async (request, reply) => {
      if (!store.view().projects.some((project) => project.id === request.params.id))
        return apiError(reply, 404, "not_found", "Project not found");
      if (typeof request.query.name !== "string" || !request.query.name.trim())
        throw new AttachmentValidationError("File name is required");
      if (!request.body || typeof request.body[Symbol.asyncIterator] !== "function")
        throw new AttachmentValidationError("File body is required");
      const length = request.headers["content-length"];
      const saved = await attachments.save(
        `project:${request.params.id}`,
        request.query.name,
        request.query.mediaType ?? "application/octet-stream",
        request.body,
        typeof length === "string" && /^\d+$/u.test(length) ? Number(length) : undefined,
      );
      return reply.code(201).send(saved);
    },
  );

  app.post<{
    Params: { id: string };
    Body: { clientCreationId?: string; draft?: UpdateThreadDraftRequest };
  }>("/api/v1/projects/:id/threads", { bodyLimit: CHAT_BODY_LIMIT }, async (request, reply) => {
    if (!store.view().projects.some((project) => project.id === request.params.id)) {
      return apiError(reply, 404, "not_found", "Project not found");
    }
    const clientCreationId = request.body?.clientCreationId;
    if (
      typeof clientCreationId !== "string" ||
      !clientCreationId.trim() ||
      clientCreationId.length > 512
    ) {
      return apiError(reply, 400, "validation_failed", "A stable clientCreationId is required");
    }
    const submittedDraft =
      request.body?.draft === undefined ? null : validateThreadDraft(request.body.draft);
    if (submittedDraft)
      await attachments.validate(`project:${request.params.id}`, submittedDraft.files ?? []);
    const thread = await getOrCreateProjectThread(request.params.id, clientCreationId);
    if (submittedDraft && !store.view().threadMeta[thread.id]?.draft) {
      const files: ThreadFileAttachment[] = [];
      for (const file of submittedDraft.files ?? []) {
        files.push(
          await attachments.save(
            thread.id,
            file.name,
            file.mediaType,
            createReadStream(file.path),
            file.size,
          ),
        );
      }
      await projection.setDraft(thread.id, { ...submittedDraft, files });
    }

    const draft = cloneView<CreateProjectThreadResponse["draft"]>(
      store.view().threadMeta[thread.id]?.draft ?? null,
    );
    return reply.code(201).send({ thread, draft } satisfies CreateProjectThreadResponse);
  });

  app.get<{ Querystring: { q?: string; archived?: string; cursor?: string; scope?: string } }>(
    "/api/v1/threads/search",
    async (request) => {
      const { q, cursor } = validateSearchQuery(request.query);
      if (
        request.query.archived !== undefined &&
        request.query.archived !== "true" &&
        request.query.archived !== "false"
      )
        throw new ProjectValidationError("archived must be true or false");
      const scope = request.query.scope ?? "messages";
      if (scope !== "titles" && scope !== "messages")
        throw new ProjectValidationError("scope must be titles or messages");
      return projection.searchThreads(q, request.query.archived === "true", cursor, scope);
    },
  );
  app.get<{ Params: { id: string }; Querystring: { q?: string; cursor?: string } }>(
    "/api/v1/threads/:id/search",
    async (request) => {
      const { q, cursor } = validateSearchQuery(request.query);
      return projection.searchOccurrences(request.params.id, q, cursor);
    },
  );
  app.get<{ Params: { id: string; turnId: string }; Querystring: { cursor?: string } }>(
    "/api/v1/threads/:id/turns/:turnId",
    async (request) => {
      const cursor = validateSearchCursor(request.query.cursor);
      if (!cursor) throw new ProjectValidationError("A history cursor is required");
      return projection.readSearchTurn(request.params.id, request.params.turnId, cursor);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/threads/:id/reference",
    async (request, reply): Promise<SessionReference | undefined> => {
      const summary = projection.summary(request.params.id);
      if (!summary) return apiError(reply, 404, "not_found", "Thread not found");
      let historyPath = await existingSessionHistoryPath(projection.rolloutPath(summary.id));
      if (!historyPath) {
        try {
          const { thread } = parseThreadRead(
            await bridge.request<unknown>(
              "thread/read",
              { threadId: summary.id, includeTurns: false },
              30_000,
            ),
          );
          historyPath = await existingSessionHistoryPath(thread.path);
        } catch (error) {
          if (!isMissingThreadError(error)) throw error;
        }
      }
      return { threadId: summary.id, cwd: summary.cwd, historyPath };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { cursor?: string } }>(
    "/api/v1/threads/:id",
    async (request, reply) => {
      let observed = projection.summary(request.params.id);
      if (!observed) {
        observed = await projection.refreshThread(request.params.id);
      }
      if (!observed) return apiError(reply, 404, "not_found", "Thread not found");
      try {
        const cursor =
          typeof request.query.cursor === "string" && request.query.cursor.length > 0
            ? request.query.cursor
            : null;
        return await projection.readThread(request.params.id, cursor ?? {});
      } catch (error) {
        if (isMissingThreadError(error)) {
          return apiError(reply, 404, "not_found", "Session history is unavailable");
        }
        if (error instanceof ThreadViewUnavailableError) {
          return apiError(
            reply,
            503,
            "app_server_unavailable",
            "Session state is temporarily unavailable",
          );
        }
        throw error;
      }
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { cursor?: string; anchorTurnId?: string };
  }>(
    "/api/v1/threads/:id/history",
    async (request, reply): Promise<ThreadHistoryPage | undefined> => {
      const observed = projection.summary(request.params.id);
      if (!observed) return apiError(reply, 404, "not_found", "Thread not found");
      const { cursor, anchorTurnId } = request.query;
      if (
        typeof cursor !== "string" ||
        !cursor ||
        typeof anchorTurnId !== "string" ||
        !anchorTurnId
      ) {
        return apiError(reply, 400, "validation_failed", "A valid history anchor is required");
      }
      try {
        return await projection.readThreadHistory(request.params.id, cursor, anchorTurnId);
      } catch (error) {
        if (error instanceof ThreadHistoryConflictError) {
          return apiError(
            reply,
            409,
            "history_changed",
            "Session history changed; reload and retry",
          );
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/threads/:id/artifacts",
    async (request, reply): Promise<ThreadArtifactsResponse | undefined> => {
      let observed = projection.summary(request.params.id);
      if (!observed) observed = await projection.refreshThread(request.params.id);
      if (!observed) return apiError(reply, 404, "not_found", "Thread not found");
      const meta = store.view().threadMeta[request.params.id];
      if (observed.relation.kind !== "session" || meta?.sessionArtifactsVersion !== 1) {
        return { capability: "unavailable", artifacts: [] };
      }
      return {
        capability: "explicit",
        artifacts: await resolveSessionArtifacts(observed.cwd, meta.sessionArtifacts ?? []),
      };
    },
  );

  app.post<{ Params: { id: string } }>("/api/v1/threads/:id/refresh", async (request, reply) => {
    try {
      const observed = await projection.refreshThread(request.params.id, { requireFresh: true });
      if (!observed) return apiError(reply, 404, "not_found", "Thread not found");
      const detail = await projection.readThread(request.params.id, { refresh: true });
      return { snapshot: projection.snapshot(), detail } satisfies RefreshThreadResponse;
    } catch (error) {
      if (error instanceof ThreadViewUnavailableError) {
        return apiError(
          reply,
          503,
          "app_server_unavailable",
          "Session state is temporarily unavailable",
        );
      }
      throw error;
    }
  });

  app.get<{ Params: { id: string; turnId: string } }>(
    "/api/v1/threads/:id/turns/:turnId/items",
    async (request, reply): Promise<TurnItemsResponse | undefined> => {
      let observed = projection.summary(request.params.id);
      if (!observed) observed = await projection.refreshThread(request.params.id);
      if (!observed) return apiError(reply, 404, "not_found", "Thread not found");
      return projection.readTurnItems(request.params.id, request.params.turnId);
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: {
      cursor?: string;
      anchorTurnId?: string;
      anchorRevision?: string;
      continuationCursor?: string;
    };
  }>("/api/v1/threads/:id/changes", async (request, reply): Promise<ThreadChanges | undefined> => {
    const { cursor, anchorTurnId, anchorRevision, continuationCursor } = request.query;
    if (
      typeof cursor !== "string" ||
      !cursor ||
      typeof anchorTurnId !== "string" ||
      !anchorTurnId ||
      typeof anchorRevision !== "string" ||
      !anchorRevision ||
      (continuationCursor !== undefined &&
        (typeof continuationCursor !== "string" || !continuationCursor))
    ) {
      return apiError(reply, 400, "validation_failed", "A valid thread sync point is required");
    }
    let observed = projection.summary(request.params.id);
    if (!observed) observed = await projection.refreshThread(request.params.id);
    if (!observed) return apiError(reply, 404, "not_found", "Thread not found");
    try {
      const detail = await projection.readThread(request.params.id, { refresh: true });
      return {
        summary: detail.summary,
        turns: detail.turns,
        queuedMessages: detail.queuedMessages,
        draft: detail.draft ?? null,
        continuationCursor: null,
        syncPoint: null,
        resetLatest: true,
        olderTurnsCursor: detail.olderTurnsCursor,
      };
    } catch (error) {
      if (error instanceof ThreadViewUnavailableError) {
        return apiError(
          reply,
          503,
          "app_server_unavailable",
          "Session state is temporarily unavailable",
        );
      }
      throw error;
    }
  });

  app.put<{
    Params: { id: string };
    Querystring: { expectedUpdatedAt?: string };
    Body: UpdateThreadDraftRequest;
  }>("/api/v1/threads/:id/draft", { bodyLimit: CHAT_BODY_LIMIT }, async (request, reply) => {
    const summary = projection.summary(request.params.id);
    if (!summary) {
      return apiError(reply, 404, "not_found", "Thread not found");
    }
    assertWritableThread(summary);
    if (voiceTranscriptions?.active(request.params.id)) {
      return apiError(
        reply,
        409,
        "conflict",
        "The composer is locked while voice transcription is active",
      );
    }
    let expectedUpdatedAt: number | null | undefined;
    if (request.query.expectedUpdatedAt !== undefined) {
      expectedUpdatedAt =
        request.query.expectedUpdatedAt === "none"
          ? null
          : (parseNonNegativeInteger(request.query.expectedUpdatedAt) ?? undefined);
      if (expectedUpdatedAt === undefined) {
        return apiError(reply, 400, "validation_failed", "Draft revision is invalid");
      }
    }
    const draft = validateThreadDraft(request.body);
    try {
      const saved = await projection.setDraft(
        request.params.id,
        draft,
        expectedUpdatedAt === undefined ? undefined : { expectedUpdatedAt },
      );
      await voiceTranscriptions?.clearFailure(request.params.id);
      return saved;
    } catch (error) {
      if (error instanceof ThreadDraftConflictError) {
        return apiError(reply, 409, "draft_conflict", error.message);
      }
      throw error;
    }
  });

  app.post<{
    Params: { id: string };
    Querystring: { name?: string; mediaType?: string };
    Body: Readable;
  }>(
    "/api/v1/threads/:id/attachments",
    { bodyLimit: MAX_ATTACHMENT_BYTES },
    async (request, reply) => {
      const summary = projection.summary(request.params.id);
      if (!summary) return apiError(reply, 404, "not_found", "Thread not found");
      assertWritableThread(summary);
      if (typeof request.query.name !== "string" || !request.query.name.trim()) {
        throw new AttachmentValidationError("File name is required");
      }
      const contentLengthHeader = request.headers["content-length"];
      const contentLength =
        typeof contentLengthHeader === "string" && /^\d+$/u.test(contentLengthHeader)
          ? Number(contentLengthHeader)
          : undefined;
      const body = request.body;
      if (!body || typeof body[Symbol.asyncIterator] !== "function") {
        throw new AttachmentValidationError("File body is required");
      }
      const saved = await attachments.save(
        request.params.id,
        request.query.name,
        request.query.mediaType ?? "application/octet-stream",
        body,
        contentLength,
      );
      return reply.code(201).send(saved);
    },
  );

  app.delete<{ Params: { id: string; attachmentId: string } }>(
    "/api/v1/threads/:id/attachments/:attachmentId",
    async (request, reply) => {
      const summary = projection.summary(request.params.id);
      if (!summary) return apiError(reply, 404, "not_found", "Thread not found");
      assertWritableThread(summary);
      await attachments.remove(request.params.id, request.params.attachmentId);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { id: string } }>("/api/v1/threads/:id/goal", async (request, reply) => {
    if (!projection.summary(request.params.id)) {
      return apiError(reply, 404, "not_found", "Thread not found");
    }
    return readThreadGoal(bridge, request.params.id);
  });

  app.patch<{ Params: { id: string }; Body: UpdateThreadGoalRequest }>(
    "/api/v1/threads/:id/goal",
    async (request, reply) => {
      const summary = projection.summary(request.params.id);
      if (!summary) {
        return apiError(reply, 404, "not_found", "Thread not found");
      }
      assertWritableThread(summary);
      if (summary.settings.collaborationMode === "team") {
        throw new ProjectConflictError("Team mode cannot be combined with a goal");
      }
      const patch = validateGoalPatch(request.body);
      await cancelCapacityRetry(request.params.id);
      return setThreadGoal(bridge, request.params.id, patch);
    },
  );

  app.delete<{ Params: { id: string } }>("/api/v1/threads/:id/goal", async (request, reply) => {
    const summary = projection.summary(request.params.id);
    if (!summary) {
      return apiError(reply, 404, "not_found", "Thread not found");
    }
    assertWritableThread(summary);
    await cancelCapacityRetry(request.params.id);
    await clearThreadGoal(bridge, request.params.id);
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string } }>(
    "/api/v1/threads/:id/browser-binding",
    async (request, reply) => {
      if (!browserExtension) {
        return apiError(reply, 503, "app_server_unavailable", "Browser extension is unavailable");
      }
      await browserExtension.detachThread(request.params.id);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { id: string } }>("/api/v1/threads/:id/git-changes", async (request, reply) => {
    const summary = projection.summary(request.params.id);
    if (!summary) return apiError(reply, 404, "not_found", "Thread not found");
    return readGitChanges(summary.cwd);
  });

  app.post<{ Params: { id: string }; Body: { path?: unknown } }>(
    "/api/v1/threads/:id/downloads",
    async (request, reply) => {
      const summary = projection.summary(request.params.id);
      if (!summary) return apiError(reply, 404, "not_found", "Thread not found");
      const body = requireRecord<{ path?: unknown }>(request.body);
      if (Object.keys(body).some((key) => key !== "path") || typeof body.path !== "string") {
        return apiError(reply, 400, "validation_failed", "path is required");
      }
      const file =
        (await attachments.resolveDownload(request.params.id, body.path)) ??
        (await resolveDownloadFile(
          body.path,
          summary.cwd,
          projection.hasToolImagePath(request.params.id, body.path),
        ));
      const now = Date.now();
      removeExpiredDownloadTickets(downloadTickets, now);
      while (downloadTickets.size >= MAX_DOWNLOAD_TICKETS) {
        const oldest = downloadTickets.keys().next().value as string | undefined;
        if (!oldest) break;
        downloadTickets.delete(oldest);
      }
      const ticket = randomBytes(24).toString("base64url");
      const expiresAt = now + DOWNLOAD_TICKET_TTL_MS;
      downloadTickets.set(ticket, {
        root: file.root,
        path: file.path,
        fileName: file.fileName,
        expiresAt,
      });
      return reply.code(201).send({
        downloadUrl: `/downloads/${ticket}/${encodeURIComponent(file.fileName)}`,
        expiresAt,
        fileName: file.fileName,
        size: file.size,
      });
    },
  );

  app.get<{ Params: { ticket: string; filename: string } }>(
    "/downloads/:ticket/:filename",
    async (request, reply) => {
      const now = Date.now();
      removeExpiredDownloadTickets(downloadTickets, now);
      const ticket = downloadTickets.get(request.params.ticket);
      if (!ticket) return downloadNotFound(reply);
      downloadTickets.delete(request.params.ticket);
      if (ticket.expiresAt <= now || request.params.filename !== ticket.fileName) {
        return downloadNotFound(reply);
      }
      const currentPath = await realpath(ticket.path).catch(() => null);
      if (!currentPath || currentPath !== ticket.path || !pathContains(ticket.root, currentPath)) {
        return downloadNotFound(reply);
      }
      const info = await Promise.all([stat(currentPath), access(currentPath, constants.R_OK)])
        .then(([value]) => value)
        .catch(() => null);
      if (!info?.isFile()) return downloadNotFound(reply);
      return reply
        .header("Cache-Control", "private, no-store")
        .header("Content-Disposition", attachmentDisposition(ticket.fileName))
        .header("Content-Length", info.size)
        .type("application/octet-stream")
        .send(createReadStream(currentPath));
    },
  );

  app.post<{ Params: { id: string }; Body: ForkThreadRequest }>(
    "/api/v1/threads/:id/fork-estimate",
    async (request, reply): Promise<ForkEstimateResponse | undefined> => {
      const body = validateForkThreadBody(request.body);
      const source = projection.summary(request.params.id);
      if (!source) return apiError(reply, 404, "not_found", "Thread not found");
      assertWritableThread(source);
      const analysis = await analyzeForkRollout(
        await resolveForkRolloutPath(source.id),
        body.lastTurnId,
      );
      return { ...analysis.estimate, compressed: freshCompressedForkEstimate() };
    },
  );

  app.post<{ Params: { id: string }; Body: CreateForkOperationRequest }>(
    "/api/v1/threads/:id/fork-operations",
    async (request, reply): Promise<ForkOperationResponse | undefined> => {
      codexManager?.assertTurnsAllowed();
      const body = validateCreateForkOperationBody(request.body);
      const source = projection.summary(request.params.id);
      if (!source) return apiError(reply, 404, "not_found", "Thread not found");
      assertWritableThread(source);
      const rolloutPath = await resolveForkRolloutPath(source.id);
      let operation: ForkOperationState;
      let retry = false;
      try {
        await withKeyLock(forkOperationLocks, body.operationId, async () => {
          const observed = store.view().forkOperations?.[body.operationId];
          if (observed) {
            if (
              observed.sourceThreadId !== source.id ||
              observed.lastTurnId !== body.lastTurnId ||
              observed.agentMessageId !== body.agentMessageId ||
              observed.mode !== body.mode
            ) {
              throw new ProjectConflictError("operationId has already been used");
            }
            if (observed.status === "failed") await deleteForkOperationThreads(observed);
          }
          await store.update((state) => {
            state.forkOperations ??= {};
            const existing = state.forkOperations[body.operationId];
            if (existing) {
              if (!existing.rolloutPath && rolloutPath) existing.rolloutPath = rolloutPath;
              if (existing.status === "failed") {
                existing.status = "preparing";
                existing.targetThreadId = null;
                existing.estimate = null;
                existing.error = null;
                existing.agentText = "";
                delete existing.nativeAttempt;
                delete existing.compressedPreparation;
                delete existing.compressedMaterialization;
                existing.updatedAt = Date.now();
                retry = true;
              }
              operation = existing;
              return;
            }
            const now = Date.now();
            operation = {
              id: body.operationId,
              sourceThreadId: source.id,
              lastTurnId: body.lastTurnId,
              agentMessageId: body.agentMessageId,
              mode: body.mode,
              status: "preparing",
              title: temporaryForkTitle(source.title),
              createdAt: now,
              updatedAt: now,
              targetThreadId: null,
              estimate: null,
              error: null,
              sourceCwd: source.cwd,
              sourceSettings: structuredClone(source.settings),
              rolloutPath,
              agentText: "",
              queuedMessages: [],
            };
            state.forkOperations[body.operationId] = operation;
          });
        });
      } catch (error) {
        if (error instanceof ProjectConflictError) {
          return apiError(reply, 409, "conflict", error.message);
        }
        throw error;
      }
      publishForkOperation(body.operationId);
      if (operation!.status === "preparing" || retry)
        setImmediate(() => scheduleForkOperation(body.operationId));
      return reply.code(202).send({ operation: publicForkOperation(operation!) });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/fork-operations/:id",
    async (request, reply): Promise<ForkOperationDetailResponse | undefined> => {
      const operation = store.view().forkOperations?.[request.params.id];
      if (!operation) return apiError(reply, 404, "not_found", "Fork operation not found");
      const readyTargetId = operation.status === "ready" ? operation.targetThreadId : null;
      const draft = readyTargetId ? store.view().threadMeta[readyTargetId]?.draft : operation.draft;
      return {
        operation: publicForkOperation(operation),
        queuedMessages: readyTargetId
          ? queue.list(readyTargetId)
          : cloneView<QueuedMessage[]>(operation.queuedMessages),
        draft: draft ? cloneView<NonNullable<ForkOperationState["draft"]>>(draft) : null,
      };
    },
  );

  app.delete<{ Params: { id: string } }>("/api/v1/fork-operations/:id", async (request, reply) => {
    const operation = store.view().forkOperations?.[request.params.id];
    if (!operation) return apiError(reply, 404, "not_found", "Fork operation not found");
    if (operation.status !== "failed") {
      return apiError(reply, 409, "conflict", "Only failed fork operations may be removed");
    }
    await deleteForkOperationThreads(operation);
    await store.update((state) => {
      delete state.forkOperations?.[request.params.id];
    });
    projection.removeForkOperation(request.params.id);
    return reply.code(204).send();
  });

  app.put<{
    Params: { id: string };
    Querystring: { expectedUpdatedAt?: string };
    Body: UpdateThreadDraftRequest;
  }>(
    "/api/v1/fork-operations/:id/draft",
    { bodyLimit: CHAT_BODY_LIMIT },
    async (request, reply) => {
      const operation = store.view().forkOperations?.[request.params.id];
      if (!operation) return apiError(reply, 404, "not_found", "Fork operation not found");
      if (operation.status === "ready" && operation.targetThreadId) {
        const expected = parseExpectedDraftRevision(request.query.expectedUpdatedAt);
        try {
          return await projection.setDraft(
            operation.targetThreadId,
            validateThreadDraft(request.body),
            expected === undefined ? undefined : { expectedUpdatedAt: expected },
          );
        } catch (error) {
          if (error instanceof ThreadDraftConflictError) {
            return apiError(reply, 409, "draft_conflict", error.message);
          }
          throw error;
        }
      }
      const expected = parseExpectedDraftRevision(request.query.expectedUpdatedAt);
      const draft = validateThreadDraft(request.body);
      let saved!: ReturnType<typeof validateThreadDraft> & { updatedAt: number };
      try {
        await store.update((state) => {
          const current = state.forkOperations?.[request.params.id];
          if (!current) throw new MessageQueueNotFoundError("Fork operation not found");
          const actual = current.draft?.updatedAt ?? null;
          if (expected !== undefined && expected !== actual) {
            throw new ThreadDraftConflictError("Draft was updated elsewhere");
          }
          saved = { ...draft, updatedAt: Date.now() };
          current.draft = saved;
          current.updatedAt = saved.updatedAt;
        });
      } catch (error) {
        if (error instanceof ThreadDraftConflictError) {
          return apiError(reply, 409, "draft_conflict", error.message);
        }
        throw error;
      }
      publishForkOperation(request.params.id);
      return saved;
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/fork-operations/:id/draft",
    async (request, reply) => {
      const operation = store.view().forkOperations?.[request.params.id];
      if (!operation) return apiError(reply, 404, "not_found", "Fork operation not found");
      const draft =
        operation.status === "ready" && operation.targetThreadId
          ? store.view().threadMeta[operation.targetThreadId]?.draft
          : operation.draft;
      return draft ? cloneView<NonNullable<ForkOperationState["draft"]>>(draft) : null;
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/fork-operations/:id/queue",
    async (request, reply) => {
      const operation = store.view().forkOperations?.[request.params.id];
      if (!operation) return apiError(reply, 404, "not_found", "Fork operation not found");
      return operation.status === "ready" && operation.targetThreadId
        ? queue.list(operation.targetThreadId)
        : cloneView<QueuedMessage[]>(operation.queuedMessages);
    },
  );

  app.post<{ Params: { id: string }; Body: QueueMessageRequest }>(
    "/api/v1/fork-operations/:id/queue",
    { bodyLimit: CHAT_BODY_LIMIT },
    async (request, reply) => {
      const operation = store.view().forkOperations?.[request.params.id];
      if (!operation) return apiError(reply, 404, "not_found", "Fork operation not found");
      const body = validateQueueMessageBody(request.body);
      if (body.planImplementationMode) {
        throw new ProjectValidationError("Plan implementation requires an existing session");
      }
      if (operation.status === "ready" && operation.targetThreadId) {
        const files = await attachments.validate(operation.targetThreadId, body.files);
        const message = await queue.enqueue(
          operation.targetThreadId,
          body.input,
          body.images,
          body.clientMessageId,
          { goal: body.goal, files, ...pastedText(body) },
        );
        return reply.code(202).send(message);
      }
      if (body.files.length) {
        throw new ProjectConflictError("File uploads are unavailable until the fork is ready");
      }
      const message: QueuedMessage = {
        id: body.clientMessageId ?? randomUUID(),
        threadId: operation.id,
        text: body.input.trim(),
        ...pastedText(trimPastedMessage(body.input, body)),
        ...(body.images.length ? { images: body.images } : {}),
        ...(body.files.length ? { files: body.files } : {}),
        ...(body.goal ? { goal: true } : {}),
        createdAt: Date.now(),
        status: "queued",
      };
      let stored = message;
      await store.update((state) => {
        const current = state.forkOperations?.[request.params.id];
        if (!current) throw new MessageQueueNotFoundError("Fork operation not found");
        const existing = current.queuedMessages.find((candidate) => candidate.id === message.id);
        if (existing) {
          if (
            messageContentHash(
              existing.text,
              existing.images ?? [],
              existing.files ?? [],
              !!existing.goal,
              undefined,
              undefined,
              existing,
            ) !==
            messageContentHash(
              message.text,
              message.images ?? [],
              message.files ?? [],
              !!message.goal,
              undefined,
              undefined,
              message,
            )
          ) {
            throw new MessageQueueConflictError("Message id has already been used");
          }
          stored = existing;
          return;
        }
        current.queuedMessages.push(message);
        delete current.draft;
        current.updatedAt = Date.now();
      });
      publishForkOperation(request.params.id);
      return reply.code(202).send(stored);
    },
  );

  app.patch<{ Params: { id: string; messageId: string }; Body: UpdateQueuedMessageRequest }>(
    "/api/v1/fork-operations/:id/queue/:messageId",
    { bodyLimit: CHAT_BODY_LIMIT },
    async (request, reply) => {
      const operation = store.view().forkOperations?.[request.params.id];
      if (!operation) return apiError(reply, 404, "not_found", "Fork operation not found");
      const body = requireRecord<UpdateQueuedMessageRequest>(request.body);
      if (typeof body.input !== "string")
        throw new ProjectValidationError("input must be a string");
      if (operation.status === "ready" && operation.targetThreadId) {
        return queue.update(
          operation.targetThreadId,
          request.params.messageId,
          body.input,
          validateQueuedPastes(body),
        );
      }
      let updated!: QueuedMessage;
      await store.update((state) => {
        const current = state.forkOperations?.[request.params.id];
        const message = current?.queuedMessages.find(
          (item) => item.id === request.params.messageId,
        );
        if (!message) throw new MessageQueueNotFoundError("Queued message not found");
        const presentation = trimPastedMessage(
          body.input,
          validateQueuedPastes(body) ?? rebasePastedText(message.text, body.input, message),
        );
        if (
          !body.input.trim() &&
          !message.images?.length &&
          !message.files?.length &&
          !presentation.pasteBlocks?.length
        ) {
          throw new MessageQueueValidationError("Queued message text must not be empty");
        }
        message.text = presentation.input;
        message.inlinePastes = presentation.inlinePastes;
        message.pasteBlocks = presentation.pasteBlocks;
        updated = structuredClone(message);
        current!.updatedAt = Date.now();
      });
      publishForkOperation(request.params.id);
      return updated;
    },
  );

  app.delete<{ Params: { id: string; messageId: string } }>(
    "/api/v1/fork-operations/:id/queue/:messageId",
    async (request, reply) => {
      const operation = store.view().forkOperations?.[request.params.id];
      if (!operation) return apiError(reply, 404, "not_found", "Fork operation not found");
      if (operation.status === "ready" && operation.targetThreadId) {
        const removed = queue
          .list(operation.targetThreadId)
          .find((message) => message.id === request.params.messageId);
        await queue.cancel(operation.targetThreadId, request.params.messageId);
        await Promise.all(
          (removed?.files ?? []).map((file) =>
            attachments.remove(operation.targetThreadId!, file.id).catch(() => undefined),
          ),
        );
      } else {
        await store.update((state) => {
          const current = state.forkOperations?.[request.params.id];
          if (!current?.queuedMessages.some((item) => item.id === request.params.messageId)) {
            throw new MessageQueueNotFoundError("Queued message not found");
          }
          current.queuedMessages = current.queuedMessages.filter(
            (item) => item.id !== request.params.messageId,
          );
          current.updatedAt = Date.now();
        });
        publishForkOperation(request.params.id);
      }
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string; messageId: string } }>(
    "/api/v1/fork-operations/:id/queue/:messageId/send",
    async (request, reply) => {
      const operation = store.view().forkOperations?.[request.params.id];
      if (!operation) return apiError(reply, 404, "not_found", "Fork operation not found");
      if (operation.status !== "ready" || !operation.targetThreadId) {
        return apiError(reply, 409, "conflict", "The fork is not ready yet");
      }
      return { turnId: await queue.sendNow(operation.targetThreadId, request.params.messageId) };
    },
  );

  app.post<{ Params: { id: string }; Body: ForkThreadRequest }>(
    "/api/v1/threads/:id/forks",
    async (request, reply) => {
      codexManager?.assertTurnsAllowed();
      const body = validateForkThreadBody(request.body);
      let source = projection.summary(request.params.id);
      if (!source) source = await projection.refreshThread(request.params.id);
      if (!source) return apiError(reply, 404, "not_found", "Thread not found");
      assertWritableThread(source);

      const point = await validateForkPoint(bridge, source.id, body.lastTurnId);
      if (!threadTitles) throw new Error("Thread title generation is unavailable");
      const model = effectiveTitleModel(
        source.settings,
        store.view().taskDefaults,
        projection.availableModels,
      );
      const title = await threadTitles.generate(point.text, {
        cwd: source.cwd,
        model: model?.id,
        effort: model?.reasoningEfforts[0]?.value,
      });
      const forked = parseThreadStart(
        await bridge.request<unknown>(
          "thread/fork",
          {
            threadId: source.id,
            lastTurnId: point.turn.id,
            excludeTurns: true,
            serviceTier: sessionServiceTier(source.settings, projection.availableModels),
          },
          FORK_RPC_TIMEOUT_MS,
        ),
      ).thread;
      await bridge.request("thread/goal/clear", { threadId: forked.id });
      await bridge.request("thread/name/set", { threadId: forked.id, name: title });

      const sourceMeta = store.view().threadMeta[source.id];
      await store.update((state) => {
        state.threadMeta[forked.id] = {
          pinned: false,
          lastReadUpdatedAt: 0,
          lastOutcome: "completed",
          outcomeUpdatedAt: forked.updatedAt * 1_000,
          settings: structuredClone(source.settings),
          ...(sourceMeta?.managedTeamToolsAvailable === true
            ? { managedTeamToolsAvailable: true as const }
            : {}),
          ...(sourceMeta?.sessionArtifactsVersion === 1
            ? { sessionArtifactsVersion: 1 as const }
            : {}),
        };
        if (state.messageQueues) delete state.messageQueues[forked.id];
      });
      projection.upsertThread({ ...forked, name: title });
      return reply.code(201).send({
        thread: projection.summary(forked.id)!,
      } satisfies ForkThreadResponse);
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateThreadRequest }>(
    "/api/v1/threads/:id",
    async (request, reply) => {
      const body = requireRecord<UpdateThreadRequest>(request.body);
      const summary = projection.summary(request.params.id);
      if (!summary) return apiError(reply, 404, "not_found", "Thread not found");
      assertWritableThread(summary);
      if (body.browserEnabled !== undefined && typeof body.browserEnabled !== "boolean") {
        return apiError(reply, 400, "validation_failed", "browserEnabled must be boolean");
      }
      if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim())) {
        return apiError(reply, 400, "validation_failed", "name must not be empty");
      }
      if (body.pinned !== undefined && typeof body.pinned !== "boolean") {
        return apiError(reply, 400, "validation_failed", "pinned must be boolean");
      }
      if (body.browserEnabled !== undefined) {
        if (!browserExtension) {
          return apiError(reply, 503, "app_server_unavailable", "Browser extension is unavailable");
        }
        if (body.browserEnabled) await browserExtension.enableThread(request.params.id);
        else await browserExtension.disableThread(request.params.id);
      }
      if (body.name !== undefined) {
        await bridge.request("thread/name/set", {
          threadId: request.params.id,
          name: body.name.trim(),
        });
      }
      if (body.pinned !== undefined) {
        await projection.setPinned(request.params.id, body.pinned);
      }
      return projection.summary(request.params.id);
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateThreadSettingsRequest }>(
    "/api/v1/threads/:id/settings",
    async (request, reply) => {
      const patch = validateSettingsPatch(request.body);
      if (Object.keys(patch).length === 0) {
        return apiError(reply, 400, "validation_failed", "At least one setting is required");
      }
      return withKeyLock(turnStartLocks, request.params.id, () =>
        updateThreadSettings(request.params.id, patch),
      );
    },
  );

  app.post<{ Params: { id: string }; Body: StartTurnRequest }>(
    "/api/v1/threads/:id/turns",
    { bodyLimit: CHAT_BODY_LIMIT },
    async (request, reply) => {
      if (voiceTranscriptions?.active(request.params.id)) {
        return apiError(
          reply,
          409,
          "conflict",
          "The composer is locked while voice transcription is active",
        );
      }
      await voiceTranscriptions?.clearFailure(request.params.id);
      const body = validateStartTurnBody(request.body, reply);
      if (!body) return;
      const summary = projection.summary(request.params.id);
      if (!summary) return apiError(reply, 404, "not_found", "Thread not found");
      assertWritableThread(summary);
      await cancelCapacityRetry(request.params.id);
      const result = await startTurn(
        request.params.id,
        body.input,
        body.images ?? [],
        body.files ?? [],
        body.clientMessageId ?? (Object.keys(pastedText(body)).length ? randomUUID() : null),
        body.goal ?? false,
        undefined,
        undefined,
        body,
      );
      return reply.code(201).send(result);
    },
  );

  app.post<{ Params: { id: string }; Body: QueueMessageRequest }>(
    "/api/v1/threads/:id/queue",
    { bodyLimit: CHAT_BODY_LIMIT },
    async (request, reply) => {
      if (voiceTranscriptions?.active(request.params.id)) {
        return apiError(
          reply,
          409,
          "conflict",
          "The composer is locked while voice transcription is active",
        );
      }
      await voiceTranscriptions?.clearFailure(request.params.id);
      const body = validateQueueMessageBody(request.body);
      const summary = projection.summary(request.params.id);
      if (!summary) {
        return apiError(reply, 404, "not_found", "Thread not found");
      }
      assertWritableThread(summary);
      const files = await attachments.validate(request.params.id, body.files);
      const message = await queue.enqueue(
        request.params.id,
        body.input,
        body.images,
        body.clientMessageId,
        {
          goal: body.goal,
          planImplementationMode: body.planImplementationMode,
          ...pastedText(body),
          files,
          replyToAsyncQuestion: body.replyToAsyncQuestion,
          replyToUserInput: body.replyToUserInput,
          dismissUserInput: body.dismissUserInput,
        },
      );
      if (body.projectDraft && body.projectDraft.projectId === summary.projectId) {
        let cleared: ThreadDraft | undefined;
        await store.update((state) => {
          const current = state.projectDrafts?.[body.projectDraft!.projectId];
          if (current?.updatedAt !== body.projectDraft!.updatedAt) return;
          cleared = {
            input: "",
            images: [],
            goalMode: false,
            annotations: [],
            updatedAt: Math.max(Date.now(), current.updatedAt + 1),
          };
          state.projectDrafts![body.projectDraft!.projectId] = cleared;
        });
        if (cleared) projection.publishProjectDraft(body.projectDraft.projectId, cleared);
      }
      return reply.code(202).send(message satisfies QueuedMessage);
    },
  );

  app.post<{
    Params: { id: string; messageId: string };
    Body: { retryUnconfirmed?: boolean } | undefined;
  }>("/api/v1/threads/:id/queue/:messageId/send", async (request, reply) => {
    return withKeyLock(firstSessionRecoveryLocks, request.params.id, async () => {
      const summary = projection.summary(request.params.id);
      if (!summary) return apiError(reply, 404, "not_found", "Thread not found");
      assertWritableThread(summary);
      if (
        request.body?.retryUnconfirmed !== undefined &&
        typeof request.body.retryUnconfirmed !== "boolean"
      ) {
        return apiError(reply, 400, "validation_failed", "retryUnconfirmed must be a boolean");
      }
      const retryUnconfirmed = request.body?.retryUnconfirmed === true;
      const recoveredId = store.view().threadCreations?.[`recover-first:${summary.id}`]?.threadId;
      if (recoveredId && !queue.list(summary.id).length) {
        const thread = projection.summary(recoveredId);
        if (thread) return sendRecoveredFirstMessage(thread, request.params.messageId);
      }
      await cancelCapacityRetry(summary.id);
      const savedMessage = queue
        .list(summary.id)
        .find((pending) => pending.id === request.params.messageId);
      if (
        savedMessage?.deliveryError?.message === "Сессия недоступна. Сообщение сохранено." &&
        store.view().messageReceipts?.[request.params.messageId]?.status === "rejected" &&
        projection.canRecoverMissingFirstSession(summary.id)
      ) {
        // Native delivery remembers an explicit rejection. Confirm that its
        // empty session is actually missing before replacing the session.
        try {
          await bridge.request("thread/turns/list", {
            threadId: summary.id,
            cursor: null,
            limit: 1,
            sortDirection: "asc",
            itemsView: "notLoaded",
          });
        } catch (error) {
          if (!isMissingThreadError(error)) throw error;
          const thread = await recoverMissingFirstSession(summary);
          return sendRecoveredFirstMessage(thread, request.params.messageId);
        }
      }
      try {
        return {
          turnId: await queue.sendNow(summary.id, request.params.messageId, retryUnconfirmed),
        };
      } catch (error) {
        if (
          retryUnconfirmed &&
          isMissingThreadError(error) &&
          projection.canRecoverMissingFirstSession(summary.id, request.params.messageId)
        ) {
          // The user explicitly retries a preserved first message. A lost
          // empty ordinary session has no native command to replay safely;
          // release just this claim before the existing session recovery.
          await store.update((state) => {
            if (!projection.canRecoverMissingFirstSession(summary.id, request.params.messageId)) {
              throw new ProjectConflictError("The saved message changed during recovery");
            }
            const message = state.messageQueues?.[summary.id]?.find(
              (item) => item.id === request.params.messageId,
            );
            if (!message)
              throw new ProjectConflictError("The saved message changed during recovery");
            delete state.messageReceipts?.[message.id];
            message.status = "queued";
          });
        }
        if (!isMissingThreadError(error) || !projection.canRecoverMissingFirstSession(summary.id))
          throw error;
        const thread = await recoverMissingFirstSession(summary);
        return sendRecoveredFirstMessage(thread, request.params.messageId);
      }
    });
  });

  app.patch<{
    Params: { id: string; messageId: string };
    Body: UpdateQueuedMessageRequest;
  }>(
    "/api/v1/threads/:id/queue/:messageId",
    { bodyLimit: CHAT_BODY_LIMIT },
    async (request, reply) => {
      const summary = projection.summary(request.params.id);
      if (!summary) return apiError(reply, 404, "not_found", "Thread not found");
      assertWritableThread(summary);
      const body = requireRecord<UpdateQueuedMessageRequest>(request.body);
      if (typeof body.input !== "string") {
        return apiError(reply, 400, "validation_failed", "input must be a string");
      }
      return queue.update(
        request.params.id,
        request.params.messageId,
        body.input,
        validateQueuedPastes(body),
      );
    },
  );

  app.delete<{ Params: { id: string; messageId: string } }>(
    "/api/v1/threads/:id/queue/:messageId",
    async (request, reply) => {
      const summary = projection.summary(request.params.id);
      if (!summary) return apiError(reply, 404, "not_found", "Thread not found");
      assertWritableThread(summary);
      const removed = queue
        .list(request.params.id)
        .find((message) => message.id === request.params.messageId);
      await queue.cancel(request.params.id, request.params.messageId);
      await Promise.all(
        (removed?.files ?? []).map((file) =>
          attachments.remove(request.params.id, file.id).catch(() => undefined),
        ),
      );
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string }; Body: InterruptTurnRequest }>(
    "/api/v1/threads/:id/interrupt",
    async (request, reply) => {
      const summary = projection.summary(request.params.id);
      if (!summary) return apiError(reply, 404, "not_found", "Thread not found");
      const managedRetry = summary.capacityRetry
        ? managedTaskForChild(store.view(), request.params.id)
        : null;
      if (!managedRetry) assertWritableThread(summary);
      const body = requireRecord<InterruptTurnRequest>(request.body);
      if (body.turnId !== undefined && typeof body.turnId !== "string") {
        return apiError(reply, 400, "validation_failed", "turnId must be a string");
      }
      const requestedTurnId = summary.currentTurnId ?? body.turnId;
      const orchestration = store.view().threadMeta[request.params.id]?.teamOrchestration;
      if (!requestedTurnId && !orchestration && !summary.capacityRetry) {
        return apiError(reply, 400, "validation_failed", "There is no running task to stop");
      }
      await cancelCapacityRetry(request.params.id);
      if (managedRetry) {
        await withKeyLock(turnStartLocks, request.params.id, () =>
          withKeyLock(teamParentLocks, managedRetry.parentThreadId, async () => {
            const currentTurnId = projection.summary(request.params.id)?.currentTurnId;
            if (currentTurnId)
              await interruptTurnIfRunning(bridge, request.params.id, currentTurnId);
            await finalizeManagedTask(
              store,
              projection,
              request.params.id,
              `cancelled:${Date.now()}`,
              "interrupted",
              {
                summary: "Task cancelled by the user during model capacity recovery.",
                source: "status",
              },
              managedRetry.task.id,
            );
          }),
        );
        projection.publishThreadState(managedRetry.parentThreadId);
        scheduleTeamTasks(managedRetry.parentThreadId);
        scheduleTeamContinuation(managedRetry.parentThreadId);
        return reply.code(204).send();
      }
      if (orchestration) {
        stoppedTeamParents.add(request.params.id);
        const immediate = teamContinuationImmediates.get(request.params.id);
        if (immediate) clearImmediate(immediate);
        teamContinuationImmediates.delete(request.params.id);
        scheduledTeamContinuations.delete(request.params.id);
      }
      const interruptedTurnIds: string[] = [];
      await withKeyLock(turnStartLocks, request.params.id, () =>
        withKeyLock(teamParentLocks, request.params.id, async () => {
          const currentTurnId = projection.summary(request.params.id)?.currentTurnId;
          if (currentTurnId && currentTurnId !== requestedTurnId) {
            const interrupted = await interruptTurnIfRunning(
              bridge,
              request.params.id,
              currentTurnId,
            );
            interruptedTurnIds.push(currentTurnId);
            if (interrupted && interrupted !== currentTurnId) interruptedTurnIds.push(interrupted);
          }
          if (requestedTurnId) {
            const interrupted = await interruptTurnIfRunning(
              bridge,
              request.params.id,
              requestedTurnId,
            );
            interruptedTurnIds.push(requestedTurnId);
            if (interrupted && interrupted !== requestedTurnId)
              interruptedTurnIds.push(interrupted);
          }
          const tasks = Object.values(
            store.view().threadMeta[request.params.id]?.teamOrchestration?.tasks ?? {},
          );
          const hasPendingWorkspace = tasks.some(managedTaskHasPendingWorkspace);
          if (tasks.length && tasks.every(isTerminalTask) && !hasPendingWorkspace) {
            await store.update((state) => {
              const meta = state.threadMeta[request.params.id];
              if (meta) delete meta.teamOrchestration;
            });
          }
        }),
      );
      await projection.markInterrupted(request.params.id, interruptedTurnIds);
      projection.publishThreadState(request.params.id);
      return reply.code(204).send();
    },
  );

  for (const [route, method] of [
    ["archive", "thread/archive"],
    ["unarchive", "thread/unarchive"],
  ] as const) {
    app.post<{ Params: { id: string } }>(`/api/v1/threads/:id/${route}`, async (request, reply) => {
      const summary = projection.summary(request.params.id);
      if (!summary) return apiError(reply, 404, "not_found", "Thread not found");
      assertWritableThread(summary);
      if (route === "archive") await cancelCapacityRetry(request.params.id);
      await bridge.request(method, { threadId: request.params.id });
      await projection.setArchived(request.params.id, route === "archive");
      return reply.code(204).send();
    });
  }

  app.post<{ Params: { id: string }; Body: DismissPlanRequest }>(
    "/api/v1/threads/:id/plan/dismiss",
    async (request, reply) => {
      const body = requireRecord<DismissPlanRequest>(request.body);
      if (
        typeof body.turnId !== "string" ||
        !body.turnId.trim() ||
        typeof body.observedUpdatedAt !== "number" ||
        !Number.isFinite(body.observedUpdatedAt)
      )
        return apiError(
          reply,
          400,
          "validation_failed",
          "turnId and observedUpdatedAt are required",
        );
      return withKeyLock(turnStartLocks, request.params.id, async () => {
        const summary = projection.summary(request.params.id);
        if (!summary) return apiError(reply, 404, "not_found", "Thread not found");
        assertWritableThread(summary);
        return projection.dismissPlan(request.params.id, body);
      });
    },
  );

  app.put<{ Params: { id: string }; Body: MarkReadRequest }>(
    "/api/v1/threads/:id/read",
    async (request, reply) => {
      const body = requireRecord<MarkReadRequest>(request.body);
      if (typeof body.observedUpdatedAt !== "number")
        return apiError(reply, 400, "validation_failed", "observedUpdatedAt is required");
      if (!projection.summary(request.params.id))
        return apiError(reply, 404, "not_found", "Thread not found");
      await projection.markRead(request.params.id, body.observedUpdatedAt);
      return reply.code(204).send();
    },
  );

  app.put<{ Params: { id: string }; Body: MarkViewedRequest }>(
    "/api/v1/threads/:id/viewed",
    async (request, reply) => {
      const body = requireRecord<MarkViewedRequest>(request.body);
      if (typeof body.observedUpdatedAt !== "number")
        return apiError(reply, 400, "validation_failed", "observedUpdatedAt is required");
      if (!projection.summary(request.params.id))
        return apiError(reply, 404, "not_found", "Thread not found");
      await projection.markViewed(request.params.id, body.observedUpdatedAt);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { attentionId: string }; Body: AttentionResponse }>(
    "/api/v1/attention/:attentionId/respond",
    async (request, reply) => {
      const body = requireRecord<AttentionResponse>(request.body);
      if (
        attention.get(request.params.attentionId)?.kind === "userInput" ||
        body.kind === "userInput"
      ) {
        return apiError(
          reply,
          409,
          "conflict",
          "Ответ на вопрос нужно отправить через очередь с постоянным идентификатором сообщения.",
        );
      }
      const resolved = attention.resolve(request.params.attentionId, body);
      if (!resolved) {
        return apiError(
          reply,
          409,
          "conflict",
          "Attention request has already been resolved or expired",
        );
      }
      await projection.recordAttentionResponse(resolved, body);
      return reply.code(204).send();
    },
  );

  app.put<{ Params: { attentionId: string }; Body: UpdateUserInputDraftRequest }>(
    "/api/v1/attention/:attentionId/draft",
    async (request, reply) => {
      const active = attention.get(request.params.attentionId);
      if (
        !active ||
        active.kind !== "userInput" ||
        !active.threadId ||
        !active.turnId ||
        !active.itemId
      ) {
        return apiError(
          reply,
          409,
          "conflict",
          "Attention request has already been resolved or is not a user-input request",
        );
      }
      return projection.updateUserInputDraft(
        active,
        validateUserInputDraft(request.body, active.questions),
      );
    },
  );

  app.setErrorHandler((error: Error, request, reply) => {
    request.log.error(
      {
        err: safeError(error),
        rpcCode: error instanceof RpcError ? error.code : undefined,
        method: request.method,
        route: request.routeOptions.url,
      },
      "request failed",
    );
    if (error instanceof BridgeUnavailableError) {
      return apiError(reply, 503, "app_server_unavailable", error.message);
    }
    if (error instanceof TranscriptionError) {
      if (error.kind === "validation") {
        return apiError(reply, 400, "validation_failed", error.message);
      }
      return apiError(
        reply,
        error.kind === "unavailable" ? 503 : 502,
        error.kind === "unavailable" ? "transcription_unavailable" : "transcription_failed",
        error.message,
      );
    }
    if (error instanceof AttachmentTooLargeError) {
      return apiError(reply, 413, "payload_too_large", error.message);
    }
    if (error instanceof AttachmentValidationError) {
      return apiError(reply, 400, "validation_failed", error.message);
    }
    if ("statusCode" in error && error.statusCode === 413) {
      return apiError(reply, 413, "payload_too_large", "Upload is too large");
    }
    if (error instanceof ProjectValidationError || error instanceof AttentionValidationError) {
      return apiError(reply, 400, "validation_failed", error.message);
    }
    if (error instanceof ProjectForbiddenError)
      return apiError(reply, 403, "forbidden", error.message);
    if (error instanceof ProjectNotFoundError)
      return apiError(reply, 404, "not_found", error.message);
    if (error instanceof MessageQueueNotFoundError)
      return apiError(reply, 404, "not_found", error.message);
    if (error instanceof MessageQueueValidationError)
      return apiError(reply, 400, "validation_failed", error.message);
    if (error instanceof ThreadSearchUnavailableError)
      return apiError(reply, 503, "app_server_unavailable", error.message);
    if (error instanceof ThreadSearchNotFoundError)
      return apiError(reply, 404, "not_found", error.message);
    if (error instanceof ThreadHistoryConflictError)
      return apiError(reply, 409, "history_changed", error.message);
    if (error instanceof DeliveryContractError)
      return apiError(reply, 409, "conflict", error.message);
    if (error instanceof MessageQueuePausedError || error instanceof MessageQueueConflictError)
      return apiError(reply, 409, "conflict", error.message);
    if (
      error instanceof VoiceTranscriptionDraftConflictError ||
      error instanceof ThreadDraftConflictError
    ) {
      return apiError(reply, 409, "draft_conflict", error.message);
    }
    if (
      error instanceof VoiceTranscriptionConflictError ||
      error instanceof VoiceTranscriptionQueueFullError
    ) {
      return apiError(reply, 409, "conflict", error.message);
    }
    if (error instanceof CodexManagementError) {
      if (error.kind === "validation")
        return apiError(reply, 400, "validation_failed", error.message);
      if (error.kind === "failed")
        return apiError(reply, 503, "app_server_unavailable", error.message);
      return apiError(reply, 409, "conflict", error.message);
    }
    if (error instanceof AppManagementError) {
      if (error.kind === "failed")
        return apiError(reply, 503, "app_server_unavailable", error.message);
      return apiError(reply, 409, "conflict", error.message);
    }
    if (error instanceof ProjectConflictError)
      return apiError(reply, 409, "conflict", error.message);
    if (error instanceof BrowserExtensionError) {
      if (error.code === "not_found") return apiError(reply, 404, "not_found", error.message);
      if (error.code === "unavailable") {
        return apiError(reply, 503, "app_server_unavailable", error.message);
      }
      return apiError(reply, 409, "conflict", error.message);
    }
    return apiError(reply, 500, "internal_error", "Internal server error");
  });
}

async function handlePublishArtifact(
  request: Extract<ServerRequest, { method: "item/tool/call" }>,
  store: StateStore,
  projection: AppProjection,
): Promise<DynamicToolCallResponse> {
  const { threadId, turnId } = request.params;
  const summary = projection.summary(threadId);
  const meta = store.view().threadMeta[threadId];
  if (!summary || summary.relation.kind !== "session" || meta?.sessionArtifactsVersion !== 1) {
    return dynamicToolError("Explicit session artifacts are unavailable for this thread");
  }
  const args = dynamicToolArguments(request.params.arguments);
  if (Object.keys(args).some((key) => key !== "path" && key !== "label")) {
    throw new ProjectValidationError("publish_artifact accepts only path and label");
  }
  const published = await resolvePublishedArtifact(summary.cwd, requiredToolString(args, "path"));
  const requestedLabel = optionalToolString(args, "label");
  const label = requestedLabel ?? basename(published.relativePath);
  if (label.length > 500) {
    throw new ProjectValidationError("label must be at most 500 characters");
  }
  let artifact: SessionArtifactState | undefined;
  await store.update((state) => {
    const current = state.threadMeta[threadId];
    if (current?.sessionArtifactsVersion !== 1 || current.managedParent) return;
    const now = Date.now();
    const existing = current.sessionArtifacts?.find(
      (candidate) => candidate.path === published.relativePath,
    );
    artifact = {
      id: existing?.id ?? randomUUID(),
      label,
      path: published.relativePath,
      turnId,
      createdAt: now,
    };
    current.sessionArtifacts = [
      artifact,
      ...(current.sessionArtifacts ?? []).filter(
        (candidate) => candidate.path !== published.relativePath,
      ),
    ];
  });
  return artifact
    ? dynamicToolSuccess({ published: true, artifact })
    : dynamicToolError("Explicit session artifacts are unavailable for this thread");
}

async function resolvePublishedArtifact(
  cwd: string,
  input: string,
): Promise<{ relativePath: string; absolutePath: string }> {
  if (input.includes("\0") || input.length > 4_096) {
    throw new ProjectValidationError("Invalid artifact path");
  }
  if (
    !isAbsolute(input) &&
    (input.includes("\\") ||
      input.split("/").some((segment) => !segment || segment === "." || segment === ".."))
  ) {
    throw new ProjectValidationError("Artifact path must be a repository-relative file path");
  }
  let canonicalRoot: string;
  let canonicalPath: string;
  try {
    canonicalRoot = await realpath(cwd);
    canonicalPath = await realpath(isAbsolute(input) ? input : resolve(canonicalRoot, input));
  } catch {
    throw new ProjectValidationError("Artifact file does not exist");
  }
  if (!pathContains(canonicalRoot, canonicalPath)) {
    throw new ProjectValidationError("Artifact file must stay inside the thread directory");
  }
  let info: Stats;
  try {
    info = await stat(canonicalPath);
  } catch {
    throw new ProjectValidationError("Artifact file does not exist");
  }
  if (!info.isFile()) throw new ProjectValidationError("Artifact path must be a regular file");
  const relativePath = relative(canonicalRoot, canonicalPath);
  if (!relativePath) throw new ProjectValidationError("Artifact path must be a regular file");
  return { relativePath, absolutePath: canonicalPath };
}

async function resolveSessionArtifacts(
  cwd: string,
  artifacts: readonly DeepReadonly<SessionArtifactState>[],
): Promise<SessionArtifact[]> {
  const resolved: SessionArtifact[] = [];
  for (const artifact of artifacts) {
    try {
      const file = await resolvePublishedArtifact(cwd, artifact.path);
      resolved.push({
        ...artifact,
        path: file.absolutePath,
        relativePath: file.relativePath,
        fileName: basename(file.relativePath),
      });
    } catch {
      // Files are resolved lazily; removed or newly unsafe entries are not exposed.
    }
  }
  return resolved;
}

async function handleManagedTeamToolCall(
  request: Extract<ServerRequest, { method: "item/tool/call" }>,
  bridge: CodexBridge,
  store: StateStore,
  projection: AppProjection,
): Promise<DynamicToolCallResponse> {
  const { threadId, callId, tool } = request.params;
  const args = dynamicToolArguments(request.params.arguments);
  const prepared = isMutatingTeamTool(tool)
    ? await prepareTeamToolOperation(store, request, args)
    : null;
  if (prepared?.conflict) {
    return dynamicToolError("This Team tool call id has already been used with other arguments");
  }
  if (prepared?.operation.status === "applied" && prepared.operation.response) {
    return prepared.operation.response;
  }
  const finish = async (response: DynamicToolCallResponse): Promise<DynamicToolCallResponse> => {
    if (prepared) {
      await completeTeamToolOperation(store, prepared.key, response);
    }
    return response;
  };

  if (tool === "submit_result") {
    const managed = managedTaskForChild(store.view(), threadId);
    if (!managed) return finish(dynamicToolError("This thread is not a managed Team task"));
    const summary = requiredToolString(args, "summary");
    const details = optionalToolString(args, "details");
    const fields = managedResultFields(args);
    await validateManagedResultArtifacts(
      fields.artifacts,
      managed.task.workspace?.worktreePath ?? projection.summary(managed.parentThreadId)?.cwd,
    );
    if (!fields.outcome) {
      throw new ProjectValidationError("outcome is required for managed Team results");
    }
    let accepted = false;
    await store.update((state) => {
      const task =
        state.threadMeta[managed.parentThreadId]?.teamOrchestration?.tasks[managed.task.id];
      if (!task) return;
      if (task.resultCandidate?.callId === callId) {
        accepted = true;
        return;
      }
      if (isTerminalTask(task)) return;
      task.resultCandidate = {
        summary,
        ...(details ? { details } : {}),
        ...fields,
        submittedAt: Date.now(),
        callId,
      };
      task.lastActivityAt = Date.now();
      delete task.watchdog;
      accepted = true;
    });
    return finish(
      accepted
        ? dynamicToolSuccess({ accepted: true })
        : dynamicToolError("The managed task is already terminal"),
    );
  }

  const parent = projection.summary(threadId);
  if (
    !parent ||
    parent.relation.kind !== "session" ||
    parent.settings.collaborationMode !== "team"
  ) {
    return finish(
      dynamicToolError("Managed task tools are only available to a Team parent session"),
    );
  }

  if (tool === "spawn_task") {
    const title = requiredToolString(args, "title");
    const prompt = requiredToolString(args, "prompt");
    const options = managedTaskOptions(args, parent.settings, projection.availableModels);
    const tasks = store.view().threadMeta[threadId]?.teamOrchestration?.tasks ?? {};
    const missing = options.dependsOn.filter((dependency) => !tasks[dependency]);
    if (missing.length) {
      return finish(dynamicToolError(`Managed task dependencies not found: ${missing.join(", ")}`));
    }
    const operation = prepared!.operation;
    const taskId = operation.taskId!;
    const childThreadSource = operation.childThreadSource!;
    let task = store.view().threadMeta[threadId]?.teamOrchestration?.tasks[taskId];
    if (!task) {
      const recoveredThread = prepared!.created
        ? null
        : await findThreadBySource(bridge, childThreadSource);
      if (!prepared!.created && !recoveredThread) {
        return finish(
          dynamicToolError(
            "The previous child creation is ambiguous; no replacement thread was created",
          ),
        );
      }
      try {
        task = await createManagedTeamTask(
          bridge,
          store,
          projection,
          parent,
          title,
          prompt,
          taskId,
          childThreadSource,
          recoveredThread,
          options,
        );
      } catch (error) {
        const recoveredAfterError = await findThreadBySource(bridge, childThreadSource);
        if (!recoveredAfterError) {
          return finish(
            dynamicToolError(`Managed task creation failed: ${safeError(error).message}`),
          );
        }
        task = await createManagedTeamTask(
          bridge,
          store,
          projection,
          parent,
          title,
          prompt,
          taskId,
          childThreadSource,
          recoveredAfterError,
          options,
        );
      }
    }
    return finish(
      dynamicToolSuccess({
        taskId: task.id,
        threadId: task.childThreadId,
        status: task.status,
      }),
    );
  }

  if (tool === "list_tasks") {
    const taskMap = store.view().threadMeta[threadId]?.teamOrchestration?.tasks ?? {};
    const tasks = Object.values(taskMap)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((task) => publicManagedTask(task, taskMap));
    return dynamicToolSuccess({ tasks });
  }

  const taskId = requiredToolString(args, "taskId");
  const task = store.view().threadMeta[threadId]?.teamOrchestration?.tasks[taskId];
  if (!task) return finish(dynamicToolError("Managed task not found"));

  if (tool === "followup_task") {
    if (!isTerminalTask(task) || task.delivery?.status !== "delivered") {
      return finish(dynamicToolError("Only a delivered terminal task can be continued"));
    }
    const tasks = store.view().threadMeta[threadId]?.teamOrchestration?.tasks ?? {};
    const existingFollowup = tasks[prepared!.operation.taskId!];
    if (existingFollowup) {
      return finish(
        dynamicToolSuccess({
          taskId: existingFollowup.id,
          threadId: existingFollowup.childThreadId,
          status: existingFollowup.status,
        }),
      );
    }
    if (Object.values(tasks).some((candidate) => candidate.predecessorTaskId === task.id)) {
      return finish(dynamicToolError("This managed task already has a follow-up"));
    }
    const prompt = requiredToolString(args, "prompt");
    const title = optionalToolString(args, "title") ?? task.title;
    const options = managedTaskOptions(args, parent.settings, projection.availableModels, task);
    const reusesWorkspace = Boolean(
      task.workspace && !["integrated", "discarded"].includes(task.workspace.lifecycle),
    );
    if (
      reusesWorkspace &&
      (options.access.mode !== "isolatedWrite" ||
        canonicalJson(options.access.writePaths ?? []) !==
          canonicalJson(task.access?.writePaths ?? []))
    ) {
      return finish(
        dynamicToolError(
          "A follow-up with pending isolated changes must keep the same workspace write paths",
        ),
      );
    }
    const nextTaskId = prepared!.operation.taskId!;
    const now = Date.now();
    const next: ManagedTeamTaskState = {
      id: nextTaskId,
      childThreadId: task.childThreadId,
      childThreadSource: task.childThreadSource,
      startMessageId: teamTaskStartMarkerId(nextTaskId),
      title,
      prompt,
      status: "queued",
      predecessorTaskId: task.id,
      access: options.access,
      resolvedModel: options.model,
      resolvedReasoningEffort: options.reasoningEffort,
      resolvedServiceTier: sessionServiceTier(
        { ...parent.settings, model: options.model },
        projection.availableModels,
      ),
      ...(reusesWorkspace && task.workspace
        ? { workspace: cloneView<NonNullable<ManagedTeamTaskState["workspace"]>>(task.workspace) }
        : {}),
      createdAt: now,
      lastActivityAt: now,
    };
    await store.update((state) => {
      const orchestration = state.threadMeta[threadId]?.teamOrchestration;
      if (!orchestration || orchestration.tasks[nextTaskId]) return;
      orchestration.tasks[nextTaskId] = next;
      const childMeta = state.threadMeta[next.childThreadId] ?? {
        pinned: false,
        lastReadUpdatedAt: 0,
      };
      childMeta.managedParent = { parentThreadId: threadId, taskId: nextTaskId };
      state.threadMeta[next.childThreadId] = childMeta;
    });
    await bridge
      .request("thread/name/set", { threadId: next.childThreadId, name: title })
      .catch(() => undefined);
    projection.publishThreadState(next.childThreadId);
    return finish(
      dynamicToolSuccess({ taskId: next.id, threadId: next.childThreadId, status: next.status }),
    );
  }

  if (tool === "integrate_task") {
    if (!isTerminalTask(task)) {
      return finish(dynamicToolError("Only a terminal managed task can be integrated"));
    }
    if (!task.workspace) {
      return finish(dynamicToolError("This managed task has no isolated workspace"));
    }
    if (task.workspace.lifecycle === "integrated") {
      return finish(
        dynamicToolSuccess({
          integrated: true,
          changedPaths: task.workspace.changedPaths ?? [],
          alreadyIntegrated: true,
        }),
      );
    }
    if (task.workspace.lifecycle === "discarded") {
      return finish(dynamicToolError("This managed task's changes were discarded"));
    }
    if (
      Object.values(store.view().threadMeta[threadId]?.teamOrchestration?.tasks ?? {}).some(
        (candidate) => candidate.predecessorTaskId === task.id,
      )
    ) {
      return finish(dynamicToolError("Integrate the latest follow-up task instead"));
    }
    const activeSharedWriter = activeSharedWriteTask(store, threadId, task.id);
    if (activeSharedWriter) {
      return finish(
        dynamicToolError(
          `Wait for shared-write task ${activeSharedWriter.title} [${activeSharedWriter.id}] before integrating isolated changes`,
        ),
      );
    }
    try {
      await store.update((state) => {
        const current = state.threadMeta[threadId]?.teamOrchestration?.tasks[taskId];
        if (current?.workspace) {
          current.workspace.lifecycle = "integrating";
          current.workspace.updatedAt = Date.now();
        }
      });
      const integration = await integrateTeamWorkspace(
        task.workspace,
        task.access?.writePaths ?? [],
      );
      const integratedAt = Date.now();
      await store.update((state) => {
        const orchestration = state.threadMeta[threadId]?.teamOrchestration;
        const current = orchestration?.tasks[taskId];
        if (!current?.workspace) return;
        for (const candidate of Object.values(orchestration?.tasks ?? {})) {
          if (candidate.workspace?.worktreePath !== current.workspace.worktreePath) continue;
          candidate.workspace = {
            ...candidate.workspace,
            lifecycle: "integrated",
            changedPaths: integration.changedPaths,
            conflictPaths: undefined,
            error: undefined,
            updatedAt: integratedAt,
          };
        }
      });
      let cleanupError: string | undefined;
      try {
        await discardTeamWorkspace(task.workspace);
      } catch (error) {
        cleanupError = safeError(error).message;
        await store.update((state) => {
          const current = state.threadMeta[threadId]?.teamOrchestration?.tasks[taskId];
          if (current?.workspace?.lifecycle === "integrated") {
            current.workspace.error = cleanupError;
            current.workspace.updatedAt = Date.now();
          }
        });
      }
      return finish(dynamicToolSuccess({ integrated: true, ...integration, cleanupError }));
    } catch (error) {
      if (error instanceof TeamWorkspaceConflictError || error instanceof TeamWorkspacePathError) {
        const conflictPaths =
          error instanceof TeamWorkspaceConflictError
            ? error.conflicts.map((conflict) => conflict.path)
            : error.paths;
        await store.update((state) => {
          const current = state.threadMeta[threadId]?.teamOrchestration?.tasks[taskId];
          if (!current?.workspace) return;
          current.workspace.lifecycle = "conflicted";
          current.workspace.conflictPaths = conflictPaths;
          current.workspace.error = error.message;
          current.workspace.updatedAt = Date.now();
        });
        return finish(dynamicToolError(`${error.message}: ${conflictPaths.join(", ")}`));
      }
      if (error instanceof TeamWorkspaceError) {
        await store.update((state) => {
          const current = state.threadMeta[threadId]?.teamOrchestration?.tasks[taskId];
          if (current?.workspace) {
            current.workspace.lifecycle = "recoveryRequired";
            current.workspace.error = error.message;
            current.workspace.updatedAt = Date.now();
          }
        });
      }
      throw error;
    }
  }

  if (tool === "discard_task_changes") {
    if (!isTerminalTask(task)) {
      return finish(dynamicToolError("Only a terminal managed task can be discarded"));
    }
    if (!task.workspace) {
      return finish(dynamicToolError("This managed task has no isolated workspace"));
    }
    if (task.workspace.lifecycle === "discarded") {
      return finish(dynamicToolSuccess({ discarded: true, alreadyDiscarded: true }));
    }
    if (task.workspace.lifecycle === "integrated") {
      return finish(dynamicToolError("This managed task was already integrated"));
    }
    if (
      Object.values(store.view().threadMeta[threadId]?.teamOrchestration?.tasks ?? {}).some(
        (candidate) => candidate.predecessorTaskId === task.id,
      )
    ) {
      return finish(dynamicToolError("Discard the latest follow-up task instead"));
    }
    await store.update((state) => {
      const current = state.threadMeta[threadId]?.teamOrchestration?.tasks[taskId];
      if (current?.workspace) {
        current.workspace.lifecycle = "discarding";
        current.workspace.updatedAt = Date.now();
      }
    });
    try {
      await discardTeamWorkspace(task.workspace);
      await store.update((state) => {
        const orchestration = state.threadMeta[threadId]?.teamOrchestration;
        const current = orchestration?.tasks[taskId];
        if (current?.workspace) {
          for (const candidate of Object.values(orchestration?.tasks ?? {})) {
            if (candidate.workspace?.worktreePath !== current.workspace.worktreePath) continue;
            candidate.workspace.lifecycle = "discarded";
            candidate.workspace.updatedAt = Date.now();
            delete candidate.workspace.error;
          }
        }
      });
      return finish(dynamicToolSuccess({ discarded: true }));
    } catch (error) {
      await store.update((state) => {
        const current = state.threadMeta[threadId]?.teamOrchestration?.tasks[taskId];
        if (current?.workspace) {
          current.workspace.lifecycle = "recoveryRequired";
          current.workspace.error = safeError(error).message;
          current.workspace.updatedAt = Date.now();
        }
      });
      throw error;
    }
  }

  if (tool === "inspect_task") {
    let recentMessages: string[] = [];
    try {
      const page = parseTurnsList(
        await bridge.request<unknown>(
          "thread/turns/list",
          {
            threadId: task.childThreadId,
            limit: 1,
            sortDirection: "desc",
            itemsView: "full",
          },
          30_000,
        ),
      );
      recentMessages = (page.data[0]?.items ?? [])
        .filter(
          (item): item is Extract<ThreadItem, { type: "agentMessage" }> =>
            item.type === "agentMessage",
        )
        .map((item) => item.text.trim())
        .filter(Boolean)
        .slice(-3);
    } catch {
      // The persisted coordinator state is still useful when detailed history is unavailable.
    }
    return dynamicToolSuccess({
      ...publicManagedTask(task, store.view().threadMeta[threadId]?.teamOrchestration?.tasks),
      workspacePath:
        task.workspace && !["integrated", "discarded"].includes(task.workspace.lifecycle)
          ? task.workspace.worktreePath
          : null,
      recentMessages,
    });
  }

  if (tool === "steer_task") {
    const message = requiredToolString(args, "message");
    const markerId = teamToolMarkerId(prepared!.key);
    const sender = new DurableDelivery(store, bridge);
    const previous = store.view().messageReceipts?.[markerId];
    if (!previous && (task.status !== "running" || !task.childTurnId)) {
      return finish(dynamicToolError("Only a running managed task can be steered"));
    }
    const resultTurnId = (
      await sender.send(
        task.childThreadId,
        markerId,
        messageContentHash(message, [], [], false),
        "turn/steer",
        {
          threadId: task.childThreadId,
          expectedTurnId: task.childTurnId,
          clientUserMessageId: markerId,
          input: messageInput(message, []),
        },
      )
    ).turnId;
    await store.update((state) => {
      const current = state.threadMeta[threadId]?.teamOrchestration?.tasks[taskId];
      if (!current || isTerminalTask(current)) return;
      current.childTurnId = resultTurnId!;
      current.lastActivityAt = Date.now();
      delete current.watchdog;
    });
    return finish(dynamicToolSuccess({ accepted: true, turnId: resultTurnId }));
  }

  if (tool === "cancel_task") {
    if (isTerminalTask(task)) {
      return finish(dynamicToolSuccess({ accepted: true, status: task.status }));
    }
    const capacityRetry = store.view().threadMeta[task.childThreadId]?.capacityRetry;
    await projection.cancelCapacityRetry(task.childThreadId, undefined, false);
    const turnId =
      projection.summary(task.childThreadId)?.currentTurnId ??
      (capacityRetry ? null : task.childTurnId);
    if (turnId) {
      await bridge.request("turn/interrupt", {
        threadId: task.childThreadId,
        turnId,
      });
    }
    const reason = optionalToolString(args, "reason");
    await finalizeManagedTask(
      store,
      projection,
      task.childThreadId,
      `cancelled:${Date.now()}`,
      "interrupted",
      {
        summary: reason ? `Task cancelled: ${reason}` : "Task cancelled by the parent agent.",
        source: "status",
      },
      task.id,
    );
    return finish(dynamicToolSuccess({ accepted: true, status: "interrupted" }));
  }

  return finish(dynamicToolError(`Unknown CodexNest tool: ${tool}`));
}

async function createManagedTeamTask(
  bridge: CodexBridge,
  store: StateStore,
  projection: AppProjection,
  parent: ThreadSummary,
  title: string,
  prompt: string,
  taskId: string,
  childThreadSource: string,
  recoveredThread: Thread | null,
  options: ManagedTaskOptions,
): Promise<ManagedTeamTaskState> {
  if (store.view().threadMeta[parent.id]?.managedTeamToolsAvailable !== true) {
    throw new ProjectConflictError("This Team session does not have managed tools");
  }
  const creationId = `team-child:${parent.id}:${taskId}`;
  const serviceTier = sessionServiceTier(
    { ...parent.settings, model: options.model },
    projection.availableModels,
  );
  let child = recoveredThread;
  if (!child) {
    await store.update((state) => {
      state.threadCreations ??= {};
      state.threadCreations[creationId] ??= {
        projectId: `team:${parent.id}`,
        threadId: null,
        params: {
          clientCreationId: creationId,
          cwd: parent.cwd,
          model: options.model,
          serviceTier,
          ...(parent.settings.personality ? { personality: parent.settings.personality } : {}),
          config: teamRuntimeConfig(),
          developerInstructions: TEAM_CHILD_INSTRUCTIONS,
          dynamicTools: TEAM_CHILD_DYNAMIC_TOOLS,
          threadSource: childThreadSource,
        },
      };
    });
    const response = await bridge.request(
      "thread/start",
      store.view().threadCreations![creationId]!.params,
    );
    child = parseThreadStart(response).thread;
    if (bridge.deliveryVersion === 1) requireDeliveryReceipt(response, creationId, child.id);
    await store.update((state) => {
      state.threadCreations![creationId]!.threadId = child!.id;
    });
  }
  const started = { thread: child };
  projection.upsertThread(started.thread);
  await bridge
    .request("thread/name/set", { threadId: started.thread.id, name: title })
    .catch(() => undefined);
  const now = Date.now();
  const task: ManagedTeamTaskState = {
    id: taskId,
    childThreadId: started.thread.id,
    childThreadSource,
    startMessageId: teamTaskStartMarkerId(taskId),
    title,
    prompt,
    status: "queued",
    ...(options?.dependsOn.length ? { dependsOn: options.dependsOn } : {}),
    access: options.access,
    resolvedModel: options.model,
    resolvedReasoningEffort: options.reasoningEffort,
    resolvedServiceTier: serviceTier,
    createdAt: now,
    lastActivityAt: now,
  };
  await store.update((state) => {
    const parentMeta = state.threadMeta[parent.id] ?? {
      pinned: false,
      lastReadUpdatedAt: 0,
    };
    parentMeta.teamOrchestration ??= { tasks: {} };
    parentMeta.teamOrchestration.tasks[task.id] = task;
    state.threadMeta[parent.id] = parentMeta;
    const childMeta = state.threadMeta[task.childThreadId] ?? {
      pinned: false,
      lastReadUpdatedAt: 0,
    };
    childMeta.managedParent = { parentThreadId: parent.id, taskId: task.id };
    state.threadMeta[task.childThreadId] = childMeta;
  });
  projection.publishThreadState(task.childThreadId);
  return task;
}

function managedTaskDependencyFailure(
  task: ManagedTeamTaskView,
  tasks: ManagedTeamTaskMapView,
): string | null {
  for (const dependencyId of task.dependsOn ?? []) {
    const dependency = tasks[dependencyId];
    if (!dependency) return `Dependency ${dependencyId} is unavailable.`;
    if (!isTerminalTask(dependency)) continue;
    if (
      dependency.status !== "completed" ||
      (dependency.result?.outcome !== undefined && dependency.result.outcome !== "success") ||
      (dependency.workspace?.lifecycle === "discarded" &&
        Boolean(dependency.workspace.changedPaths?.length))
    ) {
      return `Dependency ${dependency.title} [${dependency.id}] did not complete successfully.`;
    }
  }
  return null;
}

function managedTaskDependenciesReady(
  task: ManagedTeamTaskView,
  tasks: ManagedTeamTaskMapView,
): boolean {
  return (task.dependsOn ?? []).every((dependencyId) => {
    const dependency = tasks[dependencyId];
    if (!dependency || !isTerminalTask(dependency) || dependency.delivery?.status !== "delivered") {
      return false;
    }
    if (dependency.status !== "completed") return false;
    if (dependency.result?.outcome !== undefined && dependency.result.outcome !== "success") {
      return false;
    }
    return (
      !dependency.workspace ||
      dependency.workspace.lifecycle === "integrated" ||
      (dependency.workspace.lifecycle === "discarded" && !dependency.workspace.changedPaths?.length)
    );
  });
}

async function prepareManagedTaskWorkspace(
  store: StateStore,
  parentThreadId: string,
  task: ManagedTeamTaskView,
  parentCwd: string,
): Promise<ManagedTeamTaskState["workspace"] | null> {
  if (task.access?.mode !== "isolatedWrite") return null;
  if (task.workspace) {
    const reused = {
      ...cloneView<NonNullable<ManagedTeamTaskState["workspace"]>>(task.workspace),
      lifecycle: "ready" as const,
      updatedAt: Date.now(),
    };
    await ensureManagedTaskSandboxMountpoints(reused.worktreePath);
    await store.update((state) => {
      const current = state.threadMeta[parentThreadId]?.teamOrchestration?.tasks[task.id];
      if (current?.status === "starting") current.workspace = reused;
    });
    return reused;
  }
  const metadata = await createTeamWorkspace(parentCwd, task.id);
  const now = Date.now();
  const workspace: NonNullable<ManagedTeamTaskState["workspace"]> = {
    lifecycle: "ready",
    ...metadata,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await ensureManagedTaskSandboxMountpoints(workspace.worktreePath);
    await store.update((state) => {
      const current = state.threadMeta[parentThreadId]?.teamOrchestration?.tasks[task.id];
      if (!current || current.status !== "starting") {
        throw new ProjectConflictError("Managed task is no longer starting");
      }
      current.workspace = workspace;
    });
  } catch (error) {
    await discardTeamWorkspace(metadata).catch(() => undefined);
    throw error;
  }
  return workspace;
}

async function ensureManagedTaskSandboxMountpoints(worktreePath: string): Promise<void> {
  for (const name of TEAM_SANDBOX_MOUNTPOINTS) {
    const mountpoint = join(worktreePath, name);
    try {
      await mkdir(mountpoint);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (!(await lstat(mountpoint)).isDirectory()) {
      throw new ProjectConflictError(`Team sandbox mountpoint is not a directory: ${name}`);
    }
  }
}

async function managedChildRuntime(
  task: ManagedTeamTaskView,
  parentCwd: string,
  workspace: ManagedTeamTaskState["workspace"] | null,
): Promise<ManagedChildRuntime> {
  if (!task.access) return { cwd: parentCwd };
  const networkAccess = task.access.network ?? false;
  if (task.access.mode === "readOnly") {
    return {
      cwd: parentCwd,
      runtimeWorkspaceRoots: [parentCwd],
      sandboxPolicy: { type: "readOnly", networkAccess },
    };
  }
  const root = task.access.mode === "isolatedWrite" ? workspace?.worktreePath : parentCwd;
  if (!root) throw new ProjectConflictError("The isolated Team workspace is unavailable");
  const cwd =
    workspace && task.access.mode === "isolatedWrite"
      ? isolatedTaskCwd(parentCwd, workspace)
      : parentCwd;
  const writableRoots = await Promise.all(
    (task.access.writePaths ?? []).map((path) => safeManagedWritableRoot(root, path)),
  );
  return {
    cwd,
    runtimeWorkspaceRoots:
      workspace && task.access.mode === "isolatedWrite"
        ? [workspace.worktreePath, workspace.repositoryRoot]
        : [parentCwd],
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots,
      networkAccess,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    },
  };
}

async function safeManagedWritableRoot(root: string, path: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const candidate = resolve(canonicalRoot, path);
  let existing = candidate;
  while (true) {
    try {
      const canonicalExisting = await realpath(existing);
      if (!pathContains(canonicalRoot, canonicalExisting)) {
        throw new ProjectValidationError(`Writable path escapes the managed workspace: ${path}`);
      }
      return candidate;
    } catch (error) {
      if (error instanceof ProjectValidationError) throw error;
      const parent = dirname(existing);
      if (parent === existing) {
        throw new ProjectValidationError(`Writable path is unavailable: ${path}`);
      }
      existing = parent;
    }
  }
}

function isolatedTaskCwd(
  parentCwd: string,
  workspace: NonNullable<ManagedTeamTaskState["workspace"]>,
): string {
  const child = relative(workspace.repositoryRoot, resolve(parentCwd));
  if (!child) return workspace.worktreePath;
  if (child === ".." || child.startsWith("../") || isAbsolute(child)) {
    return workspace.worktreePath;
  }
  return resolve(workspace.worktreePath, child);
}

async function startQueuedTeamTasks(
  bridge: CodexBridge,
  store: StateStore,
  projection: AppProjection,
  parentThreadId: string,
): Promise<void> {
  while (true) {
    const orchestration = store.view().threadMeta[parentThreadId]?.teamOrchestration;
    if (!orchestration) return;
    const active = Object.values(orchestration.tasks).filter(
      (task) => task.status === "starting" || task.status === "running",
    ).length;
    if (active >= TEAM_MAX_ACTIVE_TASKS) return;
    const queuedTasks = Object.values(orchestration.tasks)
      .filter((task) => task.status === "queued")
      .sort((left, right) => left.createdAt - right.createdAt);
    const dependencyFailure = queuedTasks
      .map((task) => ({ task, reason: managedTaskDependencyFailure(task, orchestration.tasks) }))
      .find((candidate) => candidate.reason);
    if (dependencyFailure) {
      await finalizeManagedTask(
        store,
        projection,
        dependencyFailure.task.childThreadId,
        `dependency-failed:${Date.now()}`,
        "failed",
        {
          outcome: "failed",
          summary: dependencyFailure.reason!,
          source: "status",
        },
        dependencyFailure.task.id,
      );
      continue;
    }
    const queued = queuedTasks.find((task) =>
      managedTaskDependenciesReady(task, orchestration.tasks),
    );
    if (!queued) return;

    await store.update((state) => {
      const task = state.threadMeta[parentThreadId]?.teamOrchestration?.tasks[queued.id];
      if (task?.status === "queued") {
        task.status = "starting";
        task.deliveryVersion = 1;
        task.lastActivityAt = Date.now();
      }
    });
    projection.publishThreadState(queued.childThreadId);

    try {
      const parent = projection.summary(parentThreadId);
      if (!parent) throw new Error("Managed task parent is unavailable");
      const model = managedChildModel(projection.availableModels);
      const launchTask: ManagedTeamTaskState = {
        ...cloneView<ManagedTeamTaskState>(queued),
        resolvedModel: model.id,
        resolvedReasoningEffort: compatibleManagedChildEffort(model, [
          queued.resolvedReasoningEffort,
          parent.settings.reasoningEffort,
        ]),
        resolvedServiceTier: isFastServiceTier(
          queued.resolvedServiceTier === undefined
            ? parent.settings.serviceTier
            : queued.resolvedServiceTier,
        )
          ? fastServiceTier(model)
          : null,
      };
      await store.update((state) => {
        const task = state.threadMeta[parentThreadId]?.teamOrchestration?.tasks[queued.id];
        if (!task || task.status !== "starting") return;
        task.resolvedModel = launchTask.resolvedModel;
        task.resolvedReasoningEffort = launchTask.resolvedReasoningEffort;
        task.resolvedServiceTier = launchTask.resolvedServiceTier;
      });
      const workspace = await prepareManagedTaskWorkspace(
        store,
        parentThreadId,
        launchTask,
        parent.cwd,
      );
      const runtime = await managedChildRuntime(launchTask, parent.cwd, workspace);
      await bridge.request<ThreadResumeResponse>(
        "thread/resume",
        {
          threadId: launchTask.childThreadId,
          cwd: runtime.cwd,
          ...(runtime.runtimeWorkspaceRoots
            ? { runtimeWorkspaceRoots: runtime.runtimeWorkspaceRoots }
            : {}),
          approvalPolicy: "never" as const,
          excludeTurns: true,
          ...managedChildResumeSettings(parent.settings, projection.availableModels, launchTask),
          config: teamRuntimeConfig(),
          developerInstructions: TEAM_CHILD_INSTRUCTIONS,
        },
        30_000,
      );
      const markerId = launchTask.startMessageId ?? teamTaskStartMarkerId(launchTask.id);
      const receipt = await new DurableDelivery(store, bridge).send(
        launchTask.childThreadId,
        markerId,
        messageContentHash(launchTask.prompt, [], [], false),
        "turn/start",
        {
          threadId: launchTask.childThreadId,
          clientUserMessageId: markerId,
          input: messageInput(launchTask.prompt, []),
          ...managedChildTurnSettings(
            parent.settings,
            projection.availableModels,
            launchTask,
            runtime,
          ),
        },
      );
      const turn = { turn: { id: receipt.turnId! } };
      await projection.markMaterialized(launchTask.childThreadId);
      await store.update((state) => {
        const task = state.threadMeta[parentThreadId]?.teamOrchestration?.tasks[queued.id];
        if (!task || task.status !== "starting") return;
        const now = Date.now();
        task.status = "running";
        task.childTurnId = turn.turn.id;
        task.startedAt = now;
        task.lastActivityAt = now;
        delete task.recoveryMisses;
      });
    } catch (error) {
      let recoveredTurnId: string | null;
      try {
        recoveredTurnId = await deliveredClientMessageTurnId(
          bridge,
          store,
          queued.childThreadId,
          queued.startMessageId ?? teamTaskStartMarkerId(queued.id),
        );
      } catch {
        // Keep "starting" durable while the bridge is ambiguous; cold recovery will retry.
        projection.publishThreadState(queued.childThreadId);
        return;
      }
      if (recoveredTurnId) {
        await projection.markMaterialized(queued.childThreadId);
        await projection.setCurrentTurn(queued.childThreadId, recoveredTurnId);
        await store.update((state) => {
          const task = state.threadMeta[parentThreadId]?.teamOrchestration?.tasks[queued.id];
          if (!task || isTerminalTask(task)) return;
          const now = Date.now();
          task.status = "running";
          task.childTurnId = recoveredTurnId!;
          task.startedAt ??= now;
          task.lastActivityAt = now;
        });
      } else {
        await finalizeManagedTask(
          store,
          projection,
          queued.childThreadId,
          `start-error:${Date.now()}`,
          "failed",
          {
            summary: `Managed task failed to start: ${safeError(error).message}`,
            source: "status",
          },
          queued.id,
        );
      }
    }
    projection.publishThreadState(queued.childThreadId);
  }
}

async function handleManagedTeamNotification(
  notification: ServerNotification,
  bridge: CodexBridge,
  store: StateStore,
  projection: AppProjection,
  activity: Map<string, number>,
  tokenUsage: Map<string, { tokens: number; persistedAt: number }>,
  capacityStartedTaskId?: string,
): Promise<Set<string>> {
  const affected = new Set<string>();
  const childThreadId = notificationThreadId(notification);
  if (!childThreadId) return affected;
  const managed =
    managedTaskForNotification(store.view(), notification) ??
    (capacityStartedTaskId
      ? managedTaskForChild(store.view(), childThreadId, capacityStartedTaskId)
      : null);
  if (!managed || isTerminalTask(managed.task)) return affected;
  if (notification.method === "turn/started" && capacityStartedTaskId) {
    await store.update((state) => {
      const task =
        state.threadMeta[managed.parentThreadId]?.teamOrchestration?.tasks[managed.task.id];
      if (task && !isTerminalTask(task)) task.childTurnId = notification.params.turn.id;
    });
  }
  const now = activity.get(childThreadId) ?? Date.now();
  const expectedWakeAt = managedSleepExpectedWakeAt(notification);
  const sleepCompleted =
    notification.method === "item/completed" && notification.params.item.type === "sleep";
  if (notification.method === "thread/tokenUsage/updated") {
    const tokensUsed = Math.max(0, Math.floor(notification.params.tokenUsage.last.totalTokens));
    const previousUsage = tokenUsage.get(childThreadId);
    const shouldPersist =
      !previousUsage || now - previousUsage.persistedAt >= TEAM_ACTIVITY_PERSIST_MS;
    tokenUsage.set(childThreadId, {
      tokens: tokensUsed,
      persistedAt: shouldPersist ? now : previousUsage.persistedAt,
    });
    if (shouldPersist) {
      await store.updateDeferred((state) => {
        const task =
          state.threadMeta[managed.parentThreadId]?.teamOrchestration?.tasks[managed.task.id];
        if (!task || isTerminalTask(task)) return;
        task.tokensUsed = tokensUsed;
        task.lastActivityAt = now;
      });
    }
  }
  if (expectedWakeAt !== null || sleepCompleted) {
    await store.update((state) => {
      const task =
        state.threadMeta[managed.parentThreadId]?.teamOrchestration?.tasks[managed.task.id];
      if (!task || isTerminalTask(task)) return;
      task.lastActivityAt = now;
      delete task.watchdog;
      if (expectedWakeAt !== null) {
        task.expectedWakeAt = expectedWakeAt;
      } else if (sleepCompleted) {
        delete task.expectedWakeAt;
      }
    });
  } else if (now - managed.task.lastActivityAt >= TEAM_ACTIVITY_PERSIST_MS) {
    await store.updateDeferred((state) => {
      const task =
        state.threadMeta[managed.parentThreadId]?.teamOrchestration?.tasks[managed.task.id];
      if (!task || isTerminalTask(task)) return;
      task.lastActivityAt = now;
      delete task.watchdog;
    });
  }

  if (notification.method === "turn/completed") {
    if (isCapacityFailure(notification.params.turn)) {
      await projection.prepareCapacityRetry(childThreadId, notification.params.turn);
      return affected;
    }
    const finalUsage = tokenUsage.get(childThreadId);
    if (finalUsage) {
      await store.update((state) => {
        const task =
          state.threadMeta[managed.parentThreadId]?.teamOrchestration?.tasks[managed.task.id];
        if (task && !isTerminalTask(task)) task.tokensUsed = finalUsage.tokens;
      });
      tokenUsage.delete(childThreadId);
    }
    let turn = notification.params.turn;
    if (!managed.task.resultCandidate && turn.itemsView !== "full") {
      const page = parseTurnsList(
        await bridge.request<unknown>(
          "thread/turns/list",
          {
            threadId: childThreadId,
            limit: 1,
            sortDirection: "desc",
            itemsView: "full",
          },
          30_000,
        ),
      );
      turn = page.data[0] ?? turn;
    }
    const result =
      managed.task.resultCandidate !== undefined
        ? submittedManagedResult(managed.task)
        : managedResultFromTurn(turn, turnOutcome(turn));
    if (
      await finalizeManagedTask(
        store,
        projection,
        childThreadId,
        turn.id,
        turnOutcome(turn),
        result,
        managed.task.id,
      )
    ) {
      affected.add(managed.parentThreadId);
    }
    return affected;
  }

  if (
    notification.method === "thread/status/changed" &&
    notification.params.status.type === "systemError"
  ) {
    if (
      await finalizeManagedTask(
        store,
        projection,
        childThreadId,
        `system-error:${Date.now()}`,
        "failed",
        {
          summary: "Managed task stopped because the Codex thread entered a system error state.",
          source: "status",
        },
        managed.task.id,
      )
    ) {
      affected.add(managed.parentThreadId);
    }
  } else if (notification.method === "thread/closed" || notification.method === "thread/deleted") {
    const outcome = notification.method === "thread/deleted" ? "failed" : "interrupted";
    if (
      await finalizeManagedTask(
        store,
        projection,
        childThreadId,
        `${notification.method}:${Date.now()}`,
        outcome,
        {
          summary:
            notification.method === "thread/deleted"
              ? "Managed task thread was deleted."
              : "Managed task thread was closed.",
          source: "status",
        },
        managed.task.id,
      )
    ) {
      affected.add(managed.parentThreadId);
    }
  }
  return affected;
}

async function finalizeManagedTask(
  store: StateStore,
  projection: AppProjection,
  childThreadId: string,
  terminalTurnId: string,
  outcome: ThreadOutcome,
  result: ManagedTeamTaskResult,
  expectedTaskId?: string,
): Promise<boolean> {
  const managed = managedTaskForChild(store.view(), childThreadId, expectedTaskId);
  if (!managed || isTerminalTask(managed.task)) return false;
  let workspaceUpdate: ManagedTeamTaskState["workspace"] | undefined;
  let changedPathCount = managed.task.workspace?.changedPaths?.length ?? 0;
  if (
    managed.task.workspace &&
    !["integrated", "discarded"].includes(managed.task.workspace.lifecycle)
  ) {
    try {
      const delta = await computeTeamWorkspaceDelta(managed.task.workspace);
      changedPathCount = delta.changedPaths.length;
      if (!delta.changedPaths.length) {
        await discardTeamWorkspace(managed.task.workspace);
        workspaceUpdate = {
          ...cloneView<NonNullable<ManagedTeamTaskState["workspace"]>>(managed.task.workspace),
          lifecycle: "discarded",
          changedPaths: [],
          updatedAt: Date.now(),
        };
      } else {
        workspaceUpdate = {
          ...cloneView<NonNullable<ManagedTeamTaskState["workspace"]>>(managed.task.workspace),
          lifecycle: "ready",
          changedPaths: delta.changedPaths,
          conflictPaths: undefined,
          error: undefined,
          updatedAt: Date.now(),
        };
      }
    } catch (error) {
      workspaceUpdate = {
        ...cloneView<NonNullable<ManagedTeamTaskState["workspace"]>>(managed.task.workspace),
        lifecycle: "recoveryRequired",
        error: safeError(error).message,
        updatedAt: Date.now(),
      };
    }
  }
  let recorded = false;
  await store.update((state) => {
    const task =
      state.threadMeta[managed.parentThreadId]?.teamOrchestration?.tasks[managed.task.id];
    if (!task || isTerminalTask(task)) return;
    task.status = outcome;
    task.terminalTurnId = terminalTurnId;
    if (workspaceUpdate) task.workspace = workspaceUpdate;
    const normalizedResult = !result.outcome
      ? {
          ...result,
          outcome: outcome === "completed" ? ("success" as const) : ("failed" as const),
        }
      : result;
    task.result = task.budgetReason
      ? {
          ...normalizedResult,
          outcome: changedPathCount > 0 ? "partial" : "failed",
        }
      : normalizedResult;
    if (task.startedAt) task.timeUsedSeconds = Math.max(0, (Date.now() - task.startedAt) / 1_000);
    task.lastActivityAt = Date.now();
    delete task.watchdog;
    delete task.delivery;
    delete task.recoveryMisses;
    delete task.expectedWakeAt;
    const childMeta = state.threadMeta[childThreadId];
    if (childMeta) {
      if (childMeta.capacityRetry) {
        childMeta.capacityRetryHandledTurnId = childMeta.capacityRetry.failedTurnId;
        delete childMeta.capacityRetry;
      }
      childMeta.lastOutcome = outcome;
      childMeta.outcomeUpdatedAt = Date.now();
    }
    recorded = true;
  });
  if (recorded) projection.publishThreadState(childThreadId);
  return recorded;
}

async function claimTeamResults(
  store: StateStore,
  parentThreadId: string,
): Promise<TeamResultClaim | null> {
  if (!hasPendingTeamContinuation(store, parentThreadId)) return null;
  const claimId = randomBytes(16).toString("hex");
  const results: TeamResultClaim["results"] = [];
  const watchdogs: TeamResultClaim["watchdogs"] = [];
  await store.update((state) => {
    const orchestration = state.threadMeta[parentThreadId]?.teamOrchestration;
    if (!orchestration) return;
    for (const task of Object.values(orchestration.tasks)) {
      if (isTerminalTask(task) && task.terminalTurnId && task.result && !task.delivery) {
        task.delivery = { status: "claimed", claimId };
        results.push({
          taskId: task.id,
          childThreadId: task.childThreadId,
          terminalTurnId: task.terminalTurnId,
          outcome: task.status,
          title: task.title,
          result: JSON.parse(JSON.stringify(task.result)) as ManagedTeamTaskResult,
        });
      }
      if (task.watchdog?.status === "pending") {
        task.watchdog = { ...task.watchdog, status: "claimed", claimId };
        watchdogs.push({
          taskId: task.id,
          childThreadId: task.childThreadId,
          title: task.title,
          status: task.status,
          lastActivityAt: task.lastActivityAt,
        });
      }
    }
  });
  return results.length || watchdogs.length ? { claimId, results, watchdogs } : null;
}

async function markTeamClaimDispatch(
  store: StateStore,
  parentThreadId: string,
  claimId: string,
  markerId: string,
  context: string,
): Promise<void> {
  await store.update((state) => {
    const orchestration = state.threadMeta[parentThreadId]?.teamOrchestration;
    if (!orchestration) return;
    const dispatchStartedAt = Date.now();
    const contextHash = sha256(context);
    for (const task of Object.values(orchestration.tasks)) {
      if (task.delivery?.status === "claimed" && task.delivery.claimId === claimId) {
        task.delivery = {
          ...task.delivery,
          markerId,
          dispatchStartedAt,
          deliveryVersion: 1,
          contextHash,
        };
      }
      if (task.watchdog?.status === "claimed" && task.watchdog.claimId === claimId) {
        task.watchdog = {
          ...task.watchdog,
          markerId,
          dispatchStartedAt,
          deliveryVersion: 1,
          contextHash,
        };
      }
    }
  });
}

async function deliverTeamClaim(
  store: StateStore,
  parentThreadId: string,
  claimId: string,
  parentTurnId: string,
): Promise<void> {
  await store.update((state) => {
    const orchestration = state.threadMeta[parentThreadId]?.teamOrchestration;
    if (!orchestration) return;
    for (const task of Object.values(orchestration.tasks)) {
      if (task.delivery?.status === "claimed" && task.delivery.claimId === claimId) {
        task.delivery = { ...task.delivery, status: "delivered", parentTurnId };
      }
      if (task.watchdog?.status === "claimed" && task.watchdog.claimId === claimId) {
        delete task.watchdog;
      }
    }
    cleanupTeamOrchestration(state, parentThreadId);
  });
}

async function releaseTeamClaim(
  store: StateStore,
  parentThreadId: string,
  claimId: string,
): Promise<void> {
  await store.update((state) => {
    const orchestration = state.threadMeta[parentThreadId]?.teamOrchestration;
    if (!orchestration) return;
    for (const task of Object.values(orchestration.tasks)) {
      if (task.delivery?.status === "claimed" && task.delivery.claimId === claimId) {
        delete task.delivery;
      }
      if (task.watchdog?.status === "claimed" && task.watchdog.claimId === claimId) {
        task.watchdog = { status: "pending", triggeredAt: task.watchdog.triggeredAt };
      }
    }
  });
}

function cleanupTeamOrchestration(state: CodexNestState, parentThreadId: string): void {
  const orchestration = state.threadMeta[parentThreadId]?.teamOrchestration;
  if (!orchestration) return;
  const terminal = Object.values(orchestration.tasks)
    .filter(
      (task) => isTerminalTask(task) && task.delivery?.status === "delivered" && !task.watchdog,
    )
    .sort((left, right) => right.createdAt - left.createdAt);
  const retained = new Set(terminal.slice(0, TEAM_TASK_HISTORY_LIMIT).map((task) => task.id));
  for (const task of terminal.slice(TEAM_TASK_HISTORY_LIMIT).reverse()) {
    const requiredByActiveTask = Object.values(orchestration.tasks).some(
      (candidate) =>
        !isTerminalTask(candidate) &&
        (candidate.predecessorTaskId === task.id || candidate.dependsOn?.includes(task.id)),
    );
    if (requiredByActiveTask) continue;
    const successor = Object.values(orchestration.tasks).find(
      (candidate) => candidate.predecessorTaskId === task.id,
    );
    const workspaceResolved =
      !task.workspace ||
      !managedTaskHasPendingWorkspace(task) ||
      Boolean(successor?.workspace?.worktreePath === task.workspace.worktreePath);
    if (!workspaceResolved || retained.has(task.id)) continue;
    for (const candidate of Object.values(orchestration.tasks)) {
      if (candidate.predecessorTaskId === task.id) delete candidate.predecessorTaskId;
      if (candidate.dependsOn?.includes(task.id)) {
        candidate.dependsOn = candidate.dependsOn.filter((dependency) => dependency !== task.id);
        if (!candidate.dependsOn.length) delete candidate.dependsOn;
      }
    }
    delete orchestration.tasks[task.id];
  }
}

function hasPendingTeamContinuation(store: StateStore, parentThreadId: string): boolean {
  const orchestration = store.view().threadMeta[parentThreadId]?.teamOrchestration;
  return Boolean(
    orchestration &&
    Object.values(orchestration.tasks).some(
      (task) =>
        (isTerminalTask(task) &&
          Boolean(task.terminalTurnId) &&
          Boolean(task.result) &&
          task.delivery === undefined) ||
        task.watchdog?.status === "pending",
    ),
  );
}

function hasClaimedTeamContinuation(store: StateStore, parentThreadId: string): boolean {
  const orchestration = store.view().threadMeta[parentThreadId]?.teamOrchestration;
  return Boolean(
    orchestration &&
    Object.values(orchestration.tasks).some(
      (task) => task.delivery?.status === "claimed" || task.watchdog?.status === "claimed",
    ),
  );
}

function pendingTeamParents(store: StateStore): string[] {
  const state = store.view();
  return Object.entries(state.threadMeta)
    .filter(([, meta]) => Boolean(meta.teamOrchestration))
    .map(([threadId]) => threadId);
}

function teamContinuationContext(
  store: StateStore,
  parentThreadId: string,
  claim: TeamResultClaim,
): string {
  const state = store.view();
  const active = Object.values(state.threadMeta[parentThreadId]?.teamOrchestration?.tasks ?? {})
    .filter((task) => task.status === "starting" || task.status === "running")
    .map((task) => `${task.title} [${task.id}]`);
  const queued = Object.values(state.threadMeta[parentThreadId]?.teamOrchestration?.tasks ?? {})
    .filter((task) => task.status === "queued")
    .map((task) => `${task.title} [${task.id}]`);
  const resultSections = claim.results.map((item) => {
    const task = state.threadMeta[parentThreadId]?.teamOrchestration?.tasks[item.taskId];
    return [
      `Task: ${item.title} [${item.taskId}]`,
      `Outcome: ${item.outcome}`,
      `Source: ${item.result.source}`,
      ...(item.result.outcome ? [`Result outcome: ${item.result.outcome}`] : []),
      `Summary: ${item.result.summary}`,
      ...(item.result.details ? [`Details:\n${item.result.details}`] : []),
      ...(item.result.checks?.length
        ? [
            `Checks:\n${item.result.checks
              .map(
                (check) =>
                  `- ${check.name}: ${check.outcome}${check.details ? ` — ${check.details}` : ""}`,
              )
              .join("\n")}`,
          ]
        : []),
      ...(item.result.risks?.length ? [`Risks:\n- ${item.result.risks.join("\n- ")}`] : []),
      ...(item.result.artifacts?.length
        ? [
            `Artifacts:\n${item.result.artifacts
              .map((artifact) => `- ${artifact.label}: ${artifact.path ?? artifact.url}`)
              .join("\n")}`,
          ]
        : []),
      ...(task?.budgetReason ? [`Budget limit: ${task.budgetReason}`] : []),
      ...(task?.workspace
        ? [
            `Workspace: ${task.workspace.lifecycle}${task.workspace.changedPaths?.length ? `; changed paths: ${task.workspace.changedPaths.join(", ")}` : ""}`,
          ]
        : []),
    ].join("\n");
  });
  const watchdogSections = claim.watchdogs.map(
    (item) =>
      `Silent task: ${item.title} [${item.taskId}], status=${item.status}, last activity=${new Date(item.lastActivityAt).toISOString()}. Inspect it, steer it, cancel it, or end the turn and let CodexNest continue automatically after its next event.`,
  );
  return [
    "CodexNest orchestration continuation.",
    ...(resultSections.length ? ["New terminal managed-task results:", ...resultSections] : []),
    ...(watchdogSections.length ? ["Managed-task watchdog:", ...watchdogSections] : []),
    active.length
      ? `Managed tasks still running: ${active.join(", ")}.`
      : "No managed tasks are currently running.",
    ...(queued.length ? [`Managed tasks queued: ${queued.join(", ")}.`] : []),
    "If this turn also contains an explicit user message, answer the user first.",
    "Then incorporate every named result into the original task, decide the next concrete action, and continue working.",
    "Do not merely acknowledge the result or say that you are waiting.",
  ].join(" ");
}

async function reconcileManagedTaskWorkspace(
  store: StateStore,
  parentThreadId: string,
  task: ManagedTeamTaskView,
): Promise<void> {
  const workspace = task.workspace;
  if (!workspace) return;
  try {
    if (workspace.lifecycle === "discarding") {
      await discardTeamWorkspace(workspace);
      await updateManagedWorkspaceFamily(store, parentThreadId, workspace.worktreePath, {
        lifecycle: "discarded",
        error: undefined,
      });
      return;
    }
    if (workspace.lifecycle === "integrating") {
      const activeSharedWriter = activeSharedWriteTask(store, parentThreadId, task.id);
      if (activeSharedWriter) {
        await updateManagedWorkspaceFamily(store, parentThreadId, workspace.worktreePath, {
          lifecycle: "recoveryRequired",
          error: `Wait for shared-write task ${activeSharedWriter.title} [${activeSharedWriter.id}] before recovering integration`,
        });
        return;
      }
      const integration = await integrateTeamWorkspace(workspace, task.access?.writePaths ?? []);
      await updateManagedWorkspaceFamily(store, parentThreadId, workspace.worktreePath, {
        lifecycle: "integrated",
        changedPaths: integration.changedPaths,
        conflictPaths: undefined,
        error: undefined,
      });
      try {
        await discardTeamWorkspace(workspace);
      } catch (error) {
        await updateManagedWorkspaceFamily(store, parentThreadId, workspace.worktreePath, {
          lifecycle: "integrated",
          error: safeError(error).message,
        });
      }
      return;
    }
    if (workspace.lifecycle === "integrated") {
      if (workspace.error) {
        try {
          await discardTeamWorkspace(workspace);
          await updateManagedWorkspaceFamily(store, parentThreadId, workspace.worktreePath, {
            lifecycle: "integrated",
            error: undefined,
          });
        } catch (error) {
          await updateManagedWorkspaceFamily(store, parentThreadId, workspace.worktreePath, {
            lifecycle: "integrated",
            error: safeError(error).message,
          });
        }
      }
      return;
    }
    if (workspace.lifecycle === "discarded") return;
    const delta = await computeTeamWorkspaceDelta(workspace);
    if (!delta.changedPaths.length && isTerminalTask(task)) {
      await discardTeamWorkspace(workspace);
      await updateManagedWorkspaceFamily(store, parentThreadId, workspace.worktreePath, {
        lifecycle: "discarded",
        changedPaths: [],
        conflictPaths: undefined,
        error: undefined,
      });
      return;
    }
    await updateManagedWorkspaceFamily(store, parentThreadId, workspace.worktreePath, {
      lifecycle: workspace.lifecycle === "conflicted" ? "conflicted" : "ready",
      changedPaths: delta.changedPaths,
      error: workspace.lifecycle === "conflicted" ? workspace.error : undefined,
    });
  } catch (error) {
    if (error instanceof TeamWorkspaceConflictError) {
      await updateManagedWorkspaceFamily(store, parentThreadId, workspace.worktreePath, {
        lifecycle: "conflicted",
        conflictPaths: error.conflicts.map((conflict) => conflict.path),
        error: error.message,
      });
      return;
    }
    await updateManagedWorkspaceFamily(store, parentThreadId, workspace.worktreePath, {
      lifecycle: "recoveryRequired",
      error: safeError(error).message,
    });
  }
}

function activeSharedWriteTask(
  store: StateStore,
  parentThreadId: string,
  excludedTaskId: string,
): ManagedTeamTaskView | undefined {
  return Object.values(
    store.view().threadMeta[parentThreadId]?.teamOrchestration?.tasks ?? {},
  ).find(
    (candidate) =>
      candidate.id !== excludedTaskId &&
      (candidate.status === "starting" || candidate.status === "running") &&
      candidate.access?.mode === "sharedWrite",
  );
}

async function updateManagedWorkspaceFamily(
  store: StateStore,
  parentThreadId: string,
  worktreePath: string,
  patch: Partial<NonNullable<ManagedTeamTaskState["workspace"]>>,
): Promise<void> {
  await store.update((state) => {
    const tasks = state.threadMeta[parentThreadId]?.teamOrchestration?.tasks ?? {};
    for (const candidate of Object.values(tasks)) {
      if (candidate.workspace?.worktreePath !== worktreePath) continue;
      candidate.workspace = {
        ...candidate.workspace,
        ...patch,
        updatedAt: Date.now(),
      };
    }
  });
}

async function reconcileTeamOrchestration(
  bridge: CodexBridge,
  store: StateStore,
  projection: AppProjection,
  onlyParentThreadId?: string,
): Promise<Set<string>> {
  const affected = new Set<string>();
  const state = store.view();
  for (const [parentThreadId, meta] of Object.entries(state.threadMeta)) {
    if (onlyParentThreadId && parentThreadId !== onlyParentThreadId) continue;
    const orchestration = meta.teamOrchestration;
    if (!orchestration) continue;
    const parent = projection.summary(parentThreadId);
    const claimedById = new Map<
      string,
      { results: TeamResultClaim["results"]; markerId: string | null; legacyDispatch: boolean }
    >();
    for (const task of Object.values(orchestration.tasks)) {
      if (task.workspace) {
        await reconcileManagedTaskWorkspace(store, parentThreadId, task).catch((error) => {
          projection.emit(
            "projectionError",
            error instanceof Error ? error : new Error(String(error)),
          );
        });
      }
      if (task.delivery?.status === "claimed") {
        const claim = claimedById.get(task.delivery.claimId) ?? {
          results: [],
          markerId: task.delivery.markerId ?? null,
          legacyDispatch: false,
        };
        if (isTerminalTask(task) && task.terminalTurnId && task.result) {
          claim.results.push({
            taskId: task.id,
            childThreadId: task.childThreadId,
            terminalTurnId: task.terminalTurnId,
            outcome: task.status,
            title: task.title,
            result: cloneView<ManagedTeamTaskResult>(task.result),
          });
        }
        claim.markerId ??= task.delivery.markerId ?? null;
        claim.legacyDispatch ||= Boolean(
          task.delivery.dispatchStartedAt && task.delivery.deliveryVersion !== 1,
        );
        claimedById.set(task.delivery.claimId, claim);
      }
      if (task.watchdog?.status === "claimed" && task.watchdog.claimId) {
        const claim = claimedById.get(task.watchdog.claimId) ?? {
          results: [],
          markerId: task.watchdog.markerId ?? null,
          legacyDispatch: false,
        };
        claim.markerId ??= task.watchdog.markerId ?? null;
        claim.legacyDispatch ||= Boolean(
          task.watchdog.dispatchStartedAt && task.watchdog.deliveryVersion !== 1,
        );
        claimedById.set(task.watchdog.claimId, claim);
      }
      if (task.status !== "running" && task.status !== "starting") continue;
      let expectedTurnId = task.childTurnId;
      if (task.status === "starting" && !expectedTurnId) {
        try {
          expectedTurnId =
            (await deliveredClientMessageTurnId(
              bridge,
              store,
              task.childThreadId,
              task.startMessageId ?? teamTaskStartMarkerId(task.id),
            )) ?? undefined;
        } catch (error) {
          projection.emit(
            "projectionError",
            error instanceof Error ? error : new Error(String(error)),
          );
          continue;
        }
        if (!expectedTurnId) {
          if (task.deliveryVersion !== 1) {
            projection.emit(
              "projectionError",
              new DeliveryContractError(
                "Запуск старой задачи Team не подтверждён. Повторная отправка остановлена.",
              ),
            );
            continue;
          }
          await store.update((draft) => {
            const current = draft.threadMeta[parentThreadId]?.teamOrchestration?.tasks[task.id];
            if (current?.status === "starting" && !current.childTurnId) {
              current.status = "queued";
            }
          });
          continue;
        }
      }
      const summary = projection.summary(task.childThreadId);
      if (summary?.currentTurnId && (!expectedTurnId || summary.currentTurnId === expectedTurnId)) {
        await store.update((draft) => {
          const current = draft.threadMeta[parentThreadId]?.teamOrchestration?.tasks[task.id];
          if (!current || isTerminalTask(current)) return;
          current.status = "running";
          current.childTurnId = summary.currentTurnId!;
          current.startedAt ??= Date.now();
          current.lastActivityAt = Date.now();
          delete current.recoveryMisses;
        });
        continue;
      }
      try {
        const page = parseTurnsList(
          await bridge.request<unknown>(
            "thread/turns/list",
            {
              threadId: task.childThreadId,
              limit: expectedTurnId ? TEAM_TASK_HISTORY_LIMIT : 1,
              sortDirection: "desc",
              itemsView: "full",
            },
            30_000,
          ),
        );
        const recoveredTurn = expectedTurnId
          ? page.data.find((turn) => turn.id === expectedTurnId)
          : page.data[0];
        if (recoveredTurn && recoveredTurn.status !== "inProgress") {
          if (isCapacityFailure(recoveredTurn)) {
            await projection.prepareCapacityRetry(task.childThreadId, recoveredTurn);
            continue;
          }
          const result = task.resultCandidate
            ? submittedManagedResult(task)
            : managedResultFromTurn(recoveredTurn, turnOutcome(recoveredTurn));
          if (
            await finalizeManagedTask(
              store,
              projection,
              task.childThreadId,
              recoveredTurn.id,
              turnOutcome(recoveredTurn),
              result,
              task.id,
            )
          ) {
            affected.add(parentThreadId);
          }
        } else if (recoveredTurn?.status === "inProgress") {
          await projection.setCurrentTurn(task.childThreadId, recoveredTurn.id);
          await store.update((draft) => {
            const current = draft.threadMeta[parentThreadId]?.teamOrchestration?.tasks[task.id];
            if (!current || isTerminalTask(current)) return;
            current.status = "running";
            current.childTurnId = recoveredTurn.id;
            current.startedAt ??= Date.now();
            current.lastActivityAt = Date.now();
            delete current.recoveryMisses;
          });
        } else if (!recoveredTurn && task.status === "starting") {
          await store.update((draft) => {
            const current = draft.threadMeta[parentThreadId]?.teamOrchestration?.tasks[task.id];
            if (current?.status === "starting") current.status = "queued";
          });
        } else if (!recoveredTurn && task.status === "running") {
          const misses = task.recoveryMisses ?? 0;
          if (misses < 1) {
            await store.update((draft) => {
              const current = draft.threadMeta[parentThreadId]?.teamOrchestration?.tasks[task.id];
              if (current?.status === "running") current.recoveryMisses = misses + 1;
            });
          } else {
            if (
              await finalizeManagedTask(
                store,
                projection,
                task.childThreadId,
                `reconcile-missing:${Date.now()}`,
                "interrupted",
                {
                  summary: "Managed task had no recoverable turn after CodexNest restarted.",
                  source: "status",
                },
                task.id,
              )
            ) {
              affected.add(parentThreadId);
            }
          }
        }
      } catch (error) {
        if (
          isMissingRolloutError(error) &&
          (await finalizeManagedTask(
            store,
            projection,
            task.childThreadId,
            `reconcile-deleted:${Date.now()}`,
            "failed",
            {
              summary: "Managed task thread is no longer available in Codex.",
              source: "status",
            },
            task.id,
          ))
        ) {
          affected.add(parentThreadId);
          continue;
        }
        projection.emit(
          "projectionError",
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    for (const [claimId, claim] of claimedById) {
      if (
        claim.legacyDispatch &&
        (!claim.markerId || !store.view().messageReceipts?.[claim.markerId])
      ) {
        projection.emit(
          "projectionError",
          new DeliveryContractError(
            "Доставка старой команды Team не подтверждена. Повторная отправка остановлена.",
          ),
        );
        continue;
      }
      if (!claim.markerId) {
        await releaseTeamClaim(store, parentThreadId, claimId);
        affected.add(parentThreadId);
        continue;
      }
      try {
        const deliveredTurnId = await deliveredClientMessageTurnId(
          bridge,
          store,
          parentThreadId,
          claim.markerId,
        );
        if (deliveredTurnId) {
          await deliverTeamClaim(store, parentThreadId, claimId, deliveredTurnId);
          await recordTeamNotice(
            store,
            projection,
            parentThreadId,
            deliveredTurnId,
            claim.results,
            isTeamContinuationMarkerId(claim.markerId) ? null : claim.markerId,
          );
        } else if (!parent?.currentTurnId) {
          await releaseTeamClaim(store, parentThreadId, claimId);
        }
        affected.add(parentThreadId);
      } catch (error) {
        projection.emit(
          "projectionError",
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    affected.add(parentThreadId);
  }
  return affected;
}

async function recordTeamNotice(
  store: StateStore,
  projection: AppProjection,
  parentThreadId: string,
  parentTurnId: string,
  results: TeamResultClaim["results"],
  afterItemId: string | null,
): Promise<void> {
  if (!results.length) return;
  await projection.recordOrchestrationNotice(
    parentThreadId,
    parentTurnId,
    results.map((result) => {
      const child = projection.summary(result.childThreadId);
      const task = store.view().threadMeta[parentThreadId]?.teamOrchestration?.tasks[result.taskId];
      return {
        threadId: result.childThreadId,
        title: result.title,
        nickname: child?.relation.kind === "subagent" ? child.relation.nickname : null,
        outcome: result.outcome,
        taskId: result.taskId,
        ...(result.result.outcome
          ? {
              result: {
                outcome: result.result.outcome,
                summary: result.result.summary,
                ...(result.result.checks ? { checks: result.result.checks } : {}),
              },
            }
          : {}),
        ...(task?.budgetReason ? { budgetReason: task.budgetReason } : {}),
        ...(task?.failureReason ? { failureReason: task.failureReason } : {}),
        ...(task?.workspace?.changedPaths?.length
          ? {
              changedPaths: task.workspace.changedPaths.slice(0, TEAM_NOTICE_CHANGED_PATH_LIMIT),
              changedPathCount: task.workspace.changedPaths.length,
            }
          : {}),
        ...(task?.workspace ? { workspaceIntegrationStatus: task.workspace.lifecycle } : {}),
      };
    }),
    afterItemId,
  );
}

function turnOutcome(turn: Turn): ThreadOutcome {
  if (turn.status === "failed") return "failed";
  if (turn.status === "interrupted") return "interrupted";
  return "completed";
}

function isManagedTeamNotification(notification: ServerNotification, store: StateStore): boolean {
  return Boolean(managedTaskForNotification(store.view(), notification));
}

export async function triggerTeamWatchdogs(
  store: StateStore,
  activity: Map<string, number>,
  now: number,
): Promise<Set<string>> {
  const affected = new Set<string>();
  const state = store.view();
  const due: Array<{ parentThreadId: string; taskId: string; lastActivityAt: number }> = [];
  for (const [parentThreadId, meta] of Object.entries(state.threadMeta)) {
    for (const task of Object.values(meta.teamOrchestration?.tasks ?? {})) {
      if (task.status !== "running" || task.watchdog) continue;
      if (state.threadMeta[task.childThreadId]?.capacityRetry) continue;
      if (teamWatchdogIsPaused(task, now)) continue;
      const lastActivityAt = Math.max(task.lastActivityAt, activity.get(task.childThreadId) ?? 0);
      if (
        now - lastActivityAt >= TEAM_WATCHDOG_MS &&
        now - (task.lastWatchdogAt ?? 0) >= TEAM_WATCHDOG_MS
      ) {
        due.push({ parentThreadId, taskId: task.id, lastActivityAt });
      }
    }
  }
  if (!due.length) return affected;
  await store.update((draft) => {
    for (const item of due) {
      const task = draft.threadMeta[item.parentThreadId]?.teamOrchestration?.tasks[item.taskId];
      if (!task || task.status !== "running" || task.watchdog) continue;
      if (draft.threadMeta[task.childThreadId]?.capacityRetry) continue;
      if (teamWatchdogIsPaused(task, now)) continue;
      const lastActivityAt = Math.max(task.lastActivityAt, activity.get(task.childThreadId) ?? 0);
      if (now - lastActivityAt < TEAM_WATCHDOG_MS) continue;
      task.lastActivityAt = lastActivityAt;
      task.lastWatchdogAt = now;
      task.watchdog = { status: "pending", triggeredAt: now };
      affected.add(item.parentThreadId);
    }
  });
  return affected;
}

function managedSleepExpectedWakeAt(notification: ServerNotification): number | null {
  if (notification.method !== "item/started" || notification.params.item.type !== "sleep") {
    return null;
  }
  const durationMs = notification.params.item.durationMs;
  if (!Number.isFinite(durationMs) || durationMs < 0) return null;
  return notification.params.startedAtMs + durationMs;
}

function teamWatchdogIsPaused(task: ManagedTeamTaskView, now: number): boolean {
  return task.expectedWakeAt !== undefined && now - task.expectedWakeAt < TEAM_WATCHDOG_MS;
}

function managedTaskForChild(
  state: CodexNestStateView,
  childThreadId: string,
  expectedTaskId?: string,
): { parentThreadId: string; task: ManagedTeamTaskView } | null {
  if (expectedTaskId) {
    for (const [parentThreadId, meta] of Object.entries(state.threadMeta)) {
      const task = meta.teamOrchestration?.tasks[expectedTaskId];
      if (task?.childThreadId === childThreadId) return { parentThreadId, task };
    }
    return null;
  }
  const relation = state.threadMeta[childThreadId]?.managedParent;
  if (relation) {
    const task =
      state.threadMeta[relation.parentThreadId]?.teamOrchestration?.tasks[relation.taskId];
    if (task?.childThreadId === childThreadId) {
      return { parentThreadId: relation.parentThreadId, task };
    }
  }
  for (const [parentThreadId, meta] of Object.entries(state.threadMeta)) {
    const task = Object.values(meta.teamOrchestration?.tasks ?? {}).find(
      (candidate) => candidate.childThreadId === childThreadId,
    );
    if (task) return { parentThreadId, task };
  }
  return null;
}

function managedTaskForNotification(
  state: CodexNestStateView,
  notification: ServerNotification,
): { parentThreadId: string; task: ManagedTeamTaskView } | null {
  const childThreadId = notificationThreadId(notification);
  if (!childThreadId) return null;
  const turnId = notificationTurnId(notification);
  if (!turnId) return managedTaskForChild(state, childThreadId);
  const retry = state.threadMeta[childThreadId]?.capacityRetry;
  if (retry?.dispatching && turnId !== retry.failedTurnId) {
    return managedTaskForChild(state, childThreadId);
  }
  for (const [parentThreadId, meta] of Object.entries(state.threadMeta)) {
    const task = Object.values(meta.teamOrchestration?.tasks ?? {}).find(
      (candidate) => candidate.childThreadId === childThreadId && candidate.childTurnId === turnId,
    );
    if (task) return { parentThreadId, task };
  }
  return null;
}

function notificationThreadId(notification: ServerNotification): string | null {
  if (notification.method === "thread/started") return notification.params.thread.id;
  const params = notification.params as unknown;
  if (!isObjectRecord(params)) return null;
  return typeof params.threadId === "string" ? params.threadId : null;
}

function notificationTurnId(notification: ServerNotification): string | null {
  if (notification.method === "turn/completed" || notification.method === "turn/started") {
    return notification.params.turn.id;
  }
  const params = notification.params as unknown;
  if (!isObjectRecord(params)) return null;
  return typeof params.turnId === "string" ? params.turnId : null;
}

function submittedManagedResult(task: ManagedTeamTaskView): ManagedTeamTaskResult {
  const candidate = task.resultCandidate;
  if (!candidate) {
    return {
      outcome: task.status === "completed" ? "success" : "failed",
      summary: "Managed task completed without a submitted result.",
      source: "status",
    };
  }
  return {
    summary: candidate.summary,
    ...(candidate.details ? { details: candidate.details } : {}),
    ...(candidate.outcome ? { outcome: candidate.outcome } : {}),
    ...(candidate.checks
      ? { checks: cloneView<ManagedTeamTaskResultCheck[]>(candidate.checks) }
      : {}),
    ...(candidate.risks ? { risks: [...candidate.risks] } : {}),
    ...(candidate.artifacts
      ? { artifacts: cloneView<ManagedTeamTaskResultArtifact[]>(candidate.artifacts) }
      : {}),
    source: "submitted",
  };
}

function managedResultFromTurn(turn: Turn, outcome: ThreadOutcome): ManagedTeamTaskResult {
  const messages = turn.items.filter(
    (item): item is Extract<ThreadItem, { type: "agentMessage" }> =>
      item.type === "agentMessage" && Boolean(item.text.trim()),
  );
  const final = [...messages].reverse().find((item) => item.phase === "final_answer");
  const selected = final ?? messages.at(-1);
  if (selected) {
    const text = selected.text.trim();
    const summary = firstResultParagraph(text);
    return {
      outcome: outcome === "completed" ? "success" : "failed",
      summary,
      ...(text !== summary ? { details: text } : {}),
      source: final ? "final_answer" : "agent_message",
    };
  }
  return {
    outcome: outcome === "completed" ? "success" : "failed",
    summary:
      outcome === "completed"
        ? "Managed task completed without an agent message."
        : outcome === "failed"
          ? "Managed task failed without an agent message."
          : "Managed task was interrupted without an agent message.",
    source: "status",
  };
}

function firstResultParagraph(text: string): string {
  const paragraph =
    text
      .split(/\n\s*\n/u)
      .find((part) => part.trim())
      ?.trim() ?? text.trim();
  return paragraph.length <= 500 ? paragraph : `${paragraph.slice(0, 499).trimEnd()}…`;
}

function isTerminalTask<Task extends { readonly status: ManagedTeamTaskState["status"] }>(
  task: Task,
): task is Task & { readonly status: ThreadOutcome } {
  return task.status === "completed" || task.status === "failed" || task.status === "interrupted";
}

function publicManagedTask(
  task: ManagedTeamTaskView,
  tasks?: ManagedTeamTaskMapView,
): Record<string, unknown> {
  const dependencies = (task.dependsOn ?? []).map((dependency) => tasks?.[dependency]);
  const queueReason =
    task.status !== "queued" || !dependencies.length
      ? null
      : dependencies.some(
            (dependency) =>
              !dependency ||
              !isTerminalTask(dependency) ||
              dependency.delivery?.status !== "delivered",
          )
        ? "waitingForDependencies"
        : dependencies.some(
              (dependency) =>
                dependency?.workspace &&
                dependency.workspace.lifecycle !== "integrated" &&
                !(
                  dependency.workspace.lifecycle === "discarded" &&
                  !dependency.workspace.changedPaths?.length
                ),
            )
          ? "waitingForIntegration"
          : null;
  return {
    taskId: task.id,
    threadId: task.childThreadId,
    title: task.title,
    status: task.status,
    queueReason,
    createdAt: task.createdAt,
    startedAt: task.startedAt ?? null,
    lastActivityAt: task.lastActivityAt,
    dependsOn: task.dependsOn ?? [],
    predecessorTaskId: task.predecessorTaskId ?? null,
    access: task.access ?? null,
    model: task.resolvedModel ?? null,
    reasoningEffort: task.resolvedReasoningEffort ?? null,
    tokensUsed: task.tokensUsed ?? 0,
    timeUsedSeconds:
      task.status === "running" && task.startedAt
        ? Math.max(task.timeUsedSeconds ?? 0, (Date.now() - task.startedAt) / 1_000)
        : (task.timeUsedSeconds ?? 0),
    failureReason: task.failureReason ?? null,
    workspace: task.workspace
      ? {
          lifecycle: task.workspace.lifecycle,
          changedPaths: task.workspace.changedPaths ?? [],
          conflictPaths: task.workspace.conflictPaths ?? [],
          error: task.workspace.error ?? null,
        }
      : null,
    result: task.result ?? null,
  };
}

function dynamicToolArguments(value: unknown): Record<string, unknown> {
  if (!isObjectRecord(value)) throw new ProjectValidationError("Tool arguments must be an object");
  return value;
}

type MutatingTeamTool = TeamToolOperationState["tool"];

function isMutatingTeamTool(value: string): value is MutatingTeamTool {
  return [
    "spawn_task",
    "followup_task",
    "steer_task",
    "cancel_task",
    "submit_result",
    "integrate_task",
    "discard_task_changes",
  ].includes(value);
}

function teamToolOperationKey(
  request: Extract<ServerRequest, { method: "item/tool/call" }>,
): string {
  const { threadId, turnId, callId, tool } = request.params;
  return sha256(`${threadId}\0${turnId}\0${callId}\0${tool}`);
}

async function prepareTeamToolOperation(
  store: StateStore,
  request: Extract<ServerRequest, { method: "item/tool/call" }>,
  args: Record<string, unknown>,
): Promise<{
  key: string;
  operation: TeamToolOperationState;
  created: boolean;
  conflict: boolean;
}> {
  const key = teamToolOperationKey(request);
  const argumentsHash = sha256(canonicalJson(args));
  let created = false;
  let conflict = false;
  let operation: TeamToolOperationState | undefined;
  await store.update((state) => {
    state.teamToolOperations ??= {};
    const existing = state.teamToolOperations[key];
    if (existing) {
      conflict = existing.argumentsHash !== argumentsHash;
      operation = JSON.parse(JSON.stringify(existing)) as TeamToolOperationState;
      return;
    }
    const now = Date.now();
    const next: TeamToolOperationState = {
      threadId: request.params.threadId,
      turnId: request.params.turnId,
      callId: request.params.callId,
      tool: request.params.tool as MutatingTeamTool,
      argumentsHash,
      status: "prepared",
      createdAt: now,
      updatedAt: now,
      ...(request.params.tool === "spawn_task" || request.params.tool === "followup_task"
        ? {
            taskId: randomUUID(),
            ...(request.params.tool === "spawn_task"
              ? { childThreadSource: `codexnest-managed:${key.slice(0, 32)}` }
              : {}),
          }
        : {}),
    };
    state.teamToolOperations[key] = next;
    operation = structuredClone(next);
    created = true;
  });
  return { key, operation: operation!, created, conflict };
}

async function completeTeamToolOperation(
  store: StateStore,
  key: string,
  response: DynamicToolCallResponse,
): Promise<void> {
  await store.update((state) => {
    const operation = state.teamToolOperations?.[key];
    if (!operation || operation.status === "applied") return;
    operation.status = "applied";
    operation.response = structuredClone(response);
    operation.updatedAt = Date.now();
  });
}

async function pruneAppliedTeamToolOperations(
  store: StateStore,
  threadId: string,
  turnId: string,
): Promise<void> {
  await store.update((state) => {
    for (const [key, operation] of Object.entries(state.teamToolOperations ?? {})) {
      if (
        operation.status === "applied" &&
        operation.threadId === threadId &&
        operation.turnId === turnId
      ) {
        delete state.teamToolOperations![key];
      }
    }
  });
}

async function pruneCompletedTeamToolOperations(
  bridge: CodexBridge,
  store: StateStore,
): Promise<void> {
  const grouped = new Map<string, TeamToolOperationView[]>();
  for (const operation of Object.values(store.view().teamToolOperations ?? {})) {
    if (operation.status !== "applied") continue;
    const operations = grouped.get(operation.threadId) ?? [];
    operations.push(operation);
    grouped.set(operation.threadId, operations);
  }
  const completedKeys = new Set<string>();
  for (const [threadId, operations] of grouped) {
    let turns: Turn[];
    try {
      turns = parseThreadRead(
        await bridge.request<unknown>("thread/read", { threadId, includeTurns: true }, 30_000),
      ).thread.turns;
    } catch {
      continue;
    }
    const terminalTurnIds = new Set(
      turns.filter((turn) => turn.status !== "inProgress").map((turn) => turn.id),
    );
    for (const operation of operations) {
      if (terminalTurnIds.has(operation.turnId)) {
        completedKeys.add(
          sha256(
            `${operation.threadId}\0${operation.turnId}\0${operation.callId}\0${operation.tool}`,
          ),
        );
      }
    }
  }
  if (!completedKeys.size) return;
  await store.update((state) => {
    for (const key of completedKeys) delete state.teamToolOperations?.[key];
  });
}

async function findThreadBySource(bridge: CodexBridge, source: string): Promise<Thread | null> {
  const candidates: Thread[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = parseThreadList(
      await bridge.request<unknown>(
        "thread/list",
        {
          cursor,
          limit: 100,
          sourceKinds: [],
          sortKey: "created_at",
          sortDirection: "asc",
        },
        30_000,
      ),
    );
    candidates.push(...page.data.filter((thread) => thread.threadSource === source));
    cursor = page.nextCursor;
    if (cursor && seenCursors.has(cursor)) break;
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return (
    candidates.sort(
      (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
    )[0] ?? null
  );
}

async function deliveredClientMessageTurnId(
  bridge: CodexBridge,
  store: StateStore,
  threadId: string,
  markerId: string,
): Promise<string | null> {
  const saved = store.view().messageReceipts?.[markerId];
  if (!saved) return null;
  if (saved.threadId !== threadId) {
    throw new DeliveryContractError("Доставка старой команды Team не подтверждена Codex.");
  }
  const sender = new DurableDelivery(store, bridge);
  try {
    return (await sender.replay(markerId)).turnId;
  } catch (error) {
    if (!isThreadResumeRequiredError(error, threadId)) throw error;
    await bridge.request("thread/resume", { threadId, excludeTurns: true });
    return (await sender.replay(markerId)).turnId;
  }
}

function teamToolMarkerId(operationKey: string): string {
  return `codexnest-team-tool:${operationKey}`;
}

function teamTaskStartMarkerId(taskId: string): string {
  return `codexnest-team-task:${taskId}`;
}

function teamContinuationMarkerId(claimId: string): string {
  return `codexnest-team-claim:${claimId}`;
}

function isTeamContinuationMarkerId(value: string): boolean {
  return (
    value.startsWith("codexnest-team-claim:") || value.startsWith("codexnest-team-continuation:")
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObjectRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function requiredToolString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new ProjectValidationError(`${key} must be a non-empty string`);
  }
  return value.trim();
}

function optionalToolString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ProjectValidationError(`${key} must be a string`);
  return value.trim() || undefined;
}

function optionalToolStringArray(
  args: Record<string, unknown>,
  key: string,
  maximum = 100,
): string[] | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maximum) {
    throw new ProjectValidationError(`${key} must be an array with at most ${maximum} items`);
  }
  const result = value.map((item) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new ProjectValidationError(`${key} must contain non-empty strings`);
    }
    return item.trim();
  });
  if (new Set(result).size !== result.length) {
    throw new ProjectValidationError(`${key} must not contain duplicates`);
  }
  return result;
}

function managedTaskAccess(
  args: Record<string, unknown>,
  inherited?: DeepReadonly<ManagedTeamTaskAccessState>,
): ManagedTeamTaskAccessState {
  const raw = args.access;
  if (raw === undefined) {
    return cloneView<ManagedTeamTaskAccessState>(inherited ?? { mode: "readOnly", network: false });
  }
  if (!isObjectRecord(raw)) throw new ProjectValidationError("access must be an object");
  const mode = raw.mode === undefined ? "readOnly" : raw.mode;
  if (!(["readOnly", "isolatedWrite", "sharedWrite"] as const).includes(mode as never)) {
    throw new ProjectValidationError("access.mode is invalid");
  }
  const writePaths = optionalToolStringArray(raw, "writePaths") ?? [];
  for (const path of writePaths) {
    if (!isManagedRelativePath(path)) {
      throw new ProjectValidationError(`Unsafe repository-relative write path: ${path}`);
    }
  }
  if (mode === "readOnly" && writePaths.length) {
    throw new ProjectValidationError("readOnly tasks cannot declare writePaths");
  }
  if (mode !== "readOnly" && !writePaths.length) {
    throw new ProjectValidationError("Write modes require at least one writePaths entry");
  }
  if (raw.network !== undefined && typeof raw.network !== "boolean") {
    throw new ProjectValidationError("access.network must be a boolean");
  }
  return {
    mode: mode as ManagedTeamTaskAccessState["mode"],
    ...(writePaths.length ? { writePaths } : {}),
    network: raw.network ?? false,
  };
}

function managedTaskOptions(
  args: Record<string, unknown>,
  settings: SessionSettings,
  models: ModelOption[],
  inherited?: ManagedTeamTaskView,
): ManagedTaskOptions {
  const model = managedChildModel(models);
  const requestedEffort = optionalToolString(args, "reasoningEffort");
  if (
    requestedEffort &&
    !model.reasoningEfforts.some((option) => option.value === requestedEffort)
  ) {
    throw new ProjectValidationError("The requested reasoning effort is unavailable");
  }
  const reasoningEffort =
    requestedEffort ??
    compatibleManagedChildEffort(model, [
      inherited?.resolvedReasoningEffort,
      settings.reasoningEffort,
    ]);
  return {
    dependsOn: optionalToolStringArray(args, "dependsOn", 50) ?? [],
    access: managedTaskAccess(args, inherited?.access),
    model: model.id,
    reasoningEffort,
  };
}

function managedChildModel(models: ModelOption[]): ModelOption {
  const model = models.find((candidate) => candidate.id === TEAM_CHILD_MODEL_ID);
  if (!model) {
    throw new ProjectValidationError(
      `The required managed-task model ${TEAM_CHILD_MODEL_ID} is unavailable`,
    );
  }
  return model;
}

function compatibleManagedChildEffort(
  model: ModelOption,
  candidates: Array<string | null | undefined>,
): string | null {
  return (
    candidates.find(
      (candidate): candidate is string =>
        Boolean(candidate) && model.reasoningEfforts.some((option) => option.value === candidate),
    ) ??
    model.reasoningEfforts.find((option) => option.isDefault)?.value ??
    null
  );
}

function isManagedRelativePath(value: string): boolean {
  return (
    value.length <= 4_096 &&
    !value.includes("\0") &&
    !value.includes("\\") &&
    !isAbsolute(value) &&
    value
      .split("/")
      .every(
        (segment) =>
          Boolean(segment) &&
          segment !== "." &&
          segment !== ".." &&
          segment.toLowerCase() !== ".git",
      )
  );
}

function managedResultFields(args: Record<string, unknown>): {
  outcome?: "success" | "partial" | "blocked" | "failed";
  checks?: ManagedTeamTaskResultCheck[];
  risks?: string[];
  artifacts?: ManagedTeamTaskResultArtifact[];
} {
  const outcomeValue = args.outcome;
  let outcome: "success" | "partial" | "blocked" | "failed" | undefined;
  if (outcomeValue !== undefined) {
    if (!(["success", "partial", "blocked", "failed"] as const).includes(outcomeValue as never)) {
      throw new ProjectValidationError("outcome is invalid");
    }
    outcome = outcomeValue as typeof outcome;
  }
  const risks = optionalToolStringArray(args, "risks");
  const checksValue = args.checks;
  const checks =
    checksValue === undefined
      ? undefined
      : parseManagedResultObjects<ManagedTeamTaskResultCheck>(checksValue, "checks", (entry) => {
          const name = requiredToolString(entry, "name");
          const checkOutcome = entry.outcome;
          if (!(["passed", "failed", "notRun"] as const).includes(checkOutcome as never)) {
            throw new ProjectValidationError("checks[].outcome is invalid");
          }
          return {
            name,
            outcome: checkOutcome as ManagedTeamTaskResultCheck["outcome"],
            ...(optionalToolString(entry, "details")
              ? { details: optionalToolString(entry, "details") }
              : {}),
          };
        });
  const artifactsValue = args.artifacts;
  const artifacts =
    artifactsValue === undefined
      ? undefined
      : parseManagedResultObjects<ManagedTeamTaskResultArtifact>(
          artifactsValue,
          "artifacts",
          (entry) => {
            const label = requiredToolString(entry, "label");
            const path = optionalToolString(entry, "path");
            const url = optionalToolString(entry, "url");
            if (path && !isManagedRelativePath(path)) {
              throw new ProjectValidationError("artifacts[].path must be repository-relative");
            }
            if (!path && !url) {
              throw new ProjectValidationError("Each artifact requires path or url");
            }
            if (url) {
              let parsed: URL;
              try {
                parsed = new URL(url);
              } catch {
                throw new ProjectValidationError("artifacts[].url is invalid");
              }
              if (
                !["http:", "https:"].includes(parsed.protocol) ||
                parsed.username ||
                parsed.password
              ) {
                throw new ProjectValidationError(
                  "artifacts[].url must be an HTTP(S) URL without credentials",
                );
              }
            }
            return { label, ...(path ? { path } : {}), ...(url ? { url } : {}) };
          },
        );
  return {
    ...(outcome ? { outcome } : {}),
    ...(checks ? { checks } : {}),
    ...(risks ? { risks } : {}),
    ...(artifacts ? { artifacts } : {}),
  };
}

function parseManagedResultObjects<T>(
  value: unknown,
  key: string,
  parse: (entry: Record<string, unknown>) => T,
): T[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new ProjectValidationError(`${key} must be an array with at most 100 items`);
  }
  return value.map((entry) => {
    if (!isObjectRecord(entry)) throw new ProjectValidationError(`${key} entries must be objects`);
    return parse(entry);
  });
}

async function validateManagedResultArtifacts(
  artifacts: ManagedTeamTaskResultArtifact[] | undefined,
  root: string | undefined,
): Promise<void> {
  const paths = artifacts?.flatMap((artifact) => (artifact.path ? [artifact.path] : [])) ?? [];
  if (!paths.length) return;
  if (!root) throw new ProjectValidationError("The managed task workspace is unavailable");
  const canonicalRoot = await realpath(root);
  for (const path of paths) {
    let canonicalArtifact: string;
    try {
      canonicalArtifact = await realpath(resolve(canonicalRoot, path));
    } catch {
      throw new ProjectValidationError(`Managed task artifact does not exist: ${path}`);
    }
    if (!pathContains(canonicalRoot, canonicalArtifact)) {
      throw new ProjectValidationError(`Managed task artifact escapes its workspace: ${path}`);
    }
  }
}

async function existingSessionHistoryPath(path: string | null): Promise<string | null> {
  if (!path) return null;
  try {
    const canonical = await realpath(path);
    return (await stat(canonical)).isFile() ? canonical : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

function dynamicToolSuccess(value: unknown): DynamicToolCallResponse {
  return {
    contentItems: [{ type: "inputText", text: JSON.stringify(value) }],
    success: true,
  };
}

function dynamicToolError(message: string): DynamicToolCallResponse {
  return {
    contentItems: [{ type: "inputText", text: JSON.stringify({ error: message }) }],
    success: false,
  };
}

function dynamicTool(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
): {
  type: "function";
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  deferLoading: true;
} {
  return { type: "function", name, description, inputSchema, deferLoading: true };
}

function teamRuntimeConfig(): Record<string, unknown> {
  return { agents: { enabled: false } };
}

function managedChildTurnSettings(
  settings: SessionSettings,
  models: ModelOption[],
  task?: ManagedTeamTaskView,
  runtime?: ManagedChildRuntime,
): Record<string, unknown> {
  const model = managedChildModel(models);
  const effort = compatibleManagedChildEffort(model, [
    task?.resolvedReasoningEffort,
    settings.reasoningEffort,
  ]);
  const serviceTier =
    task?.resolvedServiceTier === undefined ? settings.serviceTier : task.resolvedServiceTier;
  return compact({
    model: model.id,
    serviceTier: isFastServiceTier(serviceTier) ? fastServiceTier(model) : null,
    effort,
    personality: settings.personality,
    additionalContext: {
      "codexnest.images": { kind: "application", value: IMAGE_DELIVERY_CONTEXT },
    },
    ...(task && runtime
      ? {
          cwd: runtime.cwd,
          runtimeWorkspaceRoots: runtime.runtimeWorkspaceRoots,
          approvalPolicy: "never",
          sandboxPolicy: runtime.sandboxPolicy,
        }
      : {}),
    collaborationMode: {
      mode: "default",
      settings: {
        model: model.id,
        reasoning_effort: effort,
        developer_instructions: null,
      },
    },
  });
}

function managedChildResumeSettings(
  settings: SessionSettings,
  models: ModelOption[],
  task?: ManagedTeamTaskView,
): Record<string, unknown> {
  const model = managedChildModel(models);
  const serviceTier =
    task?.resolvedServiceTier === undefined ? settings.serviceTier : task.resolvedServiceTier;
  return compact({
    model: model.id,
    serviceTier: isFastServiceTier(serviceTier) ? fastServiceTier(model) : null,
    personality: settings.personality,
  });
}

async function markRootToolsAvailable(store: StateStore, threadId: string): Promise<void> {
  await store.update((state) => {
    const meta = state.threadMeta[threadId] ?? { pinned: false, lastReadUpdatedAt: 0 };
    meta.managedTeamToolsAvailable = true;
    meta.sessionArtifactsVersion = 1;
    state.threadMeta[threadId] = meta;
  });
}

function teamOrchestrationHasWork(store: StateStore, parentThreadId: string): boolean {
  const orchestration = store.view().threadMeta[parentThreadId]?.teamOrchestration;
  return Boolean(orchestration && Object.values(orchestration.tasks).some(managedTeamTaskHasWork));
}

function managedTeamTaskHasWork(task: ManagedTeamTaskView): boolean {
  return Boolean(
    !isTerminalTask(task) ||
    task.delivery?.status !== "delivered" ||
    task.watchdog ||
    managedTaskHasPendingWorkspace(task),
  );
}

function managedTaskHasPendingWorkspace(task: ManagedTeamTaskView): boolean {
  const workspace = task.workspace;
  return Boolean(
    workspace &&
    (!["integrated", "discarded"].includes(workspace.lifecycle) ||
      (workspace.lifecycle === "integrated" && workspace.error)),
  );
}

async function interruptTurnIfRunning(
  bridge: CodexBridge,
  threadId: string,
  turnId: string,
): Promise<string | null> {
  try {
    await bridge.request("turn/interrupt", { threadId, turnId });
    return turnId;
  } catch (error) {
    if (!(error instanceof RpcError)) throw error;
    let latest: Turn | undefined;
    try {
      latest = parseTurnsList(
        await bridge.request<unknown>(
          "thread/turns/list",
          {
            threadId,
            limit: 1,
            sortDirection: "desc",
            itemsView: "summary",
          },
          30_000,
        ),
      ).data[0];
    } catch (readError) {
      if (isMissingRolloutError(readError)) return null;
      throw error;
    }
    if (!latest || latest.status !== "inProgress") return null;
    if (latest.id === turnId) throw error;
    await bridge.request("turn/interrupt", { threadId, turnId: latest.id });
    return latest.id;
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class TeamContinuationStoppedError extends Error {
  constructor() {
    super("Team orchestration was stopped");
    this.name = "TeamContinuationStoppedError";
  }
}

function withKeyLock<T>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  locks.set(key, next);
  const cleanup = () => {
    if (locks.get(key) === next) locks.delete(key);
  };
  void next.then(cleanup, cleanup);
  return next;
}

function withTranscriptionTiming(
  config: TranscriptionConfigResponse,
  store: StateStore,
): TranscriptionConfigResponse {
  const profile = transcriptionTimingProfile(config);
  return {
    ...config,
    timingEstimate: transcriptionTimingEstimate(
      profile ? store.view().transcriptionTimings?.[profile] : undefined,
    ),
  };
}

function parseAudioDurationHeader(value: string | string[] | undefined): number | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new TranscriptionError("validation", "Audio duration must be an integer");
  }
  const durationMs = Number(value);
  if (
    !Number.isSafeInteger(durationMs) ||
    durationMs < 1 ||
    durationMs > MAX_RECORDING_SECONDS * 1_000
  ) {
    throw new TranscriptionError(
      "validation",
      `Audio duration must be between 1 and ${MAX_RECORDING_SECONDS * 1_000} milliseconds`,
    );
  }
  return durationMs;
}

function parseNonNegativeInteger(value: string | undefined): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function estimatedTranscriptionSeconds(
  config: TranscriptionConfigResponse,
  audioDurationMs: number,
): number | null {
  const fixed = config.timingEstimate.estimatedFixedProcessingMs;
  const perSecond = config.timingEstimate.estimatedProcessingMsPerAudioSecond;
  if (fixed === null || perSecond === null) return null;
  return Math.max(1, Math.ceil((fixed + (audioDurationMs / 1_000) * perSecond) / 1_000));
}

function requireCodexManager(manager: CodexManager | undefined): CodexManager {
  if (!manager) {
    throw new CodexManagementError("unsupported", "Codex management is not configured");
  }
  return manager;
}

function requireAppManager(manager: AppManager | undefined): AppManager {
  if (!manager) {
    throw new AppManagementError("unsupported", "CodexNest management is not configured");
  }
  return manager;
}

function sessionServiceTier(settings: SessionSettings, models: ModelOption[]): string | null {
  return isFastServiceTier(settings.serviceTier)
    ? fastServiceTier(effectiveModel(settings, models))
    : null;
}

function threadSettings(
  settings: SessionSettings | undefined,
  models: ModelOption[],
): Record<string, unknown> {
  if (!settings) return { serviceTier: null };
  return compact({
    model: settings.model,
    serviceTier: sessionServiceTier(settings, models),
    personality: settings.personality,
  });
}

function runtimeConfigOverride(
  browserExtension: BrowserExtensionServer | undefined,
  threadId: string,
  base: Record<string, unknown>,
): Record<string, unknown> {
  const config = browserExtension?.runtimeConfig(threadId, base) ?? base;
  return Object.keys(config).length ? { config } : {};
}

function browserResumeParams(
  store: StateStore,
  summary: ThreadSummary,
  models: ModelOption[],
  config: Record<string, unknown>,
): Record<string, unknown> {
  return {
    threadId: summary.id,
    cwd: summary.cwd,
    excludeTurns: true,
    ...threadSettings(summary.settings, models),
    ...(store.view().threadMeta[summary.id]?.sessionArtifactsVersion === 1
      ? { developerInstructions: SESSION_ARTIFACT_INSTRUCTIONS }
      : {}),
    ...(Object.keys(config).length ? { config } : {}),
  };
}

async function coldResumeThread(
  bridge: CodexBridge,
  threadId: string,
  targetParams: Record<string, unknown>,
  rollbackParams: Record<string, unknown>,
  persist: () => Promise<void>,
): Promise<void> {
  await bridge.request("thread/unsubscribe", { threadId }, 30_000);
  try {
    await bridge.request<ThreadResumeResponse>("thread/resume", targetParams, 30_000);
    await persist();
  } catch (error) {
    await bridge.request("thread/unsubscribe", { threadId }, 30_000).catch(() => undefined);
    try {
      await bridge.request<ThreadResumeResponse>("thread/resume", rollbackParams, 30_000);
    } catch {
      throw new BrowserExtensionError(
        "rollback_failed",
        "Browser configuration failed and the original thread subscription could not be restored",
      );
    }
    throw error;
  }
}

function assertBrowserWritable(summary: ThreadSummary, store: StateStore): void {
  if (summary.relation.kind === "subagent" || store.view().threadMeta[summary.id]?.managedParent) {
    throw new BrowserExtensionError(
      "not_writable",
      "Subagent and managed-child threads cannot use Browser MCP",
    );
  }
  if (summary.archived) {
    throw new BrowserExtensionError("not_writable", "Archived threads cannot use Browser MCP");
  }
  if (!summary.projectId) {
    throw new BrowserExtensionError(
      "not_writable",
      "Thread is not in a writable CodexNest project",
    );
  }
}

function browserThreadIsIdle(summary: ThreadSummary): boolean {
  return (
    summary.currentTurnId === null &&
    summary.state !== "running" &&
    summary.state !== "queued" &&
    summary.state !== "needsAttention"
  );
}

function turnSettings(
  settings: SessionSettings,
  models: ModelOption[],
  continuationContext?: string,
): Record<string, unknown> {
  const model = effectiveModel(settings, models);
  if (!model) throw new ProjectValidationError("No model is available for collaboration mode");
  const reasoningEffort =
    settings.reasoningEffort ??
    model.reasoningEfforts.find((option) => option.isDefault)?.value ??
    null;
  return compact({
    model: settings.model,
    serviceTier: sessionServiceTier(settings, models),
    effort: settings.reasoningEffort,
    personality: settings.personality,
    collaborationMode: {
      mode: settings.collaborationMode === "plan" ? "plan" : "default",
      settings: {
        model: model.id,
        reasoning_effort: reasoningEffort,
        developer_instructions: null,
      },
    },
    additionalContext: {
      "codexnest.images": { kind: "application", value: IMAGE_DELIVERY_CONTEXT },
      ...(settings.collaborationMode === "plan"
        ? {
            "codexnest.plan": {
              kind: "application",
              value: PLAN_MODE_CONTEXT,
            },
          }
        : {}),
      ...(settings.collaborationMode === "team"
        ? {
            "codexnest.team": {
              kind: "application",
              value: TEAM_MODE_CONTEXT,
            },
          }
        : {}),
      ...(continuationContext
        ? {
            "codexnest.team.results": {
              kind: "application",
              value: continuationContext,
            },
          }
        : {}),
    },
  });
}

function assertWritableThread(summary: ThreadSummary): void {
  if (summary.relation.kind === "subagent") {
    throw new ProjectConflictError("Subagent threads are managed by their parent session");
  }
}

function assertDirectInput(summary: ThreadSummary): void {
  if (summary.canAcceptDirectInput === false) throw new MessageQueueInputUnavailableError();
}

function validateSearchCursor(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !value || value.length > 16_384)
    throw new ProjectValidationError("Invalid search cursor");
  return value;
}

function validateSearchQuery(value: { q?: string; cursor?: string }): {
  q: string;
  cursor: string | null;
} {
  if (typeof value.q !== "string" || !value.q.trim() || value.q.length > 500)
    throw new ProjectValidationError("Search text must contain 1 to 500 characters");
  return { q: value.q.trim(), cursor: validateSearchCursor(value.cursor) };
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}

function cloneView<T>(value: DeepReadonly<T>): T {
  return structuredClone(value) as T;
}

function isLoopbackAddress(value: string): boolean {
  return value === "127.0.0.1" || value === "::1" || value.startsWith("::ffff:127.");
}

async function listSkillsForCwd(
  bridge: CodexBridge,
  cwd: string,
  forceReload: boolean,
): Promise<SkillsListEntry> {
  const response = parseSkillsList(
    await bridge.request<unknown>("skills/list", { cwds: [cwd], forceReload }),
  );
  const entry = response.data.find((candidate) => candidate.cwd === cwd);
  if (!entry) throw new ProtocolShapeError("skills/list requested cwd");
  return {
    ...entry,
    skills: entry.skills.filter(isSupportedSkill),
  };
}

function isSupportedSkill(skill: SkillMetadata): boolean {
  // Default artifact templates depend on capabilities CodexNest does not expose.
  return !skill.name.startsWith("openai-templates:");
}

function publicSkillsCatalog(entry: SkillsListEntry): SkillsCatalogResponse {
  return {
    cwd: entry.cwd,
    skills: entry.skills.map(publicSkill),
    errors: entry.errors.map(({ path, message }) => ({ path, message })),
  };
}

function publicSkill(skill: SkillMetadata): SkillCatalogItem {
  const skillInterface: unknown = skill.interface;
  const displayName =
    isRecord(skillInterface) && typeof skillInterface.displayName === "string"
      ? skillInterface.displayName
      : skill.name;
  const interfaceShortDescription =
    isRecord(skillInterface) && typeof skillInterface.shortDescription === "string"
      ? skillInterface.shortDescription
      : null;
  return {
    name: skill.name,
    displayName,
    description: skill.description,
    shortDescription:
      interfaceShortDescription ??
      (typeof skill.shortDescription === "string" ? skill.shortDescription : null),
    path: skill.path,
    scope: skill.scope,
    enabled: skill.enabled,
  };
}

function assertSkillsCwdAllowed(cwd: string, store: StateStore, projection: AppProjection): void {
  if (
    store.view().projects.some((project) => project.path === cwd) ||
    projection.snapshot().threads.some((thread) => thread.cwd === cwd)
  ) {
    return;
  }
  throw new ProjectForbiddenError("cwd is not a configured project or visible session path");
}

function skillAwareMessageInput(
  entry: SkillsListEntry | undefined,
  text: string,
  images: string[],
  files: ThreadFileAttachment[],
  goal: boolean,
  pastes: PastedText = {},
): UserInput[] {
  const input = messageInput(serializePastedMessage(text, pastes), images, files);
  for (const range of [...(pastes.inlinePastes ?? [])].reverse()) {
    text = text.slice(0, range.start) + " ".repeat(range.end - range.start) + text.slice(range.end);
  }
  if (goal || !entry || !/(?:^|\s)\$[\p{L}\p{N}_.:-]+/u.test(text)) return input;
  input.push(...explicitSkillItems(text, entry.skills));
  return input;
}

function explicitSkillItems(
  text: string,
  catalog: SkillMetadata[],
): Array<Extract<UserInput, { type: "skill" }>> {
  const enabledByName = new Map<string, SkillMetadata>();
  for (const skill of catalog) {
    if (skill.enabled && !enabledByName.has(skill.name)) enabledByName.set(skill.name, skill);
  }
  const seen = new Set<string>();
  const result: Array<Extract<UserInput, { type: "skill" }>> = [];
  let cursor = 0;
  while (cursor < text.length) {
    const marker = text.indexOf("$", cursor);
    if (marker < 0) break;
    cursor = marker + 1;
    if (marker > 0 && !/\s/u.test(text[marker - 1]!)) continue;
    let end = marker + 1;
    while (end < text.length && /[\p{L}\p{N}_.:-]/u.test(text[end]!)) end += 1;
    const name = text.slice(marker + 1, end);
    const skill = enabledByName.get(name);
    if (!skill || seen.has(name)) continue;
    seen.add(name);
    result.push({ type: "skill", name: skill.name, path: skill.path });
  }
  return result;
}

function messageInput(
  text: string,
  images: string[],
  files: ThreadFileAttachment[] = [],
): UserInput[] {
  const result: UserInput[] = [];
  const input = appendAttachmentContext(text, files);
  if (input) result.push({ type: "text", text: input, text_elements: [] });
  result.push(...images.map((url) => ({ type: "image" as const, url })));
  result.push(...files.map(({ name, path }) => ({ type: "mention" as const, name, path })));
  return result;
}

function validateForkThreadBody(value: unknown): ForkThreadRequest {
  const body = requireRecord<ForkThreadRequest>(value);
  if (Object.keys(body).some((key) => !["lastTurnId", "agentMessageId"].includes(key))) {
    throw new ProjectValidationError("Unknown fork field");
  }
  if (
    typeof body.lastTurnId !== "string" ||
    !body.lastTurnId ||
    body.lastTurnId.trim() !== body.lastTurnId ||
    typeof body.agentMessageId !== "string" ||
    !body.agentMessageId ||
    body.agentMessageId.trim() !== body.agentMessageId
  ) {
    throw new ProjectValidationError("lastTurnId and agentMessageId are required");
  }
  return body;
}

function validateCreateForkOperationBody(value: unknown): CreateForkOperationRequest {
  const body = requireRecord<CreateForkOperationRequest>(value);
  if (
    Object.keys(body).some(
      (key) => !["operationId", "lastTurnId", "agentMessageId", "mode"].includes(key),
    )
  ) {
    throw new ProjectValidationError("Unknown fork operation field");
  }
  validateForkThreadBody({ lastTurnId: body.lastTurnId, agentMessageId: body.agentMessageId });
  if (
    typeof body.operationId !== "string" ||
    !body.operationId ||
    body.operationId.length > 500 ||
    body.operationId.trim() !== body.operationId
  ) {
    throw new ProjectValidationError("operationId is required");
  }
  if (body.mode !== "compressed" && body.mode !== "exact") {
    throw new ProjectValidationError("mode must be compressed or exact");
  }
  return body;
}

async function validateForkPoint(
  bridge: CodexBridge,
  threadId: string,
  lastTurnId: string,
): Promise<{
  turn: Turn;
  response: Extract<ThreadItem, { type: "agentMessage" | "plan" }>;
  text: string;
}> {
  const turn = await readForkTurn(bridge, threadId, lastTurnId);
  if (!turn) throw new ProjectValidationError("Fork turn was not found");
  if (turn.status !== "completed") {
    throw new ProjectConflictError("Only completed turns can be forked");
  }
  // Item IDs can change from msg_* in live notifications to item-N in historical reads.
  // The Codex fork boundary is the stable turn ID, so resolve its response from fresh history.
  const response = [...turn.items]
    .reverse()
    .find(
      (item): item is Extract<ThreadItem, { type: "agentMessage" | "plan" }> =>
        (item.type === "agentMessage" || item.type === "plan") && Boolean(item.text.trim()),
    );
  if (!response) {
    throw new ProjectValidationError("Fork turn has no non-empty agent message or plan");
  }
  return { turn, response, text: response.text };
}

function temporaryForkTitle(sourceTitle: string): string {
  const prefix = "Ответвление: ";
  const source = sourceTitle.trim() || "Без названия";
  const maxCharacters = 100;
  const characters = [...source];
  const available = maxCharacters - [...prefix].length;
  if (characters.length <= available) return `${prefix}${source}`;
  return `${prefix}${characters
    .slice(0, Math.max(1, available - 1))
    .join("")
    .trimEnd()}…`;
}

function parseExpectedDraftRevision(value: string | undefined): number | null | undefined {
  if (value === undefined) return undefined;
  const parsed = value === "none" ? null : parseNonNegativeInteger(value);
  if (parsed === undefined || (parsed === null && value !== "none")) {
    throw new ProjectValidationError("Draft revision is invalid");
  }
  return parsed;
}

function validateQueueMessageBody(value: unknown): PastedText & {
  input: string;
  images: string[];
  files: ThreadFileAttachment[];
  goal: boolean;
  planImplementationMode?: PlanImplementationMode;
  clientMessageId?: string;
  replyToAsyncQuestion?: AsyncQuestionReference;
  replyToUserInput?: UserInputReply;
  dismissUserInput?: AsyncQuestionReference;
  projectDraft?: QueueMessageRequest["projectDraft"];
} {
  const body = requireRecord<QueueMessageRequest>(value);
  if (
    Object.keys(body).some(
      (key) =>
        ![
          "input",
          "inlinePastes",
          "pasteBlocks",
          "images",
          "files",
          "goal",
          "planImplementationMode",
          "projectDraft",
          "clientMessageId",
          "replyToAsyncQuestion",
          "replyToUserInput",
          "dismissUserInput",
        ].includes(key),
    )
  ) {
    throw new ProjectValidationError("Unknown queue field");
  }
  if (typeof body.input === "string" && !validPastedText(body, body.input))
    throw new ProjectValidationError("Invalid pasted text");
  if (
    body.projectDraft !== undefined &&
    (!isRecord(body.projectDraft) ||
      typeof body.projectDraft.projectId !== "string" ||
      !body.projectDraft.projectId.trim() ||
      !Number.isSafeInteger(body.projectDraft.updatedAt) ||
      body.projectDraft.updatedAt < 0)
  ) {
    throw new ProjectValidationError("Invalid project draft revision");
  }
  const images = validateImages(body.images);
  const files = validateFiles(body.files);
  validateAttachmentPayloadSize(images, files);
  const clientMessageId = optionalClientMessageId(body.clientMessageId);
  if (!clientMessageId) throw new ProjectValidationError("clientMessageId is required");
  if (
    typeof body.input !== "string" ||
    (!body.input.trim() && !images.length && !files.length && !body.pasteBlocks?.length)
  ) {
    throw new ProjectValidationError("input, images, or files are required");
  }
  if (body.goal !== undefined && typeof body.goal !== "boolean") {
    throw new ProjectValidationError("goal must be boolean");
  }
  const planImplementationMode = body.planImplementationMode;
  if (
    planImplementationMode !== undefined &&
    (!["default", "goal", "team"].includes(planImplementationMode) ||
      body.replyToAsyncQuestion ||
      body.replyToUserInput ||
      body.dismissUserInput ||
      (body.goal !== undefined && body.goal !== (planImplementationMode === "goal")))
  ) {
    throw new ProjectValidationError("Invalid plan implementation mode");
  }
  const goal = planImplementationMode ? planImplementationMode === "goal" : (body.goal ?? false);
  if (goal && (!body.input.trim() || body.input.trim().length > 4_000)) {
    throw new ProjectValidationError("goal objective must be 1-4000 characters");
  }
  if (body.clientMessageId !== undefined && clientMessageId === null) {
    throw new ProjectValidationError("clientMessageId must not be empty");
  }
  let replyToUserInput: UserInputReply | undefined;
  const dismissUserInput = validateDismissUserInput(body.dismissUserInput);
  if (dismissUserInput && (body.replyToUserInput || body.replyToAsyncQuestion)) {
    throw new ProjectValidationError("Cannot answer and dismiss a question together");
  }
  if (body.replyToUserInput !== undefined) {
    const reference = requireRecord<UserInputReply>(body.replyToUserInput);
    if (
      !optionalClientMessageId(reference.turnId) ||
      !optionalClientMessageId(reference.itemId) ||
      !isRecord(reference.answers) ||
      !clientMessageId ||
      body.goal ||
      body.replyToAsyncQuestion ||
      Object.values(reference.answers).some(
        (answers) =>
          !Array.isArray(answers) || answers.some((answer) => typeof answer !== "string"),
      )
    ) {
      throw new ProjectValidationError("Invalid user input reply");
    }
    replyToUserInput = reference;
  }
  let replyToAsyncQuestion: AsyncQuestionReference | undefined;
  if (body.replyToAsyncQuestion !== undefined) {
    const reference = requireRecord<AsyncQuestionReference>(body.replyToAsyncQuestion);
    if (
      Object.keys(reference).some((key) => key !== "turnId" && key !== "itemId") ||
      !optionalClientMessageId(reference.turnId) ||
      typeof reference.itemId !== "string" ||
      !reference.itemId.trim() ||
      reference.itemId.length > 500 ||
      !clientMessageId ||
      body.goal ||
      images.length ||
      files.length
    ) {
      throw new ProjectValidationError("Invalid async question reply");
    }
    replyToAsyncQuestion = { turnId: reference.turnId, itemId: reference.itemId };
  }
  return {
    ...(body.projectDraft ? { projectDraft: body.projectDraft } : {}),
    input: body.input,
    ...pastedText(body),
    images,
    files,
    goal,
    ...(planImplementationMode ? { planImplementationMode } : {}),
    ...(clientMessageId ? { clientMessageId } : {}),
    ...(replyToAsyncQuestion ? { replyToAsyncQuestion } : {}),
    ...(replyToUserInput ? { replyToUserInput } : {}),
    ...(dismissUserInput ? { dismissUserInput } : {}),
  };
}

function validateDismissUserInput(value: unknown): AsyncQuestionReference | undefined {
  if (value === undefined) return undefined;
  const reference = requireRecord<AsyncQuestionReference>(value);
  if (
    Object.keys(reference).some((key) => key !== "turnId" && key !== "itemId") ||
    !optionalClientMessageId(reference.turnId) ||
    !optionalClientMessageId(reference.itemId)
  ) {
    throw new ProjectValidationError("Invalid user input dismissal");
  }
  return { turnId: reference.turnId, itemId: reference.itemId };
}

async function readForkTurn(
  bridge: CodexBridge,
  threadId: string,
  turnId: string,
): Promise<Turn | undefined> {
  let cursor: string | null = null;
  do {
    const page = parseTurnsList(
      await bridge.request<unknown>(
        "thread/turns/list",
        {
          threadId,
          cursor,
          limit: 100,
          sortDirection: "desc",
          itemsView: "full",
        },
        30_000,
      ),
    );
    const turn = page.data.find((candidate) => candidate.id === turnId);
    if (turn) return turn;
    cursor = page.nextCursor;
  } while (cursor);
  return undefined;
}

function validateStartTurnBody(body: unknown, reply: FastifyReply): StartTurnRequest | undefined {
  const value = requireRecord<StartTurnRequest>(body);
  if (
    Object.keys(value).some(
      (key) =>
        ![
          "input",
          "inlinePastes",
          "pasteBlocks",
          "images",
          "files",
          "goal",
          "clientMessageId",
        ].includes(key),
    )
  ) {
    throw new ProjectValidationError("Unknown turn field");
  }
  if (typeof value.input === "string" && !validPastedText(value, value.input))
    throw new ProjectValidationError("Invalid pasted text");
  const images = validateImages(value.images);
  const files = validateFiles(value.files);
  validateAttachmentPayloadSize(images, files);
  if (
    typeof value.input !== "string" ||
    (!value.input.trim() && !images.length && !files.length && !value.pasteBlocks?.length)
  ) {
    apiError(reply, 400, "validation_failed", "input, images, or files are required");
    return undefined;
  }
  if (value.goal !== undefined && typeof value.goal !== "boolean") {
    apiError(reply, 400, "validation_failed", "goal must be boolean");
    return undefined;
  }
  if (value.goal && (!value.input.trim() || value.input.trim().length > 4_000)) {
    apiError(reply, 400, "validation_failed", "goal objective must be 1-4000 characters");
    return undefined;
  }
  if (optionalClientMessageId(value.clientMessageId) === null) {
    apiError(reply, 400, "validation_failed", "clientMessageId must not be empty");
    return undefined;
  }
  return { ...value, images, files };
}

function optionalClientMessageId(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    value.trim() === value
    ? value
    : null;
}

function optionalVoiceUploadId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(value)
    ? value
    : null;
}

function validateImages(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((image) => !isInlineImage(image))) {
    throw new ProjectValidationError("images must contain inline image data URLs");
  }
  return value;
}

function validateFiles(value: unknown): ThreadFileAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isAttachmentShape)) {
    throw new ProjectValidationError("files must contain valid uploaded attachments");
  }
  return value.map((attachment) => ({ ...attachment }));
}

function validateAttachmentPayloadSize(
  images: readonly string[],
  files: readonly ThreadFileAttachment[],
): void {
  const imageBytes = images.reduce((total, image) => {
    const comma = image.indexOf(",");
    const encoded = comma >= 0 ? image.length - comma - 1 : 0;
    const bytes = Math.floor((encoded * 3) / 4);
    if (bytes > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentTooLargeError("File exceeds the 100 MiB limit");
    }
    return total + bytes;
  }, 0);
  if (
    imageBytes + files.reduce((total, file) => total + file.size, 0) >
    MAX_MESSAGE_ATTACHMENT_BYTES
  ) {
    throw new AttachmentTooLargeError("Attachments exceed the 250 MiB message limit");
  }
}

function validateThreadDraft(value: unknown): UpdateThreadDraftRequest {
  const body = requireRecord<UpdateThreadDraftRequest>(value);
  if (
    Object.keys(body).some(
      (key) =>
        ![
          "input",
          "inlinePastes",
          "pasteBlocks",
          "images",
          "files",
          "goalMode",
          "annotations",
        ].includes(key),
    ) ||
    typeof body.input !== "string" ||
    !validPastedText(body, body.input) ||
    typeof body.goalMode !== "boolean" ||
    !Array.isArray(body.images) ||
    !Array.isArray(body.annotations)
  ) {
    throw new ProjectValidationError("Invalid thread draft");
  }
  const images = body.images.map((image) => {
    if (
      !isRecord(image) ||
      typeof image.id !== "string" ||
      !image.id ||
      typeof image.name !== "string" ||
      !image.name ||
      !isInlineImage(image.url)
    ) {
      throw new ProjectValidationError("Invalid draft image");
    }
    return { id: image.id, name: image.name, url: image.url };
  });
  const files = validateFiles(body.files);
  validateAttachmentPayloadSize(
    images.map((image) => image.url),
    files,
  );
  const annotations = body.annotations.map((annotation) => {
    if (
      !isRecord(annotation) ||
      typeof annotation.id !== "string" ||
      !annotation.id ||
      typeof annotation.messageId !== "string" ||
      !annotation.messageId ||
      !["agentMessage", "plan"].includes(String(annotation.source)) ||
      typeof annotation.quote !== "string" ||
      !annotation.quote.trim() ||
      !Number.isInteger(annotation.startOffset) ||
      annotation.startOffset < 0 ||
      !Number.isInteger(annotation.endOffset) ||
      annotation.endOffset <= annotation.startOffset ||
      typeof annotation.comment !== "string" ||
      !annotation.comment.trim() ||
      typeof annotation.createdAt !== "number" ||
      !Number.isFinite(annotation.createdAt)
    ) {
      throw new ProjectValidationError("Invalid draft annotation");
    }
    return {
      id: annotation.id,
      messageId: annotation.messageId,
      source: annotation.source as "agentMessage" | "plan",
      quote: annotation.quote,
      startOffset: annotation.startOffset,
      endOffset: annotation.endOffset,
      comment: annotation.comment,
      createdAt: annotation.createdAt,
    };
  });
  return {
    input: body.input,
    ...pastedText(body),
    images,
    files,
    goalMode: body.goalMode,
    annotations,
  };
}

function validateUserInputDraft(
  value: unknown,
  questions: readonly UserInputQuestion[],
): UpdateUserInputDraftRequest {
  const body = requireRecord<UpdateUserInputDraftRequest>(value);
  if (
    Object.keys(body).some(
      (key) => !["answers", "currentQuestionId", "appliedRecordingIds"].includes(key),
    ) ||
    !isRecord(body.answers)
  ) {
    throw new ProjectValidationError("Invalid user-input draft");
  }
  const knownQuestionIds = new Set(questions.map((question) => question.id));
  const entries: Array<[string, string[]]> = [];
  for (const [questionId, value] of Object.entries(body.answers)) {
    if (
      !knownQuestionIds.has(questionId) ||
      !Array.isArray(value) ||
      value.length !== 1 ||
      typeof value[0] !== "string" ||
      !value[0].trim()
    ) {
      throw new ProjectValidationError("Invalid user-input draft answer");
    }
    entries.push([questionId, [value[0]]]);
  }
  if (
    body.currentQuestionId !== null &&
    (typeof body.currentQuestionId !== "string" || !knownQuestionIds.has(body.currentQuestionId))
  ) {
    throw new ProjectValidationError("Unknown current user-input question");
  }
  if (
    body.appliedRecordingIds !== undefined &&
    (!Array.isArray(body.appliedRecordingIds) ||
      body.appliedRecordingIds.some((id) => typeof id !== "string" || !optionalVoiceUploadId(id)))
  ) {
    throw new ProjectValidationError("Invalid applied recordings");
  }
  return {
    answers: Object.fromEntries(entries),
    currentQuestionId: body.currentQuestionId,
    ...(body.appliedRecordingIds ? { appliedRecordingIds: body.appliedRecordingIds } : {}),
  };
}

function isInlineImage(value: unknown): value is string {
  return typeof value === "string" && /^data:image\/[a-z0-9.+-]+;base64,/i.test(value);
}

function validateTaskDefaults(value: unknown): UpdateTaskDefaultsRequest {
  const body = requireRecord<UpdateTaskDefaultsRequest>(value);
  if (
    Object.keys(body).some(
      (key) => !["model", "titleModel", "serviceTier", "personality"].includes(key),
    )
  ) {
    throw new ProjectValidationError("Unknown task default");
  }
  for (const key of ["model", "titleModel", "serviceTier", "personality"] as const) {
    if (
      body[key] !== undefined &&
      body[key] !== null &&
      (typeof body[key] !== "string" || !body[key]?.trim())
    ) {
      throw new ProjectValidationError(`${key} must be a non-empty string or null`);
    }
  }
  return body;
}

function validateGoalPatch(value: unknown): UpdateThreadGoalRequest {
  const body = requireRecord<UpdateThreadGoalRequest>(value);
  if (Object.keys(body).some((key) => !["objective", "status"].includes(key))) {
    throw new ProjectValidationError("Unknown goal field");
  }
  if (
    body.objective !== undefined &&
    (typeof body.objective !== "string" ||
      !body.objective.trim() ||
      body.objective.trim().length > 4_000)
  ) {
    throw new ProjectValidationError("goal objective must be 1-4000 characters");
  }
  if (
    body.status !== undefined &&
    !["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"].includes(
      body.status,
    )
  ) {
    throw new ProjectValidationError("Invalid goal status");
  }
  if (body.objective === undefined && body.status === undefined) {
    throw new ProjectValidationError("At least one goal field is required");
  }
  return {
    ...(body.objective === undefined ? {} : { objective: body.objective.trim() }),
    ...(body.status === undefined ? {} : { status: body.status }),
  };
}

function validateSettingsPatch(value: unknown): UpdateThreadSettingsRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectValidationError("settings must be an object");
  }
  const settings = value as Record<string, unknown>;
  const known = new Set([
    "collaborationMode",
    "model",
    "reasoningEffort",
    "serviceTier",
    "personality",
  ]);
  if (Object.keys(settings).some((key) => !known.has(key))) {
    throw new ProjectValidationError("Unknown session setting");
  }
  if (
    settings.collaborationMode !== undefined &&
    !["default", "plan", "team"].includes(String(settings.collaborationMode))
  ) {
    throw new ProjectValidationError("Invalid collaborationMode");
  }
  for (const key of ["model", "reasoningEffort", "serviceTier", "personality"] as const) {
    if (
      settings[key] !== undefined &&
      settings[key] !== null &&
      (typeof settings[key] !== "string" || !settings[key].trim())
    ) {
      throw new ProjectValidationError(`${key} must be a non-empty string or null`);
    }
  }
  return settings as UpdateThreadSettingsRequest;
}

function mergeSettings(
  current: SessionSettings,
  patch: UpdateThreadSettingsRequest,
  models: ModelOption[],
): SessionSettings {
  const next = applySettingsPatch(current, patch);
  if (isFastServiceTier(next.serviceTier)) next.serviceTier = "fast";
  else delete next.serviceTier;
  const model = effectiveModel(next, models);
  if (!model) throw new ProjectValidationError("Unknown model");

  if (next.serviceTier && !fastServiceTier(model)) {
    if (isFastServiceTier(patch.serviceTier)) {
      throw new ProjectValidationError("Fast mode is not supported by the selected model");
    }
    delete next.serviceTier;
  }

  if (
    next.reasoningEffort &&
    !model.reasoningEfforts.some(({ value }) => value === next.reasoningEffort)
  ) {
    if (patch.reasoningEffort !== undefined) {
      throw new ProjectValidationError("Reasoning effort is not supported by the selected model");
    }
    const fallback = model.reasoningEfforts.find((option) => option.isDefault)?.value;
    if (fallback) next.reasoningEffort = fallback;
    else delete next.reasoningEffort;
  }
  if (next.personality && !model.supportsPersonality) {
    if (patch.personality !== undefined) {
      throw new ProjectValidationError("Personality is not supported by the selected model");
    }
    delete next.personality;
  }
  return next;
}

function applySettingsPatch(
  current: SessionSettings,
  patch: UpdateThreadSettingsRequest,
): SessionSettings {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch) as Array<
    [
      keyof UpdateThreadSettingsRequest,
      UpdateThreadSettingsRequest[keyof UpdateThreadSettingsRequest],
    ]
  >) {
    if (key === "serviceTier" && value !== null && !isFastServiceTier(value)) continue;
    if (value === null) delete next[key as keyof SessionSettings];
    else if (value !== undefined) Object.assign(next, { [key]: value });
  }
  return next;
}

function effectiveModel(settings: SessionSettings, models: ModelOption[]): ModelOption | undefined {
  if (settings.model) return models.find((model) => model.id === settings.model);
  return models.find((model) => model.isDefault) ?? models[0];
}

function effectiveTitleModel(
  settings: SessionSettings,
  taskDefaults: TaskDefaults | undefined,
  models: ModelOption[],
): ModelOption | undefined {
  const titleModel = taskDefaults?.titleModel
    ? models.find((model) => model.id === taskDefaults.titleModel)
    : undefined;
  const sessionModel = settings.model
    ? models.find((model) => model.id === settings.model)
    : undefined;
  return titleModel ?? sessionModel ?? models.find((model) => model.isDefault) ?? models[0];
}

function validateTaskDefaultModel(
  modelId: string | null | undefined,
  models: ModelOption[],
): string | undefined {
  if (modelId === undefined || modelId === null) return undefined;
  const model = models.find((candidate) => candidate.id === modelId);
  if (!model) throw new ProjectValidationError("Unknown model");
  return model.id;
}

function mergeTaskDefaults(
  current: TaskDefaults,
  patch: UpdateTaskDefaultsRequest,
  models: ModelOption[],
): TaskDefaults {
  const next = { ...current };
  if (isFastServiceTier(next.serviceTier)) next.serviceTier = "fast";
  else delete next.serviceTier;
  if (patch.serviceTier === null) delete next.serviceTier;
  else if (isFastServiceTier(patch.serviceTier)) next.serviceTier = "fast";
  if (patch.model !== undefined) {
    const model = validateTaskDefaultModel(patch.model, models);
    if (model) next.model = model;
    else delete next.model;
  }
  if (patch.titleModel !== undefined) {
    const model = validateTaskDefaultModel(patch.titleModel, models);
    if (model) next.titleModel = model;
    else delete next.titleModel;
  }
  const personality = patch.personality;
  if (personality === null) delete next.personality;
  else if (personality !== undefined) next.personality = personality;

  const model =
    (next.model ? models.find((candidate) => candidate.id === next.model) : undefined) ??
    models.find((candidate) => candidate.isDefault) ??
    models[0];
  if (next.personality && !model?.supportsPersonality) {
    if (patch.personality !== undefined && patch.personality !== null) {
      throw new ProjectValidationError("Personality is not supported by the selected model");
    }
    if (patch.model !== undefined && model) delete next.personality;
  }
  return next;
}

function requireRecord<T>(value: unknown): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectValidationError("JSON object expected");
  }
  return value as T;
}

async function readThreadGoal(bridge: CodexBridge, threadId: string): Promise<ThreadGoal | null> {
  const response = await bridge.request<unknown>("thread/goal/get", { threadId });
  if (!isRecord(response) || !(response.goal === null || isThreadGoal(response.goal))) {
    throw new ProjectValidationError("Invalid thread goal response");
  }
  return response.goal;
}

async function setThreadGoal(
  bridge: CodexBridge,
  threadId: string,
  patch: UpdateThreadGoalRequest,
): Promise<ThreadGoal> {
  const response = await bridge.request<unknown>("thread/goal/set", {
    threadId,
    ...patch,
  });
  if (!isRecord(response) || !isThreadGoal(response.goal)) {
    throw new ProjectValidationError("Invalid thread goal response");
  }
  return response.goal;
}

async function clearThreadGoal(bridge: CodexBridge, threadId: string): Promise<void> {
  await bridge.request("thread/goal/clear", { threadId });
}

function isThreadGoal(value: unknown): value is ThreadGoal {
  return (
    isRecord(value) &&
    typeof value.threadId === "string" &&
    typeof value.objective === "string" &&
    ["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"].includes(
      String(value.status),
    ) &&
    (value.tokenBudget === null || typeof value.tokenBudget === "number") &&
    typeof value.tokensUsed === "number" &&
    typeof value.timeUsedSeconds === "number" &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number"
  );
}

const PERMISSION_PRESETS: Record<
  PermissionPreset,
  { sandboxMode: string; approvalPolicy: string; approvalsReviewer: string }
> = {
  ask: {
    sandboxMode: "workspace-write",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
  },
  auto: {
    sandboxMode: "workspace-write",
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
  },
  "full-access": {
    sandboxMode: "danger-full-access",
    approvalPolicy: "never",
    approvalsReviewer: "user",
  },
};

type ConfigReadResult = {
  config: Record<string, unknown>;
  origins: Record<string, unknown>;
  layers: unknown[];
};

type ConfigWriteResult = {
  status: "ok" | "okOverridden";
  version: string;
  message: string | null;
};

async function readPermissionSettings(bridge: CodexBridge): Promise<GlobalPermissionSettings> {
  const result = parseConfigReadResult(
    await bridge.request<unknown>("config/read", { includeLayers: true }),
  );
  const preset = permissionPreset(result.config);
  const overridden = ["sandbox_mode", "approval_policy", "approvals_reviewer"].some((key) => {
    const origin = result.origins[key];
    return (
      isRecord(origin) &&
      isRecord(origin.name) &&
      typeof origin.name.type === "string" &&
      origin.name.type !== "user"
    );
  });
  return {
    preset,
    version: userConfigVersion(result.layers),
    overridden,
    message: overridden ? "A managed Codex configuration overrides these permissions" : null,
  };
}

function validatePermissionSettings(value: unknown): UpdateGlobalPermissionSettingsRequest {
  const body = requireRecord<Record<string, unknown>>(value);
  if (Object.keys(body).some((key) => !["preset", "expectedVersion"].includes(key))) {
    throw new ProjectValidationError("Unknown permission setting");
  }
  if (typeof body.preset !== "string" || !Object.hasOwn(PERMISSION_PRESETS, body.preset)) {
    throw new ProjectValidationError("Invalid permission preset");
  }
  if (
    body.expectedVersion !== undefined &&
    body.expectedVersion !== null &&
    (typeof body.expectedVersion !== "string" || !body.expectedVersion)
  ) {
    throw new ProjectValidationError("expectedVersion must be a non-empty string or null");
  }
  return body as UpdateGlobalPermissionSettingsRequest;
}

function configEdit(keyPath: string, value: string) {
  return { keyPath, value, mergeStrategy: "replace" as const };
}

function parseConfigReadResult(value: unknown): ConfigReadResult {
  if (
    !isRecord(value) ||
    !isRecord(value.config) ||
    !isRecord(value.origins) ||
    !Array.isArray(value.layers)
  ) {
    throw new Error("Malformed config/read response");
  }
  return { config: value.config, origins: value.origins, layers: value.layers };
}

function parseConfigWriteResult(value: unknown): ConfigWriteResult {
  if (
    !isRecord(value) ||
    !["ok", "okOverridden"].includes(String(value.status)) ||
    typeof value.version !== "string"
  ) {
    throw new Error("Malformed config/batchWrite response");
  }
  const metadata = value.overriddenMetadata;
  const message =
    isRecord(metadata) && typeof metadata.message === "string" ? metadata.message : null;
  return {
    status: value.status as ConfigWriteResult["status"],
    version: value.version,
    message,
  };
}

function permissionPreset(config: Record<string, unknown>): PermissionPreset | null {
  const sandboxMode = config.sandbox_mode;
  const approvalPolicy = config.approval_policy;
  const reviewer = config.approvals_reviewer;
  if (sandboxMode === "danger-full-access" && approvalPolicy === "never") {
    return "full-access";
  }
  if (sandboxMode !== "workspace-write" || approvalPolicy !== "on-request") return null;
  if (reviewer === "user") return "ask";
  if (reviewer === "auto_review") return "auto";
  return null;
}

function userConfigVersion(layers: unknown[]): string | null {
  const userLayers = layers.filter(
    (layer) => isRecord(layer) && isRecord(layer.name) && layer.name.type === "user",
  );
  const base = userLayers.find(
    (layer) => isRecord(layer) && isRecord(layer.name) && layer.name.profile === null,
  );
  const selected = base ?? userLayers[0];
  return isRecord(selected) && typeof selected.version === "string" ? selected.version : null;
}

function isConfigVersionConflict(error: unknown): boolean {
  return error instanceof RpcError && /version|stale|changed|conflict/i.test(error.message);
}

function isMissingRolloutError(error: unknown): boolean {
  return (
    error instanceof RpcError &&
    error.code === -32_600 &&
    /no rollout found for thread id/i.test(error.message)
  );
}

function restoreDismissedProjectPath(state: CodexNestState, path: string): void {
  const remaining = (state.dismissedProjectPaths ?? []).filter((candidate) => candidate !== path);
  if (remaining.length) state.dismissedProjectPaths = remaining;
  else delete state.dismissedProjectPaths;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function resolveDownloadFile(
  input: string,
  cwd: string,
  toolImage = false,
): Promise<{ root: string; path: string; fileName: string; size: number }> {
  if (!isAbsolute(input) || input.includes("\0")) {
    throw new ProjectValidationError("File path must be absolute");
  }
  let root: string;
  let path: string;
  try {
    [root, path] = await Promise.all([realpath(cwd), realpath(input)]);
  } catch (error) {
    throwDownloadFilesystemError(error);
  }
  if (!pathContains(root, path)) {
    if (!toolImage || path !== input || !/\.(avif|gif|jpe?g|png|webp)$/i.test(path)) {
      throw new ProjectForbiddenError("File must stay inside the task directory");
    }
    // Pin the ticket to this exact file, not its containing directory.
    root = path;
  }
  let info: Stats;
  try {
    [info] = await Promise.all([stat(path), access(path, constants.R_OK)]);
  } catch (error) {
    throwDownloadFilesystemError(error);
  }
  if (!info.isFile()) throw new ProjectValidationError("Path must point to a regular file");
  return { root, path, fileName: basename(input), size: info.size };
}

function throwDownloadFilesystemError(error: unknown): never {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") {
    throw new ProjectNotFoundError("File does not exist");
  }
  if (code === "EACCES" || code === "EPERM") {
    throw new ProjectForbiddenError("File is not accessible");
  }
  if (code === "EINVAL" || code === "ENAMETOOLONG") {
    throw new ProjectValidationError("Invalid file path");
  }
  throw new Error("File could not be opened", { cause: error });
}

function removeExpiredDownloadTickets(tickets: Map<string, DownloadTicket>, now: number): void {
  for (const [ticket, download] of tickets) {
    if (download.expiresAt <= now) tickets.delete(ticket);
  }
}

function attachmentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\\r\n]/g, "_") || "download";
  const encoded = encodeURIComponent(fileName).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function downloadNotFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: { code: "not_found", message: "Download not found" } });
}

function isTrackedMutation(method: string, pathname: string): boolean {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase())) return false;
  if (pathname.startsWith("/api/v1/internal/restart/")) return false;
  return (
    pathname !== "/api/v1/settings/app/force-restart" &&
    pathname !== "/api/v1/settings/codex/force-restart"
  );
}

function apiError(
  reply: FastifyReply,
  status: number,
  code: ApiErrorCode,
  message: string,
): FastifyReply {
  return reply.code(status).send({ error: { code, message } });
}

function validateQueuedPastes(body: UpdateQueuedMessageRequest): PastedText | undefined {
  if (!validPastedText(body, body.input)) throw new ProjectValidationError("Invalid pasted text");
  return body.inlinePastes !== undefined || body.pasteBlocks !== undefined
    ? pastedText(body)
    : undefined;
}
