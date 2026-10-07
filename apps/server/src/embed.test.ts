import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app";
import { AttentionManager } from "./attention";
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
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function serve(embedOrigins?: string) {
  if (embedOrigins !== undefined) vi.stubEnv("CODEXNEST_EMBED_ORIGINS", embedOrigins);
  const directory = await mkdtemp(join(tmpdir(), "codexnest-embed-"));
  directories.push(directory);
  const clientDist = join(directory, "dist");
  await mkdir(clientDist);
  await writeFile(join(clientDist, "index.html"), "<!doctype html><title>CodexNest</title>");
  await writeFile(join(clientDist, "embed.js"), "window.CodexNestEmbed = {};");
  const store = new StateStore(join(directory, "state.json"));
  await store.load();
  const bridge = new IdleBridge();
  const attention = new AttentionManager();
  const projection = new AppProjection(bridge as unknown as CodexBridge, store, attention);
  const app = await buildApp(loadConfig({ statePath: store.path, clientDist }), {
    bridge: bridge as unknown as CodexBridge,
    store,
    projection,
    attention,
  });
  apps.push(app);
  return app;
}

describe("embedding", () => {
  it("forbids framing unless embed origins are configured", async () => {
    const app = await serve("");
    const response = await app.inject({ url: "/" });
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  it("lets only the configured sites frame the application", async () => {
    const app = await serve("https://bots.example, http://10.0.0.5:8780/");
    const response = await app.inject({ url: "/threads/one" });
    expect(response.headers["content-security-policy"]).toContain(
      "frame-ancestors 'self' https://bots.example http://10.0.0.5:8780",
    );
  });

  it("serves the floating window loader", async () => {
    const app = await serve("https://bots.example");
    const response = await app.inject({ url: "/embed.js" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("CodexNestEmbed");
  });

  it("rejects embed origins with paths or credentials", () => {
    vi.stubEnv("CODEXNEST_EMBED_ORIGINS", "https://bots.example/dashboard");
    expect(() => loadConfig()).toThrow("CODEXNEST_EMBED_ORIGINS");
    vi.stubEnv("CODEXNEST_EMBED_ORIGINS", "https://user:pass@bots.example");
    expect(() => loadConfig()).toThrow("CODEXNEST_EMBED_ORIGINS");
    vi.stubEnv("CODEXNEST_EMBED_ORIGINS", "javascript:alert(1)");
    expect(() => loadConfig()).toThrow("CODEXNEST_EMBED_ORIGINS");
  });
});
