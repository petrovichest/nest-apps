import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const base = process.env.CLAUDENEST_URL || "http://127.0.0.1:4311";
const token = (
  await readFile(
    process.env.CLAUDENEST_TOKEN_FILE || join(homedir(), ".config/claudenest/token"),
    "utf8",
  )
).trim();
const cwd = await mkdtemp(join(tmpdir(), "claudenest-smoke-"));
const sessionId = randomUUID();
let released = false;
async function api(path, body) {
  const response = await fetch(`${base}/api/v1/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || "API request failed");
  return result;
}
try {
  await api("sessions", {
    sessionId,
    requestId: randomUUID(),
    cwd,
    prompt: "Reply with exactly CLAUDENEST_SMOKE_OK. Do not use any tools.",
  });
  let snapshot;
  for (let attempt = 0; attempt < 90; attempt++) {
    snapshot = await api(`sessions/${sessionId}/snapshot`);
    if (
      snapshot.state === "idle" &&
      snapshot.currentEvents.some((event) => event.type === "result")
    )
      break;
    if (snapshot.state === "failed")
      throw new Error("Claude failed; inspect this test session's native history");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (
    snapshot.state !== "idle" ||
    !snapshot.currentEvents.some(
      (event) =>
        ["assistant", "result"].includes(event.type) &&
        JSON.stringify(event).includes("CLAUDENEST_SMOKE_OK"),
    )
  )
    throw new Error("Expected Claude smoke response was not received");
  const history = await api(`sessions/${sessionId}/history`);
  if (!history.messages.length) throw new Error("Native history is empty");
  await api(`sessions/${sessionId}/release`, {});
  released = true;
  process.stdout.write(`Claude smoke passed: native session ${sessionId}.\n`);
} finally {
  if (!released) {
    try {
      let snapshot = await api(`sessions/${sessionId}/snapshot`);
      if (["running", "waiting"].includes(snapshot.state))
        await api(`sessions/${sessionId}/interrupt`, { requestId: randomUUID() });
      for (let attempt = 0; attempt < 20; attempt++) {
        snapshot = await api(`sessions/${sessionId}/snapshot`);
        if (["idle", "failed", "closed"].includes(snapshot.state)) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      await api(`sessions/${sessionId}/release`, {});
      released = true;
    } catch {
      /* Leave the scratch directory available to an unreconciled owner. */
    }
  }
  if (released) await rm(cwd, { recursive: true, force: true });
}
