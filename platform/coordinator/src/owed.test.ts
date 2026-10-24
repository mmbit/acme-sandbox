// node --test src/owed.test.ts   (the harness's test company; products hello (Bolt's) and yarn (Wren's))
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { harness, type Running } from './harness.ts';

const h = await harness('owed', { before: repo => {
  mkdirSync(`${repo}/products/yarn`);
  writeFileSync(`${repo}/products/yarn/product.yaml`, 'name: Yarn\nstatus: preview\nowner: wren\n');
} });
const { repo, db, agent } = h;
const owed = await import('./owed.ts');
const feedback = await import('./feedback.ts');
const { routed } = await (await import('./routing.fixture.ts')).routingFixture();

// Each case starts with nothing owed and no job open: no route clears a whole company's work
beforeEach(() => db.exec("update owed set closed = 'test' where closed is null; update jobs set status = 'done' where status != 'done'"));

// A job as HQ lists it, and the brief a job runs with (read in the table: a job waiting its turn has no caller yet)
const job = (id: number) => h.job(id);
const brief = (id: number) => (db.prepare('select prompt from jobs where id = ?').get(id) as { prompt: string }).prompt;
// A job HQ made, claimed by the worker (the harness's own run on engines of their own, so this one is next on its engine)
const run = async (id: number) => { const j = await h.claim(job(id).engine); assert.equal(j?.id, id); return j!; };
const end = async (id: number, status = 'done') => h.finish(await run(id), { status });
// HQ's own job for a return waits for its sort (sorting.ts): its owner (the CEO: yarn is in no project) names it, and it
// may start.
const proposals = await import('./proposals.ts');
const { ceo } = await import('./company.ts');
function sort(id: number, title: string, code: string) {
  const { proposal } = db.prepare(`select s.proposal from sorts s join proposals p on p.id = s.proposal
    where s.job = ? and p.status = 'open'`).get(id) as { proposal: number };
  assert.equal(proposals.drop(proposal, { agent: ceo(), job: 0 }, 'not needed'), 'it brings a product back to the board, so it runs: give it its title (hq inbox accept)');
  assert.equal((proposals.accept(proposal, ceo(), { title, code }) as { job: number }).job, id);
  assert.equal(job(id).title, title);
}
// What's owed, as hq owed shows it (from a job of Penny's, who has nothing to do with it)
const open = async (slug: string) => ((await agent('owed', (await h.start({ agent: 'penny' })).token)).body as any[]).find(r => r.slug === slug && !r.closed);
const work = (agent: string) => h.start({ agent });
// hq ask: a card filed while the job goes on
// (a card that brings work back leads with pictures, or says there's nothing to see: card.js)
const NOTHING_TO_SEE = 'Back.\n\nNo pictures: the change is in what it says.';
const ask = async (from: Running, o: { products?: string[]; back?: string[]; title?: string } = {}) => {
  const r = await agent('request', from.token, { kind: 'decision', title: o.title ?? 'Card', body: NOTHING_TO_SEE, urgency: 'today', products: o.products, back: o.back });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.id as number;
};
const answer = async (card: number, text: string) => assert.equal((await h.answer(card, text)).status, 200);
const heardBy = (agent: string) => (h.jobs.listJobs() as any[]).find(j => j.agent === agent && j.title.startsWith('The board on:'));
const ownersOpen = (agent: string) => (h.jobs.listJobs() as any[]).filter(j => j.agent === agent && ['queued', 'running', 'blocked'].includes(j.status));
// The board's review notes on a product's preview (saved by the review overlay), sent from HQ and routed by the CEO's
// check to the product's owner (or to `to`): the job they went to
let note = 0;
const notes = async (slug: string, to?: string, thread?: string) => {
  const id = (feedback.saveNote(slug, `${slug}.preview.x`, { note: `note ${++note}` }) as { id: number }).id;
  return routed((await h.board('/api/review/send', { slug, ids: [id] })).body.job, to, thread).job;
};

test("the owner's task of notes holds the return, and a card answer before it starts joins it", async () => {
  const first = await notes('yarn');
  const asker = await work('juno');
  const card = await ask(asker, { products: ['yarn'] });
  await h.finish(asker);
  await answer(card, 'More changes');
  assert.equal(job(first).agent, 'wren');
  assert.match(brief(first), /note \d+[\s\S]*You own bringing Yarn[\s\S]*--back yarn[\s\S]*More changes/);
  assert.deepEqual(ownersOpen('wren').map(j => j.id), [first]);
  assert.equal((await open('yarn')).job, first);
});

test('later notes are tasks of their own, and the return follows them all: one job after the last, waiting for the rest', async () => {
  const first = await notes('yarn');
  const holder = await run(first);
  const next = await notes('yarn'), again = await notes('yarn');
  assert.deepEqual([job(next).agent, job(next).after, job(again).after], ['wren', null, null], "the CEO's tasks, no order of HQ's");
  assert.match(brief(next), /HQ brings Yarn back to the board once this work is done: a job of Wren's/);
  assert.doesNotMatch(brief(next), /You own bringing/);
  assert.equal((await open('yarn')).job, first, 'the first task still holds it');
  await h.finish(holder);
  await end(next);
  h.storedPr(8591, next, 'open');
  owed.sweep();
  assert.equal((await open('yarn')).job, first, 'nothing while a task with a piece is still on it');
  await end(again);
  h.storedPr(8592, again, 'open');
  owed.sweep();
  const back = (await open('yarn')).job;
  assert.deepEqual([job(back).agent, job(back).after], ['wren', first]);
  const waits = h.jobs.outstandingWaits(back);
  assert.deepEqual(waits.map(w => w.id), [next, again], 'and for the pull requests still to merge');
  assert.equal(job(back).title, 'Yarn back to the board');
  assert.match(brief(back), /You own bringing Yarn[\s\S]*Job #\d+ \(done\) had this[\s\S]*note \d+/);
});

test("a card answer joins a queued return's brief once", async () => {
  await end(await notes('yarn'));
  owed.sweep();
  const back = (await open('yarn')).job;
  const asker = await work('juno');
  const card = await ask(asker, { products: ['yarn'] });
  await h.finish(asker);
  await answer(card, 'Keep the bookmarks');
  assert.equal((await open('yarn')).job, back);
  assert.equal(brief(back).split('Keep the bookmarks').length - 1, 1);
});

test("a card answer while a colleague's task of notes is still open: the owner's return waits for it and its merge", async () => {
  const task = await notes('yarn', 'bolt');
  assert.equal(job(task).agent, 'bolt');
  const asker = await work('juno');
  const card = await ask(asker, { products: ['yarn'] });
  await h.finish(asker);
  await answer(card, 'Warmer colours');
  const back = (await open('yarn')).job;
  assert.notEqual(back, task);
  assert.equal(job(back).agent, 'wren');
  assert.deepEqual(h.jobs.outstandingWaits(back).map(w => w.id), [task], 'not before the task is done');
  await end(task);
  h.storedPr(8593, task, 'open');
  assert.deepEqual(h.jobs.outstandingWaits(back).map(w => w.id), [task], 'nor before its pull request merges');
});

test("a card answer joins the owner's own queued task that holds the return, which waits for a colleague's task of notes and its merge", async () => {
  const first = await notes('yarn');
  const task = await notes('yarn', 'bolt');
  const asker = await work('juno');
  const card = await ask(asker, { products: ['yarn'] });
  await h.finish(asker);
  await answer(card, 'Softer edges');
  assert.equal((await open('yarn')).job, first, 'the answer reuses the holder');
  assert.match(brief(first), /More feedback on Yarn[\s\S]*Softer edges/);
  assert.deepEqual(h.jobs.outstandingWaits(first).map(w => w.id), [task], 'not before the task is done');
  await end(task);
  h.storedPr(8594, task, 'open');
  assert.deepEqual(h.jobs.outstandingWaits(first).map(w => w.id), [task], 'nor before its pull request merges');
});

test("the asker hears a tagged card's answer and is told whose job brings the product back", async () => {
  const asker = await work('juno');
  const card = await ask(asker, { back: ['yarn', 'hello'] });
  await h.finish(asker);
  await answer(card, 'More changes: see the notes');
  const yarn = (await open('yarn')).job, hello = (await open('hello')).job;
  assert.equal(job(yarn).agent, 'wren');
  assert.equal(job(hello).agent, 'bolt');
  const heard = brief(heardBy('juno').id);
  assert.ok(heard.includes(`job #${yarn}`) && heard.includes(`job #${hello}`));
});

test("when the asker owns the product, the job that hears the answer holds the return: one job, not two", async () => {
  const asker = await work('wren');
  const card = await ask(asker, { products: ['yarn'] });
  await h.finish(asker);
  await answer(card, 'Add bookmarks');
  const held = (await open('yarn')).job;
  assert.deepEqual(ownersOpen('wren').map(j => j.id), [held]);
  assert.match(brief(held), /Add bookmarks/);
  assert.match(brief(held), /--back yarn/);
});

test("an answer to the owner's other card joins the job that holds the return, and that card's job is told which", async () => {
  const holder = await notes('yarn');
  await run(holder);
  const asker = await work('wren');
  const card = await ask(asker, { products: ['yarn'] });
  await h.finish(asker);
  await answer(card, 'Make it blue');
  const held = (await open('yarn')).job;
  assert.deepEqual([job(held).after, job(held).status], [holder, 'queued']);
  assert.match(brief(held), /Make it blue/);
  const heard = brief(heardBy('wren').id);
  assert.ok(heard.includes(`job #${held}`));
  assert.doesNotMatch(heard, /--back yarn/);
});

test('a --back card closes the return from the job that holds it, not from a colleague while that job is still on it', async () => {
  const holder = await run(await notes('yarn'));
  await ask(await work('juno'), { back: ['yarn'] });
  assert.ok(await open('yarn'), 'still open: Wren is working on it');
  await ask(holder, { back: ['yarn'] });
  assert.equal(await open('yarn'), undefined);
});

test("a card can't close what a job that hasn't run holds yet", async () => {
  const holder = await run(await notes('yarn'));
  await notes('yarn');
  await ask(holder, { back: ['yarn'] });
  assert.equal((await open('yarn')).job, holder.id, 'still open');
});

test('a job that ends with the return open gets a follow-up after it, a few times, then waits for the morning round', async () => {
  const holder = await notes('yarn');
  await end(holder);
  owed.sweep();   // (the minute's check, now)
  const follow = (await open('yarn')).job;
  assert.notEqual(follow, holder);
  assert.deepEqual([job(follow).agent, job(follow).after], ['wren', holder]);
  owed.sweep();
  assert.equal((await open('yarn')).job, follow, 'nothing more while the follow-up is queued');
  assert.equal(await h.claim(job(follow).engine), null, 'it waits for its sort');
  sort(follow, "Show the board Yarn's fixed thread colours", 'YARNBACK');
  await end(follow, 'failed'); owed.sweep();
  const last = (await open('yarn')).job;
  sort(last, "Show the board Yarn's fixed thread colours again", 'YARNMORE');
  await end(last); owed.sweep(); owed.sweep();
  const after = await open('yarn');
  assert.equal(after.job, last);
  assert.ok(after.stalled);
});

test('hq owed close: the owner, from the job that holds it, saying why', async () => {
  const holder = await run(await notes('yarn'));
  const close = async (from: Running, why: string) => (await agent('owed-close', from.token, { slug: 'yarn', why })).status;
  assert.equal(await close(await work('kit'), 'launched'), 403);
  assert.equal(await close(await work('wren'), 'launched'), 409);
  assert.equal(await close(holder, ' '), 400);
  assert.equal(await close(holder, 'the board launched it, '.repeat(20)), 400, 'past one line the board reads: refused, never cut');
  assert.equal(await close(holder, 'the board launched it'), 200);
  assert.equal(await open('yarn'), undefined);
});

test('a saved key the closer quotes is masked in the outcome every agent reads', async () => {
  const secrets = await import('./secrets.ts'), KEY = 'sk_live_' + 'R4'.repeat(20);
  secrets.saveSecrets(['STRIPE_LIVE_SECRET_KEY'], { STRIPE_LIVE_SECRET_KEY: KEY });
  const holder = await run(await notes('yarn'));
  assert.equal((await agent('owed-close', holder.token, { slug: 'yarn', why: `live with ${KEY}` })).status, 200);
  const listed = await h.hq(holder, 'owed');
  assert.match(listed.out, /live with \[STRIPE_LIVE_SECRET_KEY\]/);
  assert.ok(!listed.out.includes(KEY));
});

test('a card naming something that is no product, or asking for keys, is refused', async () => {
  const from = await work('wren');
  for (const card of [{ kind: 'decision', products: ['nope'] }, { kind: 'decision', back: ['../x'] },
    { kind: 'credential', secrets: 'PRINTAPI_TEST_KEY', products: ['yarn'] }, { kind: 'credential', products: ['yarn'] }])   // (its answer may be a key)
    assert.equal((await agent('request', from.token, { title: 't', body: 'b', urgency: 'today', ...card })).status, 400, JSON.stringify(card));
});

test("an agent's old review card without a pull request is heard by its asker", async () => {
  const asker = await work('wren');
  // (a review card of the old kind: no route files one any more)
  const card = Number(db.prepare("insert into requests (created, agent, job, kind, title, body) values (?, 'wren', ?, 'review', 'Good now?', 'b')")
    .run(new Date().toISOString(), asker.id).lastInsertRowid);
  await h.finish(asker);
  await answer(card, 'More changes');
  assert.match(brief(heardBy('wren').id), /More changes/);
});

// ---- found in review
test("a follow-up after a holder that never ran still carries the board's words", async () => {
  const asker = await work('juno');
  const card = await ask(asker, { products: ['yarn'] });
  await h.finish(asker);
  await answer(card, 'Make the cover teal');
  const held = (await open('yarn')).job;
  db.prepare("update jobs set status = 'cancelled' where id = ?").run(held);   // (a ledger cancel: its call's follow-up drops the item)
  owed.sweep();
  const follow = (await open('yarn')).job;
  assert.notEqual(follow, held);
  // wren can't read juno's card (hq history is the asker's own), and held's session never ran: the words exist only here
  assert.match(brief(follow), /Make the cover teal/);
});

test("an owner-asker's new job keeps the line about the products that went to other owners", async () => {
  const asker = await work('wren');
  const card = await ask(asker, { products: ['yarn', 'hello'] });
  await h.finish(asker);
  await answer(card, 'Both need a darker header');
  const heard = (await open('yarn')).job, hello = (await open('hello')).job;
  assert.equal(job(hello).agent, 'bolt');
  assert.ok(brief(heard).includes(`job #${hello}`));
});

test("an owner-asker that holds the return is told how it ends", async () => {
  const asker = await work('wren');
  const card = await h.park(asker, { kind: 'decision', body: NOTHING_TO_SEE, back: ['yarn'] });
  await answer(card, 'Good now');
  assert.equal((await open('yarn')).job, asker.id);
  assert.match((await run(asker.id)).note, /--back yarn|hq owed close yarn/);
});

test("an ended owner-asker's card heard by a colleague's job queued after it: one job of the owner's holds the return, and the colleague's names it", async () => {
  const asker = await work('bolt');
  const card = await ask(asker, { products: ['hello'] });
  const kit = (await agent('job', asker.token, { agent: 'kit', title: 'after the card', brief: 'x', afterRequest: card })).body.id;
  await h.finish(asker);
  await answer(card, 'Ship it');
  const held = (await open('hello')).job;
  assert.deepEqual(ownersOpen('bolt').map(j => j.id), [held]);
  assert.doesNotMatch(brief(kit), /You own/);
  assert.ok(brief(kit).includes(`(job #${held})`), 'the colleague reads which job brings it back');
});

test("an ended owner-asker's own job queued after its card holds the return, and every other waiting job names it", async () => {
  const asker = await work('bolt');
  const card = await ask(asker, { products: ['hello'] });
  const after = async (who: string) => (await agent('job', asker.token, { agent: who, title: 'after the card', brief: 'x', afterRequest: card })).body.id;
  const next = await after('bolt'), kit = await after('kit');
  await h.finish(asker);
  await answer(card, 'Ship it');
  assert.equal((await open('hello')).job, next);
  assert.deepEqual(ownersOpen('bolt').map(j => j.id), [next]);
  assert.doesNotMatch(brief(kit), /You own/);
  assert.ok(brief(kit).includes(`(job #${next})`));
});

test("a new product.yaml owner's card while the old owner's return is open: one job holds it, after the old one's", async () => {
  const file = `${repo}/products/yarn/product.yaml`;
  const holder = await notes('yarn');
  await end(holder);   // wren's return, its job ended (say its PR is in review)
  writeFileSync(file, 'name: Yarn\nstatus: preview\nowner: bolt\n');
  try {
    const asker = await work('bolt');
    const card = await ask(asker, { products: ['yarn'] });
    await h.finish(asker);
    await answer(card, 'Rounder corners');
    const held = (await open('yarn')).job;
    assert.deepEqual([job(held).agent, job(held).after], ['bolt', holder]);
    assert.match(brief(held), /note \d+[\s\S]*Rounder corners|Rounder corners[\s\S]*note \d+/);
    const heard = brief(heardBy('bolt').id);
    assert.ok(heard.includes(`job #${held}`));
    assert.doesNotMatch(heard, /--back yarn/);
  } finally { writeFileSync(file, 'name: Yarn\nstatus: preview\nowner: wren\n'); }
});

test("an owner parked on another card: the answer joins the job after it, and the job that hears it is told so", async () => {
  const holder = await run(await notes('yarn'));
  const card = await ask(holder, { products: ['yarn'] });
  await h.park(holder, { kind: 'decision', title: 'Another question' });
  await answer(card, 'Wider margins');
  const held = (await open('yarn')).job;
  assert.deepEqual([job(held).after, job(held).status], [holder.id, 'queued']);
  assert.match(brief(held), /Wider margins/);
  const heard = brief(heardBy('wren').id);
  assert.ok(heard.includes(`job #${held}`));
  assert.doesNotMatch(heard, /--back yarn/);
});

test("notes right after a --back card, while its job still runs, don't take the return from it", async () => {
  const holder = await run(await notes('yarn'));
  await ask(holder, { back: ['yarn'] });
  const task = await notes('yarn');
  assert.equal((await open('yarn')).job, null);
  assert.match(brief(task), /HQ brings Yarn back to the board once this work is done/);
});

test("a --back card taken off before the board saw it opens the return again", async () => {
  const holder = await run(await notes('yarn'));
  const card = await ask(holder, { back: ['yarn'] });
  assert.equal(await open('yarn'), undefined);
  assert.equal((await agent('request-close', holder.token, { id: card })).status, 200);
  assert.ok(await open('yarn'));
});

test("a --back card closed after a call about it: the return stays closed, no sweep job, the call's follow-up has it", async () => {
  const holder = await run(await notes('yarn'));
  const card = await ask(holder, { back: ['yarn'] });
  await h.finish(holder);
  assert.equal((await h.voice('call-end', { agent: 'wren', lines: ['Board: the yarn page, a few more changes.'], request: card })).status, 200);
  const { job: followUp } = db.prepare('select job from calls where request = ?').get(card) as { job: number };
  const follower = await run(followUp);
  assert.equal((await agent('request-close', follower.token, { id: card })).status, 200);
  owed.sweep();
  assert.equal(await open('yarn'), undefined);
  assert.deepEqual(ownersOpen('wren').map(j => j.id), [followUp]);
});

test("a --back card closed during a call that has no follow-up opens the return again", async () => {
  const holder = await run(await notes('yarn'));
  const card = await ask(holder, { back: ['yarn'] });
  const ctx = (await h.voice(`call-context?agent=wren&request=${card}`)).body;
  assert.equal((await agent('request-close', holder.token, { id: card })).status, 200);
  assert.ok(await open('yarn'));
  assert.equal((await h.voice('call-end', { agent: 'wren', lines: [], request: card, token: ctx.token })).status, 200);
  assert.ok(await open('yarn'));
});

test("a dropped product's return can still be closed once its folder is gone", async () => {
  mkdirSync(`${repo}/products/gone`);
  writeFileSync(`${repo}/products/gone/product.yaml`, 'name: Gone\nowner: wren\n');
  const holder = await run(await notes('gone'));
  rmSync(`${repo}/products/gone`, { recursive: true });
  assert.equal((await agent('owed-close', holder.token, { slug: 'gone', why: 'the board dropped it' })).status, 200);
});

// ---- found in the review panel's round
test("an owner's card answered after its job ended doesn't take the return from the job before it", async () => {
  const holder = await notes('yarn');
  await end(holder);   // its fix waits in a pull request; the minute's check hasn't run yet
  const asker = await work('wren');
  const card = await ask(asker, { products: ['yarn'] });
  await h.finish(asker);
  await answer(card, 'And a ribbon');
  const held = (await open('yarn')).job;
  assert.deepEqual([job(held).after, job(held).status], [holder, 'queued']);
  assert.match(brief(held), /note \d+/);
  assert.match(brief(held), /And a ribbon/);
});

test("a running asker that owns the product reads with the answer that its job brings it back", async () => {
  const asker = await work('wren');
  const card = await ask(asker, { products: ['yarn', 'hello'] });
  await answer(card, 'Rounder');
  assert.equal((await open('yarn')).job, asker.id);
  const read = (await agent('request-answer', asker.token, { id: card })).body.answer as string;
  assert.match(read, /^Rounder/);
  assert.match(read, /--back yarn/);
  assert.ok(read.includes(`job #${(await open('hello')).job}`));
});

test("the intercom's chat asker hears which job brings its product back, and holds nothing", async () => {
  writeFileSync(`${repo}/products/yarn/product.yaml`, 'name: Yarn\nstatus: preview\nowner: juno\n');
  try {
    const chat = await h.start({ agent: 'juno', kind: 'chat' });
    const card = await ask(chat, { products: ['yarn'] });
    await answer(card, 'Ship it');
    const held = (await open('yarn')).job;
    assert.notEqual(held, chat.id);
    assert.equal(job(held).agent, 'juno');
    // the turn ends, and the next one hears it
    await h.finish(chat);
    assert.ok((await run(chat.id)).note.includes(`job #${held}`));
  } finally { writeFileSync(`${repo}/products/yarn/product.yaml`, 'name: Yarn\nstatus: preview\nowner: wren\n'); }
});

// The board leaves its notes on the preview in review mode, and they queue their
// own job: that answer on a card that brings work back makes none, and only such a card takes it
test("a card that brings work back, answered with notes in review mode, closes and queues nothing; Good now is heard", async () => {
  const asker = await work('wren');
  const card = await ask(asker, { back: ['yarn'] });
  await h.finish(asker);
  const listed = (await h.board('/api/requests')).body as any[];
  assert.equal(listed.find(r => r.id === card).back, true);
  const jobs = () => (h.jobs.listJobs() as any[]).length;
  const before = jobs();
  assert.equal((await h.board('/api/requests/answer', { id: card, answer: '', review: true })).status, 200);
  assert.equal(jobs(), before, 'no job hears it');
  assert.equal(await open('yarn'), undefined, 'nothing owed');
  assert.match(String((db.prepare('select answer from requests where id = ?').get(card) as { answer: string }).answer), /notes on the preview/);
  const other = await ask(await work('juno'), { products: ['yarn'] });
  assert.equal((await h.board('/api/requests/answer', { id: other, answer: '', review: true })).status, 400);
  const again = await ask(await work('wren'), { back: ['yarn'] });
  await answer(again, 'Good now');
  assert.ok((await open('yarn')).job, "Good now reaches the owner's return");
});

test("a return holder before a colleague's notes task in its thread runs first and leaves the return open", async () => {
  const file = `${repo}/company/projects.yaml`, previous = readFileSync(file, 'utf8');
  const threadends = await import('./threadends.ts');
  try {
    writeFileSync(file, 'planning: threads\nprojects:\n  - { id: due, name: Due, owner: juno }\n');
    threadends.watch();
    const thread = h.dueThread();
    const first = await notes('yarn', 'wren', thread);
    const task = await notes('yarn', 'bolt', thread);
    assert.deepEqual(h.jobs.outstandingWaits(first), [], 'no merge wait back to the later task');
    assert.equal(job(task).ready, 0, 'the colleague waits for the holder in thread order');
    const holder = await run(first);
    await ask(holder, { back: ['yarn'] });
    assert.equal((await open('yarn')).job, first, 'the later task still owes its feedback');
    await h.finish(holder);
    owed.sweep();
    assert.equal((await open('yarn')).job, first, 'no return while the colleague is still on it');
    await end(task);
    h.storedPr(8647, task, 'open');
    owed.sweep();
    const back = (await open('yarn')).job;
    assert.notEqual(back, first);
    assert.deepEqual(h.jobs.outstandingWaits(back).map(w => w.id), [task], 'the later return waits for the colleague to merge');
    assert.match(brief(back), /note \d+/);
  } finally {
    writeFileSync(file, previous);
    threadends.watch();
  }
});
