#!/usr/bin/env python3
"""Each product's server errors since the last run, as kinds without their text, for HQ's daily error scan
(infra/products.md, "HQ's watch")."""
import collections, datetime, json, os, re, subprocess, sys
from backup import into_volume, open_dir
from company import INFRA, ROOT
from log_errors import BAD

# Root's copy. The copy in the volume is the coordinator's to change.
STATE = f"/var/lib/{INFRA.get('SERVER_NAME', 'server')}/app-errors.json"
KEEP_DAYS = 30
FIRST_RUN = '24 hours ago'   # journalctl --since, before there's a last run
# A product's container in the journal: compose names it <project>-<service>-<n>, the project being compose.yaml's folder
CONTAINER = re.compile(r'infra-(product-[a-z0-9-]+)-\d+')
NAMED = re.compile(r'\b((?:[A-Z][A-Za-z]*)?(?:Error|Exception))\b')
FRAME = re.compile(r'^\s+at ')
# the source line Node prints above an uncaught error, in the image's files or Node's own:
# "file:///repo/products/hello/app/src/server.ts:41", "node:internal/modules/esm/resolve:272" (node: is)
SOURCE = re.compile(r'^(?:(?:file://)?/|node:)\S+:\d+$')
# the unindented rest of an uncaught error: the dumped error's closing brace when it has fields, and Node's trailer,
# "Node.js v24.22.0"
CLOSING = re.compile(r'^(?:\}|Node\.js v\d+\.\d+\.\d+)$')
# journald's priorities from warning up: Docker's journald driver logs stderr at 3 (error) and stdout at 6 (info)
WARNING = 4
# a frame's function, and its file under the image's top folder, /repo or /app (appCode):
# "    at handle (file:///repo/products/hello/app/src/server.ts:12:5)", "    at async file:///app/src/x.ts:3:1"
PLACE = re.compile(r'^\s+at (?:async )?(?:(.+?) \()?(?:file://)?/(repo|app)/([\w./@-]+):\d+:\d+\)?$')
FUNCTION = re.compile(r'[A-Za-z_$][\w$]{0,60}(\.[A-Za-z_$][\w$]{0,60}){0,3}')
WORD = re.compile(r'[A-Za-z_$][\w$]*')
CODE = ('.ts', '.mts', '.cts', '.js', '.mjs', '.cjs')
BUILT_IN = {'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'EvalError', 'URIError',
            'AggregateError', 'AbortError', 'TimeoutError', 'DOMException'}
WITHHELD = 'stderr, warning or error lines without a named error (text withheld)'
NO_OWN_FRAME = 'not thrown in the app\'s own code'
OTHER_NAME = 'an error whose name the app\'s code doesn\'t have'


def main(argv):
    if len(argv) != 2:
        sys.exit('usage: app_errors.py <the coordinator\'s volume>')
    text = run(argv[1], datetime.datetime.now(datetime.timezone.utc))
    print(f'app_errors: {sum(len(k) for k in json.loads(text)["apps"].values())} kinds kept', flush=True)


# read: each product's log texts since the last run's cursor, each with whether it's the app's stderr, and the cursor
# after them (a test brings its own).
# repo: the checkout the kinds are checked against.
def run(hqData, now, state=STATE, read=None, repo=ROOT):
    previous = load(state)
    streams, cursor = (read or readJournal)(previous.get('cursor'))
    found = {}
    for service, texts in streams.items():
        slug = service.removeprefix('product-')
        code = appCode(repo, slug)
        counts = collections.Counter()
        for stderr, text in texts:
            counts.update(kinds(text.splitlines(), code, stderr))
        found[slug] = dict(counts)
    status = {'at': now.isoformat(timespec='seconds'), 'cursor': cursor,
              'apps': merge(previous.get('apps', {}), found, now)}
    text = json.dumps(status, indent=1, sort_keys=True)
    os.makedirs(os.path.dirname(state), mode=0o700, exist_ok=True)
    with open(f'{state}.new', 'w') as f:
        f.write(text)
    os.replace(f'{state}.new', state)
    hqFd = open_dir(hqData)
    try:
        into_volume(text.encode(), hqFd, 'app-errors.json')
    finally:
        os.close(hqFd)
    return text


def load(path):
    """The last run's state, or nothing before a first run. A state that can't be read fails the run, which keeps it."""
    try:
        f = open(path)
    except FileNotFoundError:
        return {}
    with f:
        return json.load(f)


def readJournal(after):
    """Each product's log since the cursor, one text per container and stream, each with whether it's stderr, and the
    cursor of the last entry read (the same one when there's none). Docker's journald driver logs each line as an entry
    with its container's name and its stream's priority. Node writes console.error, console.warn and a crash's stack to
    stderr."""
    where = ['--after-cursor', after] if after else ['--since', FIRST_RUN]
    out = subprocess.run(['journalctl', '--output=json', '--no-pager', '--quiet', *where], capture_output=True, text=True,
                         errors='replace', timeout=240, check=True).stdout
    entries = [json.loads(line) for line in out.splitlines()]
    lines, cursor = {}, after
    for entry in entries:
        cursor = entry['__CURSOR']
        container = CONTAINER.fullmatch(entry.get('CONTAINER_NAME', ''))
        message = entry.get('MESSAGE')
        if not container or message is None:
            continue
        if isinstance(message, list):   # journalctl's JSON gives a message that isn't plain text as its bytes
            message = bytes(message).decode('utf-8', 'replace')
        stderr = int(entry.get('PRIORITY', 6)) <= WARNING
        lines.setdefault((container[1], entry.get('CONTAINER_ID_FULL'), stderr), []).append(message)
    streams = {}
    for (service, _, stderr), stream in lines.items():
        streams.setdefault(service, []).append((stderr, '\n'.join(stream)))
    return streams, cursor


def appCode(repo, slug):
    """A code file of the app's image, by its top folder and its path under it: the file's path in the checkout and the
    names written in it, or None when the checkout has no such file. A product's image lays the repo out under /repo
    (products.md, "the app's Dockerfile"). Care's holds the repo under /app, and an image that keeps only its app folder
    has that under /app."""
    repo = os.path.realpath(repo)
    roots = {'repo': [repo], 'app': [os.path.realpath(os.path.join(repo, 'products', slug, 'app')), repo]}
    found = {}

    def fileOf(top, path):
        if (top, path) not in found:
            found[top, path] = None
            if path.endswith(CODE) and '/node_modules/' not in f'/{path}' and '..' not in path.split('/'):
                for root in roots[top]:
                    file = os.path.realpath(os.path.join(root, path))
                    if file.startswith(root + os.sep) and os.path.isfile(file):
                        with open(file, errors='replace') as f:
                            found[top, path] = (os.path.relpath(file, repo), frozenset(WORD.findall(f.read())))
                        break
        return found[top, path]
    return fileOf


def kinds(lines, code, stderr=False):
    """The error kinds in a stream's lines, counted: a named error by the first frame of the app's own code under it.
    On stderr every message without a named error counts as withheld. An indented line (a frame, a dumped object's
    field) is part of another message, and so are an uncaught error's source line, the code under it (indented or not,
   ) and the CLOSING lines."""
    found, named, source = collections.Counter(), None, False
    for line in lines:
        if source:
            source = False
            continue
        if FRAME.match(line):
            place = PLACE.match(line)
            file = code(place[2], place[3]) if place else None
            if named and file:
                path, words = file
                shown = f' ({place[1]})' if ownFunction(place[1], words) else ''
                found[f'{nameOf(named, words)} in {path}{shown}'] += 1
                named = None
            continue
        if named:
            found[f'{nameOf(named, frozenset())}, {NO_OWN_FRAME}'] += 1
            named = None
        if stderr and SOURCE.match(line):
            source = True
            continue
        if stderr and CLOSING.match(line):
            continue
        name = NAMED.search(line)
        if name:
            named = name[1]
        elif failing(line, stderr):
            found[WITHHELD] += 1
    if named:
        found[f'{nameOf(named, frozenset())}, {NO_OWN_FRAME}'] += 1
    return dict(found)


failing = lambda line, stderr: line[:1].strip() if stderr else BAD.search(line)
nameOf = lambda name, words: name if name in BUILT_IN or name in words else OTHER_NAME
ownFunction = lambda function, words: bool(function and FUNCTION.fullmatch(function) and set(function.split('.')) <= words)


def merge(previous, found, now):
    """Each app's kinds so far, with this run's counted in. One not seen for KEEP_DAYS goes."""
    stamp, oldest = now.isoformat(timespec='seconds'), (now - datetime.timedelta(days=KEEP_DAYS)).isoformat(timespec='seconds')
    apps = {}
    for slug in previous.keys() | found.keys():
        kept = {k: v for k, v in previous.get(slug, {}).items() if v.get('last', '') >= oldest}
        for kind, n in found.get(slug, {}).items():
            was = kept.get(kind, {'first': stamp, 'n': 0})
            kept[kind] = {'first': was['first'], 'last': stamp, 'n': was['n'] + n}
        if kept:
            apps[slug] = kept
    return apps


if __name__ == '__main__':
    main(sys.argv)
