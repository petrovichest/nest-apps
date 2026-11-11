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
qualification_native_cli=/opt/native/node_modules/.bin/codex
if [[ "$NATIVE_VERSION" == 0.154.0 ]]; then
  # The older daemon requires a flat managed standalone install. Newer versions
  # require the complete package instead; retain their unmodified NPM launcher.
  native_version_home="$HOME/.codex/packages/standalone/releases/$NATIVE_VERSION"
  mkdir -p "$native_version_home/bin" "$HOME/.local/bin"
  # Preserve the package's real sidecar executables as well as the CLI. The
  # minimum runtime uses the flat standalone path, including its code-mode host.
  cp -a "$(dirname "${native_binaries[0]}")/." "$native_version_home/"
  test -x "$native_version_home/codex"
  test -x "$native_version_home/codex-code-mode-host"
  ln -s ../codex "$native_version_home/bin/codex"
  ln -s "$native_version_home" "$HOME/.codex/packages/standalone/current"
  qualification_native_cli="$HOME/.codex/packages/standalone/current/codex"
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
# Native's PID backend inherits the CLI's environment, not the user manager's.
# Scope the provider proxy to the actual CLI; Git/npm in the updater must still
# reach their artifact registry. Preserve account-runtime private proxy files.
mkdir -p "$HOME/.local/bin" "$HOME/.config/codex"
if [[ ! -f "$HOME/.config/codex/app-server.env" ]]; then
  printf 'HTTP_PROXY=%s\nHTTPS_PROXY=%s\nALL_PROXY=%s\nNO_PROXY=localhost,127.0.0.1,::1\n' \
    "$qualification_proxy" "$qualification_proxy" "$qualification_proxy" > "$HOME/.config/codex/app-server.env"
  chmod 0600 "$HOME/.config/codex/app-server.env"
fi
[[ ! -e "$HOME/.local/bin/codex" && ! -L "$HOME/.local/bin/codex" ]]
cat > "$HOME/.local/bin/codex" <<WRAPPER
#!/usr/bin/env bash
set -euo pipefail
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy
set -a
source "\${CODEXNEST_CODEX_PROXY_ENV_FILE:-\$HOME/.config/codex/app-server.env}"
set +a
if [[ -f /usr/local/share/ca-certificates/nest-qualification.crt ]]; then
  export CODEX_CA_CERTIFICATE=/usr/local/share/ca-certificates/nest-qualification.crt
  export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
  export CODEX_REFRESH_TOKEN_URL_OVERRIDE=https://127.0.0.2:9000/oauth/token
  export CODEX_APP_SERVER_LOGIN_ISSUER=https://127.0.0.2:9000
fi
exec "$qualification_native_cli" "\$@"
WRAPPER
chmod 0700 "$HOME/.local/bin/codex"
export PATH="$HOME/.local/bin:/opt/node/bin:/opt/native/node_modules/.bin:/usr/local/bin:/usr/bin:/bin"
systemctl --user unset-environment HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy
systemctl --user set-environment "PATH=$PATH"
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
