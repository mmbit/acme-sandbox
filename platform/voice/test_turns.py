"""cd platform/voice && python3 -m unittest test_turns

turns.py: each call turn's numbers from the CLI's session records (the shape Claude Code 2.1.283 writes, as a call
agent's session holds it: one entry per block, a tool's result and an interruption as user entries without
promptSource)."""
import json, sys, tempfile, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import turns  # noqa: E402

SAID = 'Pumpernickel'  # (words said on the call: never in what turns.py prints)


def user(stamp, text, **fields):
    content = [{'type': 'text', 'text': text}]
    return {'type': 'user', 'timestamp': stamp, 'message': {'role': 'user', 'content': content}, **fields}


def block(stamp, message_id, content, usage):
    return {'type': 'assistant', 'timestamp': stamp,
            'message': {'id': message_id, 'model': 'claude-opus-5-5', 'content': [content], 'usage': usage}}


U1 = {'input_tokens': 6, 'cache_read_input_tokens': 2900, 'cache_creation_input_tokens': 15800, 'output_tokens': 40,
      'output_tokens_details': {'thinking_tokens': 31}}
U2 = {'input_tokens': 4, 'cache_read_input_tokens': 18700, 'cache_creation_input_tokens': 90, 'output_tokens': 9}
SESSION = [
    {'type': 'queue-operation', 'timestamp': '2026-10-02T18:39:05.000Z'},
    user('2026-10-02T18:39:06.000Z', f'Hi Juno, {SAID}?', promptSource='sdk'),
    block('2026-10-02T18:39:08.100Z', 'msg_1', {'type': 'thinking', 'thinking': ''}, U1),
    block('2026-10-02T18:39:09.000Z', 'msg_1', {'type': 'text', 'text': f'{SAID} is fine.'}, U1),
    user('2026-10-02T18:39:20.000Z', 'And the jobs?', promptSource='sdk'),
    block('2026-10-02T18:39:21.200Z', 'msg_2',
          {'type': 'tool_use', 'name': 'mcp__hq__search', 'input': {'query': SAID}}, U2),
    {**user('2026-10-02T18:39:22.000Z', ''), 'toolUseResult': SAID,
     'message': {'role': 'user', 'content': [{'type': 'tool_result', 'content': SAID}]}},
    block('2026-10-02T18:39:24.000Z', 'msg_3', {'type': 'text', 'text': 'Found it.'}, U2),
    user('2026-10-02T18:39:30.000Z', 'Wait.', promptSource='sdk'),
    user('2026-10-02T18:39:30.400Z', '[Request interrupted by user]'),
]


class Turns(unittest.TestCase):
    def setUp(self):
        self.path = Path(tempfile.mkdtemp(), '0123abcd-ffff.jsonl')
        cut_short = '{"type": "assistant", "timest'
        self.path.write_text(''.join(json.dumps(entry) + '\n' for entry in SESSION) + cut_short)

    def test_each_turn_says_its_tokens_its_thinking_and_what_came_first(self):
        self.assertEqual(turns.turns(self.path), [
            ('2026-10-02T18:39:06.000Z',
             'call: session 0123abcd turn 1 on claude-opus-5-5: tokens in 6, cache read 2900, cache write 15800; '
             'thinking until 2.1 s (31 tokens); then words, the first block written by 3.0 s'),
            ('2026-10-02T18:39:20.000Z',
             'call: session 0123abcd turn 2 on claude-opus-5-5: tokens in 4, cache read 18700, cache write 90; '
             'no thinking; then a tool step (mcp__hq__search)'),
            ('2026-10-02T18:39:30.000Z', 'call: session 0123abcd turn 3: no answer')])

    def test_nothing_said_on_the_call_comes_out(self):
        self.assertNotIn(SAID, repr(turns.turns(self.path)))


if __name__ == '__main__':
    unittest.main()
