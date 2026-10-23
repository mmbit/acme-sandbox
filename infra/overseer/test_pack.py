#!/usr/bin/env python3
"""python3 infra/overseer/test_pack.py: pack.py zips a throwaway acme-foundation checkout in a temp folder, and refuses
one that lacks a required file, has an open-source package.json or uncommitted changes.
"""
import hashlib
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pack  # noqa: E402

here = os.path.dirname(os.path.abspath(__file__))
# Git with no user or system config, so a hook or a signing setting on this machine can't change a commit
GIT_ENV = {'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_AUTHOR_NAME': 'Test',
           'GIT_AUTHOR_EMAIL': 'test@example.invalid', 'GIT_COMMITTER_NAME': 'Test',
           'GIT_COMMITTER_EMAIL': 'test@example.invalid', 'GIT_AUTHOR_DATE': '2026-10-22T18:00:00Z',
           'GIT_COMMITTER_DATE': '2026-10-22T18:00:00Z'}


class Pack(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = os.path.join(self.tmp.name, 'repo')
        self.out = os.path.join(self.tmp.name, 'out')
        self.saved = os.environ.copy()
        os.environ.update(GIT_ENV)
        files = {'.claude/skills/acme-setup/SKILL.md': b'---\nname: acme-setup\n---\n',
                 'infra/overseer/AGENTS.md': b'# Overseer\n', 'infra/overseer/CLAUDE.md': b'@AGENTS.md\n',
                 'package.json': b'{"private": true}\n', 'README.md': b'# acme-foundation\n'}
        os.makedirs(self.repo)
        self.git('init', '-q', '-b', 'main')
        for name, body in files.items():
            self.write(name, body)
        self.commit()

    def tearDown(self):
        environment = self.saved
        os.environ.clear()
        os.environ.update(environment)
        self.tmp.cleanup()

    def git(self, *args):
        subprocess.run(['git', '-C', self.repo, *args], check=True, capture_output=True)

    def write(self, name, body):
        path = os.path.join(self.repo, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'wb') as f:
            f.write(body)

    def commit(self):
        self.git('add', '-A')
        self.git('commit', '-qm', 'files')

    def pack(self):
        return pack.pack(self.repo, self.out)

    def test_packs_the_committed_tree(self):
        self.write('untracked.txt', b'not committed\n')
        path, digest = self.pack()
        self.assertRegex(os.path.basename(path), r'^acme-foundation-2026-10-22-[0-9a-f]{7,}\.zip$')
        with open(path, 'rb') as f:
            self.assertEqual(digest, hashlib.sha256(f.read()).hexdigest())
        with zipfile.ZipFile(path) as archive:
            self.assertIn('acme-foundation/.claude/skills/acme-setup/SKILL.md', archive.namelist())
            self.assertNotIn('acme-foundation/untracked.txt', archive.namelist())

    def test_refuses_a_missing_skill(self):
        self.git('rm', '-q', '.claude/skills/acme-setup/SKILL.md')
        self.commit()
        self.refused('lacks .claude/skills/acme-setup/SKILL.md')

    def test_refuses_an_open_source_package(self):
        self.write('package.json', b'{"private": true, "license": "MIT"}\n')
        self.commit()
        self.refused('package.json must stay proprietary')

    def test_refuses_uncommitted_changes(self):
        self.write('README.md', b'# changed\n')
        self.refused('uncommitted changes')

    def refused(self, why):
        with self.assertRaisesRegex(pack.PackError, why):
            self.pack()
        self.assertFalse(os.path.isdir(self.out) and os.listdir(self.out), 'a refused zip is left behind')


if __name__ == '__main__':
    unittest.main()
