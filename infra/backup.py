#!/usr/bin/env python3
"""The nightly off-site backup: what lives only on this server, encrypted here, to Cloudflare R2.

Runs as root on the host from <SERVER_NAME>-backup.timer (installed by harden.sh). Standard library plus the age binary.

  backup.py run                          the nightly run
  backup.py restore <file.age> <dir> [<fetched>]
                                         the drill: the private key on stdin; unpacks into <dir> and checks the database,
                                         with the big files it names from <fetched>/big-files/ (backup.py fetch's folder)
  backup.py fetch <dir> <prefix>...      downloads the bucket's objects under each prefix (big-files/, daily/<time>, ...) into
                                         <dir>, with BACKUP_R2_ENDPOINT, _ACCESS_KEY_ID and _SECRET_ACCESS_KEY from the env
  backup.py restore-repo <dir> <file.repo.tar.age>...
                                         the repo's drill: rebuilds every branch and tag from its copies into <dir>
  backup.py restore-records <dir> <file.tar.gz.age>...
                                         the records' drill: unpacks invoices and agreements into <dir> and checks each file
  backup.py restore-renders <dir> <sha256.age>...
                                         the renders' drill: decrypts films and tracks into <dir> (a store for renders.py)

What goes in: the HQ database (a consistent copy, VACUUM INTO inside the coordinator, never a copy of the live file;
without the search index, which the coordinator makes again from the rest), the rest of the coordinator's data volume (the board's keys, approvals, photos; not what infra.env's BACKUP_LEFT_OUT names, nor the
lent machines' runs), the voice line's volume,
the agents' shared Claude memory and each product's backup/ folder (consistent copies the product makes there; a .part
and its SQLite sidecars are still being written; never its live files or a live product's separate preview volume), up to infra.env's BACKUP_PRODUCTS_MB. The coordinator's
big files (BIG_FILE_BYTES and up: mail attachments, photos, studio work, review shots, print files), which don't change once
written, aren't in the archive: each goes once, as its own object big-files/<its sha256, keyed>.age, and the night's
manifest names them (path, sha256, object, size, time); one that's gone from the server goes from the bucket BIG_FILE_DAYS after the last
backup that had it, when every copy naming it has expired too. Next to it goes a copy of the repo (every branch and tag, from the server's own
mirror of GitHub), as a git bundle: a full one every 14 days, and on the nights between only what's new since the
night before. The repo's copy is made only once the database's backup is uploaded, read back and recorded, and nothing
that goes wrong with it can fail the night. It's about 5 to 10 GB of the bucket for 30 days at today's size, and more
as the repo grows: on a night it would take the bucket past R2's free tier, or leave no room for the database's
backups until what's in the bucket has expired, the repo's copy is skipped (the database's has gone already). Last come
the renders git leaves out (shared/demo/renders.mjs: the films and tracks jobs pushed, kept in the worker's store by
sha256): each once, as its own object renders/<sha256>.age, never deleted, up to infra.env's BACKUP_RENDERS_GB in all
and as many as the same room allows a night (the rest wait for the next). Their room reserves database backups, but none
for repo copies: within that ceiling, renders can keep delaying the repo's copies even after older copies expire, as they
take the room that frees (repo_warn reports the gap). The archive is encrypted to the board's age public key as it is written (the database
copy on the way in is root-only, or inside the coordinator, and deleted before the upload), so this server can write
backups but never read them; only the board's private key (in its password manager) opens one.

The 7-year records go too, each once and for as long as they must be kept: every mail to invoices@ and documents@
(supplier invoices, signed agreements), its raw message and its attachments as received, as its own object under
records/ (records/invoices/<the time it came, to the second>-<mail id>.tar.gz.age: SQLite can give a deleted mail's id
to the next, never at the same second), encrypted to the same key. The monthly copies keep a year
at most, and the law wants invoices 7 years (the bookkeeping retention; a company's compliance owner confirms its own).
records/ has no lifecycle rule: an invoice's copy is deleted here INVOICE_DAYS after it came, when HQ deletes its own
(mail.ts); an agreement's never by itself. Which mail is which is HQ's `keep` column, never worked out again here.

The board's desk-phone card puts four keys in the coordinator's key store (secrets.ts): the bucket's S3 endpoint, a
token scoped to that bucket, and the public key. R2 keeps 30 days of daily/ and 12 months of monthly/ by the bucket's
own lifecycle rules, and a bucket lock stops anyone (this server included) deleting or overwriting a backup for 30 days.
The result goes to /var/lib/<SERVER_NAME>/backup/status.json (report.sh shows it) and to the coordinator's volume
(backup.ts alerts the board's feed when a night is missed). Nothing here ever prints a key.
"""
import collections, contextlib, datetime, fnmatch, hashlib, hmac, http.client, io, json, os, re, shutil, sqlite3, stat, subprocess, sys, tarfile, time, urllib.error
import urllib.parse, urllib.request, xml.etree.ElementTree as ET
from company import INFRA, ROOT, SKIPPED   # the server's names (company/infra.env), its checkout, keys whose line wasn't plain

NAME = INFRA['SERVER_NAME']
STATE = f'/var/lib/{NAME}/backup'
BUCKET = INFRA['BACKUP_BUCKET']
MEMORY = 'shared/claude/projects/-work-repo/memory'   # in the worker's seats volume (worker.ts MEMORY)
KEYS = {  # the key store's names (secrets.ts OWN) and their shapes; a value that doesn't fit is never used or shown
    'BACKUP_R2_ENDPOINT': r'https://[0-9a-f]{32}(\.(eu|fedramp))?\.r2\.cloudflarestorage\.com(/[a-z0-9][a-z0-9-]{1,61}[a-z0-9])?/?',
    'BACKUP_R2_ACCESS_KEY_ID': r'[0-9a-f]{32}',
    'BACKUP_R2_SECRET_ACCESS_KEY': r'[0-9a-f]{64}',
    'BACKUP_AGE_RECIPIENT': r'age1[02-9ac-hj-np-z]{58}',
}
# The repo's copy: the server's own mirror of GitHub (every branch and tag), fetched with the server checkout's token.
CREDENTIAL = f'{ROOT}/infra/git-credential.sh'
REPO_FULL_DAYS = 14   # a full bundle at least this often. It's kept 30 days, and a night's copy restores only while its
                      # chain's full one is there: a deleted branch stays restorable 30 - 14 = 16 to 30 days
REPO_STALE = 36 * 3600   # fetching from GitHub failing this long: the board hears (the copy then is GitHub's as of the last fetch)
# R2's free storage (10 GB-month), or the room the board allowed past it (company/infra.env's BACKUP_BUCKET_GB, a whole
# number of GB: a spending approval, BUDGET.md); the board hears about it at 80%.
BUCKET_SETTING = INFRA.get('BACKUP_BUCKET_GB', '')
BUCKET_GB_VALID = re.fullmatch(r'[1-9][0-9]*', BUCKET_SETTING) is not None   # (any other value stops the night: run())
FREE_BYTES = int(BUCKET_SETTING) * 1e9 if BUCKET_GB_VALID else 10e9
LIMIT_GB = round(FREE_BYTES / 1e9)
LIMIT = f'the {LIMIT_GB} GB the board allowed' if LIMIT_GB != 10 else "R2's free 10 GB"
NEXT_NIGHT = 1.5     # a database backup still to come, counted at this many times the size of tonight's
REPO_RESERVE = 33    # the repo's copy leaves room for this many of them, with nothing expiring: the next 31 nights (by then
                     # everything in the bucket before tonight is gone: 30 days, and a day for the lifecycle rules) and the
                     # two monthly copies those nights can start. So the repo never takes the room a later night's backup needs
INVOICE_DAYS = 2922  # mail.ts's INVOICE_DAYS (8 years after it came): an invoice's copy goes with HQ's own (test_backup checks they match)
RECORDS_MAX = 2e9    # records/ holds at most this: anyone can mail invoices@, and a flood mustn't fill the free tier (a real year is a few MB)
RECORDS_STALE = 36 * 3600   # a record due off the server this long and not there: the board hears, the fixer gets a job (backup.ts)
# The coordinator's big files go once, as their own object (big_file_key), not in each night's archive: they don't
# change once written, and a night is then little more than the database.
BIG_FILE_BYTES = 64 * 1024
BIG_FILE_DAYS = 365   # a big file gone from the server leaves the bucket this long after the last backup that had it (the monthly copies' year)
BIG_FILE_KEY = re.compile(r'big-files/[0-9a-f]{64}\.age')
RENDERS = 'renders'  # in the worker's work volume (worker.ts RENDERS): each render a job pushed, named by its sha256
RENDER_MAX_BYTES = 2 ** 30   # renders.ts RENDER_MAX: the store holds none bigger
# The most renders/ holds, for good (none is deleted): the company's own choice (company/infra.env's BACKUP_RENDERS_GB, a
# whole number of GB; 3 unset). The room check alone keeps next month's database backups but not the repo's copies, so a
# flood of renders (a job pushing films in a loop, each up to RENDER_MAX_BYTES) would take for good the room the repo's next
# full copy needs. Any other value (or a line company.py skips): no render goes, and the status says why.
def renders_max():   #.
    """The renders' ceiling in bytes, or None when BACKUP_RENDERS_GB isn't a whole number of GB or its line was skipped."""
    setting = INFRA.get('BACKUP_RENDERS_GB') or '3'
    return int(setting) * 1e9 if re.fullmatch(r'[1-9][0-9]*', setting) and 'BACKUP_RENDERS_GB' not in SKIPPED else None
RENDERS_STALE_SECONDS = 36 * 3600   # a render waiting this long to go off the server: the board hears
# A product's data volume (products.py's product-<slug>-data, in Compose's project): only its backup/ folder goes in.
PRODUCT_VOLUME = re.compile(r'infra_product-([a-z0-9][a-z0-9-]*)-data')
UNFINISHED = ('*.part', '*.part-journal', '*.part-wal', '*.part-shm')   # a copy still being written and its SQLite sidecars
# The most every product's copies together add to a night's archive, compressed: the company's own choice (company/infra.env's
# BACKUP_PRODUCTS_MB, a whole number of MB). Each byte of the archive keeps REPO_RESERVE * NEXT_NIGHT more of the bucket
# free for the nights to come. Unset or not a whole number: no product's copies go, and the board hears.
PRODUCTS_SETTING = INFRA.get('BACKUP_PRODUCTS_MB', '')
PRODUCTS_MAX_BYTES = int(PRODUCTS_SETTING) * 1e6 if re.fullmatch(r'[0-9]+', PRODUCTS_SETTING) else None
# The database's live files go as its consistent copy. The status reports report.sh keeps for the Overseer are made again
# every 10 minutes. runs/ is the lent machines' scratch (runs.ts): a job's whole tree while its run waits, and the run's
# output for two days after, like the job worktrees the backup leaves out.
# The search index (memory.ts: chunks of the repo's files and of the database's own jobs, calls and requests, their words
# and their vectors) is made again from those when the coordinator starts, so the copy leaves it out: a third of the
# database, and most of its compressed bytes (the vectors don't compress).
DERIVED = ('memory_vocab', 'memory_fts', 'memory', 'memory_docs')
HQ_SKIPPED = {'hq.db', 'hq.db-wal', 'hq.db-shm', 'hq.db-journal', 'backup-status.json', 'status', 'runs'}
# Left out on purpose: the company's own choice (company/infra.env's BACKUP_LEFT_OUT, paths in the coordinator's data volume,
# comma-separated, * and ? as in a shell; none by default).
LEFT_OUT = tuple(p.strip() for p in INFRA.get('BACKUP_LEFT_OUT', '').split(',') if p.strip())
COMPOSE = ['docker', 'compose', '-f', f'{ROOT}/infra/compose.yaml', '-f', f'{ROOT}/infra/generated/products.yaml']
# Inside the coordinator (its own uid, so the live database's -wal/-shm files never end up root's): a consistent
# snapshot with VACUUM INTO, streamed to stdout and removed.
COPY_JS = r"""
import { DatabaseSync } from 'node:sqlite';
import { createReadStream, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
// (the container's /tmp; the tests' machine's TMPDIR.)
const out = `${tmpdir()}/hq-backup-${process.pid}-${Date.now()}.db`;
try {
  const db = new DatabaseSync(process.argv[1]);
  db.exec('pragma busy_timeout = 30000');
  db.prepare('vacuum into ?').run(out);
  db.close();
  await pipeline(createReadStream(out), process.stdout);
} finally { rmSync(out, { force: true }); }
"""


class Stop(Exception):
    """A failed night, with a message that's safe to show (no key, no endpoint). config: failed for how it's set up (R2's
    401, 403 or 404 on the token, the bucket or a signature; or a key's shape), which no later night mends by itself;
    code: R2's <Code>."""
    def __init__(self, msg, config=False, code=None):
        super().__init__(msg)
        self.config, self.code = config, code


def log(msg):
    print(f'{datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")} {msg}', flush=True)


# ---- files the containers can write: opened one path component at a time, never through a symlink

def open_dir(path, dir_fd=None):
    fd = os.open('/' if path.startswith('/') else '.', os.O_PATH | os.O_DIRECTORY, dir_fd=dir_fd)
    try:
        for part in [p for p in path.split('/') if p]:
            nxt = os.open(part, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
    except BaseException:
        os.close(fd)
        raise
    return fd


def read_key(dir_fd, name):
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dir_fd)
    except FileNotFoundError:
        return None
    except OSError:
        raise Stop(f'{name} in the key store is not a plain file')
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > 4096:
            raise Stop(f'{name} in the key store is not a plain file')
        value = os.read(fd, 4096).decode('utf-8', 'replace').strip()
    finally:
        os.close(fd)
    if not re.fullmatch(KEYS[name], value):
        raise Stop(f"{name} doesn't look like one (the board can save it again on the desk phone)", config=True)
    return value


def volume(name):
    out = subprocess.run(['docker', 'volume', 'inspect', '-f', '{{.Mountpoint}}', f'infra_{name}'],
                         capture_output=True, text=True, timeout=60)
    if out.returncode or not out.stdout.strip().startswith('/'):
        raise Stop(f"Docker volume infra_{name} not found")
    return out.stdout.strip()


# ---- the archive: tar.gz straight into age, so only ciphertext reaches the disk

class Exact:
    """Exactly n bytes of a file that may change while it's read (a live call's log): zero-padded if it shrank."""
    def __init__(self, f, n):
        self.f, self.left, self.short = f, n, False

    def read(self, n=-1):
        n = self.left if n < 0 else min(n, self.left)
        b = self.f.read(n) if n else b''
        if len(b) < n:
            b, self.short = b + b'\0' * (n - len(b)), True
        self.left -= len(b)
        return b


class PastRoomError(Exception):
    """A product's copies past the products' room."""


class Capped:
    """A file that takes at most n bytes: the write past them raises PastRoomError, and drops the rest (a close's trailer)."""
    def __init__(self, f, n):
        self.f, self.n, self.full = f, n, False

    def write(self, b):
        if self.full or self.f.tell() + len(b) > self.n:
            if not self.full:
                self.full = True
                raise PastRoomError()
            return len(b)
        return self.f.write(b)


class Tally:
    """The archive's stream on its way to age, counted per part (the database, each of the data volume's folders, the
    voice line, the memory, the products): part() names the part what's added next belongs to. gzip holds back the last
    few KB it was given, so they count to the next part: a part is right to about 0.1 MB."""
    def __init__(self, f):
        self.f, self.parts, self.now = f, {}, None

    def part(self, name, raw=None):
        """What's written from now on is name's; raw: the bytes of a file of it, before compression."""
        self.now = self.parts.setdefault(name, {'bytes': 0, 'files': 0, 'raw': 0})
        if raw is not None:
            self.now['files'] += 1
            self.now['raw'] += raw

    def write(self, b):
        if self.now is not None:
            self.now['bytes'] += len(b)
        return self.f.write(b)


class BigFiles:
    """The big files (BIG_FILE_BYTES and up), each to the bucket once (big_file_key): the manifest names them (entries),
    and those not in the bucket yet are encrypted into work/big-files/ (new: {their key: their path there}) for the
    night's upload.
    A file is read once for its hash, and only if it's new again, into age, hashed on the way: what's named is what went.
"""
    def __init__(self, work, recipient, listing):
        self.work, self.recipient, self.listing = f'{work}/big-files', recipient, listing
        self.entries, self.new = [], {}
        os.makedirs(self.work, mode=0o700, exist_ok=True)

    def __call__(self, f, st, member):
        sha = self.digest(Exact(f, st.st_size))
        key = big_file_key(sha, self.recipient)
        if key not in self.listing and key not in self.new:
            f.seek(0)
            part = f'{self.work}/.part'
            age = subprocess.Popen(['age', '-r', self.recipient, '-o', part], stdin=subprocess.PIPE)
            try:
                sha = self.digest(Exact(f, st.st_size), age.stdin)
            finally:
                age.stdin.close()
                if age.wait(timeout=600):
                    raise Stop(f'age failed to encrypt {member}')
            key = big_file_key(sha, self.recipient)
            if key in self.listing or key in self.new:   # it changed while it was read, into one that's there
                os.remove(part)
            else:
                self.new[key] = f'{self.work}/{key[len("big-files/"):]}'
                os.rename(part, self.new[key])
        self.entries.append({'path': member, 'sha256': sha, 'object': key, 'size': st.st_size, 'mtime': int(st.st_mtime)})

    @staticmethod
    def digest(body, out=None):
        h = hashlib.sha256()
        for chunk in iter(lambda: body.read(1 << 20), b''):
            h.update(chunk)
            if out is not None:
                out.write(chunk)
        if body.short:
            log('a file shrank while it was read (kept, zero-padded)')
        return h.hexdigest()


def big_file_key(sha, recipient):
    """A big file's object: named by its sha256 keyed with the board's public key, so the bucket's listing can't confirm
    whether a file someone has (a customer's photo) is in it. A new key pair names every file anew (each goes once more)."""
    return f'big-files/{hmac.new(recipient.encode(), bytes.fromhex(sha), hashlib.sha256).hexdigest()}.age'


def info(name, st, kind):
    ti = tarfile.TarInfo(name)
    ti.type, ti.mode, ti.mtime, ti.uid, ti.gid = kind, stat.S_IMODE(st.st_mode), int(st.st_mtime), st.st_uid, st.st_gid
    return ti


def add_tree(tar, top_fd, arc, skip=(), left_out=(), tally=None, big_files=None):
    """Everything under top_fd as arc/..., walked by file descriptor: a symlink is stored as a link, never followed,
    and nothing a container renames mid-walk can point the walk elsewhere. Sockets and devices are left out. Returns the
    files and their bytes. tally: counts each folder at the top as its own part (arc/<folder>), the files there as arc.
    big_files: a file of BIG_FILE_BYTES and up goes to it (BigFiles) instead of into the archive."""
    count = size = 0
    tar.addfile(info(arc, os.fstat(top_fd), tarfile.DIRTYPE))
    for path, dirs, files, dfd in os.fwalk('.', dir_fd=top_fd, follow_symlinks=False, onerror=raise_walk_error):
        rel = os.path.normpath(path)
        if rel == '.':
            dirs[:] = [d for d in dirs if d not in skip]
            files = [f for f in files if f not in skip]
        for name in sorted(dirs + files):
            if any(fnmatch.fnmatchcase(os.path.normpath(f'{rel}/{name}'), p) for p in left_out):
                continue
            member = os.path.normpath(f'{arc}/{rel}/{name}')
            try:
                st = os.stat(name, dir_fd=dfd, follow_symlinks=False)
                if tally is not None:
                    if rel != '.':
                        top = f"{arc}/{rel.split('/')[0]}"
                    elif stat.S_ISDIR(st.st_mode):
                        top = f'{arc}/{name}'
                    else:
                        top = arc
                    tally.part(top)
                if stat.S_ISDIR(st.st_mode):
                    tar.addfile(info(member, st, tarfile.DIRTYPE))
                elif stat.S_ISLNK(st.st_mode):
                    ti = info(member, st, tarfile.SYMTYPE)
                    ti.linkname = os.readlink(name, dir_fd=dfd)
                    tar.addfile(ti)
                elif stat.S_ISREG(st.st_mode):
                    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dfd)
                    with os.fdopen(fd, 'rb') as f:
                        st = os.fstat(f.fileno())
                        if not stat.S_ISREG(st.st_mode):
                            continue
                        if big_files is not None and st.st_size >= BIG_FILE_BYTES:
                            big_files(f, st, member)
                            count, size = count + 1, size + st.st_size
                            continue
                        ti = info(member, st, tarfile.REGTYPE)
                        ti.size = st.st_size
                        if tally is not None:
                            tally.part(top, st.st_size)
                        body = Exact(f, st.st_size)
                        tar.addfile(ti, body)
                        if body.short:
                            log(f'{member} shrank while it was read (kept, zero-padded)')
                    count, size = count + 1, size + st.st_size
            except FileNotFoundError:
                pass   # gone since the directory was listed
    return count, size


def raise_walk_error(error):
    """A folder that can't be read ends the walk, so nothing goes in partly read; one gone since it was listed doesn't."""
    if not isinstance(error, FileNotFoundError):
        raise error


def products_add(tar, work, local=None):
    """Each product's backup/ folder as products/<slug>/..., unfinished copies and their SQLite sidecars left out, while every product's together, each
    compressed on its own, stay within PRODUCTS_MAX_BYTES. A product whose copies can't be found or read, or don't fit, is left out
    whole and HQ's backup goes on. Returns the manifest's figures ({slug: files and bytes}) and what was left out, and why.
    local: a folder of <slug>/ folders instead of Docker's volumes (infra/test_backup.py)."""
    figures, left = {}, []
    try:
        volumes = {slug: f'{local}/{slug}' for slug in sorted(os.listdir(local))} if local else product_volumes()
    except Exception as e:   # no product's copies tonight, never a failed night
        log(f'products: {type(e).__name__}: {e}'[:500])
        return figures, [str(e) if isinstance(e, Stop) else "Docker's volumes not listed"]
    room = PRODUCTS_MAX_BYTES
    for slug, place in volumes.items():
        staging = f'{work}/product-{slug}.tar.gz'
        try:
            path = place if local else volume(place.removeprefix('infra_'))
            product_figures = stage_product(path, slug, staging, room)
        except Exception as e:   # one product's copies, never the night
            with contextlib.suppress(FileNotFoundError):
                os.remove(staging)
            left.append(product_left(slug, e, room))
            continue
        if product_figures is None:
            continue   # it keeps no copies
        room -= os.path.getsize(staging)
        with tarfile.open(staging, 'r:gz') as copies:
            for member in copies:
                tar.addfile(member, copies.extractfile(member) if member.isreg() else None)
        os.remove(staging)
        figures[slug] = product_figures
    return figures, left


def product_volumes():
    """Each product's own data volume, {slug: its Docker name}: excludes a live product's separate preview door."""
    out = subprocess.run(['docker', 'volume', 'ls', '--format', '{{.Name}}'], capture_output=True, text=True, timeout=60)
    if out.returncode:
        raise Stop("Docker's volumes not listed")
    volume_names = {}
    for volume_name in sorted(out.stdout.split()):
        volume_match = PRODUCT_VOLUME.fullmatch(volume_name)
        if volume_match is None:
            continue
        volume_names[volume_match[1]] = volume_name
    return volume_names


def stage_product(path, slug, staging, room):
    """The product's backup/ folder, compressed into staging (in the night's work folder, beside the database's plaintext
    copy) before any of it goes in the archive: its figures, or None if it keeps no copies. Each file is opened once and
    read to the size it had then, so a copy renamed into place meanwhile waits for the next night. Raises PastRoomError
    before staging exceeds room."""
    try:
        top_fd = open_dir(path)
    except OSError:
        raise Stop(f"{slug}'s volume not opened")
    try:
        copies_fd = open_dir('backup', dir_fd=top_fd)
    except FileNotFoundError:
        return None
    except OSError:
        raise Stop(f"{slug}'s backup/ is not plain folders (a symlink?)")
    finally:
        os.close(top_fd)
    try:
        if room is None:
            raise Stop("company/infra.env's BACKUP_PRODUCTS_MB isn't a whole number of MB")
        with open(staging, 'wb') as raw:
            with tarfile.open(fileobj=Capped(raw, room), mode='w|gz', format=tarfile.PAX_FORMAT) as staging_tar:
                files, size = add_tree(staging_tar, copies_fd, f'products/{slug}', left_out=UNFINISHED)
    finally:
        os.close(copies_fd)
    return {'files': files, 'bytes': size}


def product_left(slug, error, room):
    """Why a product's copies aren't in tonight's archive, for the board."""
    if isinstance(error, PastRoomError):
        log(f"{slug}'s backup/ left out: past the {room / 1e6:.1f} MB of the products' room left")
        return f"{slug}'s copies would exceed the products' combined {PRODUCTS_MAX_BYTES / 1e6:.0f} MB allowance"
    log(f'{slug}: {type(error).__name__}: {error}'[:500])
    return str(error) if isinstance(error, Stop) else f"{slug}'s copies not read ({type(error).__name__})"


def db_copy(dest, local_db=None):
    """A consistent copy of the live HQ database into dest, checked, without the search index (DERIVED), with its row
    counts and each table's bytes, its indexes included (SQLite's dbstat)."""
    cmd = ['node', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', COPY_JS]
    cmd = cmd + [local_db] if local_db else COMPOSE + ['exec', '-T', 'coordinator'] + cmd + ['/data/hq.db']
    with open(dest, 'wb') as out:
        # (compose.yaml finds the server's env file by SERVER_NAME)
        r = subprocess.run(cmd, stdout=out, stderr=subprocess.PIPE, timeout=1800, env={**os.environ, 'SERVER_NAME': NAME})
    if r.returncode:
        raise Stop(f'the database copy failed: {r.stderr.decode(errors="replace").strip()[-300:]}')
    con = sqlite3.connect(dest)
    try:
        con.execute('pragma trusted_schema = off')   # the schema is the coordinator's: none of its views or triggers run here
        con.execute('pragma journal_mode = delete')   # one self-contained file
        check = con.execute('pragma integrity_check').fetchone()[0]
        if check != 'ok':
            raise Stop(f'the database copy failed its integrity check: {check[:200]}')
        for t in DERIVED:   # (the coordinator makes it again; the copy is ours alone, never the live file)
            con.execute(f'drop table if exists {ident(t)}')
        con.commit()
        con.execute('vacuum')   # their pages out of the file, not just freed
        tables = [r[0] for r in con.execute("select name from sqlite_schema where type = 'table' and name not like 'sqlite_%'"
                                            " and sql not like 'create virtual table%' order by name")]
        counts = {t: con.execute(f'select count(*) from {ident(t)}').fetchone()[0] for t in tables}
        sizes = dict(con.execute('select s.tbl_name, sum(d.pgsize) from dbstat d join sqlite_schema s on s.name = d.name'
                                 ' group by s.tbl_name order by 2 desc'))
    finally:
        con.close()
    return counts, sizes


def ident(name):
    """A table name from the database (the coordinator's, or a backup's manifest) as a quoted SQL identifier."""
    return '"' + name.replace('"', '""') + '"'


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


# ---- the repo: every branch and tag, as a git bundle (a full one, or what's new since the night before)

def git(repo, *args, stdin=None, timeout=1800):
    """git on a repo only root writes (or none, for a clone), with no system or user config and no hooks."""
    env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull,
           'GIT_TERMINAL_PROMPT': '0', 'LC_ALL': 'C', 'HOME': os.devnull}
    return subprocess.run(['git', *(['--git-dir', repo] if repo else []), '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', *args],
                          input=stdin, capture_output=True, text=True, errors='surrogateescape', env=env, timeout=timeout)


def git_error(r):
    lines = r.stderr.strip().splitlines()
    return next((l for l in lines if l.startswith(('fatal:', 'error:'))), lines[-1] if lines else f'exit {r.returncode}')[:200]


def github():
    """The repo's address on GitHub, from the server's env file (sync.sh's REPO)."""
    with open(f'/etc/{NAME}/env') as f:
        repo = next((l.split('=', 1)[1].strip() for l in f if l.startswith('REPO=')), '')
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo):
        raise Stop(f'no REPO in /etc/{NAME}/env')
    return f'https://github.com/{repo}.git'


def repo_fetch(mirror, source):
    """Brings the server's mirror up to GitHub: every branch and tag, the deleted ones pruned. Returns why it failed, or None."""
    if not shutil.which('git'):
        return 'git is not installed on the server'
    if not os.path.exists(f'{mirror}/HEAD'):
        os.makedirs(mirror, mode=0o700, exist_ok=True)
        if git(mirror, 'init', '-q', '--bare').returncode:
            return "couldn't make the mirror"
    helper = ['-c', 'credential.helper=', '-c', f'credential.helper={CREDENTIAL}'] if source.startswith('https://') else []
    # (gc in the foreground: the unit's end would kill a detached one mid-way)
    r = git(mirror, *helper, '-c', 'transfer.fsckObjects=true', '-c', 'gc.autoDetach=false', 'fetch', '-q', '--prune', '--no-tags', source,
            '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*')
    return git_error(r) if r.returncode else None


def repo_refs(repo):
    r = git(repo, 'for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/tags')
    if r.returncode:
        raise Stop(f"couldn't list the repo's branches: {git_error(r)}")
    return {ref: sha for sha, ref in (l.split(' ', 1) for l in r.stdout.splitlines())}


def present(repo, shas):
    """The objects of shas that repo holds (one git run, however many branches there are)."""
    r = git(repo, 'cat-file', '--batch-check=%(objectname)', stdin=''.join(f'{s}\n' for s in shas))
    return {l for l in r.stdout.splitlines() if re.fullmatch(r'[0-9a-f]{40,64}', l)}   # a missing one is '<sha> missing'


def repo_part(mirror, work, key, chain, now, fetched, recipient, out):
    """The night's repo copy: a tar (repo.json, repo.bundle) streamed into age as out. A full bundle when there is no
    chain yet or its full one is REPO_FULL_DAYS old; otherwise only what's new since the last copy (its branch tips are
    the bundle's prerequisites), and no bundle at all when nothing is. repo.json holds every branch and tag as GitHub
    had them, and the copy it builds on, so the restore can put the chain back together."""
    refs = repo_refs(mirror)
    if not refs:
        raise Stop('the server has no copy of the repo yet (GitHub has never answered)')
    full = not chain or now - datetime.datetime.fromisoformat(chain['full_at']) >= datetime.timedelta(days=REPO_FULL_DAYS)
    # only tips the mirror still holds can be left out (a deleted branch's commits go in a later gc)
    have = [] if full else sorted(present(mirror, set(chain['refs'].values())))
    bundle = f'{work}/repo.bundle'
    r = git(mirror, 'bundle', 'create', '-q', bundle, '--branches', '--tags', '--stdin', stdin=''.join(f'^{s}\n' for s in have))
    if r.returncode and not (have and 'empty bundle' in r.stderr):
        raise Stop(f"couldn't bundle the repo: {git_error(r)}")
    meta = {'key': key, 'created': now.isoformat(timespec='seconds'), 'kind': 'full' if full else 'new since the last copy',
            'base': None if full else chain['key'], 'full_at': now.isoformat(timespec='seconds') if full else chain['full_at'],
            'github_at': fetched, 'refs': refs, 'bundle': r.returncode == 0}
    age = subprocess.Popen(['age', '-r', recipient, '-o', out], stdin=subprocess.PIPE)
    try:
        with tarfile.open(fileobj=age.stdin, mode='w|', format=tarfile.PAX_FORMAT) as tar:   # a bundle is compressed already
            m = json.dumps(meta, indent=1).encode()
            ti = tarfile.TarInfo('repo.json')
            ti.size, ti.mtime, ti.mode = len(m), int(now.timestamp()), 0o600
            tar.addfile(ti, io.BytesIO(m))
            if meta['bundle']:
                with open(bundle, 'rb') as f:
                    tar.addfile(tar.gettarinfo(bundle, 'repo.bundle'), f)
    finally:
        age.stdin.close()
        code = age.wait(timeout=600)
    if code:
        raise Stop('age failed to encrypt the repo')
    if meta['bundle']:
        os.remove(bundle)
    return meta


def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


# ---- R2 over its S3 API: AWS Signature Version 4, region "auto"

def quote(s):
    return urllib.parse.quote(s, safe='-_.~')


def sign(method, url, headers, payload_hash, key_id, secret, region='auto', now=None):
    """The headers for a signed request (SigV4, as in AWS's S3 examples). The secret only ever goes into the HMAC."""
    u = urllib.parse.urlsplit(url)
    amz = (now or datetime.datetime.now(datetime.timezone.utc)).strftime('%Y%m%dT%H%M%SZ')
    h = {k.lower(): ' '.join(str(v).split()) for k, v in headers.items()}
    h.update({'host': u.netloc, 'x-amz-date': amz, 'x-amz-content-sha256': payload_hash})
    query = '&'.join(f'{quote(k)}={quote(v)}' for k, v in sorted(urllib.parse.parse_qsl(u.query, keep_blank_values=True)))
    names = sorted(h)
    canonical = '\n'.join([method, u.path or '/', query, ''.join(f'{k}:{h[k]}\n' for k in names), ';'.join(names), payload_hash])
    scope = f'{amz[:8]}/{region}/s3/aws4_request'
    to_sign = '\n'.join(['AWS4-HMAC-SHA256', amz, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    k = ('AWS4' + secret).encode()
    for part in (amz[:8], region, 's3', 'aws4_request', to_sign):
        k = hmac.new(k, part.encode(), hashlib.sha256).digest()
    h['authorization'] = f'AWS4-HMAC-SHA256 Credential={key_id}/{scope}, SignedHeaders={";".join(names)}, Signature={k.hex()}'
    return h


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):   # urllib would carry the signed Authorization header to wherever it points
        return None


OPENER = urllib.request.build_opener(NoRedirect)


# (Endpoint, other_jurisdiction, R2's other and find)
Endpoint = collections.namedtuple('Endpoint', 'url jurisdiction')


def other_jurisdiction(base):
    """The same account's R2 endpoint in the other jurisdiction (EU's, .eu., for the default one, and back); None for any
    other host (FedRAMP's, a local one)."""
    m = re.fullmatch(r'https://([0-9a-f]{32})(\.eu)?\.r2\.cloudflarestorage\.com', base)
    if not m:
        return None
    return Endpoint(f'https://{m[1]}.r2.cloudflarestorage.com', 'default') if m[2] else Endpoint(f'https://{m[1]}.eu.r2.cloudflarestorage.com', 'EU')


class R2:
    def __init__(self, endpoint, key_id, secret, other=None):
        """other: the Endpoint find() asks when the bucket is denied, by default the other jurisdiction's."""
        u = urllib.parse.urlsplit(endpoint)
        self.base, self.bucket = f'{u.scheme}://{u.netloc}', u.path.strip('/') or BUCKET
        self.key_id, self.secret = key_id, secret
        self.other = other or other_jurisdiction(self.base)

    def request(self, method, key='', params=None, body=None, size=0, payload_hash=None, stream=False):
        query = '&'.join(f'{quote(k)}={quote(v)}' for k, v in sorted((params or {}).items()))
        url = f'{self.base}/{self.bucket}' + (f'/{urllib.parse.quote(key, safe="/-_.~")}' if key else '') + (f'?{query}' if query else '')
        payload_hash = payload_hash or hashlib.sha256(b'').hexdigest()
        headers = {'content-length': str(size), 'content-type': 'application/octet-stream'} if method == 'PUT' else {}
        req = urllib.request.Request(url, data=body, method=method, headers=sign(method, url, headers, payload_hash, self.key_id, self.secret))
        for attempt in range(4):
            try:
                res = OPENER.open(req, timeout=300)
                return res if stream else (res.status, res.read())
            except urllib.error.HTTPError as e:
                if e.code == 404 and method in ('HEAD', 'GET') and key:   # an object that isn't there (not the bucket)
                    return None if stream else (404, b'')
                detail = re.search(rb'<Code>([^<]{1,80})</Code>', e.read() or b'')
                if e.code < 500 and e.code != 429:   # (config, code)
                    code = detail.group(1).decode() if detail else None
                    setup = e.code in (401, 403, 404) and code != 'RequestTimeTooSkewed'   # the token or the bucket, not a clock
                    raise Stop(f'R2 said {e.code}{" " + code if code else ""} to {method} {key or f"the bucket {self.bucket}"}', config=setup, code=code)
                why = f'{e.code}'
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                why = type(e).__name__
            if attempt == 3:
                raise Stop(f'R2 unreachable ({why}) for {method} {key or "the bucket"}')
            if body is not None and hasattr(body, 'seek'):
                body.seek(0)
            time.sleep(5 * 3 ** attempt)

    def put(self, key, path):
        size, digest = os.path.getsize(path), sha256_file(path)
        with open(path, 'rb') as f:
            self.request('PUT', key, body=f, size=size, payload_hash=digest)   # R2 checks the body against the hash
        return size, digest

    def exists(self, key):
        return self.request('HEAD', key)[0] == 200

    def delete(self, key):
        self.request('DELETE', key)

    def fetch_hash(self, key):
        """The object's sha256, read whole. A body cut short is asked for again, as request() does a 5xx: http.client ends
        a read early without an error when the connection drops, which would look like an object that doesn't match.
"""
        for attempt in range(4):
            res = self.request('GET', key, stream=True)
            if res is None:
                return None
            h, n = hashlib.sha256(), 0
            try:
                with res:
                    for chunk in iter(lambda: res.read(1 << 20), b''):
                        h.update(chunk)
                        n += len(chunk)
                if n == int(res.headers.get('content-length') or n):
                    return h.hexdigest()
                why = f'cut short at {n} bytes'
            except (http.client.HTTPException, TimeoutError, ConnectionError) as e:
                why = type(e).__name__
            if attempt == 3:
                raise Stop(f'R2 unreachable ({why}) for GET {key}')
            time.sleep(5 * 3 ** attempt)

    def find(self):
        """The night's first request, the bucket's listing. A bucket lives in one jurisdiction, and a token for that
        bucket alone is denied at the other's endpoint as if the bucket weren't its: so on a 403 AccessDenied the other
        endpoint is asked once, only to name the fix. The night fails either way: nothing goes where nobody set it."""
        try:
            return self.listing()
        except Stop as e:
            if e.code != 'AccessDenied' or not self.other:
                raise
            where = f"the {self.other.jurisdiction} jurisdiction's endpoint"
            here, self.base = self.base, self.other.url
            try:
                self.listing()
            except Stop as again:
                if not again.config:   # the other endpoint's 5xx or network failure says nothing about the token: R2's first answer stands
                    raise e
                if again.code == 'AccessDenied':
                    raise Stop(f"{e}, and at {where} too: the token isn't one for this bucket (another bucket's or account's, "
                               f"or the bucket's name differs)", config=True, code=e.code)
                raise Stop(f'{e}; at {where}: {again}', config=True, code=e.code)
            finally:
                self.base = here
            raise Stop(f"{e}, but it answers at {where}: BACKUP_R2_ENDPOINT isn't the bucket's", config=True, code=e.code)

    def listing(self):
        """Every object: {key: (size, last modified)}."""
        out, token = {}, None
        while True:
            params = {'list-type': '2', **({'continuation-token': token} if token else {})}
            _, xml = self.request('GET', params=params)
            root = ET.fromstring(xml)
            ns = root.tag[:root.tag.index('}') + 1] if root.tag.startswith('{') else ''
            for c in root.iter(f'{ns}Contents'):
                out[c.findtext(f'{ns}Key')] = (int(c.findtext(f'{ns}Size') or 0), c.findtext(f'{ns}LastModified'))
            token = root.findtext(f'{ns}NextContinuationToken')
            if root.findtext(f'{ns}IsTruncated') != 'true' or not token:
                return out


# ---- the 7-year records: each mail to invoices@ or documents@, once, as its own object

def record_name(keep, received, mail_id):
    """invoices-2026-10-03T101500-12: the time it came (UTC, to the second) and its id. The id alone isn't the mail's for
    good: mail.ts no longer gives a deleted mail's id out again, but before its AUTOINCREMENT rebuild SQLite gave the newest
    row's id to the next mail once that row was deleted, so a record from then may share its id with a later mail."""
    return f'{keep}-{received[:19].replace(":", "")}-{mail_id}'


def record_key(keep, received, mail_id):
    return f'records/{keep}/{record_name(keep, received, mail_id)[len(keep) + 1:]}.tar.gz.age'


def record_expired(key, now):
    """An invoice's copy past INVOICE_DAYS (the day it came is in its name); an agreement's never."""
    m = re.fullmatch(r'records/invoices/(\d{4}-\d{2}-\d{2})T\d{6}-\d+\.tar\.gz\.age', key)
    return bool(m) and datetime.datetime.fromisoformat(m.group(1) + 'T00:00:00+00:00') < now - datetime.timedelta(days=INVOICE_DAYS + 1)


def read_mail_file(hq_fd, mail_id, n):
    """An attachment's bytes, DATA_DIR/mail/<id>/<n>, opened by fd without following a link; None if it isn't there."""
    try:
        d = open_dir(f'mail/{mail_id}', dir_fd=hq_fd)
    except (FileNotFoundError, NotADirectoryError):
        return None
    except OSError:
        return None   # a symlink where the folder should be: not a file HQ stored
    try:
        fd = os.open(str(n), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=d)
    except OSError:
        return None
    finally:
        os.close(d)
    with os.fdopen(fd, 'rb') as f:
        return f.read() if stat.S_ISREG(os.fstat(f.fileno()).st_mode) else None


def records_due(con, now):
    """The mail HQ keeps for years (its keep column), as {key: (mail id, received)}. An invoice past INVOICE_DAYS isn't
    due any more (HQ deletes it too). A database from before the column has none."""
    if 'keep' not in {r[1] for r in con.execute('pragma table_info(mail)')}:
        return {}
    due = {}
    for mail_id, received, keep in con.execute("select id, received, keep from mail where keep in ('invoices', 'documents') order by id"):
        if re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*', str(received)) and not record_expired(key := record_key(keep, received, mail_id), now):
            due[key] = (mail_id, received)
    return due


def record_part(row, hq_fd, recipient, out, now):
    """One mail as a tar.gz streamed into age: mail.json (who, when, what, and each file's sha256), message.eml (the raw
    message as it came, when HQ kept it) and attachments/<n>-<name>, byte for byte as HQ holds them."""
    mail_id, received, sender, to, subject, attachments, raw, keep = row
    try:
        listed = json.loads(attachments or '[]')
    except ValueError:
        listed = []
    files, meta_files = [], []
    for n, a in enumerate(listed if isinstance(listed, list) else []):
        name = str(a.get('name', 'attachment') if isinstance(a, dict) else a)
        body = read_mail_file(hq_fd, mail_id, n) if isinstance(a, dict) else None
        if body is None:
            meta_files.append({'n': n, 'name': name, 'stored': False})   # HQ kept its name only (storage full, or before job #1228)
            continue
        safe = (re.sub(r'[^A-Za-z0-9._-]+', '-', name).lstrip('.-')[:80]) or 'attachment'
        path = f'attachments/{n}-{safe}'
        files.append((path, body))
        meta_files.append({'n': n, 'name': name, 'type': a.get('type'), 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest(), 'file': path})
    raw = bytes(raw) if raw is not None else None
    meta = {'mail': mail_id, 'received': received, 'sender': sender, 'recipient': to, 'subject': subject, 'kept_as': keep,
            'copied': now.isoformat(timespec='seconds'), 'attachments': meta_files,
            'raw': {'file': 'message.eml', 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()} if raw is not None else None}
    if raw is None:
        # (a file the board filed from a desk-phone card)
        meta['raw_missing'] = ('HQ kept no raw copy of this message (over 2 MB before job #1316, or no room for it), '
                               'or it has none: a file the board filed from a desk-phone card is its own record')
    else:
        files.insert(0, ('message.eml', raw))
    age = subprocess.Popen(['age', '-r', recipient, '-o', out], stdin=subprocess.PIPE)
    try:
        with tarfile.open(fileobj=age.stdin, mode='w|gz', format=tarfile.PAX_FORMAT) as tar:
            for path, body in [('mail.json', json.dumps(meta, indent=1, ensure_ascii=False).encode())] + files:
                ti = tarfile.TarInfo(path)
                ti.size, ti.mtime, ti.mode = len(body), int(now.timestamp()), 0o600
                tar.addfile(ti, io.BytesIO(body))
    finally:
        age.stdin.close()
        code = age.wait(timeout=600)
    if code:
        raise Stop(f'age failed to encrypt mail #{mail_id}')


def records_build(db, hq_fd, work, recipient, listing, now, status, room):
    """Encrypts each record that isn't in the bucket yet, while the database copy is still here (reading only those
    mails' raw messages), until the next wouldn't fit tonight (records_room): the rest waits, and isn't written to the
    disk every night for nothing. Returns what's due {key: received} and what's built [(key, path)]; the status says
    what's due (records_pending, and records_since: since when the oldest has been)."""
    con = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    try:
        con.execute('pragma trusted_schema = off')
        due = {key: v for key, v in records_due(con, now).items() if key not in listing}
        built, held, up = [], records_held(listing), 0
        os.makedirs(f'{work}/records', mode=0o700, exist_ok=True)
        for key, (mail_id, _) in due.items():
            row = con.execute('select id, received, sender, recipient, subject, attachments, raw, keep from mail where id = ?', (mail_id,)).fetchone()
            out = f'{work}/records/{mail_id}.age'
            try:
                record_part(row, hq_fd, recipient, out, now)
            except Stop as e:
                status['records_error'] = str(e)
                continue
            size = os.path.getsize(out)
            full = records_room(key, held + up, size, up, room)
            if full:
                os.remove(out)
                status['records_error'] = full
                break
            built.append((key, out))
            up += size
    finally:
        con.close()
    due = {key: received for key, (_, received) in due.items()}
    pending(status, due)
    return due, built


def pending(status, due):
    """records_since: since when the oldest record still to go (or still to read back: records_unverified) has been due
    off the server: when it came, or when the copy first ran (the board's keys), whichever is later, so the records
    already in HQ that night aren't overdue."""
    first = datetime.datetime.fromisoformat(status.setdefault('records_first', status['tried_at']))
    due = {**due, **{k: v['received'] for k, v in (status.get('records_unverified') or {}).items()}}
    since = min((max(datetime.datetime.fromisoformat(r.replace('Z', '+00:00')), first) for r in due.values()), default=None)
    status.update(records_pending=len(due), records_since=since and since.isoformat(timespec='seconds'))


def records_held(listing):
    return sum(size for k, (size, _) in listing.items() if k.startswith('records/'))


def records_room(key, held, size, up, room):
    """Why a record of size bytes can't go tonight, with held bytes in records/ and up of room (the free tier's) taken."""
    if held + size > RECORDS_MAX:
        return f'not uploaded: {key} would take the records past their 2 GB (a flood of mail to invoices@ or documents@?)'
    if up + size > room:
        return f"not uploaded: {key} would take the records past {LIMIT} (with next month's database backups)"
    return None


def records_expire(r2, listing, now):
    """Deletes the invoices' copies past INVOICE_DAYS (the lock let them go long before) and takes them out of the
    listing. First thing in the night's records, so whatever stops an upload never keeps them, and their room is free."""
    for key in sorted(listing):
        if key.startswith('records/') and record_expired(key, now):
            r2.delete(key)
            del listing[key]
            log(f'{key}: past its {INVOICE_DAYS} days, deleted')


def records_copy(r2, due, built, listing, status, room):
    """Reads back the records whose read-back failed on an earlier night (records_unverified: they can't be put again,
    the lock, so they stay due until they match), then uploads tonight's, each read back whole. room: the bytes the free
    tier has left. Returns the bytes uploaded even when something stops it (records_error says what): the repo's copy
    checks its reserve against a bucket that holds them. A PUT that failed counts too: R2 may have kept it."""
    held, up = records_held(listing), 0
    unverified = status.setdefault('records_unverified', {})
    try:
        for key, v in list(unverified.items()):
            if key not in listing or r2.fetch_hash(key) == v['sha256']:   # gone (and built again from HQ), or it's whole
                del unverified[key]
        for key, path in built:
            size = os.path.getsize(path)
            full = records_room(key, held, size, up, room)
            if full:
                raise Stop(full)
            held, up = held + size, up + size
            size, digest = r2.put(key, path)
            unverified[key] = {'sha256': digest, 'received': due.pop(key)}   # (until it reads back: R2 may not answer)
            os.remove(path)
            if r2.fetch_hash(key) != digest:
                raise Stop(f'{key} did not read back the same from R2')
            del unverified[key]
    except Exception as e:
        status['records_error'] = str(e) if isinstance(e, Stop) else f'{type(e).__name__} in the records\' copy'
        if not isinstance(e, Stop):
            log(f'records: {type(e).__name__}: {e}'[:500])
        return up
    finally:
        pending(status, due)
    if not status['records_pending']:
        status['records_ok_at'] = status['tried_at']
    return up


def records_warn(status, now):
    """A heads-up once a record has been due off the server for RECORDS_STALE. The text changes only with the date of the
    oldest one, so the board hears it once (backup.ts), not every night."""
    since = status.get('records_since')
    if since and (now - datetime.datetime.fromisoformat(since)).total_seconds() > RECORDS_STALE:
        return f'invoices or agreements due off the server since {since[:10]} aren\'t copied yet'
    return None


# ---- the renders: every film and track a job pushed (the worker's store), once, as its own object

class RenderCapacityError(Stop):
    """No room tonight for the next render: it and the rest wait for the next night."""


def renders_copy(r2, store_fd, work, recipient, listing, status, room, save):
    """Copies renders within their cap and tonight's room, using the current listing. Save each digest before PUT so
    interrupted uploads can be read back later. Invalid files are shown. Returns uploaded bytes even if read-back fails.
    renders_ok_at moves only when every render in the store is in the bucket and read back."""
    held = sum(size for k, (size, _) in listing.items() if k.startswith('renders/'))
    unverified = status.setdefault('renders_unverified', {})
    due, done, up, complete = [], set(), 0, False
    cap = renders_max()   #.
    def fits(size):
        if cap is None:
            raise RenderCapacityError("not uploaded: company/infra.env's BACKUP_RENDERS_GB isn't a whole number of GB")
        if held + up + size > cap:
            raise RenderCapacityError(f"not uploaded: the renders would pass their {cap / 1e9:.0f} GB (BACKUP_RENDERS_GB)")
        if up + size > room:
            raise RenderCapacityError(f"not uploaded: the renders would take the bucket past {LIMIT} (with next month's database backups)")
    try:
        names = renders_list(store_fd)
        due = sorted(n for n in names if re.fullmatch(r'[0-9a-f]{64}', n) and render_key(n) not in listing)
        renders_reread(r2, listing, unverified, status)
        os.makedirs(f'{work}/renders', mode=0o700, exist_ok=True)
        for sha in due:
            key, out = render_key(sha), f'{work}/renders/{sha}.age'
            try:
                why = render_part(store_fd, sha, recipient, out, fits)
                if why is None:
                    fits(os.path.getsize(out))
                    unverified[key] = sha256_file(out)
                    save()
                    size, digest = r2.put(key, out)
                    up += size   # (counted before the read-back: R2 may have kept it)
                    if r2.fetch_hash(key) == digest:
                        del unverified[key]
                    else:   # read back the nights after (renders_reread), while the rest still go
                        why = f'{key} did not read back the same from R2'
            except RenderCapacityError as e:   # tonight's room is used up: the rest wait too
                status['renders_error'] = str(e)
                break
            finally:
                with contextlib.suppress(FileNotFoundError):
                    os.remove(out)
            if why:
                status['renders_error'] = why
            else:
                done.add(key)
        complete = True
    except Exception as e:
        status['renders_error'] = str(e) if isinstance(e, Stop) else f'{type(e).__name__} in the renders\' copy'
        if not isinstance(e, Stop):
            log(f'renders: {type(e).__name__}: {e}'[:500])
    pending = ({render_key(n) for n in due} - done) | set(unverified)
    status['renders_pending'] = len(pending)
    if complete and not pending:
        status['renders_ok_at'] = status['tried_at']
    return up


def renders_list(store_fd):
    listed = os.open('.', os.O_RDONLY | os.O_DIRECTORY, dir_fd=store_fd)   # an O_PATH folder can't be listed
    try:
        return os.listdir(listed)
    finally:
        os.close(listed)


def renders_reread(r2, listing, unverified, status):
    for key, digest in list(unverified.items()):
        if key not in listing or r2.fetch_hash(key) == digest:   # its PUT never landed, or it is whole
            del unverified[key]
        else:
            status['renders_error'] = f'{key} did not read back the same from R2'


def render_part(store_fd, sha, recipient, out, fits):
    """One render from the store, streamed into age as out. Returns None once it's there, else why it's left out: gone
    since the listing (''), not a plain file of at most RENDER_MAX_BYTES, not the bytes its name's sha256 says, or past what
    fits(size) allows tonight (it raises RenderCapacityError)."""
    try:
        fd = os.open(sha, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=store_fd)
    except FileNotFoundError:
        return ''
    except OSError:
        return f'renders/{sha[:12]}… in the store is not a plain file'
    h = hashlib.sha256()
    with os.fdopen(fd, 'rb') as f:
        st = os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode):
            return f'renders/{sha[:12]}… in the store is not a plain file'
        if st.st_size > RENDER_MAX_BYTES:
            return f'renders/{sha[:12]}… in the store is bigger than any render'
        fits(st.st_size)
        age = subprocess.Popen(['age', '-r', recipient, '-o', out], stdin=subprocess.PIPE)
        try:
            for block in iter(lambda: f.read(1 << 20), b''):
                h.update(block)
                age.stdin.write(block)
        finally:
            age.stdin.close()
            code = age.wait(timeout=600)
    if code:
        raise Stop(f'age failed to encrypt {render_key(sha)}')
    return None if h.hexdigest() == sha else f'renders/{sha[:12]}… in the store is not the render its name says'


def render_key(sha):
    return f'renders/{sha}.age'


def renders_warn(status, now):
    """A heads-up once the renders haven't all been in the bucket and read back for RENDERS_STALE_SECONDS: since the last
    night they were, or the first try. Whatever kept them (one waiting for room, the store or the bucket unreadable, the
    unit stopped mid-way) counts the same, and the text changes only with that date, so the board hears it once."""
    since = status.get('renders_ok_at') or status.get('renders_since')
    if since and (now - datetime.datetime.fromisoformat(since)).total_seconds() > RENDERS_STALE_SECONDS:
        return f'the renders haven\'t all been copied off the server since {since[:10]}'
    return None


# ---- the big files: each once, as its own object (BigFiles), named by the nights' manifests.

def big_files_copy(r2, big_files, status):
    """Tonight's new big files, each uploaded and read back before the archive that names them goes. Each is due a read-back
    (big_files_unverified) from before its upload until one matches, so a night cut short after an upload, or one that
    doesn't read back the same, is read back the nights after (big_files_reread); the board hears meanwhile."""
    unverified = status.setdefault('big_files_unverified', {})
    for key, path in big_files.new.items():
        unverified[key] = sha256_file(path)
        r2.put(key, path)
        if r2.fetch_hash(key) == unverified[key]:
            del unverified[key]
        else:
            status['big_files_error'] = f'{key} did not read back the same from R2'
        os.remove(path)


def big_files_reread(r2, listing, status):
    """The big files not read back the same on an earlier night (or not read back at all), read back again. One not in
    the listing never landed: it is dropped, and made again tonight if its file is still on the server."""
    unverified = status.get('big_files_unverified') or {}
    for key, digest in list(unverified.items()):
        if key not in listing or r2.fetch_hash(key) == digest:
            del unverified[key]
        else:
            status['big_files_error'] = f'{key} did not read back the same from R2'


def big_files_expire(r2, listing, big_files, now):
    """Deletes each big file's object no backup has named for BIG_FILE_DAYS: by then every backup naming it has expired
    too (the monthly copies keep a year). Tonight's are named by tonight's archive, so they never go. When each was last
    named is kept in big-files-seen.json, written before anything is deleted; an object it doesn't know (a new server's
    state) counts from the first night that sees it, so a lost state never deletes one a kept backup may still name.
    Deleted objects leave listing."""
    path, stamp = f'{STATE}/big-files-seen.json', now.isoformat(timespec='seconds')
    seen = load(path) or {}
    seen.update({entry['object']: stamp for entry in big_files.entries})
    held = [key for key in listing if BIG_FILE_KEY.fullmatch(key)]
    for key in held:
        seen.setdefault(key, stamp)

    def save():
        with open(f'{path}.new', 'w') as f:
            json.dump({key: t for key, t in seen.items() if key in listing}, f)
        os.replace(f'{path}.new', path)
    save()
    for key in sorted(held):
        if (now - datetime.datetime.fromisoformat(seen[key])).days >= BIG_FILE_DAYS:
            r2.delete(key)
            del listing[key]
    save()


# ---- the nightly run

def write_status(status, hqdata_fd):
    """status.json for report.sh (root's) and backup-status.json in the coordinator's volume for backup.ts. The
    volume is the coordinator's to write, so the file goes in under a fresh name (O_EXCL) and is renamed over."""
    text = json.dumps(status, indent=1, sort_keys=True).encode()
    os.makedirs(STATE, mode=0o700, exist_ok=True)
    with open(f'{STATE}/status.json.new', 'wb') as f:
        f.write(text)
    os.replace(f'{STATE}/status.json.new', f'{STATE}/status.json')
    if hqdata_fd is None:
        return
    try:
        into_volume(text, hqdata_fd)
    except OSError as e:
        log(f"couldn't leave the status for the coordinator: {type(e).__name__}")


# (app_errors.py leaves its file the same way)
def into_volume(text, hqdata_fd, name='backup-status.json'):
    tmp = f'.{name}.{os.getpid()}.{time.time_ns()}'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=hqdata_fd)
    os.fchmod(fd, 0o644)  # the unit's UMask=0077 would leave it 0600, root's: the coordinator (node) couldn't read it
    with os.fdopen(fd, 'wb') as f:
        f.write(text)
    os.rename(tmp, name, src_dir_fd=hqdata_fd, dst_dir_fd=hqdata_fd)


def previous():
    try:
        with open(f'{STATE}/status.json') as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def run(opts):
    global STATE
    STATE = opts.get('state') or STATE
    now = datetime.datetime.now(datetime.timezone.utc)
    last = previous()
    status = {k: v for k, v in last.items() if k.startswith(('ok_', 'bucket_', 'repo_', 'records_', 'renders_', 'big_files_'))}
    status.update(tried_at=now.isoformat(timespec='seconds'), state='failed', error=None, warn=None, repo_error=None, repo_warn=None,
                  records_error=None, records_warn=None, renders_error=None, products_error=None, config_error=None, big_files_error=None)
    hq_fd = voice_fd = seats_fd = None
    work = f'{STATE}/work'
    try:
        hq_fd = open_dir(opts.get('hqdata') or volume('hqdata'))
        # a skipped line would leave nothing out, so it stops the night instead
        if 'BACKUP_LEFT_OUT' in SKIPPED:
            raise Stop("company/infra.env's BACKUP_LEFT_OUT isn't a plain KEY=value line, so nothing is uploaded until it's fixed")
        if 'BACKUP_BUCKET_GB' in SKIPPED or (BUCKET_SETTING and not BUCKET_GB_VALID):   # never the free tier in its place
            raise Stop("company/infra.env's BACKUP_BUCKET_GB isn't a whole number of GB, so nothing is uploaded until it's fixed")
        secrets_fd = None
        try:
            secrets_fd = open_dir('secrets', dir_fd=hq_fd)
            keys = {n: read_key(secrets_fd, n) for n in KEYS}
        except FileNotFoundError:
            keys = {}
        finally:
            if secrets_fd is not None:
                os.close(secrets_fd)
        if not shutil.which('age'):
            raise Stop('age is not installed on the server (harden.sh installs it)')
        missing = [n for n in KEYS if not keys.get(n)]
        if missing:
            status.update(state='waiting for the board', error=f'not set up yet: {", ".join(missing)} missing from the key store')
            return status
        voice_fd = open_dir(opts.get('voice') or volume('voice'))
        seats_fd = open_dir(opts.get('seats') or volume('seats'))

        shutil.rmtree(work, ignore_errors=True)   # a plaintext copy never outlives its run, not even a crashed one
        os.makedirs(work, mode=0o700)
        os.chmod(STATE, 0o700)
        start = time.time()
        r2 = R2(keys['BACKUP_R2_ENDPOINT'], keys['BACKUP_R2_ACCESS_KEY_ID'], keys['BACKUP_R2_SECRET_ACCESS_KEY'])
        before = r2.find()   # the night's first request: the big files already there aren't made again, and the size check
        big_files_reread(r2, before, status)
        big_files = BigFiles(work, keys['BACKUP_AGE_RECIPIENT'], before)
        db = f'{work}/hq.db'
        counts, sizes = db_copy(db, opts.get('local_db'))
        manifest = {'created': now.isoformat(timespec='seconds'), 'commit': commit(), 'hq_db_sha256': sha256_file(db),
                    'hq_db_bytes': os.path.getsize(db), 'tables': counts}

        name = now.strftime('%Y-%m-%dT%H%M%SZ') + '.tar.gz.age'
        out = f'{work}/{name}'
        age = subprocess.Popen(['age', '-r', keys['BACKUP_AGE_RECIPIENT'], '-o', out], stdin=subprocess.PIPE)
        try:   # (if anything fails mid-way, closing stdin below lets age finish, and the error still ends the night)
            tally = Tally(age.stdin)   # (what each part of tonight's archive weighs: the status's ok_parts)
            with tarfile.open(fileobj=tally, mode='w|gz', format=tarfile.PAX_FORMAT) as tar:
                tally.part('database', os.path.getsize(db))
                with open(db, 'rb') as f:
                    tar.addfile(tar.gettarinfo(db, 'hq/hq.db'), f)
                files = add_tree(tar, hq_fd, 'hq/data', skip=HQ_SKIPPED, left_out=LEFT_OUT, tally=tally, big_files=big_files)[0]
                files += add_tree(tar, voice_fd, 'voice', tally=tally)[0]
                try:
                    mem_fd = open_dir(MEMORY, dir_fd=seats_fd)
                except FileNotFoundError:
                    mem_fd = None
                    log('no shared Claude memory yet')
                except OSError:
                    raise Stop("the shared Claude memory's path is not plain folders (a symlink?)")
                if mem_fd is not None:
                    try:
                        files += add_tree(tar, mem_fd, 'memory', tally=tally)[0]
                    finally:
                        os.close(mem_fd)
                tally.part('products')
                manifest['products'], left = products_add(tar, work, opts.get('products'))
                files += sum(p['files'] for p in manifest['products'].values())
                tally.parts['products'].update(files=sum(p['files'] for p in manifest['products'].values()),
                                               raw=sum(p['bytes'] for p in manifest['products'].values()))
                status['products_error'] = '; '.join(left) or None
                manifest['big_files'] = big_files.entries   # each its own object (big_file_key)
                m = json.dumps(manifest, indent=1).encode()   # last, so it holds what went in
                tally.part('manifest', len(m))
                ti = tarfile.TarInfo('manifest.json')
                ti.size, ti.mtime, ti.mode = len(m), int(now.timestamp()), 0o600
                tar.addfile(ti, io.BytesIO(m))
        finally:
            age.stdin.close()
            code = age.wait(timeout=600)
        if code:
            raise Stop('age failed to encrypt the backup')

        month = f'monthly/{now:%Y-%m}.tar.gz.age'   # the first good backup of each month is also kept for a year
        new_bytes = sum(os.path.getsize(p) for p in big_files.new.values())   # the bucket lock means an upload can't be taken back: check the size first
        # The invoices' copies past INVOICE_DAYS go first (out of the listing too), then the records not in the bucket yet
        # are encrypted, from the database copy (nothing has left the server so far), as many as tonight has room for: the
        # free tier's, less the room the repo's copy keeps for next month's database backups. Whatever goes wrong with
        # them never costs the night its backup: it shows in the status, and as a heads-up once one has been due for
        # RECORDS_STALE. A build that fails keeps last night's figures, so what was due stays due.
        try:
            records_expire(r2, before, now)
        except Exception as e:
            status['records_error'] = str(e) if isinstance(e, Stop) else f'{type(e).__name__} deleting the records past their time'
            if not isinstance(e, Stop):
                log(f'records: {type(e).__name__}: {e}'[:500])
        try:   # the big files no backup has named for BIG_FILE_DAYS too, so their room counts tonight
            big_files_expire(r2, before, big_files, now)
        except Exception as e:
            status['big_files_error'] = str(e) if isinstance(e, Stop) else f'{type(e).__name__} deleting the big files past their time'
            if not isinstance(e, Stop):
                log(f'big files: {type(e).__name__}: {e}'[:500])
        after = sum(s for s, _ in before.values()) + os.path.getsize(out) * (1 if month in before else 2) + new_bytes
        room = FREE_BYTES - after - REPO_RESERVE * NEXT_NIGHT * os.path.getsize(out)
        due, built = None, []
        try:
            due, built = records_build(db, hq_fd, work, keys['BACKUP_AGE_RECIPIENT'], before, now, status, room)
        except Exception as e:
            status['records_error'] = str(e) if isinstance(e, Stop) else f'{type(e).__name__} in the records\' copy'
            status.setdefault('records_first', status['tried_at'])
            status['records_since'] = status.get('records_since') or status['tried_at']
            if not isinstance(e, Stop):
                log(f'records: {type(e).__name__}: {e}'[:500])
        os.remove(db)   # the plaintext copy goes before anything leaves the server
        if after > FREE_BYTES:   # a sudden jump (a huge file in a volume): the board hears and decides before the bill
            raise Stop(f'not uploaded: this backup ({os.path.getsize(out) / 1e9:.1f} GB) would take the bucket to '
                       f'{after / 1e9:.1f} GB, past {LIMIT}')
        big_files_copy(r2, big_files, status)   # before the archive that names them
        size, digest = r2.put(f'daily/{name}', out)
        if r2.fetch_hash(f'daily/{name}') != digest:   # read back what R2 holds: every byte, not just the length
            raise Stop('the uploaded backup did not read back the same from R2')
        if not r2.exists(month):
            r2.put(month, out)
        os.remove(out)   # the disk's room goes to the repo's bundle
        # The database's backup is in: the night is good whatever happens to the repo's copy, and the status says so
        # before the repo's work starts (git and the bundle are the night's longest minutes; the unit stopped then, by
        # its time limit or a reboot, ends the script without its finally). What it leaves is the status of a night
        # whose repo copy failed, heads-up included: a repo copy stopped every night still reaches the board after
        # REPO_STALE. The repo's copy, its own object next to the archive, can't cost the night: any failure shows in
        # the status, and becomes a heads-up for the board once there's been no good copy for REPO_STALE.
        status.update(state='ok', ok_at=status['tried_at'], ok_key=f'daily/{name}', ok_bytes=size, ok_sha256=digest,
                      ok_seconds=round(time.time() - start), ok_files=files + 1, ok_db_bytes=manifest['hq_db_bytes'],
                      ok_parts=tally.parts, ok_tables=dict(list(sizes.items())[:10]),   # (the 10 biggest)
                      ok_big_files={'files': len(big_files.entries), 'raw': sum(entry['size'] for entry in big_files.entries),
                                    'new': len(big_files.new), 'new_bytes': new_bytes})
        status.setdefault('repo_since', status['tried_at'])   # the first try: the 36 hours before a heads-up start here
        status.setdefault('renders_since', status['tried_at'])

        def unfinished(**errors):   # the status on disk while the night's later parts run: what the unit stopping leaves
            # tonight's figure leaves out what's still to go: last night's bucket, if bigger, keeps its heads-up in (and
            # in_progress tells backup.ts this is no all-clear), so the board doesn't hear the same heads-up again tonight
            write_status({**status, 'warn': warnings(status, max(after, status.get('bucket_bytes') or 0), now), 'repo_warn': repo_warn(status, now),
                          'records_warn': records_warn(status, now), **errors, 'in_progress': True}, hq_fd)
        renders_unfinished = {'renders_error': "the renders' copy didn't finish (the unit stopped mid-way?)"}
        unfinished(repo_error="the repo's copy didn't finish (the unit stopped mid-way?)", **renders_unfinished,
                   **({'records_error': "the records' copy didn't finish (the unit stopped mid-way?)"} if built else {}))
        if due is not None:   # the records before the repo: they're small, and the law wants them (none if the build failed)
            after += records_copy(r2, due, built, before, status, room)
        try:
            repo_copy(r2, opts, keys, now, work, status, after, size)
        except Exception as e:
            status['repo_error'] = str(e) if isinstance(e, Stop) else f'{type(e).__name__} in the repo\'s copy'
            if not isinstance(e, Stop):
                log(f'repo copy: {type(e).__name__}: {e}'[:500])
        # The renders go last because the repo keeps each one's recipe. A render failure never costs the night.
        # Keep a fallback total for when the store or the bucket listing cannot be read.
        after += (status.get('repo_bytes') or 0) if status.get('repo_ok_at') == status['tried_at'] else 0
        unfinished(**renders_unfinished)
        try:
            store_fd = open_dir(f"{opts.get('worker_work') or volume('work')}/{RENDERS}")
        except FileNotFoundError:
            store_fd = None
            status.update(renders_pending=0, renders_ok_at=status['tried_at'])   # no render made yet
        except (Stop, OSError) as e:
            store_fd = None
            status['renders_error'] = str(e) if isinstance(e, Stop) else "the renders' store is not plain folders (a symlink?)"
        if store_fd is not None:
            try:
                # Count the repo copy even if its upload could not be read back.
                bucket = r2.listing()
                after = sum(s for s, _ in bucket.values())
                after += renders_copy(r2, store_fd, work, keys['BACKUP_AGE_RECIPIENT'], bucket, status,
                                      FREE_BYTES - after - REPO_RESERVE * NEXT_NIGHT * size, lambda: unfinished(**renders_unfinished))
            except Stop as e:
                status['renders_error'] = f"not uploaded: the bucket's size not read ({e})"
            finally:
                os.close(store_fd)
        try:
            objects = r2.listing()
            total = sum(s for s, _ in objects.values())
            status.update(bucket_bytes=total, bucket_daily=sum(k.startswith('daily/') and k.endswith('.tar.gz.age') for k in objects),
                          bucket_repo=sum(k.startswith('daily/') and k.endswith('.repo.tar.age') for k in objects),
                          bucket_monthly=sum(k.startswith('monthly/') for k in objects), bucket_records=sum(k.startswith('records/') for k in objects),
                          bucket_renders=sum(k.startswith('renders/') for k in objects), bucket_big_files=sum(k.startswith('big-files/') for k in objects),
                          bucket_limit=FREE_BYTES)
        except Stop as e:   # the backup is in: the bucket's figures are last night's, and the report says why
            status['error'] = f'the bucket\'s size not read: {e}'
            total = after   # tonight's uploads: the listing before them, tonight's backup, the repo's copy if it went, the renders
        status.update(warn=warnings(status, total, now), repo_warn=repo_warn(status, now), records_warn=records_warn(status, now))
        return status
    except Stop as e:
        status['error'], status['config_error'] = str(e), e.config or None   # (backup.ts queues the fixer's job at once)
        return status
    except Exception as e:   # anything else still ends the night with a status, never with a key in it
        status['error'] = f'{type(e).__name__} in backup.py'
        log(f'unexpected: {type(e).__name__}: {e}'[:500])
        return status
    finally:
        shutil.rmtree(work, ignore_errors=True)
        try:
            write_status(status, hq_fd)
        finally:
            for fd in (hq_fd, voice_fd, seats_fd):
                if fd is not None:
                    os.close(fd)


def warnings(status, total, now):
    """The night's heads-ups in one line (the bucket of total bytes, then the repo's, the records', the renders' and the products': never one behind another). No
    figure in the text: backup.ts tells the board each time it changes (STATUS.md has the size)."""
    warns = [repo_warn(status, now), records_warn(status, now), renders_warn(status, now),
             status.get('products_error') and f"a product's copies aren't in tonight's backup ({status['products_error']})",
             status.get('big_files_unverified') and "a big file's copy in the bucket hasn't read back the same"]
    if total > 0.8 * FREE_BYTES:
        warns.insert(0, f'the bucket is past {0.8 * LIMIT_GB:g} GB of {LIMIT}')
    elif max(status.get('bucket_daily') or 0, status.get('bucket_repo') or 0) > 35 or (status.get('bucket_monthly') or 0) > 14:
        warns.insert(0, 'more backups kept than 30 daily and 12 monthly: check the bucket\'s lifecycle rules')
    return '; '.join(w for w in warns if w) or None


def repo_copy(r2, opts, keys, now, work, status, after, db_size):
    """Fetches GitHub into the mirror, makes the night's copy and uploads it, once the database's backup is in. It goes
    only if it leaves room for REPO_RESERVE database backups half as big again as tonight's, with nothing in the bucket
    expiring: every night's until all that's in the bucket now is past its 30 days, and their monthly copies. So the
    repo can't fill the bucket and cost a later night its backup."""
    mirror = f'{STATE}/repo.git'
    why = repo_fetch(mirror, opts.get('github') or github())
    if why:
        status['repo_error'] = f'GitHub: {why}'
        try:
            empty = not repo_refs(mirror)
        except (Stop, OSError):   # no git, or no mirror made
            empty = True
        if empty:   # a new server's first fetch: nothing to copy, and the fetch's reason is the one to show
            raise Stop(status['repo_error'])
    else:
        status['repo_fetched_at'] = status['tried_at']
    name = now.strftime('%Y-%m-%dT%H%M%SZ') + '.repo.tar.age'
    out = f'{work}/{name}'
    repo = repo_part(mirror, work, f'daily/{name}', load(f'{STATE}/repo-chain.json'), now, status.get('repo_fetched_at'),
                     keys['BACKUP_AGE_RECIPIENT'], out)
    if after + os.path.getsize(out) + REPO_RESERVE * NEXT_NIGHT * db_size > FREE_BYTES:
        raise Stop(f'not uploaded: the repo\'s copy ({os.path.getsize(out) / 1e9:.1f} GB) wouldn\'t leave '
                   f'room in {LIMIT} for the next month\'s database backups')
    size, digest = r2.put(repo['key'], out)
    if r2.fetch_hash(repo['key']) != digest:
        raise Stop('the repo\'s copy did not read back the same from R2')
    with open(f'{STATE}/repo-chain.json.new', 'w') as f:   # the next night builds on this copy
        json.dump({k: repo[k] for k in ('key', 'full_at', 'refs')}, f)
    os.replace(f'{STATE}/repo-chain.json.new', f'{STATE}/repo-chain.json')
    status.update(repo_ok_at=status['tried_at'], repo_key=repo['key'], repo_kind=repo['kind'], repo_bytes=size,
                  repo_refs=len(repo['refs']), repo_head=repo['refs'].get('refs/heads/main'), repo_github_at=repo['github_at'])


def repo_warn(status, now):
    """A heads-up once the repo's copy has been failing, or stuck on an old GitHub, for REPO_STALE. The text only
    changes with the date, so the board hears it once (backup.ts), not every night, until a good night clears it."""
    since = lambda k: (now - datetime.datetime.fromisoformat(status[k])).total_seconds() if status.get(k) else float('inf')
    day = lambda k: status[k][:16].replace('T', ' ') + ' UTC' if status.get(k) else 'never'
    if since('repo_ok_at' if status.get('repo_ok_at') else 'repo_since') > REPO_STALE:
        return f'no copy of the repo since {day("repo_ok_at")}' if status.get('repo_ok_at') else 'no copy of the repo yet'
    if status.get('repo_ok_at') and since('repo_fetched_at') > REPO_STALE:
        return f'the repo\'s copy is GitHub\'s as of {day("repo_fetched_at")}: fetching from GitHub has failed since'
    return None


def commit():
    try:
        with open(f'/var/lib/{NAME}/deployed') as f:
            return f.read().strip()[:40]
    except OSError:
        return None


# ---- the drill's downloads: the bucket's objects, with the R2 keys from the environment.

def fetch(dest, prefixes):
    """Downloads every object under the prefixes into dest/<its key>, with the R2 keys from the environment (the drill
    on the board's machine: a token that can read the bucket). One already there at its size is kept."""
    env = {n: os.environ.get(n, '') for n in ('BACKUP_R2_ENDPOINT', 'BACKUP_R2_ACCESS_KEY_ID', 'BACKUP_R2_SECRET_ACCESS_KEY')}
    if not all(env.values()):
        raise Stop(f'set {", ".join(n for n, v in env.items() if not v)} in the environment')
    r2 = R2(env['BACKUP_R2_ENDPOINT'], env['BACKUP_R2_ACCESS_KEY_ID'], env['BACKUP_R2_SECRET_ACCESS_KEY'])
    report = {'objects': 0, 'bytes': 0}
    for key, (size, _) in sorted(r2.listing().items()):
        if not any(key.startswith(p) for p in prefixes):
            continue
        if not re.fullmatch(r'[A-Za-z0-9_.:-]+(/[A-Za-z0-9_.:-]+)*', key) or '..' in key.split('/'):
            raise Stop(f'{key!r} is not a name to write to disk')
        path = f'{dest}/{key}'
        if not (os.path.isfile(path) and os.path.getsize(path) == size):
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with r2.request('GET', key, stream=True) as res, open(f'{path}.part', 'wb') as f:
                shutil.copyfileobj(res, f)
            if os.path.getsize(f'{path}.part') != size:   # a connection that closes early reads as the end, not an error
                raise Stop(f'{key} came down short ({os.path.getsize(f"{path}.part")} of {size} bytes): run fetch again')
            os.replace(f'{path}.part', path)
        report['objects'] += 1
        report['bytes'] += size
    print(json.dumps(report, indent=1))
    return True


# ---- the restore drill (on the board's machine or a scratch server; never needs R2 keys)

def restore(archive, dest, fetched=None):
    """Decrypts with the identity on stdin, unpacks into dest (plain files and folders only, nothing outside it), puts
    each big file the manifest names in its place from fetched/big-files/ (fetch's folder), checked against its
    sha256, and checks the database against the manifest made when it was copied, and each product's database copy opens."""
    os.makedirs(dest, exist_ok=True)
    root = os.path.realpath(dest)
    if os.listdir(root):
        raise Stop(f'{dest} is not empty: restore into an empty scratch folder')
    identity = sys.stdin.read()
    age = subprocess.Popen(['age', '-d', '-i', '-', archive], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    age.stdin.write(identity.encode())
    age.stdin.close()
    try:
        links = unpack(age.stdout, root, dest)
    except (tarfile.TarError, EOFError, OSError, ValueError):
        if age.wait():
            raise Stop('age could not decrypt it (wrong key?)')
        raise
    if age.wait():
        raise Stop('age could not decrypt it (wrong key?)')
    with open(f'{root}/manifest.json') as f:
        manifest = json.load(f)
    db = f'{root}/hq/hq.db'
    problems = restore_big_files(manifest.get('big_files', []), identity, root, dest, fetched)
    if sha256_file(db) != manifest['hq_db_sha256']:
        problems.append('hq.db differs from the copy that was made')
    con = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    try:
        con.execute('pragma trusted_schema = off')
        check = con.execute('pragma integrity_check').fetchone()[0]
        if check != 'ok':
            problems.append(f'integrity check: {check[:200]}')
        for t, n in manifest['tables'].items():
            got = con.execute(f'select count(*) from {ident(t)}').fetchone()[0]
            if got != n:
                problems.append(f'{t}: {got} rows, {n} when copied')
    finally:
        con.close()
    product_checks = check_product_copies(root)
    problems.extend(product_checks['problems'])
    files = sum(len(f) for _, _, f in os.walk(root))
    report = {'created': manifest['created'], 'commit': manifest.get('commit'), 'files': files, 'symlinks_listed': links, 'big_files': len(manifest.get('big_files', [])),
              'tables': len(manifest['tables']), 'rows': sum(manifest['tables'].values()), 'product_dbs': product_checks['databases'], 'problems': problems}
    print(json.dumps(report, indent=1))
    return not problems


def restore_big_files(entries, identity, root, dest, fetched):
    """The big files a backup names, each decrypted from fetched/<its object> into its place (mode 0600, as every file of a
    restore, and its time). Returns the problems: one not fetched, or not the file its sha256 says."""
    problems, missing = [], 0
    for entry in entries:
        target = os.path.realpath(os.path.join(root, entry['path']))
        if not target.startswith(root + os.sep) or entry['path'].startswith('/') or not BIG_FILE_KEY.fullmatch(entry['object']):
            raise Stop(f"{entry['path']!r} would land outside {dest}")
        src = f"{fetched}/{entry['object']}" if fetched else None
        if not src or not os.path.isfile(src):
            missing += 1
            continue
        os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
        with open(target, 'xb') as out:
            age = subprocess.Popen(['age', '-d', '-i', '-', src], stdin=subprocess.PIPE, stdout=out)
            age.communicate(identity.encode())
        if age.returncode:
            raise Stop('age could not decrypt a file (wrong key?)')
        os.chmod(target, 0o600)
        os.utime(target, (entry['mtime'], entry['mtime']))
        if sha256_file(target) != entry['sha256']:
            problems.append(f"{entry['path']} differs from the file that was backed up")
    if missing:
        problems.append(f'{missing} of the {len(entries)} big files it names not fetched'
                        + (f' into {fetched}/big-files/' if fetched else ': give the folder backup.py fetch put big-files/ in'))
    return problems


def check_product_copies(root):
    """Checks every restored product database, including copies under hidden folders."""
    problems = []
    databases = 0
    for folder, _, files in os.walk(f'{root}/products'):
        for name in sorted(files):
            if not name.endswith('.db'):
                continue
            path = os.path.join(folder, name)
            databases += 1
            try:
                uri = f'file:{urllib.parse.quote(path)}?mode=ro&immutable=1'
                with contextlib.closing(sqlite3.connect(uri, uri=True)) as con:
                    con.execute('pragma trusted_schema = off')
                    check = con.execute('pragma quick_check').fetchone()[0]
            except sqlite3.DatabaseError as e:
                check = str(e)
            if check != 'ok':
                problems.append(f'{os.path.relpath(path, root)}: {check[:200]}')
    return {'databases': databases, 'problems': problems}


def unpack(stream, root, dest, mode='r|gz'):
    links = 0
    with tarfile.open(fileobj=stream, mode=mode) as tar:
        for m in tar:
            target = os.path.realpath(os.path.join(root, m.name))
            if not target.startswith(root + os.sep) or m.name.startswith('/'):
                raise Stop(f'{m.name!r} would land outside {dest}')
            if m.isdir():
                os.makedirs(target, mode=0o700, exist_ok=True)
            elif m.isreg():
                os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
                with tar.extractfile(m) as src, open(target, 'xb') as out:
                    shutil.copyfileobj(src, out)
                os.chmod(target, 0o600)
            else:
                links += 1   # symlinks are listed, not recreated
    return links


def restore_repo(dest, files):
    """Decrypts the repo's copies with the identity on stdin and rebuilds the newest one as a bare repo, dest/repo.git:
    cloned from its chain's full bundle, then every later bundle fetched in order (git checks each one's prerequisites),
    then every branch and tag set exactly as GitHub had them that night. git fsck checks every object."""
    os.makedirs(dest, exist_ok=True)
    root = os.path.realpath(dest)
    if os.listdir(root):
        raise Stop(f'{dest} is not empty: restore into an empty scratch folder')
    if not shutil.which('git'):
        raise Stop('git is not installed')
    identity = sys.stdin.read().encode()
    parts = {}
    for i, path in enumerate(files):
        d = f'{root}/copies/{i}'
        os.makedirs(d)
        age = subprocess.Popen(['age', '-d', '-i', '-', path], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        age.stdin.write(identity)
        age.stdin.close()
        try:
            unpack(age.stdout, os.path.realpath(d), path, mode='r|')
        except (tarfile.TarError, EOFError, OSError, ValueError):
            if age.wait():
                raise Stop(f'age could not decrypt {path} (wrong key?)')
            raise
        if age.wait():
            raise Stop(f'age could not decrypt {path} (wrong key?)')
        meta = load(f'{d}/repo.json')
        if not meta:
            raise Stop(f"{path} isn't a copy of the repo (the database's backups go to restore)")
        parts[meta['key']] = (d, meta)
    newest = max(parts.values(), key=lambda p: p[1]['created'])[1]
    chain, key = [], newest['key']
    while key:   # from the newest back to its full bundle
        if key not in parts:
            raise Stop(f"{newest['key']} builds on {key}: download that one too (and give every copy since the chain's full one)")
        chain.insert(0, parts[key])
        key = parts[key][1]['base']
    repo = f'{root}/repo.git'
    r = git(None, '-c', 'transfer.fsckObjects=true', 'clone', '-q', '--bare', f'{chain[0][0]}/repo.bundle', repo)
    if r.returncode:
        raise Stop(f"couldn't clone from {chain[0][1]['key']}: {git_error(r)}")
    for i, (d, meta) in enumerate(chain[1:], 1):
        if meta['bundle']:
            # --no-tags: git would also follow the bundle's annotated tags into refs/tags/, where release/child can't be
            # made while the older copy's release is still there (or the other way round), and the whole fetch fails
            r = git(repo, '-c', 'transfer.fsckObjects=true', 'fetch', '-q', '--no-tags', f'{d}/repo.bundle', f'+refs/*:refs/copies/{i}/*')
            if r.returncode:
                raise Stop(f"couldn't fetch {meta['key']}: {git_error(r)}")
    problems, want = [], newest['refs']
    held = present(repo, set(want.values()))
    missing = [ref for ref, sha in want.items() if sha not in held]
    problems += [f'{ref}: {want[ref]} is not in the copies' for ref in missing]
    # The deletes first, on their own: in one transaction git can't delete topic and create topic/child (or the other
    # way round), and the whole of it fails.
    gone = [ref for ref in repo_refs(repo) if ref not in want]
    gone += git(repo, 'for-each-ref', '--format=%(refname)', 'refs/copies').stdout.splitlines()
    for ops in ([f'delete {ref}' for ref in gone], [f'update {ref} {sha}' for ref, sha in want.items() if ref not in missing]):
        r = git(repo, 'update-ref', '--stdin', stdin=''.join(o + '\n' for o in ops))
        if r.returncode:
            problems.append(f'setting the branches failed: {git_error(r)}')
    git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main')
    got = repo_refs(repo)
    if got != want:
        problems.append(f'{len(set(got.items()) ^ set(want.items()))} branches or tags differ from GitHub\'s that night')
    r = git(repo, 'fsck', '--full', '--no-dangling', '--no-progress', timeout=3600)
    if r.returncode:
        problems.append(f'git fsck: {git_error(r)}')
    shutil.rmtree(f'{root}/copies')
    report = {'copy': newest['key'], 'github_at': newest['github_at'], 'chain': [m['key'] for _, m in chain],
              'branches': sum(k.startswith('refs/heads/') for k in got), 'tags': sum(k.startswith('refs/tags/') for k in got),
              'main': got.get('refs/heads/main'), 'main_matches_github': got.get('refs/heads/main') == want.get('refs/heads/main'),
              'repo': repo, 'problems': problems}
    print(json.dumps(report, indent=1))
    return not problems


def restore_records(dest, files):
    """Decrypts records (invoices, agreements) with the identity on stdin, each into dest/<its name>/, and checks every
    file against the sha256 its mail.json recorded when it was copied."""
    os.makedirs(dest, exist_ok=True)
    root = os.path.realpath(dest)
    if os.listdir(root):
        raise Stop(f'{dest} is not empty: restore into an empty scratch folder')
    identity = sys.stdin.read().encode()
    report = []
    for i, path in enumerate(files):
        d = f'{root}/.unpacking-{i}'
        os.makedirs(d)
        age = subprocess.Popen(['age', '-d', '-i', '-', path], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        age.stdin.write(identity)
        age.stdin.close()
        try:
            unpack(age.stdout, os.path.realpath(d), path)
        except (tarfile.TarError, EOFError, OSError, ValueError):
            if age.wait():
                raise Stop(f'age could not decrypt {path} (wrong key?)')
            raise
        if age.wait():
            raise Stop(f'age could not decrypt {path} (wrong key?)')
        meta = load(f'{d}/mail.json')
        if not meta:
            raise Stop(f"{path} isn't a record (the database's backups go to restore)")
        # the folder is named by the record itself (the downloaded file may be called anything): documents-2026-10-03T101500-12
        name = record_name(str(meta['kept_as']), str(meta['received']), int(meta['mail']))
        if not re.fullmatch(r'(invoices|documents)-\d{4}-\d{2}-\d{2}T\d{6}-\d+', name) or os.path.exists(f'{root}/{name}'):
            raise Stop(f"{path}: its mail.json doesn't name a record, or it's there twice")
        os.rename(d, f'{root}/{name}')
        d = f'{root}/{name}'
        problems = []
        for f in [meta['raw']] + meta['attachments'] if meta.get('raw') else meta['attachments']:
            if f.get('stored') is False:
                continue
            if not os.path.isfile(f'{d}/{f["file"]}') or sha256_file(f'{d}/{f["file"]}') != f['sha256']:
                problems.append(f'{f["file"]} differs from the copy that was made')
        report.append({'record': name, 'mail': meta['mail'], 'received': meta['received'], 'from': meta['sender'], 'to': meta['recipient'],
                       'subject': meta['subject'], 'raw': bool(meta.get('raw')), 'files': [a['name'] for a in meta['attachments']],
                       'not_stored': [a['name'] for a in meta['attachments'] if a.get('stored') is False], 'folder': d, 'problems': problems})
    print(json.dumps(report, indent=1, ensure_ascii=False))
    return not any(r['problems'] for r in report)


def restore_renders(dest, files):
    """Decrypts renders with the identity on stdin, each into dest/<its sha256>: dest is then a store infra/renders.py
    puts back into a checkout (`renders.py <checkout> <dest> <state>`). A file still named as R2 had it (<sha256>.age)
    is checked against that name."""
    os.makedirs(dest, exist_ok=True)
    root = os.path.realpath(dest)
    if os.listdir(root):
        raise Stop(f'{dest} is not empty: restore into an empty scratch folder')
    identity = sys.stdin.read().encode()
    report = {'renders': 0, 'bytes': 0, 'problems': []}
    for path in files:
        tmp = f'{root}/.restoring'
        age = subprocess.Popen(['age', '-d', '-i', '-', '-o', tmp, path], stdin=subprocess.PIPE)
        age.stdin.write(identity)
        age.stdin.close()
        if age.wait():
            raise Stop(f'age could not decrypt {path} (wrong key?)')
        sha, named = sha256_file(tmp), os.path.basename(path).split('.')[0]
        if re.fullmatch(r'[0-9a-f]{64}', named) and named != sha:
            report['problems'].append(f'{path} differs from the render its name says')
        os.chmod(tmp, 0o444)
        os.replace(tmp, f'{root}/{sha}')
        report['renders'] += 1
        report['bytes'] += os.path.getsize(f'{root}/{sha}')
    print(json.dumps(report, indent=1))
    return not report['problems']


def main(argv):
    if len(argv) >= 2 and argv[1] == 'run':
        # --local-db/--hqdata/--voice/--seats/--state: the local proof (infra/test_backup.py) instead of Docker
        opts = dict(zip([a.lstrip('-').replace('-', '_') for a in argv[2::2]], argv[3::2]))
        status = run(opts)
        log(f'{status["state"]}: ' + (status.get('error') or f'{status.get("ok_key")}, {status.get("ok_bytes")} bytes'))
        return 0 if status['state'] in ('ok', 'waiting for the board') else 1
    if len(argv) in (4, 5) and argv[1] == 'restore' or len(argv) >= 4 and argv[1] in ('restore-repo', 'restore-records', 'restore-renders', 'fetch'):
        try:
            drill = {'restore': lambda: restore(*argv[2:]), 'fetch': lambda: fetch(argv[2], argv[3:]), 'restore-repo': lambda: restore_repo(argv[2], argv[3:]),
                     'restore-records': lambda: restore_records(argv[2], argv[3:]), 'restore-renders': lambda: restore_renders(argv[2], argv[3:])}[argv[1]]
            return 0 if drill() else 1
        except Stop as e:
            print(f'{argv[1]} failed: {e}', file=sys.stderr)
            return 1
    print(__doc__.split('\n\n')[1], file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
