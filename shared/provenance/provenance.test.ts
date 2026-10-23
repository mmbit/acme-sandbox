// node --test shared/provenance/provenance.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { crc32 } from 'node:zlib';
import { AI_EDITED, isAiEdited, markAiEdited, NotAPictureError } from './provenance.ts';

// 8 × 8 pictures made with ImageMagick
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAIAAgDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAABv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AB4iU6//2Q==',
  'base64',
);
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAABlBMVEUwUMD////v/bm9AAAAAWJLR0QB/wIt3gAAAAd0SU1FB+oKEg4ENx3kWPAAAAALSURBVAjXY2BABQAAEAABocUhwQAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0xMC0xOFQxNDowNDo1NSswMDowMKE6WWEAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMTAtMThUMTQ6MDQ6NTUrMDA6MDDQZ+HdAAAAAElFTkSuQmCC',
  'base64',
);

const scanOf = (jpeg: Buffer) => jpeg.subarray(jpeg.indexOf(Buffer.from([0xff, 0xda])));
const pngChunks = (png: Buffer) => {
  const chunks = [];
  for (let i = 8; i < png.length; i += 12 + png.readUInt32BE(i)) {
    const length = png.readUInt32BE(i),
      typed = png.subarray(i + 4, i + 8 + length);
    chunks.push({ type: typed.toString('latin1', 0, 4), crcHolds: crc32(typed) === png.readUInt32BE(i + 8 + length) });
  }
  return chunks;
};

test('a marked JPEG carries the digital source type and the same scan', () => {
  const marked = markAiEdited(JPEG);
  assert.equal(isAiEdited(JPEG), false);
  assert.equal(isAiEdited(marked), true);
  assert.ok(marked.includes(AI_EDITED));
  assert.deepEqual(scanOf(marked), scanOf(JPEG));
});

test('marking twice leaves one mark', () => {
  const once = markAiEdited(JPEG);
  assert.deepEqual(markAiEdited(once), once);
  assert.deepEqual(markAiEdited(markAiEdited(PNG)), markAiEdited(PNG));
});

test("a JPEG's content credential goes, since the mark changes the bytes it signs", () => {
  const jumbf = Buffer.concat([Buffer.from([0xff, 0xeb, 0x00, 0x0c]), Buffer.from('JP\0\0\0\0c2pa', 'latin1')]);
  const signed = Buffer.concat([JPEG.subarray(0, 20), jumbf, JPEG.subarray(20)]);
  const marked = markAiEdited(signed);
  assert.equal(marked.includes(Buffer.from('c2pa', 'latin1')), false);
  assert.equal(isAiEdited(marked), true);
});

test('a marked PNG has the mark after its header and every chunk intact', () => {
  const marked = markAiEdited(PNG),
    chunks = pngChunks(marked);
  assert.equal(isAiEdited(marked), true);
  assert.deepEqual(
    chunks.slice(0, 2).map(c => c.type),
    ['IHDR', 'iTXt'],
  );
  assert.ok(chunks.every(c => c.crcHolds));
  assert.equal(chunks.at(-1)?.type, 'IEND');
});

test('anything but a JPEG or PNG is refused', () => {
  assert.throws(() => markAiEdited(Buffer.from('GIF89a')), NotAPictureError);
  assert.throws(() => markAiEdited(JPEG.subarray(0, 40)), NotAPictureError);
});

test('the command marks files in place and checks them', () => {
  const dir = mkdtempSync(`${tmpdir()}/provenance-`),
    file = `${dir}/photo.jpg`,
    script = new URL('./provenance.ts', import.meta.url).pathname;
  writeFileSync(file, JPEG);
  assert.throws(() => execFileSync('node', [script, '--check', file], { stdio: 'pipe' }));
  execFileSync('node', [script, file], { stdio: 'pipe' });
  assert.equal(isAiEdited(readFileSync(file)), true);
  assert.match(execFileSync('node', [script, '--check', file], { encoding: 'utf8' }), /marked as edited with AI/);
});
