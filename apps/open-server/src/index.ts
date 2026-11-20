import { loadConfig } from "./config";
import { Engine } from "./engine";
import { buildApp } from "./app";

const config = await loadConfig();
const app =
  process.env.OPENNEST_RUNTIME === "claude"
    ? await (await import("./claude-runtime")).startClaudeRuntime(config)
    : await startOpenCode();
async function startOpenCode() {
  const engine = new Engine(config);
  engine.on("storageError", () => process.stderr.write("OpenNest could not persist its state.\n"));
  await engine.initialize();
  return buildApp(engine);
}
await app.listen({ host: config.host, port: config.port });
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await app.close();
};
process.once("SIGINT", () => {
  void close();
});
process.once("SIGTERM", () => {
  void close();
});
