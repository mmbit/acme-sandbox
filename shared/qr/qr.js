// QR codes (ISO/IEC 18004) for a short text such as a link, in byte mode, for the browser and Node alike.
// qrCode(text, { level, mask }) → { size, version, level, mask, dark(x, y) }; qrPath(code, { margin }) → an SVG path.

// The four error correction levels, by how much of the code may be lost: L 7%, M 15%, Q 25%, H 30%.
// formatBits is each level's two bits in the format information.
const LEVELS = {
  L: { index: 0, formatBits: 1 },
  M: { index: 1, formatBits: 0 },
  Q: { index: 2, formatBits: 3 },
  H: { index: 3, formatBits: 2 },
};

// Per level (L, M, Q, H), per version (1 to 40): the error correction codewords in each block, and the blocks
// (the standard's table 9)
// prettier-ignore
const ECC_PER_BLOCK = [
  [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
// prettier-ignore
const BLOCKS = [
  [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

// The eight mask patterns: a module whose pattern is true is flipped
const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  x => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

const BYTE_MODE = 0b0100;
const PAD_BYTES = [0xec, 0x11];

// The smallest code that holds `text` at `level`. mask (0 to 7) forces a mask pattern; without it the code takes the
// one the standard's penalty rules score lowest. Throws when the text is too long for version 40.
export function qrCode(text, { level = 'M', mask } = {}) {
  const ecl = LEVELS[level];
  if (!ecl) throw new Error(`No QR error correction level ${level}: use L, M, Q or H`);
  const bytes = new TextEncoder().encode(text);
  const version = smallestVersion(bytes.length, ecl);
  const codewords = withErrorCorrection(dataCodewords(bytes, version, ecl), version, ecl);
  const grid = emptyGrid(version);
  drawFunctionPatterns(grid, version);
  drawCodewords(grid, codewords);
  const chosen = mask ?? bestMask(grid, ecl);
  applyMask(grid, chosen);
  drawFormatBits(grid, ecl, chosen);
  return {
    size: grid.size,
    version,
    level,
    mask: chosen,
    dark: (x, y) => grid.modules[y][x],
  };
}

// The dark modules as one SVG path, a unit per module, `margin` modules of quiet zone round the code (the standard
// asks four). Draw it in an <svg viewBox="0 0 n n">, n = size + 2 × margin, with shape-rendering="crispEdges".
export function qrPath(code, { margin = 4 } = {}) {
  const runs = [];
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (!code.dark(x, y)) continue;
      let length = 1;
      while (x + length < code.size && code.dark(x + length, y)) length++;
      runs.push(`M${x + margin} ${y + margin}h${length}v1h${-length}z`);
      x += length;
    }
  }
  return runs.join('');
}

// ---- the data

function smallestVersion(byteCount, ecl) {
  for (let version = 1; version <= 40; version++) {
    const bits = 4 + countBits(version) + byteCount * 8;
    if (bits <= dataCodewordCount(version, ecl) * 8) return version;
  }
  throw new RangeError(`A QR code holds at most 2953 bytes; this text is ${byteCount}`);
}

// The character count's width in byte mode
const countBits = version => (version < 10 ? 8 : 16);

// The mode, the count, the bytes, a terminator and the padding, as codewords
function dataCodewords(bytes, version, ecl) {
  const capacity = dataCodewordCount(version, ecl) * 8;
  const bits = [];
  const push = (value, width) => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(BYTE_MODE, 4);
  push(bytes.length, countBits(version));
  for (const byte of bytes) push(byte, 8);
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8)
    codewords.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit));
  for (let i = 0; codewords.length < capacity / 8; i++) codewords.push(PAD_BYTES[i % 2]);
  return codewords;
}

// The data split into blocks, each followed by its Reed-Solomon codewords, then interleaved: the first codeword of
// every block, then the second, and so on, the error correction last
function withErrorCorrection(data, version, ecl) {
  const blockCount = BLOCKS[ecl.index][version - 1];
  const eccLength = ECC_PER_BLOCK[ecl.index][version - 1];
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blockCount - (rawCodewords % blockCount);
  const shortDataLength = Math.floor(rawCodewords / blockCount) - eccLength;
  const divisor = reedSolomonDivisor(eccLength);
  const blocks = [];
  for (let i = 0, start = 0; i < blockCount; i++) {
    const length = shortDataLength + (i < shortBlocks ? 0 : 1);
    const blockData = data.slice(start, start + length);
    start += length;
    blocks.push({ data: blockData, ecc: reedSolomonRemainder(blockData, divisor) });
  }
  const interleaved = [];
  for (let i = 0; i <= shortDataLength; i++) {
    for (const block of blocks) if (i < block.data.length) interleaved.push(block.data[i]);
  }
  for (let i = 0; i < eccLength; i++) for (const block of blocks) interleaved.push(block.ecc[i]);
  return interleaved;
}

const dataCodewordCount = (version, ecl) =>
  Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK[ecl.index][version - 1] * BLOCKS[ecl.index][version - 1];

// The modules left for data and error correction once the function patterns and the format and version information
// have theirs
function rawDataModules(version) {
  let modules = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignments = Math.floor(version / 7) + 2;
    modules -= (25 * alignments - 10) * alignments - 55;
    if (version >= 7) modules -= 36;
  }
  return modules;
}

// ---- Reed-Solomon over GF(256), the field's polynomial x⁸ + x⁴ + x³ + x² + 1

function reedSolomonDivisor(degree) {
  const divisor = new Array(degree).fill(0);
  divisor[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      divisor[j] = fieldMultiply(divisor[j], root);
      if (j + 1 < degree) divisor[j] ^= divisor[j + 1];
    }
    root = fieldMultiply(root, 2);
  }
  return divisor;
}

function reedSolomonRemainder(data, divisor) {
  const remainder = new Array(divisor.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder.shift();
    remainder.push(0);
    divisor.forEach((coefficient, i) => (remainder[i] ^= fieldMultiply(coefficient, factor)));
  }
  return remainder;
}

function fieldMultiply(x, y) {
  let product = 0;
  for (let i = 7; i >= 0; i--) {
    product = (product << 1) ^ ((product >>> 7) * 0x11d);
    product ^= ((y >>> i) & 1) * x;
  }
  return product;
}

// ---- the grid

function emptyGrid(version) {
  const size = version * 4 + 17;
  const rows = () => Array.from({ length: size }, () => new Array(size).fill(false));
  return { size, modules: rows(), reserved: rows() };
}

const setFunction = (grid, x, y, dark) => {
  grid.modules[y][x] = dark;
  grid.reserved[y][x] = true;
};

// The finders, the timing lines, the alignment patterns, the version information and the dark module. The format
// information's places are reserved here and drawn once the mask is chosen.
function drawFunctionPatterns(grid, version) {
  const { size } = grid;
  for (let i = 0; i < size; i++) {
    setFunction(grid, 6, i, i % 2 === 0);
    setFunction(grid, i, 6, i % 2 === 0);
  }
  for (const [x, y] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ]) {
    drawFinder(grid, x, y);
  }
  const centres = alignmentCentres(version, size);
  const last = centres.length - 1;
  centres.forEach((x, i) =>
    centres.forEach((y, j) => {
      const underFinder = (i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0);
      if (!underFinder) drawAlignment(grid, x, y);
    }),
  );
  drawFormatBits(grid, LEVELS.M, 0);
  drawVersionBits(grid, version);
}

// A 7 × 7 finder with its light separator, centred on (x, y)
function drawFinder(grid, x, y) {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const ring = Math.max(Math.abs(dx), Math.abs(dy));
      const [mx, my] = [x + dx, y + dy];
      if (mx >= 0 && mx < grid.size && my >= 0 && my < grid.size) setFunction(grid, mx, my, ring !== 2 && ring !== 4);
    }
  }
}

function drawAlignment(grid, x, y) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) setFunction(grid, x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
}

// Where alignment patterns centre, on both axes: 6, then evenly spaced up to size − 7
function alignmentCentres(version, size) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
  const centres = [6];
  for (let at = size - 7; centres.length < count; at -= step) centres.splice(1, 0, at);
  return centres;
}

// The level and the mask in 15 bits (a BCH code), twice: round the top left finder, and split between the other two
function drawFormatBits(grid, ecl, mask) {
  const data = (ecl.formatBits << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  const bits = ((data << 10) | remainder) ^ 0x5412;
  const bit = i => ((bits >>> i) & 1) === 1;
  const { size } = grid;
  for (let i = 0; i <= 5; i++) setFunction(grid, 8, i, bit(i));
  setFunction(grid, 8, 7, bit(6));
  setFunction(grid, 8, 8, bit(7));
  setFunction(grid, 7, 8, bit(8));
  for (let i = 9; i < 15; i++) setFunction(grid, 14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) setFunction(grid, size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) setFunction(grid, 8, size - 15 + i, bit(i));
  setFunction(grid, 8, size - 8, true);
}

// From version 7: the version in 18 bits (a Golay code), beside the top right and bottom left finders
function drawVersionBits(grid, version) {
  if (version < 7) return;
  let remainder = version;
  for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  const bits = (version << 12) | remainder;
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    const [across, down] = [grid.size - 11 + (i % 3), Math.floor(i / 3)];
    setFunction(grid, across, down, dark);
    setFunction(grid, down, across, dark);
  }
}

// The codewords' bits in two-module columns, from the bottom right, up then down, skipping the vertical timing line
function drawCodewords(grid, codewords) {
  const { size } = grid;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let step = 0; step < size; step++) {
      const y = upward ? size - 1 - step : step;
      for (const x of [right, right - 1]) {
        if (grid.reserved[y][x] || i >= codewords.length * 8) continue;
        grid.modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
        i++;
      }
    }
  }
}

// ---- the mask

function applyMask(grid, mask) {
  const flips = MASKS[mask];
  for (let y = 0; y < grid.size; y++) {
    for (let x = 0; x < grid.size; x++)
      if (!grid.reserved[y][x] && flips(x, y)) grid.modules[y][x] = !grid.modules[y][x];
  }
}

function bestMask(grid, ecl) {
  let best = { mask: 0, penalty: Infinity };
  for (let mask = 0; mask < MASKS.length; mask++) {
    applyMask(grid, mask);
    drawFormatBits(grid, ecl, mask);
    const score = penalty(grid);
    if (score < best.penalty) best = { mask, penalty: score };
    applyMask(grid, mask);
  }
  return best.mask;
}

// The standard's four penalty rules (section 7.8.3): runs of five or more, 2 × 2 blocks, finder look-alikes, and an
// uneven share of dark modules
const FINDER_LIKE = ['10111010000', '00001011101'];
function penalty(grid) {
  const { size, modules } = grid;
  const lines = [];
  for (let i = 0; i < size; i++) {
    lines.push(modules[i].map(Number).join(''));
    lines.push(modules.map(row => Number(row[i])).join(''));
  }
  let score = 0;
  for (const line of lines) {
    for (const run of line.match(/0{5,}|1{5,}/g) ?? []) score += run.length - 2;
    for (const look of FINDER_LIKE) {
      for (let at = line.indexOf(look); at >= 0; at = line.indexOf(look, at + 1)) score += 40;
    }
  }
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) dark++;
      if (x === size - 1 || y === size - 1) continue;
      const colour = modules[y][x];
      if (modules[y][x + 1] === colour && modules[y + 1][x] === colour && modules[y + 1][x + 1] === colour) score += 3;
    }
  }
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}
