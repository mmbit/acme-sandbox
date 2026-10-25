#!/usr/bin/env python3
"""The Overseer's way in when HQ itself is down (the board, 18 October): a host service, outside every container, that
does one of a fixed set of actions for a GitHub Actions run of this repo's own .github/workflows/overseer.yml on main,
and answers with what it saw. The actions, and nothing else (the board chose a fixed set over free commands):
  status            the containers, memory, disk and the deploy's latest runs
  logs <service>    a service's last lines (lines: up to 2000)
  restart <service> one service restarted
  deploy            the deploy now (sync.sh), so a fix or a revert pushed to main lands at once
  tests <file>      one of infra's own test files (infra/test_*.py, *.sh) from the server's checkout, on the server's
                    own tools, as nobody with an empty environment: no Docker, no keys, nothing written in the checkout
Each request carries the run's OIDC token, signed by GitHub: its signature (openssl, against GitHub's published keys),
issuer, audience, repository, workflow and branch are all checked, and a token is taken once.

Installed by harden.sh as a systemd service, listening on Docker's bridge only, where Caddy's /__shell reaches it.
python3 infra/shell.py serve | python3 infra/test_shell.py
"""
import base64
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ISSUER = 'https://token.actions.githubusercontent.com'
JWKS_URL = os.environ.get('SHELL_JWKS', f'{ISSUER}/.well-known/jwks')
WORKFLOW = '.github/workflows/overseer.yml'
ACTION_S = 600  # one action's time
LINES_MAX = 2000
OUTPUT_MAX = 512 * 1024  # of its output, the last part
BODY_MAX = 4 * 1024
# A test runs as nobody (65534 on Debian and Ubuntu), with only these in its environment.
NOBODY = ['setpriv', '--reuid=65534', '--regid=65534', '--clear-groups', '--',
          'env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/tmp', 'LANG=C.UTF-8']
TESTS = re.compile(r'test_[a-z0-9_]+\.(py|sh)')
COMPOSE = ['docker', 'compose', '-f', 'infra/compose.yaml', '-f', 'infra/generated/products.yaml']
# Key-shaped words never leave in the output (it lands in the workflow's log)
KEYS = re.compile(r'\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}'
                  r'|\bsk-ant-[A-Za-z0-9_-]{20,}|\bsk-[A-Za-z0-9_-]{32,}|\bhelper_[A-Za-z0-9_-]{20,}|\bxox[abp]-[A-Za-z0-9-]{10,}'
                  r'|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----')

seen = {}  # a token's id → its expiry: each is taken once
lock = threading.Lock()


def b64(text):
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


def der_len(n):
    return bytes([n]) if n < 128 else bytes([0x80 | ((n.bit_length() + 7) // 8)]) + n.to_bytes((n.bit_length() + 7) // 8, 'big')


def der(tag, body):
    return bytes([tag]) + der_len(len(body)) + body


def pem(jwk):
    """A JWK's RSA key as a PEM public key (SubjectPublicKeyInfo), for openssl."""
    ints = b''.join(der(0x02, b'\x00' + b if b[0] & 0x80 else b) for b in (b64(jwk['n']), b64(jwk['e'])))
    algorithm = der(0x30, der(0x06, bytes.fromhex('2a864886f70d010101')) + b'\x05\x00')
    info = der(0x30, algorithm + der(0x03, b'\x00' + der(0x30, ints)))
    return '-----BEGIN PUBLIC KEY-----\n' + base64.encodebytes(info).decode() + '-----END PUBLIC KEY-----\n'


def jwks():
    with urllib.request.urlopen(JWKS_URL, timeout=20) as res:
        return {k['kid']: k for k in json.load(res)['keys']}


# GitHub's keys, kept an hour; a token naming one not kept fetches them again at most once a minute, one fetch at a time,
# so requests anyone can send don't each fetch them. 'at' is the last try, 'got'
# the last fetch that worked: keys older than an hour are never used, and a failed fetch is an error, not an unknown key.
KEYS_KEPT_S, KEYS_RETRY_S = 3600, 60
keys_kept = {'keys': {}, 'at': None, 'got': None}
keys_lock = threading.Lock()


def key_of(kid):
    with keys_lock:
        now, at, got = time.monotonic(), keys_kept['at'], keys_kept['got']
        old = got is None or now - got >= KEYS_KEPT_S
        if (old or kid not in keys_kept['keys']) and (at is None or now - at >= KEYS_RETRY_S):
            keys_kept['at'] = now
            keys_kept['keys'] = jwks()
            keys_kept['got'] = now
        elif old:
            raise RuntimeError('their last fetch failed under a minute ago')
        return keys_kept['keys'].get(kid)


def verified(token, repo, audience, now=None, keys=None):
    """The token's claims when it's a fresh GitHub token for this repo's overseer workflow on main, else why not."""
    now = time.time() if now is None else now
    try:
        head, body, sig = token.split('.')
        header, claims = json.loads(b64(head)), json.loads(b64(body))
    except Exception:
        return None, 'not a token'
    if header.get('alg') != 'RS256':
        return None, 'not RS256'
    try:
        key = keys.get(header.get('kid')) if keys is not None else key_of(header.get('kid'))
    except Exception as e:
        print(f"GitHub's keys didn't load: {e}", flush=True)
        return None, "GitHub's keys didn't load"
    if not key:
        return None, 'an unknown key'
    with tempfile.TemporaryDirectory() as tmp:
        for name, data in (('k.pem', pem(key).encode()), ('s', b64(sig)), ('d', f'{head}.{body}'.encode())):
            with open(f'{tmp}/{name}', 'wb') as f:
                f.write(data)
        ok = subprocess.run(['openssl', 'dgst', '-sha256', '-verify', f'{tmp}/k.pem', '-signature', f'{tmp}/s', f'{tmp}/d'],
                            capture_output=True).returncode == 0
    if not ok:
        return None, 'a bad signature'
    checks = [
        (claims.get('iss') == ISSUER, 'another issuer'),
        (claims.get('aud') == audience, 'another audience'),
        (claims.get('repository') == repo, 'another repository'),
        (claims.get('ref') == 'refs/heads/main', 'not main'),
        (str(claims.get('workflow_ref', '')).startswith(f'{repo}/{WORKFLOW}@refs/heads/main'), 'another workflow'),
        (claims.get('exp', 0) > now >= claims.get('nbf', claims.get('iat', 0)) - 60, 'out of date'),
    ]
    for passed, why in checks:
        if not passed:
            return None, why
    with lock:
        for jti in [j for j, exp in seen.items() if exp < now]:
            del seen[jti]
        if claims.get('jti') in seen:
            return None, 'already taken'
        seen[claims.get('jti')] = claims['exp']
    return claims, ''


def services():
    """The services compose knows here: the only names logs and restart take."""
    done = subprocess.run([*COMPOSE, 'config', '--services'], cwd=os.environ.get('SHELL_CWD', '/'), capture_output=True,
                          text=True, timeout=60)
    return set(done.stdout.split())


def tests():
    """infra's own test files in the server's checkout: the only names tests takes."""
    return {name for name in os.listdir(os.path.join(os.environ.get('SHELL_CWD', '/'), 'infra')) if TESTS.fullmatch(name)}


def commands(request, known=None, files=None):
    """The command lines of the action a request names, or why it isn't one of the fixed set."""
    action, service, server = request.get('action'), request.get('service'), os.environ.get('SERVER_NAME', '')
    known, files = known or services, files or tests
    if action == 'status':
        return [['docker', 'ps', '-a', '--format', 'table {{.Names}}\t{{.Status}}\t{{.Image}}'], ['free', '-m'],
                ['df', '-h', '/'], ['uptime'],
                ['systemctl', 'status', '--no-pager', '--lines', '8', f'{server}-sync.service', f'{server}-shell.service']]
    if action == 'deploy':
        return [['systemctl', 'start', '--no-block', f'{server}-sync.service']]
    if action in ('logs', 'restart'):
        if not isinstance(service, str) or service not in known():
            return f'no such service: {service!r}'
        if action == 'restart':
            return [[*COMPOSE, 'restart', service]]
        lines = request.get('lines', 300)
        if not isinstance(lines, int) or not 0 < lines <= LINES_MAX:
            return f'lines: 1 to {LINES_MAX}'
        return [[*COMPOSE, 'logs', '--no-color', '--timestamps', '--tail', str(lines), service]]
    if action == 'tests':
        name = request.get('test')
        name = name.removeprefix('infra/') if isinstance(name, str) else name
        if not isinstance(name, str) or name not in files():
            return f'no such test: {request.get("test")!r} (infra/test_*.py or *.sh)'
        return [[*NOBODY, 'python3' if name.endswith('.py') else 'bash', f'infra/{name}']]
    return 'the actions: status, logs <service>, restart <service>, deploy, tests <file>'


def run(lines):
    """The actions' output (stderr in) and the last exit code, from the server's checkout, key-shaped words cut."""
    out, code = b'', 0
    for argv in lines:
        try:
            done = subprocess.run(argv, cwd=os.environ.get('SHELL_CWD', '/'), capture_output=True, timeout=ACTION_S,
                                  stdin=subprocess.DEVNULL)
            out, code = out + done.stdout + done.stderr + b'\n', done.returncode
        except subprocess.TimeoutExpired as e:
            out, code = out + (e.stdout or b'') + (e.stderr or b'') + f'\n(stopped after {ACTION_S} s)\n'.encode(), 124
        except FileNotFoundError:
            out, code = out + f'{argv[0]}: not on this server\n'.encode(), 127
    return KEYS.sub('[a key, cut]', out[-OUTPUT_MAX:].decode('utf-8', 'replace')), code


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        auth = self.headers.get('authorization', '')
        size = int(self.headers.get('content-length') or 0)
        if not auth.startswith('Bearer ') or size > BODY_MAX:
            return self.answer(401, 'no token')
        claims, why = verified(auth[7:], os.environ['REPO'], os.environ['SHELL_AUDIENCE'])
        if not claims:
            return self.answer(403, f'refused: {why}')
        try:
            request = json.loads(self.rfile.read(size))
            lines = commands(request)
        except Exception:
            return self.answer(400, 'send {"action": "status" | "logs" | "restart" | "deploy" | "tests", "service": "...",'
                                    ' "test": "..."}')
        if isinstance(lines, str):
            return self.answer(400, lines)
        started = time.time()
        output, code = run(lines)
        print(f'run {claims.get("run_id")} by {claims.get("actor")}: {request.get("action")}'
              f' {request.get("test" if request.get("action") == "tests" else "service") or ""}'
              f' exit {code} after {time.time() - started:.0f} s', flush=True)
        self.answer(200, f'{output}\n(exit {code})\n')

    def answer(self, status, text):
        data = text.encode()
        self.send_response(status)
        self.send_header('content-type', 'text/plain; charset=utf-8')
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


if __name__ == '__main__' and sys.argv[1:] == ['serve']:
    host, port = os.environ.get('SHELL_BIND', '172.17.0.1:8722').rsplit(':', 1)
    ThreadingHTTPServer((host, int(port)), Handler).serve_forever()
