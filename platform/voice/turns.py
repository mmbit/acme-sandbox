"""Each call turn's numbers from a call agent's own session record, for the timing log (infra/call-times.sh):
numbers and tool names only, never a word said on the call."""
import json
from datetime import datetime

THINKING = ('thinking', 'redacted_thinking')


def turns(path):
    """(the turn's time, its line) for each turn in one session file."""
    entries = []
    for text in path.read_text(errors='replace').splitlines():
        try:
            entry = json.loads(text)
        except ValueError:  # (a line cut short by a crash)
            continue
        if entry.get('type') in ('user', 'assistant') and entry.get('timestamp') and not entry.get('isSidechain'):
            entries.append(entry)
    number, found = 0, []
    for index, message in enumerate(entries):
        if not sent_by_the_line(message):
            continue
        number += 1
        head = f'call: session {path.stem[:8]} turn {number}'
        reply = first_request(entries[index + 1:])
        found.append((message['timestamp'], line(head, message, reply) if reply else f'{head}: no answer'))
    return found


def sent_by_the_line(entry):
    # (a tool's result or an interruption has no promptSource)
    return entry['type'] == 'user' and entry.get('promptSource') is not None


def first_request(after):
    """The entries of the turn's first request: one per block, all with the same message id."""
    reply = []
    for entry in after:
        if sent_by_the_line(entry):
            break
        if entry['type'] == 'assistant' and (not reply or entry['message'].get('id') == reply[0]['message'].get('id')):
            reply.append(entry)
    return reply


def line(head, message, reply):
    def elapsed(entry):
        return f'{(when(entry) - when(message)).total_seconds():.1f} s'

    first = reply[0]['message']
    usage = first.get('usage') or {}
    text = (f"{head} on {first.get('model', '?')}: tokens in {usage.get('input_tokens', 0)}, "
            f"cache read {usage.get('cache_read_input_tokens', 0)}, "
            f"cache write {usage.get('cache_creation_input_tokens', 0)}")
    blocks = [(entry, block(entry)) for entry in reply]
    thought = [entry for entry, content in blocks if content.get('type') in THINKING]
    rest = [(entry, content) for entry, content in blocks if content.get('type') not in THINKING]
    if thought:
        tokens = (usage.get('output_tokens_details') or {}).get('thinking_tokens')
        text += f'; thinking until {elapsed(thought[-1])}' + (f' ({tokens} tokens)' if tokens is not None else '')
    else:
        text += '; no thinking'
    if rest:
        entry, content = rest[0]
        if content.get('type') == 'tool_use':
            text += f"; then a tool step ({content.get('name', '?')})"
        else:
            text += f'; then words, the first block written by {elapsed(entry)}'
    return text


def block(entry):
    """The entry's block (the CLI writes one per entry), or {} if it has none."""
    content = entry['message'].get('content')
    return content[0] if isinstance(content, list) and content and isinstance(content[0], dict) else {}


def when(entry):
    return datetime.fromisoformat(entry['timestamp'].replace('Z', '+00:00'))
