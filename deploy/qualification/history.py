"""Generate and check synthetic history from a real persisted native rollout."""

import copy
import datetime
import hashlib
import json
import os
from pathlib import Path
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
    for index in range(sum(profiles.values())):
        kind = 'live' if index < 2000 else 'archived' if index < 2040 else 'nested'
        identity = parent_id if index == 0 else str(uuid.uuid4())
        timestamp = (datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc)
                     + datetime.timedelta(minutes=index))
        folder = NATIVE / ('archived_sessions' if kind == 'archived' else 'sessions')
        if kind != 'archived':
            folder = folder / timestamp.strftime('%Y/%m/%d')
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f'rollout-{timestamp.strftime("%Y-%m-%dT%H-%M-%S")}-{identity}.jsonl'
        meta = copy.deepcopy(header)
        meta['timestamp'] = timestamp.isoformat()
        meta['payload']['id'] = identity
        meta['payload']['timestamp'] = timestamp.isoformat()
        if kind == 'nested':
            meta['payload']['source'] = {'subAgent': {'thread_spawn': {
                'parent_thread_id': parent_id, 'depth': 1, 'agent_path': 'qualification',
                'agent_nickname': 'Qualification', 'agent_role': 'worker'}}}
        # Genuine user/assistant records, derived from the running binary's schema.
        # Several sessions are deliberately much longer than the common profile.
        turns = 200 if index < 8 else 28
        with path.open('w') as stream:
            stream.write(json.dumps(meta) + '\n')
            for turn in range(turns):
                turn_id = str(uuid.uuid4())
                for original in turn_rows:
                    row = copy.deepcopy(original)
                    payload = row.get('payload', {})
                    if 'turn_id' in payload:
                        payload['turn_id'] = turn_id
                    if 'turnId' in payload:
                        payload['turnId'] = turn_id
                    if payload.get('type') == 'turn_context':
                        payload['turn_id'] = turn_id
                    role = payload.get('role')
                    if row['type'] == 'response_item' and role in ('user', 'assistant'):
                        payload['content'] = [{'type': 'output_text' if role == 'assistant'
                                               else 'input_text',
                                               'text': conversation(index, turn, role == 'assistant')}]
                    if row['type'] == 'event_msg' and payload.get('type') in ('user_message', 'agent_message'):
                        payload['message'] = conversation(index, turn, payload['type'] == 'agent_message')
                    row['timestamp'] = (timestamp + datetime.timedelta(seconds=turn)).isoformat()
                    stream.write(json.dumps(row).replace(seed_id, identity) + '\n')
        manifests.append({'id': identity, 'kind': kind, 'path': str(path),
                          'bytes': path.stat().st_size, 'sha256': digest(path), 'turns': turns})
    total = sum(row['bytes'] for row in manifests)
    assert total >= expected_bytes, f'Meaningful history too small: {total}'
    (PRIVATE / 'history-manifest.json').write_text(json.dumps(manifests))
    # All native processes have been stopped by the driver. Preserve a consistent
    # previous index and force real native index reconstruction from these files.
    backup = PRIVATE / 'index-before-rebuild'
    backup.mkdir()
    for database in NATIVE.glob('*.sqlite'):
        with sqlite3.connect(database) as connection:
            assert connection.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()[0] == 0
        for source in (database, Path(str(database) + '-wal'), Path(str(database) + '-shm')):
            if source.exists():
                source.rename(backup / source.name)
    (OUTPUT / 'history-profile.json').write_text(json.dumps({
        'nonArchivedSessions': profiles['live'] + profiles['nested'],
        'archivedSessions': profiles['archived'], 'nestedSessions': profiles['nested'],
        'longSessions': 8, 'bytes': total, 'sparseFiles': False,
        'seed': 'real native thread/start and turn/start persisted rollout',
        'indexRebuild': 'previous consistent native SQLite files moved while daemon stopped',
        'manifestSha256': digest(PRIVATE / 'history-manifest.json')}, indent=2) + '\n')
    print(json.dumps({'historyFiles': len(manifests), 'bytes': total}))


def check():
    manifests = json.loads((PRIVATE / 'history-manifest.json').read_text())
    for row in manifests:
        path = Path(row['path'])
        assert path.is_file() and path.stat().st_size == row['bytes'], 'History lost or truncated'
        assert digest(path) == row['sha256'], 'Existing synthetic history changed'
    print(json.dumps({'intactHistoryFiles': len(manifests)}))


def evict():
    manifests = json.loads((PRIVATE / 'history-manifest.json').read_text())
    for row in manifests:
        with open(row['path'], 'rb') as stream:
            os.posix_fadvise(stream.fileno(), 0, 0, os.POSIX_FADV_DONTNEED)


if __name__ == '__main__':
    assert os.geteuid() == 17001 and Path.home() == HOME
    if sys.argv[1] == 'create':
        create(sys.argv[2])
    elif sys.argv[1] == 'check':
        check()
    elif sys.argv[1] == 'evict':
        evict()
    else:
        raise ValueError('Unknown history operation')
