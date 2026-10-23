// node --test src/mailforward.test.ts   (the bookkeeping mail's copies: the harness, a local stand-in for the email service)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { harness } from './harness.ts';
import { commitFile, fakeLettermint } from './fixture.ts';

const TOKEN = 'mail-worker-test-token-0123456789',
  BOARD = 'ada@home.example';
let BRAND = '';
const lettermint = await fakeLettermint();
const h = await harness('mailforward', {
  before: repo => {
    commitFile(
      'infra/mail/token.sha256',
      createHash('sha256').update(TOKEN).digest('hex'),
      "Email: rotate the inbox Worker's token",
    );
    BRAND = `${repo}/company/brand.yaml`;
    writeFileSync(
      BRAND,
      readFileSync(BRAND, 'utf8').replace(
        'mail: { domain: testco.example }',
        'mail: { domain: testco.example, also: [old.example], boardOnly: [board, seat-1], business: [ads], invoicesFrom: [billing.example], forward: [invoices, documents], ' +
          "notices: [{ to: [board, seat-1], from: seller.example, subject: 'Your receipt from Seller', file: invoices }] }",
      ),
    );
  },
});
const { base, db } = h;
const mail = await import('./mail.ts');
const storage = await import('./storage.ts');
storage.FLOOR.bytes = 0; // (attachments are kept whatever this machine's disk has free)
const secrets = await import('./secrets.ts');
const forward = await import('./mailforward.ts');
lettermint.on();

const PDF = Buffer.concat([
  Buffer.from('%PDF-1.7\n'),
  Buffer.from([0, 1, 2, 0xff, 0xfe, 13, 10]),
  Buffer.from('\n%%EOF\n'),
]);
// A mail as the Worker hands it over, with a PDF attached: its id
const inbound = async (to: string, from = 'shop@supplier.example', subject = 'Invoice 2026-101', pdf = PDF) => {
  const raw = Buffer.from(
    [
      `From: Supplier <${from}>`,
      `To: ${to}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Your invoice is attached.',
      '--b1',
      'Content-Type: application/pdf; name="invoice-101.pdf"',
      'Content-Disposition: attachment',
      'Content-Transfer-Encoding: base64',
      '',
      pdf.toString('base64').replace(/(.{76})/g, '$1\r\n'),
      '--b1--',
      '',
    ].join('\r\n'),
  );
  const res = await fetch(`${base}/api/mail/inbound`, {
    method: 'POST',
    body: raw,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'message/rfc822',
      'x-mail-from': from,
      'x-mail-to': to,
    },
  });
  assert.equal(res.status, 200, `the inbox took the mail to ${to}`);
  return (await res.json()).id as number;
};
const sent = () => lettermint.received.splice(0);
const told = async () => {
  await new Promise(resolve => setImmediate(resolve));
  return (
    db
      .prepare("select text from events where type = 'log' and text like 'Mail: NEEDS A PERSON%' order by id")
      .all() as { text: string }[]
  ).map(r => r.text);
};

test('the mail already in goes whole to the saved address in one email, then each new one as it comes, once; nothing else goes', async () => {
  const invoice = await inbound('invoices@testco.example'),
    agreement = await inbound('documents@old.example', 'legal@partner.example', 'Signed DPA');
  const receipt = await inbound('hello@testco.example', 'receipts@billing.example', 'Your receipt'); // filed at invoices@
  const seat = await inbound('seat-1@testco.example', 'billing@seller.example', 'Your receipt from Seller #77'); // filed at invoices@
  await inbound('hello@testco.example', 'someone@example.com', 'A question');
  await inbound('board@testco.example', 'receipts@billing.example', 'Your sign-in code');
  await inbound('seat-1@testco.example', 'billing@seller.example', 'Your sign-in code');
  const filed = mail.fileMail({
    sender: 'the board (desk phone)',
    recipient: 'invoices@testco.example',
    subject: 'Billing: the invoice',
    text: 'The board added this file.',
    file: { name: 'registrar.pdf', type: 'application/pdf', bytes: PDF },
  });

  await forward.pass();
  assert.deepEqual(sent(), [], 'nothing goes before the board has saved the address');
  assert.deepEqual(secrets.saveSecrets([forward.KEY], { [forward.KEY]: BOARD }), { saved: [forward.KEY], refused: {} });
  await forward.pass();
  const [all, ...more] = sent(),
    ids = [invoice, agreement, receipt, seat, filed];
  assert.deepEqual(more, []);
  assert.deepEqual([all.to, all.from], [[BOARD], 'Testco <invoices@testco.example>']);
  for (const subject of [
    'Invoice 2026-101',
    'Signed DPA',
    'Your receipt',
    'Your receipt from Seller #77',
    'Billing: the invoice',
  ])
    assert.ok(all.text.includes(subject), `the original subject reaches the recipient: ${subject}`);
  assert.deepEqual(
    [...all.text.matchAll(/mail #(\d+)\b/g)].map(m => Number(m[1])),
    ids,
  );
  for (const fact of [
    'invoices@testco.example',
    'shop@supplier.example',
    'invoice-101.pdf',
    'Your invoice is attached.',
  ])
    assert.ok(all.text.includes(fact), `the original message fact reaches the recipient: ${fact}`);
  assert.deepEqual(
    all.attachments.map((a: any) => [a.filename, a.content_type]),
    [...Array(4).fill(['invoice-101.pdf', 'application/pdf']), ['registrar.pdf', 'application/pdf']],
  );
  for (const a of all.attachments)
    assert.deepEqual(Buffer.from(a.content, 'base64'), PDF, 'each file goes byte for byte');
  assert.equal((await h.board(`/api/mail/one?id=${invoice}`)).status, 200, 'the mail stays in HQ');

  await forward.pass();
  assert.deepEqual(sent(), [], 'each goes once');
  await inbound('documents@testco.example', 'legal@partner.example', 'Countersigned');
  await forward.pass();
  const next = sent();
  assert.equal(next.length, 1);
  assert.deepEqual([next[0].from, next[0].attachments.length], ['Testco <documents@testco.example>', 1]);
  assert.ok(next[0].subject.includes('Countersigned'));
});

test("what doesn't fit one email goes in as few as fit", async () => {
  const big = (n: number) => Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(9_000_000, n)]);
  const ids = [
    await inbound('invoices@testco.example', 'a@supplier.example', 'A', big(1)),
    await inbound('invoices@testco.example', 'b@supplier.example', 'B', big(2)),
    await inbound('invoices@testco.example', 'c@supplier.example', 'C', big(3)),
  ];
  await forward.pass();
  const emails = sent();
  assert.equal(emails.length, 2);
  assert.deepEqual(emails.flatMap(e => [...e.text.matchAll(/mail #(\d+)\b/g)].map(m => Number(m[1]))).sort(), ids);
  for (const e of emails) assert.ok(JSON.stringify(e).length <= 25_000_000, "each within the service's 25 MB");
});

test("a copy that didn't surely go, refused or with no answer, is told for a person at once and never sent again", async () => {
  const refused = await inbound('invoices@testco.example', 'shop@supplier.example', 'Too big');
  lettermint.script.push('refuse:attachments');
  await forward.pass();
  const lost = await inbound('invoices@testco.example', 'shop@supplier.example', 'Lost');
  lettermint.script.push('lose');
  await forward.pass();
  const first = sent();
  assert.equal(first.length, 2);
  assert.ok(first[0].subject.includes('Too big'));
  assert.ok(first[1].subject.includes('Lost'));
  const lines = await told();
  assert.equal(lines.length, 2);
  assert.match(lines[0], new RegExp(`mail #${refused}\\b`));
  assert.match(lines[1], new RegExp(`mail #${lost}\\b`));

  await forward.pass();
  assert.deepEqual(sent(), [], 'neither goes again by itself');
  assert.equal((await told()).length, 2);
});

test('a mail whose files HQ no longer keeps sends no copy without them, and is told for a person once', async () => {
  const old = await inbound('ads@testco.example', 'partner@ads.example', 'Statement');
  mail.sweep(Date.now() + (mail.ATTACHMENT_DAYS + 1) * 864e5); // its files go, its names stay
  const text = readFileSync(BRAND, 'utf8');
  writeFileSync(BRAND, text.replace('forward: [invoices, documents]', 'forward: [invoices, documents, ads]'));
  try {
    await forward.pass();
    assert.deepEqual(sent(), []);
    const lines = await told();
    assert.equal(lines.length, 3);
    assert.match(lines[2], new RegExp(`mail #${old}\\b`));
    await forward.pass();
    assert.deepEqual([sent(), (await told()).length], [[], 3]);
  } finally {
    writeFileSync(BRAND, text);
  }
});

test('the desk phone refuses unusable addresses and accepts a dot-atom address with an apostrophe', () => {
  for (const value of ['ada at home', 'ada@home..example', 'ada@home.example.']) {
    const answer = secrets.saveSecrets([forward.KEY], { [forward.KEY]: value });
    assert.ok(typeof answer === 'object' && answer.refused[forward.KEY]);
  }
  const value = "o'brien@example.com";
  assert.deepEqual(secrets.saveSecrets([forward.KEY], { [forward.KEY]: value }), { saved: [forward.KEY], refused: {} });
  assert.equal(secrets.secret(forward.KEY), value);
});
