import { buildApp } from "./app";
import { loadConfig } from "./config";
import { SessionManager } from "./manager";

const config = await loadConfig();
const manager = new SessionManager(config);
await manager.initialize();
const app = await buildApp(manager);
await app.listen({ host: config.host, port: config.port });
process.stdout.write(`ClaudeNest prototype listening on ${config.host}:${config.port}\n`);
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await app.close();
};
process.once("SIGTERM", () => {
  void shutdown().then(() => process.exit(0));
});
process.once("SIGINT", () => {
  void shutdown().then(() => process.exit(0));
});
