import type { CodexRateLimitsState } from "./index.js";

export type CodexAccount = {
  id: string;
  email: string | null;
  plan: string | null;
  authenticated: boolean;
  rateLimits: CodexRateLimitsState;
  connectionError: string | null;
};

export type CodexAccountsStatus = {
  currentAccountId: string | null;
  accounts: CodexAccount[];
};

export type CodexLoginStatus = {
  id: string;
  state: "starting" | "waiting" | "checking" | "completed" | "failed" | "cancelled";
  url: string | null;
  userCode: string | null;
  accountId: string | null;
  error: string | null;
};
