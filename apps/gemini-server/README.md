# GeminiNest

Independent Nest client for a Google AI Ultra account, using the installed
Antigravity CLI's native Google sign-in and ACP v1. The tested CLI baseline is
**Antigravity 1.5.3**. Gemini CLI's old individual subscription login is not used.

Google documents the supported integration in [Antigravity ACP](https://antigravity.google/docs/ide/extensions/acp/).
Its [remote-control daemon](https://antigravity.google/docs/remote-control/) serves
Google's remote UI; GeminiNest instead owns a local ACP subprocess, using the
documented prompts, permission requests and elicitation forms.

GeminiNest has a separate web/PWA build, Android identity, bearer token, private
configuration and native data directory. CodexNest and ClaudeNest remain separate
applications. Do not update or restart their installed instances to install this one.

## Connection and Google sign-in

Open **Settings → Gemini**. Save an HTTP, HTTPS or SOCKS5 proxy, test it, then choose
**Sign in with Google**. Open the Google link, select the account with Ultra, and
paste the authorization code or final redirect URL back into GeminiNest. The native
`agy acp --login` process exchanges the code through the configured proxy and owns
the credentials. GeminiNest does not implement OAuth or accept an API key.

The Google consent page runs in the user's browser and uses that browser's network
settings. Server-side token exchange and agent traffic use GeminiNest's proxy. If
Google is blocked in that browser, its proxy must also be enabled.

Proxy credentials are saved only in `~/.config/gemininest/connection.json` (0600),
and are redacted from API responses. The daemon owns a loopback CONNECT bridge, with
the configured proxy as its mandatory upstream, including remote DNS for SOCKS5.
Child processes receive the loopback proxy, not the upstream password. Missing or
failed proxy configuration does not fall back to a direct connection. Native login
process output, authorization codes and ACP traffic are never logged by Nest.
Account/proxy changes require idle tasks. Login links expire after ten minutes.

## Build and install

Requirements: Node 24, Linux systemd user manager, and Antigravity CLI (`agy`) on PATH
or an absolute `GEMININEST_AGY_BIN`. Native sign-in may require an unlocked desktop
keyring / D-Bus session. Install the CLI from Google's official distribution.

```sh
npm ci
npm run build:gemini
```

For the published installer, install [Antigravity CLI](https://antigravity.google/docs/getting-started/)
first, then run:

```sh
curl -fsSL https://github.com/petrovichest/nest-apps/releases/latest/download/install-gemininest.sh | bash
```

Use a committed, detached Git checkout for an installed release:

```sh
git worktree add --detach ~/.local/share/gemininest/releases/COMMIT COMMIT
cd ~/.local/share/gemininest/releases/COMMIT
npm ci --include=dev
npm run build:gemini
node apps/gemini-server/scripts/manage.mjs setup --release "$PWD" --start
```

The installer is `deploy/gemininest/install.sh`; published copies are pinned to
the verified release commit. Setup refuses to replace running GeminiNest services.
It creates the private bearer token at `~/.config/gemininest/token` without printing
it. Open `http://127.0.0.1:4312` and enter that token. For trusted LAN hosting, configure
a private reverse proxy to that address and add its origin to
`GEMININEST_ALLOWED_ORIGINS` in `~/.config/gemininest/server.env`.

`npm run dev:gemini` starts the development API on 4312 and UI on 5175. Do not start
it on a port owned by an installed instance. Test fixtures use temporary state and
free ports; they do not access the user's account.

## Ownership and recovery

`gemininest-daemon.service` owns ACP, pending tool decisions, login, and sessions.
`gemininest.service` forwards authenticated HTTP/WebSocket connections over a
private Unix socket. Restarting the gateway or closing the browser does not stop
agent work. Reconnection provides a full UI snapshot and task history.

ACP session IDs and Nest metadata are durable. Nest also stores a local UI
projection so history is viewable without calling the model or launching a CLI.
Native conversation history remains owned by Antigravity. After a daemon/host
crash, unfinished work is marked interrupted; an explicit next message loads the
same native session. Uncertain prompt deliveries are never automatically replayed.
Delivery receipts acknowledge Nest admission, not exactly-once external tool work.

The first implementation supports project folders, conversations, streaming text
and reasoning, tool output, approvals, elicitation forms, attachments, native model
options, stop, steering, a durable FIFO queue, drafts, read/pin/archive state, and
Git changes. Model options appear after opening the first native session. Native
tool configuration, skills and rules continue to be handled by the CLI.

Nest Team, Goal, Plan, forks, the shared task board, browser extension, full-text
search, voice and in-app updates are disabled in this initial Gemini build.
Credentials are for one Google account. Changing models while a turn is active is
not supported. Real model execution needs the owner's interactive Google login;
automated tests use deterministic ACP agents.

## Checks

```sh
npm test -w @gemininest/server
npm run typecheck -w @gemininest/server
npm run build:gemini
npm run smoke:gemini -w @codexnest/client
```

Tests cover proxy routing and rejection, native login/code submission, idempotent
delivery, steering/FIFO ordering, decisions, attachment ownership, native session
reload, authenticated HTTP and gateway restart. The real CLI's initialize handshake
and proxy-routed OAuth exchange are separately verified without signing in.
