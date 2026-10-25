// node --test shared/lineart/lineart.test.mjs
// The line-art kit at its exports: shapes and their roles, the palettes, the fit and the SVG.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scene, shapesOf, fit, bounds, svg, paletteOf, drawing, PALETTES } from './lineart.js';
import { EXAMPLES } from './examples/examples.js';

test('a box shows its top and two near faces, the accent on the face it names', () => {
  const shapes = shapesOf(scene().box(0, 0, 0, 2, 1, 1, { accent: 'left' }).items);
  assert.deepEqual(shapes.map(s => s.role).sort(), ['accent', 'plain-right', 'plain-top']);
});

test('a flat box leaves out the faces it has no area for', () => {
  const shapes = shapesOf(scene().box(0, 0, 0, 2, 2, 0).items);
  assert.deepEqual(
    shapes.map(s => s.role),
    ['plain-top'],
  );
});

test('the fit keeps the drawing inside its frame less the pad', () => {
  const shapes = shapesOf(scene().room(0, 0, 0, 6, 4, 3).figure(2, 2, 0).items);
  const W = 800,
    H = 600,
    pad = 0.1,
    { k, ox, oy } = fit(shapes, { W, H, pad });
  const [x0, y0, x1, y1] = bounds(shapes).map((v, i) => (i % 2 ? oy : ox) + v * k);
  assert.ok(x0 >= W * pad - 0.01 && x1 <= W * (1 - pad) + 0.01 && y0 >= H * pad - 0.01 && y1 <= H * (1 - pad) + 0.01);
  assert.ok(
    Math.abs(x1 - x0 - W * (1 - 2 * pad)) < 0.01 || Math.abs(y1 - y0 - H * (1 - 2 * pad)) < 0.01,
    'it fills one side',
  );
});

test('each palette shades its own way: dots, hatching or flat tones', () => {
  const box = s => s.box(0, 0, 0, 1, 1, 1);
  const frame = { W: 100, H: 100 };
  assert.match(drawing(box, 'line', frame), /fill="url\(#la-line-dots\)"/);
  assert.match(drawing(box, 'blueprint', frame), /fill="url\(#la-blueprint-hatch\)"/);
  assert.doesNotMatch(drawing(box, 'soft', frame), /fill="url\(/);
  const dark = drawing(s => s.box(0, 0, 0, 1, 1, 1, { tone: 'dark' }), 'blueprint', frame);
  assert.match(dark, new RegExp(`<path[^>]*fill="${PALETTES.blueprint.ink}"`));
});

test("a company's own palette lies over the one it names, CSS variables and all", () => {
  const own = paletteOf({
    base: 'soft',
    ink: 'var(--ink)',
    accent: 'var(--accent)',
    tones: { leaf: ['#0f0', '#0c0', '#090'], 'red-brick': ['#c33', '#a22', '#811'] },
  });
  assert.equal(own.shade, 'flat');
  assert.equal(own.tones.plain, PALETTES.soft.tones.plain);
  assert.equal(own.tones.leaf[1], '#0c0');
  const picture = drawing(s => s.box(0, 0, 0, 1, 1, 1, { accent: 'top' }), own, { W: 100, H: 100 });
  assert.match(picture, /fill="var\(--accent\)"/);
  assert.match(picture, /stroke="var\(--ink\)"/);
  const brick = drawing(s => s.box(0, 0, 0, 1, 1, 1, { tone: 'red-brick' }), own, { W: 100, H: 100 });
  for (const colour of own.tones['red-brick']) assert.match(brick, new RegExp(`fill="${colour}"`));
  assert.throws(() => paletteOf('neon'), /no palette called neon/);
});

test("a line on the accent takes the palette's onAccent, the ink where it sets none", () => {
  const lines = s =>
    s.box(0, 0, 0, 1, 1, 1, { accent: 'top' }).line(
      [
        [0, 0, 1],
        [1, 1, 1],
      ],
      { onAccent: true },
    );
  const lit = drawing(lines, { ink: '#111', onAccent: '#eee' }, { W: 100, H: 100 });
  assert.match(lit, /<path d="[^"]*" fill="none" stroke="#eee"/);
  assert.match(drawing(lines, { ink: '#111' }, { W: 100, H: 100 }), /<path d="[^"]*" fill="none" stroke="#111"/);
});

test('every example draws the same bytes twice in every palette, with one accent shape', () => {
  for (const { build, W, H, title } of Object.values(EXAMPLES))
    for (const palette of Object.keys(PALETTES)) {
      const picture = drawing(build, palette, { W, H, title });
      assert.equal(picture, drawing(build, palette, { W, H, title }));
      assert.match(picture, new RegExp(`aria-label="${title}"`));
      assert.equal(
        picture.split(`fill="${PALETTES[palette].accent}"`).length - 1,
        1,
        `${title} in ${palette}: one accent`,
      );
    }
});

test('a drawing with an unknown piece fails loudly', () => {
  assert.throws(() => shapesOf([{ kind: 'cone' }]), /no shape called cone/);
});

test('svg escapes its title', () => {
  const picture = svg([], PALETTES.line, { W: 10, H: 10, title: 'A <b>"house"</b> & garden' });
  assert.match(picture, /aria-label="A &lt;b&gt;&quot;house&quot;&lt;\/b&gt; &amp; garden"/);
});
