#!/usr/bin/env bash

set -Eeuo pipefail

adopt_repository=""
adopt_node_root=""
adopt_dry_run=false
adopt_expected_node="24.18.0"

while (($# > 0)); do
  case "$1" in
    --repo)
      [[ $# -ge 2 ]] || { printf '%s\n' '--repo requires a path' >&2; exit 2; }
      adopt_repository="$2"
      shift 2
      ;;
    --node)
      [[ $# -ge 2 ]] || { printf '%s\n' '--node requires a path' >&2; exit 2; }
      adopt_node_root="$2"
      shift 2
      ;;
    --dry-run)
      adopt_dry_run=true
      shift
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

adopt_backup=""
adopt_activation_started=false
adopt_complete=false

adopt_log() { printf '\n==> %s\n' "$1"; }
adopt_die() {
  printf 'CodexNest adoption: %s\n' "$1" >&2
  if $adopt_activation_started && ! $adopt_complete && declare -F adopt_restore >/dev/null; then
    adopt_restore
  fi
  if [[ -n "$adopt_backup" && -d "$adopt_backup" ]]; then
    rm -rf -- "$adopt_backup"
  fi
  exit 1
}

[[ "$(uname -s)" == "Linux" ]] || adopt_die "only Linux is supported"
(( EUID != 0 )) || adopt_die "run adoption as the CodexNest service user, not root"
[[ -n "$adopt_repository" ]] || adopt_die "--repo is required"
[[ -n "$adopt_node_root" ]] || adopt_die "--node is required"

adopt_repository="$(readlink -f "$adopt_repository")"
adopt_node_root="$(readlink -f "$adopt_node_root")"
adopt_node_bin="$adopt_node_root/bin/node"
adopt_npm_bin="$adopt_node_root/bin/npm"
adopt_config_root="${XDG_CONFIG_HOME:-$HOME/.config}/codexnest"
adopt_config="$adopt_config_root/server.env"
adopt_state_root="${XDG_STATE_HOME:-$HOME/.local/state}/codexnest"
adopt_service_root="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
adopt_service="$adopt_service_root/codexnest.service"
adopt_update_service="$adopt_service_root/codexnest-update.service"
adopt_root="${CODEXNEST_ROOT:-$HOME/.local/share/codexnest}"
adopt_root="$(readlink -m "$adopt_root")"
adopt_source="$adopt_root/source"
adopt_releases="$adopt_root/releases"

[[ "$adopt_root" == "$HOME"/* && "$adopt_root" != "$HOME" ]] \
  || adopt_die "managed root must be a directory inside the service user's home"

[[ -d "$adopt_repository/.git" ]] || adopt_die "$adopt_repository is not a Git checkout"
[[ -x "$adopt_node_bin" && -x "$adopt_npm_bin" ]] || adopt_die "Node.js runtime is incomplete"
[[ "$($adopt_node_bin --version)" == "v$adopt_expected_node" ]] \
  || adopt_die "Node.js $adopt_expected_node is required"
[[ -f "$adopt_config" ]] || adopt_die "existing server.env is missing"
[[ -f "$adopt_service" ]] || adopt_die "existing codexnest.service is missing"
[[ -z "$(git -C "$adopt_repository" status --porcelain)" ]] \
  || adopt_die "existing checkout must be clean"

adopt_version="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([0-9][0-9.]*\)".*/\1/p' "$adopt_repository/package.json" | head -n 1)"
[[ "$adopt_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || adopt_die "package version is invalid"
adopt_tag="v$adopt_version"
adopt_head="$(git -C "$adopt_repository" rev-parse HEAD)"
adopt_tag_commit="$(git -C "$adopt_repository" rev-parse "$adopt_tag^{commit}" 2>/dev/null || true)"
[[ "$adopt_tag_commit" == "$adopt_head" ]] || adopt_die "$adopt_tag must point at the deployed commit"

adopt_release_json="$(curl -fsSL \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  "https://api.github.com/repos/petrovichest/nest-apps/releases/tags/$adopt_tag")" \
  || adopt_die "GitHub Release $adopt_tag is not published"
printf '%s' "$adopt_release_json" | "$adopt_node_bin" -e '
  const fs = require("node:fs");
  const release = JSON.parse(fs.readFileSync(0, "utf8"));
  if (release.draft || release.prerelease) process.exit(1);
' || adopt_die "GitHub Release $adopt_tag is not stable"

adopt_state_path="$(awk -F= '$1 == "CODEXNEST_STATE_PATH" { print substr($0, index($0, "=") + 1); exit }' "$adopt_config")"
[[ -n "$adopt_state_path" ]] || adopt_state_path="$adopt_state_root/state.json"
[[ -f "$adopt_state_path" ]] || adopt_die "existing CodexNest state is missing"
adopt_token_before="$($adopt_node_bin -e '
  const fs = require("node:fs");
  const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(state.auth?.tokenSha256 ?? "");
' "$adopt_state_path")"
[[ "$adopt_token_before" =~ ^[0-9a-fA-F]{64}$ ]] || adopt_die "existing bearer token verifier is missing"

adopt_origin="${CODEXNEST_REPOSITORY_URL:-https://github.com/petrovichest/nest-apps.git}"
adopt_release="$adopt_releases/$adopt_tag"

if $adopt_dry_run; then
  printf 'CodexNest adoption dry run succeeded.\n'
  printf 'Repository: %s\n' "$adopt_repository"
  printf 'Release: %s (%s)\n' "$adopt_tag" "${adopt_head:0:12}"
  printf 'Managed root: %s\n' "$adopt_root"
  printf 'Node.js: %s\n' "$adopt_node_root"
  exit 0
fi

mkdir -p "$adopt_root" "$adopt_releases" "$adopt_root/runtime" \
  "$adopt_config_root" "$adopt_state_root" "$adopt_service_root" "$HOME/.local/bin"
chmod 700 "$adopt_config_root" "$adopt_state_root"

adopt_backup="$(mktemp -d "$adopt_state_root/adoption-backup.XXXXXX")"
chmod 700 "$adopt_backup"
cp -p "$adopt_config" "$adopt_backup/server.env"
cp -p "$adopt_service" "$adopt_backup/codexnest.service"

adopt_health_ok() {
  local expected="$1" attempt body
  local attempts="${CODEXNEST_HEALTH_ATTEMPTS:-30}"
  local delay="${CODEXNEST_HEALTH_DELAY_SECONDS:-1}"
  for attempt in $(seq 1 "$attempts"); do
    body="$(curl --fail --silent http://127.0.0.1:4310/api/v1/health 2>/dev/null || true)"
    if [[ "$body" == *'"status":"ok"'* && "$body" == *"\"serverVersion\":\"$expected\""* ]]; then
      return 0
    fi
    sleep "$delay"
  done
  return 1
}

adopt_set_env() {
  local key="$1" value="$2" temporary="$adopt_config.$$"
  awk -v key="$key" -v value="$value" '
    BEGIN { replaced = 0 }
    index($0, key "=") == 1 { print key "=" value; replaced = 1; next }
    { print }
    END { if (!replaced) print key "=" value }
  ' "$adopt_config" > "$temporary"
  chmod 600 "$temporary"
  mv -f "$temporary" "$adopt_config"
}

adopt_restore() {
  trap - ERR INT TERM
  cp -p "$adopt_backup/server.env" "$adopt_config"
  cp -p "$adopt_backup/codexnest.service" "$adopt_service"
  systemctl --user daemon-reload || true
  systemctl --user restart codexnest.service || true
}

adopt_on_failure() {
  local status=$?
  if $adopt_activation_started && ! $adopt_complete; then
    printf '%s\n' 'Adoption failed; restoring the previous service and configuration.' >&2
    adopt_restore
  fi
  if [[ -n "$adopt_backup" && -d "$adopt_backup" ]]; then
    rm -rf -- "$adopt_backup"
  fi
  exit "$status"
}
adopt_on_signal() {
  trap - ERR INT TERM
  if $adopt_activation_started && ! $adopt_complete; then
    adopt_restore
  fi
  if [[ -n "$adopt_backup" && -d "$adopt_backup" ]]; then
    rm -rf -- "$adopt_backup"
  fi
  exit 130
}
trap adopt_on_failure ERR
trap adopt_on_signal INT TERM

adopt_log "Preparing managed source"
if [[ -d "$adopt_source/.git" ]]; then
  git -C "$adopt_source" remote set-url origin "$adopt_origin"
  git -C "$adopt_source" fetch --prune origin \
    '+refs/heads/*:refs/remotes/origin/*' \
    'refs/tags/v*:refs/tags/v*'
else
  if [[ -e "$adopt_source" ]]; then
    rm -rf -- "$adopt_source"
  fi
  git clone --filter=blob:none --no-checkout "$adopt_origin" "$adopt_source"
  git -C "$adopt_source" fetch --prune origin \
    '+refs/heads/*:refs/remotes/origin/*' \
    'refs/tags/v*:refs/tags/v*'
fi
[[ "$(git -C "$adopt_source" rev-parse "$adopt_tag^{commit}")" == "$adopt_head" ]] \
  || adopt_die "managed source resolved $adopt_tag to a different commit"

if [[ ! -f "$adopt_release/.codexnest-built" || \
      ! -f "$adopt_release/apps/server/dist/index.js" || \
      ! -f "$adopt_release/apps/client/dist/index.html" ]]; then
  adopt_log "Building CodexNest $adopt_tag"
  git -C "$adopt_source" worktree remove --force "$adopt_release" 2>/dev/null || true
  if [[ -e "$adopt_release" ]]; then
    rm -rf -- "$adopt_release"
  fi
  git -C "$adopt_source" worktree prune
  git -C "$adopt_source" worktree add --detach "$adopt_release" "$adopt_tag"
  (
    cd "$adopt_release"
    PATH="$adopt_node_root/bin:$PATH" "$adopt_npm_bin" ci
    PATH="$adopt_node_root/bin:$PATH" CODEXNEST_VERSION="$adopt_version" \
      "$adopt_npm_bin" run build
    printf '%s\n' "$adopt_tag" > .codexnest-built
  ) || {
    git -C "$adopt_source" worktree remove --force "$adopt_release" || true
    adopt_die "managed release build failed"
  }
fi

ln -sfn "$adopt_node_root" "$adopt_root/runtime/current"
adopt_current_tmp="$adopt_root/.current.$$"
ln -s "$adopt_release" "$adopt_current_tmp"
mv -Tf "$adopt_current_tmp" "$adopt_root/current"
install -m 0755 "$adopt_release/deploy/codexnest" "$HOME/.local/bin/codexnest"
install -m 0644 "$adopt_release/deploy/systemd/codexnest-update.service" "$adopt_update_service"

adopt_log "Activating managed CodexNest $adopt_tag"
adopt_activation_started=true
adopt_set_env CODEXNEST_CLIENT_DIST "$adopt_root/current/apps/client/dist"
adopt_set_env CODEXNEST_MANAGED_INSTALL true
adopt_set_env CODEXNEST_MANAGEMENT_CLI "$HOME/.local/bin/codexnest"
adopt_set_env CODEXNEST_UPDATE_STATUS_PATH "$adopt_state_root/update.json"
grep -q '^CODEXNEST_UPDATE_CHANNEL=' "$adopt_config" \
  || adopt_set_env CODEXNEST_UPDATE_CHANNEL rolling
adopt_set_env CODEXNEST_VERSION "$adopt_version"
install -m 0644 "$adopt_release/deploy/systemd/codexnest-managed.service" "$adopt_service"
systemctl --user daemon-reload
systemctl --user restart codexnest.service
adopt_health_ok "$adopt_version"

adopt_token_after="$($adopt_node_bin -e '
  const fs = require("node:fs");
  const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(state.auth?.tokenSha256 ?? "");
' "$adopt_state_path")"
[[ "$adopt_token_after" == "$adopt_token_before" ]] || adopt_die "bearer token verifier changed"

adopt_complete=true
trap - ERR INT TERM
rm -rf -- "$adopt_backup"
printf '\nCodexNest %s now uses managed releases.\n' "$adopt_version"
printf 'Current: %s\n' "$adopt_root/current"
printf '%s\n' 'Configuration, state, token, and systemd drop-ins were preserved.'
