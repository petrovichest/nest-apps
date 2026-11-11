#!/usr/bin/env bash

set -euo pipefail

[[ "${GITHUB_ACTIONS:-}" == true && "${CI:-}" == true ]] || {
  printf '%s\n' 'Run only in an isolated GitHub-hosted CI job, never on an installed Nest instance.' >&2
  exit 2
}
case "${NATIVE_VERSION:-}" in
  0.154.0|0.167.0|0.167.1) ;;
  *) exit 2 ;;
esac
[[ -n "${RUNNER_TEMP:-}" && -n "${GITHUB_RUN_ID:-}" && -n "${GITHUB_RUN_ATTEMPT:-}" ]] || exit 2

qualification_root="$(git rev-parse --show-toplevel)"
qualification_sha="$(git rev-parse HEAD)"
qualification_mode="${QUALIFICATION_MODE:-environment}"
case "$qualification_mode" in environment|lifecycle) ;; *) exit 2 ;; esac
qualification_output="$RUNNER_TEMP/qualification-$qualification_mode-$NATIVE_VERSION"
qualification_container="nest-qualification-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-${NATIVE_VERSION//./-}"
qualification_image="$qualification_container:environment"
qualification_context="$(mktemp -d "$RUNNER_TEMP/nest-qualification-context.XXXXXX")"
mkdir -p "$qualification_output"
chmod 0777 "$qualification_output"
cp "$qualification_root/deploy/qualification/Dockerfile" "$qualification_context/Dockerfile"
printf '{"candidate":"%s","native":"%s","phase":"preparing","releaseQualified":false}\n' \
  "$qualification_sha" "$NATIVE_VERSION" > "$qualification_output/environment.json"
qualification_input="$(mktemp -d "$RUNNER_TEMP/nest-qualification-input.XXXXXX")"
if [[ "$qualification_mode" == lifecycle ]]; then
  cp "$qualification_root"/deploy/qualification/{services.py,provision.sh,lifecycle.mjs,history.py} "$qualification_input/"
  curl -fsSL --retry 2 --max-time 60 \
    https://github.com/petrovichest/nest-apps/releases/download/rolling-latest/NestApps-latest.json \
    -o "$qualification_input/baseline.json"
  curl -fsSL --retry 2 --max-time 60 \
    https://github.com/petrovichest/nest-apps/releases/download/rolling-latest/install.sh \
    -o "$qualification_input/install-A.sh"
  python3 - "$qualification_input" "$qualification_output" <<'PY'
import hashlib,json,sys
from pathlib import Path
root,out=map(Path,sys.argv[1:])
baseline=json.loads((root/'baseline.json').read_text())
assert baseline == {'schemaVersion':1,'version':'0.1.9-fe3c5c8',
                    'commit':'fe3c5c858344b5f03c2619250b01d351930c891b'}, 'Reconfirm the healthy published baseline before testing a new channel pointer.'
installer=(root/'install-A.sh').read_text()
assert f'codexnest_default_ref="{baseline["commit"]}"' in installer
assert f'codexnest_default_version="{baseline["version"]}"' in installer
(out/'baseline.json').write_text(json.dumps({**baseline,'installerSha256':hashlib.sha256(installer.encode()).hexdigest()},indent=2)+'\n')
PY
  git clone --bare --no-hardlinks "$qualification_root" "$qualification_input/nest-apps.git"
  git -C "$qualification_input/nest-apps.git" update-ref refs/heads/qualification "$qualification_sha"
  git -C "$qualification_input/nest-apps.git" update-ref refs/heads/main fe3c5c858344b5f03c2619250b01d351930c891b
  git -C "$qualification_input/nest-apps.git" update-server-info
  printf '%s\n' "$qualification_sha" > "$qualification_input/candidate-sha"
fi
chmod -R a+rX "$qualification_input"

cleanup() {
  if docker container inspect "$qualification_container" >/dev/null 2>&1; then
    docker logs "$qualification_container" > "$qualification_output/systemd.log" 2>&1 || true
    docker stop --time 15 "$qualification_container" >/dev/null 2>&1 || true
    docker container rm "$qualification_container" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# Public package downloads use the dedicated CI runner's resolver. The runtime
# still has a private network namespace, with no published host ports.
docker build --network=host --build-arg "CODEX_VERSION=$NATIVE_VERSION" -t "$qualification_image" "$qualification_context"
docker run --detach --privileged --cgroupns=private \
  --memory=10g --cpus=4 \
  --tmpfs /run --tmpfs /run/lock \
  --name "$qualification_container" \
  --label "com.codexnest.qualification=$GITHUB_RUN_ID" \
  --mount "type=bind,source=$qualification_output,target=/qualification-output" \
  --mount "type=bind,source=$qualification_input,target=/qualification-input,readonly" \
  "$qualification_image" >/dev/null

qualification_bus_ready=false
for ((attempt = 1; attempt <= 60; attempt += 1)); do
  if docker exec "$qualification_container" systemctl is-active --quiet dbus.service; then
    qualification_bus_ready=true
    break
  fi
  sleep 1
done
$qualification_bus_ready || { printf '%s\n' 'The isolated system manager did not become ready.' >&2; exit 1; }

docker exec "$qualification_container" sh -c 'test "$(cat /proc/1/comm)" = systemd'
docker exec "$qualification_container" loginctl enable-linger nest-qualification
docker exec "$qualification_container" systemctl start user@17001.service
if [[ "$qualification_mode" == lifecycle ]]; then
  docker exec --env NEST_QUALIFICATION_CONTAINER=1 "$qualification_container" \
    bash /qualification-input/provision.sh
fi

docker exec --interactive --user 17001 \
  --env HOME=/home/nest-qualification \
  --env XDG_RUNTIME_DIR=/run/user/17001 \
  --env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/17001/bus \
  --env "NATIVE_VERSION=$NATIVE_VERSION" \
  --env "QUALIFICATION_MODE=$qualification_mode" \
  "$qualification_container" bash --noprofile --norc -s <<'GUEST'
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
  mkdir -p "$native_version_home" "$HOME/.local/bin"
  install -m 0755 "${native_binaries[0]}" "$native_version_home/codex"
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
GUEST

docker image inspect "$qualification_image" --format '{{.Id}}' > "$qualification_output/image-id.txt"
python3 - "$qualification_output" "$qualification_sha" "$NATIVE_VERSION" <<'PY'
import json,sys
from pathlib import Path
root=Path(sys.argv[1])
version=json.loads((root/'native-version.json').read_text())
assert version['cliVersion']==sys.argv[3] and version['appServerVersion']==sys.argv[3]
assert version['status'] in ('running','ready')
result={'phase':'environment-only','candidate':sys.argv[2],'native':sys.argv[3],
        'systemManager':'real systemd PID 1','userManager':'real systemd --user, uid 17001',
        'nativeDaemon':'real installed CLI, private HOME and Unix socket',
        'cpuLimit':4,'memoryLimitGiB':10,'releaseQualified':False}
(root/'environment.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
PY
