#!/usr/bin/env python3
"""python3 infra/test_renders.py: renders.py in a throwaway git checkout and store (no Docker).

Checks that a render comes back from the worker's store and one from before from git's history, each checked against
its sha256, and a run's raw output from the store; that history gives back only video or audio, and raw output
adopted from git isn't missing; that a file whose .render.json went is taken away; that a
file still in git and a path led out through a symlink are left alone; and that a second run with nothing new puts
nothing and says nothing.
"""
import hashlib, json, os, subprocess, tempfile

here = os.path.dirname(os.path.abspath(__file__))
tmp = tempfile.mkdtemp(prefix='renders-test-')
repo, store, state = os.path.join(tmp, 'repo'), os.path.join(tmp, 'store'), os.path.join(tmp, 'state.json')
os.makedirs(os.path.join(repo, 'products/x/ads'))
os.makedirs(store)
failures = []


def check(what, ok):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok:
        failures.append(what)


def git(*args):
    return subprocess.run(['git', '-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', *args], check=True, capture_output=True, text=True).stdout


def write(path, data):
    with open(os.path.join(repo, path), 'wb') as f:
        f.write(data)


def run():
    return subprocess.run(['python3', os.path.join(here, 'renders.py'), repo, store, state], capture_output=True, text=True, check=True).stdout


def note(path, data, **more):
    write(path + '.render.json', json.dumps({'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), **more}).encode())


old, new, text = b'\0\0\0\x18ftypmp42 an old film', b'\0\0\0\x18ftypmp42 a new film', b'HQ_TOKEN=a secret once committed\n'
git('init', '-q', '-b', 'main')
write('products/x/ads/old.mp4', old)
write('products/x/ads/secret.mp4', text)
write('products/x/ads/kept.mp4', b'\0\0\0\x18ftypmp42 still in git')
git('add', '-A')
git('commit', '-qm', 'films in git')
blob = git('rev-parse', 'HEAD:products/x/ads/old.mp4').strip()
secret = git('rev-parse', 'HEAD:products/x/ads/secret.mp4').strip()
git('rm', '-q', '--cached', 'products/x/ads/old.mp4', 'products/x/ads/secret.mp4')
os.remove(os.path.join(repo, 'products/x/ads/old.mp4'))
os.remove(os.path.join(repo, 'products/x/ads/secret.mp4'))
note('products/x/ads/old.mp4', old, blob=blob)
note('products/x/ads/secret.mp4', text, blob=secret)
note('products/x/ads/new.mp4', new, command=['node', 'shared/demo/ad.mjs'])
note('products/x/ads/kept.mp4', b'something else')
with open(os.path.join(store, hashlib.sha256(new).hexdigest()), 'wb') as f:
    f.write(new)
os.makedirs(os.path.join(repo, 'knowledge/qa'))
trace, observations = b'{"frames": [1, 2, 3]}\n', b'{"seen": []}\n'
note('knowledge/qa/trace.json', trace)   # raw output kept in the store (renders.mjs keep)
with open(os.path.join(store, hashlib.sha256(trace).hexdigest()), 'wb') as f:
    f.write(trace)
note('knowledge/qa/observations.json', observations, blob=secret)   # raw output adopted: it stays in git's history
outside = os.path.join(tmp, 'outside')   # a folder beside the checkout, as /tmp is to the real one
os.makedirs(outside)
os.symlink(outside, os.path.join(repo, 'products/out'))
note('products/out/escape.mp4', new, command=['node', 'shared/demo/ad.mjs'])
git('add', '-A')
git('commit', '-qm', 'renders kept out')

said = run()
read = lambda p: open(os.path.join(repo, p), 'rb').read() if os.path.exists(os.path.join(repo, p)) else None
check('a render from the store comes back', read('products/x/ads/new.mp4') == new)
check('one from before comes back from its blob', read('products/x/ads/old.mp4') == old)
check('history gives back only video or audio', read('products/x/ads/secret.mp4') is None)
check('a file still in git keeps its own', read('products/x/ads/kept.mp4') == b'\0\0\0\x18ftypmp42 still in git')
check('a path led out through a symlink is left alone', not os.path.exists(os.path.join(outside, 'escape.mp4')))
check('raw output kept in the store comes back', read('knowledge/qa/trace.json') == trace)
check('raw output adopted from git stays there, not missing', read('knowledge/qa/observations.json') is None
      and 'observations' not in said)
check('it says what it put back and what it could not find', 'renders: 3 put back' in said and 'secret.mp4' in said)
check('nothing new: nothing put and nothing said', run() == '')
git('rm', '-q', 'products/x/ads/new.mp4.render.json')
git('commit', '-qm', 'the new film goes')
run()
check("a file whose .render.json went is taken away", read('products/x/ads/new.mp4') is None and read('products/x/ads/old.mp4') == old)

print('all good' if not failures else f'{len(failures)} failed')
raise SystemExit(1 if failures else 0)
