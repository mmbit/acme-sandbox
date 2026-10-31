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

test('now is the preview for something new, else a cut kept from before, else nothing: the snip alone', () => {
  const preview = {
    name: 'Inkbath',
    open: 'https://inkbath.preview.example',
    picture: '/api/artifacts/picture?id=inkbath',
  };
  assert.deepEqual(nowOf({ preview, now: '/cut.jpg' }), {
    src: preview.picture,
    href: preview.open,
    label: 'Now · Inkbath',
    empty: 'Running',
  });
  assert.equal(nowOf({ preview: { pending: true } }).empty, 'Its preview shows here once it runs');
  assert.deepEqual(nowOf({ preview: null, now: '/cut.jpg' }), { src: '/cut.jpg', label: 'Now' });
  assert.equal(nowOf({}), null, 'nothing cuts the place again (rule zero)');
});

test("a slip in the reader's words, its agent's name marked as an AI's", () => {
  const dutch = {
    "{name}'s answer": 'Antwoord van {name}',
    'Tick it: done': 'Afvinken: klaar',
    'Reply to {name}': 'Antwoord aan {name}',
    'Write under it to reply': 'Schrijf eronder om te antwoorden',
  };
  const say = (en, places = {}) => (dutch[en] ?? en).replace(/\{(\w+)\}/g, (_, k) => places[k]);
  // each word on its own element, whatever the order of the markup around it
  const tag = (html, name) => html.match(new RegExp(`<${name}\\b[^>]*>`))[0];
  const html = slipHtml({ id: 1, name: 'Vera', text: 'Klaar' }, {}, { say, mark: 'AI-agent' });
  assert.match(tag(html, 'section'), /aria-label="Antwoord van Vera · AI-agent"/);
  assert.match(html, /<b class="slip-by">Vera · AI-agent<\/b>/);
  assert.match(tag(html, 'button'), /aria-label="Afvinken: klaar"/);
  assert.match(tag(html, 'textarea'), /aria-label="Antwoord aan Vera"/);
  assert.match(tag(html, 'textarea'), /placeholder="Schrijf eronder om te antwoorden"/);
  const english = slipHtml({ id: 1, name: 'Vera', text: 'Done' }, {});
  assert.match(english, /<b class="slip-by">Vera<\/b>/);
  assert.match(tag(english, 'textarea'), /aria-label="Reply to Vera"/);
  assert.match(tag(english, 'textarea'), /placeholder="Write under it to reply"/);
});
