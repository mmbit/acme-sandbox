// node --test src/ink/bookrender.test.ts   (a page's picture drawn with sharp: no server, no browser)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { render } from './bookrender.ts';

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
