#!/usr/bin/env bash
set -euo pipefail

# Publication substitutes these only after qualifying these exact installer bytes.
opennest_default_version="__OPENNEST_VERSION__"
opennest_default_ref="__OPENNEST_REF__"
if [[ ! "$opennest_default_ref" =~ ^[0-9a-f]{40}$ || ! "$opennest_default_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-[0-9a-f]{7}$ ]]; then
  echo 'OpenNest has no qualified published installer yet. This source template cannot install a release.' >&2
  exit 1
fi
if [[ "${opennest_default_version##*-}" != "${opennest_default_ref:0:7}" ]]; then
  echo 'OpenNest installer version does not match its pinned commit.' >&2
  exit 1
fi
opennest_root="${XDG_DATA_HOME:-$HOME/.local/share}/opennest"
opennest_config_root="${OPENNEST_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opennest}"
opennest_repo="${OPENNEST_REPOSITORY_URL:-https://github.com/petrovichest/nest-apps.git}"
if [[ -e "$opennest_root/current" || -L "$opennest_root/current" || -f "$opennest_config_root/server.env" ]]; then
  echo 'An OpenNest installation already exists. Upgrade support waits for native rollback qualification.' >&2
  exit 1
fi
if [[ -x "$HOME/.local/node-v24/bin/node" ]]; then
  export PATH="$HOME/.local/node-v24/bin:$PATH"
fi
command -v git >/dev/null
command -v npm >/dev/null
command -v flock >/dev/null
command -v /usr/bin/bwrap >/dev/null || { echo 'Install bubblewrap (/usr/bin/bwrap) for OpenNest Team isolation first.' >&2; exit 1; }
node -e 'if(Number(process.versions.node.split(".")[0]) !== 24) throw new Error("Node 24 is required")'
opennest_native="${OPENNEST_OPENCODE_BIN:-opencode}"
command -v "$opennest_native" >/dev/null || { echo 'Install OpenCode 1.19.5 or set OPENNEST_OPENCODE_BIN first.' >&2; exit 1; }
mkdir -p "$opennest_root/releases"
opennest_checkout="$(mktemp -d "$opennest_root/releases/install-XXXXXXXX")"
trap 'rm -rf "$opennest_checkout"' EXIT
git -C "$opennest_checkout" init -q
git -C "$opennest_checkout" remote add origin "$opennest_repo"
git -C "$opennest_checkout" fetch --depth=1 origin "$opennest_default_ref"
git -C "$opennest_checkout" checkout --detach FETCH_HEAD
opennest_commit="$(git -C "$opennest_checkout" rev-parse HEAD)"
[[ "$opennest_commit" == "$opennest_default_ref" ]] || { echo 'OpenNest Git commit does not match the installer.' >&2; exit 1; }
opennest_release="$opennest_root/releases/v$opennest_default_version"
if [[ -e "$opennest_release" ]]; then
  echo 'The target release directory already exists; refusing to overwrite it.' >&2
  exit 1
fi
mv "$opennest_checkout" "$opennest_release"
(
  cd "$opennest_release"
  npm ci --include=dev
  OPENNEST_VERSION="$opennest_default_version" VITE_APP_VERSION="$opennest_default_version" npm run build:open
  printf '%s\n' "$opennest_commit" > .opennest-built
)
OPENNEST_VERSION="$opennest_default_version" node "$opennest_release/apps/open-server/scripts/manage.mjs" setup --release "$opennest_release" --start
