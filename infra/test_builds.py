#!/usr/bin/env python3
"""python3 infra/test_builds.py: failed image builds keep their containers while the other services deploy.
"""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest
from sync_fixture import here, sync_lines

BRING_UP = re.compile(r'^bring_up\(\) \{\n.*?^\}\n', re.M | re.S)
COMPOSE = r'''
compose() {
  case "$1" in
    config)
      if [ "${2:-}" = --services ]; then printf '%s\n' coordinator voice worker caddy
      else echo '{"services":{"coordinator":{"build":{}},"voice":{"build":{}},"worker":{"build":{}},"caddy":{"image":"caddy"}}}'; fi ;;
    build)
      echo "build $2" >> events
      if [ "$2" = "$FAIL_SERVICE" ]; then echo 'checksum mismatch' >&2; return 1; fi ;;
    up)
      echo "$*" >> events
      [[ " $* " == *' --no-build '* ]] || return 2
      [[ " $* " != *" $FAIL_SERVICE "* ]] || return 3 ;;
    ps) echo "$3-container" ;;
    exec) [ "$3" != caddy ] || [ "$4" != cat ] || cat infra/Caddyfile ;;
    *) echo "$*" >> events ;;
  esac
}
compose=compose
docker() {
  case "$1" in
    inspect) if [ "$3" = '{{.Image}}' ]; then echo "running-${4%-container}"; else echo "infra-${4%-container}"; fi ;;
    tag) echo "docker $*" >> events; [ -z "${FAIL_TAG:-}" ] ;;
    *) echo "docker $*" >> events ;;
  esac
}
on_call() { return 1; }
stage_worker_code() { echo stage-worker >> events; }
worker_behind() { return 0; }
keep_limits() { return 0; }
work=work HQ_DATA=hq INFRA_ENV_SKIPPED=''
'''


class BuildIsolation(unittest.TestCase):
    def deploy(self, failed, repeat=False, kept=(), fail_tag=False):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'infra').mkdir()
            for name, contents in [('harden.sh', '#!/bin/bash\ntrue\n'), ('products.py', ''), ('Caddyfile', '')]:
                path = root / 'infra' / name
                path.write_text(contents)
                path.chmod(0o755)
            clock = root / 'platform/coordinator/src/clock.ts'
            clock.parent.mkdir(parents=True)
            clock.touch()
            shutil.copyfile(Path(here) / 'builds.sh', root / 'infra/builds.sh')
            script = ('. infra/builds.sh\n' + COMPOSE
                      + sync_lines(BRING_UP, 'bring_up').group(0)
                      + '\nbring_up; status=$?\n'
                      + ('bring_up; status=$?\n' if repeat else '')
                      + 'DEPLOY_KEPT="$kept" python3 "$RECORD" records abc1234 now "$status" before < after\n'
                      + 'rm -rf "$kept"\nexit "$status"\n')
            (root / 'before').write_text('voice v1\nworker w1\ncoordinator c1\n')
            after = {name: name + '2' for name in ['voice', 'worker', 'coordinator']}
            for name in (failed, *kept):
                after[name] = {'voice': 'v1', 'worker': 'w1', 'coordinator': 'c1'}[name]
            (root / 'after').write_text(''.join(f'{name} {cid}\n' for name, cid in after.items()))
            ran = subprocess.run(['bash', '-uo', 'pipefail', '-c', script], cwd=root, capture_output=True, text=True,
                                 env={**os.environ, 'FAIL_SERVICE': failed, 'FAIL_TAG': 'yes' if fail_tag else '',
                                      'RECORD': str(Path(here) / 'deploys.py')})
            self.assertEqual(ran.returncode != 0, fail_tag, ran.stdout + ran.stderr)
            record = json.loads(next((root / 'records').glob('*.json')).read_text())
            return (root / 'events').read_text().splitlines(), record, ran.stdout

    def test_voice_failure_still_deploys_worker_and_coordinator_and_records_why(self):
        events, record, _ = self.deploy('voice')
        self.assertTrue(any(line.startswith('up ') and 'worker' in line for line in events))
        self.assertTrue(any(line.startswith('up ') and 'coordinator' in line for line in events))
        self.assertTrue(record['ok'])
        self.assertEqual(record['recreated'], ['coordinator', 'worker'])
        self.assertIn('checksum mismatch', record['kept']['voice'])
        self.assertFalse(any(line.startswith('docker tag') for line in events))

    def test_worker_failure_neither_stages_nor_reloads_worker_and_keeps_the_coordinator_with_it(self):
        events, record, _ = self.deploy('worker', kept=['coordinator'])
        self.assertNotIn('stage-worker', events)
        self.assertFalse(any('SIGUSR2' in line for line in events))
        self.assertFalse(any(line.startswith('up ') and 'coordinator' in line for line in events))
        self.assertEqual(record['recreated'], ['voice'])
        self.assertIn('worker', record['kept']['coordinator'])
        self.assertIn('docker tag running-worker infra-worker', events)
        self.assertIn('docker tag running-coordinator infra-coordinator', events)

    def test_a_rollback_attempt_builds_images_again_for_its_own_checkout(self):
        events, _, _ = self.deploy('voice', repeat=True)
        self.assertEqual(events.count('build coordinator'), 2)
        self.assertEqual(events.count('build worker'), 2)

    def test_coordinator_failure_skips_its_clock_keeps_the_worker_with_it_and_deploys_the_rest(self):
        events, record, _ = self.deploy('coordinator', kept=['worker'])
        self.assertFalse(any(line.startswith('run ') for line in events))
        self.assertEqual(events.count('build coordinator'), 1)
        self.assertNotIn('stage-worker', events)
        self.assertEqual(record['recreated'], ['voice'])
        self.assertIn('coordinator', record['kept']['worker'])
        self.assertIn('docker tag running-coordinator infra-coordinator', events)
        self.assertIn('docker tag running-worker infra-worker', events)

    def test_a_failed_retag_of_a_kept_pair_stops_the_deploy(self):
        events, record, _ = self.deploy('coordinator', kept=['worker'], fail_tag=True)
        self.assertFalse(any(line.startswith('up ') for line in events))
        self.assertFalse(record['ok'])


if __name__ == '__main__':
    unittest.main()
