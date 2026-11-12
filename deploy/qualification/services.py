"""Disposable artifact registry and model/OAuth services; never a native RPC mock."""

import base64
import json
import os
from pathlib import Path
import re
import select
import shlex
import socket
import ssl
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit
import uuid

ROOT = Path('/qualification-input')
PRIVATE = Path('/qualification-private')
APPROVAL_DIRECTORY = Path('/home/nest-qualification/qualification-approvals')
STATE = {'manifest': json.loads((ROOT / 'baseline.json').read_text()),
         'requests': {}, 'auxiliaryRequests': {}, 'released': [], 'oauthGeneration': 0, 'authFailure': False,
         'registryUnavailable': False,
         'proxyConnections': 0, 'deniedConnections': 0, 'directModelRequests': 0,
         'directOAuthRequests': 0, 'rejectedAccessTokens': 0}
LOCK = threading.Lock()
PROXY_PORTS = set()


def jwt(generation=0):
    def part(value):
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')
    claims = {'sub': 'qualification-user', 'email': 'qualification@example.invalid',
              'exp': int(time.time()) + 3600, 'generation': generation,
              'https://api.openai.com/auth': {'chatgpt_account_id': 'qualification-workspace',
                                            'chatgpt_user_id': 'qualification-user',
                                            'chatgpt_plan_type': 'plus'}}
    return f'{part({"alg": "none"})}.{part(claims)}.fixture'


def functions(tools, namespace=None):
    for tool in tools:
        if tool.get('type') == 'namespace':
            yield from functions(tool.get('tools', []), tool.get('name'))
        elif tool.get('type') in ('function', 'custom'):
            yield namespace, tool


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_args):
        pass  # Authorization, query strings and synthetic prompts stay out of reports.

    def body(self):
        length = int(self.headers.get('Content-Length', '0'))
        if not 0 <= length <= 32 * 1024 * 1024:
            raise ValueError('Fixture request too large')
        return self.rfile.read(length)

    def send(self, status, value, content_type='application/json'):
        data = value if isinstance(value, bytes) else json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class Registry(Handler):
    def do_GET(self):
        path = unquote(urlsplit(self.path).path)
        if path == '/petrovichest/nest-apps/releases/download/rolling-latest/NestApps-latest.json':
            with LOCK:
                self.send(200, STATE['manifest'])
            return
        prefix = '/petrovichest/nest-apps.git/'
        with LOCK:
            unavailable = STATE['registryUnavailable']
        if unavailable and path.startswith(prefix):
            self.send(503, {})
            return
        if not path.startswith(prefix):
            self.send(404, {})
            return
        root = (ROOT / 'nest-apps.git').resolve()
        target = (root / path[len(prefix):]).resolve()
        if not target.is_relative_to(root) or not target.is_file():
            self.send(404, {})
            return
        # Plain Git HTTP supports the unchanged installer's clone and fetch.
        self.send(200, target.read_bytes(), 'text/plain' if path.endswith('info/refs')
                  else 'application/octet-stream')


class Control(Handler):
    def do_GET(self):
        with LOCK:
            self.send(200, STATE)

    def do_POST(self):
        changes = json.loads(self.body())
        assert set(changes) <= {'manifest', 'released', 'authFailure', 'registryUnavailable'}
        with LOCK:
            STATE.update(changes)
            self.send(200, STATE)


class Model(Handler):
    def authorized(self):
        try:
            encoded = self.headers.get('Authorization', '').split('.')[1]
            claims = json.loads(base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)))
            with LOCK:
                valid = claims.get('generation') == STATE['oauthGeneration'] and claims['exp'] > time.time()
                if not valid:
                    STATE['rejectedAccessTokens'] += 1
            if valid:
                return True
        except (KeyError, IndexError, ValueError):
            pass
        self.send(401, {'error': {'type': 'invalid_token'}})
        return False

    def do_GET(self):
        if self.path == '/fixture/health':
            self.send(200, {'fixture': 'model', 'tls': True})
            return
        if not self.authorized():
            return
        if '/usage' in self.path:
            window = {'used_percent': 1, 'limit_window_seconds': 18000,
                      'reset_after_seconds': 3600, 'reset_at': int(time.time()) + 3600}
            self.send(200, {'account_id': 'qualification-workspace',
                            'user_id': 'qualification-user', 'plan_type': 'plus',
                            'rate_limit': {'allowed': True, 'limit_reached': False,
                                           'primary_window': window,
                                           'secondary_window': {**window,
                                                                'limit_window_seconds': 604800}}})
        elif '/wham/accounts/check' in self.path:
            account = {'id': 'qualification-workspace', 'name': 'Qualification',
                       'structure': 'personal', 'can_access_with_session': True,
                       'workspace_backend_origin': 'NO_CONSTRAINT',
                       'account_routing_override': 'NO_CONSTRAINT', 'plan_type': 'plus'}
            self.send(200, {'accounts': [account], 'account_ordering': [account['id']],
                            'default_account_id': account['id']})
        else:
            self.send(404, {})

    def do_POST(self):
        body = self.body()
        if self.path == '/oauth/token':
            refresh = (json.loads(body).get('refresh_token')
                       if self.headers.get('Content-Type', '').startswith('application/json')
                       else parse_qs(body.decode()).get('refresh_token', [None])[0])
            with LOCK:
                if self.client_address[1] not in PROXY_PORTS:
                    STATE['directOAuthRequests'] += 1
                failed = (STATE['authFailure'] or
                          refresh != f'qualification-refresh-{STATE["oauthGeneration"]}')
                if not failed:
                    STATE['oauthGeneration'] += 1
                generation = STATE['oauthGeneration']
            self.send(401 if failed else 200,
                      {'error': 'invalid_grant'} if failed else
                      {'id_token': jwt(generation), 'access_token': jwt(generation),
                       'refresh_token': f'qualification-refresh-{generation}',
                       'token_type': 'Bearer', 'expires_in': 3600})
            return
        if not self.path.endswith('/responses'):
            self.send(404, {})
            return
        if not self.authorized():
            return
        # Only record opaque operation identifiers, never request bodies or credentials.
        payload = json.loads(body)
        schema = payload.get('text', {}).get('format', {}).get('schema', {})
        properties = schema.get('properties', {})
        auxiliary = ('title' if 'title' in properties else 'reply-verdict'
                     if {'waiting', 'reason', 'published'} <= properties.keys() else None)
        users = [item for item in payload.get('input', [])
                 if isinstance(item, dict) and item.get('role') == 'user']
        text = '\n'.join(part.get('text', '') for part in users[-1].get('content', [])
                         if isinstance(part, dict)) if users else ''
        contexts = [part.get('text', '') for value in payload.get('input', [])
                    if isinstance(value, dict) and value.get('role') in ('developer', 'user')
                    for part in value.get('content', []) if isinstance(part, dict)]
        latest_result = next((value for value in reversed(contexts)
                              if '<codexnest.team.results>' in value), '')
        match = re.fullmatch(r'QUALIFICATION_(REQUEST|HOLD|APPROVAL):([a-zA-Z0-9_-]+)', text.strip())
        team = re.search(r'QUALIFICATION_TEAM_(PARENT|CHILD):([a-zA-Z0-9_-]+)', text)
        delivery = re.search(r'QUALIFICATION_BACKGROUND_RESULT:([a-zA-Z0-9_-]+)', latest_result)
        marker = match[2] if match else 'unmarked'
        if delivery:
            marker = f'team-delivery-{delivery[1]}'
            team = None
        elif team:
            marker = f'team-{team[1].lower()}-{team[2]}'
        call_id = f'qualification-call-{marker}'
        has_tool_result = any(value.get('type') in ('function_call_output', 'custom_tool_call_output') and value.get('call_id') == call_id
                              for value in payload.get('input', []) if isinstance(value, dict))
        held = not auxiliary and (bool(match and match[1] == 'HOLD') or
                                   bool(team and team[1] == 'CHILD' and not has_tool_result))
        with LOCK:
            counter, key = ('auxiliaryRequests', auxiliary) if auxiliary else ('requests', marker)
            STATE[counter][key] = STATE[counter].get(key, 0) + 1
            if self.client_address[1] not in PROXY_PORTS:
                STATE['directModelRequests'] += 1
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.close_connection = True
        response_id = str(uuid.uuid4())
        def event(kind, **value):
            data = {'type': kind, **value}
            self.wfile.write(f'event: {kind}\ndata: {json.dumps(data)}\n\n'.encode())
            self.wfile.flush()
        event('response.created', response={'id': response_id})
        deadline = time.monotonic() + 900
        while held:
            with LOCK:
                held = marker not in STATE['released']
            if time.monotonic() > deadline:
                return
            if held:
                self.wfile.write(b': qualification keepalive\n\n')
                self.wfile.flush()
                time.sleep(1)
        answer = (json.dumps({'title': 'Qualification request'}) if auxiliary == 'title' else
                  json.dumps({'waiting': False, 'reason': '', 'published': False})
                  if auxiliary == 'reply-verdict' else f'QUALIFICATION_OK:{marker}')
        item = {'id': str(uuid.uuid4()), 'type': 'message', 'role': 'assistant',
                'status': 'completed', 'content': [{'type': 'output_text',
                                                   'text': answer,
                                                   'annotations': []}]}
        if match and match[1] == 'APPROVAL' and not auxiliary and not has_tool_result:
            candidates = [(namespace, tool) for namespace, tool in functions(payload.get('tools', []))
                          if tool.get('name') in ('exec_command', 'shell_command')]
            command = f"printf '%s\\n' approved >> {shlex.quote(str(APPROVAL_DIRECTORY / marker))}"
            namespace, tool = candidates[0] if candidates else (None, {'name': 'exec_command'})
            args = {'cmd' if tool['name'] == 'exec_command' else 'command': command,
                    'sandbox_permissions': 'require_escalated',
                    'justification': 'Append once to the disposable qualification counter.'}
            if candidates:
                item = {'id': str(uuid.uuid4()), 'type': 'function_call', 'call_id': call_id,
                        'name': tool['name'], 'arguments': json.dumps(args)}
                if namespace:
                    item['namespace'] = namespace
            else:
                # Keep the actual code-mode cell waiting for the real human
                # approval, matching the deliberately held model stream's
                # 15-minute fixture lifetime. Startup/RPC/rollback budgets are
                # separate and unchanged. No model turn is completed early.
                code = ('// @exec: {"yield_time_ms": 900000}\n'
                        f'text(await tools.exec_command({json.dumps(args)}));')
                item = {'id': str(uuid.uuid4()), 'type': 'custom_tool_call',
                        'call_id': call_id, 'name': 'exec', 'input': code}
        elif team and not auxiliary and not has_tool_result:
            tool_name = 'spawn_task' if team[1] == 'PARENT' else 'submit_result'
            candidates = [(namespace, tool) for namespace, tool in functions(payload.get('tools', []))
                          if namespace == 'codexnest' and tool.get('name') == tool_name]
            args = ({'title': 'Synthetic background result',
                     'prompt': f'QUALIFICATION_TEAM_CHILD:{team[2]}',
                     'access': {'mode': 'readOnly', 'network': False}} if team[1] == 'PARENT' else
                    {'outcome': 'success', 'summary': f'QUALIFICATION_BACKGROUND_RESULT:{team[2]}',
                     'checks': [], 'risks': [], 'artifacts': []})
            if len(candidates) == 1:
                namespace, tool = candidates[0]
                item = {'id': str(uuid.uuid4()), 'type': 'function_call', 'call_id': call_id,
                        'namespace': namespace, 'name': tool['name'], 'arguments': json.dumps(args)}
            else:
                # The actual managed-child model uses Native's code-mode-only
                # tool surface. Invoke its real namespaced dynamic tool through
                # the advertised exec host, rather than assuming direct tools.
                code_tools = [(namespace, tool) for namespace, tool in functions(payload.get('tools', []))
                              if tool.get('type') == 'custom' and tool.get('name') == 'exec']
                if len(code_tools) > 1:
                    raise ValueError('Ambiguous code-mode exec surface')
                # Some native model transports omit wire tool metadata. As a
                # controlled model endpoint, send the same real exec call;
                # Native must validate and execute it and deliver the actual
                # dynamic-tool request before the lifecycle case can pass.
                namespace, tool = code_tools[0] if code_tools else (None, {'name': 'exec'})
                code_name = f'codexnest__{tool_name}'
                code = (f'const tool = ALL_TOOLS.find(({{ name }}) => name === {json.dumps(code_name)});'
                        'if (!tool) throw new Error("Managed task tool unavailable");'
                        f'text(await tools[tool.name]({json.dumps(args)}));')
                item = {'id': str(uuid.uuid4()), 'type': 'custom_tool_call', 'call_id': call_id,
                        'name': tool['name'], 'input': code}
                if namespace:
                    item['namespace'] = namespace
        if item['type'] == 'custom_tool_call':
            event('response.output_item.done', output_index=0, item=item)
            event('response.completed', response={'id': response_id, 'status': 'completed', 'output': [item]})
            return
        if item['type'] == 'function_call':
            event('response.output_item.added', output_index=0, item={**item, 'arguments': ''})
            event('response.function_call_arguments.delta', item_id=item['id'], output_index=0,
                  delta=item['arguments'])
            event('response.output_item.done', output_index=0, item=item)
            event('response.completed', response={'id': response_id, 'status': 'completed', 'output': [item]})
            return
        event('response.output_item.added', output_index=0, item={**item, 'content': []})
        event('response.output_text.delta', item_id=item['id'], output_index=0,
              content_index=0, delta=item['content'][0]['text'])
        event('response.output_item.done', output_index=0, item=item)
        event('response.completed', response={'id': response_id, 'status': 'completed',
                                             'output': [item], 'usage': {'input_tokens': 1,
                                                                         'output_tokens': 1,
                                                                         'total_tokens': 2}})


class Proxy(Handler):
    def do_CONNECT(self):
        if self.path != '127.0.0.2:9000':
            with LOCK:
                STATE['deniedConnections'] += 1
            self.send(403, {})
            return
        with socket.create_connection(('127.0.0.2', 9000), timeout=5) as upstream:
            proxy_port = upstream.getsockname()[1]
            with LOCK:
                STATE['proxyConnections'] += 1
                PROXY_PORTS.add(proxy_port)
            try:
                self.send_response(200, 'Connection established')
                self.end_headers()
                self.close_connection = True
                sockets = (self.connection, upstream)
                while True:
                    readable, _, _ = select.select(sockets, [], [], 30)
                    for source in readable:
                        data = source.recv(65536)
                        if not data:
                            return
                        (upstream if source is self.connection else self.connection).sendall(data)
            except (ConnectionError, TimeoutError):
                pass
            finally:
                with LOCK:
                    PROXY_PORTS.discard(proxy_port)

    def do_GET(self):
        self.send(403, {})

    do_POST = do_GET


if __name__ == '__main__':
    assert os.geteuid() == 0 and Path('/proc/1/comm').read_text().strip() == 'systemd'
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(PRIVATE / 'fixture.pem', PRIVATE / 'fixture-key.pem')
    servers = []
    for address, handler, tls in [(('127.0.0.2', 443), Registry, True),
                                  (('127.0.0.2', 9000), Model, True),
                                  (('127.0.0.1', 9001), Proxy, False),
                                  (('127.0.0.1', 9002), Control, False)]:
        server = ThreadingHTTPServer(address, handler)
        server.daemon_threads = True
        if tls:
            server.socket = context.wrap_socket(server.socket, server_side=True)
        servers.append(server)
        threading.Thread(target=server.serve_forever, daemon=True).start()
    threading.Event().wait()
