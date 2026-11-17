# OpenNest backend

OpenNest is a separate Nest application using OpenCode's native HTTP runtime and
OpenRouter models. Its configuration, API token, drafts, queues and receipts are
independent of the other Nest applications. The API defaults to `127.0.0.1:4313`;
the independently managed OpenCode service defaults to `127.0.0.1:4097`.

The shared client has been integrated after approval of its concrete preview.
Source implementation and isolated tests do **not** qualify an application release.
Publication is gated by [the native release safety rules](../../docs/release-safety.md).
The first release independently qualifies its initial baseline; later releases
qualify an upgrade from the previously published OpenNest version.

The `OpenNest qualification` workflow on a working branch runs only isolated
startup diagnostics. Its report stays incomplete and it produces no release
packages or qualification artifact. The full publication matrix runs on `main`.

## Installing a qualified release

The published backend supports Linux **x86_64**, Node.js **24**, and OpenCode
**1.19.5**. Install Git, npm, `flock` and `/usr/bin/bwrap` (bubblewrap) first.
OpenCode is an external prerequisite; the installer verifies its exact version.
Set `OPENNEST_OPENCODE_BIN=/absolute/path/to/opencode` when it is not on PATH.

Installers appear only after the complete native qualification has passed:

```sh
curl -fsSL https://github.com/petrovichest/nest-apps/releases/download/opennest-latest/install-opennest.sh | bash
```

Open `http://127.0.0.1:4313`. The owner token is in
`~/.config/opennest/token`; enter the OpenRouter key in OpenNest settings and
choose a model. The same qualified release contains `OpenNest-latest.apk` and
`opennest-browser-latest.zip`. [OpenNest releases](https://github.com/petrovichest/nest-apps/releases)
use their own `opennest-v…` tags and `opennest-latest` update channel.

The installer creates its own API/native services and directories; existing Nest
installations are preserved. Use the OpenNest update button or `opennest update`
for qualified updates. Source templates intentionally refuse to install until
release packaging pins their tested version and full commit.

## Implemented behavior

- Projects, native conversation history, drafts, model and reasoning selection
  from the actual OpenCode OpenRouter catalog, streaming text/reasoning/tool
  activity, questions, approvals, interruption and Git changes.
- Persistent FIFO and stable admission receipts. Supplied native message IDs
  reconcile uncertain delivery after API restart. Missing native evidence never
  causes automatic replay. Unacknowledged native session creation remains
  uncertain rather than silently creating another session.
- Plan using the native planning agent, persisted goals with usage accounting,
  and application-managed Team tasks with durable result delivery. Managed
  parents and children disable native subagents. Child access is checked by the
  native plugin, with filesystem/network isolation for shell commands. Goal
  budgets use observed native usage; they cannot retroactively cap a model
  request whose usage has not yet been reported.
- Exact and compressed forks with stable operation IDs and queued messages;
  private session-owned attachments, pasted text and actual native image parts;
  explicitly published artifacts and scoped download tickets.
- Browser extension bindings and tools, screenshot attachments, skills discovered
  through native APIs, scoped skill disabling, local/OpenAI transcription,
  durable voice jobs, notifications, and the shared task board.
- Native permission presets and genuine session-scoped grants. Session grants
  update only the relevant native session and reply `once`; OpenCode's durable
  project-wide `always` approval is never presented as a session-only grant.
- Full-text search directly against the native read-only SQLite history, scoped
  to explicitly managed sessions and bounded in a worker. OpenNest creates no
  second transcript database, search index or transcript cache. Unknown native
  storage schemas return an explicit error rather than incomplete results.
- Masked OpenRouter/proxy settings, connection checks, and in-app update controls.
  A managed update restarts the API while retaining the native process. An
  unqualified or missing OpenNest release is not offered as an update.

OpenCode remains the conversation source of truth. OpenNest stores only its own
metadata, workflow state, drafts, queues and receipts in private atomic JSON.
API restart never kills the native service. SSE reconnect reconciles native
snapshots before admitting queued work. Managed installations use the native
plugin's authenticated private Unix socket for versioned active text snapshots
and offsets, continuing live output after reconnect without per-token HTTP
requests. The relay is bounded to 256 active parts and 8 MiB; overflow or an
unavailable configured relay closes admission instead of declaring partial text
ready. Overflow requires restarting the native owner. Direct connections without
the relay conservatively suppress ambiguous snapshot-overlapping deltas until a
canonical update or completion. These checks are separate from cold/warm
lifecycle and rollback qualification.

Messages submitted during native work may be consumed on a subsequent model
step. Instantaneous steering inside a running tool is not guaranteed by the
native runtime. Concurrent external native clients are outside Nest's admission
lock and must coordinate account or instance changes.

## Credentials, proxy and native boundaries

`GET/PUT /api/v1/settings/open` reads public state or saves an OpenRouter key
through native `PUT /auth/openrouter`. Only a successful-write flag is persisted
in Nest metadata. Existing keys configured outside OpenNest are not discovered by
that flag. Catalog membership and `provider.connected` do not prove that a key
exists or is valid. `POST /api/v1/settings/open/test` checks native readiness;
OpenRouter authorization is observed only when a model request is made.

OpenCode 1.19.5 caches initialized provider credentials. Saving a key serializes
Nest admissions and inventories all native session directories, including
archived sessions, before checking model work, questions and permissions there.
Only the default instance and managed project directories are refreshed after
saving. Unknown directories are never disposed, and `/global/dispose` is never
used. External clients cannot be atomically locked by the native API. This scope
is deliberately narrower than a global cross-client rotation guarantee.

`GET/PUT /api/v1/settings/open/proxy` stores private upstream configuration. The
native wrapper uses a local bridge, keeps upstream credentials out of its child
environment, and does not fall back to direct requests if the configured proxy
fails. Proxy testing uses a temporary bridge. Idle checks use raw native status
when projection readiness is unavailable, allowing a first proxy to repair
bootstrap connectivity while refusing changes if native activity is unknown.

## Development and evidence

Requirements: Node 24, external OpenCode **1.19.5**, and bubblewrap for managed
Team shell isolation. Other native versions require measured contract checks.
Use only isolated HOME/state/credentials/ports for native and lifecycle tests;
never point a smoke at a user's running native service or authentication data.

```sh
npm run build:open
npm run typecheck -w @opennest/server
npm test -w @opennest/server
node apps/open-server/scripts/native-smoke.mjs /absolute/path/to/opencode
node apps/open-server/scripts/proxy-smoke.mjs /absolute/path/to/opencode apps/open-server/dist/native.js apps/open-server/dist/plugin.js
node apps/open-server/scripts/workflows-smoke.mjs /absolute/path/to/opencode
```

The workspace tests include transport, projection, facade, feature, workflow,
isolation, connection and deployment-management tests. The native protocol smoke
uses the real binary and a local controlled model. The proxy smoke additionally
loads the production plugin; the workflows smoke exercises the actual facade,
plugin and workflow controller together, including API restart without repeated
model work. These are narrow integration probes, not a representative large
history, installed upgrade or automatic rollback matrix.

`OPENNEST_CONFIG_DIR`, `OPENNEST_STATE_DIR`, `OPENNEST_RUNTIME_DIR`,
`OPENNEST_EVENT_SOCKET`, `OPENNEST_NATIVE_URL`, `OPENNEST_NATIVE_USERNAME`, `OPENNEST_NATIVE_PASSWORD`,
`OPENNEST_NATIVE_DATABASE_PATH`, `OPENNEST_PORT`, `OPENNEST_HOST`,
`OPENNEST_RELEASE_PATH`, `OPENNEST_VERSION` and `OPENNEST_CLIENT_DIST` configure the
backend. Native authentication also reads `OPENCODE_SERVER_USERNAME` and
`OPENCODE_SERVER_PASSWORD`. API and native service may share one private
`server.env`. Environment and token files must be private regular files (`0600`).
Managed services preserve configured XDG paths so runtime and search read the
same isolated native profile.
