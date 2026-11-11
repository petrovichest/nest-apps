#!/usr/bin/env bash
set -euo pipefail
[[ "$(id -u)" == 0 && "$(cat /proc/1/comm)" == systemd ]]
[[ "${NEST_QUALIFICATION_VM:-}" == 1 ]]
test -f /qualification-input/baseline.json
install -d -m 0700 -o 17001 -g 17001 /qualification-private
openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -subj '/CN=Nest disposable qualification CA' \
  -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout /qualification-private/ca-key.pem -out /qualification-private/ca.pem \
  > /qualification-private/certificate.log 2>&1
openssl req -newkey rsa:2048 -nodes -subj '/CN=127.0.0.2' \
  -keyout /qualification-private/fixture-key.pem -out /qualification-private/fixture.csr \
  >> /qualification-private/certificate.log 2>&1
cat > /qualification-private/certificate-extensions <<'CERT'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:github.com,IP:127.0.0.2
CERT
openssl x509 -req -in /qualification-private/fixture.csr \
  -CA /qualification-private/ca.pem -CAkey /qualification-private/ca-key.pem -CAcreateserial \
  -out /qualification-private/fixture.pem -days 2 -extfile /qualification-private/certificate-extensions \
  >> /qualification-private/certificate.log 2>&1
openssl verify -CAfile /qualification-private/ca.pem -purpose sslserver \
  /qualification-private/fixture.pem >> /qualification-private/certificate.log
install -m 0644 /qualification-private/ca.pem /usr/local/share/ca-certificates/nest-qualification.crt
update-ca-certificates >/dev/null
printf '\n127.0.0.2 github.com # nest-qualification\n' >> /etc/hosts
cat > /etc/systemd/system/nest-qualification-fixture.service <<'UNIT'
[Unit]
Description=Disposable Nest artifact/model/OAuth fixtures
[Service]
Slice=user-17001.slice
ExecStart=/usr/bin/python3 /qualification-input/services.py
Restart=no
UNIT
systemctl daemon-reload
systemctl start nest-qualification-fixture.service
fixture_tls_ready=false
for ((attempt=1; attempt<=20; attempt+=1)); do
  if curl --fail --silent --show-error --connect-timeout 1 --max-time 3 \
    --cacert /usr/local/share/ca-certificates/nest-qualification.crt \
    --proxy http://127.0.0.1:9001 --noproxy '' \
    https://127.0.0.2:9000/fixture/health > /qualification-output/model-tls.json 2>/qualification-private/tls-check.log; then
    fixture_tls_ready=true
    break
  fi
  sleep 0.2
done
$fixture_tls_ready || { printf '%s\n' 'Fixture TLS through its real proxy did not become ready.' >&2; exit 1; }
python3 - <<'PY'
import datetime,importlib.util,json,os
from pathlib import Path
spec=importlib.util.spec_from_file_location('fixture','/qualification-input/services.py')
fixture=importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
home=Path('/home/nest-qualification')
native=home/'.codex'
native.mkdir(mode=0o700)
config='''model = "gpt-5.4"
model_provider = "fixture"
chatgpt_base_url = "https://127.0.0.2:9000/backend-api"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
[features]
respect_system_proxy = true
[analytics]
enabled = false
[model_providers.fixture]
name = "Qualification"
base_url = "https://127.0.0.2:9000/v1"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
'''
(native/'config.toml').write_text(config)
auth={'auth_mode':'chatgpt','OPENAI_API_KEY':None,
      'tokens':{'id_token':fixture.jwt(),'access_token':fixture.jwt(),
                'refresh_token':'qualification-refresh-0','account_id':'qualification-workspace'},
      'last_refresh':datetime.datetime.now(datetime.timezone.utc).isoformat()}
(native/'auth.json').write_text(json.dumps(auth))
proxy=home/'.config/codex'
proxy.mkdir(parents=True)
(proxy/'app-server.env').write_text('HTTP_PROXY=http://127.0.0.1:9001\nHTTPS_PROXY=http://127.0.0.1:9001\nALL_PROXY=http://127.0.0.1:9001\nNO_PROXY=localhost,127.0.0.1,::1\n')
for directory in (native,home/'.config',proxy):
    os.chown(directory,17001,17001)
for file in (native/'config.toml',native/'auth.json',proxy/'app-server.env'):
    file.chmod(0o600)
    os.chown(file,17001,17001)
approvals=home/'qualification-approvals'
approvals.mkdir(mode=0o700)
os.chown(approvals,17001,17001)
PY
