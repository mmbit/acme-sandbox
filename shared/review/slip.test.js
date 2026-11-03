// node --test shared/review/slip.test.js   (a tick written on a slip, the slip it's on, and what "now" shows)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTick, nowOf, slipHtml, slipUnder } from './slip.js';

// a line through these corners, a point every 2 px
const line = (...corners) =>
  corners.slice(1).flatMap((b, i) => {
    const a = corners[i],
      steps = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2));
    return Array.from({ length: steps }, (_, k) => [
      a[0] + ((b[0] - a[0]) * (k + 1)) / steps,
      a[1] + ((b[1] - a[1]) * (k + 1)) / steps,
      0.5,
      0,
    ]);
  });
const from = (start, ...rest) => [[...start, 0.5, 0], ...line(start, ...rest)];

test('a tick is a tick: short leg down, long leg up, either way across, a V too', () => {
  assert.ok(isTick(from([0, 20], [10, 32], [40, 0])));
  assert.ok(isTick(from([40, 20], [30, 32], [0, 0])), "a left hand's, right to left");
  assert.ok(isTick(from([0, 0], [15, 30], [30, 2])), 'a V');
  assert.ok(isTick(from([0, 14], [5, 20], [24, 0])), 'a small one');
});

test('what is no tick: a line, a ring, a scribble, a cross stroke, an upside-down one, a dot', () => {
  assert.ok(!isTick(from([0, 0], [60, 0])), 'a line across');
  assert.ok(!isTick(from([0, 0], [40, 30])), 'a line down');
  assert.ok(!isTick(from([20, 0], [40, 20], [20, 40], [0, 20], [20, 0])), 'a ring');
  assert.ok(!isTick(from([0, 0], [10, 20], [20, 0], [30, 20], [40, 0], [50, 20], [60, 0])), 'a scribble');
  assert.ok(!isTick(from([0, 30], [10, 0], [40, 30])), 'upside down');
  assert.ok(!isTick(from([0, 20], [10, 32], [12, 28])), 'its second leg too short');
  assert.ok(!isTick(from([0, 20], [10, 32], [0, 0])), 'back the way it came');
  assert.ok(!isTick([[5, 5, 0.5, 0]]), 'a dot');
});

test('a line is on the slip that holds its middle', () => {
  const slips = [
    { id: 1, x: 0, y: 0, w: 300, h: 100 },
    { id: 2, x: 0, y: 120, w: 300, h: 100 },
  ];
  assert.equal(slipUnder(from([250, 140], [260, 160], [290, 120]), slips)?.id, 2);
  assert.equal(slipUnder(from([250, 40], [260, 60], [290, 20]), slips)?.id, 1);
  assert.equal(slipUnder(from([250, 104], [260, 110], [290, 106]), slips), null, 'between them: neither');
});

// a reader's words by their key, each place after it
const keyed = (key, places = {}) => [key, ...Object.values(places)].join(' ');

test('now is the preview for something new, else a cut kept from before, else nothing: the snip alone', () => {
  const preview = {
    name: 'Inkbath',
    open: 'https://inkbath.preview.example',
    picture: '/api/artifacts/picture?id=inkbath',
  };
  assert.deepEqual(nowOf({ preview, now: '/cut.jpg' }, keyed), {
    src: preview.picture,
    href: preview.open,
    label: 'slipNowOf Inkbath',
    empty: 'slipRunning',
  });
  assert.equal(nowOf({ preview: { pending: true } }, keyed).empty, 'slipPreviewPending');
  assert.deepEqual(nowOf({ preview: null, now: '/cut.jpg' }, keyed), { src: '/cut.jpg', label: 'slipNow' });
  assert.equal(nowOf({}, keyed), null, 'nothing cuts the place again (rule zero)');
});

test("a slip in the reader's words, its agent's name marked as an AI's", () => {
  const dutch = {
    slipAnswer: 'Antwoord van {name}',
    slipTick: 'Afvinken: klaar',
  };
  const say = (key, places = {}) => (dutch[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => places[k]);
  // each word on its own element, whatever the order of the markup around it
  const tag = (html, name) => html.match(new RegExp(`<${name}\\b[^>]*>`))[0];
  const html = slipHtml({ id: 1, name: 'Vera', text: 'Klaar' }, {}, { say, mark: 'AI-agent' });
  assert.match(tag(html, 'section'), /aria-label="Antwoord van Vera · AI-agent"/);
  assert.match(html, /<b class="slip-by">Vera · AI-agent<\/b>/);
  assert.match(tag(html, 'button'), /aria-label="Afvinken: klaar"/);
  const unmarked = slipHtml({ id: 1, name: 'Vera', text: 'Done' }, {}, { say });
  assert.match(unmarked, /<b class="slip-by">Vera<\/b>/);
  // (no field to type a reply in: the reader answers in its own room, drawn.)
  assert.doesNotMatch(unmarked + html, /<(textarea|input)\b/);
});

test("a fix: its box beside its line, or round its drawing, saying what the tick does; a picture's source under it", () => {
  const say = (key, places = {}) =>
    `${key}${places.fix ? ` ${places.fix}` : ''}${places.name ? ` ${places.name}` : ''}`;
  const written = slipHtml({ id: 2, name: 'Joost', text: 'It keeps every stroke', fix: 'Free strokes' }, {}, { say });
  assert.match(written, /data-fix/);
  assert.match(
    written,
    /<div class="slip-fix"><button class="slip-tick"[^>]*aria-label="slipFixTick">/,
    'the box by its line',
  );
  assert.match(written, /<b class="slip-fix-words">slipFix Free strokes<\/b>/);
  assert.match(written, /<p class="slip-fix-said">slipFixSend<\/p>/);
  assert.equal(written.match(/class="slip-tick"/g).length, 1, 'one box: none at the corner');
  const drawn = slipHtml({ id: 3, name: 'Joost', text: '', fix: 'Room', ticked: 'x' }, {}, { say, art: '<svg></svg>' });
  assert.match(drawn, /<div class="slip-fix-art"><svg><\/svg><button class="slip-tick"/, 'the box at its drawing');
  assert.match(drawn, /slipFixTicked/);
  const built = slipHtml({ id: 4, name: 'Vera', text: '', fix: 'Room', ticked: 'x', builder: 'Joost' }, {}, { say });
  assert.match(built, /<button class="slip-tick"[^>]*disabled>/);
  assert.match(built, /slipFixBuilt Joost/, 'who builds it, not who proposed it');
  const chart = slipHtml(
    { id: 5, name: 'Joost', text: 'Faster', picture: '/c.png', source: 'HQ, 7 days' },
    {},
    { say },
  );
  assert.match(chart, /<img class="slip-pic"[^>]*><p class="slip-source">HQ, 7 days<\/p>/);
});
