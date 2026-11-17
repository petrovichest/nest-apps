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

The installer remains a closed source template until publication substitutes the
qualified exact commit and matching version. It cannot install a moving branch,
and existing installations are never overwritten. Update commands intentionally
refuse candidates until the [mandatory qualification](../../docs/release-safety.md)
covers native installation, large histories, upgrade and failed-candidate rollback.
Neither these scripts nor their unit tests constitute release qualification.

`check-update` reads the shared release manifest. A legacy manifest without
`applications.opennest` reports no eligible OpenNest release. An eligible section
must contain `installer` and `qualification` artifacts, each with a trusted GitHub
release URL and SHA-256 checksum. The downloaded report must bind the exact
candidate and unchanged healthy baseline, OpenNest identity, supported native
version, recovery protocol, installer checksum and successful manual workflow.
It must include all native scopes, at least 2000 nonarchived sessions and 3 GiB,
three cold and warm runs inside the startup budget, and automatic rollback with
the same native process, a ready previous application and resumed work.

The updater fetches only that exact Git commit and builds an immutable checkout.
It verifies the packaged installer bytes against qualification before switching
the API pointer. The native service unit and process are preserved. A private
durable transaction is written before switching. Failed candidates and interrupted
updaters restore the previous API through `ExecStopPost` recovery; `rolled_back`
is recorded only after the previous API reaches readiness with the original
native identity. Failed recovery retains evidence and reports failure. Emergency
restart runs the recovery unit, which stops the updater before API recovery.
Installation, checking, replacement and recovery use the OpenNest kernel lock.

`node --test deploy/opennest/update.test.mjs` verifies qualification parsing and
update/rollback control flow with simulated services and health responses. These
are supplemental source tests, not the mandatory native lifecycle matrix.

No installer or manager is run against an existing user installation during
development. Native lifecycle checks require isolated HOME, credentials, native
state, ports and services. The first-release baseline is qualified independently as specified in the
release policy. The separate `OpenNest qualification` workflow executes the
complete native matrix, signed Android packaging and extension checks. Only a
successful completed manual run for the exact source SHA enables
`Publish qualified OpenNest`; its versioned release artifacts are immutable and
the dedicated channel manifest is written last. The existing Nest Apps channel
is never updated by this publisher.
