// node --test src/documents.test.ts   (the test company, whose mail domain is testco.example; HQ's real server)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { harness } from './harness.ts';
import { parkedRequest } from '../../worker/src/outcome.ts';

const h = await harness('documents');
const { repo, dataDir: DATA, board } = h;
const documents = await import('./documents.ts');   // (sweep: the server's timer, here when the test says)
const mail = await import('./mail.ts');
const { ORIGIN } = await import('./config.ts');
(await import('./storage.ts')).FLOOR.bytes = 0;   // (the files are kept on this disk too, whatever it has free)
const dex = await h.start({ agent: 'dex' });

// A PDF as a browser downloads it, with bytes a re-encoding or a text read would change
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1'), Buffer.from([0, 0xff, 0x0d, 0x0a, 0x80]), Buffer.from('\n%%EOF\n')]);
const PDF2 = Buffer.concat([PDF, Buffer.from('second invoice')]);
const JPEG_EXIF = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0xff, 0xd9]);

const FIELDS = [{ label: 'Claude Team invoice', to: 'invoices' }, { label: 'ChatGPT Business invoice', optional: true, to: 'invoices@' }];
const card = (over: Record<string, unknown> = {}, job = dex) => h.agent('request', job.token, { kind: 'action', title: "The AI seats' invoices, October", body: 'Upload both.',
  documents: FIELDS, ...over });
const ask = async (over: Record<string, unknown> = {}, job = dex) => { const r = await card(over, job); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.id as number; };
const listed = async (id: number) => ((await board('/api/requests')).body as any[]).find(r => r.id === id)?.documents;
// the mail each file went in, as the agent hears it in the board's answer
const filed = async (id: number, job = dex) => [...String((await h.agent('request-answer', job.token, { id })).body.answer).matchAll(/mail #(\d+)/g)].map(m => Number(m[1]));
const attachment = async (m: number) => (await h.agent(`mail-file?id=${m}&n=0`, dex.token)).body;

test('document fields: labels as photo fields, each filed to one of the company\'s own addresses, never the board\'s alone', async () => {
  const id = await ask({ documents: [{ label: ' Claude​ invoice ', to: 'INVOICES@testco.example' }, { label: 'Signed', optional: true, to: 'documents@' }] });
  assert.deepEqual((await listed(id)).map((f: any) => [f.label, f.optional, f.to]), [['Claude invoice', false, 'invoices@testco.example'], ['Signed', true, 'documents@testco.example']]);
  for (const bad of [['A'], [{ label: 'A' }], [{ label: 'A', to: 'invoices@example.com' }], [{ label: 'A', to: 'in voices' }], [{ label: 'A', to: '../x' }],
    [{ label: 'A', to: 'invoices' }, { label: 'a', to: 'invoices' }], [{ label: '', to: 'invoices' }], [{ label: 'A', to: 'board@elsewhere.example' }]])
    assert.equal((await card({ documents: bad })).status, 400, JSON.stringify(bad));
  const file = `${repo}/company/brand.yaml`, before = readFileSync(file, 'utf8');
  writeFileSync(file, before.replace(/^mail: \{ domain: testco\.example \}/m, 'mail: { domain: testco.example, boardOnly: [board] }'));
  try { assert.equal((await card({ documents: [{ label: 'A', to: 'board' }] })).status, 400); } finally { writeFileSync(file, before); }
  for (const over of [{ kind: 'credential', secrets: 'SOME_TEST_KEY' }, { kind: 'approval', approves: 'live:pebblet' }, { kind: 'login', seat: 'server-9' }])
    assert.equal((await card(over)).status, 400, JSON.stringify(over));
});

test('hq request --document parks its fields, and the worker files them on the card', async () => {
  const dir = mkdtempSync(`${tmpdir()}/documents-hq-`);
  writeFileSync(`${dir}/body.md`, 'Upload both.');
  // The card check has no coordinator to answer it. --park skips the clone check because this fixture has no clone.
  const run = (...args: string[]) => execFileSync('bash', [new URL('../../worker/bin/hq', import.meta.url).pathname, 'request', 'action', 'today', 'Invoices',
    `${dir}/body.md`, '--topic', 'invoices', '--park', ...args], { env: { PATH: process.env.PATH, HQ_URL: 'http://127.0.0.1:9', HQ_TOKEN: 't', HQ_AGENT: 'dex', HQ_JOB_DIR: `${dir}/.hq`, TMPDIR: dir }, stdio: 'pipe' });   // (--topic)
  run('--document', 'Claude Team invoice', '--optional-document', 'ChatGPT Business invoice', '--documents-to', 'invoices');
  const request = parkedRequest(readFileSync(`${dir}/.hq/request.json`, 'utf8'));
  const job = await h.start({ agent: 'dex', title: 'The AI seats\' invoices' });
  const parked = await h.park(job, request);
  assert.deepEqual((await listed(parked)).map((f: any) => [f.label, f.optional, f.to]),
    [['Claude Team invoice', false, 'invoices@testco.example'], ['ChatGPT Business invoice', true, 'invoices@testco.example']]);
  assert.throws(() => run('--documents-to', 'invoices'), (e: any) => e.status > 0);   // a box nobody asked for is refused, not dropped
});

// ---------------------------------------------------------------- upload, answer
// the board adds a file on the desk phone
const put = (id: number, field: number | string, body: Buffer, name = 'invoice.pdf') => new Promise<{ status: number; json: any }>((resolve, reject) => {
  const q = request(`${h.base}/api/requests/document?id=${id}&field=${field}&name=${encodeURIComponent(name)}`,
    { method: 'POST', headers: { cookie: h.boardCookie, origin: ORIGIN, 'content-type': 'application/pdf', 'content-length': body.length } }, res => {
      let t = ''; res.setEncoding('utf8'); res.on('data', c => t += c);
      res.on('end', () => resolve({ status: res.statusCode!, json: t ? JSON.parse(t) : null }));
    });
  q.on('error', e => ['EPIPE', 'ECONNRESET'].includes((e as any).code) ? resolve({ status: 413, json: null }) : reject(e));
  q.end(body);
});

test('the board\'s file is kept byte for byte (0600 in a 0700 dir) under its own name, replaceable; anything else is refused', async () => {
  const id = await ask(), dir = `${DATA}/documents/${id}`;
  assert.equal((await put(id, 0, PDF2, 'old.pdf')).status, 200);
  assert.deepEqual((await put(id, 0, PDF, 'Invoice-2026-10‮.pdf')).json, { ok: true, field: 0, name: 'Invoice-2026-10_.pdf', bytes: PDF.length });
  assert.deepEqual(readFileSync(`${dir}/0`), PDF);
  assert.equal(statSync(`${dir}/0`).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal((await put(id, 1, JPEG_EXIF, '')).json.name, 'chatgpt-business-invoice.jpg');   // kept as it is, Exif and all
  assert.deepEqual(readFileSync(`${dir}/1`), JPEG_EXIF);
  assert.equal((await put(id, 1, Buffer.from('<html><script>'), 'x.pdf')).status, 415);
  assert.equal((await put(id, 2, PDF)).status, 400);
  assert.equal((await put(99999, 0, PDF)).status, 404);
  assert.equal((await put(await h.ask(dex, { title: 'No files here', body: '.' }), 0, PDF)).status, 404);
  assert.equal((await put(id, 1, Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]))).status, 413);
  assert.deepEqual(readFileSync(`${dir}/1`), JPEG_EXIF);
});

test('the answer files each file as mail to its address, kept as an invoice, and tells the agent the mail ids', async () => {
  const job = await h.start({ agent: 'dex', title: 'The AI seats\' invoices' }), id = await ask({}, job);
  assert.deepEqual((await listed(id))[0], { label: 'Claude Team invoice', optional: false, to: 'invoices@testco.example', saved: false, name: null, mail: null });
  assert.equal((await h.answer(id, 'Here they are.')).status, 400, 'the required one is missing');
  assert.equal((await put(id, 0, PDF, 'Invoice-ABC-0012.pdf')).status, 200);
  assert.deepEqual((await listed(id)).map((f: any) => [f.saved, f.name]), [[true, 'Invoice-ABC-0012.pdf'], [false, null]]);
  // no room in Mail: nothing is filed and the card stays open, its file waiting
  const floor = mail.STORAGE.maxStored; mail.STORAGE.maxStored = 0;
  try { assert.equal((await h.answer(id, 'Here they are.')).status, 507); } finally { mail.STORAGE.maxStored = floor; }
  assert.equal((await h.answer(id, 'Here they are.')).status, 200);
  const answer = (await h.agent('request-answer', job.token, { id })).body.answer, [m] = await filed(id, job);
  assert.ok(answer.startsWith('Here they are.\n') && m, answer);
  // the mail as it's kept: an invoice, 7 years (the mail table is what the backups' records and Finance read)
  const row = h.db.prepare('select sender, recipient, subject, keep, board, raw from mail where id = ?').get(m) as any;
  assert.deepEqual({ ...row }, { sender: 'the board (desk phone)', recipient: 'invoices@testco.example', subject: "The AI seats' invoices, October: Claude Team invoice",
    keep: 'invoices', board: 0, raw: null });
  const file = await attachment(m);
  assert.deepEqual([file.name, file.type, Buffer.from(file.data, 'base64')], ['Invoice-ABC-0012.pdf', 'application/pdf', PDF]);
  assert.ok(!existsSync(`${DATA}/documents/${id}`));
  assert.deepEqual(await filed(id, job), [m], 'the optional file, never added, filed nothing');
  assert.equal((await put(id, 1, PDF)).status, 409);
});

test('an answer that fails part-way keeps what it filed: that file can\'t be replaced, and answering again files only the rest', async () => {
  const id = await ask(), dir = `${DATA}/documents/${id}`;
  assert.equal((await put(id, 0, PDF, 'first.pdf')).status, 200);
  assert.equal((await put(id, 1, PDF2, 'second.pdf')).status, 200);
  rmSync(`${dir}/1`); mkdirSync(`${dir}/1`);   // the second file can't be read: filing it throws, after the first is filed
  assert.equal((await h.answer(id, 'Here.')).status, 500);
  const [first] = await listed(id);
  assert.ok(first.mail && first.saved);
  assert.equal((await put(id, 0, PDF2, 'replacement.pdf')).status, 409);   // its mail holds the file now
  rmSync(`${dir}/1`, { recursive: true });
  assert.equal((await put(id, 1, PDF2, 'second.pdf')).status, 200);
  assert.equal((await h.answer(id, 'Here.')).status, 200);
  const mails = await filed(id);
  assert.equal(mails[0], first.mail);
  assert.deepEqual(await Promise.all(mails.map(async (m: number) => Buffer.from((await attachment(m)).data, 'base64'))), [PDF, PDF2]);
});

test('a card that leaves the desk phone unanswered loses its waiting files at the next sweep', async () => {
  const id = await ask();
  assert.equal((await put(id, 0, PDF)).status, 200);
  documents.sweep();
  assert.ok(existsSync(`${DATA}/documents/${id}/0`));
  assert.equal((await h.agent('request-close', dex.token, { id })).status, 200);   // (hq close: moot now)
  documents.sweep();
  assert.ok(!existsSync(`${DATA}/documents/${id}`));
});
