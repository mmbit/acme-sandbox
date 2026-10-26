#!/usr/bin/env python3
"""python3 infra/test_reset.py: starts a made-up company over in a throwaway folder (real git, a local bare repo as
GitHub's, a local server playing GitHub's API; no Docker).

Checks that start takes the company's own files back to the template and keeps what the reset keeps, that the server
acts only on the board's own commit and only once, and that run archives the runtime data and job branches while the
board's keys, passkeys and sessions, the products' own keys and the seats' sign-ins stay.
"""
import json, os, shutil, sqlite3, subprocess, sys, tempfile, threading, time, unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

here = os.path.dirname(os.path.abspath(__file__))
INFRA_ENV = 'SERVER_NAME=testco\nSERVER=testco-1\nBACKUP_BUCKET=testco-backups\nAGENT_EMAIL_DOMAIN=agents.testco.test\nAGENTS_EMAIL=agents@testco.test\n'
BOARD = {'GIT_AUTHOR_NAME': 'Claude', 'GIT_AUTHOR_EMAIL': 'noreply@anthropic.com', 'GIT_COMMITTER_NAME': 'Claude',
         'GIT_COMMITTER_EMAIL': 'noreply@anthropic.com'}
AGENT = {'GIT_AUTHOR_NAME': 'Mara', 'GIT_AUTHOR_EMAIL': 'mara@agents.testco.test', 'GIT_COMMITTER_NAME': 'Mara',
         'GIT_COMMITTER_EMAIL': 'mara@agents.testco.test'}
MERGER = {'GIT_AUTHOR_NAME': 'testco', 'GIT_AUTHOR_EMAIL': 'owner@testco.test', 'GIT_COMMITTER_NAME': 'GitHub',
          'GIT_COMMITTER_EMAIL': 'noreply@github.com'}


def write(root, path, text):
    os.makedirs(os.path.dirname(os.path.join(root, path)), exist_ok=True)
    with open(os.path.join(root, path), 'w') as f:
        f.write(text)


def git(root, *args, who=BOARD, at=None):
    env = {**os.environ, **who, **({'GIT_AUTHOR_DATE': at, 'GIT_COMMITTER_DATE': at} if at else {})}
    return subprocess.run(['git', '-C', root, *args], check=True, capture_output=True, text=True, env=env).stdout.strip()


class Company(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='reset-test-')
        self.origin, self.repo, self.state = (os.path.join(self.tmp, d) for d in ('origin.git', 'repo', 'state'))
        subprocess.run(['git', 'init', '-q', '--bare', '-b', 'main', self.origin], check=True)
        subprocess.run(['git', 'clone', '-q', self.origin, self.repo], check=True, capture_output=True)
        git(self.repo, 'checkout', '-q', '-b', 'main')
        os.makedirs(os.path.join(self.repo, 'infra'))
        for f in ('reset.py', 'company.py'):
            shutil.copy(os.path.join(here, f), os.path.join(self.repo, 'infra', f))
        files = {'platform/server.ts': 'platform\n', 'infra/host': 'hq.testco.test\n', 'CODE_STYLE.md': 'style\n',
                 'template/AGENTS.md': 'template agents\n', 'template/company/CHARTER.md': 'template charter\n',
                 'template/company/org.yaml': 'template org\n', 'template/company/infra.env': 'SERVER_NAME=company\n',
                 'template/theme/hq.yaml': 'renderer: wire\n',
                 'AGENTS.md': 'our agents\n', 'company/CHARTER.md': 'our mission\n', 'company/org.yaml': 'eleven agents\n',
                 'company/brand.yaml': 'name: Testco\n', 'company/infra.env': INFRA_ENV, 'company/people/ada.md': 'long memory\n',
                 'theme/hq.yaml': 'renderer: holo\n', 'products/shop/app.js': 'shop\n', 'kits/sound/bed.js': 'bed\n',
                 'knowledge/notes/a.md': 'note\n', 'concepts/round-1.md': 'concept\n',
                 'company/reset.yaml': 'id: 2026-10-03-clean\nkeep:\n  - company/brand.yaml\n  - theme/\n',
                 'company/reset/company/org.yaml': 'ada and the board\n', 'company/reset/company/people/ada.md': 'fresh profile\n'}
        for path, text in files.items():
            write(self.repo, path, text)
        git(self.repo, 'add', '-A')
        git(self.repo, 'commit', '-q', '-m', 'The company as it is')
        git(self.repo, 'push', '-q', 'origin', 'main')
        os.environ.update(INFRA_ENV=os.path.join(self.repo, 'company', 'infra.env'), RESET_STATE=self.state)

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def reset(self, *args, env=None):
        return subprocess.run([sys.executable, os.path.join(self.repo, 'infra', 'reset.py'), *args], capture_output=True,
                              text=True, env={**os.environ, **(env or {})})

    def read(self, path):
        with open(os.path.join(self.repo, path)) as f:
            return f.read()

    def start(self):
        r = self.reset('start')
        self.assertEqual(r.returncode, 0, r.stderr)
        git(self.repo, 'commit', '-q', '-m', 'Start over')

    def test_start_takes_the_company_back_to_the_template_and_keeps_what_the_reset_keeps(self):
        self.start()
        tracked = set(git(self.repo, 'ls-files').splitlines())
        for gone in ('products/shop/app.js', 'kits/sound/bed.js', 'knowledge/notes/a.md', 'concepts/round-1.md',
                     'company/reset.yaml', 'company/reset/company/org.yaml'):
            self.assertNotIn(gone, tracked)
        self.assertEqual(self.read('company/CHARTER.md'), 'template charter\n')
        self.assertEqual(self.read('AGENTS.md'), 'template agents\n')
        self.assertEqual(self.read('company/org.yaml'), 'ada and the board\n')
        self.assertEqual(self.read('company/people/ada.md'), 'fresh profile\n')
        self.assertEqual(self.read('company/brand.yaml'), 'name: Testco\n')
        self.assertEqual(self.read('theme/hq.yaml'), 'renderer: holo\n')
        self.assertEqual(self.read('company/infra.env'), INFRA_ENV, "the server's names are always kept")
        self.assertEqual(self.read('platform/server.ts'), 'platform\n')
        self.assertEqual(self.read('infra/host'), 'hq.testco.test\n')
        self.assertIn('2026-10-03-clean', self.read('infra/reset'))

    def test_the_server_acts_once_on_the_boards_own_commit(self):
        self.start()
        due = self.reset('due')
        self.assertEqual((due.returncode, due.stdout.strip()), (0, '2026-10-03-clean'))
        os.makedirs(self.state, exist_ok=True)
        write(self.state, 'reset', '2026-10-03-clean 2026-10-03T10:00:00Z done\n')
        self.assertEqual(self.reset('due').returncode, 1, 'an id the server acted on is never run again')

    def test_a_reset_merged_from_a_pull_request_is_refused_and_said_once(self):
        git(self.repo, 'checkout', '-q', '-b', 'job/7')
        write(self.repo, 'infra/reset', 'agents-wish\n')
        git(self.repo, 'add', '-A')
        git(self.repo, 'commit', '-q', '-m', 'Start over', who=AGENT)
        git(self.repo, 'checkout', '-q', 'main')
        git(self.repo, 'merge', '-q', '--no-ff', '-m', 'Merge PR #9 after review', 'job/7', who=MERGER)
        due = self.reset('due')
        self.assertEqual(due.returncode, 2)
        self.assertIn('merge', due.stdout)
        self.assertEqual(self.reset('due').returncode, 1, 'a refusal is reported once')

    def test_an_agents_own_commit_or_an_old_one_is_refused(self):
        write(self.repo, 'infra/reset', 'by-an-agent\n')
        git(self.repo, 'add', '-A')
        git(self.repo, 'commit', '-q', '-m', 'Start over', who=AGENT)
        self.assertEqual(self.reset('due').returncode, 2)
        write(self.repo, 'infra/reset', 'long-ago\n')
        git(self.repo, 'add', '-A')
        git(self.repo, 'commit', '-q', '-m', 'Start over', at=f'@{int(time.time()) - 5 * 86400}')
        self.assertEqual(self.reset('due').returncode, 2)

    def test_run_archives_the_runtime_data_and_job_branches_and_keeps_the_boards_keys_and_sign_ins(self):
        for n in (1, 2):
            git(self.repo, 'push', '-q', 'origin', f'main:job/{n}')
        hq, work, voice, seats = (os.path.join(self.tmp, d) for d in ('hqdata', 'work', 'voice', 'seats'))
        write(hq, 'secrets/STRIPE_KEY', 'sk')
        held = json.dumps({'kind': 'p256', 'generation': 2, 'key': 'c2lnbg==', 'retired': [{'kty': 'EC', 'crv': 'P-256', 'x': 'a', 'y': 'b'}]})
        write(hq, 'product-keys/shop/live/SHOP_SIGNING_KEY.json', held)
        write(hq, 'mail/3/1', 'attachment')
        write(hq, 'approvals/live:shop', '{}')
        db = sqlite3.connect(os.path.join(hq, 'hq.db'))
        db.executescript("""
          create table credentials (id text primary key, public_key blob not null, counter integer not null, transports text, created text not null);
          create table sessions (token text primary key, expires integer not null);
          create table settings (key text primary key, value text not null);
          create table jobs (id integer primary key, title text);
          create table migrations (id text primary key);
          insert into credentials values ('tablet', x'00', 1, null, '2026-10-01');
          insert into sessions values ('board-session', 9999999999999);
          insert into settings values ('vapid', '{}'), ('company.paused', '{}');
          insert into jobs values (1, 'Old work');""")
        db.commit()
        db.close()
        write(work, 'mirror.git/HEAD', 'ref: refs/heads/main\n')
        write(work, 'jobs/1/file', 'clone')
        write(voice, 'calls/a.json', '{}')
        write(seats, 'claude-1/token', 'signed in')
        write(seats, 'shared/claude/projects/-work-repo/memory/MEMORY.md', 'the old company')
        server_env = os.path.join(self.tmp, 'env')
        write(self.tmp, 'env', 'REPO=testco/company\nGITHUB_TOKEN=test-token\n')
        closed = []
        github = HTTPServer(('127.0.0.1', 0), pull_requests(closed))
        threading.Thread(target=github.serve_forever, daemon=True).start()

        r = self.reset('run', '2026-10-03-clean', env={'HQ_DATA': hq, 'WORK_DATA': work, 'VOICE_DATA': voice, 'SEATS_DATA': seats,
                                                       'SERVER_ENV': server_env, 'GITHUB_API': f'http://127.0.0.1:{github.server_port}'})
        github.shutdown()
        github.server_close()
        self.assertEqual(r.returncode, 0, r.stderr)
        archive = os.path.join(self.state, 'archive', '2026-10-03-clean')
        db = sqlite3.connect(os.path.join(hq, 'hq.db'))
        tables = {t for (t,) in db.execute("select name from sqlite_master where type = 'table'")}
        self.assertEqual(tables, {'credentials', 'sessions', 'settings'}, 'no migrations table: the coordinator takes it for a new database')
        self.assertEqual(db.execute('select token from sessions').fetchall(), [('board-session',)])
        self.assertEqual(db.execute('select id from credentials').fetchall(), [('tablet',)])
        self.assertEqual(db.execute('select key from settings').fetchall(), [('vapid',)])
        old = sqlite3.connect(os.path.join(archive, 'hqdata', 'hq.db'))
        self.assertEqual(old.execute('select title from jobs').fetchall(), [('Old work',)])
        self.assertTrue(os.path.exists(os.path.join(hq, 'secrets', 'STRIPE_KEY')))
        with open(os.path.join(hq, 'product-keys', 'shop', 'live', 'SHOP_SIGNING_KEY.json')) as f:
            self.assertEqual(f.read(), held, "a product keeps its key and its ring's retired public halves (its data volume stays)")
        for path in ('hqdata/mail/3/1', 'hqdata/approvals/live:shop', 'work/jobs/1/file', 'voice/calls/a.json',
                     'seats/shared/claude/projects/-work-repo/memory/MEMORY.md', 'job-branches.bundle'):
            self.assertTrue(os.path.exists(os.path.join(archive, path)), path)
        self.assertFalse(os.path.exists(os.path.join(hq, 'mail')))
        self.assertTrue(os.path.exists(os.path.join(work, 'mirror.git', 'HEAD')))
        self.assertTrue(os.path.exists(os.path.join(seats, 'claude-1', 'token')))
        self.assertEqual(git(self.repo, 'ls-remote', '--heads', 'origin', 'job/*'), '', 'the job branches are gone')
        self.assertIn('job/1', git(self.repo, 'bundle', 'list-heads', os.path.join(archive, 'job-branches.bundle')))
        self.assertEqual(closed, [11], "only the job branch's own pull request is closed")
        write(self.repo, 'infra/reset', '2026-10-03-clean\n')
        self.assertEqual(self.reset('due').returncode, 1, 'done: never again')


def pull_requests(closed):
    class GitHub(BaseHTTPRequestHandler):
        def do_GET(self):
            pulls = [{'number': 11, 'head': {'ref': 'job/1', 'repo': {'full_name': 'testco/company'}}},
                     {'number': 12, 'head': {'ref': 'job/2', 'repo': {'full_name': 'someone/fork'}}},
                     {'number': 13, 'head': {'ref': 'hosting', 'repo': {'full_name': 'testco/company'}}}]
            self.answer(pulls if self.headers['authorization'] == 'Bearer test-token' and 'page=1' in self.path else [])

        def do_PATCH(self):
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            if body == {'state': 'closed'}:
                closed.append(int(self.path.rsplit('/', 1)[1]))
            self.answer({})

        def answer(self, body):
            data = json.dumps(body).encode()
            self.send_response(200)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):
            pass
    return GitHub


if __name__ == '__main__':
    unittest.main()
