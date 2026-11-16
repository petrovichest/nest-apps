/** Public connection state; provider keys and native server credentials never leave the host. */
export type OpenConnectionStatus = {
  runtime: "ready" | "unavailable";
  runtimeVersion: string | null;
  provider: "openrouter";
  apiKeyConfigured: boolean;
  message: string | null;
};

export type UpdateOpenConnectionRequest = { apiKey: string };

export type OpenProxyStatus = {
  configured: boolean;
  address: string | null;
  hasPassword: boolean;
};

export type UpdateOpenProxyRequest = { proxy: string | null };
export type OpenProxyTestResult = { ok: boolean; message: string };
