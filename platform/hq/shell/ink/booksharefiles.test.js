// node --test platform/hq/shell/ink/booksharefiles.test.js   (a shared page's file: its name, its PDF and a long one's pieces; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutsOf, fileName, pdfOf, piecesFor } from './booksharefiles.js';

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
  const pdf = read(pdfOf({ images: [{ jpeg: JPEG, w: 1400, h: 1600 }], pageW: 525, pageH: 600.333, title: 'For Kit' }));
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
  const pdf = read(pdfOf({ images: [{ jpeg: JPEG, w: 10, h: 10 }], pageW: 100, pageH: 100 }));
  const xref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(pdf)[1]);
  assert.ok(pdf.startsWith('xref\n0 7\n0000000000 65535 f \n', xref));
  const rows = pdf.slice(xref).split('\n').slice(3, 9);
  rows.forEach((row, i) => {
    assert.match(row, /^\d{10} 00000 n $/, 'each row 20 bytes, as a reader counts them');
    assert.ok(pdf.startsWith(`${i + 1} 0 obj\n`, Number(row.slice(0, 10))), `object ${i + 1} at its offset`);
  });
  const length = Number(/4 0 obj\n<< \/Length (\d+) >>\nstream\n/.exec(pdf)[1]);
  assert.match(pdf, new RegExp(`4 0 obj\\n<< /Length ${length} >>\\nstream\\n.{${length}}\\nendstream`));
});

test("the reader's window says the page's title, in any language", () => {
  const pdf = read(pdfOf({ images: [{ jpeg: JPEG, w: 1, h: 1 }], pageW: 1, pageH: 1, title: 'Für Kit ✔ 🎉' }));
  const hex = /\/Title <FEFF([0-9A-F]*)>/.exec(pdf)[1];
  assert.equal(Buffer.from(hex, 'hex').swap16().toString('utf16le'), 'Für Kit ✔ 🎉');
  assert.match(pdf, /trailer\n<< \/Size 7 \/Root 1 0 R \/Info 5 0 R >>/);
});

test("a long page's pictures go down the one page in order, each over its share of it, none left out", () => {
  const images = [
    { jpeg: JPEG, w: 1000, h: 4000 },
    { jpeg: JPEG, w: 1000, h: 1000 },
  ];
  const pdf = read(pdfOf({ images, pageW: 375, pageH: 1875 }));
  assert.match(pdf, /\/Count 1/);
  assert.match(pdf, /\/XObject << \/Im0 6 0 R \/Im1 7 0 R >>/);
  assert.match(pdf, /stream\nq 375 0 0 1500 0 375 cm \/Im0 Do Q\nq 375 0 0 375 0 0 cm \/Im1 Do Q\nendstream/);
  assert.match(pdf, /6 0 obj\n<< .*\/Width 1000 \/Height 4000 /);
  assert.match(pdf, /7 0 obj\n<< .*\/Width 1000 \/Height 1000 /);
});

test('a long page goes in pieces at most half again as tall as wide, each repeating a strip of the one before', () => {
  assert.deepEqual(
    [piecesFor(800, 600), piecesFor(600, 900), piecesFor(600, 2400), piecesFor(300, 9000)],
    [1, 1, 3, 6],
  );
  assert.deepEqual(cutsOf(1, 1000), [{ top: 0, height: 1000 }]);
  assert.deepEqual(cutsOf(3, 4800), [
    { top: 0, height: 1600 },
    { top: 1540, height: 1660 },
    { top: 3140, height: 1660 },
  ]);
});
