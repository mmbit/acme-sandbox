#!/usr/bin/env python3
"""Packs acme-foundation into the zip a newcomer unzips: run at the root of an acme-foundation checkout. The zip is the
committed tree (git archive of HEAD) in one folder, acme-foundation/. It checks the zip holds the setup skill and
the Overseer's instructions, and that package.json stays proprietary. Then it prints the zip's name and SHA-256.
python3 infra/overseer/pack.py [out-dir]; its test: python3 infra/overseer/test_pack.py
"""
import hashlib
import json
import os
import subprocess
import sys
import zipfile

FOLDER = 'acme-foundation'
REQUIRED = ['.claude/skills/acme-setup/SKILL.md', 'infra/overseer/AGENTS.md', 'infra/overseer/CLAUDE.md']


class PackError(Exception):
    pass


def main():
    out_dir = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else '.')
    try:
        path, digest = pack(os.getcwd(), out_dir)
    except PackError as e:
        sys.exit(f'pack: {e}')
    print(f'{os.path.basename(path)}\nsha256 {digest}')


def pack(checkout, out_dir):
    """The zip's path and SHA-256, made from checkout's HEAD into out_dir, or a PackError that says what's wrong."""
    def git(*args):
        return subprocess.run(['git', '-C', checkout, *args], capture_output=True, text=True, check=True).stdout

    if git('status', '--porcelain', '--untracked-files=no').strip():
        raise PackError('the checkout has uncommitted changes: commit them first, the zip is the committed tree')
    stamp = git('log', '-1', '--format=%cs-%h').strip()
    path = os.path.join(out_dir, f'{FOLDER}-{stamp}.zip')
    os.makedirs(out_dir, exist_ok=True)
    git('archive', '--format=zip', f'--prefix={FOLDER}/', '-o', path, 'HEAD')
    try:
        check(path)
    except PackError:
        os.remove(path)
        raise
    with open(path, 'rb') as f:
        return path, hashlib.sha256(f.read()).hexdigest()


def check(path):
    """Stops with a PackError unless the zip has every required file and proprietary metadata."""
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        missing = [name for name in REQUIRED if f'{FOLDER}/{name}' not in names]
        if missing:
            raise PackError(f'the zip lacks {", ".join(missing)}')
        if f'{FOLDER}/package.json' in names:
            package = json.loads(archive.read(f'{FOLDER}/package.json'))
            if package.get('private') is not True or package.get('license', 'UNLICENSED') != 'UNLICENSED':
                raise PackError('package.json must stay proprietary: "private": true and no open-source "license"')


if __name__ == '__main__':
    main()
