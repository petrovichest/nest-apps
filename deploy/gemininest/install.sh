#!/usr/bin/env bash
set -euo pipefail

gemininest_default_version="__GEMININEST_VERSION__"
gemininest_default_ref="__GEMININEST_REF__"
gemininest_ref="${GEMININEST_REF:-$gemininest_default_ref}"
gemininest_root="${XDG_DATA_HOME:-$HOME/.local/share}/gemininest"
gemininest_repo="${GEMININEST_REPOSITORY_URL:-https://github.com/petrovichest/nest-apps.git}"
command -v git >/dev/null
command -v npm >/dev/null
command -v curl >/dev/null
command -v flock >/dev/null
node -e 'if(Number(process.versions.node.split(".")[0]) !== 24) throw new Error("Node 24 is required")'
if [[ -z "${GEMININEST_AGY_BIN:-}" ]]; then
  command -v agy >/dev/null || { echo 'Install Antigravity CLI from https://antigravity.google/docs/getting-started/ first.' >&2; exit 1; }
fi
if [[ "$gemininest_ref" == "__GEMININEST_REF__" ]]; then
  gemininest_ref="main"
fi
mkdir -p "$gemininest_root/releases"
gemininest_checkout="$(mktemp -d "$gemininest_root/releases/install-XXXXXXXX")"
trap 'rm -rf "$gemininest_checkout"' EXIT
git -C "$gemininest_checkout" init -q
git -C "$gemininest_checkout" remote add origin "$gemininest_repo"
git -C "$gemininest_checkout" fetch --depth=1 origin "$gemininest_ref"
git -C "$gemininest_checkout" checkout --detach FETCH_HEAD
gemininest_commit="$(git -C "$gemininest_checkout" rev-parse HEAD)"
if [[ "$gemininest_default_version" != "__GEMININEST_VERSION__" ]]; then
  gemininest_version="$gemininest_default_version"
  gemininest_release="$gemininest_root/releases/v$gemininest_version"
else
  gemininest_version="0.1.9-${gemininest_commit:0:7}"
  gemininest_release="$gemininest_root/releases/$gemininest_commit"
fi
if [[ ! -e "$gemininest_release" ]]; then
  mv "$gemininest_checkout" "$gemininest_release"
  (
    cd "$gemininest_release"
    npm ci --include=dev
    GEMININEST_VERSION="$gemininest_version" VITE_APP_VERSION="$gemininest_version" npm run build:gemini
    printf '%s\n' "$gemininest_commit" > .gemininest-built
  )
fi
if [[ -L "$gemininest_root/current" ]]; then
  node "$gemininest_release/apps/gemini-server/scripts/manage.mjs" update --release "$gemininest_release"
else
  node "$gemininest_release/apps/gemini-server/scripts/manage.mjs" setup --release "$gemininest_release" --start
fi
