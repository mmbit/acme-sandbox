// node --test src/ink/booktyped.test.ts   (a question typed on a page of the board's book, answered under it)
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { harness, until } from '../harness.ts';

const h = await harness('booktyped');
const { db } = h;
afterEach(() => h.cancelQueued());
const question = { x: 40, y: 60, w: 300, text: 'What time is it? Just testing agent answers :)', color: '#2a2352' };
const response = 'It is 16:35 in Amsterdam.';

// The judge's verdict on the question: an answer
async function judgedAnswer() {
  let reading: any;
  await until(async () => (reading = (await h.worker('reads/claim')).body).reading, "the judge's reading");
  const verdict = { structured_output: { reply: 'answer', why: 'The board asks for the current time.' } };
  assert.equal((await h.worker('reads/answer', { reading: reading.reading, result: verdict })).body.written, 1);
}

test('a typed box on a book page receives an answer or a reason when its run fails', async () => {
  for (const status of ['done', 'failed']) {
    const page = (await h.board('/api/book/page/new', { kind: 'free', w: 800, h: 600 })).body;
    assert.equal(
      (await h.board('/api/book/page/save', { id: page.id, ink: [], scraps: [], texts: [question] })).status,
      200,
    );
    await judgedAnswer();
    let run: any;
    await until(async () => (run = await h.claim('claude', { kind: 'chat' })), 'its quick run');
    await h.finish(run, { status, result: status === 'done' ? response : 'The worker could not answer.' });
    let texts: any[] = [];
    await until(
      async () => (texts = (await h.board(`/api/book/page?id=${page.id}`)).body.texts).length === 2,
      'the answer under the question',
    );
    if (status === 'done') assert.equal(texts[1].text, response);
    else assert.equal(texts[1].text, "I couldn't answer that. Ask again.", 'the page says why no answer came');
    const landed = db.prepare('select typed from book_typed_asks where job = ?').get(run.id) as {
      typed: string | null;
    };
    assert.equal(!!landed.typed, status === 'done', 'only an answer counts as landing');
  }
});
