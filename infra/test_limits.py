#!/usr/bin/env python3
"""python3 infra/test_limits.py: the worker admits from measured host RAM under a finite RAM ceiling and persistent no-swap parent."""
import configparser
import json
from pathlib import Path
import subprocess
import unittest
import yaml
from company import INFRA

HERE = Path(__file__).resolve().parent
MIB = 2 ** 20


class MemoryLimits(unittest.TestCase):
    def test_worker_inherits_zero_swap_with_a_finite_ram_ceiling(self):
        worker = yaml.safe_load((HERE / 'compose.yaml').read_text())['services']['worker']
        parent = worker['cgroup_parent'].replace('${SERVER_NAME}', 'testco')
        self.assertEqual(parent, 'testco-worker.slice')
        policy = configparser.ConfigParser()
        policy.read(HERE / 'worker.slice')
        self.assertEqual(policy['Slice']['MemorySwapMax'], '0')
        self.assertNotIn('MemoryMax', policy['Slice'])
        self.assertEqual(worker['mem_limit'], worker['memswap_limit'])
        self.assertEqual(INFRA['WORKER_MEMORY'], '8192m')

    def test_finite_policy_keeps_the_reserve_on_the_same_captured_load(self):
        worker = yaml.safe_load((HERE / 'compose.yaml').read_text())['services']['worker']
        # Compose's byte-size syntax. The deployment reads the company's ceiling through infra-env.sh.
        settings = subprocess.run(['bash', '-c', '. infra/infra-env.sh; printf %s "$WORKER_MEMORY"'],
                                  cwd=HERE.parent, capture_output=True, text=True, check=True)
        limit = worker.get('mem_limit', 0)
        if limit == '${WORKER_MEMORY:-7168m}':
            limit = settings.stdout
        cap = int(limit[:-1]) * MIB if isinstance(limit, str) and limit.endswith('m') else int(limit)
        module = (HERE.parent / 'platform/worker/src/reserve.ts').as_uri()
        script = '''
const { reservations } = await import(process.argv[1]);
const cap = Number(process.argv[2]);
const hostMb = 5404499968 / 2 ** 20;
const charge = 7386316800 - 340353024;
const available = cap ? Math.min((cap - charge) / 2 ** 20, hostMb) : hostMb;
const reserve = reservations(() => 0);
let admitted = 0;
while (reserve.room(available)) { reserve.take(); admitted++; }
console.log(JSON.stringify({admitted, free: reserve.freeMb(available), small: reserve.claimMb(available)}));
'''
        done = subprocess.run(['node', '--input-type=module', '-e', script, module, str(cap)],
                              capture_output=True, text=True, check=True)
        replay = json.loads(done.stdout)
        self.assertEqual(replay['admitted'], 0)
        self.assertEqual(replay['small'], 0)
        self.assertGreater(replay['free'], 0)
        self.assertLess(replay['free'], 1500)


if __name__ == '__main__':
    unittest.main()
