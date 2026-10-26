"""The board's call agent reads what a job's agent reads: the server's status report and the company's git, every branch
with unmerged work. hq_tools.py offers them as the report and git tools."""
import os, re, subprocess

# One answer stays under the CLI's limit for an MCP tool's answer (MAX_MCP_OUTPUT_TOKENS, 25,000 tokens; the report's
# figures and code run near 3 characters a token): a longer read comes in pages, each saying where the next starts.
PAGE = 60_000
FOOTER = 200  # (the room a page keeps for its last line, which says what it holds and where the rest starts)
# The worker's mirror of the company's repository, every branch and a job's unpushed commits (refs/outgoing), mounted
# read-only (infra/compose.yaml's voice service); a test gives git its own.
MIRROR = os.environ.get('HQ_TOOLS_MIRROR', '/mirror')
# A revision as a job would name it: main, job/1234, origin/job/1234, outgoing/job/1234, a sha, HEAD~2, v1^. Never
# one that starts with '-' (git would read it as an option) or holds ':' (show builds rev:path itself).
REVISION = re.compile(r'[A-Za-z0-9][A-Za-z0-9._/^~@{}-]*')
# A path in the repository: never a pathspec's magic (':(...)') or an option
PATH = re.compile(r'[A-Za-z0-9._@+][A-Za-z0-9._/@+ -]*')
TIME = re.compile(r'[0-9][0-9:TZ.+-]{3,34}')  # (an ISO time, as the reports give it: hq report checks it)
GIT_COMMANDS = ('log', 'show', 'diff', 'grep', 'branches')


def paged(text, start=1, offset=0):
    """(ok, text): the answer from line start (1-based), offset characters into it, as far as fits a PAGE with its
    footer, and where the rest starts if there is a rest. A line longer than a page goes on over the pages that follow,
    by its offset, so no answer is longer than a PAGE and every part can be had."""
    lines = text.splitlines()
    if start > max(len(lines), 1):
        return False, f'from {start} is past the end: the answer has {len(lines)} lines'
    if offset and offset >= len(lines[start - 1]):
        return False, f'offset {offset} is past the end of line {start}: it has {len(lines[start - 1]):,} characters'
    shown, room, line, cut = [], PAGE - FOOTER, start, offset
    while line <= len(lines):
        piece = lines[line - 1][cut:]
        joined = len(piece) + (1 if shown else 0)
        if joined <= room:
            shown.append(piece)
            room, line, cut = room - joined, line + 1, 0
            continue
        if shown and len(piece) <= PAGE - FOOTER:  # (a line that fits a page of its own starts the next one)
            break
        taken = room - (1 if shown else 0)
        if taken > 0:
            shown.append(piece[:taken])
            cut += taken
        break
    if start == 1 and not offset and line > len(lines):
        return True, text
    last = line if cut else line - 1
    within = (f', line {start} from its character {offset + 1:,}' if offset else '') + (
        f', line {line} up to its character {cut:,}' if cut else '')
    rest = (f'; the rest from {line}' + (f' with offset {cut}' if cut else '')) if line <= len(lines) else ''
    return True, '\n'.join(shown) + f'\n(lines {start}–{last} of {len(lines)}{within}{rest})'


def place(a):
    """(start, offset, None) of a tool call's from and offset, or (None, None, the refusal)."""
    start, offset = a.get('from', 1), a.get('offset', 0)
    if type(start) is not int or start < 1 or type(offset) is not int or offset < 0:
        return None, None, 'from is a line number, 1 or more, and offset a count of characters into it, 0 or more'
    return start, offset, None


def sections(report):
    """The report's sections in order: (heading, its lines), the lines before the first heading as '(the opening)'. In
    what changed since a time (a unified diff) each hunk is one, its header naming its section."""
    found, heading, lines = [], '(the opening)', []
    for line in report.splitlines():
        if line.startswith(('== ', '@@ ')):
            found.append((heading, lines))
            heading, lines = line, []
        else:
            lines.append(line)
    return found + [(heading, lines)]


def named(heading, lines):
    """The words a section is asked for in: its heading, and for a hunk also the headings inside it (git names a hunk by
    the heading above it, so a change on a heading's first line sits in the hunk of the one before)."""
    inside = [line[1:] for line in lines if heading.startswith('@@ ') and line[1:].startswith('== ')]
    return ' '.join([heading, *inside])


def report(a, hq_env):
    """(ok, text): hq report (the newest, or at or since a time), as a list of its sections; with section, the sections
    whose heading has those words; with find, only the lines that have them (under their heading)."""
    times = {k: a.get(k) for k in ('since', 'at') if a.get(k) is not None}
    if any(not isinstance(t, str) or not TIME.fullmatch(t) for t in times.values()):
        return False, 'since and at are ISO times, as the reports give them: 2026-10-25T14:00Z'
    section, find = a.get('section', ''), a.get('find', '')
    if not isinstance(section, str) or not isinstance(find, str):
        return False, 'section and find are words'
    start, offset, refused = place(a)
    if refused:
        return False, refused
    argv = ['hq', 'report', *(arg for k, t in times.items() for arg in (f'--{k}', t))]
    r = subprocess.run(argv, env=hq_env, stdin=subprocess.DEVNULL, capture_output=True, text=True)
    if r.returncode:
        return False, f'hq report failed: {(r.stderr or r.stdout).strip()[:300] or "the coordinator refused it"}'
    parts = sections(r.stdout)
    if not section.strip() and not find.strip():
        listed = [f'{heading} ({len(lines)} lines)' for heading, lines in parts]
        return paged('The report\'s sections (ask for one by words of its heading):\n' + '\n'.join(listed), start, offset)
    chosen = [(h, ls) for h, ls in parts if section.strip().lower() in named(h, ls).lower()]
    if not chosen:
        return False, f'no section\'s heading has "{section}": leave section out for the list of them'
    words = find.strip().lower()
    kept = [(h, [line for line in ls if words in line.lower()]) for h, ls in chosen]
    kept = [(h, ls) for h, ls in kept if ls]
    if not kept:
        return True, f'No line has "{find}" in {"that section" if section.strip() else "the report"}.'
    return paged('\n'.join(line for h, ls in kept for line in [h, *ls]), start, offset)


def git_env(mirror):
    """git's environment: the mirror, no system or global config (nothing there can name a command), no prompt."""
    return {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'LANG': 'C.UTF-8', 'GIT_DIR': mirror,
            'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0',
            'GIT_OPTIONAL_LOCKS': '0', 'GIT_NO_REPLACE_OBJECTS': '1'}


def revision(rev, command):
    """(the revision argument, None) or (None, the refusal): a branch, tag or commit, or for log and diff a range
    ('main..job/1234', 'main...job/1234'), each side checked after a job's 'origin/' is taken off (the mirror's
    branches are its own)."""
    names = re.split(r'\.\.\.?', rev, maxsplit=1) if command in ('log', 'diff') else [rev]
    plain = [n.removeprefix('origin/') for n in names]
    if not all(REVISION.fullmatch(n) and '..' not in n for n in plain):
        return None, 'rev is a branch, tag or commit (main, job/1234, a sha)' + (
            ', or a range: main..job/1234 (its commits main lacks), main...job/1234 (what it changed since it left '
            'main)' if command in ('log', 'diff') else '')
    if command == 'diff' and len(names) == 1:
        return None, 'diff needs a range: main...job/1234 (what the branch changed since it left main), or a..b'
    joint = rev[len(names[0]):len(rev) - len(names[-1])] if len(names) > 1 else ''
    return joint.join(plain), None


def git_argv(a):
    """The git command line for a valid git tool call: a list, or the refusal (a string)."""
    command, rev, path = a.get('command'), a.get('rev', 'main'), a.get('path', '')
    pattern, stat = a.get('pattern', ''), a.get('stat') is True
    if command not in GIT_COMMANDS:
        return f'command is one of {", ".join(GIT_COMMANDS)}'
    if not isinstance(path, str) or (path and not PATH.fullmatch(path)) or '..' in path.split('/'):
        return 'path is a file or folder in the repository, like platform/voice/server.py'
    if not isinstance(pattern, str) or '\n' in pattern:
        return 'pattern is one line of words'
    if command == 'branches':
        return ['git', 'for-each-ref', '--sort=-committerdate',
                '--format=%(refname:short) %(committerdate:short) %(subject)', 'refs/heads/', 'refs/outgoing/']
    if command == 'grep' and not pattern:
        return 'grep needs a pattern: the words to find'
    target, refused = revision(rev if isinstance(rev, str) else '', command)
    if refused:
        return refused
    paths = ['--', path] if path else []
    diffs = ['--no-color', '--no-ext-diff', '--no-textconv', *(['--stat'] if stat else [])]
    return {
        'log': ['git', 'log', '--no-color', '--format=%h %ad %an: %s', '--date=short', target, *paths],
        'show': ['git', 'show', *diffs, f'{target}:{path}' if path else target],
        'diff': ['git', 'diff', *diffs, target, *paths],
        'grep': ['git', 'grep', '--no-color', '-n', '-I', '-F', *(['-i'] if a.get('ignore_case') is True else []),
                 '-e', pattern, target, *paths],
    }[command]


def git(a, mirror=MIRROR):
    """(ok, text): one read of the company's git (the mirror), from an argument list git_argv built, in a page."""
    argv = git_argv(a)
    if isinstance(argv, str):
        return False, argv
    start, offset, refused = place(a)
    if refused:
        return False, refused
    r = subprocess.run([argv[0], '-c', f'safe.directory={mirror}', *argv[1:]], env=git_env(mirror),
                       stdin=subprocess.DEVNULL, capture_output=True, text=True, errors='replace')
    if a.get('command') == 'grep' and r.returncode == 1 and not r.stderr.strip():
        return True, 'No line has it.'
    if r.returncode:
        return False, f'git {a["command"]}: {(r.stderr or r.stdout).strip()[:500]}'
    out = r.stdout
    if a['command'] == 'branches' and a.get('pattern'):
        out = '\n'.join(line for line in out.splitlines() if a['pattern'].lower() in line.lower())
    return paged(out.strip() or '(nothing)', start, offset)
