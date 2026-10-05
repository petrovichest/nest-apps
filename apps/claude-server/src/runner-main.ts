import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { SessionRunner } from "./runner.js";
import type { RunnerDescriptor } from "./types.js";

const execFileAsync = promisify(execFile);
const descriptorFlag = process.argv.indexOf("--descriptor");
const descriptorPath = descriptorFlag >= 0 ? process.argv[descriptorFlag + 1] : undefined;
if (!descriptorPath) throw new Error("Usage: runner-main --descriptor <descriptor.json>");
const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as RunnerDescriptor;
if (descriptor.protocolVersion !== 1) throw new Error("Unsupported runner protocol version");
const { stdout } = await execFileAsync(descriptor.claudeBin, ["--version"], {
  timeout: 10_000,
  maxBuffer: 64 * 1024,
});
const runner = new SessionRunner(descriptor, { claudeVersion: stdout.trim() });
await runner.start();
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void runner.close().then(
      () => process.exit(0),
      (error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      },
    );
  });
}
