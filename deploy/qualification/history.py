"""Generate and check synthetic history from a real persisted native rollout."""

import copy
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import uuid

HOME = Path('/home/nest-qualification')
NATIVE = HOME / '.codex'
PRIVATE = Path('/qualification-private')
OUTPUT = Path('/qualification-output')


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def conversation(index, turn, assistant):
    lines = [f'Qualification project {index}, review batch {turn}. '
             'Check the retry and recovery decisions for these independent operations.']
    for operation in range(48):
        attempt = index * 100000 + turn * 100 + operation
        if assistant:
            lines.append(f'Operation {attempt}: persist the accepted receipt before dispatch; '
                         f'after reconnect use receipt {attempt} to resume the existing turn. '
                         'If acknowledgement is missing, inspect durable delivery status first. '
                         'Do not repeat an accepted operation. Keep the queued follow-up and '
                         'its approval associated with the original conversation.')
        else:
            lines.append(f'Operation {attempt} accepted a request while its client disconnected. '
                         'The worker remains alive and writes the result to durable history. '
                         'Explain how the resumed client should distinguish a completed '
                         'operation from an unacknowledged submission, retaining the original '
                         'receipt and the next queued message without another side effect.')
    return '\n'.join(lines)


def create(seed_id):
    seed_files = list((NATIVE / 'sessions').rglob(f'*{seed_id}.jsonl'))
    assert len(seed_files) == 1, 'Expected one real native seed rollout'
    seed = [json.loads(line) for line in seed_files[0].read_text().splitlines() if line]
    header = next(row for row in seed if row['type'] == 'session_meta')
    turn_rows = [row for row in seed if row['type'] != 'session_meta']
    assert any(row.get('payload', {}).get('role') == 'user' for row in turn_rows)
    assert any(row.get('payload', {}).get('role') == 'assistant' for row in turn_rows)
    profiles = {'live': 2000, 'archived': 40, 'nested': 8}
    expected_bytes = 3 * 1024 ** 3
    manifests = []
    parent_id = str(uuid.uuid4())
    uuid_pattern = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
    seed_turns = {row['payload']['turn_id'] for row in turn_rows
                  if row.get('payload', {}).get('type') in ('task_started', 'turn_started')}
    assert len(seed_turns) == 1, 'Expected one completed canonical seed turn'
    for index in range(sum(profiles.values())):
        kind = 'live' if index < 2000 else 'archived' if index < 2040 else 'nested'
        identity = parent_id if index == 0 else str(uuid.uuid4())
        timestamp = (datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc)
                     + datetime.timedelta(minutes=index))
        # Native's archive operation creates the matching metadata. Construct
        # files as live input; the actual import will archive the requested 40.
        folder = NATIVE / 'sessions' / timestamp.strftime('%Y/%m/%d')
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f'rollout-{timestamp.strftime("%Y-%m-%dT%H-%M-%S")}-{identity}.jsonl'
        meta = copy.deepcopy(header)
        meta['timestamp'] = timestamp.isoformat()
        meta['payload']['id'] = identity
        meta['payload']['session_id'] = parent_id if kind == 'nested' else identity
        meta['payload']['timestamp'] = timestamp.isoformat()
        thread_identities = {seed_id: identity}
        if meta['payload'].get('context_window', {}).get('window_id'):
            previous_window = meta['payload']['context_window']['window_id']
            thread_identities[previous_window] = str(uuid.uuid4())
            meta['payload']['context_window']['window_id'] = thread_identities[previous_window]
        if kind == 'nested':
            # Rollout serde uses lowercase "subagent"; the app-server JSON API
            # uses a different camelCase source representation.
            meta['payload']['source'] = {'subagent': {'thread_spawn': {
                'parent_thread_id': parent_id, 'depth': 1,
                'agent_path': f'/root/qualification_{index}',
                'agent_nickname': 'Qualification', 'agent_role': 'worker'}}}
            meta['payload']['parent_thread_id'] = parent_id
            meta['payload']['agent_path'] = f'/root/qualification_{index}'
            meta['payload']['thread_source'] = 'subagent'
            # A V1 child is independently resumable. Copying the seed's V2
            # marker would invent parent-owned agents without their real parent
            # ownership. Application-managed Team work is exercised separately.
            meta['payload']['multi_agent_version'] = 'v1'
        # Genuine user/assistant records, derived from the running binary's schema.
        # Several sessions are deliberately much longer than the common profile.
        turns = 200 if index < 8 else 28
        with path.open('w') as stream:
            stream.write(json.dumps(meta) + '\n')
            ordinal = min((row['ordinal'] for row in turn_rows
                           if isinstance(row.get('ordinal'), int)), default=0)
            for turn in range(turns):
                turn_id = str(uuid.uuid4())
                identities = {**thread_identities, next(iter(seed_turns)): turn_id}
                user_text, assistant_text = conversation(index, turn, False), conversation(index, turn, True)
                def replace_id(match):
                    value = match[0]
                    if value not in identities:
                        identities[value] = str(uuid.uuid4())
                    return identities[value]
                def remap(value, key=''):
                    if isinstance(value, dict):
                        return {name: remap(child, name) for name, child in value.items()}
                    if isinstance(value, list):
                        return [remap(child, key) for child in value]
                    if isinstance(value, str):
                        if key == 'session_id' and value == seed_id:
                            return meta['payload']['session_id']
                        if key == 'id' or key.endswith(('_id', 'Id')):
                            return uuid_pattern.sub(replace_id, value)
                    return value
                for original in turn_rows:
                    row = remap(original)
                    payload = row.get('payload', {})
                    role = payload.get('role')
                    if row['type'] == 'response_item' and role in ('user', 'assistant'):
                        payload['content'] = [{'type': 'output_text' if role == 'assistant'
                                               else 'input_text',
                                               'text': assistant_text if role == 'assistant' else user_text}]
                    if row['type'] == 'event_msg' and payload.get('type') in ('user_message', 'agent_message'):
                        payload['message'] = assistant_text if payload['type'] == 'agent_message' else user_text
                    if row['type'] == 'event_msg' and payload.get('type') == 'item_completed':
                        item = payload.get('item', {})
                        if item.get('type') == 'UserMessage':
                            item['content'] = [{'type': 'text', 'text': user_text}]
                        elif item.get('type') == 'AgentMessage':
                            item['content'] = [{'type': 'Text', 'text': assistant_text}]
                    row['timestamp'] = (timestamp + datetime.timedelta(seconds=turn)).isoformat()
                    if 'ordinal' in row:
                        row['ordinal'] = ordinal
                        ordinal += 1
                    # Turn attribution, passthrough metadata and completed-item
                    # events also contain IDs. Keep every cross-reference aligned
                    # while giving each cloned turn/item/client receipt a fresh ID.
                    stream.write(json.dumps(row) + '\n')
        manifests.append({'id': identity, 'kind': kind, 'path': str(path),
                          'bytes': path.stat().st_size, 'sha256': digest(path), 'turns': turns})
    total = sum(row['bytes'] for row in manifests)
    assert total >= expected_bytes, f'Meaningful history too small: {total}'
    (PRIVATE / 'history-manifest.json').write_text(json.dumps(manifests))
    (OUTPUT / 'history-profile.json').write_text(json.dumps({
        'nonArchivedSessions': profiles['live'] + profiles['nested'],
        'archivedSessions': profiles['archived'], 'nestedSessions': profiles['nested'],
        'longSessions': 8, 'bytes': total, 'sparseFiles': False,
        'nestedHistoryProtocol': 'native v1 independently resumable children',
        'seed': 'real native thread/start and turn/start persisted rollout',
        'nativeImport': 'pending real Native writer materialization',
        'indexRebuild': 'pending metadata-index reconstruction',
        'manifestSha256': digest(PRIVATE / 'history-manifest.json')}, indent=2) + '\n')
    print(json.dumps({'historyFiles': len(manifests), 'bytes': total}))


def freeze():
    """Freeze actual Native-canonicalized files and remove only its metadata index."""
    manifest_path = PRIVATE / 'history-manifest.json'
    manifests = json.loads(manifest_path.read_text())
    for row in manifests:
        path = Path(row['path'])
        assert path.is_file(), 'Native-imported canonical history missing'
        row['bytes'], row['sha256'] = path.stat().st_size, digest(path)
    total = sum(row['bytes'] for row in manifests)
    assert total >= 3 * 1024 ** 3, 'Native-canonicalized workload below mandatory 3 GiB'
    assert (NATIVE / 'thread_history_1.sqlite').is_file(), 'Native history projection missing'
    # The driver stopped every real app-server after materialization. Keep the
    # paginated history view and goals/queues; they are not the session index.
    for database in NATIVE.glob('*.sqlite'):
        with sqlite3.connect(database) as connection:
            assert connection.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()[0] == 0
            assert connection.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
    backup = PRIVATE / 'metadata-index-before-rebuild'
    backup.mkdir()
    indexes = list(NATIVE.glob('state_*.sqlite'))
    assert indexes, 'Expected a real Native metadata index'
    for database in indexes:
        for source in (database, Path(str(database) + '-wal'), Path(str(database) + '-shm')):
            if source.exists():
                source.rename(backup / source.name)
    manifest_path.write_text(json.dumps(manifests))
    profile_path = OUTPUT / 'history-profile.json'
    profile = json.loads(profile_path.read_text())
    profile.update(bytes=total, nativeImport='real thread/resume writer, archive/unarchive and read',
                   indexRebuild='only consistent state_*.sqlite moved with native stopped',
                   historyProjection='real Native thread_history_1.sqlite retained and quick_check passed',
                   manifestSha256=digest(manifest_path))
    profile_path.write_text(json.dumps(profile, indent=2)+'\n')


def check():
    manifests = json.loads((PRIVATE / 'history-manifest.json').read_text())
    for row in manifests:
        path = Path(row['path'])
        assert path.is_file() and path.stat().st_size == row['bytes'], 'History lost or truncated'
        assert digest(path) == row['sha256'], 'Existing synthetic history changed'
    print(json.dumps({'intactHistoryFiles': len(manifests)}))


def evict():
    manifests = json.loads((PRIVATE / 'history-manifest.json').read_text())
    paths = [Path(row['path']) for row in manifests] + list(NATIVE.glob('*.sqlite*'))
    for path in paths:
        if not path.is_file():
            continue
        with path.open('rb') as stream:
            os.fsync(stream.fileno())
            os.posix_fadvise(stream.fileno(), 0, 0, os.POSIX_FADV_DONTNEED)


if __name__ == '__main__':
    assert os.geteuid() == 17001 and Path.home() == HOME
    if sys.argv[1] == 'create':
        create(sys.argv[2])
    elif sys.argv[1] == 'check':
        check()
    elif sys.argv[1] == 'evict':
        evict()
    elif sys.argv[1] == 'freeze':
        freeze()
    else:
        raise ValueError('Unknown history operation')
