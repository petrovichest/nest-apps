import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Opt-in Linux integration: real independent systemd owners, a deterministic
// CLI fixture, and private temporary data. No existing app service is changed.
const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "cn-systemd-"));
const node = await realpath(process.execPath);
const token = randomBytes(32).toString("base64url");
const sessions = [];
const units = [];
let backend;
const envFile = join(directory, "server.env");
const releaseA = join(directory, "A"),
  releaseB = join(directory, "B");
const cwd = join(directory, "project");
const fakeCli = join(directory, "claude");
const listen = createServer();
await new Promise((resolve) => listen.listen(0, "127.0.0.1", resolve));
const port = listen.address().port;
await new Promise((resolve) => listen.close(resolve));

async function api(path, body, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || "Smoke API failed");
  return result;
}
async function until(operation) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const value = await operation();
      if (value) return value;
    } catch {
      /* Startup/reconnect. */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Systemd smoke condition timed out");
}
async function start(target) {
  const values = {
    CLAUDENEST_SERVER_ENV_FILE: envFile,
    CLAUDENEST_RELEASE_PATH: target,
    CLAUDENEST_CLAUDE_BIN: fakeCli,
    CLAUDENEST_TOKEN_FILE: join(directory, "token"),
    CLAUDENEST_HOST: "127.0.0.1",
    CLAUDENEST_PORT: String(port),
    CLAUDENEST_STATE_DIR: join(directory, "state"),
    CLAUDENEST_RUNTIME_DIR: join(directory, "run"),
    CLAUDE_CONFIG_DIR: join(directory, "native"),
  };
  await writeFile(
    envFile,
    Object.entries(values)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n") + "\n",
    { mode: 0o600 },
  );
  backend = `claudenest-smoke-${randomUUID()}.service`;
  units.push(backend);
  await exec("systemd-run", [
    "--user",
    "--collect",
    "--quiet",
    "--service-type=exec",
    `--unit=${backend}`,
    `--property=EnvironmentFile=${envFile}`,
    "--property=UMask=0077",
    "--",
    node,
    join(target, "apps/claude-server/dist/index.js"),
  ]);
  await until(async () => (await api("health")).releasePath === target);
}
async function stop() {
  if (backend) {
    await exec("systemctl", ["--user", "stop", backend]);
    backend = undefined;
  }
}
async function create(prompt) {
  const sessionId = randomUUID();
  sessions.push(sessionId);
  await api("sessions", { sessionId, requestId: randomUUID(), cwd, prompt });
  return sessionId;
}
async function snapshot(id, state) {
  return until(async () => {
    const value = await api(`sessions/${id}/snapshot`);
    return value.state === state ? value : undefined;
  });
}
const fixture = `#!${node}
import { createInterface } from 'node:readline';
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv.includes('--version')) { console.log('fixture 1'); process.exit(0); }
if (process.argv.includes('agents')) { console.log('[]'); process.exit(0); }
const flag = process.argv.includes('--resume') ? '--resume' : '--session-id';
const sessionId = process.argv[process.argv.indexOf(flag)+1];
let active;
const output = value => process.stdout.write(JSON.stringify(value)+'\\n');
const nativeDir = join(process.env.CLAUDE_CONFIG_DIR,'projects','fixture');
mkdirSync(nativeDir,{recursive:true});
const history = value => appendFileSync(join(nativeDir,sessionId+'.jsonl'),JSON.stringify({...value,cwd:process.cwd(),sessionId})+'\\n');
function complete() {
  const event = {type:'assistant',message:{role:'assistant',content:[{type:'text',text:'fixture complete'}]}};
  history(event); output(event); output({type:'result',subtype:'success',result:'fixture complete'});
}
const input = createInterface({input:process.stdin});
input.on('line',line=>{
  const value=JSON.parse(line);
  if (value.type==='control_request') {
    output({type:'control_response',response:{subtype:'success',request_id:value.request_id,response:{}}});
    if(value.request.subtype==='interrupt') setTimeout(complete,20);
  } else if(value.type==='user') {
    active=value.uuid; history(value); output(value);
    if(value.message.content==='permission') output({type:'control_request',request_id:'permission-1',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'fixture'}}});
    else setTimeout(complete,500);
  } else if(value.type==='control_response') setTimeout(complete,500);
});
input.on('close',()=>process.exit(0));
`;
try {
  await exec("systemctl", ["--user", "show", "-p", "Version"]);
  await mkdir(cwd);
  await writeFile(join(directory, "token"), token, { mode: 0o600 });
  await writeFile(fakeCli, fixture, { mode: 0o700 });
  await writeFile(join(directory, "package.json"), '{"type":"module"}');
  for (const target of [releaseA, releaseB]) {
    await mkdir(join(target, "apps/claude-server/dist"), { recursive: true });
    await writeFile(join(target, "package.json"), '{"type":"module"}');
    await symlink(join(root, "node_modules"), join(target, "node_modules"));
    for (const name of ["index.js", "runner-main.js"])
      await copyFile(
        join(root, "apps/claude-server/dist", name),
        join(target, "apps/claude-server/dist", name),
      );
  }
  await start(releaseA);
  // Approval survival needs an explicit ask policy now that new installs default
  // to full access. This setting is persisted only in the private smoke state.
  const permissions = await api("settings/permissions", { preset: "ask" }, "PUT");
  assert.equal(permissions.preset, "ask");
  const id = await create("permission");
  const before = await snapshot(id, "waiting");
  assert.equal(before.pendingRequests.length, 1);
  assert.equal(before.permissionMode, "manual");
  assert.equal(before.capabilities.steer, true);
  assert.equal(before.capabilities.livePermissionMode, true);
  await api("internal/restart/prepare", { supportedRunnerProtocols: [1] });
  await stop();
  await start(releaseB);
  const after = await snapshot(id, "waiting");
  for (const key of ["runnerPid", "claudePid", "runnerInstanceId"])
    assert.equal(after[key], before[key]);
  assert.equal(after.releasePath, releaseA);
  assert.deepEqual(after.pendingRequests, before.pendingRequests);
  const response = {
    sessionId: id,
    requestId: randomUUID(),
    response: { behavior: "allow", updatedInput: { command: "fixture" } },
  };
  await api("requests/permission-1/responses", response);
  await stop();
  await new Promise((resolve) => setTimeout(resolve, 800));
  await start(releaseB);
  const finished = await snapshot(id, "idle");
  assert.equal(finished.claudePid, before.claudePid);
  assert.ok(finished.currentEvents.some((event) => event.type === "result"));
  const current = await create("complete");
  const newer = await snapshot(current, "idle");
  assert.equal(newer.releasePath, releaseB);
  await stop();
  await start(releaseA); // Compatible rollback retains both owners.
  assert.equal((await snapshot(current, "idle")).claudePid, newer.claudePid);
  assert.equal((await snapshot(id, "idle")).runnerPid, before.runnerPid);
  const native = await api(`sessions/${id}/history`);
  assert.equal(native.messages.filter((event) => event.type === "user").length, 1);
  for (const sessionId of sessions) await api(`sessions/${sessionId}/release`, {});
  process.stdout.write(
    "Systemd smoke passed: stable owner/CLI PIDs, pending approval, offline completion, new release, rollback, native history.\n",
  );
} finally {
  for (const unit of [...units, ...sessions.map((id) => `claudenest-session-${id}.service`)]) {
    await exec("systemctl", ["--user", "stop", unit]).catch(() => undefined);
  }
  await rm(directory, { recursive: true, force: true });
}
