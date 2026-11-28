// Runs inside the Antigravity network namespace. Its loopback listener has just
// one upstream, the daemon's Unix socket for the account's configured proxy.
import { spawn } from "node:child_process";
import { connect, createServer } from "node:net";

const [socket, port, command, ...args] = process.argv.slice(2);
const relay = createServer((client) => {
  const upstream = connect(socket);
  client.once("close", () => upstream.destroy());
  upstream.once("close", () => client.destroy());
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.pipe(upstream).pipe(client);
});
relay.on("error", () => process.exit(1));
relay.listen(Number(port), "127.0.0.1", () => {
  const child = spawn(command, args, { stdio: "inherit" });
  child.once("error", () => process.exit(1));
  child.once("exit", (code) => process.exit(code ?? 1));
});
