// node --test src/steps.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detailOf, stepOf, memberReturned, memberOf, writtenTokens } from './steps.ts';

test('a tool call reads as a line in plain words: its kind and what it names for agents, the line itself for the board', () => {
  assert.deepEqual(stepOf('Read', { file_path: '/repo/platform/hq/shell/hud.js' }), { text: 'Reading hud.js' });
  assert.deepEqual(stepOf('Edit', { file_path: 'a/b.ts', old_string: 'x', new_string: 'y' }), { text: 'Editing b.ts' });
  assert.deepEqual(stepOf('MultiEdit', { file_path: 'b.ts', edits: [] }), { text: 'Editing b.ts' });
  assert.deepEqual(stepOf('Write', { file_path: 'n.md', content: 'one' }), { text: 'Writing n.md' });
  assert.deepEqual(stepOf('Bash', { command: 'hq care 12', description: 'Read case 12' }), {
    text: 'Running a command',
    board: 'Read case 12',
  });
  assert.equal(stepOf('Bash', { command: 'ls -la' })?.board, 'Running ls -la');
  assert.deepEqual(stepOf('Grep', { pattern: 'jan@example.org' }), {
    text: 'Searching the files',
    board: 'Searching for “jan@example.org”',
  });
  assert.deepEqual(stepOf('WebSearch', { query: 'Jan Jansen' }), {
    text: 'Searching the web',
    board: 'Searching the web for “Jan Jansen”',
  });
  assert.deepEqual(stepOf('WebFetch', { url: 'https://example.com/a?b' }), { text: 'Reading example.com' });
  assert.equal(stepOf('mcp__github__get_file')?.text, 'Using github');
  assert.equal(stepOf('SendMessage', { to: 'x' }), null);
});

test('the job’s log has each call as it was made for the board, and its kind for agents', () => {
  assert.deepEqual(detailOf('Bash', { command: 'hq care reply 12 "Dear Jan"', description: 'Reply' }), {
    text: 'Running a command',
    board: '$ hq care reply 12 "Dear Jan"',
  });
  assert.deepEqual(detailOf('Edit', { file_path: 'platform/hq/a.js' }), {
    text: 'Editing a.js',
    board: 'Edit platform/hq/a.js',
  });
  assert.deepEqual(detailOf('Grep', { pattern: 'until', path: 'src', glob: '*.ts' }), {
    text: 'Searching the files',
    board: 'Grep “until” in src (*.ts)',
  });
  assert.deepEqual(detailOf('TodoWrite', { todos: [{ content: 'a', status: 'completed' }, { content: 'b' }] }), {
    text: 'Updating its plan',
    board: 'Plan: ✓ a · b',
  });
  assert.deepEqual(detailOf('SendMessage', { to: 'kit', message: 'Jan wants a refund' }), {
    text: 'To kit',
    board: 'To kit: Jan wants a refund',
  });
});

test("a team member is done when its Agent call comes back with its work or fails, not when it's sent to the background", () => {
  const back = (status: string) => ({ type: 'user', tool_use_result: { status } });
  assert.equal(memberReturned(back('completed'), { type: 'tool_result', tool_use_id: 'a' }), true);
  assert.equal(memberReturned(back('async_launched'), { type: 'tool_result', tool_use_id: 'a' }), false);
  assert.equal(memberReturned(back('teammate_spawned'), { type: 'tool_result', tool_use_id: 'a' }), false);
  assert.equal(memberReturned({ type: 'user' }, { type: 'tool_result', tool_use_id: 'a', is_error: true }), true);
});

test("a team member's task is its Agent call's description, never only its name again", () => {
  assert.deepEqual(memberOf({ name: 'quoin', description: "The formats kit's tests" }), {
    name: 'quoin',
    task: "The formats kit's tests",
  });
  assert.deepEqual(memberOf({ description: 'Burnish' }), { name: 'Burnish', task: '' }); // the name in the description
  assert.deepEqual(memberOf({ name: 'burnish', description: 'Burnish' }), { name: 'burnish', task: '' });
  assert.deepEqual(memberOf({ name: 'sea-glass', description: 'Sea glass' }), { name: 'sea-glass', task: '' });
  assert.deepEqual(memberOf({ name: 'burnish', description: ' ' }), { name: 'burnish', task: '' });
  assert.deepEqual(memberOf({}), { name: 'helper', task: '' });
});

test('what a step wrote counts in tokens, about four characters each, whichever engine wrote it', () => {
  const claude = (...content: object[]) => ({
    type: 'assistant',
    message: { id: 'm', content, usage: { output_tokens: 1 } },
  });
  assert.equal(writtenTokens(claude({ type: 'text', text: 'x'.repeat(400) })), 100);
  assert.equal(writtenTokens(claude({ type: 'thinking', thinking: 'y'.repeat(40) })), 10);
  assert.equal(writtenTokens(claude({ type: 'tool_use', name: 'Bash', input: { command: 'ls' } })), 4);
  assert.equal(writtenTokens({ type: 'item.completed', item: { type: 'agent_message', text: 'z'.repeat(80) } }), 20);
  assert.equal(writtenTokens({ type: 'item.completed', item: { type: 'command_execution', command: 'npm test' } }), 2);
  assert.equal(
    writtenTokens({ type: 'user', message: { content: [{ type: 'tool_result', content: 'long output' }] } }),
    0,
  );
});
