"""cd platform/voice && python3 -m unittest test_guard   (guard.py and hq_tools.py: no models, no network)

CallAgent runs the real Claude CLI (skipped where it isn't installed; the worker has it) against a scripted model and a
stand-in coordinator on 127.0.0.1: the call agent starts, answers and hands work on, as on a call. CallsList runs the
tools against the real coordinator (platform/coordinator, after its npm ci) with a throwaway database.
"""
import json, os, re, shutil, socket, sqlite3, subprocess, sys, tempfile, textwrap, threading, time, unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from guard import CALL_TOOLS, HQ_TOOLS, PARTNER, PARTNER_TOOLS, TOOLS, agent_env, hq_tools_work, sign_in_pipe  # noqa: E402

HERE = str(Path(__file__).parent)
HQ = str(Path(HERE).parent / 'worker' / 'bin' / 'hq')
SEAT = 'sk-ant-oat01-' + os.urandom(8).hex()  # a stand-in for the seat's sign-in
ESTIMATE = {'size': '30m', 'refs': [], 'why': 'Small tooling change with no comparable completed scope'}
SIGN_IN_FD = 3  # where the CLI would read it (sign_in_pipe), for what runs no CLI.


def fake_hq(d):
    """An hq on PATH that notes its environment and arguments in d/hq.log, then runs the real one."""
    Path(d, 'hq').write_text(f'#!/bin/bash\n{{ env; printf "ARG %s\\n" "$@"; }} >> {d}/hq.log\nexec bash {HQ} "$@"\n')
    Path(d, 'hq').chmod(0o755)
    return {'PATH': f'{d}:{os.environ["PATH"]}'}


class Coordinator(BaseHTTPRequestHandler):
    """The coordinator's /api/agent/* (what hq calls) and the model API (/v1/messages, scripted: on the first turn the
    model says a hold line and makes the tool call in `script`, once it has a tool result it says it's done)."""
    script, seen, refuse, lose, signed_in = None, [], None, None, set()  # (refuse: the coordinator's reason for a 400, as server.ts gives it)
    slow = 0  # s the coordinator takes over each answer (a slow moment: it's still there)
    # the first turn makes its tool call with no hold line before it
    tool_first = False
    # lose: the job is taken (seen), then the answer goes astray: 'drop' closes the connection without one, a number is
    # that status with the coordinator's {error}, 'no id' a 200 without a job number

    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('content-length', 0))) or 'null')
        if self.path.startswith('/api/agent/'):
            self.seen.append(('hq', self.path, self.headers.get('authorization'), body))
            time.sleep(self.slow)
            if self.lose == 'drop':
                self.close_connection = True
                return
            if self.lose:
                self.send_response(200 if self.lose == 'no id' else self.lose); self.send_header('content-type', 'application/json'); self.end_headers()
                self.wfile.write(json.dumps({'ok': True} if self.lose == 'no id' else {'error': 'internal'}).encode())
                return
            self.send_response(400 if self.refuse else 200); self.send_header('content-type', 'application/json'); self.end_headers()
            job = {'code': 'HQ-LOGS'} if self.path == '/api/agent/job' else {}  # (a job's code)
            self.wfile.write(json.dumps({'error': self.refuse} if self.refuse else {'id': 1234, 'call': 7, **job, **{k: body[k] for k in ('kind', 'owner') if k in body}}).encode())
            return
        if not self.path.startswith('/v1/messages') or 'count_tokens' in self.path:
            self.send_response(404); self.end_headers()
            return
        done = any(isinstance(m['content'], list) and any(c.get('type') == 'tool_result' for c in m['content']) for m in body['messages'])
        self.seen.append(('model', [t['name'] for t in body.get('tools', [])], json.dumps(body['messages'])))
        self.signed_in.add(self.headers.get('authorization'))
        blocks = [{'type': 'text', 'text': 'Done, Bolt has it.' if done else 'One moment.'}]
        if not done and body.get('tools'):
            blocks = blocks[self.tool_first:] + [{'type': 'tool_use', 'id': 'toolu_1', 'name': self.script[0], 'input': self.script[1]}]
        self.send_response(200); self.send_header('content-type', 'text/event-stream'); self.end_headers()
        ev = lambda d: self.wfile.write(f'event: {d["type"]}\ndata: {json.dumps(d)}\n\n'.encode())
        ev({'type': 'message_start', 'message': {'id': 'msg_1', 'type': 'message', 'role': 'assistant', 'model': body['model'], 'content': [],
                                                 'stop_reason': None, 'usage': {'input_tokens': 1, 'output_tokens': 1}}})
        for i, b in enumerate(blocks):
            text = b['type'] == 'text'
            ev({'type': 'content_block_start', 'index': i, 'content_block': {'type': 'text', 'text': ''} if text else {**b, 'input': {}}})
            ev({'type': 'content_block_delta', 'index': i, 'delta': {'type': 'text_delta', 'text': b['text']} if text else
                {'type': 'input_json_delta', 'partial_json': json.dumps(b['input'])}})
            ev({'type': 'content_block_stop', 'index': i})
        ev({'type': 'message_delta', 'delta': {'stop_reason': 'tool_use' if blocks[-1]['type'] == 'tool_use' else 'end_turn'}, 'usage': {'output_tokens': 1}})
        ev({'type': 'message_stop'})


    def do_GET(self):  # hq search, history and call (memory.ts): one hit, no history, call 12 (13 isn't this agent's: 404)
        self.seen.append(('hq', self.path, self.headers.get('authorization'), None))
        call = re.fullmatch(r'/api/agent/call\?id=(\d+)', self.path)
        if call and call[1] not in CALLS:
            self.send_response(404); self.send_header('content-type', 'application/json'); self.end_headers()
            self.wfile.write(b'{"error":"no such call"}')
            return
        self.send_response(200); self.send_header('content-type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps(CALLS[call[1]] if call else
                                    {'semantic': True, 'hits': [{'title': 'Charter › Mission', 'pointer': 'company/CHARTER.md:5', 'source': 'handbook',
                                     'snippet': 'Make the digital world a slightly warmer place.'}]} if '/search' in self.path
                                    else {'agent': 'juno', 'jobs': [], 'requests': [], 'calls': []}).encode())


# The stand-in coordinator's calls: 12 is short (a colleague's, with its summary), 14 an hour's worth.
CALLS = {n: {'id': int(n), 'agent': 'kit', 'ts': '2026-09-27T10:00:00Z', 'request': None, 'job': 700,
             'lines': ['board: What is our mission?', 'kit: A slightly warmer, more whimsical digital world.'] * k,
             'summary': 'The board asked for the mission; Kit read it out from the charter.'}
         for n, k in (('12', 1), ('14', 300))}
MCP = [f'mcp__hq__{t}' for t in CALL_TOOLS]  # (sorted: the call's tools)


class Guard(unittest.TestCase):
    def server(self, env, then):
        """A stand-in server: takes its token as server.py does, then runs `then` as a child with the same uid."""
        code = textwrap.dedent(f'''
            import os, subprocess, sys
            sys.path.insert(0, {HERE!r})
            from guard import take_token
            take_token(os.environ)
            print(subprocess.run(['sh', '-c', {then!r}], capture_output=True, text=True).stdout, end='')
        ''')
        return subprocess.run([sys.executable, '-c', code], env=env, capture_output=True, text=True)

    def test_a_same_uid_child_cannot_read_the_token(self):
        token = 'voice-' + os.urandom(8).hex()
        r = self.server({'PATH': os.environ['PATH'], 'VOICE_TOKEN': token},
                        'env; cat /proc/$PPID/environ; tr "\\0" "\\n" < /proc/$PPID/cmdline; echo; head -c 99999999 /proc/$PPID/mem; echo control')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('control', r.stdout)  # (the child did run)
        self.assertNotIn(token, r.stdout)

    def test_control_without_the_guard_the_child_reads_it(self):
        token = 'voice-' + os.urandom(8).hex()
        r = subprocess.run([sys.executable, '-c', 'import subprocess; print(subprocess.run(["sh", "-c", "cat /proc/$PPID/environ"], capture_output=True, text=True).stdout)'],
                           env={'PATH': os.environ['PATH'], 'VOICE_TOKEN': token}, capture_output=True, text=True)
        self.assertIn(token, r.stdout)

    def test_no_token_no_line(self):
        for env in ({'PATH': os.environ['PATH']}, {'PATH': os.environ['PATH'], 'VOICE_TOKEN': ''}):
            r = self.server(env, 'echo started')
            self.assertNotEqual(r.returncode, 0)
            self.assertNotIn('started', r.stdout)
            self.assertIn('VOICE_TOKEN is not set', r.stderr)

    def test_the_agent_gets_only_its_own_environment(self):
        server = {'PATH': '/usr/bin', 'HOME': '/home/caller', 'VOICE_TOKEN': 'v', 'WORKER_TOKEN': 'w', 'GITHUB_TOKEN': 'g',
                  'NODE_OPTIONS': '--require /data/x.js', 'HQ_URL': 'http://coordinator:8080', 'ORIGIN': 'https://hq'}
        env = agent_env(server, 'http://coordinator:8080', 7, 'call-token', 'juno')
        self.assertEqual(set(env), {'PATH', 'HOME', 'LANG', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CONFIG_DIR',
                                    'DISABLE_AUTOUPDATER', 'HQ_URL', 'HQ_TOKEN', 'HQ_AGENT', 'HQ_CALL', 'CLAUDE_CODE_DISABLE_CLAUDE_MDS'})
        self.assertEqual((env['HQ_TOKEN'], env['HQ_AGENT'], env['HQ_CALL']), ('call-token', 'juno', '1'))
        self.assertEqual(env['CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR'], '7')  # (the sign-in itself on that pipe, never here)
        self.assertFalse({'v', 'w', 'g'} & set(env.values()))
        # a call with a screen: the line's screen socket and the session's key, for the screen tool
        screen = agent_env(server, 'http://coordinator:8080', 7, 'call-token', 'juno', ('/data/call/screen.sock', 'k1'))
        self.assertEqual({k: v for k, v in screen.items() if k not in env}, {'SCREEN_SOCKET': '/data/call/screen.sock', 'SCREEN_KEY': 'k1'})

    def test_tools_read_search_and_hand_on_only(self):
        args = dict(zip(TOOLS[1::2], TOOLS[2::2]))
        self.assertEqual(args['--tools'], 'Read,Grep,Glob,WebSearch')  # no Bash: no shell at all, no WebFetch
        self.assertEqual(args['--permission-mode'], 'dontAsk')
        rules = lambda s: re.findall(r'\w+(?:\([^)]*\))?', s)  # (the CLI splits on spaces outside parentheses)
        self.assertEqual(rules(args['--allowedTools']), ['Read', 'Grep', 'Glob', 'WebSearch', *MCP])  # (no say, no forward)
        self.assertEqual(json.loads(args['--mcp-config']), {'mcpServers': {'hq': {'command': sys.executable, 'args': [f'{HERE}/hq_tools.py']}}})
        self.assertIn('--strict-mcp-config', TOOLS)
        for p in ('//proc/**', '//seat/**', '//data/**'):
            self.assertIn(f'Read({p})', rules(args['--disallowedTools']))

    def test_a_call_out_has_the_partner_tools_and_no_built_in_one(self):
        """A call to a partner: its own tools, nothing that hands work on, and no Read (an outsider never has the
        company's files read to them)."""
        args = dict(zip(PARTNER[1::2], PARTNER[2::2]))
        self.assertEqual(args['--tools'], '')
        self.assertEqual(args['--allowedTools'].split(), [f'mcp__hq__{t}' for t in PARTNER_TOOLS])
        self.assertEqual(json.loads(args['--mcp-config']),
                         {'mcpServers': {'hq': {'command': sys.executable, 'args': [f'{HERE}/hq_tools.py', 'partner']}}})
        self.assertEqual((args['--permission-mode'], args['--setting-sources']), ('dontAsk', 'user'))
        self.assertIn('--strict-mcp-config', PARTNER)

    def test_a_call_out_looks_nothing_up(self):
        """A partner's call has exactly note, no_transcript, hang_up and screen (their own screen on a walk-through): no
        search or history, whose answers are the company's files, jobs and the board's answers, and which the partner's
        words could steer (house rule 9)."""
        import hq_tools
        self.assertEqual(PARTNER_TOOLS, ['hang_up', 'no_transcript', 'note', 'screen'])
        self.assertEqual(sorted(t['name'] for t in hq_tools.PARTNER_TOOLS), PARTNER_TOOLS)

    def test_a_call_cannot_hand_on_a_file(self):
        """hq job with a file, in the call agent's environment: refused before anything leaves (the file is the seat's token)."""
        hq = HQ
        secret = Path(HERE) / f'.test-seat-{os.urandom(4).hex()}'
        secret.write_text('sk-ant-oat01-' + os.urandom(8).hex())
        try:
            env = agent_env({'PATH': os.environ['PATH']}, 'http://127.0.0.1:9', SIGN_IN_FD, 'call-token', 'juno')
            r = subprocess.run(['bash', hq, 'job', 'rivet', 'x', str(secret)], env=env, capture_output=True, text=True)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn('takes no file', r.stderr)
            r = subprocess.run(['bash', hq, 'job', '--after', '5', 'rivet', 'x', str(secret)], env=env, capture_output=True, text=True)
            self.assertIn('takes no file', r.stderr)
            r = subprocess.run(['bash', hq, 'job', 'rivet', 'x', '-', str(secret)], env=env, capture_output=True, text=True)
            self.assertIn('takes no file', r.stderr)
            # stdin is how a call hands on its brief (port 9: nobody's there, and hq says nothing was queued)
            r = subprocess.run(['bash', hq, 'job', 'rivet', 'x', '-'], env=env, input='the brief', capture_output=True, text=True)
            self.assertNotIn('takes no file', r.stderr)
            self.assertIn('No job was queued', r.stderr)
        finally:
            secret.unlink()



def coordinator(test, refuse=None, lose=None):
    """A stand-in coordinator on 127.0.0.1 for one test: its URL (what it was sent: Coordinator.seen)."""
    Coordinator.seen, Coordinator.refuse, Coordinator.lose, Coordinator.signed_in = [], refuse, lose, set()
    srv = ThreadingHTTPServer(('127.0.0.1', 0), Coordinator)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    test.addCleanup(lambda: (srv.shutdown(), srv.server_close(), setattr(Coordinator, 'refuse', None), setattr(Coordinator, 'lose', None)))
    return f'http://127.0.0.1:{srv.server_port}'


def line_socket(test, answers):
    """A stand-in voice line's screen socket for one test: its path, and what each connection asked (each gets the next
    of answers)."""
    folder = tempfile.mkdtemp()
    test.addCleanup(shutil.rmtree, folder)
    path, asked = os.path.join(folder, 'screen.sock'), []
    line = socket.socket(socket.AF_UNIX)
    line.bind(path)
    line.listen()
    test.addCleanup(line.close)

    def serve():
        while answers:
            conn, _ = line.accept()
            with conn:
                asked.append(json.loads(conn.makefile().readline()))
                conn.sendall((json.dumps(answers.pop(0)) + '\n').encode())
    threading.Thread(target=serve, daemon=True).start()
    return path, asked


class HqTools(unittest.TestCase):
    def call(self, *calls, env=None):
        """hq_tools.py's replies to initialize, then these tools/call messages."""
        msgs = [{'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18'}},
                {'jsonrpc': '2.0', 'method': 'notifications/initialized'}]
        msgs += [{'jsonrpc': '2.0', 'id': i + 2, 'method': 'tools/call', 'params': {'name': n, 'arguments': a}} for i, (n, a) in enumerate(calls)]
        r = subprocess.run(HQ_TOOLS, input=''.join(json.dumps(m) + '\n' for m in msgs), env=env, capture_output=True, text=True, timeout=60)
        return [json.loads(line) for line in r.stdout.splitlines()]

    def env(self, d, url):
        """The call agent's environment, as the CLI hands it to hq_tools.py, with fake_hq."""
        return agent_env({'PATH': fake_hq(d)['PATH']}, url, SIGN_IN_FD, 'call-token', 'juno')

    def test_a_call_queuer_supplies_its_scope_estimate_and_missing_or_bad_sizes_run_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            url = coordinator(self)
            base = {'agent': 'bolt', 'code': 'LOGS', 'title': 'Logs', 'brief': 'Check the logs.'}
            out = self.call(('job', {**base, 'size': '45m', 'refs': [11, 29], 'why': 'Between a small read and a full transport fix'}),
                            ('job', base), ('job', {**base, **ESTIMATE, 'refs': ['11']}),
                            ('when', {'what': 'Logs'}), env=self.env(d, url))
        self.assertEqual(len(Coordinator.seen), 1)
        self.assertEqual({k: Coordinator.seen[0][3][k] for k in ('size', 'refs', 'why')},
                         {'size': '45m', 'refs': [11, 29], 'why': 'Between a small read and a full transport fix'})
        self.assertFalse(out[1]['result']['isError'])
        self.assertTrue(all(entry['result']['isError'] for entry in out[2:]))

    def test_the_start_up_check(self):
        self.assertTrue(hq_tools_work())

    def test_only_the_call_tools_no_say(self):
        """A chat bubble reaches nobody, so a call can't send one: its one hand-off is a job (no forward either; search,
        history and call only read)."""
        with tempfile.TemporaryDirectory() as d:
            env = {**fake_hq(d), 'HQ_URL': 'http://127.0.0.1:9'}
            r = subprocess.run(HQ_TOOLS, input=json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'}) + '\n', env=env, capture_output=True, text=True)
            out = self.call(('say', {'agent': 'bolt', 'text': 'the logs, please'}), env=env)
            self.assertFalse(Path(d, 'hq.log').exists())
        self.assertEqual([t['name'] for t in json.loads(r.stdout)['result']['tools']], ['job', 'promise', 'replace', 'expedite', 'add', 'reach', 'pin_words', 'pin_sent', 'search', 'history', 'call', 'intercom', 'eta', 'estimate', 'when', 'manage', 'waiting', 'hang_up', 'screen', 'sketch'])
        self.assertTrue(out[1]['result']['isError'])

    def test_a_partner_call_has_exactly_its_tools_and_note_and_no_transcript_run_nothing(self):
        import hq_tools
        with tempfile.TemporaryDirectory() as d:
            env = self.env(d, 'http://127.0.0.1:9')
            msgs = [{'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'}]
            msgs += [{'jsonrpc': '2.0', 'id': i + 2, 'method': 'tools/call', 'params': {'name': n, 'arguments': a}} for i, (n, a) in enumerate(
                (('note', {'what': 'Reprint ships Tuesday'}), ('no_transcript', {}), ('note', {'what': 'two\nlines'}),
                 ('job', {'agent': 'bolt', 'code': 'LOGS', **ESTIMATE, 'title': 'x', 'brief': 'y'}), ('promise', {'owner': 'juno', 'what': 'x'}),
                 ('call', {'id': 12}), ('hang_up', {}), ('search', {'query': 'parcel'}), ('history', {})))]
            r = subprocess.run([*HQ_TOOLS, 'partner'], input=''.join(json.dumps(m) + '\n' for m in msgs), env=env,
                               capture_output=True, text=True, timeout=60)
            self.assertFalse(Path(d, 'hq.log').exists(), 'none of them runs hq')
        out = [json.loads(line)['result'] for line in r.stdout.splitlines()]
        self.assertEqual([t['name'] for t in out[0]['tools']], ['note', 'no_transcript', 'hang_up', 'screen'])
        text = lambda n: (out[n]['isError'], '\n'.join(part['text'] for part in out[n]['content']))
        self.assertEqual(text(1), (False, hq_tools.NOTE_ANSWER))
        self.assertEqual(text(2), (False, hq_tools.NO_TRANSCRIPT_ANSWER))
        self.assertTrue(text(3)[0], 'a note is one plain line')
        self.assertEqual([text(n)[0] for n in (4, 5, 6)], [True, True, True], 'nothing of the board\'s calls')
        self.assertEqual(text(7), (False, hq_tools.PARTNER_HANG_UP_ANSWER))
        self.assertEqual([text(n)[0] for n in (8, 9)], [True, True], 'no look-ups for a partner')
        self.assertIn("don't say it again", hq_tools.NO_TRANSCRIPT_ANSWER)
        for reply in out[1:]:
            self.assertNotIn('Never say one aloud', '\n'.join(part['text'] for part in reply['content']))

    def test_the_screen_tool_asks_the_voice_line_on_its_socket_with_the_sessions_key(self):
        """On the board's call and a partner's: the line's answer as MCP content (a picture and its moment line, the
        moment list, or the line's refusal); arguments it can't take never reach the line; hq never gets the key."""
        region = {'x': 0.5, 'y': 0, 'width': 0.5, 'height': 0.5}
        picture = {'type': 'image/jpeg', 'data': '/9j/4AAQ'}
        moments = ['#12 17:03:12 tapped "Add to basket" (button)', '#13 17:03:14 page /shop/mug']
        path, asked = line_socket(self, [{'picture': picture, 'line': moments[0]}, {'lines': moments},
                                         {'error': 'They paused showing their screen.'}, {'lines': []}])
        with tempfile.TemporaryDirectory() as d:
            env = agent_env({'PATH': fake_hq(d)['PATH']}, 'http://127.0.0.1:9', SIGN_IN_FD, 'call-token', 'juno', (path, 'key-1'))
            out = self.call(('screen', {'at': '-20s', 'region': region, 'key': 'another'}), ('screen', {'since': '17:03'}),
                            ('screen', {}), ('screen', {'at': 'yesterday'}), ('screen', {'since': '#12', 'at': '#13'}),
                            ('screen', {'region': {**region, 'x': 2}}), ('history', {}), env=env)
            msg = {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': 'screen', 'arguments': {'since': '-2m'}}}
            partner = subprocess.run([*HQ_TOOLS, 'partner'], input=json.dumps(msg) + '\n', env=env, capture_output=True, text=True, timeout=60)
            log = Path(d, 'hq.log').read_text()
        replies = [(r['result']['isError'], r['result']['content']) for r in [*out[1:], json.loads(partner.stdout)]]
        self.assertEqual(replies[:3], [(False, [{'type': 'image', 'data': '/9j/4AAQ', 'mimeType': 'image/jpeg'}, {'type': 'text', 'text': moments[0]}]),
                                       (False, [{'type': 'text', 'text': '\n'.join(moments)}]),
                                       (True, [{'type': 'text', 'text': 'They paused showing their screen.'}])])
        self.assertEqual([error for error, _ in replies[3:6]], [True, True, True])
        self.assertEqual(replies[7], (False, [{'type': 'text', 'text': 'Nothing since then.'}]))
        self.assertEqual(asked, [{'at': '-20s', 'region': region, 'key': 'key-1'}, {'since': '17:03', 'key': 'key-1'}, {'key': 'key-1'},
                                 {'since': '-2m', 'key': 'key-1'}])
        self.assertIn('ARG history', log)
        self.assertNotIn('key-1', log)
        self.assertNotIn('SCREEN_', log)

    def test_the_sketch_tool_asks_the_voice_line_for_a_sketch_by_number_or_words(self):
        """On the board's call: the line's answer as MCP content (the sketch's picture and its line, or the line's
        refusal); an empty ask never reaches the line; a partner's call has no sketch tool; hq never gets the key."""
        picture = {'type': 'image/png', 'data': 'iVBORw0K'}
        line = 'Sketch #12 “Tote bag”: drawn 2026-10-24 14:02 UTC, last changed 2026-10-24 15:10 UTC.'
        path, asked = line_socket(self, [{'picture': picture, 'line': line}, {'error': 'No sketch has those words in its label.'}])
        with tempfile.TemporaryDirectory() as d:
            env = agent_env({'PATH': fake_hq(d)['PATH']}, 'http://127.0.0.1:9', SIGN_IN_FD, 'call-token', 'juno', (path, 'key-1'))
            out = self.call(('sketch', {'sketch': '#12'}), ('sketch', {'sketch': 'mug lid'}), ('sketch', {'sketch': ' '}),
                            ('sketch', {}), env=env)
            msg = {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': 'sketch', 'arguments': {'sketch': '12'}}}
            partner = subprocess.run([*HQ_TOOLS, 'partner'], input=json.dumps(msg) + '\n', env=env, capture_output=True, text=True, timeout=60)
            none = self.call(('sketch', {'sketch': '12'}), env=self.env(d, 'http://127.0.0.1:9'))
            self.assertFalse(Path(d, 'hq.log').exists(), 'none of them runs hq')
        replies = [(r['result']['isError'], r['result']['content']) for r in out[1:]]
        self.assertEqual(replies[:2], [(False, [{'type': 'image', 'data': 'iVBORw0K', 'mimeType': 'image/png'}, {'type': 'text', 'text': line}]),
                                       (True, [{'type': 'text', 'text': 'No sketch has those words in its label.'}])])
        self.assertEqual([error for error, _ in replies[2:]], [True, True])
        self.assertEqual(asked, [{'sketch': '#12', 'key': 'key-1'}, {'sketch': 'mug lid', 'key': 'key-1'}])
        self.assertTrue(json.loads(partner.stdout)['result']['isError'], 'no sketches for a partner')
        self.assertIn("can't be shown on this call", none[1]['result']['content'][0]['text'])

    def test_a_call_with_no_screen_has_a_screen_tool_that_says_so(self):
        with tempfile.TemporaryDirectory() as d:
            out = self.call(('screen', {}), env=self.env(d, 'http://127.0.0.1:9'))
        self.assertTrue(out[1]['result']['isError'])
        self.assertIn('no screen on this call', out[1]['result']['content'][0]['text'])

    def test_every_answer_on_the_boards_call_says_its_numbers_are_not_for_saying(self):
        """Done, refused or looked up, the agent speaks next: each answer carries the rule, except hang_up's.
"""
        with tempfile.TemporaryDirectory() as d:
            out = self.call(('job', {'agent': 'bolt', 'code': 'LOGS', **ESTIMATE, 'title': 'Logs', 'brief': 'Check them.'}), ('promise', {'owner': 'Bolt!', 'what': 'x'}),
                            ('history', {}), ('pin_sent', {'pin': 0}), ('hang_up', {}), env=self.env(d, coordinator(self)))
        self.assertEqual([r['result']['isError'] for r in out[1:]], [False, True, False, True, False])
        for reply in out[1:5]:
            words = '\n'.join(part['text'] for part in reply['result']['content'])
            self.assertIn('Never say one aloud', words)
            self.assertIn('tell the board what the work is and whose it is', words)
        goodbye = '\n'.join(part['text'] for part in out[5]['result']['content'])
        self.assertNotIn('Never say one aloud', goodbye)

    def test_hq_runs_without_the_sign_in_or_a_shell(self):
        with tempfile.TemporaryDirectory() as d:
            url = coordinator(self)
            brief = 'the logs, please: $(cat /seat/token) `id` ${CLAUDE_CODE_OAUTH_TOKEN}'
            out = self.call(('job', {'agent': 'bolt', 'code': 'LOGS', **ESTIMATE, 'title': 'x', 'brief': brief}), env=self.env(d, url))
            log = Path(d, 'hq.log').read_text()
        self.assertEqual(out[0]['result']['serverInfo']['name'], 'hq')
        self.assertIn('ARG job\nARG bolt\nARG x\nARG -\n', log)
        self.assertNotIn('the logs', log)  # (the brief goes on stdin, not in argv)
        self.assertEqual(Coordinator.seen[0][3]['prompt'], brief)  # (as typed: nothing expanded)
        self.assertIn('HQ_TOKEN=call-token', log)
        self.assertNotIn(SEAT, log)
        self.assertNotIn('CLAUDE_CODE_OAUTH_TOKEN=', log)

    def test_the_whole_brief_arrives_and_the_answer_names_the_job(self):
        brief = ('The board wants the phone logs from Monday checked for dropped calls. ' * 10)[:600]
        with tempfile.TemporaryDirectory() as d:
            url = coordinator(self)
            out = self.call(('job', {'agent': 'bolt', 'code': 'LOGS', **ESTIMATE, 'title': 'Check the phone logs', 'brief': brief}), env=self.env(d, url))
        self.assertEqual(len(brief), 600)
        self.assertEqual([s[1:3] for s in Coordinator.seen], [('/api/agent/job', 'Bearer call-token')])
        self.assertEqual(Coordinator.seen[0][3], {'agent': 'bolt', 'title': 'Check the phone logs', 'after': None, 'code': 'LOGS', **ESTIMATE, 'prompt': brief})
        self.assertFalse(out[1]['result']['isError'])
        words = '\n'.join(part['text'] for part in out[1]['result']['content'])
        self.assertIn('Queued job #1234 HQ-LOGS for bolt: Check the phone logs', words)
        self.assertIn("Not started yet: it's on bolt's list, and nobody is on it until it runs.", words)

    def test_a_thread_goes_to_hq_job_as_given_and_a_time_never_does(self):
        """ The coordinator puts the job on the thread named; the tool only keeps it one plain word. A job takes no time
        of its own: a promise's time becomes its thread's window (windows.ts)."""
        with tempfile.TemporaryDirectory() as d:
            url = coordinator(self)
            deck = {'agent': 'bolt', 'code': 'DECK', **ESTIMATE, 'title': 'Deck', 'brief': 'Make it.'}
            out = self.call(('job', {**deck, 'deadline': '1h30m', 'thread': 'shop/launch-deck'}),
                            ('job', {**deck, 'thread': '--after 3'}), env=self.env(d, url))
            log = Path(d, 'hq.log').read_text()
        self.assertIn('ARG -\nARG --thread\nARG shop/launch-deck\n', log)
        self.assertNotIn('--deadline', log)
        self.assertEqual(Coordinator.seen[0][3]['thread'], 'shop/launch-deck')
        self.assertNotIn('deadline', Coordinator.seen[0][3])
        self.assertEqual(len(Coordinator.seen), 1)
        self.assertTrue(out[2]['result']['isError'])  # (refused, and nothing reached hq)

    def test_a_job_waits_for_the_call_s_end_unless_it_starts_now(self):
        """The coordinator holds a call's job until the call ends (server.ts). The now option is the agent's choice to start
        it at once, and only true sends it."""
        with tempfile.TemporaryDirectory() as d:
            url = coordinator(self)
            deck = {'agent': 'bolt', 'code': 'DECK', **ESTIMATE, 'title': 'Deck', 'brief': 'Make it.'}
            out = self.call(('job', deck), ('job', {**deck, 'now': False}), ('job', {**deck, 'now': True}),
                            *(('job', {**deck, 'now': value}) for value in ('true', 1, None)), env=self.env(d, url))
            log = Path(d, 'hq.log').read_text()
        self.assertEqual(log.count('ARG --now\n'), 1)
        self.assertEqual([s[3].get('now') for s in Coordinator.seen], [None, None, True])
        self.assertEqual([reply['result']['isError'] for reply in out[4:]], [True, True, True])

    def test_after_queues_the_job_behind_another(self):
        """The job reaches the coordinator with its dependency, and invalid job numbers are refused.
"""
        with tempfile.TemporaryDirectory() as d:
            url = coordinator(self)
            deck = {'agent': 'bolt', 'code': 'DECK', **ESTIMATE, 'title': 'Deck', 'brief': 'Make it.'}
            out = self.call(('job', {**deck, 'after': 42}), *(('job', {**deck, 'after': value}) for value in ('42', 0)),
                            env=self.env(d, url))
        self.assertEqual([s[3].get('after') for s in Coordinator.seen], [42])
        self.assertEqual([reply['result']['isError'] for reply in out[1:]], [False, True, True])

    def test_too_long_is_refused_never_cut(self):
        with tempfile.TemporaryDirectory() as d:
            url = coordinator(self)
            out = self.call(('job', {'agent': 'bolt', 'code': 'LOGS', **ESTIMATE, 'title': 'Logs', 'brief': 'b' * 9000}),
                            ('job', {'agent': 'bolt', 'code': 'LOGS', **ESTIMATE, 'title': 't' * 200, 'brief': 'Check the logs.'}), env=self.env(d, url))
            self.assertFalse(Path(d, 'hq.log').exists())
        self.assertEqual(Coordinator.seen, [])  # (no job)
        self.assertEqual([(r['result']['isError'], r['result']['content'][0]['text']) for r in out[1:]], [
            (True, 'brief too long (9,000 > 8,000): split it into two jobs'),
            (True, 'title too long (200 > 140): keep it to one short line and put the rest in the brief')])

    def test_the_coordinators_refusal_reaches_the_agent(self):
        """Whatever it refuses (it checks the same limits), the agent hears why, and that nothing was handed on."""
        with tempfile.TemporaryDirectory() as d:
            url = coordinator(self, refuse='brief too long (8,001 > 8,000): split it into two jobs')
            out = self.call(('job', {'agent': 'bolt', 'code': 'LOGS', **ESTIMATE, 'title': 'Logs', 'brief': 'Check the logs.'}), env=self.env(d, url))
        self.assertEqual(len(Coordinator.seen), 1)
        self.assertEqual((out[1]['result']['isError'], out[1]['result']['content'][0]['text']),
                         (True, 'No job was queued: brief too long (8,001 > 8,000): split it into two jobs'))

    def test_a_lost_answer_is_unconfirmed_not_refused(self):
        """The coordinator took the job, then its answer went astray: the agent hears it may be queued, and not to send
        it again (a retry would queue it twice), never that nothing was handed on."""
        for lose, why in (('drop', 'Empty reply from server'), (500, 'HTTP 500: internal'), ('no id', 'HTTP 200: no job number')):
            with self.subTest(lose=lose), tempfile.TemporaryDirectory() as d:
                url = coordinator(self, lose=lose)
                out = self.call(('job', {'agent': 'bolt', 'code': 'LOGS', **ESTIMATE, 'title': 'Logs', 'brief': 'Check the logs.'}), env=self.env(d, url))
                self.assertEqual(len(Coordinator.seen), 1)
                self.assertEqual((out[1]['result']['isError'], out[1]['result']['content'][0]['text']), (True,
                    f"Not confirmed: the job for bolt may or may not be queued ({why}). Don't send it again: it may be there already. "
                    "Don't hand it on again: tell the board the hand-off is unconfirmed and that you'll check after the call."))

    def tool(self, hq_tools, name, arguments):
        """hq_tools' answer to one tools/call, in this process: (isError, its text)."""
        reply = hq_tools.answer({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': name, 'arguments': arguments}})
        return reply['result']['isError'], reply['result']['content'][0]['text']

    def test_a_slow_coordinator_lands_the_job_and_confirms_it(self):
        """The coordinator answers after 32 s, past every cutoff there was (hq's 20 s, hq_tools' 30 s): the job tool
        says within STILL that it's still on its way, and waiting hears it queued. One job, never two."""
        import hq_tools
        from unittest import mock
        with tempfile.TemporaryDirectory() as d:
            url = coordinator(self)
            Coordinator.slow = 32
            self.addCleanup(setattr, Coordinator, 'slow', 0)
            with mock.patch.object(hq_tools, 'HQ_ENV', self.env(d, url)), mock.patch.object(hq_tools, 'STILL', 4), \
                    mock.patch.object(hq_tools, 'PENDING', []):
                started = time.monotonic()
                first = self.tool(hq_tools, 'job', {'agent': 'bolt', 'code': 'LOGS', **ESTIMATE, 'title': 'Logs', 'brief': 'Check the logs.'})
                self.assertLess(time.monotonic() - started, 6)
                answers = [self.tool(hq_tools, 'waiting', {})]
                while 'Still waiting' in answers[-1][1]:
                    answers.append(self.tool(hq_tools, 'waiting', {}))
                last = self.tool(hq_tools, 'waiting', {})
        self.assertEqual(first, (False, hq_tools.STILL_WAITING.format('job (Logs)')))
        self.assertGreater(len(answers), 2, 'waiting keeps the call answered while the coordinator is slow')
        self.assertFalse(answers[-1][0])
        self.assertTrue(answers[-1][1].startswith('job (Logs): Queued job #1234 HQ-LOGS for bolt: Logs'), answers[-1][1])
        self.assertEqual(last, (False, 'Nothing is waiting for the coordinator: every tool of this call has its answer.'))
        self.assertEqual(len(Coordinator.seen), 1)

    def test_waiting_delivers_every_answer_once(self):
        """An answer that lands while waiting reads the others stays waiting and comes on the next waiting, once."""
        import hq_tools
        from concurrent.futures import Future
        from unittest import mock
        late, came = Future(), Future()
        came.set_result((True, 'Queued job #1 HQ-LOGS for bolt: Logs'))
        read = hq_tools.outcome
        def outcome(future):
            late.done() or late.set_result((False, 'No job was queued: refused'))
            return read(future)
        with mock.patch.object(hq_tools, 'STILL', 0.1), mock.patch.object(hq_tools, 'outcome', outcome), \
                mock.patch.object(hq_tools, 'PENDING', [('job (Late)', late), ('job (Logs)', came)]):
            answers = [self.tool(hq_tools, 'waiting', {}) for _ in range(3)]
        self.assertEqual(answers, [
            (False, 'job (Logs): Queued job #1 HQ-LOGS for bolt: Logs\n\n' + hq_tools.STILL_WAITING.format('job (Late)')),
            (True, 'job (Late): No job was queued: refused'),
            (False, 'Nothing is waiting for the coordinator: every tool of this call has its answer.')])

    def test_a_dead_coordinator_fails_clearly(self):
        """Nobody listening: the agent hears at once, for certain, that no job was queued, nothing waits on it."""
        import hq_tools
        from unittest import mock
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0))
            url = f'http://127.0.0.1:{s.getsockname()[1]}'  # (bound, never listening: refused)
            with tempfile.TemporaryDirectory() as d, mock.patch.object(hq_tools, 'HQ_ENV', self.env(d, url)), \
                    mock.patch.object(hq_tools, 'PENDING', []):
                failed = self.tool(hq_tools, 'job', {'agent': 'bolt', 'code': 'LOGS', **ESTIMATE, 'title': 'Logs', 'brief': 'Check the logs.'})
                self.assertEqual(hq_tools.PENDING, [])
        self.assertTrue(failed[0])
        self.assertTrue(failed[1].startswith('No job was queued: Failed to connect to 127.0.0.1'), failed[1])

    def test_hq_job_exit_statuses(self):
        """hq itself: 0 with the job number, 1 only when there's surely no job (refused, or the coordinator never
        reached), 3 when it may be queued. (--new: past the open-jobs check, which isn't what's tested here.)"""
        cases = [({}, 0, 'Queued job #1234 HQ-LOGS for bolt: Logs\n', ''),
                 ({'refuse': 'no'}, 1, '', 'No job was queued: no\n'),
                 (None, 1, '', 'No job was queued: Failed to connect'),  # (port 9: nobody's there, nothing was sent)
                 ({'lose': 'drop'}, 3, '', 'Not confirmed: the job for bolt may or may not be queued (Empty reply from server)'),
                 ({'lose': 502}, 3, '', 'Not confirmed: the job for bolt may or may not be queued (HTTP 502: internal)')]
        for how, rc, out, err in cases:
            with self.subTest(how=how):
                url = 'http://127.0.0.1:9' if how is None else coordinator(self, **how)
                r = subprocess.run(['bash', HQ, 'job', '--new', 'bolt', 'Logs', '-', '--size', ESTIMATE['size'], '--why', ESTIMATE['why']], input='Check the logs.', capture_output=True, text=True,
                                   env={'PATH': os.environ['PATH'], 'HQ_URL': url, 'HQ_TOKEN': 't'})
                self.assertEqual((r.returncode, r.stdout), (rc, out))
                self.assertTrue(r.stderr.startswith(err), r.stderr)

    def test_every_tool_says_it_queues_and_reaches_nobody_live(self):
        """A call's tool puts something on a list; its description says so."""
        import hq_tools
        self.assertEqual(sorted(t['name'] for t in hq_tools.TOOLS), CALL_TOOLS)
        for t in hq_tools.TOOLS[:3]:  # (search, history and call only read)
            self.assertIn("reaches nobody live" if t['name'] != 'job' else "doesn't reach them live", t['description'], t['name'])

    def test_hang_up_runs_nothing_and_says_the_line_hangs_up_after_the_goodbye(self):
        """The voice line ends the call when the agent uses it (server.py, Call.leave): the tool itself runs no hq, and its
        description says when, and its answer what happens."""
        import hq_tools
        tool = next(t for t in hq_tools.TOOLS if t['name'] == 'hang_up')
        self.assertIn('only once the board has clearly wrapped it up', tool['description'])
        self.assertIn("a short goodbye of your own that fits the call ('Thank you, talk soon.' is one example, not a set "
                      'line)', tool['description'])
        self.assertIn('no recap of what was queued or noted unless the board asks for one', tool['description'])
        self.assertNotIn('say only', tool['description'])
        self.assertIn('Never on a pause', tool['description'])
        self.assertIn('a thank-you while the business is still going', tool['description'])
        with tempfile.TemporaryDirectory() as d:
            out = self.call(('hang_up', {}), env=self.env(d, 'http://127.0.0.1:9'))
            self.assertFalse(Path(d, 'hq.log').exists())
        answer = {'content': [{'type': 'text', 'text': hq_tools.HANG_UP_ANSWER}], 'isError': False}
        self.assertEqual(out[1]['result'], answer)
        self.assertIn('hangs up once your goodbye has finished playing', hq_tools.HANG_UP_ANSWER)

    def test_a_promise_goes_on_the_calls_list_with_the_agents_own_words(self):
        what = 'Bolt checks Monday\'s phone logs for dropped calls: $(id) `id`'
        with tempfile.TemporaryDirectory() as d:
            url = coordinator(self)
            out = self.call(('promise', {'owner': 'bolt', 'what': what}), ('job', {'agent': 'bolt', 'code': 'LOGS', **ESTIMATE, 'title': 'Logs', 'brief': 'Check them.', 'item': 1234}),
                            env=self.env(d, url))
            log = Path(d, 'hq.log').read_text()
        self.assertEqual([s[1:4] for s in Coordinator.seen], [('/api/agent/item', 'Bearer call-token', {'kind': 'promise', 'owner': 'bolt', 'what': what, 'quote': what}),
                                                              ('/api/agent/job', 'Bearer call-token', {'agent': 'bolt', 'title': 'Logs', 'after': None, 'code': 'LOGS', **ESTIMATE, 'prompt': 'Check them.', 'item': 1234})])
        self.assertIn(f'ARG item\nARG add\nARG promise\nARG bolt\nARG {what}\nARG -\n', log)
        self.assertFalse(out[1]['result']['isError'])
        promise_words = '\n'.join(part['text'] for part in out[1]['result']['content'])
        self.assertIn('Noted as promise #1234 on this call, for bolt.', promise_words)
        self.assertIn("It's on the call's list, not handed to anyone yet: after the call, the follow-up hands it out.", promise_words)
        self.assertFalse(out[2]['result']['isError'])
        job_words = '\n'.join(part['text'] for part in out[2]['result']['content'])
        self.assertIn("Queued job #1234 HQ-LOGS for bolt: Logs\nIt carries item #1234: handled when #1234 ends done "
                      "(it hasn't started yet).\nNot started yet: it's on bolt's list, and nobody is on it until it runs.", job_words)

    def test_a_promise_carries_the_time_told_to_the_board(self):
        """ a promise's time (and a correction's) goes to hq as --deadline; a bad one goes nowhere."""
        with tempfile.TemporaryDirectory() as d:
            url = coordinator(self)
            out = self.call(('promise', {'owner': 'bolt', 'what': 'The share link is live', 'deadline': '3h'}),
                            ('replace', {'item': 7, 'what': 'Live by 18:00', 'deadline': '16:00'}),
                            ('promise', {'owner': 'bolt', 'what': 'x', 'deadline': 'tonight'}), env=self.env(d, url))
            log = Path(d, 'hq.log').read_text()
        self.assertEqual([s[3].get('deadline') for s in Coordinator.seen], ['3h', '16:00'])
        self.assertIn('ARG -\nARG --deadline\nARG 3h\n', log)
        self.assertTrue(out[3]['result']['isError'])
        self.assertIn('deadline must be', out[3]['result']['content'][0]['text'])

    def test_a_promise_about_work_under_way_names_its_job(self):
        """A promise's job (the work under way it's about) goes to hq as --job with its time, whose thread takes it at
        once (askwindow.ts), with --thread for one the call queued in none; without a time, or a thread without a job,
        it goes nowhere."""
        with tempfile.TemporaryDirectory() as d:
            url = coordinator(self)
            out = self.call(('promise', {'owner': 'wren', 'what': 'The fallback is live', 'deadline': '40m', 'job': 9222}),
                            ('promise', {'owner': 'wren', 'what': 'x', 'job': 9222}),
                            ('promise', {'owner': 'wren', 'what': 'Names', 'deadline': '2h', 'job': 9223, 'thread': 'shop/names'}),
                            ('promise', {'owner': 'wren', 'what': 'x', 'deadline': '2h', 'thread': 'shop/names'}), env=self.env(d, url))
            log = Path(d, 'hq.log').read_text()
        self.assertEqual([(s[3].get('deadline'), s[3].get('job'), s[3].get('thread')) for s in Coordinator.seen],
                         [('40m', 9222, None), ('2h', 9223, 'shop/names')])
        self.assertIn('ARG -\nARG --deadline\nARG 40m\nARG --job\nARG 9222\n', log)
        self.assertIn('ARG --job\nARG 9223\nARG --thread\nARG shop/names\n', log)
        self.assertTrue(out[2]['result']['isError'])
        self.assertIn('goes with deadline', out[2]['result']['content'][0]['text'])
        self.assertTrue(out[4]['result']['isError'])
        self.assertIn('thread goes with job', out[4]['result']['content'][0]['text'])

    def test_limits_are_refused_with_a_message_never_cut(self):
        with tempfile.TemporaryDirectory() as d:
            url = coordinator(self)
            out = self.call(('promise', {'owner': 'bolt', 'what': 'w' * 201}), ('promise', {'owner': 'bolt', 'what': 'Two\nlines'}),
                            ('replace', {'item': 7, 'what': 'w' * 250}), ('promise', {'owner': 'Bolt Smith', 'what': 'x'}), env=self.env(d, url))
            self.assertFalse(Path(d, 'hq.log').exists())
        self.assertEqual(Coordinator.seen, [])
        self.assertEqual([(r['result']['isError'], r['result']['content'][0]['text']) for r in out[1:]], [
            (True, 'what too long (201 > 200): make it one short line; the follow-up has the whole call'),
            (True, 'what needs one plain line: the board reads it'),
            (True, 'what too long (250 > 200): make it one short line; the follow-up has the whole call'),
            (True, 'owner must be a colleague id, like ada')])

    def test_a_lost_answer_to_a_promise_is_unconfirmed(self):
        """A retry could put it on the list twice: the agent hears it may be there, and that the follow-up catches it if not."""
        for lose, why in (('drop', 'Empty reply from server'), (500, 'HTTP 500: internal')):
            with self.subTest(lose=lose), tempfile.TemporaryDirectory() as d:
                url = coordinator(self, lose=lose)
                out = self.call(('promise', {'owner': 'bolt', 'what': 'Check the logs'}), env=self.env(d, url))
                self.assertEqual((out[1]['result']['isError'], out[1]['result']['content'][0]['text']), (True,
                    f"Not confirmed: the item may or may not be recorded ({why}). Don't record it again: it may be there already. "
                    "Don't note it again: the follow-up goes through the whole call afterwards and records it if it's missing."))

    def test_a_management_change_is_done_refused_or_not_confirmed_by_hqs_exit_code(self):
        """manage answers what hq's exit code says: done, refused (nothing changed), not confirmed (the answer was lost
        after HQ had the change: never a refusal, so a retry checks first) or HQ not reached."""
        draw = ('manage', {'command': ['cancel', '123', 'the board dropped it']})
        cases = [(dict(lose='no id'), False, 'Cancelled job #123.'), (dict(refuse="job #123 isn't yours to cancel"), True, "isn't yours"),
                 (dict(lose='drop'), True, 'Not confirmed'), (dict(lose=500), True, 'Not confirmed')]
        for given, error, said in cases:
            with self.subTest(**given), tempfile.TemporaryDirectory() as d:
                url = coordinator(self, **given)
                out = self.call(draw, env=self.env(d, url))[1]['result']
                self.assertEqual(out['isError'], error, out)
                self.assertIn(said, out['content'][0]['text'])
                self.assertEqual([s[1] for s in Coordinator.seen], ['/api/agent/cancel'])
        with tempfile.TemporaryDirectory() as d:
            out = self.call(draw, env=self.env(d, 'http://127.0.0.1:9'))[1]['result']
        self.assertTrue(out['isError'])
        self.assertIn("HQ couldn't be reached, so nothing changed", out['content'][0]['text'])

    def test_bad_arguments_never_reach_hq(self):
        with tempfile.TemporaryDirectory() as d:
            ok = {'agent': 'bolt', 'title': 'x', 'brief': 'y'}
            bad = [('job', {**ok, 'agent': '--after'}),
                   ('job', {**ok, 'title': ' '}), ('job', {**ok, 'brief': ' '}), ('job', {k: v for k, v in ok.items() if k != 'brief'}),
                   ('job', {**ok, 'agent': 'Bolt Smith'}), ('job', {**ok, 'item': '7'}), ('job', {**ok, 'item': 0}),
                   ('say', {'agent': 'bolt', 'text': 'x'}), ('status', {'agent': 'bolt', 'text': 'x'}), ('forward', {'agent': 'bolt', 'text': 'x'}),
                   ('promise', {'owner': '--call', 'what': 'x'}), ('promise', {'owner': 'bolt', 'what': ' '}), ('replace', {'item': '7', 'what': 'x'}),
                   ('replace', {'item': True, 'what': 'x'}), ('replace', {'item': 7}),
                   # (manage: only hq's management commands, one line a word)
                   ('manage', {'command': ['status', 'x']}), ('manage', {'command': ['job', 'bolt', 'x', '-']}), ('manage', {'command': ['job']}),
                   ('manage', {'command': ['followthrough', 'ok']}), ('manage', {'command': ['inbox', '--hook']}),
                   ('manage', {'command': ['meeting', 'say', 'x']}), ('manage', {'command': ['estimate', 'x']}),
                   ('manage', {'command': ['cancel', '7', 'two\nlines']}), ('manage', {'command': ['cancel', 7]}),
                   ('manage', {'command': []}), ('manage', {'command': 'cancel 7'}), ('manage', {'command': ['--as', 'bolt', 'cancel', '7']})]
            out = self.call(*bad, env={**fake_hq(d), 'HQ_URL': 'http://127.0.0.1:9'})
            self.assertFalse(Path(d, 'hq.log').exists())
        self.assertEqual(len(out), 1 + len(bad))
        self.assertTrue(all(r['result']['isError'] for r in out[1:]))


    def test_look_ups_run_hq_from_an_argument_list(self):
        with tempfile.TemporaryDirectory() as d:
            env = {**fake_hq(d), **agent_env({'PATH': fake_hq(d)['PATH']}, 'http://127.0.0.1:9', SIGN_IN_FD, 'call-token', 'juno')}
            q = "Penny's request #35; $(cat /seat/token) `id`"
            out = self.call(('search', {'query': q}), ('history', {'query': '#35'}), ('history', {}),
                            ('when', {'what': q, 'size': '1h30m', 'agent': 'bolt', 'after': 123, 'by': '2026-10-06T14:30Z'}),
                            ('intercom', {'query': q}), ('eta', {'query': q}), env=env)
            log = Path(d, 'hq.log').read_text()
        self.assertIn(f'ARG search\nARG {q}\nARG 5\n', log)  # (as typed: nothing expanded)
        self.assertIn(f'ARG when\nARG {q}\nARG --size\nARG 1h30m\nARG --agent\nARG bolt\nARG --after\nARG 123\nARG --by\nARG 2026-10-06T14:30Z\n', log)
        self.assertIn(f'ARG intercom\nARG {q}\n', log)
        self.assertIn(f'ARG projects\nARG {q}\n', log)  # (eta)
        self.assertIn('ARG history\nARG #35\n', log)
        self.assertEqual(log.count('ARG history\n'), 2)  # (and with no query, no argument after it)
        self.assertNotIn(SEAT, log)
        self.assertTrue(all(r['result']['isError'] for r in out[1:]))  # (port 9: the coordinator isn't there)

    def test_added_seat_replay_is_available_without_a_deadline_or_query(self):
        with tempfile.TemporaryDirectory() as d:
            env = {**fake_hq(d), **agent_env({'PATH': fake_hq(d)['PATH']}, 'http://127.0.0.1:9', SIGN_IN_FD, 'call-token', 'juno')}
            self.call(('eta', {'extra_seat': '5x'}), ('when', {'extra_seat': '20x'}), env=env)
            log = Path(d, 'hq.log').read_text()
        self.assertIn('ARG projects\nARG --extra-seat\nARG 5x\n', log)
        self.assertIn('ARG when\nARG --extra-seat\nARG 20x\n', log)
        with tempfile.TemporaryDirectory() as d:
            out = self.call(('eta', {'extra_seat': '$(id)'}), ('when', {'extra_seat': None}),
                            ('when', {'extra_seat': '5x', 'what': 'new work'}), env=fake_hq(d))
            self.assertFalse(Path(d, 'hq.log').exists())
        self.assertTrue(all(r['result']['isError'] for r in out[1:]))

    def test_eta_with_no_query_reads_whats_going_on_now(self):
        # (who's at work and what each open card holds up, fresh each time: hq now.)
        with tempfile.TemporaryDirectory() as d:
            env = {**fake_hq(d), **agent_env({'PATH': fake_hq(d)['PATH']}, 'http://127.0.0.1:9', SIGN_IN_FD, 'call-token', 'juno')}
            self.call(('eta', {}), ('eta', {'query': ' '}), env=env)
            log = Path(d, 'hq.log').read_text()
        self.assertEqual(log.count('ARG now\n'), 2)
        self.assertNotIn('ARG projects', log)

    def test_a_call_is_read_in_full_by_its_number(self):
        with tempfile.TemporaryDirectory() as d:
            url = coordinator(self)
            out = self.call(('call', {'id': 12}), ('call', {'id': 13}), ('call', {'id': 14}), env=self.env(d, url))
            log = Path(d, 'hq.log').read_text()
        self.assertIn('ARG call\nARG 12\n', log)
        self.assertNotIn(SEAT, log)
        self.assertEqual([s[1:3] for s in Coordinator.seen], [(f'/api/agent/call?id={n}', 'Bearer call-token') for n in (12, 13, 14)])
        self.assertEqual((out[1]['result']['isError'], out[1]['result']['content'][0]['text']), (False,
            'Call 12, kit with the board, 2026-09-27T10:00, heard by job #700\n\n'
            'board: What is our mission?\nkit: A slightly warmer, more whimsical digital world.\n\n'
            "Summary (job #700's report):\nThe board asked for the mission; Kit read it out from the charter."))
        # (a call the coordinator won't show: hq's refusal, as it words it)
        self.assertEqual((out[2]['result']['isError'], out[2]['result']['content'][0]['text']), (True, "hq call failed: No call #13 you can read (it doesn't exist, or it's still going on)."))
        long = out[3]['result']['content'][0]['text']
        self.assertFalse(out[3]['result']['isError'])
        self.assertEqual(long.count('board: What is our mission?'), 300, 'whole, to its last line')

    def test_bad_look_ups_never_reach_hq(self):
        with tempfile.TemporaryDirectory() as d:
            bad = [('search', {'query': ' '}), ('search', {}), ('when', {'what': ' '}), ('when', {}), ('when', {'what': '--by'}),
                   ('when', {'what': 'x', 'agent': '--after'}), ('when', {'what': 'x', 'size': 'soon'}), ('when', {'what': 'x', 'by': '$(id)'}),
                   *[('when', {'what': 'x', 'after': after}) for after in (0, -1, True, '123', None)], ('search', {'query': ['x']}), ('history', {'query': 35}),
                   ('intercom', {'query': ' '}), ('intercom', {}), ('eta', {'query': ['x']}),
                   ('call', {}), ('call', {'id': '12; id'}), ('call', {'id': '12'}), ('call', {'id': 0}), ('call', {'id': -3}),
                   ('call', {'id': True}), ('call', {'id': 12.5})]
            out = self.call(*bad, env={**fake_hq(d), 'HQ_URL': 'http://127.0.0.1:9'})
            self.assertFalse(Path(d, 'hq.log').exists())
        self.assertTrue(all(r['result']['isError'] for r in out[1:]))


COORDINATOR = Path(HERE).parent / 'coordinator'


@unittest.skipUnless((COORDINATOR / 'node_modules').is_dir(), 'needs the coordinator (npm ci in platform/coordinator)')
class CallsList(unittest.TestCase):
    """promise and replace through the real hq and the real coordinator (its app, with a throwaway database), under the
    call token the coordinator gave the call, as the voice line has it."""

    @classmethod
    def setUpClass(cls):
        cls.data = tempfile.mkdtemp()
        # The test company (platform/coordinator/fixture) as REPO_DIR, as the
        # coordinator's own tests have it (fixture.ts fixtureRepo), never the company's files: it passes in the foundation.
        cls.repo = Path(cls.data, 'repo')
        shutil.copytree(COORDINATOR / 'fixture', cls.repo)
        for d in ('platform', 'shared'):
            (cls.repo / d).symlink_to(COORDINATOR.parent.parent / d)
        code = ("import { createServer } from 'node:http'; const { app } = await import('file://' + process.argv[1]);"
                "const s = createServer(app).listen(0, '127.0.0.1', () => console.log('port', s.address().port));")
        cls.proc = subprocess.Popen(['node', '--input-type=module', '-e', code, str(COORDINATOR / 'src' / 'server.ts')], stdout=subprocess.PIPE, text=True,
                                    env={'PATH': os.environ['PATH'], 'DATA_DIR': cls.data, 'VOICE_TOKEN': 'voice-test', 'WORKER_TOKEN': 'worker-test',
                                         'GITHUB_TOKEN': 'test', 'REPO': 'company/test', 'REPO_DIR': str(cls.repo)})
        while not (line := cls.proc.stdout.readline()).startswith('port '):
            assert line, 'the coordinator did not start'
        cls.url = f'http://127.0.0.1:{line.split()[1]}'

    @classmethod
    def tearDownClass(cls):
        cls.proc.kill(); cls.proc.wait()
        shutil.rmtree(cls.data, True)

    def voice(self, route, body):
        from urllib.request import Request, urlopen
        req = Request(f'{self.url}/api/voice/{route}', data=json.dumps(body).encode(), headers={'authorization': 'Bearer voice-test', 'content-type': 'application/json'})
        with urlopen(req, timeout=15) as r:
            return json.loads(r.read())

    def db(self, sql, *args):
        with sqlite3.connect(f'{self.data}/hq.db') as c:
            return c.execute(sql, args).fetchall()

    def start(self, agent):
        """A call starting: its token, and its row's id."""
        token = self.voice('call-context', {'agent': agent})['token']
        return token, self.db('select max(id) from calls')[0][0]

    def tools(self, token, agent, *calls):
        with tempfile.TemporaryDirectory() as d:
            out = HqTools.call(self, *calls, env=agent_env({'PATH': fake_hq(d)['PATH']}, self.url, SIGN_IN_FD, token, agent))
        return [(r['result']['isError'], r['result']['content'][0]['text']) for r in out[1:]]

    def hq(self, token, agent, *args, words=''):
        """hq itself, in the call agent's environment (what a tool could run)."""
        return subprocess.run(['bash', HQ, *args], input=words, capture_output=True, text=True,
                              env=agent_env({'PATH': os.environ['PATH']}, self.url, SIGN_IN_FD, token, agent))

    def test_a_promise_is_on_the_calls_list_at_once_and_stays_after_hang_up(self):
        for lines in ([], ['Board: Kit, the coming-soon page.', 'Kit: I will send Juno the mission note.']):
            with self.subTest(lines=len(lines)):
                token, call = self.start('kit')
                out = self.tools(token, 'kit', ('promise', {'owner': 'kit', 'what': 'Kit sends Juno the mission note'}))
                item = self.db('select id, call, kind, owner, what, quote, by, status from call_items order by id desc limit 1')[0]
                self.assertEqual(item[1:], (call, 'promise', 'kit', 'Kit sends Juno the mission note', 'Kit sends Juno the mission note', None, 'open'))
                self.assertEqual(out, [(False, f"Noted as promise #{item[0]} on this call, for kit.\n"
                                        "It's on the call's list, not handed to anyone yet: after the call, the follow-up hands it out.")])
                self.voice('call-end', {'agent': 'kit', 'lines': lines, 'token': token})  # (the line drops, or the call ends)
                self.assertEqual(self.db('select call, status from call_items where id = ?', item[0]), [(call, 'open')])
                status, job = self.db('select status, job from calls where id = ?', call)[0]
                self.assertEqual((status, bool(job)), ('ended', True), 'its follow-up hands it out')
                again = self.tools(token, 'kit', ('promise', {'owner': 'kit', 'what': 'After the call'}))
                self.assertTrue(again[0][0] and again[0][1].startswith('Nothing recorded'), again)  # (the token ended with the call)

    def test_on_a_call_about_pins_the_agent_rewords_and_marks_them_sent_and_is_told_to_say_which(self):
        add = lambda words: self.db("insert into review_notes (created, slug, about, page, element, note, viewport) values "
                                    "('2026-10-06', 'hello', 'hello', '/shop', '{\"tag\":\"button\"}', ?, '{}') returning id", words)[0][0]
        pale, price, faq, other = add('The button is too pale'), add('Is this the final price?'), add('Add a FAQ'), add('Not on the call')
        ctx = self.voice('call-context', {'agent': 'bolt', 'pins': [pale, price, faq]})
        token = ctx['token']
        self.assertIn(f'### Pin #{pale} on https://hello.preview.', ctx['prompt'])
        queued = self.tools(token, 'bolt', ('job', {'agent': 'moss', 'code': 'FAQ', **ESTIMATE, 'title': 'A FAQ', 'brief': 'Add a FAQ to hello.'}))[0][1]
        job = int(re.search(r'Queued job #(\d+)', queued)[1])
        out = self.tools(token, 'bolt', ('pin_words', {'pin': pale, 'words': 'Make the button the brand green'}),
                         ('pin_sent', {'pin': faq, 'job': job}), ('pin_sent', {'pin': price, 'answered': True}),
                         ('pin_sent', {'pin': other, 'answered': True}), ('pin_sent', {'pin': pale}),
                         ('pin_sent', {'pin': pale, 'job': job, 'answered': True}), ('pin_words', {'pin': pale, 'words': ' '}))
        self.assertEqual(out[0], (False, f'Pin #{pale} has its new words in HQ. It still waits there: not sent.'))
        self.assertEqual(out[1], (False, f"Pin #{faq} is marked sent with job #{job} (moss's). It's no longer waiting in HQ.\n"
                                  'Tell the board plainly which of its notes went to which work, and whether that work is queued or already under way.'))
        self.assertEqual(out[2], (False, f"Pin #{price} is marked sent as answered on this call, with no job queued for it. It's no longer "
                                  'waiting in HQ.\nTell the board plainly which of its notes you answered here, with no work queued for it.'))
        self.assertEqual(out[3], (True, f"Nothing changed: pin #{other} isn't one this call is about"))
        for refused in out[4:]:
            self.assertTrue(refused[0], refused)
        self.assertEqual(self.db('select id, status, job, note from review_notes where id in (?, ?, ?, ?) order by id', pale, price, faq, other),
                         [(pale, 'pending', None, 'Make the button the brand green'), (price, 'sent', None, 'Is this the final price?'),
                          (faq, 'sent', job, 'Add a FAQ'), (other, 'pending', None, 'Not on the call')])
        self.voice('call-end', {'agent': 'bolt', 'lines': ['Board: the pale button, let me think.'], 'token': token})
        self.assertEqual(self.db('select status from review_notes where id = ?', pale), [('pending',)])  # (it waits for Send or another call)

    def test_the_ceos_call_expedites_and_a_refusal_says_why(self):
        token, _ = self.start('juno')
        queued = self.tools(token, 'juno', ('job', {'agent': 'kit', 'code': 'CLAIM', **ESTIMATE, 'title': 'Fix the claim', 'brief': 'The claim stalls.'}))[0][1]
        job = int(re.search(r'Queued job #(\d+)', queued)[1])
        out = self.tools(token, 'juno', ('expedite', {'job': job}), ('expedite', {'job': 999999}))
        self.assertEqual(out[0], (False, f'#{job} is expedited: it starts next, and merges once a push passes its gates and tests.'))
        self.assertEqual(out[1], (True, "Nothing expedited: there's no job #999999: check the number"))
        self.assertEqual(self.db('select expedite from jobs where id = ?', job), [(1,)])
        self.voice('call-end', {'agent': 'juno', 'lines': [], 'token': token})
        token, _ = self.start('kit')
        self.assertEqual(self.tools(token, 'kit', ('expedite', {'job': job})), [(True, 'Nothing expedited: only the CEO expedites a job: ask juno')])
        self.voice('call-end', {'agent': 'kit', 'lines': [], 'token': token})

    def test_a_call_token_adds_to_no_other_call_and_reads_no_items_nor_its_own_transcript(self):
        said = 'Board: the secret plan for the brand film.'
        other, theirs = self.start('moss')
        self.voice('call-end', {'agent': 'moss', 'lines': [said], 'token': other})
        token, mine = self.start('kit')
        r = self.hq(token, 'kit', 'item', 'add', 'promise', 'kit', 'Onto the other call?', '-', '--call', str(theirs), words='x')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.db('select call from call_items order by id desc limit 1'), [(mine,)], 'on its own call, whatever it asks')
        for args in (['call', str(mine)], ['items', str(theirs)], ['items', str(mine)], ['items']):
            r = self.hq(token, 'kit', *args)
            self.assertNotEqual(r.returncode, 0, args)
            self.assertNotIn('secret plan', r.stdout + r.stderr)
        # An ended call is every agent's to read, unnumbered, as its agent reads it
        r = self.hq(token, 'kit', 'call', str(theirs))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn(said, r.stdout)
        self.assertNotIn('[1]', r.stdout, 'never the numbered transcript a follow-up works from')
        out = self.tools(token, 'kit', ('call', {'id': theirs}), ('items', {'call': theirs}))
        self.assertEqual([e for e, _ in out], [False, True])
        self.assertEqual(out[1][1], 'no tool items: hand work on with job, note a promise with promise')
        self.voice('call-end', {'agent': 'kit', 'lines': [], 'token': token})

    def test_the_call_manages_the_companys_work_as_off_the_call(self):
        """manage runs hq's management commands under the call token, with HQ's own rules on who may."""
        other, _ = self.start('kit')
        queued = lambda token, agent, code: int(re.search(r'Queued job #(\d+)', self.tools(token, agent, ('job', {
            'agent': 'moss', 'code': code, **ESTIMATE, 'title': code.title(), 'brief': 'x'}))[0][1])[1])
        kits = queued(other, 'kit', 'KITS')
        token, _ = self.start('juno')  # (the fixture's CEO)
        drop, keep = queued(token, 'juno', 'DROP'), queued(token, 'juno', 'KEEP')
        out = self.tools(other, 'kit', ('manage', {'command': ['cancel', str(keep), 'not mine to cancel']}))
        self.assertTrue(out[0][0], out)
        out = self.tools(token, 'juno', ('manage', {'command': ['cancel', str(drop), 'the board dropped it']}),
                         ('manage', {'command': ['cancel', str(kits), 'the board dropped this one too']}),
                         ('manage', {'command': ['plan', 'thread', 'office', 'Launch', 'The launch is out', '--slug', 'launch']}),
                         ('manage', {'command': ['job', 'move', str(keep), 'office/launch']}),
                         ('manage', {'command': ['window', 'office/launch', '18:00']}),
                         ('manage', {'command': ['thread', 'pause', 'office/launch', 'waits for the board', '--by-hand']}),
                         ('manage', {'command': ['thread', 'resume', 'office/launch']}),
                         ('manage', {'command': ['jobs', 'moss']}), ('manage', {'command': ['summary']}))
        self.assertEqual([e for e, _ in out], [False] * 9, out)
        self.assertEqual(out[0][1].splitlines()[0], f'Cancelled job #{drop}.')
        self.assertEqual(self.db('select id, status from jobs where id in (?, ?, ?) order by id', kits, drop, keep),
                         [(kits, 'cancelled'), (drop, 'cancelled'), (keep, 'queued')])
        self.assertEqual(self.db('select thread from jobs where id = ?', keep), [('office/launch',)])
        self.assertIn(f'#{keep}', out[7][1])
        # (what speaks as a job a call doesn't have stays closed at the coordinator, whatever runs hq)
        for args in (['status', 'x'], ['followthrough', 'ok'], ['reply', 'x']):
            self.assertNotEqual(self.hq(token, 'juno', *args).returncode, 0, args)
        for t in (other, token):
            self.voice('call-end', {'agent': 'juno' if t == token else 'kit', 'lines': [], 'token': t})

    def test_the_boards_correction_replaces_an_open_item_on_the_line(self):
        first, call1 = self.start('moss')
        self.tools(first, 'moss', ('promise', {'owner': 'moss', 'what': 'Brand films A2 and D'}))
        old = self.db('select max(id) from call_items')[0][0]
        self.voice('call-end', {'agent': 'moss', 'lines': ['Moss: I will make A2 and D.'], 'token': first})
        token, call2 = self.start('moss')
        prompt = self.voice('call-context', {'agent': 'wren'})['prompt']
        self.assertIn(f'- #{old}: Brand films A2 and D (moss)', prompt)  # (what replace takes)
        out = self.tools(token, 'moss', ('replace', {'item': old, 'what': 'Only film D, no A2'}), ('replace', {'item': old, 'what': 'Again'}))
        new = self.db('select max(id) from call_items')[0][0]
        self.assertEqual(out, [(False, f"Noted as promise #{new} on this call, for moss: it replaces #{old} (Brand films A2 and D), which the board changed.\n"
                                "It's on the call's list, not handed to anyone yet: after the call, the follow-up hands it out."),
                               (True, f"Nothing recorded: item #{old} isn't open: on a call, only an open item is replaced (the call's follow-up can replace a handled one)")])
        self.assertEqual(self.db('select id, call, status from call_items where id in (?, ?) order by id', old, new), [(old, call1, 'replaced'), (new, call2, 'open')])
        self.voice('call-end', {'agent': 'moss', 'lines': [], 'token': token})

    def test_what_the_board_adds_reaches_the_job_queued_on_the_call(self):
        """add puts what the board adds in the brief while the job waits, else in its running session; only the call's own jobs."""
        other, _ = self.start('kit')
        theirs = int(re.search(r'#(\d+)', self.tools(other, 'kit', ('job', {'agent': 'moss', 'code': 'THEIRS', **ESTIMATE, 'title': 'Theirs', 'brief': 'x'}))[0][1])[1])
        token, call = self.start('vera')
        queued = lambda title: int(re.search(r'Queued job #(\d+)', self.tools(token, 'vera', ('job', {
            'agent': 'moss', 'code': title.upper(), **ESTIMATE, 'title': title, 'brief': 'Lower the Codex load.'}))[0][1])[1])
        waits, runs, ended = queued('Waits'), queued('Runs'), queued('Ended')
        self.db("update jobs set status = 'running', session = 's' where id = ?", runs)
        self.db("update jobs set status = 'done' where id = ?", ended)
        out = self.tools(token, 'vera', ('add', {'job': waits, 'words': "Don't move the work over to Anthropic."}),
                         ('add', {'job': runs, 'words': 'Keep the high-risk reviews on Codex.'}),
                         ('add', {'job': ended, 'words': 'Too late.'}), ('add', {'job': theirs, 'words': 'Not mine.'}))
        self.assertEqual(out[0], (False, f"Added to job #{waits}'s brief: it hasn't started yet, so moss gets it with the rest."))
        message = self.db('select id, job, text from messages order by id desc limit 1')[0]
        self.assertEqual(out[1], (False, f"Job #{runs} has started: moss's session reads the addition at its next step (message #{message[0]}). "
                                  'If the job ends first, it becomes a job of its own for moss.'))
        self.assertEqual(message[1], runs)
        self.assertIn(f'An addition to your job #{runs} (Runs), from vera\'s call with the board (call #{call})', message[2])
        self.assertTrue(message[2].endswith('Keep the high-risk reviews on Codex.'))
        self.assertEqual(out[2], (True, f'Nothing was added: job #{ended} has finished. If the board still wants it, '
                                  'queue it as a new job with the whole brief.'))
        self.assertEqual(out[3], (True, f"Nothing was added: job #{theirs} wasn't queued on this call: only a job you queued on it takes an "
                                  "addition now. The call's follow-up adds to any other from the transcript."))
        self.assertEqual(self.db('select prompt from jobs where id = ?', waits)[0][0], 'Lower the Codex load.\n\n(Assigned by vera, on a call with the '
                         "board.)\n\nDon't move the work over to Anthropic.\n(Added by vera, on a call with the board.)")
        self.assertEqual(self.db('select prompt from jobs where id = ?', theirs)[0][0], 'x\n\n(Assigned by kit, on a call with the board.)')
        r = self.hq(token, 'vera', 'extend', str(waits), '/etc/hostname')
        self.assertIn('takes no file', r.stderr)
        self.voice('call-end', {'agent': 'vera', 'lines': ['Board: lower the Codex load.'], 'token': token})
        self.voice('call-end', {'agent': 'kit', 'lines': [], 'token': other})
        after = self.tools(token, 'vera', ('add', {'job': waits, 'words': 'After the call.'}))
        self.assertTrue(after[0][0], after)  # (the token ended with the call)
        self.assertNotIn('After the call', self.db('select prompt from jobs where id = ?', waits)[0][0])

    def test_the_board_s_word_reaches_a_running_job_as_often_as_it_needs_and_goes_on_the_calls_list(self):
        """reach: a running Claude job's session gets it at its next step, by its number
        and its agent; it's on the call's list, handled, and a second on the same call goes too."""
        token, call = self.start('vera')
        job = self.db("insert into jobs (agent, title, prompt, status, engine, kind, session, created) values "
                      "('moss', 'The site', 'x', 'running', 'claude', 'work', 's', '2026-10-15') returning id")[0][0]
        words = 'Only something insecure blocks the site now; fix the rest once it is up.'
        reach = lambda agent, what='Only an insecure change blocks the site': ('reach', {'agent': agent, 'job': job, 'words': words, 'what': what})
        out = self.tools(token, 'vera', reach('kit'), reach('moss', 'two\nlines'), reach('moss'), reach('moss'))
        self.assertEqual(out[0], (True, f"Nothing was sent: job #{job} is moss's (The site), not kit's: check the number."))
        self.assertEqual(out[1], (True, "what needs one plain line: the board reads it"))
        (message, item), (again, item_again) = self.db('select m.id, i.id from messages m join call_items i on i.ref like '
                                                       "'%message #' || m.id where m.call = ? order by m.id", call)
        self.assertEqual(out[2], (False, f"Sent to moss's job #{job}: its session reads it at its next step (message #{message}). "
                                  f"It's on this call's list as item #{item}, so the follow-up won't send it again."))
        self.assertEqual(out[3], (False, f"Sent to moss's job #{job}: its session reads it at its next step (message #{again}). "
                                  f"It's on this call's list as item #{item_again}, so the follow-up won't send it again."))
        self.assertEqual(self.db('select job, call from messages where id = ?', message), [(job, call)])
        self.assertTrue(self.db('select text from messages where id = ?', message)[0][0].endswith(words))
        self.assertEqual(self.db('select call, kind, owner, status, job, quote from call_items where id = ?', item),
                         [(call, 'message', 'moss', 'handled', job, words)])
        self.voice('call-end', {'agent': 'vera', 'lines': ['Board: only block on something insecure.'], 'token': token})
        after = self.tools(token, 'vera', reach('moss'))
        self.assertTrue(after[0][0], after)  # (the token ended with the call)

    def test_the_coordinators_limits_reach_the_agent(self):
        token, call = self.start('kit')
        out = self.tools(token, 'kit', ('promise', {'owner': 'nobody-here', 'what': 'x'}), ('replace', {'item': 999999, 'what': 'x'}))
        self.assertEqual(out, [(True, "Nothing recorded: nobody-here isn't a colleague who takes work"),
                               (True, "Nothing recorded: item #999999 isn't there to replace")])
        self.assertEqual(self.db('select count(*) from call_items where call = ?', call), [(0,)])
        self.voice('call-end', {'agent': 'kit', 'lines': [], 'token': token})


@unittest.skipUnless(shutil.which('claude'), 'needs the Claude CLI (the worker has it)')
class CallAgent(unittest.TestCase):
    """The real CLI with guard.TOOLS and agent_env, as server.py starts it: one turn of a call."""

    def turn(self, name, args, tools=TOOLS, partial=(), checkout=None):
        Coordinator.script = (name, args)
        url = coordinator(self)
        with tempfile.TemporaryDirectory() as d:
            for f, text in (checkout or {}).items():  # (the call agent's working directory is the company's checkout)
                Path(d, f).parent.mkdir(parents=True, exist_ok=True)
                Path(d, f).write_text(text)
            signs = sign_in_pipe(SEAT)  # (as server.py hands it over)
            env = agent_env({**fake_hq(d), 'HOME': d}, url, signs, 'call-token', 'juno')
            env.update(CLAUDE_CONFIG_DIR=d, ANTHROPIC_BASE_URL=url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1')
            msg = {'type': 'user', 'message': {'role': 'user', 'content': [{'type': 'text', 'text': 'Give Bolt the phone logs.'}]}}
            try:
                r = subprocess.run(['claude', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
                                    *partial, '--model', 'sonnet', *tools, '--system-prompt', 'You are Juno.'], input=json.dumps(msg) + '\n',
                                   env=env, cwd=d, capture_output=True, text=True, timeout=120, pass_fds=(signs,))
            finally:
                os.close(signs)
            log = Path(d, 'hq.log').read_text() if Path(d, 'hq.log').exists() else ''
        events = [json.loads(line) for line in r.stdout.splitlines()]
        self.assertEqual(r.returncode, 0, r.stderr[-500:])
        self.assertEqual(events[-1]['result'], 'Done, Bolt has it.')  # (it started and answered)
        self.events = events
        return next(e for e in events if e.get('subtype') == 'init'), Coordinator.seen, log

    def test_it_starts_answers_and_hands_on_the_whole_brief(self):
        brief = ('The board wants the phone logs from Monday checked for dropped calls, and a note on why. ' * 10)[:600]
        init, seen, log = self.turn('mcp__hq__job', {'agent': 'bolt', 'code': 'LOGS', **ESTIMATE, 'title': 'Check the phone logs', 'brief': brief})
        self.assertEqual(init['mcp_servers'], [{'name': 'hq', 'status': 'connected', 'source': 'dynamic'}])
        self.assertEqual(sorted(init['tools']), ['Glob', 'Grep', 'Read', 'WebSearch', *MCP])
        self.assertEqual(sorted(seen[0][1]), ['Glob', 'Grep', 'Read', 'WebSearch', *MCP])  # (what the model is offered: the call's tools, no say, no forward, no shell)
        self.assertIn(('hq', '/api/agent/job', 'Bearer call-token', {'agent': 'bolt', 'title': 'Check the phone logs',
                                                                    'after': None, 'code': 'LOGS', **ESTIMATE, 'prompt': brief}), seen)
        self.assertIn("Queued job #1234 HQ-LOGS for bolt: Check the phone logs\\nNot started yet: it's on bolt's list", seen[-1][2])  # (a number, and that it's queued)
        self.assertIn('HQ_CALL=1', log)
        self.assertNotIn(SEAT, log)
        self.assertEqual(Coordinator.signed_in, {f'Bearer {SEAT}'})  # (the sign-in reached the CLI on its pipe)

    def test_the_checkouts_claude_md_is_not_sent_again(self):
        """The briefing carries AGENTS.md: the CLI's own copy from the checkout's CLAUDE.md was 5 KB more in every call's
        first request, to write to the cache before the first words."""
        _, seen, _ = self.turn('mcp__hq__search', {'query': 'x'}, checkout={'CLAUDE.md': '@AGENTS.md', 'AGENTS.md': 'Every agent here knows QX7.'})
        self.assertNotIn('QX7', seen[0][2])

    def test_the_checkouts_settings_run_nothing(self):
        """A .claude/settings.json on main runs nothing on a call: its hooks would be commands in the call agent's
        environment (the seat's sign-in in it, /seat readable), past the Read fence and with no shell needed."""
        with tempfile.TemporaryDirectory() as out:
            hooks = {e: [{'hooks': [{'type': 'command', 'command': f'env >> {out}/ran'}]}] for e in ('SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop')}
            settings = json.dumps({'hooks': hooks})
            self.turn('mcp__hq__search', {'query': 'x'}, checkout={'.claude/settings.json': settings, '.claude/settings.local.json': settings})
            self.assertFalse(Path(out, 'ran').exists())

    def test_a_promise_goes_on_the_list(self):
        init, seen, log = self.turn('mcp__hq__promise', {'owner': 'bolt', 'what': 'Bolt checks the phone logs'})
        self.assertIn(('hq', '/api/agent/item', 'Bearer call-token', {'kind': 'promise', 'owner': 'bolt', 'what': 'Bolt checks the phone logs',
                                                                     'quote': 'Bolt checks the phone logs'}), seen)
        self.assertIn("Noted as promise #1234 on this call, for bolt.\\nIt's on the call's list, not handed to anyone yet", seen[-1][2])

    def test_a_tool_step_before_any_words_shows_in_the_stream(self):
        """What server.py's Agent.ask goes by, from the CLI as the line runs it (partial messages on): a tool step's start
        is a stream_event content_block_start of type tool_use, before the tool runs and before any words."""
        Coordinator.tool_first = True
        self.addCleanup(setattr, Coordinator, 'tool_first', False)
        _, seen, _ = self.turn('mcp__hq__job', {'agent': 'bolt', 'code': 'LOGS', **ESTIMATE, 'title': 'Check the phone logs', 'brief': 'The logs.'},
                               partial=('--include-partial-messages',))
        stream = [e['event'] for e in self.events if e.get('type') == 'stream_event']
        start = next(i for i, e in enumerate(stream) if e.get('type') == 'content_block_start'
                     and e['content_block'].get('type') == 'tool_use')
        self.assertEqual(stream[start]['content_block']['name'], 'mcp__hq__job')
        words = [i for i, e in enumerate(stream) if e.get('delta', {}).get('type') == 'text_delta']
        self.assertTrue(words and start < words[0], 'the step starts before the first words')
        ran = next(i for i, e in enumerate(self.events) if e.get('type') == 'user')  # (the tool's result)
        self.assertLess(self.events.index(next(e for e in self.events if e.get('event') is stream[start])), ran)
        self.assertIn('/api/agent/job', [s[1] for s in seen if s[0] == 'hq'])

    def test_hang_up_shows_in_the_stream_by_its_name_and_runs_no_hq(self):
        """What server.py goes by to end the call (HANG_UP_TOOL, 'mcp__hq__hang_up'), from the CLI as the line runs it:
        the tool step's name in the stream; the model hears the line hangs up after its goodbye."""
        _, seen, log = self.turn('mcp__hq__hang_up', {}, partial=('--include-partial-messages',))
        steps = [e['event']['content_block']['name'] for e in self.events if e.get('type') == 'stream_event'
                 and e['event'].get('type') == 'content_block_start' and e['event']['content_block'].get('type') == 'tool_use']
        self.assertEqual(steps, ['mcp__hq__hang_up'])
        self.assertIn('The line hangs up once your goodbye has finished playing', seen[-1][2])
        self.assertEqual(log, '')
        self.assertFalse([s for s in seen if s[0] == 'hq'])

    def test_it_looks_things_up(self):
        _, seen, log = self.turn('mcp__hq__search', {'query': 'the company mission'})
        self.assertIn(('hq', '/api/agent/search?q=the%20company%20mission&limit=5', 'Bearer call-token', None), seen)
        self.assertIn('company/CHARTER.md:5', seen[-1][2])  # (the hit reached the model)
        self.assertNotIn(SEAT, log)

    def test_it_reads_a_call(self):
        _, seen, log = self.turn('mcp__hq__call', {'id': 12})
        self.assertIn(('hq', '/api/agent/call?id=12', 'Bearer call-token', None), seen)
        self.assertIn('What is our mission?', seen[-1][2])  # (the call reached the model)
        self.assertNotIn(SEAT, log)

    def test_no_say(self):
        _, seen, log = self.turn('mcp__hq__say', {'agent': 'bolt', 'text': 'the logs, please'})
        self.assertIn('No such tool available: mcp__hq__say', seen[-1][2])
        self.assertEqual(log, '')
        self.assertFalse([s for s in seen if s[0] == 'hq'])

    def test_no_shell(self):
        _, seen, log = self.turn('Bash', {'command': 'hq say juno hi', 'description': 'x'})
        self.assertIn('No such tool available: Bash', seen[-1][2])
        self.assertEqual(log, '')

    def test_a_call_out_offers_the_model_only_the_partner_tools(self):
        init, seen, log = self.turn('mcp__hq__note', {'what': 'Reprint ships Tuesday'}, tools=PARTNER)
        self.assertEqual(sorted(init['tools']), [f'mcp__hq__{t}' for t in PARTNER_TOOLS])
        self.assertEqual(sorted(seen[0][1]), [f'mcp__hq__{t}' for t in PARTNER_TOOLS])
        self.assertIn('Noted.', seen[-1][2])
        self.assertEqual(log, '')

    def test_calls_work_when_the_tools_do_not_start(self):
        broken = [a.replace('hq_tools.py', 'missing_hq_tools.py') for a in TOOLS]
        init, seen, log = self.turn('mcp__hq__job', {'agent': 'bolt', 'code': 'LOGS', **ESTIMATE, 'title': 'x', 'brief': 'y'}, tools=broken)
        self.assertEqual(init['mcp_servers'][0]['status'], 'failed')
        self.assertEqual(sorted(init['tools']), ['Glob', 'Grep', 'Read', 'WebSearch'])
        self.assertEqual(log, '')


if __name__ == '__main__':
    unittest.main()
