#!/usr/bin/env bash
# Read-only administrator helper. Prints one existing CA certificate/key pair.
# Usage: sudo bash find-lan-ca.sh [additional-search-directory ...]
set -euo pipefail

codex_cert=/etc/caddy/certs/codex.home.arpa.crt
if [[ ${EUID} -ne 0 ]]; then
  echo 'Run this read-only CA discovery helper as administrator.' >&2
  exit 2
fi
command -v openssl >/dev/null || { echo 'OpenSSL is required.' >&2; exit 2; }
[[ -f "$codex_cert" ]] || { echo 'Existing Codex certificate was not found.' >&2; exit 1; }

roots=(/etc/caddy /var/lib/caddy /etc/ssl /usr/local/share/ca-certificates /root/.local/share "$@")
files=()
declare -A seen=()
for root in "${roots[@]}"; do
  [[ -d "$root" ]] || continue
  while IFS= read -r -d '' file; do
    # The output uses tabs and newlines as delimiters; reject ambiguous paths.
    [[ "$file" != *$'\t'* && "$file" != *$'\n'* ]] || continue
    file=$(realpath -- "$file" 2>/dev/null) || continue
    [[ "$file" != *$'\t'* && "$file" != *$'\n'* && -f "$file" ]] || continue
    [[ ${seen[$file]+present} ]] && continue
    seen[$file]=1
    files+=("$file")
  done < <(find "$root" \( -type f -o -type l \) \
    \( -iname '*.crt' -o -iname '*.pem' -o -iname '*.key' \) -print0 2>/dev/null)
done

certs=()
digests=()
for file in "${files[@]}"; do
  constraints=$(openssl x509 -in "$file" -noout -ext basicConstraints 2>/dev/null) || continue
  [[ "$constraints" == *'CA:TRUE'* ]] || continue
  # Exclude the system trust store: only this candidate may validate Codex.
  openssl verify -no-CApath -no-CAstore -CAfile "$file" "$codex_cert" >/dev/null 2>&1 || continue
  digest=$(openssl x509 -in "$file" -pubkey -noout 2>/dev/null |
    openssl pkey -pubin -outform DER 2>/dev/null |
    openssl dgst -sha256 2>/dev/null) || continue
  certs+=("$file")
  digests+=("$digest")
done

pair_cert=''
pair_key=''
pair_digest=''
for file in "${files[@]}"; do
  # An empty password fails encrypted keys without an interactive prompt.
  digest=$(openssl pkey -in "$file" -passin pass: -pubout -outform DER 2>/dev/null |
    openssl dgst -sha256 2>/dev/null) || continue
  for index in "${!certs[@]}"; do
    [[ "$digest" == "${digests[$index]}" ]] || continue
    if [[ -n "$pair_cert" ]]; then
      # Installed trust copies and backup copies of the same key are one CA.
      [[ "$digest" == "$pair_digest" ]] && continue
      echo 'Multiple matching CA certificate/key pairs found; provide explicit paths.' >&2
      exit 1
    fi
    pair_cert=${certs[$index]}
    pair_key=$file
    pair_digest=$digest
  done
done

if [[ -z "$pair_cert" ]]; then
  echo 'No existing signing CA pair found. Supply its paths or additional search directories.' >&2
  exit 1
fi
printf '%s\t%s\n' "$pair_cert" "$pair_key"
