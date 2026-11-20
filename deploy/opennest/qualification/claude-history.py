"""Generate and cold-evict native Claude JSONL only on the disposable runner."""
import argparse
import json
import os
from pathlib import Path
import uuid

parser = argparse.ArgumentParser()
parser.add_argument("operation", choices=["seed", "evict"])
args = parser.parse_args()
home = Path("/home/opennest-qualification")
assert os.getuid() == 17002 and Path.home() == home
assert (home / ".opennest-qualification").read_text() == "OpenNest synthetic qualification fixture v1\n"
native = home / ".config/opennest/claude/projects"
project = home / "seed-project"
folder = native / str(project).replace("/", "-")
folder.mkdir(parents=True, exist_ok=True)
prefix = (("Synthetic native Claude qualification transcript with searchable work markers. " * 430) + "\n")
if args.operation == "seed":
    files = 0
    size = 0
    metadata = home / ".local/state/opennest/claude/ui.json"
    stored = json.loads(metadata.read_text())
    assert stored["version"] == 1
    archived = 0
    children = 0
    for index in range(2050):
        session = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"opennest-claude-{index}"))
        target = folder / f"{session}.jsonl"
        parent = None
        with target.open("wb") as output:
            for entry in range(57):
                message_id = str(uuid.uuid5(uuid.UUID(session), str(entry)))
                role = "assistant" if entry % 2 else "user"
                record = {
                    "type": role, "cwd": str(project), "sessionId": session, "uuid": message_id,
                    "parentUuid": parent, "timestamp": "2026-01-01T00:00:00.000Z",
                    "version": "2.1.289", "isSidechain": False,
                    "message": {"role": role, "content": [{"type": "text", "text": f"QUALIFICATION_HISTORY {index}/{entry} {prefix}"}]},
                }
                output.write(json.dumps(record, separators=(",", ":")).encode() + b"\n")
                parent = message_id
        size += target.stat().st_size
        files += 1
        if index >= 2000:
            stored["threads"][session] = {
                "id": session, "cwd": str(project), "projectId": None,
                "title": f"Archived qualification session {index}",
                "createdAt": 1, "updatedAt": 1, "readAt": 1, "viewedAt": 1,
                "pinned": False, "archived": True,
                "settings": {"collaborationMode": "default"}, "nativeHistory": True,
                "draft": None, "queue": [], "deliveries": {},
            }
            archived += 1
        if index < 20:
            child = folder / session / "subagents" / f"agent-fixture{index}.jsonl"
            child.parent.mkdir(parents=True, exist_ok=True)
            child.write_text(json.dumps({**record, "isSidechain": True}) + "\n")
            children += 1
    assert size >= 3 * 1024**3
    temporary = metadata.with_suffix(".seed.tmp")
    temporary.write_text(json.dumps(stored))
    temporary.chmod(0o600)
    temporary.replace(metadata)
    print(json.dumps({"nonArchivedSessions": files - archived, "archivedSessions": archived,
                      "childTranscripts": children, "historyBytes": size}))
else:
    for path in folder.glob("*.jsonl"):
        with path.open("rb") as stream:
            os.posix_fadvise(stream.fileno(), 0, 0, os.POSIX_FADV_DONTNEED)
