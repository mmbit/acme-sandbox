#!/usr/bin/env python3
"""python3 infra/test_hq_up.py: after a deploy, HQ is up once its coordinator answers /health; a coordinator that
restarts meanwhile crashed at its start, and one that answers nothing in HQ_UP_S hangs (infra/hq-up.sh, which sync.sh
reads to go back to the last good deploy). Docker and compose are stand-ins that read the coordinator's state from files.
"""
import os, subprocess, tempfile, unittest

here = os.path.dirname(os.path.abspath(__file__))
COMPOSE = """#!/bin/bash
case "$1" in
  ps) cat "$STATE/id" 2>/dev/null ;;
  exec) n=$(cat "$STATE/asked" 2>/dev/null || echo 0); echo $((n + 1)) > "$STATE/asked"
        [ -f "$STATE/crash-after" ] && [ $((n + 1)) -ge "$(cat "$STATE/crash-after")" ] && echo 1 > "$STATE/restarts"
        [ -f "$STATE/answers-after" ] && [ $((n + 1)) -ge "$(cat "$STATE/answers-after")" ] ;;
esac
"""
DOCKER = """#!/bin/bash
[ "$1" = inspect ] && cat "$STATE/restarts"
"""


def hq_up(answers_after=None, crash_after=None, container=True, limit=30):
    """hq-up.sh's exit code and words, against a coordinator that answers at its nth ask, or crashes at its nth"""
    with tempfile.TemporaryDirectory() as state:
        for name, text in (('compose', COMPOSE), ('docker', DOCKER)):
            with open(os.path.join(state, name), 'w') as f:
                f.write(text)
            os.chmod(os.path.join(state, name), 0o755)
        files = {'restarts': '0', 'id': 'c0ffee' if container else None, 'answers-after': answers_after,
                 'crash-after': crash_after}
        for name, value in files.items():
            if value is not None:
                with open(os.path.join(state, name), 'w') as f:
                    f.write(f'{value}\n')
        env = {**os.environ, 'STATE': state, 'COMPOSE': os.path.join(state, 'compose'), 'HQ_UP_S': str(limit),
               'PATH': f'{state}:{os.environ["PATH"]}'}
        # (no real sleeping: the stand-in's sleep returns at once)
        with open(os.path.join(state, 'sleep'), 'w') as f:
            f.write('#!/bin/sh\n')
        os.chmod(os.path.join(state, 'sleep'), 0o755)
        done = subprocess.run(['bash', os.path.join(here, 'hq-up.sh')], env=env, capture_output=True, text=True,
                              timeout=60)
        return done.returncode, done.stdout.strip()


class HqUp(unittest.TestCase):
    def test_up_once_it_answers(self):
        self.assertEqual(hq_up(answers_after=1), (0, 'HQ: up after 0 s'))
        self.assertEqual(hq_up(answers_after=3), (0, 'HQ: up after 10 s'), 'still starting at first')

    def test_a_coordinator_that_restarts_crashed_at_its_start(self):
        self.assertEqual(hq_up(crash_after=2), (1, 'HQ: the coordinator crashed at its start (it restarted)'))

    def test_one_that_answers_nothing_in_time_hangs(self):
        self.assertEqual(hq_up(limit=20), (1, 'HQ: no answer from the coordinator in 20 s'))

    def test_no_coordinator_is_no_hq(self):
        self.assertEqual(hq_up(answers_after=1, container=False), (1, 'HQ: no coordinator container'))


if __name__ == '__main__':
    unittest.main()
