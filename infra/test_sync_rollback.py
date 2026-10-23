#!/usr/bin/env python3
"""python3 infra/test_sync_rollback.py: a deploy that doesn't bring HQ up goes back to the last good one by itself, and
isn't tried again; one that does is recorded as deployed. Real git and bash in a throwaway folder; the script under test
is sync.sh's own lines after the deploy's steps, taken from the file, with HQ's check (infra/hq-up.sh) and the steps
themselves (bring_up) as stand-ins.
"""
import os, re, subprocess, tempfile, unittest

here = os.path.dirname(os.path.abspath(__file__))
AFTER_DEPLOY = re.compile(r'^up=0; COMPOSE=.*?\n^fi\n', re.M | re.S)
SKIP_FAILED = re.compile(r'^failed=.*\n^if \[ "\$\(cat "\$failed".*\n', re.M)
GIT_IDENTITY = {'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t.test', 'GIT_COMMITTER_NAME': 't',
                'GIT_COMMITTER_EMAIL': 't@t.test'}


def lines(pattern, what):
    with open(os.path.join(here, 'sync.sh')) as f:
        found = pattern.search(f.read())
    assert found, f"sync.sh: {what} were not found"
    return found.group(0)


def git(root, *args):
    return subprocess.run(['git', '-C', root, *args], check=True, capture_output=True, text=True,
                          env={**os.environ, **GIT_IDENTITY}).stdout.strip()


def deploy(hq_comes_up, deployed=0):
    """A server on a good commit deploying the next one: what it records and runs, and its checkout after"""
    with tempfile.TemporaryDirectory() as root:
        os.makedirs(f'{root}/infra')
        git(root, 'init', '-q', '-b', 'main')
        for message in ('good', 'next'):
            with open(f'{root}/file', 'a') as f:
                f.write(message + '\n')
            git(root, 'add', '-A')
            git(root, 'commit', '-q', '-m', message)
        good, bad = git(root, 'rev-parse', 'HEAD~1'), git(root, 'rev-parse', 'HEAD')
        with open(f'{root}/infra/infra-env.sh', 'w') as f:
            f.write(':\n')
        # HQ's check: down on the new commit when hq_comes_up is false, up on the good one
        with open(f'{root}/infra/hq-up.sh', 'w') as f:
            f.write(f'#!/bin/bash\n[ "$(git log -1 --format=%s)" = good ] || {"true" if hq_comes_up else "false"}\n')
        os.chmod(f'{root}/infra/hq-up.sh', 0o755)
        script = (
            '#!/bin/bash\ncd "$1"; root=$1\n'
            f'state=$1/state failed_at=$1 commit={bad} last={good} approvals=a approved=$1/approved deployed={deployed}\n'
            'echo "$last" > "$state"; log=$1/log; compose=compose\n'
            'stack_env() { :; }\nbring_up() { echo "bring_up on $(git log -1 --format=%s) rolling_back=${rolling_back:-}" >> "$root/ran"; }\n'
            + lines(SKIP_FAILED, 'the lines that skip a failed commit').replace('/var/lib/$SERVER_NAME', '$failed_at').split('\n')[0] + '\n'
            + lines(AFTER_DEPLOY, "the lines after the deploy's steps")
            + 'echo "deployed=$deployed"\n'
        )
        done = subprocess.run(['bash', '-c', script, 'sync', root], capture_output=True, text=True, timeout=60)
        def read(name):
            if not os.path.exists(f'{root}/{name}'):
                return None
            with open(f'{root}/{name}') as f:
                return f.read().strip()
        return {'out': done.stdout.strip(), 'err': done.stderr.strip(), 'state': read('state'), 'failed': read('failed'),
                'ran': read('ran'), 'log': read('log'), 'checkout': git(root, 'log', '-1', '--format=%s'),
                'good': good, 'bad': bad}


class Rollback(unittest.TestCase):
    def test_a_deploy_whose_hq_comes_up_is_recorded(self):
        r = deploy(hq_comes_up=True)
        self.assertEqual((r['out'], r['err']), ('deployed=0', ''))
        self.assertEqual(r['state'], r['bad'])
        self.assertIsNone(r['failed'])
        self.assertIsNone(r['ran'], 'no way back needed')

    def test_one_whose_hq_doesnt_goes_back_to_the_last_good_one_and_isnt_tried_again(self):
        r = deploy(hq_comes_up=False)
        self.assertEqual((r['out'], r['err']), ('deployed=1', ''))
        self.assertEqual(r['state'], r['good'], 'the last good deploy stays the deployed one')
        self.assertEqual(r['failed'], r['bad'])
        self.assertEqual(r['checkout'], 'good')
        self.assertEqual(r['ran'], 'bring_up on good rolling_back=1', 'the good one brought up again, waiting for no call')
        self.assertIn(f"HQ didn't come up on {r['bad']}: back to the last good deploy, {r['good']}", r['log'])
        self.assertIn(f"back on {r['good']}: exit 0", r['log'])

    def test_sync_sh_skips_a_failed_commit(self):
        line = lines(SKIP_FAILED, 'the lines that skip a failed commit')
        self.assertIn('report_between', line)
        self.assertIn('exit 0', line)


if __name__ == '__main__':
    unittest.main()
