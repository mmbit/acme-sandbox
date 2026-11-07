#!/usr/bin/env python3
"""python3 infra/test_shell.py: the Overseer's way in takes a GitHub token for this repo's overseer workflow on main, once,
and nothing else; it does only its fixed actions, on compose's own services and infra's own test files; a logs read says
what it covers; its output cuts key-shaped words. Tokens are signed with a throwaway RSA key by openssl, as GitHub's
are with its own."""
import base64
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shell  # noqa: E402

REPO, AUD = 'acme/shop', 'overseer-shell:hq.example.com'
os.environ['SHELL_CWD'] = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # this checkout, as the server's
tmp = tempfile.mkdtemp()
subprocess.run(['openssl', 'genrsa', '-out', f'{tmp}/key.pem', '2048'], check=True, capture_output=True)
modulus = subprocess.run(['openssl', 'rsa', '-in', f'{tmp}/key.pem', '-noout', '-modulus'], capture_output=True, text=True,
                         check=True).stdout.split('=')[1].strip()
enc = lambda b: base64.urlsafe_b64encode(b).rstrip(b'=').decode()
KEYS = {'k1': {'kid': 'k1', 'kty': 'RSA', 'n': enc(bytes.fromhex(modulus)), 'e': enc((65537).to_bytes(3, 'big'))}}


def token(**over):
    now = int(time.time())
    claims = {'iss': shell.ISSUER, 'aud': AUD, 'repository': REPO, 'ref': 'refs/heads/main',
              'workflow_ref': f'{REPO}/.github/workflows/overseer.yml@refs/heads/main', 'iat': now, 'nbf': now,
              'exp': now + 300, 'jti': os.urandom(8).hex(), 'run_id': '1', 'actor': 'board'}
    claims.update(over)
    head = enc(json.dumps({'alg': 'RS256', 'kid': 'k1'}).encode()) + '.' + enc(json.dumps(claims).encode())
    with open(f'{tmp}/d', 'w') as f:
        f.write(head)
    sig = subprocess.run(['openssl', 'dgst', '-sha256', '-sign', f'{tmp}/key.pem', f'{tmp}/d'], capture_output=True,
                         check=True).stdout
    return f'{head}.{enc(sig)}'


def check(t):
    return shell.verified(t, REPO, AUD, keys=KEYS)[1]


# journalctl as the server's: --field lists a field's values; a read gives the last --lines entries of those matching,
# from --since to --until (both included, @ seconds since the epoch), oldest first, as JSON. With --until but no --since
# it starts --lines before until, or at the head, and reads on past until
JOURNALCTL = """import json, os, sys
entries, args = json.load(open(os.environ['SHELL_JOURNAL'])), sys.argv[1:]
if args == ['--field=CONTAINER_NAME']:
    print('\\n'.join(sorted({e['CONTAINER_NAME'] for e in entries})))
    sys.exit()
opt = lambda name: next((a.split('=', 1)[1] for a in args if a.startswith(f'--{name}=')), None)
since, until, names = opt('since'), opt('until'), [a.split('=', 1)[1] for a in args if a.startswith('CONTAINER_NAME=')]
usec = lambda at: round(float(at[1:]) * 10**6)
lines = int(opt('lines'))
ours = [e for e in entries if e['CONTAINER_NAME'] in names]
found = [e for e in ours if (since is None or int(e['__REALTIME_TIMESTAMP']) >= usec(since))
         and (until is None or int(e['__REALTIME_TIMESTAMP']) <= usec(until))]
if until is not None and since is None:
    start = max(len(found) - lines, 0)   # lines before until, or the head
    found = ours[start:start + lines]
for e in found[-lines:]:
    print(json.dumps(e))
"""
with open(f'{tmp}/journalctl.py', 'w') as f:
    f.write(JOURNALCTL)
shell.JOURNALCTL = [sys.executable, f'{tmp}/journalctl.py']


def at(minute, second=0):
    """2026-11-07T04:<minute>:<second>Z in microseconds since the epoch."""
    return (1794026400 + (minute - 40) * 60 + second) * 10**6


def entry(name, id, usec, message):
    """A journal entry as journalctl's JSON has it: its container, the container's id, microseconds and message."""
    return {'__REALTIME_TIMESTAMP': str(usec), 'CONTAINER_NAME': name, 'CONTAINER_ID': id, 'MESSAGE': message}


def on_journal(entries):
    """The stand-in journal's entries, in the journal's order: (container, its id, microseconds, message)."""
    with open(f'{tmp}/journal.json', 'w') as f:
        json.dump([entry(*e) for e in entries], f)
    os.environ['SHELL_JOURNAL'] = f'{tmp}/journal.json'


class Shell(unittest.TestCase):
    def test_only_this_repos_overseer_workflow_on_main_once(self):
        good = token()
        self.assertEqual(check(good), '')
        self.assertEqual(check(good), 'already taken')
        self.assertEqual(check(token(repository='other/repo')), 'another repository')
        self.assertEqual(check(token(ref='refs/heads/job/1')), 'not main')
        self.assertEqual(check(token(workflow_ref=f'{REPO}/.github/workflows/other.yml@refs/heads/main')), 'another workflow')
        self.assertEqual(check(token(aud='someone-else')), 'another audience')
        self.assertEqual(check(token(exp=int(time.time()) - 1)), 'out of date')
        # claims changed after signing: the signature no longer holds
        head, body, sig = token(repository='other/repo').split('.')
        forged = enc(json.dumps({**json.loads(shell.b64(body)), 'repository': REPO}).encode())
        self.assertEqual(check(f'{head}.{forged}.{sig}'), 'a bad signature')
        self.assertEqual(check('a.b'), 'not a token')

    def test_only_the_fixed_actions_on_compose_services(self):
        known = lambda: {'coordinator', 'worker'}
        self.assertEqual(shell.commands({'action': 'logs', 'service': 'coordinator', 'lines': 50}, known),
                         shell.Logs('coordinator', 50, None, None))
        self.assertEqual(shell.commands({'action': 'restart', 'service': 'worker'}, known)[0][-2:], ['restart', 'worker'])
        self.assertEqual(shell.commands({'action': 'deploy'}, known)[0][:3], ['systemctl', 'start', '--no-block'])
        self.assertTrue(all(isinstance(argv, list) for argv in shell.commands({'action': 'status'}, known)))
        for request in ({'action': 'logs', 'service': 'coordinator; rm -rf /'}, {'action': 'restart', 'service': 'caddy'},
                        {'action': 'logs', 'service': 'worker', 'lines': 10 ** 6}, {'action': 'exec', 'command': 'id'},
                        {'command': 'id'}):
            self.assertIsInstance(shell.commands(request, known), str, request)

    def test_logs_reads_an_interval_given_as_utc_timestamps(self):
        known = lambda: {'worker'}
        request = {'action': 'logs', 'service': 'worker', 'lines': 2000}
        self.assertEqual(shell.commands({**request, 'since': '2026-11-07T04:40:00Z', 'until': '2026-11-07T04:49:00.5Z'}, known),
                         shell.Logs('worker', 2000, at(40), at(49) + 500000))
        self.assertEqual(shell.commands({**request, 'since': '2026-11-07T04:40:00.000001Z'}, known),
                         shell.Logs('worker', 2000, at(40) + 1, None))
        for interval in ({'since': '42m'}, {'since': '2026-13-07T04:40:00Z'}, {'until': '2026-11-07T04:40:00+01:00'},
                         {'until': 1762490400}, {'since': '2026-11-07T04:40:00Z --lines=99'},
                         {'until': '2026-11-07T04:40:00.0000001Z'},
                         {'since': '2026-11-07T04:49:00Z', 'until': '2026-11-07T04:40:00Z'}):
            self.assertIsInstance(shell.commands({**request, **interval}, known), str, interval)

    def test_a_logs_read_reaches_past_the_containers_compose_replaced(self):
        # worker-1 replaced at 04:42 (a changed image), beside a second worker and other services
        on_journal([('infra-worker-1', 'aaa', at(40), 'starting'), ('infra-coordinator-1', 'ccc', at(41), 'hq up'),
                    ('infra-worker-1', 'aaa', at(41, 5), 'stopping'), ('infra-worker-1', 'bbb', at(42), 'starting again'),
                    ('infra-worker-2', 'ddd', at(42, 1), 'a seat back'), ('infra-worker-x-1', 'eee', at(43), 'another service'),
                    ('infra-worker-1', 'bbb', at(43, 1), 'sk_live_abcdefgh12345678 in a line')])
        text, code = shell.read_logs(shell.Logs('worker', 300, at(40), at(43)))
        self.assertEqual((text, code), ('infra-worker-1 aaa | 2026-11-07T04:40:00.000000Z starting\n'
                                        'infra-worker-1 aaa | 2026-11-07T04:41:05.000000Z stopping\n'
                                        'infra-worker-1 bbb | 2026-11-07T04:42:00.000000Z starting again\n'
                                        'infra-worker-2 ddd | 2026-11-07T04:42:01.000000Z a seat back\n'
                                        '\n(covers: 4 lines from 2026-11-07T04:40:00.000000Z to 2026-11-07T04:42:01.000000Z;'
                                        ' no cap cut it)\n', 0))
        self.assertIn('bbb | 2026-11-07T04:43:01.000000Z [a key, cut] in a line', shell.read_logs(shell.Logs('worker', 1, None, None))[0])
        self.assertEqual(shell.read_logs(shell.Logs('voice', 300, None, None)), ('\n(covers: no lines; no cap cut it)\n', 0))

    def test_a_cut_read_goes_on_from_its_first_line_without_a_gap(self):
        # The review's two cases: the line cap over two containers, and the byte cap over long lines
        for lines, entries in ((2, [('infra-worker-2', 'w2', at(40, 0), 'zero'), ('infra-worker-1', 'w1', at(40, 1), 'one'),
                                    ('infra-worker-1', 'w1', at(40, 2), 'two'), ('infra-worker-1', 'w1', at(40, 3), 'three')]),
                               (2000, [('infra-worker-1', 'w1', at(40, second), f'{second} ' + 'x' * (200 * 1024))
                                       for second in (0, 1, 10)])):
            on_journal(entries)
            got, until, pieces = set(), at(41), []
            while True:
                text, _ = shell.read_logs(shell.Logs('worker', lines, at(40), until))
                rows, covers = text.split('\n(covers: ')
                pieces.append(covers)
                got |= {row.split(' ', 4)[4] for row in rows.splitlines()}
                if 'no cap cut it' in covers:
                    break
                until = shell.micros(shell.INSTANT.search(covers))
            self.assertEqual(got, {message for *_, message in entries}, pieces)
            self.assertGreater(len(pieces), 1, pieces)
        on_journal([('infra-worker-1', 'w1', at(40, second), 'x' * (200 * 1024)) for second in range(4)])
        self.assertIn('2 lines from 2026-11-07T04:40:02.000000Z to 2026-11-07T04:40:03.000000Z; the 512 KiB cap left out'
                      ' earlier lines)', shell.read_logs(shell.Logs('worker', 2000, None, None))[0])
        on_journal([('infra-worker-1', 'w1', at(40, second), 'a line') for second in range(4)])
        self.assertIn('2 lines from 2026-11-07T04:40:02.000000Z to 2026-11-07T04:40:03.000000Z; the 2-line cap left out'
                      ' earlier lines)', shell.read_logs(shell.Logs('worker', 2, None, None))[0])
        # Until alone: what journalctl sends past it isn't shown, and the lines before it are all there were
        self.assertIn('2 lines from 2026-11-07T04:40:00.000000Z to 2026-11-07T04:40:01.000000Z; no cap cut it)',
                      shell.read_logs(shell.Logs('worker', 300, None, at(40, 1)))[0])
        # journalctl's stderr counts toward the byte cap, and its keys are cut before the cap can split one
        journal = shell.journal
        sent = b''.join(json.dumps(entry('infra-worker-1', 'w1', at(40, second), 'x' * (200 * 1024))).encode() + b'\n'
                        for second in range(2))
        diagnostics = b'e' * (200 * 1024)
        shell.journal = lambda logs: (sent, diagnostics, 0)
        try:
            text, _ = shell.read_logs(shell.Logs('worker', 300, None, None))
            self.assertLessEqual(len(text.split('\n(covers: ')[0].encode()), shell.OUTPUT_MAX)
            self.assertIn('1 lines from 2026-11-07T04:40:01.000000Z', text)
            body = b'A' * 36
            diagnostics = b'ghp_' + body + b'\n' + b'e' * (shell.OUTPUT_MAX - len(body) - 1)
            text, _ = shell.read_logs(shell.Logs('worker', 300, None, None))
            self.assertIn('[a key, cut]', text)
            self.assertNotIn(body.decode(), text)
            diagnostics = b'e' * (shell.OUTPUT_MAX + 1)
            self.assertIn('no lines; the 512 KiB cap left out earlier diagnostics',
                          shell.read_logs(shell.Logs('worker', 300, None, None))[0])
        finally:
            shell.journal = journal
        # A read stopped at its time cap keeps the whole entries it had sent
        journal = shell.journal
        sent = json.dumps(entry('infra-worker-1', 'w1', at(40), 'first')).encode()
        shell.journal = lambda logs: (sent + b'\n{"__REALTIME_TIMESTAMP": "17', b'', 124)
        try:
            self.assertIn('1 lines from 2026-11-07T04:40:00.000000Z to 2026-11-07T04:40:00.000000Z; the 600 s cap may'
                          ' have left out later lines', shell.read_logs(shell.Logs('worker', 300, None, None))[0])
        finally:
            shell.journal = journal

    def test_githubs_keys_are_kept_and_unknown_key_ids_fetch_them_at_most_once_a_minute(self):
        fetched, jwks, monotonic = [], shell.jwks, shell.time.monotonic
        clock = [1000.0]
        shell.jwks, shell.time.monotonic = (lambda: fetched.append(1) or KEYS), (lambda: clock[0])
        shell.keys_kept.update(keys={}, at=None, got=None)
        try:
            unknown = enc(json.dumps({'alg': 'RS256', 'kid': 'nope'}).encode()) + '.' + enc(b'{}') + '.x'
            for _ in range(50):
                self.assertEqual(shell.verified(unknown, REPO, AUD)[1], 'an unknown key')
            self.assertEqual(shell.verified(token(), REPO, AUD)[1], '')
            self.assertEqual(len(fetched), 1)
            clock[0] += shell.KEYS_RETRY_S
            shell.verified(unknown, REPO, AUD)
            shell.verified(unknown, REPO, AUD)
            self.assertEqual(len(fetched), 2)
        finally:
            shell.jwks, shell.time.monotonic = jwks, monotonic
            shell.keys_kept.update(keys={}, at=None, got=None)

    def test_keys_that_didnt_load_are_refused_for_their_own_reason_and_never_trusted_past_an_hour(self):
        fetches, jwks, monotonic = [], shell.jwks, shell.time.monotonic
        clock, down = [1000.0], []

        def fetch():
            fetches.append(1)
            if down:
                raise urllib.error.URLError('timed out')
            return KEYS
        shell.jwks, shell.time.monotonic = fetch, (lambda: clock[0])
        shell.keys_kept.update(keys={}, at=None, got=None)
        try:
            down.append(1)
            for _ in range(3):
                self.assertEqual(shell.verified(token(), REPO, AUD)[1], "GitHub's keys didn't load")
            self.assertEqual(len(fetches), 1)
            down.clear()
            clock[0] += shell.KEYS_RETRY_S
            self.assertEqual(shell.verified(token(), REPO, AUD)[1], '')
            down.append(1)
            clock[0] += shell.KEYS_KEPT_S
            for _ in range(3):
                self.assertEqual(shell.verified(token(), REPO, AUD)[1], "GitHub's keys didn't load")
            self.assertEqual(len(fetches), 3)
        finally:
            shell.jwks, shell.time.monotonic = jwks, monotonic
            shell.keys_kept.update(keys={}, at=None, got=None)

    def test_tests_takes_only_infras_own_test_files(self):
        for name in ('shell.py', 'sync.sh', '../infra/test_shell.py', 'test_shell.py; id', 'test_nothing.py', None, ['x']):
            self.assertIsInstance(shell.commands({'action': 'tests', 'test': name}), str, name)

    def test_over_http_a_signed_request_gets_its_action_and_anything_else_is_refused(self):
        os.environ.update(REPO=REPO, SHELL_AUDIENCE=AUD)
        shell.jwks, shell.services = (lambda: KEYS), (lambda: {'coordinator'})
        shell.COMPOSE = ['echo', 'compose']   # what compose would be asked, said back
        server = shell.ThreadingHTTPServer(('127.0.0.1', 0), shell.Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        def post(body, auth):
            req = urllib.request.Request(f'http://127.0.0.1:{server.server_port}/__shell', json.dumps(body).encode(),
                                         {'authorization': auth, 'content-type': 'application/json'})
            try:
                with urllib.request.urlopen(req) as res:
                    return res.status, res.read().decode()
            except urllib.error.HTTPError as e:
                return e.code, e.read().decode()
        on_journal([('infra-coordinator-1', 'c1', at(40, 30), 'hq up'), ('infra-coordinator-1', 'c1', at(41, 30), 'later')])
        status, text = post({'action': 'logs', 'service': 'coordinator', 'lines': 5, 'since': '2026-11-07T04:40:00Z',
                             'until': '2026-11-07T04:41:00Z'}, f'Bearer {token()}')
        self.assertEqual((status, text), (200, 'infra-coordinator-1 c1 | 2026-11-07T04:40:30.000000Z hq up\n\n(covers: 1 lines'
                                               ' from 2026-11-07T04:40:30.000000Z to 2026-11-07T04:40:30.000000Z; no cap cut'
                                               ' it)\n\n(exit 0)\n'))
        self.assertEqual(post({'action': 'logs', 'service': 'coordinator', 'since': 'yesterday'}, f'Bearer {token()}')[0], 400)
        # A test runs as nobody, with none of the service's environment: a checkout
        # whose one test says who it runs as and whether the service's variable reached it
        checkout = tempfile.mkdtemp()
        os.makedirs(f'{checkout}/infra')
        with open(f'{checkout}/infra/test_whoami.py', 'w') as f:
            f.write("import os\nprint('uid', os.getuid(), 'with', os.environ.get('SHELL_FIXTURE', 'nothing'), 'from the service')\n")
        for path, mode in ((checkout, 0o755), (f'{checkout}/infra', 0o755), (f'{checkout}/infra/test_whoami.py', 0o644)):
            os.chmod(path, mode)
        cwd, os.environ['SHELL_CWD'], os.environ['SHELL_FIXTURE'] = os.environ['SHELL_CWD'], checkout, 'a key'
        status, text = post({'action': 'tests', 'test': 'test_whoami.py'}, f'Bearer {token()}')
        os.environ['SHELL_CWD'] = cwd
        del os.environ['SHELL_FIXTURE']
        self.assertEqual(status, 200, text)
        if os.geteuid() == 0:   # as the server's shell service runs
            self.assertIn('uid 65534 with nothing from the service', text)
            self.assertTrue(text.endswith('(exit 0)\n'), text)
        else:   # with no root to drop, it doesn't run at all, rather than as the service's own user
            self.assertNotIn('from the service', text)
            self.assertNotIn('(exit 0)', text)
        self.assertEqual(post({'action': 'tests', 'test': 'sync.sh'}, f'Bearer {token()}')[0], 400)
        self.assertEqual(post({'action': 'status'}, 'Bearer nope')[0], 403)
        self.assertEqual(post({'action': 'logs', 'service': 'x; id'}, f'Bearer {token()}')[0], 400)
        server.shutdown()

    def limited(self, caddy, check):
        """check(post) against a shell whose Caddy is at these addresses (or its lookup, a function), on a clock the test
        moves (post's clock). post answers its status, and keeps its text in post.text."""
        os.environ.update(REPO=REPO, SHELL_AUDIENCE=AUD)
        shell.asked.clear()
        monotonic, addresses = shell.time.monotonic, shell.caddy_addresses
        clock = [1000.0]
        shell.time.monotonic = lambda: clock[0]
        shell.caddy_addresses = caddy if callable(caddy) else lambda: set(caddy)
        shell.caddy.update(at=None, failed=None)
        server = shell.ThreadingHTTPServer(('127.0.0.1', 0), shell.Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        def post(client):
            req = urllib.request.Request(f'http://127.0.0.1:{server.server_port}/__shell', b'{}',
                                         {'authorization': 'Bearer x.y.z', 'x-forwarded-for': client})
            try:
                with urllib.request.urlopen(req) as res:
                    post.text = res.read().decode()
                    return res.status
            except urllib.error.HTTPError as e:
                post.text = e.read().decode()
                return e.code
        post.clock = clock
        try:
            check(post)
        finally:
            server.shutdown()
            shell.time.monotonic, shell.caddy_addresses = monotonic, addresses
            shell.caddy.update(at=None, failed=None)
            shell.asked.clear()

    def test_each_client_gets_a_few_requests_a_minute_before_any_token_is_checked(self):
        def check(post):
            self.assertEqual([post('203.0.113.7') for _ in range(shell.ASKS_PER_WINDOW)], [403] * shell.ASKS_PER_WINDOW)
            self.assertEqual(post('203.0.113.7'), 429)
            self.assertEqual(post('198.51.100.2'), 403, 'another client has its own')
            post.clock[0] += shell.WINDOW_S
            self.assertEqual(post('203.0.113.7'), 403, 'a minute on')
        self.limited({'127.0.0.1'}, check)

    def test_a_forwarded_address_from_anyone_but_caddy_counts_under_its_peer(self):
        def check(post):
            forged = [f'203.0.113.{n}' for n in range(shell.ASKS_PER_WINDOW + 1)]
            self.assertEqual([post(f) for f in forged], [403] * shell.ASKS_PER_WINDOW + [429])
            self.assertEqual(list(shell.asked), ['127.0.0.1'])
        self.limited({'172.17.0.5'}, check)

    def test_a_caddy_lookup_that_fails_is_answered_503_and_never_kept(self):
        lookup, docker = ['fails'], shell.caddy_addresses
        def caddy():
            if lookup[0] == 'fails':
                return docker()   # compose is `false` here: it exits 1
            if lookup[0] == 'times out':
                raise subprocess.TimeoutExpired(['docker', 'inspect'], 10)
            return {'127.0.0.1'}
        def check(post):
            self.assertEqual([post('203.0.113.7') for _ in range(shell.ASKS_PER_WINDOW + 1)],
                             [503] * (shell.ASKS_PER_WINDOW + 1), 'never counted under Caddy, the peer')
            self.assertNotIn('false', post.text, "Docker's command line and stderr stay in the log")
            lookup[0] = 'times out'
            self.assertEqual(post('203.0.113.7'), 503)
            lookup[0] = 'answers'
            self.assertEqual(post('203.0.113.7'), 403, 'looked up again at once, its client counted')
        compose, shell.COMPOSE = shell.COMPOSE, ['false']
        try:
            self.limited(caddy, check)
        finally:
            shell.COMPOSE = compose

    def test_caddy_is_looked_up_again_after_a_minute_or_5_s_after_another_peer_forwards(self):
        addrs, lookups = [{'127.0.0.1'}], []
        def caddy():
            lookups.append(1)
            return addrs[0]
        def check(post):
            def at(seconds, client='203.0.113.7'):
                post.clock[0] = 1000.0 + seconds
                self.assertEqual(post(client), 403)
                return len(lookups)
            self.assertEqual([at(0), at(59), at(60)], [1, 1, 2], 'kept for a minute')
            addrs[0] = {'172.17.0.5'}   # Caddy restarted with a new address
            self.assertEqual([at(120), at(124)], [3, 3], 'another peer: kept for 5 s')
            self.assertEqual(list(shell.asked), ['127.0.0.1'], 'counted under its peer meanwhile')
            addrs[0] = {'127.0.0.1'}
            self.assertEqual(at(125, '198.51.100.2'), 4, 'and looked up again after them')
            self.assertIn('198.51.100.2', shell.asked)
        self.limited(caddy, check)

    def test_requests_that_waited_on_a_failed_lookup_fail_with_it_rather_than_each_look_again(self):
        entered, release, lookups, clock = threading.Event(), threading.Event(), [], {}
        def caddy():
            lookups.append(1)
            entered.set()
            release.wait(10)
            clock['now'][0] += 10   # the lookup took 10 s
            raise subprocess.TimeoutExpired(['docker', 'inspect'], 10)
        def check(post):
            clock['now'] = post.clock
            reads, fake = [], shell.time.monotonic
            shell.time.monotonic = lambda: reads.append(1) or fake()
            codes = []
            first = threading.Thread(target=lambda: codes.append(post('203.0.113.7')))
            first.start()
            entered.wait(10)
            seen = len(reads)
            waiting = [threading.Thread(target=lambda: codes.append(post(f'198.51.100.{n}'))) for n in range(3)]
            for thread in waiting:
                thread.start()
            while len(reads) < seen + len(waiting):   # each has read the clock it came at
                time.sleep(0.01)
            release.set()
            for thread in [first, *waiting]:
                thread.join(10)
            self.assertEqual(codes, [503] * 4)
            self.assertEqual(len(lookups), 1, 'one lookup for all four')
            lookups.clear()
            self.assertEqual(post('203.0.113.7'), 503, 'a request that came after it looks up again')
            self.assertEqual(len(lookups), 1)
        self.limited(caddy, check)

    def test_a_request_that_waited_on_a_failed_lookup_but_needs_none_is_answered_from_the_cache(self):
        lookups = []
        def check(post):
            reads, fake = [], shell.time.monotonic
            shell.time.monotonic = lambda: reads.append(1) or fake()
            shell.caddy.update(addrs={'127.0.0.1'}, at=post.clock[0])   # Caddy's address, just looked up
            codes = []
            with shell.caddy_lock:   # another peer's lookup holds the lock
                waiter = threading.Thread(target=lambda: codes.append(post('203.0.113.7')))
                waiter.start()
                while not reads:   # it has read the clock it came at
                    time.sleep(0.01)
                post.clock[0] += 10
                shell.caddy['failed'] = (post.clock[0], subprocess.TimeoutExpired(['docker', 'inspect'], 10))
            waiter.join(10)
            self.assertEqual(codes, [403], 'counted under its client, past the failure')
            self.assertEqual(lookups, [])
            self.assertIn('203.0.113.7', shell.asked)
        self.limited(lambda: lookups.append(1) or {'127.0.0.1'}, check)

    def test_output_cuts_key_shaped_words_and_keeps_the_rest(self):
        out, code = shell.run([['echo', 'key sk_live_0123456789abcdef and ok'], ['false']])
        self.assertEqual(code, 1)
        self.assertIn('[a key, cut] and ok', out)
        self.assertNotIn('sk_live_0123', out)


if __name__ == '__main__':
    unittest.main()
