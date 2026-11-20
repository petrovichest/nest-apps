#!/usr/bin/env bash
set -euo pipefail

# This driver changes only a disposable GitHub-hosted VM. Never relax this guard.
[[ "${GITHUB_ACTIONS:-}" == true && "${CI:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted && "${RUNNER_OS:-}" == Linux ]]
[[ "$(id -un)" == runner && "$(cat /proc/1/comm)" == systemd ]]
[[ "${OPENNEST_QUALIFICATION_BASELINE:-}" =~ ^[0-9a-f]{40}$ ]]
[[ -n "${RUNNER_TEMP:-}" && -n "${GITHUB_RUN_ID:-}" ]]
[[ "${OPENNEST_DIAGNOSTIC_STARTUP_ONLY:-0}" == 0 || ( "${OPENNEST_DIAGNOSTIC_STARTUP_ONLY:-0}" == 1 && "${GITHUB_REF:-}" == refs/heads/* && "${GITHUB_REF:-}" != refs/heads/main ) ]]
qualification_source="$(git rev-parse --show-toplevel)"
qualification_candidate="$(git rev-parse HEAD)"
qualification_uid=17002
qualification_input=/opennest-qualification-input
qualification_output=/opennest-qualification-output
qualification_private=/opennest-qualification-private
qualification_home=/home/opennest-qualification
for directory in "$qualification_input" "$qualification_output" "$qualification_private" /opt/opennest-qualification; do
  [[ ! -e "$directory" ]] || { printf 'Fixture path already exists: %s\n' "$directory" >&2; exit 2; }
done
! getent passwd "$qualification_uid" >/dev/null
for command in git curl python3 openssl sudo systemctl tar sha256sum node npm; do command -v "$command" >/dev/null; done
sudo -n true
sudo apt-get update -qq
sudo apt-get install --yes bubblewrap tcpdump
sudo useradd --create-home --uid "$qualification_uid" --shell /bin/bash opennest-qualification
sudo install -d -m 0755 "$qualification_input" /opt/opennest-qualification/native
sudo install -d -m 0700 -o "$qualification_uid" -g "$qualification_uid" "$qualification_private"
sudo install -d -m 0755 -o "$qualification_uid" -g "$qualification_uid" "$qualification_output"
ln -s "$qualification_output" "$RUNNER_TEMP/opennest-qualification"

cleanup() {
  sudo systemctl stop opennest-qualification-nettrace.service >/dev/null 2>&1 || true
  sudo ss -tnp '( sport = :4097 or dport = :4097 )' \
    | sudo tee "$qualification_output/native-sockets.txt" >/dev/null || true
  ps -u "$qualification_uid" -o pid,ppid,etimes,stat,pcpu,pmem,comm,wchan \
    | sudo tee "$qualification_output/native-processes.txt" >/dev/null || true
  sudo python3 - <<'PYCOMMANDS' || true
import re
from pathlib import Path
root=Path('/opennest-qualification-private')
destination=Path('/opennest-qualification-output')
sources=list(root.glob('command-*.log'))
sources.extend(root.glob('native-http-trace.log'))
sources.extend(root.glob('native-network.log'))
sources.extend(Path('/home/opennest-qualification/.local/share/opencode/log').glob('*.log'))
for source in sources:
    lines=source.read_text(errors='replace').splitlines()
    sanitized=[]
    for line in lines:
        if re.search(r'bearer|authorization|access.token|refresh.token|api.?key|password|owner.token|prompt|messages|input=',line,re.I):
            continue
        line=re.sub(r'(https?://)[^/\s:@]+:[^/\s@]+@',r'\1[redacted]@',line)
        line=re.sub(r'\b[0-9a-fA-F]{64}\b','[redacted]',line)
        sanitized.append(line)
    name=('native-cli-'+source.name) if source.parent != root else source.name
    limit=5000 if source.name in ('native-http-trace.log','native-network.log') else 300
    (destination/name).write_text('\n'.join(sanitized[-limit:])+'\n')
PYCOMMANDS
  sudo journalctl _UID="$qualification_uid" --no-pager -o short-monotonic -n 180 \
    | python3 -c 'import re,sys; print("\n".join(line for line in sys.stdin.read().splitlines() if not re.search(r"bearer|authorization|access.token|refresh.token|api.key|password",line,re.I)))' \
    | sudo tee "$qualification_output/service-errors.log" >/dev/null || true
  sudo journalctl -u opennest-qualification-fixture.service --no-pager -o short-monotonic -n 100 \
    | python3 -c 'import re,sys; print("\n".join(line for line in sys.stdin.read().splitlines() if not re.search(r"bearer|authorization|access.token|refresh.token|api.key|password",line,re.I)))' \
    | sudo tee "$qualification_output/fixture-errors.log" >/dev/null || true
  sudo python3 - <<'PYRESOURCES' || true
import json
from pathlib import Path
group=Path('/sys/fs/cgroup/user.slice/user-17002.slice')
destination=Path('/opennest-qualification-output')
if group.exists():
    events=dict(line.split() for line in (group/'memory.events').read_text().splitlines())
    resources={'memoryMaxBytes':int((group/'memory.max').read_text()),'memoryHighBytes':int((group/'memory.high').read_text()),'memoryPeakBytes':int((group/'memory.peak').read_text()),'cpuQuota':(group/'cpu.max').read_text().strip(),'oomKills':int(events['oom_kill']),'oomEvents':int(events['oom'])}
    (destination/'resources.json').write_text(json.dumps(resources,indent=2)+'\n')
    lifecycle=destination/'lifecycle.json'
    if lifecycle.exists():
        report=json.loads(lifecycle.read_text());report['resources']=resources
        if resources['oomKills'] or resources['oomEvents']: report['completed']=False
        lifecycle.write_text(json.dumps(report,indent=2)+'\n')
PYRESOURCES
  sudo systemctl show opennest-qualification-driver.service -p Result -p ExecMainCode -p ExecMainStatus -p MemoryPeak \
    | sudo tee "$qualification_output/driver-service.txt" >/dev/null || true
  sudo systemctl stop opennest-qualification-driver.service opennest-qualification-fixture.service >/dev/null 2>&1 || true
  sudo systemctl stop user@17002.service user-17002.slice >/dev/null 2>&1 || true
  sudo python3 - <<'PY'
from pathlib import Path
p=Path('/etc/hosts')
p.write_text(''.join(line for line in p.read_text().splitlines(keepends=True) if '# opennest-qualification' not in line))
PY
  sudo chmod -R a+rX "$qualification_output"
}
trap cleanup EXIT

curl -fsSL --retry 2 --max-time 120 https://github.com/anomalyco/opencode/releases/download/v1.19.5/opencode-linux-x64-baseline.tar.gz \
  -o "$RUNNER_TEMP/opennest-native.tar.gz"
printf '%s  %s\n' 17c200fd4b2289954cc01552559f9b6d03ec157b2ddfb5eb54144f491656333d "$RUNNER_TEMP/opennest-native.tar.gz" | sha256sum --check --strict
sudo tar -xzf "$RUNNER_TEMP/opennest-native.tar.gz" -C /opt/opennest-qualification/native
/opt/opennest-qualification/native/opencode --version | grep -Fx 1.19.5
sudo install -d -m 0755 /opt/opennest-qualification/unsupported
curl -fsSL --retry 2 --max-time 120 https://github.com/anomalyco/opencode/releases/download/v1.19.4/opencode-linux-x64-baseline.tar.gz -o "$RUNNER_TEMP/opennest-unsupported.tar.gz"
printf '%s  %s\n' 1697ef40558d378bd2f72efa8fafe1bed1f0e664f09247b9357556b95dbc7cbc "$RUNNER_TEMP/opennest-unsupported.tar.gz" | sha256sum --check --strict
sudo tar -xzf "$RUNNER_TEMP/opennest-unsupported.tar.gz" -C /opt/opennest-qualification/unsupported
/opt/opennest-qualification/unsupported/opencode --version | grep -Fx 1.19.4
sha256sum /opt/opennest-qualification/native/opencode | sudo tee "$qualification_output/native-binary-sha256.txt" >/dev/null
qualification_node="$(readlink -f "$(command -v node)")"
[[ "$("$qualification_node" -p 'process.versions.node.split(".")[0]')" == 24 ]]
qualification_node_root="$(dirname "$(dirname "$qualification_node")")"
sudo cp -a "$qualification_node_root" /opt/opennest-qualification/node
sudo chmod -R a+rX /opt/opennest-qualification/node
sudo env PATH=/opt/opennest-qualification/node/bin:/usr/bin:/bin /opt/opennest-qualification/node/bin/npm install \
  --prefix /opt/opennest-qualification/claude --ignore-scripts --no-audit --no-fund @anthropic-ai/claude-code@2.1.289
sudo /opt/opennest-qualification/node/bin/node /opt/opennest-qualification/claude/node_modules/@anthropic-ai/claude-code/install.cjs
/opt/opennest-qualification/claude/node_modules/.bin/claude --version | grep -E '^2\.1\.289([[:space:]]|$)'

for file in environment.sh guest.sh lifecycle.mjs native-relay.mjs native-http-trace.mjs fault-entry.mjs history.py services.mjs claude-history.py; do
  sudo install -m 0644 "$qualification_source/deploy/opennest/qualification/$file" "$qualification_input/$file"
done
git -C "$qualification_source" cat-file -e "$OPENNEST_QUALIFICATION_BASELINE^{commit}"
git clone --bare --no-hardlinks "$qualification_source" "$RUNNER_TEMP/opennest-source.git"
git -C "$RUNNER_TEMP/opennest-source.git" update-ref refs/heads/main "$qualification_candidate"
sudo cp -a "$RUNNER_TEMP/opennest-source.git" "$qualification_input/nest-apps.git"
for kind in A B; do
  qualification_commit="$qualification_candidate"
  [[ "$kind" != A ]] || qualification_commit="$OPENNEST_QUALIFICATION_BASELINE"
  if [[ "$kind" == A && "${OPENNEST_QUALIFICATION_BASELINE_KIND:?}" == published ]]; then
    [[ "${OPENNEST_QUALIFICATION_BASELINE_INSTALLER_URL:-}" == https://github.com/petrovichest/nest-apps/releases/download/* ]]
    [[ "${OPENNEST_QUALIFICATION_BASELINE_INSTALLER_SHA256:-}" =~ ^[0-9a-f]{64}$ ]]
    curl -fsSL --retry 2 --max-time 60 --max-filesize 1048576 "$OPENNEST_QUALIFICATION_BASELINE_INSTALLER_URL" -o "$RUNNER_TEMP/opennest-install-$kind.sh"
    printf '%s  %s\n' "$OPENNEST_QUALIFICATION_BASELINE_INSTALLER_SHA256" "$RUNNER_TEMP/opennest-install-$kind.sh" | sha256sum --check --strict
  else
    git -C "$qualification_source" show "$qualification_commit:deploy/opennest/install.sh" \
      | sed -e "s/^opennest_default_version=.*/opennest_default_version=\"0.1.9-${qualification_commit:0:7}\"/" \
            -e "s/^opennest_default_ref=.*/opennest_default_ref=\"$qualification_commit\"/" \
      > "$RUNNER_TEMP/opennest-install-$kind.sh"
  fi
  bash -n "$RUNNER_TEMP/opennest-install-$kind.sh"
  sudo install -m 0644 "$RUNNER_TEMP/opennest-install-$kind.sh" "$qualification_input/install-$kind.sh"
  qualification_hash_name=candidate
  [[ "$kind" != A ]] || qualification_hash_name=baseline
  sha256sum "$RUNNER_TEMP/opennest-install-$kind.sh" | sudo tee "$qualification_output/$qualification_hash_name-installer-sha256.txt" >/dev/null
done
printf '%s\n' "$qualification_candidate" | sudo tee "$qualification_input/candidate-sha" >/dev/null
printf '%s\n' "$OPENNEST_QUALIFICATION_BASELINE" | sudo tee "$qualification_input/baseline-sha" >/dev/null
# Install the exact non-registry dependency into the local HTTPS fixture.
picomatch_archive="$(node -p 'require("./package-lock.json").packages["node_modules/picomatch"].resolved')"
if [[ "$picomatch_archive" == https://codeload.github.com/micromatch/picomatch/tar.gz/* ]]; then
  picomatch_commit="${picomatch_archive##*/}"
  [[ "$picomatch_commit" =~ ^[0-9a-f]{40}$ ]]
  picomatch_integrity="$(node -p 'require("./package-lock.json").packages["node_modules/picomatch"].integrity')"
  curl -fsSL --proto '=https' --proto-redir '=https' --retry 2 --max-time 60 --max-filesize 1048576 \
    "$picomatch_archive" -o "$RUNNER_TEMP/opennest-picomatch.tgz"
  [[ "$picomatch_integrity" == "sha512-$(openssl dgst -sha512 -binary "$RUNNER_TEMP/opennest-picomatch.tgz" | openssl base64 -A)" ]]
  sudo install -m 0644 "$RUNNER_TEMP/opennest-picomatch.tgz" "$qualification_input/picomatch-$picomatch_commit.tgz"
fi
sudo chmod -R a+rX "$qualification_input"

sudo openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=OpenNest disposable qualification CA' \
  -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout "$qualification_private/ca-key.pem" -out "$qualification_private/ca.pem" > /dev/null 2>&1
sudo openssl req -newkey rsa:2048 -nodes -subj '/CN=github.com' \
  -keyout "$qualification_private/fixture-key.pem" -out "$qualification_private/fixture.csr" > /dev/null 2>&1
printf '%s\n' 'basicConstraints=critical,CA:FALSE' 'keyUsage=critical,digitalSignature,keyEncipherment' \
  'extendedKeyUsage=serverAuth' 'subjectAltName=DNS:github.com,DNS:codeload.github.com,DNS:model.openrouter.fixture,DNS:openrouter.ai,IP:127.0.0.2' \
  | sudo tee "$qualification_private/certificate-extensions" >/dev/null
sudo openssl x509 -req -in "$qualification_private/fixture.csr" -CA "$qualification_private/ca.pem" -CAkey "$qualification_private/ca-key.pem" \
  -CAcreateserial -out "$qualification_private/fixture-cert.pem" -days 2 -extfile "$qualification_private/certificate-extensions" > /dev/null 2>&1
sudo install -m 0644 "$qualification_private/ca.pem" /usr/local/share/ca-certificates/opennest-qualification.crt
sudo update-ca-certificates >/dev/null
printf '\n127.0.0.2 github.com codeload.github.com model.openrouter.fixture openrouter.ai # opennest-qualification\n' | sudo tee -a /etc/hosts >/dev/null
sudo chown -R "$qualification_uid:$qualification_uid" "$qualification_private" "$qualification_output"
printf 'OpenNest synthetic qualification fixture v1\n' | sudo tee "$qualification_home/.opennest-qualification" >/dev/null
sudo chown "$qualification_uid:$qualification_uid" "$qualification_home/.opennest-qualification"

sudo tee /etc/systemd/system/opennest-qualification-fixture.service >/dev/null <<'UNIT'
[Unit]
Description=Disposable OpenNest model, proxy and artifact fixtures
[Service]
Slice=user-17002.slice
UMask=0077
ExecStart=/opt/opennest-qualification/node/bin/node /opennest-qualification-input/services.mjs
Restart=no
UNIT
sudo tee /etc/systemd/system/opennest-qualification-nettrace.service >/dev/null <<'UNIT'
[Unit]
Description=Disposable OpenNest native TCP metadata
[Service]
Slice=user-17002.slice
UMask=0077
# Quiet output contains packet lengths/endpoints only, never HTTP payloads.
ExecStart=/usr/bin/tcpdump -l -q -tt -nn -i lo -Z opennest-qualification tcp port 4097
StandardOutput=append:/opennest-qualification-private/native-network.log
Restart=no
UNIT
sudo systemctl daemon-reload
sudo systemctl set-property --runtime user-17002.slice MemoryMax=10G MemoryHigh=9G CPUQuota=400%
sudo loginctl enable-linger opennest-qualification
sudo systemctl start user@17002.service
sudo -u opennest-qualification env XDG_RUNTIME_DIR=/run/user/17002 systemctl --user start dbus.service
sudo systemctl start opennest-qualification-fixture.service
sudo systemctl start opennest-qualification-nettrace.service
sudo systemd-run --unit=opennest-qualification-driver --wait --pipe --uid=17002 --gid=17002 \
  --property=Slice=user-17002.slice --property=UMask=0077 \
  --setenv=HOME=/home/opennest-qualification \
  --setenv=XDG_CONFIG_HOME=/home/opennest-qualification/.config \
  --setenv=XDG_DATA_HOME=/home/opennest-qualification/.local/share \
  --setenv=XDG_STATE_HOME=/home/opennest-qualification/.local/state \
  --setenv=XDG_CACHE_HOME=/home/opennest-qualification/.cache \
  --setenv=XDG_RUNTIME_DIR=/run/user/17002 --setenv=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/17002/bus \
  --setenv=PATH=/home/opennest-qualification/.local/bin:/opt/opennest-qualification/node/bin:/usr/local/bin:/usr/bin:/bin \
  --setenv=OPENNEST_CLAUDE_BIN=/opt/opennest-qualification/claude/node_modules/.bin/claude \
  --setenv=OPENNEST_OPENCODE_BIN=/opt/opennest-qualification/native/opencode \
  --setenv=NODE_EXTRA_CA_CERTS=/opennest-qualification-private/ca.pem \
  --setenv=CURL_CA_BUNDLE=/opennest-qualification-private/ca.pem \
  --setenv=GIT_SSL_CAINFO=/opennest-qualification-private/ca.pem \
  --setenv="OPENNEST_QUALIFICATION_BASELINE_KIND=${OPENNEST_QUALIFICATION_BASELINE_KIND:?}" \
  --setenv="OPENNEST_QUALIFICATION_BASELINE_RUNTIME=${OPENNEST_QUALIFICATION_BASELINE_RUNTIME:?}" \
  --setenv="OPENNEST_QUALIFICATION_BASELINE_VERSION=${OPENNEST_QUALIFICATION_BASELINE_VERSION:?}" \
  --setenv="OPENNEST_DIAGNOSTIC_STARTUP_ONLY=${OPENNEST_DIAGNOSTIC_STARTUP_ONLY:-0}" \
  --setenv="GITHUB_REF=${GITHUB_REF:?}" \
  --setenv="GITHUB_RUN_ID=$GITHUB_RUN_ID" --setenv=GITHUB_ACTIONS=true \
  /bin/bash /opennest-qualification-input/guest.sh
