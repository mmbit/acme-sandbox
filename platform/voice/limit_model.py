"""A model API that turns every request away as a Claude seat at its usage limit does, for the real CLI to talk to
(ANTHROPIC_BASE_URL): HTTP 429 with the unified rate-limit headers it reads. No dependencies.
"""
import atexit, json, os, shutil, tempfile, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HEADERS = {'content-type': 'application/json', 'x-should-retry': 'false',
           'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': '{reset}',
           'anthropic-ratelimit-unified-representative-claim': 'five_hour',
           'anthropic-ratelimit-unified-5h-utilization': '1.0', 'anthropic-ratelimit-unified-5h-reset': '{reset}',
           'anthropic-ratelimit-unified-overage-status': 'rejected',
           'anthropic-ratelimit-unified-overage-disabled-reason': 'org_level_disabled'}


class Limited(BaseHTTPRequestHandler):
    reset = 0  # when the window resets (Unix seconds)

    def log_message(self, *a):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get('content-length', 0)))
        if not self.path.startswith('/v1/messages') or 'count_tokens' in self.path:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(429)
        for k, v in HEADERS.items():
            self.send_header(k, v.format(reset=self.reset))
        self.end_headers()
        error = {'type': 'rate_limit_error', 'message': 'Rate limited'}
        self.wfile.write(json.dumps({'type': 'error', 'error': error}).encode())


def serve(reset):
    """The model on 127.0.0.1 (a free port), its window resetting at `reset`: (url, stop)."""
    handler = type('At', (Limited,), {'reset': int(reset)})
    httpd = ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return f'http://127.0.0.1:{httpd.server_address[1]}', httpd.shutdown


def cli_env(env, url):
    """The call agent's environment (guard.agent_env: the CLI config is the test's Paths.cli_config), at the model."""
    return {**env, 'ANTHROPIC_BASE_URL': url, 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1'}


def installed():
    return shutil.which('claude') is not None


def tmp():
    """A throwaway folder (the CLI's config, the checkout, the seat's token), gone when the run ends."""
    d = tempfile.mkdtemp(prefix='limit-model-', dir=os.environ.get('TMPDIR'))
    atexit.register(shutil.rmtree, d, True)
    return d
