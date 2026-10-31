// node --test src/ink/askspot.test.ts   (a design ask about one thing on a page: hq ask --book --at --spot's shot and
// anchor make the ask's scrap, the thing ringed in pencil and the shot cut round it; a spot without a book, without its
// element or with no picture refused, nothing filed.)
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { harness } from '../harness.ts';
import { pictureSize } from '../../../../shared/pictures/size.ts';

const h = await harness('askspot');
const { db } = h;
afterEach(() => h.cancelQueued());

// The job's shot as hq ask takes it: a 1280 × 800 screen at 1.5, scrolled 400 down, the headline in the middle
const VIEW = { w: 1280, h: 800, x: 0, y: 400, dpr: 1.5 },
  HEADLINE = { x: 400, y: 760, w: 480, h: 80 };
const shot = await sharp({ create: { width: 1920, height: 1200, channels: 3, background: '#f4efe6' } })
  .composite([
    { input: { create: { width: 720, height: 120, channels: 3, background: '#d8e95a' } }, left: 600, top: 540 },
  ])
  .jpeg({ quality: 85 })
  .toBuffer();
const spot = (more: Record<string, unknown> = {}) => ({
  snip: `data:image/jpeg;base64,${shot.toString('base64')}`,
  anchor: {
    v: 1,
    url: 'https://shop.preview.company.test/#hero',
    el: { selector: 'section.hero > h1', tag: 'h1', text: 'Made to last', box: HEADLINE },
    view: VIEW,
    ink: [],
  },
  ...more,
});
// hq ask's request as it reaches HQ (cards.ts readCard), with its spot
const card = (more: Record<string, unknown>) => ({
  ...{ kind: 'decision', urgency: 'today', title: 'Tagline OK?', body: 'The hero says Made to last. Keep it?' },
  ...{ secrets: '', topic: 'shop', book: 'journal', ...more },
});
const filed = () => (db.prepare('select count(*) n from requests').get() as { n: number }).n;
const asksPage = () => {
  const mine = (db.prepare("select id from notebooks where kind = 'mine'").get() as { id: number }).id;
  return (db.prepare("select id from book_pages where notebook = ? and kind = 'asks'").get(mine) as { id: number }).id;
};

test('an ask with a spot is a scrap of its shot, the thing ringed in pencil and the shot cut round it', async () => {
  const lark = await h.start({ agent: 'lark' });
  const asked = await h.agent('request', lark.token, card({ spot: spot() }));
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  const groups = (await h.board(`/api/notebooks/pages/groups?page=${asksPage()}`)).body.groups as any[];
  const scrap = groups.find(g => g.asks.some((a: any) => a.id === asked.body.id));
  assert.equal(scrap.kind, 'scrap');
  assert.equal(scrap.words, 'Tagline OK?');
  assert.equal(scrap.anchor.url, 'https://shop.preview.company.test/#hero');
  assert.equal(scrap.anchor.el.selector, 'section.hero > h1');
  // the ring kept as the anchor's ink, round the headline
  const [ring] = scrap.anchor.ink,
    xs = ring.points.map((p: number[]) => p[0]),
    ys = ring.points.map((p: number[]) => p[1]);
  assert.ok(Math.min(...xs) < HEADLINE.x && Math.max(...xs) > HEADLINE.x + HEADLINE.w, 'round it across');
  assert.ok(Math.min(...ys) < HEADLINE.y && Math.max(...ys) > HEADLINE.y + HEADLINE.h, 'and up and down');
  // the picture: the shot cut round the ring, smaller than the screen and wider than the headline
  const [picture] = scrap.pictures;
  const served = await fetch(`${h.base}/api/notebooks/pictures?file=${encodeURIComponent(picture.file)}`, {
    headers: { cookie: h.boardCookie },
  });
  const size = pictureSize(Buffer.from(await served.arrayBuffer()))!;
  assert.ok(size.width < 1920 && size.width > HEADLINE.w * VIEW.dpr, `cut round it: ${size.width} px wide`);
  await h.finish(lark);
});

test('a spot without a book, without its element or without a picture is refused, nothing filed', async () => {
  const lark = await h.start({ agent: 'lark' });
  const before = filed();
  const loose = await h.agent('request', lark.token, card({ book: undefined, spot: spot() }));
  assert.deepEqual([loose.status, loose.body.error], [400, '--at and --spot go with --book: a design ask in the book']);
  const bare = spot();
  const page = await h.agent('request', lark.token, card({ spot: { ...bare, anchor: { ...bare.anchor, el: null } } }));
  assert.equal(page.status, 400);
  const blank = await h.agent('request', lark.token, card({ spot: spot({ snip: 'data:image/png;base64,AAAA' }) }));
  assert.equal(blank.status, 400);
  assert.equal(filed(), before);
  await h.finish(lark);
});

test('hq ask refuses --at that is no https address, and --at or --spot alone or without --book', async () => {
  const lark = await h.start({ agent: 'lark' });
  const file = `${mkdtempSync(`${tmpdir()}/askspot-`)}/card.md`;
  writeFileSync(file, 'The hero says Made to last. Keep it?');
  const ask = (...flags: string[]) =>
    h.hq(lark, 'ask', 'decision', 'today', 'Tagline OK?', file, '--topic', 'shop', ...flags);
  const before = filed();
  const local = await ask('--book', 'journal', '--at', 'http://localhost:3000/', '--spot', 'h1');
  assert.match(local.out, /--at is the https address of the page/);
  assert.match((await ask('--book', 'journal', '--at', 'https://shop.example/')).out, /go together/);
  assert.match((await ask('--at', 'https://shop.example/', '--spot', 'h1')).out, /go with hq ask --book/);
  assert.equal(filed(), before);
  await h.finish(lark);
});
