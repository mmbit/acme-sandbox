#!/usr/bin/env python3
"""python3 infra/renders.py <checkout> <store> <state>: puts every render back in the server's checkout.

Rendered video and audio stays out of git (shared/demo/renders.mjs): the repo keeps each one's recipe and its
`<file>.render.json`, and HQ, the previews, the product sites and the company's tools read the file where it always was.
For each .render.json git tracks, its file is put there from the worker's store (`<store>/<sha256>`, what a job pushed),
or for one rendered before renders were kept, from its blob in git's history (only one that is video or audio, so a
.render.json can't bring back any old file). Each is checked against its sha256 and written whole (a temporary file,
then renamed). A run's raw output kept without a recipe comes back from the store too. Raw output adopted from git
stays in its history, where a job's clone reads it (renders.mjs fetch). <state> remembers what was put where (and what
was missing), so a run that has nothing new to put costs a directory listing, and a file whose .render.json went is
taken away again. sync.sh runs it on every run, after the checkout moves.
Prints what it put back and what it couldn't find; exits 0 either way (a missing render is no reason not to deploy).
"""
import hashlib, json, os, subprocess, sys

SIDE = '.render.json'
MEDIA = ('.mp4', '.mov', '.webm', '.m4a', '.wav', '.mp3', '.ogg')


def media(head):
    """Whether these first bytes start a video or audio file (MP4/QuickTime/M4A, WAV, MP3, Ogg, WebM)."""
    return (head[4:8] == b'ftyp' or (head[:4] == b'RIFF' and head[8:12] == b'WAVE') or head[:3] == b'ID3'
            or head[:2] in (b'\xff\xfb', b'\xff\xf3', b'\xff\xf2') or head[:4] == b'OggS' or head[:4] == b'\x1a\x45\xdf\xa3')


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def git(checkout, *args, **kw):
    return subprocess.run(['git', '-C', checkout, *args], check=True, capture_output=True, **kw).stdout


def inside(checkout, path):
    """The path's real place, when it's inside the checkout (a tracked symlink can't lead the write elsewhere)."""
    real = os.path.realpath(os.path.join(checkout, os.path.dirname(path)))
    return real == os.path.realpath(checkout) or real.startswith(os.path.realpath(checkout) + os.sep)


def put(checkout, store, path, note):
    """Writes the render `path` names from the store or git's history. Returns False when there's none to be had."""
    want, dest = note.get('sha256', ''), os.path.join(checkout, path)
    tmp = f'{dest}.renders-tmp'
    stored = os.path.join(store, want) if len(want) == 64 and all(c in '0123456789abcdef' for c in want) else ''
    if stored and os.path.isfile(stored):
        with open(stored, 'rb') as src, open(tmp, 'wb') as out:
            for block in iter(lambda: src.read(1 << 20), b''):
                out.write(block)
    elif note.get('blob') and path.lower().endswith(MEDIA):
        try:
            data = git(checkout, 'cat-file', 'blob', str(note['blob']))
        except subprocess.CalledProcessError:
            return False
        if not media(data[:12]):
            return False
        with open(tmp, 'wb') as out:
            out.write(data)
    else:
        return False
    if sha256(tmp) != want:
        os.remove(tmp)
        return False
    os.chmod(tmp, 0o644)
    os.replace(tmp, dest)
    return True


def main(checkout, store, state_file):
    try:
        with open(state_file) as f:
            saved = json.load(f)
    except (OSError, ValueError):
        saved = {}
    state = saved.get('put', {})
    tracked = set(git(checkout, 'ls-files', '-z', text=True).split('\0'))
    sides = sorted(p for p in tracked if p.endswith(SIDE))
    put_back, missing, now = [], [], {}
    for side in sides:
        path = side[:-len(SIDE)]
        if path in tracked or not inside(checkout, path):   # (one still in git keeps its own; one led elsewhere is skipped)
            continue
        try:
            with open(os.path.join(checkout, side)) as f:
                note = json.load(f)
        except (OSError, ValueError):
            missing.append(path)
            continue
        # raw output adopted from git (a trace, a log) stays in its history, where a job's clone reads it (renders.mjs
        # fetch): only media comes back from a blob
        if note.get('blob') and not path.lower().endswith(MEDIA):
            continue
        dest = os.path.join(checkout, path)
        if state.get(path) == note.get('sha256') and os.path.isfile(dest) and os.path.getsize(dest) == note.get('bytes'):
            now[path] = state[path]
            continue
        if put(checkout, store, path, note):
            now[path] = note['sha256']
            put_back.append(path)
        else:
            missing.append(path)
    # a file put here whose .render.json went (or moved) goes too, unless something else changed it since
    for path, sha in state.items():
        dest = os.path.join(checkout, path)
        if path not in now and path not in tracked and os.path.isfile(dest) and inside(checkout, path) and sha256(dest) == sha:
            os.remove(dest)
    with open(f'{state_file}.tmp', 'w') as f:
        json.dump({'put': now, 'missing': missing}, f)
    os.replace(f'{state_file}.tmp', state_file)
    if put_back:
        print(f'renders: {len(put_back)} put back')
    if missing and missing != saved.get('missing'):   # (said again only when it changes: this runs every minute)
        print(f'renders: {len(missing)} not found: ' + ', '.join(missing[:10]) + (' and more' if len(missing) > 10 else ''))


if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
