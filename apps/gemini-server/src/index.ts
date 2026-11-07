import { loadConfig } from "./config";
import { createGateway } from "./gateway";

const config = await loadConfig();
const gateway = createGateway(config.socket);
gateway.server.listen(config.port, config.host);
const stop = () => {
  void gateway.close().then(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
