#!/usr/bin/env bash

set -euo pipefail

[[ "${GITHUB_ACTIONS:-}" == true && "${CI:-}" == true ]] || {
  printf '%s\n' 'Run only in an isolated GitHub-hosted CI job, never on an installed Nest instance.' >&2
  exit 2
}
[[ "${NATIVE_VERSION:-}" == 0.154.0 || "${NATIVE_VERSION:-}" == 0.167.0 ]] || exit 2
[[ -n "${RUNNER_TEMP:-}" && -n "${GITHUB_RUN_ID:-}" && -n "${GITHUB_RUN_ATTEMPT:-}" ]] || exit 2

qualification_root="$(git rev-parse --show-toplevel)"
qualification_sha="$(git rev-parse HEAD)"
qualification_output="$RUNNER_TEMP/qualification-environment-$NATIVE_VERSION"
qualification_container="nest-qualification-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-${NATIVE_VERSION//./-}"
qualification_image="$qualification_container:environment"
qualification_context="$(mktemp -d "$RUNNER_TEMP/nest-qualification-context.XXXXXX")"
mkdir -p "$qualification_output"
chmod 0777 "$qualification_output"
cp "$qualification_root/deploy/qualification/Dockerfile" "$qualification_context/Dockerfile"

cleanup() {
  if docker container inspect "$qualification_container" >/dev/null 2>&1; then
    docker logs "$qualification_container" > "$qualification_output/systemd.log" 2>&1 || true
    docker stop --time 15 "$qualification_container" >/dev/null 2>&1 || true
    docker container rm "$qualification_container" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

docker build --build-arg "CODEX_VERSION=$NATIVE_VERSION" -t "$qualification_image" "$qualification_context"
docker run --detach --privileged --cgroupns=private \
  --memory=10g --cpus=4 \
  --tmpfs /run --tmpfs /run/lock \
  --name "$qualification_container" \
  --label "com.codexnest.qualification=$GITHUB_RUN_ID" \
  --mount "type=bind,source=$qualification_output,target=/qualification-output" \
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

docker exec --interactive --user 17001 \
  --env HOME=/home/nest-qualification \
  --env XDG_RUNTIME_DIR=/run/user/17001 \
  --env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/17001/bus \
  --env "NATIVE_VERSION=$NATIVE_VERSION" \
  "$qualification_container" bash --noprofile --norc -s <<'GUEST'
set -euo pipefail
[[ "$HOME" == /home/nest-qualification && "$(id -u)" == 17001 ]]
systemctl --user is-active --quiet default.target
mkdir -p "$HOME/.codex"
chmod 0700 "$HOME/.codex"
printf '[features]\nrespect_system_proxy = true\n[analytics]\nenabled = false\n' > "$HOME/.codex/config.toml"
# No real auth is present. Even unauthenticated background discovery must not
# leave this disposable fixture through a direct provider connection.
systemctl --user set-environment \
  HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 \
  http_proxy=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 all_proxy=http://127.0.0.1:9 \
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
