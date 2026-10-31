// node --test src/notebookguestshelf.test.ts   (Ink 1.1's guests: a lasting guest and a week's review round, invited
// from the work, each with one link to their shelf of project books; the asks for them counted red until they write on
// one; a round's access ending after its week.)
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';
import { fakeLettermint } from './fixture.ts';

const lettermint = await fakeLettermint();
const h = await harness('guestshelf', { env: { CADDY_HOST: '127.0.0.1', PUBLIC_HOST: 'hq.company.test' } });
const { db } = h;
lettermint.on();
const { ORIGIN } = await import('./config.ts');
const { currentPage, mine } = await import('./notebook.ts');
const shares = await import('./shares.ts');
const { endDue } = await import('./feedback.ts');
const { timeZone } = await import('./company.ts');
afterEach(() => h.cancelQueued());

const HELLO = 'hello.preview.company.test'; // (the fixture's product)
const api = '/guest/notebooks/api';
let clients = 0;

// The board's Share on the work: a lasting guest's or a week's round, as the box sends it
const share = async (name: string, email: string, lasting: boolean, page = `https://${HELLO}/`) => {
  const made = await h.board('/api/review/shares', { page, name, email, ...(lasting ? { lasting } : { days: 7 }) });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  return made.body;
};
// Their one link, followed once: the code by email, then their session; its Open leads to their shelf
async function signIn(link: string) {
  const door = new URL(link).pathname,
    from = `192.0.2.${++clients}`;
  const form = (path: string, fields: Record<string, string>) =>
    fetch(h.base + path, {
      method: 'POST',
      redirect: 'manual',
      body: new URLSearchParams(fields),
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': from },
    });
  assert.equal((await form(`${door}/send`, {})).status, 200);
  const code = /(\d{6})/.exec(lettermint.taken.at(-1)!.text)![1];
  const cookie = (await form(`${door}/verify`, { code })).headers.get('set-cookie')!.split(';')[0];
  const go = await fetch(`${h.base}${door}/go`, { headers: { cookie }, redirect: 'manual' });
  const read = async (path: string) =>
    (await fetch(h.base + path, { headers: { cookie }, redirect: 'manual' })) as Response;
  return { cookie, go: go.headers.get('location'), read, shelf: async () => (await read(`${api}/shelf`)).json() };
}
const shelfOf = (row: any, name: string) => row.people.find((p: any) => p.name === name).shelf;
const typed = (text: string) => [{ x: 40, y: 40, w: 500, text, color: '#292722' }];

test('a lasting guest and a round guest each come in by one link to a shelf of project books', async () => {
  const lasting = await share('Sam de Vries', 'sam@example.org', true);
  assert.equal(lasting.lasting, true);
  const row = shares.byId(lasting.id)!;
  assert.equal(row.ends, shares.LASTING_ENDS, 'a lasting share never ends by date');
  const sam = lasting.people[0];
  assert.match(sam.shelf, /\/guest\/[A-Za-z0-9_-]{43}$/);

  // the same link on every share they're on: a round on the same work adds a second piece to the same book
  const round = await share('Sam de Vries', 'sam@example.org', false, `https://${HELLO}/basket`);
  assert.equal(round.lasting, false);
  assert.equal(round.people[0].shelf, sam.shelf, 'no new link each round');
  const days = (Date.parse(round.ends) - Date.now()) / 864e5;
  assert.ok(days > 6.9 && days <= 7, `a round is open a week, not ${days} days`);

  const guest = await signIn(sam.shelf);
  assert.equal(guest.go, '/guest/notebooks/', 'their link opens their shelf');
  const shelf = await guest.shelf();
  assert.equal(shelf.name, 'Sam de Vries');
  assert.equal(shelf.timeZone, timeZone(), "the guest's days are on the company's clock");
  assert.equal(shelf.books.length, 1, 'one book per project');
  const [book] = shelf.books;
  assert.equal(book.name, 'Hello (platform test)');
  assert.deepEqual(
    book.artifacts.map((a: any) => [a.lasting, a.ends === null]),
    [
      [true, true],
      [false, false],
    ],
  );
  // a lasting guest's work is an invited notebook, the round's a round, each with their own page
  const kinds = book.artifacts.map(
    (a: any) => (db.prepare('select kind from notebooks where id = ?').get(a.notebook) as { kind: string }).kind,
  );
  assert.deepEqual(kinds, ['invited', 'round']);
  assert.ok(shelf.journal.notebook, 'their own journal, for anything loose');

  // Open hands them their session on the work, by the guest desk's onward
  const open = await guest.read(book.artifacts[0].open);
  assert.equal(open.status, 302);
  assert.match(open.headers.get('location')!, new RegExp(`^https://${HELLO.replace(/\./g, '\\.')}/__preview\\?s=`));
});

test('an ask for a guest waits in red on their page and the book, until they write on it', async () => {
  const made = await share('Noor Jansen', 'noor@example.org', true);
  const guest = await signIn(shelfOf(made, 'Noor Jansen'));
  const scrap = await h.board('/api/notebooks/groups/create', {
    page: currentPage(mine().id),
    texts: typed('Bigger?'),
  });
  assert.equal(scrap.status, 200, JSON.stringify(scrap.body));
  const noor = (await h.board('/api/notebooks/people')).body.everyone.find((p: any) => p.name === 'Noor Jansen');
  const given = await h.board('/api/notebooks/groups/assign', { id: scrap.body.id, to: noor.to });
  assert.equal(given.status, 200, JSON.stringify(given.body));

  let shelf = await guest.shelf();
  const [work] = shelf.books[0].artifacts;
  assert.equal(work.asks, 1, 'on the work it lands on');
  assert.equal(shelf.books[0].asks, 1, 'counted on the cover');
  const groups = (await (await guest.read(`${api}/groups?page=${work.page}`)).json()).groups;
  const copy = groups.find((g: any) => g.forYou);
  assert.ok(copy, 'on their page on the work, marked for them');

  const written = await fetch(`${h.base}${api}/edit`, {
    method: 'POST',
    headers: { cookie: guest.cookie, origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ id: copy.id, since: copy.updated, texts: typed('Yes, twice') }),
  });
  assert.equal(written.status, 200, await written.text());
  shelf = await guest.shelf();
  assert.equal(shelf.books[0].asks, 0, 'answered: all read');
});

test('a round guest’s access ends after its week; a lasting guest’s stays', async () => {
  const round = await share('Kees Bakker', 'kees@example.org', false);
  await share('Kees Bakker', 'kees@example.org', true, `https://${HELLO}/about`);
  const guest = await signIn(shelfOf(round, 'Kees Bakker'));
  assert.equal((await guest.shelf()).books[0].artifacts.length, 2);

  db.prepare('update review_shares set ends = ? where id = ?').run(new Date(Date.now() - 1000).toISOString(), round.id);
  endDue();
  const [book] = (await guest.shelf()).books;
  assert.deepEqual(
    book.artifacts.map((a: any) => a.lasting),
    [true],
    'the week over, only the lasting work is left',
  );
});
