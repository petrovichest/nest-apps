# OpenNest installation and update mechanisms

OpenNest uses an external OpenCode CLI. The initial compatibility candidate is
OpenCode `1.19.5`; native contract tests determine which behavior is supported.

`opennest.service` owns the Nest API. `opennest-daemon.service` owns a separate,
loopback-only `opencode serve` process through the Node `native.js` launcher,
using OpenCode's normal native history and provider configuration. API restart
never restarts that native service. Private
runtime credentials and the API token belong to OpenNest; credentials are not
embedded in unit files, wrapper scripts, frontend bundles, or management output.

The manager prepares a new installation from a clean detached Git checkout with
the backend and `dist-open` client already built. It refuses to replace a running
or configured installation. `start` starts both services, `restart` restarts only
the API, and explicit `stop` stops both OpenNest services. Configuration defaults
to `~/.config/opennest`, application state to `~/.local/state/opennest`, and the
release pointer to `~/.local/share/opennest/current`. API port defaults to `4313`
and the private native port to `4097`. The native URL must be an HTTP loopback
address with a different port. `OPENNEST_OPENCODE_BIN` selects an external binary.
Installation requires Node.js 24, Git, npm, `flock`, and executable
`/usr/bin/bwrap` for managed Team shell isolation. The installer checks these
prerequisites and does not install system packages with elevated privileges.
Managed API and native services share a private `native-events.sock` in the
OpenNest runtime directory; `OPENNEST_EVENT_SOCKET` can override this path.
Manual native fixtures omit this variable unless they explicitly test the relay.
Managed Team sessions perform file reads, searches and edits through sandboxed
`bash`; native host filesystem tools are disabled for these sessions. Write scopes
must name existing files or directories. Creating a new file requires an explicit
existing parent-directory scope, and nonexistent scopes are rejected before a
child starts. Ordinary OpenCode sessions retain their native filesystem tools.

The native launcher reads only OpenNest's private `connection.json` proxy setting.
HTTP, HTTPS and SOCKS5 upstreams use the existing local proxy bridge. The native
child receives the bridge address without upstream credentials, with no direct
fallback if the configured upstream fails. Proxy changes require idle native
work and restart only OpenNest's native service. The application API can restart
without closing that proxy bridge. The launcher injects the OpenNest tool plugin
through process-local configuration; ordinary OpenCode configuration is preserved.

OpenCode itself can prepare plugin dependencies in its normal configuration
directories when a project is first opened. This is native startup behavior and
uses the configured proxy; offline dependency bootstrap is not claimed. The
wrapper does not alter those ordinary configuration directories or add another
profile. Invalid saved proxy files fail closed instead of starting a direct
connection.

`apps/open-server/scripts/proxy-smoke.mjs BINARY NATIVE_ENTRY PLUGIN_ENTRY` runs
the real native launcher and plugin with a local model, authenticated HTTP proxy,
and authenticated local tool API. Its private fixture HOME stages already
installed public plugin dependencies so it does not need the package registry.
It verifies actual native proxy routing, upstream failure without direct fallback,
credential redaction, native tool context, and a managed native-subagent denial.
HTTP and SOCKS5 bridge unit checks additionally cover upstream authentication and
remote DNS. These checks do not qualify application installation or rollback.

The rolling channel publishes an installer, signed APK and extension after
`verify` and `opennest-native-contract` pass on the exact commit on `main`.
The manifest is published after the assets and points at the versioned installer
and its SHA-256. The installed updater checks the recovery protocol and current
native runtime before building the exact candidate. The installed commit must
be an ancestor of the candidate, so installations can skip rolling releases.

The updater builds a detached Git worktree and verifies the packaged installer
against the source before switching the API. The native service stays running.
Failed or interrupted updates use the saved transaction to restore the previous
API. The updater records `rolled_back` after confirming readiness and the original
native process identity.

`OpenNest native diagnostics` runs on an isolated GitHub runner. Use
`diagnostic_scope=full` for runtime, installer, and recovery changes. Set
`baseline_release` to reproduce a particular upgrade from an older published tag.

## Upgrading a legacy installation

An installation at `0.1.9-4098f78` can use its normal update button to install the
bridge from `opennest-claude-latest`. The bridge uses the rolling channel for
subsequent updates.

Older updaters require the exact next release. If an older installation skipped
updates, work through the remaining versions in this order:

```text
085a170 → a589610 → 7265629 → f789d8a → 1781d46 → 7d6350e → a0cefda → 4098f78
```

For each step, set `OPENNEST_UPDATE_MANIFEST_URL` in the OpenNest `server.env`
(by default `~/.config/opennest/server.env`) to the versioned manifest and use the
update button. For example, the next release from `7d6350e` is
[`0.1.9-a0cefda`](https://github.com/petrovichest/nest-apps/releases/download/opennest-v0.1.9-a0cefda/OpenNest-latest.json).
Replace the version in that URL with the next needed version at each step.
Remove the temporary override after reaching `4098f78` and use the update button
to install the bridge. The step from `7265629` to `f789d8a` requires Claude
Code 2.1.289 and completed OpenCode work.
