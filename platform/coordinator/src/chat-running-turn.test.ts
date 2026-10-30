// node --test src/chat-running-turn.test.ts: what the board says while the CEO's turn is running reaches that turn at
// its next step (chat.take), is answered by its one reply and starts no second turn; a line the turn never took waits for
// the next turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';
import { WAITING, ANSWERED, WITH_CEO, OFFERED } from './chatstates.ts';

const h = await harness('chat-running-turn');
const say = async (text: string) => assert.equal((await h.board('/api/chat', { text })).status, 200);
const chatJobs = () =>
  h.db.prepare("select id, status from jobs where kind = 'chat' order by id").all() as { id: number; status: string }[];
const sentOf = (text: string) =>
  (h.db.prepare('select sent from chat where text = ?').get(text) as { sent: number }).sent;
const turn = () => h.claimJob(chatJobs().at(-1)!.id);

test('a line said during the turn goes to its session, and the turn ends having answered both', async () => {
  await say('Is the back link fixed?');
  const running = await turn();
  await say('And the footer too?');
  assert.equal(sentOf('And the footer too?'), WAITING, 'waiting until the session takes it');
  const offered = (await h.agent('inbox', running.token, {})).body as { chat?: number; from?: string; text?: string }[];
  assert.deepEqual(
    offered.filter(m => m.chat).map(m => [m.from, m.text]),
    [['board', 'And the footer too?']],
  );
  assert.equal(sentOf('And the footer too?'), OFFERED, 'offered, not confirmed');
  assert.deepEqual((await h.agent('inbox', running.token, {})).body, [], 'not offered twice');
  await h.agent('inbox-ack', running.token, { ids: [], chat: offered.map(m => m.chat) });
  assert.equal(sentOf('And the footer too?'), WITH_CEO);
  await h.finish(running, { result: 'Both fixed.' });
  assert.equal(sentOf('And the footer too?'), ANSWERED, 'answered by that reply');
  assert.equal(chatJobs().filter(j => j.status === 'queued').length, 0, 'no second turn');
});

test('a line the turn never took, or was offered but never confirmed, goes in the next turn', async () => {
  await say('First question');
  const running = await turn();
  await say('Offered line');
  await h.agent('inbox', running.token, {}); // offered; the hook never confirms it
  await say('Never offered');
  assert.equal(sentOf('Offered line'), OFFERED);
  await h.finish(running, { result: 'Answer.' });
  assert.equal(chatJobs().filter(j => j.status === 'queued').length, 1, 'a second turn starts for them');
  assert.deepEqual([sentOf('Offered line'), sentOf('Never offered')], [WITH_CEO, WITH_CEO], 'handed to that turn');
});

test("a confirmed line is in the turn's note, and a malformed confirmation is refused", async () => {
  await say('Question');
  const running = await turn();
  await say('Side line');
  const offered = (await h.agent('inbox', running.token, {})).body as { chat?: number }[];
  assert.equal((await h.agent('inbox-ack', running.token, { ids: [], chat: 'nope' })).status, 400);
  await h.agent('inbox-ack', running.token, { ids: [], chat: offered.map(m => m.chat) });
  const note = (h.db.prepare('select note from jobs where id = ?').get(running.id) as { note: string }).note;
  assert.ok(note.includes('Side line'), 'a rerun in a new session hears it');
});
