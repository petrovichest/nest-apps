#!/usr/bin/env bash

set -Eeuo pipefail

[[ "$(uname -s)" == "Linux" ]] || { printf '%s\n' 'Linux test host required'; exit 0; }

trap 'printf "::error::adoption test failed at line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR

test_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT

prepare_case() {
  local name="$1"
  case_home="$test_root/$name/home"
  case_repo="$test_root/$name/repo"
  case_node="$test_root/$name/node-v24"
  case_fake_bin="$test_root/$name/bin"
  mkdir -p "$case_home/.config/codexnest" "$case_home/.config/systemd/user/codexnest.service.d" \
    "$case_home/.local/state/codexnest" "$case_repo/deploy/systemd" "$case_fake_bin" \
    "$case_node/bin"

  printf '%s\n' '{' '  "name": "fixture",' '  "version": "0.1.0"' '}' \
    > "$case_repo/package.json"
  cp "$test_script_dir/codexnest" "$case_repo/deploy/codexnest"
  cp "$test_script_dir/restart-protocol.json" "$case_repo/deploy/restart-protocol.json"
  cp "$test_script_dir/systemd/codexnest-managed.service" \
    "$case_repo/deploy/systemd/codexnest-managed.service"
  cp "$test_script_dir/systemd/codexnest-update.service" \
    "$case_repo/deploy/systemd/codexnest-update.service"
  chmod 0755 "$case_repo/deploy/codexnest"
  git -C "$case_repo" init -q -b codex/mvp
  git -C "$case_repo" config user.name CodexNest
  git -C "$case_repo" config user.email 0+codexnest@users.noreply.github.com
  git -C "$case_repo" add .
  git -C "$case_repo" commit -q -m fixture
  git -C "$case_repo" tag v0.1.0
  sed -i 's/"version": "0.1.0"/"version": "0.1.1"/' "$case_repo/package.json"
  git -C "$case_repo" add package.json
  git -C "$case_repo" commit -q -m update-fixture
  git -C "$case_repo" tag v0.1.1
  git -C "$case_repo" switch -q --detach v0.1.0
  git -C "$case_repo" remote add origin "$case_repo"

  printf 'CUSTOM_SETTING=keep\nCODEXNEST_STATE_PATH=%s\n' \
    "$case_home/.local/state/codexnest/state.json" \
    > "$case_home/.config/codexnest/server.env"
  printf '%s\n' '[Unit]' 'Description=Existing CodexNest' '' '[Service]' \
    'ExecStart=/old/node /old/server.js' \
    > "$case_home/.config/systemd/user/codexnest.service"
  printf '%s\n' '[Service]' 'Environment=PRESERVED_DROP_IN=true' \
    > "$case_home/.config/systemd/user/codexnest.service.d/preserved.conf"
  printf '{"auth":{"tokenSha256":"%064d"}}\n' 0 \
    > "$case_home/.local/state/codexnest/state.json"
  printf '%s\n' 'test-restart-token' \
    > "$case_home/.local/state/codexnest/restart-token"

  case_real_node="$(command -v node)"
  cat > "$case_node/bin/node" <<EOF
#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  printf '%s\\n' 'v24.18.0'
  exit 0
fi
exec "$case_real_node" "\$@"
EOF
  cat > "$case_node/bin/npm" <<'EOF'
#!/usr/bin/env bash
set -e
if [[ -f "$HOME/fail-build" ]]; then exit 9; fi
if [[ "${1:-}" == "ci" ]]; then exit 0; fi
if [[ "${1:-}" == "run" && "${2:-}" == "build" ]]; then
  mkdir -p apps/server/dist apps/client/dist
  : > apps/server/dist/index.js
  : > apps/client/dist/index.html
  exit 0
fi
exit 2
EOF
  chmod 0755 "$case_node/bin/node" "$case_node/bin/npm"

  cat > "$case_fake_bin/systemctl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  cat > "$case_fake_bin/curl" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == *NestApps-latest.json* ]]; then
  if [[ "$*" != *'NestApps-latest.json?cache='* ]]; then
    printf '%s\n' 'Expected rolling manifest request to bypass caches' >&2
    exit 2
  fi
  if [[ -f "$HOME/invalid-manifest" ]]; then
    printf '%s\n' '{"schemaVersion":1,"version":"invalid","commit":"invalid"}'
    exit 0
  fi
  commit="$(git -C "$CODEXNEST_REPOSITORY_URL" rev-parse codex/mvp)"
  printf '{"schemaVersion":1,"version":"0.1.1-%s","commit":"%s"}\n' \
    "${commit:0:7}" "$commit"
  exit 0
fi
if [[ "$*" == *'/releases?per_page=100'* ]]; then
  printf '%s\n' \
    '[{"tag_name":"rolling-latest","draft":false,"prerelease":false},{"tag_name":"v0.1.0","draft":false,"prerelease":false},{"tag_name":"v0.1.1","draft":false,"prerelease":false}]'
  exit 0
fi
if [[ "$*" == *api.github.com* ]]; then
  printf '%s\n' '{"tag_name":"v0.1.0","draft":false,"prerelease":false}'
  exit 0
fi
if [[ "$*" == *'/api/v1/internal/restart/prepare'* ]]; then
  if [[ -f "$HOME/managed-team-work" ]]; then
    printf '%s\n' \
      '{"restartProtocolVersion":2,"transport":"daemon","appServerReady":true,"hasManagedWork":true,"quiescent":false}'
    exit 0
  fi
  printf '%s\n' \
    '{"restartProtocolVersion":1,"transport":"daemon","appServerReady":true,"hasManagedWork":false,"quiescent":true}'
  exit 0
fi
if [[ "$*" == *'/api/v1/internal/restart/resume'* ]]; then exit 0; fi
if [[ -f "$HOME/fail-health" ]]; then exit 22; fi
current="$(readlink -f "$HOME/.local/share/codexnest/current" 2>/dev/null || true)"
version="${current##*/v}"
if [[ -f "$HOME/fail-rolling-health" && "$version" =~ -[0-9a-f]{7}$ ]]; then exit 22; fi
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9a-f]{7})?$ ]] || version=0.1.0
printf '{"status":"ok","serverVersion":"%s","recoveryState":"ready"}\n' "$version"
EOF
  chmod 0755 "$case_fake_bin/systemctl" "$case_fake_bin/curl"
}

run_adoption() {
  HOME="$case_home" \
  XDG_CONFIG_HOME="$case_home/.config" \
  XDG_STATE_HOME="$case_home/.local/state" \
  CODEXNEST_ROOT="$case_home/.local/share/codexnest" \
  CODEXNEST_REPOSITORY_URL="$case_repo" \
  PATH="$case_fake_bin:/usr/bin:/bin" \
  CODEXNEST_HEALTH_ATTEMPTS=1 \
  CODEXNEST_HEALTH_DELAY_SECONDS=0 \
    "$test_script_dir/adopt-existing.sh" --repo "$case_repo" --node "$case_node" "$@"
}

run_cli() {
  HOME="$case_home" \
  XDG_CONFIG_HOME="$case_home/.config" \
  XDG_STATE_HOME="$case_home/.local/state" \
  CODEXNEST_ROOT="$case_home/.local/share/codexnest" \
  CODEXNEST_REPOSITORY_URL="$case_repo" \
  CODEXNEST_UPDATE_CHANNEL="${CODEXNEST_UPDATE_CHANNEL:-}" \
  CODEXNEST_HEALTH_ATTEMPTS=1 \
  CODEXNEST_HEALTH_DELAY_SECONDS=0 \
  PATH="$case_fake_bin:/usr/bin:/bin" \
    "$case_home/.local/bin/codexnest" "$@"
}

prepare_case success
run_adoption --dry-run >/dev/null
run_adoption >/dev/null
run_adoption >/dev/null
grep -q '^CUSTOM_SETTING=keep$' "$case_home/.config/codexnest/server.env"
grep -q '^CODEXNEST_MANAGED_INSTALL=true$' "$case_home/.config/codexnest/server.env"
grep -q '^CODEXNEST_UPDATE_CHANNEL=rolling$' "$case_home/.config/codexnest/server.env"
grep -q 'Environment=PRESERVED_DROP_IN=true' \
  "$case_home/.config/systemd/user/codexnest.service.d/preserved.conf"
test -x "$case_home/.local/bin/codexnest"
test -f "$case_home/.config/systemd/user/codexnest-update.service"
grep -q '^KillMode=process$' "$case_home/.config/systemd/user/codexnest.service"
test "$(basename "$(readlink -f "$case_home/.local/share/codexnest/current")")" = v0.1.0
test -z "$(find "$case_home/.local/state/codexnest" -maxdepth 1 -name 'adoption-backup.*' -print -quit)"
success_commit="$(git -C "$case_repo" rev-parse codex/mvp)"
success_version="0.1.1-${success_commit:0:7}"
run_cli update-worker >/dev/null
test "$(basename "$(readlink -f "$case_home/.local/share/codexnest/current")")" = "v$success_version"
test "$(basename "$(readlink -f "$case_home/.local/share/codexnest/previous")")" = v0.1.0
test "$(cat "$case_home/.local/share/codexnest/current/.codexnest-built")" = "$success_commit"
grep -q '^KillMode=process$' "$case_home/.config/systemd/user/codexnest.service"
grep -q '"result":"updated"' "$case_home/.local/state/codexnest/update.json"
run_cli check-update | grep -q '"updateAvailable":false'
touch "$case_home/managed-team-work"
run_cli restart >/dev/null
sed -i 's/"runtimeRecoveryProtocolVersion": 2/"runtimeRecoveryProtocolVersion": 1/' \
  "$case_home/.local/share/codexnest/current/deploy/restart-protocol.json"
if run_cli restart >/dev/null 2>&1; then
  printf '%s\n' 'Expected restart to reject a mismatched recovery protocol' >&2
  exit 1
fi

prepare_case stable_channel
run_adoption >/dev/null
CODEXNEST_UPDATE_CHANNEL=stable run_cli update-worker >/dev/null
test "$(basename "$(readlink -f "$case_home/.local/share/codexnest/current")")" = v0.1.1
grep -q '"latestVersion":"0.1.1"' "$case_home/.local/state/codexnest/update.json"

prepare_case build_failure
run_adoption >/dev/null
touch "$case_home/fail-build"
if run_cli update-worker >/dev/null 2>&1; then
  printf '%s\n' 'Expected managed update build failure' >&2
  exit 1
fi
test "$(basename "$(readlink -f "$case_home/.local/share/codexnest/current")")" = v0.1.0
grep -q '"result":"failed"' "$case_home/.local/state/codexnest/update.json"

prepare_case invalid_manifest
run_adoption >/dev/null
touch "$case_home/invalid-manifest"
if run_cli check-update >/dev/null 2>&1; then
  printf '%s\n' 'Expected invalid rolling manifest failure' >&2
  exit 1
fi
test "$(basename "$(readlink -f "$case_home/.local/share/codexnest/current")")" = v0.1.0

prepare_case rolling_rollback
run_adoption >/dev/null
touch "$case_home/fail-rolling-health"
if run_cli update-worker >/dev/null 2>&1; then
  printf '%s\n' 'Expected rolling update health failure' >&2
  exit 1
fi
test "$(basename "$(readlink -f "$case_home/.local/share/codexnest/current")")" = v0.1.0
grep -q '"result":"rolled_back"' "$case_home/.local/state/codexnest/update.json"

prepare_case rollback
cp "$case_home/.config/codexnest/server.env" "$test_root/rollback-env"
cp "$case_home/.config/systemd/user/codexnest.service" "$test_root/rollback-service"
touch "$case_home/fail-health"
if run_adoption >/dev/null 2>&1; then
  printf '%s\n' 'Expected adoption health failure' >&2
  exit 1
fi
cmp "$test_root/rollback-env" "$case_home/.config/codexnest/server.env"
cmp "$test_root/rollback-service" "$case_home/.config/systemd/user/codexnest.service"
grep -q '"tokenSha256":"0000000000000000000000000000000000000000000000000000000000000000"' \
  "$case_home/.local/state/codexnest/state.json"

printf '%s\n' 'CodexNest adoption tests passed.'
