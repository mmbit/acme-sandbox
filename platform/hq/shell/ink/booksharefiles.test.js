// node --test platform/hq/shell/ink/booksharefiles.test.js   (a shared page's file: its name and its PDF; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileName, pdfOf } from './booksharefiles.js';

// a JPEG's bytes as a reader sees them: its start and end markers round a little made-up middle
const JPEG = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0x0a, 0x65, 0x6e, 0x64, 0xff, 0xd9);
const read = bytes => Buffer.from(bytes).toString('latin1');

test("a file is named after its page's title and day, safe for any system", () => {
  assert.equal(fileName('For Kit', '2026-10-27', 'png'), 'For Kit 2026-10-27.png');
  assert.equal(fileName('Sketch: a/b  "shop"?', '2026-10-27', 'pdf'), 'Sketch a b shop 2026-10-27.pdf');
  assert.equal(fileName('', '2026-10-27', 'png'), 'Notebook page 2026-10-27.png');
  assert.equal(fileName(null, null, 'pdf'), 'Notebook page.pdf');
});

test('the PDF is one page the size asked, the JPEG embedded byte for byte and drawn over all of it', () => {
  const pdf = read(pdfOf({ jpeg: JPEG, imageW: 1400, imageH: 1600, pageW: 525, pageH: 600.333, title: 'For Kit' }));
  assert.ok(pdf.startsWith('%PDF-1.4\n'));
  assert.ok(pdf.endsWith('%%EOF\n'));
  assert.match(pdf, /\/Type \/Pages \/Kids \[3 0 R\] \/Count 1/);
  assert.match(pdf, /\/MediaBox \[0 0 525 600\.33\]/);
  assert.match(pdf, /\/Width 1400 \/Height 1600 .*\/Filter \/DCTDecode \/Length 13 >>\nstream\n/);
  const start = pdf.indexOf('stream\n', pdf.indexOf('/DCTDecode')) + 'stream\n'.length;
  assert.equal(pdf.slice(start, start + JPEG.length), read(JPEG), 'the picture as it was given');
  assert.equal(pdf.slice(start + JPEG.length, start + JPEG.length + 10), '\nendstream');
  assert.match(pdf, /stream\nq 525 0 0 600\.33 0 0 cm \/Im0 Do Q\nendstream/);
});

test("a reader finds every object where the PDF's table says, and the table where the file's end says", () => {
  const pdf = read(pdfOf({ jpeg: JPEG, imageW: 10, imageH: 10, pageW: 100, pageH: 100 }));
  const xref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(pdf)[1]);
  assert.ok(pdf.startsWith('xref\n0 7\n0000000000 65535 f \n', xref));
  const rows = pdf.slice(xref).split('\n').slice(3, 9);
  rows.forEach((row, i) => {
    assert.match(row, /^\d{10} 00000 n $/, 'each row 20 bytes, as a reader counts them');
    assert.ok(pdf.startsWith(`${i + 1} 0 obj\n`, Number(row.slice(0, 10))), `object ${i + 1} at its offset`);
  });
  const length = Number(/5 0 obj\n<< \/Length (\d+) >>\nstream\n/.exec(pdf)[1]);
  assert.match(pdf, new RegExp(`5 0 obj\\n<< /Length ${length} >>\\nstream\\n.{${length}}\\nendstream`));
});

test("the reader's window says the page's title, in any language", () => {
  const pdf = read(pdfOf({ jpeg: JPEG, imageW: 1, imageH: 1, pageW: 1, pageH: 1, title: 'Für Kit ✔ 🎉' }));
  const hex = /\/Title <FEFF([0-9A-F]*)>/.exec(pdf)[1];
  assert.equal(Buffer.from(hex, 'hex').swap16().toString('utf16le'), 'Für Kit ✔ 🎉');
  assert.match(pdf, /trailer\n<< \/Size 7 \/Root 1 0 R \/Info 6 0 R >>/);
});
