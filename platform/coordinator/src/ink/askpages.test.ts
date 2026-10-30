// node --test src/ink/askpages.test.ts   (a design ask: hq ask --book through the real hq makes the desk-phone card and
// its scrap on the Asks page of the project's book, one answer closing both; the CEO's project books with their counts;
// keys, steps and money refused in the book.)
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { harness, type Running } from '../harness.ts';

const h = await harness('askpages');
const { db } = h;
const { currentPage } = await import('../notebook.ts');
const guestbooks = await import('../notebookguests.ts');
afterEach(() => h.cancelQueued());

db.prepare(
  "insert into projects (id, name, owner, created, by) values ('rocketlings', 'Rocketlings', 'lark', '2026-10-30', 'juno')",
).run();
db.prepare(
  "insert into projects (id, name, owner, created, by) values ('carrel', 'Carrel', 'lark', '2026-10-30', 'juno')",
).run();

const CARD = `The launch button reads as an ad. Which way?

Choose:
- Smaller, in the corner
- Same size, quieter colour`;
// hq ask as the agent types it: the request's number and hq's words, or hq's whole output when nothing was filed
async function ask(job: Running, body: string, ...flags: string[]) {
  const file = `${mkdtempSync(`${tmpdir()}/askpages-`)}/card.md`;
  writeFileSync(file, body);
  const kind = flags[0] === '--kind' ? flags[1] : 'decision';
  const rest = flags[0] === '--kind' ? flags.slice(2) : flags;
  const { code, out } = await h.hq(
    job,
    'ask',
    kind,
    'today',
    'Launch button: which way?',
    file,
    '--topic',
    'rocketlings',
    ...rest,
  );
  const id = out.match(/Request #(\d+)/)?.[1];
  return code === 0 && id ? { id: Number(id), out } : out;
}
const shelf = async () => (await h.board('/api/notebooks')).body.shelf as any[];
const groupsOn = async (page: number) =>
  (await h.board(`/api/notebooks/pages/groups?page=${page}`)).body.groups as any[];
const asksPageOf = (notebook: number) =>
  (db.prepare("select id from book_pages where notebook = ? and kind = 'asks'").get(notebook) as { id: number }).id;

test('only the CEO makes a project book, one per project, named for it; again, it keeps the one', async () => {
  const lark = await h.start({ agent: 'lark' });
  assert.match((await h.hq(lark, 'projectbook', 'rocketlings')).out, /Only the CEO/);
  const juno = await h.start({ agent: 'juno' });
  const made = await h.hq(juno, 'projectbook', 'rocketlings');
  assert.equal(made.code, 0, made.out);
  assert.match(made.out, /Made Rocketlings, the book of rocketlings/);
  assert.match((await h.hq(juno, 'projectbook', 'rocketlings')).out, /Kept Rocketlings/);
  assert.match((await h.hq(juno, 'projectbook', 'nowhere')).out, /no project "nowhere"/);
  const books = (await shelf()).filter(n => n.kind === 'project');
  assert.deepEqual(
    books.map(n => [n.name, n.project, n.asks]),
    [['Rocketlings', 'rocketlings', { open: 0, all: 0 }]],
  );
  await h.finish(lark);
  await h.finish(juno);
});

test('hq ask --book <project> files the card and its scrap on the book’s Asks page; one answer closes both', async () => {
  const juno = await h.start({ agent: 'juno' });
  await h.hq(juno, 'projectbook', 'rocketlings');
  await h.finish(juno);
  const lark = await h.start({ agent: 'lark' });
  const asked = await ask(lark, CARD, '--book', 'rocketlings');
  assert.equal(typeof asked, 'object', String(asked));
  const { id, out } = asked as { id: number; out: string };
  assert.match(out, /a scrap on the Asks page of Rocketlings in the board's book/);
  const book = (await shelf()).find(n => n.project === 'rocketlings');
  assert.deepEqual(book.asks, { open: 1, all: 1 }, 'the cover counts it, red');
  const page = asksPageOf(book.id);
  const [scrap] = await groupsOn(page);
  assert.equal(scrap.by, 'lark');
  assert.deepEqual(
    scrap.asks.map((a: any) => [a.id, a.status, a.name]),
    [[id, 'open', 'Lark']],
  );
  assert.match(scrap.texts.map((t: any) => t.text).join(' '), /Launch button: which way\?/);
  // (the board's own new scraps never land on the Asks page)
  assert.notEqual(currentPage(book.id), page);
  // answered in the book (the desk phone's own route): the card is answered, the scrap shows it, the count goes grey
  assert.equal((await h.board('/api/requests/answer', { id, answer: 'Smaller, in the corner' })).status, 200);
  const [after] = (await groupsOn(page)).filter(g => g.id === scrap.id);
  assert.deepEqual([after.asks[0].status, after.asks[0].answer], ['answered', 'Smaller, in the corner']);
  assert.deepEqual((await shelf()).find(n => n.id === book.id).asks, { open: 0, all: 1 });
  await h.finish(lark);
});

test('a card withdrawn takes its scrap; a project with no book, or journal, lands in My journal', async () => {
  const lark = await h.start({ agent: 'lark' });
  const asked = (await ask(lark, CARD, '--book', 'carrel')) as { id: number; out: string };
  assert.match(asked.out, /carrel has no book yet/);
  const mine = (await shelf()).find(n => n.kind === 'mine');
  const page = asksPageOf(mine.id);
  assert.ok((await groupsOn(page)).some(g => g.asks.some((a: any) => a.id === asked.id)));
  assert.equal((await h.hq(lark, 'close', String(asked.id))).code, 0);
  assert.ok(!(await groupsOn(page)).some(g => g.asks.some((a: any) => a.id === asked.id)), 'gone with its card');
  assert.equal((await shelf()).find(n => n.id === mine.id).asks.open, 0);
  const journal = await ask(lark, CARD, '--book', 'journal');
  assert.equal(typeof journal, 'object', String(journal));
  assert.equal(asksPageOf(mine.id), page, 'the same Asks page');
  await h.finish(lark);
});

test('the board deleting an ask’s scrap takes its card off the desk phone, for good', async () => {
  const lark = await h.start({ agent: 'lark' });
  const asked = (await ask(lark, CARD, '--book', 'journal')) as { id: number; out: string };
  const mine = (await shelf()).find(n => n.kind === 'mine');
  const page = asksPageOf(mine.id);
  const scrap = (await groupsOn(page)).find(g => g.asks.some((a: any) => a.id === asked.id));
  const open = (await shelf()).find(n => n.id === mine.id).asks.open;
  assert.equal((await h.board('/api/notebooks/groups/delete', { id: scrap.id })).status, 200);
  const card = (await h.board('/api/requests')).body.find((r: any) => r.id === asked.id);
  assert.equal(card, undefined, 'off the desk phone');
  assert.equal((await shelf()).find(n => n.id === mine.id).asks.open, open - 1);
  const undo = await h.board('/api/notebooks/groups/restore', { id: scrap.id });
  assert.deepEqual([undo.status, undo.body.reason], [409, 'askGone'], 'no Undo');
  assert.ok(!(await groupsOn(page)).some(g => g.id === scrap.id));
  await h.finish(lark);
});

test('an answered ask’s scrap deleted leaves its card as the board answered it, and Undo brings the scrap back', async () => {
  const lark = await h.start({ agent: 'lark' });
  const { id } = (await ask(lark, CARD, '--book', 'journal')) as { id: number };
  assert.equal((await h.board('/api/requests/answer', { id, answer: 'Keep it' })).status, 200);
  const page = asksPageOf((await shelf()).find(n => n.kind === 'mine').id);
  const scrap = (await groupsOn(page)).find(g => g.asks.some((a: any) => a.id === id));
  assert.equal((await h.board('/api/notebooks/groups/delete', { id: scrap.id })).status, 200);
  const filed = (await h.board('/api/requests/archive')).body.cards.find((r: any) => r.id === id);
  assert.deepEqual([filed.status, filed.answer, filed.closing], ['answered', 'Keep it', null], 'no line from HQ');
  assert.equal((await h.board('/api/notebooks/groups/restore', { id: scrap.id })).status, 200);
  const back = (await groupsOn(page)).find(g => g.id === scrap.id);
  assert.equal(back?.asks[0].answer, 'Keep it', 'back with its card under it');
  await h.finish(lark);
});

test('an ask goes to a guest: into their book by its number, its Share part for the board to forward', async () => {
  const invited = await h.board('/api/notebooks/guests', { people: [{ name: 'Nora', email: 'nora@example.org' }] });
  assert.equal(invited.status, 200, JSON.stringify(invited.body));
  const book = invited.body.notebook.id;
  const lark = await h.start({ agent: 'lark' });
  const asked = await ask(
    lark,
    `${CARD}\n\n---\n\nShare: Nora, which launch button reads less like an ad?`,
    '--book',
    String(book),
  );
  assert.equal(typeof asked, 'object', String(asked));
  const { id, out } = asked as { id: number; out: string };
  assert.match(out, /a scrap on the Asks page of Nora in the board's book/);
  const card = (await h.board('/api/requests')).body.find((r: any) => r.id === id);
  assert.equal(card.share, 'Nora, which launch button reads less like an ad?');
  const page = asksPageOf(book);
  const [scrap] = await groupsOn(page);
  assert.deepEqual(
    scrap.asks.map((a: any) => [a.id, a.status]),
    [[id, 'open']],
  );
  const guestRead = guestbooks.listNotebooks('Nora').notebooks.find(n => n.id === book)!;
  assert.ok(!guestRead.pages.some(p => p.id === page), 'the guest sees their own page, not the board’s Asks');
  assert.equal((await h.board('/api/requests/answer', { id, answer: 'Same size, quieter colour' })).status, 200);
  assert.equal((await groupsOn(page))[0].asks[0].status, 'answered');
  await h.finish(lark);
});

test('keys, steps, approvals and uploads are refused in the book, with why; a bad --book too', async () => {
  const lark = await h.start({ agent: 'lark' });
  const before = (db.prepare('select count(*) n from requests').get() as { n: number }).n;
  const key = await ask(lark, 'The shop needs its key.', '--kind', 'credential', 'SHOP_KEY', '--book', 'rocketlings');
  assert.equal(typeof key, 'string');
  assert.match(String(key), /A card for keys or a login stays on the desk phone only/);
  const steps = await ask(
    lark,
    'Open the store.\n\nSteps:\n1. Sign in to the console\n2. Press Publish',
    '--book',
    'rocketlings',
  );
  assert.match(String(steps), /steps the board takes in another system stays on the desk phone only/);
  const photo = await ask(lark, CARD, '--photo', 'The box', '--book', 'rocketlings');
  assert.match(String(photo), /uploads stays on the desk phone only/);
  assert.match(String(await ask(lark, CARD, '--book', 'nowhere')), /--book is a project or journal/);
  assert.equal((db.prepare('select count(*) n from requests').get() as { n: number }).n, before, 'nothing filed');
  await h.finish(lark);
});
