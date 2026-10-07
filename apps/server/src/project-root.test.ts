import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app";
import { AttentionManager } from "./attention";
import { hashToken } from "./auth";
import type { CodexBridge } from "./codex/bridge";
import { loadConfig } from "./config";
import { AppProjection } from "./projection";
import { StateStore } from "./state/store";

class IdleBridge extends EventEmitter {
  state = "ready";
  request = vi.fn(async () => ({}));
}

const apps: FastifyInstance[] = [];
const directories: string[] = [];
const headers = { authorization: "Bearer correct" };
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function serve(directory: string, projectRoot: string, serviceRoot?: string) {
  const store = new StateStore(join(directory, "state.json"));
  await store.load();
  await store.update((state) => {
    state.auth.tokenSha256 = hashToken("correct");
  });
  const bridge = new IdleBridge();
  const attention = new AttentionManager();
  const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
  const app = await buildApp(
    loadConfig({ statePath: store.path, clientDist: join(directory, "missing"), projectRoot }),
    {
      bridge: bridge as unknown as CodexBridge,
      store,
      projection,
      attention,
      projectRoot: serviceRoot,
    },
  );
  apps.push(app);
  return { app, store };
}

describe("configured project root", () => {
  it("uses the configured root for project creation and keeps paths and symlinks confined", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-project-root-"));
    directories.push(directory);
    const root = join(directory, "copy_trade");
    const outside = join(directory, "outside");
    await Promise.all([mkdir(root), mkdir(outside)]);
    await symlink(outside, join(root, "escape"));
    const { app, store } = await serve(directory, root);

    const listing = await app.inject({ url: "/api/v1/directories", headers });
    expect(listing.statusCode).toBe(200);
    expect(listing.json()).toMatchObject({ rootPath: root, path: root, directories: [] });

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers,
      payload: { path: root },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ displayName: "copy_trade", path: await realpath(root) });
    expect(store.view().projects).toEqual([created.json()]);

    for (const path of [outside, join(root, "escape")]) {
      const rejected = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers,
        payload: { path },
      });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json()).toMatchObject({ error: { code: "validation_failed" } });
      expect(
        (await app.inject({ url: `/api/v1/directories?${new URLSearchParams({ path })}`, headers }))
          .statusCode,
      ).toBe(400);
    }
    expect(store.view().projects).toHaveLength(1);
  });

  it("preserves an explicit project root supplied by an API test harness", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexnest-project-root-"));
    directories.push(directory);
    const configuredRoot = join(directory, "configured");
    const serviceRoot = join(directory, "override");
    await Promise.all([mkdir(configuredRoot), mkdir(serviceRoot)]);
    const { app } = await serve(directory, configuredRoot, serviceRoot);

    const listing = await app.inject({ url: "/api/v1/directories", headers });
    expect(listing.statusCode).toBe(200);
    expect(listing.json()).toMatchObject({ rootPath: serviceRoot, path: serviceRoot });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/projects",
          headers,
          payload: { path: serviceRoot },
        })
      ).statusCode,
    ).toBe(201);
  });
});
