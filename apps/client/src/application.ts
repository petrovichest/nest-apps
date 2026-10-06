import type { AppCapabilities, AppProvider } from "@codexnest/protocol";

const provider: AppProvider = import.meta.env.VITE_APP_PROVIDER === "claude" ? "claude" : "codex";
const isClaude = provider === "claude";
export const application = {
  provider,
  isClaude,
  name: isClaude ? "ClaudeNest" : "CodexNest",
  agentName: isClaude ? "Claude" : "Codex",
  storagePrefix: isClaude ? "claudenest" : "codexnest",
  eventsPath: isClaude ? "/api/v1/ui/events" : "/api/v1/events",
  capabilities: {
    codexManagement: !isClaude,
    rateLimits: true,
    plan: true,
    team: !isClaude,
    goal: !isClaude,
    forks: !isClaude,
    browserIntegration: !isClaude,
    fullTextSearch: !isClaude,
    sessionApprovalGrants: !isClaude,
    skills: !isClaude,
    gitChanges: !isClaude,
    artifacts: !isClaude,
    appUpdates: true,
    reasoningEffort: true,
  } satisfies AppCapabilities,
};

/** Translate product labels without touching user or assistant content. */
export function applicationText(text: string): string {
  return application.isClaude
    ? text.replace(/\bCodexNest\b/g, "ClaudeNest").replace(/\bCodex\b/g, "Claude")
    : text;
}
