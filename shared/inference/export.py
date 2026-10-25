#!/usr/bin/env python3
"""Export an explicit source allowlist into a fresh Git snapshot with no inherited history."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', required=True, type=Path)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--scope', required=True, type=Path)
    parser.add_argument('--archive', required=True, type=Path)
    arguments = parser.parse_args()
    if not re.fullmatch('[0-9a-f]{40}', arguments.revision):
        raise ValueError('The source revision must be an exact commit')
    scope = json.loads(arguments.scope.read_text())
    paths = scope['paths']
    if not paths or len(set(paths)) != len(paths):
        raise ValueError('The source scope must be a nonempty file allowlist')
    revision = git(arguments.repository, 'rev-parse', arguments.revision + '^{commit}').decode().strip()
    if revision != arguments.revision:
        raise ValueError('The source revision is not the named commit')
    with tempfile.TemporaryDirectory(prefix='source-export-') as temporary:
        workspace = Path(temporary)
        blobs = export_sources(arguments.repository, revision, paths, workspace)
        snapshot = initialize_git(workspace, blobs)
        archive_snapshot(workspace, arguments.archive)
    digest = hashlib.sha256(arguments.archive.read_bytes()).hexdigest()
    arguments.archive.chmod(0o444)
    receipt = {'sourceRevision': revision, 'snapshotCommit': snapshot,
               'sourceBlobs': blobs, 'archiveSha256': digest}
    arguments.archive.with_suffix('.json').write_text(json.dumps(receipt, indent=2) + '\n')


def git(repository, *arguments):
    return subprocess.run(['git', '-C', str(repository), *arguments], check=True,
                          capture_output=True).stdout


def export_sources(repository, revision, paths, workspace):
    entries = {}
    for entry in git(repository, 'ls-tree', '-rz', '--full-tree', revision).split(b'\0'):
        if not entry:
            continue
        metadata, path = entry.split(b'\t', 1)
        mode, kind, digest = metadata.decode().split(' ')
        entries[os.fsdecode(path)] = (mode, kind, digest)
    blobs = {}
    for path in paths:
        destination = workspace / path
        if Path(path).is_absolute() or '..' in Path(path).parts or '.git' in Path(path).parts:
            raise ValueError('A source path leaves the snapshot')
        mode, kind, digest = entries[path]
        if kind != 'blob' or mode not in ('100644', '100755'):
            raise ValueError('Only ordinary source files are supported in this export')
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(git(repository, 'cat-file', 'blob', digest))
        destination.chmod(0o755 if mode == '100755' else 0o644)
        blobs[path] = digest
    return blobs


def initialize_git(workspace, blobs):
    git(workspace, 'init', '-q', '-b', 'main', '--template=')
    git(workspace, 'config', 'core.logAllRefUpdates', 'false')
    entries = bytearray()
    for path, expected in blobs.items():
        digest = git(workspace, 'hash-object', '-w', '--no-filters', '--', path).decode().strip()
        if digest != expected:
            raise ValueError('A source blob changed during export')
        mode = '100755' if (workspace / path).stat().st_mode & 0o111 else '100644'
        entries.extend(os.fsencode(f'{mode} {digest}\t{path}') + b'\0')
    subprocess.run(['git', '-C', str(workspace), 'update-index', '-z', '--index-info'],
                   input=entries, check=True, capture_output=True)
    tree = git(workspace, 'write-tree').decode().strip()
    environment = {**os.environ, 'GIT_AUTHOR_NAME': 'Source export', 'GIT_AUTHOR_EMAIL': 'export@localhost',
                   'GIT_COMMITTER_NAME': 'Source export', 'GIT_COMMITTER_EMAIL': 'export@localhost',
                   'GIT_AUTHOR_DATE': '2000-01-01T00:00:00Z', 'GIT_COMMITTER_DATE': '2000-01-01T00:00:00Z'}
    commit = subprocess.run(['git', '-C', str(workspace), 'commit-tree', tree], input=b'Source snapshot\n',
                            env=environment, check=True, capture_output=True).stdout.decode().strip()
    git(workspace, 'update-ref', 'refs/heads/main', commit)
    git(workspace, 'update-ref', 'refs/remotes/origin/main', commit)
    return commit


def archive_snapshot(workspace, archive):
    with tarfile.open(archive, 'w', format=tarfile.PAX_FORMAT) as output:
        for path in sorted(workspace.rglob('*')):
            if path.is_dir():
                continue
            member = output.gettarinfo(str(path), arcname=str(path.relative_to(workspace)))
            member.uid = member.gid = member.mtime = 0
            member.uname = member.gname = ''
            with path.open('rb') as contents:
                output.addfile(member, contents)


if __name__ == '__main__':
    main()
