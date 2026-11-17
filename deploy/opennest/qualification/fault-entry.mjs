import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Candidate fault injection lives outside the immutable release. The executable
// application/native services remain real; the healthy A path is never altered.
const directory = "/opennest-qualification-private";
const fault = JSON.parse(await readFile(join(directory, "fault.json"), "utf8"));
const candidate = (await readFile("/opennest-qualification-input/candidate-sha", "utf8")).trim();
if (process.env.OPENNEST_VERSION === `0.1.9-${candidate.slice(0, 7)}`) {
  await writeFile(join(directory, "candidate-entered"), String(Date.now()), { mode: 0o600 });
  if (fault.mode === "no-http") {
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  if (fault.mode === "slow-native") {
    const response = await fetch("http://127.0.0.1:9053/__qualification/hold", {
      method: "POST",
      headers: { authorization: `Bearer ${fault.controlToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("Native delay injection was not armed");
  }
  if (fault.mode === "rotated-auth") {
    const currentKey = "fixture-openrouter-key-rotated";
    const controlled = await fetch("http://127.0.0.1:9052/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        authKey: currentKey,
        acceptedAuthKeys: ["fixture-openrouter-key-1", currentKey],
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!controlled.ok) throw new Error("Controlled credential generation was not configured");
    const changed = await fetch("http://127.0.0.1:4097/auth/openrouter", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME || "opencode"}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`,
      },
      body: JSON.stringify({ type: "api", key: currentKey }),
      signal: AbortSignal.timeout(5000),
    });
    if (!changed.ok) throw new Error("Candidate native credential rotation failed");
    await writeFile(join(directory, "candidate-auth-rotated"), String(Date.now()), { mode: 0o600 });
  }
  if (fault.mode === "wrong-version" || fault.mode === "rotated-auth")
    process.env.OPENNEST_VERSION = "0.0.0-0000000";
  if (fault.mode === "native-auth")
    process.env.OPENNEST_NATIVE_PASSWORD = "invalid-isolated-qualification-credential";
  if (fault.mode === "no-token")
    process.env.OPENNEST_CONFIG_DIR = join(directory, "missing-owner-token");
} else await writeFile(join(directory, "baseline-entered"), String(Date.now()), { mode: 0o600 });
process.env.OPENNEST_NATIVE_URL = "http://127.0.0.1:9053";
await import(
  pathToFileURL(join(process.env.OPENNEST_RELEASE_PATH, "apps/open-server/dist/index.js")).href
);
