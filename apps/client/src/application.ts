import type { AppCapabilities, AppProvider } from "@codexnest/protocol";

const provider: AppProvider =
  import.meta.env.VITE_APP_PROVIDER === "open"
    ? "open"
    : import.meta.env.VITE_APP_PROVIDER === "gemini"
      ? "gemini"
      : import.meta.env.VITE_APP_PROVIDER === "claude"
        ? "claude"
        : "codex";
const isOpen = provider === "open";
const isClaude = provider === "claude";
const isGemini = provider === "gemini";
const isCodex = provider === "codex";
export const application = {
  provider,
  isOpen,
  isClaude,
  isGemini,
  isCodex,
  supportsSteering: !isCodex,
  supportsKanban: true,
  name: isOpen ? "OpenNest" : isGemini ? "GeminiNest" : isClaude ? "ClaudeNest" : "CodexNest",
  agentName: isOpen ? "OpenCode" : isGemini ? "Gemini" : isClaude ? "Claude" : "Codex",
  storagePrefix: isOpen
    ? "opennest"
    : isGemini
      ? "gemininest"
      : isClaude
        ? "claudenest"
        : "codexnest",
  eventsPath: isCodex ? "/api/v1/events" : "/api/v1/ui/events",
  /** Codex takes `$name` anywhere in a message; Claude runs `/name` only at the very start. */
  skillPrefix: isCodex ? "$" : "/",
  capabilities: {
    codexManagement: isCodex,
    rateLimits: !isOpen,
    plan: !isGemini,
    team: isCodex || isOpen,
    goal: isCodex || isOpen,
    forks: isCodex || isOpen,
    browserIntegration: true,
    fullTextSearch: true,
    sessionApprovalGrants: true,
    skills: true,
    gitChanges: true,
    artifacts: !isClaude,
    appUpdates: true,
    reasoningEffort: true,
  } satisfies AppCapabilities,
};

/** Translate product labels without touching user or assistant content. */
export function applicationText(text: string): string {
  if (application.isOpen)
    return text
      .replace(/\b(?:CodexNest|ClaudeNest|GeminiNest)\b/g, "OpenNest")
      .replace(/\b(?:Codex|Claude|Gemini)\b/g, "OpenCode");
  if (application.isGemini)
    return text
      .replace(/\b(?:CodexNest|ClaudeNest)\b/g, "GeminiNest")
      .replace(/\b(?:Codex|Claude)\b/g, "Gemini");
  return application.isClaude
    ? text.replace(/\bCodexNest\b/g, "ClaudeNest").replace(/\bCodex\b/g, "Claude")
    : text;
}
