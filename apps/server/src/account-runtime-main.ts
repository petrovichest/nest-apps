import { spawn, execFile } from "node:child_process";
import { stat, mkdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createAccountProxyConnection } from "./account-proxy";
import {
  readPrivateJson,
  writePrivateJson,
  type AccountRuntimeDescriptor,
  type AccountRuntimeState,
} from "./account-runtime";
import { renderProxyEnvironment } from "./codex-management";
import { childProcessEnvironment } from "./config";

const flag = process.argv.indexOf("--descriptor");
const path = flag < 0 ? undefined : process.argv[flag + 1];
if (!path) throw new Error("Account runtime descriptor is required");
const descriptor = await readPrivateJson<AccountRuntimeDescriptor>(path);
if (
  !descriptor ||
  descriptor.version !== 1 ||
  !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(descriptor.id)
)
  throw new Error("Account runtime descriptor is invalid");
process.umask(0o077);
const statePath = join(descriptor.directory, "runtime.json");
const state: AccountRuntimeState = {
  id: descriptor.id,
  fingerprint: descriptor.fingerprint,
  state: "starting",
  cliVersion: null,
  pid: process.pid,
};
await writePrivateJson(statePath, state);
await mkdir(descriptor.home, { recursive: true, mode: 0o700 });
await mkdir(join(descriptor.historyHome, "sessions"), { recursive: true, mode: 0o700 });
await mkdir(join(descriptor.historyHome, "archived_sessions"), { recursive: true, mode: 0o700 });
if (resolve(descriptor.home) !== resolve(descriptor.historyHome)) {
  // Share native histories/indexes, not credentials. No copy or rewrite of conversation data.
  for (const name of [
    "sessions",
    "archived_sessions",
    "config.toml",
    "skills",
    "plugins",
    "prompts",
  ]) {
    const source = join(descriptor.historyHome, name);
    try {
      await symlink(source, join(descriptor.home, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (resolve(await readlink(join(descriptor.home, name))) !== resolve(source))
        throw new Error("Account history link is inconsistent", { cause: error });
    }
  }
}
const connection = await createAccountProxyConnection(
  descriptor.proxy,
  descriptor.environment ?? childProcessEnvironment(),
);
const envPath = join(descriptor.directory, "proxy.env");
await writeFile(envPath, renderProxyEnvironment(connection.url), { mode: 0o600 });
const env: NodeJS.ProcessEnv = {
  ...connection.env,
  CODEX_HOME: descriptor.home,
  CODEXNEST_CODEX_PROXY_ENV_FILE: envPath,
};
delete env.CODEXNEST_STT_OPENAI_API_KEY;
delete env.OPENAI_API_KEY;
delete env.CODEX_API_KEY;
const exec = promisify(execFile);
try {
  const { stdout } = await exec(descriptor.codexBin, ["--version"], { env, timeout: 5_000 });
  state.cliVersion = /codex-cli\s+(\S+)/.exec(stdout)?.[1] ?? "unknown";
} catch {
  state.state = "failed";
  await writePrivateJson(statePath, state);
  await connection.close();
  process.exit(1);
}
const child = spawn(
  descriptor.codexBin,
  [
    "--enable",
    "respect_system_proxy",
    "-c",
    `sqlite_home=${JSON.stringify(descriptor.historyHome)}`,
    ...(descriptor.native ? [] : ["-c", 'cli_auth_credentials_store="file"']),
    ...(descriptor.nativeArgs ?? []),
    "app-server",
    "--listen",
    `unix://${descriptor.socketPath}`,
  ],
  { env, stdio: ["ignore", "ignore", "pipe"], cwd: descriptor.directory },
);
child.stderr?.resume();
let closing = false;
let forceStop: NodeJS.Timeout | undefined;
const stop = () => {
  if (closing) return;
  closing = true;
  child.kill("SIGTERM");
  forceStop = setTimeout(() => child.kill("SIGKILL"), 2_000);
  forceStop.unref();
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
child.once("close", async () => {
  clearTimeout(forceStop);
  state.state = "failed";
  await writePrivateJson(statePath, state).catch(() => undefined);
  await connection.close();
  await rm(descriptor.socketPath, { force: true }).catch(() => undefined);
  process.exit(closing ? 0 : 1);
});
child.once("error", () => {
  state.state = "failed";
});
const deadline = Date.now() + 10_000;
while (state.state !== "failed" && !closing) {
  try {
    if (!(await stat(descriptor.socketPath)).isSocket())
      throw new Error("Account transport is not a socket");
    state.state = "ready";
    break;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      stop();
      throw error;
    }
  }
  if (Date.now() >= deadline) {
    stop();
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}
await writePrivateJson(statePath, state);
