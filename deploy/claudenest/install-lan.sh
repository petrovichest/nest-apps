#!/usr/bin/env bash
# Run as administrator only after the local ClaudeNest release has passed checks.
# Usage: sudo bash install-lan.sh [existing-ca.crt existing-ca.key]
#        sudo bash install-lan.sh --certificate CERT KEY CA_CERT
#        sudo bash install-lan.sh --replace-certificate CERT KEY CA_CERT
set -euo pipefail
if [[ ${EUID} -ne 0 || ( $# -ne 0 && $# -ne 2 && ( $# -ne 4 || ( $1 != --certificate && $1 != --replace-certificate ) ) ) ]]; then
  echo 'Usage: sudo bash install-lan.sh [CA_CERT CA_KEY] | --certificate CERT KEY CA_CERT | --replace-certificate CERT KEY CA_CERT' >&2
  exit 2
fi
issued_cert=''
issued_key=''
replace_certificate=false
if [[ $# -eq 4 ]]; then
  [[ $1 != --replace-certificate ]] || replace_certificate=true
  issued_cert=$2
  issued_key=$3
  ca_cert=$4
elif [[ $# -eq 0 ]]; then
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
[[ -f "$ca_cert" && -f "$codex_cert" && -f "$caddy_config" ]]
if [[ -n "$issued_cert" ]]; then
  [[ -f "$issued_cert" && -f "$issued_key" ]]
else
  [[ -f "$ca_key" ]]
fi
# Prove this is the CA already trusted for Codex. Never invent or replace a CA.
openssl verify -no-CApath -no-CAstore -CAfile "$ca_cert" "$codex_cert" >/dev/null
if "$replace_certificate"; then
  # Replacement is limited to the dedicated vhost emitted by this installer.
  if ! awk '
    /^[[:space:]]*https:\/\/claude[.]home[.]arpa[[:space:]]*[{][[:space:]]*$/ {
      blocks++; inside=1; next
    }
    inside && /^[[:space:]]*[}][[:space:]]*$/ { inside=0; next }
    inside && /^[[:space:]]*($|#)/ { next }
    inside && $1 == "tls" && NF == 3 &&
      $2 == "/etc/caddy/certs/claude.home.arpa.crt" &&
      $3 == "/etc/caddy/certs/claude.home.arpa.key" { tls++; next }
    inside && $1 == "reverse_proxy" && NF == 2 &&
      $2 == "127.0.0.1:4311" { proxy++; next }
    inside { unexpected=1 }
    END { exit !(blocks == 1 && tls == 1 && proxy == 1 && !inside && !unexpected) }
  ' "$caddy_config"; then
    echo 'Existing Claude vhost does not match the expected certificate paths and backend.' >&2
    exit 1
  fi
  [[ -f "$cert_directory/claude.home.arpa.crt" && -f "$cert_directory/claude.home.arpa.key" ]]
elif grep -Eq 'claude\.home\.arpa' "$caddy_config"; then
  echo 'Claude host already exists in Caddy; inspect it before applying this script.' >&2
  exit 1
fi
temporary=$(mktemp -d)
replacement_cert=''
replacement_key=''
trap 'rm -rf -- "$temporary"; if [[ -n "$replacement_cert" ]]; then rm -f -- "$replacement_cert" "$replacement_key"; fi' EXIT
chmod 700 "$temporary"
if [[ -n "$issued_cert" ]]; then
  install -m 0644 "$issued_cert" "$temporary/claude.crt"
  install -m 0600 "$issued_key" "$temporary/claude.key"
else
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
fi
# Accept only a currently valid server certificate for this host from the same CA.
openssl verify -no-CApath -no-CAstore -CAfile "$ca_cert" \
  -purpose sslserver -verify_hostname claude.home.arpa "$temporary/claude.crt" >/dev/null
# Chromium rejects *.home.arpa because home.arpa is a public suffix.
san=$(openssl x509 -in "$temporary/claude.crt" -noout -ext subjectAltName)
if ! printf '%s\n' "$san" | tr ',' '\n' | grep -Eq '^[[:space:]]*DNS:claude[.]home[.]arpa[[:space:]]*$'; then
  echo 'Claude certificate requires an explicit DNS:claude.home.arpa subjectAltName.' >&2
  exit 1
fi
cert_public=$(openssl x509 -in "$temporary/claude.crt" -pubkey -noout 2>/dev/null |
  openssl pkey -pubin -outform DER 2>/dev/null | openssl dgst -sha256)
key_public=$(openssl pkey -in "$temporary/claude.key" -passin pass: -pubout -outform DER 2>/dev/null |
  openssl dgst -sha256)
if [[ "$cert_public" != "$key_public" ]]; then
  echo 'Claude certificate and private key do not match.' >&2
  exit 1
fi
if "$replace_certificate"; then
  backup_directory=$(mktemp -d "$cert_directory/.claude-before.XXXXXX")
  cp -p "$cert_directory/claude.home.arpa.crt" "$backup_directory/claude.crt"
  cp -p "$cert_directory/claude.home.arpa.key" "$backup_directory/claude.key"
  replacement_cert=$(mktemp "$cert_directory/.claude-new-crt.XXXXXX")
  replacement_key=$(mktemp "$cert_directory/.claude-new-key.XXXXXX")
  install -o root -g caddy -m 0644 "$temporary/claude.crt" "$replacement_cert"
  install -o root -g caddy -m 0640 "$temporary/claude.key" "$replacement_key"
  # Each rename is atomic; Caddy keeps its old in-memory certificate until reload.
  if ! { mv "$replacement_cert" "$cert_directory/claude.home.arpa.crt" &&
         mv "$replacement_key" "$cert_directory/claude.home.arpa.key" &&
         caddy validate --config "$caddy_config" --adapter caddyfile &&
         systemctl reload caddy; }; then
    cp -p "$backup_directory/claude.crt" "$replacement_cert"
    cp -p "$backup_directory/claude.key" "$replacement_key"
    mv "$replacement_cert" "$cert_directory/claude.home.arpa.crt"
    mv "$replacement_key" "$cert_directory/claude.home.arpa.key"
    if ! systemctl reload caddy; then
      echo 'Original Claude certificate files restored; Caddy reload still failed.' >&2
      exit 1
    fi
    echo 'Certificate replacement failed; original Claude certificate files were restored.' >&2
    exit 1
  fi
  echo "Claude certificate replaced. Backup: $backup_directory. Caddyfile and Codex files were preserved."
  exit 0
fi
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
