"""Local stand-ins for the voice line's checks, each on a free port: care's phone port (CareService), and a JSON
service of the check's own (JsonHandler, served by serve).
"""
import json, select, socket, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class JsonHandler(BaseHTTPRequestHandler):
    """A request handler that reads and answers JSON, streams NDJSON chunk by chunk, and logs nothing."""
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def body(self):
        return json.loads(self.rfile.read(int(self.headers.get('content-length') or 0)) or '{}')

    def answer(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def stream(self):
        self.send_response(200)
        self.send_header('content-type', 'application/x-ndjson')
        self.send_header('transfer-encoding', 'chunked')
        self.end_headers()

    def chunk(self, item):
        data = (json.dumps(item) + '\n').encode()
        self.wfile.write(f'{len(data):x}\r\n'.encode() + data + b'\r\n')
        self.wfile.flush()

    def end_stream(self):
        self.wfile.write(b'0\r\n\r\n')
        self.wfile.flush()


def serve(handler):
    http = ThreadingHTTPServer(('127.0.0.1', 0), handler)
    http.daemon_threads = True
    threading.Thread(target=http.serve_forever, daemon=True).start()
    return http


class CareService:
    """care's phone port, answering the three routes as care does (NDJSON, chunked, as Node streams it) to the line's
    token alone. /phone/start answers `start` (a status and a body, or a function of the request's body giving them).
    Each /phone/turn streams the next of `turns`, else reply(body): a list of NDJSON objects, a chunk each, where 'hold'
    waits until `go` is set or the line closes the request and 'cut' closes it there, without the last chunk; or a
    status alone; or bytes, a body framed by hand, sent a few bytes at a time. /phone/end is noted. `asked` is every
    request's path and body; `closed` the turns the line closed before their end."""
    def __init__(self, start, reply=lambda body: [{'text': 'Sure.'}, {'end': True}], token='care-test-token'):
        self.start, self.reply = start, reply
        self.turns, self.asked, self.closed, self.go = [], [], [], threading.Event()
        service = self

        class Handler(JsonHandler):
            def do_POST(self):
                body = self.body()
                if self.headers.get('authorization') != f'Bearer {token}':
                    return self.answer(401, {})
                service.asked.append((self.path, body))
                if self.path == '/phone/start':
                    return self.answer(*(service.start(body) if callable(service.start) else service.start))
                if self.path == '/phone/end':
                    return self.answer(200, {})
                script = service.turns.pop(0) if service.turns else service.reply(body)
                if isinstance(script, int):
                    return self.answer(script, {'error': 'no'})
                self.stream()
                if isinstance(script, bytes):
                    for i in range(0, len(script), 7):
                        self.wfile.write(script[i:i + 7])
                        self.wfile.flush()
                    return
                for item in script:
                    if item == 'cut':
                        return
                    if item == 'hold':
                        if not self.hold():
                            service.closed.append(body['text'])
                            return
                        continue
                    self.chunk(item)
                self.end_stream()

            def hold(self):
                """Waits for go; False once the line has closed the request."""
                while not service.go.wait(0.02):
                    if select.select([self.connection], [], [], 0)[0] and not self.connection.recv(1, socket.MSG_PEEK):
                        return False
                return True

        self.http = serve(Handler)
        self.url = f'http://127.0.0.1:{self.http.server_address[1]}'

    def stop(self):
        self.go.set()
        self.http.shutdown()
        self.http.server_close()

    def paths(self):
        return [path for path, _ in self.asked]

    def turned(self):
        return [body for path, body in self.asked if path == '/phone/turn']
