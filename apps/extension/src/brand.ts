declare const __APP_NAME__: string | undefined;

/** The application this build talks to; Vite defines it per build mode. */
export const appName = typeof __APP_NAME__ === "string" ? __APP_NAME__ : "CodexNest";

export const defaultBaseUrl =
  appName === "ClaudeNest" ? "http://127.0.0.1:4311" : "http://127.0.0.1:4310";
