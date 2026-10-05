#!/usr/bin/env bash
# Run as administrator only after the local ClaudeNest release has passed checks.
# Usage: sudo bash install-lan.sh [existing-ca.crt existing-ca.key]
set -euo pipefail
if [[ ${EUID} -ne 0 || ( $# -ne 0 && $# -ne 2 ) ]]; then
  echo 'Usage: sudo bash install-lan.sh [existing-ca.crt existing-ca.key]' >&2
  exit 2
fi
if [[ $# -eq 0 ]]; then
  script_directory=$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")
  pair=$(bash "$script_directory/find-lan-ca.sh")
  IFS=$'\t' read -r ca_cert ca_key <<< "$pair"
else
  ca_cert=$1
  ca_key=$2
fi
caddy_config=/etc/caddy/Caddyfile
codex_cert=/etc/caddy/certs/codex.home.arpa.crt
cert_directory=/etc/caddy/certs
[[ -f "$ca_cert" && -f "$ca_key" && -f "$codex_cert" && -f "$caddy_config" ]]
# Prove this is the CA already trusted for Codex. Never invent or replace a CA.
openssl verify -CAfile "$ca_cert" "$codex_cert" >/dev/null
if rg -q 'claude\.home\.arpa' "$caddy_config"; then
  echo 'Claude host already exists in Caddy; inspect it before applying this script.' >&2
  exit 1
fi
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
chmod 700 "$temporary"
openssl req -new -newkey rsa:2048 -nodes -keyout "$temporary/claude.key" \
  -out "$temporary/claude.csr" -subj '/CN=claude.home.arpa' >/dev/null 2>&1
cat > "$temporary/extensions" <<'EXTENSIONS'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:claude.home.arpa
EXTENSIONS
serial=$(openssl rand -hex 16)
openssl x509 -req -in "$temporary/claude.csr" -CA "$ca_cert" -CAkey "$ca_key" \
  -set_serial "0x$serial" -days 365 -sha256 -extfile "$temporary/extensions" \
  -out "$temporary/claude.crt" >/dev/null
openssl verify -CAfile "$ca_cert" "$temporary/claude.crt" >/dev/null
install -o root -g caddy -m 0644 "$temporary/claude.crt" "$cert_directory/claude.home.arpa.crt"
install -o root -g caddy -m 0640 "$temporary/claude.key" "$cert_directory/claude.home.arpa.key"
cp "$caddy_config" "$temporary/Caddyfile"
cat >> "$temporary/Caddyfile" <<'CADDY'

https://claude.home.arpa {
  tls /etc/caddy/certs/claude.home.arpa.crt /etc/caddy/certs/claude.home.arpa.key
  reverse_proxy 127.0.0.1:4311
}

http://claude.home.arpa {
  redir https://claude.home.arpa{uri} 308
}
CADDY
caddy validate --config "$temporary/Caddyfile" --adapter caddyfile
backup="${caddy_config}.before-claude-$(date -u +%Y%m%dT%H%M%SZ)"
cp -p "$caddy_config" "$backup"
install -o root -g root -m 0644 "$temporary/Caddyfile" "${caddy_config}.claude-new"
mv "${caddy_config}.claude-new" "$caddy_config"
if ! systemctl reload caddy; then
  cp -p "$backup" "$caddy_config"
  systemctl reload caddy
  echo 'Caddy reload failed; the original configuration was restored.' >&2
  exit 1
fi
echo 'ClaudeNest host configured. Existing Codex routes and certificate were preserved.'
