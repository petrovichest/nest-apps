# ClaudeNest backend prototype

Independent Linux backend for the installed Claude Code CLI. This milestone has
no frontend or Android package. It does not modify the existing CodexNest server,
installation, configuration, token, data, or systemd services.

Requirements: Node 24, a systemd user manager with linger, and an installed Claude
CLI signed in using its own normal login. Tested protocol baseline: Claude 2.1.289.
No Agent SDK, ACP adapter, API-key injection, or alternative auth implementation
is used. The CLI loads its normal project/user configuration and CLAUDE.md.

## Build and install locally

Build a detached, immutable Git worktree containing the committed implementation:

```sh
git worktree add --detach ~/.local/share/claudenest/releases/COMMIT COMMIT
cd ~/.local/share/claudenest/releases/COMMIT
npm ci --include=dev
npm run build -w @claudenest/server
node apps/claude-server/scripts/manage.mjs setup --release "$PWD" --start
```

Use Git commit/push/pull for deployment to another host. Configure proxy settings
in the new private `~/.config/claudenest/server.env`, or export them before setup.
Setup captures proxy variables without printing their values. No Codex environment
file is modified. Login credentials remain in Claude's native config directory.
The bearer token is stored in `~/.config/claudenest/token` with mode 0600 and is
never printed. Default API address: `http://127.0.0.1:4311`.

For development, after configuration, use `npm run dev:claude`; `npm run dev`
continues to run the existing Codex development server/client. `npm run dev:all`
starts both development stacks. An installed CodexNest already listening on 4310
must not be started a second time; run only the Claude command in that case.

## Ownership and updates

Each native session gets its own `claudenest-session-UUID.service`, Unix socket,
and process that owns Claude stdin/stdout. Restarting/stopping `claudenest.service`
only disconnects the API. Session processes continue reading output and retaining
pending approvals/questions. Reconnection supplies an owner identity, snapshot,
stream position, and replay; expired replay cursors receive a full resync.

```sh
node apps/claude-server/scripts/manage.mjs status
node apps/claude-server/scripts/manage.mjs restart
node apps/claude-server/scripts/manage.mjs update --release /absolute/new/release
npm run smoke -w @claudenest/server
```

Build the new detached Git release before update. Update checks all live runner
protocols, changes only the API release, and keeps old session processes/resources.
Do not edit, rebuild, remove, or prune releases used by live runners. Old sessions
keep the old code; new sessions use the new release. Protocol v1 compatibility is
required for updates and rollback. Incompatible updates are rejected.

Runner processes are not evicted automatically in this prototype. Explicit release
is allowed only when no work or permission is pending. Owner/host crashes do not
replay commands automatically: continue native history explicitly with a new
message ID. An acceptance receipt records command admission, not exactly-once
external tool execution or guaranteed native persistence before a crash.

## API

All HTTP calls require `Authorization: Bearer TOKEN`. Cross-origin requests are
rejected unless their Origin is listed in `CLAUDENEST_ALLOWED_ORIGINS`. Keep access
local or on the owner's trusted private network, as with CodexNest.

- `GET /api/v1/health`: readiness, API release, runner protocol.
- `GET /api/v1/sessions?cwd=...`: native CLI history plus managed runtime state.
- `GET /api/v1/sessions/:id/history`: native messages; no history database/copy.
- `GET /api/v1/sessions/:id/snapshot`: live owner, native events, requests, receipts.
- `POST /api/v1/sessions`: `{sessionId, requestId, cwd, prompt, model?}`. UUIDs
  must be generated before sending and retained when retrying. Mode is manual.
- `POST /api/v1/sessions/:id/messages`: `{requestId, prompt}`. Explicitly resumes
  inactive native history, including terminal-created sessions. External live
  sessions are not taken over; ambiguous ownership is reported as a conflict.
- `POST /api/v1/sessions/:id/interrupt`: `{requestId}`.
- `POST /api/v1/requests/:id/responses`: `{sessionId, requestId, response}` where
  response is `{behavior:"allow",updatedInput:{...}}` or
  `{behavior:"deny",message:"..."}`. AskUserQuestion answers go into updatedInput.
- `POST /api/v1/sessions/:id/release`: release an idle runner.
- `POST /api/v1/internal/restart/prepare`: `{supportedRunnerProtocols:[1]}`.
  Pauses new admission, drains short operations, validates owners; never waits for
  model turns or unanswered permissions. `.../resume` cancels preparation.

WebSocket `/api/v1/events`: first send `{type:"authenticate",token}`, then
`{type:"subscribe",sessionId,afterSequence?,runnerInstanceId?}`. Messages include
snapshots and events with `sessionId`, `runnerInstanceId`, `sequence`, `kind`, and
`data`. Persist both owner identity and sequence for replay; discard the old cursor
when owner identity changes. On `claudenest_history_required` fetch native history.
Slow connections are closed for reconnect/resync rather than buffering forever.

## Verification

`npm test -w @claudenest/server`, `npm run typecheck -w @claudenest/server`,
and `npm run build -w @claudenest/server` verify transport, native-history parsing,
socket replay, approvals, admission races, uncertain sends, and restart recovery.
The smoke script makes one small real subscription request in a scratch directory.
`npm run smoke:systemd -w @claudenest/server` runs an isolated deterministic CLI
fixture through real systemd services and checks owner/CLI PIDs, pending approvals,
completion during API downtime, new-release launch, rollback, and native history.
No existing CodexNest process needs to be restarted for any of these checks.
