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
- PRs and independent approvals are optional in this single-account repository. Do not
  impose them as a requirement. Verify the exact commit on a non-publishing branch, then
  a normal fast-forward push to `main` is allowed after the required `verify` check passes.
  Saving source on `main` does not qualify an application release. Keep the CI publication
  gate closed until qualification succeeds; do not create a release tag to bypass it.
- The workflow accepts only the complete successful manual native matrix for the exact
  candidate SHA, including the validated qualification artifact and unchanged healthy
  baseline. Until that matrix passes, application publication remains blocked. Neither
  policy documentation nor the presence of the harness qualifies a candidate.
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
