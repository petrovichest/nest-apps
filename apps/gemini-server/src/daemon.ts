import { chmod, lstat, unlink } from "node:fs/promises";
import { connect } from "node:net";
import { loadConfig } from "./config";
import { Engine } from "./engine";
import { buildApp } from "./app";

const config = await loadConfig();
const engine = new Engine(config);
await engine.initialize();
const app = await buildApp(engine);
if (process.argv.includes("--tcp")) await app.listen({ host: config.host, port: config.port });
else {
  if (
    await lstat(config.socket).then(
      () => true,
      () => false,
    )
  ) {
    const live = await new Promise<boolean>((resolve) => {
      const socket = connect(config.socket);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (live) throw new Error("A GeminiNest daemon already owns this socket");
    await unlink(config.socket);
  }
  await app.listen({ path: config.socket });
  await chmod(config.socket, 0o600);
}
engine.on("storageError", () => process.stderr.write("GeminiNest could not persist its state.\n"));
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await app.close();
  await engine.close();
  process.exit(0);
};
process.on("SIGTERM", () => {
  void stop();
});
process.on("SIGINT", () => {
  void stop();
});
