#!/usr/bin/env bash
set -euo pipefail
[[ "$HOME" == /home/nest-qualification && "$(id -u)" == 17001 ]]
systemctl --user is-active --quiet default.target
mkdir -p "$HOME/.codex"
chmod 0700 "$HOME/.codex"
if [[ ! -f "$HOME/.codex/config.toml" ]]; then
  printf '[features]\nrespect_system_proxy = true\n[analytics]\nenabled = false\n' > "$HOME/.codex/config.toml"
fi
mapfile -t native_binaries < <(find /opt/native/node_modules -type f -name codex -executable)
(( ${#native_binaries[@]} == 1 ))
sha256sum "${native_binaries[0]}" > /qualification-output/native-binary-sha256.txt
if [[ "$NATIVE_VERSION" == 0.154.0 ]]; then
  # The older daemon requires a flat managed standalone install. Newer versions
  # require the complete package instead; retain their unmodified NPM launcher.
  native_version_home="$HOME/.codex/packages/standalone/releases/$NATIVE_VERSION"
  mkdir -p "$native_version_home/bin" "$HOME/.local/bin"
  install -m 0755 "${native_binaries[0]}" "$native_version_home/codex"
  ln -s ../codex "$native_version_home/bin/codex"
  ln -s "$native_version_home" "$HOME/.codex/packages/standalone/current"
  ln -s "$HOME/.codex/packages/standalone/current/codex" "$HOME/.local/bin/codex"
  export PATH="$HOME/.local/bin:$PATH"
fi
# No real auth is present. Even unauthenticated background discovery must not
# leave this disposable fixture through a direct provider connection.
qualification_proxy=http://127.0.0.1:9
if [[ "$QUALIFICATION_MODE" == lifecycle ]]; then
  qualification_proxy=http://127.0.0.1:9001
  systemctl --user set-environment \
    CODEX_CA_CERTIFICATE=/usr/local/share/ca-certificates/nest-qualification.crt \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    CODEX_REFRESH_TOKEN_URL_OVERRIDE=https://127.0.0.2:9000/oauth/token \
    CODEX_APP_SERVER_LOGIN_ISSUER=https://127.0.0.2:9000
fi
systemctl --user set-environment \
  "HTTP_PROXY=$qualification_proxy" "HTTPS_PROXY=$qualification_proxy" "ALL_PROXY=$qualification_proxy" \
  "http_proxy=$qualification_proxy" "https_proxy=$qualification_proxy" "all_proxy=$qualification_proxy" \
  NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1
codex --enable respect_system_proxy app-server daemon bootstrap > /qualification-output/bootstrap.log 2>&1
codex app-server daemon version > /qualification-output/native-version.json
test -S "$HOME/.codex/app-server-control/app-server-control.sock"
systemctl --user list-units --type=service --all --plain --no-legend > /qualification-output/user-services.txt
python3 - <<'PY'
import json,os
from pathlib import Path
root=Path('/qualification-output')
version=json.loads((root/'native-version.json').read_text())
assert version['cliVersion']==os.environ['NATIVE_VERSION'], version
assert version['appServerVersion']==os.environ['NATIVE_VERSION'], version
assert version['status'] in ('running','ready'), version
PY
if [[ "$QUALIFICATION_MODE" == lifecycle ]]; then
  export PATH="$HOME/.local/bin:$PATH"
  node /qualification-input/lifecycle.mjs
fi
