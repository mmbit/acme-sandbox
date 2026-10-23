// node --test src/cardfiles.test.ts   (files on a desk-phone card, the real hq
// script against the real server, from hq ask --file to the board's download)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { harness } from './harness.ts';

const KEY = 'lm-key-0123456789abcdefghij';
const h = await harness('cardfiles', {
  before: () => {
    mkdirSync(process.env.SECRETS_DIR!, { recursive: true });
    writeFileSync(`${process.env.SECRETS_DIR}/CARE_EMAIL_API_KEY`, KEY);
  },
});
const cardFiles = await import('./cardfiles.ts');

const dir = mkdtempSync(`${tmpdir()}/cardfiles-job-`);
const write = (name: string, body: string | Buffer) => {
  writeFileSync(`${dir}/${name}`, body);
  return `${dir}/${name}`;
};
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
const download = (id: number, n: number, cookie = true) =>
  fetch(`${h.base}/api/requests/file?id=${id}&n=${n}`, { headers: cookie ? { cookie: h.boardCookie } : {} });

test('hq ask --file: the card lists each file by its name, the board downloads it as it was, a key in a text file is its name', async () => {
  const job = { ...(await h.start({ agent: 'dowser', title: 'Pages' })), dir };
  const page = `<!doctype html>\n<p>Over ons</p>\n<!-- ${KEY} -->\n`;
  const asked = await h.hq(
    job,
    'ask',
    'action',
    'today',
    'The fixed pages',
    write(
      'card.md',
      'Two pages to put in place.\n\nSteps:\n1. Download over-ons.html and put it in place of the old one.\n',
    ),
    '--file',
    write('over-ons.html', page),
    '--file',
    write('logo.png', PNG),
    '--topic',
    'site',
  );
  assert.equal(asked.code, 0, asked.out);
  const card = ((await h.board('/api/requests')).body as any[]).find(c => c.title === 'The fixed pages');
  assert.deepEqual(
    card.files.map((f: any) => [f.n, f.name, f.kept]),
    [
      [0, 'over-ons.html', true],
      [1, 'logo.png', true],
    ],
  );
  assert.equal(card.files[1].size, PNG.length);

  const html = await download(card.id, 0);
  assert.equal(html.status, 200);
  assert.equal(html.headers.get('content-type'), 'application/octet-stream');
  assert.match(html.headers.get('content-disposition')!, /^attachment; filename="over-ons\.html"/);
  assert.equal(html.headers.get('x-content-type-options'), 'nosniff');
  const text = await html.text();
  assert.ok(!text.includes(KEY) && text.includes('CARE_EMAIL_API_KEY'), 'the key is its name');
  assert.equal(card.files[0].size, Buffer.byteLength(text), 'its size as kept');
  assert.deepEqual(Buffer.from(await (await download(card.id, 1)).arrayBuffer()), PNG, 'a picture byte for byte');
  assert.equal((await download(card.id, 1, false)).status, 401, "behind the board's sign-in");
  assert.equal((await download(card.id, 2)).status, 404);

  // a month after the card closed, the names stay and the bytes go
  assert.equal((await h.board('/api/requests/answer', { id: card.id, answer: 'Done' })).status, 200);
  cardFiles.sweep(Date.now() + 31 * 86_400_000);
  const archived = ((await h.board('/api/requests/archive')).body.cards as any[]).find(c => c.id === card.id);
  assert.deepEqual(
    archived.files.map((f: any) => [f.name, f.kept]),
    [
      ['over-ons.html', false],
      ['logo.png', false],
    ],
  );
  assert.equal((await download(card.id, 0)).status, 404);
});

test('files the coordinator refuses: none on a card for keys, no folder in a name, not over the size, nor two of a name', async () => {
  const job = await h.start({ agent: 'dowser', title: 'More pages' });
  const file = (more: object) =>
    h.agent('request', job.token, {
      kind: 'action',
      title: 'Pages',
      body: 'A page to put in place.',
      topic: 'site',
      ...more,
    });
  const one = { name: 'a.html', data: Buffer.from('<p>a</p>').toString('base64') };
  assert.equal((await file({ kind: 'credential', secrets: 'A_KEY', files: [one] })).status, 400, 'not with keys');
  assert.match((await file({ files: [{ ...one, name: '../a.html' }] })).body.error, /no folder/);
  assert.match((await file({ files: [one, one] })).body.error, /same name/);
  assert.match(
    (await file({ files: [{ name: 'big.bin', data: Buffer.alloc(cardFiles.MAX_BYTES + 1).toString('base64') }] })).body
      .error,
    /MB in all/,
  );
  assert.match(
    (await file({ files: Array.from({ length: 9 }, (_, k) => ({ ...one, name: `${k}.html` })) })).body.error,
    /1 to 8 files/,
  );
  assert.equal((await file({ files: [one] })).status, 200);
});
