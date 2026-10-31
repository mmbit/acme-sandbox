#!/usr/bin/env python3
"""python3 infra/test_sync_rerun.py: a deploy that changes sync.sh runs the new one.

The timer runs sync.sh from the checkout it resets, and bash goes on reading the copy it opened. Real git and bash in a
throwaway folder; the script under test is a small stand-in around sync.sh's own rerun lines, taken from the file.
"""
import os, re, subprocess, tempfile, unittest
from sync_fixture import git, sync_lines

RERUN_LINES = re.compile(
    r'^(?P<before_reset>running=\$\(git rev-parse.*\n)'
    r'git reset -q --hard "\$commit" \|\| exit 1\n'
    r'(?P<after_reset>(?:#.*\n)*\[ -n "\$\{SYNC_RERUN.*\n)',
    re.M)
COMMIT_LINE = re.compile(r'^commit=.*FETCH_HEAD.*\n', re.M)
PADDING = '# padding so the old copy is longer than the new one\n' * 20


def rerun_lines():
    return sync_lines(RERUN_LINES, 'the rerun lines after the reset')


def commit_line():
    return sync_lines(COMMIT_LINE, 'the line that picks the commit to deploy').group(0)


def stand_in(version, with_rerun):
    # fetch, reset (with sync.sh's rerun lines or without), then say which version's tail ran on which commit;
    # $ADVANCE, run only by a rerun before its fetch, stands in for a commit landing on origin in between
    lines = rerun_lines()
    before_reset = lines.group('before_reset') if with_rerun else ''
    after_reset = lines.group('after_reset') if with_rerun else ''
    pick = commit_line() if with_rerun else 'commit=$(git rev-parse FETCH_HEAD)\n'
    return (
        '#!/bin/bash\n'
        'cd "$(dirname "$0")/.."\n'
        f'echo "start {version}"\n'
        '[ -z "${SYNC_RERUN:-}" ] || eval "${ADVANCE:-}"\n'
        'git fetch -q origin main\n'
        + pick
        + before_reset
        + 'git reset -q --hard "$commit" || exit 1\n'
        + after_reset
        + PADDING
        + f'echo "tail {version} on $(git log -1 --format=%s)"\n'
    )


def deploy(with_rerun, change_sync=True, advance=False):
    """What a server prints when it deploys a commit after the one it has; the lines of its output."""
    tmp = tempfile.TemporaryDirectory()
    root = tmp.name
    origin, work, server = (os.path.join(root, d) for d in ('origin.git', 'work', 'server'))
    subprocess.run(['git', 'init', '-q', '--bare', '-b', 'main', origin], check=True)
    subprocess.run(['git', 'clone', '-q', origin, work], check=True, capture_output=True)
    os.makedirs(os.path.join(work, 'infra'))

    def commit(sync_text, message, to='main'):
        with open(os.path.join(work, 'infra', 'sync.sh'), 'w') as f:
            f.write(sync_text)
        with open(os.path.join(work, 'other'), 'a') as f:
            f.write(message + '\n')
        git(work, 'add', '-A')
        git(work, 'commit', '-q', '-m', message)
        git(work, 'push', '-q', 'origin', f'HEAD:{to}')

    with tmp:
        commit(stand_in('v1', with_rerun), 'one')
        subprocess.run(['git', 'clone', '-q', origin, server], check=True, capture_output=True)
        commit(stand_in('v2' if change_sync else 'v1', with_rerun), 'two')
        env = {k: v for k, v in os.environ.items() if k != 'SYNC_RERUN'}
        if advance:
            commit(stand_in('v3', with_rerun), 'three', to='next')
            env['ADVANCE'] = f'git --git-dir={origin} update-ref refs/heads/main refs/heads/next'
        deployed = subprocess.run(['bash', os.path.join(server, 'infra', 'sync.sh')], check=True,
                                  capture_output=True, text=True, env=env, timeout=30)
    return deployed.stdout.splitlines()


class SyncRerun(unittest.TestCase):
    def test_without_the_rerun_the_old_script_goes_on_after_a_reset_that_changed_it(self):
        self.assertEqual(deploy(with_rerun=False), ['start v1', 'tail v1 on two'])

    def test_with_the_rerun_the_new_script_runs_once(self):
        self.assertEqual(deploy(with_rerun=True), ['start v1', 'start v2', 'tail v2 on two'])

    def test_the_rerun_deploys_the_commit_the_first_run_fetched(self):
        self.assertEqual(deploy(with_rerun=True, advance=True), ['start v1', 'start v2', 'tail v2 on two'])

    def test_a_deploy_that_leaves_sync_sh_alone_runs_straight_on(self):
        self.assertEqual(deploy(with_rerun=True, change_sync=False), ['start v1', 'tail v1 on two'])


if __name__ == '__main__':
    unittest.main()
