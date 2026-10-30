// node --test src/notebookguests.test.ts (real HTTP sessions, notebook storage, routing and the round's Advice job).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { harness } from './harness.ts';

const h = await harness('notebookguests', { env: { CADDY_HOST: '127.0.0.1' } });
const { ORIGIN, PREVIEW } = await import('./config.ts');
const rounds = await import('./notebookrounds.ts');
const guestbooks = await import('./notebookguests.ts');
const sheets = await import('./ink/booksheets.ts');
const { SEND_MS } = await import('./ink/booknotes.ts');
const api = '/guest/notebooks/api';
const stroke = {
  color: '#292722',
  size: 4,
  points: [
    [10, 10, 0.5, 0],
    [40, 40, 0.5, 10],
  ],
};
let clients = 0;

async function signIn(link: string) {
  const door = new URL(link).pathname;
  const from = `192.0.2.${++clients}`;
  const form = (path: string, fields: Record<string, string>) =>
    fetch(h.base + path, {
      method: 'POST',
      redirect: 'manual',
      body: new URLSearchParams(fields),
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': from },
    });
  const sent = await form(`${door}/send`, {});
  const code = /: (\d{6})/.exec(await sent.text())![1];
  const verified = await form(`${door}/verify`, { code });
  assert.equal(verified.status, 303);
  const cookie = verified.headers.get('set-cookie')!.split(';')[0];
  return async (path: string, body?: unknown, contentType = 'application/json') => {
    const response = await fetch(h.base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, origin: ORIGIN, 'content-type': contentType },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body),
    });
    const text = await response.text();
    let contents: any;
    try {
      contents = JSON.parse(text);
    } catch {
      contents = text;
    }
    return { status: response.status, body: contents };
  };
}

let reviewCount = 0;
const create = async (kind: string, names: string[], days = 7) => {
  if (kind === 'round' && days < 1) {
    return (
      guestbooks.createNotebook({
        kind,
        days,
        name: 'Expiring review',
        people: names.map(name => ({ name, email: `${name.toLowerCase()}@example.org` })),
      }) as any
    ).notebook;
  }
  if (kind === 'round') {
    const folder = `round-${++reviewCount}`;
    mkdirSync(join(h.repo, 'products/_cycles', folder), { recursive: true });
    let share;
    for (const name of names) {
      const created = await h.board('/api/review/shares', {
        ...(share ? { id: share.id } : { page: `https://cycles${PREVIEW}/${folder}/`, days: Math.max(1, days) }),
        name,
        email: `${name.toLowerCase()}@example.org`,
      });
      assert.equal(created.status, 200, JSON.stringify(created.body));
      share = created.body;
    }
    return (await h.board('/api/notebooks/guests/list')).body.notebooks.at(-1);
  }
  const created = await h.board('/api/notebooks/guests', {
    kind,
    days,
    name: `${kind} design review`,
    people: names.map(name => ({ name, email: `${name.toLowerCase()}@example.org` })),
  });
  assert.equal(created.status, 200);
  return created.body.notebook;
};
const note = (page: number, text: string) => ({ page, texts: [{ x: 40, y: 40, w: 500, text, color: '#292722' }] });

test('the guest invite makes one permanent named notebook and resolves a known person without an email', async () => {
  const guests = await import('./guests.ts');
  guests.invite('Nora', 'nora@example.org');
  const before = (await h.board('/api/notebooks')).body.shelf.length;
  const made = await h.board('/api/notebooks/guests', { people: [{ name: 'Nora' }], days: 1, colleagues: true });
  assert.equal(made.status, 200);
  const book = made.body.notebook;
  assert.equal(book.name, 'Nora');
  assert.ok((await h.board('/api/review/people')).body.some((person: any) => person.name === 'Nora'));
  assert.equal(book.kind, 'invited');
  assert.equal(book.ends, null);
  assert.equal(book.colleagues, false);
  assert.equal(book.people.length, 1);
  assert.equal((await h.board('/api/notebooks')).body.shelf.length, before + 1);
  const guest = await signIn(book.people[0].link);
  assert.equal((await guest(`${api}/list`)).status, 200);
  assert.equal(
    (await h.board('/api/notebooks/guests', { kind: 'round', name: 'Wrong door', people: [{ name: 'Nora' }] })).status,
    400,
  );
  assert.equal((await h.board('/api/notebooks/guests', { people: [{ name: 'Unknown' }] })).status, 400);
  assert.equal((await h.board('/api/notebooks/guests', { people: [{ name: 'Nora' }, { name: 'Ada' }] })).status, 400);
  await h.board('/api/notebooks/guests/revoke', { notebook: book.id });
  assert.equal((await guest(`${api}/list`)).status, 403);
});

test('the notebook door and room use the signed-in guest language', async () => {
  const guests = await import('./guests.ts');
  const job = await h.start({ agent: 'vera' });
  for (const [lang, name, intro, button, label, footer] of [
    ['en', 'Sana', 'Your own notebook', 'Open notebook', 'Your notebooks', 'Notes are answered by our AI team.'],
    [
      'nl',
      'Tara',
      'Je eigen notitieboek',
      'Notitieboek openen',
      'Je notitieboeken',
      'Ons AI-team beantwoordt je notities.',
    ],
    [
      'de',
      'Ulla',
      'Dein eigenes Notizbuch',
      'Notizbuch öffnen',
      'Deine Notizbücher',
      'Unser KI-Team beantwortet deine Notizen.',
    ],
  ]) {
    const written = guests.write(job, name, 'Earlier checklist', {
      lang,
      sections: [{ items: [{ kind: 'info', title: 'Welcome' }] }],
    });
    assert.ok(!Array.isArray(written));
    const book = await create('invited', [name]);
    const guest = await signIn(book.people[0].link);
    const door = await guest(new URL(book.people[0].link).pathname);
    assert.equal(door.status, 200);
    for (const words of [intro, button, label]) assert.ok(door.body.includes(words), words);
    const room = await guest('/guest/notebooks/');
    assert.equal(room.status, 200);
    assert.ok(room.body.includes(`<html lang="${lang}">`));
    assert.ok(room.body.includes(`<title>${label}</title>`));
    assert.ok(room.body.includes(footer));
  }
  await h.finish(job);
});

test('notebook room refusals identify their reason for every guest language', async context => {
  const guests = await import('./guests.ts');
  const job = await h.start({ agent: 'vera' });
  for (const [lang, name] of [
    ['en', 'Vera'],
    ['nl', 'Wera'],
    ['de', 'Xena'],
  ]) {
    const written = guests.write(job, name, 'Earlier checklist', {
      lang,
      sections: [{ items: [{ kind: 'info', title: 'Welcome' }] }],
    });
    assert.ok(!Array.isArray(written));
    const created = {
      body: guestbooks.createNotebook({
        kind: 'round',
        name: 'Colleague review',
        colleagues: true,
        people: [{ name, email: `${name.toLowerCase()}@studio.example` }],
      }) as any,
    };
    const book = created.body.notebook;
    const guest = await signIn(book.people[0].link);
    const page = book.pages[0].id;
    const refused = async (action: string, body: unknown, status: number, reason: string) => {
      const response = await guest(`${api}/${action}`, body);
      assert.equal(response.status, status);
      assert.equal(response.body.reason, reason, `${lang}: ${action}`);
    };
    await refused('invite', { notebook: book.id, name: 'Yara', email: 'yara@gmail.com' }, 400, 'inviteDomain');
    await refused(
      'invite',
      { notebook: book.id, name, email: `${name.toLowerCase()}@studio.example` },
      409,
      'inviteAlready',
    );
    await refused('invite', { notebook: book.id, name: 'lowercase', email: 'new@studio.example' }, 400, 'inviteName');
    await refused('pages/create', { notebook: book.id }, 409, 'roundPage');
    await refused('send', { id: page }, 409, 'pageEmpty');
    await refused('undo', { id: page }, 409, 'pageNotSent');
    await refused('create', note(-1, 'No page'), 404, 'unavailable');
    for (const colleague of ['Yara', 'Zara', 'Zora']) {
      assert.equal(
        (
          await guest(`${api}/invite`, {
            notebook: book.id,
            name: `${colleague} ${name}`,
            email: `${colleague}.${name}@studio.example`,
          })
        ).status,
        200,
      );
    }
    await refused(
      'invite',
      { notebook: book.id, name: 'Extra', email: 'extra@studio.example' },
      403,
      'inviteUnavailable',
    );
    await refused('create', note(page, 'x'.repeat(2001)), 400, 'noteLong');
    const saved = await guest(`${api}/create`, note(page, 'Keep this note'));
    await refused('edit', { id: saved.body.id, since: 'old', texts: note(page, 'Changed').texts }, 409, 'noteChanged');
    await refused('edit', { id: saved.body.id, since: saved.body.updated, texts: [] }, 400, 'noteDelete');
    await guest(`${api}/send`, { id: page });
    const group = (await guest(`${api}/groups?page=${page}`)).body.groups[0];
    await refused('restore', { id: group.id }, 409, 'roundRestore');
    for (const person of (
      await h.board(`/api/notebooks/guests/list?notebook=${book.id}`)
    ).body.notebooks[0].people.slice(1)) {
      guestbooks.revokeNotebook({ notebook: book.id, guest: person.name });
    }
    assert.equal((await h.board('/api/notebooks/round/close', { id: book.id, anyway: true })).status, 200);
    await refused('undo', { id: page }, 409, 'roundClosed');
    context.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    context.mock.timers.tick(366 * 86400_000);
    await refused('create', note(page, 'Session expired'), 401, 'signIn');
    context.mock.timers.reset();
  }
  await h.finish(job);
});

test('Reviews makes one round on the shelf, while view-only shares make none and removal closes notebook access', async () => {
  const round = await create('round', ['Oona', 'Petra']);
  const shelf = (await h.board('/api/notebooks')).body.shelf;
  assert.equal(shelf.filter((book: any) => book.id === round.id).length, 1);
  assert.equal(round.people.length, 2);
  const shares = (await h.board('/api/review/shares')).body;
  const share = shares.find((item: any) => item.people.some((person: any) => person.name === 'Oona'));
  const guest = await signIn(round.people[0].link);
  assert.equal((await h.board('/api/review/shares/remove', { id: share.id, name: 'Oona' })).status, 200);
  assert.equal((await guest(`${api}/groups?page=${round.people[0].page}`)).status, 403);
  await h.board('/api/review/shares/remove', { id: share.id, name: 'Petra' });
  assert.equal(
    (await h.board('/api/review/shares', { id: share.id, name: 'Oona', email: 'oona@corrected.example' })).status,
    200,
  );
  const corrected = (await h.board(`/api/notebooks/guests/list?notebook=${round.id}`)).body.notebooks[0];
  assert.equal(corrected.state, 'open');
  assert.equal(corrected.archived, false);
  const returning = await signIn(corrected.people.find((person: any) => person.name === 'Oona').link);
  assert.equal((await returning(`${api}/create`, note(round.people[0].page, 'A new review note'))).status, 200);
  await h.board('/api/review/shares/remove', { id: share.id, name: 'Oona' });
  assert.equal(
    (await h.board('/api/review/shares', { id: share.id, name: 'Oona', email: 'oona@other.example' })).status,
    409,
  );
  const before = (await h.board('/api/notebooks/guests/list')).body.notebooks.length;
  assert.equal(
    (
      await h.board('/api/review/shares', {
        page: `https://${share.host}${share.prefix}`,
        view: true,
        days: 3,
        name: 'Rosa',
        email: 'rosa@example.org',
      })
    ).status,
    200,
  );
  assert.equal((await h.board('/api/notebooks/guests/list')).body.notebooks.length, before);
  assert.equal((await h.board('/api/review/shares/end', { id: share.id })).status, 200);
  assert.ok((await h.board('/api/notebooks')).body.archive.some((book: any) => book.id === round.id));
});

test('two guest pages stay private and mark done or undo until the board closes; Lyra writes the Advice and it comes back to unwrap', async () => {
  const round = await create('round', ['Ada', 'Bela']);
  assert.equal(round.pages.length, 2);
  const ada = await signIn(round.people[0].link),
    bela = await signIn(round.people[1].link);
  const first = round.people[0].page,
    second = round.people[1].page;
  assert.deepEqual(
    (await ada(`${api}/list`)).body.notebooks[0].pages.map((p: any) => p.id),
    [first],
  );
  assert.equal((await ada(`${api}/groups?page=${second}`)).status, 404);
  assert.equal((await ada(`${api}/create`, note(second, 'Not mine'))).status, 404);
  assert.equal((await ada(`${api}/picture?id=${second}`)).status, 404);
  assert.equal((await fetch(h.base + `${api}/list`)).status, 401);
  assert.equal((await ada('/guest/notebooks/shell/ink/bookwrite.js')).status, 200);
  assert.equal((await ada('/__review/ink.js')).status, 200);
  const drawn = await ada(`${api}/create`, note(first, 'Make this clear'));
  assert.equal(drawn.status, 200);
  assert.equal((await h.board('/api/notebooks/groups/create', note(first, 'Board edit'))).status, 404);
  assert.equal((await ada(`${api}/send`, { id: first })).status, 200);
  sheets.deliverDue(Date.now() + SEND_MS);
  const groups = (await ada(`${api}/groups?page=${first}`)).body.groups;
  assert.equal(groups[0].status, 'sent');
  assert.ok(groups[0].owner_name);
  const dispatched = h.db
    .prepare(
      `select n.review, s.job from notebook_groups g join book_notes n on n.id = g.note
    join book_sheets s on s.id = n.sheet where g.id = ?`,
    )
    .get(drawn.body.id) as { review: number; job: number };
  const responder = await h.claimJob(dispatched.job);
  assert.equal(
    (await h.agent('answer', responder.token, { note: dispatched.review, text: 'I will make it clearer.' })).status,
    200,
  );
  await h.finish(responder);
  assert.equal((await ada(`${api}/undo`, { id: first })).status, 200);
  assert.equal(
    (
      await ada(`${api}/edit`, {
        id: drawn.body.id,
        since: drawn.body.updated,
        texts: note(first, 'Make this much clearer').texts,
      })
    ).status,
    200,
  );
  assert.equal(
    (await ada(`${api}/groups?page=${first}`)).body.groups[0].children.find((c: any) => c.kind === 'answer').text,
    'I will make it clearer.',
  );
  assert.equal((await ada(`${api}/send`, { id: first })).status, 200);
  await bela(`${api}/create`, note(second, 'Move the icon'));
  assert.equal((await bela(`${api}/send`, { id: second })).status, 200);
  // (every guest marked done: nothing closes but the board, and either may still undo)
  rounds.reconcileRound(round.id);
  assert.equal(rounds.roundOf(round.id)!.closed, null);
  assert.equal((await bela(`${api}/undo`, { id: second })).status, 200);
  await bela(`${api}/send`, { id: second });
  const shelf = (await h.board('/api/notebooks')).body.shelf.find((n: any) => n.id === round.id);
  assert.deepEqual(
    [shelf.round.state, shelf.round.guests.map((g: any) => [g.name, g.done, g.notes])],
    [
      'open',
      [
        ['Ada', true, 1],
        ['Bela', true, 1],
      ],
    ],
  );
  const pages = (await h.board(`/api/notebooks/pages?notebook=${round.id}`)).body.pages;
  assert.deepEqual(
    pages.map((p: any) => [p.chapter, p.guest, p.readonly]),
    [
      ['guests', 'Ada', true],
      ['guests', 'Bela', true],
    ],
  );
  // (the board's book reads a guest's page, as the watcher does, and never writes on it)
  assert.equal((await h.board(`/api/notebooks/pages/groups?page=${first}`)).body.groups[0].id, drawn.body.id);
  assert.equal((await h.board('/api/notebooks/round/unwrap', { id: round.id })).status, 409);
  const sent = await h.board('/api/notebooks/round/close', { id: round.id });
  assert.equal(sent.body.state, 'away');
  assert.equal((await h.board('/api/notebooks/round/close', { id: round.id })).status, 409);
  const closed = (await h.board(`/api/notebooks/guests/list?notebook=${round.id}`)).body.notebooks[0];
  assert.deepEqual([closed.state, closed.archived, closed.pages.length], ['closed', false, 2]);
  assert.equal((await bela(`${api}/undo`, { id: second })).status, 409);
  const advice = await h.claimJob(rounds.roundOf(round.id)!.advice!);
  assert.ok(advice.prompt.includes('I will make it clearer.'));
  assert.ok(advice.prompt.includes(`hq advice ${round.id}`));
  const read = await h.agent(`sketch?id=${first}`, advice.token);
  assert.equal(read.status, 200);
  assert.equal(read.body.from, 'Ada');
  assert.ok(read.body.picture.data);
  const saved = await h.hq({ ...advice, tmp: tmpdir() }, 'sketch', String(first));
  assert.equal(saved.code, 0, saved.out);
  // (nothing to hand back before a page is written)
  assert.equal((await h.agent('advice', advice.token, { notebook: round.id, back: true })).status, 409);
  const scrap = await h.hq(
    { ...advice, tmp: tmpdir() },
    'advice',
    String(round.id),
    '--page',
    'Checkout: one step less',
    'From four steps to two.',
  );
  assert.equal(scrap.code, 0, scrap.out);
  const back = await h.hq({ ...advice, tmp: tmpdir() }, 'advice', String(round.id), '--back');
  assert.equal(back.code, 0, back.out);
  assert.equal((await h.agent('advice', advice.token, { notebook: round.id, page: 'Late', text: 'x' })).status, 409);
  await h.finish(advice);
  const wrapped = (await h.board('/api/notebooks')).body.shelf.find((n: any) => n.id === round.id);
  assert.equal(wrapped.round.state, 'back');
  assert.equal((await h.board('/api/notebooks/round/unwrap', { id: round.id })).body.state, 'done');
  const chapters = (await h.board(`/api/notebooks/pages?notebook=${round.id}`)).body.pages;
  const page = chapters.find((p: any) => p.chapter === 'advice');
  assert.equal(page.title, 'Checkout: one step less');
  assert.equal((await h.board(`/api/notebooks/pages/groups?page=${page.id}`)).body.groups.length, 1);
});

test('a permanent invite sends pages and reads answers while the board watches, until revoked', async () => {
  const book = await create('invited', ['Cora']);
  const cora = await signIn(book.people[0].link);
  const page = book.pages[0].id;
  assert.equal(book.ends, null);
  assert.equal((await h.board(`/api/notebooks/pages?notebook=${book.id}`)).body.pages.length, 1);
  assert.equal((await h.board('/api/notebooks/pages/create', { notebook: book.id })).status, 403);
  const who = (await import('./notebookguests.ts')).whoOf((await import('./notebookguests.ts')).pageMember(page)!);
  // (the book's save, the only one now.)
  assert.equal((await h.board('/api/book/page/save', { id: page, who, ink: [] })).status, 403);
  const created = (await cora(`${api}/create`, note(page, 'Could this be simpler?'))).body;
  assert.equal((await cora(`${api}/send`, { id: page })).status, 200);
  sheets.deliverDue(Date.now() + SEND_MS);
  const sent = h.db
    .prepare(
      `select n.review, s.job from notebook_groups g join book_notes n on n.id = g.note
    join book_sheets s on s.id = n.sheet where g.id = ?`,
    )
    .get(created.id) as { review: number; job: number };
  const job = await h.claimJob(sent.job);
  const answered = await h.agent('answer', job.token, { note: sent.review, text: 'Yes, I can simplify it.' });
  assert.equal(answered.status, 200);
  await h.finish(job);
  const own = (await cora(`${api}/groups?page=${page}`)).body.groups[0];
  const watched = (await h.board(`/api/notebooks/guests/groups?page=${page}`)).body.groups[0];
  assert.equal(own.children[0].text, 'Yes, I can simplify it.');
  assert.deepEqual(own.children, watched.children);
  const listed = (await cora(`${api}/list`)).body.notebooks[0];
  assert.equal(listed.pages.length, 2);
  assert.equal((await cora(`${api}/create`, note(listed.pages[1].id, 'Another page'))).status, 200);
  assert.equal((await cora(`${api}/pages/create`, { notebook: book.id })).status, 200);
  const reply = guestbooks.act('reply', { answer: own.children[0].id, words: 'Late reply', ink: [stroke] }, 'Cora');
  guestbooks.revokeNotebook({ notebook: book.id });
  assert.equal(((await reply) as [number, string])[0], 403);
  assert.equal((await h.board(`/api/notebooks/guests/groups?page=${page}`)).body.groups[0].children.length, 1);
  assert.equal((await cora(`${api}/list`)).status, 403);
  assert.equal((await cora(`${api}/create`, note(page, 'Revoked'))).status, 403);
  assert.equal((await h.board(`/api/notebooks/guests/groups?page=${page}`)).status, 200);
});

test('colleague invitations require the board switch and company domain, and stop at three', async () => {
  const created = {
    body: guestbooks.createNotebook({
      kind: 'round',
      name: 'Company review',
      colleagues: true,
      people: [{ name: 'Dina', email: 'dina@studio.example' }],
    }) as any,
  };
  const book = created.body.notebook;
  const dina = await signIn(book.people[0].link);
  assert.deepEqual((await dina(`${api}/list`)).body.notebooks.at(-1).invites, { domain: 'studio.example', left: 3 });
  assert.equal(
    (await dina(`${api}/invite`, { notebook: book.id, name: 'Elena', email: 'elena@elsewhere.example' })).status,
    400,
  );
  for (const name of ['Elena', 'Fara', 'Gina']) {
    const invited = await dina(`${api}/invite`, {
      notebook: book.id,
      name,
      email: `${name.toLowerCase()}@studio.example`,
    });
    assert.equal(invited.status, 200);
    assert.ok(invited.body.person.link);
  }
  assert.equal(
    (await dina(`${api}/invite`, { notebook: book.id, name: 'Hana', email: 'hana@studio.example' })).status,
    403,
  );
  assert.equal((await h.board(`/api/notebooks/guests/list?notebook=${book.id}`)).body.notebooks[0].pages.length, 4);
});

test('revoking an invite during page rendering prevents sending, and removing a pending guest frees a round', async () => {
  const invited = await create('invited', ['Iris']);
  const iris = await signIn(invited.people[0].link);
  const page = invited.pages[0].id;
  await iris(`${api}/create`, { page, ink: [stroke] });
  const sending = guestbooks.act('send', { id: page }, 'Iris');
  guestbooks.revokeNotebook({ notebook: invited.id });
  assert.equal(((await sending) as [number, string])[0], 403);
  const watched = (await h.board(`/api/notebooks/guests/list?notebook=${invited.id}`)).body.notebooks[0];
  assert.equal(watched.pages.length, 1);
  assert.equal(watched.pages[0].sent, null);
  const round = await create('round', ['Jana', 'Kira']);
  const jana = await signIn(round.people[0].link);
  await jana(`${api}/create`, note(round.pages[0].id, 'Keep this note'));
  await jana(`${api}/send`, { id: round.pages[0].id });
  const revoked = await h.board('/api/notebooks/guests/revoke', { notebook: round.id, guest: 'Kira' });
  assert.equal(revoked.body.notebook.state, 'open');
  assert.equal((await h.board('/api/notebooks/round/close', { id: round.id })).status, 200);
  const completed = (await h.board(`/api/notebooks/guests/list?notebook=${round.id}`)).body.notebooks[0];
  assert.equal(completed.state, 'closed');
  assert.equal(completed.round.state, 'away');
  assert.equal((await h.board(`/api/notebooks/guests/groups?page=${round.pages[1].id}`)).status, 200);
});

for (const [state, name] of [
  ['open', 'Nora'],
  ['revoked', 'Orla'],
  ['expired', 'Petra'],
  ['closed', 'Rina'],
]) {
  test(`the retired Sketchbook cannot reach notebook pages while ${state}`, async context => {
    const kind = state === 'open' || state === 'revoked' ? 'invited' : 'round';
    const notebook = await create(kind, [name], 1 / 24);
    const guest = await signIn(notebook.people[0].link);
    const page = notebook.pages[0].id;
    assert.equal((await guest(`${api}/create`, note(page, 'Keep this notebook page'))).status, 200);
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#292722' } })
      .png()
      .toBuffer();
    const who = guestbooks.whoOf(guestbooks.pageMember(page)!);
    const uploaded = await h.send(
      `/api/book/scrap?id=${page}&who=${who}`,
      {
        cookie: h.boardCookie,
        origin: ORIGIN,
        'content-type': 'image/png',
      },
      png,
    );
    assert.equal(uploaded.status, 200);
    assert.equal((await guest(`${api}/picture?id=${page}`)).status, 200);
    assert.ok((await guest('/guest/sketchbook/api/create', { w: 800, h: 600 })).status >= 400);
    if (kind === 'invited') assert.equal((await guest(`${api}/pages/create`, { notebook: notebook.id })).status, 200);
    if (state === 'revoked') await h.board('/api/notebooks/guests/revoke', { notebook: notebook.id });
    if (state === 'expired') {
      context.mock.timers.enable({ apis: ['Date'], now: Date.now() });
      context.mock.timers.tick(2 * 3600_000);
    }
    if (state === 'closed') {
      assert.equal((await guest(`${api}/send`, { id: page })).status, 200);
      await assertOutsideSketchbook(guest, page, uploaded.json.file, png);
      assert.equal((await h.board('/api/notebooks/round/close', { id: notebook.id })).status, 200);
      assert.ok(rounds.roundOf(notebook.id)!.closed);
    }
    await assertOutsideSketchbook(guest, page, uploaded.json.file, png);
    // (no Sketchbook's shelf to look on, its routes gone.)
    assert.ok((await guest('/guest/sketchbook/api/list')).status >= 400);
  });
}

async function assertOutsideSketchbook(
  guest: Awaited<ReturnType<typeof signIn>>,
  page: number,
  file: string,
  png: Buffer,
) {
  const base = '/guest/sketchbook/api';
  const before = h.db.prepare('select * from book_pages where id = ?').get(page);
  const { scrapFiles } = await import('./pagescraps.ts');
  const files = scrapFiles(page);
  assert.ok((await guest(`${base}/list`)).status >= 400);
  for (const path of [`ink?id=${page}`, `picture?id=${page}`, `scrap?id=${page}&file=${file}`])
    assert.ok((await guest(`${base}/${path}`)).status >= 400, path);
  assert.ok((await guest(`${base}/scrap?id=${page}`, png, 'image/png')).status >= 400);
  for (const [action, fields] of Object.entries({
    save: { ink: [stroke], scraps: [] },
    label: { label: 'Rewrite this' },
    archive: { archived: true },
    send: {},
    delete: {},
  }))
    assert.ok((await guest(`${base}/${action}`, { id: page, ...fields })).status >= 400, action);
  assert.deepEqual(h.db.prepare('select * from book_pages where id = ?').get(page), before);
  assert.deepEqual(scrapFiles(page), files);
}
