#!/usr/bin/env bash
set -euo pipefail

[[ "${GITHUB_ACTIONS:-}" == true && "${CI:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]] || {
  printf '%s\n' 'Run only on a disposable GitHub-hosted VM, never on an installed Nest instance.' >&2
  exit 2
}
[[ "$(id -un)" == runner && "${RUNNER_OS:-}" == Linux ]]
case "${NATIVE_VERSION:-}" in 0.154.0|0.167.0|0.167.1) ;; *) exit 2 ;; esac
qualification_mode="${QUALIFICATION_MODE:-environment}"
case "$qualification_mode" in environment|lifecycle) ;; *) exit 2 ;; esac
qualification_scope="${QUALIFICATION_SCOPE:-all}"
case "$qualification_scope" in all|interruption|clean) ;; *) exit 2 ;; esac
[[ -n "${RUNNER_TEMP:-}" && -n "${GITHUB_RUN_ID:-}" ]]
qualification_root="$(git rev-parse --show-toplevel)"
qualification_sha="$(git rev-parse HEAD)"
qualification_output="$RUNNER_TEMP/qualification-$qualification_mode-$NATIVE_VERSION"
! getent passwd 17001 >/dev/null
for path in /qualification-input /qualification-output /qualification-private /opt/node /opt/native /opt/qualification; do
  [[ ! -e "$path" ]] || { printf 'Fixture path already exists: %s\n' "$path" >&2; exit 2; }
done
for program in curl git openssl python3 sha256sum sudo systemctl tar xz; do
  command -v "$program" >/dev/null
done
sudo -n sh -c 'test "$(cat /proc/1/comm)" = systemd'
sudo useradd --create-home --uid 17001 --shell /bin/bash nest-qualification
sudo install -d -m 0777 -o 17001 -g 17001 /qualification-output
sudo install -d -m 0700 -o 17001 -g 17001 /qualification-private
sudo install -d -m 0755 /qualification-input /opt/node /opt/native /opt/qualification
ln -s /qualification-output "$qualification_output"
printf '{"candidate":"%s","native":"%s","phase":"preparing","releaseQualified":false}\n' \
  "$qualification_sha" "$NATIVE_VERSION" | sudo tee /qualification-output/environment.json >/dev/null

cleanup() {
  sudo journalctl _UID=17001 _SYSTEMD_USER_UNIT=codexnest.service --no-pager -o cat -n 100 \
    | python3 -c 'import re,sys; text=sys.stdin.read(); print("\n".join(re.sub(r"eyJ[\w-]+\.[\w-]+\.[\w-]+", "[redacted]", line) for line in text.splitlines() if not re.search(r"bearer|authorization|access.token|refresh.token|id.token",line,re.I)))' \
    > "$qualification_output/application-errors.log" || true
  sudo systemctl show nest-qualification-driver.service \
    -p Result -p ExecMainCode -p ExecMainStatus -p MemoryPeak \
    > "$qualification_output/driver-service.txt" || true
  if [[ -n "${qualification_cgroup:-}" ]]; then
    sudo python3 - "$qualification_cgroup" > "$qualification_output/resources.json" <<'PY' || true
import json,sys
from pathlib import Path
root=Path('/sys/fs/cgroup'+sys.argv[1])
print(json.dumps({name:(root/name).read_text().strip() for name in
                  ('memory.max','memory.peak','memory.events','cpu.max','cpu.stat') if (root/name).exists()},indent=2))
PY
  fi
  sudo systemctl stop nest-qualification-fixture.service nest-qualification-driver.service >/dev/null 2>&1 || true
  sudo systemctl stop user@17001.service user-17001.slice >/dev/null 2>&1 || true
  sudo python3 - <<'PY'
from pathlib import Path
hosts=Path('/etc/hosts')
hosts.write_text(''.join(line for line in hosts.read_text().splitlines(keepends=True)
                         if '# nest-qualification' not in line))
PY
  # Only sanitized reports are made readable to the artifact uploader.
  sudo chmod -R a+rX /qualification-output
}
trap cleanup EXIT

# The hosted VM already includes the OS tools. Download only pinned Node/native
# packages; no container build, APT mirror or host/user credentials are involved.
curl -fsSL --max-time 120 https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz \
  -o "$RUNNER_TEMP/qualification-node.tar.xz"
curl -fsSL --max-time 30 https://nodejs.org/dist/v24.18.0/SHASUMS256.txt \
  -o "$RUNNER_TEMP/qualification-node-shasums.txt"
qualification_node_sha="$(awk '$2 == "node-v24.18.0-linux-x64.tar.xz" {print $1}' "$RUNNER_TEMP/qualification-node-shasums.txt")"
[[ "$qualification_node_sha" =~ ^[0-9a-f]{64}$ ]]
printf '%s  %s\n' "$qualification_node_sha" "$RUNNER_TEMP/qualification-node.tar.xz" | sha256sum --check --strict
sudo tar -xJf "$RUNNER_TEMP/qualification-node.tar.xz" --strip-components=1 -C /opt/node
sudo env PATH=/opt/node/bin:/usr/bin:/bin /opt/node/bin/npm install \
  --prefix /opt/native --ignore-scripts --no-audit --no-fund "@openai/codex@$NATIVE_VERSION"
sudo env PATH=/opt/node/bin:/usr/bin:/bin /opt/node/bin/npm install \
  --prefix /opt/qualification --ignore-scripts --no-audit --no-fund ws@8.21.1
sudo install -m 0644 "$qualification_root/deploy/qualification/guest.sh" /qualification-input/guest.sh
if [[ "$qualification_mode" == lifecycle ]]; then
  for file in services.py provision.sh lifecycle.mjs native-relay.mjs history.py; do
    sudo install -m 0644 "$qualification_root/deploy/qualification/$file" "/qualification-input/$file"
  done
  curl -fsSL --max-time 60 \
    https://github.com/petrovichest/nest-apps/releases/download/rolling-latest/NestApps-latest.json \
    -o "$RUNNER_TEMP/qualification-baseline.json"
  curl -fsSL --max-time 60 \
    https://github.com/petrovichest/nest-apps/releases/download/rolling-latest/install.sh \
    -o "$RUNNER_TEMP/qualification-install-A.sh"
  python3 - "$RUNNER_TEMP/qualification-baseline.json" "$RUNNER_TEMP/qualification-install-A.sh" <<'PY'
import json,sys
from pathlib import Path
baseline=json.loads(Path(sys.argv[1]).read_text())
assert baseline == {'schemaVersion':1,'version':'0.1.9-fe3c5c8',
                    'commit':'fe3c5c858344b5f03c2619250b01d351930c891b'}, 'Reconfirm the healthy baseline before using a new channel pointer.'
installer=Path(sys.argv[2]).read_text()
assert f'codexnest_default_ref="{baseline["commit"]}"' in installer
assert f'codexnest_default_version="{baseline["version"]}"' in installer
PY
  sudo install -m 0644 "$RUNNER_TEMP/qualification-baseline.json" /qualification-input/baseline.json
  sudo install -m 0644 "$RUNNER_TEMP/qualification-install-A.sh" /qualification-input/install-A.sh
  sed -e "s/^codexnest_default_version=.*/codexnest_default_version=\"0.1.9-${qualification_sha:0:7}\"/" \
      -e "s/^codexnest_default_ref=.*/codexnest_default_ref=\"$qualification_sha\"/" \
      "$qualification_root/deploy/install.sh" > "$RUNNER_TEMP/qualification-install-B.sh"
  bash -n "$RUNNER_TEMP/qualification-install-B.sh"
  sudo install -m 0644 "$RUNNER_TEMP/qualification-install-B.sh" /qualification-input/install-B.sh
  sha256sum "$RUNNER_TEMP/qualification-install-B.sh" > "$qualification_output/candidate-installer-sha256.txt"
  git clone --bare --no-hardlinks "$qualification_root" "$RUNNER_TEMP/qualification-source.git"
  git -C "$RUNNER_TEMP/qualification-source.git" update-ref refs/heads/qualification "$qualification_sha"
  git -C "$RUNNER_TEMP/qualification-source.git" update-ref refs/heads/main fe3c5c858344b5f03c2619250b01d351930c891b
  git -C "$RUNNER_TEMP/qualification-source.git" update-server-info
  sudo cp -a "$RUNNER_TEMP/qualification-source.git" /qualification-input/nest-apps.git
  printf '%s\n' "$qualification_sha" | sudo tee /qualification-input/candidate-sha >/dev/null
  sudo chmod -R a+rX /qualification-input
  sha256sum "$RUNNER_TEMP/qualification-install-A.sh" > "$qualification_output/baseline-installer-sha256.txt"
fi

sudo systemctl set-property --runtime user-17001.slice MemoryMax=10G CPUQuota=400%
sudo loginctl enable-linger nest-qualification
sudo systemctl start user@17001.service
qualification_cgroup="$(sudo systemctl show user-17001.slice -p ControlGroup --value)"
[[ "$qualification_cgroup" == /user.slice/user-17001.slice ]]
sudo -u nest-qualification env XDG_RUNTIME_DIR=/run/user/17001 \
  systemctl --user start dbus.service
if [[ "$qualification_mode" == lifecycle ]]; then
  sudo env NEST_QUALIFICATION_VM=1 bash /qualification-input/provision.sh
fi
sudo systemd-run --unit=nest-qualification-driver --wait --pipe \
  --uid=17001 --gid=17001 --property=Slice=user-17001.slice --property=UMask=0077 \
  --setenv=HOME=/home/nest-qualification \
  --setenv=PATH=/home/nest-qualification/.local/bin:/opt/node/bin:/opt/native/node_modules/.bin:/usr/local/bin:/usr/bin:/bin \
  --setenv=XDG_RUNTIME_DIR=/run/user/17001 \
  --setenv=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/17001/bus \
  --setenv="NATIVE_VERSION=$NATIVE_VERSION" --setenv="QUALIFICATION_MODE=$qualification_mode" \
  --setenv="QUALIFICATION_SCOPE=$qualification_scope" \
  --setenv="QUALIFICATION_CGROUP_PATH=/sys/fs/cgroup$qualification_cgroup" \
  /bin/bash /qualification-input/guest.sh
sudo python3 - "$qualification_output" "$qualification_sha" "$NATIVE_VERSION" <<'PY'
import json,sys
from pathlib import Path
root=Path(sys.argv[1])
version=json.loads((root/'native-version.json').read_text())
assert version['cliVersion']==sys.argv[3] and version['appServerVersion']==sys.argv[3]
assert version['status'] in ('running','ready')
result={'phase':'environment-only','candidate':sys.argv[2],'native':sys.argv[3],
        'isolation':'disposable GitHub VM, private uid/HOME/user manager/state/auth/socket',
        'cpuLimit':4,'memoryLimitGiB':10,'releaseQualified':False}
(root/'environment.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
PY
