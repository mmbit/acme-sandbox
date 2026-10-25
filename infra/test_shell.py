#!/usr/bin/env python3
"""python3 infra/test_shell.py: the Overseer's way in takes a GitHub token for this repo's overseer workflow on main, once,
and nothing else; it does only its fixed actions, on compose's own services and infra's own test files; its output cuts
key-shaped words. Tokens are signed with a throwaway RSA key by openssl, as GitHub's
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
        self.assertEqual(shell.commands({'action': 'logs', 'service': 'coordinator', 'lines': 50}, known)[0][-3:],
                         ['--tail', '50', 'coordinator'])
        self.assertEqual(shell.commands({'action': 'restart', 'service': 'worker'}, known)[0][-2:], ['restart', 'worker'])
        self.assertEqual(shell.commands({'action': 'deploy'}, known)[0][:3], ['systemctl', 'start', '--no-block'])
        self.assertTrue(all(isinstance(argv, list) for argv in shell.commands({'action': 'status'}, known)))
        for request in ({'action': 'logs', 'service': 'coordinator; rm -rf /'}, {'action': 'restart', 'service': 'caddy'},
                        {'action': 'logs', 'service': 'worker', 'lines': 10 ** 6}, {'action': 'exec', 'command': 'id'},
                        {'command': 'id'}):
            self.assertIsInstance(shell.commands(request, known), str, request)

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
        status, text = post({'action': 'logs', 'service': 'coordinator', 'lines': 5}, f'Bearer {token()}')
        self.assertEqual(status, 200, text)
        self.assertIn('compose logs --no-color --timestamps --tail 5 coordinator', text)
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

    def test_output_cuts_key_shaped_words_and_keeps_the_rest(self):
        out, code = shell.run([['echo', 'key sk_live_0123456789abcdef and ok'], ['false']])
        self.assertEqual(code, 1)
        self.assertIn('[a key, cut] and ok', out)
        self.assertNotIn('sk_live_0123', out)


if __name__ == '__main__':
    unittest.main()
