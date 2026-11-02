// node --test src/cardread.test.ts   (the card reader, org.yaml roles.cards: a colleague's card waits off the desk phone
// for their read, then goes on in plainer words or is answered in the board's place; the real hq)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { harness } from './harness.ts';

const h = await harness('cardread');
const { db, board } = h;

const orgPath = `${h.repo}/company/org.yaml`,
  orgContent = readFileSync(orgPath, 'utf8');
writeFileSync(orgPath, orgContent.replace(/^roles:\n/m, 'roles:\n  cards: juno\n'));

const dir = mkdtempSync(`${tmpdir()}/cardread-files-`);
const running = async (agent: string) => ({ ...(await h.start({ agent })), dir: mkdtempSync(`${dir}/job-`) });
const file = (text: string) => {
  const f = `${dir}/${Math.random().toString(36).slice(2)}.md`;
  writeFileSync(f, text);
  return f;
};
const onPhone = async () => ((await board('/api/requests')).body as any[]).map(r => r.title);
const archived = async () => ((await board('/api/requests/archive')).body.cards as any[]).map(r => r.title);
const card = (title: string) =>
  db.prepare('select * from requests where title = ? order by id desc').get(title) as Record<string, any>;
const readJob = (id: number, reader = 'juno') =>
  db
    .prepare("select * from jobs where agent = ? and title like 'Read %' and prompt like ?")
    .get(reader, `%card #${id} %`) as Record<string, any>;
const ask = (job: { token: string; agent: string }, title: string, body: string) =>
  h.hq(job, 'ask', 'decision', 'today', title, file(body), '--topic', 'seats');
const SIZE = JSON.stringify({
  time: '5m',
  tokens: { work: 1000, reviews: 0, fixes: 0, feedback: 0 },
  feedback_rounds: 0,
  confidence: { level: 'low', why: 'A test' },
});
const JARGON = 'May we close Seat stops hold on the live admission repairs, accepting the bound remains unproved?';

test("a colleague's card waits off the desk phone for the reader, who reads it as filed; their own card goes straight on", async () => {
  const kit = await running('kit');
  const asked = await ask(kit, 'Close seat stops with bound unproved?', JARGON);
  assert.equal(asked.code, 0, asked.out);
  const filed = card('Close seat stops with bound unproved?');
  assert.equal((await onPhone()).includes(filed.title), false, 'not on the desk phone yet');
  const read = readJob(filed.id);
  assert.ok(read, "the reader's job");
  assert.match(read.prompt, /Title: Close seat stops with bound unproved\?/);
  assert.match(read.prompt, new RegExp(JARGON.replace(/[?]/g, '\\?')));
  assert.match(read.prompt, new RegExp(`hq card settle ${filed.id} <file>`));

  const juno = await running('juno');
  const own = await ask(juno, 'Juno asks the board', 'Which name do we print?');
  assert.match(own.out, /is on the board's desk phone/);
  assert.ok((await onPhone()).includes('Juno asks the board'), "the reader's own card goes straight on");
});

test('the reader passes a card on in plainer words, with a plainer title: it shows as a new card; only the reader may', async () => {
  const kit = await running('kit');
  await ask(kit, 'Admission repairs: close?', JARGON);
  const filed = card('Admission repairs: close?');
  assert.equal((await h.hq(kit, 'card', 'pass', String(filed.id))).code, 1, 'kit is no reader');
  const juno = await h.claimJob(readJob(filed.id).id);
  const plain = 'Seats now stop near their limit, as you asked. Is it fine to call this done?';
  assert.equal((await h.hq(juno, 'rewrite', String(filed.id), file(plain))).code, 0);
  assert.equal((await onPhone()).includes('Admission repairs: close?'), false, 'a rewrite keeps it held');
  const passed = await h.hq(juno, 'card', 'pass', String(filed.id), '--title', 'Seats stop near their limit: done?');
  assert.equal(passed.code, 0, passed.out);
  assert.match(passed.out, /is on the board's desk phone/);
  assert.ok((await onPhone()).includes('Seats stop near their limit: done?'));
  assert.equal(card('Seats stop near their limit: done?').body, plain);
  assert.equal((await h.hq(juno, 'card', 'pass', String(filed.id))).code, 1, 'passed once');
});

test('a card reader who is not the CEO can rewrite a card only while it awaits their read', async () => {
  writeFileSync(orgPath, orgContent.replace(/^roles:\n/m, 'roles:\n  cards: bolt\n'));
  try {
    const kit = await running('kit');
    await ask(kit, 'A card for Bolt to read', JARGON);
    const filed = card('A card for Bolt to read');
    const bolt = await h.claimJob(readJob(filed.id, 'bolt').id);
    const plain = 'Which name should we use?';
    const rewritten = await h.hq(bolt, 'rewrite', String(filed.id), file(plain));
    assert.equal(rewritten.code, 0, rewritten.out);
    assert.equal(card('A card for Bolt to read').body, plain);
    assert.equal((await onPhone()).includes(filed.title), false);
    assert.equal((await h.hq(bolt, 'card', 'pass', String(filed.id))).code, 0);
    assert.equal((await h.hq(bolt, 'rewrite', String(filed.id), file('Another name?'))).code, 1);
  } finally {
    writeFileSync(orgPath, orgContent.replace(/^roles:\n/m, 'roles:\n  cards: juno\n'));
  }
});

test("the reader settles a card that isn't the board's: its asker and the job waiting for it hear the reader, and the board never sees it", async () => {
  const kit = await running('kit');
  await ask(kit, 'Keep proving the bound?', JARGON);
  const filed = card('Keep proving the bound?');
  const after = await h.hq(
    kit,
    'job',
    '--after',
    `request:${filed.id}`,
    'kit',
    'Close it',
    file('Close it.'),
    '--code',
    'CLOSEIT',
    '--new',
    '--by',
    'none',
    '--size',
    SIZE,
    '--why',
    'One small step',
  );
  assert.equal(after.code, 0, after.out);
  const juno = await h.claimJob(readJob(filed.id).id);
  const answer = 'Not the board’s to decide: the seats stop near their limit, which is what it asked for. Close it.';
  const settled = await h.hq(juno, 'card', 'settle', String(filed.id), file(answer));
  assert.equal(settled.code, 0, settled.out);
  assert.match((await h.hq(kit, 'wait', String(filed.id))).out, /Not the board’s/);
  assert.equal(card('Keep proving the bound?').settled, 'juno');
  assert.equal((await onPhone()).includes('Keep proving the bound?'), false);
  assert.equal((await archived()).includes('Keep proving the bound?'), false, "not in the board's archive");
  const waiting = db.prepare("select prompt from jobs where title = 'Close it'").get() as { prompt: string };
  assert.match(waiting.prompt, /Not the board’s/);
});

test("a card for the board's own photos is the board's alone; a read that ends without passing or settling failed, and the card stays with the reader", async () => {
  const kit = await running('kit');
  const photo = await h.hq(
    kit,
    'ask',
    'action',
    'today',
    'A photo of the cut',
    file('Photograph the cut.'),
    '--photo',
    'The cut',
    '--topic',
    'prints',
  );
  assert.equal(photo.code, 0, photo.out);
  const filed = card('A photo of the cut');
  const juno = await h.claimJob(readJob(filed.id).id);
  const refused = await h.hq(juno, 'card', 'settle', String(filed.id), file('No key needed.'));
  assert.equal(refused.code, 1);
  assert.equal(card('A photo of the cut').status, 'open');
  await h.finish(juno);
  assert.equal(h.job(juno.id).status, 'failed');
  assert.equal((await onPhone()).includes('A photo of the cut'), false, 'still off the desk phone');
  const later = await running('juno');
  assert.equal((await h.hq(later, 'card', 'pass', String(filed.id))).code, 0);
  assert.ok((await onPhone()).includes('A photo of the cut'));
});

test("the reader reads a card's questions whole and rewrites them in plain words", async () => {
  const kit = await running('kit');
  const jargon = [{ title: 'Close Seat stops with the bound unproved?', options: ['Close it', 'Prove the bound'] }];
  const asked = await h.hq(
    kit,
    'ask',
    'decision',
    'today',
    'Seat stops: close?',
    file(JARGON),
    '--questions',
    file(JSON.stringify(jargon)),
    '--topic',
    'seats',
  );
  assert.equal(asked.code, 0, asked.out);
  const filed = card('Seat stops: close?');
  const read = readJob(filed.id);
  for (const words of ['Close Seat stops with the bound unproved?', 'Prove the bound'])
    assert.ok(read.prompt.includes(words));
  const juno = await h.claimJob(read.id);
  const plain = [{ title: 'Is this done?', options: ['Yes, call it done', 'No, keep checking'] }];
  const rewritten = await h.hq(
    juno,
    'rewrite',
    String(filed.id),
    file('Seats now stop near their limit, as you asked.'),
    '--questions',
    file(JSON.stringify(plain)),
  );
  assert.equal(rewritten.code, 0, rewritten.out);
  assert.deepEqual(
    JSON.parse(card('Seat stops: close?').questions).map((q: any) => [q.title, q.options]),
    plain.map(q => [q.title, q.options]),
  );
  const unreadable = await h.hq(juno, 'rewrite', String(filed.id), file('Done?'), '--questions', file('[]'));
  assert.equal(unreadable.code, 1, 'refused as hq ask refuses it');
});

test('a parked card (hq request) waits for the reader the same way', async () => {
  const kit = await running('kit');
  const parked = await h.finish(kit, {
    status: 'parked',
    request: { kind: 'decision', urgency: 'today', title: 'Parked: which seat?', body: 'Which seat?', topic: 'seats' },
  });
  assert.equal(parked.status, 200);
  const filed = card('Parked: which seat?');
  assert.equal((await onPhone()).includes('Parked: which seat?'), false);
  assert.ok(readJob(filed.id), "the reader's job");
});

test('with no card reader in org.yaml, a card goes straight to the desk phone', async () => {
  writeFileSync(orgPath, orgContent);
  try {
    const kit = await running('kit');
    const asked = await ask(kit, 'Straight on', 'Which one?');
    assert.match(asked.out, /is on the board's desk phone/);
    assert.ok((await onPhone()).includes('Straight on'));
  } finally {
    writeFileSync(orgPath, orgContent.replace(/^roles:\n/m, 'roles:\n  cards: juno\n'));
  }
});
