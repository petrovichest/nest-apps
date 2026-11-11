import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { request } from "node:http";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  symlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(process.env.CODEXNEST_ROOT || join(homedir(), ".local/share/codexnest"));
const recovery = join(root, "recovery");
const journalPath = join(recovery, "journal.json");
const configPath = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "codexnest/server.env",
);
const serviceDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd/user");
const stateDir = join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "codexnest");
const cli = join(homedir(), ".local/bin/codexnest");
const mode = process.argv[2];
const sha = (value) => createHash("sha256").update(value).digest("hex");
const ctl = async (...args) =>
  (await exec("systemctl", ["--user", ...args], { timeout: 80_000 })).stdout.trim();

async function atomic(path, value, permissions = 0o600) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", permissions);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function journal() {
  const metadata = await lstat(journalPath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!metadata) return null;
  assert.ok(metadata.isFile() && !metadata.isSymbolicLink());
  assert.equal(metadata.uid, process.getuid());
  assert.equal(metadata.mode & 0o077, 0);
  const value = JSON.parse(await readFile(journalPath, "utf8"));
  assert.equal(value.schemaVersion, 1);
  assert.ok(["clean", "pending", "restoring", "committed", "aborted"].includes(value.phase));
  return value;
}

const save = (value) => atomic(journalPath, `${JSON.stringify(value)}\n`);

async function release(path) {
  const directory = await realpath(path);
  assert.ok(directory.startsWith(`${root}/releases/`));
  const version = basename(directory).replace(/^v/, "");
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9a-f]{7})?$/);
  const commit = (await readFile(join(directory, ".codexnest-built"), "utf8")).trim();
  assert.match(commit, /^[0-9a-f]{40}$/);
  const protocol = JSON.parse(
    await readFile(join(directory, "deploy/restart-protocol.json"), "utf8"),
  );
  assert.equal(protocol.schemaVersion, 1);
  const protocolVersion =
    protocol.runtimeRecoveryProtocolVersion ?? protocol.recoveryProtocolVersion;
  assert.ok(Number.isInteger(protocolVersion) && protocolVersion >= 1);
  return {
    path: directory,
    version,
    commit,
    protocol: protocolVersion,
    admissionProtocolVersion: protocol.updateAdmissionProtocolVersion,
  };
}

async function version() {
  return (await readFile(configPath, "utf8")).match(/^CODEXNEST_VERSION=(.*)$/m)?.[1]?.trim();
}

// Built-in http.request ignores provider proxy environment variables. A restart
// token must only travel directly to the private loopback API.
function localApi(path, token, timeout = 3000) {
  return new Promise((resolveRequest, reject) => {
    const outgoing = request(
      {
        hostname: "127.0.0.1",
        port: 4310,
        path: `/api/v1${path}`,
        method: token ? "POST" : "GET",
        agent: false,
        headers: token ? { "X-CodexNest-Restart-Token": token } : {},
      },
      (incoming) => {
        incoming.on("error", reject);
        incoming.on("aborted", () => reject(new Error("Recovery response aborted")));
        let body = "";
        incoming.on("data", (data) => {
          body += data;
          if (body.length > 65_536) outgoing.destroy(new Error("Recovery response too large"));
        });
        incoming.on("end", () => {
          try {
            if (incoming.statusCode !== 200) throw new Error("Recovery API unavailable");
            resolveRequest(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    const timer = setTimeout(
      () => outgoing.destroy(new Error("Recovery API deadline exceeded")),
      timeout,
    );
    outgoing.once("close", () => clearTimeout(timer));
    outgoing.on("error", reject);
    outgoing.end();
  });
}

async function token() {
  const config = await readFile(configPath, "utf8");
  const path =
    config.match(/^CODEXNEST_RESTART_TOKEN_PATH=(.*)$/m)?.[1]?.trim() ||
    join(stateDir, "restart-token");
  const value = (await readFile(path, "utf8")).trim();
  assert.match(value, /^[0-9a-f]{64}$/);
  return value;
}

async function runningAt(info) {
  const pid = Number(await ctl("show", "codexnest.service", "-p", "MainPID", "--value"));
  if (pid <= 1) return false;
  return (await realpath(`/proc/${pid}/cwd`).catch(() => null)) === info.path;
}

async function healthy(info, timeout = 3000) {
  const health = await localApi("/health", undefined, timeout).catch(() => null);
  return (
    health?.status === "ok" &&
    health.serverVersion === info.version &&
    health.recoveryState === "ready" &&
    health.transport === "daemon" &&
    health.appServer?.state === "ready" &&
    health.restartProtocolVersion === info.protocol &&
    (info.admissionProtocolVersion === 1
      ? health.buildCommit === info.commit
      : health.buildCommit
        ? health.buildCommit === info.commit
        : await runningAt(info))
  );
}

async function nativeIdentity() {
  const paths = new Set([
    join(
      process.env.CODEX_HOME || join(homedir(), ".codex"),
      "app-server-control/app-server-control.sock",
    ),
  ]);
  const accounts = JSON.parse(
    await readFile(join(stateDir, "codex-accounts.json"), "utf8").catch((error) => {
      if (error.code === "ENOENT") return "{}";
      throw error;
    }),
  );
  for (const runtime of accounts.runtimes ?? []) paths.add(runtime.socketPath);
  const sockets = new Set(
    (await readFile("/proc/net/unix", "utf8")).split("\n").flatMap((line) => {
      const fields = line.trim().split(/\s+/);
      return paths.has(fields[7]) ? [`socket:[${fields[6]}]`] : [];
    }),
  );
  const identity = [];
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    const directory = join("/proc", pid);
    const metadata = await lstat(directory).catch(() => null);
    if (metadata?.uid !== process.getuid()) continue;
    const command = (await readFile(join(directory, "cmdline"), "utf8").catch(() => "")).split(
      "\0",
    );
    if (!command.includes("app-server") || command.includes("pid-update-loop")) continue;
    if (basename(await readlink(join(directory, "exe")).catch(() => "")) !== "codex") continue;
    const descriptors = await readdir(join(directory, "fd")).catch(() => []);
    const owns = await Promise.all(
      descriptors.map((fd) => readlink(join(directory, "fd", fd)).catch(() => null)),
    );
    if (!owns.some((fd) => sockets.has(fd))) continue;
    const stat = await readFile(join(directory, "stat"), "utf8");
    identity.push({
      pid: Number(pid),
      startTime: stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19],
    });
  }
  assert.ok(identity.length, "Original native daemon identity is unavailable");
  return identity;
}

async function surviving(value) {
  assert.ok(value.native?.length, "Native recovery identity is missing");
  for (const prior of value.native) {
    const stat = await readFile(`/proc/${prior.pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
    assert.notEqual(fields[0], "Z", "Original native daemon exited");
    assert.equal(fields[19], prior.startTime, "Original native daemon was replaced");
  }
}

async function waitHealthy(info, deadline, value) {
  while (Date.now() < deadline) {
    const ready = await healthy(info, Math.min(3000, Math.max(1, deadline - Date.now())));
    if (ready) {
      if (value.native) await surviving(value);
      assert.ok(Date.now() <= deadline, "Recovery readiness exceeded its deadline");
      return;
    }
    await delay(Math.min(250, Math.max(1, deadline - Date.now())));
  }
  throw new Error("Application did not prove readiness within the recovery budget");
}

async function statusFailed(message) {
  const path = join(stateDir, "update.json");
  const prior = JSON.parse(await readFile(path, "utf8").catch(() => "{}"));
  if (prior.operation === "idle" && ["failed", "rolled_back"].includes(prior.result)) return;
  await atomic(
    path,
    `${JSON.stringify({ ...prior, operation: "idle", result: "failed", message, updatedAt: new Date().toISOString() })}\n`,
  );
}

async function begin(target = null) {
  const baseline = await release(join(root, "current"));
  assert.equal(await version(), baseline.version);
  if (!(await healthy(baseline)))
    throw new Error("Restart preflight failed: the current application is unavailable");
  const prior = await journal();
  assert.notEqual(prior?.phase, "clean", "Initial installation is not confirmed yet");
  if (prior && ["pending", "restoring"].includes(prior.phase)) {
    assert.equal(prior.baseline.commit, baseline.commit, "Unfinished recovery must complete first");
    assert.equal(prior.phase, "pending");
  }
  if (prior?.phase === "pending" && prior.baseline.commit === baseline.commit) {
    if (target) {
      prior.target = target;
      await save(prior);
    }
    return;
  }
  await save({
    schemaVersion: 1,
    phase: "pending",
    preparedAt: Date.now(),
    activatedAt: null,
    baseline,
    baselineCliSha256: sha(await readFile(cli)),
    target,
    native: await nativeIdentity(),
  });
}

const unitArg = (value) =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;

async function install(fromBuild) {
  const cwd = await realpath(process.cwd());
  if (!cwd.startsWith(`${root}/releases/`)) return;
  const group = await readFile("/proc/self/cgroup", "utf8");
  if (fromBuild && !group.includes("/codexnest-update.service")) return;
  assert.equal((await lstat(root)).uid, process.getuid());
  await mkdir(recovery, { recursive: true, mode: 0o700 });
  await chmod(recovery, 0o700);
  if (!fromBuild && !(await journal())) {
    const current = await release(join(root, "current"));
    assert.equal(current.path, cwd);
    await save({
      schemaVersion: 1,
      phase: "clean",
      target: current,
      baseline: null,
      preparedAt: Date.now(),
    });
  }
  if (fromBuild) {
    const commit = (await exec("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
    assert.match(commit, /^[0-9a-f]{40}$/);
    const protocol = JSON.parse(await readFile(join(cwd, "deploy/restart-protocol.json"), "utf8"));
    await begin({
      path: cwd,
      commit,
      version: basename(cwd).replace(/^v/, ""),
      protocol: protocol.runtimeRecoveryProtocolVersion ?? protocol.recoveryProtocolVersion,
      admissionProtocolVersion: 1,
    });
  }
  await atomic(join(recovery, "guard.mjs"), await readFile(fileURLToPath(import.meta.url)), 0o700);
  const command = `${unitArg(process.execPath)} ${unitArg(join(recovery, "guard.mjs"))}`;
  for (const [unit, body] of [
    [
      "codexnest-update.service",
      `TimeoutStopSec=420s\nExecStartPre=${command} before-update\nExecStopPost=${command} after-update\n`,
    ],
    [
      "codexnest.service",
      `ExecStartPre=${command} before-app\nExecStartPost=${command} confirm-start\n`,
    ],
  ]) {
    const directory = join(serviceDir, `${unit}.d`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await atomic(join(directory, "10-update-recovery.conf"), `[Service]\n${body}`, 0o600);
  }
  await ctl("daemon-reload");
}

async function restoreFiles(value) {
  const baseline = await release(value.baseline.path);
  assert.equal(baseline.commit, value.baseline.commit);
  const current = await realpath(join(root, "current"));
  const modified =
    current !== baseline.path ||
    (await version()) !== baseline.version ||
    sha(await readFile(cli)) !== value.baselineCliSha256;
  if (!modified) return;
  const link = join(root, `.current.recovery-${randomUUID()}`);
  await symlink(baseline.path, link);
  await rename(link, join(root, "current"));
  const env = await readFile(configPath, "utf8");
  const setting = `CODEXNEST_VERSION=${baseline.version}`;
  await atomic(
    configPath,
    /^CODEXNEST_VERSION=/m.test(env)
      ? env.replace(/^CODEXNEST_VERSION=.*$/m, setting)
      : `${env}\n${setting}\n`,
  );
  await atomic(cli, await readFile(join(baseline.path, "deploy/codexnest")), 0o755);
  for (const [source, name] of [
    ["codexnest-managed.service", "codexnest.service"],
    ["codexnest-update.service", "codexnest-update.service"],
  ]) {
    await atomic(
      join(serviceDir, name),
      await readFile(join(baseline.path, "deploy/systemd", source)),
      0o644,
    );
  }
  // Retain a proved healthy rollback target, never the interrupted candidate.
  const previous = join(root, `.previous.recovery-${randomUUID()}`);
  await symlink(baseline.path, previous);
  await rename(previous, join(root, "previous"));
  await ctl("daemon-reload");
}

async function candidateMatches(value, current) {
  if (current.commit === value.baseline.commit) return false;
  assert.equal(current.admissionProtocolVersion, 1);
  assert.equal(current.protocol, value.baseline.protocol);
  if (!value.target) {
    const status = JSON.parse(await readFile(join(stateDir, "update.json"), "utf8"));
    if (status.latestVersion !== current.version) return false;
    value.target = current;
    await save(value);
  }
  return ["commit", "path", "version", "protocol", "admissionProtocolVersion"].every(
    (key) => value.target[key] === current[key],
  );
}

async function afterUpdate() {
  const value = await journal();
  if (!value || ["clean", "committed", "aborted"].includes(value.phase)) return;
  const current = await release(join(root, "current"));
  const matches = await candidateMatches(value, current);
  const status = JSON.parse(
    await readFile(join(stateDir, "update.json"), "utf8").catch(() => "{}"),
  );
  if (
    matches &&
    status.operation === "idle" &&
    status.result === "updated" &&
    (await version()) === current.version &&
    (await healthy(current))
  ) {
    await surviving(value);
    value.phase = "committed";
    value.confirmedAt = Date.now();
    await save(value);
    return;
  }
  value.activatedAt ??= Date.now();
  const deadline = value.activatedAt + 420_000;
  value.phase = "restoring";
  await save(value);
  const health = await localApi("/health").catch(() => null);
  if (health && health.serverVersion !== value.baseline.version) {
    const prepared = await token()
      .then((secret) => localApi("/internal/restart/prepare", secret, 75_000))
      .catch(() => null);
    if (
      prepared &&
      !(
        prepared.transport === "daemon" &&
        prepared.appServerReady === true &&
        prepared.restartProtocolVersion === value.baseline.protocol
      ) &&
      !prepared.quiescent
    ) {
      throw new Error("Recovery refused: target cannot safely resume current work");
    }
  }
  await restoreFiles(value);
  if (await runningAt(value.baseline)) {
    await token()
      .then((secret) => localApi("/internal/restart/resume", secret, 10_000))
      .catch(() => undefined);
  } else {
    // ExecStartPre only repairs/checks files. It never waits for this process or
    // recursively restarts its own service, so there is no shared-lock deadlock.
    assert.ok(Date.now() < deadline, "Recovery restart budget exhausted");
    await exec("systemctl", ["--user", "restart", "codexnest.service"], {
      timeout: deadline - Date.now(),
    });
  }
  await waitHealthy(value.baseline, deadline, value);
  value.phase = "aborted";
  value.recoveredAt = Date.now();
  await save(value);
  await statusFailed("CodexNest update was interrupted; the healthy previous release was restored");
}

async function confirmStart() {
  const value = await journal();
  if (!["clean", "restoring"].includes(value?.phase)) return;
  const current = await release(join(root, "current"));
  if (value.phase === "clean") {
    assert.equal(current.commit, value.target.commit);
    await waitHealthy(current, Date.now() + 60_000, value);
    value.phase = "committed";
    value.confirmedAt = Date.now();
    value.baseline = current;
    value.baselineCliSha256 = sha(await readFile(cli));
    await save(value);
    return;
  }
  assert.equal(current.commit, value.baseline.commit);
  const deadline = Math.min(Date.now() + 60_000, value.activatedAt + 420_000);
  await waitHealthy(current, deadline, value);
  value.phase = "aborted";
  value.recoveredAt = Date.now();
  await save(value);
  await statusFailed("CodexNest update was interrupted; the healthy previous release was restored");
}

async function beforeApp() {
  const value = await journal();
  assert.ok(value, "The managed update recovery journal is missing");
  const busy = ["active", "activating", "deactivating", "reloading"].includes(
    await ctl("show", "codexnest-update.service", "-p", "ActiveState", "--value"),
  );
  if (value && ["pending", "restoring"].includes(value.phase) && !busy) {
    value.phase = "restoring";
    value.activatedAt ??= Date.now();
    await save(value);
    await restoreFiles(value);
    // Marking ready is left to after-update or the actual application; file
    // repair alone never becomes an assertion that runtime recovery succeeded.
  }
  const current = await release(join(root, "current"));
  assert.equal(await version(), current.version, "Refusing a mixed release/version pair");
  if (value?.phase === "pending" && current.commit !== value.baseline.commit) {
    assert.ok(await candidateMatches(value, current), "Refusing an unexpected candidate build");
  }
  if (["committed", "aborted"].includes(value.phase)) {
    assert.ok(
      current.commit === value.baseline?.commit ||
        (value.phase === "committed" && current.commit === value.target?.commit),
      "Release does not match the confirmed update journal",
    );
  }
  if (value.phase === "clean") {
    assert.equal(current.commit, value.target.commit);
  }
  if (
    value?.phase === "pending" &&
    current.commit !== value.baseline.commit &&
    !value.activatedAt
  ) {
    value.activatedAt = Date.now();
    await save(value);
  }
}

try {
  if (mode === "install-from-build") await install(true);
  else if (mode === "install-clean") await install(false);
  else {
    const group = await readFile("/proc/self/cgroup", "utf8");
    assert.ok(
      group.includes(
        ["before-app", "confirm-start"].includes(mode)
          ? "/codexnest.service"
          : "/codexnest-update.service",
      ),
    );
    if (mode === "before-update") await begin();
    else if (mode === "after-update") await afterUpdate();
    else if (mode === "before-app") await beforeApp();
    else if (mode === "confirm-start") await confirmStart();
    else throw new Error("Unknown recovery mode");
  }
} catch (error) {
  process.stderr.write(`CodexNest recovery guard failed (${mode}: ${error.code || error.name})\n`);
  if (["before-update", "after-update"].includes(mode))
    await statusFailed(
      "CodexNest recovery/preflight failed; the recorded healthy release is retained",
    ).catch(() => undefined);
  process.exitCode = 1;
}
