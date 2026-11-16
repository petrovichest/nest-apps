import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { paths, type Config } from "./config";
import { Engine } from "./engine";
import { type OpenCodeClient, OpenCodeError } from "./opencode";
import type { NativeMessage } from "./projection";

type Call = { method: string; path: string; directory?: string; body?: any };
export class NativeFixture {
  calls: Call[] = [];
  sessions = new Map<
    string,
    { id: string; directory: string; title: string; time: { created: number; updated: number } }
  >();
  messages = new Map<string, NativeMessage[]>();
  statuses = new Map<string, Record<string, { type: string }>>();
  permissions: Record<string, any>[] = [];
  questions: Record<string, any>[] = [];
  count = 0;
  ambiguous = false;
  beforeAck?: (id: string) => Promise<void>;
  beforeStatus?: () => Promise<void>;
  beforeCreate?: () => Promise<void>;
  beforeFork?: () => Promise<void>;
  supportsImages = true;
  skills: Array<{ name: string; description: string; location: string; content: string }> = [];
  async health() {
    return { healthy: true, version: "1.19.5" };
  }
  async request<T>(
    method: string,
    path: string,
    options: { directory?: string; body?: any } = {},
  ): Promise<T> {
    this.calls.push({ method, path, ...options });
    let result: unknown;
    if (path === "/provider")
      result = {
        connected: ["openrouter"],
        default: { openrouter: "vendor/test" },
        all: [
          {
            id: "openrouter",
            models: {
              "vendor/test": {
                name: "Test model",
                variants: { low: {}, high: {} },
                capabilities: { input: { image: this.supportsImages } },
              },
            },
          },
        ],
      };
    else if (path === "/skill") result = this.skills;
    else if (path === "/session/status") {
      if (this.beforeStatus) await this.beforeStatus();
      result = this.statuses.get(options.directory ?? "default") ?? {};
    } else if (path.startsWith("/experimental/session"))
      result = [...this.sessions.values()].slice(
        0,
        Number(new URL(path, "http://fixture.invalid").searchParams.get("limit") ?? 100),
      );
    else if (path === "/permission") result = this.permissions;
    else if (path === "/question") result = this.questions;
    else if ((path === "/session" || path.startsWith("/session?")) && method === "GET")
      result = [...this.sessions.values()]
        .filter((session) => session.directory === options.directory)
        .slice(0, Number(new URL(path, "http://fixture.invalid").searchParams.get("limit") ?? 100));
    else if (path === "/session" && method === "POST") {
      if (this.beforeCreate) await this.beforeCreate();
      const now = Date.now();
      const session = {
        id: `ses_${++this.count}`,
        directory: options.directory!,
        title: "New session",
        time: { created: now, updated: now },
      };
      this.sessions.set(session.id, session);
      this.messages.set(session.id, []);
      result = session;
    } else if (/\/session\/[^/]+\/message$/.test(path))
      result = this.messages.get(path.split("/")[2]!) ?? [];
    else if (path.endsWith("/prompt_async")) {
      const id = path.split("/")[2]!;
      this.messages.get(id)!.push({
        info: {
          id: options.body.messageID,
          sessionID: id,
          role: "user",
          time: { created: Date.now() },
        },
        parts: options.body.parts.map((part: NativeMessage["parts"][number], index: number) => ({
          ...part,
          id: `part_${options.body.messageID}_${index}`,
          messageID: options.body.messageID,
          sessionID: id,
        })),
      });
      if (this.beforeAck) await this.beforeAck(id);
      if (this.ambiguous) throw new OpenCodeError("unavailable");
    } else if (path.endsWith("/fork")) {
      if (this.beforeFork) await this.beforeFork();
      const original = this.sessions.get(path.split("/")[2]!)!;
      const session = { ...original, id: `ses_${++this.count}` };
      this.sessions.set(session.id, session);
      result = session;
      const source = this.messages.get(original.id) ?? [];
      const cutoff = options.body?.messageID
        ? source.findIndex((message) => message.info.id === options.body.messageID)
        : source.length;
      const ids = new Map<string, string>();
      const copied = structuredClone(source.slice(0, cutoff < 0 ? source.length : cutoff)).map(
        (message, index) => {
          const nextId = `fork_${session.id}_${index}`;
          ids.set(message.info.id, nextId);
          message.info.id = nextId;
          message.info.sessionID = session.id;
          if (message.info.parentID)
            message.info.parentID = ids.get(message.info.parentID) ?? message.info.parentID;
          message.parts = message.parts.map((part, partIndex) => ({
            ...part,
            id: `${nextId}_part_${partIndex}`,
            messageID: nextId,
            sessionID: session.id,
          }));
          return message;
        },
      );
      this.messages.set(session.id, copied);
    } else if (path.endsWith("/summarize")) result = true;
    else if (
      path === "/auth/openrouter" ||
      path === "/instance/dispose" ||
      path.endsWith("/abort") ||
      path.endsWith("/reply") ||
      method === "PATCH"
    )
      result = true;
    else throw new Error(`Unimplemented fixture route ${method} ${path}`);
    return structuredClone(result) as T;
  }
  client() {
    return this as unknown as OpenCodeClient;
  }
  prompts() {
    return this.calls.filter((call) => call.path.endsWith("/prompt_async"));
  }
}
export const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
export async function setup() {
  const scratch = await mkdtemp(join(tmpdir(), "opennest-backend-"));
  cleanups.push(() => rm(scratch, { recursive: true, force: true }));
  const cwd = join(scratch, "project");
  await mkdir(cwd);
  const config: Config = {
    ...paths({
      OPENNEST_CONFIG_DIR: join(scratch, "config"),
      OPENNEST_STATE_DIR: join(scratch, "state"),
      OPENNEST_RUNTIME_DIR: join(scratch, "runtime"),
      OPENNEST_CLIENT_DIST: join(scratch, "no-client"),
      OPENNEST_NATIVE_DATABASE_PATH: join(scratch, "native.db"),
    }),
    token: "t".repeat(64),
  };
  const native = new NativeFixture();
  const engine = new Engine(config, { native: native.client() });
  await engine.initialize({ watch: false });
  await engine.reconcile();
  cleanups.push(() => engine.close());
  const project = await engine.addProject(cwd);
  const { thread } = await engine.createThread(project.id, "creation");
  return { scratch, config, native, engine, project, thread };
}
