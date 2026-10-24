#!/usr/bin/env python3
"""python3 infra/test_sync_prune.py: the deploy's build-cache prune keeps a budget, so free space and the cache can't
trade places every deploy. The script under test is sync.sh's own prune lines,
taken from the file, run by bash against a stand-in host: docker and df answer from a JSON file holding the free space
and the cache's steps (size, the deploy that last used it), and `docker builder prune` drops least recently used
first, never a step the deploy under way used when filtered `until=`.
"""
import json, os, re, subprocess, tempfile, unittest

here = os.path.dirname(os.path.abspath(__file__))
PRUNE = re.compile(r'^# The images a rebuild replaced go after every deploy.*?(?=^\./infra/report\.sh "\$log"$)',
                   re.M | re.S)
GB = 10 ** 9
DISK = 75 * 2 ** 30  # the server's disk on 24 Oct (hq report's "== disk")
# A full rebuild filled 15 GB of cache and took about 7 GB of free space (21 GB before, under 15 after): the rest is
# layers its images share. So a step's bytes cost free space at this rate, coming and going.
DISK_COST = 7 / 15

HOST = r'''
import json, re, sys
state_file, tool, args = sys.argv[1], sys.argv[2], sys.argv[3:]
with open(state_file) as f:
    state = json.load(f)
cache = state['cache']
if tool == 'df':
    print('Avail' if 'avail' in args[0] else 'Size')
    print(int(state['free'] if 'avail' in args[0] else state['disk']) // 1024)
elif args[:2] == ['system', 'df']:
    print('Build Cache %.2fGB' % (sum(step['size'] for step in cache) / 1e9))
elif args[:2] == ['image', 'prune']:
    print('Total reclaimed space: 0B')
elif args[:2] == ['builder', 'prune']:
    keep = 0
    if '--keep-storage' in args:
        keep = int(re.fullmatch(r'(\d+)mb', args[args.index('--keep-storage') + 1]).group(1)) << 20
    keep_used = any(arg.startswith('until=') for arg in args)
    cache.sort(key=lambda step: step['used'])
    dropped = 0
    for step in list(cache):
        if keep and sum(step['size'] for step in cache) <= keep:
            break
        if not (keep_used and step['used'] == state['now']):
            cache.remove(step)
            dropped += step['size']
    state['free'] += dropped * state['diskCost']
    state['prunes'].append(dropped)
    print('Total:\t%.2fGB' % (dropped / 1e9))
with open(state_file, 'w') as f:
    json.dump(state, f)
'''


def prune_lines(floor_gb):
    with open(os.path.join(here, 'sync.sh')) as f:
        found = PRUNE.search(f.read())
    assert found, "sync.sh: the prune lines after the deploy were not found"
    lines = found.group(0)
    assert 'floorBytes=$((10 << 30))' in lines, "sync.sh: the 10 GB free line was not found"
    return lines.replace('floorBytes=$((10 << 30))', f'floorBytes=$(({floor_gb} << 30))')


class Host:
    """A server's deploys: each builds every image's steps (the ones it still has cost nothing), then prunes"""

    def __init__(self, root, free, steps, floor_gb=10):
        self.root, self.state_file, self.deploys, self.floor_gb = root, f'{root}/state.json', 0, floor_gb
        self.steps = steps  # name -> size: what today's images stand on
        os.makedirs(f'{root}/bin')
        with open(f'{root}/host.py', 'w') as f:
            f.write(HOST)
        for tool in ('docker', 'df'):
            with open(f'{root}/bin/{tool}', 'w') as f:
                f.write(f'#!/bin/sh\nexec python3 {root}/host.py {self.state_file} {tool} "$@"\n')
            os.chmod(f'{root}/bin/{tool}', 0o755)
        self.save({'disk': DISK, 'free': free, 'diskCost': DISK_COST, 'cache': [], 'prunes': []})

    def load(self):
        with open(self.state_file) as f:
            return json.load(f)

    def save(self, state):
        with open(self.state_file, 'w') as f:
            json.dump(state, f)

    def deploy(self, changed=()):
        """Builds every image (changed steps are new ones; the steps they replace stay behind, unused), then prunes.
        What it had to build, in bytes."""
        self.deploys += 1
        for name in changed:
            self.steps[f'{name} v{self.deploys}'] = self.steps.pop(name)
        state = self.load()
        state['now'] = self.deploys
        cached = {step['name']: step for step in state['cache']}
        built = 0
        for name, size in self.steps.items():
            if name in cached:
                cached[name]['used'] = self.deploys
            else:
                state['cache'].append({'name': name, 'size': size, 'used': self.deploys})
                state['free'] -= size * DISK_COST
                built += size
        self.save(state)
        script = 'log=$1/log\n' + prune_lines(self.floor_gb)
        done = subprocess.run(['bash', '-c', script, 'sync', self.root], capture_output=True, text=True, timeout=60,
                              env={**os.environ, 'PATH': f'{self.root}/bin:{os.environ["PATH"]}'})
        assert done.returncode == 0 and not done.stderr, done.stderr
        return built

    def log(self):
        with open(f'{self.root}/log') as f:
            return f.read().strip().split('\n')[-1]


def images(count, size):
    """count images of 3 steps each, size bytes in all"""
    return {f'image {i} step {j}': size // (count * 3) for i in range(count) for j in range(3)}


class Prune(unittest.TestCase):
    def test_the_24_october_loop_keeps_its_cache(self):
        # 21 GB free with the cache just pruned: the rebuild refills 15 GB and leaves free under the 15 GB line
        for floor_gb in (15, 10):
            with tempfile.TemporaryDirectory() as root, self.subTest(line=f'{floor_gb} GB'):
                host = Host(root, free=21 * GB, steps=images(6, 15 * GB), floor_gb=floor_gb)
                self.assertEqual(host.deploy(), 15 * GB - 15 * GB % 18)
                state = host.load()
                self.assertEqual(sum(step['size'] for step in state['cache']), sum(host.steps.values()), host.log())
                self.assertNotIn('all of it', host.log())
                # the next deploys build next to nothing, where the old rule rebuilt all 15 GB each time
                for _ in range(3):
                    self.assertLess(host.deploy(), 2 * GB, host.log())
                self.assertEqual(sum(host.load()['prunes']), 0, 'every step was one the deploy used')

    def test_a_growing_cache_loses_the_steps_no_image_uses_any_more(self):
        # every deploy changes a step of two images; the cache passes a quarter of the disk (20.1 GB) and is trimmed
        with tempfile.TemporaryDirectory() as root:
            host = Host(root, free=40 * GB, steps=images(6, 15 * GB))
            host.deploy()
            for n in range(2, 12):
                built = host.deploy(changed=[name for name in host.steps if name.startswith(('image 0 step 2',
                                                                                             'image 1 step 2'))])
                self.assertEqual(built, 2 * (15 * GB // 18), f'deploy {n} built only its two changed steps')
            state = host.load()
            self.assertTrue(state['prunes'], 'the cache went over its share')
            self.assertLessEqual(sum(step['size'] for step in state['cache']), DISK // 4)
            self.assertEqual({step['name'] for step in state['cache'] if step['used'] == host.deploys}, set(host.steps),
                             "every step today's images stand on is kept")
            self.assertIn('oldest first', host.log())
            self.assertIn('a quarter of the disk', host.log())

    def test_with_no_room_for_any_of_it_the_whole_cache_goes(self):
        with tempfile.TemporaryDirectory() as root:
            host = Host(root, free=4 * GB, steps=images(2, 3 * GB))
            host.deploy()
            self.assertEqual(host.load()['cache'], [])
            self.assertIn('under 5 GB free: the steps this deploy used too', host.log())


if __name__ == '__main__':
    unittest.main()
