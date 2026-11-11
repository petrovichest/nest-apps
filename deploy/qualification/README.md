# Isolated native lifecycle diagnostics

`environment.sh` runs only on disposable GitHub-hosted VMs. Each matrix job owns
a fresh VM with real systemd as PID 1 and a separate real user manager, uid 17001,
private HOME/state/authentication/native socket. All fixture units share a cgroup
limited to 4 CPUs and 10 GiB of memory. No user installation, credentials or native
socket is accessible to the fixtures. Only public source inputs and synthetic
reports are used. The preinstalled VM tools avoid any dependency on downloading
an additional OS image or APT packages.

The default mode checks the exact pinned native package and actual daemon.
`QUALIFICATION_MODE=lifecycle` additionally runs `lifecycle.mjs`. It uses the
published `0.1.9-fe3c5c8` installer and its installed updater, with the exact
candidate Git commit served by a VM-local HTTPS artifact registry. The
registry changes download inputs, not installer/updater code. The model and OAuth
services are local fixtures; native RPC, health, systemctl and service units are
real. The private fixture CA and GitHub hostname mapping exist only in the
disposable test VM; the mapping is removed during cleanup.

The lifecycle diagnostic exercises installation, real saved-chat requests,
rebuilding the native index from at least 2000 nonarchived synthetic sessions and
3 GiB of valid history, three cold and warm runs, A → B, active requests/queues,
pending command approvals and managed background results, and automatic A → B → A
after a wrong health version or failure to start HTTP.
Separate real refusal cases cover an unavailable native connection, failed Git
artifact download, incompatible recovery metadata, a filesystem checkpoint
failure and a missing build executable. They require A and the rollback target
to remain unchanged and the same native work to finish after clearing the fault.
It records original native PID/start-time identity and operation counters to
detect a daemon restart or request replay. Cold tests evict only their own
history files using `posix_fadvise`, without changing host-wide kernel settings.
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
Fixture import has a separate 1380-second construction budget, including stopping
the writer and freezing its consistent index; measured cold/warm budgets stay at 60.
This preparation limit replaces the initial 600-second estimate based on measured
run `43078675692` at `b4be4410b3cc46d43340ffbf880d1808bf0c8981`:
Native 0.154.0 imports 100 chats per 56–57 seconds, reaching 1000 at the old limit.
The full 2048-chat workload therefore needs approximately 1160–1230 seconds before
freezing. The volume, CPU/RAM limits and startup/RPC/health/rollback budgets are
unchanged; the entire affected runtime matrix must run again with the declared
construction limit. A fixture preparation pass is never a startup performance pass.
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

`QUALIFICATION_SCOPE=interruption` is a separate diagnostic on the actual old
updater. A FIFO pauses its existing version-file write after switching `current`;
the test kills only the fixture updater service and requires automatic recovery.
This scope does not run or qualify the large-history matrix.

`QUALIFICATION_SCOPE=clean` installs the exact candidate using the same version/SHA
substitution as publication. It verifies its committed build identity and the
effective 420-second systemd recovery stop limit, then resumes actual private
account requests, a queue, an approval and a managed result after an API restart.
It does not qualify the separate large-history, upgrade or failed-candidate matrix.

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

These are **diagnostics, not complete release qualification**. `lifecycle.json`
always has `releaseQualified: false` and explicitly lists unfinished mandatory
cases. The publication gate stays closed until all requirements in
`docs/release-safety.md` are implemented and demonstrated for the exact candidate.
An environment-only pass or diagnostic pass must never authorize publication.
The large-history jobs start after clean installation and interrupted-update
diagnostics pass. An early failure therefore avoids building several large native
fixtures for an already rejected candidate; skipped matrix jobs remain unqualified.

Raw installer output and synthetic credentials stay in a private VM
directory. Reports contain phase/results/timings/versions/checksums/counters;
failure excerpts remove credential lines. User installations are never test
fixtures and must not be restarted or changed by these scripts.
