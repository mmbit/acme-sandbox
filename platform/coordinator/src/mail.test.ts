// node --test src/mail.test.ts   (the test company, with a test token for the mail Worker)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { harness } from './harness.ts';
import { commitFile, git } from './fixture.ts';

const TOKEN = 'mail-worker-test-token-0123456789';
let BRAND = '', BRAND_TEXT = '', ORG = '', ORG_TEXT = '';
const withBrandMail = (settings: string) => writeFileSync(BRAND, BRAND_TEXT.replace(/^mail: \{ domain: testco\.example \}/m, `mail: { domain: testco.example, ${settings} }`));
const h = await harness('mail', { before: repo => {
  commitFile('infra/mail/token.sha256', createHash('sha256').update(TOKEN).digest('hex'), "Email: rotate the inbox Worker's token");
  BRAND = `${repo}/company/brand.yaml`; BRAND_TEXT = readFileSync(BRAND, 'utf8');
  ORG = `${repo}/company/org.yaml`; ORG_TEXT = readFileSync(ORG, 'utf8');
} });
const { db, base, repo } = h;
const mail = await import('./mail.ts');
const storage = await import('./storage.ts');
storage.FLOOR.bytes = 0;   // (attachments are kept whatever this machine's disk has free: a test that wants the floor sets it)
// HQ's Mail, as the board reads it: a mail (or 404), and an attachment's download
const one = async (id: number) => { const r = await h.board(`/api/mail/one?id=${id}`); return r.status === 200 ? r.body : r.status; };
const download = (path: string) => fetch(base + path, { headers: { cookie: h.boardCookie } });
// hq mail, as a job of an agent who reads both kinds of mail (Penny, in the fixture) runs it, with the job's own TMPDIR
const JOB_TMP = mkdtempSync(`${tmpdir()}/mail-jobtmp-`);
after(() => rmSync(JOB_TMP, { recursive: true, force: true }));
const reader = { ...await h.start({ agent: 'penny', title: 'Read the inbox' }), tmp: JOB_TMP };
const read = (path: string) => h.agent(path, reader.token);
const saved = async (id: number, n: number | string) => { const r = await read(`mail-file?id=${id}&n=${n}`); return r.status === 200 ? Buffer.from(r.body.data, 'base64') : r.status; };

// A PDF (base64, as mail clients send it), a small binary file sent as-is, and a named text file.
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from([0, 1, 2, 0xff, 0xfe, 13, 10, 13, 10]), Buffer.from('\n%%EOF\n')]);
const BIN = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const message = (extra = '') => Buffer.concat([Buffer.from([
  'From: Board <board@example.com>', 'To: documents@testco.example', 'Subject: Signed DPA', 'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="b1"', '', '--b1', 'Content-Type: multipart/alternative; boundary="b2"', '',
  '--b2', 'Content-Type: text/plain; charset=utf-8', '', 'Here is the signed agreement.', '--b2--', '',
  '--b1', 'Content-Type: application/pdf; name="=?utf-8?Q?Verwerkers=C3=B6vereenkomst_(signed).pdf?="', 'Content-Disposition: attachment',
  'Content-Transfer-Encoding: base64', '', PDF.toString('base64').replace(/(.{20})/g, '$1\r\n'), '',
  '--b1', 'Content-Type: application/octet-stream', 'Content-Disposition: attachment; filename="../../etc/passwd"', 'Content-Transfer-Encoding: binary', '', '',
].join('\r\n'), 'latin1'), BIN, Buffer.from(`\r\n${extra}--b1--\r\n`, 'latin1')]);
const inbound = (body: Buffer, token = TOKEN, to = 'documents@testco.example', from = 'board@example.com') => fetch(`${base}/api/mail/inbound`, { method: 'POST', body,
  headers: { authorization: `Bearer ${token}`, 'content-type': 'message/rfc822', 'x-mail-from': from, 'x-mail-to': to } });
const to = async (address: string, body = message()) => (await (await inbound(body, TOKEN, address)).json()).id as number;
// HQ started again: mail.ts sorts the mail it already has by the brand's lists as it loads (each query a fresh copy)
let restarts = 0;
const restart = () => import(`./mail.ts?restart=${++restarts}`);

test('attachments are kept as numbered files, byte for byte, and listed with their names', async () => {
  assert.equal((await inbound(message(), 'wrong-token-but-long-enough-000')).status, 401);
  const { id } = await (await inbound(message())).json();
  const m = await one(id);
  assert.equal(m.body, 'Here is the signed agreement.');
  assert.deepEqual(JSON.parse(m.attachments), [
    { name: 'Verwerkersövereenkomst (signed).pdf', type: 'application/pdf', size: PDF.length },
    { name: '../../etc/passwd', type: 'application/octet-stream', size: BIN.length },
  ]);
  assert.deepEqual(readdirSync(`${mail.FILES}/${id}`).sort(), ['0', '1']); // the sender's name is never a path
  assert.equal((await read(`mail-file?id=${id}&n=0`)).body.name, 'Verwerkersövereenkomst (signed).pdf');
  assert.deepEqual(await saved(id, 0), PDF);
  assert.deepEqual(await saved(id, 1), BIN);
  for (const n of [2, -1, 0.5, NaN]) assert.equal(await saved(id, n), 404);
  assert.equal(await saved(id + 1, 0), 404);
});

test('HQ serves an attachment to the board only, always as a download that never runs on HQ\'s origin', async () => {
  const { id } = await (await inbound(message())).json();
  assert.equal((await fetch(`${base}/api/mail/file?id=${id}&n=0`)).status, 401);
  const pdf = await download(`/api/mail/file?id=${id}&n=0`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.match(pdf.headers.get('content-disposition')!, /^attachment; filename="Verwerkers_vereenkomst _signed_.pdf"; filename\*=UTF-8''Verwerkers%C3%B6vereenkomst%20%28signed%29.pdf$/);
  assert.equal(pdf.headers.get('x-content-type-options'), 'nosniff');
  assert.match(pdf.headers.get('content-security-policy')!, /sandbox/);
  assert.deepEqual(Buffer.from(await pdf.arrayBuffer()), PDF);
  const bin = await download(`/api/mail/file?id=${id}&n=1`);
  assert.equal(bin.headers.get('content-type'), 'application/octet-stream');
  assert.match(bin.headers.get('content-disposition')!, /filename="\.\._\.\._etc_passwd"/);
  assert.equal((await download(`/api/mail/file?id=${id}&n=7`)).status, 404);
});

test('a file named .pdf that isn\'t one is served as bytes, not as a PDF; older mail (names only) has no files', async () => {
  const body = Buffer.from(['From: x@example.com', 'To: invoices@testco.example', 'Subject: Invoice', 'Content-Type: multipart/mixed; boundary=z', '',
    '--z', 'Content-Type: text/plain', '', 'See attached.', '--z', 'Content-Type: application/pdf', 'Content-Disposition: attachment; filename=invoice.pdf',
    'Content-Transfer-Encoding: base64', '', Buffer.from('<html><script>alert(1)</script>').toString('base64'), '--z--', ''].join('\r\n'));
  const { id } = await (await inbound(body)).json();
  assert.equal((await download(`/api/mail/file?id=${id}&n=0`)).headers.get('content-type'), 'application/octet-stream');
  const old = Number(db.prepare("insert into mail (received, sender, recipient, subject, body, attachments, size) values ('2026-09-01', 'a', 'b', 'c', 'd', ?, 1)")
    .run(JSON.stringify(['old.pdf'])).lastInsertRowid);
  assert.equal(await saved(old, 0), 404);
  assert.ok(!existsSync(`${mail.FILES}/${old}`));
});

// A message with these files attached, base64 in 76-character lines as mail clients send them.
const withFiles = (files: { name: string, type: string, bytes: Buffer }[]) => Buffer.from([
  'From: someone@example.com', 'To: hello@testco.example', 'Subject: Photos', 'Content-Type: multipart/mixed; boundary="p"', '',
  '--p', 'Content-Type: text/plain; charset=utf-8', '', 'My poster arrived bent, photos attached.',
  ...files.flatMap(f => ['--p', `Content-Type: ${f.type}; name="${f.name}"`, `Content-Disposition: attachment; filename="${f.name}"`,
    'Content-Transfer-Encoding: base64', '', f.bytes.toString('base64').replace(/(.{76})/g, '$1\r\n')]),
  '--p--', ''].join('\r\n'));
const random = (head: string, size: number) => { const b = Buffer.alloc(size); for (let i = 0; i < size; i++) b[i] = (i * 7919 + (i >> 9)) & 0xff; b.write(head, 'latin1'); return b; };

test('a 3 MB signed PDF and phone photos (JPEG, HEIC) arrive whole, well past the old 10 MB and 2 MB limits', async () => {
  const files = [
    { name: 'DPA signed.pdf', type: 'application/pdf', bytes: random('%PDF-1.7\n', 3 * 1024 * 1024) },
    { name: 'IMG_0412.JPG', type: 'image/jpeg', bytes: random('\xff\xd8\xff\xe1', 4 * 1024 * 1024) },
    { name: 'IMG_0413.HEIC', type: 'image/heic', bytes: random('\0\0\0\x18ftypheic', 3 * 1024 * 1024) },
  ];
  const body = withFiles(files);
  assert.ok(body.length > 13 * 1024 * 1024);
  const res = await inbound(body, TOKEN, 'hello@testco.example');
  assert.equal(res.status, 200);
  const { id } = await res.json(), m = await one(id);
  assert.equal(m.body, 'My poster arrived bent, photos attached.');
  assert.deepEqual(JSON.parse(m.attachments).map((a: any) => [a.name, a.type, a.size]), files.map(f => [f.name, f.type, f.bytes.length]));
  for (const [n, f] of files.entries()) assert.deepEqual(await saved(id, n), f.bytes, f.name);
  const big = Buffer.concat([body, Buffer.alloc(12 * 1024 * 1024, 'A')]); // past Cloudflare's own 25 MiB: never kept in part
  assert.equal((await inbound(big, TOKEN, 'hello@testco.example')).status, 413);
});

test('a mail with thirty photos keeps every one', async () => {
  const files = Array.from({ length: 30 }, (_, n) => ({ name: `IMG_${n}.JPG`, type: 'image/jpeg', bytes: random('\xff\xd8\xff\xe1', 1024 + n) }));
  const { id } = await (await inbound(withFiles(files), TOKEN, 'hello@testco.example')).json();
  assert.deepEqual(JSON.parse((await one(id)).attachments).map((a: any) => a.name), files.map(f => f.name));
  assert.deepEqual(await saved(id, 29), files[29].bytes);
});

test('customer mail loses its attachments after ATTACHMENT_DAYS; invoices@ and documents@ keep them', async () => {
  const photo = [{ name: 'bent.jpg', type: 'image/jpeg', bytes: random('\xff\xd8\xff', 5000) }];
  const ids: Record<string, number> = {};
  for (const to of ['care@testco.example', 'my-invoices@testco.example', 'invoices@testco.example', 'Documents@testco.example', 'recent@testco.example'])
    ids[to] = (await (await inbound(withFiles(photo), TOKEN, to)).json()).id;
  const old = new Date(Date.now() - (mail.ATTACHMENT_DAYS + 1) * 864e5).toISOString();
  // (time moving on: no route ages a mail)
  db.prepare(`update mail set received = ? where id in (${Object.values(ids).slice(0, 4).join(',')})`).run(old);
  mail.sweep();
  mail.sweep(); // twice: a swept row is left alone
  for (const to of ['care@testco.example', 'my-invoices@testco.example']) {
    const m = await one(ids[to]);
    assert.deepEqual(JSON.parse(m.attachments), ['bent.jpg']); // HQ and `hq mail` show the name, "not stored"
    assert.ok(!existsSync(`${mail.FILES}/${ids[to]}`));
    assert.equal(await saved(ids[to], 0), 404);
    assert.equal(m.body, 'My poster arrived bent, photos attached.'); // the text stays
  }
  for (const to of ['invoices@testco.example', 'Documents@testco.example', 'recent@testco.example']) assert.deepEqual(await saved(ids[to], 0), photo[0].bytes, to);
});

test('customer mail goes altogether after MESSAGE_DAYS; invoices@, documents@ and newer mail stay', async () => {
  const photo = [{ name: 'bent.jpg', type: 'image/jpeg', bytes: random('\xff\xd8\xff', 5000) }];
  const ids: Record<string, number> = {};
  for (const to of ['hello@testco.example', 'invoices@testco.example', 'Documents@testco.example', 'recent@testco.example'])
    ids[to] = (await (await inbound(withFiles(photo), TOKEN, to)).json()).id;
  const old = new Date(Date.now() - (mail.MESSAGE_DAYS + 1) * 864e5).toISOString();
  db.prepare(`update mail set received = ? where id in (${Object.values(ids).slice(0, 3).join(',')})`).run(old);   // (time moving on)
  mail.sweep();
  const exists = async (id: number) => await one(id) !== 404;
  assert.ok(!await exists(ids['hello@testco.example']));
  assert.ok(!existsSync(`${mail.FILES}/${ids['hello@testco.example']}`));
  for (const to of ['invoices@testco.example', 'Documents@testco.example', 'recent@testco.example']) assert.ok(await exists(ids[to]), to);
  assert.ok(existsSync(`${mail.FILES}/${ids['invoices@testco.example']}`));
});

test('mail at a domain added later (mail.also) is kept by its address from the next start; the address decides', async () => {
  const invoice = await to('invoices@old.example'), agreement = await to('Board <documents@old.example>');
  assert.deepEqual([(await one(invoice)).keep, (await one(agreement)).keep], [null, null]); // not ours yet
  withBrandMail('also: [old.example]');
  try {
    await restart();
    assert.deepEqual([(await one(invoice)).keep, (await one(agreement)).keep], ['invoices', 'documents']);
  } finally { writeFileSync(BRAND, BRAND_TEXT); }
  assert.equal((await one(await to('my-invoices@testco.example'))).keep, null);
  assert.equal((await one(await to('invoices@testco.example, documents@testco.example'))).keep, 'documents'); // no automatic end wins
});

test('a mail id is never given again: a deleted mail\'s isn\'t handed out again', async () => {
  const top = await to('case-3877@testco.example');
  assert.deepEqual(mail.forget([top]), [top]);
  assert.ok(await to('case-3877@testco.example') > top, "the newest one's id, once it's gone, isn't handed out again");
});

test('an invoice goes altogether after INVOICE_DAYS (row, raw copy and files); an agreement never goes by itself', async () => {
  const photo = [{ name: 'invoice.pdf', type: 'application/pdf', bytes: random('%PDF-1.7\n', 5000) }];
  const ids: Record<string, number> = {};
  for (const to of ['invoices@testco.example', 'documents@testco.example', 'Invoices@testco.example'])
    ids[to] = (await (await inbound(withFiles(photo), TOKEN, to)).json()).id;
  assert.deepEqual(await Promise.all(Object.values(ids).map(async id => (await one(id)).keep)), ['invoices', 'documents', 'invoices']);
  const old = new Date(Date.now() - (mail.INVOICE_DAYS + 1) * 864e5).toISOString();
  db.prepare(`update mail set received = ? where id in (${ids['invoices@testco.example']}, ${ids['documents@testco.example']})`).run(old);   // (time moving on)
  mail.sweep();
  assert.equal(await one(ids['invoices@testco.example']), 404);
  assert.ok(!existsSync(`${mail.FILES}/${ids['invoices@testco.example']}`));
  for (const to of ['documents@testco.example', 'Invoices@testco.example']) {
    assert.deepEqual(await saved(ids[to], 0), photo[0].bytes, to);
  }
});

test('an invoice or an agreement keeps its raw message whole past 2 MB in the table; customer mail doesn\'t', async () => {
  const files = [{ name: 'signed.pdf', type: 'application/pdf', bytes: random('%PDF-1.7\n', 3 * 1024 * 1024) }];
  for (const [to, whole] of [['documents@testco.example', true], ['invoices@testco.example', true], ['hello@testco.example', false]] as const) {
    const body = withFiles(files);
    const { id } = await (await inbound(body, TOKEN, to)).json();
    const row = db.prepare('select raw from mail where id = ?').get(id) as { raw: Uint8Array | null };
    assert.equal(!!row.raw && Buffer.from(row.raw).equals(body), whole, to);
  }
});

test('a mail\'s subject never reaches the events log', async () => {
  const body = Buffer.from(['From: jane@example.com', 'To: hello@testco.example', 'Subject: Order #5678 arrived bent - Jane Doe', '', 'Hello'].join('\r\n'));
  const id = await to('hello@testco.example', body), feed = await h.feed();
  assert.ok(feed.some(e => e.text.startsWith(`Mail #${id} `)));
  assert.ok(!feed.some(e => /Jane Doe|#5678/.test(e.text)));
});

test('a boundary inside a line of a file sent as it is doesn\'t cut the file short', async () => {
  const file = Buffer.from('first--b1middle\r\n--b1x is not a boundary either\r\nlast line\r\n');
  const body = Buffer.concat([Buffer.from(['From: x@example.com', 'To: documents@testco.example', 'Subject: Raw', 'Content-Type: multipart/mixed; boundary=b1', '',
    '--b1', 'Content-Type: text/plain', '', 'Attached.', '--b1', 'Content-Type: application/octet-stream', 'Content-Disposition: attachment; filename=raw.bin',
    'Content-Transfer-Encoding: binary', '', ''].join('\r\n')), file, Buffer.from('\r\n--b1--\r\n')]);
  const { id } = await (await inbound(body)).json();
  assert.equal((await one(id)).body, 'Attached.');
  assert.deepEqual(await saved(id, 0), file);
});

test('once mail files would pass their cap, or the disk run low, a message with attachments is refused whole for the Worker to hold', async () => {
  const cap = mail.STORAGE.maxStored;
  const before = (await (await inbound(message())).json()).id;
  const refusals = async () => (await h.feed()).filter(e => e.text.startsWith('Mail refused:')).length;
  const notices = await refusals();
  try {
    mail.STORAGE.maxStored = 0;
    assert.equal((await inbound(message())).status, 507);
    mail.STORAGE.maxStored = cap;
    storage.FLOOR.bytes = Number.MAX_SAFE_INTEGER;
    assert.equal((await inbound(message())).status, 507);
    assert.equal(await refusals(), notices + 1, 'one notice while Mail keeps refusing');
  } finally { mail.STORAGE.maxStored = cap; storage.FLOOR.bytes = 0; }
  const after = (await (await inbound(message())).json()).id;
  assert.equal(after, before + 1, 'nothing of either refused message is kept');
  assert.ok(existsSync(`${mail.FILES}/${after}/0`));
  try {
    mail.STORAGE.maxStored = 0;
    assert.equal((await inbound(message())).status, 507);
    assert.equal(await refusals(), notices + 2, 'storing attachments ends the refusal spell');
  } finally { mail.STORAGE.maxStored = cap; }
});

test('a mail\'s files are charged their blocks and inodes, its folder too, and two at once can\'t share the room', async () => {
  const cap = mail.STORAGE.maxStored, { bsize, perInode } = storage.shape();
  // what Mail holds now, as room() counts it: the least cap it still fits under
  const holds = () => {
    let held = 0;
    for (let high = 2 ** 40; held < high;) {
      mail.STORAGE.maxStored = Math.floor((held + high) / 2);
      if (mail.room({ files: [] })) high = mail.STORAGE.maxStored; else held = mail.STORAGE.maxStored + 1;
    }
    return held;
  };
  const deliver = (files: { name: string, type: string, bytes: Buffer }[]) => inbound(withFiles(files), TOKEN, 'hello@testco.example');
  const files = Array.from({ length: 200 }, (_, n) => ({ name: `part-${n}.txt`, type: 'text/plain', bytes: Buffer.alloc(n === 0 ? bsize : n % 2, 65 + n % 26) }));
  const charge = storage.charged({ files: files.map(f => f.bytes.length), folders: 1 });
  try {
    let held = holds();
    mail.STORAGE.maxStored = held + 101 * bsize;   // (a block and 100 bytes, in 101 files' blocks and a folder's)
    assert.equal((await deliver(files)).status, 507, 'their bytes fit, their blocks and folder do not');
    mail.STORAGE.maxStored = held + charge;
    const { id } = await (await deliver(files)).json();
    assert.deepEqual(await saved(id, 199), files[199].bytes);
    held = holds();
    mail.STORAGE.maxStored = held + charge;
    const both = await Promise.all([deliver(files), deliver(files)]);
    assert.deepEqual(both.map(r => r.status).sort(), [200, 507], 'room for one, so only one goes in');
    if (perInode) {   // (a filesystem that counts inodes)
      mail.STORAGE.maxStored = holds() + 2 * bsize;
      const empty = Array.from({ length: 1000 }, (_, n) => ({ name: `empty-${n}`, type: 'text/plain', bytes: Buffer.alloc(0) }));
      assert.equal((await deliver(empty)).status, 507, 'empty files take no blocks, but an inode each');
    }
  } finally { mail.STORAGE.maxStored = cap; }
});

test('the mail Worker keeps a held message HQ has no room for, and hands over the held mail behind it', async () => {
  const { default: emailWorker } = await import('../../../infra/mail/worker.js');
  const store = new Map<string, { value: ArrayBuffer; metadata: unknown }>();
  const HELD = {
    list: async ({ cursor }: { cursor?: string } = {}) => {
      const names = [...store.keys()].sort().filter(name => !cursor || name > cursor);
      return { keys: names.slice(0, 1).map(name => ({ name })), list_complete: names.length <= 1, cursor: names[0] };
    },
    getWithMetadata: async (name: string) => store.get(name) ?? { value: null, metadata: null },
    delete: async (name: string) => { store.delete(name); },
  };
  const held = (key: string, raw: Buffer) =>
    store.set(key, { value: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length) as ArrayBuffer, metadata: { from: 'board@example.com', to: 'documents@testco.example' } });
  held('1-with-files', message());
  held('2-plain', Buffer.from('From: board@example.com\r\nTo: documents@testco.example\r\nSubject: Words only\r\n\r\nJust words.'));
  const cap = mail.STORAGE.maxStored;
  try {
    mail.STORAGE.maxStored = 0;
    await emailWorker.scheduled({}, { HQ_ORIGIN: base, MAIL_TOKEN: TOKEN, HELD });
  } finally { mail.STORAGE.maxStored = cap; }
  assert.deepEqual([...store.keys()], ['1-with-files'], 'the plain one went; the one with files waits for room');
  await emailWorker.scheduled({}, { HQ_ORIGIN: base, MAIL_TOKEN: TOKEN, HELD });
  assert.equal(store.size, 0, 'with room again it goes too');
});

test('parts nested past MAX_DEPTH are dropped, and a deep mail parses quickly without a copy per level', async () => {
  const nest = (depth: number, inner: string): string => depth === 0 ? inner
    : `Content-Type: multipart/mixed; boundary="n${depth}"\r\n\r\n--n${depth}\r\n${nest(depth - 1, inner)}\r\n--n${depth}--\r\n`;
  const leaf = 'Content-Type: text/plain\r\nContent-Disposition: attachment; filename=deep.txt\r\n\r\nhello';
  const shallow = Buffer.from(`From: x@example.com\r\nTo: documents@testco.example\r\nSubject: Deep\r\n${nest(9, leaf)}`);
  assert.deepEqual(JSON.parse((await one((await (await inbound(shallow)).json()).id)).attachments).map((a: any) => a.name), ['deep.txt']);
  const deep = Buffer.from(`From: x@example.com\r\nTo: documents@testco.example\r\nSubject: Deep\r\n${nest(2000, leaf)}`);
  const t = Date.now(), r = await inbound(deep);
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse((await one((await r.json()).id)).attachments), []);
  assert.ok(Date.now() - t < 2000);
});

test('an HTML mail reads as text with its links, and a hostile one (unclosed "<", comments, links, scripts) is read in one pass', async () => {
  const html = (body: string) => Buffer.from(['From: x@example.com', 'To: hello@testco.example', 'Subject: hi', 'Content-Type: text/html; charset=utf-8', '', body].join('\r\n'));
  const { id } = await (await inbound(html('<html><head><style>p{}</style></head><body><p>Hello&nbsp;<b>there</b></p><!-- x --><script>alert(1)</script>' +
    '<a href="https://ex.com/c">Confirm</a> or <A HREF="https://ex.com/d">https://ex.com/d</A><br>a &lt; b</body></html>'))).json();
  assert.equal((await one(id)).body, 'Hello there\nConfirm [https://ex.com/c] or https://ex.com/d\na < b');
  // lower-casing İ makes the string longer: the closing tag is found in the mail itself, never at a shifted index
  const { id: id2 } = await (await inbound(html('<title>' + 'İ'.repeat(40) + '</title><script>x</SCRIPT>BODY'))).json();
  assert.equal((await one(id2)).body, 'İ'.repeat(40) + 'BODY');
  // Each of these took time by the square of its length (200 KB of "<": 32 s, the whole coordinator frozen; 25 MB: days)
  for (const unit of ['<', '<!--', '<a ', '<script>', '<a href=http:x>']) {
    const t = Date.now(), r = await inbound(html(unit.repeat(Math.floor(2_000_000 / unit.length))), TOKEN, 'hello@testco.example');
    assert.equal(r.status, 200);
    assert.ok(Date.now() - t < 5_000, `${unit}: ${Date.now() - t} ms`);
  }
});

test("a welcome mail's padded preview text: every entity decoded, the invisible padding gone, in both parts", async () => {
  // as a big sender writes it: a hidden preheader padded to fill the inbox's preview line, in the HTML and the plain part
  const pad = '&nbsp;&zwnj;&shy;'.repeat(90) + '&#847; &#8199;&#65279;'.repeat(40), plainPad = '\u00a0\u200c\u00ad'.repeat(90) + '\u034f \u2007\ufeff'.repeat(40);
  const html = '<!doctype html><html><head><style>.h{display:none}</style></head><body>' +
    `<div class="h" style="display:none;max-height:0;overflow:hidden">Your account is ready${pad}</div>` +
    '<table><tr><td><h1>Welcome, Sam</h1></td></tr><tr><td><p>Sign in &rarr; <a href="https://ex.com/start?a=1&amp;copy=2&lang=nl">Get started</a></p>' +
    '<p>Pro&shy;tect your ac&shy;count &middot; 2&times;faster &bull; &frac12; done&hellip;</p><p>&#x1F468;&zwj;&#x1F469;&zwj;&#x1F467; welcome &copy; 2026</p></td></tr></table></body></html>';
  const plain = `Your account is ready${plainPad}\r\n${plainPad}\r\n\r\n\r\nWelcome, Sam\r\nSign in: https://ex.com/start\r\n  Pro\u00adtect your account\u200b\u200b. 👨‍👩‍👧\r\n`;
  const mail = (parts: string[][]) => Buffer.from(['From: x@example.com', 'To: hello@testco.example', 'Subject: Welcome', 'Content-Type: multipart/alternative; boundary=w', '',
    ...parts.flatMap(([type, body]) => ['--w', `Content-Type: ${type}; charset=utf-8`, '', body]), '--w--', ''].join('\r\n'));
  const { id } = await (await inbound(mail([['text/html', html]]))).json();
  assert.equal((await one(id)).body, 'Your account is ready\nWelcome, Sam\n\nSign in → Get started [https://ex.com/start?a=1&copy=2&lang=nl]\n' +
    'Protect your account · 2×faster • ½ done…\n👨‍👩‍👧 welcome © 2026');
  // a plain part as long as the HTML's text: read as it is, its own indent kept
  const { id: id2 } = await (await inbound(mail([['text/plain', plain], ['text/html', html]]))).json();
  assert.equal((await one(id2)).body, 'Your account is ready\n\nWelcome, Sam\nSign in: https://ex.com/start\n  Protect your account. 👨‍👩‍👧');
  // a joiner that joins stays: after a virama in Sinhala, Malayalam and Devanagari
  const indic = 'ශ්\u200dරී ക്\u200dഷ क्\u200cष', { id: id3 } = await (await inbound(mail([['text/plain', indic]]))).json();
  assert.equal((await one(id3)).body, indic);
  // two million plain spaces are read in one pass: a mail is outside input
  const t = Date.now(), r = await inbound(mail([['text/plain', ' '.repeat(2_000_000) + 'x'], ['text/html', ' '.repeat(2_000_000) + '\u200b']]));
  assert.equal(r.status, 200);
  assert.ok(Date.now() - t < 5_000, `${Date.now() - t} ms`);
});

test('RFC 2231 names are decoded and joined, and a long name is cut by characters, not UTF-16 units', async () => {
  const message = (disposition: string) => Buffer.from(['From: x@example.com', 'To: documents@testco.example', 'Subject: Names', 'Content-Type: multipart/mixed; boundary=b1', '',
    '--b1', 'Content-Type: application/octet-stream; name="fallback.bin"', `Content-Disposition: ${disposition}`, '', 'x', '--b1--', ''].join('\r\n'), 'latin1');
  const named = async (disposition: string) => JSON.parse((await one((await (await inbound(message(disposition))).json()).id)).attachments)[0].name;
  assert.equal(await named("attachment; filename*=UTF-8''%E2%82%AC%20invoice.pdf"), '€ invoice.pdf');
  assert.equal(await named("attachment; filename*=iso-8859-1'en'caf%E9.pdf"), 'café.pdf');
  assert.equal(await named("attachment;\r\n filename*0*=UTF-8''Verwerkers%C3%B6;\r\n filename*1=\"vereenkomst \";\r\n filename*2*=%28signed%29.pdf"), 'Verwerkersövereenkomst (signed).pdf');
  assert.equal(await named('attachment; filename="a;b.pdf"'), 'a;b.pdf');
  assert.equal(await named("attachment; filename*=UTF-8''%E2%80%AEfdp.exe"), '_fdp.exe'); // a bidi override, decoded, is still cleaned
  const long = await named(`attachment; filename="${'a'.repeat(199)}=?utf-8?B?${Buffer.from('😀.jpg').toString('base64')}?="`);
  assert.equal(long, 'a'.repeat(199) + '😀');
  const { id } = await (await inbound(message(`attachment; filename="${'a'.repeat(199)}=?utf-8?B?${Buffer.from('😀.jpg').toString('base64')}?="`))).json();
  assert.equal((await download(`/api/mail/file?id=${id}&n=0`)).status, 200); // the download's name encodes
});

// `hq mail <id>` itself, as an agent runs it, against this server, with the job's own TMPDIR.
const hq = async (id: number) => (await h.hq(reader, 'mail', String(id))).out;
const savedTo = (out: string) => [...out.matchAll(/ → (\S+)$/gm)].map(m => m[1]);

test('a sender\'s attachment name can\'t make `hq mail` write, truncate or delete anything outside its own new folder', async () => {
  const outside = mkdtempSync(`${tmpdir()}/mail-victim-`), victim = `${outside}/victim-x`;
  writeFileSync(victim, 'keep');
  // A newline, a tab and a number of the sender's choosing: "../../<outside>/victim" (truncated, then deleted on a 404) and
  // ".../w&n=0" (the server would read n=0 and send real bytes). Encoded-word names decode to anything.
  const evil = (n: string) => `a\n${n}\tx\n-\tfake (not stored)\n`;
  const names = [evil(`../..${outside}/victim`), evil(`../..${outside}/w&n=0`)];
  const encoded = (s: string) => `=?utf-8?B?${Buffer.from(s).toString('base64')}?=`;
  const body = withFiles(names.map(n => ({ name: encoded(n), type: 'text/plain', bytes: Buffer.from('attacker bytes') })));
  const { id } = await (await inbound(body, TOKEN, 'care@testco.example')).json();
  // stored clean: no control characters in the names HQ and hq show
  for (const a of JSON.parse((await one(id)).attachments)) assert.doesNotMatch(a.name, /[\p{Cc}\p{Cf}]/u);
  // and a row stored before that, with the raw names, is safe in hq too
  const old = Number(db.prepare("insert into mail (received, sender, recipient, subject, body, attachments, size) values (?, 'x', 'care@testco.example', 's', 'b', ?, 1)")
    .run(new Date().toISOString(), JSON.stringify(names.map(name => ({ name, type: 'text/plain', size: 14 })))).lastInsertRowid);
  mkdirSync(`${mail.FILES}/${old}`, { recursive: true });
  names.forEach((_, n) => writeFileSync(`${mail.FILES}/${old}/${n}`, 'attacker bytes'));
  try {
    for (const m of [id, old]) {
      const out = await hq(m), files = savedTo(out), dir = files[0].slice(0, files[0].lastIndexOf('/'));
      assert.match(dir, new RegExp(`^${JOB_TMP}/mail-${m}\\.[A-Za-z0-9]{6}$`));
      assert.deepEqual(files.map(f => f.slice(0, f.lastIndexOf('/'))), [dir, dir]);
      const saved = readdirSync(dir);
      assert.deepEqual(saved.map(f => f[0]).sort(), ['0', '1']);
      for (const f of saved) assert.match(f, /^[01]-[A-Za-z0-9._-]+$/);
      assert.doesNotMatch(out, /\(not stored\)$/m); // no line of the sender's making
      assert.doesNotMatch(out.replace(/[\t\n]/g, ''), /\p{Cc}/u);
      // Another slot made the predictable folders first, with the same file names linked to this job's own file: not used.
      for (const planted of [`${tmpdir()}/mail-${m}`, `${JOB_TMP}/mail-${m}`]) {
        mkdirSync(planted, { recursive: true });
        for (const f of saved) symlinkSync(victim, `${planted}/${f}`);
      }
      const again = savedTo(await hq(m));
      assert.equal(again.length, files.length, 'every attachment is saved again beside the planted folders');
      assert.ok(again.every(f => !f.startsWith(dir) && f.startsWith(`${JOB_TMP}/mail-${m}.`)));
      rmSync(`${tmpdir()}/mail-${m}`, { recursive: true, force: true });
    }
    assert.equal(readFileSync(victim, 'utf8'), 'keep');
    assert.deepEqual(readdirSync(outside), ['victim-x']);
  } finally { for (const m of [id, old]) rmSync(`${tmpdir()}/mail-${m}`, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('`hq mail <id> --raw` saves the mail as HQ received it, byte for byte, in a new private folder; the board\'s own is no mail, and a cleared copy says so', async () => {
  const body = message(), id = await to('hello@testco.example', body);
  const served = await fetch(`${base}/api/agent/mail-raw?id=${id}`, { headers: { authorization: `Bearer ${reader.token}` } });
  assert.equal(served.headers.get('content-type'), 'message/rfc822');
  assert.ok(Buffer.from(await served.arrayBuffer()).equals(body));
  const saved = await h.hq(reader, 'mail', String(id), '--raw'), path = saved.out.trim();
  assert.equal(saved.code, 0);
  assert.match(path, new RegExp(`^${JOB_TMP}/mail-${id}\\.[A-Za-z0-9]{6}/message\\.eml$`));
  assert.ok(readFileSync(path).equals(body));
  assert.doesNotMatch(saved.out, /Signed DPA|signed agreement/);

  withBrandMail('boardOnly: [board]');
  try {
    const own = await to('board@testco.example');
    assert.equal((await read(`mail-raw?id=${own}`)).status, 404);
    const refused = await h.hq(reader, 'mail', String(own), '--raw');
    assert.equal(refused.code, 1); assert.match(refused.out, new RegExp(`No mail #${own}`));
  } finally { writeFileSync(BRAND, BRAND_TEXT); }

  db.prepare('update mail set received = ? where id = ?').run(new Date(Date.now() - (mail.ATTACHMENT_DAYS + 1) * 864e5).toISOString(), id);
  mail.sweep();
  assert.equal((await read(`mail-raw?id=${id}`)).status, 410);
  const cleared = await h.hq(reader, 'mail', String(id), '--raw');
  assert.equal(cleared.code, 1); assert.match(cleared.out, /no raw copy/);
});

test('`hq mail --to invoices@` finds an invoice behind 250 newer mails to other addresses, and only mail to that exact address', async () => {
  const id = await to('Invoices <INVOICES@testco.example>'), before = id - 1;
  for (const address of ['my-invoices@testco.example', 'invoices@testco.example.example.com', 'invoicesXtestco.example', 'documents@testco.example']) await to(address);
  const hi = Buffer.from(['From: a@example.com', 'To: hello@testco.example', 'Subject: Hi', '', 'x'].join('\r\n'));
  let last = 0;
  for (let i = 0; i < 250; i++) last = await to('hello@testco.example', hi);
  const list = (...a: string[]) => h.hq(reader, 'mail', '--to', ...a);
  for (const { out } of [await list('invoices@', '--after', String(before)), await list('invoices@testco.example')])
    assert.match(out.split('\n')[0], new RegExp(`^#${id} .*INVOICES@testco.example`));
  assert.deepEqual([...(await list('invoices@', '--after', String(before))).out.matchAll(/^#(\d+)/gm)].map(m => Number(m[1])), [id]);
  assert.deepEqual((await read(`mail?to=invoice_%40&after=${before}`)).body, []); // like's wildcards match only themselves
  for (const bad of ['invoices%@', 'invoices', '@testco.example', 'a@b@testco.example']) assert.equal((await read(`mail?to=${encodeURIComponent(bad)}`)).status, 400, bad);
  // a full page (hello@ has 250 since): exit 3, and where to page on from
  const paged = await list('hello@', '--after', String(before));
  assert.equal(paged.code, 3);
  assert.match(paged.out, /Page on: hq mail --to hello@ --after \d+/);
  assert.equal((await read(`mail?to=hello%40&after=${last - 1}`)).body.length, 1);
});

test('a body past the runaway guard says where it was cut, stored and read back', async () => {
  const text = `${'A very long complaint. '.repeat(5000)}The last line.`;
  const raw = Buffer.from(['From: A <a@example.com>', 'To: hello@testco.example', 'Subject: Long', 'Content-Type: text/plain; charset=utf-8', '', text, ''].join('\r\n'));
  const { id } = await (await inbound(raw, TOKEN, 'hello@testco.example')).json();
  const m = await one(id);
  assert.match(m.body, /^A very long complaint\./);
  assert.match(m.body, /\n\n… \(cut here: the message has 115,0\d\d characters\)$/);
});

test("a brand colour that isn't #rrggbb keeps the board's mail its own, as it comes in and as HQ starts again", async () => {
  withBrandMail('boardOnly: [board]');
  appendFileSync(BRAND, "colour: '#47f'\n");
  try {
    const id = await to('board@testco.example');
    await restart();
    assert.equal((await read(`mail?id=${id}`)).status, 404); assert.equal((await one(id)).id, id);
  } finally { writeFileSync(BRAND, BRAND_TEXT); }
});

test('mail to a board-only address (mail.boardOnly) is in HQ\'s Mail, and no agent reads it: not its words, files or address', async () => {
  withBrandMail('boardOnly: [board, claude-1, ../x]');
  try {
    const id = await to('Claude-1@testco.example');
    assert.equal((await read(`mail?id=${id}`)).status, 404); assert.equal((await one(id)).id, id);
    assert.ok(!(await read('mail?limit=200')).body.some((m: { id: number }) => m.id === id)); assert.ok((await h.board('/api/mail')).body.some((m: { id: number }) => m.id === id));
    assert.deepEqual((await read('mail?to=claude-1%40')).body, []);
    assert.equal(await saved(id, 0), 404); assert.equal((await download(`/api/mail/file?id=${id}&n=0`)).status, 200);
    const event = (await h.feed()).find(e => e.text.startsWith(`Mail #${id} `));
    assert.ok(event && !/claude-1/i.test(event.text), event?.text);
    assert.doesNotMatch(await hq(id), /Signed DPA|signed agreement/);
    // hello@ (a customer's) stays the agents'
    const hello = await to('hello@testco.example');
    assert.equal((await read(`mail?id=${hello}`)).body.id, hello);
  } finally { writeFileSync(BRAND, BRAND_TEXT); }
});

test('a board-only hook hears only that mail came to a board-only address, and from whom: never its words; other hooks never hear it', async () => {
  withBrandMail('boardOnly: [board, trustpilot]');
  const board: any[] = [], others: any[] = [], hook = (m: any) => { board.push(m); }, other = (m: any) => { others.push(m); };
  mail.boardMailHooks.push(hook); mail.mailHooks.push(other);
  try {
    const raw = Buffer.from(['From: Trustpilot <noreply@trustpilot.example>', 'To: trustpilot@testco.example', 'Subject: Your code is 482913',
      'Content-Type: text/plain', '', 'Sign in with 482913', ''].join('\r\n'));
    const send = async (to: string) => (await (await fetch(`${base}/api/mail/inbound`, { method: 'POST', body: raw, headers: { authorization: `Bearer ${TOKEN}`,
      'content-type': 'message/rfc822', 'x-mail-from': 'bounce@trustpilot.example', 'x-mail-to': to } })).json()).id;
    const id = await send('trustpilot@testco.example');
    assert.deepEqual(board, [{ id, sender: 'bounce@trustpilot.example', recipient: 'trustpilot@testco.example' }]);
    assert.ok(!others.some(m => m.id === id), "the agents' hooks never hear the board's mail");
    const hello = await send('hello@testco.example');
    assert.equal(board.length, 1, "hello@ isn't board-only");
    assert.ok(others.some(m => m.id === hello));
  } finally {
    mail.boardMailHooks.splice(mail.boardMailHooks.indexOf(hook), 1); mail.mailHooks.splice(mail.mailHooks.indexOf(other), 1);
    writeFileSync(BRAND, BRAND_TEXT);
  }
});

test("an account's notice at its board-only sign-in (mail.notices) is business mail the hooks hear; anything else there stays the board's", async () => {
  withBrandMail("boardOnly: [board, vendor], notices: [{ to: vendor, from: vendor.example, subject: ['Fault report: GET /', 'Fault report: POST /orders'] }]");
  const heard: number[] = [], board: number[] = [], hook = (m: any) => { heard.push(m.id); }, boardHook = (m: any) => { board.push(m.id); };
  mail.mailHooks.push(hook); mail.boardMailHooks.push(boardHook);
  try {
    const send = async (subject: string, from = 'info@vendor.example', to = 'vendor@testco.example') => (await (await fetch(`${base}/api/mail/inbound`, {
      method: 'POST', body: Buffer.from([`From: Vendor <${from}>`, `To: ${to}`, `Subject: ${subject}`, 'Content-Type: text/plain', '', 'Status 404', ''].join('\r\n')),
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'message/rfc822', 'x-mail-from': from, 'x-mail-to': to } })).json()).id as number;
    const report = await send('Fault report: GET /orders/pc_123'), posted = await send('Fault report: POST /orders');
    const locked = [
      await send('Wachtwoord herstellen'),                                                    // the account's own mail
      await send('Fault report: POST /oauth'),                                                 // a request the list leaves out
      await send('Re: Fault report: GET /orders/pc_123'),                                      // the words must start the subject
      await send('Fault report: GET /orders/pc_1', 'info@vendor.example.other.example'),     // a domain, never a lookalike
      await send('Fault report: GET /orders/pc_1', 'info@badvendor.example'),
      await send('Fault report: GET /orders/pc_1', 'info@vendor.example', 'vendor@testco.example, board@testco.example'),   // another board-only address
    ];
    const dex = await h.start({ agent: 'dex', title: "Vendor notices" }), get = (path: string) => h.agent(path, dex.token);
    for (const id of [report, posted]) assert.equal((await get(`mail?id=${id}`)).body.id, id);
    for (const id of locked) assert.equal((await get(`mail?id=${id}`)).status, 404, `#${id}`);
    assert.deepEqual((await get('mail?to=vendor%40')).body.map((m: any) => m.id), [posted, report], 'hq mail --to vendor@: the notices only');
    const listed = (await get('mail?limit=200')).body.map((m: any) => m.id);
    assert.ok(listed.includes(report) && !locked.some(id => listed.includes(id)), 'business mail: in hq mail for roles.businessMail');
    assert.deepEqual(heard.filter(id => id >= report), [report, posted]);
    assert.deepEqual(board, locked);
    const shown = (await h.board('/api/mail')).body as { id: number, board: number }[];
    assert.deepEqual([report, ...locked].map(id => shown.find(m => m.id === id)?.board), [0, 1, 1, 1, 1, 1, 1], "HQ's Mail: a lock on the board's own only");
  } finally {
    mail.mailHooks.splice(mail.mailHooks.indexOf(hook), 1); mail.boardMailHooks.splice(mail.boardMailHooks.indexOf(boardHook), 1);
    writeFileSync(BRAND, BRAND_TEXT);
  }
});

test("an account's receipts at its sign-in (a notice rule with file: invoices) are filed at invoices@, the ones already in too; its codes stay the board's", async () => {
  withBrandMail('boardOnly: [board, seat-1]');
  try {
    const send = async (subject: string, to: string, from = 'receipts@seller.example') => (await (await fetch(`${base}/api/mail/inbound`, {
      method: 'POST', body: Buffer.from([`From: Seller <${from}>`, `To: ${to}`, `Subject: ${subject}`, 'Content-Type: text/plain', '', 'Paid', ''].join('\r\n')),
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'message/rfc822', 'x-mail-from': from, 'x-mail-to': to } })).json()).id as number;
    const earlier = await send('Your receipt from Seller #1001', 'seat-1@testco.example');
    // through the seller's mail service, from a subdomain of a listed domain.
    const relayed = await send('Your receipt from Seller #1000', 'board@testco.example', 'bounces+9-ab=board=testco.example@em9672.seller.example');
    assert.equal((await one(earlier)).board, 1, 'before the rule: the board\'s');
    withBrandMail("boardOnly: [board, seat-1], notices: [{ to: [board, seat-1], from: [seller.example, pay.example], subject: ['Your receipt from Seller'], file: invoices }]");
    await restart();
    const receipt = await send('Your receipt from Seller #1002', 'board@testco.example', 'x@pay.example');
    const code = await send('Your sign-in code', 'seat-1@testco.example'), stranger = await send('Your receipt from Seller #1003', 'seat-1@testco.example', 'x@forger.example');
    const filed = async (id: number) => { const m = await one(id); return [m.recipient, m.keep, m.board]; };
    assert.deepEqual(await filed(earlier), ['invoices@testco.example', 'invoices', 0]);
    assert.deepEqual(await filed(relayed), ['invoices@testco.example', 'invoices', 0], 'filed at the next start');
    assert.deepEqual(await filed(await send('Your sign-in code', 'board@testco.example', 'b@em9672.seller.example')), ['board@testco.example', null, 1]);
    assert.deepEqual(await filed(receipt), ['invoices@testco.example', 'invoices', 0]);
    assert.deepEqual(await filed(code), ['seat-1@testco.example', null, 1]);
    assert.deepEqual(await filed(stranger), ['seat-1@testco.example', null, 1]);
    assert.ok((await read('mail?to=invoices%40')).body.some((m: { id: number }) => m.id === receipt), "Finance's weekly check finds it");
  } finally { writeFileSync(BRAND, BRAND_TEXT); await restart(); }
});

test("a supplier's billing sender (mail.invoicesFrom) is filed at invoices@ wherever it wrote, never at a board-only address or documents@", async () => {
  withBrandMail('boardOnly: [board], invoicesFrom: [Bounce.Billing.example, billing@shop.example]');
  try {
    const to = async (from: string, recipient: string) => {
      const raw = Buffer.from([`From: Supplier <${from}>`, `To: ${recipient}`, 'Subject: Your receipt', 'Content-Type: text/plain', '', 'Paid', ''].join('\r\n'));
      const { id } = await (await fetch(`${base}/api/mail/inbound`, { method: 'POST', body: raw, headers: { authorization: `Bearer ${TOKEN}`,
        'content-type': 'message/rfc822', 'x-mail-from': from, 'x-mail-to': recipient } })).json();
      return await one(id) as { id: number, recipient: string, keep: string | null, board: number };
    };
    const receipt = await to('0101-b@bounce.billing.example', 'hello@testco.example');
    assert.deepEqual([receipt.recipient, receipt.keep], ['invoices@testco.example', 'invoices']);
    assert.ok((await read('mail?to=invoices%40')).body.some((m: { id: number }) => m.id === receipt.id), "Finance's weekly check finds it");
    assert.deepEqual([(await to('billing@shop.example', 'hello@testco.example')).keep, (await to('sales@shop.example', 'hello@testco.example')).keep], ['invoices', null]);
    // a domain covers its subdomains (a mail service's bounce address), never a lookalike or its parent.
    assert.equal((await to('a@em1.bounce.billing.example', 'hello@testco.example')).keep, 'invoices');
    for (const from of ['a@bounce.billing.example.net', 'a@xbounce.billing.example', 'a@billing.example'])
      assert.equal((await to(from, 'hello@testco.example')).recipient, 'hello@testco.example', from);
    // the board's own mail stays the board's, and an agreement stays an agreement
    const boards = await to('0101-c@bounce.billing.example', 'board@testco.example');
    assert.deepEqual([boards.recipient, boards.keep, boards.board], ['board@testco.example', null, 1]);
    assert.equal((await to('0101-d@bounce.billing.example', 'documents@testco.example')).keep, 'documents');
  } finally { writeFileSync(BRAND, BRAND_TEXT); }
});

// A company that also receives at a second domain (mail.also): the address rules hold at both, never at anyone else's.
test("with a second domain (mail.also), every address rule holds at each of ours, and a stranger's domain counts for none", async () => {
  withBrandMail('also: [Old.Example], boardOnly: [board, claude-1], business: [ads], invoicesFrom: [bounce.billing.example]');
  try {
    const to = async (recipient: string, from = 'a@example.com') => {
      const raw = Buffer.from([`From: ${from}`, `To: ${recipient}`, 'Subject: Hi', 'Content-Type: text/plain', '', 'Hello', ''].join('\r\n'));
      const { id } = await (await fetch(`${base}/api/mail/inbound`, { method: 'POST', body: raw, headers: { authorization: `Bearer ${TOKEN}`,
        'content-type': 'message/rfc822', 'x-mail-from': from, 'x-mail-to': recipient } })).json();
      return await one(id) as { id: number, recipient: string, keep: string | null, board: number, business: number };
    };
    // a board-only name is the board's at each domain, and no agent reads it
    for (const address of ['claude-1@testco.example', 'Claude-1@old.example', 'Board <board@OLD.example>']) {
      const m = await to(address);
      assert.equal(m.board, 1, address); assert.equal((await read(`mail?id=${m.id}`)).status, 404, address);
    }
    for (const address of ['claude-1@stranger.example', 'claude-1@old.example.net', 'board@mail.old.example'])
      assert.equal((await to(address)).board, 0, address);
    // invoices@, documents@ and mail.business at each domain; not at a stranger's
    assert.deepEqual([(await to('invoices@old.example')).keep, (await to('documents@old.example')).keep, (await to('invoices@stranger.example')).keep], ['invoices', 'documents', null]);
    assert.deepEqual([(await to('ads@old.example')).business, (await to('ads@stranger.example')).business], [1, 0]);
    // a billing sender's mail is filed at invoices@ of the domain it came to
    const old = await to('hello@old.example', '0101-x@bounce.billing.example'), ours = await to('invoices@testco.example');
    assert.deepEqual([old.recipient, old.keep], ['invoices@old.example', 'invoices']);
    // Finance's bare invoices@ finds both domains' invoices; a whole address finds its own
    const ids = async (to: string) => (await read(`mail?to=${encodeURIComponent(to)}`)).body.map((m: { id: number }) => m.id) as number[];
    const atAll = await ids('invoices@');
    assert.ok([old.id, ours.id].every(id => atAll.includes(id)));
    const atOld = await ids('invoices@old.example');
    assert.ok(atOld.includes(old.id) && !atOld.includes(ours.id));
    // our own addresses: a bare name at the public domain, a whole one at its own, never the board's or a stranger's
    assert.deepEqual(['invoices', 'Invoices@Old.example', 'invoices@stranger.example', 'claude-1@old.example'].map(mail.ownAddress),
      ['invoices@testco.example', 'invoices@old.example', null, null]);
  } finally { writeFileSync(BRAND, BRAND_TEXT); }
});

test("mail a listed billing sender sent before it was listed is filed at invoices@ at the next start (not a case's own)", async () => {
  const receipt = (address: string) => inbound(Buffer.from(['From: 0101-a@bounce.billing.example', `To: ${address}`, 'Subject: Your receipt',
    'Content-Type: text/plain', '', 'Paid', ''].join('\r\n')), TOKEN, address, '0101-a@bounce.billing.example').then(async r => (await r.json()).id as number);
  const hello = await receipt('hello@testco.example'), ofCase = await receipt('case-e12@testco.example');
  withBrandMail('invoicesFrom: [bounce.billing.example]');
  try {
    await restart();
    assert.deepEqual([(await one(hello)).recipient, (await one(hello)).keep], ['invoices@testco.example', 'invoices']);
    assert.deepEqual([(await one(ofCase)).recipient, (await one(ofCase)).keep], ['case-e12@testco.example', null]);
  } finally { writeFileSync(BRAND, BRAND_TEXT); }
});

test("forget() deletes a plug-in's customer mail with its files, the mail it hid from agents too; never kept mail or the board's own (forgettable() says which)", async () => {
  withBrandMail('boardOnly: [board]');
  try {
    const ids: Record<string, number> = {};
    for (const address of ['case-1042@testco.example', 'case-1043@testco.example', 'invoices@testco.example', 'board@testco.example']) ids[address] = await to(address);
    db.prepare('update mail set board = 1 where id = ?').run(ids['case-1043@testco.example']);   // hidden from agents by a plug-in (as care.ts hides a health mail)
    const customers = [ids['case-1042@testco.example'], ids['case-1043@testco.example']];
    assert.deepEqual(mail.forgettable(Object.values(ids)), customers, 'what forget() will delete, for a plug-in to clear up first');
    assert.deepEqual(mail.forget(Object.values(ids)), customers, 'and what it deleted');
    const kept = async (id: number) => await one(id) !== 404 && existsSync(`${mail.FILES}/${id}`);
    assert.deepEqual(await Promise.all(Object.entries(ids).map(async ([address, id]) => [address, await kept(id)])), [['case-1042@testco.example', false],
      ['case-1043@testco.example', false], ['invoices@testco.example', true], ['board@testco.example', true]]);
  } finally { writeFileSync(BRAND, BRAND_TEXT); }
});

test('the Worker\'s token counts only as the Email workflow commits it: not from a merged pull request, nor anyone else\'s commit', async () => {
  const subject = "Email: rotate the inbox Worker's token", before = git(repo, 'rev-parse', 'HEAD');
  const theirs = 'token-from-a-pull-request-0123456789', hash = createHash('sha256').update(theirs).digest('hex');
  try {
    git(repo, 'checkout', '-q', '-b', 'job/1');
    commitFile('infra/mail/token.sha256', hash, subject);   // (the bot's name and words, on a job branch)
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge PR #1 after review (round 1)', 'job/1');
    assert.equal((await inbound(message(), theirs)).status, 401);
    commitFile('infra/mail/token.sha256', hash + '\n', subject, { by: { name: 'Bolt', email: 'bolt@agents.testco.example' } });
    assert.equal((await inbound(message(), theirs)).status, 401);
    commitFile('infra/mail/token.sha256', hash, subject);   // the workflow's own run
    assert.equal((await inbound(message(), theirs)).status, 200);
    // git unreadable (a full disk, say): the server's trouble, not a wrong token
    const head = readFileSync(`${repo}/.git/HEAD`, 'utf8');
    writeFileSync(`${repo}/.git/HEAD`, 'unreadable\n');
    try { assert.equal((await inbound(message(), theirs)).status, 503); } finally { writeFileSync(`${repo}/.git/HEAD`, head); }
  } finally {
    git(repo, 'reset', '-q', '--hard', before);
  }
  assert.equal((await inbound(message())).status, 200);
});

// The job a hand-off made (mail.ts forward), as the board's route made it, and claimed: the route gives it no engine of its own,
// so it gets one here, the only way to claim that job and no other (calls.test.ts does the same)
const forwardJob = (job: number) => db.prepare('select agent, title, prompt, customers from jobs where id = ?').get(job) as
  { agent: string, title: string, prompt: string, customers: number };
const claimForwarded = async (job: number) => {
  db.prepare('update jobs set engine = ? where id = ?').run(`engine-forward-${job}`, job);
  const claimed = await h.claim(`engine-forward-${job}`);
  assert.equal(claimed?.id, job);
  return { ...claimed!, agent: 'wren', tmp: JOB_TMP, get: (path: string) => h.agent(path, claimed!.token) };
};
const forward = (mailId: number) => h.board('/api/mail/forward', { id: mailId });
const sendTo = (from: string, address: string, subject: string) => fetch(`${base}/api/mail/inbound`, { method: 'POST',
  body: Buffer.from([`From: <${from}>`, `To: ${address}`, `Subject: ${subject}`, 'Content-Type: text/plain', '', 'Please book the stand for 12 May.', ''].join('\r\n')),
  headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'message/rfc822', 'x-mail-from': from, 'x-mail-to': address } }).then(r => r.json()).then(r => r.id as number);
const HANDING = 'boardOnly: [board, vendor], partnersFrom: [partner.example], forwardTo: wren, notices: [{ to: vendor, from: partner.example, subject: Fault }]';

// HQ's Mail's Send to the team: a board-only mail becomes a job for brand.yaml's mail.forwardTo, its brief the mail, and that
// job alone reads it, whatever its agent's roles; once a mail.
test("the board hands one of its own mails to the team: one job for mail.forwardTo, the only one that reads it", async () => {
  withBrandMail(HANDING);
  try {
    const id = await to('board@testco.example'), hello = await to('hello@testco.example');
    assert.equal((await forward(hello)).status, 404, "only the board's own mail is handed on this way");
    const first = await forward(id);
    assert.equal(first.status, 200); assert.equal(first.body.already, false);
    const job = forwardJob(first.body.job);
    assert.equal(job.agent, 'wren'); assert.equal(job.title, `From the board's mail #${id}`, 'the log never holds a subject');
    const json = JSON.parse(job.prompt.slice(job.prompt.indexOf('{')));
    assert.deepEqual({ ...json, received: undefined }, { from: 'board@example.com', to: 'board@testco.example', received: undefined, subject: 'Signed DPA',
      attachments: ['Verwerkersövereenkomst (signed).pdf', '../../etc/passwd'], text: 'Here is the signed agreement.' }, 'the mail as JSON, nothing after it');
    for (const part of [`Mail #${id}`, `hq mail ${id}`, 'charter rule 9', 'no note']) assert.ok(job.prompt.includes(part), part);
    assert.equal(job.customers, 1, 'the mail is in its brief: the job holds what a customer may have written');
    assert.deepEqual((await forward(id)).body, { job: first.body.job, already: true }, 'a second click: the first job');
    assert.equal((await h.board('/api/mail')).body.find((m: { id: number }) => m.id === id).forwarded, first.body.job, 'Mail shows it went');

    // that job reads it, its files and its raw copy (Wren reads no mail by role); every other job, Penny's too, still can't
    const handed = await claimForwarded(first.body.job);
    assert.equal((await handed.get(`mail?id=${id}`)).body.id, id);
    assert.equal((await handed.get(`mail-file?id=${id}&n=0`)).status, 200); assert.equal((await handed.get(`mail-raw?id=${id}`)).status, 200);
    assert.equal((await h.worker('customers', { job: handed.id })).body.customers, true);
    for (const path of [`mail?id=${hello}`, 'mail']) assert.equal((await handed.get(path)).status, 403, path);
    assert.equal((await handed.get(`mail?id=${await to('board@testco.example')}`)).status, 404, "the board's other mail: as for any job");
    for (const path of [`mail?id=${id}`, `mail-file?id=${id}&n=0`, `mail-raw?id=${id}`]) assert.equal((await read(path)).status, 404, path);
    assert.ok(!(await read('mail?limit=200')).body.some((m: { id: number }) => m.id === id));
    const out = await h.hq(handed, 'mail', String(id));
    assert.equal(out.code, 0, out.out); assert.match(out.out, /Here is the signed agreement/);

    withBrandMail('boardOnly: [board]');
    const unset = await forward(await to('board@testco.example'));
    assert.equal(unset.status, 409); assert.match(unset.body.error, /mail\.forwardTo/);
  } finally { withBrandMail('invoicesFrom: [bounce.billing.example]'); }
});

// A partner's mail to the board's own address, handed on, leaves the job free of a customer's details, unless it went to the
// sign-in whose notices carry them (a vendor's other mail at vendor@)
test("a partner's mail the board hands on marks no job, but one to a notices address does", async () => {
  withBrandMail(HANDING);
  try {
    const partner = await sendTo('anna@partner.example', 'board@testco.example', 'Our stand'), made = (await forward(partner)).body.job;
    assert.equal(forwardJob(made).customers, 0);
    const handed = await claimForwarded(made);
    assert.equal((await handed.get(`mail?id=${partner}`)).body.id, partner);
    assert.equal((await h.worker('customers', { job: handed.id })).body.customers, false, "a partner's mail: no customer's details");
    const atVendor = await sendTo('ops@partner.example', 'vendor@testco.example', 'Your order 1234');
    assert.equal(forwardJob((await forward(atVendor)).body.job).customers, 1);
  } finally { withBrandMail('invoicesFrom: [bounce.billing.example]'); }
});

// HQ hands a customer's mail only to org.yaml's roles.customerData, business mail (invoices@, documents@, brand.yaml's
// mail.business) only to roles.businessMail, and anyone else's job is refused, with how to get it. Any mail read marks the
// job: a customer can write to invoices@ too. The fixture: Dex reads business mail, Penny both, Wren neither.
//
test("a job reads the inbox by its agent's role, and any mail it reads marks it; anyone else's is refused with why", async () => {
  withBrandMail('business: [ads]');
  try {
    const running = async (agent: string) => {
      const job = await h.start({ agent, title: 'Read the inbox' });
      return { ...job, tmp: JOB_TMP, get: (path: string) => h.agent(path, job.token), marked: async () => (await h.worker('customers', { job: job.id })).body.customers as boolean };
    };
    const invoice = await to('invoices@testco.example'), ads = await to('ads@testco.example'), hello = await to('hello@testco.example');
    const other = await to('info@testco.example'), filed = await to('case-e7@testco.example');

    const wren = await running('wren');
    // (mail-raw checks)
    for (const path of ['mail', 'mail?limit=5', `mail?id=${hello}`, `mail?id=${invoice}`, 'mail?to=invoices%40', 'mail?to=hello%40',
      `mail-file?id=${hello}&n=0`, `mail-file?id=${invoice}&n=0`, `mail-raw?id=${hello}`, `mail-raw?id=${invoice}`, 'orders']) {
      const r = await wren.get(path);
      assert.equal(r.status, 403, path); assert.match(r.body.error, /org\.yaml's roles\.(customerData|businessMail|orders)/, path);
    }
    assert.equal(await wren.marked(), false, 'a refused read holds nothing');

    const dex = await running('dex');
    // (mail-raw check)
    for (const path of [`mail?id=${hello}`, `mail?id=${filed}`, 'mail?to=hello%40', `mail-file?id=${hello}&n=0`, `mail-raw?id=${hello}`, 'orders'])
      assert.equal((await dex.get(path)).status, 403, path);
    assert.equal((await dex.get('mail?id=999999')).status, 404, 'no such mail: as before');
    assert.equal(await dex.marked(), false);
    assert.equal((await dex.get(`mail?id=${invoice}`)).body.id, invoice);
    assert.equal(await dex.marked(), true, 'mail to invoices@ may be a customer\'s too');
    assert.equal((await dex.get(`mail-file?id=${invoice}&n=0`)).status, 200);
    const rawReader = await running('dex');
    assert.equal((await rawReader.get(`mail-raw?id=${invoice}`)).status, 200);
    assert.equal(await rawReader.marked(), true, 'its raw copy marks the job like its text');
    assert.deepEqual((await dex.get('mail?to=ads%40')).body.map((m: any) => m.id), [ads]);
    const listed = (await dex.get('mail?limit=200')).body.map((m: any) => m.id);
    assert.ok(listed.includes(invoice) && listed.includes(ads) && !listed.includes(hello) && !listed.includes(other), 'business mail only');

    const penny = await running('penny');
    assert.equal((await penny.get(`mail?id=${hello}`)).body.id, hello);
    assert.equal(await penny.marked(), true, "a customer's mail: the job holds their details");
    const both = (await penny.get('mail?limit=200')).body.map((m: any) => m.id);
    assert.ok([invoice, ads, hello, other, filed].every(id => both.includes(id)), 'both kinds');

    // roles.customerMail: a customer's mail alone, for whoever routes what comes in
    writeFileSync(ORG, ORG_TEXT.replace('  customerData: [penny, vera]\n', '  customerData: [penny, vera]\n  customerMail: [kit]\n'));
    try {
      const kit = await running('kit');
      assert.equal((await kit.get(`mail?id=${invoice}`)).status, 403, 'business mail stays businessMail\'s');
      assert.equal(await kit.marked(), false);
      assert.equal((await kit.get(`mail?id=${hello}`)).body.id, hello);
      assert.equal(await kit.marked(), true, "a customer's mail: the job holds their details");
      const routed = (await kit.get('mail?limit=200')).body.map((m: any) => m.id);
      assert.ok(routed.includes(hello) && routed.includes(other) && !routed.includes(invoice) && !routed.includes(ads), "customers' mail only");
    } finally { writeFileSync(ORG, ORG_TEXT); }

    // hq says why, and stops
    // (--raw check)
    for (const a of [['mail'], ['mail', String(hello)], ['mail', String(hello), '--raw'], ['mail', '--to', 'hello@'], ['orders']]) {
      const r = await h.hq(wren, ...a);
      assert.equal(r.code, 1, a.join(' ')); assert.match(r.out, /HQ refused it: .*org\.yaml's roles\.\w+/, a.join(' '));
    }
    assert.equal((await h.hq(dex, 'mail', '--to', 'invoices@')).code, 0);
  } finally { withBrandMail('invoicesFrom: [bounce.billing.example]'); }
});
