import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeJsonAtomic } from "../../claude-server/src/io";
import type { AcpClient } from "./acp";
import { compareCliVersions, GeminiCliManager, resolveAntigravityPlatform } from "./cli-management";
import { paths } from "./config";
import { Engine } from "./engine";

const exec = promisify(execFile);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function createCliTarball(dir: string, version: string, modelsOutput: string) {
  const srcDir = join(dir, `pkg-${version}`);
  await mkdir(srcDir, { recursive: true });
  const script = `#!${process.execPath}
if (process.argv.includes("--version")) {
  process.stdout.write(${JSON.stringify(`${version}\n`)});
  process.exit(0);
}
if (process.argv.includes("models")) {
  process.stdout.write(${JSON.stringify(modelsOutput)});
  process.exit(0);
}
process.exit(0);
`;
  await writeFile(join(srcDir, "antigravity"), script, { mode: 0o755 });
  const archivePath = join(dir, `antigravity-${version}.tar.gz`);
  await exec("tar", ["-czf", archivePath, "-C", srcDir, "antigravity"]);
  const bytes = await readFile(archivePath);
  const sha512 = createHash("sha512").update(bytes).digest("hex");
  return { bytes, sha512 };
}

describe("GeminiCliManager", () => {
  it("compares semver versions and resolves supported platforms", () => {
    expect(resolveAntigravityPlatform("linux", "x64")).toBe("linux_amd64");
    expect(resolveAntigravityPlatform("darwin", "arm64")).toBe("darwin_arm64");
    expect(resolveAntigravityPlatform("win32", "x64")).toBeNull();
    expect(compareCliVersions("1.5.9", "1.5.3")).toBe(1);
    expect(compareCliVersions("1.5.9", "1.5.9")).toBe(0);
    expect(compareCliVersions("1.5.3", "1.5.9")).toBe(-1);
    expect(compareCliVersions("1.5.3", "1.5.3-fixture")).toBe(1);
  });

  it("checks manifest, verifies SHA-512, atomically updates CLI + server.env, and refreshes models", async () => {
    const root = await mkdtemp(join(tmpdir(), "gemininest-cli-mgr-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));

    const oldDir = join(root, "old-cli");
    await mkdir(oldDir, { recursive: true });
    const oldBin = join(oldDir, "antigravity");
    await writeFile(
      oldBin,
      `#!${process.execPath}
if (process.argv.includes("--version")) { process.stdout.write("1.5.3\\n"); process.exit(0); }
if (process.argv.includes("models")) {
  process.stdout.write("gemini-4-carbon-high  Gemini 4 Carbon (High)\\ngemini-4-carbon-low   Gemini 4 Carbon (Low)\\n");
  process.exit(0);
}
process.exit(0);
`,
      { mode: 0o755 },
    );

    const { bytes: archiveBytes, sha512: validSha512 } = await createCliTarball(
      root,
      "1.5.9",
      [
        "gemini-4-carbon-medium         Gemini 4 Carbon (Medium)",
        "gemini-4-carbon-high           Gemini 4 Carbon (High)",
        "gemini-4-carbon-low            Gemini 4 Carbon (Low)",
        "gemini-pro-orchestrator        Orchestrator (Carbon)",
      ].join("\n") + "\n",
    );

    let reportedSha512 = validSha512;
    const server: Server = createServer((req, res) => {
      if (req.url?.startsWith("/manifest.json")) {
        const port = (server.address() as { port: number }).port;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            version: "1.5.9",
            url: `http://127.0.0.1:${port}/cli_linux_x64.tar.gz`,
            sha512: reportedSha512,
          }),
        );
        return;
      }
      if (req.url === "/cli_linux_x64.tar.gz") {
        res.writeHead(200, { "content-type": "application/gzip" });
        res.end(archiveBytes);
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as { port: number }).port;

    const configDir = join(root, "config");
    const stateDir = join(root, "state");
    const dataDir = join(root, "data");
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    const envFile = join(configDir, "server.env");
    await writeFile(
      envFile,
      `GEMININEST_PORT=4314\nGEMININEST_AGY_BIN=${JSON.stringify(oldBin)}\n`,
      { mode: 0o600 },
    );

    const config = {
      ...paths({
        GEMININEST_CONFIG_DIR: configDir,
        GEMININEST_STATE_DIR: stateDir,
        GEMININEST_DATA_DIR: dataDir,
        GEMININEST_RUNTIME_DIR: join(root, "run"),
        GEMININEST_AGY_BIN: oldBin,
        GEMININEST_MANAGED_INSTALL: "1",
      }),
      token: "t".repeat(48),
    };

    const engine = new Engine(config, undefined, { pollRateLimits: false });
    await engine.initialize();
    cleanups.push(() => engine.close());

    const manager = new GeminiCliManager(engine, {
      manifestUrl: `http://127.0.0.1:${port}/manifest.json`,
      platform: "linux",
      arch: "x64",
    });

    // Without proxy configured, status reports proxy requirement and check rejects with 409
    const initial = await manager.status();
    expect(initial).toMatchObject({
      supported: true,
      proxyConfigured: false,
      cliVersion: "1.5.3",
      updateAvailable: null,
    });
    await expect(manager.check()).rejects.toThrow("прокси");

    // Configure proxy + authenticated state
    await writeJsonAtomic(join(configDir, "connection.json"), {
      proxy: "http://127.0.0.1:9",
      authenticated: true,
    });
    await engine.account.initialize();

    const checked = await manager.check();
    expect(checked).toMatchObject({
      supported: true,
      proxyConfigured: true,
      cliVersion: "1.5.3",
      latestVersion: "1.5.9",
      updateAvailable: true,
      operation: "idle",
      result: "none",
    });
    await vi.waitFor(() =>
      expect(engine.snapshot().models.map((item) => item.id)).toEqual(["gemini-4-carbon"]),
    );

    // SHA-512 mismatch must abort without touching agyBin or server.env
    reportedSha512 = "0".repeat(128);
    await expect(manager.update()).rejects.toThrow("Контрольная сумма");
    expect(engine.config.agyBin).toBe(oldBin);
    expect(engine.account.cliVersion).toBe("1.5.3");

    reportedSha512 = validSha512;
    const currentLink = join(dataDir, "runtime", "antigravity-current");
    await symlink(oldDir, currentLink);
    await rename(envFile, `${envFile}.saved`);
    await mkdir(envFile);
    await expect(manager.update()).rejects.toThrow("Не удалось обновить");
    expect(await realpath(currentLink)).toBe(await realpath(oldDir));
    expect(engine.config.agyBin).toBe(oldBin);
    expect(engine.account.cliVersion).toBe("1.5.3");
    await rm(envFile, { recursive: true });
    await rename(`${envFile}.saved`, envFile);

    // Retrying after a settings write failure can install the verified CLI.
    const updated = await manager.update();
    expect(updated).toMatchObject({
      cliVersion: "1.5.9",
      latestVersion: "1.5.9",
      updateAvailable: false,
      operation: "idle",
      result: "updated",
    });

    const expectedCurrentBin = join(dataDir, "runtime", "antigravity-current", "antigravity");
    expect(engine.config.agyBin).toBe(expectedCurrentBin);
    expect(await realpath(expectedCurrentBin)).toBe(
      await realpath(join(dataDir, "runtime", "antigravity-1.5.9", "antigravity")),
    );

    const savedEnv = await readFile(envFile, "utf8");
    expect(savedEnv).toContain("GEMININEST_PORT=4314");
    expect(savedEnv).toContain(`GEMININEST_AGY_BIN=${JSON.stringify(expectedCurrentBin)}`);
    expect((await stat(envFile)).mode & 0o777).toBe(0o600);

    await vi.waitFor(() =>
      expect(engine.snapshot().models.map((item) => item.id)).toEqual([
        "gemini-4-carbon",
        "gemini-pro-orchestrator",
      ]),
    );
  });

  it("clears the operation and permits retry after proxy connection setup fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "gemininest-cli-connection-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const config = {
      ...paths({
        GEMININEST_CONFIG_DIR: join(root, "config"),
        GEMININEST_STATE_DIR: join(root, "state"),
        GEMININEST_RUNTIME_DIR: join(root, "run"),
        GEMININEST_AGY_BIN: "/bin/true",
        GEMININEST_MANAGED_INSTALL: "1",
      }),
      token: "t".repeat(48),
    };
    await writeJsonAtomic(join(config.configDir, "connection.json"), {
      proxy: "http://unused.example:3128",
      authenticated: true,
    });
    const engine = new Engine(config);
    await engine.initialize();
    cleanups.push(() => engine.close());
    const manager = new GeminiCliManager(engine, { platform: "linux", arch: "x64" });
    const connect = vi.spyOn(engine.account, "connection");
    for (const operation of ["check", "update"] as const) {
      connect.mockRejectedValueOnce(new Error("Proxy bridge could not listen"));
      await expect(manager[operation]()).rejects.toThrow();
      expect(await manager.status()).toMatchObject({ operation: "idle", result: "failed" });
    }
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("blocks update while a session turn is active", async () => {
    const root = await mkdtemp(join(tmpdir(), "gemininest-cli-busy-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const config = {
      ...paths({
        GEMININEST_CONFIG_DIR: join(root, "config"),
        GEMININEST_STATE_DIR: join(root, "state"),
        GEMININEST_DATA_DIR: join(root, "data"),
        GEMININEST_RUNTIME_DIR: join(root, "run"),
        GEMININEST_AGY_BIN: "/bin/true",
        GEMININEST_MANAGED_INSTALL: "1",
      }),
      token: "t".repeat(48),
    };
    await writeJsonAtomic(join(config.configDir, "connection.json"), {
      proxy: "http://unused.example:3128",
      authenticated: true,
    });
    let resolvePrompt!: (value: any) => void;
    const fakeAcp = {
      onRequest: async () => ({}),
      on: () => fakeAcp,
      once: () => fakeAcp,
      off: () => fakeAcp,
      start: async () => ({ protocolVersion: 1 }),
      request: (method: string) => {
        if (method === "session/prompt") {
          return new Promise((resolve) => {
            resolvePrompt = resolve;
          });
        }
        return Promise.resolve({ sessionId: "native-1", configOptions: [] });
      },
      notify: () => {},
      close: () => {},
    } as unknown as AcpClient;

    const engine = new Engine(config, () => fakeAcp);
    await engine.initialize();
    cleanups.push(() => engine.close());

    const project = await engine.addProject(root);
    const { thread } = await engine.createThread(project.id, "busy");
    await engine.send(thread.id, { input: "working", clientMessageId: "m1" });

    const manager = new GeminiCliManager(engine, {
      manifestUrl: "http://127.0.0.1:9/manifest.json",
      platform: "linux",
      arch: "x64",
    });
    expect((await manager.status()).activeTurnCount).toBeGreaterThan(0);
    await expect(manager.update()).rejects.toThrow("активных задач");
    resolvePrompt({ stopReason: "end_turn" });
  });
});
