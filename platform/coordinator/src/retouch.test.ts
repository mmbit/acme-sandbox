// node --test src/retouch.test.ts   (the studio's kept boxes on pictures drawn here, no model)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { keepBoxes } from './retouch.ts';

// A sheet with a drawing and a label, and the model's edit of it: 1.5 times larger, a stronger light (1.4 times)
const sheet = (width: number, height: number) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">
    <rect width="400" height="300" fill="#8a7a6a"/><ellipse cx="200" cy="140" rx="120" ry="80" fill="#4f6a55"/>
    <rect x="240" y="200" width="120" height="50" fill="#d8d0c0" stroke="#222" stroke-width="2"/>
    <path d="M60 260 Q200 40 340 260" stroke="#2e3d34" stroke-width="5" fill="none"/></svg>`.replace(
      'width="400" height="300" viewBox',
      `width="${width}" height="${height}" viewBox`,
    ),
  );
const photo = await sharp(sheet(400, 300)).removeAlpha().png().toBuffer(),
  edit = await sharp(sheet(600, 450)).removeAlpha().linear([1.4, 1.4, 1.4], [0, 0, 0]).png().toBuffer();

test('a box with a ring around it takes the light the edit has there', async () => {
  const { kept } = await keepBoxes(photo, edit, 'image/png', [{ x: 230, y: 190, w: 140, h: 70 }]);
  assert.ok('at' in kept[0], JSON.stringify(kept[0]));
  for (const gain of kept[0].gain) assert.ok(Math.abs(gain - 1.4) < 0.05, `gain ${gain}`);
});

test("a box that fills the photo has no light around it to match: it isn't pasted, and says why", async () => {
  const { picture, kept } = await keepBoxes(photo, edit, 'image/png', [{ x: 0, y: 0, w: 400, h: 300 }]);
  assert.ok('missing' in kept[0], JSON.stringify(kept[0]));
  assert.match(kept[0].missing, /can't be measured/);
  assert.equal(picture, edit);
});

// A herbarium sheet with a typed label, its letters drawn from a seed: another seed puts other letters in the same
// places (the model's retyping)
function herbarium(seed: number) {
  let n = seed;
  const random = () => (n = (n * 1103515245 + 12345) % 2 ** 31) / 2 ** 31,
    letters: string[] = [];
  for (let line = 0; line < 4; line++)
    for (let x = 0; x < 200 - 40 * (line % 2); x += 7) {
      const tall = 4 + Math.floor(random() * 5),
        wide = 2 + Math.floor(random() * 3);
      letters.push(`<rect x="${410 + x}" y="${440 + line * 16 - tall}" width="${wide}" height="${tall}"/>`);
    }
  return `<rect width="1000" height="800" fill="#e8e0cc"/><ellipse cx="380" cy="300" rx="90" ry="230" fill="#4f6a55"/>
    <path d="M380 560 Q420 300 360 90" stroke="#2e3d34" stroke-width="6" fill="none"/>
    <rect x="400" y="420" width="240" height="80" fill="#fbf8f0" stroke="#222" stroke-width="3"/><g fill="#333">${letters.join('')}</g>`;
}
const drawn = (svg: string, width: number, height: number) =>
  sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${svg}</svg>`))
    .removeAlpha()
    .jpeg({ quality: 92 })
    .toBuffer();

test("a label the model squared up is kept on its four corners: the board's photo 2° off, the edit straight", async () => {
  // the photo: the sheet turned 2° about its middle; the edit: the sheet straight, 1.44 times larger, shifted, relit,
  // its label retyped
  const turn = 2,
    scale = 1.44,
    shift = { x: 140, y: 60 },
    photo = await drawn(`<g transform="rotate(${turn} 500 400)">${herbarium(1)}</g>`, 1000, 800),
    edit = await sharp(
      await drawn(`<g transform="translate(${shift.x} ${shift.y}) scale(${scale})">${herbarium(2)}</g>`, 1720, 1290),
    )
      .linear([1.1, 1, 0.9], [0, 0, 0])
      .jpeg({ quality: 90 })
      .toBuffer();
  // the keeper's box round the label as it lies in the photo, and where its corners go in the edit: back by the turn,
  // then scaled and shifted (found within a pixel and a half there, about one of the photo's: they lie out on the blank
  // sheet, placed by the label within)
  const box = { x: 384, y: 402, w: 278, h: 126 },
    radians = (-turn * Math.PI) / 180,
    expected = [
      [box.x, box.y],
      [box.x + box.w, box.y],
      [box.x + box.w, box.y + box.h],
      [box.x, box.y + box.h],
    ].map(([x, y]) => {
      const dx = x - 500,
        dy = y - 400;
      return [
        shift.x + scale * (500 + dx * Math.cos(radians) - dy * Math.sin(radians)),
        shift.y + scale * (400 + dx * Math.sin(radians) + dy * Math.cos(radians)),
      ];
    });
  const { kept } = await keepBoxes(photo, edit, 'image/jpeg', [box]);
  assert.ok('corners' in kept[0], JSON.stringify(kept[0]));
  kept[0].corners.forEach(([x, y], i) =>
    assert.ok(Math.hypot(x - expected[i][0], y - expected[i][1]) <= 1.5, `corner ${i}: ${x},${y} for ${expected[i]}`),
  );
  assert.ok(kept[0].match >= 0.85, `match ${kept[0].match}`);
});
