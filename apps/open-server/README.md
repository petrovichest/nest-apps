# OpenNest backend

OpenNest is a separate Nest application that runs Claude Code through OpenRouter.
Older installations can still use the OpenCode runtime. Its configuration, API token,
drafts, queues and receipts are independent of the other Nest applications. The API defaults
to `127.0.0.1:4313` and the independently managed OpenCode service to `127.0.0.1:4097`.

The `opennest-rolling` channel publishes after the source and native contract
checks pass on `main`. The [release safety rules](../../docs/release-safety.md)
describe the manual native diagnostics for changes to the runtime, installer, or recovery.

## Installing a rolling release

The published backend supports Linux **x86_64** and Node.js **24**. Install Git,
npm, `flock`, bubblewrap, OpenCode **1.19.5**, and Claude Code **2.1.289** first.
Set `OPENNEST_OPENCODE_BIN` and `OPENNEST_CLAUDE_BIN` to absolute paths when the
executables are outside PATH.

```sh
curl -fsSL https://github.com/petrovichest/nest-apps/releases/download/opennest-rolling/install-opennest.sh | bash
```

Open `http://127.0.0.1:4313`. The owner token is in
`~/.config/opennest/token`; enter the OpenRouter key in OpenNest settings and
choose a model. The release includes `OpenNest-latest.apk` and
`opennest-browser-latest.zip`. [OpenNest rolling channel](https://github.com/petrovichest/nest-apps/releases/tag/opennest-rolling)

Use the OpenNest update button for regular updates. The updater can skip rolling
releases when the candidate descends from the installed commit and supports the
current runtime and recovery protocol. It restores the previous ready API when a
candidate fails to become ready. [Upgrading a legacy installation](../../deploy/opennest/README.md#upgrading-a-legacy-installation)

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
  A managed update restarts the API while retaining the native process.

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
