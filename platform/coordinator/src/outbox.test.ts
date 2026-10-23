// node --test src/outbox.test.ts   (emails to outside parties: hq mail draft, the board's card, Send and Discard; the
// harness, the real hq, a local stand-in for the email service)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { commitFile, fakeLettermint } from './fixture.ts';
import { harness, until, type Running } from './harness.ts';

const lettermint = await fakeLettermint(), { taken } = lettermint;
const MAIL_TOKEN = 'mail-worker-test-token-0123456789';
const h = await harness('outbox', {
  env: { PUBLIC_HOST: 'hq.testco.example' },
  before: repo => {
    commitFile('infra/mail/token.sha256', createHash('sha256').update(MAIL_TOKEN).digest('hex'), "Email: rotate the inbox Worker's token");
    // claude-1@ is the board's alone (mail.ts boardOnly)
    writeFileSync(`${repo}/company/brand.yaml`, readFileSync(`${repo}/company/brand.yaml`, 'utf8')
      .replace('mail: { domain: testco.example }', 'mail: { domain: testco.example, boardOnly: [claude-1], partnersFrom: [press.example], forwardTo: moss }'));
  } });
const { repo, base, db, board, hq, boardCookie } = h;
lettermint.on();

const running = (agent: string) => h.start({ agent });
const letter = (text: string) => { const f = `${h.dataDir}/${Math.random().toString(36).slice(2)}.txt`; writeFileSync(f, text); return f; };
const draft = (j: Running, subject: string, ...more: string[]) => hq(j, 'mail', 'draft', '--to', 'legal@partner.example',
  '--subject', subject, '--why', 'They asked for our transfer assessment', ...more, letter('Dear legal team,\n\nHere it is.\n\nKind regards,'));
const card = async (title: string) => ((await board('/api/requests')).body as any[]).find(r => r.title === title);
const archived = async (id: number) => ((await board('/api/requests/archive')).body.cards as any[]).find(c => c.id === id);
// (no route clears the board's name once given: a company that never set one is the table without it)
const setName = async (name: string | null) => name ? assert.equal((await board('/api/care/name', { name })).status, 200)
  : db.prepare("delete from settings where key = 'care.name'").run();
// What the agent hears next: the job HQ made for it, as the worker hands it over (the jobs HQ makes run on claude; the
// harness's own on engines of their own). Takes every one waiting, so the next call hears only what came since.
const heard = async (agent: string) => {
  let j: Running | null, mine: Running | undefined;
  while ((j = await h.claim())) if (j.agent === agent) mine = j;
  return mine;
};

test('a draft reaches the desk phone as an email card, and its Send sends the edited text with the sign-off and tells the agent', async () => {
  await setName('Ada Board');
  const wren = await running('wren');
  const filed = await draft(wren, 'Our transfer impact assessment', '--to', 'dpo@partner.example', '--cc', 'counsel@partner.example', '--from', 'privacy', '--reply-to', 'privacy@');
  assert.equal(filed.code, 0, filed.out);
  const id = Number(filed.out.match(/Email draft #(\d+)/)![1]);
  await h.finish(wren);   // the agent has moved on: the answer becomes a job for it

  const c = await card('Our transfer impact assessment');
  assert.equal(c.kind, 'mail');
  assert.equal(c.body, 'They asked for our transfer assessment');
  assert.deepEqual([c.mail.to, c.mail.cc, c.mail.from, c.mail.replyTo],
    [['legal@partner.example', 'dpo@partner.example'], ['counsel@partner.example'], 'privacy@testco.example', 'privacy@testco.example']);
  assert.equal(c.mail.signoff, 'Ada Board\nTestco');
  // the desk phone's answer box can't answer it, so it never leaves without Send or Discard
  assert.equal((await h.answer(c.id, 'ok')).status, 409);

  const sent = await board('/api/outbox/send', { id: c.id, subject: c.title, text: 'Dear legal team,\n\nHere it is, signed.\n\nKind regards,' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const out = taken.at(-1);
  // (the board signs: its name with the company's on the From line)
  assert.deepEqual([out.from, out.to, out.cc, out.reply_to, out.subject], ['"Ada Board, Testco" <privacy@testco.example>',
    ['legal@partner.example', 'dpo@partner.example'], ['counsel@partner.example'], ['privacy@testco.example'], 'Our transfer impact assessment']);
  assert.equal(out.text, 'Dear legal team,\n\nHere it is, signed.\n\nKind regards,\n\nAda Board\nTestco');
  assert.deepEqual(out.settings, { track_opens: false, track_clicks: false });
  assert.equal(out.html, undefined);   // without the company's look, plain text alone

  // the agent hears it with the text that went, and no outside party's address is on the card or in its answer
  const job = (await heard('wren'))!;
  assert.match(job.prompt, /Here it is, signed\.\n\nKind regards,\n\nAda Board\nTestco/);
  const shown = await archived(c.id);
  assert.equal(shown.status, 'answered');
  assert.doesNotMatch(JSON.stringify([shown.title, shown.body, shown.answer, job.prompt]), /partner\.example/);
  assert.equal((await board('/api/outbox/send', { id: c.id })).status, 404);   // once
  assert.equal(taken.length, 1);

  const state = await hq(await running('wren'), 'mail', 'draft', String(id));
  assert.equal(state.code, 0, state.out);
  assert.match(state.out, /^Email draft #\d+: sent/);
  assert.match(state.out, /Here it is, signed\./);
  assert.equal((await hq(await running('moss'), 'mail', 'draft', String(id))).code, 1);   // another agent's draft isn't theirs to read
});

test('a draft an agent signs ends with its name on behalf of the crew, in the email\'s language, and needs no board name', async () => {
  await setName(null);
  const vera = await running('vera');
  for (const more of [['--signed', 'nobody', '--lang', 'nl'], ['--signed', 'juno'], ['--signed', 'juno', '--lang', 'dutch'], ['--signed', 'juno', '--lang', 'de']])
    assert.equal((await draft(vera, 'Refused signed', ...more)).code, 1, more.join(' '));
  assert.equal(await card('Refused signed'), undefined);
  assert.equal((await draft(vera, 'Even kennismaken', '--signed', 'juno', '--lang', 'nl')).code, 0);
  assert.equal((await draft(vera, 'Our introduction', '--signed', 'vera', '--lang', 'en')).code, 0);
  await h.finish(vera);

  const dutch = await card('Even kennismaken'), signoff = 'Juno, namens de crew van Testco\n'
    + '(Geschreven door een AI-agent. Een mens bij Testco heeft deze mail gelezen en verstuurd.)';
  assert.deepEqual([dutch.mail.signed, dutch.mail.signoff], ['Juno', signoff]);
  // a company's own words for a language (brand.yaml's mail.signoffAgent); a language it leaves out stays the platform's
  const brandFile = `${repo}/company/brand.yaml`, brandText = readFileSync(brandFile, 'utf8');
  writeFileSync(brandFile, brandText.replace('mail: { domain: testco.example,', "mail: { domain: testco.example, signoffAgent: { en: '{agent} at {company}, an AI agent' },"));
  try {
    assert.equal((await card('Our introduction')).mail.signoff, 'Vera at Testco, an AI agent');
    assert.equal((await card('Even kennismaken')).mail.signoff, signoff);
  } finally { writeFileSync(brandFile, brandText); }

  // with no name of the board's in Settings: the agent signs, so it goes, with its sign-off, and the agent hears what went
  const sent = await board('/api/outbox/send', { id: dutch.id });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(taken.at(-1).text, `Dear legal team,\n\nHere it is.\n\nKind regards,\n\n${signoff}`);
  assert.ok((await heard('vera'))!.prompt.includes(`Kind regards,\n\n${signoff}`));
  await setName('Ada Board');
});

test('a draft is refused for an address that isn\'t one, and for a from or reply-to that isn\'t ours to read', async () => {
  const moss = await running('moss');
  const before = (await board('/api/requests')).body.length;
  for (const more of [['--to', 'not an address'], ['--from', 'someone@elsewhere.example'], ['--reply-to', 'claude-1'], ['--cc', 'x@y']]) {
    const r = await draft(moss, 'Refused', ...more);
    assert.equal(r.code, 1, `${more.join(' ')}: ${r.out}`);
  }
  // a reply-to whose mail becomes a Care card (hello@, while the company runs Care), as the from's default reply-to too
  mkdirSync(`${repo}/products/care`, { recursive: true });
  writeFileSync(`${repo}/products/care/product.yaml`, 'name: Care\n');
  try {
    for (const more of [['--reply-to', 'hello'], []]) assert.equal((await draft(moss, 'Refused', ...more)).code, 1);
  } finally { rmSync(`${repo}/products/care`, { recursive: true }); }
  // hello@ for the board alone, and no from or reply-to: the default reply-to is no address an agent can read
  const brandFile = `${repo}/company/brand.yaml`, brandText = readFileSync(brandFile, 'utf8');
  writeFileSync(brandFile, brandText.replace('boardOnly: [claude-1]', 'boardOnly: [claude-1, hello]'));
  try { assert.equal((await draft(moss, 'Refused')).code, 1); } finally { writeFileSync(brandFile, brandText); }
  // a from at a domain we only receive at (mail.also): mail goes out from the public one alone; a reply-to there is fine
  writeFileSync(brandFile, brandText.replace('mail: { domain: testco.example,', 'mail: { domain: testco.example, also: [old.example],'));
  try {
    const r = await draft(moss, 'Refused', '--from', 'ops@old.example');
    assert.equal(r.code, 1); assert.match(r.out, /at testco\.example/);
    assert.equal((await draft(moss, 'Our question', '--from', 'ops', '--reply-to', 'ops@old.example')).code, 0);
  } finally { writeFileSync(brandFile, brandText); }
  assert.equal((await board('/api/requests')).body.length, before + 1);
});

test('Discard sends nothing and tells the agent; a refused send or a missing name leaves the card waiting', async () => {
  const kit = await running('kit');
  assert.equal((await draft(kit, 'Our invoice question')).code, 0);
  assert.equal((await draft(kit, 'Our second question', '--reply-to', 'ops')).code, 0);
  await h.finish(kit);
  const first = await card('Our invoice question'), second = await card('Our second question'), count = taken.length;

  await setName(null);
  assert.equal((await board('/api/outbox/send', { id: first.id })).status, 409);
  await setName('Ada Board');
  lettermint.script = ['refuse'];
  assert.equal((await board('/api/outbox/send', { id: first.id })).status, 502);
  assert.equal(taken.length, count);
  assert.equal((await card('Our invoice question')).mail.status, 'open');

  assert.equal((await board('/api/outbox/discard', { id: second.id })).status, 200);
  assert.equal(await card('Our second question'), undefined);
  assert.match((await heard('kit'))!.prompt, /Discarded email #\d+/);
  assert.equal((await board('/api/outbox/send', { id: second.id })).status, 404);
  assert.equal(taken.length, count);
});

test('a send cut off by a restart comes back open, saying it may have gone, and is never sendable meanwhile', async () => {
  const lark = await running('lark');
  assert.equal((await draft(lark, 'Our cut-off email')).code, 0);
  const c = await card('Our cut-off email'), count = taken.length;
  const release = lettermint.hold();
  const first = board('/api/outbox/send', { id: c.id, subject: 'Our cut-off email, signed', text: 'Dear legal team,\n\nHere it is, signed.' });
  await until(() => taken.length > count, 'the email service has it');   // HQ has no answer yet
  assert.equal((await card('Our cut-off email')).mail.status, 'sending');
  assert.equal((await board('/api/outbox/send', { id: c.id })).status, 409);
  assert.equal((await board('/api/outbox/discard', { id: c.id })).status, 409);
  assert.equal((await h.answer(c.id, 'ok')).status, 409);

  // HQ restarts here: the new process finds the send in the table, never knowing whether it went
  (await import('./outbox.ts?restart')).start();
  const after = (await card('Our cut-off email')).mail;
  assert.equal(after.status, 'open');
  assert.ok(after.doubt);
  assert.deepEqual([after.subject, after.text], ['Our cut-off email, signed', 'Dear legal team,\n\nHere it is, signed.']);   // what may have gone
  assert.equal(taken.length, count + 1);
  // (a real restart ends the old process; here its send is let finish)
  release(); await first;
});

test('a draft carries png, jpg and pdf files from the repo: on the card, sent as attachments, listed for the agent', async () => {
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('a picture')]), pdf = Buffer.from('%PDF-1.7 an insert');
  mkdirSync(`${repo}/products/_cycles/insert`, { recursive: true });
  writeFileSync(`${repo}/products/_cycles/insert/front.png`, png);
  writeFileSync(`${repo}/products/_cycles/insert/insert.pdf`, pdf);
  writeFileSync(`${repo}/products/_cycles/insert/fake.jpg`, 'not a jpeg');
  writeFileSync(`${repo}/products/_cycles/insert/notes.txt`, 'words');
  const moss = await running('moss');
  for (const more of [['--attach', 'products/_cycles/insert/fake.jpg'], ['--attach', 'products/_cycles/insert/notes.txt'],
    ['--attach', 'products/_cycles/insert/gone.png'], ['--attach', '../outside.png'],
    ['--attach', 'products/_cycles/insert/front.png', '--attach', 'products/_cycles/insert/front.png']])
    assert.equal((await draft(moss, 'Refused attachment', ...more)).code, 1, more.join(' '));
  assert.equal(await card('Refused attachment'), undefined);
  const filed = await draft(moss, 'Our insert, attached', '--attach', './products/_cycles/insert/front.png', '--attach', 'products/_cycles/insert/insert.pdf');
  assert.equal(filed.code, 0, filed.out);
  const id = filed.out.match(/Email draft #(\d+)/)![1];
  // copied as filed: a change on main after it doesn't change what the board sees and sends
  writeFileSync(`${repo}/products/_cycles/insert/front.png`, Buffer.concat([png, Buffer.from(' changed')]));

  const c = await card('Our insert, attached');
  assert.deepEqual(c.mail.attachments, [{ n: 0, name: 'front.png', type: 'image/png', size: png.length },
    { n: 1, name: 'insert.pdf', type: 'application/pdf', size: pdf.length }]);
  const file = (cookie = boardCookie) => fetch(`${base}/api/outbox/file?id=${c.id}&n=0`, { headers: { cookie } });
  const shown = await file();
  assert.equal(shown.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await shown.arrayBuffer()), png);
  assert.equal((await file('')).status, 401);   // the board's alone
  assert.match((await hq(moss, 'mail', 'draft', id)).out, /Attachments:\nfront\.png \(1 KB\)\ninsert\.pdf \(1 KB\)/);

  assert.equal((await board('/api/outbox/send', { id: c.id })).status, 200);
  assert.deepEqual(taken.at(-1).attachments, [{ filename: 'front.png', content: png.toString('base64'), content_type: 'image/png' },
    { filename: 'insert.pdf', content: pdf.toString('base64'), content_type: 'application/pdf' }]);
  assert.match((await archived(c.id)).answer, /With 2 attachments: front\.png, insert\.pdf\.$/);
  // sent: the bytes go, the names stay
  assert.equal((await file()).status, 404);
  assert.match((await hq(moss, 'mail', 'draft', id)).out, /Attachments:\nfront\.png/);
  await h.finish(moss);
  rmSync(`${repo}/products/_cycles/insert`, { recursive: true });
});

// An answer to a sent email
const inbound = async (o: { from: string; to?: string; subject: string; text: string; headers?: string[] }) => {
  const raw = [`From: Sam <${o.from}>`, `To: ${o.to ?? 'documents@testco.example'}`, `Subject: ${o.subject}`, ...o.headers ?? [],
    'Content-Type: text/plain; charset=utf-8', '', o.text].join('\r\n');
  const res = await fetch(`${base}/api/mail/inbound`, { method: 'POST', body: raw, headers: { authorization: `Bearer ${MAIL_TOKEN}`,
    'x-mail-from': o.from, 'x-mail-to': o.to ?? 'documents@testco.example' } });
  assert.equal(res.status, 200);
  return (await res.json() as { id: number }).id;
};
// The answer jobs on HQ's list, oldest first, but those in `seen`
const answerJobs = (seen: number[] = []) => (h.jobs.listJobs() as unknown as { id: number; agent: string; title: string }[])
  .filter(j => j.title.startsWith('The answer') && !seen.includes(j.id)).reverse();

test("an answer threaded to a sent email is one job for its drafter, who may read it and draft the reply (a partner's mail isn't a customer's); unrelated mail is nothing", async () => {
  const juno = await running('juno');
  const filed = await draft(juno, 'Kennismaking Testco', '--signed', 'juno', '--lang', 'nl', '--reply-to', 'documents');
  assert.equal(filed.code, 0, filed.out);
  const email = Number(filed.out.match(/Email draft #(\d+)/)![1]);
  await h.finish(juno);
  assert.equal((await board('/api/outbox/send', { id: (await card('Kennismaking Testco')).id })).status, 200);
  await heard('juno');
  // it goes with HQ's own Message-ID, kept with the draft
  const { headers } = taken.at(-1), messageId = headers['Message-ID'];
  assert.match(messageId, new RegExp(`^<outbox-${email}\\.[\\w-]+@testco\\.example>$`));
  assert.equal(headers['X-LM-Preserve-Message-ID'], 'true');
  const before = answerJobs().map(j => j.id);

  // an unrelated mail to documents@, even from the same partner: nothing
  await inbound({ from: 'sam@partner.example', subject: 'Verwerkersovereenkomst', text: 'Signed, attached.' });
  assert.deepEqual(answerJobs(before), []);

  // the answer, threaded to it: one job for Juno, who reads it without the business mail role. A partner's answer to a
  // business address, from where the email went, holds no customer's details (outbox.ts fromPartner): the job can draft
  // the reply
  const answer = await inbound({ from: 'sam@partner.example', subject: 'Re: Kennismaking', text: 'Graag! 20% korting op testorders.',
    headers: ['Message-ID: <a1@partner.example>', `In-Reply-To: ${messageId}`, `References: ${messageId}`] });
  let made = answerJobs(before);
  assert.deepEqual(made.map(j => [j.agent, j.title]), [['juno', `The answer to email #${email} (Kennismaking Testco) came in: HQ mail #${answer}`]]);
  const reader = await running('juno');
  const read = await hq(reader, 'mail', String(answer));
  assert.equal(read.code, 0, read.out);
  assert.match(read.out, /20% korting op testorders/);
  assert.equal(h.jobs.holdsCustomerData(reader.id), false);
  assert.equal((await draft(reader, 'Re: Kennismaking Testco')).code, 0);
  assert.ok(await card('Re: Kennismaking Testco'));
  assert.equal((await hq(reader, 'mail', String(answer - 1))).code, 1);   // the unrelated one isn't theirs
  assert.equal((await hq(reader, 'mail', '--to', 'documents@')).code, 1);   // nor is the address
  assert.equal((await hq(await running('moss'), 'mail', String(answer))).code, 1);   // nor another agent's
  await h.finish(reader);

  // a second answer while the job waits joins it; the same mail delivered to a second address of ours counts once
  const second = await inbound({ from: 'sam@partner.example', subject: 'Re: Kennismaking', text: 'En nog iets.',
    headers: ['Message-ID: <a2@partner.example>', `References: ${messageId} <a1@partner.example>`] });
  await inbound({ from: 'sam@partner.example', to: 'ops@testco.example', subject: 'Re: Kennismaking', text: 'En nog iets.',
    headers: ['Message-ID: <a2@partner.example>', `References: ${messageId} <a1@partner.example>`] });
  made = answerJobs(before);
  assert.deepEqual(made.map(j => j.title), [`The answers to email #${email} (Kennismaking Testco) came in: HQ mail #${answer}, #${second}`]);
  // once it has started, the next answer is one more job; an out-of-office is none. Its brief names the mail, not the partner.
  const started = (await h.claim())!;
  assert.equal(started.id, made[0].id);
  assert.match(started.prompt, new RegExp(`hq mail ${answer}`));
  assert.doesNotMatch(started.prompt, /partner\.example/);
  await inbound({ from: 'sam@partner.example', subject: 'Automatisch antwoord: Kennismaking', text: 'Afwezig.',
    headers: ['Auto-Submitted: auto-replied', `In-Reply-To: ${messageId}`] });
  assert.equal(answerJobs(before).length, 1);
  await inbound({ from: 'sam@partner.example', subject: 'Re: Kennismaking', text: 'Nog een vraag.', headers: [`In-Reply-To: ${messageId}`] });
  assert.equal(answerJobs(before).length, 2);
  await h.finish(started);

  // Finance's listing of documents@ says which mail is already with its drafter
  const listed = await hq(await running('penny'), 'mail', '--to', 'documents@');
  assert.match(listed.out, new RegExp(`#${answer} .*\\(answers email #${email}: with its drafter\\)`));
  assert.doesNotMatch(listed.out, new RegExp(`#${answer - 1} .*answers email`));
});

test('an answer without a thread is matched by its reply-to, the domain it went to and its subject (a client that drops the thread)', async () => {
  const moss = await running('moss');
  assert.equal((await draft(moss, 'Our A6 insert', '--reply-to', 'documents')).code, 0);
  await h.finish(moss);
  assert.equal((await board('/api/outbox/send', { id: (await card('Our A6 insert')).id })).status, 200);
  const before = answerJobs().map(j => j.id);
  await inbound({ from: 'someone@elsewhere.example', subject: 'Re: Our A6 insert', text: 'Not the partner.' });
  await inbound({ from: 'sam@partner.example', subject: 'Our prices', text: 'Another subject.' });
  await inbound({ from: 'sam@partner.example', subject: 'Re: Our A6 insert, and the order', text: 'More than the subject.' });
  // the same subject from the same domain, to a customer's address: a customer's mail, which Moss can't read
  const customers = await inbound({ from: 'sam@partner.example', to: 'hello@testco.example', subject: 'Re: Our A6 insert', text: 'My order.' });
  assert.deepEqual(answerJobs(before), []);
  assert.equal((await hq(await running('moss'), 'mail', String(customers))).code, 1);
  const id = await inbound({ from: 'sam@mail.partner.example', subject: 'Antw: Our  A6 insert', text: 'Use the 350 g card.' });
  const made = answerJobs(before);
  assert.deepEqual(made.map(j => j.agent), ['moss']);
  assert.match(made[0].title, new RegExp(`HQ mail #${id}$`));
});

// A reply on the partner's thread: a helpdesk files mail on a ticket by its
// In-Reply-To and References alone
// A partner's mail to the board's own address that the board handed to the team (mail.ts forward) is answered from the job it
// went to, threaded, and from no other.
test("a partner's board-only mail the board hands on is answered from its job alone", async () => {
  const id = await inbound({ from: 'pia@press.example', to: 'claude-1@testco.example', subject: 'An interview?', text: 'Free on Friday?',
    headers: ['Message-ID: <i1@press.example>'] });
  const made = (await board('/api/mail/forward', { id })).body.job;
  // the route gives the job no engine of its own: one here, the only way to claim that job and no other
  db.prepare('update jobs set engine = ? where id = ?').run('engine-handed', made);
  const handed = (await h.claim('engine-handed'))!, other = await running('moss');
  assert.equal(handed.id, made);
  assert.match((await draft(other, 'Re: An interview?', '--answers', String(id))).out, new RegExp(`HQ mail #${id} isn't one this job may read`));
  const reply = await draft({ ...handed, agent: 'moss' }, 'Re: An interview?', '--answers', String(id));
  assert.equal(reply.code, 0, reply.out);
  assert.equal((await card('Re: An interview?')).mail.answers, id);
  await h.finish(other); await h.finish(handed);
});

test('a reply drafted --answers <mail> goes with that mail\'s In-Reply-To and References; only for a partner\'s mail the job may read', async () => {
  const moss = await running('moss');
  assert.equal((await draft(moss, 'Our sample order', '--reply-to', 'documents')).code, 0);
  await h.finish(moss);
  assert.equal((await board('/api/outbox/send', { id: (await card('Our sample order')).id })).status, 200);
  await heard('moss');
  const messageId = taken.at(-1).headers['Message-ID'], before = answerJobs().map(j => j.id);
  // the answer, from a helpdesk that keeps its own ids in the thread
  const answer = await inbound({ from: 'desk@partner.example', subject: 'Re: Our sample order [#9]', text: 'Which paper?',
    headers: ['Message-ID: <t2@desk.partner.example>', `In-Reply-To: ${messageId}`, `References: ${messageId} <t1@desk.partner.example>`] });
  const other = await inbound({ from: 'sam@partner.example', subject: 'Our prices', text: 'Attached.', headers: ['Message-ID: <p1@partner.example>'] });
  const [job] = answerJobs(before);
  assert.match(job.title, new RegExp(`HQ mail #${answer}$`));
  assert.match((h.db.prepare('select prompt from jobs where id = ?').get(job.id) as { prompt: string }).prompt, new RegExp(`--answers ${answer} `));

  const reader = await running('moss');
  // business mail that answers none of Moss's emails isn't Moss's to read, so not to answer either; nor is a mail that isn't
  for (const id of [other, 9999]) assert.match((await draft(reader, 'Re: Our prices', '--answers', String(id))).out, new RegExp(`HQ mail #${id} isn't one this job may read`));
  // an answer threaded to Moss's email from where it never went (a customer it was forwarded to) is Moss's to read, but its
  // ids are that customer's: not answered from here
  const forwarded = await inbound({ from: 'jan@elsewhere.example', subject: 'Re: Our sample order', text: 'Me too.',
    headers: ['Message-ID: <j1@elsewhere.example>', `In-Reply-To: ${messageId}`] });
  assert.match((await draft(reader, 'Re: Our sample order', '--answers', String(forwarded))).out, new RegExp(`HQ mail #${forwarded} isn't a partner's `));
  const reply = await draft(reader, 'Re: Our sample order [#9]', '--answers', String(answer));
  assert.equal(reply.code, 0, reply.out);
  const c = await card('Re: Our sample order [#9]');
  assert.equal(c.mail.answers, answer);
  assert.match((await hq(reader, 'mail', 'draft', reply.out.match(/Email draft #(\d+)/)![1])).out, new RegExp(`Answers: HQ mail #${answer}\n`));
  await h.finish(reader);
  assert.equal((await board('/api/outbox/send', { id: c.id })).status, 200);
  const { headers } = taken.at(-1);
  assert.deepEqual([headers['In-Reply-To'], headers.References], ['<t2@desk.partner.example>', `${messageId} <t1@desk.partner.example> <t2@desk.partner.example>`]);
  assert.notEqual(headers['Message-ID'], messageId);
  await heard('moss');

  // the business mail role reads the partner's answer, so it may answer it too; the role's other business mail can be a
  // customer's, so it isn't answered from here; a draft that answers nothing goes without the headers
  const penny = await running('penny');
  assert.match((await draft(penny, 'Re: Our prices', '--answers', String(other))).out, new RegExp(`HQ mail #${other} isn't a partner's `));
  assert.equal((await draft(penny, 'Re: Our sample order, the paper', '--answers', String(answer))).code, 0);
  assert.equal((await draft(penny, 'Our next order')).code, 0);
  await h.finish(penny);
  assert.equal((await board('/api/outbox/send', { id: (await card('Re: Our sample order, the paper')).id })).status, 200);
  assert.equal(taken.at(-1).headers.References, `${messageId} <t1@desk.partner.example> <t2@desk.partner.example>`);
  assert.equal((await board('/api/outbox/send', { id: (await card('Our next order')).id })).status, 200);
  assert.deepEqual(Object.keys(taken.at(-1).headers), ['Message-ID', 'X-LM-Preserve-Message-ID']);
  await heard('penny');
});

// The mark follows what was read: a partner's business mail (an answer to a sent email, from where it went) leaves a job
// free; anyone else's, threaded or from the partner's domain, marks it, in a listing too.
test("a partner's answer leaves its reader unmarked; a stranger's, one threaded from elsewhere, a partner's domain's other mail, a late one, or a listing with any marks it", async () => {
  const filer = await running('vera');
  assert.equal((await draft(filer, 'Our parcel insert', '--to', 'ops@printer.example', '--reply-to', 'documents')).code, 0);
  await h.finish(filer);
  assert.equal((await board('/api/outbox/send', { id: (await card('Our parcel insert')).id })).status, 200);
  await heard('vera');
  const thread = [`In-Reply-To: ${taken.at(-1).headers['Message-ID']}`];
  const stranger = await inbound({ from: 'jan@elsewhere.example', subject: 'My order', text: 'Jan Jansen, Dorpsstraat 1.' });
  const forwarded = await inbound({ from: 'jan@elsewhere.example', subject: 'Re: Our parcel insert', text: 'My order too.', headers: thread });
  const atCase = await inbound({ from: 'anna@printer.example', to: 'hello@testco.example', subject: 'Hello', text: 'Hi.' });
  const sameDomain = await inbound({ from: 'anna@printer.example', subject: 'Your test order', text: 'Shipped today.' });
  const sent = h.db.prepare("select decided from outbox where subject = 'Our parcel insert'").get() as { decided: string };
  h.db.prepare("update outbox set decided = '2020-01-01T00:00:00.000Z' where subject = 'Our parcel insert'").run();
  const late = await inbound({ from: 'anna@printer.example', subject: 'Re: Our parcel insert', text: 'Months later.' });
  h.db.prepare("update outbox set decided = ? where subject = 'Our parcel insert'").run(sent.decided);
  const partner = await inbound({ from: 'anna@printer.example', subject: 'Re: Our parcel insert', text: 'Shipped today.', headers: thread });
  const unthreaded = await inbound({ from: 'support@mail.printer.example', subject: 'Re: Our parcel insert', text: 'Attached.' });
  const read = async (...paths: string[]) => {
    const j = await running('penny');
    for (const path of paths) assert.equal((await h.agent(path, j.token)).status, 200, path);
    return j;
  };
  const free = await read(`mail?id=${partner}`, `mail?id=${unthreaded}`, 'mail?limit=2', `mail-raw?id=${partner}`);
  assert.equal(h.jobs.holdsCustomerData(free.id), false, "a partner's answers, and a listing of only those");
  assert.equal((await draft(free, 'Re: Our parcel insert', '--to', 'anna@printer.example')).code, 0, 'so it drafts the reply');
  for (const [paths, why] of [[[`mail?id=${stranger}`], "a stranger's mail to a business address"],
    [[`mail?id=${forwarded}`], 'an answer threaded to the email, from an address it never went to'],
    [[`mail?id=${atCase}`], "a customer's address, whoever wrote"], [[`mail?id=${sameDomain}`], "the partner's domain, but no answer"],
    [[`mail?id=${late}`], `an unthreaded answer more than its days after the email`], [['mail?limit=3'], 'a listing with a late one in it']] as [string[], string][]) {
    const j = await read(...paths);
    assert.equal(h.jobs.holdsCustomerData(j.id), true, why);
    assert.equal((await draft(j, 'Re: anything', '--to', 'anna@printer.example')).code, 1, why);
  }
});

// A partner brand.yaml names (mail.partnersFrom) isn't a customer: its own mail to a business address, an answer to no
// email of ours, leaves its reader free to draft the reply on its thread; the same partner at a customer's address, or a
// look-alike domain, marks it
test("a listed partner's own mail leaves its reader unmarked and is answered from here; at a customer's address, or from a look-alike, it marks", async () => {
  const own = await inbound({ from: 'alex@press.example', subject: 'Our design file', text: 'Could you send the design file?',
    headers: ['Message-ID: <c1@press.example>'] });
  const reader = await running('penny');
  for (const path of [`mail?id=${own}`, 'mail?limit=1']) assert.equal((await h.agent(path, reader.token)).status, 200, path);
  assert.equal(h.jobs.holdsCustomerData(reader.id), false, "a listed partner's mail, and a listing of only that");
  const reply = await draft(reader, 'Re: Our design file', '--to', 'alex@press.example', '--answers', String(own));
  assert.equal(reply.code, 0, reply.out);
  assert.equal((await card('Re: Our design file')).mail.answers, own);
  await h.finish(reader);
  const atHello = await inbound({ from: 'alex@press.example', to: 'hello@testco.example', subject: 'Hello', text: 'Hi.' });
  const lookAlike = await inbound({ from: 'alex@press.example.net', subject: 'Our design file', text: 'The file, please.' });
  for (const [id, why] of [[atHello, "a customer's address, whoever wrote"], [lookAlike, 'a domain that only starts like the partner\'s']] as [number, string][]) {
    const j = await running('penny');
    assert.equal((await h.agent(`mail?id=${id}`, j.token)).status, 200, why);
    assert.equal(h.jobs.holdsCustomerData(j.id), true, why);
    assert.equal((await draft(j, 'Re: anything', '--to', 'alex@press.example')).code, 1, why);
    await h.finish(j);
  }
});

test('hq close withdraws the drafter\'s own open draft unsent, saying nothing of the board; never one being sent, another\'s or a sent one', async () => {
  await setName('Ada Board');
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('an old picture')]);
  mkdirSync(`${repo}/products/_cycles/withdrawn`, { recursive: true });
  writeFileSync(`${repo}/products/_cycles/withdrawn/old.png`, png);
  const filer = await running('vera');
  const filed = await draft(filer, 'Our first introduction', '--attach', 'products/_cycles/withdrawn/old.png');
  assert.equal(filed.code, 0, filed.out);
  const id = filed.out.match(/Email draft #(\d+)/)![1];
  assert.equal((await draft(filer, 'Our introduction, being sent')).code, 0);
  assert.equal((await draft(filer, 'Our introduction, sent')).code, 0);
  await h.finish(filer);   // moved on: anything the board's side said now would become a job for vera
  const old = await card('Our first introduction'), sending = await card('Our introduction, being sent'), sent = await card('Our introduction, sent');
  const vera = await running('vera'), pylon = await running('pylon'), count = taken.length;
  await heard('vera');

  // another agent's draft isn't theirs to withdraw, and hq close says why rather than failing silently
  const theirs = await hq(pylon, 'close', String(old.id));
  assert.equal(theirs.code, 22, theirs.out);
  assert.match(theirs.out, /isn't an open card of yours/);
  assert.equal((await card('Our first introduction')).mail.status, 'open');

  // the drafter's own open draft: off the desk phone, unsent, its bytes gone, and no answer or job saying the board didn't send it
  const closed = await hq(vera, 'close', String(old.id));
  assert.equal(closed.code, 0, closed.out);
  assert.equal(await card('Our first introduction'), undefined);
  // the board's archive shows it as withdrawn by its drafter (desk.js reads mail.status)
  const shown = await archived(old.id);
  assert.deepEqual([shown.status, shown.answer, shown.mail.status], ['done', null, 'withdrawn']);
  assert.equal(await heard('vera'), undefined);
  assert.equal((await fetch(`${base}/api/outbox/file?id=${old.id}&n=0`, { headers: { cookie: boardCookie } })).status, 404);
  assert.equal((await board('/api/outbox/send', { id: old.id })).status, 404);
  assert.equal(taken.length, count);
  assert.match((await hq(vera, 'mail', 'draft', id)).out, /^Email draft #\d+: withdrawn/);

  // one being sent stays, with the reason
  const release = lettermint.hold();
  const going = board('/api/outbox/send', { id: sending.id });
  await until(() => taken.length > count, 'the email service has it');
  const refused = await hq(vera, 'close', String(sending.id));
  assert.equal(refused.code, 22, refused.out);
  assert.match(refused.out, /being sent right now/);
  release();
  assert.equal((await going).status, 200);

  // a sent one is untouched
  assert.equal((await board('/api/outbox/send', { id: sent.id })).status, 200);
  assert.equal((await hq(vera, 'close', String(sent.id))).code, 22);
  const after = await archived(sent.id);
  assert.deepEqual([after.mail.status, after.status], ['sent', 'answered']);
  assert.match(after.answer, /^Sent email #/);
  await h.finish(vera); await h.finish(pylon);
  rmSync(`${repo}/products/_cycles/withdrawn`, { recursive: true });
});

test('with the company\'s look, an email goes as a letter: an HTML part with the sign-off as its signature, from the letter address in the board\'s name; the card previews it', async () => {
  const before = readFileSync(`${repo}/company/brand.yaml`, 'utf8');
  writeFileSync(`${repo}/company/letter-look.yaml`, 'styles: { p: "margin:0", sign: "color:#555" }\n'
    + 'page: "<html lang=\\"{lang}\\"><title>{subject}</title><img src=\\"https://img.testco.example/logo.png\\">{content}<hr>{signature}</html>"\n');
  writeFileSync(`${repo}/company/brand.yaml`, before.replace('mail: { domain: testco.example, boardOnly: [claude-1], partnersFrom: [press.example], forwardTo: moss }',
    'mail: { domain: testco.example, boardOnly: [claude-1], partnersFrom: [press.example], business: [partners], signoff: "{name}\\n{company}\\nhttps://www.testco.example\\n{address}",'
    + ' outbox: { address: partners, look: company/letter-look.yaml } }'));
  try {
    await setName('Ada Board');
    const juno = await running('juno');
    assert.equal((await hq(juno, 'mail', 'draft', '--to', 'hello@printer.example', '--subject', 'Kennismaken', '--why', 'Our introduction', '--lang', 'nl',
      letter('Beste mensen,\n\nMeer over ons: https://www.testco.example/about\n\nHartelijke groet,'))).code, 0);
    assert.equal((await hq(juno, 'mail', 'draft', '--to', 'hello@printer.example', '--subject', 'Signed by Juno', '--why', 'Our introduction',
      '--signed', 'juno', '--lang', 'en', letter('Dear printer,\n\n<b>Kind</b> regards,'))).code, 0);
    await h.finish(juno);

    // the letter address is the draft's sender and reply-to; the card says there's a preview
    const c = await card('Kennismaken');
    assert.deepEqual([c.mail.from, c.mail.replyTo, c.mail.preview], ['partners@testco.example', 'partners@testco.example', true]);
    assert.equal(c.mail.signoff, 'Ada Board\nTestco\nhttps://www.testco.example\npartners@testco.example');

    // the preview: the HTML part as it would go, behind the board's sign-in, unable to run script; the card's edits redraw it
    const preview = async (id: number, cookie = boardCookie) => {
      const res = await fetch(`${base}/api/outbox/preview?id=${id}`, { headers: { cookie } });
      return { status: res.status, csp: res.headers.get('content-security-policy') ?? '', html: await res.text() };
    };
    const first = await preview(c.id);
    assert.equal(first.status, 200);
    assert.match(first.csp, /sandbox/);
    assert.match(first.csp, /default-src 'none'/);
    assert.match(first.html, /<html lang="nl"><title>Kennismaken<\/title>/);
    assert.match(first.html, /<a href="https:\/\/www\.testco\.example\/about">/);
    assert.match(first.html, /<hr><p style="color:#555"><strong>Ada Board<\/strong>/);
    assert.equal((await preview(c.id, '')).status, 401);
    assert.equal((await board('/api/outbox/preview', { id: c.id, subject: 'Kennismaken', text: 'Beste allemaal,\n\nTot snel,' })).status, 200);
    assert.match((await preview(c.id)).html, /<p style="margin:0">Beste allemaal,<\/p>/);
    assert.equal((await board('/api/outbox/preview', { id: c.id, subject: 'Kennismaken', text: '' })).status, 400);
    // reopened, the card's boxes hold the filed text again and post it before the frame loads: the frame shows them, not the edit
    const reopened = await card('Kennismaken');
    assert.match(reopened.mail.text, /^Beste mensen,/);
    assert.equal((await board('/api/outbox/preview', { id: c.id, subject: reopened.mail.subject, text: reopened.mail.text })).status, 200);
    assert.equal((await preview(c.id)).html, first.html);
    // edited again: Send sends the letter the frame shows
    assert.equal((await board('/api/outbox/preview', { id: c.id, subject: 'Kennismaken', text: 'Beste allemaal,\n\nTot snel,' })).status, 200);
    const shown = (await preview(c.id)).html;

    // Send: the text as before, the HTML part beside it, in the board's name and the company's
    const sent = await board('/api/outbox/send', { id: c.id, subject: 'Kennismaken', text: 'Beste allemaal,\n\nTot snel,' });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    let out = taken.at(-1);
    assert.deepEqual([out.from, out.reply_to], ['"Ada Board, Testco" <partners@testco.example>', ['partners@testco.example']]);
    assert.equal(out.text, 'Beste allemaal,\n\nTot snel,\n\nAda Board\nTestco\nhttps://www.testco.example\npartners@testco.example');
    assert.equal(out.html, shown);
    assert.equal((await preview(c.id)).status, 404);   // a sent card has no preview

    // an agent signs: the company's name on the From line, its own words as the signature, the words escaped
    const signed = await card('Signed by Juno');
    assert.equal((await board('/api/outbox/send', { id: signed.id, subject: 'Signed by Juno', text: 'Dear printer,\n\n<b>Kind</b> regards,' })).status, 200);
    out = taken.at(-1);
    assert.equal(out.from, 'Testco <partners@testco.example>');
    assert.match(out.html, /&lt;b&gt;Kind&lt;\/b&gt; regards,/);
    assert.match(out.html, /<strong>Juno, on behalf of the crew at Testco<\/strong><br>\(Written by an AI agent\./);

    // a withdrawn draft has no preview, edited or not
    const drafter = await running('juno');
    assert.equal((await hq(drafter, 'mail', 'draft', '--to', 'hello@printer.example', '--subject', 'Withdrawn', '--why', 'x', letter('Hello,'))).code, 0);
    const withdrawn = await card('Withdrawn');
    assert.equal((await board('/api/outbox/preview', { id: withdrawn.id, subject: 'Withdrawn', text: 'Hello again,' })).status, 200);
    assert.equal((await hq(drafter, 'close', String(withdrawn.id))).code, 0);
    assert.equal((await preview(withdrawn.id)).status, 404);
    await h.finish(drafter);

    // a look file that's gone: nothing is sent
    assert.equal((await hq(await running('juno'), 'mail', 'draft', '--to', 'hello@printer.example', '--subject', 'No look', '--why', 'x',
      letter('Hello,'))).code, 0);
    rmSync(`${repo}/company/letter-look.yaml`);
    const none = await card('No look'), count = taken.length;
    assert.equal((await board('/api/outbox/send', { id: none.id, subject: 'No look', text: 'Hello,' })).status, 409);
    assert.equal(taken.length, count);
  } finally {
    writeFileSync(`${repo}/company/brand.yaml`, before);
    rmSync(`${repo}/company/letter-look.yaml`, { force: true });
  }
});
