#!/usr/bin/env python3
"""python3 infra/test_sync_records.py: a deploy with code in it is never taken for records only.

sync.sh records a commit that changes only the office's records (office.paths) as deployed, with no build or restart.
Real git and bash in a throwaway folder; the script under test is sync.sh's records_only function, taken from the file.
"""
import os, re, shutil, subprocess, tempfile, unittest
from sync_fixture import git, here, sync_lines

office_paths = os.path.join(here, '..', 'platform', 'coordinator', 'src', 'office.paths')
RECORDS_ONLY = re.compile(r'^records_only\(\) \{\n.*?^\}\n', re.M | re.S)
# Each run starts a fresh git and grep, so the runs meet the scheduler at different moments. At load 6 here, the diff
# below piped to grep -q was taken for records only in all of 3 x 200 runs, and in 114 to 133 of 200 at a fifth of its
# names. 200 runs take about 5 s: enough that a pipe to grep should fail the test, with no guarantee that it will.
RUNS = 200


def records_only(paths, runs=RUNS, commit=None):
    """How many of `runs` runs of records_only say "records only" for a commit that adds `paths`."""
    with tempfile.TemporaryDirectory() as root:
        git(root, 'init', '-q', '-b', 'main')
        os.makedirs(os.path.join(root, 'platform', 'coordinator', 'src'))
        shutil.copy(office_paths, os.path.join(root, 'platform', 'coordinator', 'src'))
        git(root, 'add', '-A')
        git(root, 'commit', '-q', '-m', 'last')
        for path in paths:
            os.makedirs(os.path.join(root, os.path.dirname(path)), exist_ok=True)
            with open(os.path.join(root, path), 'w') as f:
                f.write(path + '\n')
        git(root, 'add', '-A')
        git(root, 'commit', '-q', '--allow-empty', '-m', 'commit')
        script = (
            'set -uo pipefail\n'
            + sync_lines(RECORDS_ONLY, 'the records_only function').group(0)
            + 'last=$(git rev-parse HEAD~1) commit=${COMMIT:-$(git rev-parse HEAD)}\n'
            f'for _ in $(seq {runs}); do\n'
            '  if records_only "$last" "$commit"; then echo records; else echo deploy; fi\n'
            'done\n'
        )
        env = {**os.environ, 'COMMIT': commit or ''}
        ran = subprocess.run(['bash', '-c', script], cwd=root, check=True, capture_output=True, text=True, env=env,
                             timeout=120)
    said = ran.stdout.split()
    assert len(said) == runs, ran.stdout + ran.stderr
    return said.count('records')


class RecordsOnly(unittest.TestCase):
    def test_a_diff_of_thousands_of_code_paths_always_deploys(self):
        code = [f'platform/coordinator/src/generated/module-with-a-long-name-{n:05}.ts' for n in range(5000)]
        self.assertEqual(records_only(code), 0)

    def test_profiles_and_briefs_alone_are_records_only(self):
        records = ['company/people/someone.md', 'company/people/archive/someone.md', 'company/briefs/a-brief.md',
                   'company/DECISIONS.md', 'knowledge/notes/process/deploys.md']
        self.assertEqual(records_only(records, runs=20), 20)

    def test_one_code_file_among_records_deploys(self):
        self.assertEqual(records_only(['company/people/someone.md', 'infra/sync.sh'], runs=20), 0)

    def test_a_diff_that_fails_deploys(self):
        self.assertEqual(records_only(['company/people/someone.md'], runs=5, commit='no-such-commit'), 0)

    def test_no_change_since_the_last_deploy_is_records_only(self):
        self.assertEqual(records_only([], runs=5), 5)


if __name__ == '__main__':
    unittest.main()
