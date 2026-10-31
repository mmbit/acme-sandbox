#!/usr/bin/env python3
"""python3 infra/test_sync_prune.py: the deploy's build cache goes whole or not at all, before the build, so neither a
partial prune nor the rebuild after a whole one can take the disk under its floor, and the two can't trade places every
deploy. The script under test is sync.sh's own prune lines (prune_cache and the image prune after the deploy), taken
from the file, run by bash against a stand-in host: docker and df answer from a JSON file holding the free space, the
cache's steps and the images' layers, and `docker builder prune` refuses anything but the whole cache.

"""
import json, os, re, subprocess, tempfile, unittest
from sync_fixture import sync_lines

PRUNE_CACHE = re.compile(r'^floorBytes=.*?^prune_cache\(\) \{.*?^\}$', re.M | re.S)
PRUNE_IMAGES = re.compile(r'^# The images a rebuild replaced go after every deploy.*?(?=^\./infra/report\.sh "\$log"$)',
                          re.M | re.S)
GB = 10 ** 9  # docker's sizes are decimal; the script's free space is counted in 2 ** 30 (GiB)
DISK = 150 * 2 ** 30  # the server's disk (hq report's "== disk")

# The stand-in host. A cache step today's images stand on is shared with them: a prune drops its record but not its
# layer, which goes with the image a rebuild replaces (the image prune after the deploy). Any other step is the cache's
# own (docker system df's "Reclaimable"), and a prune frees it at once.
HOST = r'''
import json, sys
state_file, tool, args = sys.argv[1], sys.argv[2], sys.argv[3:]
with open(state_file) as f:
    state = json.load(f)
cache = state['cache']
own = sum(step['size'] for step in cache if not step['image'])
if tool == 'df':
    print('Avail' if 'avail' in args[0] else 'Size')
    print(int(state['free'] if 'avail' in args[0] else state['disk']) // 1024)
elif args[:2] == ['system', 'df']:
    if state.get('dfFails'):
        sys.exit('Error response from daemon: busy')
    print('Images 3 3 1GB 0B (0%)')
    print('Build Cache %.2fGB %.2fGB' % (sum(step['size'] for step in cache) / 1e9, own / 1e9))
elif args[:2] == ['image', 'prune']:
    state['free'] += state['replaced']
    print('Total reclaimed space: %.2fGB' % (state['replaced'] / 1e9))
    state['replaced'] = 0
elif args[:2] == ['builder', 'prune']:
    if args[2:] != ['-af']:
        sys.exit('a partial prune: ' + ' '.join(args))
    state['free'] += own
    state['orphaned'] += sum(step['size'] for step in cache if step['image'])
    state['cache'] = []
    state['prunes'].append(own)
    print('Total:\t%.2fGB' % (own / 1e9))
with open(state_file, 'w') as f:
    json.dump(state, f)
'''


def script(floor_gb):
    lines = sync_lines(PRUNE_CACHE, 'the cache prune lines').group(0)
    image_lines = sync_lines(PRUNE_IMAGES, 'the image prune lines').group(0)
    assert 'floorBytes=$((10 << 30))' in lines, "sync.sh: the 10 GB free line was not found"
    lines = lines.replace('floorBytes=$((10 << 30))', f'floorBytes=$(({floor_gb} << 30))')
    return 'log=$1/log\n' + lines + '\nprune_cache >> "$log"\n' + image_lines


class Host:
    """A server's deploys: each prunes, builds every image's steps (the ones it still has cost nothing), prunes the
    images it replaced"""

    def __init__(self, root, free, steps, floor_gb=10):
        self.root, self.state_file, self.deploys, self.floor_gb = root, f'{root}/state.json', 0, floor_gb
        self.steps = steps  # name -> size: what today's images stand on
        self.lowest = float('inf')  # the least free space any deploy saw, mid-build
        os.makedirs(f'{root}/bin')
        with open(f'{root}/host.py', 'w') as f:
            f.write(HOST)
        for tool in ('docker', 'df'):
            with open(f'{root}/bin/{tool}', 'w') as f:
                f.write(f'#!/bin/sh\nexec python3 {root}/host.py {self.state_file} {tool} "$@"\n')
            os.chmod(f'{root}/bin/{tool}', 0o755)
        # (the images' layers already on the disk: a first deploy finds them all cached)
        cache = [{'name': name, 'size': size, 'image': True} for name, size in steps.items()]
        self.save({'disk': DISK, 'free': free, 'cache': cache, 'prunes': [], 'orphaned': 0, 'replaced': 0})

    def load(self):
        with open(self.state_file) as f:
            return json.load(f)

    def save(self, state):
        with open(self.state_file, 'w') as f:
            json.dump(state, f)

    def run(self, lines):
        done = subprocess.run(['bash', '-c', lines, 'sync', self.root], capture_output=True, text=True, timeout=60,
                              env={**os.environ, 'PATH': f'{self.root}/bin:{os.environ["PATH"]}'})
        assert done.returncode == 0 and not done.stderr, done.stderr

    def deploy(self, changed=(), grown=0):
        """Prunes, then builds every image (a changed step is a new one, and the one it replaces stays behind, the
        cache's own); grown: bytes the volumes and jobs took since the last. What it had to build, in bytes."""
        self.deploys += 1
        state = self.load()
        state['free'] -= grown
        self.save(state)
        lines = script(self.floor_gb)
        cut = lines.index('# The images a rebuild replaced')
        self.run(lines[:cut])
        state = self.load()
        for name in changed:
            self.steps[f'{name} v{self.deploys}'] = self.steps.pop(name)
        cached = {step['name']: step for step in state['cache']}
        built = 0
        for step in state['cache']:
            step['image'] = step['name'] in self.steps
        for name, size in self.steps.items():
            if name not in cached:
                state['cache'].append({'name': name, 'size': size, 'image': True})
                state['free'] -= size
                built += size
        self.lowest = min(self.lowest, state['free'])
        # the old images a whole prune left without a record go once the rebuild replaced them
        state['replaced'], state['orphaned'] = state['orphaned'], 0
        self.save(state)
        self.run(lines[:lines.index('prune_cache() {')] + lines[cut:])
        return built

    def log(self):
        with open(f'{self.root}/log') as f:
            return f.read().strip().split('\n')


def images(count, size):
    """count images of 3 steps each, size bytes in all"""
    return {f'image {i} step {j}': size // (count * 3) for i in range(count) for j in range(3)}


def changing(host):
    """a deploy's changed steps: a step of two images"""
    return [name for name in host.steps if name.startswith(('image 0 step 2', 'image 1 step 2'))]


class Prune(unittest.TestCase):
    def test_a_growing_cache_goes_whole_once_and_the_rebuild_stays_above_the_floor(self):
        # 15 GB of images, and each deploy leaves ~0.4 GB of the cache's own behind
        with tempfile.TemporaryDirectory() as root:
            host = Host(root, free=60 * GB, steps=images(16, 15 * GB))
            builds = [host.deploy(changed=changing(host)) for _ in range(60)]
            state = host.load()
            self.assertEqual(len(state['prunes']), 1, 'the whole cache went once, when free space reached the line')
            whole = next(n for n, line in enumerate(host.log()) if 'pruned whole' in line) // 2
            self.assertGreater(builds[whole], 14 * GB, 'that deploy rebuilt every image')
            self.assertTrue(all(built < GB for n, built in enumerate(builds) if n != whole),
                            'every other deploy built only its changed steps')
            self.assertGreaterEqual(host.lowest, 10 * 2 ** 30, 'no deploy took the disk under the floor')

    def test_a_whole_prune_the_rebuild_would_undo_is_skipped(self):
        # 21 GB free with little of the cache its own: a whole prune would give back less than the rebuild takes
        for floor_gb in (15, 10):
            with tempfile.TemporaryDirectory() as root, self.subTest(line=f'{floor_gb} GB'):
                host = Host(root, free=21 * GB, steps=images(6, 15 * GB), floor_gb=floor_gb)
                for _ in range(4):
                    self.assertLess(host.deploy(changed=changing(host)), 2 * GB, host.log())
                self.assertEqual(host.load()['prunes'], [])
                self.assertIn("the disk needs room the cache can't give", host.log()[-2])

    def test_with_room_the_cache_is_kept_whole(self):
        with tempfile.TemporaryDirectory() as root:
            host = Host(root, free=60 * GB, steps=images(6, 15 * GB))
            host.deploy(changed=changing(host))
            self.assertEqual(host.load()['prunes'], [])
            self.assertRegex(host.log()[0], r'^build cache kept whole: [\d.]+GB \(0\.00GB its own\), 55 GB free$')

    def test_a_cache_mostly_its_own_goes_whole_before_the_build(self):
        # 23 GB free (21 GiB, as the log counts) with 40 GB of the cache its own: the next deploy starts from a whole prune
        with tempfile.TemporaryDirectory() as root:
            host = Host(root, free=23 * GB, steps=images(16, 15 * GB))
            state = host.load()
            state['cache'].append({'name': 'old steps', 'size': 40 * GB, 'image': False})
            host.save(state)
            self.assertGreater(host.deploy(), 14 * GB)
            self.assertRegex(host.log()[0], r'^build cache pruned whole: 40\.00GB of 55\.00GB, 21 GB free, under 25 GB')
            self.assertGreaterEqual(host.lowest, 40 * 2 ** 30)
            self.assertLess(host.deploy(), GB, 'and the cache holds again')

    def test_with_almost_no_room_the_whole_cache_goes_if_it_leaves_more_after_the_rebuild(self):
        # 4 GB free and 20 GB of the cache its own: under the line after the rebuild, but more room than now
        with tempfile.TemporaryDirectory() as root:
            host = Host(root, free=4 * GB, steps=images(2, 3 * GB))
            state = host.load()
            state['cache'].append({'name': 'old steps', 'size': 20 * GB, 'image': False})
            host.save(state)
            host.deploy()
            self.assertEqual(len(host.load()['prunes']), 1)
            self.assertIn('pruned whole', host.log()[0])

    def test_with_almost_no_room_a_cache_the_images_share_is_kept(self):
        # 4 GB free and a 15 GB cache all shared with the images: a prune frees nothing and the rebuild can't fit
        with tempfile.TemporaryDirectory() as root:
            host = Host(root, free=4 * GB, steps=images(16, 15 * GB))
            self.assertEqual(host.deploy(), 0)
            self.assertEqual(host.load()['prunes'], [])
            self.assertIn("the disk needs room the cache can't give", host.log()[0])

    def test_a_failed_read_of_the_cache_gives_no_verdict(self):
        with tempfile.TemporaryDirectory() as root:
            host = Host(root, free=12 * GB, steps=images(2, 3 * GB))
            state = host.load()
            state['dfFails'] = True
            host.save(state)
            lines = script(10)
            done = subprocess.run(['bash', '-c', lines[:lines.index('# The images a rebuild replaced')], 'sync', root],
                                  capture_output=True, text=True, timeout=60,
                                  env={**os.environ, 'PATH': f'{root}/bin:{os.environ["PATH"]}'})
            self.assertIn('busy', done.stderr, "docker's own error reaches the deploy log")
            self.assertEqual(host.log(), ['build cache kept whole: docker system df gave no build cache size'])
            self.assertEqual(host.load()['prunes'], [])

if __name__ == '__main__':
    unittest.main()
