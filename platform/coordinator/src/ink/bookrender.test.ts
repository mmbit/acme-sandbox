// node --test src/ink/bookrender.test.ts   (a page's picture drawn with sharp: no server, no browser)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from './bookrender.ts';
import type { Tried } from './bookrenderversions.ts';

const INK = '#2a2352';
const WORDS = 'The page bar at the bottom grew too tall with the title: make it slim again, and keep the title whole';
const pixels = async (png: Buffer) => sharp(png).raw().toBuffer({ resolveWithObject: true });
const at = ({ data, info }: Awaited<ReturnType<typeof pixels>>, x: number, y: number) => [
  ...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3),
];
// (the post-it's yellow, #fff3a8)
const yellow = ([r, g, b]: number[]) => r > 245 && g > 235 && g < 250 && b > 150 && b < 185;

test("a scrap's words are drawn on their yellow post-it under it, wrapped at its width", async () => {
  const drawn = await pixels(
    await render({ w: 400, h: 300, ink: [], scraps: [], under: [{ x: 24, y: 40, w: 313, text: WORDS }] }, '.'),
  );
  // twice the page's px: the post-it from (48, 80), 626 wide, its words dark on it
  assert.ok(yellow(at(drawn, 60, 84)), "the post-it's top-left");
  assert.ok(yellow(at(drawn, 660, 84)), "the post-it's top-right");
  assert.ok(!yellow(at(drawn, 690, 84)), 'nothing past its width');
  let inked = 0;
  for (let y = 80; y < 200; y++) for (let x = 48; x < 674; x++) if (at(drawn, x, y)[0] < 120) inked++;
  assert.ok(inked > 500, 'its words written on it');
});

test('a page whose box stops short of its last words grows down to them: nothing cut off at the bottom', async () => {
  const long = Array.from({ length: 6 }, () => WORDS).join(' ');
  const page = {
    ...{ w: 400, h: 300, ink: [], scraps: [] },
    texts: [{ x: 24, y: 260, w: 313, text: long, color: INK }],
    under: [{ x: 24, y: 200, w: 313, text: WORDS }],
  };
  const drawn = await pixels(await render(page, '.'));
  assert.equal(drawn.info.width, 800);
  assert.ok(drawn.info.height > 900, `taller than its box (${drawn.info.height} px)`);
  // its last line inked near the bottom, a little paper under it
  const rowInked = (y: number) => Array.from({ length: 626 }, (_, x) => at(drawn, 48 + x, y)[0] < 120).some(Boolean);
  const last = Array.from({ length: drawn.info.height }, (_, y) => y)
    .filter(rowInked)
    .at(-1)!;
  assert.ok(
    last > drawn.info.height - 80 && last < drawn.info.height - 40,
    `the last line whole, paper under it (${last})`,
  );
});

test('a long page is drawn at its full scale, however long, only very big ones scaled down', async () => {
  const tall = await sharp(await render({ w: 600, h: 6000, ink: [], scraps: [] }, '.')).metadata();
  assert.deepEqual([tall.width, tall.height], [1200, 12000]);
  const wide = await sharp(await render({ w: 3000, h: 800, ink: [], scraps: [] }, '.')).metadata();
  assert.deepEqual([wide.width, wide.height], [2400, 640]);
  const huge = await sharp(await render({ w: 2000, h: 20000, ink: [], scraps: [] }, '.')).metadata();
  assert.ok(huge.width! * huge.height! <= 40_000_000 && huge.height! >= 20000, 'whole, at most 40 million px');
});

test('words grown past the picture at its full size draw it smaller, still whole and at most 40 million px', async () => {
  const under = [{ x: 24, y: 19_900, w: 1900, text: Array.from({ length: 20 }, () => WORDS).join(' ') }];
  const png = await render({ w: 2000, h: 20000, ink: [], scraps: [], under }, '.'),
    { width, height } = await sharp(png).metadata();
  assert.ok(width! * height! <= 40_000_000, `at most 40 million px (${width} × ${height})`);
  assert.ok(width! < 2000 && height! / width! > 10, `drawn smaller, the page's shape kept (${width} × ${height})`);
});

test('a page that fills the pixels with words set past its foot is drawn smaller, whole: its last line on paper', async () => {
  const long = Array.from({ length: 6 }, () => WORDS).join(' ');
  const page = {
    ...{ w: 1200, h: 8400, ink: [], scraps: [] },
    texts: [{ x: 24, y: 8380, w: 313, text: long, color: INK }],
  };
  const png = await render(page, '.');
  const { width = 0, height = 0 } = await sharp(png).metadata();
  assert.ok(width * height <= 40_000_000 && width < 2390, `within the pixels, smaller (${width} × ${height})`);
  // the foot of the picture: its last line inked, paper under it to the bottom
  const foot = await pixels(
    await sharp(png)
      .extract({ left: 0, top: height - 600, width: 800, height: 600 })
      .toBuffer(),
  );
  const rowInked = (y: number) => Array.from({ length: 700 }, (_, x) => at(foot, 40 + x, y)[0] < 120).some(Boolean);
  const last = Array.from({ length: 600 }, (_, y) => y).findLast(rowInked) ?? -1;
  assert.ok(last > 600 - 80 && last < 600 - 30, `the last line drawn, near the foot (${last} of 600)`);
  assert.deepEqual(at(foot, 100, 599), [255, 253, 248], 'paper under it');
});

test("an agent's answers and the board's replies are drawn: slipped under their group, and at their spots", async () => {
  const page = {
    ...{ w: 800, h: 300, ink: [], scraps: [] },
    under: [
      {
        ...{ x: 24, y: 200, w: 313, text: WORDS },
        slips: [
          { name: 'Lyra', text: Array.from({ length: 4 }, () => WORDS).join(' ') },
          { name: null, text: 'Yes, slim it' },
        ],
      },
    ],
    answers: [{ x: 420, y: 40, w: 340, name: 'Juno', color: '#12808a', text: WORDS }],
  };
  const drawn = await pixels(await render(page, '.'));
  const ink = ([r, g, b]: number[]) => r < 60 && g > 100 && g < 160 && b > 110 && b < 170;
  let teal = 0;
  for (let y = 80; y < 400; y++) for (let x = 840; x < 1520; x++) if (ink(at(drawn, x, y))) teal++;
  assert.ok(teal > 800, `the answer at its spot written in its agent's ink (${teal} px)`);
  // the post-it, then the slip's name under it (#5a5478), then the reply's words, the picture grown down to them
  const column = Array.from({ length: drawn.info.height }, (_, y) => at(drawn, 60, y)),
    postit = column.findLastIndex(yellow);
  const named = (y: number) =>
    Array.from({ length: 120 }, (_, x) => at(drawn, 60 + x, y)).some(
      ([r, g, b]) => r < 110 && g < 100 && b > 105 && b - r > 15,
    );
  const slip = Array.from({ length: drawn.info.height }, (_, y) => y).find(y => y > postit && named(y)) ?? -1;
  assert.ok(postit > 400 && slip > postit, `the slip's name under the post-it (${postit}, ${slip})`);
  const rowInked = (y: number) => Array.from({ length: 600 }, (_, x) => at(drawn, 48 + x, y)[0] < 120).some(Boolean);
  const last = Array.from({ length: drawn.info.height }, (_, y) => y).findLast(rowInked)!;
  assert.ok(
    drawn.info.height > 1000 && last > drawn.info.height - 80,
    `grown down to the reply (${last} of ${drawn.info.height})`,
  );
});

const TEAL = ([r, g, b]: number[]) => r < 60 && g > 100 && g < 160 && b > 110 && b < 170;
const count = (drawn: Awaited<ReturnType<typeof pixels>>, is: (p: number[]) => boolean, box = [0, 0, 1e9, 1e9]) => {
  let n = 0;
  for (let y = box[1]; y < Math.min(box[3], drawn.info.height); y++)
    for (let x = box[0]; x < Math.min(box[2], drawn.info.width); x++) if (is(at(drawn, x, y))) n++;
  return n;
};

const RED = ([r, g, b]: number[]) => r > 200 && g < 70 && b < 70;
// A red cross over a box (x, y, w, h): two strokes corner to corner
const cross = (x: number, y: number, w: number, h: number) =>
  [
    [0.2, 0.2, 0.8, 0.8],
    [0.8, 0.2, 0.2, 0.8],
  ].map(([x0, y0, x1, y1]) => ({
    ...{ color: '#e02020', size: 4, alpha: 1 },
    points: [
      [x + x0 * w, y + y0 * h],
      [x + x1 * w, y + y1 * h],
    ],
  }));

const GREEN = ([r, g, b]: number[]) => r < 70 && g > 150 && b < 70;
// A green ring round a box (x, y, w, h), reach px outside it on every side, as bookpicks.mjs's circle
const ring = (x: number, y: number, w: number, h: number, reach: number) => [
  {
    ...{ color: '#20c020', size: 4, alpha: 1 },
    points: Array.from({ length: 49 }, (_, i) => [
      x + w / 2 + (w / 2 + reach) * Math.cos((i / 48) * 2 * Math.PI),
      y + h / 2 + (h / 2 + reach) * Math.sin((i / 48) * 2 * Math.PI),
    ]),
  },
];

test("a try's versions are drawn under its scrap: each version's picture and letter, the chosen one stamped, the others' fates, the board's ink on them, and the ones coming", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'versions-'));
  for (const [file, colour] of [
    ['a.png', '#2050ff'],
    ['b.png', '#ff8c00'],
  ])
    await sharp({ create: { width: 320, height: 240, channels: 3, background: colour } })
      .png()
      .toFile(join(dir, file));
  const tried: Tried = {
    ...{ name: 'Lyra', color: '#12808a', coming: 1, ended: null },
    versions: [
      {
        ...{ letter: 'A', name: 'Quiet harbour', text: 'Softer greys', picture: 'a.png' },
        ...{ chosen: true, greyed: false, fate: null },
        // (the board's ring round A's picture when it showed 200 px wide, reaching 10 px past it)
        marks: [{ frame: { x: 100, y: 300, w: 200, h: 150 }, ink: ring(100, 300, 200, 150, 10) }],
      },
      {
        ...{ letter: 'B', name: 'Bright quay', text: '', picture: 'b.png', chosen: false, greyed: true },
        fate: 'cleared once the page is sent',
        // (the board's cross, written over B's picture when it showed 200 px wide)
        marks: [{ frame: { x: 500, y: 300, w: 200, h: 150 }, ink: cross(500, 300, 200, 150) }],
      },
    ],
  };
  const page = (t?: typeof tried) => ({
    ...{ w: 700, h: 300, ink: [], scraps: [] },
    under: [{ x: 24, y: 120, w: 640, text: 'Test: who is this', ...(t ? { tried: t } : {}) }],
  });
  const [bare, drawn] = await Promise.all(
    [render(page(), dir), render(page(tried), dir)].map(async p => pixels(await p)),
  );
  // the block under the post-it, grown down to it: Lyra's face and name, and the frame still coming, in her ink
  assert.ok(drawn.info.height > bare.info.height + 300, `grown down to it (${bare.info.height}, ${drawn.info.height})`);
  assert.equal(count(bare, TEAL), 0);
  assert.ok(count(drawn, TEAL) > 600, "Lyra's face, name and pencil dots");
  // A's picture with CHOSEN across it (#d6ea3c); B's greyed: no orange left
  assert.ok(count(drawn, ([r, g, b]) => r < 60 && g < 110 && b > 220) > 20_000, "A's picture");
  assert.ok(count(drawn, ([r, g, b]) => r > 190 && g > 210 && b < 90) > 2_000, 'CHOSEN stamped on it');
  assert.equal(
    count(drawn, ([r, g, b]) => r > 230 && g > 110 && g < 160 && b < 40),
    0,
    'B greyed',
  );
  // the board's red cross over B's frame, and its fate a line under it
  assert.ok(count(drawn, RED) > 200, "the board's cross on B");
  // the ring whole round A's picture: past its blue on all four sides, not cut to its corners
  const blue = ([r, g, b]: number[]) => r < 60 && g < 110 && b > 220;
  const xs: number[] = [],
    ys: number[] = [];
  for (let y = 0; y < drawn.info.height; y++)
    for (let x = 0; x < drawn.info.width; x++)
      if (blue(at(drawn, x, y))) {
        xs.push(x);
        ys.push(y);
      }
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  for (const [side, box] of [
    ['left', [0, y0, x0 - 4, y1]],
    ['right', [x1 + 5, y0, x1 + 40, y1]],
    ['above', [x0, 0, x1, y0 - 4]],
    ['below', [x0, y1 + 5, x1, y1 + 40]],
  ] as const)
    assert.ok(count(drawn, GREEN, [...box]) > 100, `the ring ${side} A's picture`);
  const unmarked = { ...tried, versions: tried.versions.map(v => ({ ...v, fate: null, marks: [] })) };
  const plain = await pixels(await render(page(unmarked), dir));
  assert.equal(count(plain, RED), 0);
  assert.equal(count(plain, GREEN), 0);
  assert.ok(drawn.info.height > plain.info.height, `B's fate under it (${plain.info.height}, ${drawn.info.height})`);
  const ended = await pixels(
    await render(page({ ...tried, versions: [], coming: 0, ended: 'The try ended without a version.' }), dir),
  );
  assert.ok(count(ended, TEAL) > 600, "the ended try's agent and reason");
});

test("an agent's card clipped under a unit is drawn in its ink: its words, its choices as chips, its questions", async () => {
  const card = {
    ...{ name: 'Lyra', color: '#12808a', text: 'Give me a choice to test', answer: null },
    ...{ choices: ['Red', 'Blue'], questions: [{ title: 'Anything to add?', choices: [] }] },
  };
  const page = (asks: (typeof card)[]) => ({
    ...{ w: 400, h: 200, ink: [], scraps: [] },
    under: [{ x: 24, y: 40, w: 313, text: 'Give me a choice to test :)', asks }],
  });
  const [bare, drawn] = await Promise.all(
    [render(page([]), '.'), render(page([card]), '.')].map(async p => pixels(await p)),
  );
  // its slip under the post-it (#fff4cf), "Lyra asks", its chips in her ink; the picture grown down to it
  const slip = ([r, g, b]: number[]) => r > 250 && g > 238 && g < 250 && b > 196 && b < 214;
  assert.ok(count(drawn, slip) > 20_000, "the card's slip");
  assert.ok(count(drawn, TEAL) > 600, "in Lyra's ink");
  assert.equal(count(bare, TEAL), 0);
  assert.ok(drawn.info.height > bare.info.height + 100, `grown down to it (${bare.info.height}, ${drawn.info.height})`);
});

test("a form clipped onto an answer is drawn under its words in the agent's ink: chips and a line, then the answers", async () => {
  const form = (answered: boolean) => ({
    color: '#12808a',
    questions: [
      { title: 'Warmer or cooler?', choices: ['Warmer', 'Cooler'], ...(answered ? { answer: 'Warmer' } : {}) },
      { title: 'Anything to add?', choices: [], ...(answered ? { answer: '' } : {}) },
    ],
  });
  const page = (slip: object) => ({
    ...{ w: 400, h: 200, ink: [], scraps: [] },
    under: [
      { x: 24, y: 40, w: 313, text: 'Which colour?', slips: [{ name: 'Lyra', text: 'Two things first', ...slip }] },
    ],
  });
  const [bare, open, answered] = await Promise.all(
    [render(page({}), '.'), render(page({ form: form(false) }), '.'), render(page({ form: form(true) }), '.')].map(
      async p => pixels(await p),
    ),
  );
  assert.equal(count(bare, TEAL), 0);
  assert.ok(count(open, TEAL) > 1500, "its chips and line in Lyra's ink");
  assert.ok(count(answered, TEAL) > 200 && count(answered, TEAL) < count(open, TEAL), "the answers in Lyra's ink");
  assert.ok(open.info.height > bare.info.height + 100, `grown down to it (${bare.info.height}, ${open.info.height})`);
});
