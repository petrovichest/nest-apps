import assert from "node:assert/strict";
import { appendFile, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

// Test-only observation. Never consume, replace or retry native response data.
const home = process.env.HOME;
assert.ok(home);
assert.equal(
  await readFile(join(home, ".opennest-qualification"), "utf8"),
  "OpenNest synthetic qualification fixture v1\n",
);
const privateRoot =
  home === "/home/opennest-qualification"
    ? "/opennest-qualification-private"
    : join(home, "private");
const tracePath = resolve(process.env.OPENNEST_QUALIFICATION_NATIVE_TRACE || "");
assert.equal(tracePath, join(privateRoot, "native-http-trace.log"));
assert.equal(await realpath(dirname(tracePath)), await realpath(privateRoot));
const originalFetch = globalThis.fetch;
let sequence = 0;
let unavailable = false;
const now = () => Number(process.hrtime.bigint()) / 1e6;
function record(value) {
  void appendFile(
    tracePath,
    JSON.stringify({ pid: process.pid, monotonicMs: now(), ...value }) + "\n",
    { mode: 0o600 },
  ).catch(() => {
    if (!unavailable) process.stderr.write("OpenNest qualification native trace is unavailable.\n");
    unavailable = true;
  });
}
function observed(input, options) {
  try {
    const url = new URL(typeof input === "object" && "url" in input ? input.url : input);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !["4097", "9053"].includes(url.port)
    )
      return null;
    const method = String(options?.method || input?.method || "GET").toUpperCase();
    return {
      requestId: ++sequence,
      method: /^[A-Z]{1,16}$/.test(method) ? method : "unknown",
      path: url.pathname,
    };
  } catch {
    return null;
  }
}
function errorName(error) {
  return ["AbortError", "TimeoutError", "TypeError", "Error"].includes(error?.name)
    ? error.name
    : "Error";
}
globalThis.fetch = async function (input, options) {
  const request = observed(input, options);
  if (!request) return Reflect.apply(originalFetch, this, [input, options]);
  const started = now();
  record({ ...request, phase: "request" });
  try {
    const response = await Reflect.apply(originalFetch, this, [input, options]);
    record({
      ...request,
      phase: "headers",
      status: response.status,
      durationMs: now() - started,
    });
    const originalText = response.text;
    Object.defineProperty(response, "text", {
      configurable: true,
      writable: true,
      async value(...args) {
        const bodyStarted = now();
        record({ ...request, phase: "body-text-start" });
        try {
          const text = await Reflect.apply(originalText, this, args);
          record({ ...request, phase: "body-text-end", durationMs: now() - bodyStarted });
          return text;
        } catch (error) {
          record({
            ...request,
            phase: "body-text-error",
            durationMs: now() - bodyStarted,
            error: errorName(error),
          });
          throw error;
        }
      },
    });
    return response;
  } catch (error) {
    record({
      ...request,
      phase: "fetch-error",
      durationMs: now() - started,
      error: errorName(error),
    });
    throw error;
  }
};
