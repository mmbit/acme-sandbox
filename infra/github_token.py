#!/usr/bin/env python3
"""Gets the server's GitHub token into its env file (/etc/<SERVER_NAME>/env, which SERVER_ENV names) without it ever
sitting in cloud-init user_data (served unauthenticated at 169.254.169.254) and without SSH.

  seal                   provision.sh: BOOT_KEY + SERVER_GITHUB_TOKEN from the env -> payload on stdout
  serve PORT KEYFILE     first boot: accept exactly one payload sealed with KEYFILE's key, write the token, exit
  adopt FILE             sync.sh: take a token the board typed on the desk phone (the coordinator's key store)

The bootstrap key (user_data) is 32 bytes of HMAC key plus a 256-byte one-time pad. The token is XORed with the
pad and authenticated with HMAC-SHA256: stdlib only, and nothing to tune. The key is used for one payload only, so
someone who reads user_data later learns nothing unless they also recorded that one request on the network.
Exit codes for adopt: 0 token installed, 1 nothing to do, 2 refused (the file is deleted either way).
"""
import base64, hashlib, hmac, os, re, stat, sys, time
from http.server import BaseHTTPRequestHandler, HTTPServer

ENV = os.environ.get('SERVER_ENV', '')   # the server's env file: sync.sh and cloud-init name it
TOKEN = re.compile(r'github_pat_[A-Za-z0-9_]{20,240}')   # fine-grained PATs; also safe to source from bash
MAC, PAD = 32, 256


def install(token):
    """Replace GITHUB_TOKEN in the env file: atomic, 0600, and the value never goes through a shell or sed."""
    try:
        lines = [l for l in open(ENV).read().splitlines() if not l.startswith('GITHUB_TOKEN=')]
    except FileNotFoundError:
        lines = []
    tmp = f'{ENV}.new'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with open(fd, 'w') as f:
        f.write('\n'.join(lines + [f'GITHUB_TOKEN={token}']) + '\n')
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, 0o600)
    os.replace(tmp, ENV)


def split(key_hex):
    key = bytes.fromhex(key_hex.strip())
    assert len(key) == MAC + PAD, 'bootstrap key must be 288 bytes (576 hex digits)'
    return key[:MAC], key[MAC:]


def seal(key_hex, token):
    assert TOKEN.fullmatch(token), 'SERVER_GITHUB_TOKEN must be a fine-grained token (github_pat_...)'
    mac, pad = split(key_hex)
    ct = bytes(a ^ b for a, b in zip(token.encode(), pad))
    return base64.b64encode(hmac.new(mac, ct, hashlib.sha256).digest() + ct).decode()


def unseal(key_hex, payload):
    """The token, or None if the payload wasn't sealed with this key or doesn't hold a token."""
    mac, pad = split(key_hex)
    try:
        raw = base64.b64decode(payload, validate=True)
    except ValueError:
        return None
    tag, ct = raw[:MAC], raw[MAC:]
    if len(ct) > PAD or not hmac.compare_digest(tag, hmac.new(mac, ct, hashlib.sha256).digest()):
        return None
    token = bytes(a ^ b for a, b in zip(ct, pad)).decode('ascii', 'replace')
    return token if TOKEN.fullmatch(token) else None


def serve(port, keyfile, seconds=3600):
    key = open(keyfile).read()
    done = []

    class Handler(BaseHTTPRequestHandler):
        timeout = 10   # one slow client can't hold the single-threaded listener

        def do_POST(self):
            size = int(self.headers.get('content-length') or 0)
            token = unseal(key, self.rfile.read(size)) if 0 < size <= 4096 else None
            if token and not done:
                install(token)
                done.append(True)
            self.send_response(200 if token else 403)
            self.end_headers()
            self.wfile.write(b'ok\n' if token else b'no\n')

        def log_message(self, fmt, *args):   # one line per attempt, never the body
            print(f'{self.client_address[0]} {fmt % args}', file=sys.stderr)

    srv = HTTPServer(('', port), Handler)
    srv.timeout = 5
    deadline = time.time() + seconds
    while not done and time.time() < deadline:
        srv.handle_request()
    srv.server_close()
    if not done:
        sys.exit('no token arrived in time')
    os.remove(keyfile)   # user_data still has it, but it opens nothing any more


def adopt(path):
    """A token the board typed on the desk phone. Read without following links (the coordinator owns that
    directory), installed, then removed from the key store."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return 1
    except OSError:   # a symlink or something else odd: never read it
        os.unlink(path)
        print('SERVER_GITHUB_TOKEN in the key store is not a plain file: removed', file=sys.stderr)
        return 2
    with open(fd, 'rb') as f:
        token = f.read(4096).decode('ascii', 'replace').strip() if stat.S_ISREG(os.fstat(fd).st_mode) else ''
    if not TOKEN.fullmatch(token):
        os.unlink(path)
        print('SERVER_GITHUB_TOKEN in the key store is not a fine-grained token (github_pat_...): removed', file=sys.stderr)
        return 2
    install(token)
    os.unlink(path)
    return 0


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd in ('serve', 'adopt') and not ENV:
        sys.exit('SERVER_ENV must name the env file')
    if cmd == 'seal':
        print(seal(os.environ['BOOT_KEY'], os.environ['SERVER_GITHUB_TOKEN']))
    elif cmd == 'serve':
        serve(int(sys.argv[2]), sys.argv[3], int(sys.argv[4]) if len(sys.argv) > 4 else 3600)
    elif cmd == 'adopt':
        sys.exit(adopt(sys.argv[2]))
    else:
        sys.exit(__doc__)
