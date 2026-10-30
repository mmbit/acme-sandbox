// node --test platform/hq/shell/viewerfit.test.js   (the viewer's frames: device sizes, side by side or tabs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { devicesFor, fit, chosen, bookChoice, HEAD } from './viewerfit.js';

test('a phone and an upright iPad mini offer no switcher; an iPad on its side a phone; a laptop all four', () => {
  assert.deepEqual(devicesFor(390), ['here']);
  assert.deepEqual(devicesFor(744), ['here']);
  assert.deepEqual(devicesFor(1133), ['here', 'phone']);
  assert.deepEqual(devicesFor(1440), ['here', 'desktop', 'tablet', 'phone']);
});

// What the viewer draws: a frame's box on the screen, the page's size at its scale
const drawn = f => ({ width: f.width * f.scale, height: f.height * f.scale });
// The frames inside a stage w × h px, both across it where they're columns, and filling most of its height under the
// head row (viewer.js draws it HEAD px high)
function inside(f, w, h) {
  const frame = drawn(f),
    room = h - (f.head ? HEAD : 0);
  assert.ok(frame.width * (f.columns ? 2 : 1) <= w, `${frame.width} px frames across ${w} px`);
  assert.ok(frame.height <= room && frame.height > room * 0.9, `a ${frame.height} px frame down ${room} px`);
}

test('staging alone on this device fills the stage, no head row, as the viewer always did', () => {
  const f = fit(800, 700, 'here', false);
  assert.equal(f.head, false);
  assert.deepEqual(drawn(f), { width: 800, height: 700 });
});

test('an iPad mini on its side, the book shut, phone picked: live and staging side by side at full size', () => {
  const f = fit(1133, 704, 'phone', true);
  assert.equal(f.columns, true);
  assert.equal(f.scale, 1);
  assert.equal(f.width, 390);
  inside(f, 1133, 704);
});

test('an iPad mini on its side beside the open book, this device: too narrow for two, so tabs, edge to edge', () => {
  const f = fit(620, 704, 'here', true);
  assert.equal(f.columns, false);
  assert.equal(f.scale, 1);
  assert.equal(f.width, 620);
  inside(f, 620, 704);
});

test('a laptop beside the book: a desktop page drawn smaller in each column, its own width kept', () => {
  const f = fit(1440 - 533, 860, 'desktop', true);
  assert.equal(f.columns, false, 'two desktops under 560 px each take turns');
  inside(f, 1440 - 533, 860);
  const wide = fit(2560 - 533, 1300, 'desktop', true);
  assert.equal(wide.columns, true);
  assert.equal(wide.width, 1440);
  assert.ok(wide.scale < 1 && wide.scale > 0.6, `scale ${wide.scale}`);
  inside(wide, 2560 - 533, 1300);
});

test('choices kept per screen; a device no longer offered falls back to this device; the book beside on a desktop', () => {
  assert.deepEqual(chosen(null, devicesFor(1440), 'wide'), { device: 'here', book: 'beside' });
  assert.deepEqual(chosen(null, devicesFor(1133), 'landscape'), { device: 'here', book: 'over' });
  assert.deepEqual(chosen({ device: 'desktop', book: 'beside' }, devicesFor(1133), 'landscape'), {
    device: 'here',
    book: 'beside',
  });
  assert.equal(bookChoice('portrait'), false);
  assert.equal(bookChoice('narrow'), false);
  assert.equal(bookChoice('landscape'), true);
});
