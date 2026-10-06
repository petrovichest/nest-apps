import type { CodexRateLimitsState } from "./index.js";

export type ClaudeProxyProtocol = "http" | "https" | "socks5";
export type ClaudeProxyInput = {
  enabled: boolean;
  protocol: ClaudeProxyProtocol;
  value: string;
};
export type ClaudeProxyStatus = {
  enabled: boolean;
  protocol: ClaudeProxyProtocol;
  host: string | null;
  port: number | null;
  username: string | null;
  hasPassword: boolean;
};
export type ClaudeAccount = {
  id: string;
  email: string | null;
  plan: string | null;
  authenticated: boolean;
  proxy: ClaudeProxyStatus;
  rateLimits: CodexRateLimitsState;
  connectionError: string | null;
};
export type ClaudeAccountsStatus = {
  cliVersion: string | null;
  autoSwitch: boolean;
  currentAccountId: string | null;
  accounts: ClaudeAccount[];
};
export type ClaudeLoginStatus = {
  id: string;
  state: "starting" | "waitingCode" | "checking" | "completed" | "failed" | "cancelled";
  url: string | null;
  accountId: string | null;
  error: string | null;
};
export type CreateClaudeLoginRequest = { proxy?: ClaudeProxyInput; accountId?: string };
export type UpdateClaudeAccountRequest = { proxy: ClaudeProxyInput };
export type ClaudeProxyTestResult = {
  ok: boolean;
  latencyMs: number | null;
  error: string | null;
  proxy: ClaudeProxyStatus;
};
