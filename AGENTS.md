# CodexNest repository guidance

## Local instance updates

- The user updates the locally running CodexNest and ClaudeNest instances themselves through
  each application's update button. Agents must not update, reinstall, deploy to, or restart
  those instances.
- Agents publish changes only by committing and pushing to GitHub. This project-specific rule
  overrides general deployment authorization; pushing changes must not trigger a local update.

## Release safety: mandatory publication gate

- Before preparing or publishing a release, read and follow
  [docs/release-safety.md](docs/release-safety.md). These rules apply to rolling releases,
  versioned releases, hotfixes, and changes that appear unrelated to startup.
- A green build, unit tests, or the current `verify` job is not release qualification.
  Publication requires evidence for the exact candidate commit, supported native runtime
  versions, a representative large history, cold/warm startup, an upgrade from the last
  known healthy release, and an automatic rollback after deliberately failing the candidate.
- Run lifecycle tests only in an isolated installation with its own HOME, state, credentials,
  ports, service manager, and native daemon. Never use the user's running instances as a
  release test environment, copy their real credentials, or restart their daemon to make
  a candidate pass.
- A rollback passes only when the previous version actually becomes ready and resumes the
  tested work with intact state. Reverting a symlink or starting a process is insufficient.
  Test the same surviving daemon and the state/authentication left by the failed candidate.
- Missing, skipped, flaky, timed-out, or inconclusive mandatory checks block publication.
  Do not bypass branch protection, weaken health checks, increase timeouts without measured
  justification, or substitute mocked lifecycle tests for the native update/rollback test.
- Work on a non-publishing branch and use a PR with required checks for the exact commit.
  Do not push directly to `main` or create a release tag while the publication gate is unmet.
  In this repository even a documentation-only push to `main` currently publishes a release.
- The existing workflow does not yet enforce the complete gate in the linked policy.
  Until the gate is implemented and demonstrated, treat application publication as blocked;
  writing this policy does not make the current release process safe. Policy documentation
  may be committed and pushed on a non-publishing branch without publishing an application.
- Report code completion, CI results, candidate qualification, release publication, and
  installation health as separate facts. Never claim the user's application was updated
  or recovered without observing that specific result.

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
