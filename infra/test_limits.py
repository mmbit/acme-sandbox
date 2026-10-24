#!/usr/bin/env python3
"""DOCKER_COMPOSE=/path/to/docker-compose python3 infra/test_limits.py (no daemon needed).

WORKER_LIMITS_LIVE=1 also checks kernel limits and restart in a disposable Linux VM with root,
Docker's systemd cgroup driver, cgroup v2 and systemd. Never enable it on the company server.
"""
from contextlib import ExitStack
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import uuid
import yaml

HERE = Path(__file__).resolve().parent
MIB = 2 ** 20
COMPOSE = os.environ.get('DOCKER_COMPOSE') or shutil.which('docker-compose')


def run(*args, **kwargs):
    completed = subprocess.run(args, capture_output=True, text=True, **kwargs)
    if completed.returncode:
        raise AssertionError(f'{args[0]} exited {completed.returncode}: {completed.stderr}')
    return completed.stdout


UNITS = {'m': MIB, 'g': 2 ** 30}


def as_deployed(setting):
    """A compose.yaml setting as the deployment reads it: its ${...} expanded from infra-env.sh, else its own
    default."""
    expanded = subprocess.run(['bash', '-c', f'. infra/infra-env.sh; printf %s "{setting}"'],
                              cwd=HERE.parent, capture_output=True, text=True, check=True)
    return expanded.stdout


def composed_worker(folder, memory):
    stack = yaml.safe_load((HERE / 'compose.yaml').read_text())
    server_env = folder / 'server.env'
    server_env.write_text('')
    for service in stack['services'].values():
        if 'env_file' in service:
            service['env_file'] = str(server_env)
    compose = folder / 'compose.yaml'
    compose.write_text(yaml.safe_dump(stack))
    settings = folder / 'infra.env'
    settings.write_text(f'SERVER_NAME=limitsfixture\nWORKER_MEMORY={memory}\n')
    # Use the deployment's setting reader and Compose's own interpolation and byte-size normalization.
    rendered = run('bash', '-c', '. "$1"; shift; exec "$@"', '_', str(HERE / 'infra-env.sh'),
                   COMPOSE, '-f', str(compose), 'config', '--format', 'json',
                   env={'PATH': os.environ['PATH'], 'INFRA_ENV': str(settings), 'PUBLIC_HOST': 'hq.company.test'})
    return json.loads(rendered)['services']['worker']


@unittest.skipUnless(COMPOSE, 'real Compose required: set DOCKER_COMPOSE=/path/to/docker-compose')
class MemoryLimits(unittest.TestCase):
    def test_compose_resolves_equivalent_ceiling_spellings_without_extra_swap(self):
        with tempfile.TemporaryDirectory() as tmp:
            for spelling in ['8192m', '8g', '8589934592']:
                with self.subTest(spelling=spelling):
                    worker = composed_worker(Path(tmp), spelling)
                    self.assertEqual(int(worker['mem_limit']), 8192 * MIB)
                    self.assertEqual(int(worker['memswap_limit']), 8192 * MIB)

    @unittest.skipUnless(os.environ.get('WORKER_LIMITS_LIVE') == '1',
                         'kernel enforcement needs WORKER_LIMITS_LIVE=1 in a disposable Linux VM')
    def test_kernel_ceiling_and_no_swap_survive_container_restart(self):
        with ExitStack() as cleanup:
            folder = Path(cleanup.enter_context(tempfile.TemporaryDirectory()))
            worker = composed_worker(folder, '8192m')
            project = 'limits' + uuid.uuid4().hex
            parent = worker['cgroup_parent'].replace('limitsfixture', project)
            unit = Path('/run/systemd/system') / parent
            unit.write_bytes((HERE / 'worker.slice').read_bytes())
            cleanup.callback(run, 'systemctl', 'daemon-reload')
            cleanup.callback(unit.unlink)
            run('systemctl', 'daemon-reload')
            self.assertEqual(run('docker', 'info', '--format', '{{.CgroupDriver}}').strip(), 'systemd')
            run('systemctl', 'start', parent)
            cleanup.callback(run, 'systemctl', 'stop', parent)
            # Only the resolved deployment policy enters this idle fixture. No company mounts, keys or worker jobs.
            fixture = folder / 'kernel.yaml'
            fixture.write_text(yaml.safe_dump({'services': {'worker': {
                'image': 'busybox:1.37', 'command': ['sleep', '300'], 'network_mode': 'none', 'cgroup': 'private',
                'mem_limit': worker['mem_limit'], 'memswap_limit': worker['memswap_limit'],
                'cgroup_parent': parent,
            }}}))
            compose = [COMPOSE, '-p', project, '-f', str(fixture)]
            cleanup.callback(run, *compose, 'down', '--volumes')
            run(*compose, 'up', '-d')
            for restarted in [False, True]:
                with self.subTest(restarted=restarted):
                    if restarted:
                        run(*compose, 'restart')
                    cap = run(*compose, 'exec', '-T', 'worker', 'cat', '/sys/fs/cgroup/memory.max')
                    self.assertEqual(int(cap), 8192 * MIB)
                    control = run('systemctl', 'show', parent, '--property=ControlGroup', '--value').strip()
                    container = run(*compose, 'ps', '-q', 'worker').strip()
                    pid = run('docker', 'inspect', '--format', '{{.State.Pid}}', container).strip()
                    membership = Path(f'/proc/{pid}/cgroup').read_text().strip().removeprefix('0::')
                    self.assertTrue(membership.startswith(control + '/'), membership)
                    swap = Path('/sys/fs/cgroup') / control.lstrip('/') / 'memory.swap.max'
                    self.assertEqual(int(swap.read_text()), 0)
                    charge = run(*compose, 'exec', '-T', 'worker', 'cat', '/sys/fs/cgroup/memory.swap.current')
                    self.assertEqual(int(charge), 0)

    def test_worker_inherits_zero_swap_with_a_finite_ram_ceiling(self):
        worker = yaml.safe_load((HERE / 'compose.yaml').read_text())['services']['worker']
        parent = worker['cgroup_parent'].replace('${SERVER_NAME}', 'testco')
        self.assertEqual(parent, 'testco-worker.slice')
        policy = configparser.ConfigParser()
        policy.read(HERE / 'worker.slice')
        self.assertEqual(policy['Slice']['MemorySwapMax'], '0')
        self.assertNotIn('MemoryMax', policy['Slice'])
        self.assertEqual(worker['mem_limit'], worker['memswap_limit'])
        # the company's own ceiling, finite
        self.assertRegex(as_deployed(worker['mem_limit']), r'^[1-9][0-9]*[mg]$')

    def test_finite_policy_keeps_the_reserve_on_the_same_captured_load(self):
        worker = yaml.safe_load((HERE / 'compose.yaml').read_text())['services']['worker']
        limit = worker.get('mem_limit', 0)
        if isinstance(limit, str):
            limit = as_deployed(limit)
        # Compose's byte-size syntax, in the units the first test allows
        cap = int(limit[:-1]) * UNITS[limit[-1]] if isinstance(limit, str) and limit[-1:] in UNITS else int(limit)
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
