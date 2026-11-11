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
and automatic A → B → A after a wrong health version or failure to start HTTP.
It records original native PID/start-time identity and operation counters to
detect a daemon restart or request replay. Cold tests evict only their own
history files using `posix_fadvise`, without changing host-wide kernel settings.

Budgets are declared before execution: normal startup/recovery ≤60 seconds,
updater health budget 120 seconds, failed-candidate rollback ≤420 seconds from
the restart phase. The latter accommodates the existing health wait, restart
preflight, graceful shutdown and restored-version health wait. Exceeding any
budget fails the scenario; the harness does not rerun a failed scenario or
increase timeouts.

These are **diagnostics, not complete release qualification**. `lifecycle.json`
always has `releaseQualified: false` and explicitly lists unfinished mandatory
cases. The publication gate stays closed until all requirements in
`docs/release-safety.md` are implemented and demonstrated for the exact candidate.
An environment-only pass or diagnostic pass must never authorize publication.

Raw installer output and synthetic credentials stay in a private VM
directory. Reports contain phase/results/timings/versions/checksums/counters;
failure excerpts remove credential lines. User installations are never test
fixtures and must not be restarted or changed by these scripts.
