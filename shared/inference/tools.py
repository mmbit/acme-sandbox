"""Mediate candidate tools in a fresh process with no supervisor descriptors or filesystem authority."""

import fnmatch
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys

import confinement


TOOLS = ('read', 'write', 'edit', 'bash', 'glob', 'grep')
LINE_CHARS = 2000
SEARCH_MATCHES = 100
SEARCH_FILE_BYTES = 1024 * 1024


def main():
    try:
        policy = json.loads(Path(sys.argv[1]).read_text())
        request = json.load(sys.stdin)
        workspace = Path(policy['workspace'])
        os.chdir(workspace)
        environment = {'PATH': policy['path'], 'HOME': str(workspace), 'TMPDIR': str(workspace),
                       'LANG': 'C.UTF-8', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null'}
        os.environ.clear()
        os.environ.update(environment)
        confinement.enter(workspace, policy['readOnly'])
        response = execute(request['tool'], request['arguments'], policy)
    except OSError as failure:
        response = {'error': f'Tool failed: {failure.strerror or "operating system refused the operation"}'}
    except (ValueError, re.error) as failure:
        response = {'error': ' '.join(str(failure).split())}
    except (KeyError, TypeError):
        response = {'error': 'Invalid tool arguments. Check the tool description'}
    except Exception:
        response = {'error': 'Tool worker failed before completing the request'}
    print(json.dumps(response), flush=True)


def execute(tool, arguments, policy):
    if tool not in policy['tools']:
        raise ValueError('The candidate tool is not approved')
    if tool == 'bash':
        return command(arguments['command'], policy['commands'])
    if tool in ('glob', 'grep'):
        return search(tool, arguments, policy['outputBytes'] - 1024)
    path = Path(arguments['filePath'])
    if tool == 'read':
        return read(path, arguments, policy['outputBytes'] - 1024)
    if tool == 'write':
        path.write_text(arguments['content'])
    elif tool == 'edit':
        source = path.read_text()
        old, new = arguments['oldString'], arguments['newString']
        count = source.count(old)
        if not old or not count or (count > 1 and not arguments.get('replaceAll', False)):
            raise ValueError('The edit needs one unique nonempty oldString. Read the source or use replaceAll')
        path.write_text(source.replace(old, new, -1 if arguments.get('replaceAll', False) else 1))
    return {'output': 'File updated'}


def command(source, approved):
    if any(character in source for character in '\n\r;&|<>`$()') or not any(
            fnmatch.fnmatchcase(source, pattern) for pattern in approved):
        raise ValueError(f'not approved: {source}; approved: {", ".join(approved) or "(none)"}')
    arguments = shlex.split(source)
    if not arguments:
        raise ValueError('The command is empty')
    completed = subprocess.run(arguments, capture_output=True, text=True, errors='replace')
    return {'output': completed.stdout + completed.stderr, 'metadata': {'exit': completed.returncode}}


def read(path, arguments, body_bytes):
    offset = arguments.get('offset', 1)
    limit = arguments.get('limit', 200)
    if type(offset) is not int or offset < 1:
        raise ValueError('offset must be a positive integer, counted from 1')
    if type(limit) is not int or not 1 <= limit <= 2000:
        raise ValueError('limit must be an integer from 1 to 2000')
    output, size, next_offset = [], 0, None
    with path.open(encoding='utf-8') as stream:
        for number, (line, shortened) in enumerate(lines(stream), 1):
            if number < offset:
                continue
            entry = f'{number}: {line}' + (' [line truncated]' if shortened else '')
            length = len(entry.encode()) + 1
            if not output and length > body_bytes:
                entry = truncate_entry(entry, body_bytes - 1)
                length = len(entry.encode()) + 1
            if len(output) == limit or size + length > body_bytes:
                next_offset = number
                break
            output.append(entry)
            size += length
    notice = f'\n[output truncated. Continue with offset={next_offset}]' if next_offset else '\n[End of file]'
    return {'output': '\n'.join(output) + notice, 'metadata': {'nextOffset': next_offset}}


def lines(stream):
    while True:
        chunk = stream.readline(LINE_CHARS + 1)
        if not chunk:
            return
        prefix = chunk.rstrip('\r\n')
        shortened = len(prefix) > LINE_CHARS
        while chunk and not chunk.endswith('\n'):
            chunk = stream.readline(LINE_CHARS + 1)
            if chunk:
                shortened = True
        yield prefix[:LINE_CHARS], shortened


def search(tool, arguments, body_bytes):
    root = Path(arguments.get('path', '.'))
    with os.scandir(root):
        pass
    if tool == 'glob':
        if Path(arguments['pattern']).is_absolute():
            raise ValueError('pattern must be relative to path. Put the search directory in path')
        entries = (str(path) for path in root.glob(arguments['pattern']))
        return collect(entries, {}, body_bytes)
    pattern = re.compile(arguments['pattern'])
    skipped = {'binary': 0, 'oversized': 0, 'unreadable': 0}
    entries = grep(root, arguments.get('include', '*'), pattern, skipped)
    return collect(entries, skipped, body_bytes)


def grep(root, include, pattern, skipped):
    for path in root.rglob(include):
        if not path.is_file() or '.git' in path.parts:
            continue
        try:
            with path.open('rb') as stream:
                if os.fstat(stream.fileno()).st_size > SEARCH_FILE_BYTES:
                    skipped['oversized'] += 1
                    continue
                contents = stream.read(SEARCH_FILE_BYTES + 1)
            if len(contents) > SEARCH_FILE_BYTES:
                skipped['oversized'] += 1
                continue
            if b'\0' in contents:
                skipped['binary'] += 1
                continue
            for number, line in enumerate(contents.decode('utf-8').splitlines(), 1):
                if pattern.search(line):
                    yield f'{path}:{number}:{line[:LINE_CHARS]}' + (' [line truncated]' if len(line) > LINE_CHARS else '')
        except UnicodeError:
            skipped['binary'] += 1
        except OSError:
            skipped['unreadable'] += 1


def collect(entries, skipped, body_bytes):
    output, size, truncated = [], 0, False
    for entry in entries:
        length = len(entry.encode()) + 1
        if not output and length > body_bytes:
            entry = truncate_entry(entry, body_bytes - 1)
            length = len(entry.encode()) + 1
            truncated = True
        if len(output) == SEARCH_MATCHES or size + length > body_bytes:
            truncated = True
            break
        output.append(entry)
        size += length
    notice = '\n[Results truncated. Narrow path or pattern]' if truncated else ''
    if any(skipped.values()):
        notice += '\n[Files skipped: ' + ', '.join(f'{count} {reason}' for reason, count in skipped.items() if count) + ']'
    return {'output': ('\n'.join(output) or 'No matches') + notice, 'metadata': {'truncated': truncated, 'skipped': skipped}}


def truncate_entry(entry, maximum_bytes):
    marker = ' [entry truncated]'
    prefix_bytes = maximum_bytes - len(marker.encode())
    if prefix_bytes < 4:
        raise ValueError('The context budget is too small to return an entry. Increase contextTokens')
    return entry.encode()[:prefix_bytes].decode('utf-8', errors='ignore') + marker


def policy(workspace, settings, receipt, context_tokens):
    # One eighth of the context at roughly four bytes per token leaves room for history and replies.
    return {'contextTokens': context_tokens, 'outputBytes': context_tokens * 4 // 8,
            'workspace': str(workspace.resolve()), 'tools': settings['tools'],
            'commands': settings.get('commands', []), 'readOnly': receipt['sandbox']['readOnly'],
            'path': receipt['sandbox']['path']}


def run(policy_path, tool, arguments, **options):
    return subprocess.run([sys.executable, str(Path(__file__).resolve()), str(policy_path)],
                          input=json.dumps({'tool': tool, 'arguments': arguments}),
                          capture_output=True, text=True, **options)


if __name__ == '__main__':
    main()
