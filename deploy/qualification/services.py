"""Disposable artifact registry and model/OAuth services; never a native RPC mock."""

import base64
import json
import os
from pathlib import Path
import re
import select
import socket
import ssl
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit
import uuid

ROOT = Path('/qualification-input')
PRIVATE = Path('/qualification-private')
STATE = {'manifest': json.loads((ROOT / 'baseline.json').read_text()),
         'requests': {}, 'released': [], 'oauthGeneration': 0, 'authFailure': False,
         'proxyConnections': 0, 'deniedConnections': 0, 'directModelRequests': 0}
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
        assert set(changes) <= {'manifest', 'released', 'authFailure'}
        with LOCK:
            STATE.update(changes)
            self.send(200, STATE)


class Model(Handler):
    def do_GET(self):
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
            with LOCK:
                STATE['oauthGeneration'] += 1
                generation = STATE['oauthGeneration']
                failed = STATE['authFailure']
            self.send(401 if failed else 200,
                      {'error': 'invalid_grant'} if failed else
                      {'id_token': jwt(generation), 'access_token': jwt(generation),
                       'refresh_token': f'qualification-refresh-{generation}',
                       'token_type': 'Bearer', 'expires_in': 3600})
            return
        if not self.path.endswith('/responses'):
            self.send(404, {})
            return
        # Only record opaque operation identifiers, never request bodies or credentials.
        payload = json.loads(body)
        users = [item for item in payload.get('input', [])
                 if isinstance(item, dict) and item.get('role') == 'user']
        text = '\n'.join(part.get('text', '') for part in users[-1].get('content', [])
                         if isinstance(part, dict)) if users else ''
        match = re.fullmatch(r'QUALIFICATION_(REQUEST|HOLD):([a-zA-Z0-9_-]+)', text.strip())
        marker = match[2] if match else 'unmarked'
        held = bool(match and match[1] == 'HOLD')
        with LOCK:
            STATE['requests'][marker] = STATE['requests'].get(marker, 0) + 1
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
        item = {'id': str(uuid.uuid4()), 'type': 'message', 'role': 'assistant',
                'status': 'completed', 'content': [{'type': 'output_text',
                                                   'text': f'QUALIFICATION_OK:{marker}',
                                                   'annotations': []}]}
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
            with LOCK:
                STATE['proxyConnections'] += 1
                PROXY_PORTS.add(upstream.getsockname()[1])
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
