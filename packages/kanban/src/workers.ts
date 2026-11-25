import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  WORKER_ARCHITECT_ID,
  type WorkerMemoryEntry,
  type WorkerProfile,
  type WorkerProposal,
} from "@codexnest/protocol";
import { atomicJson, KanbanError, KanbanStore } from "./store.js";
import {
  curateMemory,
  memoryContentProblem,
  memoryFailure,
  memoryLimits,
  type WorkerMemoryResult,
} from "./worker-memory.js";

type WorkerDocument = {
  profile: WorkerProfile;
  memory: WorkerMemoryEntry[];
  /** Commit with the changes until the durable helper result has been written. */
  pendingMemoryResults?: Record<
    string,
    { projectKey: string | null; result: Extract<WorkerMemoryResult, { success: true }> }
  >;
};
type ProfileFields = Pick<
  WorkerProfile,
  "name" | "role" | "instructions" | "settings" | "coordinates"
>;
type MemoryChange =
  | { action: "add"; kind: WorkerMemoryEntry["kind"]; scope: "worker" | "project"; text: string }
  | { action: "edit"; id: string; expectedText: string; text: string }
  | { action: "remove"; id: string; expectedText: string };

const architect: WorkerProfile = {
  id: WORKER_ARCHITECT_ID,
  name: "Архитектор работников",
  role: "Создаёт работников вместе с пользователем",
  instructions: "",
  settings: {},
  projectKey: null,
  revision: 0,
};

function text(value: string, field: string, max: number, allowEmpty = false): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length > max || (!trimmed && !allowEmpty))
    throw new KanbanError("invalid_worker", `Invalid worker ${field}`, 400);
  return trimmed;
}

function profileFields(fields: ProfileFields): ProfileFields {
  return {
    name: text(fields.name, "name", 120),
    role: text(fields.role, "role", 500),
    instructions: text(fields.instructions, "instructions", 16_000, true),
    ...(fields.coordinates !== undefined ? { coordinates: fields.coordinates } : {}),
    settings: fields.settings,
  };
}

function visible(profile: WorkerProfile, projectKey: string | null): boolean {
  return profile.projectKey === null || profile.projectKey === projectKey;
}

/** The common profiles and memory are local to the operating-system user, independent of boards. */
export class WorkerStore {
  private readonly lock: KanbanStore;
  private readonly path: string;

  constructor(
    directory = process.env.NEST_WORKERS_DATA_DIR ||
      join(homedir(), ".local/share/nest-apps/workers"),
  ) {
    this.lock = new KanbanStore(directory);
    this.path = join(directory, "workers.json");
  }

  get directory(): string {
    return this.lock.directory;
  }

  async projectKey(projectPath: string): Promise<string> {
    return (await this.lock.identity(projectPath)).id;
  }

  async propose(fields: Omit<WorkerProposal, "id">): Promise<WorkerProposal> {
    const proposal = { ...fields, id: randomUUID() };
    profileFields({ ...proposal, settings: { [proposal.provider]: proposal.settings } });
    await this.lock.initialize();
    await atomicJson(join(this.lock.directory, `proposal-${proposal.id}.json`), proposal);
    return proposal;
  }

  async proposal(id: string): Promise<WorkerProposal> {
    if (!/^[0-9a-f-]{36}$/.test(id))
      throw new KanbanError("worker_proposal_not_found", "Worker proposal not found", 404);
    try {
      return JSON.parse(
        await readFile(join(this.lock.directory, `proposal-${id}.json`), "utf8"),
      ) as WorkerProposal;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new KanbanError("worker_proposal_not_found", "Worker proposal not found", 404);
      throw error;
    }
  }

  async approveProposal(proposal: WorkerProposal): Promise<WorkerProfile> {
    return this.update((data) => {
      if (proposal.target) {
        const { id, revision } = proposal.target;
        const worker = this.require(data, id, proposal.projectKey);
        if (
          worker.profile.instructions === proposal.instructions &&
          (proposal.coordinates === undefined ||
            worker.profile.coordinates === proposal.coordinates)
        )
          return worker.profile;
        if (worker.profile.revision !== revision)
          throw new KanbanError("worker_changed", "Worker profile changed; request a new proposal");
        worker.profile.instructions = proposal.instructions.trim();
        if (proposal.coordinates !== undefined && id !== WORKER_ARCHITECT_ID) {
          worker.profile.coordinates = proposal.coordinates;
        }
        worker.profile.revision++;
        data[id] = worker;
        return worker.profile;
      }
      const prior = data[proposal.id];
      if (prior) return prior.profile;
      const profile = {
        ...profileFields({ ...proposal, settings: { [proposal.provider]: proposal.settings } }),
        id: proposal.id,
        projectKey: proposal.projectKey,
        revision: 1,
      };
      data[profile.id] = { profile, memory: [] };
      return profile;
    });
  }

  async configure(
    id: string,
    projectKey: string | null,
    provider: WorkerProposal["provider"],
    choose: (profile: WorkerProfile) => Promise<WorkerProposal["settings"]>,
  ): Promise<WorkerProposal["settings"]> {
    await this.lock.initialize();
    return this.lock.withLock(`configure-${provider}-${id}`, async () => {
      const { profile } = await this.snapshot(id, projectKey);
      const existing = profile.settings[provider];
      if (existing) return existing;
      const settings = await choose(profile);
      return this.update((data) => {
        const worker = this.require(data, id, projectKey);
        if (worker.profile.settings[provider]) return worker.profile.settings[provider]!;
        worker.profile.settings[provider] = settings;
        worker.profile.revision++;
        return settings;
      });
    });
  }

  private async read(): Promise<Record<string, WorkerDocument>> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as Record<string, WorkerDocument>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async update<T>(
    mutate: (data: Record<string, WorkerDocument>) => T,
    persist?: (result: T) => boolean,
  ): Promise<T> {
    await this.lock.initialize();
    return this.lock.withLock("workers", async () => {
      const data = await this.read();
      const result = mutate(data);
      if (persist?.(result) ?? true) await atomicJson(this.path, data);
      return result;
    });
  }

  private require(
    data: Record<string, WorkerDocument>,
    id: string,
    projectKey: string | null,
  ): WorkerDocument {
    const worker = Object.hasOwn(data, id) ? data[id] : undefined;
    if (worker && visible(worker.profile, projectKey)) return worker;
    if (!worker && id === WORKER_ARCHITECT_ID)
      return { profile: structuredClone(architect), memory: [] };
    throw new KanbanError("worker_not_found", "Worker not found in this project", 404);
  }

  async list(projectKey: string | null): Promise<WorkerProfile[]> {
    return this.listForProjects(projectKey === null ? [] : [projectKey]);
  }

  async listForProjects(projectKeys: readonly string[]): Promise<WorkerProfile[]> {
    const data = await this.read();
    const keys = new Set(projectKeys);
    return [
      data[WORKER_ARCHITECT_ID]?.profile ?? structuredClone(architect),
      ...Object.values(data)
        .map(({ profile }) => profile)
        .filter(
          (profile) =>
            profile.id !== WORKER_ARCHITECT_ID &&
            (profile.projectKey === null || keys.has(profile.projectKey)),
        ),
    ];
  }

  async snapshot(id: string, projectKey: string | null): Promise<WorkerDocument> {
    const worker = this.require(await this.read(), id, projectKey);
    return {
      profile: worker.profile,
      memory: worker.memory.filter(
        (entry) => entry.projectKey === null || entry.projectKey === projectKey,
      ),
    };
  }

  async create(fields: ProfileFields, projectKey: string | null): Promise<WorkerProfile> {
    const profile = { ...profileFields(fields), id: randomUUID(), projectKey, revision: 1 };
    return this.update((data) => {
      data[profile.id] = { profile, memory: [] };
      return profile;
    });
  }

  async edit(
    id: string,
    projectKey: string | null,
    revision: number,
    fields: ProfileFields,
  ): Promise<WorkerProfile> {
    return this.update((data) => {
      const worker = this.require(data, id, projectKey);
      if (worker.profile.revision !== revision)
        throw new KanbanError("worker_changed", "Worker profile changed; reload before saving");
      const fieldsToSave =
        id === WORKER_ARCHITECT_ID
          ? { ...architect, instructions: text(fields.instructions, "instructions", 16_000, true) }
          : profileFields(fields);
      worker.profile = { ...worker.profile, ...fieldsToSave, revision: revision + 1 };
      data[id] = worker;
      return worker.profile;
    });
  }

  async changeMemory(
    id: string,
    projectKey: string | null,
    change: MemoryChange,
  ): Promise<WorkerMemoryEntry[]> {
    return this.update((data) => {
      const worker = this.require(data, id, projectKey);
      if (change.action === "add") {
        const scope = change.scope === "project" ? projectKey : worker.profile.projectKey;
        if (change.scope === "project" && scope === null)
          throw new KanbanError("invalid_worker", "Open a project to save project memory", 400);
        const entry: WorkerMemoryEntry = {
          id: randomUUID(),
          kind: change.kind,
          projectKey: scope,
          text: text(change.text, "memory", memoryLimits[change.kind]),
        };
        const problem = memoryContentProblem(entry.text);
        if (problem) throw new KanbanError("memory_unsafe", problem, 400);
        if (
          !worker.memory.some(
            (item) =>
              item.kind === entry.kind &&
              item.projectKey === entry.projectKey &&
              item.text === entry.text,
          )
        )
          worker.memory.push(entry);
      } else {
        const entry = worker.memory.find(
          (item) =>
            item.id === change.id && (item.projectKey === null || item.projectKey === projectKey),
        );
        if (!entry) throw new KanbanError("memory_not_found", "Memory entry not found", 404);
        if (entry.text !== change.expectedText)
          throw new KanbanError("memory_changed", "Memory entry changed; reload before saving");
        if (change.action === "remove")
          worker.memory = worker.memory.filter((item) => item !== entry);
        else {
          const replacement = text(change.text, "memory", memoryLimits[entry.kind]);
          const problem = memoryContentProblem(replacement);
          if (problem) throw new KanbanError("memory_unsafe", problem, 400);
          entry.text = replacement;
        }
      }
      const totals = new Map<string, number>();
      for (const entry of worker.memory) {
        const key = `${entry.projectKey ?? ""}:${entry.kind}`;
        const size = (totals.get(key) ?? 0) + entry.text.length + (totals.has(key) ? 2 : 0);
        if (size > memoryLimits[entry.kind])
          throw new KanbanError("memory_full", "Worker memory is full; shorten or remove an entry");
        totals.set(key, size);
      }
      data[id] = worker;
      return worker.memory.filter(
        (entry) => entry.projectKey === null || entry.projectKey === projectKey,
      );
    });
  }

  async curate(
    id: string,
    projectKey: string | null,
    input: Record<string, unknown>,
    requestId?: string,
  ): Promise<WorkerMemoryResult> {
    if (input.target !== "memory" && input.target !== "user")
      return memoryFailure("invalid_request", "Set target to memory or user.");
    const scope =
      input.scope === undefined ? (projectKey === null ? "worker" : "project") : input.scope;
    if (scope !== "worker" && scope !== "project")
      return memoryFailure("invalid_request", "Set scope to worker or project.");
    if (scope === "project" && projectKey === null)
      return memoryFailure("invalid_request", "Open a project to edit project memory.");
    const operations = input.operations === undefined ? [input] : input.operations;
    if (!Array.isArray(operations) || !operations.length)
      return memoryFailure("invalid_request", "Supply a nonempty operations array.");
    const kind = input.target === "memory" ? "notes" : "user";
    return this.update<WorkerMemoryResult>(
      (data) => {
        const worker = this.require(data, id, projectKey);
        const previous = requestId && worker.pendingMemoryResults?.[requestId];
        if (previous)
          return previous.projectKey === projectKey
            ? previous.result
            : memoryFailure("invalid_request", "Worker memory request identifier was reused.");
        const targetProject = scope === "project" ? projectKey : worker.profile.projectKey;
        const inTarget = (entry: WorkerMemoryEntry) =>
          entry.kind === kind && entry.projectKey === targetProject;
        const change = curateMemory(
          worker.memory.filter(inTarget),
          kind,
          targetProject,
          scope,
          operations,
        );
        if ("entries" in change) {
          const replacements = new Map(change.entries.map((entry) => [entry.id, entry]));
          const retained = worker.memory.flatMap((entry) => {
            if (!inTarget(entry)) return [entry];
            const replacement = replacements.get(entry.id);
            replacements.delete(entry.id);
            return replacement ? [replacement] : [];
          });
          worker.memory = [...retained, ...replacements.values()];
          if (requestId)
            (worker.pendingMemoryResults ??= {})[requestId] = { projectKey, result: change.result };
          data[id] = worker;
        }
        return change.result;
      },
      (result) => result.success,
    );
  }

  async acknowledgeMemory(id: string, projectKey: string | null, requestId: string): Promise<void> {
    await this.update(
      (data) => {
        const worker = this.require(data, id, projectKey);
        const pending = worker.pendingMemoryResults;
        if (pending?.[requestId]?.projectKey !== projectKey) return false;
        delete pending[requestId];
        if (!Object.keys(pending).length) delete worker.pendingMemoryResults;
        return true;
      },
      (changed) => changed,
    );
  }
}
