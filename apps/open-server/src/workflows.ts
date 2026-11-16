import { createHash } from "node:crypto";
import { access, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { constants } from "node:fs";
import type { FastifyInstance } from "fastify";
import type {
  ActivityItem,
  QueueMessageRequest,
  ThreadDetail,
  ThreadGoalStatus,
  ThreadSummary,
} from "@codexnest/protocol";
import type { ManagedTeamTaskState, TeamOrchestrationState } from "../../server/src/state/store";
import {
  createTeamWorkspace,
  computeTeamWorkspaceDelta,
  discardTeamWorkspace,
  integrateTeamWorkspace,
  validateTeamWorkspaceWritePaths,
} from "../../server/src/team-workspace";
import { AppError, type Engine, object, text } from "./engine";
import { BROWSER_TOOL_NAMES } from "@codexnest/protocol";
import {
  canonicalToolPath,
  MANAGED_FILESYSTEM_TOOLS,
  writeToolPolicy,
  type ToolPolicy,
} from "./tool-policy";

type WorkflowState = {
  parentId?: string;
  taskId?: string;
  goalBaseTokens?: number;
  goalLastTurn?: string;
  goalResultHash?: string;
  goalRepeated?: number;
  goalStartTurn?: string;
  goalPendingContinuation?: { id: string; input: string };
  goalContinuations?: string[];
  notices?: Array<{ turnId: string; item: ActivityItem }>;
  operations?: Record<
    string,
    { state: "started" | "done"; fingerprint?: string; result?: unknown }
  >;
  teamPaused?: boolean;
};
const terminal = (task: ManagedTeamTaskState) =>
  ["completed", "failed", "interrupted"].includes(task.status);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const teamInstructions = [
  "Team mode is managed by OpenNest, independently of native subagents. Use codexnest_spawn_task for delegated work; do not use native task/subagent tools.",
  "Delegate only necessary work, with self-contained prompts and explicit access. Tasks default to read-only and no network. Write tasks must name existing repository-relative writePaths; choose an existing parent directory when new files are needed.",
  "Task completion automatically resumes you. Never poll, wait, or sleep for children. Inspect the delivered result before integrating isolated changes.",
  "Integrate with codexnest_integrate_task; conflicts preserve parent changes. Do not report success until required child results have been reviewed and the original task is complete.",
].join(" ");
const childInstructions =
  "You are an application-managed OpenNest child. Stay within the assigned task and access scope. Use sandboxed bash for all file reads, searches and edits; native filesystem tools are disabled. Writes are limited to explicitly assigned existing paths; creating new files requires an assigned existing parent directory. Native subagents are disabled. Before finishing call codexnest_submit_result with an honest concise summary, checks and risks, then send your normal final answer. Do not publish or deploy unless the assigned task explicitly authorizes it.";
const goalInstructions =
  "A persistent goal is active. Continue useful work until the objective is achieved. Call update_goal with complete only after achieving it; blocked only after repeated inability to proceed; paused only at the user's explicit request. Do not ask for confirmation for already authorized work. Respect the goal's token budget and stop at its limit.";
const statuses = new Set<ThreadGoalStatus>([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
]);

export class Workflows {
  private idle = new Set<string>();
  private pumping = new Set<string>();
  private operations = new Map<string, Promise<unknown>>();
  constructor(readonly engine: Engine) {}
  private state(id: string): WorkflowState {
    return (this.engine.thread(id).workflow ??= {}) as WorkflowState;
  }
  private team(id: string): TeamOrchestrationState {
    return (this.engine.thread(id).teamOrchestration ??= {
      tasks: {},
    }) as unknown as TeamOrchestrationState;
  }
  private managed(id: string) {
    const state = this.state(id);
    if (!state.parentId || !state.taskId) return null;
    const task = this.team(state.parentId).tasks[state.taskId];
    return task ? { parentId: state.parentId, task } : null;
  }
  private requireParent(id: string) {
    if (this.managed(id) || this.engine.summary(id).settings.collaborationMode !== "team")
      throw new AppError("conflict", "Managed task tools require a Team parent session", 409);
  }
  private task(id: string, taskId: unknown) {
    this.requireParent(id);
    const task = this.team(id).tasks[text(taskId, "taskId", 200)];
    if (!task) throw new AppError("not_found", "Managed task not found", 404);
    return task;
  }
  private goalChanged(id: string) {
    this.engine.publish({
      type: "goal.changed",
      threadId: id,
      goal: this.engine.thread(id).goal ?? null,
    });
  }
  private refreshGoal(id: string) {
    const thread = this.engine.thread(id),
      goal = thread.goal;
    if (!goal) return null;
    const usage = this.engine.usage(id);
    goal.tokensUsed = Math.max(0, usage.tokensUsed - (this.state(id).goalBaseTokens ?? 0));
    goal.timeUsedSeconds = this.engine
      .detail(id)
      .turns.filter((turn) => (turn.startedAt ?? 0) >= goal.createdAt)
      .reduce((sum, turn) => sum + (turn.durationMs ?? 0) / 1000, 0);
    if (
      goal.tokenBudget !== null &&
      goal.tokensUsed >= goal.tokenBudget &&
      goal.status === "active"
    )
      goal.status = "budgetLimited";
    return goal;
  }
  async createGoal(id: string, objective: string, budget?: number, fromTool = false) {
    if (this.engine.summary(id).settings.collaborationMode === "team" || this.managed(id))
      throw new AppError("conflict", "Goal and Team cannot be combined", 409);
    if (
      !objective.trim() ||
      objective.length > 200_000 ||
      (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 1))
    )
      throw new AppError("validation_failed", "Invalid goal");
    const existing = this.engine.thread(id).goal;
    if (existing && existing.status !== "complete")
      throw new AppError("conflict", "An unfinished goal already exists", 409);
    const now = Date.now();
    this.engine.thread(id).goal = {
      threadId: id,
      objective,
      tokenBudget: budget ?? null,
      status: "active",
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: now,
      updatedAt: now,
    };
    const state = this.state(id);
    state.goalBaseTokens = this.engine.usage(id).tokensUsed;
    delete state.goalLastTurn;
    delete state.goalResultHash;
    state.goalRepeated = 0;
    delete state.goalPendingContinuation;
    state.goalStartTurn = fromTool ? this.engine.detail(id).turns.at(-1)?.id : undefined;
    await this.engine.save();
    this.goalChanged(id);
    return this.engine.thread(id).goal!;
  }
  async updateGoal(id: string, patch: Record<string, unknown>, resume = false) {
    const goal = this.refreshGoal(id);
    if (!goal) throw new AppError("not_found", "No goal exists for this session", 404);
    const wasBlocked = goal.status === "blocked";
    if (patch.objective !== undefined) goal.objective = text(patch.objective, "objective");
    if (!goal.objective.trim()) throw new AppError("validation_failed", "Enter a goal objective");
    if (patch.status !== undefined) {
      if (!statuses.has(patch.status as ThreadGoalStatus))
        throw new AppError("validation_failed", "Invalid goal status");
      if (
        patch.status === "active" &&
        (this.engine.summary(id).settings.collaborationMode === "team" || this.managed(id))
      )
        throw new AppError("conflict", "Goal and Team cannot be combined", 409);
      if (
        patch.status === "active" &&
        goal.tokenBudget !== null &&
        goal.tokensUsed >= goal.tokenBudget
      )
        throw new AppError("conflict", "The goal token budget has been reached", 409);
      goal.status = patch.status as ThreadGoalStatus;
      if (wasBlocked && goal.status === "active") {
        delete this.state(id).goalResultHash;
        this.state(id).goalRepeated = 0;
      }
    }
    if (goal.status !== "active" || patch.objective !== undefined) this.clearGoalContinuations(id);
    goal.updatedAt = Math.max(Date.now(), goal.updatedAt + 1);
    await this.engine.save();
    this.goalChanged(id);
    if (resume && goal.status === "active" && !this.engine.isBusy(id)) {
      await this.engine.send(
        id,
        {
          input: `Continue the saved goal: ${goal.objective}`,
          clientMessageId: `goal-resume:${goal.createdAt}:${goal.updatedAt}`,
        },
        true,
      );
    }
    return goal;
  }
  async clearGoal(id: string) {
    this.clearGoalContinuations(id);
    delete this.engine.thread(id).goal;
    await this.engine.save();
    this.goalChanged(id);
  }
  async validateSend(id: string, input: QueueMessageRequest) {
    const thread = this.engine.thread(id);
    if (!/^(team-result:|goal:|goal-resume:)/.test(input.clientMessageId ?? ""))
      this.state(id).teamPaused = false;
    if (input.planImplementationMode) {
      thread.summary.settings.collaborationMode =
        input.planImplementationMode === "team" ? "team" : "default";
    }
    if (input.goal || input.planImplementationMode === "goal") {
      if (thread.summary.settings.collaborationMode === "team")
        throw new AppError("conflict", "Goal and Team cannot be combined", 409);
      if (!thread.goal || thread.goal.status === "complete") await this.createGoal(id, input.input);
    }
    if (thread.summary.settings.collaborationMode === "team" && thread.goal?.status === "active")
      throw new AppError("conflict", "Pause or clear the goal before entering Team mode", 409);
  }
  async beforeDispatch(id: string, input?: QueueMessageRequest & { id?: string }) {
    const thread = this.engine.thread(id),
      managed = this.managed(id);
    const clientId = input?.clientMessageId ?? input?.id ?? "";
    if (
      /^(goal:|goal-resume:)/.test(clientId) &&
      (!thread.goal ||
        thread.goal.status !== "active" ||
        !clientId.includes(String(thread.goal.createdAt)))
    )
      return { cancelled: true };
    const instructions = [
      "OpenNest is a client of OpenCode. Use codexnest_publish_artifact only for standalone final deliverables, never ordinary source references, intermediate files, plans or checklists.",
    ];
    if (managed) instructions.push(childInstructions, managed.task.prompt);
    else if (thread.summary.settings.collaborationMode === "team") {
      instructions.push(teamInstructions);
      if (thread.teamOrchestration)
        instructions.push(
          "Persisted managed tasks (inspect a task for its detailed result): " +
            JSON.stringify(
              Object.values(this.team(id).tasks)
                .slice(-50)
                .map((task) => ({ id: task.id, title: task.title, status: task.status })),
            ),
        );
    }
    if (thread.goal?.status === "active")
      instructions.push(goalInstructions, JSON.stringify(thread.goal));
    const tools: Record<string, boolean> = {};
    if (managed || thread.summary.settings.collaborationMode === "team") tools.task = false;
    if (managed) for (const name of MANAGED_FILESYSTEM_TOOLS) tools[name] = false;
    if (
      !thread.browserEnabled ||
      !thread.browserBinding ||
      thread.browserBinding.detachedAt !== undefined ||
      (managed && managed.task.access?.network !== true)
    )
      for (const name of BROWSER_TOOL_NAMES) tools[`browser_${name}`] = false;
    return {
      agent: thread.summary.settings.collaborationMode === "plan" ? "plan" : "build",
      system: instructions.join("\n\n"),
      ...(Object.keys(tools).length ? { tools } : {}),
    };
  }
  decorateDetail(id: string, detail: ThreadDetail): ThreadDetail {
    const thread = this.engine.thread(id),
      state = this.state(id);
    const controlIds = new Set(
      Object.values(thread.receipts)
        .filter((receipt) => /^(goal:|goal-resume:|team-result:)/.test(receipt.message.id))
        .map((receipt) => receipt.nativeMessageId),
    );
    const result = {
      ...detail,
      turns: detail.turns.map((turn) => ({
        ...turn,
        items: [
          ...(state.notices ?? [])
            .filter((notice) => notice.turnId === turn.id)
            .map((notice) => notice.item),
          ...turn.items.filter((item) => !(item.type === "userMessage" && controlIds.has(turn.id))),
        ],
      })),
    };
    if (this.hasManagedWork(id) && result.turns.at(-1))
      Object.assign(result.turns.at(-1)!, {
        status: "inProgress",
        completedAt: null,
        durationMs: null,
      });
    return result;
  }
  private hasManagedWork(id: string) {
    const thread = this.engine.thread(id);
    return (
      thread.summary.settings.collaborationMode === "team" &&
      !!thread.teamOrchestration &&
      !this.state(id).teamPaused &&
      Object.values(this.team(id).tasks).some((task) => !terminal(task))
    );
  }
  decorateSummary(id: string, summary: ThreadSummary): ThreadSummary {
    return this.hasManagedWork(id) && !["needsAttention", "unavailable"].includes(summary.state)
      ? { ...summary, state: "running" }
      : summary;
  }
  private async continueGoal(id: string) {
    const state = this.state(id),
      intent = state.goalPendingContinuation;
    if (!intent || this.engine.thread(id).goal?.status !== "active" || !this.engine.canAcceptWork())
      return;
    await this.engine.send(id, { input: intent.input, clientMessageId: intent.id }, true);
    delete state.goalPendingContinuation;
    await this.engine.save();
  }
  /** Resume only previously persisted admissions/results; never replay uncertain commands. */
  async recover() {
    if (!this.engine.canAcceptWork()) return;
    for (const [id, thread] of Object.entries(this.engine.data.threads)) {
      if (thread.goal?.status === "active") {
        await this.continueGoal(id);
        if (!this.engine.isBusy(id)) await this.onIdle(id);
      }
      if (!thread.teamOrchestration) continue;
      if (this.state(id).teamPaused) continue;
      for (const task of Object.values(this.team(id).tasks)) {
        if (terminal(task)) {
          if (task.delivery?.status !== "delivered") await this.deliver(id, task);
          continue;
        }
        if (task.status === "starting" && !task.childThreadId) {
          const created = this.engine.data.creations[`team:${task.id}`];
          if (created?.threadId) task.childThreadId = created.threadId;
          else if (created) {
            task.status = "interrupted";
            task.result = {
              summary:
                "Native session creation is uncertain. Inspect history before creating a replacement.",
              source: "status",
              outcome: "blocked",
            };
            await this.engine.save();
            await this.deliver(id, task);
            continue;
          } else {
            task.status = "queued";
            await this.engine.save();
            continue;
          }
        }
        if (!task.childThreadId) continue;
        const child = this.engine.thread(task.childThreadId);
        Object.assign(this.state(task.childThreadId), { parentId: id, taskId: task.id });
        await writeToolPolicy(this.engine.config.stateDir, task.childThreadId, {
          mode: task.access?.mode ?? "readOnly",
          directory: await realpath(child.summary.cwd),
          writePaths: task.access?.writePaths ?? [],
          network: task.access?.network ?? false,
          protectedPaths: [
            this.engine.config.configDir,
            this.engine.config.stateDir,
            this.engine.config.runtimeDir,
          ],
          nodeBin: this.engine.config.nodeBin,
          gitReadOnlyPaths: task.workspace ? [task.workspace.gitCommonDir] : [],
        });
        task.status = "running";
        task.startMessageId ??= `team-start:${task.id}`;
        await this.engine.save();
        if (!child.receipts[task.startMessageId])
          await this.engine.send(
            task.childThreadId,
            {
              input: `${childInstructions}\n\n${task.prompt}`,
              clientMessageId: task.startMessageId,
            },
            true,
          );
        if (!this.engine.isBusy(task.childThreadId)) await this.onIdle(task.childThreadId);
      }
      await this.pump(id);
    }
  }
  async interrupted(id: string) {
    const goal = this.engine.thread(id).goal;
    if (goal?.status === "active") await this.updateGoal(id, { status: "paused" });
    const managed = this.managed(id);
    if (!managed && this.engine.thread(id).teamOrchestration) {
      this.state(id).teamPaused = true;
      await this.engine.save();
      for (const task of Object.values(this.team(id).tasks)) {
        if (terminal(task)) continue;
        task.status = "interrupted";
        task.result = { summary: "Parent task stopped", source: "status", outcome: "partial" };
        await this.engine.save();
        if (task.childThreadId && this.engine.isBusy(task.childThreadId))
          await this.engine.interrupt(task.childThreadId);
      }
      await this.engine.save();
      this.engine.changed(id);
    }
    if (managed && !terminal(managed.task)) {
      managed.task.status = "interrupted";
      managed.task.result = { summary: "Task interrupted", source: "status", outcome: "partial" };
      await this.engine.save();
      await this.deliver(managed.parentId, managed.task);
    }
  }
  private clearGoalContinuations(id: string) {
    const thread = this.engine.thread(id);
    delete this.state(id).goalPendingContinuation;
    thread.queue = thread.queue.filter((message) => {
      if (
        !/^(goal:|goal-resume:)/.test(message.id) ||
        thread.receipts[message.id]?.status !== "prepared"
      )
        return true;
      message.deliveryError = { message: "Goal continuation cancelled", retryable: false };
      return false;
    });
    this.engine.publish({ type: "queue.changed", threadId: id, messages: thread.queue });
  }
  async onUsage(id: string) {
    const goal = this.engine.thread(id).goal;
    if (goal?.status !== "active") return;
    const current = this.refreshGoal(id);
    if (current?.status !== "budgetLimited") return;
    this.clearGoalContinuations(id);
    await this.engine.save();
    this.goalChanged(id);
    if (this.engine.isBusy(id)) await this.engine.interrupt(id);
  }
  async onIdle(id: string) {
    if (this.idle.has(id) || this.engine.isBusy(id)) return;
    this.idle.add(id);
    try {
      const managed = this.managed(id);
      const detail = this.engine.detail(id),
        turn = detail.turns.at(-1);
      if (!turn || turn.status === "inProgress") return;
      if (managed) {
        const { task, parentId } = managed;
        if (task.terminalTurnId === turn.id || terminal(task)) return;
        const start = task.startMessageId
          ? this.engine.thread(id).receipts[task.startMessageId]
          : null;
        if (!start || !detail.turns.some((candidate) => candidate.id === start.nativeMessageId))
          return;
        const answer = turn.items
          .flatMap((item) => (item.type === "agentMessage" ? [item.text] : []))
          .join("\n")
          .trim();
        const outcome = this.engine.summary(id).state;
        task.status = outcome === "failed" || outcome === "interrupted" ? outcome : turn.status;
        task.terminalTurnId = turn.id;
        task.lastActivityAt = Date.now();
        task.result = task.resultCandidate
          ? { ...task.resultCandidate, source: "submitted" }
          : {
              summary: answer.slice(0, 8000) || `Task ${turn.status}`,
              source: answer ? "final_answer" : "status",
              outcome: turn.status === "completed" ? "success" : "failed",
            };
        if (task.workspace) {
          try {
            task.workspace.changedPaths = (
              await computeTeamWorkspaceDelta(task.workspace)
            ).changedPaths;
          } catch {
            task.workspace.lifecycle = "recoveryRequired";
            task.workspace.error = "Cannot inspect the isolated workspace";
          }
        }
        await this.engine.save();
        await this.deliver(parentId, task);
        await this.pump(parentId);
        return;
      }
      const goal = this.refreshGoal(id),
        state = this.state(id);
      if (!goal) return;
      if (goal.status === "budgetLimited") {
        this.clearGoalContinuations(id);
        await this.engine.save();
        this.goalChanged(id);
        return;
      }
      if (
        goal.status !== "active" ||
        state.goalLastTurn === turn.id ||
        ((turn.startedAt ?? 0) < goal.createdAt && turn.id !== state.goalStartTurn)
      )
        return;
      state.goalLastTurn = turn.id;
      const answer = turn.items
        .flatMap((item) => (item.type === "agentMessage" ? [item.text] : []))
        .join("\n");
      const resultHash = hash(answer);
      state.goalRepeated = state.goalResultHash === resultHash ? (state.goalRepeated ?? 0) + 1 : 1;
      state.goalResultHash = resultHash;
      if ((state.goalRepeated ?? 0) >= 3) goal.status = "blocked";
      if (goal.status === "active" && !this.engine.thread(id).queue.length) {
        state.goalPendingContinuation = {
          id: `goal:${goal.createdAt}:${turn.id}`,
          input: `Continue working toward the saved goal. If it is achieved, call update_goal with complete. Objective: ${goal.objective}`,
        };
      }
      goal.updatedAt = Date.now();
      await this.engine.save();
      this.goalChanged(id);
      await this.continueGoal(id);
    } finally {
      this.idle.delete(id);
    }
  }
  private async scope(id: string, accessValue: unknown): Promise<ToolPolicy> {
    const value = accessValue === undefined ? {} : object(accessValue);
    const mode = value.mode ?? "readOnly";
    if (!["readOnly", "isolatedWrite", "sharedWrite"].includes(mode))
      throw new AppError("validation_failed", "Invalid task access mode");
    if (
      mode !== "readOnly" &&
      (!Array.isArray(value.writePaths) ||
        value.writePaths.length === 0 ||
        !value.writePaths.every((path: unknown) => typeof path === "string"))
    )
      throw new AppError(
        "validation_failed",
        "Write tasks require explicit repository-relative writePaths",
      );
    const writePaths = mode === "readOnly" ? [] : validateTeamWorkspaceWritePaths(value.writePaths);
    if (value.network !== undefined && typeof value.network !== "boolean")
      throw new AppError("validation_failed", "Invalid task network setting");
    await access("/usr/bin/bwrap", constants.X_OK).catch(() => {
      throw new AppError("unavailable", "Managed Team shell isolation requires bubblewrap", 503);
    });
    const directory = await realpath(this.engine.summary(id).cwd);
    for (const path of writePaths) {
      await access(resolve(directory, path)).catch(() => {
        throw new AppError(
          "validation_failed",
          "The write path does not exist; choose an existing parent-directory scope for new files",
        );
      });
      const canonical = await canonicalToolPath(resolve(directory, path));
      const name = relative(directory, canonical);
      if (name.startsWith("..") || isAbsolute(name))
        throw new AppError("validation_failed", "Unsafe task write path");
    }
    return { mode, directory, writePaths, network: value.network ?? false };
  }
  private async spawn(id: string, args: Record<string, any>, operationId: string) {
    this.requireParent(id);
    const policy = await this.scope(id, args.access);
    const tasks = this.team(id).tasks;
    const taskId = `task_${operationId.slice(0, 24)}`;
    if (tasks[taskId]) return tasks[taskId];
    const dependencies = args.dependsOn ?? [];
    if (
      !Array.isArray(dependencies) ||
      !dependencies.every((value) => typeof value === "string" && tasks[value])
    )
      throw new AppError("validation_failed", "Unknown task dependency");
    const now = Date.now();
    const task: ManagedTeamTaskState = {
      id: taskId,
      childThreadId: "",
      title: text(args.title, "title", 500),
      prompt: text(args.prompt, "prompt"),
      status: "queued",
      dependsOn: [...new Set(dependencies)] as string[],
      access: { mode: policy.mode, writePaths: policy.writePaths, network: policy.network },
      resolvedModel: this.engine.summary(id).settings.model,
      resolvedReasoningEffort:
        args.reasoningEffort ?? this.engine.summary(id).settings.reasoningEffort ?? null,
      createdAt: now,
      lastActivityAt: now,
    };
    tasks[task.id] = task;
    await this.engine.save();
    await this.pump(id);
    return task;
  }
  private async pump(id: string) {
    if (this.pumping.has(id) || !this.engine.canAcceptWork() || this.state(id).teamPaused) return;
    this.pumping.add(id);
    try {
      const tasks = this.team(id).tasks;
      for (const task of Object.values(tasks)) {
        if (
          Object.values(tasks).filter((item) => ["starting", "running"].includes(item.status))
            .length >= 10
        )
          break;
        if (task.status !== "queued") continue;
        const deps = (task.dependsOn ?? []).map((key) => tasks[key]!);
        if (
          deps.some(
            (dep) =>
              terminal(dep) &&
              (dep.status !== "completed" ||
                (dep.result?.outcome !== undefined && dep.result.outcome !== "success") ||
                (dep.workspace?.lifecycle === "discarded" &&
                  Boolean(dep.workspace.changedPaths?.length))),
          )
        ) {
          task.status = "failed";
          task.result = {
            summary: "A required predecessor failed",
            source: "status",
            outcome: "blocked",
          };
          await this.engine.save();
          await this.deliver(id, task);
          continue;
        }
        if (
          deps.some(
            (dep) =>
              !terminal(dep) ||
              dep.delivery?.status !== "delivered" ||
              (dep.workspace &&
                dep.workspace.lifecycle !== "integrated" &&
                !(dep.workspace.lifecycle === "discarded" && !dep.workspace.changedPaths?.length)),
          )
        )
          continue;
        task.status = "starting";
        await this.engine.save();
        try {
          let cwd = this.engine.summary(id).cwd;
          if (task.access?.mode === "isolatedWrite") {
            if (!task.workspace) {
              const workspace = await createTeamWorkspace(cwd, task.id);
              task.workspace = {
                ...workspace,
                lifecycle: "ready",
                createdAt: Date.now(),
                updatedAt: Date.now(),
              };
            }
            cwd = task.workspace.worktreePath;
            await this.engine.save();
          }
          const parent = this.engine.summary(id);
          const projectId = parent.projectId ?? (await this.engine.addProject(parent.cwd)).id;
          const created = await this.engine.createThread(projectId, `team:${task.id}`, undefined, {
            cwd,
            title: task.title,
            settings: {
              ...parent.settings,
              collaborationMode: "default",
              ...(task.resolvedReasoningEffort
                ? { reasoningEffort: task.resolvedReasoningEffort }
                : {}),
            },
            parentThreadId: id,
          });
          task.childThreadId = created.thread.id;
          Object.assign(this.state(task.childThreadId), { parentId: id, taskId: task.id });
          await writeToolPolicy(this.engine.config.stateDir, task.childThreadId, {
            directory: await realpath(cwd),
            mode: task.access?.mode ?? "readOnly",
            writePaths: task.access?.writePaths ?? [],
            network: task.access?.network ?? false,
            protectedPaths: [
              this.engine.config.configDir,
              this.engine.config.stateDir,
              this.engine.config.runtimeDir,
            ],
            nodeBin: this.engine.config.nodeBin,
            gitReadOnlyPaths: task.workspace ? [task.workspace.gitCommonDir] : [],
          });
          task.status = "running";
          task.startedAt = Date.now();
          task.lastActivityAt = task.startedAt;
          task.startMessageId = `team-start:${task.id}`;
          await this.engine.save();
          await this.engine.send(
            task.childThreadId,
            {
              input: `${childInstructions}\n\n${task.prompt}`,
              clientMessageId: task.startMessageId,
            },
            true,
          );
        } catch (error) {
          task.status = "failed";
          task.result = {
            summary: error instanceof Error ? error.message : "Managed task could not start",
            source: "status",
            outcome: "failed",
          };
          await this.engine.save();
          await this.deliver(id, task);
        }
      }
    } finally {
      this.pumping.delete(id);
    }
  }
  private async deliver(id: string, task: ManagedTeamTaskState) {
    if (this.state(id).teamPaused) return;
    if (task.delivery?.status === "delivered") return;
    const marker = `team-result:${task.id}:${task.terminalTurnId ?? task.status}`;
    task.delivery = { status: "claimed", claimId: marker, markerId: marker };
    await this.engine.save();
    const message = await this.engine.send(
      id,
      {
        input: `Application-managed task result. Review it before continuing. ${JSON.stringify({ taskId: task.id, title: task.title, status: task.status, result: task.result, changedPaths: task.workspace?.changedPaths, workspaceIntegrationStatus: task.workspace?.lifecycle })}`,
        clientMessageId: marker,
      },
      true,
    );
    const nativeId = this.engine.thread(id).receipts[message.id]?.nativeMessageId;
    if (nativeId) {
      const notices = (this.state(id).notices ??= []);
      if (!notices.some((notice) => notice.item.id === marker))
        notices.push({
          turnId: nativeId,
          item: {
            type: "orchestrationNotice",
            id: marker,
            status: "completed",
            agents: [
              {
                threadId: task.childThreadId,
                title: task.title,
                nickname: null,
                outcome:
                  task.status === "completed"
                    ? "completed"
                    : task.status === "interrupted"
                      ? "interrupted"
                      : "failed",
                taskId: task.id,
                ...(task.result
                  ? {
                      result: {
                        outcome: task.result.outcome ?? "partial",
                        summary: task.result.summary,
                        checks: task.result.checks,
                      },
                    }
                  : {}),
                ...(task.workspace
                  ? {
                      workspaceIntegrationStatus: task.workspace.lifecycle,
                      changedPaths: task.workspace.changedPaths?.slice(0, 20),
                      changedPathCount: task.workspace.changedPaths?.length ?? 0,
                    }
                  : {}),
              },
            ],
            timestamp: Date.now(),
            afterItemId: null,
          },
        });
    }
    task.delivery.status = "delivered";
    await this.engine.save();
    this.engine.changed(id);
  }
  async tool(id: string, name: string, value: unknown, messageId: string, callId?: string) {
    const args = object(value),
      fingerprint = hash({ name, args });
    const operationId = hash(callId ? { id, messageId, callId } : { id, name, args, messageId });
    if (
      [
        "get_goal",
        "list_tasks",
        "inspect_task",
        "browser:tabs_context",
        "browser:read_page",
        "browser:get_page_text",
        "browser:find",
        "browser:read_console_messages",
        "browser:read_network_requests",
        "browser:read_network_request",
        "browser:read_network_body",
      ].includes(name) ||
      (name === "browser:computer" && args.action === "screenshot")
    )
      return this.performTool(id, name, args, operationId);
    const calls = (this.state(id).operations ??= {});
    const prior = calls[operationId];
    if (prior?.fingerprint && prior.fingerprint !== fingerprint)
      throw new AppError(
        "conflict",
        "Native tool call identity was reused with different arguments",
        409,
      );
    const active = this.operations.get(operationId);
    if (active) return active;
    if (prior?.state === "done") return prior.result;
    if (prior)
      throw new AppError(
        "conflict",
        "The previous tool result is uncertain. Inspect persisted task state before retrying.",
        409,
      );
    const operation = (async () => {
      calls[operationId] = { state: "started", fingerprint };
      await this.engine.save();
      try {
        const result = this.publicResult(await this.performTool(id, name, args, operationId));
        calls[operationId] = { state: "done", fingerprint, result };
        await this.engine.save();
        return result;
      } catch (error) {
        // A late persistence/I/O failure does not prove that no side effect ran.
        // Keep the started marker; recovery must inspect state, not repeat it.
        await this.engine.save();
        throw error;
      }
    })();
    this.operations.set(operationId, operation);
    try {
      return await operation;
    } finally {
      this.operations.delete(operationId);
    }
  }
  private publicResult(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((entry) => this.publicResult(entry));
    if (!value || typeof value !== "object") return value;
    const task = value as ManagedTeamTaskState;
    if (typeof task.childThreadId !== "string" || typeof task.prompt !== "string") return value;
    const { workspace, resultCandidate, prompt, ...result } = task;
    void resultCandidate;
    void prompt;
    return {
      ...result,
      ...(workspace
        ? {
            workspace: {
              lifecycle: workspace.lifecycle,
              worktreePath: workspace.worktreePath,
              changedPaths: workspace.changedPaths,
              conflictPaths: workspace.conflictPaths,
              error: workspace.error,
            },
          }
        : {}),
    };
  }
  private async performTool(
    id: string,
    name: string,
    args: Record<string, any>,
    operationId: string,
  ): Promise<unknown> {
    this.engine.thread(id);
    if (name.startsWith("browser:")) {
      const tool = name.slice("browser:".length);
      if (!(BROWSER_TOOL_NAMES as readonly string[]).includes(tool))
        throw new AppError("validation_failed", "Unknown browser tool");
      return this.engine.invokeBrowserTool(id, tool, args);
    }
    if (name === "get_goal") return this.refreshGoal(id);
    if (name === "create_goal")
      return this.createGoal(id, text(args.objective, "objective"), args.token_budget, true);
    if (name === "update_goal") {
      if (!["paused", "blocked", "complete"].includes(args.status))
        throw new AppError("validation_failed", "Invalid goal status");
      return this.updateGoal(id, { status: args.status });
    }
    if (name === "publish_artifact")
      return this.engine.publishArtifact(id, {
        path: text(args.path, "path", 4096),
        ...(args.label ? { label: text(args.label, "label", 500) } : {}),
      });
    if (name === "submit_result") {
      const managed = this.managed(id);
      if (!managed || terminal(managed.task))
        throw new AppError("conflict", "Only an active managed child can submit a result", 409);
      if (!["success", "partial", "blocked", "failed"].includes(args.outcome))
        throw new AppError("validation_failed", "Invalid result outcome");
      const required = (value: unknown, field: string, maximum: number) => {
        const result = text(value, field, maximum);
        if (!result.trim()) throw new AppError("validation_failed", `Invalid ${field}`);
        return result;
      };
      const entries = (value: unknown, field: string): unknown[] | undefined => {
        if (value === undefined) return undefined;
        if (!Array.isArray(value) || value.length > 100)
          throw new AppError("validation_failed", `${field} must contain at most 100 entries`);
        return value;
      };
      const checks = entries(args.checks, "checks")?.map((value) => {
        const check = object(value);
        if (!["passed", "failed", "notRun"].includes(check.outcome))
          throw new AppError("validation_failed", "Invalid check outcome");
        return {
          name: required(check.name, "check name", 500),
          outcome: check.outcome as "passed" | "failed" | "notRun",
          ...(check.details !== undefined
            ? { details: required(check.details, "check details", 8000) }
            : {}),
        };
      });
      const risks = entries(args.risks, "risks")?.map((value) => required(value, "risk", 8000));
      const artifacts = entries(args.artifacts, "artifacts")?.map((value) => {
        const artifact = object(value);
        const path =
          artifact.path === undefined ? undefined : required(artifact.path, "artifact path", 4096);
        const url =
          artifact.url === undefined ? undefined : required(artifact.url, "artifact URL", 4096);
        if (!path && !url)
          throw new AppError("validation_failed", "An artifact requires a path or URL");
        if (
          path &&
          (isAbsolute(path) ||
            path.includes("\\") ||
            path.includes("\0") ||
            path
              .split("/")
              .some(
                (part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git",
              ))
        )
          throw new AppError("validation_failed", "Artifact paths must be repository-relative");
        if (url) {
          let parsed: URL;
          try {
            parsed = new URL(url);
          } catch {
            throw new AppError("validation_failed", "Invalid artifact URL");
          }
          if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
            throw new AppError(
              "validation_failed",
              "Artifact URLs must use HTTP(S) without credentials",
            );
        }
        return {
          label: required(artifact.label, "artifact label", 500),
          ...(path ? { path } : {}),
          ...(url ? { url } : {}),
        };
      });
      if (artifacts?.some((artifact) => artifact.path)) {
        const root = await realpath(this.engine.summary(id).cwd);
        for (const artifact of artifacts) {
          if (!artifact.path) continue;
          let canonical: string;
          try {
            canonical = await realpath(resolve(root, artifact.path));
          } catch {
            throw new AppError("validation_failed", "The result artifact does not exist");
          }
          const nested = relative(root, canonical);
          if (nested === ".." || nested.startsWith("../") || isAbsolute(nested))
            throw new AppError("validation_failed", "The result artifact escapes its workspace");
        }
      }
      managed.task.resultCandidate = {
        summary: required(args.summary, "summary", 8000),
        outcome: args.outcome,
        ...(args.details ? { details: text(args.details, "details", 32_000) } : {}),
        ...(checks ? { checks } : {}),
        ...(risks ? { risks } : {}),
        ...(artifacts ? { artifacts } : {}),
        submittedAt: Date.now(),
        callId: operationId,
      };
      await this.engine.save();
      return { submitted: true };
    }
    this.requireParent(id);
    if (name === "spawn_task") return this.spawn(id, args, operationId);
    if (name === "list_tasks") return this.publicResult(Object.values(this.team(id).tasks));
    const task = this.task(id, args.taskId);
    if (name === "inspect_task")
      return {
        task: this.publicResult(task),
        ...(task.childThreadId ? { history: this.engine.detail(task.childThreadId) } : {}),
      };
    if (name === "steer_task") {
      if (terminal(task) || !task.childThreadId)
        throw new AppError("conflict", "The task is not running", 409);
      return this.engine.send(task.childThreadId, {
        input: text(args.message, "message"),
        clientMessageId: `team-steer:${operationId}`,
      });
    }
    if (name === "cancel_task") {
      if (task.childThreadId && this.engine.isBusy(task.childThreadId))
        await this.engine.interrupt(task.childThreadId);
      task.status = "interrupted";
      task.result = {
        summary: typeof args.reason === "string" ? args.reason : "Task cancelled",
        source: "status",
        outcome: "partial",
      };
      await this.engine.save();
      await this.deliver(id, task);
      return task;
    }
    if (name === "integrate_task" || name === "discard_task_changes") {
      if (!terminal(task) || !task.workspace)
        throw new AppError("conflict", "A delivered isolated task is required", 409);
      if (name === "discard_task_changes") {
        if (task.workspace.lifecycle === "integrated")
          throw new AppError("conflict", "Integrated changes cannot be discarded", 409);
        if (task.workspace.lifecycle !== "discarded") {
          await discardTeamWorkspace(task.workspace);
          task.workspace.lifecycle = "discarded";
        }
      } else {
        task.workspace.lifecycle = "integrating";
        await this.engine.save();
        try {
          await integrateTeamWorkspace(task.workspace, task.access?.writePaths ?? []);
          task.workspace.lifecycle = "integrated";
        } catch (error) {
          task.workspace.lifecycle = "conflicted";
          task.workspace.error = error instanceof Error ? error.message : "Integration failed";
          await this.engine.save();
          throw error;
        }
      }
      task.workspace.updatedAt = Date.now();
      await this.engine.save();
      await this.pump(id);
      return task;
    }
    if (name === "followup_task") {
      if (!terminal(task) || !task.childThreadId || task.workspace?.lifecycle === "discarded")
        throw new AppError(
          "conflict",
          "A delivered task with an existing workspace is required",
          409,
        );
      if (args.access && hash(args.access) !== hash(task.access))
        throw new AppError("validation_failed", "Start a new task to change its access scope");
      if (task.workspace?.lifecycle === "integrated") {
        const delta = await computeTeamWorkspaceDelta(task.workspace);
        for (const change of delta.changes) {
          if (change.final) task.workspace.baseline[change.path] = change.final;
          else delete task.workspace.baseline[change.path];
        }
        task.workspace.lifecycle = "ready";
      }
      task.status = "running";
      task.prompt = text(args.prompt, "prompt");
      if (args.title) task.title = text(args.title, "title", 500);
      task.startMessageId = `team-followup:${operationId}`;
      delete task.terminalTurnId;
      delete task.result;
      delete task.resultCandidate;
      delete task.delivery;
      await this.engine.save();
      await this.engine.send(
        task.childThreadId,
        { input: task.prompt, clientMessageId: task.startMessageId },
        true,
      );
      return task;
    }
    throw new AppError("validation_failed", "Unknown OpenNest tool");
  }
}

export function registerWorkflows(app: FastifyInstance, engine: Engine) {
  const workflows = new Workflows(engine);
  engine.setWorkflowHooks({
    validateSend: (id, input) => workflows.validateSend(id, input),
    beforeDispatch: (id, input) => workflows.beforeDispatch(id, input),
    onIdle: (id) => workflows.onIdle(id),
    onInterrupted: (id) => workflows.interrupted(id),
    onUsage: (id) => workflows.onUsage(id),
    collaborationAgent: (mode) => (mode === "plan" ? "plan" : "build"),
    decorateDetail: (id, detail) => workflows.decorateDetail(id, detail),
    decorateSummary: (id, summary) => workflows.decorateSummary(id, summary),
  });
  engine.enableCapabilities({ plan: true, goal: true, team: true });
  app.get<{ Params: { id: string } }>(
    "/api/v1/threads/:id/goal",
    (request) => engine.thread(request.params.id).goal ?? null,
  );
  app.patch<{ Params: { id: string } }>("/api/v1/threads/:id/goal", (request) =>
    workflows.updateGoal(request.params.id, object(request.body), true),
  );
  app.delete<{ Params: { id: string } }>("/api/v1/threads/:id/goal", async (request, reply) => {
    await workflows.clearGoal(request.params.id);
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>("/api/v1/threads/:id/plan/dismiss", async (request) => {
    const thread = engine.thread(request.params.id);
    thread.summary.settings.collaborationMode = "default";
    await engine.save();
    engine.changed(request.params.id);
    return engine.summary(request.params.id);
  });
  app.post("/api/v1/internal/tools", async (request) => {
    const body = object(request.body);
    const id = text(body.sessionID, "sessionID", 200);
    const callId = text(body.callID, "callID", 500);
    if (!callId) throw new AppError("validation_failed", "Native tool call identity is required");
    return workflows.tool(
      id,
      text(body.tool, "tool", 100),
      body.args,
      text(body.messageID, "messageID", 200),
      callId,
    );
  });
  let listening = false;
  let recovery: Promise<void> | undefined;
  const recover = () => {
    if (!listening || recovery) return;
    recovery = workflows
      .recover()
      .catch(() => {
        engine.emit("storageError");
      })
      .finally(() => {
        recovery = undefined;
      });
  };
  const observe = (frame: { event?: { type?: string; connection?: { state?: string } } }) => {
    if (frame.event?.type === "connection.changed" && frame.event.connection?.state === "ready")
      recover();
  };
  engine.on("frame", observe);
  app.addHook("onListen", async () => {
    listening = true;
    recover();
  });
  app.addHook("onClose", async () => {
    listening = false;
    engine.off("frame", observe);
    await recovery;
  });
  return workflows;
}
