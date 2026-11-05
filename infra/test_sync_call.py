#!/usr/bin/env python3
"""python3 infra/test_sync_call.py: a deploy waits for a live call, and the status report goes on meanwhile.

The voice line touches each live call's file in /data/live while the call is on (platform/voice/server.py watch_live);
sync.sh counts a file touched in the last 5 minutes. Real bash in a throwaway folder; the script under test is sync.sh's
report_between and on_call functions and the lines that wait on a call, taken from the file, with compose's exec run
here on the folder's own live files and report.sh a stand-in that keeps the report.
"""
import os, re, subprocess, tempfile, time, unittest
from sync_fixture import sync_lines

REPORT_BETWEEN = re.compile(r'^report_between\(\) \{\n.*?^\}\n', re.M | re.S)
WAITS = re.compile(r'^on_call\(\) \{.*\n(?:.*\n)*?^fi\n', re.M)
STAND_INS = r'''
stack_env() { :; }
# compose exec -T voice <command>: the command, here, with /data/live the folder's own
voice() {
  [ "$1 $2 $3" = "exec -T voice" ] || return 1; shift 3
  local args=() a; for a in "$@"; do args+=("${a//\/data\/live/$LIVE}"); done
  "${args[@]}"
}
compose=voice
'''


def deploy(live_age_minutes=None, rolling_back=False):
    """sync.sh's call check with one live file this many minutes old (None: none): what it printed, and the report it
    wrote (None: none)."""
    with tempfile.TemporaryDirectory() as root:
        live, srv = os.path.join(root, 'live'), os.path.join(root, 'srv')
        os.makedirs(live)
        os.makedirs(srv)
        os.makedirs(os.path.join(root, 'infra'))
        with open(os.path.join(root, 'infra', 'report.sh'), 'w') as f:
            f.write('#!/bin/bash\ncp "$1" "$REPORTED"\n')
        os.chmod(os.path.join(root, 'infra', 'report.sh'), 0o755)
        if live_age_minutes is not None:
            call = os.path.join(live, 'a-call')
            open(call, 'w').close()
            at = time.time() - live_age_minutes * 60
            os.utime(call, (at, at))
        script = (
            STAND_INS
            + sync_lines(REPORT_BETWEEN, 'the report_between function').group(0)
            + sync_lines(WAITS, 'the lines that wait on a live call').group(0)
            + 'echo "deploying $commit"\n'
        )
        reported = os.path.join(root, 'report')
        env = {**os.environ, 'LIVE': live, 'REPORTED': reported, 'SERVER_NAME': f'../..{srv}', 'commit': 'new',
               'last': 'old'}
        if rolling_back:
            env['rolling_back'] = '1'
        ran = subprocess.run(['bash', '-c', script], cwd=root, check=True, capture_output=True, text=True, env=env,
                             timeout=30)
        if not os.path.exists(reported):
            return ran.stdout.splitlines(), None
        with open(reported) as f:
            return ran.stdout.splitlines(), f.read()


class SyncCall(unittest.TestCase):
    def test_no_live_call_deploys(self):
        self.assertEqual(deploy(), (['deploying new'], None))

    def test_a_call_touched_a_minute_ago_holds_the_deploy_and_the_report_goes_on(self):
        printed, report = deploy(live_age_minutes=1)
        waits = 'the deploy of new waits: a call is live on the voice line'
        self.assertEqual(printed, [waits])
        self.assertEqual(report.splitlines()[0], f'periodic report (no deploy: {waits}); deployed old')

    def test_a_file_untouched_for_six_minutes_holds_nothing(self):
        self.assertEqual(deploy(live_age_minutes=6), (['deploying new'], None))

    def test_going_back_to_the_last_good_deploy_never_waits(self):
        self.assertEqual(deploy(live_age_minutes=1, rolling_back=True), (['deploying new'], None))


if __name__ == '__main__':
    unittest.main()
