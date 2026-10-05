import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const manageScript = fileURLToPath(new URL("../scripts/manage.mjs", import.meta.url));
const token = "management-test-token-abcdefghijklmnopqrstuv";
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

type ApiState = { available: boolean; releasePath: string; recoveryState: string };
type ApiRequest = { route: string; available: boolean; body: Record<string, unknown> };

async function fixture() {
  const directory = await mkdtemp("/tmp/cnm-");
  const configHome = join(directory, "config");
  const dataHome = join(directory, "data");
  const configRoot = join(configHome, "claudenest");
  const dataRoot = join(dataHome, "claudenest");
  const bin = join(directory, "bin");
  const envPath = join(configRoot, "server.env");
  const statePath = join(directory, "api-state.json");
  const commandsPath = join(directory, "systemctl.jsonl");
  const oldRelease = join(directory, "old-release");
  const nextRelease = join(directory, "next-release");
  const requests: ApiRequest[] = [];
  let rejectCompatibility = false;

  for (const path of [configRoot, dataRoot, bin]) await mkdir(path, { recursive: true });
  for (const releasePath of [oldRelease, nextRelease]) {
    const dist = join(releasePath, "apps/claude-server/dist");
    await mkdir(dist, { recursive: true });
    await writeFile(join(dist, "index.js"), "// simulated immutable backend build\n");
    await writeFile(join(dist, "runner-main.js"), "// simulated immutable runner build\n");
    await writeFile(
      join(releasePath, "apps/claude-server/runner-protocol.json"),
      JSON.stringify({ supportedRunnerProtocols: [1] }),
    );
  }
  await symlink(oldRelease, join(dataRoot, "current"));
  await writeFile(join(configRoot, "token"), "incorrect-default-test-token\n", { mode: 0o600 });
  const customTokenPath = join(configRoot, "custom-token");
  await writeFile(customTokenPath, `${token}\n`, { mode: 0o600 });
  await writeFile(
    statePath,
    JSON.stringify({
      available: true,
      releasePath: oldRelease,
      recoveryState: "ready",
    } satisfies ApiState),
  );

  // Only these fake executable files receive management subprocess calls.
  await writeFile(
    join(bin, "git"),
    `#!${process.execPath}\nif (process.argv.includes('symbolic-ref')) process.exit(1);\n`,
    { mode: 0o700 },
  );
  await writeFile(
    join(bin, "claude"),
    `#!${process.execPath}\nprocess.stdout.write('test Claude version\\n');\n`,
    { mode: 0o700 },
  );
  await writeFile(
    join(bin, "systemctl"),
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_COMMANDS_PATH, JSON.stringify(args) + '\\n');
const action = args.find((arg) => ['show','restart','start','stop','daemon-reload','enable'].includes(arg));
if (action === 'show') {
  process.stdout.write(args.includes('ActiveState') ? (process.env.FAKE_SERVICE_STATE || 'inactive') + '\\n' : 'Version=256\\n');
} else if (action === 'restart' && process.env.FAKE_RESTART_FAIL === '1') {
  fs.writeFileSync(process.env.FAKE_STATE_PATH, JSON.stringify({available:false,releasePath:fs.realpathSync(path.join(process.env.XDG_DATA_HOME,'claudenest/current')),recoveryState:'unavailable'}));
  process.stderr.write('simulated target backend restart failure\\n');
  process.exit(1);
} else if (action === 'stop') {
  const state = JSON.parse(fs.readFileSync(process.env.FAKE_STATE_PATH,'utf8'));
  state.available = false;
  fs.writeFileSync(process.env.FAKE_STATE_PATH,JSON.stringify(state));
} else if (action === 'start' || action === 'restart' || action === 'enable') {
  const env = fs.readFileSync(path.join(process.env.XDG_CONFIG_HOME,'claudenest/server.env'),'utf8');
  const paused = /^CLAUDENEST_START_PAUSED="1"$/m.test(env);
  fs.writeFileSync(process.env.FAKE_STATE_PATH,JSON.stringify({available:true,releasePath:fs.realpathSync(path.join(process.env.XDG_DATA_HOME,'claudenest/current')),recoveryState:paused?'draining':'ready'}));
}
`,
    { mode: 0o700 },
  );

  const server: Server = createServer(async (request, response) => {
    try {
      const state = JSON.parse(await readFile(statePath, "utf8")) as ApiState;
      const route = request.url!.replace("/api/v1/", "");
      let rawBody = "";
      for await (const chunk of request) rawBody += String(chunk);
      const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
      requests.push({ route, available: state.available, body });
      response.setHeader("content-type", "application/json");
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401).end(JSON.stringify({ error: { message: "Wrong test token" } }));
      } else if (!state.available) {
        response
          .writeHead(503)
          .end(JSON.stringify({ error: { message: "Simulated new API is unavailable" } }));
      } else if (route === "health") {
        response.end(
          JSON.stringify({ releasePath: state.releasePath, recoveryState: state.recoveryState }),
        );
      } else if (route === "internal/restart/prepare") {
        if (rejectCompatibility)
          response
            .writeHead(409)
            .end(
              JSON.stringify({ error: { message: "Target cannot recover live runner protocol" } }),
            );
        else {
          state.recoveryState = "draining";
          await writeFile(statePath, JSON.stringify(state));
          response.end(
            JSON.stringify({
              supportedRunnerProtocols: [1],
              runners: 2,
              releasePaths: [oldRelease],
            }),
          );
        }
      } else if (route === "internal/restart/resume") {
        state.recoveryState = "ready";
        await writeFile(statePath, JSON.stringify(state));
        response.end(JSON.stringify({ resumed: true }));
      } else
        response.writeHead(404).end(JSON.stringify({ error: { message: "Unknown test route" } }));
    } catch {
      response.writeHead(500).end(JSON.stringify({ error: { message: "Test server error" } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test HTTP port");
  await writeFile(
    envPath,
    [
      `CLAUDENEST_PORT=${JSON.stringify(String(address.port))}`,
      `CLAUDENEST_TOKEN_FILE=${JSON.stringify(customTokenPath)}`,
      `CLAUDENEST_RELEASE_PATH=${JSON.stringify(oldRelease)}`,
      `CLAUDENEST_RUNNER_PATH=${JSON.stringify(join(oldRelease, "apps/claude-server/dist/runner-main.js"))}`,
    ].join("\n") + "\n",
    { mode: 0o600 },
  );
  cleanup.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH || ""}`,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    FAKE_COMMANDS_PATH: commandsPath,
    FAKE_STATE_PATH: statePath,
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    http_proxy: "",
    https_proxy: "",
    all_proxy: "",
    NO_PROXY: "127.0.0.1,localhost",
    NODE_USE_ENV_PROXY: "0",
  };
  async function run(command: string, args: string[] = [], overrides: NodeJS.ProcessEnv = {}) {
    try {
      const result = await exec(process.execPath, [manageScript, command, ...args], {
        env: { ...env, ...overrides },
        timeout: 10_000,
      });
      return { ...result, code: 0 };
    } catch (error) {
      const result = error as Error & { code: number; stdout: string; stderr: string };
      return { code: result.code, stdout: result.stdout, stderr: result.stderr };
    }
  }
  async function commands(): Promise<string[][]> {
    try {
      return (await readFile(commandsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  return {
    configRoot,
    dataRoot,
    envPath,
    oldRelease,
    nextRelease,
    requests,
    run,
    commands,
    reject: () => {
      rejectCompatibility = true;
    },
  };
}

describe("ClaudeNest release management", () => {
  it("leaves current release and environment untouched when live runner compatibility is refused", async () => {
    const test = await fixture();
    const before = await readFile(test.envPath, "utf8");
    await writeFile(
      join(test.nextRelease, "apps/claude-server/runner-protocol.json"),
      JSON.stringify({ supportedRunnerProtocols: [2] }),
    );
    test.reject();
    const result = await test.run("update", ["--release", test.nextRelease]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Target cannot recover live runner protocol");
    expect(await realpath(join(test.dataRoot, "current"))).toBe(test.oldRelease);
    expect(await readFile(test.envPath, "utf8")).toBe(before);
    expect(await test.commands()).toEqual([]);
    expect(test.requests[0]?.body).toEqual({ supportedRunnerProtocols: [2] });
  });

  it("restores the old API release after a failed target restart without contacting the unavailable API", async () => {
    const test = await fixture();
    const result = await test.run("update", ["--release", test.nextRelease], {
      FAKE_RESTART_FAIL: "1",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("previous API release restored");
    expect(await realpath(join(test.dataRoot, "current"))).toBe(test.oldRelease);
    const env = await readFile(test.envPath, "utf8");
    expect(env).toContain(`CLAUDENEST_RELEASE_PATH=${JSON.stringify(test.oldRelease)}`);
    expect(env).toContain('CLAUDENEST_START_PAUSED="0"');
    expect(await test.commands()).toEqual([
      ["--user", "daemon-reload"],
      ["--user", "restart", "claudenest.service"],
      ["--user", "stop", "claudenest.service"],
      ["--user", "start", "claudenest.service"],
    ]);
    expect(test.requests.filter((request) => !request.available)).toEqual([]);
    expect(test.requests.map((request) => request.route)).toEqual([
      "internal/restart/prepare",
      "health",
      "internal/restart/prepare",
      "internal/restart/resume",
    ]);
  });

  it("refuses setup against an active service without changing its release or environment", async () => {
    const test = await fixture();
    const before = await readFile(test.envPath, "utf8");
    const result = await test.run("setup", ["--release", test.nextRelease], {
      FAKE_SERVICE_STATE: "active",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("already running");
    expect(await realpath(join(test.dataRoot, "current"))).toBe(test.oldRelease);
    expect(await readFile(test.envPath, "utf8")).toBe(before);
    expect((await test.commands()).every((args) => args.includes("show"))).toBe(true);
    expect(test.requests).toEqual([]);
  });

  it("authenticates status using the configured custom token file", async () => {
    const test = await fixture();
    const result = await test.run("status");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      releasePath: test.oldRelease,
      recoveryState: "ready",
    });
    expect(test.requests.map((request) => request.route)).toEqual(["health"]);
    expect(await test.commands()).toEqual([]);
  });

  it("starts a compatible new API paused and resumes it only after readiness and rollback compatibility checks", async () => {
    const test = await fixture();
    const result = await test.run("update", ["--release", test.nextRelease]);
    expect(result.code).toBe(0);
    expect(await realpath(join(test.dataRoot, "current"))).toBe(test.nextRelease);
    expect(await readFile(test.envPath, "utf8")).toContain('CLAUDENEST_START_PAUSED="0"');
    expect(test.requests.map((request) => request.route)).toEqual([
      "internal/restart/prepare",
      "health",
      "internal/restart/prepare",
      "internal/restart/resume",
    ]);
    expect(await test.commands()).toEqual([
      ["--user", "daemon-reload"],
      ["--user", "restart", "claudenest.service"],
    ]);
  });
});
