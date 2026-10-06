import { buildApp } from "./app";
import { loadConfig } from "./config";
import { SessionManager } from "./manager";
import { UiService } from "./ui-service";
import { ClaudeAccounts } from "./accounts";

const config = await loadConfig();
const accounts = new ClaudeAccounts(config);
await accounts.initialize();
const manager = new SessionManager(config, undefined, accounts);
await manager.initialize();
const ui = new UiService(manager);
await ui.initialize();
const app = await buildApp(manager, ui);
await app.listen({ host: config.host, port: config.port });
process.stdout.write(`ClaudeNest listening on ${config.host}:${config.port}\n`);
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
