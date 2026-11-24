# Isolated native lifecycle diagnostics

Run these diagnostics explicitly with the CI workflow's **Run workflow** action
against the candidate branch. Ordinary pushes run source and account-network
checks without requiring a PR. Publication is restricted to main/version tags
and requires a complete successful manual qualification of the exact same SHA.

`environment.sh` runs only on disposable GitHub-hosted VMs. Each matrix job owns
a fresh VM with real systemd as PID 1 and a separate real user manager, uid 17001,
private HOME/state/authentication/native socket. All fixture units share a cgroup
limited to 4 CPUs and 10 GiB of memory. No user installation, credentials or native
socket is accessible to the fixtures. Only public source inputs and synthetic
reports are used. The preinstalled VM tools avoid any dependency on downloading
an additional OS image or APT packages.

The default mode checks the exact pinned native package and actual daemon.
Full lifecycle qualification targets the latest stable Codex CLI, pinned at 0.172.0.
The real installed updaters must reject 0.171.0 and 0.154.0 before switching the
application and preserve active work. Publication checks the pin against the
latest stable upstream release.
`QUALIFICATION_MODE=lifecycle` additionally runs `lifecycle.mjs`. It uses the
published `0.1.9-5779121` installer and its installed updater, with the exact
candidate Git commit served by a VM-local HTTPS artifact registry. The
registry changes download inputs, not installer/updater code. The model and OAuth
services are local fixtures; native RPC, health, systemctl and service units are
real. The private fixture CA and GitHub hostname mapping exist only in the
disposable test VM; the mapping is removed during cleanup.

The pinned published installer is reconstructed with its original packaging
from immutable source, and must match the SHA-256 of the observed published
file. Moving the rolling channel cannot silently replace the baseline.
This baseline was qualified by run `44173862212`; its published installer hash is
`98869c3475a265637ea876d63c6bb3a769f2e641fdc66f7923e51810d5aa6a86`.
Interrupted updates additionally run from the incident recovery release
`0.1.9-fe3c5c8` and the user's installed `0.1.9-f42edbe`. All three installers
match their observed published hashes. The installed-release case places a real
CLI 0.144.6 in the shared Node runtime while the configured CLI is 0.172.0,
then requires the unchanged installed updater to complete update and rollback.

The older f42edbe/fe3c5c8 baselines reapply auth on reconnect. Real Native 0.167.2 and 0.169.0
terminate an active turn on that call with `application network permission was
revoked`, even when its daemon PID survives. A's active replacement is therefore
unsupported. Recovery protocol 3 requires the legacy transition to be idle;
the actual old updater must refuse a busy transition and preserve the held
request, queue, approval and managed result. Legacy warm starts and interrupted
replacement/rollback diagnostics then use idle A, preserving its PID/history
and exercising a new saved-chat request after recovery. Candidate warm recovery
still requires all active work and operation counters. These legacy scopes must not
be reported as qualifying an active rollback into the legacy version.
The current 5779121 baseline uses recovery protocol 3 and update admission:
compatible busy upgrades, interrupted updates and failed-candidate rollbacks
must preserve active requests, queues, approvals and managed results.
For an idle rollback, the new CLI supplies the target recovery protocol. The API
returns private threads' writer leases to the original daemon before replacement,
without terminating either daemon or exposing internal archive events. Archived
chats stay archived. A selected account/credential generation or connection that
the old version cannot recover refuses downgrade before any pointer switch.

The lifecycle diagnostic exercises installation, real saved-chat requests,
rebuilding the native index from at least 2200 nonarchived synthetic sessions and
12 GiB of valid history, three cold and warm runs, A → B, active requests/queues,
pending command approvals and managed background results, and automatic A → B → A
after a wrong health version or failure to start HTTP.
Separate real refusal cases cover an unavailable native connection, failed Git
artifact download, incompatible recovery metadata, a filesystem checkpoint
failure and a missing build executable. They require A and the rollback target
to remain unchanged and the same native work to finish after clearing the fault.
It records original native PID/start-time identity and operation counters to
detect a daemon restart or request replay. Cold tests evict only their own
history files using `posix_fadvise`, without changing host-wide kernel settings.
PID capture selects actual Native processes owning listening Unix sockets,
including private account servers. Short-lived CLI status commands are not daemons.
The native PID update-loop helper is recorded separately from the app-server;
cold setup also verifies that no fixture process retains history or SQLite
descriptors. Complete fixture ID membership is checked in both native pages and
the Nest projection, including archived and nested history.
The fixture first materializes every generated chat through the actual native
writer and unloads it with archive/unarchive. It then preserves the real paginated
history SQLite view and rebuilds only the metadata session index. Deleting all
native databases is a different recovery fault: current Native does not rebuild
an already paginated turns view merely by listing or reading its JSONL file.
That full database-loss fault is not claimed as passing here. The nested file
profile uses independently resumable Native V1 children; it does not impersonate
V2 parent ownership. Actual application-managed Team execution is tested separately.
Fixture import has a separate 2100-second construction budget, including stopping
the writer and freezing its consistent index; measured cold/warm budgets stay at 60.
Its four preparation workers use independent real Native connections, within the
same 4-CPU/10-GiB cgroup. This avoids depending on request scheduling within one
connection. Run `43699932619` measured 89–90 seconds per 100 chats on Native
0.154.0 even with four connections, reaching only 1500/2048 at the previous
1380-second construction limit. This supersedes the earlier single-connection
estimate of 56–57 seconds per 100. The complete workload therefore needs about
1830 seconds, plus stopping the writer and freezing its consistent index.
The declared 2100-second construction limit and 60-minute whole-job limit cover
that measured work. Volume, CPU/RAM limits and startup/RPC/health/rollback
deadlines are unchanged. The entire affected runtime matrix must run again;
a fixture preparation pass is never a startup performance pass.
On cold bootstrap, the CLI's internal short probe may time out while its spawned
server continues initializing. The diagnostic then observes that same process
without another bootstrap; native readiness and Nest recovery must still finish
within the original 60-second total budget. Other bootstrap errors remain fatal.

Budgets are declared before execution: normal startup/recovery ≤60 seconds,
updater health budget 120 seconds, failed-candidate rollback ≤420 seconds from
the restart phase. The latter accommodates the existing health wait, restart
preflight, graceful shutdown and restored-version health wait. Exceeding any
budget fails the scenario; the harness does not rerun a failed scenario or
increase timeouts.
The existing paginated `thread/list` RPC has a 120-second deadline. The transient
timeout case holds the actual startup `thread/loaded/list` response for 35 seconds
against that RPC's 30-second deadline; it must observe failed readiness and then
recover with the same API/Native processes inside the unchanged 60-second budget.

`QUALIFICATION_SCOPE=interruption` is a separate diagnostic on the actual old
updater. Real FIFOs pause its build checkpoint, version write and final update
confirmation; a delayed real Native response exposes candidate recovery. The
test terminates the fixture updater at each boundary and also terminates the
unconfirmed candidate during recovery. Every case requires automatic restoration
of A and completion of the original work with the same surviving Native daemon.
This scope does not run or qualify the large-history matrix.

`QUALIFICATION_SCOPE=clean` installs the exact candidate using the same version/SHA
substitution as publication. It verifies its committed build identity and the
effective 420-second systemd recovery stop limit, then resumes actual private
account requests, a queue, an approval and a managed result after an API restart.
It also exercises expired credentials and a transient OAuth service failure
before the expensive full-history jobs. Explicit refusal before dispatch and a
failed native turn both require a real OAuth failure and no accepted model call;
clearing the fault must restore a saved-chat request with the same Native PID.
It does not qualify the separate large-history, upgrade or failed-candidate matrix.
It also starts the actual packaged ClaudeNest API and GeminiNest daemon/gateway,
checks their health/version and serves both UI bundles from the candidate release.
These startup smoke tests use an empty private HOME and the real pinned Claude
2.1.289 and Antigravity 1.5.6 binaries (Google's distribution is checksum-verified).
They do not log in or execute model requests; provider traffic is disabled/blocked
in their subprocess environment. Native model execution and proxy qualification
remain the separate Codex lifecycle/network cases.

The candidate installs its persistent recovery guard from `postbuild` only while
building a managed release inside the real updater service. Ordinary checkout
builds have no installation side effects. This lets the unchanged previous
updater prepare recovery before switching its pointer. The guard records the
healthy release and candidate, restores the previous release on failure, and
checks actual API/Native readiness. The isolated diagnostics check surviving
Native PIDs and operation counters; the updater does not inspect process identity.
Authentication and native history are never reverted. New candidate work remains
blocked until the exact update is confirmed. These mechanisms still require the native diagnostics;
their presence alone is not evidence that interrupted recovery works.

Each `lifecycle.json` describes only its own scope and keeps `releaseQualified:
false`. `release-report` depends on source verification, all native account-network
and environment jobs, clean installation, both baseline interruption jobs and
the full five-version history matrix. Its independent report validator rejects
missing/failed cases, incomplete scopes, a different SHA, smaller history,
changed readiness budgets, direct provider traffic and OOM. Only that successful
aggregate produces the immutable `qualified-release-<SHA>` artifact.
The publication gate requires the complete successful manual CI run at the same
SHA, validates that artifact and installer hash, and checks that the published
healthy baseline has not moved. Missing/expired evidence or a moved baseline
blocks release. The qualification report and asset checksums accompany the release.
An environment-only pass or a single diagnostic pass cannot authorize publication.
Each interruption scope also finishes a successful upgrade and saved-chat request,
including the incident recovery baseline. The unsupported-native scope requires
the specific version-gate diagnostic before switch, preserving the same Native
process, held request and queue. Approval and Team recovery remain mandatory on
supported runtimes; legacy 0.154.0 cannot run the fixture's managed child scenario.
The large-history jobs start after source/account checks, clean installation and
interrupted-update diagnostics pass. An early failure avoids building large native
fixtures for an already rejected candidate; skipped matrix jobs remain unqualified.

Raw installer output and synthetic credentials stay in a private VM
directory. Reports contain phase/results/timings/versions/checksums/counters;
failure excerpts remove credential lines. User installations are never test
fixtures and must not be restarted or changed by these scripts.
