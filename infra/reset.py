#!/usr/bin/env python3
"""Starting a company over: a clean slate the board chooses (template/README.md, "Starting over").

  start    the board's Claude Code, in the company's checkout on an up-to-date main: the company's own files go back
           to the template, except what company/reset.yaml keeps, with the files it prepares (company/reset/<path>)
           laid over them, and infra/reset names the reset's id. Nothing is committed: the board reads the change, then
           commits and pushes it itself.
  due      sync.sh: prints the id in infra/reset when this server hasn't acted on it yet (exit 0). Exit 1: nothing to
           do. Exit 2: refused, and why, because the change didn't come from the board's own commit (printed once).
  run ID   sync.sh, with the coordinator, worker and voice line stopped: archives the company's runtime data and its
           job branches in /var/lib/<SERVER_NAME>/archive/<ID>/, and leaves the coordinator a new database.

Kept on the server: the board's keys (secrets/), the products' own keys (product-keys/), its passkeys, sessions and push subscriptions, the seats' sign-ins,
the search model, HQ's address, mail routing and the server itself. Archived: the database (jobs, calls, chat, cards,
memory, mail), mail files, photos, review shots, approvals, the jobs' clones and homes, the agents' Claude
and Codex sessions and auto memory, the voice line's call sessions and logs, and every job/* branch (one git bundle)
before its pull request is closed and the branch deleted, so no new job meets an old one's branch. An archive stays
until someone removes it.
"""
import json, os, re, shutil, sqlite3, subprocess, sys, time, urllib.request
from company import INFRA, ROOT

MARKER = 'infra/reset'
PLAN, PREPARED = 'company/reset.yaml', 'company/reset/'
ID = re.compile(r'[0-9a-z][0-9a-z.-]{0,63}')
# The foundation's own paths at the top of a company's repo (README.md, "A fork with an upstream"); everything else is
# the company's. infra/ holds the server's state too (host, server-type, enroll, mail token): it stays as it is.
FOUNDATION = {'.github', '.gitignore', 'CODE_STYLE.md', 'PLAN.md', 'docs', 'infra', 'platform', 'shared', 'template'}
ALWAYS_KEPT = ['company/infra.env']   # the server's names: the server is kept
MAX_AGE_S = 3 * 86400   # a marker this old is history (a new server, a restored backup), not the board's wish now
GITHUB_WEB = 'noreply@github.com'   # GitHub's own commits: a merged pull request, an edit in the browser

STATE = os.environ.get('RESET_STATE') or f"/var/lib/{INFRA['SERVER_NAME']}"
# What stays in the coordinator's data volume (platform/coordinator/src: secrets.ts, memory.ts, guests.ts,
# payments.ts, backup.ts); the database is rebuilt with only KEPT_TABLES and KEPT_SETTINGS. product-keys: the products'
# own keys (products.py needs.keys), since their data volumes stay and still need what signed and sealed it.
KEPT_DATA = {'secrets', 'models', 'guest.key', 'payments.key', 'backup-status.json', 'product-keys'}
KEPT_TABLES = ['credentials', 'sessions', 'enrollments', 'push_subscriptions']   # the board's passkeys, sign-ins, phones
KEPT_SETTINGS = ['vapid', 'twilio_account', 'backup.keyed']   # push.ts's signing key, calls.ts, backup.ts
DB_FILES = ['hq.db', 'hq.db-wal', 'hq.db-shm']
# From the seats volume: the agents' sessions and Claude's auto memory (worker.ts SHARED), not the seats' sign-ins
SEAT_HISTORY = ['shared/claude/projects', 'shared/codex-sessions']


def main(args):
    if args[:1] == ['start']:
        return start()
    if args[:1] == ['due']:
        return due()
    if args[:1] == ['run'] and len(args) == 2 and ID.fullmatch(args[1]):
        return run(args[1])
    print(__doc__, file=sys.stderr)
    return 1


# ---- start: the repo, in the board's Claude Code

def start(root=ROOT):
    if git(root, 'status', '--porcelain', '--untracked-files=no'):
        return refuse('the checkout has changes: commit or stash them first')
    try:
        import yaml
        plan = yaml.safe_load(open(os.path.join(root, PLAN))) or {}
    except FileNotFoundError:
        return refuse(f'{PLAN} is missing: write the reset first (its id, and what it keeps)')
    reset_id, keep = str(plan.get('id', '')), [str(k).rstrip('/') for k in plan.get('keep') or []] + ALWAYS_KEPT
    if not ID.fullmatch(reset_id):
        return refuse(f'{PLAN} needs an id: lowercase letters, digits, dots and dashes, like 2026-10-03-clean-slate')
    if marker_id(root) == reset_id:
        return refuse(f'{MARKER} already names {reset_id}: a new reset needs a new id')
    kept = lambda path: any(path == k or path.startswith(k + '/') for k in keep)
    tracked = [p for p in git(root, 'ls-files', '-z').split('\0') if p]
    prepared = {p[len(PREPARED):]: read_bytes(root, p) for p in tracked if p.startswith(PREPARED)}
    own = [p for p in tracked if p.split('/')[0] not in FOUNDATION]
    removed = [p for p in own if not kept(p)]
    for path in removed:
        os.remove(os.path.join(root, path))
        try:
            os.removedirs(os.path.dirname(os.path.join(root, path)))
        except OSError:
            pass   # a folder with something left in it
    template = [p[len('template/'):] for p in tracked if p.startswith('template/')]
    copied = [p for p in template if not kept(p)]
    for path in copied:
        write_bytes(root, path, read_bytes(root, f'template/{path}'))
    for path, content in prepared.items():
        write_bytes(root, path, content)
    write_bytes(root, MARKER, (f'# The company started over (infra/reset.py): the server acts on this id once, and only when the\n'
                               f"# board's own commit set it.\n{reset_id}\n").encode())
    git(root, 'add', '-A', '--', *removed, *copied, *prepared, MARKER)
    print(f'Starting over as {reset_id}: {len(removed)} of the company\'s files cleared, {len(copied)} from the template, '
          f'{len(prepared)} prepared in {PREPARED}, kept: {", ".join(keep)}.\n'
          'Read `git status` and `git diff --cached`, then commit and push it to the deploy branch yourself: the server '
          'starts over within a minute.')
    return 0


def marker_id(root):
    try:
        lines = open(os.path.join(root, MARKER)).read().splitlines()
    except FileNotFoundError:
        return None
    found = [l.strip() for l in lines if l.strip() and not l.startswith('#')]
    return found[0] if found and ID.fullmatch(found[0]) else None


def read_bytes(root, path):
    with open(os.path.join(root, path), 'rb') as f:
        return f.read()


def write_bytes(root, path, content):
    target = os.path.join(root, path)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, 'wb') as f:
        f.write(content)


def refuse(why):
    print(f'Not starting over: {why}', file=sys.stderr)
    return 1


# ---- due: whether the server acts on infra/reset

def due(root=ROOT):
    reset_id = marker_id(root)
    if not reset_id or reset_id in acted():
        return 1
    why = not_the_boards(root)
    if why:
        record(reset_id, f'refused: {why}')
        print(f'REFUSED starting the company over ({reset_id}): {why}')
        return 2
    print(reset_id)
    return 0


# Agents reach the deploy branch only through pull requests, which the review panel merges as merge commits (sync.sh
# refuses an agent's commit pushed straight to it). So the board's own reset is a plain commit on the branch's
# first-parent line, made by neither an agent nor GitHub.
def not_the_boards(root):
    line = git(root, 'log', '-1', '--first-parent', '--format=%H %P%x00%ae%x00%ce%x00%ct', '--', MARKER)
    if not line:
        return f'no commit on the deploy branch sets {MARKER}'
    commits, author, committer, at = line.split('\0')
    commit, parents = commits.split()[0][:12], commits.split()[1:]
    if len(parents) != 1:
        return f'{commit} is a merge: a pull request brought the change, and only the board starts the company over'
    if any(is_agent(e) for e in (author, committer)):
        return f'{commit} is an agent\'s'
    if committer.lower() == GITHUB_WEB:
        return f'{commit} was made on GitHub (a merged pull request or an edit in the browser), not by the board\'s Claude Code'
    if time.time() - int(at) > MAX_AGE_S:
        return f'{commit} is more than {MAX_AGE_S // 86400} days old: a new reset needs a new id'
    return None


def is_agent(email):
    email = email.lower()
    return email.endswith('@' + INFRA['AGENT_EMAIL_DOMAIN'].lower()) or email == INFRA['AGENTS_EMAIL'].lower()


def acted():
    try:
        return {l.split(' ', 1)[0] for l in open(os.path.join(STATE, 'reset')).read().splitlines() if l}
    except FileNotFoundError:
        return set()


def record(reset_id, outcome):
    os.makedirs(STATE, exist_ok=True)
    with open(os.path.join(STATE, 'reset'), 'a') as f:
        f.write(f'{reset_id} {time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())} {outcome}\n')


# ---- run: the server's side, with the stack stopped

def run(reset_id, root=ROOT):
    archive = os.path.join(STATE, 'archive', reset_id)
    os.makedirs(archive, mode=0o700, exist_ok=True)
    os.chmod(archive, 0o700)
    branches(root, archive)
    hq_data = os.environ['HQ_DATA']
    if not os.path.exists(os.path.join(archive, 'hqdata', 'hq.db')):   # (a run that stopped after this got this far)
        fresh_database(hq_data, archive)
    move_all(hq_data, os.path.join(archive, 'hqdata'), lambda name: name not in KEPT_DATA and name not in DB_FILES)
    for volume, folder, keep in [('WORK_DATA', 'work', lambda name: name != 'mirror.git'), ('VOICE_DATA', 'voice', lambda name: True)]:
        if os.environ.get(volume):
            move_all(os.environ[volume], os.path.join(archive, folder), keep)
    if os.environ.get('SEATS_DATA'):
        for path in SEAT_HISTORY:
            move(os.path.join(os.environ['SEATS_DATA'], path), os.path.join(archive, 'seats', path))
    record(reset_id, f'done: archived in {archive}')
    print(f'Started over as {reset_id}: the old data is in {archive}')
    return 0


# Every job/* branch goes into one bundle in the archive, its open pull request is closed, and the branch is deleted:
# job numbers start again at 1, and job #1 must not take up the old job #1's branch (git.ts clone) or pull request.
def branches(root, archive):
    git(root, 'fetch', '-q', '--prune', 'origin', '+refs/heads/job/*:refs/reset/job/*')
    refs = git(root, 'for-each-ref', '--format=%(refname)', 'refs/reset/job/').splitlines()
    if not refs:
        return
    git(root, 'bundle', 'create', '-q', os.path.join(archive, 'job-branches.bundle'), *refs)
    names = [r[len('refs/reset/'):] for r in refs]
    for number in open_pull_requests(set(names)):
        github('PATCH', f'pulls/{number}', {'state': 'closed'})
    for i in range(0, len(names), 50):
        git(root, 'push', '-q', 'origin', '--delete', *names[i:i + 50])
    for ref in refs:
        git(root, 'update-ref', '-d', ref)
    print(f'{len(names)} job branches bundled, closed and deleted')


def open_pull_requests(heads):
    repo, numbers = server_env()['REPO'], []
    for page in range(1, 11):
        pulls = github('GET', f'pulls?state=open&per_page=100&page={page}')
        numbers += [p['number'] for p in pulls if p['head']['ref'] in heads and (p['head'].get('repo') or {}).get('full_name') == repo]
        if len(pulls) < 100:
            break
    return numbers


def github(method, path, body=None):
    env = server_env()
    api = os.environ.get('GITHUB_API', 'https://api.github.com')
    request = urllib.request.Request(f"{api}/repos/{env['REPO']}/{path}", method=method,
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers={'authorization': f"Bearer {env['GITHUB_TOKEN']}", 'accept': 'application/vnd.github+json'})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def server_env():
    with open(os.environ['SERVER_ENV']) as f:
        return dict(l.strip().split('=', 1) for l in f if '=' in l and not l.startswith('#'))


# A new hq.db holding only what's kept. It has no other tables, so the coordinator takes it for a new company's
# first database (db.ts born, which knows KEPT_TABLES and settings): the platform's one-off fixes are recorded as done,
# never run on it.
def fresh_database(hq_data, archive):
    old_path, new_path = os.path.join(hq_data, 'hq.db'), os.path.join(hq_data, 'hq.db.new')
    if not os.path.exists(old_path):
        return
    for leftover in (new_path, new_path + '-journal'):
        if os.path.exists(leftover):
            os.remove(leftover)
    new = sqlite3.connect(new_path)
    new.execute('attach database ? as old', (old_path,))
    schema = dict(new.execute("select name, sql from old.sqlite_master where type = 'table'").fetchall())
    for table in KEPT_TABLES + ['settings']:
        if table in schema:
            new.execute(schema[table])
    for table in KEPT_TABLES:
        if table in schema:
            new.execute(f'insert into main.{table} select * from old.{table}')
    if 'settings' in schema:
        marks = ','.join('?' * len(KEPT_SETTINGS))
        new.execute(f'insert into main.settings select * from old.settings where key in ({marks})', KEPT_SETTINGS)
    new.commit()
    new.execute('detach database old')
    new.close()
    owner = os.stat(old_path)
    os.chown(new_path, owner.st_uid, owner.st_gid)
    os.chmod(new_path, owner.st_mode & 0o777)
    for name in DB_FILES:
        move(os.path.join(hq_data, name), os.path.join(archive, 'hqdata', name))
    os.replace(new_path, old_path)


def move_all(source, target, chosen):
    for name in sorted(os.listdir(source)):
        if chosen(name):
            move(os.path.join(source, name), os.path.join(target, name))


def move(source, target):
    if not os.path.lexists(source):
        return
    os.makedirs(os.path.dirname(target), exist_ok=True)
    if os.path.lexists(target):   # (an earlier run of the same reset archived one already)
        target = f'{target}.{int(time.time())}'
    shutil.move(source, target)


def git(root, *args):
    return subprocess.run(['git', '-C', root, *args], check=True, capture_output=True, text=True).stdout.strip()


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
