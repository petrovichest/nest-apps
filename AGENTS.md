# CodexNest repository guidance

## Local instance updates

- The user updates the locally running CodexNest and ClaudeNest instances themselves through
  each application's update button. Agents must not update, reinstall, deploy to, or restart
  those instances.
- Agents publish changes only by committing and pushing to GitHub. This project-specific rule
  overrides general deployment authorization; pushing changes must not trigger a local update.

## Team orchestration

- CodexNest Team mode is an application-owned managed orchestration mechanism implemented in this
  repository. It is not Codex's native multi-agent or subagent mode.
- Team delegation must use the `codexnest` managed-task dynamic tools and the persisted
  `teamOrchestration` state. Do not route Team work through Codex's native subagent tools.
- Do not use Codex product documentation as the source of truth for Team behavior; this mechanism
  exists only in CodexNest. Read the local implementation, tests, and orchestration notes instead.
  Consult Codex documentation only when an underlying app-server protocol or configuration detail
  itself needs verification.
- Preserve the boundary between these mechanisms. Team parent and managed child sessions disable
  native agent tools as runtime isolation; native subagent support elsewhere in the projection is
  not the implementation of Team mode.
