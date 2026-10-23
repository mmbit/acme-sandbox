// node --test src/mailsummary.test.ts   (hq mail summary: Finance's books to the forward address, through the real hq
// command, the email service a local stand-in).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { harness } from './harness.ts';
import { fakeLettermint } from './fixture.ts';

const BOARD = 'ada@home.example';
const lettermint = await fakeLettermint();
let brandFile = '';
const h = await harness('mailsummary', {
  before: repo => {
    brandFile = `${repo}/company/brand.yaml`;
    writeFileSync(
      brandFile,
      readFileSync(brandFile, 'utf8').replace(
        'mail: { domain: testco.example }',
        'mail: { domain: testco.example, forward: [invoices, documents] }',
      ),
    );
  },
});
const { db } = h;
const secrets = await import('./secrets.ts');
const forward = await import('./mailforward.ts');
lettermint.on();

const dir = mkdtempSync(`${tmpdir()}/mailsummary-`);
// The books as Finance's generator writes them: UTF-8 with a euro sign and a CRLF, which must arrive as they are
const BOOKS = Buffer.from(
  'Testco: books for October 2026\r\nMonth still open, this is a preview.\nCosts: € 12,10\n',
  'utf8',
);
writeFileSync(`${dir}/books.txt`, BOOKS);
writeFileSync(`${dir}/body.txt`, 'Month to date: this preview does not replace the final October close.\n');
const ask = (job: any, month: string, kind: string, ...more: string[]) =>
  h.hq(
    job,
    'mail',
    'summary',
    '--month',
    month,
    '--kind',
    kind,
    '--records',
    '2026-10-21',
    '--attach',
    `${dir}/books.txt`,
    ...more,
    `${dir}/body.txt`,
  );
const sent = () => lettermint.received.splice(0);
const told = () =>
  (
    db.prepare("select text from events where type = 'log' and text like 'Mail:%' order by id").all() as {
      text: string;
    }[]
  ).map(r => r.text);
// Nothing a job or HQ's log sees holds the address
const unseen = (...outputs: string[]) => {
  for (const out of [...outputs, ...told(), JSON.stringify(db.prepare('select * from forward_reports').all())])
    assert.ok(!out.includes(BOARD), `the address stays out of: ${out}`);
};

test("Finance's books go once per month and kind, byte for byte, and only Finance sends them", async () => {
  const finance = await h.start({ agent: 'penny' }),
    process = await h.start({ agent: 'bolt' }),
    other = await h.start({ agent: 'vera' });

  const early = await ask(finance, '2026-06', 'preview');
  assert.equal(early.code, 2, early.out);
  assert.match(early.out, /2026-06 preview: not ready/);
  assert.deepEqual(sent(), []);
  assert.equal((await h.hq(finance, 'mail', 'summary')).code, 0);
  assert.deepEqual(forward.reports(), [], 'without the address the month stays pending');

  assert.deepEqual(secrets.saveSecrets([forward.KEY], { [forward.KEY]: BOARD }), { saved: [forward.KEY], refused: {} });
  for (const job of [process, other]) {
    const denied = await ask(job, '2026-06', 'preview');
    assert.equal(denied.code, 1);
  }
  assert.equal((await h.hq(other, 'mail', 'summary')).code, 1);
  assert.deepEqual(sent(), []);

  const preview = await ask(finance, '2026-06', 'preview');
  assert.equal(preview.code, 0, preview.out);
  assert.match(preview.out, /^2026-06 preview: accepted, records as of 2026-10-21, asked .* UTC, receipt m-1\n$/);
  const [mail, ...more] = sent();
  assert.deepEqual(more, []);
  assert.deepEqual(
    [mail.to, mail.from, mail.subject],
    [[BOARD], 'Testco <invoices@testco.example>', 'Testco books: 2026-06 preview'],
  );
  assert.match(
    mail.text,
    /^An automated summary from Testco's Finance agent.*not a customer's message\. Records as of 2026-10-21\.\n\nMonth to date/,
  );
  assert.deepEqual(
    mail.attachments.map((a: any) => [a.filename, a.content_type]),
    [['testco-books-2026-06-preview.txt', 'text/plain']],
  );
  assert.deepEqual(Buffer.from(mail.attachments[0].content, 'base64'), BOOKS, 'the file goes byte for byte');

  const twice = await ask(finance, '2026-06', 'preview');
  assert.equal(twice.code, 0);
  assert.match(twice.out, /^Asked before, nothing sent now: 2026-06 preview: accepted, .*receipt m-1/);
  assert.deepEqual(sent(), [], 'the same month and kind goes once');

  const closed = await ask(finance, '2026-06', 'closed');
  assert.equal(closed.code, 0, closed.out);
  const [close] = sent();
  assert.equal(close.subject, 'Testco books: 2026-06');
  assert.equal(close.attachments[0].filename, 'testco-books-2026-06.txt');
  assert.deepEqual(Buffer.from(close.attachments[0].content, 'base64'), BOOKS);

  const state = await h.hq(process, 'mail', 'summary', '--month', '2026-06');
  assert.equal(state.code, 0);
  assert.deepEqual(
    state.out
      .trim()
      .split('\n')
      .map(l => l.replace(/, asked .*/, '')),
    ['2026-06 preview: accepted, records as of 2026-10-21', '2026-06 closed: accepted, records as of 2026-10-21'],
  );
  unseen(early.out, preview.out, twice.out, closed.out, state.out);
});

test('a refused send is told and may be asked again; one that may have gone waits for --again', async () => {
  const finance = await h.start({ agent: 'penny' });
  lettermint.script.push('refuse:attachments');
  const refused = await ask(finance, '2026-09', 'closed');
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.out, /2026-09 closed: failed/);
  assert.match(told().at(-1)!, /^Mail: NEEDS A PERSON: Testco's books for 2026-09 to the forward address didn't go/);
  const retried = await ask(finance, '2026-09', 'closed');
  assert.equal(retried.code, 0, retried.out);
  assert.equal(sent().length, 2);

  lettermint.script.push('lose');
  const lost = await ask(finance, '2026-08', 'closed');
  assert.equal(lost.code, 3, lost.out);
  assert.match(lost.out, /2026-08 closed: uncertain.*\nIt may have gone/);
  assert.match(
    told().at(-1)!,
    /^Mail: NEEDS A PERSON: Testco's books for 2026-08 to the forward address may not have gone/,
  );
  const blind = await ask(finance, '2026-08', 'closed');
  assert.equal(blind.code, 3);
  assert.match(blind.out, /^Asked before, nothing sent now: 2026-08 closed: uncertain/);
  assert.equal(sent().length, 1, 'never again by itself');
  const again = await ask(finance, '2026-08', 'closed', '--again');
  assert.equal(again.code, 0, again.out);
  assert.equal(sent().length, 1);

  lettermint.script.push('lose');
  assert.equal((await ask(finance, '2026-05', 'closed')).code, 3);
  const arrive = (job: any, month: string) =>
    h.hq(job, 'mail', 'summary', '--month', month, '--kind', 'closed', '--arrived');
  assert.equal((await arrive(await h.start({ agent: 'bolt' }), '2026-05')).code, 1, 'only Finance records it');
  const arrived = await arrive(finance, '2026-05');
  assert.equal(arrived.code, 0, arrived.out);
  assert.match(arrived.out, /^2026-05 closed: arrived, .*arrival confirmed .* UTC\n$/);
  assert.ok(!arrived.out.includes('receipt'), 'no receipt is made up for it');
  const after = await ask(finance, '2026-05', 'closed');
  assert.equal(after.code, 0, 'an arrived close counts as delivered');
  assert.match(after.out, /^Asked before, nothing sent now: 2026-05 closed: arrived/);
  assert.equal((await arrive(finance, '2026-09')).code, 1, 'an accepted send is not confirmed again');
  assert.equal((await arrive(finance, '2026-04')).code, 1, 'nor one never asked');
  assert.equal(sent().length, 1, 'confirming sends nothing');
  unseen(refused.out, retried.out, lost.out, blind.out, again.out, arrived.out, after.out);
});

test('a send cut off when the service goes leaves the month pending; bad input is refused', async () => {
  const finance = await h.start({ agent: 'penny' });
  lettermint.off();
  try {
    const off = await ask(finance, '2026-07', 'closed');
    assert.equal(off.code, 2, off.out);
    assert.deepEqual(forward.reports('2026-07'), []);
  } finally {
    lettermint.on();
  }
  const brand = readFileSync(brandFile, 'utf8');
  writeFileSync(brandFile, brand.replace(', forward: [invoices, documents]', ''));
  try {
    const unboxed = await ask(finance, '2026-07', 'closed');
    assert.equal(unboxed.code, 2, 'no bookkeeping mailbox to send from: not ready, as the copies are');
    assert.deepEqual(forward.reports('2026-07'), []);
  } finally {
    writeFileSync(brandFile, brand);
  }
  writeFileSync(`${dir}/binary.txt`, Buffer.from([0xff, 0xfe, 0x00]));
  const binary = await h.hq(
    finance,
    'mail',
    'summary',
    '--month',
    '2026-07',
    '--kind',
    'closed',
    '--records',
    '2026-08-01',
    '--attach',
    `${dir}/binary.txt`,
    `${dir}/body.txt`,
  );
  assert.equal(binary.code, 1);
  assert.equal((await ask(finance, '2026-13', 'closed')).code, 1);
  assert.equal((await ask(finance, '2026-07', 'final')).code, 1);
  const thisMonth = (await import('./company.ts')).companyDay(Date.now()).slice(0, 7);
  assert.equal((await ask(finance, thisMonth, 'closed')).code, 1);
  assert.equal((await ask(finance, '9999-12', 'preview')).code, 1);
  assert.equal((await ask(finance, '2026-07', 'closed', '--records', '2026-07-01')).code, 1);
  assert.equal((await ask(finance, '2026-07', 'closed', '--records', '2026-11-31')).code, 1);
  assert.deepEqual(forward.reports(thisMonth), []);
  assert.deepEqual(forward.reports('2026-07'), []);
  assert.deepEqual(sent(), []);
});
