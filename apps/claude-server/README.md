# ClaudeNest

Independent Linux backend for the installed Claude Code CLI, with the existing
Nest frontend built as a separate browser/PWA application. Codex remains the
default build. Claude has its own icon, install identity, credentials, browser
storage, backend, systemd services and metadata. There is no Claude Android APK
in this milestone.

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
npm run build:claude
node apps/claude-server/scripts/manage.mjs setup --release "$PWD" --start
```

Use Git commit/push/pull for deployment to another host. Configure proxy settings
in the new private `~/.config/claudenest/server.env`, or export them before setup.
Setup captures proxy variables without printing their values. No Codex environment
file is modified. Login credentials remain in Claude's native config directory.
The bearer token is stored in `~/.config/claudenest/token` with mode 0600 and is
never printed. Default API address: `http://127.0.0.1:4311`.

For development, after configuration, use `npm run dev:claude` (API 4311 and UI
5174); `npm run dev` / `npm run dev:codex` continue to run Codex (4310 and 5173).
`npm run dev:all` starts both development stacks. When an installed API already
owns a port, use `npm run dev:claude:client` for just the Claude UI, or stop only
that application's own development API before launching its development stack.
Do not launch the Codex development stack over an installed Codex instance.

## Browser features and local LAN hosting

The compatibility API `/api/v1/threads`, `/projects`, `/attention`, `/settings`
and global WebSocket `/api/v1/ui/events` reuse the same App, ThreadPage, Composer
and SettingsPage as Codex. It supports project folders, native Claude sessions,
streaming text and thinking, tools, permissions, AskUserQuestion, model selection,
drafts, durable FIFO messages, file/image attachments, pin/archive/read state and
title search. Model choices come from CLI initialization. Effort is a launch
setting; model changes require an idle compatible owner. Permission presets apply
to newly launched owners. Native history stays under Claude's config directory;
`ui.json` holds only Nest metadata, pending input and receipt identifiers.

Team, Plan, Goal, forks, Codex management, browser integration, artifacts and full
text history search are gated off in this milestone. Imported native sessions
resume with their original UUID; a session controlled by another live Claude
process cannot be taken over. Earlier prototype owners keep protocol v1 and text
chat; their missing attachment/control capabilities are reported explicitly.

The backend serves `apps/client/dist-claude` itself. Caddy proxies the whole host
to `127.0.0.1:4311`, so it needs no access to a user's private home directory.
Add `https://claude.home.arpa` to `CLAUDENEST_ALLOWED_ORIGINS` in Claude's own
private server.env. Point LAN DNS for that hostname at this machine.

The current home lab keeps its existing CA on `pi5@192.168.2.216`, under
`/home/pi5/certs`. Keep `local-root-ca.key` on that CA host. Copy only the existing
`home.arpa.crt` wildcard certificate, `home.arpa.key` service key and public
`local-root-ca.crt` to a private temporary directory on the service host, then:

```sh
sudo bash deploy/claudenest/install-lan.sh --certificate \
  /absolute/home.arpa.crt /absolute/home.arpa.key /absolute/local-root-ca.crt
```

The script checks the existing Codex certificate against that CA, verifies the
supplied certificate for `claude.home.arpa`, and checks its private key before
installing Claude's separate certificate files and vhost. Remove the temporary
service-key copy afterward; never commit it.

For deployments where the existing signing CA is already local, an administrator
can issue a new host certificate and install the isolated vhost:

```sh
sudo bash deploy/claudenest/install-lan.sh
```

The read-only discovery helper searches local certificate directories for a unique
matching CA/key pair and fails if unavailable or ambiguous. For another location or
an encrypted CA key, supply the two absolute paths explicitly as arguments.
The script verifies that the CA validates the existing Codex certificate,
adds only the Claude host, validates Caddy's full candidate configuration, keeps
a backup and reloads Caddy. Existing Codex blocks and its certificate remain intact.
It never restarts either Nest service. The CA private key must stay outside Git.

Open `https://claude.home.arpa`, enter the token stored in
`~/.config/claudenest/token` locally, and install the PWA from the browser.
Tokens are never included in frontend assets or printed by management scripts.

## Voice and attachments

Voice uses the already running local STT endpoint (default
`http://127.0.0.1:8178/inference`, Russian), with no second model/service. Optional
text cleanup runs the installed Claude CLI with no tools, hooks, MCP configuration
or session persistence, using the selected model (default `haiku`). Timeout or
cleanup failure retains the original transcript. Task voice jobs persist upload
and application state; restart/retry retains the same delivery ID and cancellation
prevents late application. Recordings are limited to 300 seconds and 24 MiB.
Question voice is transcribed into the editable answer before explicit response.

Uploaded files are private and scoped to their project/session; references are
validated before dispatch. Ordinary files are supplied as local paths. Images
become native CLI image blocks inside the runner, keeping base64 off control IPC.
Limits: 100 MiB per file, 250 MiB per message, 5 MiB per direct image, plus the
transport's aggregate native message limit. An upload never starts an agent.
The shared STT service and machine resources can increase latency in both apps
when they are busy simultaneously; neither instance is reconfigured by Claude.

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

All `/api/` HTTP calls require `Authorization: Bearer TOKEN`. Public static assets
contain no credentials; private downloads use short-lived scoped tickets.
Cross-origin requests are
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

`npm run smoke:claude -w @codexnest/client` exercises the production Claude UI in
Chromium against the real facade/manager/runner with a deterministic transport and
local speech fixture. It uses temporary state and free ports; checks chat, FIFO,
attachments, task/question voice, questions, models, title search and drafts; and
saves screenshots under ignored `node_modules/.cache/claude-browser-smoke`.
