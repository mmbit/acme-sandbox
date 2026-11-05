// node --test src/callguests.test.ts (the harness: the real server, the board's session, a guest's door and the voice
// line). The board's guests on its live call: the call's QR code and its join page, each scan's pen on the call's page
// alone, and each mark heard by the call's agent with who drew it (callguests.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import sharp from 'sharp';
import { harness } from './harness.ts';

// (the privacy page a guest's call bar links: brand.yaml callsOut.privacy)
const PRIVACY = 'https://shop.example.test/privacy-nl.html#partner-calls';
const h = await harness('callguests', {
  env: { CADDY_HOST: '127.0.0.1' },
  before: repo => appendFileSync(`${repo}/company/brand.yaml`, `\ncallsOut:\n  privacy:\n    nl: ${PRIVACY}\n`),
});
const { ORIGIN } = await import('./config.ts');
const { onPublish } = await import('./events.ts');
const api = '/guest/notebooks/api';
const stroke = {
  color: '#292722',
  size: 4,
  points: [
    [10, 10, 0.5, 0],
    [60, 40, 0.5, 10],
  ],
};
const said = (r: { status: number; body: any }) => {
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};

// A device scanning the call's code: its own cookie jar, the join page, the name, and its requests with the session
function device() {
  let cookie = '';
  const as = async (to: string, body?: unknown, form?: string) => {
    const response = await fetch(new URL(to, h.base), {
      method: body === undefined && form === undefined ? 'GET' : 'POST',
      headers: {
        cookie,
        origin: ORIGIN,
        'content-type': form === undefined ? 'application/json' : 'application/x-www-form-urlencoded',
      },
      body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
      redirect: 'manual',
    });
    const set = response.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await response.text();
    let contents: any = text;
    try {
      contents = JSON.parse(text);
    } catch {
      // (a page, not JSON: its text)
    }
    return { status: response.status, body: contents, location: response.headers.get('location') };
  };
  // (the code's link, as the scan opens it on this server)
  const path = (link: string) => new URL(link).pathname;
  const join = async (link: string, name: string) => {
    const joined = await as(path(link), undefined, `name=${encodeURIComponent(name)}`);
    assert.equal(joined.status, 303, JSON.stringify(joined.body));
    return Number(new URL(joined.location!, ORIGIN).searchParams.get('notebook'));
  };
  return { as, path, join, cookie: () => cookie };
}

test('a scan of the call’s code joins its page with a pen of its own, and the agent hears who drew what', async () => {
  const { call, token } = await h.liveCall('juno');
  const page = said(await h.board('/api/notebooks/call', { call })).page.id as number;
  const { link } = said(await h.board('/api/calls/guest', { call, lang: 'nl' }));
  assert.match(link, /\/guest\/scan\/nl\/[\w-]{43}$/);
  // (the same code each time, for every device)
  assert.equal(said(await h.board('/api/calls/guest', { call, lang: 'nl' })).link, link);

  // Told first, in Dutch: an AI, a written record, never the sound; then a name, nothing else
  const ilse = device();
  const door = await ilse.as(ilse.path(link));
  assert.equal(door.status, 200);
  assert.match(
    door.body,
    /Juno is een AI-assistent\. We houden een geschreven verslag van dit gesprek bij, nooit het geluid\./,
  );
  assert.match(door.body, /<input name="name"/);
  assert.doesNotMatch(door.body.slice(door.body.indexOf('<main>')), /email|name="code"/i);
  // (a name without letters isn't one)
  assert.equal((await ilse.as(ilse.path(link), undefined, 'name=%20%20')).status, 400);
  const told: unknown[] = [];
  const deaf = onPublish(e => void (e.type === 'book' && e.text === 'guest' && told.push(e.guest)));
  const notebook = await ilse.join(link, 'Ilse');
  deaf();
  // (HQ's call screen hears of the join, and tells the line their name: callguest.js)
  assert.deepEqual(told, [{ call, name: 'Ilse' }]);
  // (again, the session goes straight back in)
  const back = await ilse.as(ilse.path(link));
  assert.equal(back.status, 303);
  assert.equal(Number(new URL(back.location!, ORIGIN).searchParams.get('notebook')), notebook);

  // The call's page alone, open to write on
  const listed = said(await ilse.as(`${api}/list?notebook=${notebook}`));
  assert.deepEqual(
    listed.notebooks.map((n: any) => [n.kind, n.pages.map((p: any) => [p.id, p.readonly])]),
    [['call', [[page, false]]]],
  );
  // (its room page, without a passkey to save; its shelf empty, and no journal made for it)
  const room = await ilse.as(`/guest/notebooks/?notebook=${notebook}`);
  assert.equal(room.status, 200);
  assert.doesNotMatch(room.body, /data-guest-passkey/);
  assert.deepEqual(said(await ilse.as(`${api}/shelf`)).books, []);
  assert.equal(said(await ilse.as(`${api}/list?notebook=${notebook}`)).notebooks.length, 1);
  // Nothing else of the board's book: another page of the same notebook, another notebook
  const other = said(await h.board('/api/notebooks/pages/create', { notebook })).id as number;
  assert.equal((await ilse.as(`${api}/pages/groups?page=${other}`)).status, 404);
  assert.equal((await ilse.as(`${api}/groups/create`, { page: other, ink: [stroke] })).status, 404);
  assert.equal((await ilse.as(`${api}/list?notebook=${notebook + 1000}`)).body.notebooks?.length ?? 0, 0);
  // ...and nothing of HQ: its API knows no such session
  assert.equal((await ilse.as('/api/notebooks/call', { call })).status, 401);
  assert.equal((await ilse.as(`/api/notebooks/pages/groups?page=${page}`)).status, 401);

  // Theirs and the board's on the page, each as its drawer
  const hers = said(await ilse.as(`${api}/groups/create`, { page, ink: [stroke] }));
  const boards = said(await h.board('/api/notebooks/groups/create', { page, ink: [stroke] }));
  const groups = said(await ilse.as(`${api}/pages/groups?page=${page}`)).groups as any[];
  assert.deepEqual(
    groups.map(g => [g.id, g.by]),
    [
      [hers.id, hers.by],
      [boards.id, 'board'],
    ],
  );
  assert.match(hers.by, /^guest:\d+$/);
  // (theirs to change, the board's not; a POST from another origin is refused)
  assert.equal((await ilse.as(`${api}/groups/delete`, { id: boards.id })).status, 404);
  assert.equal((await ilse.as(`${api}/groups/edit`, { id: boards.id, since: boards.updated, ink: [] })).status, 404);
  said(await ilse.as(`${api}/groups/edit`, { id: hers.id, since: hers.updated, ink: [stroke, stroke] }));
  const elsewhere = await fetch(h.base + `${api}/groups/create`, {
    method: 'POST',
    headers: { cookie: ilse.cookie(), origin: 'https://elsewhere.example', 'content-type': 'application/json' },
    body: JSON.stringify({ page, ink: [stroke] }),
  });
  assert.equal(elsewhere.status, 403);
  // A picture dropped on the call's page is kept for it and read back; not on another page
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#c33' } })
    .png()
    .toBuffer();
  const upload = (to: number) =>
    fetch(h.base + `${api}/pictures?page=${to}`, {
      method: 'POST',
      headers: { cookie: ilse.cookie(), origin: ORIGIN, 'content-type': 'image/png' },
      body: new Uint8Array(png),
    });
  assert.equal((await upload(other)).status, 404);
  const kept = await upload(page);
  const picture = (await kept.json()) as { file: string; url: string };
  assert.equal(kept.status, 200, JSON.stringify(picture));
  assert.equal((await ilse.as(picture.url)).status, 200);

  // The agent hears each with who drew it, and its picture; never its own
  const heard = said(await h.voice(`drawn?id=${hers.id}&call=${call}`));
  assert.deepEqual([heard.n, heard.who], [hers.id, 'Ilse']);
  assert.equal((await sharp(Buffer.from(heard.picture.data, 'base64')).metadata()).format, 'png');
  assert.equal(said(await h.voice(`drawn?id=${boards.id}&call=${call}`)).who, 'Board');
  // (and no tick on the page for it: the agent answers in its own notes and words.)
  const units = said(await h.board(`/api/notebooks/pages/groups?page=${page}`)).groups as any[];
  assert.equal(units.find(g => g.id === boards.id).seen, null);
  const own = said(await h.voice('mark', { call, mark: 'rect', box: { x: 10, y: 10, width: 50, height: 50 } }));
  assert.equal((await h.voice(`drawn?id=${own.id}&call=${call}`)).status, 404);

  // The call over, the page, its code and the session close to them
  said(await h.voice('call-end', { agent: 'juno', lines: ['Board: Zo dan.'], token }));
  for (const r of [
    await ilse.as(`${api}/groups/create`, { page, ink: [stroke] }),
    await ilse.as(`${api}/pages/groups?page=${page}`),
  ])
    assert.equal(r.status, 401);
  assert.equal((await ilse.as(ilse.path(link))).status, 404);
  assert.equal((await device().as(ilse.path(link), undefined, 'name=Ilse')).status, 404);
  assert.equal((await h.voice(`drawn?id=${hers.id}&call=${call}`)).status, 404);
});

test('each scan is someone new for this call: never an invited guest of that name, and two of one name told apart', async () => {
  // An invited Esmee of the guest desk, with an address and a notebook of her own
  said(await h.board('/api/notebooks/guests', { people: [{ name: 'Esmee', email: 'esmee@example.org' }] }));
  const { call } = await h.liveCall('juno');
  const page = said(await h.board('/api/notebooks/call', { call })).page.id as number;
  const { link } = said(await h.board('/api/calls/guest', { call, lang: 'en' }));
  const first = device(),
    second = device(),
    board = device();
  await first.join(link, 'Esmee');
  await second.join(link, 'esmee');
  // (the board's iPad is a pen like any other, never the board)
  await board.join(link, 'Board');
  const marks = [] as { by: string; id: number }[];
  for (const d of [first, second, board]) marks.push(said(await d.as(`${api}/groups/create`, { page, ink: [stroke] })));
  assert.equal(new Set(marks.map(m => m.by)).size, 3);
  assert.ok(marks.every(m => /^guest:\d+$/.test(m.by)));
  const who = [] as string[];
  for (const m of marks) who.push(said(await h.voice(`drawn?id=${m.id}&call=${call}`)).who);
  assert.deepEqual(who, ['Esmee', 'esmee 2', 'Board 2']);
  // The invited Esmee's notebooks aren't theirs: the shelf is empty, the rail of people with a book has her alone
  assert.deepEqual(said(await first.as(`${api}/shelf`)).books, []);
  const rail = said(await h.board('/api/book/people')) as { who: string; name: string }[];
  const invited = rail.find(p => p.name === 'Esmee')!.who;
  assert.ok(!marks.some(m => m.by === invited), 'never the invited Esmee’s pen');
  assert.deepEqual(
    rail.filter(p => /esmee|board/i.test(p.name)).map(p => p.name),
    ['Esmee'],
  );
});

test('a code opens only a live call of the board’s, and a forged or older call’s code opens nothing', async () => {
  assert.equal((await h.board('/api/calls/guest', { call: 999999, lang: 'en' })).status, 404);
  const first = await h.liveCall('juno');
  assert.equal((await h.board('/api/calls/guest', { call: first.call, lang: 'fr' })).status, 400);
  const { link } = said(await h.board('/api/calls/guest', { call: first.call, lang: 'en' }));
  const d = device();
  const forged = d.path(link).replace(/.$/, c => (c === 'A' ? 'B' : 'A'));
  assert.equal((await d.as(forged)).status, 404);
  assert.equal((await d.as(d.path(link).replace('/en/', '/nl/'))).status, 404);
  await d.join(link, 'Ilse');
  // A call that recorded nothing goes with its guests: the next call by its number opens to none of them
  said(await h.voice('call-end', { agent: 'juno', lines: [], token: first.token }));
  const next = await h.liveCall('juno');
  assert.equal(next.call, first.call, 'the forgotten call’s number comes back');
  const page = said(await h.board('/api/notebooks/call', { call: next.call })).page.id as number;
  assert.equal((await d.as(d.path(link))).status, 404);
  assert.equal((await d.as(`${api}/pages/groups?page=${page}`)).status, 401);
  assert.equal((await d.as(`${api}/groups/create`, { page, ink: [stroke] })).status, 401);
});

test('the board leaves its call to a guest: their device gets a one-time ticket, and the call’s tools reach no HQ', async () => {
  const { call, token } = await h.liveCall('juno');
  said(await h.board('/api/notebooks/call', { call }));
  const { link } = said(await h.board('/api/calls/guest', { call, lang: 'nl' }));
  const esmee = device(),
    stranger = device();
  const notebook = await esmee.join(link, 'Esmee');
  const room = async () => said(await esmee.as(`${api}/list?notebook=${notebook}`)).notebooks[0].call;
  // While the board is on: its own device carries the call, no ticket, the call's tools as ever
  assert.deepEqual(await room(), { agent: 'Juno', away: false, privacy: PRIVACY });
  assert.equal((await esmee.as('/guest/scan/voice', {})).status, 409);
  assert.equal((await h.agent('search?q=fotoboek', token)).status, 200);
  // The line's word that the board left (only with the call's own token)
  assert.equal((await h.voice('call-away', { agent: 'juno', token: 'not-the-call', away: true })).status, 404);
  said(await h.voice('call-away', { agent: 'juno', token, away: true }));
  assert.deepEqual(await room(), { agent: 'Juno', away: true, privacy: PRIVACY });
  // A guest is never the board: the call's token reaches nothing of HQ now, a read included
  for (const r of [await h.agent('search?q=fotoboek', token), await h.agent('job', token, { to: 'lark', title: 'x' })])
    assert.equal(r.status, 403, JSON.stringify(r.body));
  // Her session's ticket: once, for her, from HQ's own pages only; none for a device that never joined
  assert.equal((await stranger.as('/guest/scan/voice', {})).status, 409);
  const elsewhere = await fetch(h.base + '/guest/scan/voice', {
    method: 'POST',
    headers: { cookie: esmee.cookie(), origin: 'https://elsewhere.example' },
  });
  assert.equal(elsewhere.status, 403);
  const { ticket } = said(await esmee.as('/guest/scan/voice', {}));
  assert.deepEqual(said(await h.voice('guest-ticket', { ticket })), { call, name: 'Esmee', lang: 'nl' });
  assert.equal((await h.voice('guest-ticket', { ticket })).status, 404, 'good once');
  assert.equal((await h.voice('guest-ticket', { ticket: 'made-up' })).status, 404);
  // The board back: her tickets stop, the tools work again
  const late = said(await esmee.as('/guest/scan/voice', {})).ticket;
  said(await h.voice('call-away', { agent: 'juno', token, away: false }));
  assert.equal((await h.voice('guest-ticket', { ticket: late })).status, 404);
  assert.equal((await h.agent('search?q=fotoboek', token)).status, 200);
  assert.deepEqual(await room(), { agent: 'Juno', away: false, privacy: PRIVACY });
  // Left again and over: nothing for a call that has ended
  said(await h.voice('call-away', { agent: 'juno', token, away: true }));
  const over = said(await esmee.as('/guest/scan/voice', {})).ticket;
  said(await h.voice('call-end', { agent: 'juno', lines: ['Esmee: Doei.'], token }));
  assert.equal((await h.voice('guest-ticket', { ticket: over })).status, 404);
  assert.equal((await esmee.as('/guest/scan/voice', {})).status, 409);
});
