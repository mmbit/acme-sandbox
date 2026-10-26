// node --test shared/qr/qr.test.mjs   (pure: no network, no files)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qrCode, qrPath } from './qr.js';

// Reference symbols from python-qrcode 8 (byte mode, level M, the same mask forced), '#' dark
// prettier-ignore
const HI_MASK_2 = [
    '#######..####.#######',
    '#.....#..##.#.#.....#',
    '#.###.#.##.##.#.###.#',
    '#.###.#.##..#.#.###.#',
    '#.###.#.#..##.#.###.#',
    '#.....#.##..#.#.....#',
    '#######.#.#.#.#######',
    '........#.###........',
    '#.#####.....#.#####..',
    '.###.#.#..#.#..#....#',
    '..##..##.#.#.#..####.',
    '###.#....#.....##.#..',
    '###.#.#....#.#..#.#.#',
    '........#..####..#..#',
    '#######...#.#.##...#.',
    '#.....#.#######..#..#',
    '#.###.#.#...#..#..#..',
    '#.###.#.###.#..#..#..',
    '#.###.#.#..#.#..###..',
    '#.....#..##....##.#..',
    '#######.#.##.#..####.',
];
// prettier-ignore
const LINK_MASK_5 = [
    '#######....#...###....#######',
    '#.....#.###.###.#.#.#.#.....#',
    '#.###.#.#..#.#.#..###.#.###.#',
    '#.###.#.##..#...#####.#.###.#',
    '#.###.#...###..#####..#.###.#',
    '#.....#..####..#.#..#.#.....#',
    '#######.#.#.#.#.#.#.#.#######',
    '........#..#..###...#........',
    '#.....#.#...#...####.##..###.',
    '###....#.#####..#.##...##.##.',
    '.#.##.##...#.######.#.###....',
    '...........#.#.....####..#...',
    '..#.#.##.###.#.##...#.#.....#',
    '..####.#.#.##...#.###.###..##',
    '##.#..#..........##.#.#.###..',
    '..#......####..#...##..#..#.#',
    '.....##.##......###......##..',
    '####.#.#..#.###..#.##.###.###',
    '##..####.#..#..#.#.##.##.#..#',
    '#...##.#######.....###.#.....',
    '#.#..####...#.##.#.######.###',
    '........#.###.#..#..#...##...',
    '#######....##.....###.#.###..',
    '#.....#..##.#.###.#.#...#....',
    '#.###.#....####..#########...',
    '#.###.#..##.###..###.#...###.',
    '#.###.#..#####.###..#.######.',
    '#.....#..######.####..##.##.#',
    '#######.####.#.#...#.###..#..',
];

const picture = code =>
  Array.from({ length: code.size }, (_, y) =>
    Array.from({ length: code.size }, (_, x) => (code.dark(x, y) ? '#' : '.')).join(''),
  );

test('a short text makes the same version 1 symbol as a reference encoder', () => {
  const code = qrCode('hi', { level: 'M', mask: 2 });
  assert.equal(code.version, 1);
  assert.deepEqual(picture(code), HI_MASK_2);
});

test('a link makes the same version 3 symbol as a reference encoder', () => {
  const code = qrCode('https://onlyonery.com/p/#c=x', { level: 'M', mask: 5 });
  assert.equal(code.version, 3);
  assert.deepEqual(picture(code), LINK_MASK_5);
});

test('the version grows with the text and the level, and version 7 carries its version bits', () => {
  assert.equal(qrCode('x'.repeat(100), { level: 'L' }).version, 5);
  assert.equal(qrCode('x'.repeat(100), { level: 'H' }).version, 10);
  const code = qrCode('x'.repeat(110), { level: 'M' });
  assert.equal(code.version, 7);
  // 000111 110010 010100: version 7 and its Golay remainder, read from the bottom left block
  let bits = 0;
  for (let i = 17; i >= 0; i--) bits = (bits << 1) | Number(code.dark(Math.floor(i / 3), code.size - 11 + (i % 3)));
  assert.equal(bits, 0x07c94);
});

test('without a forced mask it picks one, and too long a text is refused', () => {
  const code = qrCode('https://onlyonery.com/povpad/pair/#c=0123456789abcdef');
  assert.ok(code.mask >= 0 && code.mask < 8);
  assert.equal(qrCode('é'.repeat(1476), { level: 'L' }).version, 40);
  assert.throws(() => qrCode('x'.repeat(2954), { level: 'L' }), RangeError);
  assert.throws(() => qrCode('x', { level: 'X' }), /level X/);
});

test('the path draws one rectangle per run of dark modules, inside the quiet zone', () => {
  const code = qrCode('hi', { level: 'M', mask: 2 });
  const path = qrPath(code, { margin: 4 });
  assert.match(path, /^M4 4h7v1h-7z/);
  const runs = HI_MASK_2.flatMap(row => row.match(/#+/g) ?? []);
  assert.equal(path.split('M').length - 1, runs.length);
});
