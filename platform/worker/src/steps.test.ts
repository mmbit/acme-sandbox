// node --test src/steps.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detailOf, stepOf, shown, guard, memberReturned, memberOf, writtenTokens } from './steps.ts';

test('a tool call reads as a line in plain words', () => {
  assert.deepEqual(stepOf('Read', { file_path: '/repo/platform/hq/shell/hud.js' }), { text: 'Reading hud.js' });
  assert.deepEqual(stepOf('Edit', { file_path: 'a/b.ts', old_string: 'x', new_string: 'y' }), { text: 'Editing b.ts' });
  assert.deepEqual(stepOf('MultiEdit', { file_path: 'b.ts', edits: [] }), { text: 'Editing b.ts' });
  assert.deepEqual(stepOf('Write', { file_path: 'n.md', content: 'one' }), { text: 'Writing n.md' });
  assert.equal(
    stepOf('Bash', { command: 'npm test', description: 'Run the schedule tests' })?.text,
    'Run the schedule tests',
  );
  assert.equal(stepOf('Bash', { command: 'ls -la' })?.text, 'Running ls -la');
  assert.equal(stepOf('Grep', { pattern: 'updateStatus' })?.text, 'Searching for “updateStatus”');
  assert.equal(stepOf('WebFetch', { url: 'https://example.com/a?b' })?.text, 'Reading example.com');
  assert.equal(stepOf('mcp__github__get_file')?.text, 'Using github');
  assert.equal(stepOf('SendMessage', { to: 'x' }), null);
});

test('a job holding a customer’s details shows only the kind of step: no paths, searches or commands', () => {
  for (const [name, input] of [
    ['Read', { file_path: 'cases/ada-jansen.md' }],
    ['Grep', { pattern: 'ada@example.nl' }],
    ['Bash', { command: 'cat x', description: 'Read Ada’s order' }],
  ] as const) {
    const text = stepOf(name, input, true)!.text;
    assert.doesNotMatch(text, /ada/i, `${name}: ${text}`);
  }
  assert.deepEqual(stepOf('Edit', { file_path: 'c.md', old_string: 'a', new_string: 'b' }, true), {
    text: 'Editing a file',
  });
});

test('the job’s log has each call as it was made; a job holding a customer’s details only its plain line', () => {
  assert.equal(
    detailOf('Bash', { command: 'npm test -- --grep till', description: 'Run the tests' }),
    '$ npm test -- --grep till',
  );
  assert.equal(detailOf('Edit', { file_path: 'platform/hq/a.js' }), 'Edit platform/hq/a.js');
  assert.equal(detailOf('Grep', { pattern: 'until', path: 'src', glob: '*.ts' }), 'Grep “until” in src (*.ts)');
  assert.equal(
    detailOf('TodoWrite', { todos: [{ content: 'a', status: 'completed' }, { content: 'b' }] }),
    'Plan: ✓ a · b',
  );
  assert.equal(detailOf('Bash', { command: 'cat cases/ada.md' }, true), 'Running a command');
  assert.equal(detailOf('Read', { file_path: 'cases/ada.md' }, true), 'Reading a file');
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

test('a job holding a customer’s details: its line itself goes as board, for the board’s own HQ alone', () => {
  const bash = { command: 'hq parcel 12 again', description: 'Place the order again' };
  assert.deepEqual(
    shown(true, g => stepOf('Bash', bash, g)?.text),
    { text: 'Running a command', board: 'Place the order again' },
  );
  assert.deepEqual(
    shown(true, g => detailOf('Bash', bash, g)),
    { text: 'Running a command', board: '$ hq parcel 12 again' },
  );
  // what its agent says between steps: only the board's
  assert.deepEqual(
    shown(true, g => (g ? null : 'Found it.')),
    { text: null, board: 'Found it.' },
  );
  // a line with nothing to hide, and any job's line otherwise: as it is, no board copy
  assert.deepEqual(
    shown(true, g => stepOf('TodoWrite', {}, g)?.text),
    { text: 'Updating its plan' },
  );
  assert.deepEqual(
    shown(false, g => stepOf('Bash', bash, g)?.text),
    { text: 'Place the order again' },
  );
  assert.deepEqual(
    shown(false, g => (g ? null : 'Found it.')),
    { text: 'Found it.' },
  );
  assert.equal(
    shown(true, g => stepOf('SendMessage', { to: 'x' }, g)?.text),
    null,
  );
});

test('a job handed a customer’s details mid-run: its lines go out guarded from the coordinator’s answer that says so', async () => {
  const answer = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
  const g = guard(false);
  const bash = { command: 'grep -i refund mail.txt', description: 'Find the refund mail' };
  await g.follow(answer({ ok: true, customers: false }));
  assert.deepEqual(
    shown(g.on, gd => stepOf('Bash', bash, gd)?.text),
    { text: 'Find the refund mail' },
  );
  // an answer HQ couldn't give, or none at all (the post failed), changes nothing
  await g.follow(answer({ error: 'down' }, 502));
  await g.follow(Promise.resolve());
  assert.equal(g.on, false);
  await g.follow(answer({ ok: true, customers: true }));
  assert.deepEqual(
    shown(g.on, gd => stepOf('Bash', bash, gd)?.text),
    { text: 'Running a command', board: 'Find the refund mail' },
  );
  // and it stays guarded: a mark is never lifted mid-run
  await g.follow(answer({ ok: true }));
  assert.equal(g.on, true);
  assert.equal(guard(true).on, true);
});
