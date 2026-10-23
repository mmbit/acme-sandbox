#!/usr/bin/env python3
"""python3 infra/test_backup.py: the backup's proof, end to end, without Docker or R2.

backup.py runs against a real S3 server that checks every signature (versitygw, VGW=/path/to/versitygw) with the real age
binary (on PATH, or AGE_DIR), while a writer keeps adding rows to the live database in WAL mode, as the coordinator does.
Then a backup is fetched back, restored into a scratch folder with the private key, and checked: the database opens,
passes its integrity check, matches the copy's manifest and holds exactly the rows the live database had at some
moment during the run; the keys, the voice line's files and the memory come back byte for byte, and a symlink planted
in a volume is kept as a link, never followed. The lent machines' runs are left out; the status says what each part of
the archive weighs (adding up to it) and the database's biggest tables. A product's volume gives only its backup/ folder's finished copies (not a .part
still being written, not its live database), each opening in the drill, which fails on a damaged one; one past the
company's allowance (compressed, an incompressible one just under it still goes), one whose read fails mid-way and one
Docker can't find are each left out whole while HQ's backup goes and the board hears; an oversized copy renamed into place before it opens is left out whole; a preview's volume never goes. Also: nothing runs before the four keys are in, a wrong key fails the
night without leaving plaintext behind or showing the key, a second night adds no second monthly copy, a backup that
would take the bucket past R2's free tier isn't uploaded, and a wrong private key can't open it. A table name with SQL in
it is only ever a name. The SigV4 signer is checked against AWS's own published example, and a redirect is refused.

The repo's copy, against a local stand-in for GitHub: the first night is a full bundle, later nights only what's new
(nothing, on a night without changes); restore-repo clones from the bundles and every branch and tag, main included,
matches GitHub's; a missing link in the chain is named; GitHub not answering still leaves a copy (and a heads-up once
it's been too long); a copy that would pass the free tier goes without the repo, never without the database, and with
the bucket filled to the repo's limit and nothing expiring, a month of nights after still get their database backups; a
repo step stopped mid-way every night (the unit's time limit, a reboot) still reaches the board after 36 hours, a first
try included; a branch or an annotated tag deleted and one nested under its name made between copies (topic ->
topic/child, release -> release/child, and back) still restores. A new server whose first fetch fails keeps the fetch's
reason. A bucket that isn't there is named.

The big files (BIG_FILE_BYTES and up) go once each, as big-files/<keyed sha256>.age (one object for the same content at two paths),
never in the archive, and not again the next night; fetch downloads them as the board would, and the drill puts each in
its place byte for byte (and names them when they weren't fetched). One deleted on the server stays while a backup may
name it, and leaves the bucket BIG_FILE_DAYS after the last one that had it (with the state lost, from the first night that sees it).
The copy leaves the search index out, and BACKUP_BUCKET_GB sets the bucket's room.

The renders (the worker's store, by sha256): each its own object once, ciphertext only, restored byte for byte into a
store renders.py reads; a planted link or a file that isn't its name is left out while the rest go; past their cap
they wait, the board hears after 36 hours, and they go the next night with room. One that went up and didn't read back,
the unit stopped in between included, is read back the nights after and counts as waiting until it does, while the rest
still go (a read-back cut short is asked for again, never a mismatch); their room
counts a repo copy that went up without reading back; a store that can't be read, or a first try stopped mid-way,
reaches the board after 36 hours too.
"""
import contextlib, datetime, hashlib, io, json, os, shutil, socket, sqlite3, subprocess, sys, tarfile, tempfile, time
from unittest.mock import patch

here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, here)
# a test company's names, not the checkout's own company/infra.env
os.environ['INFRA_ENV'] = os.path.join(tempfile.mkdtemp(prefix='backup-infra-'), 'infra.env')
open(os.environ['INFRA_ENV'], 'w').write('SERVER_NAME=testco\nSERVER=testco-1\nBACKUP_BUCKET=testco-backups\n'
                                         'BACKUP_LEFT_OUT=secrets/SAMPLE_DROP_*,photos/9.jp?\n'   # what it leaves out
                                         'BACKUP_PRODUCTS_MB=1\n')
# no spaces in BACKUP_LEFT_OUT (infra-env.sh), and ? as in a shell
import backup  # noqa: E402

if os.environ.get('AGE_DIR'):
    os.environ['PATH'] = os.environ['AGE_DIR'] + os.pathsep + os.environ['PATH']
VGW = os.environ.get('VGW') or shutil.which('versitygw')
for tool in ('age', 'age-keygen', 'node', 'git'):
    if not shutil.which(tool):
        sys.exit(f'needs {tool} on PATH')
if not VGW:
    sys.exit('needs versitygw (VGW=/path/to/versitygw): https://github.com/versity/versitygw/releases')

fails = 0
def check(ok, what):
    global fails
    print(('ok   ' if ok else 'FAIL ') + what)
    fails += not ok

@contextlib.contextmanager
def failing_reads(slug):
    fdopen = os.fdopen

    def open_for_read(fd, *args, **kwargs):
        stream = fdopen(fd, *args, **kwargs)
        if slug in os.readlink(f'/proc/self/fd/{fd}'):
            read, began = stream.read, False

            def failing_read(n=-1):
                nonlocal began
                if began:
                    raise OSError(5, 'Input/output error')
                began = True
                return read(n)
            stream.read = failing_read
        return stream
    with patch('os.fdopen', open_for_read):
        yield


@contextlib.contextmanager
def unreadable_directory(name):
    original_open = os.open

    def failed_open(path, *args, **kwargs):
        if path == name:
            raise OSError(5, 'Input/output error')
        return original_open(path, *args, **kwargs)
    with patch('os.open', failed_open):
        yield


# ---- SigV4: AWS's "GET Object" example (Signature Version 4 examples, S3 API reference)
h = backup.sign('GET', 'https://examplebucket.s3.amazonaws.com/test.txt', {'Range': 'bytes=0-9'}, hashlib.sha256(b'').hexdigest(),
                'AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'us-east-1', datetime.datetime(2013, 5, 24, tzinfo=datetime.timezone.utc))
check(h['authorization'].endswith('Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'), "SigV4 matches AWS's example")

# ---- a redirect is refused: urllib would carry the signed Authorization header along
import http.server, threading  # noqa: E402
seen = []
class Redirect(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        seen.append(self.path)
        self.send_response(302)
        self.send_header('location', f'http://127.0.0.1:{self.server.server_port}/elsewhere')
        self.end_headers()
    def log_message(self, *a):
        pass
srv = http.server.HTTPServer(('127.0.0.1', 0), Redirect)
threading.Thread(target=srv.serve_forever, daemon=True).start()
try:
    backup.R2(f'http://127.0.0.1:{srv.server_port}', 'a' * 32, 'b' * 64).request('GET', 'daily/x')
    check(False, 'a redirect is refused')
except backup.Stop as e:
    check('302' in str(e) and seen == [f'/{backup.BUCKET}/daily/x'], 'a redirect is refused, never followed')
srv.shutdown()

# ---- a read-back whose body is cut short (http.client ends such a read without an error): asked for again, never a mismatch
class Cut(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.server.gets += 1
        whole = self.server.gets > self.server.cuts
        self.send_response(200)
        self.send_header('content-length', '8')
        self.send_header('connection', 'close')
        self.end_headers()
        self.wfile.write(b'12345678' if whole else b'1234')
    def log_message(self, *a):
        pass
def cut_read(cuts):
    s = http.server.HTTPServer(('127.0.0.1', 0), Cut)
    s.gets, s.cuts = 0, cuts
    threading.Thread(target=s.serve_forever, daemon=True).start()
    try:
        with patch.object(backup.time, 'sleep'):
            return backup.R2(f'http://127.0.0.1:{s.server_port}', 'a' * 32, 'b' * 64).fetch_hash('renders/x'), s.gets
    except backup.Stop as e:
        return e, s.gets
    finally:
        s.shutdown()
got, gets = cut_read(1)
check(got == hashlib.sha256(b'12345678').hexdigest() and gets == 2, f'a body cut short is read again, and matches ({got}, {gets} GETs)')
got, gets = cut_read(4)
check(isinstance(got, backup.Stop) and 'cut short' in str(got) and gets == 4, f'cut short every time: R2 unreachable, not a mismatch ({got})')

# ---- a 403 at the bucket: the other jurisdiction's endpoint is asked, only to name the fix
class Answer(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        code, body = self.server.answer
        self.send_response(code)
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a):
        pass
def answering(code, body):
    s = http.server.HTTPServer(('127.0.0.1', 0), Answer)
    s.answer = (code, body)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s
denied = answering(403, b'<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>')
listed = answering(200, b'<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated>'
                        b'<Contents><Key>daily/x</Key><Size>3</Size><LastModified>2026-10-20T02:32:00Z</LastModified></Contents></ListBucketResult>')
gone = answering(404, b'<?xml version="1.0"?><Error><Code>NoSuchBucket</Code></Error>')
def found(first, other):
    """find() at the first server, with the other as the other jurisdiction's endpoint: the Stop, and the R2 after it."""
    r2 = backup.R2(f'http://127.0.0.1:{first.server_port}', 'a' * 32, 'b' * 64, backup.Endpoint(f'http://127.0.0.1:{other.server_port}', 'EU'))
    try:
        r2.find()
    except backup.Stop as e:
        return e, r2
    return None, r2
e, r2 = found(denied, listed)
try:
    r2.listing()
    stays = False
except backup.Stop:
    stays = True
check(e is not None and e.config and "answers at the EU jurisdiction's endpoint" in str(e) and stays,
      f'denied, and listed at the other endpoint: the night fails naming it, and stays at the endpoint set ({e})')
e, _ = found(denied, denied)
check(e is not None and e.config and "isn't one for this bucket" in str(e), f'denied at both endpoints: the token, named ({e})')
e, _ = found(denied, gone)
check(e is not None and e.config and 'NoSuchBucket' in str(e) and "isn't one for this bucket" not in str(e),
      f"denied, and no such bucket at the other endpoint: its own answer, named ({e})")
e, _ = found(gone, listed)
check(e is not None and e.config and 'jurisdiction' not in str(e), f'a 404 asks no other endpoint ({e})')
for s in (denied, listed, gone):
    s.shutdown()

# ---- a throwaway server: three volumes, a live database, an S3 server
tmp = tempfile.mkdtemp(prefix='backup-test-')
hq, voice, seats, state, s3 = (f'{tmp}/{d}' for d in ('hqdata', 'voice', 'seats', 'state', 's3'))
memory = f'{seats}/{backup.MEMORY}'
for d in (f'{hq}/secrets', f'{hq}/approvals', f'{hq}/photos', f'{hq}/studio', f'{hq}/runs/7', f'{voice}/calls', f'{voice}/claude/projects', memory, f'{seats}/claude-1', f'{s3}/{backup.BUCKET}'):
    os.makedirs(d)
files = {f'{hq}/approvals/live:pebblet': b'{"request": 21}', f'{hq}/photos/1.jpg': os.urandom(40_000),
         f'{voice}/calls/28.jsonl': b'{"who":"board","text":"hello"}\n' * 500, f'{voice}/claude/projects/s.jsonl': os.urandom(3000),
         f'{memory}/MEMORY.md': b'# Memory index\n', f'{memory}/live_state_access.md': b'---\nname: x\n---\n',
         f'{seats}/claude-1/.credentials.json': b'{"seat": "never in a backup"}', f'{hq}/secrets/SAMPLE_DROP_STREET': b'Nowhere Lane 1',
         f'{hq}/photos/9.jpg': b'left out', f'{hq}/runs/7/bundle.tar.gz': b'a job tree a lent machine runs'}
# The big files (BIG_FILE_BYTES and up): each content once in the bucket, as its own object, whatever path it's at
BIG = b'take one ' + os.urandom(200_000)
files.update({f'{hq}/studio/take.webm': BIG, f'{hq}/photos/again.webm': BIG, f'{hq}/photos/2.jpg': b'photo two ' + os.urandom(100_000)})
for p, b in files.items():
    open(p, 'wb').write(b)
os.symlink('/etc/passwd', f'{hq}/photos/planted')   # a container's symlink: stored as a link, never read through
os.makedirs(f'{hq}/mail/15')
os.symlink('/etc/passwd', f'{hq}/mail/15/0')   # a mail's file that is a link: never read through
# The worker's store of renders (the work volume's renders/, by sha256): a film and a track, and its temp file mid-write
store = f'{tmp}/work/{backup.RENDERS}'
os.makedirs(store)
RENDERS = {hashlib.sha256(b).hexdigest(): b for b in (b'\x00\x00\x00\x18ftypmp42 trailer ' + os.urandom(300_000), b'RIFF\x00\x00\x00\x00WAVE score ' + os.urandom(50_000))}
for sha, b in RENDERS.items():
    open(f'{store}/{sha}', 'wb').write(b)
open(f'{store}/.a1b2c3', 'wb').write(b'half a render')
# A product's data volume, as a product keeps it: a live database in WAL mode, and in backup/ a finished copy (SQLite's
# backup API, as the product makes it) and the next one still being written. Another product keeps no copies.
products = f'{tmp}/products'
product_volume = f'{products}/pebblet'
os.makedirs(f'{product_volume}/planets')
os.makedirs(f'{product_volume}/backup')
os.makedirs(f'{products}/sprout')
live = sqlite3.connect(f'{product_volume}/planets/x.db')
live.executescript("pragma journal_mode = wal; create table events (tick integer, what text);")
live.executemany('insert into events values (?, ?)', [(i, f'creature {i} drank' * 3) for i in range(4000)])
live.commit()
copy = sqlite3.connect(f'{product_volume}/backup/x.db.part')
live.backup(copy)
copy.close()
os.rename(f'{product_volume}/backup/x.db.part', f'{product_volume}/backup/x.db')
open(f'{product_volume}/backup/x.db.part', 'wb').write(b'SQLite format 3\x00 half a copy')
for suffix in ('-journal', '-wal', '-shm'):
    open(f'{product_volume}/backup/x.db.part{suffix}', 'wb').write(b'half a copy')
PRODUCT_COPY = open(f'{product_volume}/backup/x.db', 'rb').read()

docker_bin = f'{tmp}/docker-bin'
preview_volume = f'{tmp}/preview'
os.makedirs(docker_bin)
os.makedirs(f'{preview_volume}/backup')
open(f'{preview_volume}/backup/preview.db', 'wb').write(b'preview only')
docker_volumes = {'infra_product-pebblet-data': product_volume, 'infra_preview-pebblet-data': preview_volume,
                  'infra_hqdata': hq, 'other_product-x-data': preview_volume, 'infra_product-x-data-old': preview_volume}
open(f'{docker_bin}/docker', 'w').write(f"""#!/usr/bin/env python3
import sys
volumes = {docker_volumes!r}
if sys.argv[1:3] == ['volume', 'ls']:
    print('\\n'.join(volumes))
elif sys.argv[1:3] == ['volume', 'inspect']:
    print(volumes[sys.argv[-1]])
else:
    sys.exit(1)
""")
os.chmod(f'{docker_bin}/docker', 0o700)

port = (lambda s: (s.bind(('127.0.0.1', 0)), s.getsockname()[1], s.close())[1])(socket.socket())
KEY_ID, SECRET = 'ab' * 16, 'cd' * 32
gw = subprocess.Popen([VGW, '--access', KEY_ID, '--secret', SECRET, '--region', 'auto', '--port', f'127.0.0.1:{port}', 'posix', s3],
                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for _ in range(100):
    with contextlib.suppress(OSError), socket.create_connection(('127.0.0.1', port), 0.2):
        break
    time.sleep(0.1)
backup.KEYS['BACKUP_R2_ENDPOINT'] = rf'http://127\.0\.0\.1:{port}(/{backup.BUCKET})?'   # the only change: a local endpoint

ident = subprocess.run(['age-keygen'], capture_output=True, text=True).stdout
secret_key = next(l for l in ident.splitlines() if l.startswith('AGE-SECRET-KEY-'))
public_key = subprocess.run(['age-keygen', '-y'], input=secret_key, capture_output=True, text=True).stdout.strip()
KEYS = {'BACKUP_R2_ENDPOINT': f'http://127.0.0.1:{port}', 'BACKUP_R2_ACCESS_KEY_ID': KEY_ID,
        'BACKUP_R2_SECRET_ACCESS_KEY': SECRET, 'BACKUP_AGE_RECIPIENT': public_key}

db = f'{hq}/hq.db'
con = sqlite3.connect(db)
con.executescript("""pragma journal_mode = wal;
  create table jobs (id integer primary key, title text, prompt text);
  create table calls (id integer primary key, lines text);
  create table settings (key text primary key, value text);
  create table a (x); insert into a values (1);
  create table "a"" union select 424242 order by 1 desc --" (y);
  create virtual table search using fts5(body);
  create table memory (id integer primary key, doc text, body text, vec blob); create table memory_docs (doc text primary key, hash text);
  create virtual table memory_fts using fts5(title, body); create virtual table memory_vocab using fts5vocab(memory_fts, 'row');""")
# The search index (memory.ts), as big as the jobs: the copy leaves it out, the coordinator makes it again
con.executemany('insert into memory (doc, body, vec) values (?, ?, ?)', [(f'job:{i}', 'chunk ' * 50, os.urandom(1536)) for i in range(5000)])
con.executemany('insert into memory_fts (title, body) values (?, ?)', [(f'job {i}', 'chunk words ' * 30) for i in range(5000)])
con.executemany('insert into jobs (title, prompt) values (?, ?)', [(f'job {i}', 'x' * 2000) for i in range(3000)])
# The company inbox (mail.ts): an invoice with its raw message and two files, an agreement HQ kept no raw copy of (one of
# its files only by name), a customer's mail, a 9-year-old invoice, and an attachment that's a planted symlink.
con.execute("""create table mail (id integer primary key, received text not null, sender text, recipient text, subject text, body text,
  attachments text, size integer, raw blob, audio text, keep text)""")
ago = lambda days: (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=days)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
INVOICE_PDF, DPA_PDF, RAW = b'%PDF-1.7 Print API invoice 2026-10-0412 ' + os.urandom(3000), b'%PDF-1.7 signed DPA ' + os.urandom(5000), b'From: billing@printapi.example\r\nSubject: Factuur\r\n\r\nraw invoice mail ' + os.urandom(2000)
MAIL = [(11, ago(2), 'billing@printapi.example', 'invoices@company.test', 'Factuur 2026-10-0412',
         [{'name': 'Factuur 2026-10-0412.pdf', 'type': 'application/pdf', 'size': len(INVOICE_PDF)}, {'name': '../../specificatie.csv', 'type': 'text/csv', 'size': 9}], RAW, 'invoices'),
        (12, ago(30), 'board@example.com', 'documents@company.test', 'Signed DPA', [{'name': 'DPA signed.pdf', 'type': 'application/pdf', 'size': len(DPA_PDF)}, 'too-big.pdf'], None, 'documents'),
        (13, ago(1), 'jane@example.com', 'hello@company.test', 'My poster', [{'name': 'bent.jpg', 'type': 'image/jpeg', 'size': 5}], b'raw customer mail', None),
        (14, ago(9 * 365.25), 'billing@printapi.example', 'invoices@company.test', 'Factuur 2017', [], b'old', 'invoices'),
        (15, ago(3), 'x@example.com', 'invoices@company.test', 'Planted', [{'name': 'passwd', 'type': 'text/plain', 'size': 1}], None, 'invoices')]
for mid, received, sender, to, subject, atts, raw, keep in MAIL:
    con.execute('insert into mail (id, received, sender, recipient, subject, body, attachments, size, raw, keep) values (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
                (mid, received, sender, to, subject, 'body', json.dumps(atts), raw, keep))
MAIL_FILES = {f'{hq}/mail/11/0': INVOICE_PDF, f'{hq}/mail/11/1': b'line;1;2\n', f'{hq}/mail/12/0': DPA_PDF, f'{hq}/mail/13/0': b'\xff\xd8\xffjp'}
con.execute("insert into calls (lines) values ('the board: hello')")
for p, b in MAIL_FILES.items():
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, 'wb').write(b)
con.commit()
con.close()
# The coordinator's side: a writer adding jobs the whole time (each row carries a running number, so a torn copy shows).
WRITER = r"""
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[1]); db.exec('pragma busy_timeout = 5000');
const ins = db.prepare('insert into jobs (title, prompt) values (?, ?)');
for (let i = 0; ; i++) { db.exec('begin'); ins.run(`live ${i}`, 'y'.repeat(2000)); ins.run(`live ${i} b`, 'y'.repeat(2000)); db.exec('commit');
  if (i % 50 === 0) await new Promise(r => setTimeout(r, 1)); }
"""
# GitHub's stand-in: branches, an annotated tag, a file big enough that a full bundle and a night's bundle differ.
gh = f'{tmp}/github.git'
GIT_ENV = {**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t', 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@t',
           'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1'}
def g(*args, cwd=None):
    return subprocess.run(['git', *args], cwd=cwd, env=GIT_ENV, capture_output=True, text=True, errors='surrogateescape', check=True).stdout.strip()
g('init', '-q', '--bare', '-b', 'main', gh)
wt = f'{tmp}/github-work'
g('clone', '-q', gh, wt)
def commit(msg, files, branch='main'):
    for n, b in files.items():
        open(f'{wt}/{n}', 'wb').write(b)
    g('add', '-A', cwd=wt)
    g('commit', '-q', '-m', msg, cwd=wt)
    g('push', '-q', 'origin', f'HEAD:refs/heads/{branch}', cwd=wt)
g('checkout', '-q', '-b', 'main', cwd=wt)
commit('first: the company', {'CHARTER.md': b'# Charter\n', 'film.mp4': os.urandom(400_000)})
commit('job 1', {'job1.txt': b'one\n'}, 'job/1')
g('tag', '-a', 'v1', '-m', 'first', cwd=wt)
g('push', '-q', 'origin', 'v1', cwd=wt)
def github_refs():
    return dict(reversed(l.split(' ', 1)) for l in g('--git-dir', gh, 'for-each-ref', '--format=%(objectname) %(refname)').splitlines())

opts = {'hqdata': hq, 'voice': voice, 'seats': seats, 'state': state, 'local_db': db, 'github': gh, 'worker_work': f'{tmp}/work', 'products': products}

def status_file():
    return json.load(open(f'{state}/status.json'))

def restore_repo(dest, paths, key=secret_key):
    stdin = sys.stdin
    sys.stdin = io.StringIO(key + '\n')
    try:
        with contextlib.redirect_stdout(io.StringIO()) as out:
            try:
                ok = backup.restore_repo(dest, paths)
            except backup.Stop as e:
                return False, str(e)
        return ok, json.loads(out.getvalue())
    finally:
        sys.stdin = stdin

def fetch(key):
    path = f'{tmp}/fetched-{len(os.listdir(tmp))}.age'
    with r2.request('GET', key, stream=True) as res, open(path, 'wb') as f:
        shutil.copyfileobj(res, f)
    return path

def restored_matches(rep, dest):
    """A plain clone of the restored repo: its checkout is GitHub's main, and every branch and tag is GitHub's."""
    g('clone', '-q', f'{dest}/repo.git', f'{dest}/checkout')
    return (rep['main_matches_github'] and g('rev-parse', 'HEAD', cwd=f'{dest}/checkout') == github_refs()['refs/heads/main']
            and dict(reversed(l.split(' ', 1)) for l in g('--git-dir', f'{dest}/repo.git', 'for-each-ref', '--format=%(objectname) %(refname)').splitlines()) == github_refs())

def restore(path, dest, fetched=None, key=secret_key):
    return drill(backup.restore, path, dest, *([fetched] if fetched else []), key=key)

def fetch_objects(dest, *prefixes):
    """backup.py fetch, as the board would run it: the R2 keys in the environment."""
    env = {'BACKUP_R2_ENDPOINT': KEYS['BACKUP_R2_ENDPOINT'], 'BACKUP_R2_ACCESS_KEY_ID': KEY_ID, 'BACKUP_R2_SECRET_ACCESS_KEY': SECRET}
    with patch.dict(os.environ, env), contextlib.redirect_stdout(io.StringIO()) as out:
        backup.fetch(dest, list(prefixes))
    return json.loads(out.getvalue())

def restore_renders(dest, paths, key=secret_key):
    return drill(backup.restore_renders, dest, paths, key=key)

def restore_records(dest, paths, key=secret_key):
    return drill(backup.restore_records, dest, paths, key=key)

def drill(restore_fn, *args, key=secret_key):
    stdin = sys.stdin
    sys.stdin = io.StringIO(key + '\n')
    try:
        with contextlib.redirect_stdout(io.StringIO()) as out:
            try:
                ok = restore_fn(*args)
            except backup.Stop as e:
                return False, str(e)
        return ok, json.loads(out.getvalue())
    finally:
        sys.stdin = stdin

try:
    # ---- nothing before the board's keys are in
    st = backup.run(dict(opts))
    check(st['state'] == 'waiting for the board' and 'BACKUP_R2_ENDPOINT' in st['error'], 'no keys: waits for the board, runs nothing')
    for k, v in KEYS.items():
        open(f'{hq}/secrets/{k}', 'w').write(v + '\n')

    # ---- a wrong token: the night fails, no plaintext left, the key never shown
    open(f'{hq}/secrets/BACKUP_R2_SECRET_ACCESS_KEY', 'w').write('ef' * 32)
    st = backup.run(dict(opts))
    text = open(f'{state}/status.json').read() + open(f'{hq}/backup-status.json').read()
    check(st['state'] == 'failed' and 'R2 said 403' in st['error'], f'wrong token: fails with R2\'s answer ({st["error"]})')
    check(st['config_error'] is True and json.load(open(f'{hq}/backup-status.json'))['config_error'] is True, 'wrong token: a configuration error, for backup.ts')
    check('ef' * 32 not in text and SECRET not in text and not os.path.exists(f'{state}/work'), 'wrong token: no key in the status, no plaintext left')
    open(f'{hq}/secrets/BACKUP_R2_SECRET_ACCESS_KEY', 'w').write(SECRET)
    open(f'{hq}/secrets/BACKUP_AGE_RECIPIENT', 'w').write('age1notakey')
    st = backup.run(dict(opts))
    check(st['state'] == 'failed' and 'age1notakey' not in json.dumps(st) and 'BACKUP_AGE_RECIPIENT' in st['error'], 'a malformed key: named, never shown')
    open(f'{hq}/secrets/BACKUP_AGE_RECIPIENT', 'w').write(public_key)
    # a skipped BACKUP_LEFT_OUT line stops the night rather than leave nothing out
    backup.SKIPPED.add('BACKUP_LEFT_OUT')
    try:
        st = backup.run(dict(opts))
    finally:
        backup.SKIPPED.discard('BACKUP_LEFT_OUT')
    check(st['state'] == 'failed' and 'BACKUP_LEFT_OUT' in st['error'] and not os.listdir(f'{s3}/{backup.BUCKET}'),
          f"a skipped BACKUP_LEFT_OUT line: the night fails, nothing uploaded ({st['error']})")
    check(st['config_error'] is None, 'a failure of our own is no configuration error of R2\'s')

    # ---- the night, with the database being written throughout
    before = sqlite3.connect(db).execute('select count(*) from jobs').fetchone()[0]
    writer = subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', WRITER, db])
    time.sleep(0.5)
    umask = os.umask(0o077)  # as infra/backup.service runs it
    path_before = os.environ['PATH']
    os.environ['PATH'] = docker_bin + os.pathsep + path_before
    try:
        st = backup.run(dict(opts, products=None))
    finally:
        os.environ['PATH'] = path_before
        os.umask(umask)
    time.sleep(0.3)
    writer.kill()
    writer.wait()
    after = sqlite3.connect(db).execute('select count(*) from jobs').fetchone()[0]
    check(st['state'] == 'ok' and st['ok_key'].startswith('daily/'), f'the night: ok ({st.get("ok_key")}, {st.get("ok_bytes")} bytes, {st.get("ok_seconds")} s)')
    check(after > before + 100, f'the writer kept writing throughout ({before} → {after} jobs)')
    shared = json.load(open(f'{hq}/backup-status.json'))
    check(shared == status_file() and oct(os.stat(f'{hq}/backup-status.json').st_mode & 0o777) == '0o644', 'status left for the coordinator, readable')
    check(st['bucket_daily'] == 1 and st['bucket_monthly'] == 1, 'one daily and one monthly copy in the bucket')
    check(not os.path.exists(f'{state}/work'), 'no plaintext left on the server')
    parts, counted = st['ok_parts'], sum(p['bytes'] for p in st['ok_parts'].values())
    check(0 < st['ok_bytes'] - counted < 0.001 * st['ok_bytes'] + 500, f"the parts add up to the archive, age's few bytes aside ({counted} of {st['ok_bytes']})")
    check(parts['database']['raw'] == st['ok_db_bytes'] and parts['hq/data/photos'] == {**parts['hq/data/photos'], 'files': 1, 'raw': 40_000}
          and {'voice/calls', 'voice/claude', 'memory', 'hq/data/secrets'} <= set(parts) and 'hq/data/runs' not in parts,
          f'each part: the database, each folder of the data volume, the voice line, the memory ({sorted(parts)})')
    check(max(st['ok_tables'], key=st['ok_tables'].get) == 'jobs' and 0 < len(st['ok_tables']) <= 10, f"the database's biggest tables ({st['ok_tables']})")

    # ---- the 7-year records: each mail to invoices@ and documents@ as its own object, once
    r2 = backup.R2(KEYS['BACKUP_R2_ENDPOINT'], KEY_ID, SECRET)
    records = sorted(k for k in r2.listing() if k.startswith('records/'))
    want = sorted(backup.record_key(MAIL[i][7], MAIL[i][1], MAIL[i][0]) for i in (0, 1, 4))
    check(records == want, f'the records: invoices@ and documents@ mail, each its own object; no customer mail, no invoice past 8 years ({records})')
    check(st['records_pending'] == 0 and st['records_since'] is None and st['records_ok_at'] == st['tried_at'] and st['bucket_records'] == 3
          and st['records_error'] is None and st['warn'] is None, 'the records: nothing left due, no heads-up (a 30-day-old agreement isn\'t overdue on the first night)')
    rec = [fetch(k) for k in want]
    blobs = b''.join(open(r, 'rb').read() for r in rec)
    check(all(open(r, 'rb').read().startswith(b'age-encryption.org/v1') for r in rec) and b'Factuur' not in blobs and b'Print API invoice' not in blobs,
          'the records in R2 are age ciphertext only')
    ok, got_rec = restore_records(f'{tmp}/records1', rec)
    by = {r['mail']: r for r in got_rec} if ok else {}
    inv = f'{tmp}/records1/{backup.record_name("invoices", MAIL[0][1], 11)}'
    check(ok and open(f'{inv}/message.eml', 'rb').read() == RAW and open(f'{inv}/attachments/0-Factuur-2026-10-0412.pdf', 'rb').read() == INVOICE_PDF
          and open(f'{inv}/attachments/1-specificatie.csv', 'rb').read() == b'line;1;2\n' and by[11]['from'] == 'billing@printapi.example'
          and by[11]['subject'] == 'Factuur 2026-10-0412', 'restore-records: the invoice\'s raw message and files byte for byte, with who sent it and when')
    doc = f'{tmp}/records1/{backup.record_name("documents", MAIL[1][1], 12)}'
    check(ok and not by[12]['raw'] and by[12]['not_stored'] == ['too-big.pdf'] and open(f'{doc}/attachments/0-DPA-signed.pdf', 'rb').read() == DPA_PDF
          and 'raw_missing' in json.load(open(f'{doc}/mail.json')), 'restore-records: an agreement without a raw copy says so, and names the file HQ kept by name only')
    check(ok and by[15]['not_stored'] == ['passwd'] and not os.path.exists(f'{tmp}/records1/{backup.record_name("invoices", MAIL[4][1], 15)}/attachments'),
          'a mail\'s file that is a symlink is never read through')
    ok, why = restore_records(f'{tmp}/records2', rec[:1], key=subprocess.run(['age-keygen'], capture_output=True, text=True).stdout)
    check(not ok and 'wrong key' in why, "another private key can't open a record")
    mts = open(os.path.join(here, '..', 'platform/coordinator/src/mail.ts')).read()
    check(f'INVOICE_DAYS = {backup.INVOICE_DAYS}' in mts, f"backup.py's INVOICE_DAYS is mail.ts's ({backup.INVOICE_DAYS})")

    # ---- the renders: each film and track in the worker's store as its own object, once
    renders = sorted(k for k in r2.listing() if k.startswith('renders/'))
    check(renders == sorted(backup.render_key(sha) for sha in RENDERS) and st['bucket_renders'] == 2 and st['renders_pending'] == 0
          and st['renders_ok_at'] == st['tried_at'] and st['renders_error'] is None, f'the renders: each its own object, a temp file left out ({renders})')
    ren = [fetch(k) for k in renders]
    check(all(open(r, 'rb').read().startswith(b'age-encryption.org/v1') and b'trailer' not in open(r, 'rb').read() for r in ren),
          'the renders in R2 are age ciphertext only')
    ok, rep = restore_renders(f'{tmp}/renders1', ren)
    check(ok and sorted(os.listdir(f'{tmp}/renders1')) == sorted(RENDERS) and all(open(f'{tmp}/renders1/{sha}', 'rb').read() == b for sha, b in RENDERS.items()),
          f'restore-renders: a store renders.py reads, each named by its sha256, byte for byte ({rep})')
    os.rename(ren[0], f'{tmp}/{renders[1][len("renders/"):]}')
    ok, rep = restore_renders(f'{tmp}/renders2', [f'{tmp}/{renders[1][len("renders/"):]}'])
    check(not ok and len(rep['problems']) == 1, "restore-renders: a copy that isn't the render its name says is named")
    ok, why = restore_renders(f'{tmp}/renders3', ren[1:], key=subprocess.run(['age-keygen'], capture_output=True, text=True).stdout)
    check(not ok and 'wrong key' in why, "another private key can't open a render")

    # ---- what R2 holds is ciphertext only
    r2 = backup.R2(KEYS['BACKUP_R2_ENDPOINT'], KEY_ID, SECRET)
    enc = f'{tmp}/fetched.age'
    with r2.request('GET', st['ok_key'], stream=True) as res, open(enc, 'wb') as f:
        shutil.copyfileobj(res, f)
    blob = open(enc, 'rb').read()
    check(blob.startswith(b'age-encryption.org/v1') and b'Memory index' not in blob and b'job 1' not in blob, 'R2 holds age ciphertext only')
    check(hashlib.sha256(blob).hexdigest() == st['ok_sha256'], 'fetched object matches the uploaded hash')
    try:   # a bucket that isn't there (made under another name, the endpoint pasted without it): R2's answer, named
        backup.R2(f'http://127.0.0.1:{port}/no-such-bucket', KEY_ID, SECRET).listing()
        check(False, 'a missing bucket stops the night')
    except Exception as e:
        check(isinstance(e, backup.Stop) and '404' in str(e) and 'the bucket no-such-bucket' in str(e), f'a missing bucket stops the night, named ({e!r})')

    # ---- the big files: each content once, its own object, ciphertext only; the archive names them.
    held = sorted(k for k in r2.listing() if k.startswith('big-files/'))
    want = sorted({backup.big_file_key(hashlib.sha256(files[f'{hq}/{n}']).hexdigest(), public_key) for n in ('studio/take.webm', 'photos/2.jpg')})
    check(held == want and st['bucket_big_files'] == 2 and st['ok_big_files'] == {'files': 3, 'raw': 2 * len(BIG) + len(files[f'{hq}/photos/2.jpg']), 'new': 2,
                                                                         'new_bytes': sum(os.path.getsize(f'{s3}/{backup.BUCKET}/{k}') for k in held)},
          f"big files: each content once in the bucket, the same one at two paths too ({st['ok_big_files']})")
    check(not {hashlib.sha256(files[f'{hq}/{n}']).hexdigest() for n in ('studio/take.webm', 'photos/2.jpg')} & {k[6:70] for k in held},
          "big files: the objects' names aren't the files' own sha256 (keyed with the board's public key)")
    check(all(BIG[:200] not in open(f'{s3}/{backup.BUCKET}/{k}', 'rb').read() and open(f'{s3}/{backup.BUCKET}/{k}', 'rb').read().startswith(b'age-encryption.org/v1')
              for k in held), 'big files: age ciphertext only')
    check(st['ok_big_files']['raw'] > parts['hq/data/photos']['raw'] and parts['hq/data/studio']['raw'] == 0, "the parts are the archive's own: the big files aren't in them")

    # ---- the restore drill, into scratch: the archive, and the big files it names fetched from the bucket
    scratch = f'{tmp}/scratch[1]'
    ok, rep = restore(enc, f'{tmp}/scratch-unfetched')
    check(not ok and rep['problems'] == ['3 of the 3 big files it names not fetched: give the folder backup.py fetch put big-files/ in'],
          f"restore without the big files: named ({rep['problems']})")
    fetched = f'{tmp}/fetched-objects'
    got = fetch_objects(fetched, 'big-files/')
    check(got == {'objects': 2, 'bytes': st['ok_big_files']['new_bytes']} and sorted(f'big-files/{n}' for n in os.listdir(f'{fetched}/big-files')) == held,
          f'fetch: the bucket\'s files/ objects, by their keys ({got})')
    ok, rep = restore(enc, scratch, fetched)
    check(ok and rep['problems'] == [] and rep['big_files'] == 3, f'restore: database opens, integrity ok, matches its manifest ({rep})')
    check(all(open(f'{scratch}/hq/data/{n}', 'rb').read() == files[f'{hq}/{n}'] and int(os.stat(f'{scratch}/hq/data/{n}').st_mtime) == int(os.stat(f'{hq}/{n}').st_mtime)
              for n in ('studio/take.webm', 'photos/again.webm', 'photos/2.jpg')), 'restore: the big files in their places, byte for byte, with their times')
    r = sqlite3.connect(f'file:{scratch}/hq/hq.db?mode=ro', uri=True)
    got = r.execute('select count(*) from jobs').fetchone()[0]
    check(before <= got <= after, f'restored jobs ({got}) lie between the counts before ({before}) and after ({after}) the run')
    ids = [x[0] for x in r.execute('select id from jobs order by id')]
    check(ids == list(range(1, got + 1)), 'restored rows are a prefix of the live table: no gap, no torn write')
    titles = [x[0] for x in r.execute("select title from jobs where title like 'live %' order by id")]
    check(len(titles) % 2 == 0, 'every live transaction is in whole (both rows or neither)')
    live = sqlite3.connect(db)
    check(all(live.execute('select title, prompt from jobs where id = ?', (i,)).fetchone() == r.execute('select title, prompt from jobs where id = ?', (i,)).fetchone()
              for i in (1, 1500, 3000, got)), 'restored rows equal the live ones')
    check(r.execute('select lines from calls').fetchall() == [('the board: hello',)], 'calls table restored')
    manifest = json.loads(subprocess.run(f'age -d -i - {enc} | tar xzOf - manifest.json', shell=True, input=secret_key, capture_output=True, text=True).stdout)
    check(not {'memory', 'memory_docs', 'memory_fts', 'memory_vocab'} & set(manifest['tables']) and 'memory' not in st['ok_tables']
          and r.execute("select count(*) from sqlite_schema where name like 'memory%'").fetchone()[0] == 0
          and sqlite3.connect(db).execute('select count(*) from memory').fetchone()[0] == 5000,
          'the search index is left out of the copy (the live one keeps it), and nothing of it is left in the file')
    check(manifest['tables'].get('a" union select 424242 order by 1 desc --') == 0 and manifest['tables'].get('a') == 1 and 'search' not in manifest['tables'],
          'a table name with SQL in it is counted as a name, not run; virtual tables are skipped')
    r.close()
    same = lambda a, b: open(a, 'rb').read() == open(b, 'rb').read()
    check(same(f'{scratch}/hq/data/secrets/BACKUP_R2_SECRET_ACCESS_KEY', f'{hq}/secrets/BACKUP_R2_SECRET_ACCESS_KEY'), "the board's keys restored")
    check(all(same(f'{scratch}/{dest}', src) for src, dest in [
        (f'{hq}/photos/1.jpg', 'hq/data/photos/1.jpg'), (f'{hq}/approvals/live:pebblet', 'hq/data/approvals/live:pebblet'),
        (f'{voice}/calls/28.jsonl', 'voice/calls/28.jsonl'), (f'{voice}/claude/projects/s.jsonl', 'voice/claude/projects/s.jsonl'),
        (f'{memory}/MEMORY.md', 'memory/MEMORY.md'), (f'{memory}/live_state_access.md', 'memory/live_state_access.md')]), 'photos, approvals, voice line, memory: byte for byte')
    listed = subprocess.run(f'age -d -i - {enc} | tar tvzf -', shell=True, input=secret_key, capture_output=True, text=True).stdout
    check('hq/data/photos/planted -> /etc/passwd' in listed and not os.path.exists(f'{scratch}/hq/data/photos/planted'), 'a planted symlink is stored as a link and not recreated')
    check(not any(n in listed for n in ('hq.db-wal', 'hq.db-shm', 'credentials', 'claude-1')) and 'hq/hq.db' in listed, 'no live db files, no seat logins; only the consistent copy')
    check('SAMPLE_DROP' not in listed and 'photos/9.jpg' not in listed and 'BACKUP_AGE_RECIPIENT' in listed and 'photos/1.jpg' in listed,
          "what the company's BACKUP_LEFT_OUT names is left out, the other keys and photos are in")
    check('hq/data/runs' not in listed, "the lent machines' runs are left out")
    check('take.webm' not in listed and 'photos/2.jpg' not in listed and 'photos/1.jpg' in listed, "the big files aren't in the night's archive, the small ones are")
    check(not os.path.exists(f'{scratch}/hq/data/hq.db'), 'the live hq.db was never copied as a file')
    names = subprocess.run(f'age -d -i - {enc} | tar tzf -', shell=True, input=secret_key, capture_output=True, text=True).stdout.split()
    check([n for n in names if n.startswith('products/') and not n.endswith('/')] == ['products/pebblet/x.db']
          and same(f'{scratch}/products/pebblet/x.db', f'{product_volume}/backup/x.db') and rep['product_dbs'] == 1
          and manifest['products'] == {'pebblet': {'files': 1, 'bytes': len(PRODUCT_COPY)}} and st['products_error'] is None,
          "Docker volumes: only the product's finished backup/ copy, checked in the drill; no preview, other project, .part or live database")

    # ---- the products' copies on their own, into a plain tar: each is staged whole before any of it goes in
    settings = {'12': True, '': False, '12x': False, '-3': False, '1.5': False}
    for value, included in settings.items():
        env_file = f'{tmp}/infra-{len(value)}-{value}.env'
        open(env_file, 'w').write(f'SERVER_NAME=t\nSERVER=t-1\nBACKUP_BUCKET=t\nBACKUP_PRODUCTS_MB={value}\n')
        probe = "import backup, io, json, sys, tarfile, tempfile; w = tempfile.TemporaryDirectory(); " \
                "t = tarfile.open(fileobj=io.BytesIO(), mode='w'); " \
                "print(json.dumps(backup.products_add(t, w.name, sys.argv[1])))"
        got = subprocess.run([sys.executable, '-c', probe, products], cwd=here,
                             env={**os.environ, 'INFRA_ENV': env_file}, capture_output=True, text=True)
        figures, left = json.loads(got.stdout.splitlines()[-1])
        check(('pebblet' in figures) == included and (left == [] if included else len(left) == 1 and 'BACKUP_PRODUCTS_MB' in left[0]),
              f'BACKUP_PRODUCTS_MB={value!r}: products included or the invalid setting named ({figures}, {left})')
    loose = f'{tmp}/loose'
    loose_work = f'{tmp}/loose-work'
    os.makedirs(loose_work)

    def loose_product(slug, size):
        os.makedirs(f'{loose}/{slug}/backup')
        body = os.urandom(size)
        open(f'{loose}/{slug}/backup/a.db', 'wb').write(body)
        return body

    def loose_add(room, local=loose):
        cap, backup.PRODUCTS_MAX_BYTES = backup.PRODUCTS_MAX_BYTES, room
        buffer = io.BytesIO()
        try:
            with tarfile.open(fileobj=buffer, mode='w') as tar:
                figures, left = backup.products_add(tar, loose_work, local)
        finally:
            backup.PRODUCTS_MAX_BYTES = cap
        buffer.seek(0)
        with tarfile.open(fileobj=buffer) as tar:
            members = {m.name: tar.extractfile(m).read() for m in tar if m.isreg()}
        return figures, left, members

    # A copy renamed into place just before the archive opens it must still fit.
    loose_product('swap', 8192)
    original_open = os.open

    def replaced_meanwhile(path, *args, **kwargs):
        if path == 'a.db':
            open(f'{loose}/swap/backup/a.db.part', 'wb').write(os.urandom(49152))
            os.replace(f'{loose}/swap/backup/a.db.part', f'{loose}/swap/backup/a.db')
        return original_open(path, *args, **kwargs)
    cap, backup.PRODUCTS_MAX_BYTES = backup.PRODUCTS_MAX_BYTES, 12000
    output = io.BytesIO()
    try:
        with patch('os.open', replaced_meanwhile), tarfile.open(fileobj=output, mode='w:gz') as tar:
            figures, left = backup.products_add(tar, loose_work, loose)
    finally:
        backup.PRODUCTS_MAX_BYTES = cap
    output.seek(0)
    with tarfile.open(fileobj=output) as tar:
        members = tar.getnames()
    check(members == [] and figures == {} and len(left) == 1 and 'allowance' in left[0] and len(output.getvalue()) <= 12000
          and os.path.getsize(f'{loose}/swap/backup/a.db') == 49152 and os.listdir(loose_work) == [],
          f'an oversized replacement before open is excluded whole ({figures}, {left})')
    shutil.rmtree(loose)

    # incompressible copies near the allowance: just under it goes, just over it is left out whole, and nothing is left staged
    under = loose_product('a-under', 200_000 - 4096)
    loose_product('b-over', 200_001)
    figures, left, members = loose_add(200_000)
    check(members == {'products/a-under/a.db': under} and len(left) == 1 and 'b-over' in left[0],
          f'an incompressible product just under the allowance goes, the next is left out ({left})')
    shutil.rmtree(f'{loose}/a-under')
    figures, left, members = loose_add(200_000)
    check(members == {} and figures == {} and len(left) == 1 and 'b-over' in left[0] and 'allowance' in left[0]
          and os.listdir(loose_work) == [], f'one just over it is left out whole, nothing staged left behind ({left})')
    shutil.rmtree(loose)

    # a read failing mid-way: that product is left out whole, the next one still goes
    loose_product('a-broken', 65536)
    fine = loose_product('b-fine', 1000)
    with failing_reads('a-broken'):
        figures, left, members = loose_add(1e6)
    check(members == {'products/b-fine/a.db': fine} and list(figures) == ['b-fine'] and left == ["a-broken's copies not read (OSError)"]
          and os.listdir(loose_work) == [], f'a read failing mid-way leaves that product out whole, the next one goes ({left})')
    os.makedirs(f'{loose}/b-fine/backup/gone')

    def gone_meanwhile(path, *args, **kwargs):
        if path == 'gone':
            raise FileNotFoundError(2, 'No such file or directory')
        return original_open(path, *args, **kwargs)
    with patch('os.open', gone_meanwhile):
        figures, left, members = loose_add(1e6)
    check(members.get('products/b-fine/a.db') == fine and set(figures) == {'a-broken', 'b-fine'} and left == [],
          f'a folder gone since it was listed: the rest of that product goes ({left})')
    figures, left, members = loose_add(None)
    check(members == {} and left == ["company/infra.env's BACKUP_PRODUCTS_MB isn't a whole number of MB"] * 2,
          f'no allowance set: no product goes, and the setting is named ({left})')

    # Docker failing at discovery: a volume that can't be inspected is named, the others go; no listing at all, none goes
    broken_bin = f'{tmp}/docker-broken'
    listing = f'{tmp}/docker-lists'   # Docker lists its volumes only once this is there
    os.makedirs(broken_bin)
    open(f'{broken_bin}/docker', 'w').write(f"""#!/usr/bin/env python3
import os, sys
volumes = {{'infra_product-ghost-data': None, 'infra_product-pebblet-data': {product_volume!r}}}
if sys.argv[1:3] == ['volume', 'ls'] and os.path.exists({listing!r}):
    print('\\n'.join(volumes))
elif sys.argv[1:3] == ['volume', 'inspect'] and volumes.get(sys.argv[-1]):
    print(volumes[sys.argv[-1]])
else:
    sys.exit(1)
""")
    os.chmod(f'{broken_bin}/docker', 0o700)
    path_before = os.environ['PATH']
    os.environ['PATH'] = broken_bin + os.pathsep + path_before
    try:
        figures, left, members = loose_add(1e6, None)
        open(listing, 'w').close()
        figures2, left2, members2 = loose_add(1e6, None)
    finally:
        os.environ['PATH'] = path_before
    check(members == {} and left == ["Docker's volumes not listed"], f"Docker's volumes not listed: no product goes, HQ's backup carries on ({left})")
    check(list(members2) == ['products/pebblet/x.db'] and left2 == ['Docker volume infra_product-ghost-data not found'],
          f"a volume Docker can't inspect is named, the others go ({left2})")
    shutil.rmtree(loose)

    ok, _ = restore(enc, f'{tmp}/scratch2', key=subprocess.run(['age-keygen'], capture_output=True, text=True).stdout)
    check(not ok, "another private key can't open it")
    ok, why = restore(enc, scratch)
    check(not ok and 'not empty' in why, 'restore refuses a folder that already has files')

    # ---- a second night: another daily, no second monthly
    time.sleep(1.1)
    # ---- the repo's first copy: a full bundle, ciphertext only, and a restore that clones from it
    check(st['repo_kind'] == 'full' and st['repo_error'] is None and st['bucket_repo'] == 1 and st['repo_head'] == github_refs()['refs/heads/main'],
          f'the repo: a full copy next to the backup ({st["repo_key"]}, {st["repo_bytes"]} bytes)')
    full = fetch(st['repo_key'])
    blob = open(full, 'rb').read()
    check(blob.startswith(b'age-encryption.org/v1') and b'Charter' not in blob and b'refs/heads' not in blob, "the repo's copy is age ciphertext only")
    ok, rep = restore_repo(f'{tmp}/repo1', [full])
    check(ok and restored_matches(rep, f'{tmp}/repo1') and rep['branches'] == 2 and rep['tags'] == 1,
          f"restore-repo: cloned from the bundle, main and every branch and tag match GitHub's ({rep})")

    # ---- GitHub moves on: a commit on main, a branch deleted, one added, a new tag; the next copy holds only what's new
    commit('second: more', {'NEW.md': b'new\n'})
    commit('job 2', {'job2.txt': b'two\n'}, 'job/2')
    g('push', '-q', 'origin', ':refs/heads/job/1', cwd=wt)
    g('tag', '-a', 'v2', '-m', 'second', cwd=wt)
    g('push', '-q', 'origin', 'v2', cwd=wt)
    time.sleep(1.1)
    time.sleep(1.1)
    st2 = backup.run(dict(opts))
    check(st2['state'] == 'ok' and st2['bucket_daily'] == 2 and st2['bucket_monthly'] == 1, 'second night: two dailies, still one monthly')
    check(st2['ok_big_files'] == {**st['ok_big_files'], 'new': 0, 'new_bytes': 0} and st2['bucket_big_files'] == 2, 'second night: the big files are named again, none uploaded twice')
    check(st2['repo_kind'] != 'full' and st2['repo_bytes'] < st['repo_bytes'] / 10 and st2['bucket_repo'] == 2,
          f"second night: the repo's copy holds only what's new ({st2['repo_bytes']} bytes, the full one {st['repo_bytes']})")
    second = fetch(st2['repo_key'])
    ok, rep = restore_repo(f'{tmp}/repo2', [second, full])
    check(ok and restored_matches(rep, f'{tmp}/repo2') and 'refs/heads/job/1' not in github_refs() and rep['chain'] == [st['repo_key'], st2['repo_key']],
          "restore-repo from the full copy and the night's: GitHub's branches and tags exactly, the deleted branch gone")
    ok, why = restore_repo(f'{tmp}/repo3', [second])
    check(not ok and st['repo_key'] in why, f'restore-repo without the full copy: names the one to download ({why})')
    ok, why = restore_repo(f'{tmp}/repo4', [second, full], key=subprocess.run(['age-keygen'], capture_output=True, text=True).stdout)
    check(not ok and 'wrong key' in why, "another private key can't open the repo's copy")

    gone = '0' * 39 + '1'
    check(backup.present(gh, {gone, github_refs()['refs/heads/main']}) == {github_refs()['refs/heads/main']}, "present(): a commit the repo doesn't hold isn't counted")

    # ---- a night without changes: a copy with no bundle, and the chain still restores
    time.sleep(1.1)
    st5 = backup.run(dict(opts))
    third = fetch(st5['repo_key'])
    ok, rep = restore_repo(f'{tmp}/repo5', [full, second, third])
    meta = json.loads(subprocess.run(f'age -d -i - {third} | tar xOf - repo.json', shell=True, input=secret_key, capture_output=True, text=True).stdout)
    check(st5['state'] == 'ok' and meta['bundle'] is False and meta['base'] == st2['repo_key'] and ok and restored_matches(rep, f'{tmp}/repo5'),
          'a night without changes: a copy with no bundle, and the chain still restores')

    # ---- GitHub doesn't answer: the night is still good, the copy is the mirror's; the board hears once it's been too long
    os.rename(gh, f'{gh}.away')
    time.sleep(1.1)
    st6 = backup.run(dict(opts))
    check(st6['state'] == 'ok' and st6['repo_error'].startswith('GitHub:') and st6['repo_key'] != st5['repo_key']
          and st6['repo_fetched_at'] == st5['tried_at'] and st6['warn'] is None, f"GitHub unreachable: the night is ok, the repo copied from the mirror ({st6['repo_error']})")
    os.rename(f'{gh}.away', gh)
    at = lambda h: (datetime.datetime(2026, 10, 1, 12, tzinfo=datetime.timezone.utc) - datetime.timedelta(hours=h)).isoformat(timespec='seconds')
    later = datetime.datetime(2026, 10, 1, 12, tzinfo=datetime.timezone.utc)
    warns = [backup.repo_warn({'repo_ok_at': at(0), 'repo_fetched_at': at(h)}, later) for h in (24, 37)]
    warns += [backup.repo_warn({'repo_ok_at': at(40), 'repo_fetched_at': at(40)}, later), backup.repo_warn({}, later)]
    warns += [backup.repo_warn({'repo_since': at(h)}, later) for h in (10, 37)]
    check(warns == [None, "the repo's copy is GitHub's as of 2026-09-29 23:00 UTC: fetching from GitHub has failed since",
                    'no copy of the repo since 2026-09-29 20:00 UTC', 'no copy of the repo yet', None, 'no copy of the repo yet'],
          f'heads-ups: none for a day without GitHub, then one; a first try that fails waits the 36 hours too ({warns})')

    # ---- every REPO_FULL_DAYS a new full copy starts the chain again
    days = backup.REPO_FULL_DAYS
    backup.REPO_FULL_DAYS = 0
    try:
        time.sleep(1.1)
        st8 = backup.run(dict(opts))
    finally:
        backup.REPO_FULL_DAYS = days
    ok, rep = restore_repo(f'{tmp}/repo8', [fetch(st8['repo_key'])])
    check(st8['repo_kind'] == 'full' and ok and restored_matches(rep, f'{tmp}/repo8'), 'after REPO_FULL_DAYS: a full copy again, restorable on its own')

    # ---- a branch whose name isn't UTF-8 (git allows it): still copied and restored, the night still good
    odd = 'refs/heads/caf' + b'\xe9'.decode('utf-8', 'surrogateescape')
    g('--git-dir', gh, 'update-ref', odd, github_refs()['refs/heads/main'])
    time.sleep(1.1)
    full8 = fetch(st8['repo_key'])
    st8 = backup.run(dict(opts))
    ok, rep = restore_repo(f'{tmp}/repo8b', [full8, fetch(st8['repo_key'])])
    check(st8['state'] == 'ok' and st8['repo_error'] is None and odd in github_refs() and ok and restored_matches(rep, f'{tmp}/repo8b'),
          f"a branch name that isn't UTF-8: copied and restored ({st8['repo_error']})")

    # ---- the repo would take the bucket past the free tier, the database's backup wouldn't: only the database goes
    free, backup.FREE_BYTES, backup.REPO_FULL_DAYS = backup.FREE_BYTES, st8['bucket_bytes'] + st8['ok_bytes'] * 1.1, 0   # a full repo copy: 400 kB
    old = status_file()   # ... and no good repo copy for 40 hours: the bucket's heads-up mustn't hide the repo's
    old['repo_ok_at'] = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=40)).isoformat(timespec='seconds')
    json.dump(old, open(f'{state}/status.json', 'w'))
    try:
        time.sleep(1.1)
        st9 = backup.run(dict(opts))
    finally:
        backup.FREE_BYTES, backup.REPO_FULL_DAYS = free, days
    check(st9['state'] == 'ok' and 'not uploaded' in st9['repo_error'] and st9['repo_key'] == st8['repo_key'] and st9['ok_key'] != st8['ok_key'],
          f"the repo past the free tier: the database's backup still goes, the repo's doesn't ({st9['repo_error']})")
    check(st9['warn'].startswith('the bucket is past 8 GB') and 'no copy of the repo since' in st9['warn'],
          f"the bucket near the free tier and the repo 40 hours stale: the board hears both ({st9['warn']})")

    # ---- the repo's copy leaves room for a month of database backups with nothing expiring (versitygw has no lifecycle
    # rules, and neither does a bucket in its first 30 days): the bucket filled to the repo's limit tonight, every night
    # after still gets its backup (room kept for one night only would lose the fourth night's)
    backup.REPO_FULL_DAYS = 0
    try:
        time.sleep(1.1)
        st10 = backup.run(dict(opts))   # a full copy, uploaded: its size is the one the next full copies will have
        reserve = backup.REPO_RESERVE * backup.NEXT_NIGHT * st10['ok_bytes']
        free, backup.FREE_BYTES = backup.FREE_BYTES, st10['bucket_bytes'] + 1.2 * st10['ok_bytes'] + st10['repo_bytes'] + reserve
        try:
            time.sleep(1.1)
            st11 = backup.run(dict(opts))   # tonight's backup and a repo copy just fit, with the reserve
            nights = []
            for _ in range(backup.REPO_RESERVE):
                time.sleep(1.1)
                nights.append(backup.run(dict(opts)))
        finally:
            backup.FREE_BYTES = free
    finally:
        backup.REPO_FULL_DAYS = days
    check(st10['state'] == 'ok' and st10['repo_key'] != st9['repo_key'] and st11['state'] == 'ok' and st11['repo_key'] != st10['repo_key']
          and st11['repo_error'] is None, "the repo's copy that leaves exactly the reserve goes up")
    check(all(n['state'] == 'ok' and n['repo_key'] == st11['repo_key'] and 'next month' in n['repo_error'] for n in nights)
          and len({n['ok_key'] for n in nights}) == len(nights) and nights[-1]['bucket_daily'] == st11['bucket_daily'] + len(nights),
          f"... then {len(nights)} nights with nothing expiring: every one gets its database backup, none a repo copy "
          f"({[n.get('error') for n in nights if n['state'] != 'ok'] or nights[-1]['repo_error']})")
    st12 = nights[-1]
    st2 = st12   # the free-tier and memory checks below build on the latest good night

    # ---- a branch or an annotated tag deleted and one nested under its name made between copies (topic -> topic/child,
    # release -> release/child, and back): restores (the fetch must not auto-follow the new tag into refs/tags/)
    main_sha = github_refs()['refs/heads/main']
    def make(ref):
        if ref.startswith('refs/tags/'):
            g('--git-dir', gh, 'tag', '-a', '-m', ref, ref[len('refs/tags/'):], main_sha)
        else:
            g('--git-dir', gh, 'update-ref', ref, main_sha)
    for old, new in [(f'{kind}/{a}', f'{kind}/{b}') for kind, name in (('refs/heads', 'topic'), ('refs/tags', 'release'))
                     for a, b in ((name, f'{name}/child'), (f'{name}/child', name))]:
        make(old)
        backup.REPO_FULL_DAYS = 0
        try:
            time.sleep(1.1)
            sta = backup.run(dict(opts))
        finally:
            backup.REPO_FULL_DAYS = days
        g('--git-dir', gh, 'update-ref', '-d', old)
        make(new)
        time.sleep(1.1)
        stb = backup.run(dict(opts))
        dest = f'{tmp}/repo-{new.replace("/", "-")}'
        ok, rep = restore_repo(dest, [fetch(sta['repo_key']), fetch(stb['repo_key'])])
        check(sta['repo_kind'] == 'full' and stb['repo_kind'] != 'full' and ok and restored_matches(rep, dest)
              and new in github_refs() and old not in github_refs(),
              f'restore-repo: {old} deleted and {new} made between copies, every branch and tag as GitHub had it ({rep})')
        g('--git-dir', gh, 'update-ref', '-d', new)
    st2 = stb

    # ---- the repo's copy can't cost the night its database backup, whatever goes wrong with it:
    # a connection reset while reading back the repo's 0.6 GB object is not a Stop, and can't fail the whole night
    # after the database's backup is already in R2 (the board would hear "no off-site backup")
    fetch_hash = backup.R2.fetch_hash
    def reset(self, key):
        if key.endswith('.repo.tar.age'):
            raise ConnectionResetError(104, 'Connection reset by peer')
        return fetch_hash(self, key)
    g('--git-dir', gh, 'update-ref', 'refs/heads/reset', github_refs()['refs/heads/main'] + '^')
    backup.R2.fetch_hash = reset
    try:
        time.sleep(1.1)
        stx = backup.run(dict(opts))
    finally:
        backup.R2.fetch_hash = fetch_hash
    check(stx['state'] == 'ok' and stx['ok_key'] != st2['ok_key'] and stx['error'] is None and status_file()['ok_key'] == stx['ok_key']
          and 'ConnectionResetError' in (stx['repo_error'] or '') and stx['repo_key'] == st2['repo_key'],
          f"a reset reading back the repo's copy: the night is good, the repo's copy counts as not made ({stx.get('error') or stx['repo_error']})")
    time.sleep(1.1)
    stn = backup.run(dict(opts))   # the next night builds on the last copy that did read back
    ok, rep = restore_repo(f'{tmp}/repo-reset', [fetch(k) for k in (sta['repo_key'], stb['repo_key'], stn['repo_key'])])
    check(stn['state'] == 'ok' and stn['repo_error'] is None and rep['chain'][-2] == stb['repo_key'] and ok
          and restored_matches(rep, f'{tmp}/repo-reset'), '... and the next night builds on the last copy that read back, and restores')
    g('--git-dir', gh, 'update-ref', '-d', 'refs/heads/reset')

    # ---- the database's backup is in R2, and the status on disk says so, before the repo's work starts: git and a
    # 0.6 GB bundle take the night's longest minutes, and the unit being stopped then (TimeoutStartSec, a reboot) kills
    # the script without its finally, so anything the night hadn't saved yet is lost
    seen, repo_fetch = {}, backup.repo_fetch
    def watch(mirror, source):
        seen.update(listing=set(backup.R2(KEYS['BACKUP_R2_ENDPOINT'], KEY_ID, SECRET).listing()), status=status_file())
        return repo_fetch(mirror, source)
    backup.repo_fetch = watch
    try:
        time.sleep(1.1)
        stw = backup.run(dict(opts))
    finally:
        backup.repo_fetch = repo_fetch
    check(stw['state'] == 'ok' and stw['ok_key'] in seen.get('listing', ()) and seen['status']['state'] == 'ok'
          and seen['status']['ok_key'] == stw['ok_key'] and stw['repo_error'] is None,
          'when the repo\'s work starts, tonight\'s database backup is already in R2 and the status on disk says ok')
    listing, calls = backup.R2.listing, []
    def flaky(self):   # the bucket's listing after the uploads fails: the backup is in, the figures are last night's
        calls.append(1)
        if len(calls) > 1:
            raise backup.Stop('R2 said 503 to GET the bucket company-backups')
        return listing(self)
    backup.R2.listing = flaky
    try:
        time.sleep(1.1)
        stl = backup.run(dict(opts))
    finally:
        backup.R2.listing = listing
    check(stl['state'] == 'ok' and stl['ok_key'] != stw['ok_key'] and stl['bucket_bytes'] == stw['bucket_bytes'] and 'size not read' in stl['error']
          and stl['warn'] == stw['warn'] and 'in_progress' not in stl,
          f"the bucket's listing failing after the uploads: the night is still good ({stl['error']})")

    # ---- the unit stopped during the repo's work, every night (its 2-hour limit, the 04:00 reboot): no finally, nothing
    # after it runs. What the status on disk says then is a failed repo copy's, so the board still hears after 36 hours:
    # from the last good copy, or from the first try when there's never been one
    KILLED = r'''
import os, sys
sys.path.insert(0, sys.argv[1])
import backup
backup.KEYS['BACKUP_R2_ENDPOINT'] = sys.argv[2]
backup.repo_copy = lambda *a: os._exit(124)   # as SIGKILL would: the process ends where it stands
sys.exit(backup.main(['backup.py', 'run', *sys.argv[3:]]))
'''
    def killed_night(state_dir):
        args = [a for k, v in {**opts, 'state': state_dir}.items() for a in (f'--{k.replace("_", "-")}', v)]
        time.sleep(1.1)
        code = subprocess.run([sys.executable, '-c', KILLED, here, backup.KEYS['BACKUP_R2_ENDPOINT'], *args], capture_output=True).returncode
        s = json.load(open(f'{state_dir}/status.json'))
        check(code == 124 and s == json.load(open(f'{hq}/backup-status.json')), 'a stopped night: the status is on disk for backup.ts')
        # a day passes: every time in the status goes back 24 hours
        json.dump({k: (datetime.datetime.fromisoformat(v) - datetime.timedelta(days=1)).isoformat(timespec='seconds')
                   if k.endswith('_at') or k in ('repo_since', 'renders_since') else v for k, v in s.items()}, open(f'{state_dir}/status.json', 'w'))
        return s
    for first, state_k in ((True, f'{tmp}/state-first'), (False, f'{tmp}/state-stopped')):
        if not first:
            shutil.copytree(state, state_k)   # after a good night: a repo copy made just now
        got = [killed_night(state_k) for _ in range(3)]   # at 0, 24 and 48 hours
        good = not first and datetime.datetime.fromisoformat(stl['repo_ok_at']) - datetime.timedelta(days=2)   # two days back by the third
        want = f'no copy of the repo since {good:%Y-%m-%d %H:%M} UTC' if good else 'no copy of the repo yet'
        lead = None if first else stl['warn']   # the bucket's heads-up (versitygw keeps every copy), first as on a finished night
        renders_want = f"the renders haven't all been copied off the server since {(got[-1].get('renders_ok_at') or got[-1]['renders_since'])[:10]}"
        check(all(s['state'] == 'ok' and 'stopped mid-way' in s['repo_error'] and 'stopped mid-way' in s['renders_error'] and s['in_progress'] for s in got)
              and [s['repo_warn'] for s in got] == [None, None, want]
              and [s['warn'] for s in got] == [lead, lead, '; '.join(w for w in (lead, want, renders_want) if w)] and (first or 'lifecycle' in lead)
              and (not first or got[-1].get('repo_ok_at') is None),
              f"the repo's work stopped three nights running{' on a first-ever run' if first else ''}: the nights are good, "
              f"and the heads-up comes after 36 hours ({[s['warn'] for s in got]})")
    shutil.rmtree(f'{tmp}/state-first')
    shutil.rmtree(f'{tmp}/state-stopped')

    # ---- a new server whose first fetch fails (a bad token): the status keeps GitHub's reason, not a generic one
    time.sleep(1.1)
    stf = backup.run({**opts, 'state': f'{tmp}/state-new', 'github': f'{tmp}/nowhere.git'})
    check(stf['state'] == 'ok' and stf['repo_error'].startswith('GitHub:') and 'nowhere.git' in stf['repo_error'] and stf.get('repo_key') is None,
          f"a new server's first fetch failing: the night is good, and the repo's error is the fetch's ({stf['repo_error']})")
    shutil.rmtree(f'{tmp}/state-new')

    # a mail's id can come back (SQLite, once the newest row is deleted): the same id the same day later is another record
    reused = [backup.record_key('documents', t, 21) for t in ('2026-10-03T10:15:00.000Z', '2026-10-03T16:40:09.512Z')]
    check(reused[0] != reused[1] and reused[0] == 'records/documents/2026-10-03T101500-21.tar.gz.age'
          and backup.record_expired(backup.record_key('invoices', '2017-01-02T09:00:00.000Z', 21), datetime.datetime.now(datetime.timezone.utc)),
          f"a mail id reused the same day gets its own key, and an old invoice's still expires ({reused})")

    # ---- the renders, night after night: a new one goes, nothing twice; a planted link or a file that isn't its name is left
    # out and shown while the rest still go; past the cap they wait (and the board hears after 36 hours), then go with room
    r2 = backup.R2(KEYS['BACKUP_R2_ENDPOINT'], KEY_ID, SECRET)
    held = {k: v for k, v in r2.listing().items() if k.startswith('renders/')}
    new = os.urandom(20_000)
    NEW, LINK, WRONG = hashlib.sha256(new).hexdigest(), 'a' * 64, 'b' * 64
    open(f'{store}/{NEW}', 'wb').write(new)
    os.symlink(f'{hq}/secrets/BACKUP_R2_SECRET_ACCESS_KEY', f'{store}/{LINK}')
    open(f'{store}/{WRONG}', 'wb').write(b'not what its name says')
    oversized = f'{store}/' + 'c' * 64
    open(oversized, 'wb').close()
    os.truncate(oversized, backup.RENDER_MAX_BYTES + 1)
    time.sleep(1.1)
    sn = backup.run(dict(opts))
    now_held = {k: v for k, v in r2.listing().items() if k.startswith('renders/')}
    check(sn['state'] == 'ok' and all(now_held.get(k) == v for k, v in held.items()) and set(now_held) == {*held, backup.render_key(NEW)}
          and sn['renders_pending'] == 3 and sn['renders_ok_at'] != sn['tried_at'] and sn['renders_error'],
          f"the renders' next night: only the new one goes; a planted link, wrong file and oversized file are left out, shown ({sn['renders_error']})")
    os.remove(f'{store}/{LINK}')
    os.remove(f'{store}/{WRONG}')
    os.remove(oversized)
    open(f'{store}/{hashlib.sha256(big := os.urandom(30_000)).hexdigest()}', 'wb').write(big)
    limit = backup.RENDERS_MAX_BYTES
    backup.RENDERS_MAX_BYTES = sum(v[0] for v in now_held.values()) + len(big)
    try:
        time.sleep(1.1)
        sc = backup.run(dict(opts))
    finally:
        backup.RENDERS_MAX_BYTES = limit
    rw = [backup.renders_warn(sc, datetime.datetime.fromisoformat(sn['renders_ok_at']) + datetime.timedelta(hours=h)) for h in (35, 37)]
    check(sc['state'] == 'ok' and sc['ok_key'] != sn['ok_key'] and sc['renders_pending'] == 1 and 'not uploaded' in sc['renders_error']
          and rw[0] is None and rw[1] and sn['renders_ok_at'][:10] in rw[1],
          f"render ciphertext past its cap although plaintext fits: the night's backup still goes, the render waits, and the board hears after 36 hours ({rw[1]})")
    time.sleep(1.1)
    sd = backup.run(dict(opts))
    check(sd['state'] == 'ok' and sd['renders_pending'] == 0 and sd['renders_error'] is None and sd['renders_ok_at'] == sd['tried_at']
          and 'renders' not in (sd['warn'] or ''), 'with room again, the waiting render goes up the next night')

    # ---- a render that went up and didn't read back: the next still goes; it isn't due any more (the bucket lists it), so
    # it's read back the nights after, and waits until it matches
    def new_render(size=10_000):
        b = os.urandom(size)
        open(f'{store}/{(sha := hashlib.sha256(b).hexdigest())}', 'wb').write(b)
        return backup.render_key(sha)
    fetch_hash = backup.R2.fetch_hash
    unreadable_render_key, readable_render_key = sorted([new_render(), new_render()])
    def unreadable(self, key):   # the first of the two: the second still goes up that night
        return 'not what went up' if key == unreadable_render_key else fetch_hash(self, key)
    backup.R2.fetch_hash = unreadable
    try:
        time.sleep(1.1)
        unreadable_status = backup.run(dict(opts))
        time.sleep(1.1)
        still_unreadable_status = backup.run(dict(opts))   # R2 still answering wrong: still waiting
    finally:
        backup.R2.fetch_hash = fetch_hash
    time.sleep(1.1)
    verified_status = backup.run(dict(opts))
    check(unreadable_status['state'] == 'ok' and unreadable_render_key in r2.listing() and readable_render_key in r2.listing()
          and list(unreadable_status['renders_unverified']) == [unreadable_render_key] and unreadable_status['renders_pending'] == 1
          and unreadable_status['renders_ok_at'] == sd['renders_ok_at'] and 'read back' in unreadable_status['renders_error']
          and list(still_unreadable_status['renders_unverified']) == [unreadable_render_key]
          and still_unreadable_status['renders_pending'] == 1 and still_unreadable_status['renders_ok_at'] == sd['renders_ok_at']
          and verified_status['renders_unverified'] == {} and verified_status['renders_pending'] == 0
          and verified_status['renders_ok_at'] == verified_status['tried_at'] and verified_status['renders_error'] is None,
          f"a render that doesn't read back: the next still goes, and it waits, read again each night, until it matches ({unreadable_status['renders_error']})")

    # ... and the unit stopped between its upload and its read-back: the status on disk already names it
    STOPPED = r'''
import os, sys
sys.path.insert(0, sys.argv[1])
import backup
backup.KEYS['BACKUP_R2_ENDPOINT'] = sys.argv[2]
fetch_hash = backup.R2.fetch_hash
backup.R2.fetch_hash = lambda self, key: os._exit(124) if key.startswith('renders/') else fetch_hash(self, key)
sys.exit(backup.main(['backup.py', 'run', *sys.argv[3:]]))
'''
    interrupted_render_key = new_render()
    time.sleep(1.1)
    args = [a for k, v in opts.items() for a in (f'--{k.replace("_", "-")}', v)]
    code = subprocess.run([sys.executable, '-c', STOPPED, here, backup.KEYS['BACKUP_R2_ENDPOINT'], *args], capture_output=True).returncode
    interrupted_status = status_file()
    time.sleep(1.1)
    recovered_status = backup.run(dict(opts))
    check(code == 124 and interrupted_status['in_progress'] and list(interrupted_status['renders_unverified']) == [interrupted_render_key]
          and 'stopped mid-way' in interrupted_status['renders_error'] and interrupted_render_key in r2.listing()
          and recovered_status['renders_unverified'] == {} and recovered_status['renders_pending'] == 0
          and recovered_status['renders_ok_at'] == recovered_status['tried_at'],
          "a render up but the unit stopped before its read-back: the next night reads it back")

    # ---- the repo's copy went up and didn't read back: the renders' room still counts its bytes (the bucket as it is)
    commit('a new asset', {'asset.bin': os.urandom(recovered_status['ok_bytes'] + 200_000)})
    waiting_render_size = 3 * recovered_status['ok_bytes'] + 300_000
    waiting_render_key = new_render(waiting_render_size)
    bucket_before = r2.listing()
    free_bytes = backup.FREE_BYTES
    # Allow tonight's database backup and a month's reserve with growth, plus the render and a small margin.
    # The new repo asset fits, but uses more than that margin, so the render must wait after its upload.
    backup.FREE_BYTES = sum(size for size, _ in bucket_before.values()) + 51 * recovered_status['ok_bytes'] + waiting_render_size + 100_000
    backup.R2.fetch_hash = lambda self, key: None if key.endswith('.repo.tar.age') else fetch_hash(self, key)
    try:
        time.sleep(1.1)
        repo_unreadable_status = backup.run(dict(opts))
    finally:
        backup.FREE_BYTES, backup.R2.fetch_hash = free_bytes, fetch_hash
    bucket_after = r2.listing()
    repo_up = [key for key in bucket_after.keys() - bucket_before.keys() if key.endswith('.repo.tar.age')]
    persisted_status = status_file()
    check(repo_unreadable_status['state'] == 'ok' and 'read back' in repo_unreadable_status['repo_error']
          and repo_unreadable_status['repo_key'] == recovered_status['repo_key'] and len(repo_up) == 1
          and waiting_render_key not in bucket_after and persisted_status['renders_pending'] == 1
          and 'free 10 GB' in persisted_status['renders_error'],
          f"a repo copy up but not read back: the renders' room counts it ({repo_up})")
    time.sleep(1.1)
    room_restored_status = backup.run(dict(opts))

    # ---- a store that was fine and then can't be read: nothing waits that the night can see, and the board still hears
    os.rename(store, f'{store}-moved')
    os.symlink(f'{store}-moved', store)
    try:
        time.sleep(1.1)
        unreadable_store_status = backup.run(dict(opts))
    finally:
        os.remove(store)
        os.rename(f'{store}-moved', store)
    rw = [backup.renders_warn(unreadable_store_status, datetime.datetime.fromisoformat(room_restored_status['renders_ok_at']) + datetime.timedelta(hours=h)) for h in (35, 37)]
    check(unreadable_store_status['state'] == 'ok' and 'symlink' in unreadable_store_status['renders_error']
          and unreadable_store_status['renders_pending'] == 0 and unreadable_store_status['renders_ok_at'] == room_restored_status['renders_ok_at']
          and rw[0] is None and rw[1], f"a renders' store that can't be read: the board hears after 36 hours ({rw[1]})")

    # ---- the records, night after night: one upload each, new mail next night, an invoice's copy gone after 8 years
    r2 = backup.R2(KEYS['BACKUP_R2_ENDPOINT'], KEY_ID, SECRET)
    held = {k: v for k, v in r2.listing().items() if k.startswith('records/')}
    con = sqlite3.connect(db)
    con.execute("insert into mail (id, received, sender, recipient, subject, attachments, raw, keep) values (16, ?, 'b@example.com', 'invoices@company.test', 'New', '[]', ?, 'invoices')",
                (received16 := ago(0), b'new invoice mail'))
    con.commit()
    con.close()
    with open(f'{tmp}/old.age', 'wb') as f:
        f.write(b'age-encryption.org/v1 old')
    r2.put('records/invoices/2017-01-02T090000-7.tar.gz.age', f'{tmp}/old.age')     # an invoice's copy past INVOICE_DAYS
    r2.put('records/documents/2017-01-02T090000-8.tar.gz.age', f'{tmp}/old.age')    # an agreement's: never deleted by itself
    time.sleep(1.1)
    sr = backup.run(dict(opts))
    now_held = {k: v for k, v in r2.listing().items() if k.startswith('records/')}
    check(sr['state'] == 'ok' and all(now_held.get(k) == v for k, v in held.items()) and backup.record_key('invoices', received16, 16) in now_held
          and 'records/invoices/2017-01-02T090000-7.tar.gz.age' not in now_held and 'records/documents/2017-01-02T090000-8.tar.gz.age' in now_held
          and sr['records_pending'] == 0, 'the next night: only the new mail goes up, nothing twice; an invoice\'s copy past 8 years is deleted, an agreement\'s stays')
    con = sqlite3.connect(db)
    con.execute("insert into mail (id, received, sender, recipient, subject, attachments, raw, keep) values (17, ?, 'b@example.com', 'documents@company.test', 'Big', '[]', ?, 'documents')",
                (received17 := ago(2), os.urandom(4000)))
    con.commit()
    con.close()
    limit = backup.RECORDS_MAX
    backup.RECORDS_MAX = sum(v[0] for k, v in r2.listing().items() if k.startswith('records/')) + 100
    try:
        time.sleep(1.1)
        sf = backup.run(dict(opts))
    finally:
        backup.RECORDS_MAX = limit
    check(sf['state'] == 'ok' and sf['ok_key'] != sr['ok_key'] and 'not uploaded' in sf['records_error'] and '2 GB' in sf['records_error']
          and sf['records_pending'] == 1 and sf['records_since'] and sf['records_warn'] is None,
          f"records past their cap: the night's backup still goes, the record waits ({sf['records_error']})")
    later = datetime.datetime.fromisoformat(sf['records_since']) + datetime.timedelta(hours=37)
    rw = [backup.records_warn(sf, datetime.datetime.fromisoformat(sf['records_since']) + datetime.timedelta(hours=h)) for h in (35, 37)]
    check(rw[0] is None and rw[1] and sf['records_since'][:10] in rw[1] and rw[1] in backup.warnings(sf, 0, later),
          f'a record due for 36 hours: the heads-up, with no figure in it ({rw[1]})')
    time.sleep(1.1)
    sg = backup.run(dict(opts))
    check(sg['state'] == 'ok' and sg['records_pending'] == 0 and sg['records_error'] is None and sg['records_since'] is None
          and backup.record_key('documents', received17, 17) in r2.listing(), 'with room again, the waiting record goes up the next night')

    def mail(i, keep, body):
        con = sqlite3.connect(db)
        con.execute("insert into mail (id, received, sender, recipient, subject, attachments, raw, keep) values (?, ?, 'b@example.com', ?, 'More', '[]', ?, ?)",
                    (i, received := ago(0), f'{keep}@company.test', body, keep))
        con.commit()
        con.close()
        return backup.record_key(keep, received, i)

    # a build that fails outright (a full disk, age dying mid-tar): nothing goes up, and what's due stays due, heads-up and all
    k18 = mail(18, 'invoices', b'invoice eighteen')
    build = backup.records_build
    def broken(*a):
        raise OSError(28, 'No space left on device')
    backup.records_build = broken
    try:
        time.sleep(1.1)
        sb = backup.run(dict(opts))
    finally:
        backup.records_build = build
    check(sb['state'] == 'ok' and 'OSError' in sb['records_error'] and sb['records_ok_at'] == sg['records_ok_at'] and sb['records_since'] == sb['tried_at']
          and k18 not in r2.listing() and backup.records_warn(sb, datetime.datetime.fromisoformat(sb['tried_at']) + datetime.timedelta(hours=37)),
          f"a records build that fails: the night's backup goes, the copy isn't marked done, and the heads-up comes after 36 hours ({sb['records_error']})")

    # an expired invoice filling records/ to RECORDS_MAX: it's deleted first, and the new record goes up in its room
    with open(f'{tmp}/old.age', 'wb') as f:
        f.write(os.urandom(5000))
    r2.put('records/invoices/2017-01-03T090000-9.tar.gz.age', f'{tmp}/old.age')
    backup.RECORDS_MAX = sum(v[0] for k, v in r2.listing().items() if k.startswith('records/')) + 100
    try:
        time.sleep(1.1)
        se = backup.run(dict(opts))
    finally:
        backup.RECORDS_MAX = limit
    held = r2.listing()
    check(se['state'] == 'ok' and 'records/invoices/2017-01-03T090000-9.tar.gz.age' not in held and k18 in held and se['records_pending'] == 0
          and se['records_error'] is None and se['records_ok_at'] == se['tried_at'] and se['records_since'] is None,
          f"records/ full of an invoice past 8 years: it's deleted before the uploads, and the new one goes up ({se['records_error']})")

    # past the cap, only the first record that doesn't fit is built: the others aren't written to the disk every night
    k19, k20 = mail(19, 'documents', os.urandom(3000)), mail(20, 'documents', os.urandom(3000))
    parts, part = [], backup.record_part
    backup.record_part = lambda row, *a: (parts.append(row[0]), part(row, *a))[1]
    backup.RECORDS_MAX = sum(v[0] for k, v in r2.listing().items() if k.startswith('records/')) + 100
    try:
        time.sleep(1.1)
        sc = backup.run(dict(opts))
    finally:
        backup.RECORDS_MAX, backup.record_part = limit, part
    check(sc['state'] == 'ok' and parts == [19] and sc['records_pending'] == 2 and '2 GB' in sc['records_error'] and k19 not in r2.listing(),
          f'records past their cap: the build stops at the first that doesn\'t fit ({parts}, {sc["records_error"]})')

    # a read-back that doesn't match: the record can't be put again (the lock), so it stays due until it reads back whole
    read_back = backup.R2.fetch_hash
    backup.R2.fetch_hash = lambda self, key: 'damaged' if key == k19 else read_back(self, key)
    try:
        time.sleep(1.1)
        su = backup.run(dict(opts))
    finally:
        backup.R2.fetch_hash = read_back
    time.sleep(1.1)
    sv = backup.run(dict(opts))
    check(su['state'] == 'ok' and 'read back' in su['records_error'] and list(su['records_unverified']) == [k19] and su['records_pending'] == 2
          and su['records_ok_at'] != su['tried_at'] and su['records_since'] and k19 in r2.listing()
          and sv['records_unverified'] == {} and sv['records_pending'] == 0 and sv['records_ok_at'] == sv['tried_at'] and sv['records_since'] is None
          and k20 in r2.listing() and sv['records_error'] is None,
          f"a record that doesn't read back: still due the next night, until it reads back whole ({su['records_error']})")

    # records that stop mid-way (the second doesn't fit tonight's room) still count what went up: the repo's copy that
    # would fit only without them is refused, so it can't take the room kept for next month's database backups
    class Store:   # R2 as records_copy and repo_copy use it
        def __init__(self):
            self.held = {}
        def put(self, key, path):
            self.held[key] = backup.sha256_file(path)
            return os.path.getsize(path), self.held[key]
        def fetch_hash(self, key):
            return self.held.get(key)
    was = backup.STATE
    backup.STATE, work_r = f'{tmp}/state-room', f'{tmp}/work-room'
    os.makedirs(work_r)
    try:
        recs = []
        for n in (1, 2):
            with open(f'{work_r}/{n}.age', 'wb') as f:
                f.write(os.urandom(4000))
            recs.append((f'records/documents/2026-01-0{n}T090000-{n}.tar.gz.age', f'{work_r}/{n}.age'))
        sq = {'tried_at': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')}
        store = Store()
        up = backup.records_copy(store, {k: ago(0) for k, _ in recs}, recs, {}, sq, 6000)
        repo_keys = {'BACKUP_AGE_RECIPIENT': KEYS['BACKUP_AGE_RECIPIENT']}
        now_q = datetime.datetime.now(datetime.timezone.utc)
        backup.repo_copy(Store(), opts, repo_keys, now_q, work_r, {'tried_at': sq['tried_at']}, 0, 0)   # its size, alone
        os.remove(f'{backup.STATE}/repo-chain.json')   # (so the next is a full copy again, the same size)
        repo_size = sum(os.path.getsize(f'{work_r}/{f}') for f in os.listdir(work_r) if f.endswith('.repo.tar.age'))
        free = backup.FREE_BYTES
        backup.FREE_BYTES = repo_size + 2000   # room for the repo's copy, but not with the record that went up
        try:
            backup.repo_copy(Store(), opts, repo_keys, now_q, work_r, sq, up, 0)
            refused = None
        except backup.Stop as e:
            refused = str(e)
        finally:
            backup.FREE_BYTES = free
        check(up == 4000 and list(store.held) == [recs[0][0]] and 'not uploaded' in sq['records_error'] and sq['records_pending'] == 1
              and 'records_ok_at' not in sq and refused and 'next month' in refused and sq.get('repo_ok_at') is None,
              f"a record up, the next past tonight's room: its bytes still count, and the repo's copy is refused ({sq.get('records_error')}; {refused})")
    finally:
        backup.STATE = was
        shutil.rmtree(f'{tmp}/state-room', ignore_errors=True)
        shutil.rmtree(work_r, ignore_errors=True)

    time.sleep(1.1)
    st2 = backup.run(dict(opts))

    # ---- a backup that would take the bucket past the free tier: not uploaded, the night fails
    free = backup.FREE_BYTES
    backup.FREE_BYTES = st2['bucket_bytes'] + st2['ok_bytes'] // 2
    try:
        time.sleep(1.1)
        st4 = backup.run(dict(opts))
    finally:
        backup.FREE_BYTES = free
    kept = r2.listing()
    check(st4['state'] == 'failed' and 'not uploaded' in st4['error'] and 'free 10 GB' in st4['error']
          and len(kept) == st2['bucket_daily'] + st2['bucket_repo'] + st2['bucket_records'] + st2['bucket_renders'] + st2['bucket_big_files'] + 1
          and st4['ok_key'] == st2['ok_key'],
          f'past the free tier: nothing uploaded, last good kept ({st4["error"]})')

    # ---- a product's copy damaged, one whose read fails mid-way and one past the products' room: the night is good, the
    # drill fails on the damaged copy, the board hears about the three left out
    with open(f'{product_volume}/backup/x.db', 'r+b') as f:
        f.seek(4096 * 2)
        f.write(os.urandom(4096))
    os.makedirs(f'{products}/xx-unreadable/backup/planets')
    open(f'{products}/xx-unreadable/backup/planets/x.db', 'wb').write(PRODUCT_COPY)
    open(f'{products}/xx-unreadable/backup/visible.txt', 'wb').write(b'fine')
    os.makedirs(f'{products}/yy-broken/backup')
    open(f'{products}/yy-broken/backup/y.db', 'wb').write(os.urandom(65536))
    os.makedirs(f'{products}/zz-big/backup')
    open(f'{products}/zz-big/backup/y.db', 'wb').write(os.urandom(len(PRODUCT_COPY) * 2))
    cap = backup.PRODUCTS_MAX_BYTES
    backup.PRODUCTS_MAX_BYTES = len(PRODUCT_COPY) * 1.5
    try:
        with failing_reads('yy-broken'), unreadable_directory('planets'):
            time.sleep(1.1)
            stp = backup.run(dict(opts))
    finally:
        backup.PRODUCTS_MAX_BYTES = cap
    ok, rep = restore(fetch(stp['ok_key']), f'{tmp}/scratch-products', fetched)
    check(stp['state'] == 'ok' and 'zz-big' in stp['products_error'] and 'zz-big' in stp['warn'] and 'yy-broken' in stp['products_error']
          and 'xx-unreadable' in stp['products_error'] and 'pebblet' not in stp['products_error'] and not ok and len(rep['problems']) == 1
          and rep['problems'][0].startswith('products/pebblet/x.db: ') and os.listdir(f'{tmp}/scratch-products/products') == ['pebblet'],
          f"a damaged product copy fails the drill ({rep['problems']}); unreadable copies and one past the products' room are left out whole, named ({stp['products_error']})")
    shutil.rmtree(f'{products}/xx-unreadable')
    shutil.rmtree(f'{products}/yy-broken')
    shutil.rmtree(f'{products}/zz-big')

    # ---- a big file gone from the server: its copy stays while a backup naming it may be kept (BIG_FILE_DAYS after the last
    # one that had it), then leaves the bucket, before the night's room is counted; one still on the server never goes;
    # with the state lost, the year starts at the first night that sees it.
    gone = backup.big_file_key(hashlib.sha256(files[f'{hq}/photos/2.jpg']).hexdigest(), public_key)
    os.remove(f'{hq}/photos/2.jpg')
    time.sleep(1.1)
    ste = backup.run(dict(opts))
    check(ste['state'] == 'ok' and ste['ok_big_files']['files'] == 2 and gone in r2.listing(), 'a big file deleted on the server: its copy stays while backups name it')
    seen = json.load(open(f'{state}/big-files-seen.json'))
    year = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=backup.BIG_FILE_DAYS, hours=1)).isoformat(timespec='seconds')
    json.dump({key: year for key in seen}, open(f'{state}/big-files-seen.json', 'w'))   # every big file last in a backup a year ago
    held = r2.listing()
    free = backup.FREE_BYTES   # room for tonight's archive only once the expired one is gone
    backup.FREE_BYTES = sum(size for size, _ in held.values()) - held[gone][0] + ste['ok_bytes'] + held[gone][0] // 2
    try:
        time.sleep(1.1)
        ste = backup.run(dict(opts))
    finally:
        backup.FREE_BYTES = free
    left = sorted(k for k in r2.listing() if k.startswith('big-files/'))
    check(ste['state'] == 'ok' and ste['big_files_error'] is None and left == [backup.big_file_key(hashlib.sha256(BIG).hexdigest(), public_key)] and ste['bucket_big_files'] == 1
          and sorted(json.load(open(f'{state}/big-files-seen.json'))) == left,
          f'a year after the last backup that had it, a deleted file leaves the bucket, its room counted tonight; one still on the server stays ({left})')
    os.remove(f'{hq}/studio/take.webm')
    os.remove(f'{hq}/photos/again.webm')
    os.remove(f'{state}/big-files-seen.json')
    time.sleep(1.1)
    ste = backup.run(dict(opts))
    check(ste['state'] == 'ok' and ste['bucket_big_files'] == 1 and json.load(open(f'{state}/big-files-seen.json')) == {left[0]: ste['tried_at']},
          'with the state lost, a deleted file\'s year starts at the first night that sees it, never at its upload')

    # ---- a night cut short after a big file's upload (R2 unreachable for its read-back): the next night reads it back
    open(f'{hq}/photos/3.jpg', 'wb').write(b'photo three ' + os.urandom(100_000))
    third = backup.big_file_key(hashlib.sha256(open(f'{hq}/photos/3.jpg', 'rb').read()).hexdigest(), public_key)
    fetch_hash = backup.R2.fetch_hash
    def unreachable(r2_, key):
        if key.startswith('big-files/'):
            raise backup.Stop(f'R2 unreachable (URLError) for GET {key}')
        return fetch_hash(r2_, key)
    backup.R2.fetch_hash = unreachable
    try:
        time.sleep(1.1)
        stu = backup.run(dict(opts))
    finally:
        backup.R2.fetch_hash = fetch_hash
    check(stu['state'] == 'failed' and third in r2.listing() and list(status_file()['big_files_unverified']) == [third],
          f"a big file uploaded on a night cut short is due its read-back ({stu['error']})")
    time.sleep(1.1)
    stu = backup.run(dict(opts))
    check(stu['state'] == 'ok' and stu['big_files_unverified'] == {} and stu['ok_big_files']['new'] == 0 and stu['big_files_error'] is None,
          'the next night reads it back, and makes it no second time')

    # ---- a big file whose PUT never landed, then deleted from the server: nothing is due a read-back for it
    open(f'{hq}/photos/4.jpg', 'wb').write(b'photo four ' + os.urandom(100_000))
    fourth = backup.big_file_key(hashlib.sha256(open(f'{hq}/photos/4.jpg', 'rb').read()).hexdigest(), public_key)
    put = backup.R2.put
    def refused(r2_, key, path):
        if key == fourth:
            raise backup.Stop(f'R2 unreachable (URLError) for PUT {key}')
        return put(r2_, key, path)
    backup.R2.put = refused
    try:
        time.sleep(1.1)
        stf = backup.run(dict(opts))
    finally:
        backup.R2.put = put
    check(stf['state'] == 'failed' and fourth not in r2.listing() and list(status_file()['big_files_unverified']) == [fourth],
          f"a big file whose PUT failed is due a read-back ({stf['error']})")
    os.remove(f'{hq}/photos/4.jpg')
    time.sleep(1.1)
    stf = backup.run(dict(opts))
    check(stf['state'] == 'ok' and stf['big_files_unverified'] == {} and stf['big_files_error'] is None,
          'a big file that never reached R2, then deleted, is no read-back that never ends')

    # ---- the bucket's room: R2's free 10 GB, or what the board allowed (BACKUP_BUCKET_GB, whole GB); any other value
    # (or a line infra-env.sh skips) stops the night rather than take the free tier for it
    for value, gb in {'30': 30, '': 10, '0': None, '2.5': None, '30GB': None}.items():
        env_file = f'{tmp}/infra-bucket-{len(value)}.env'
        open(env_file, 'w').write(f'SERVER_NAME=t\nSERVER=t-1\nBACKUP_BUCKET=t\nBACKUP_BUCKET_GB={value}\n')
        probe = ("import backup, json, sys; st = backup.run({'hqdata': sys.argv[1], 'state': sys.argv[2]}); "
                 "print(json.dumps([backup.FREE_BYTES, backup.LIMIT, st['error']]))")
        os.makedirs(f'{tmp}/bucket-{len(value)}/hq')
        os.makedirs(f'{tmp}/bucket-{len(value)}/state')
        r = subprocess.run([sys.executable, '-c', probe, f'{tmp}/bucket-{len(value)}/hq', f'{tmp}/bucket-{len(value)}/state'], cwd=here,
                           env={**os.environ, 'INFRA_ENV': env_file}, capture_output=True, text=True)
        free_bytes, limit, error = json.loads(r.stdout.splitlines()[-1])
        if gb:
            check(free_bytes == gb * 1e9 and (gb == 10) == ('free' in limit) and 'BACKUP_BUCKET_GB' not in error, f'BACKUP_BUCKET_GB={value!r}: {limit}')
        else:
            check('BACKUP_BUCKET_GB' in error, f'BACKUP_BUCKET_GB={value!r}: the night stops ({error})')
    backup.SKIPPED.add('BACKUP_BUCKET_GB')
    try:
        stb = backup.run(dict(opts))
    finally:
        backup.SKIPPED.discard('BACKUP_BUCKET_GB')
    check(stb['state'] == 'failed' and 'BACKUP_BUCKET_GB' in stb['error'] and stb['ok_key'] == stf['ok_key'], f'a skipped BACKUP_BUCKET_GB line stops the night ({stb["error"]})')

    # ---- a symlink where the memory's folder should be: the night fails, nothing is read through it
    shutil.rmtree(f'{seats}/shared/claude/projects')
    os.symlink(f'{seats}/claude-1', f'{seats}/shared/claude/projects')
    st3 = backup.run(dict(opts))
    check(st3['state'] == 'failed' and 'symlink' in st3['error'] and st3['ok_key'] == stf['ok_key'], f'symlinked memory path: fails, last good kept ({st3["error"]})')
finally:
    gw.kill()
    shutil.rmtree(tmp, ignore_errors=True)

print(f'\n{fails} failed' if fails else '\nall passed')
sys.exit(1 if fails else 0)
