#!/usr/bin/env python3
"""python3 infra/test_deploys.py: the record of a deploy HQ reads (infra/deploys.py, wakes.ts in the coordinator).


"""
import json, os, subprocess, sys, tempfile, unittest
from datetime import datetime, timezone

here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, here)
import deploys  # noqa: E402

BEFORE = {'coordinator': 'c1', 'worker': 'w1', 'caddy': 'k1', 'product-example': 'p1'}


class Record(unittest.TestCase):
    def test_says_which_containers_the_deploy_recreated(self):
        with tempfile.TemporaryDirectory() as folder:
            after = {**BEFORE, 'coordinator': 'c2', 'product-example': 'p2', 'product-new': 'n1'}
            name, rec = deploys.record(folder, 'abc123def4567890', '2026-10-13T10:00:00Z', 0, BEFORE, after, ['worker'],
                                       now=datetime(2026, 10, 13, 10, 5, 7, tzinfo=timezone.utc))
            self.assertEqual(name, '20261013T100507Z-abc123def456.json')
            with open(os.path.join(folder, name)) as f:
                self.assertEqual(json.load(f), rec)
            self.assertEqual(rec['recreated'], ['coordinator', 'product-example', 'product-new'])
            self.assertEqual(rec['reloaded'], ['worker'])
            self.assertEqual(rec['services'], ['caddy', 'coordinator', 'product-example', 'product-new', 'worker'])
            self.assertEqual((rec['ok'], rec['fetched'], rec['finished']), (True, '2026-10-13T10:00:00Z', '2026-10-13T10:05:07.000Z'))
            self.assertEqual(oct(os.stat(os.path.join(folder, name)).st_mode & 0o777), '0o644')

    def test_a_failed_deploy_is_recorded_as_not_ok(self):
        with tempfile.TemporaryDirectory() as folder:
            _, rec = deploys.record(folder, 'abc1234', 'x', 1, BEFORE, BEFORE)
            self.assertEqual((rec['ok'], rec['recreated']), (False, []))

    def test_leaves_no_partial_file(self):
        with tempfile.TemporaryDirectory() as data:
            folder = os.path.join(data, 'deploys')
            for i in range(3):
                deploys.record(folder, f'{i:07x}', 'x', 0, {}, {}, now=datetime(2026, 1, 1, 0, 0, i, tzinfo=timezone.utc))
            self.assertEqual(len(os.listdir(folder)), 3)
            self.assertTrue(all(f.endswith('.json') for f in os.listdir(folder)))

    def test_as_sync_sh_runs_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            before = os.path.join(tmp, 'before')
            with open(before, 'w') as f:
                f.write('coordinator c1\nworker w1\n')
            out = subprocess.run([sys.executable, os.path.join(here, 'deploys.py'), os.path.join(tmp, 'deploys'), 'abcdef1',
                                  '2026-10-13T10:00:00Z', '0', before, 'worker'], input='coordinator c2\nworker w1\n',
                                 capture_output=True, text=True, check=True).stdout
            self.assertRegex(out, r'^recorded for HQ as \d{8}T\d{6}Z-abcdef1\.json\n$')
            (name,) = os.listdir(os.path.join(tmp, 'deploys'))
            with open(os.path.join(tmp, 'deploys', name)) as f:
                rec = json.load(f)
            self.assertEqual((rec['recreated'], rec['reloaded']), (['coordinator'], ['worker']))

    def test_finished_keeps_the_milliseconds_so_a_job_queued_in_the_same_second_still_counts_it(self):
        with tempfile.TemporaryDirectory() as folder:
            _, rec = deploys.record(folder, 'abc1234', 'x', 0, {}, {},
                                    now=datetime(2026, 10, 13, 10, 5, 7, 900000, tzinfo=timezone.utc))
            self.assertEqual(rec['finished'], '2026-10-13T10:05:07.900Z')

    def test_a_missing_before_file_fails_rather_than_recording_every_container_as_recreated(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = subprocess.run([sys.executable, os.path.join(here, 'deploys.py'), os.path.join(tmp, 'deploys'), 'abcdef1',
                                  '2026-10-13T10:00:00Z', '0', os.path.join(tmp, 'none')], input='worker w1\n',
                                 capture_output=True, text=True)
            self.assertNotEqual(run.returncode, 0)
            self.assertFalse(os.path.exists(os.path.join(tmp, 'deploys')))


if __name__ == '__main__':
    unittest.main()
