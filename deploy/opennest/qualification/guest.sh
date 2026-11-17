#!/usr/bin/env bash
set -euo pipefail
[[ "$(id -u)" == 17002 && "$HOME" == /home/opennest-qualification ]]
[[ "$(cat /proc/1/comm)" == systemd && "${GITHUB_ACTIONS:-}" == true ]]
export HTTP_PROXY=http://fixture-user:fixture-proxy-password@127.0.0.1:9051
export HTTPS_PROXY="$HTTP_PROXY" ALL_PROXY="$HTTP_PROXY"
export NO_PROXY=127.0.0.1,localhost,::1
export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
systemctl --user set-environment \
  HOME="$HOME" XDG_CONFIG_HOME="$XDG_CONFIG_HOME" XDG_DATA_HOME="$XDG_DATA_HOME" \
  XDG_STATE_HOME="$XDG_STATE_HOME" XDG_CACHE_HOME="$XDG_CACHE_HOME" XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" \
  HTTP_PROXY="$HTTP_PROXY" HTTPS_PROXY="$HTTPS_PROXY" ALL_PROXY="$ALL_PROXY" NO_PROXY="$NO_PROXY" \
  CURL_CA_BUNDLE="$CURL_CA_BUNDLE" GIT_SSL_CAINFO="$GIT_SSL_CAINFO" SSL_CERT_FILE="$SSL_CERT_FILE" \
  NODE_EXTRA_CA_CERTS=/opennest-qualification-private/ca.pem \
  OPENCODE_DISABLE_MODELS_FETCH=true OPENCODE_DISABLE_DEFAULT_PLUGINS=true
exec /opt/opennest-qualification/node/bin/node /opennest-qualification-input/lifecycle.mjs
