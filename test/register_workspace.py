"""Register the DeskResume workspace in the DSH workspace registry.

The registry is the `workspace` storage domain (version 2), persisted at
$DSH_HOME/storages/workspace.json. Its `create` operation:

  1. canonicalises the directory path (realpath),
  2. writes the record into tables.workspaces,
  3. prepends the new id to global.workspaceIds.

Startup validation rejects duplicate paths, duplicate session accounts and
order drift (workspaceIds must list exactly the table keys). This script
reproduces the create semantics offline and verifies those invariants before
and after writing, so a running DSH instance can still load the file.
"""

import json
import os
import shutil
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

DSH_HOME = Path(os.environ.get("DSH_HOME", Path.home() / ".dsh"))
REGISTRY = DSH_HOME / "storages" / "workspace.json"

TARGET_DIR = Path(sys.argv[1] if len(sys.argv) > 1 else r"D:\DeepSeek\harness\DeskResume")
TITLE = sys.argv[2] if len(sys.argv) > 2 else TARGET_DIR.name


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + \
           f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z"


def fail(msg):
    print(f"FAIL: {msg}")
    sys.exit(1)


def main():
    if not TARGET_DIR.is_dir():
        fail(f"target directory does not exist: {TARGET_DIR}")
    canonical = str(TARGET_DIR.resolve())

    if not REGISTRY.is_file():
        fail(f"registry not found: {REGISTRY}")

    data = json.loads(REGISTRY.read_text(encoding="utf-8"))

    if data.get("unit", {}).get("name") != "workspace":
        fail(f"unexpected storage unit: {data.get('unit')}")
    version = data.get("unit", {}).get("version")
    if version != 2:
        fail(f"unexpected workspace domain version: {version}")

    g = data["global"]
    table = data["tables"]["workspaces"]
    ids = list(g["workspaceIds"])

    print(f"registry   : {REGISTRY}")
    print(f"target     : {canonical}")
    print(f"existing   : {len(table)} workspace(s), order={len(ids)}")

    # Invariant the registry itself enforces on start: order must mirror the table.
    if set(ids) != set(table.keys()):
        fail("order drift: workspaceIds does not match the table keys")
    if len(ids) != len(set(ids)):
        fail("duplicate ids in workspaceIds")

    # Idempotency: an existing registration for this path is left alone.
    for wid, rec in table.items():
        if str(rec.get("path", "")).lower() == canonical.lower():
            print(f"ALREADY REGISTERED as {wid} (title={rec.get('title')!r})")
            print("nothing to do")
            return

    seen_paths = {}
    for wid, rec in table.items():
        key = str(rec.get("path", "")).lower()
        if key in seen_paths:
            fail(f"duplicate paths already present: {seen_paths[key]} and {wid}")
        seen_paths[key] = wid

    new_id = str(uuid.uuid4())
    stamp = now_iso()
    record = {
        "path": canonical,
        "title": TITLE,
        "sessionIds": [],
        "createdAt": stamp,
        "updatedAt": stamp,
    }

    backup = REGISTRY.with_suffix(".json.deskresume-backup")
    shutil.copy2(REGISTRY, backup)

    # Reproduce create(): marker -> record -> order+clear-marker. The marker is
    # deliberately absent from the final file because this runs while the app
    # may be live; a half-written pair would be worse than a missing entry.
    table[new_id] = record
    g["workspaceIds"] = [new_id] + ids
    g["initialized"] = True
    g.pop("pendingMutation", None)

    if set(g["workspaceIds"]) != set(table.keys()):
        fail("internal error: post-write order drift")
    if len(g["workspaceIds"]) != len(set(g["workspaceIds"])):
        fail("internal error: post-write duplicate ids")

    payload = json.dumps(data, ensure_ascii=False, indent=2)
    tmp = REGISTRY.with_suffix(".json.tmp")
    tmp.write_text(payload, encoding="utf-8")
    os.replace(tmp, REGISTRY)

    print(f"backup     : {backup}")
    print(f"registered : {new_id}  title={TITLE!r}")
    print(f"order      : {[table[i]['title'] for i in g['workspaceIds']]}")


main()
