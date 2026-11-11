#!/usr/bin/env bash
set -euo pipefail
[[ "$(id -u)" == 0 && "$(cat /proc/1/comm)" == systemd ]]
[[ "${NEST_QUALIFICATION_CONTAINER:-}" == 1 ]]
test -f /qualification-input/baseline.json
install -d -m 0700 -o 17001 -g 17001 /qualification-private
openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -subj '/CN=Nest disposable qualification CA' \
  -keyout /qualification-private/fixture-key.pem -out /qualification-private/fixture.pem \
  -addext 'subjectAltName=DNS:github.com,IP:127.0.0.2' \
  > /qualification-private/certificate.log 2>&1
install -m 0644 /qualification-private/fixture.pem /usr/local/share/ca-certificates/nest-qualification.crt
update-ca-certificates >/dev/null
printf '\n127.0.0.2 github.com\n' >> /etc/hosts
cat > /etc/systemd/system/nest-qualification-fixture.service <<'UNIT'
[Unit]
Description=Disposable Nest artifact/model/OAuth fixtures
[Service]
ExecStart=/usr/bin/python3 /qualification-input/services.py
Restart=no
UNIT
systemctl daemon-reload
systemctl start nest-qualification-fixture.service
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
approval_policy = "never"
sandbox_mode = "danger-full-access"
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
PY
