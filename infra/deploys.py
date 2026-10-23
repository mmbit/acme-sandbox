#!/usr/bin/env python3
"""A deploy's record for HQ, so a job can wait for the next deploys, or one that recreated a container, without holding a
seat to poll for it (hq job --when: platform/coordinator/src/wakes.ts). sync.sh runs this after every deploy it runs.
The record goes in the coordinator's data folder, one file per deploy, written whole (a rename). The folder is the data
folder's owner's, so the coordinator removes each record once its database has it (wakes.ts readDeploys).

python3 infra/deploys.py <folder> <commit> <fetched> <exit status> <containers before> [reloaded service]...
  fetched: when sync.sh fetched the commit (UTC, ISO 8601): a deploy has every merge from before it
  containers before: a file of `<service> <container id>` lines from before the deploy; the ones after come on stdin
  (both `docker compose ps -a --format '{{.Service}} {{.ID}}'`). A service whose id changed, or that's new, was recreated.
  reloaded: services restarted in place (the worker's process on new code)

"""
import json, os, sys, tempfile
from datetime import datetime, timezone


def containers(lines):
    found = {}
    for line in lines:
        parts = line.split()
        if len(parts) == 2:
            found[parts[0]] = parts[1]
    return found


def record(folder, sha, fetched, status, before, after, reloaded=(), now=None):
    now = now or datetime.now(timezone.utc)
    rec = {
        'sha': sha,
        'fetched': fetched,
        'finished': now.isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
        'ok': status == 0,
        'recreated': sorted(s for s, cid in after.items() if before.get(s) != cid),
        'reloaded': sorted(set(reloaded)),
        'services': sorted(after),
    }
    os.makedirs(folder, mode=0o755, exist_ok=True)
    data = os.stat(os.path.dirname(os.path.abspath(folder)))
    os.chown(folder, data.st_uid, data.st_gid)
    name = f"{now.strftime('%Y%m%dT%H%M%SZ')}-{sha[:12]}.json"
    fd, part = tempfile.mkstemp(dir=folder, prefix='.part-')   # (no .json: the coordinator reads only whole records)
    with os.fdopen(fd, 'w') as f:
        json.dump(rec, f)
    os.chmod(part, 0o644)
    os.replace(part, os.path.join(folder, name))
    return name, rec


def main(argv):
    if len(argv) < 6:
        sys.exit(__doc__)
    folder, sha, fetched, status, before_file, *reloaded = argv[1:]
    with open(before_file) as f:
        before = containers(f)
    name, _ = record(folder, sha, fetched, int(status), before, containers(sys.stdin), reloaded)
    print(f'recorded for HQ as {name}')


if __name__ == '__main__':
    main(sys.argv)
