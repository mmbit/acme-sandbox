// node --test src/callguests.test.ts (the harness: the real server, the board's session, a guest's door and the voice
// line). The board's guests on its live call: the call's QR code and its join page, each scan's pen on the call's page
// alone, and each mark heard by the call's agent with who drew it (callguests.ts).
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import sharp from 'sharp';
import { harness } from './harness.ts';
import { playwright } from '../../../shared/browser/browser.mjs';

// (a screen's pictures are taken in the coordinator's Chromium: the push checks' is Playwright's)
process.env.CHROMIUM_PATH ??= process.env.BROWSER_HEADLESS_SHELL ?? playwright().chromium.executablePath();

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
  const join = async (link: string, name: string, screen = 'no') => {
    const joined = await as(path(link), undefined, `name=${encodeURIComponent(name)}&screen=${screen}`);
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
  // (nor the board's screens, as the screen tool takes them: watchturns.ts)
  const screens = [device(), device(), device()];
  await screens[0].join(link, "Board's screen");
  await screens[1].join(link, "The board's screen");
  await screens[2].join(link, "the board's screen 2");
  const marks = [] as { by: string; id: number }[];
  for (const d of [first, second, board, ...screens])
    marks.push(said(await d.as(`${api}/groups/create`, { page, ink: [stroke] })));
  assert.equal(new Set(marks.map(m => m.by)).size, 6);
  assert.ok(marks.every(m => /^guest:\d+$/.test(m.by)));
  const who = [] as string[];
  for (const m of marks) who.push(said(await h.voice(`drawn?id=${m.id}&call=${call}`)).who);
  assert.deepEqual(who, ['Esmee', 'esmee 2', 'Board 2', 'Guest', 'Guest 2', "the board's screen 2 2"]);
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

// ---- every screen on the call: a guest's room records itself for the call's agent, and the agent sees it
// with each turn under their name, beside the board's, with what their pen points at. Pictures need Chromium.
const WALK = JSON.parse(
  gunzipSync(readFileSync(new URL('../../../shared/watchalong/walk.test.json.gz', import.meta.url))).toString('utf8'),
) as { type: number; timestamp: number; data: Record<string, unknown> }[][];
const chromium = !!process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH);
const JPEG = (data: string) => Buffer.from(data, 'base64').subarray(0, 2).toString('hex') === 'ffd8';
// The walk's first batch as a page sends it now, and a pen's circle around a button on it
const walked = () => {
  const shift = Date.now() - WALK[0].at(-1)!.timestamp;
  return WALK[0].map(event => ({ ...event, timestamp: event.timestamp + shift }));
};
const circled = (label: string) => ({
  type: 5,
  timestamp: Date.now(),
  data: {
    tag: 'ink',
    payload: {
      phase: 'end',
      stroke: {
        points: [
          [100, 50],
          [150, 100],
          [100, 150],
          [50, 100],
          [98, 52],
        ],
      },
      under: [{ label, role: 'button' }],
    },
  },
});
const posted = async (events: string, batch: unknown[]) =>
  (
    await fetch(new URL(events, h.base), {
      method: 'POST',
      headers: { origin: ORIGIN },
      body: JSON.stringify({ events: batch }),
    })
  ).status;

test(
  'the agent sees every screen on the call, the board’s other one by its number, a guest’s with their name and what their pen points at, and nothing of those is kept',
  { timeout: 120_000 },
  async () => {
    // (HQ's other screens hear the call go live, and show themselves on it: boardscreen.js)
    const live: unknown[] = [];
    const deaf = onPublish(e => void (e.type === 'book' && e.text === 'call' && live.push(e.call)));
    const ctx = await h.liveCall('juno');
    deaf();
    const { call } = ctx;
    assert.deepEqual(live, [call]);
    said(await h.board('/api/notebooks/call', { call }));
    const { link } = said(await h.board('/api/calls/guest', { call, lang: 'en' }));
    const turn = (body: Record<string, unknown> = {}) =>
      h.voice('screen-turn', { purpose: 'call', ref: String(call), after: 0, seen: 0, briefed: false, ...body });
    assert.deepEqual((await turn()).body, { on: false });

    // Her join page says what the agent sees if she shows her screen, and asks: show it, or join without, alike (Enter in
    // her name chooses neither)
    const esmee = device();
    const door = await esmee.as(esmee.path(link));
    assert.match(
      door.body,
      /If you show your screen, Juno sees this call’s page and the prototypes you open on it live, never another tab or app or what you type\. The transcript notes what you open, where you scroll and tap, and that you type, never what\. Nothing else of it is kept\. Pause stops it at any time\./,
    );
    assert.match(
      door.body,
      /<button type="submit" hidden disabled aria-hidden="true"><\/button><button type="submit" name="screen" value="show">Join and show my screen<\/button><button type="submit" name="screen" value="no">Join without showing it<\/button>/,
    );
    // (in Dutch the same, with the privacy page linked where the brand has one for the language)
    const nl = said(await h.board('/api/calls/guest', { call, lang: 'nl' })).link;
    const lotte = device();
    const deur = (await lotte.as(lotte.path(nl))).body;
    assert.match(
      deur,
      /Het verslag noemt wat je opent, waar je scrolt en tikt, en dat je typt, maar nooit wat\. Verder wordt er niets van bewaard\. Met Pauze stopt het meteen\./,
    );
    assert.ok(
      deur.includes(`<a href="${PRIVACY}" target="_blank" rel="noopener noreferrer">Hoe we daarmee omgaan</a>`),
    );
    // (one who joins without: nothing of theirs is captured, and the agent sees no screen of theirs)
    const ilse = device();
    await ilse.join(link, 'Ilse');
    assert.equal((await ilse.as(`${api}/screen`, {})).status, 409);
    await esmee.join(link, 'Esmee', 'show');
    // Her room starts its screen: its page posts as any watch-along's, only that she typed kept
    const screen = said(await esmee.as(`${api}/screen`, {}));
    assert.match(screen.events, /^\/api\/watchalong\/events\?id=\d+&key=/);
    assert.equal(h.db.prepare('select typed from watchalong_sessions where id = ?').get(screen.id)!.typed, 'hidden');
    assert.equal(await posted(screen.events, [...walked(), circled('Palette')]), 200);
    await new Promise(resolve => setTimeout(resolve, 600)); // (the moments settle)

    // Her turn's lines come under her name, her pen's circle among them, with her screen's picture and the briefing
    const first = said(await turn());
    assert.equal(first.on, true);
    assert.equal(first.paused, false);
    assert.match(
      first.brief,
      /A guest in the room who joined the call from a device of their own shows you their screen too/,
    );
    const heading = first.lines.findIndex((l: string) => l.startsWith("Esmee's screen"));
    assert.ok(heading >= 0, first.lines.join('\n'));
    assert.ok(
      first.lines.some((l: string) => /circled "Palette" \(button\)/.test(l)),
      first.lines.join('\n'),
    );
    assert.deepEqual(Object.keys(first.last), [String(screen.id)]);
    if (chromium) {
      assert.equal(first.lines[heading], "Esmee's screen (its picture comes with this turn):");
      assert.equal(first.pictures.length, 1);
      assert.ok(JPEG(first.pictures[0].data));
    }
    // nothing new since: no lines, no picture, no briefing
    const again = said(await turn({ after: first.last, seen: first.version, briefed: true }));
    assert.deepEqual([again.lines, again.pictures, again.brief], [[], [], undefined]);

    // The board shows its screen too: both, each under whose it is, the board's first; the line's cursor from before a
    // guest's came (a number) is the board's
    const started = await h.board('/api/watchalong/start', { call, key: ctx.key });
    assert.equal(started.status, 200);
    {
      assert.equal(await posted(started.body.events, walked()), 200);
      await new Promise(resolve => setTimeout(resolve, 600));
      const both = said(await turn({ after: first.last, seen: first.version, briefed: true }));
      assert.equal(
        both.lines.findIndex((l: string) => l.startsWith("The board's screen")),
        0,
        both.lines.join('\n'),
      );
      assert.ok(!both.lines.some((l: string) => l.startsWith("Esmee's screen")), both.lines.join('\n'));
      if (chromium) assert.equal(both.pictures.length, 1);
    }

    // The board's iPad, another of its screens on the call, shows itself too: its own entry after the call's screen,
    // the board's screen 2, never a name. A reload goes on as the same screen.
    const ipad = said(await h.board('/api/watchalong/screens/start', { screen: 'board-ipad-1' }));
    assert.equal(ipad.call, call);
    assert.equal(ipad.agent, 'juno');
    assert.equal(await posted(ipad.events, [...walked(), circled('Flip me')]), 200);
    await new Promise(resolve => setTimeout(resolve, 600));
    {
      const all = said(await turn({ briefed: true }));
      const at = (heading: string) => all.lines.findIndex((l: string) => l.startsWith(heading));
      assert.equal(at("The board's screen"), 0, all.lines.join('\n'));
      assert.ok(at("The board's screen 2") > 0, all.lines.join('\n'));
      assert.ok(at("Esmee's screen") > at("The board's screen 2"), all.lines.join('\n'));
    }
    const reloaded = said(await h.board('/api/watchalong/screens/start', { screen: 'board-ipad-1' }));
    assert.equal(await posted(ipad.events, [circled('Late')]), 409);
    assert.equal(await posted(reloaded.events, [...walked(), circled('Flip me again')]), 200);
    await new Promise(resolve => setTimeout(resolve, 600));

    // The screen tool looks at hers by her name; another name says whose there are
    const tool = (body: Record<string, unknown>) => h.voice('screen', { purpose: 'call', ref: String(call), ...body });
    const since = said(await tool({ who: 'esmee', since: '-5m' }));
    assert.ok(
      since.lines.some((l: string) => /circled "Palette"/.test(l)),
      since.lines.join('\n'),
    );
    if (chromium) assert.ok(JPEG(said(await tool({ who: 'Esmee' })).picture.data));
    // ...and at the board's iPad by its number
    const second = said(await tool({ who: "the board's screen 2", since: '-5m' }));
    assert.ok(
      second.lines.some((l: string) => /circled "Flip me again"/.test(l)),
      second.lines.join('\n'),
    );
    if (chromium) assert.ok(JPEG(said(await tool({ who: 'screen 2' })).picture.data));
    const nobody = await tool({ who: 'Ilse' });
    assert.equal(nobody.status, 404, 'Ilse joined without showing hers');
    assert.match(JSON.stringify(nobody.body), /the others shown are screen 2, Esmee/);
    // The board leaves the call to her: its iPad reaches her session no more, hers still does, until the board is back
    said(await h.voice('call-away', { agent: 'juno', token: ctx.token, away: true }));
    {
      const away = said(await turn({ briefed: true }));
      assert.ok(!away.lines.some((l: string) => l.startsWith("The board's screen 2")), away.lines.join('\n'));
      assert.ok(
        away.lines.some((l: string) => l.startsWith("Esmee's screen")),
        away.lines.join('\n'),
      );
      assert.equal((await tool({ who: 'screen 2' })).status, 404);
    }
    said(await h.voice('call-away', { agent: 'juno', token: ctx.token, away: false }));
    {
      const back = said(await turn({ briefed: true }));
      assert.ok(
        back.lines.some((l: string) => l.startsWith("The board's screen 2")),
        back.lines.join('\n'),
      );
    }

    // The iPad goes quiet (closed, asleep, or ringing the call itself: boardscreen.js): its page posts nothing for
    // watchalong.ts QUIET_MS, and it leaves the agent's list, until it posts again
    mock.timers.enable({ apis: ['Date'], now: Date.now() + 21_000 });
    try {
      assert.equal(await posted(screen.events, [circled('Swatch')]), 200);
      const quiet = said(await turn({ briefed: true }));
      assert.ok(!quiet.lines.some((l: string) => l.startsWith("The board's screen 2")), quiet.lines.join('\n'));
      assert.equal((await tool({ who: 'screen 2' })).status, 404);
      assert.equal(said(await tool({ who: 'Esmee', since: '-5m' })).lines.length > 0, true);
      assert.equal(await posted(reloaded.events, []), 200);
      assert.equal(said(await tool({ who: 'screen 2', since: '-5m' })).lines.length > 0, true);
    } finally {
      mock.timers.reset();
    }

    // The call over: her screen and the board's iPad go, nothing of them kept to watch back
    said(await h.voice('call-end', { agent: 'juno', lines: ['Board: look'], token: ctx.token }));
    const kept = h.db.prepare(
      "select count(*) n from watchalong_sessions where purpose in ('callguest', 'callscreen')",
    );
    assert.equal(kept.get()!.n, 0);
    assert.equal(await posted(screen.events, [circled('Late')]), 404);
    assert.equal(await posted(reloaded.events, [circled('Late')]), 404);
    assert.notEqual((await esmee.as(`${api}/screen`, {})).status, 200);
    // (and it shows itself on no call it was on: an earlier test's call may still be live)
    assert.notEqual((await h.board('/api/watchalong/screens/start', { screen: 'board-ipad-1' })).body?.call, call);
    // ...nor on a call on the phone line, the newest live one, where nobody looks at a screen
    const phone = said(await h.voice('call-context', { agent: 'juno', lang: 'en', phone: true })).call;
    const onPhone = await h.board('/api/watchalong/screens/start', { screen: 'board-ipad-1' });
    assert.notEqual(onPhone.body?.call, phone, JSON.stringify(onPhone.body));
  },
);

// ---- a guest pauses their screen: as easy to withdraw as to give, and it holds through a reload or a
// scan again, until they show it again
test(
  'a guest pauses their screen: the agent sees nothing of it, through a scan again, until they show it again',
  {
    timeout: 120_000,
  },
  async () => {
    const ctx = await h.liveCall('juno');
    const { call } = ctx;
    said(await h.board('/api/notebooks/call', { call }));
    const { link } = said(await h.board('/api/calls/guest', { call, lang: 'en' }));
    const turn = (body: Record<string, unknown> = {}) =>
      h.voice('screen-turn', { purpose: 'call', ref: String(call), after: 0, seen: 0, briefed: true, ...body });
    const hers = (lines: string[]) => lines.filter(l => l.startsWith("Esmee's screen"));
    const esmee = device();
    await esmee.join(link, 'Esmee', 'show');
    const shown = said(await esmee.as(`${api}/screen`, {}));
    assert.equal(shown.paused, false);
    assert.equal(await posted(shown.events, walked()), 200);
    await new Promise(resolve => setTimeout(resolve, 600));
    const before = said(await turn());
    assert.equal(hers(before.lines).length, 1, before.lines.join('\n'));
    if (chromium) assert.equal(before.pictures.length, 1);

    // Her Pause: what was recorded ends, and the screen-turn brings nothing of hers, no picture, no lines
    assert.deepEqual(said(await esmee.as(`${api}/screen`, { paused: true })), { paused: true });
    assert.equal(await posted(shown.events, [circled('Late')]), 409);
    const paused = said(await turn());
    assert.deepEqual(paused, { on: false });
    const tool = await h.voice('screen', { purpose: 'call', ref: String(call), who: 'Esmee' });
    assert.equal(tool.status, 404);

    // Her room read again, or the code scanned again: still paused, nothing started
    const back = await esmee.as(esmee.path(link));
    assert.equal(back.status, 303);
    assert.deepEqual(said(await esmee.as(`${api}/screen`, {})), { paused: true });
    assert.equal(
      h.db.prepare("select count(*) n from watchalong_sessions where purpose = 'callguest' and ended is null").get()!.n,
      0,
    );
    assert.deepEqual(said(await turn()), { on: false });

    // Show again: a new recording, and the agent sees her screen again
    const again = said(await esmee.as(`${api}/screen`, { paused: false }));
    assert.equal(again.paused, false);
    assert.notEqual(again.id, shown.id);
    assert.equal(await posted(again.events, walked()), 200);
    await new Promise(resolve => setTimeout(resolve, 600));
    const resumed = said(await turn());
    assert.equal(hers(resumed.lines).length, 1, resumed.lines.join('\n'));
    if (chromium) assert.equal(resumed.pictures.length, 1);
    // (the call over: both her recordings go, as every guest's)
    said(await h.voice('call-end', { agent: 'juno', lines: ['Board: look'], token: ctx.token }));
    assert.equal(h.db.prepare("select count(*) n from watchalong_sessions where purpose = 'callguest'").get()!.n, 0);
  },
);
