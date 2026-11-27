import type { KanbanProvider, SessionSettings, WorkerProfile } from "@codexnest/protocol";
import type { FastifyInstance, FastifyReply } from "fastify";
import { KanbanError } from "./store.js";
import type { WorkerStore } from "./workers.js";
import type { KanbanService } from "./service.js";

type WorkerRequest = {
  Params: { workerId: string };
  Querystring: { projectId?: string };
};

type MemoryRequest = Omit<WorkerRequest, "Params"> & {
  Params: WorkerRequest["Params"] & { entryId: string };
};

type EditWorker = {
  revision: number;
  name: string;
  role: string;
  instructions: string;
  settings?: SessionSettings | null;
};

const settingsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["collaborationMode"],
  properties: {
    collaborationMode: { type: "string", enum: ["default", "plan", "team"] },
    model: { type: "string", minLength: 1, maxLength: 300 },
    openRouterEndpoint: { type: ["string", "null"], maxLength: 300 },
    reasoningEffort: { type: "string", minLength: 1, maxLength: 100 },
    serviceTier: { type: "string", enum: ["fast", "ultrafast"] },
    personality: { type: "string", minLength: 1, maxLength: 100 },
  },
};

export function registerWorkerRoutes(
  app: FastifyInstance,
  workers: WorkerStore,
  projectPath: (id: string) => string,
  provider: KanbanProvider,
  startWorker: KanbanService["startWorker"],
): void {
  const root = "/api/v1/workers";
  const projectKey = async (id?: string) => (id ? workers.projectKey(projectPath(id)) : null);
  const handle = async <T>(reply: FastifyReply, operation: () => Promise<T>) => {
    reply.header("Cache-Control", "no-store");
    try {
      return await operation();
    } catch (error) {
      if (error instanceof KanbanError)
        return reply
          .code(error.status)
          .send({ error: { code: error.code, message: error.message } });
      throw error;
    }
  };

  app.get<Pick<WorkerRequest, "Querystring">>(root, (request, reply) =>
    handle(reply, async () => workers.list(await projectKey(request.query.projectId))),
  );
  app.patch<{
    Querystring: WorkerRequest["Querystring"];
    Body: { workerId?: unknown; targetIndex?: unknown };
  }>(`${root}/order`, (request, reply) =>
    handle(reply, async () => {
      const { projectId } = request.query;
      if (typeof projectId !== "string" || !projectId.trim())
        throw new KanbanError(
          "worker_project_required",
          "Choose a project to reorder workers",
          400,
        );
      const { workerId, targetIndex } = request.body ?? {};
      if (typeof workerId !== "string" || !workerId.trim())
        throw new KanbanError("invalid_worker", "workerId is required", 400);
      if (typeof targetIndex !== "number")
        throw new KanbanError("validation_failed", "targetIndex must be a number", 400);
      return workers.move(workerId, await workers.projectKey(projectPath(projectId)), targetIndex);
    }),
  );
  app.post<{ Body: { projectIds: string[] } }>(
    `${root}/catalog`,
    {
      schema: {
        body: {
          type: "object",
          required: ["projectIds"],
          properties: {
            projectIds: {
              type: "array",
              maxItems: 1000,
              uniqueItems: true,
              items: { type: "string", minLength: 1, maxLength: 300 },
            },
          },
        },
      },
    },
    (request, reply) =>
      handle(reply, async () => {
        const ids = request.body.projectIds;
        const keys = await Promise.all(ids.map((id) => workers.projectKey(projectPath(id))));
        const grouped = new Map<string | null, WorkerProfile[]>();
        for (const profile of await workers.listForProjects(keys)) {
          const group = grouped.get(profile.projectKey) ?? [];
          group.push(profile);
          grouped.set(profile.projectKey, group);
        }
        return {
          common: grouped.get(null) ?? [],
          projects: ids.map((projectId, index) => ({
            projectId,
            workers: grouped.get(keys[index]!) ?? [],
          })),
        };
      }),
  );
  app.get<WorkerRequest>(`${root}/:workerId`, (request, reply) =>
    handle(reply, async () =>
      workers.availableSnapshot(request.params.workerId, await projectKey(request.query.projectId)),
    ),
  );
  const checkedProposal = async (id: string) => {
    const proposal = await workers.proposal(id);
    if (
      proposal.provider !== provider ||
      (proposal.projectId && (await projectKey(proposal.projectId)) !== proposal.projectKey)
    )
      throw new KanbanError(
        "worker_proposal_context",
        "Open this proposal in its original application and project",
      );
    return proposal;
  };
  app.get<{ Params: { id: string } }>(`${root}/proposals/:id`, (request, reply) =>
    handle(reply, () => checkedProposal(request.params.id)),
  );
  app.post<{ Params: { id: string } }>(`${root}/proposals/:id/approve`, (request, reply) =>
    handle(reply, async () => workers.approveProposal(await checkedProposal(request.params.id))),
  );
  app.post<WorkerRequest & { Body: { creationId: string } }>(
    `${root}/:workerId/sessions`,
    {
      schema: {
        body: {
          type: "object",
          required: ["creationId"],
          properties: {
            creationId: {
              type: "string",
              pattern: "^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$",
            },
          },
        },
      },
    },
    (request, reply) =>
      handle(reply, () =>
        startWorker(
          request.params.workerId,
          request.query.projectId ? projectPath(request.query.projectId) : null,
          request.body.creationId,
        ),
      ),
  );
  app.patch<WorkerRequest & { Body: EditWorker }>(
    `${root}/:workerId`,
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["revision", "name", "role", "instructions"],
          properties: {
            revision: { type: "integer", minimum: 0 },
            name: { type: "string", minLength: 1, maxLength: 120 },
            role: { type: "string", minLength: 1, maxLength: 500 },
            instructions: { type: "string", maxLength: 16_000 },
            settings: { anyOf: [settingsSchema, { type: "null" }] },
          },
        },
      },
    },
    (request, reply) =>
      handle(reply, async () => {
        const key = await projectKey(request.query.projectId);
        const id = request.params.workerId;
        const { profile } = await workers.availableSnapshot(id, key);
        const { revision, name, role, instructions, settings: choice } = request.body;
        const settings = { ...profile.settings };
        if (choice === null) delete settings[provider];
        else if (choice !== undefined) settings[provider] = choice;
        return workers.edit(id, key, revision, { name, role, instructions, settings });
      }),
  );
  app.patch<MemoryRequest & { Body: { expectedText: string; text: string } }>(
    `${root}/:workerId/memory/:entryId`,
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["expectedText", "text"],
          properties: {
            expectedText: { type: "string", maxLength: 2200 },
            text: { type: "string", maxLength: 2200 },
          },
        },
      },
    },
    (request, reply) =>
      handle(reply, async () => {
        const key = await projectKey(request.query.projectId);
        await workers.availableSnapshot(request.params.workerId, key);
        return workers.changeMemory(request.params.workerId, key, {
          action: "edit",
          id: request.params.entryId,
          expectedText: request.body.expectedText,
          text: request.body.text,
        });
      }),
  );
  app.delete<MemoryRequest & { Body: { expectedText: string } }>(
    `${root}/:workerId/memory/:entryId`,
    {
      schema: {
        body: {
          type: "object",
          required: ["expectedText"],
          properties: { expectedText: { type: "string", maxLength: 2200 } },
        },
      },
    },
    (request, reply) =>
      handle(reply, async () => {
        const key = await projectKey(request.query.projectId);
        await workers.availableSnapshot(request.params.workerId, key);
        return workers.changeMemory(request.params.workerId, key, {
          action: "remove",
          id: request.params.entryId,
          expectedText: request.body.expectedText,
        });
      }),
  );
}
