/** The Google login remains owned by Antigravity CLI, including Ultra entitlements. */
export type GeminiConnectionStatus = {
  cliVersion: string | null;
  authenticated: boolean;
  proxy: { configured: boolean; address: string | null; hasPassword: boolean };
  login: GeminiLoginStatus | null;
};

export type GeminiLoginStatus = {
  id: string;
  state: "starting" | "awaiting_code" | "exchanging" | "completed" | "failed" | "cancelled";
  url: string | null;
  error: string | null;
};
