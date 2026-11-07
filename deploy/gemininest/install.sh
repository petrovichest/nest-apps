#!/usr/bin/env bash
set -euo pipefail

gemininest_default_ref="main"
gemininest_ref="${GEMININEST_REF:-$gemininest_default_ref}"
gemininest_root="${XDG_DATA_HOME:-$HOME/.local/share}/gemininest"
gemininest_repo="${GEMININEST_REPOSITORY_URL:-https://github.com/petrovichest/nest-apps.git}"
command -v git >/dev/null
command -v npm >/dev/null
node -e 'if(Number(process.versions.node.split(".")[0]) !== 24) throw new Error("Node 24 is required")'
if [[ -z "${GEMININEST_AGY_BIN:-}" ]]; then
  command -v agy >/dev/null || { echo 'Install Antigravity CLI from https://antigravity.google/docs/getting-started/ first.' >&2; exit 1; }
fi
mkdir -p "$gemininest_root/releases"
gemininest_checkout="$(mktemp -d "$gemininest_root/releases/install-XXXXXXXX")"
git -C "$gemininest_checkout" init -q
git -C "$gemininest_checkout" remote add origin "$gemininest_repo"
git -C "$gemininest_checkout" fetch --depth=1 origin "$gemininest_ref"
git -C "$gemininest_checkout" checkout --detach FETCH_HEAD
gemininest_commit="$(git -C "$gemininest_checkout" rev-parse HEAD)"
gemininest_release="$gemininest_root/releases/$gemininest_commit"
if [[ -e "$gemininest_release" ]]; then
  echo 'This release already exists. Use its setup command after checking the existing GeminiNest services.' >&2
  exit 1
fi
mv "$gemininest_checkout" "$gemininest_release"
cd "$gemininest_release"
npm ci --include=dev
npm run build:gemini
node apps/gemini-server/scripts/manage.mjs setup --release "$gemininest_release" --start
