import type { CapacitorConfig } from "@capacitor/cli";

const provider = process.env.NEST_APP_PROVIDER ?? "codex";
if (provider !== "codex" && provider !== "claude") {
  throw new Error("NEST_APP_PROVIDER must be codex or claude");
}
const claude = provider === "claude";

const config: CapacitorConfig = {
  appId: claude ? "com.claudenest.app" : "com.codexnest.app",
  appName: claude ? "ClaudeNest" : "CodexNest",
  webDir: claude ? "dist-claude" : "dist",
  server: {
    androidScheme: "http",
    hostname: "localhost",
  },
  android: {
    minWebViewVersion: 83,
  },
};

export default config;
