"""What keeps the voice line's token and the seat's sign-in from the call agent (the README's "Trust")."""
import ctypes, json, os, subprocess, sys
from pathlib import Path

HQ_TOOLS = [sys.executable, str(Path(__file__).with_name('hq_tools.py'))]
# (when: eta)
CALL_TOOLS = ['add', 'call', 'estimate', 'eta', 'expedite', 'hang_up', 'history', 'intercom', 'job', 'pin_sent', 'pin_words', 'promise',
              'reach', 'replace', 'search', 'waiting', 'when']
PARTNER_TOOLS = ['hang_up', 'no_transcript', 'note']
# Off limits to Read, Grep and Glob, where a set has them
FENCED = ('/proc', '/seat', '/data', '/dev', '/sys', '/etc', '/models', '/tmp')


def cli_tools(names, builtin, tool_set=None):
    """The CLI's arguments for a call's tools: hq_tools.py's set (tool_set: its argument, none for the board's) and the
    built-in tools named (a comma-separated list, '' for none)."""
    server = {'command': HQ_TOOLS[0], 'args': [*HQ_TOOLS[1:], *([tool_set] if tool_set else [])]}
    allowed = [*filter(None, builtin.split(',')), *(f'mcp__hq__{t}' for t in names)]
    return ['--strict-mcp-config', '--mcp-config', json.dumps({'mcpServers': {'hq': server}}),
            '--tools', builtin, '--allowedTools', ' '.join(allowed),
            '--disallowedTools', ' '.join(f'Read(/{p}/**)' for p in FENCED),
            '--permission-mode', 'dontAsk',
            # Settings from the user's folder only (/data/claude, the line's own): the checkout's
            # .claude/settings*.json would run its hooks (or an apiKeyHelper) as commands with the seat's sign-in in
            # their environment and /seat readable, past every fence above.
            '--setting-sources', 'user']


# The call agent reads the company's files (main, read only), hands work on with hq job (and adds to it), puts promises
# and corrections on the call's list, looks things up with hq search, history, call, intercom and projects (eta) and
# searches the web (WebSearch runs at Anthropic: the line opens no connection for it); nothing else. The line's own
# folders and /proc are off limits to its Read, Grep and Glob: the OS keeps the server's token from it, this is a second
# fence. If hq_tools.py won't start, the CLI still does (MCP servers are optional): calls work, without its tools.
TOOLS = cli_tools(CALL_TOOLS, 'Read,Grep,Glob,WebSearch')  # (WebSearch)
# A call out to a partner: no built-in tool and nothing of the company's looked up, so an outsider's words can't steer
# a look-up (house rule 9)
PARTNER = cli_tools(PARTNER_TOOLS, '', 'partner')


def take_token(environ):
    """The server's token, out of the environment children inherit, with this process made non-dumpable."""
    token = environ.pop('VOICE_TOKEN', '')
    if not token:
        raise SystemExit('VOICE_TOKEN is not set: the voice line takes no calls without it')
    if ctypes.CDLL(None, use_errno=True).prctl(4, 0, 0, 0, 0) != 0:  # PR_SET_DUMPABLE, 0
        raise SystemExit('Could not make the voice line non-dumpable: the call agent could read its token')
    return token


def hq_tools_work():
    """Whether hq_tools.py starts here and offers the call's tools (the voice line's start-up check: the log says if
    not)."""
    try:
        return listed() == CALL_TOOLS and listed('partner') == PARTNER_TOOLS
    except Exception:
        return False


def listed(*tool_set):
    """The tools hq_tools.py lists, sorted by name (tool_set: its argument)."""
    msgs = [{'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18'}},
            {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'}]
    r = subprocess.run([*HQ_TOOLS, *tool_set], input=''.join(json.dumps(m) + '\n' for m in msgs), capture_output=True,
                       text=True, timeout=10)
    return sorted(t['name'] for t in json.loads(r.stdout.splitlines()[-1])['result']['tools'])


def sign_in_pipe(seat_token):
    """The seat's sign-in on a pipe, which the call agent's CLI reads to its end as it starts: never in its environment,
    which the CLI's own process could read back (/proc/self/environ). Returns the read end, for agent_env and pass_fds;
    the caller closes it once the CLI has started."""
    r, w = os.pipe()
    try:
        os.write(w, seat_token.encode())  # (a sign-in is about 100 bytes: the pipe holds it, nothing waits)
    finally:
        os.close(w)
    return r


def agent_env(environ, hq_url, sign_in_fd, call_token, agent):
    """The call agent's whole environment: nothing of the server's passes but PATH and HOME (sign_in_fd:
    sign_in_pipe)."""
    return {'PATH': environ['PATH'], 'HOME': environ.get('HOME', '/data/call'), 'LANG': 'C.UTF-8',
            'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR': str(sign_in_fd), 'CLAUDE_CONFIG_DIR': '/data/claude',
            'DISABLE_AUTOUPDATER': '1', 'HQ_URL': hq_url, 'HQ_TOKEN': call_token, 'HQ_AGENT': agent,
            'HQ_CALL': '1',  # (hq job and hq item: the brief and the words on stdin, never a file)
            # The briefing has the repo's AGENTS.md already: the CLI's own copy (CLAUDE.md in the checkout) was the
            # same 5 KB again in every call's first request
            'CLAUDE_CODE_DISABLE_CLAUDE_MDS': '1'}
