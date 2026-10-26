// node --test platform/hq/renderers/brownstone/layout.test.js   (the layout alone, from the world: no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as world from '../../world/world.js';
import { buildLayout, MAX_WING, roomAt, standBeside, wallHidden, clearOf } from './layout.js';
import { inWell } from './iso.js';

// departments: [id, headcount, room kind, room size]
const org = (...departments) => ({
  board: { members: [{ id: 'board', name: 'The Board', human: true }] },
  commons: [{ id: 'lobby', room: { kind: 'lobby' } }],
  departments: departments.map(([id, n, kind = 'office', size]) => ({
    id,
    room: { kind, size },
    agents: Array.from({ length: n }, (_, k) => ({ id: `${id}-${k}`, name: `${id} ${k}`, engine: 'claude' })),
  })),
});
const layout = o => {
  world.setOrg(o, false);
  return buildLayout(world, 1280, 800);
};
const parts = (L, id) => L.rooms.filter(r => r.src === id).sort((a, b) => a.part - b.part);

test('a department too big for one wing takes several, upwards, each with its name and an even share of its people', () => {
  const L = layout(org(['studio', 100, 'lab'], ['ops', 3, 'dock'], ['process', 4, 'server']));
  const studio = parts(L, 'studio');
  assert.ok(studio.length > 1);
  for (const [k, r] of studio.entries()) {
    assert.equal(r.name, 'Studio');
    assert.ok(r.len <= (r.wing === 'x' ? L.Lx : L.Ly), `${r.id} fits its wing`);
    if (k) assert.ok(r.level >= studio[k - 1].level, `${r.id} is no lower than the part before it`);
  }
  const sizes = studio.map(r => r.agents.length);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `shares ${sizes}`);
  // everyone has exactly one desk, in org order
  assert.deepEqual(
    studio.flatMap(r => r.agents.map(a => a.id)),
    Array.from({ length: 100 }, (_, k) => `studio-${k}`),
  );
  assert.ok(studio.every(r => r.seats.length === r.agents.length));
});

test('a growing department adds floors, never width past MAX_WING', () => {
  const sizes = [20, 60, 120, 600],
    built = sizes.map(n => layout(org(['studio', n, 'lab'], ['ops', 3, 'dock'])));
  for (const [k, L] of built.entries()) {
    assert.ok(L.Lx <= MAX_WING && L.Ly <= MAX_WING, `${sizes[k]} people: wings ${L.Lx} and ${L.Ly}`);
    if (k) assert.ok(L.nUp > built[k - 1].nUp, `${sizes[k]} people: ${L.nUp} floors`);
  }
});

test('departments that fit a wing stay in one room each', () => {
  const L = layout(org(['studio', 9, 'lab'], ['growth', 6], ['ops', 1, 'dock'], ['process', 4, 'server']));
  for (const id of ['studio', 'growth', 'ops', 'process'])
    assert.deepEqual(
      parts(L, id).map(r => r.id),
      [id],
    );
});

test('leftover floor is a few filler rooms, never one long one, each unlike the one beside it', () => {
  // one long department sets the wings' length; the small ones leave long stretches empty
  const L = layout(org(['studio', 14, 'lab'], ['ops', 2, 'dock'], ['care', 2], ['growth', 1], ['finance', 1]));
  const fill = L.rooms.filter(r => r.auto && r.level >= 0 && !['terrace', 'core'].includes(r.kind));
  assert.ok(
    fill.some(r => ['gym', 'canteen'].includes(r.kind)),
    fill.map(r => `${r.kind}(${r.len})`).join(),
  );
  for (const r of fill) assert.ok(r.len <= 7, `${r.id}: ${r.len} tiles`);
  for (const lv of L.levels)
    for (const w of ['x', 'y']) {
      const row = lv.rooms.filter(r => r.wing === w);
      row.forEach(
        (r, k) =>
          k && r.auto && row[k - 1].auto && assert.notEqual(r.kind, row[k - 1].kind, `${r.id} beside ${row[k - 1].id}`),
      );
      assert.ok(row.filter(r => r.kind === 'lounge').length <= 1, `one lounge at most on ${lv.i}${w}`);
    }
});

test('a cocktail bar takes the first green corner of up to 5 tiles, or with none the first filler of that length, once', () => {
  const built = { small: 0, big: 0 };
  for (const a of [1, 5, 9, 14, 16])
    for (const b of [1, 6, 10, 12])
      for (const show of [false, true]) {
        const o = org(['studio', a, 'lab'], ['ops', 2, 'dock'], ['care', b], ['growth', 1], ['process', 2, 'server']);
        const L = layout(show ? { ...o, shows: [{ id: 'onair', name: 'On Air', hosts: ['growth-0'] }] } : o);
        // the filler rooms above ground (not the building's lounge) in the order the wings fill: floor by floor from the bottom, the x wing first, near end first
        const fill = L.levels.flatMap(lv =>
          ['x', 'y'].flatMap(w => lv.rooms.filter(r => r.wing === w && r.id.startsWith('nook-') && r.level >= 0)),
        );
        const bars = fill.filter(r => r.kind === 'bar'),
          cosy = fill.filter(r => r.len <= 5);
        const say = `${a}, ${b}, ${show}: ${fill.map(r => `${r.level}${r.wing}:${r.kind}(${r.len})`).join(' ')}`;
        assert.ok(bars.length <= 1, say);
        // a building with any filler of a cosy length has its bar
        assert.equal(bars.length, cosy.length ? 1 : 0, say);
        if (!bars[0]) continue;
        // no green corner of a cosy length comes before it (one under 3 tiles is always a green corner)
        assert.ok(!cosy.slice(0, cosy.indexOf(bars[0])).some(r => r.kind === 'nook'), say);
        assert.equal(bars[0].name, bars[0].len < 3 ? 'Clink' : 'Cocktails', say);
        built[bars[0].len < 3 ? 'small' : 'big']++;
      }
  assert.ok(built.small && built.big, JSON.stringify(built));
});

test('the photo studio has a darkroom, its keeper at a desk there instead of in their department', () => {
  const o = org(['creative', 3, 'studio'], ['ops', 2, 'dock']);
  assert.equal(
    layout(o).rooms.find(r => r.kind === 'darkroom'),
    undefined,
    'no studio, no darkroom',
  );
  const L = layout({ ...o, studio: { keeper: 'creative-1', waiting: 2, developing: 0, editing: 1 } }),
    dark = L.rooms.find(r => r.kind === 'darkroom');
  assert.deepEqual(
    dark.agents.map(a => a.id),
    ['creative-1'],
  );
  assert.deepEqual(
    parts(L, 'creative').flatMap(r => r.agents.map(a => a.id)),
    ['creative-0', 'creative-2'],
  );
  assert.ok(dark.len <= (dark.wing === 'x' ? L.Lx : L.Ly) && dark.seats.length === 1);
  // a keeper who isn't on a department's desk: the room is drawn all the same, with nobody in it
  const empty = layout({ ...o, studio: { keeper: 'nobody', waiting: 0, developing: 0, editing: 0 } }).rooms.find(
    r => r.kind === 'darkroom',
  );
  assert.equal(empty.agents.length, 0);
});

test('beside a mascot anywhere on the roof, the board stands on the roof: never over the stairwell or past an edge', () => {
  const L = layout(org(['studio', 9, 'lab'], ['ops', 2, 'dock'])),
    roof = L.nUp;
  // the board's note: the cat at the well's left rim, on its way round the stairs, put the board in the well
  const rim = standBeside(L, roof, { x: 2.85, y: 2.45 });
  assert.ok(!inWell(rim.x, rim.y, 0.2), `beside the rim: ${rim.x}, ${rim.y}`);
  // and every spot the cat can be, on a tenth-of-a-tile grid over the roof
  for (let x = 0.3; x < L.X1; x += 0.1)
    for (let y = 0.3; y < L.Y1; y += 0.1) {
      if (!roomAt(L, roof, x, y) || inWell(x, y)) continue;
      const p = standBeside(L, roof, { x, y }),
        at = `beside ${x.toFixed(1)}, ${y.toFixed(1)}: ${p.x.toFixed(2)}, ${p.y.toFixed(2)}`;
      assert.ok(roomAt(L, roof, p.x, p.y), `${at} is on the roof`);
      assert.ok(!inWell(p.x, p.y), `${at} is out of the stairwell`);
    }
});

test("the basement fills the street side's wing on under the street first; under the park is soil", () => {
  const L = layout(org(['studio', 9, 'lab'], ['ops', 2, 'dock'], ['process', 9, 'server'], ['finance', 1, 'vault']));
  const under = L.rooms.filter(r => r.level < 0 && r.wing !== 'core');
  assert.ok(
    under.every(r => r.wing === L.street),
    under.map(r => `${r.id} ${r.wing}`).join(),
  );
  const end = Math.max(...under.map(r => (r.wing === 'x' ? r.x1 : r.y1)));
  assert.equal(end, L.street === 'x' ? L.Xe : L.Ye, 'the street side runs on to the island end');
  // a basement too big for the street side: the park side has only its rooms, no storage after them
  const big = layout(org(['studio', 9, 'lab'], ['ops', 2, 'dock'], ['process', 12, 'server'], ['finance', 9, 'vault'])),
    side = big.rooms.filter(r => r.level < 0 && r.wing === (big.street === 'x' ? 'y' : 'x'));
  assert.ok(side.length && side.every(r => !r.auto), side.map(r => r.id).join());
});

test("an empty room's notice always hangs, clear of the fire escape at its wing's end", () => {
  // small and medium empty departments (3 and 4 tiles) fill the floors up to the park end's fire escape
  const ends = [];
  for (const size of ['s', 'm'])
    for (let n = 1; n <= 14; n++) {
      const L = layout(
        org(['lab', 3, 'lab', 'l'], ...Array.from({ length: n }, (_, k) => [`d${k}`, 0, 'office', size])),
      );
      for (const r of L.rooms.filter(r => r.dept && !r.agents.length && r.level > 0)) {
        const X = r.wing !== 'y',
          len = X ? r.x1 - r.x0 : r.y1 - r.y0,
          atEscape = (L.street !== 'x') === X && (X ? r.x1 === L.X1 : r.y1 === L.Y1);
        // backWall's notice: 22 px, from 2 px into the wall to 4 short of its end, in the first pass with a spot
        const spots = wallHidden(r, L).map(h => clearOf(h, { X, len }, 8, 22, 2, len * 16 - 4));
        assert.ok(
          spots.some(u => u !== null),
          `${r.id} has a spot for its notice`,
        );
        if (!atEscape || r.level === L.nUp) continue;
        ends.push(`${len}@${r.level}${r.level === L.nUp - 1 ? ' top' : ''}`);
        // past the escape's iron: three tiles end the wing only where its flight comes down away from the wall's end (odd
        // floors), so the notice has room before it
        assert.ok(spots[0] !== null, `${r.id}, ${len} tiles on floor ${r.level}: ${spots}`);
      }
    }
  for (const end of ['3@1', '4@1', '4@2', '4@2 top'])
    assert.ok(ends.includes(end), `a ${end} wall at the escape among ${ends}`);
  assert.ok(!ends.some(end => /^3@[2468]/.test(end)), `no three tiles at the escape on an even floor among ${ends}`);
});
