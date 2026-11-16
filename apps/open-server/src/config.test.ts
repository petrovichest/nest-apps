import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, paths } from "./config";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
async function privateConfiguration() {
  const root = await mkdtemp(join(tmpdir(), "opennest-config-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const previous = { ...process.env };
  cleanups.push(async () => {
    process.env = previous;
  });
  process.env.OPENNEST_CONFIG_DIR = join(root, "config");
  process.env.OPENNEST_STATE_DIR = join(root, "state");
  process.env.OPENNEST_RUNTIME_DIR = join(root, "run");
  delete process.env.OPENNEST_SERVER_ENV_FILE;
  await mkdir(process.env.OPENNEST_CONFIG_DIR, { mode: 0o700 });
  const token = join(process.env.OPENNEST_CONFIG_DIR, "token");
  await writeFile(token, "a".repeat(64), { mode: 0o600 });
  return { root, token, envFile: join(process.env.OPENNEST_CONFIG_DIR, "server.env") };
}

describe("private native connection configuration", () => {
  it("defaults to its own API, state and local native origin", () => {
    const config = paths({});
    expect(config.port).toBe(4313);
    expect(config.nativeUrl).toBe("http://127.0.0.1:4097");
    expect(config.configDir).toMatch(/opennest$/);
    expect(config.clientDist).toMatch(/dist-open$/);
  });
  it.each([
    "https://127.0.0.1:4097",
    "http://example.com:4097",
    "http://user:secret@127.0.0.1:4097",
    "http://127.0.0.1:4097/private",
    "http://127.0.0.1:4097/?secret=x",
  ])("rejects unsafe native origin %s", (url) => {
    expect(() => paths({ OPENNEST_NATIVE_URL: url })).toThrow("loopback HTTP origin");
  });
  it("loads an isolated installation without requiring a server.env", async () => {
    const { token } = await privateConfiguration();
    const config = await loadConfig();
    expect(config.token).toBe("a".repeat(64));
    await chmod(token, 0o644);
    await expect(loadConfig()).rejects.toThrow("token must be a private regular file");
  });
  it("refuses world-readable environment secrets before applying them", async () => {
    const { envFile } = await privateConfiguration();
    await writeFile(envFile, "OPENNEST_NATIVE_PASSWORD=private-test-value\n", { mode: 0o644 });
    await expect(loadConfig()).rejects.toThrow("server.env must be a private regular file");
    expect(process.env.OPENNEST_NATIVE_PASSWORD).not.toBe("private-test-value");
  });
  it("refuses symlinked environment/token files", async () => {
    const { root, token, envFile } = await privateConfiguration();
    const source = join(root, "private-env");
    await writeFile(source, "", { mode: 0o600 });
    await symlink(source, envFile);
    await expect(loadConfig()).rejects.toThrow("server.env must be a private regular file");
    await rm(envFile);
    await rm(token);
    await symlink(source, token);
    await expect(loadConfig()).rejects.toThrow("token must be a private regular file");
  });
});
