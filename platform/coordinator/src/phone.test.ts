// node --test src/phone.test.ts   (the test company; a stand-in for Twilio's API)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

const TOKEN = 'twilio-auth-token', BOARD = '+31600000001', PIN = '4711';
const listen = async (s: Server) => { await new Promise<void>(r => s.listen(0, r)); after(() => s.close()); return `http://localhost:${(s.address() as any).port}`; };
const ACCOUNT = 'AC' + 'a'.repeat(32), CALL = 'CA' + 'c'.repeat(32);
const seen: string[] = [];
const fail: Record<string, number> = {}; // 'METHOD part-of-url' -> how many 503s Twilio answers first
const calls = new Map<string, { status: string; end_time: string | null }>(); // what the account lists
let endless = false; // the calls list never ends
// the account's numbers, as Twilio lists them (hq phone --check)
const numbers: Record<string, unknown>[] = [];
const TWILIO_API = await listen(createServer((q, s) => {
  seen.push(`${q.method} ${q.url} ${q.headers.authorization}`);
  const key = Object.keys(fail).find(k => `${q.method} ${q.url}`.includes(k) && fail[k] > 0);
  if (key) { fail[key]--; s.writeHead(503); return s.end(); }
  if (q.method === 'DELETE') { calls.delete(q.url!.split('/').pop()!.replace('.json', '')); s.writeHead(204); return s.end(); }
  if (q.headers.authorization !== 'Basic ' + Buffer.from(`${ACCOUNT}:${TOKEN}`).toString('base64')) { s.writeHead(401); return s.end(); }
  if (q.url === `/2010-04-01/Accounts/${ACCOUNT}.json`) return s.end(JSON.stringify({ status: 'active', type: 'Full' }));
  if (q.url!.startsWith(`/2010-04-01/Accounts/${ACCOUNT}/IncomingPhoneNumbers.json`)) return s.end(JSON.stringify({ incoming_phone_numbers: numbers }));
  if (q.url!.includes('/Calls.json')) return s.end(JSON.stringify({ calls: [...calls].map(([sid, c]) => ({ sid, ...c })), next_page_uri: endless ? `/2010-04-01/Accounts/${ACCOUNT}/Calls.json?Page=1` : null }));
  s.writeHead(500); s.end();
}));

const h = await harness('phone', { env: { PUBLIC_HOST: 'hq.company.test', TWILIO_RETRY_MS: '10', TWILIO_API } });
const { deleteEndedCalls, rememberAccount } = await import('./calls.ts');   // (the server's hourly job, here when the test says)
const { openingLanguages } = await import('./phone.ts');
const { DIR } = await import('./secrets.ts');
// the board saves the phone line's keys on the desk phone
const bolt = await h.start({ agent: 'bolt' });
const check = async () => { const reply = await h.hq(bolt, 'phone', '--check'); assert.equal(reply.code, 0, reply.out); return reply.out; };
const keys = { TWILIO_AUTH_TOKEN: TOKEN, BOARD_PHONE_NUMBER: BOARD, CALL_PIN: PIN, TWILIO_PHONE_NUMBER: '+3197010000000' };
const saved = await h.answer(await h.ask(bolt, { kind: 'credential', title: 'The phone line', secrets: Object.keys(keys).join(',') }), '', { secrets: keys });
assert.equal(saved.status, 200, JSON.stringify(saved.body));

// what Twilio does: sign the full URL plus the sorted form fields with the auth token
async function twilio(path: string, fields: Record<string, string>, key = TOKEN) {
  const form = new URLSearchParams(fields);
  const sig = createHmac('sha1', key).update(`https://hq.company.test${path}` + [...form.keys()].sort().map(k => k + form.get(k)).join('')).digest('base64');
  const res = await fetch(h.base + path, { method: 'POST', body: form, headers: { 'x-twilio-signature': sig } });
  return { status: res.status, text: await res.text() };
}

test('an unsigned or wrongly signed call gets nothing', async () => {
  assert.equal((await twilio('/api/twilio/voice', { From: '+31612345678' }, 'wrong')).status, 403);
});

test("a customer hears the chime and the company's message in each language, then the call ends: nothing recorded, never the board's line", async () => {
  const r = await twilio('/api/twilio/voice', { From: '+31612345678', AccountSid: ACCOUNT, CallSid: CALL });
  assert.equal(r.status, 200);
  assert.match(r.text, /^<\?xml[^>]*><Response><Play>https:\/\/hq\.company\.test\/phone\/chime\.mp3<\/Play><Say language="en-GB" [^>]*>Hello, you've reached Testco[^<]*Help page[^<]*<\/Say><Say language="nl-NL" [^>]*>Hallo, u spreekt met Testco[^<]*<\/Say><Say language="de-DE" [^>]*>Hallo, Sie sind bei Testco[^<]*<\/Say><Hangup\/><\/Response>$/);
  assert.doesNotMatch(r.text, /Record|Gather|message|PIN|Stream|Dial/);
  // a customer typing digits at the PIN step still only gets the message
  assert.doesNotMatch((await twilio('/api/twilio/pin', { From: '+31612345678', Digits: PIN })).text, /Stream/);
});

test("the company's own words: a hello in each language, then its message in each, in its order", async () => {
  const file = `${h.repo}/company/brand.yaml`, was = readFileSync(file, 'utf8');
  try {
    writeFileSync(file, was.replace(/^phoneLine:\n( {2}.*\n)*/m, '') + `phoneLine:
  hello: { en: Hello, nl: Hallo, de: Guten Tag }
  greeting:
    nl: "Je belt met Testco."
    de: "Hier ist Testco."
    en: "This is Testco."
`);
    const own = (await twilio('/api/twilio/voice', { From: '+31612345678', CallSid: CALL })).text;
    assert.match(own, /<Play>[^<]*chime\.mp3<\/Play><Say language="nl-NL" [^>]*>Hallo<\/Say><Say language="de-DE" [^>]*>Guten Tag<\/Say><Say language="en-GB" [^>]*>Hello<\/Say><Say language="nl-NL" [^>]*>Je belt met Testco\.<\/Say><Say language="de-DE" [^>]*>Hier ist Testco\.<\/Say><Say language="en-GB" [^>]*>This is Testco\.<\/Say><Hangup\/><\/Response>$/);
    // the platform's own words, when a company gives none: all three, with its name
    writeFileSync(file, was.replace(/^phoneLine:\n( {2}.*\n)*/m, ''));
    const platform = (await twilio('/api/twilio/voice', { From: '+31612345678' })).text;
    assert.match(platform, /<Play>[^<]*chime\.mp3<\/Play><Say language="en-GB" [^>]*>Hello, you've reached Testco\. [^<]*Help page[^<]*<\/Say><Say language="nl-NL" [^>]*>Hallo, u spreekt met Testco\. [^<]*<\/Say><Say language="de-DE" [^>]*>Hallo, Sie sind bei Testco\. [^<]*<\/Say><Hangup\/><\/Response>$/);
  } finally { writeFileSync(file, was); }
});

test('the board still gets its PIN prompt and the team', async () => {
  assert.match((await twilio('/api/twilio/voice', { From: BOARD })).text, /Your PIN, please/);
  assert.match((await twilio('/api/twilio/pin', { From: BOARD, Digits: PIN })).text, /<Stream url="wss:\/\/hq\.company\.test\/voice\/twilio">/);
});

test('the board\'s number saved the way it\'s written at home still gets the PIN prompt; a withheld one says so', async () => {
  const file = `${DIR}/BOARD_PHONE_NUMBER`, answer = () => (h.db.prepare('select answer from phone_asks order by rowid desc limit 1').get() as { answer: string }).answer;
  try {
    for (const typed of ['06 0000 0001', '+31 (0)6 0000 0001', '0031 6 0000 0001', '31600000001']) {
      writeFileSync(file, typed);
      assert.match((await twilio('/api/twilio/voice', { From: BOARD })).text, /Your PIN, please/, typed);
    }
    // a national number is in the line's own country, not another's with the same digits
    writeFileSync(file, '06 0000 0001');
    assert.doesNotMatch((await twilio('/api/twilio/voice', { From: '+32600000001' })).text, /PIN/);
    assert.equal(answer(), "the company's message (another number)");
    for (const From of ['', 'anonymous', '+266696687']) {
      assert.doesNotMatch((await twilio('/api/twilio/voice', { From })).text, /PIN/);
      assert.equal(answer(), "the company's message (no caller ID)", From);
    }
    for (const typed of ['', '------']) {
      writeFileSync(file, typed);
      for (const From of [BOARD, '', 'anonymous']) {
        assert.doesNotMatch((await twilio('/api/twilio/voice', { From })).text, /PIN/, `${typed} ${From}`);
        assert.equal(answer(), "the company's message (no board number saved)", `${typed} ${From}`);
      }
    }
  } finally { writeFileSync(file, BOARD); }
});

test('every request Twilio makes is kept with its step and HQ\'s answer, never the caller\'s number', async () => {
  // (by row: the test before can write in the same millisecond)
  const since = (h.db.prepare('select coalesce(max(rowid), 0) n from phone_asks').get() as { n: number }).n;
  await twilio('/api/twilio/voice', { From: '+31612345678' }, 'wrong');
  await twilio('/api/twilio/voice', { From: '+31612345678' });
  await twilio('/api/twilio/voice', { From: BOARD });
  const kept = h.db.prepare('select step, answer from phone_asks where rowid > ? order by rowid').all(since);
  assert.deepEqual(kept.map(r => ({ ...r })), [
    { step: 'voice', answer: '403, signed with another token or URL' },
    { step: 'voice', answer: "the company's message (another number)" },
    { step: 'voice', answer: 'the board: PIN prompt' },
  ]);
  const stored = JSON.stringify(h.db.prepare('select step, answer from phone_asks').all());
  assert.ok(!stored.includes('+31612345678') && !stored.includes(BOARD));
});

test('unsigned requests to the public webhook never push Twilio\'s own rows out', async () => {
  await twilio('/api/twilio/voice', { From: '+31612345678' });
  for (let i = 0; i < 250; i++) await fetch(h.base + '/api/twilio/voice', { method: 'POST', body: new URLSearchParams({ From: '+31612345678' }) });
  const count = (where: string) => (h.db.prepare(`select count(*) n from phone_asks where ${where}`).get() as { n: number }).n;
  assert.ok(count("answer = 'the company''s message (another number)'") >= 1);
  assert.ok(count("answer like '403, %'") <= 20);
});

test('five wrong PINs shut the team line for an hour, even with the right PIN', async () => {
  // the board hears of wrong PINs
  const told = async () => (await h.feed()).filter(e => (e as any).to === 'board' && /wrong PIN/.test(e.text)).map(e => e.text);
  const before = (await told()).length;
  for (let i = 0; i < 5; i++) await twilio('/api/twilio/pin', { From: BOARD, Digits: '0000' });
  // the board hears of each one, and of the lockout, without the number or the digits
  const now = (await told()).slice(before);
  assert.equal(now.length, 5);
  assert.match(now[0], /1 of 5/);
  assert.match(now[4], /shut for an hour/);
  assert.ok(now.every(t => !t.includes(BOARD) && !t.includes('0000')));
  assert.match((await twilio('/api/twilio/pin', { From: BOARD, Digits: PIN })).text, /closed for now/);
  // customers still get the message
  assert.match((await twilio('/api/twilio/voice', { From: '+31612345678' })).text, /Testco, the company behind Pebblet/);
});
test("the line's own words to the board are in the board's language", async () => {
  assert.equal((await h.board('/api/language', { lang: 'nl' })).status, 200);
  try {
    // (still shut from the five wrong PINs above)
    assert.match((await twilio('/api/twilio/voice', { From: BOARD })).text, /<Say language="nl-NL" [^>]*>De lijn is voorlopig dicht\. Tot ziens\.<\/Say><Hangup\/>/);
    h.db.exec('delete from phone_misses');
    assert.match((await twilio('/api/twilio/voice', { From: BOARD })).text, /<Gather [^>]*><Say language="nl-NL" [^>]*>Testco\. Je pincode, graag\.<\/Say><\/Gather><Say language="nl-NL" [^>]*>Tot ziens\.<\/Say>/);
    assert.match((await twilio('/api/twilio/pin', { From: BOARD, Digits: '0000' })).text, /<Say language="nl-NL" [^>]*>Die pincode klopt niet\. Tot ziens\.<\/Say><Hangup\/>/);
    await h.board('/api/language', { lang: 'de' });
    assert.match((await twilio('/api/twilio/voice', { From: BOARD })).text, /<Say language="de-DE" [^>]*>Testco\. Deine PIN, bitte\.<\/Say>/);
    // strangers hear the company's message in its own languages, whatever the board's
    assert.match((await twilio('/api/twilio/voice', { From: '+31612345678' })).text, /^(?![\s\S]*PIN)[\s\S]*<Say language="en-GB"/);
  } finally {
    h.db.exec('delete from phone_misses');
    await h.board('/api/language', { lang: 'en' });
  }
  assert.match((await twilio('/api/twilio/voice', { From: BOARD })).text, /<Say language="en-GB" [^>]*>Testco\. Your PIN, please\.<\/Say>/);
});

test('the hourly job deletes every call that ended 10 minutes ago at Twilio, but not one still on or just ended', async () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toUTCString(), CA = (n: number) => 'CA' + String(n).repeat(32);
  calls.set(CA(1), { status: 'completed', end_time: ago(20 * 60_000) }); // heard the message and hung up
  calls.set(CA(2), { status: 'no-answer', end_time: ago(3 * 3_600_000) });
  calls.set(CA(3), { status: 'completed', end_time: ago(60_000) }); // just ended
  calls.set(CA(4), { status: 'in-progress', end_time: null }); // the board on a call
  calls.set(CA(5), { status: 'completed', end_time: ago(20 * 60_000) }); // its delete fails three times: the next hour's
  fail[`DELETE /2010-04-01/Accounts/${ACCOUNT}/Calls/${CA(5)}.json`] = 3;
  assert.equal(await deleteEndedCalls(), true);
  const auth = 'Basic ' + Buffer.from(`${ACCOUNT}:${TOKEN}`).toString('base64');
  assert.ok(seen.every(s => s.endsWith(auth)));
  assert.deepEqual([...calls.keys()], [CA(3), CA(4), CA(5)]);
  await deleteEndedCalls();
  assert.deepEqual([...calls.keys()], [CA(3), CA(4)]);
  fail[`GET /2010-04-01/Accounts/${ACCOUNT}/Calls.json`] = 3;
  assert.equal(await deleteEndedCalls(), false);
});

test('a calls list longer than the hourly job reads is no complete list: it says so', async () => {
  endless = true;
  try { assert.equal(await deleteEndedCalls(), false); } finally { endless = false; }
});

test('hq phone --check says whether Twilio takes HQ\'s keys and where the number sends a call, never a key or a number', async () => {
  const signed = h.db.prepare("select value from settings where key = 'twilio_account'").get();
  h.db.prepare("delete from settings where key = 'twilio_account'").run();
  const own = { phone_number: '+3197010000000', status: 'in-use', capabilities: { voice: true }, voice_url: 'https://hq.company.test/api/twilio/voice', voice_method: 'POST', voice_application_sid: '', trunk_sid: null };
  numbers.push({ ...own, phone_number: '+3197010000001' }, own);
  try {
    // no signed call yet: nothing to ask until the board saves the Account SID, and the hourly job leaves Twilio alone
    const none = await check();
    assert.match(none, /No account to ask: save Twilio's Account SID as TWILIO_ACCOUNT_SID[^]*A signed call has reached HQ for this account: no\./);
    assert.doesNotMatch(none, /named another account/);
    const asked = seen.length;
    assert.equal(await deleteEndedCalls(), true);
    assert.equal(seen.length, asked);
    rememberAccount('AC' + 'b'.repeat(32));
    const card = await h.answer(await h.ask(bolt, { kind: 'credential', title: 'Twilio\'s account', secrets: 'TWILIO_ACCOUNT_SID' }), '', { secrets: { TWILIO_ACCOUNT_SID: ACCOUNT } });
    assert.equal(card.status, 200, JSON.stringify(card.body));
    const report = await check();
    assert.match(report, /account is active \(Full\)/);
    assert.match(report, /on the account \(in-use\), takes voice calls/);
    assert.match(report, /HQ's https:\/\/hq\.company\.test\/api\/twilio\/voice, POST/);
    assert.match(report, /A signed call has reached HQ for this account: no/);
    // the signed call named account b, not the saved SID: said, with neither SID
    assert.match(report, /A signed call named another account than the saved TWILIO_ACCOUNT_SID/);
    assert.ok(![TOKEN, ACCOUNT, 'b'.repeat(32), '3197010000000'].some(key => report.includes(key)));
    rememberAccount(ACCOUNT);
    const same = await check();
    assert.match(same, /A signed call has reached HQ for this account: yes/);
    assert.doesNotMatch(same, /named another account/);
    rememberAccount('AC' + 'b'.repeat(32));
    // and the hourly job now lists the account's calls with it
    assert.equal(await deleteEndedCalls(), true);
    assert.ok(seen.slice(asked).some(s => s.startsWith(`GET /2010-04-01/Accounts/${ACCOUNT}/Calls.json`)));
    // a voice URL that isn't HQ's, without what it holds besides; a GET; an app or a trunk in its place
    Object.assign(own, { voice_url: 'http://user:secret@hq.company.test/api/twilio/voice?key=1', voice_method: 'GET' });
    const other = await check();
    assert.match(other, /another URL, http:\/\/hq\.company\.test \(HQ's path, with a query\), GET, but HQ takes only POST/);
    assert.ok(!/secret|key=1/.test(other));
    Object.assign(own, { voice_url: 'https://relay.example.test/hooks/path-key-1', voice_method: 'POST' });
    const relayed = await check();
    assert.match(relayed, /another URL, https:\/\/relay\.example\.test \(another path\), POST/);
    assert.ok(!relayed.includes('path-key-1'));
    Object.assign(own, { voice_application_sid: 'AP' + 'b'.repeat(32) });
    assert.match(await check(), /a TwiML app takes it/);
    Object.assign(own, { trunk_sid: 'TK' + 'b'.repeat(32) });
    assert.match(await check(), /a SIP trunk takes it/);
    // a number the account doesn't have, and a token that isn't the account's
    numbers.splice(0);
    assert.match(await check(), /TWILIO_PHONE_NUMBER isn't on this account \(it has 0 numbers\)\./);
    writeFileSync(`${DIR}/TWILIO_AUTH_TOKEN`, 'another-token');
    const refused = await check();
    assert.match(refused, /^Twilio refused HQ's keys for the saved TWILIO_ACCOUNT_SID: the saved auth token isn't that account's/);
    assert.ok(![TOKEN, 'another-token', ACCOUNT, '3197010000000'].some(k => refused.includes(k) || other.includes(k)));
  } finally {
    writeFileSync(`${DIR}/TWILIO_AUTH_TOKEN`, TOKEN);
    rmSync(`${DIR}/TWILIO_ACCOUNT_SID`, { force: true });
    numbers.splice(0);
    h.db.prepare("delete from settings where key = 'twilio_account'").run();
    if (signed) rememberAccount(ACCOUNT);
  }
});

test('phone diagnostics distinguish lookup failures and missing settings from configured values', async () => {
  writeFileSync(`${DIR}/TWILIO_ACCOUNT_SID`, ACCOUNT);
  numbers.push({ phone_number: keys.TWILIO_PHONE_NUMBER, voice_url: 'https://hq.company.test/api/twilio/voice' });
  try {
    fail['IncomingPhoneNumbers.json'] = 3;
    const unavailable = await check();
    assert.match(unavailable, /503 for the account's numbers/);
    assert.doesNotMatch(unavailable, /isn't on this account|has 0 numbers/);
    assert.match(await check(), /no method, but HQ takes only POST/);
    rmSync(`${DIR}/TWILIO_PHONE_NUMBER`);
    assert.match(await check(), /No TWILIO_PHONE_NUMBER saved/);
  } finally {
    fail['IncomingPhoneNumbers.json'] = 0;
    writeFileSync(`${DIR}/TWILIO_PHONE_NUMBER`, keys.TWILIO_PHONE_NUMBER);
    rmSync(`${DIR}/TWILIO_ACCOUNT_SID`, { force: true });
    numbers.splice(0);
  }
});

// ---- the agent who answers callers who aren't the board
// brand.yaml's phoneLine.care names one of org.yaml's agents (Wren here, whose voice is jane), with the opening's
// languages by country code, a native voice for Dutch and the seed of its fixed words
async function withCare<T>(work: () => Promise<T>) {
  const file = `${h.repo}/company/brand.yaml`,
    was = readFileSync(file, 'utf8');
  try {
    writeFileSync(
      file,
      was.replace(
        /^phoneLine:\n/m,
        'phoneLine:\n  care: wren\n  hello: { nl: Hallo, de: Guten Tag, en: Hello }\n' +
          '  languages: { 31: [nl, en], 32: [nl, en], 49: [de, en], 4: [de], default: [en] }\n  voices: { nl: alex, xx: x }\n' +
          '  seeds: { nl: 2, de: -1, en: x }\n',
      ),
    );
    return await work();
  } finally {
    writeFileSync(file, was);
  }
}
const lastAnswer = () =>
  (h.db.prepare('select step, answer from phone_asks order by rowid desc limit 1').get() as { answer: string }).answer;
const ticketOf = (twiml: string) => twiml.match(/<Parameter name="ticket" value="([\w-]+)"\/>/)?.[1] ?? '';
const CARE_CONNECT =
  /<Response><Connect action="\/api\/twilio\/after\?line=0"><Stream url="wss:\/\/hq\.company\.test\/voice\/twilio"><Parameter name="ticket" value="[\w-]+"\/><\/Stream><\/Connect><\/Response>$/;
const sid = (n: number) => 'CA' + n.toString(16).padStart(32, '0');

test("with phoneLine.care, a caller who is not the board gets the agent: a care ticket the voice line trades once for the opening's languages, its voices and seeds", () =>
  withCare(async () => {
    h.db.exec('delete from phone_misses'); // (the five wrong PINs above)
    const r = await twilio('/api/twilio/voice', { From: '+31611110001', CallSid: sid(1) });
    assert.match(r.text, CARE_CONNECT);
    assert.doesNotMatch(r.text, /Record|Gather|Say|Play/);
    assert.equal(lastAnswer(), 'Wren (care ticket)');
    const ticket = ticketOf(r.text);
    const traded = await h.voice('call-ticket', { ticket });
    assert.deepEqual(traded.body, {
      agent: 'wren',
      lang: 'nl',
      kind: 'care',
      engine: 'care',
      langs: ['nl', 'en'],
      voice: 'jane',
      voices: { nl: 'alex' }, // (a language the line doesn't speak is left out)
      seeds: { nl: 2 }, // (a seed that isn't a whole number from 0 is left out)
      respell: {}, // (brand.yaml speech.respell: none in the test company)
    });
    assert.equal((await h.voice('call-ticket', { ticket })).status, 404);
    // the board's own ticket stays as it was: no kind, no hellos
    const board = await twilio('/api/twilio/pin', { From: BOARD, Digits: PIN });
    assert.match(board.text, /<Response><Connect><Stream /);
    assert.deepEqual((await h.voice('call-ticket', { ticket: ticketOf(board.text) })).body, {
      agent: 'juno',
      lang: 'en',
    });
  }));

test("the opening's languages: by the caller's country code, the longest that fits, else the default", () =>
  withCare(async () => {
    const langs = async (From: string) => {
      const r = await twilio('/api/twilio/voice', { From, CallSid: sid(20) });
      return (await h.voice('call-ticket', { ticket: ticketOf(r.text) })).body.langs;
    };
    assert.deepEqual(await langs('+32470000001'), ['nl', 'en']);
    assert.deepEqual(await langs('+491510000001'), ['de', 'en']);
    assert.deepEqual(await langs('+43660000001'), ['de']); // (4 alone: the test's own, to show the longest wins)
    assert.deepEqual(await langs('+447700000001'), ['de']);
    assert.deepEqual(await langs('+12025550001'), ['en']);
    assert.deepEqual(await langs('anonymous'), ['en']);
    assert.deepEqual(openingLanguages('+31611110099'), ['nl', 'en']);
    h.db.exec('delete from phone_callers'); // (the withheld one counted: its limit is tested below)
  }));

test("phoneLine.care naming nobody on org.yaml's desks, or left out: the message, as before", async () => {
  const file = `${h.repo}/company/brand.yaml`,
    was = readFileSync(file, 'utf8');
  try {
    writeFileSync(file, was.replace(/^phoneLine:\n/m, 'phoneLine:\n  care: nobody\n'));
    const r = await twilio('/api/twilio/voice', { From: '+31611110002' });
    assert.match(r.text, /chime\.mp3[\s\S]*<Hangup\/><\/Response>$/);
    assert.equal(lastAnswer(), "the company's message (another number)");
  } finally {
    writeFileSync(file, was);
  }
});

test('three calls a day per number reach the agent; the fourth hears the message, and nothing keeps the number', () =>
  withCare(async () => {
    for (let i = 0; i < 3; i++)
      assert.match((await twilio('/api/twilio/voice', { From: '+31611110003' })).text, CARE_CONNECT, `call ${i + 1}`);
    const fourth = await twilio('/api/twilio/voice', { From: '+31611110003' });
    assert.match(fourth.text, /chime\.mp3[\s\S]*<Hangup\/><\/Response>$/);
    assert.doesNotMatch(fourth.text, /Stream/);
    assert.equal(lastAnswer(), "the company's message (3 calls today)");
    // another number still gets through, and the same number written another way counts as the same
    assert.match((await twilio('/api/twilio/voice', { From: '+31611110004' })).text, CARE_CONNECT);
    assert.doesNotMatch((await twilio('/api/twilio/voice', { From: '0031611110003' })).text, /Stream/);
    const kept = JSON.stringify(h.db.prepare('select * from phone_callers').all());
    assert.ok(!kept.includes('611110003') && !kept.includes('611110004'));
  }));

test('withheld numbers share one limit of three a day', () =>
  withCare(async () => {
    for (const From of ['', 'anonymous', '+266696687'])
      assert.match((await twilio('/api/twilio/voice', { From })).text, CARE_CONNECT, From);
    assert.doesNotMatch((await twilio('/api/twilio/voice', { From: 'Restricted' })).text, /Stream/);
    assert.equal(lastAnswer(), "the company's message (3 calls today)");
  }));

test("a number's calls are blanked after 2 days, and a day-old one no longer counts", () =>
  withCare(async () => {
    const From = '+31611110005';
    for (let i = 0; i < 3; i++) await twilio('/api/twilio/voice', { From });
    assert.doesNotMatch((await twilio('/api/twilio/voice', { From })).text, /Stream/);
    const rows = () => (h.db.prepare('select count(*) n from phone_callers').get() as { n: number }).n;
    const before = rows();
    // a day and a bit ago: kept, but not today's
    h.db
      .prepare(
        'update phone_callers set ts = ts - ? where rowid in (select rowid from phone_callers order by rowid desc limit 3)',
      )
      .run(25 * 3_600_000);
    assert.match((await twilio('/api/twilio/voice', { From })).text, CARE_CONNECT);
    assert.equal(rows(), before + 1);
    // two days ago: gone before the next count
    h.db.prepare('update phone_callers set ts = ts - ?').run(2 * 86_400_000);
    await twilio('/api/twilio/voice', { From: '+31611110006' });
    assert.equal(rows(), 1);
  }));

test("after the agent's stream: a hang-up when the voice line said the agent hung up, else the message", () =>
  withCare(async () => {
    // a third call at once, care down, 10 minutes or a crash: no phone-done
    const message = await twilio('/api/twilio/after', { From: '+31611110007', CallSid: sid(7) });
    assert.match(
      message.text,
      /^<\?xml[^>]*><Response><Play>[^<]*chime\.mp3<\/Play>(<Say [^>]*>(Hello|Hallo|Guten Tag)<\/Say>){3}<Say language="en-GB" [^>]*>Hello, you've reached Testco[\s\S]*<Hangup\/><\/Response>$/,
    );
    assert.equal(lastAnswer(), "after Wren: the company's message");
    assert.deepEqual((await h.voice('phone-done', { call: sid(8) })).body, {});
    const ended = await twilio('/api/twilio/after', { From: '+31611110008', CallSid: sid(8) });
    assert.match(ended.text, /<Response><Hangup\/><\/Response>$/);
    assert.equal(lastAnswer(), 'after Wren: hung up');
    // the word counts once, and only for its own call
    assert.match((await twilio('/api/twilio/after', { CallSid: sid(8) })).text, /chime\.mp3/);
    assert.match((await twilio('/api/twilio/after', { CallSid: sid(9) })).text, /chime\.mp3/);
    // signed like the line's other steps
    assert.equal((await twilio('/api/twilio/after', { CallSid: sid(8) }, 'wrong')).status, 403);
  }));

test("phone-done takes the voice line's token and a CallSid only", async () => {
  const post = (token: string, body: unknown) =>
    fetch(h.base + '/api/voice/phone-done', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
  assert.equal((await post('', { call: sid(10) })).status, 401);
  assert.equal((await post('not-the-voice-token', { call: sid(10) })).status, 401);
  assert.equal((await h.voice('phone-done', { call: 'not a call' })).status, 400);
  assert.equal((await h.voice('phone-done', {})).status, 400);
});

test("the board's own number: no PIN within the timeout goes to the agent as any caller; a wrong PIN stays a miss", () =>
  withCare(async () => {
    h.db.exec('delete from phone_misses');
    const prompt = (await twilio('/api/twilio/voice', { From: BOARD })).text;
    assert.match(prompt, /<Gather [^>]*action="\/api\/twilio\/pin\?line=0"[^>]* actionOnEmptyResult="true">/);
    for (const fields of [{ From: BOARD, Digits: '' }, { From: BOARD }] as Record<string, string>[]) {
      const r = await twilio('/api/twilio/pin', fields);
      assert.match(r.text, CARE_CONNECT);
      assert.equal(lastAnswer(), 'Wren (care ticket)');
      assert.equal((await h.voice('call-ticket', { ticket: ticketOf(r.text) })).body.kind, 'care');
    }
    assert.equal((h.db.prepare('select count(*) n from phone_misses').get() as { n: number }).n, 0);
    assert.match((await twilio('/api/twilio/pin', { From: BOARD, Digits: '9999' })).text, /not right/);
    assert.equal((h.db.prepare('select count(*) n from phone_misses').get() as { n: number }).n, 1);
    // a stranger at the PIN step never reaches the agent
    assert.doesNotMatch((await twilio('/api/twilio/pin', { From: '+31611110009', Digits: '' })).text, /Stream/);
    h.db.exec('delete from phone_misses');
  }));

test("without phoneLine.care the board's prompt waits for digits only: no PIN is no call", async () => {
  assert.doesNotMatch((await twilio('/api/twilio/voice', { From: BOARD })).text, /actionOnEmptyResult/);
});

// ---- phoneLines, a list: a guarded line on a number of its own for Moss on the
// deployment `partnerline` (two numbers allowed, with a PIN), that number's message for everyone else, and the default
// line for any other number, Vera on `care`, one call a day
const PARTNER = '+3197010000099', ALLOWED = '+31655500001';
async function withLines<T>(work: () => Promise<T>) {
  const file = `${h.repo}/company/brand.yaml`,
    was = readFileSync(file, 'utf8');
  writeFileSync(`${DIR}/PARTNER_LINE_NUMBERS`, `${ALLOWED}, +49 151 5550002\n`);
  writeFileSync(`${DIR}/PARTNER_LINE_PIN`, '24680');
  try {
    writeFileSync(
      file,
      was.replace(/^phoneLine:\n( {2}.*\n)*/m, '') +
        `phoneLines:
  - number: "${PARTNER}"
    callers: { numbers: PARTNER_LINE_NUMBERS, pin: PARTNER_LINE_PIN }
    agent: moss
    engine: partnerline
    languages: { default: [nl] }
    voices: { nl: eve }
  - number: "${PARTNER}"
    greeting: { en: "This line is for our partners." }
  - agent: vera
    callsADay: 1
    languages: { default: [de] }
    greeting: { de: "Hier ist Testco." }
`,
    );
    return await work();
  } finally {
    writeFileSync(file, was);
    rmSync(`${DIR}/PARTNER_LINE_NUMBERS`);
    rmSync(`${DIR}/PARTNER_LINE_PIN`);
    h.db.exec('delete from phone_callers; delete from phone_misses');
  }
}
const connectTo = (line: number) =>
  new RegExp(`<Response><Connect action="/api/twilio/after\\?line=${line}"><Stream [^>]*><Parameter name="ticket" value="[\\w-]+"/></Stream></Connect></Response>$`);

test('phoneLines: a call takes the line for the number dialled that lets the caller in, else the default; the ticket names its deployment', () =>
  withLines(async () => {
    // any other number: the default line, its agent on care, its own languages
    const r = await twilio('/api/twilio/voice', { From: '+31611120001', To: '+3197010000000', CallSid: sid(30) });
    assert.match(r.text, connectTo(2));
    assert.equal(lastAnswer(), 'Vera (care ticket)');
    assert.deepEqual((await h.voice('call-ticket', { ticket: ticketOf(r.text) })).body, {
      agent: 'vera', lang: 'de', kind: 'care', engine: 'care', langs: ['de'], voice: 'eve', respell: {},
    });
    // its own calls a day (one), and its own message after
    const again = await twilio('/api/twilio/voice', { From: '+31611120001', To: '+3197010000000' });
    assert.match(again.text, /<Say language="de-DE" [^>]*>Hier ist Testco\.<\/Say><Hangup\/>/);
    assert.equal(lastAnswer(), "the company's message (1 calls today)");
    // the partner line's number from a number it doesn't allow: that number's own message, never the PIN prompt
    const stranger = await twilio('/api/twilio/voice', { From: '+31611120002', To: PARTNER });
    assert.match(stranger.text, /<Say language="en-GB" [^>]*>This line is for our partners\.<\/Say><Hangup\/><\/Response>$/);
    assert.doesNotMatch(stranger.text, /Gather|Stream/);
    // after a stream on the number's message line: that line's message
    const after = await twilio('/api/twilio/after?line=1', { From: '+31611120002', To: PARTNER, CallSid: sid(31) });
    assert.match(after.text, /This line is for our partners\./);
  }));

test("phoneLines: a guarded line asks its callers for the line's PIN, then its agent on its own deployment; five wrong PINs shut it for the hour", () =>
  withLines(async () => {
    const prompt = await twilio('/api/twilio/voice', { From: '0049 151 5550002', To: PARTNER });
    assert.match(prompt.text, /<Gather input="dtmf" numDigits="5" action="\/api\/twilio\/pin\?line=0" timeout="10"><Say language="nl-NL" [^>]*>Testco\. Je pincode, graag\.<\/Say><\/Gather>/);
    assert.doesNotMatch(prompt.text, /actionOnEmptyResult/);
    assert.equal(lastAnswer(), "Moss's line: PIN prompt");
    const right = await twilio('/api/twilio/pin?line=0', { From: ALLOWED, To: PARTNER, Digits: '24680' });
    assert.match(right.text, connectTo(0));
    assert.deepEqual((await h.voice('call-ticket', { ticket: ticketOf(right.text) })).body, {
      agent: 'moss', lang: 'nl', kind: 'care', engine: 'partnerline', langs: ['nl'], voice: 'paul', voices: { nl: 'eve' }, respell: {},
    });
    // a number the line doesn't allow, typing the right PIN at its step: the default line's message
    assert.doesNotMatch((await twilio('/api/twilio/pin?line=0', { From: '+31611120003', To: PARTNER, Digits: '24680' })).text, /Stream/);
    // the board's PIN is not the line's, and the line's misses are its own
    h.db.exec('delete from phone_misses');
    for (let i = 0; i < 5; i++)
      assert.match((await twilio('/api/twilio/pin?line=0', { From: ALLOWED, To: PARTNER, Digits: PIN })).text, /Die pincode klopt niet|not right|Diese PIN/);
    assert.equal(lastAnswer(), "Moss's line: wrong PIN");
    const shut = await twilio('/api/twilio/pin?line=0', { From: ALLOWED, To: PARTNER, Digits: '24680' });
    assert.match(shut.text, /De lijn is voorlopig dicht\. Tot ziens\.<\/Say><Hangup\/>/);
    assert.equal(lastAnswer(), "Moss's line: closed (5 wrong PINs)");
    assert.equal((h.db.prepare("select count(*) n from phone_misses where pin_key = 'CALL_PIN'").get() as { n: number }).n, 0);
    // the board's own line is still open to the board
    assert.match((await twilio('/api/twilio/pin', { From: BOARD, Digits: PIN })).text, /<Connect><Stream /);
  }));

test('phoneLines: no line lets the caller in, or none at all: the platform message', () =>
  withLines(async () => {
    const file = `${h.repo}/company/brand.yaml`, was = readFileSync(file, 'utf8');
    writeFileSync(file, was.replace(/\n {2}- agent: vera\n( {4}.*\n)*/, '\n'));
    const r = await twilio('/api/twilio/voice', { From: '+31611120004', To: '+3197010000000' });
    assert.match(r.text, /Hello, you've reached Testco[\s\S]*<Hangup\/><\/Response>$/);
    assert.equal(lastAnswer(), "the company's message (another number)");
  }));

test("phoneLines: a line that can't be read as written stops the call with why, never read as another", async () => {
  const file = `${h.repo}/company/brand.yaml`,
    was = readFileSync(file, 'utf8');
  const cases: [string, RegExp][] = [
    ['  - just a word\n', /line 1: not a mapping/],
    ['  - { number: 3197010000099, agent: moss }\n', /line 1: its number must be quoted/],
    ['  - { agent: moss, callsADay: "5" }\n', /line 1: its callsADay must be a whole number from 0/],
    ['  - { agent: moss, callsADay: 2.5 }\n', /line 1: its callsADay/],
    ['  - { agent: moss, engine: 7 }\n', /line 1: its engine/],
    ['  - { agent: moss, callers: partners }\n', /line 1: its callers must be anyone/],
    ['  - { agent: moss, callers: { numbers: PARTNER_LINE_NUMBERS } }\n', /line 1: its callers/],
  ];
  try {
    for (const [entry, why] of cases) {
      writeFileSync(file, was.replace(/^phoneLine:\n( {2}.*\n)*/m, '') + 'phoneLines:\n' + entry);
      const r = await twilio('/api/twilio/voice', { From: '+31611130001', To: '+3197010000000' });
      assert.equal(r.status, 500, entry);
      assert.doesNotMatch(r.text, /Stream|Gather|Say/, entry);
      assert.throws(() => openingLanguages('+31611130001'), why, entry);
    }
    // an engine is taken as given, for the voice line to refuse one no deployment has
    writeFileSync(file, was.replace(/^phoneLine:\n( {2}.*\n)*/m, '') + 'phoneLines:\n  - { agent: moss, engine: Partner_Line }\n');
    const r = await twilio('/api/twilio/voice', { From: '+31611130002', To: '+3197010000000' });
    assert.equal((await h.voice('call-ticket', { ticket: ticketOf(r.text) })).body.engine, 'Partner_Line');
  } finally {
    writeFileSync(file, was);
    h.db.exec('delete from phone_callers');
  }
});

test("phoneLines: a line that can't be read leaves the board's own call its PIN and the voice line", async () => {
  const file = `${h.repo}/company/brand.yaml`,
    was = readFileSync(file, 'utf8');
  try {
    writeFileSync(file, was.replace(/^phoneLine:\n( {2}.*\n)*/m, '') + 'phoneLines:\n  - { number: 3197010000099, agent: moss }\n');
    h.db.exec('delete from phone_misses');
    const prompt = await twilio('/api/twilio/voice', { From: BOARD, To: '+3197010000000' });
    assert.equal(prompt.status, 200);
    assert.match(prompt.text, /<Gather input="dtmf" numDigits="4" action="\/api\/twilio\/pin" timeout="10">/);
    assert.doesNotMatch(prompt.text, /actionOnEmptyResult/);
    const call = await twilio('/api/twilio/pin', { From: BOARD, To: '+3197010000000', Digits: PIN });
    assert.match(call.text, /<Connect><Stream /);
    // a stranger on the same list still hears why: no call
    assert.equal((await twilio('/api/twilio/voice', { From: '+31611140001', To: '+3197010000000' })).status, 500);
  } finally {
    writeFileSync(file, was);
  }
});
