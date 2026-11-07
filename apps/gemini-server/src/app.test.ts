import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { writeJsonAtomic } from "../../claude-server/src/io";
import { Engine } from "./engine";
import { buildApp } from "./app";
import { createGateway } from "./gateway";
import { paths } from "./config";
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
it("protects API and retains daemon state when its public gateway restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "gemininest-api-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const config = {
    ...paths({
      GEMININEST_CONFIG_DIR: root,
      GEMININEST_STATE_DIR: join(root, "state"),
      GEMININEST_RUNTIME_DIR: root,
      GEMININEST_AGY_BIN: "/bin/true",
    }),
    token: "t".repeat(48),
  };
  const engine = new Engine(config);
  await engine.initialize();
  cleanups.push(() => engine.close());
  const app = await buildApp(engine);
  await app.listen({ path: config.socket });
  cleanups.push(() => app.close());
  expect((await app.inject({ url: "/api/v1/health" })).statusCode).toBe(401);
  expect(
    (
      await app.inject({
        url: "/api/v1/health",
        headers: { authorization: `Bearer ${config.token}`, origin: "https://attacker.example" },
      })
    ).statusCode,
  ).toBe(403);
  const openGateway = async () => {
    const gateway = createGateway(config.socket);
    await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
    const port = (gateway.server.address() as { port: number }).port;
    return { gateway, url: `http://127.0.0.1:${port}` };
  };
  const first = await openGateway();
  const headers = { authorization: `Bearer ${config.token}`, "content-type": "application/json" };
  const project = (await fetch(`${first.url}/api/v1/projects`, {
    method: "POST",
    headers,
    body: JSON.stringify({ path: root }),
  }).then((r) => r.json())) as { id: string };
  await first.gateway.close();
  const second = await openGateway();
  cleanups.push(() => second.gateway.close());
  const projects = await fetch(`${second.url}/api/v1/projects`, { headers }).then((r) => r.json());
  expect(projects).toEqual([expect.objectContaining({ id: project.id })]);
  const created = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${project.id}/threads`,
    headers,
    payload: { clientCreationId: "one" },
  });
  const id = created.json().thread.id;
  const savedDraft = await app.inject({
    method: "PUT",
    url: `/api/v1/threads/${id}/draft?expectedUpdatedAt=none`,
    headers,
    payload: { input: "hello", images: [], annotations: [], goalMode: false },
  });
  expect(savedDraft.statusCode).toBe(200);
  const stale = await app.inject({
    method: "PUT",
    url: `/api/v1/threads/${id}/draft?expectedUpdatedAt=none`,
    headers,
    payload: { input: "stale", images: [], annotations: [], goalMode: false },
  });
  expect(stale.statusCode).toBe(409);
  const file = join(root, "report.txt");
  await writeFile(file, "result");
  const download = await app.inject({
    method: "POST",
    url: `/api/v1/threads/${id}/downloads`,
    headers,
    payload: { path: file },
  });
  expect(download.json()).toMatchObject({
    downloadUrl: expect.stringMatching(/^\/api\/v1\/downloads\//),
    fileName: "report.txt",
    expiresAt: expect.any(Number),
  });
  expect((await app.inject({ url: download.json().downloadUrl })).body).toBe("result");
});

it("keeps a real ACP subprocess and its approval alive across gateway WebSocket reconnects", async () => {
  const root = await mkdtemp(join(tmpdir(), "gemininest-owner-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const config = {
    ...paths({
      GEMININEST_CONFIG_DIR: root,
      GEMININEST_STATE_DIR: join(root, "state"),
      GEMININEST_RUNTIME_DIR: root,
      GEMININEST_AGY_BIN: resolve(import.meta.dirname, "../scripts/fixture-agent.mjs"),
    }),
    token: "t".repeat(48),
  };
  await writeJsonAtomic(join(root, "connection.json"), {
    proxy: "http://127.0.0.1:9",
    authenticated: true,
  });
  const engine = new Engine(config);
  await engine.initialize();
  cleanups.push(() => engine.close());
  const app = await buildApp(engine);
  await app.listen({ path: config.socket });
  cleanups.push(() => app.close());
  const open = async () => {
    const gateway = createGateway(config.socket);
    await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => gateway.close());
    const socket = new WebSocket(
      `ws://127.0.0.1:${(gateway.server.address() as { port: number }).port}/api/v1/ui/events`,
    );
    const snapshot = new Promise<any>((resolve) =>
      socket.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data));
        if (frame.type === "snapshot") resolve(frame.snapshot);
      }),
    );
    await new Promise<void>((resolve) =>
      socket.addEventListener("open", () => resolve(), { once: true }),
    );
    socket.send(JSON.stringify({ type: "authenticate", token: config.token }));
    return { gateway, socket, snapshot: await snapshot };
  };
  const project = await engine.addProject(root);
  const { thread } = await engine.createThread(project.id, "one");
  const first = await open();
  expect(first.snapshot.provider).toBe("gemini");
  await engine.send(thread.id, { input: "approval please", clientMessageId: "one" });
  await vi.waitFor(() => expect(engine.snapshot().attention).toHaveLength(1));
  const approval = engine.snapshot().attention[0]!;
  await first.gateway.close();
  const second = await open();
  expect(second.snapshot.attention).toEqual([approval]);
  expect(engine.detail(thread.id).summary.state).toBe("needsAttention");
  engine.respond(approval.id, { kind: "approval", decision: "accept" });
  await vi.waitFor(() => expect(engine.detail(thread.id).summary.state).toBe("completed"));
  expect(engine.detail(thread.id).turns[0]!.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "agentMessage", text: "Gemini fixture completed." }),
    ]),
  );
});
