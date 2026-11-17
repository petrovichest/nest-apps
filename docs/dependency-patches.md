# Temporary build dependency patch

`picomatch` is pinned to upstream PR [#259](https://github.com/micromatch/picomatch/pull/259),
commit `d705935d4ece5f406df01213330f1a04adad3fe0`, for
[GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf).
No patched npm release is available as of 2026-11-17. The lockfile pins the
download's SHA-512. No Vite, tsup or Vitest downgrade is required.

The upstream package still identifies itself as 4.0.7, so npm's version-based
audit also flags the patched source. `npm run audit:security` retrieves the full
production and development audit, verifies the exact source URL, archive integrity
and installed parser SHA-256, and treats only this fixed advisory as resolved.
Other advisories, including future ones on picomatch, still block at high/critical.
Unknown reports, changed patch bytes and additional unverified copies fail closed.
The audit tests also exercise hostile globs in a subprocess with a fixed deadline.

Replace this override with a registry release containing the fix when available,
then remove the specific patched-advisory handling. Do not add a blanket audit
exception or suppress development dependency checks.
