// node --test src/callguests.test.ts (the harness: the real server, the board's session, a guest's door and the voice
// line). The board's guest on its live call: their door, their pen on the call's page alone, and each mark heard by the
// call's agent with who drew it (callguests.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { harness } from './harness.ts';

const h = await harness('callguests', { env: { CADDY_HOST: '127.0.0.1' } });
const { ORIGIN } = await import('./config.ts');
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

// The guest at their door, signed in with the emailed code, and their requests with the session
async function signIn(link: string) {
  const { g: cookie, path } = await h.guestIn(link, sent => /: (\d{6})/.exec(sent.text)![1]);
  const as = async (to: string, body?: unknown) => {
    const response = await fetch(h.base + to, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    const text = await response.text();
    let contents: any = text;
    try {
      contents = JSON.parse(text);
    } catch {
      // (a page, not JSON: its text)
    }
    return { status: response.status, body: contents, location: response.headers.get('location') };
  };
  return { as, path };
}

test('the guest joins the call’s page from their door, draws there as themselves, and the agent hears who drew what', async () => {
  const { call, token } = await h.liveCall('juno');
  const page = said(await h.board('/api/notebooks/call', { call })).page.id as number;
  const added = said(await h.board('/api/calls/guest', { call, name: 'Ilse', email: 'ilse@example.org', lang: 'nl' }));
  assert.match(added.link, /\/guest\//);
  // (asked again, the same door)
  assert.equal(
    said(await h.board('/api/calls/guest', { call, name: 'Ilse', email: 'ilse@example.org', lang: 'nl' })).link,
    added.link,
  );

  const ilse = await signIn(added.link);
  // Told first, in Dutch: an AI, a written record, never the sound
  const door = await ilse.as(ilse.path);
  assert.match(
    door.body,
    /Juno is een AI-assistent\. We houden een geschreven verslag van dit gesprek bij, nooit het geluid\./,
  );
  const go = await ilse.as(`${ilse.path}/go`);
  assert.equal(go.status, 302);
  const notebook = Number(new URL(go.location!, ORIGIN).searchParams.get('notebook'));

  // The call's page alone, open to write on
  const listed = said(await ilse.as(`${api}/list?notebook=${notebook}`));
  assert.deepEqual(
    listed.notebooks.map((n: any) => [n.kind, n.pages.map((p: any) => [p.id, p.readonly])]),
    [['call', [[page, false]]]],
  );
  // Nothing else of the board's book: another page of the same notebook
  const other = said(await h.board('/api/notebooks/pages/create', { notebook })).id as number;
  assert.equal((await ilse.as(`${api}/pages/groups?page=${other}`)).status, 404);
  assert.equal((await ilse.as(`${api}/groups/create`, { page: other, ink: [stroke] })).status, 404);

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
  // (theirs to change, the board's not)
  assert.equal((await ilse.as(`${api}/groups/delete`, { id: boards.id })).status, 404);
  assert.equal((await ilse.as(`${api}/groups/edit`, { id: boards.id, since: boards.updated, ink: [] })).status, 404);
  said(await ilse.as(`${api}/groups/edit`, { id: hers.id, since: hers.updated, ink: [stroke, stroke] }));

  // The agent hears each with who drew it, and its picture; never its own
  const heard = said(await h.voice(`drawn?id=${hers.id}&call=${call}`));
  assert.deepEqual([heard.n, heard.who], [hers.id, 'Ilse']);
  assert.equal((await sharp(Buffer.from(heard.picture.data, 'base64')).metadata()).format, 'png');
  assert.equal(said(await h.voice(`drawn?id=${boards.id}&call=${call}`)).who, 'Board');
  const own = said(await h.voice('mark', { call, mark: 'rect', box: { x: 10, y: 10, width: 50, height: 50 } }));
  assert.equal((await h.voice(`drawn?id=${own.id}&call=${call}`)).status, 404);

  // The call over, the page and its door close to them
  said(await h.voice('call-end', { agent: 'juno', lines: ['Board: Zo dan.'], token }));
  // (the room shut to them: they've no notebook of their own)
  for (const r of [
    await ilse.as(`${api}/groups/create`, { page, ink: [stroke] }),
    await ilse.as(`${api}/pages/groups?page=${page}`),
  ])
    assert.equal(r.status, 403);
  assert.equal((await ilse.as(`${ilse.path}/go`)).status, 404);
  assert.equal((await h.voice(`drawn?id=${hers.id}&call=${call}`)).status, 404);
});

test('a guest is added only to a live call of the board’s, with a name and an address', async () => {
  assert.equal(
    (await h.board('/api/calls/guest', { call: 999999, name: 'Ilse', email: 'ilse@example.org' })).status,
    404,
  );
  const { call } = await h.liveCall('juno');
  assert.equal((await h.board('/api/calls/guest', { call, name: 'Ilse', email: 'not an address' })).status, 400);
  assert.equal(
    (await h.board('/api/calls/guest', { call, name: 'Ilse', email: 'ilse@example.org', lang: 'fr' })).status,
    400,
  );
});

test('a call that recorded nothing goes with its guests: the next call by its number has none', async () => {
  const first = await h.liveCall('juno');
  said(await h.board('/api/notebooks/call', { call: first.call }));
  const added = said(
    await h.board('/api/calls/guest', { call: first.call, name: 'Esmee', email: 'esmee@example.org', lang: 'en' }),
  );
  const esmee = await signIn(added.link);
  assert.equal((await esmee.as(`${esmee.path}/go`)).status, 302);
  said(await h.voice('call-end', { agent: 'juno', lines: [], token: first.token }));

  const next = await h.liveCall('juno');
  assert.equal(next.call, first.call, 'the forgotten call’s number comes back');
  const page = said(await h.board('/api/notebooks/call', { call: next.call })).page.id as number;
  assert.equal((await esmee.as(`${esmee.path}/go`)).status, 404);
  assert.equal((await esmee.as(`${api}/pages/groups?page=${page}`)).status, 403);
  assert.equal((await esmee.as(`${api}/groups/create`, { page, ink: [stroke] })).status, 403);
});
