"""Build meaningful V1 OpenCode history from a real 1.19.5 writer seed, offline only."""

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time

GIB = 1024 ** 3
CANONICAL_VERSION = '1.19.5'
MARKER = 'OpenNest synthetic qualification fixture v1\n'


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def digest_file(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def check_location(args):
    home = Path(args.home).resolve(strict=True)
    assert (home / '.opennest-qualification').read_text() == MARKER, 'Missing isolated fixture marker'
    database = Path(args.database).resolve(strict=True)
    assert database.is_relative_to(home) and database.name == 'opencode.db', 'Database is outside isolated HOME'
    for item in (Path(args.manifest), Path(args.profile)):
        item.parent.mkdir(parents=True, exist_ok=True)
    return home, database


def conversation(index, turn, role):
    """Actual readable operation/recovery discussions, not null padding or random blobs."""
    lines = [f'QUALIFICATION_HISTORY:{index}:{turn}:{role}',
             f'Review project {index % 20}, session {index}, turn {turn} as an independent recovery case.']
    for offset in range(112 if role == 'user' else 124):
        operation = index * 1000000 + turn * 1000 + offset
        if role == 'user':
            lines.append(f'Operation {operation} accepted receipt R-{operation} before the browser disconnected. '
                         f'The native worker remains alive and updates file results/{operation}.txt. '
                         'Explain how to reconnect to that accepted turn, retain its queued follow-up and '
                         'question draft, distinguish durable completion from uncertain delivery, and '
                         'avoid sending the original operation twice.')
        else:
            lines.append(f'Recovery decision {operation}: preserve accepted receipt R-{operation} and '
                         'the original native message identifier. Read the canonical native turn and '
                         'continue from its observed state. Resume a prepared follow-up exactly once; '
                         'keep a pending question and approval associated with its initial session. '
                         'Do not repeat the accepted operation when its acknowledgement is missing.')
    return '\n'.join(lines)


def message_identity(index, turn, role):
    # Historical IDs sort before newly created native/app message IDs.
    return f'msg_000000{index:06x}{turn:05x}{0 if role == "user" else 1:x}'


def insert(connection, table, row):
    columns = list(row)
    connection.execute('INSERT INTO "' + table + '" (' + ','.join('"' + key + '"' for key in columns) +
                       ') VALUES (' + ','.join('?' for _ in columns) + ')', [row[key] for key in columns])


def remap_message(template, identity, session_id, now, parent_id, directory):
    row = dict(template)
    row.update(id=identity, session_id=session_id, time_created=now, time_updated=now + 1)
    data = json.loads(row['data'])
    data['time'] = {'created': now, **({'completed': now + 1} if data['role'] == 'assistant' else {})}
    if data['role'] == 'assistant':
        data['parentID'] = parent_id
        data['path'] = {'cwd': str(directory), 'root': str(directory)}
    row['data'] = encoded(data)
    return row


def seed(args):
    home, database = check_location(args)
    # The native service must be stopped before manipulating synthetic storage.
    assert args.native_stopped, 'Explicit --native-stopped acknowledgement is required'
    connection = sqlite3.connect(database, timeout=5)
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA foreign_keys=ON')
    connection.execute('PRAGMA busy_timeout=5000')
    assert connection.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
    required = {'session': {'id', 'project_id', 'directory', 'version', 'time_archived'},
                'message': {'id', 'session_id', 'data', 'time_created', 'time_updated'},
                'part': {'id', 'session_id', 'message_id', 'data', 'time_created', 'time_updated'}}
    for table, columns in required.items():
        actual = {row['name'] for row in connection.execute('PRAGMA table_info("' + table + '")')}
        assert columns <= actual, 'Unknown native history schema'
    original = connection.execute('SELECT * FROM session WHERE id=?', (args.seed,)).fetchone()
    assert original and original['version'] == CANONICAL_VERSION, 'A real native 1.19.5 seed is required'
    originals = [dict(row) for row in connection.execute('SELECT * FROM message WHERE session_id=? ORDER BY time_created,id', (args.seed,))]
    user = next(row for row in originals if json.loads(row['data'])['role'] == 'user')
    assistant = next(row for row in reversed(originals) if json.loads(row['data'])['role'] == 'assistant' and json.loads(row['data']).get('time', {}).get('completed'))
    assert connection.execute('SELECT count(*) FROM part WHERE message_id=? AND json_extract(data,\'$.type\')=\'text\'', (user['id'],)).fetchone()[0]
    assert connection.execute('SELECT count(*) FROM part WHERE message_id=? AND json_extract(data,\'$.type\')=\'text\'', (assistant['id'],)).fetchone()[0]
    # Actual V1 stores transcript bodies in SQLite. Native file parts below point
    # to real source documents; no invented JSONL transcript mirror is counted.
    total = args.live + args.archived + args.nested
    assert args.live >= 1 and args.projects >= 1 and total <= 10000
    assert not connection.execute("SELECT 1 FROM session WHERE id LIKE 'ses_qualification_%' LIMIT 1").fetchone(), 'Fixture history already exists'
    project_root = home / 'qualification-projects'
    directories = [project_root / f'project-{index:02}' for index in range(args.projects)]
    for directory in directories:
        (directory / 'documents').mkdir(parents=True, exist_ok=True)
    sessions, files = [], []
    payload_bytes = 0
    base_time = min(int(time.time() * 1000) - 86400000, original['time_created'] - 86400000)
    started = time.monotonic()
    connection.execute('BEGIN IMMEDIATE')
    try:
        for index in range(total):
            kind = 'live' if index < args.live else 'archived' if index < args.live + args.archived else 'nested'
            directory = directories[index % len(directories)]
            session_id = f'ses_qualification_{index:06d}'
            now = base_time + index * 10000
            turns = args.long_turns if index < min(args.long_sessions, total) else args.turns
            row = dict(original)
            for field in ('tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write', 'cost'):
                row[field] *= turns
            row.update(id=session_id, slug=f'qualification-{index:06d}', directory=str(directory),
                       path=str(directory).lstrip('/'), title=f'Qualification {kind} history {index:06d}',
                       parent_id='ses_qualification_000000' if kind == 'nested' else None,
                       time_created=now, time_updated=now + 9999,
                       time_archived=now + 9999 if kind == 'archived' else None,
                       time_compacting=None, revert=None, permission=None, metadata=None,
                       workspace_id=None, summary_diffs=None, share_url=None)
            insert(connection, 'session', row)
            transcript = hashlib.sha256()
            session_bytes = 0
            first_user = first_answer = last_user = last_answer = None
            for turn in range(turns):
                turn_time = now + turn * 10
                user_id, answer_id = message_identity(index, turn, 'user'), message_identity(index, turn, 'assistant')
                for template, message_id, role in ((user, user_id, 'user'), (assistant, answer_id, 'assistant')):
                    message = remap_message(template, message_id, session_id, turn_time + (role == 'assistant'), user_id, directory)
                    insert(connection, 'message', message)
                    transcript.update(message['data'].encode()); session_bytes += len(message['data'].encode())
                    text = conversation(index, turn, role)
                    values = [{'type': 'text', 'text': text}]
                    if role == 'assistant':
                        values[0]['time'] = {'start': turn_time + 1, 'end': turn_time + 2}
                        values.insert(0, {'type': 'step-start'})
                        values.append({'type': 'step-finish', 'reason': 'stop', 'cost': 0,
                                       'tokens': json.loads(message['data'])['tokens']})
                    for part_index, part in enumerate(values):
                        raw = encoded(part)
                        insert(connection, 'part', {'id': f'prt_qualification_{index:06d}_{turn:05d}_{role[0]}_{part_index}',
                                                   'session_id': session_id, 'message_id': message_id,
                                                   'time_created': turn_time + part_index, 'time_updated': turn_time + part_index + 1, 'data': raw})
                        transcript.update(raw.encode()); session_bytes += len(raw.encode())
                if turn == 0:
                    first_user, first_answer = user_id, answer_id
                last_user, last_answer = user_id, answer_id
            if index % 32 == 0:
                document = directory / 'documents' / f'recovery-{index:06d}.txt'
                document.write_text('\n\n'.join(conversation(index, case, 'user') for case in range(8)))
                raw = encoded({'type': 'file', 'mime': 'text/plain', 'filename': document.name, 'url': document.as_uri()})
                insert(connection, 'part', {'id': f'prt_qualification_{index:06d}_document', 'session_id': session_id,
                                           'message_id': first_user, 'time_created': now + 1, 'time_updated': now + 1, 'data': raw})
                transcript.update(raw.encode()); session_bytes += len(raw.encode())
                files.append({'path': str(document), 'bytes': document.stat().st_size, 'sha256': digest_file(document), 'sessionId': session_id})
            payload_bytes += session_bytes
            sessions.append({'id': session_id, 'kind': kind, 'directory': str(directory), 'projectId': row['project_id'],
                             'turns': turns, 'bytes': session_bytes, 'sha256': transcript.hexdigest(),
                             'firstUser': first_user, 'firstAnswer': first_answer, 'lastUser': last_user, 'lastAnswer': last_answer})
            if index % 32 == 31:
                connection.commit()
                assert connection.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()[0] == 0
                connection.execute('BEGIN IMMEDIATE')
        connection.commit()
        assert connection.execute('PRAGMA foreign_key_check').fetchone() is None
        assert connection.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
        assert connection.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()[0] == 0
    finally:
        connection.close()
    file_bytes = sum(item['bytes'] for item in files)
    native_database_bytes = database.stat().st_size
    assert database.stat().st_blocks * 512 >= native_database_bytes * 0.95, 'Sparse native database is not representative history'
    assert payload_bytes + file_bytes >= args.minimum_bytes, f'Meaningful native history too small: {payload_bytes + file_bytes}'
    manifest = {'schemaVersion': 1, 'nativeVersion': CANONICAL_VERSION, 'database': str(database),
                'seedSession': args.seed, 'sessions': sessions, 'files': files}
    Path(args.manifest).write_text(encoded(manifest))
    profile = {'nonArchivedSessions': args.live + args.nested, 'archivedSessions': args.archived,
               'nestedSessions': args.nested, 'longSessions': min(args.long_sessions, total),
               'projects': [str(path) for path in directories], 'projectCount': len(directories),
               'bytes': native_database_bytes + file_bytes, 'historyBytes': native_database_bytes + file_bytes,
               'nativeDatabaseBytes': native_database_bytes, 'referencedFileBytes': file_bytes,
               'storageRepresentation': 'opencode-v1-sqlite-and-file-parts',
               'databasePayloadBytes': payload_bytes, 'nativeFileBytes': file_bytes, 'sparseFiles': False,
               'nativeVersion': CANONICAL_VERSION, 'nativeSchemaSource': 'actual V1 native session/message/part writer seed',
               'storage': 'canonical native SQLite conversation bodies plus native file-part documents',
               'nativeApiValidation': 'pending real native reads/resumption by lifecycle driver',
               'manifestSha256': digest_file(Path(args.manifest)), 'generationSeconds': time.monotonic() - started,
               'samples': [sessions[index] for index in sorted({0, min(1, total - 1), min(args.live - 1, total - 1), min(args.live, total - 1), total - 1})]}
    Path(args.profile).write_text(json.dumps(profile, indent=2) + '\n')
    print(encoded({key: profile[key] for key in ('nonArchivedSessions', 'archivedSessions', 'nestedSessions', 'bytes', 'generationSeconds')}))


def verify(args):
    _, database = check_location(args)
    manifest = json.loads(Path(args.manifest).read_text())
    connection = sqlite3.connect('file:' + str(database) + '?mode=ro', uri=True, timeout=5)
    connection.row_factory = sqlite3.Row
    try:
        assert connection.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
        assert connection.execute('PRAGMA foreign_key_check').fetchone() is None
        for expected in manifest['sessions']:
            actual = connection.execute('SELECT id,directory,parent_id,time_archived FROM session WHERE id=?', (expected['id'],)).fetchone()
            assert actual and actual['directory'] == expected['directory'], 'Native session missing or relocated'
            assert bool(actual['time_archived']) == (expected['kind'] == 'archived'), 'Native archive state lost'
            assert (actual['parent_id'] == 'ses_qualification_000000') == (expected['kind'] == 'nested'), 'Native lineage lost'
            value = hashlib.sha256()
            payload_bytes = 0
            # Same semantic ordering used by seed, independent from SQL row layout.
            for turn in range(expected['turns']):
                for role in ('user', 'assistant'):
                    message_id = message_identity(int(expected['id'].rsplit('_', 1)[1]), turn, role)
                    message = connection.execute('SELECT data FROM message WHERE id=? AND session_id=?', (message_id, expected['id'])).fetchone()
                    assert message, 'Native message missing'
                    value.update(message['data'].encode()); payload_bytes += len(message['data'].encode())
                    parts = connection.execute('SELECT data FROM part WHERE message_id=? AND id NOT LIKE \'%_document\' ORDER BY id', (message_id,)).fetchall()
                    for part in parts:
                        value.update(part['data'].encode()); payload_bytes += len(part['data'].encode())
            document = connection.execute('SELECT data FROM part WHERE id=?', (f'prt_qualification_{int(expected["id"].rsplit("_", 1)[1]):06d}_document',)).fetchone()
            if document:
                value.update(document['data'].encode()); payload_bytes += len(document['data'].encode())
            assert value.hexdigest() == expected['sha256'] and payload_bytes == expected['bytes'], 'Existing native conversation changed'
        for expected in manifest['files']:
            path = Path(expected['path'])
            assert path.is_file() and path.stat().st_size == expected['bytes'] and digest_file(path) == expected['sha256'], 'Native document changed'
    finally:
        connection.close()
    print(encoded({'intactSessions': len(manifest['sessions']), 'intactNativeFiles': len(manifest['files'])}))


def evict(args):
    _, database = check_location(args)
    manifest = json.loads(Path(args.manifest).read_text())
    for path in [database, *[Path(item['path']) for item in manifest['files']]]:
        with path.open('rb') as stream:
            os.fsync(stream.fileno())
            os.posix_fadvise(stream.fileno(), 0, 0, os.POSIX_FADV_DONTNEED)
    print(encoded({'evictedPrivateFixtureFiles': len(manifest['files']) + 1}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['seed', 'verify', 'evict'])
    parser.add_argument('--home', default='/home/opennest-qualification')
    parser.add_argument('--database', required=True)
    parser.add_argument('--manifest', default='/opennest-qualification-private/history-manifest.json')
    parser.add_argument('--profile', default='/opennest-qualification-output/history-profile.json')
    parser.add_argument('--seed')
    parser.add_argument('--native-stopped', action='store_true')
    parser.add_argument('--live', type=int, default=2000)
    parser.add_argument('--archived', type=int, default=40)
    parser.add_argument('--nested', type=int, default=8)
    parser.add_argument('--projects', type=int, default=20)
    parser.add_argument('--turns', type=int, default=24)
    parser.add_argument('--long-turns', type=int, default=160)
    parser.add_argument('--long-sessions', type=int, default=8)
    parser.add_argument('--minimum-bytes', type=int, default=3 * GIB)
    args = parser.parse_args()
    if args.operation == 'seed':
        seed(args)
    elif args.operation == 'verify':
        verify(args)
    else:
        evict(args)


if __name__ == '__main__':
    main()
