#!/usr/bin/env bash

set -euo pipefail

codexnest_repository="https://github.com/petrovichest/nest-apps.git"
codexnest_default_version="__CODEXNEST_VERSION__"
codexnest_default_ref="__CODEXNEST_REF__"
codexnest_node_version="24.18.0"
codexnest_requested_version="${CODEXNEST_VERSION:-$codexnest_default_version}"
codexnest_dry_run=false

while (($# > 0)); do
  case "$1" in
    --version)
      [[ $# -ge 2 ]] || { printf '%s\n' '--version requires a value' >&2; exit 2; }
      codexnest_requested_version="$2"
      shift 2
      ;;
    --dry-run)
      codexnest_dry_run=true
      shift
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

codexnest_log() { printf '\n==> %s\n' "$1"; }
codexnest_die() { printf 'CodexNest installer: %s\n' "$1" >&2; exit 1; }

[[ "$(uname -s)" == "Linux" ]] || codexnest_die "only Linux is supported"
[[ -r /etc/os-release ]] || codexnest_die "Ubuntu or Debian is required"
codexnest_os_family="$(. /etc/os-release; printf '%s %s' "${ID:-}" "${ID_LIKE:-}")"
case " $codexnest_os_family " in
  *" ubuntu "*|*" debian "*) ;;
  *) codexnest_die "Ubuntu or Debian is required" ;;
esac
if ! $codexnest_dry_run; then
  [[ -d /run/systemd/system ]] || codexnest_die "systemd is required"
fi
(( EUID != 0 )) || codexnest_die "run the installer as a regular user, not root"

case "$(uname -m)" in
  x86_64|amd64) codexnest_node_arch=x64 ;;
  aarch64|arm64) codexnest_node_arch=arm64 ;;
  *) codexnest_die "only amd64 and arm64 are supported" ;;
esac

if $codexnest_dry_run; then
  printf 'CodexNest dry run: Linux/%s, Node.js %s, repository %s\n' \
    "$codexnest_node_arch" "$codexnest_node_version" "$codexnest_repository"
  exit 0
fi

command -v curl >/dev/null 2>&1 || codexnest_die "curl is required"

codexnest_missing_packages=()
command -v git >/dev/null 2>&1 || codexnest_missing_packages+=(git)
command -v xz >/dev/null 2>&1 || codexnest_missing_packages+=(xz-utils)
command -v sha256sum >/dev/null 2>&1 || codexnest_missing_packages+=(coreutils)
if ((${#codexnest_missing_packages[@]} > 0)); then
  command -v apt-get >/dev/null 2>&1 || codexnest_die "Ubuntu/Debian with apt is required"
  command -v sudo >/dev/null 2>&1 || codexnest_die "sudo is required to install system packages"
  codexnest_log "Installing ${codexnest_missing_packages[*]}"
  sudo apt-get update
  sudo apt-get install -y ca-certificates "${codexnest_missing_packages[@]}"
fi

codexnest_root="${CODEXNEST_ROOT:-$HOME/.local/share/codexnest}"
codexnest_source="$codexnest_root/source"
codexnest_releases="$codexnest_root/releases"
codexnest_runtime="$codexnest_root/runtime"
codexnest_config_root="${XDG_CONFIG_HOME:-$HOME/.config}/codexnest"
codexnest_config="$codexnest_config_root/server.env"
codexnest_state_root="${XDG_STATE_HOME:-$HOME/.local/state}/codexnest"
codexnest_state="$codexnest_state_root/state.json"
codexnest_database="$codexnest_state_root/state.sqlite"
codexnest_service_root="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

mkdir -p "$codexnest_root" "$codexnest_releases" "$codexnest_runtime" \
  "$codexnest_config_root" "$codexnest_state_root" "$codexnest_service_root" "$HOME/.local/bin"
chmod 700 "$codexnest_config_root" "$codexnest_state_root"

codexnest_node_directory="$codexnest_runtime/node-v$codexnest_node_version-linux-$codexnest_node_arch"
if [[ ! -x "$codexnest_node_directory/bin/node" ]]; then
  codexnest_log "Installing private Node.js $codexnest_node_version runtime"
  codexnest_temporary="$(mktemp -d)"
  trap 'rm -rf "$codexnest_temporary"' EXIT
  codexnest_archive="node-v$codexnest_node_version-linux-$codexnest_node_arch.tar.xz"
  codexnest_node_url="https://nodejs.org/dist/v$codexnest_node_version"
  curl -fsSL "$codexnest_node_url/$codexnest_archive" -o "$codexnest_temporary/$codexnest_archive"
  codexnest_checksum="$(curl -fsSL "$codexnest_node_url/SHASUMS256.txt" | awk -v name="$codexnest_archive" '$2 == name { print $1 }')"
  [[ "$codexnest_checksum" =~ ^[0-9a-f]{64}$ ]] || codexnest_die "Node.js checksum is unavailable"
  (cd "$codexnest_temporary" && printf '%s  %s\n' "$codexnest_checksum" "$codexnest_archive" | sha256sum -c -)
  tar -xJf "$codexnest_temporary/$codexnest_archive" -C "$codexnest_runtime"
fi
ln -sfn "$codexnest_node_directory" "$codexnest_runtime/current"

codexnest_log "Preparing CodexNest source"
if [[ -d "$codexnest_source/.git" ]]; then
  git -C "$codexnest_source" remote set-url origin "$codexnest_repository"
  git -C "$codexnest_source" fetch --prune origin \
    '+refs/heads/*:refs/remotes/origin/*' \
    'refs/tags/v*:refs/tags/v*'
else
  if [[ -e "$codexnest_source" ]]; then
    rm -rf -- "$codexnest_source"
  fi
  git clone --filter=blob:none --no-checkout "$codexnest_repository" "$codexnest_source"
  git -C "$codexnest_source" fetch --prune origin \
    '+refs/heads/*:refs/remotes/origin/*' \
    'refs/tags/v*:refs/tags/v*'
fi

if [[ "$codexnest_requested_version" == "__CODEXNEST_VERSION__" ]]; then
  codexnest_requested_version="$(
    git -C "$codexnest_source" tag --list 'v[0-9]*' --sort=-v:refname \
      | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1
  )"
fi
if [[ "$codexnest_requested_version" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  [[ "$codexnest_requested_version" == v* ]] \
    || codexnest_requested_version="v$codexnest_requested_version"
  codexnest_version="${codexnest_requested_version#v}"
  codexnest_requested_ref="$codexnest_requested_version"
elif [[ "$codexnest_requested_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-[0-9a-f]{7}$ ]]; then
  codexnest_version="$codexnest_requested_version"
  codexnest_requested_ref="$codexnest_default_ref"
  [[ "$codexnest_requested_ref" =~ ^[0-9a-f]{40}$ ]] \
    && [[ "$codexnest_version" == *-"${codexnest_requested_ref:0:7}" ]] \
    || codexnest_die "the rolling release reference is invalid"
else
  codexnest_die "a stable semver or rolling release is required"
fi
codexnest_resolved_ref="$(
  git -C "$codexnest_source" rev-parse --verify "$codexnest_requested_ref^{commit}" 2>/dev/null
)" || codexnest_die "release $codexnest_requested_version does not exist"

codexnest_release="$codexnest_releases/v$codexnest_version"
if [[ ! -f "$codexnest_release/.codexnest-built" || \
      "$(cat "$codexnest_release/.codexnest-built" 2>/dev/null)" != "$codexnest_resolved_ref" || \
      ! -f "$codexnest_release/apps/server/dist/index.js" || \
      ! -f "$codexnest_release/apps/client/dist/index.html" ]]; then
  codexnest_log "Building CodexNest $codexnest_requested_version"
  git -C "$codexnest_source" worktree remove --force "$codexnest_release" 2>/dev/null || true
  if [[ -e "$codexnest_release" ]]; then
    rm -rf -- "$codexnest_release"
  fi
  git -C "$codexnest_source" worktree prune
  git -C "$codexnest_source" worktree add --detach "$codexnest_release" "$codexnest_resolved_ref"
  codexnest_node_bin="$codexnest_runtime/current/bin"
  (
    cd "$codexnest_release"
    PATH="$codexnest_node_bin:$PATH" "$codexnest_node_bin/npm" ci
    PATH="$codexnest_node_bin:$PATH" CODEXNEST_VERSION="$codexnest_version" \
      "$codexnest_node_bin/npm" run build
    printf '%s\n' "$codexnest_resolved_ref" > .codexnest-built
  ) || {
    git -C "$codexnest_source" worktree remove --force "$codexnest_release" || true
    codexnest_die "build failed"
  }
fi

codexnest_old_current="$(readlink -f "$codexnest_root/current" 2>/dev/null || true)"
if [[ -n "$codexnest_old_current" && "$codexnest_old_current" != "$codexnest_release" ]]; then
  ln -sfn "$codexnest_old_current" "$codexnest_root/previous"
fi
ln -sfn "$codexnest_release" "$codexnest_root/current"

codexnest_codex_bin="$(command -v codex 2>/dev/null || true)"
[[ -n "$codexnest_codex_bin" ]] || codexnest_codex_bin=codex
if [[ ! -f "$codexnest_config" ]]; then
  codexnest_log "Creating production configuration"
  umask 077
  {
    printf 'NODE_ENV=production\n'
    printf 'CODEXNEST_HOST=0.0.0.0\n'
    printf 'CODEXNEST_PORT=4310\n'
    printf 'CODEXNEST_ALLOWED_ORIGINS=http://localhost\n'
    printf 'CODEXNEST_STATE_PATH=%s\n' "$codexnest_state"
    printf 'CODEXNEST_DATABASE_PATH=%s\n' "$codexnest_database"
    printf 'CODEXNEST_CODEX_BIN=%s\n' "$codexnest_codex_bin"
    printf 'CODEXNEST_CODEX_MANAGEMENT_BIN=%s\n' "$codexnest_codex_bin"
    printf 'CODEXNEST_CODEX_TRANSPORT=daemon\n'
    printf 'CODEXNEST_CLIENT_DIST=%s/apps/client/dist\n' "$codexnest_root/current"
    printf 'CODEXNEST_SERVER_ENV_FILE=%s\n' "$codexnest_config"
    printf 'CODEXNEST_MANAGED_INSTALL=true\n'
    printf 'CODEXNEST_MANAGEMENT_CLI=%s/.local/bin/codexnest\n' "$HOME"
    printf 'CODEXNEST_UPDATE_STATUS_PATH=%s/update.json\n' "$codexnest_state_root"
    printf 'CODEXNEST_UPDATE_CHANNEL=rolling\n'
    printf 'CODEXNEST_VERSION=%s\n' "$codexnest_version"
  } > "$codexnest_config"
  chmod 600 "$codexnest_config"
fi

codexnest_set_env_value() {
  local key="$1" value="$2" temporary="$codexnest_config.$$"
  awk -v key="$key" -v value="$value" '
    BEGIN { replaced = 0 }
    index($0, key "=") == 1 { print key "=" value; replaced = 1; next }
    { print }
    END { if (!replaced) print key "=" value }
  ' "$codexnest_config" > "$temporary"
  chmod 600 "$temporary"
  mv -f "$temporary" "$codexnest_config"
}
codexnest_ensure_env_value() {
  local key="$1" value="$2"
  grep -q "^${key}=" "$codexnest_config" 2>/dev/null || codexnest_set_env_value "$key" "$value"
}
codexnest_ensure_env_value NODE_ENV production
codexnest_ensure_env_value CODEXNEST_HOST 0.0.0.0
codexnest_ensure_env_value CODEXNEST_PORT 4310
codexnest_ensure_env_value CODEXNEST_ALLOWED_ORIGINS http://localhost
codexnest_ensure_env_value CODEXNEST_STATE_PATH "$codexnest_state"
codexnest_ensure_env_value CODEXNEST_DATABASE_PATH "$codexnest_database"
codexnest_ensure_env_value CODEXNEST_CODEX_BIN "$codexnest_codex_bin"
codexnest_ensure_env_value CODEXNEST_CODEX_MANAGEMENT_BIN "$codexnest_codex_bin"
codexnest_ensure_env_value CODEXNEST_CODEX_TRANSPORT daemon
codexnest_ensure_env_value CODEXNEST_SERVER_ENV_FILE "$codexnest_config"
codexnest_set_env_value CODEXNEST_CLIENT_DIST "$codexnest_root/current/apps/client/dist"
codexnest_set_env_value CODEXNEST_MANAGED_INSTALL true
codexnest_set_env_value CODEXNEST_MANAGEMENT_CLI "$HOME/.local/bin/codexnest"
codexnest_set_env_value CODEXNEST_UPDATE_STATUS_PATH "$codexnest_state_root/update.json"
codexnest_ensure_env_value CODEXNEST_UPDATE_CHANNEL rolling
codexnest_set_env_value CODEXNEST_VERSION "$codexnest_version"

install -m 0755 "$codexnest_release/deploy/codexnest" "$HOME/.local/bin/codexnest"
install -m 0644 "$codexnest_release/deploy/systemd/codexnest-managed.service" \
  "$codexnest_service_root/codexnest.service"
install -m 0644 "$codexnest_release/deploy/systemd/codexnest-update.service" \
  "$codexnest_service_root/codexnest-update.service"

codexnest_token=""
if [[ ! -f "$codexnest_state" ]] || ! grep -q '"tokenSha256"' "$codexnest_state"; then
  codexnest_log "Generating owner access token"
  codexnest_token="$(
    set -a
    . "$codexnest_config"
    set +a
    cd "$codexnest_release"
    PATH="$codexnest_runtime/current/bin:$PATH" \
      "$codexnest_runtime/current/bin/npm" run --silent auth:generate -w @codexnest/server
  )"
fi

if command -v codex >/dev/null 2>&1; then
  codexnest_log "Bootstrapping Codex daemon"
  codex app-server daemon bootstrap || printf '%s\n' 'Codex daemon is not ready; run codexnest repair later.' >&2
else
  printf '%s\n' 'Codex CLI was not found. CodexNest will start in diagnostic mode.' >&2
  printf '%s\n' 'Install Codex CLI, sign in, then run: codexnest repair' >&2
fi

if command -v loginctl >/dev/null 2>&1; then
  codexnest_linger="$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)"
  if [[ "$codexnest_linger" != yes ]]; then
    command -v sudo >/dev/null 2>&1 \
      && sudo loginctl enable-linger "$(id -un)" \
      || printf '%s\n' 'Could not enable linger; the service may stop after logout.' >&2
  fi
fi

systemctl --user daemon-reload
systemctl --user enable --now codexnest.service

codexnest_log "Waiting for CodexNest"
codexnest_ready=false
for codexnest_attempt in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:4310/api/v1/health >/dev/null 2>&1; then
    codexnest_ready=true
    break
  fi
  sleep 1
done
$codexnest_ready || codexnest_die "service did not become ready; run codexnest logs"

codexnest_lan_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
[[ -n "$codexnest_lan_ip" ]] || codexnest_lan_ip=127.0.0.1
printf '\nCodexNest %s is ready.\n' "${codexnest_requested_version#v}"
printf 'URL: http://%s:4310\n' "$codexnest_lan_ip"
if [[ -n "$codexnest_token" ]]; then
  printf 'Bearer token (shown once): %s\n' "$codexnest_token"
else
  printf '%s\n' 'Bearer token was preserved; use the credential saved during the first install.'
fi
printf '%s\n' 'Keep port 4310 inside your trusted LAN or VPN; do not forward it publicly.'
