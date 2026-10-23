// node --test src/credentials.test.ts: a company tool's own keys (secrets.ts registerKeys) and its credential grant
// (approvals.ts registerCredential), as the desk phone asks for them and the board saves them
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('credentials');
const secrets = await import('./secrets.ts');
const approvals = await import('./approvals.ts');

// a made-up company's tool: one sample parcel to the board's door
const KEYS = ['SAMPLE_DROP_NAME', 'SAMPLE_DROP_STREET'];
let done = false;
secrets.registerKeys({ SAMPLE_DROP_NAME: /^[^\p{Cc}]{1,80}$/u, SAMPLE_DROP_STREET: /^[^\p{Cc}]{1,80}$/u });
approvals.registerCredential('sample:drop', { keys: KEYS, approves: 'Saving both approves one sample parcel.',
  saved: 'That approves the sample parcel (sample:drop).', closed: () => done,
  closedCard: 'The sample parcel went already: nothing is kept.', closedAnswer: 'Nothing saved: the sample parcel went already.' });
const wren = await h.start({ agent: 'wren' });
const ask = (names = KEYS, kind = 'credential') => h.agent('request', wren.token, { kind, title: 'Where should the sample go?', body: 'x', secrets: names.join(',') });
const askFor = async (names = KEYS) => { const r = await ask(names); assert.equal(r.status, 200); return r.body.id as number; };
const card = async (id: number) => (await h.board('/api/requests')).body.find((r: any) => r.id === id);
const answered = async (id: number) => (await h.board('/api/requests/archive')).body.cards.find((r: any) => r.id === id).answer;
const save = (id: number, keys: Record<string, string>) => h.answer(id, '', { secrets: keys }).then(r => [r.status, r.body]);

test('a tool registers only its own plain names, never a partner key or a name already taken', async () => {
  assert.equal((await ask(['SAMPLE_DROP_CITY'])).status, 400, 'a name no tool registered');
  for (const n of ['PRINTAPI_TEST_CLIENT_ID', 'STRIPE_LIVE_KEY', 'ANTHROPICEVAL_TEST_API_KEY', 'CALL_PIN', 'SAMPLE_DROP_NAME', 'lower_case', 'X'])
    assert.throws(() => secrets.registerKeys({ [n]: /./ }), n);
  assert.equal((await save(await askFor(['SAMPLE_DROP_NAME']), { SAMPLE_DROP_NAME: 'a\u0007b' }))[0], 400, 'its own shape');
  assert.ok(!Object.keys((await h.worker('secrets')).body).some(n => n.startsWith('SAMPLE_')), 'never handed to a job');
});

test('a credential grant is no approval grant, and can be registered once', async () => {
  for (const g of ['live:sample', 'site:sample', 'sample:drop', 'Sample:x', 'nocolon'])
    assert.throws(() => approvals.registerCredential(g, { keys: ['SAMPLE_DROP_NAME'], approves: '', saved: '', closed: () => false, closedCard: '', closedAnswer: '' }), g);
  assert.equal((await h.agent('request', wren.token, { kind: 'approval', title: 'x', body: 'x', approves: 'sample:drop' })).status, 400);
});

test('saving all of its keys is the yes, in the tool\'s words; once closed, its keys are not asked for or kept', async () => {
  assert.equal((await card(await askFor(KEYS.slice(0, 1)))).grants, undefined, 'one of its keys alone grants nothing');
  const id = await askFor();
  assert.equal((await card(id)).grants, 'Saving both approves one sample parcel.');
  assert.deepEqual(await save(id, { SAMPLE_DROP_NAME: 'Testco Board' }), [200, { ok: true, missing: ['SAMPLE_DROP_STREET'] }]);
  assert.equal(approvals.approved('sample:drop'), null, 'one of two: no yes yet');
  assert.deepEqual(await save(id, { SAMPLE_DROP_STREET: 'Nowhere Lane 1' }), [200, { ok: true }]);
  assert.equal(approvals.approved('sample:drop')?.request, id);
  assert.match(await answered(id), /That approves the sample parcel \(sample:drop\)\.$/);

  const open = await askFor();   // asked again before it closed
  done = true;
  secrets.forget(KEYS);
  assert.equal((await card(open)).grants, 'The sample parcel went already: nothing is kept.');
  assert.equal((await ask(['SAMPLE_DROP_STREET'])).status, 400, 'any one of its keys');
  assert.deepEqual(await save(open, { SAMPLE_DROP_NAME: 'x', SAMPLE_DROP_STREET: 'y' }), [200, { ok: true }]);
  assert.deepEqual(secrets.stored(KEYS), []);
  assert.equal(await answered(open), 'Nothing saved: the sample parcel went already.');
  assert.equal((await ask(['PRINTAPI_TEST_CLIENT_ID'])).status, 200, 'other keys still can be');
});
