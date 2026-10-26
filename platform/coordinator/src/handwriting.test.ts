// node --test src/handwriting.test.ts   (the board's handwriting read into type on the real server: its session's
// request, the worker's claim and answer, a failed call tried again, the day's readings bounded)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('handwriting');
const { db } = h;
const { READS_A_DAY, SCHEMA } = await import('./handwriting.ts');
const { companyDay } = await import('./company.ts');

// A PNG of 1 × 1 white px: a picture the store can read
const INK =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';
const claim = async () => (await h.worker('reads/claim')).body;
// The worker's next claim, once the board's request has put one up
async function claimed() {
  for (let i = 0; i < 50; i++) {
    const c = await claim();
    if (c.reading) return c;
    await new Promise(res => setTimeout(res, 20));
  }
  throw new Error('nothing to claim');
}
const result = (structured_output: unknown) => ({ result: { is_error: false, structured_output } });

test('the ink goes to the small model as a picture with the prompt, and its words come back to the board', async () => {
  assert.deepEqual(await claim(), {}, 'nothing to read');
  const asked = h.board('/api/book/read', { ink: INK });
  const c = await claimed();
  assert.equal(c.model, 'haiku');
  assert.deepEqual(JSON.parse(c.schema), SCHEMA);
  const [image, words] = c.content;
  assert.deepEqual(image, {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: INK.split(',')[1] },
  });
  assert.equal(words.type, 'text');
  assert.match(words.text, /handwritten words/);
  assert.deepEqual(await claim(), {}, 'a reading under way is no one else’s');
  const answered = await h.worker('reads/answer', {
    reading: c.reading,
    ...result({ writing: true, words: '  + same for\n the Sunday one? ' }),
  });
  assert.deepEqual(answered.body, { written: 1 });
  assert.deepEqual((await asked).body, { writing: true, words: '+ same for the Sunday one?' });
});

test("marks that aren't writing come back with no words, whatever the model wrote", async () => {
  const asked = h.board('/api/book/read', { ink: INK });
  const c = await claimed();
  await h.worker('reads/answer', { reading: c.reading, ...result({ writing: false, words: 'a ring' }) });
  assert.deepEqual((await asked).body, { writing: false, words: '' });
});

test('a failed call is tried once more; a second failure tells the board', async () => {
  const asked = h.board('/api/book/read', { ink: INK });
  const first = await claimed();
  await h.worker('reads/answer', { reading: first.reading, error: 'exit 1' });
  const again = await claimed();
  assert.equal(again.reading, first.reading, 'the same ink, due again');
  await h.worker('reads/answer', {
    reading: again.reading,
    result: { is_error: false, structured_output: { words: 1 } },
  });
  const res = await asked;
  assert.equal(res.status, 502);
  assert.deepEqual(await claim(), {}, 'gone once told');
});

test("only the board's session reads, a picture only, and READS_A_DAY a day", async () => {
  assert.equal((await h.board('/api/book/read', { ink: 'data:text/plain;base64,aGk=' })).status, 400);
  const day = companyDay(Date.now());
  db.prepare('update handwriting_reads set reads = ? where day = ?').run(READS_A_DAY, day);
  const res = await h.board('/api/book/read', { ink: INK });
  assert.equal(res.status, 429);
  assert.match(res.body.error, new RegExp(`${READS_A_DAY} times a day`));
  assert.deepEqual(await claim(), {}, 'nothing sent to the model past the bound');
  const outside = await fetch(`${h.base}/api/book/read`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ink: INK }),
  });
  assert.ok([401, 403].includes(outside.status), `no session: ${outside.status}`);
});
