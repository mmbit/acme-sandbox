#!/usr/bin/env python3
"""python3 infra/test_revert.py: the commits since the last good deploy, or the ones a request names, reverted on main in
one pushed commit (infra/revert.py); a revert that conflicts with what came since pushes nothing. Real git, with a bare
repository standing in for GitHub.
"""
import json, os, subprocess, tempfile, unittest

here = os.path.dirname(os.path.abspath(__file__))
IDENTITY = {'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t.test', 'GIT_COMMITTER_NAME': 't',
            'GIT_COMMITTER_EMAIL': 't@t.test'}


def git(root, *args):
    return subprocess.run(['git', '-C', root, *args], check=True, capture_output=True, text=True,
                          env={**os.environ, **IDENTITY}).stdout.strip()


def write(root, name, text):
    with open(os.path.join(root, name), 'w') as f:
        f.write(text)


class Revert(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.origin, self.repo = f'{self.dir.name}/origin.git', f'{self.dir.name}/server'
        subprocess.run(['git', 'init', '-q', '--bare', '-b', 'main', self.origin], check=True)
        subprocess.run(['git', 'clone', '-q', self.origin, self.repo], check=True, capture_output=True)
        git(self.repo, 'checkout', '-q', '-b', 'main')
        write(self.repo, 'hq.js', 'good\n')
        git(self.repo, 'add', '-A')
        git(self.repo, 'commit', '-q', '-m', 'good')
        self.good = git(self.repo, 'rev-parse', 'HEAD')
        # a merged pull request that breaks HQ, then a commit straight on main
        git(self.repo, 'checkout', '-q', '-b', 'job/1')
        write(self.repo, 'hq.js', 'broken\n')
        git(self.repo, 'commit', '-q', '-am', 'break it')
        git(self.repo, 'checkout', '-q', 'main')
        git(self.repo, 'merge', '-q', '--no-ff', '-m', 'Merge PR #1', 'job/1')
        write(self.repo, 'notes.md', 'more\n')
        git(self.repo, 'add', '-A')
        git(self.repo, 'commit', '-q', '-m', 'notes')
        self.bad = git(self.repo, 'rev-parse', 'HEAD')
        git(self.repo, 'push', '-q', 'origin', 'main')
        # (the server's checkout sits on the last good deploy)
        git(self.repo, 'reset', '-q', '--hard', self.good)

    def tearDown(self):
        self.dir.cleanup()

    def run_revert(self, *args):
        done = subprocess.run(['python3', os.path.join(here, 'revert.py'), *args], capture_output=True, text=True,
                              timeout=60)
        return done.returncode, done.stdout.strip()

    def main_has(self, name):
        return git(self.origin, 'show', f'main:{name}')

    def test_the_commits_since_the_last_good_deploy_are_reverted_on_main(self):
        code, said = self.run_revert(self.repo, "HQ didn't come up", '--since', self.good, self.bad)
        self.assertEqual(code, 0, said)
        self.assertEqual(git(self.origin, 'rev-parse', 'main'), said)
        self.assertEqual(self.main_has('hq.js'), 'good')
        self.assertEqual(git(self.origin, 'ls-tree', '--name-only', 'main'), 'hq.js')
        message = git(self.origin, 'log', '-1', '--format=%B', 'main')
        self.assertTrue(message.startswith("Revert 2 commits on main: HQ didn't come up"), message)
        self.assertIn('Merge PR #1', message)
        self.assertIn('notes', message)
        self.assertEqual(git(self.origin, 'log', '-1', '--format=%an', 'main'), 'HQ')

    def test_a_revert_that_conflicts_with_what_came_since_pushes_nothing(self):
        other = f'{self.dir.name}/other'
        subprocess.run(['git', 'clone', '-q', self.origin, other], check=True, capture_output=True)
        write(other, 'hq.js', 'fixed differently\n')
        git(other, 'commit', '-q', '-am', 'a fix on top')
        git(other, 'push', '-q', 'origin', 'main')
        main = git(self.origin, 'rev-parse', 'main')
        code, said = self.run_revert(self.repo, "HQ didn't come up", '--since', self.good, self.bad)
        self.assertEqual(code, 1)
        self.assertIn("revert conflicts with what main has since", said)
        self.assertEqual(git(self.origin, 'rev-parse', 'main'), main)
        self.assertEqual(git(self.repo, 'worktree', 'list').count('\n'), 0, 'its worktree is gone')

    def test_a_request_reverts_the_commits_it_names_and_answers_beside_it(self):
        folder = f'{self.dir.name}/reverts'
        os.makedirs(folder)
        merge = git(self.repo, 'rev-parse', f'{self.bad}~1')
        write(folder, '7.json', json.dumps({'why': 'the worker stopped starting jobs', 'commits': [merge[:9]]}))
        write(folder, '8.json', json.dumps({'why': 'x', 'commits': ['--upload-pack=touch /tmp/x']}))
        code, _ = self.run_revert('--requests', folder, self.repo)
        self.assertEqual(code, 0)
        with open(f'{folder}/7.done') as f:
            done = json.load(f)
        self.assertEqual(done, {'ok': True, 'said': git(self.origin, 'rev-parse', 'main')})
        self.assertEqual(self.main_has('hq.js'), 'good')
        self.assertEqual(self.main_has('notes.md'), 'more', 'only the named commit')
        with open(f'{folder}/8.done') as f:
            self.assertEqual(json.load(f), {'ok': False, 'said': 'a request names commits by their ids'})

    def test_a_commit_main_doesnt_have_is_refused(self):
        git(self.repo, 'commit', '-q', '--allow-empty', '-m', 'local only')
        code, said = self.run_revert(self.repo, 'why', git(self.repo, 'rev-parse', 'HEAD'))
        self.assertEqual(code, 1)
        self.assertIn("main doesn't have", said)


if __name__ == '__main__':
    unittest.main()
