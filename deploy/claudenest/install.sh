#!/usr/bin/env bash
set -euo pipefail

claudenest_default_version="__CLAUDENEST_VERSION__"
claudenest_default_ref="__CLAUDENEST_REF__"
claudenest_repository="${CLAUDENEST_REPOSITORY_URL:-https://github.com/petrovichest/nest-apps.git}"
claudenest_root="${XDG_DATA_HOME:-$HOME/.local/share}/claudenest"
claudenest_node_version="24.18.0"

[[ "$(uname -s)" == Linux ]] || { echo 'ClaudeNest requires Linux' >&2; exit 1; }
(( EUID != 0 )) || { echo 'Run the installer as a regular user' >&2; exit 1; }
case "$(uname -m)" in
  x86_64|amd64) claudenest_arch=x64 ;;
  aarch64|arm64) claudenest_arch=arm64 ;;
  *) echo 'ClaudeNest supports amd64 and arm64' >&2; exit 1 ;;
esac
if [[ "${1:-}" == --dry-run ]]; then
  printf 'ClaudeNest: Linux/%s, Node %s, repository %s\n' "$claudenest_arch" "$claudenest_node_version" "$claudenest_repository"
  exit 0
fi
[[ $# == 0 ]] || { echo 'Usage: install-claudenest.sh [--dry-run]' >&2; exit 2; }
[[ -d /run/systemd/system ]] || { echo 'ClaudeNest requires systemd' >&2; exit 1; }
command -v claude >/dev/null || { echo 'Install Claude Code and sign in before installing ClaudeNest' >&2; exit 1; }
command -v flock >/dev/null
command -v git >/dev/null
command -v curl >/dev/null
claudenest_config_root="${XDG_CONFIG_HOME:-$HOME/.config}/claudenest"
mkdir -p "$claudenest_config_root"
chmod 0700 "$claudenest_config_root"
exec 9>"$claudenest_config_root/manage.lock"
flock --nonblock 9 || { echo 'Another ClaudeNest management operation is active' >&2; exit 1; }

# Enable proxy support before starting the private Node runtime. Preserve the
# existing ClaudeNest configuration and normal Claude authentication.
export NODE_USE_ENV_PROXY=1
export NO_PROXY="${NO_PROXY:+$NO_PROXY,}127.0.0.1,localhost"
export no_proxy="${no_proxy:+$no_proxy,}127.0.0.1,localhost"
claudenest_temporary="$(mktemp -d)"
trap 'rm -rf "$claudenest_temporary"' EXIT
mkdir -p "$claudenest_root/runtime" "$claudenest_root/releases"
claudenest_node_directory="$claudenest_root/runtime/node-v$claudenest_node_version-linux-$claudenest_arch"
if [[ ! -x "$claudenest_node_directory/bin/node" ]]; then
  claudenest_archive="node-v$claudenest_node_version-linux-$claudenest_arch.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v$claudenest_node_version/$claudenest_archive" -o "$claudenest_temporary/$claudenest_archive"
  curl -fsSL "https://nodejs.org/dist/v$claudenest_node_version/SHASUMS256.txt" -o "$claudenest_temporary/SHASUMS256.txt"
  claudenest_checksum="$(awk -v name="$claudenest_archive" '$2 == name { print $1 }' "$claudenest_temporary/SHASUMS256.txt")"
  [[ "$claudenest_checksum" =~ ^[0-9a-f]{64}$ ]]
  (cd "$claudenest_temporary" && printf '%s  %s\n' "$claudenest_checksum" "$claudenest_archive" | sha256sum -c -)
  tar -xJf "$claudenest_temporary/$claudenest_archive" -C "$claudenest_root/runtime"
fi
ln -sfn "$claudenest_node_directory" "$claudenest_root/runtime/current"
export PATH="$claudenest_root/runtime/current/bin:$PATH"
if [[ "$claudenest_default_ref" == __CLAUDENEST_REF__ ]]; then
  curl -fsSL 'https://github.com/petrovichest/nest-apps/releases/download/rolling-latest/NestApps-latest.json' -o "$claudenest_temporary/release.json"
  claudenest_default_ref="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).commit" "$claudenest_temporary/release.json")"
  claudenest_default_version="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).version" "$claudenest_temporary/release.json")"
fi
[[ "$claudenest_default_ref" =~ ^[0-9a-f]{40}$ ]]
[[ "$claudenest_default_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9a-f]{7})?$ ]]
if [[ "$claudenest_default_version" == *-* ]]; then
  [[ "$claudenest_default_version" == *-"${claudenest_default_ref:0:7}" ]]
fi

claudenest_source="$claudenest_root/source"
if [[ ! -d "$claudenest_source/.git" ]]; then
  git clone --filter=blob:none --no-checkout "$claudenest_repository" "$claudenest_source"
fi
git -C "$claudenest_source" remote set-url origin "$claudenest_repository"
git -C "$claudenest_source" fetch --prune origin '+refs/heads/*:refs/remotes/origin/*' 'refs/tags/v*:refs/tags/v*'
[[ "$(git -C "$claudenest_source" rev-parse "$claudenest_default_ref^{commit}")" == "$claudenest_default_ref" ]]
claudenest_release="$claudenest_root/releases/v$claudenest_default_version"
# Existing release directories can belong to live session owners. Never rebuild them.
if [[ ! -e "$claudenest_release" ]]; then
  git -C "$claudenest_source" worktree add --detach "$claudenest_release" "$claudenest_default_ref"
  (
    cd "$claudenest_release"
    npm ci --include=dev
    CLAUDENEST_VERSION="$claudenest_default_version" VITE_APP_VERSION="$claudenest_default_version" npm run build:claude
    printf '%s\n' "$claudenest_default_ref" > .claudenest-built
  ) || {
    git -C "$claudenest_source" worktree remove --force "$claudenest_release"
    exit 1
  }
fi
[[ "$(cat "$claudenest_release/.claudenest-built")" == "$claudenest_default_ref" ]]
test -s "$claudenest_release/apps/client/dist-claude/index.html"
if [[ -L "$claudenest_root/current" ]]; then
  node "$claudenest_release/apps/claude-server/scripts/manage.mjs" update --release "$claudenest_release" --locked
else
  loginctl enable-linger "$USER"
  node "$claudenest_release/apps/claude-server/scripts/manage.mjs" setup --release "$claudenest_release" --start --locked
fi
