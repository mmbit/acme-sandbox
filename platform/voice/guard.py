"""What keeps the voice line's token and the seat's sign-in from the call agent (the README's "Trust")."""
import ctypes, json, os, subprocess, sys
from pathlib import Path

HQ_TOOLS = [sys.executable, str(Path(__file__).with_name('hq_tools.py'))]
# (when: eta)
# (git, report; ask_to_see, draw; drive, open_work; the pins' removal)
# (answer_note)
# (scrap and title_page: the call's notes page, callnotes.py; change_page, mark_page and read_page: the agent working it.)
CALL_TOOLS = ['add', 'answer_note', 'ask_to_see', 'call', 'change_page', 'draw', 'drive', 'estimate', 'eta', 'expedite', 'git',
              'hang_up', 'history', 'intercom', 'job', 'manage', 'mark_page', 'open_work', 'promise', 'reach', 'read_page',
              'replace', 'report', 'scrap', 'screen', 'search', 'sketch', 'title_page', 'waiting', 'when']
PARTNER_TOOLS = ['hang_up', 'no_transcript', 'note', 'screen']
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


# The board's call agent has the tools a job's agent has but a shell: it reads the company's
# files (main, read only), hands work on with hq job (and adds to it), puts promises and corrections on the call's list,
# manages the company's work with hq's management commands and reads (manage), looks things up with hq search, history,
# call, intercom and projects (eta), reads the server's status report (report) and every branch's code (git: the
# worker's mirror, read only), searches and fetches the web (WebSearch runs at Anthropic; WebFetch from this container,
# as a job's does from the worker), and sees the caller's screen on a walk-through (screen) and the board's sketches
# (sketch), asks to see the board's screen (ask_to_see) and rings things on its page (draw), suggests opening a piece of
# work there and moves it while it talks (open_work, drive), all through the
# voice line's own socket. What stays shut, and why:
# - no shell (Bash): it runs as the line's uid, which can read /seat, the seat's sign-in (README's "Trust"), and a
#   command steered by any text it reads (a web page, a misheard word) could send that anywhere. Its reads are tools
#   that run hq and git from argument lists they build, so no word of the agent's becomes a command.
# - no customer's details (mail, care cases, orders, photos: charter rule 7): a call's transcript and summary are
#   read by every agent, and a call can't be marked as holding them as a job is (server.ts CALL_ROUTES).
# - the line's own folders and /proc are off limits to its Read, Grep and Glob: the OS keeps the server's token from
#   it, this is a second fence.
# If hq_tools.py won't start, the CLI still does (MCP servers are optional): calls work, without its tools.
TOOLS = cli_tools(CALL_TOOLS, 'Read,Grep,Glob,WebSearch,WebFetch')  #.
# A call out to a partner: no built-in tool and nothing of the company's looked up, so an outsider's words can't steer
# a look-up (house rule 9). Its screen tool shows only the partner's own screen.
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


def agent_env(environ, hq_url, sign_in_fd, call_token, agent, screen=None, time_zone='UTC', *, work, cli_config):
    """The call agent's whole environment: nothing of the server's passes but PATH and HOME (sign_in_fd:
    sign_in_pipe). screen: the line's screen socket and the session's key, on a call with a screen (hq_tools.py's
    screen and sketch tools read them; hq never gets them). time_zone: the board's clock (the call's
    company.timeZone), hq's answers' times are in it. work: HOME where the server has none; cli_config: the CLI's
    config folder (server.Paths' work and cli_config)."""
    return {'PATH': environ['PATH'], 'HOME': environ.get('HOME', str(work)), 'LANG': 'C.UTF-8',
            'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR': str(sign_in_fd), 'CLAUDE_CONFIG_DIR': str(cli_config),
            'DISABLE_AUTOUPDATER': '1', 'HQ_URL': hq_url, 'HQ_TOKEN': call_token, 'HQ_AGENT': agent,
            'HQ_CALL': '1',  # (hq job and hq item: the brief and the words on stdin, never a file)
            # (what hq answers on a call is read out: its times on the board's clock)
            'HQ_TIME_ZONE': time_zone,
            # The briefing has the repo's AGENTS.md already: the CLI's own copy (CLAUDE.md in the checkout) was the
            # same 5 KB again in every call's first request
            'CLAUDE_CODE_DISABLE_CLAUDE_MDS': '1',
            **({'SCREEN_SOCKET': screen[0], 'SCREEN_KEY': screen[1]} if screen else {})}
