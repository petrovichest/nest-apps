import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function configFixture() {
  const directory = await mkdtemp("/tmp/cnc-");
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const serverEnvFile = join(directory, "server.env");
  const tokenFile = join(directory, "token");
  await Promise.all([
    writeFile(serverEnvFile, ""),
    writeFile(tokenFile, "private-fixture-token-with-at-least-32-characters", { mode: 0o600 }),
  ]);
  const environment = {
    CLAUDENEST_SERVER_ENV_FILE: serverEnvFile,
    CLAUDENEST_TOKEN_FILE: tokenFile,
    CLAUDENEST_STATE_DIR: join(directory, "state"),
    CLAUDENEST_RUNTIME_DIR: join(directory, "run"),
    CLAUDENEST_RELEASE_PATH: directory,
    CLAUDENEST_CLAUDE_BIN: process.execPath,
    CLAUDENEST_RUNNER_PATH: process.execPath,
    CLAUDENEST_PORT: "4311",
    CLAUDENEST_ALLOWED_ORIGINS: "",
    CLAUDE_CONFIG_DIR: join(directory, "native"),
  };
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
}

describe("loadConfig", () => {
  it("always allows the bundled Android origin alongside configured origins", async () => {
    await configFixture();
    vi.stubEnv("CLAUDENEST_ALLOWED_ORIGINS", "https://claude.home.arpa, , https://another.example");
    expect((await loadConfig()).allowedOrigins).toEqual(
      new Set(["http://localhost", "https://claude.home.arpa", "https://another.example"]),
    );
  });

  it("keeps browser development origins alongside the bundled Android origin by default", async () => {
    await configFixture();
    expect((await loadConfig()).allowedOrigins).toEqual(
      new Set([
        "http://localhost",
        "http://127.0.0.1:4311",
        "http://localhost:4311",
        "http://127.0.0.1:5174",
        "http://localhost:5174",
      ]),
    );
  });
});
