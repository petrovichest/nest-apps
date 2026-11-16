import { loadConfig } from "./config";
import { Engine } from "./engine";
import { buildApp } from "./app";

const config = await loadConfig();
const engine = new Engine(config);
engine.on("storageError", () => process.stderr.write("OpenNest could not persist its state.\n"));
await engine.initialize();
const app = await buildApp(engine);
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
