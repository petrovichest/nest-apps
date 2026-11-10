import type { CodexRateLimitsState } from "./index.js";
import type { ClaudeProxyInput, ClaudeProxyStatus } from "./claude-accounts.js";

export type CodexAccount = {
  id: string;
  email: string | null;
  plan: string | null;
  authenticated: boolean;
  proxy: ClaudeProxyStatus;
  rateLimits: CodexRateLimitsState;
  connectionError: string | null;
};

export type CodexAccountsStatus = {
  cliVersion: string | null;
  autoSwitch: boolean;
  warmLimits: boolean;
  currentAccountId: string | null;
  accounts: CodexAccount[];
};

export type CreateCodexLoginRequest = { accountId?: string; proxy?: ClaudeProxyInput };

export type CodexLoginStatus = {
  id: string;
  state: "starting" | "waiting" | "checking" | "completed" | "failed" | "cancelled";
  url: string | null;
  userCode: string | null;
  accountId: string | null;
  error: string | null;
};
