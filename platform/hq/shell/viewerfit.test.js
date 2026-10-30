// node --test platform/hq/shell/viewerfit.test.js   (the viewer's frames: device sizes, side by side or tabs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { devicesFor, fit, chosen, bookChoice, GAP, HEAD } from './viewerfit.js';

test('a phone and an upright iPad mini offer no switcher; an iPad on its side a phone; a laptop all four', () => {
  assert.deepEqual(devicesFor(390), ['here']);
  assert.deepEqual(devicesFor(744), ['here']);
  assert.deepEqual(devicesFor(1133), ['here', 'phone']);
  assert.deepEqual(devicesFor(1440), ['here', 'desktop', 'tablet', 'phone']);
});

test('staging alone on this device fills the stage, no head row, as the viewer always did', () => {
  assert.deepEqual(fit(800, 700, 'here', false), {
    columns: false,
    column: 800,
    width: 800,
    scale: 1,
    height: 700,
    head: false,
    pad: 0,
  });
});

test('an iPad mini on its side, the book shut, phone picked: live and staging side by side at full size', () => {
  const f = fit(1133, 704, 'phone', true);
  assert.equal(f.columns, true);
  assert.equal(f.scale, 1);
  assert.equal(f.width, 390);
  assert.equal(f.height, 704 - HEAD - GAP / 2);
});

test('an iPad mini on its side beside the open book, this device: too narrow for two, so tabs, edge to edge', () => {
  const f = fit(620, 704, 'here', true);
  assert.equal(f.columns, false);
  assert.equal(f.column, 620);
  assert.equal(f.scale, 1);
  assert.equal(f.height, 704 - HEAD);
});

test('a laptop beside the book: a desktop page drawn smaller in each column, its own width kept', () => {
  const f = fit(1440 - 533, 860, 'desktop', true);
  assert.equal(f.columns, false, 'two desktops under 560 px each take turns');
  const wide = fit(2560 - 533, 1300, 'desktop', true);
  assert.equal(wide.columns, true);
  assert.equal(wide.width, 1440);
  assert.ok(wide.scale < 1 && wide.scale > 0.6, `scale ${wide.scale}`);
  assert.equal(wide.height, Math.round((1300 - HEAD - GAP / 2) / wide.scale), 'the page fills the frame down');
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
