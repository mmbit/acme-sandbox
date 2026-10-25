// node --test src/callouts.test.ts   (calls out to partners: hq phone call, the board's card, the dial through a stand-in
// for Twilio, the voice line's routes, the follow-up and the 12-month sweep; a throwaway DATA_DIR)
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { harness, type Running } from './harness.ts';
import { cardOf as shown } from '../../hq/shell/card.js';

// Twilio's REST API, played: each call placed (its form fields); `refuse` makes the next answer Twilio's refusal
const placed: URLSearchParams[] = [];
let refuse: { status: number; code: number; message: string } | null = null;
const twilioApi = createServer(async (q, s) => {
  let body = '';
  for await (const c of q) body += c;
  if (q.method !== 'POST' || !q.url!.endsWith('/Calls.json')) {
    s.writeHead(404);
    return s.end();
  }
  if (refuse) {
    const r = refuse;
    refuse = null;
    s.writeHead(r.status);
    return s.end(JSON.stringify({ code: r.code, message: r.message, status: r.status }));
  }
  placed.push(new URLSearchParams(body));
  s.writeHead(201);
  s.end(JSON.stringify({ sid: `CA${String(placed.length).padStart(32, '0')}`, status: 'queued' }));
}).listen(0);
after(() => twilioApi.close());

const TOKEN = 'twilio-auth-token',
  ACCOUNT = 'AC' + 'a'.repeat(32);
const BOARD = '06 1234 5678',
  OURS = '+3197010000000',
  PARTNER = '+31 20 555 0123';
const ALWAYS = 'callsOut:\n  hours: { days: [mon, tue, wed, thu, fri, sat, sun], from: "00:00", until: "24:00" }\n';
const h = await harness('callouts', {
  env: { PUBLIC_HOST: 'hq.company.test', TWILIO_API: `http://localhost:${(twilioApi.address() as AddressInfo).port}` },
  before: repo =>
    writeFileSync(`${repo}/company/brand.yaml`, readFileSync(`${repo}/company/brand.yaml`, 'utf8') + ALWAYS),
});
const { db, hq, board, voice } = h;
const sweeper = await import('./callsweep.ts');
const callcard = await import('./callcard.ts');
const bolt = await h.start({ agent: 'bolt' });
const keys = { TWILIO_AUTH_TOKEN: TOKEN, BOARD_PHONE_NUMBER: BOARD, TWILIO_PHONE_NUMBER: OURS };
assert.equal(
  (
    await h.answer(
      await h.ask(bolt, { kind: 'credential', title: 'The phone line', secrets: Object.keys(keys).join(',') }),
      '',
      { secrets: keys },
    )
  ).status,
  200,
);
db.prepare(
  "insert into settings (key, value) values ('twilio_account', ?) on conflict (key) do update set value = excluded.value",
).run(ACCOUNT);

const why = (text = 'Ask where parcel PA-1234 is; we may agree to a reprint at their cost.') => {
  const f = `${h.dataDir}/${Math.random().toString(36).slice(2)}.txt`;
  writeFileSync(f, text);
  return f;
};
// (--card)
const CARD = 'Wren asks Print API where our parcel is. May agree: a reprint at their cost.';
const fileCall = (j: Running, ...more: string[]) =>
  hq(j, 'phone', 'call', '--who', 'Print API', '--about', 'our parcel', '--card', CARD, '--lang', 'en', ...more, why());
const filed = (out: string) => ({
  id: Number(out.match(/Call #(\d+)/)![1]),
  request: Number(out.match(/request #(\d+)/)![1]),
});
const cardOf = async (request: number) => ((await board('/api/requests')).body as any[]).find(r => r.id === request);
// (the card's read of a held call)
const pastCard = async (request: number) =>
  ((await board('/api/requests/archive')).body.cards as any[]).find(r => r.id === request);
const row = (id: number) => db.prepare('select * from callouts where id = ?').get(id) as any;
const jobsFor = (agent: string, title: string) =>
  db.prepare('select id, prompt from jobs where agent = ? and title = ?').all(agent, title) as {
    id: number;
    prompt: string;
  }[];
const until = async (done: () => boolean) => {
  for (let i = 0; i < 100 && !done(); i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(done());
};
// what Twilio does: sign the full URL plus the sorted form fields with the auth token
async function twilio(path: string, fields: Record<string, string>, key = TOKEN) {
  const form = new URLSearchParams(fields);
  const sig = createHmac('sha1', key)
    .update(
      `https://hq.company.test${path}` +
        [...form.keys()]
          .sort()
          .map(k => k + form.get(k))
          .join(''),
    )
    .digest('base64');
  return (await fetch(h.base + path, { method: 'POST', body: form, headers: { 'x-twilio-signature': sig } })).status;
}
// A phone call filed and approved, dialled: its row and the ticket Twilio would stream with
async function dialled(j: Running) {
  const f = filed((await fileCall(j, '--to', PARTNER)).out);
  const before = placed.length;
  assert.equal((await board('/api/callouts/approve', { id: f.request })).status, 200);
  await until(() => placed.length > before && !!row(f.id).sid);
  const twiml = placed.at(-1)!.get('Twiml')!;
  return { ...f, ticket: twiml.match(/name="ticket" value="([^"]+)"/)![1], form: placed.at(-1)! };
}

test('a call is filed as a card the board can read, with the number only as its last digits', async () => {
  const wren = await h.start({ agent: 'wren' });
  const r = await fileCall(wren, '--to', PARTNER, '--digits', '1234#');
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /555/);
  const f = filed(r.out),
    c = await cardOf(f.request);
  assert.equal(c.kind, 'call');
  assert.equal(c.title, 'Call Print API about our parcel');
  // the card's text is the line for the board, the why under its More
  assert.deepEqual(
    [shown(c.body).summary[0], shown(c.body).details],
    [CARD, 'Ask where parcel PA-1234 is; we may agree to a reprint at their cost.'],
  );
  assert.deepEqual(
    [c.call.who, c.call.about, c.call.kind, c.call.lang, c.call.ending, c.call.digits, c.call.name],
    ['Print API', 'our parcel', 'phone', 'en', '123', true, 'Wren'],
  );
  assert.doesNotMatch(JSON.stringify(c), /555\s?0123|5550123/);
  assert.doesNotMatch(JSON.stringify(await h.feed()), /5550123/);
  // the board sees it whole on asking; the desk phone's answer box can't answer it
  assert.deepEqual((await board(`/api/callouts/number?id=${f.request}`)).body, { number: '+31205550123' });
  assert.equal((await h.answer(f.request, 'ok')).status, 409);
  // the agent's own view never has the number
  const own = await hq(wren, 'phone', 'call', String(f.id));
  assert.match(
    own.out,
    /Call #\d+ with Print API, about our parcel \(a phone call to a number ending 123, in en, as soon as approved\): open/,
  );
  assert.doesNotMatch(own.out, /5550123/);
  // withdrawn by its filer (hq close): nothing dialled, the card gone without an answer
  assert.equal((await hq(wren, 'close', String(f.request))).code, 0);
  assert.equal(row(f.id).status, 'withdrawn');
  assert.equal(row(f.id).number, null);
  assert.equal(await cardOf(f.request), undefined);
});

test("refused: our own number, no number, a bad language, more than three an hour, a job that holds a customer's details", async () => {
  const wren = await h.start({ agent: 'wren' });
  const refused = async (pattern: RegExp, ...more: string[]) => {
    const r = await fileCall(wren, ...more);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, pattern);
    assert.match(r.out, /Nothing was filed/);
  };
  await refused(/our own line's number/, '--to', '097010000000');
  await refused(/--to: a phone number/, '--to', '12');
  await refused(/--digits/, '--link', '--digits', '12');
  // --lang, and the card's line, required and short
  const filing = async (...flags: string[]) =>
    (await hq(wren, 'phone', 'call', '--link', '--who', 'Print API', '--about', 'x', ...flags, why())).out;
  assert.match(await filing('--card', CARD, '--lang', 'fr'), /--lang/);
  assert.match(
    await filing('--card', 'x'.repeat(201), '--lang', 'en'),
    /--card: the card's text for the board, 1 to 200/,
  );
  assert.match(await filing('--lang', 'en'), /--card/);
  for (let i = 0; i < 3; i++) assert.equal((await fileCall(wren, '--link')).code, 0);
  await refused(/3 calls in the last hour/, '--link');
  // --to board: the board's own saved number, for a test call; the agent never sees it
  const dex = await h.start({ agent: 'dex' });
  const toBoard = await fileCall(dex, '--to', 'board');
  assert.equal(toBoard.code, 0, toBoard.out);
  assert.equal(row(filed(toBoard.out).id).number, '+31612345678');
  assert.doesNotMatch(toBoard.out, /12345678/);
  const juno = await h.start({ agent: 'juno' });
  db.prepare('update jobs set customers = 1 where id = ?').run(juno.id);
  const r = await fileCall(juno, '--link');
  assert.match(r.out, /holds a customer's own details/);
});

test('Call dials once through Twilio with the stream, its ticket and a signed callback; busy ends it missed with one follow-up', async () => {
  const juno = await h.start({ agent: 'juno' });
  const d = await dialled(juno);
  assert.equal(d.form.get('To'), '+31205550123');
  assert.equal(d.form.get('From'), OURS);
  assert.equal(d.form.get('Timeout'), '30');
  assert.equal(d.form.get('SendDigits'), null);
  assert.match(
    d.form.get('Twiml')!,
    /^<Response><Connect><Stream url="wss:\/\/hq\.company\.test\/voice\/twilio"><Parameter name="ticket" value="[\w-]+"\/><\/Stream><\/Connect><\/Response>$/,
  );
  assert.equal(d.form.get('StatusCallback'), `https://hq.company.test/api/twilio/status?callout=${d.id}`);
  const answer = db.prepare('select answer from requests where id = ?').get(d.request) as { answer: string };
  assert.match(answer.answer, /^Approved: Juno calls Print API now/);
  assert.doesNotMatch(answer.answer, /5550123/);
  // only Twilio's signature counts; busy ends it, and it's never dialled again
  const path = `/api/twilio/status?callout=${d.id}`,
    sid = row(d.id).sid;
  assert.equal(await twilio(path, { CallSid: sid, CallStatus: 'busy' }, 'wrong'), 403);
  assert.equal(await twilio(path, { CallSid: sid, CallStatus: 'busy', AccountSid: ACCOUNT }), 204);
  assert.equal(row(d.id).status, 'missed');
  assert.equal(row(d.id).number, null);
  const count = placed.length;
  await sweeper.sweep();
  assert.equal(placed.length, count);
  const follow = jobsFor('juno', 'Follow up on your call with Print API').at(-1)!;
  assert.match(follow.prompt, /has ended: the line was busy/);
  assert.match(follow.prompt, /a new call is a new card/);
  assert.equal(row(d.id).followup, follow.id);
});

test("Twilio's refusal ends it failed with its code; Don't call answers the card and dials nothing", async () => {
  const juno = await h.start({ agent: 'juno' });
  const f = filed((await fileCall(juno, '--to', PARTNER)).out);
  refuse = {
    status: 400,
    code: 21215,
    message: 'Account not authorized to call +31205550123. Perhaps you need to enable some international permissions',
  };
  assert.equal((await board('/api/callouts/approve', { id: f.request })).status, 200);
  await until(() => row(f.id).status === 'failed');
  assert.match(row(f.id).outcome, /Twilio refused it \(21215: Account not authorized to call the number\. Perhaps/);
  const g = filed((await fileCall(juno, '--link')).out),
    count = placed.length;
  assert.equal((await board('/api/callouts/decline', { id: g.request })).status, 200);
  assert.equal(row(g.id).status, 'declined');
  assert.match(
    (db.prepare('select answer from requests where id = ?').get(g.request) as { answer: string }).answer,
    /^Declined/,
  );
  assert.equal(placed.length, count);
  assert.equal((await board('/api/callouts/approve', { id: g.request })).status, 404);
});

test('a phone call waits for the calling hours, on the company clock', async () => {
  const file = `${h.repo}/company/brand.yaml`,
    was = readFileSync(file, 'utf8');
  try {
    // Saturdays and Sundays 10:00 to 12:00 only, and a Monday to come back to
    writeFileSync(
      file,
      was.replace(ALWAYS, 'callsOut:\n  hours: { days: [sat, sun], from: "10:00", until: "12:00" }\n'),
    );
    const juno = await h.start({ agent: 'juno' });
    const f = filed((await fileCall(juno, '--to', PARTNER)).out);
    db.prepare("update callouts set status = 'approved', decided = ? where id = ?").run(new Date().toISOString(), f.id);
    const count = placed.length;
    await sweeper.sweep(Date.parse('2026-10-19T09:30:00Z')); // a Monday, 11:30 in Amsterdam
    await sweeper.sweep(Date.parse('2026-10-17T10:30:00Z')); // a Saturday, 12:30
    assert.equal(placed.length, count);
    assert.equal((await cardOf(f.request)).call.hours, 'Sat, Sun 10:00-12:00');
    await sweeper.sweep(Date.parse('2026-10-17T08:30:00Z')); // a Saturday, 10:30
    assert.equal(placed.length, count + 1);
    assert.equal(row(f.id).status, 'dialling');
  } finally {
    writeFileSync(file, was);
  }
});

test("a dial a restart cut off ends failed and is never dialled again; an outbound ticket is one stream's, for 2 minutes", async () => {
  const juno = await h.start({ agent: 'juno' });
  const f = filed((await fileCall(juno, '--to', PARTNER)).out);
  db.prepare("update callouts set status = 'dialling', ticket_expires = ? where id = ?").run(
    Date.now() + 120_000,
    f.id,
  );
  sweeper.start();
  assert.equal(row(f.id).status, 'failed');
  assert.match(row(f.id).outcome, /may have rung once/);
  const count = placed.length;
  await sweeper.sweep();
  assert.equal(placed.length, count);

  const d = await dialled(juno);
  assert.deepEqual((await voice('call-ticket', { ticket: d.ticket })).body, {
    agent: 'juno',
    lang: 'en',
    callout: d.id,
  });
  assert.equal((await voice('call-ticket', { ticket: d.ticket })).status, 404);
  const late = await dialled(juno);
  db.prepare('update callouts set ticket_expires = ? where id = ?').run(Date.now() - 1, late.id);
  assert.equal((await voice('call-ticket', { ticket: late.ticket })).status, 404);
});

test('a link opens 15 minutes before its time until 3 hours after, for one call; any other token gets one closed page', async () => {
  const juno = await h.start({ agent: 'juno' });
  const at = new Date(Date.now() + 3600_000).toISOString().slice(0, 16) + 'Z';
  const f = filed((await fileCall(juno, '--link', '--at', at)).out);
  const approved = await board('/api/callouts/approve', { id: f.request });
  assert.equal(approved.status, 200);
  const { link, opens, closes } = approved.body,
    token = link.split('/join/')[1];
  assert.match(link, /^https:\/\/hq\.company\.test\/join\/[\w-]{43}$/);
  assert.equal(Date.parse(opens), Date.parse(at) - 15 * 60_000);
  assert.equal(Date.parse(closes), Date.parse(at) + 3 * 3600_000);
  assert.ok(
    (db.prepare('select answer from requests where id = ?').get(f.request) as { answer: string }).answer.includes(link),
  );
  assert.ok(!JSON.stringify(row(f.id)).includes(token), 'only its hash is kept with the call');
  assert.equal((await voice('join-ticket', { token })).status, 410); // not open yet
  db.prepare('update callouts set opens = ? where id = ?').run(new Date(Date.now() - 1000).toISOString(), f.id);
  assert.deepEqual((await voice('join-ticket', { token })).body, {
    agent: 'juno',
    lang: 'en',
    callout: f.id,
    name: 'Juno',
  });
  assert.equal((await voice('join-ticket', { token: 'x'.repeat(43) })).status, 404);
  const page = await h.send(`/join/${token}`),
    unknown = await h.send(`/join/${'y'.repeat(43)}`),
    junk = await h.send('/join/nothing');
  assert.equal(page.status, 200);
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.deepEqual([unknown.status, junk.status], [404, 404]);
  assert.equal(unknown.text, junk.text);
  assert.match(unknown.text, /This link has closed\..*Deze link is gesloten\..*Dieser Link ist geschlossen\./s);
  // the call ends: the link with it
  const ctx = await voice('call-context', {
    agent: 'juno',
    lang: 'en',
    callout: f.id,
    phone: false,
    request: 0,
    pins: [],
  });
  assert.equal(ctx.status, 200);
  assert.equal(
    (
      await voice('call-end', {
        agent: 'juno',
        token: ctx.body.token,
        callout: f.id,
        lines: ['Juno: Hi.'],
        notes: [],
        objected: false,
      })
    ).status,
    200,
  );
  assert.equal((await voice('join-ticket', { token })).status, 410);
  assert.equal((await h.send(`/join/${token}`)).status, 404);
});

test('a link nobody opened expires, and its filer hears it', async () => {
  const juno = await h.start({ agent: 'juno' });
  const f = filed((await fileCall(juno, '--link')).out);
  assert.equal((await board('/api/callouts/approve', { id: f.request })).status, 200);
  await sweeper.sweep(Date.now() + 25 * 3600_000);
  assert.equal(row(f.id).status, 'expired');
  const follow = jobsFor('juno', 'Follow up on your call with Print API').find(j =>
    j.prompt.includes(`call out #${f.id} `),
  )!;
  assert.match(follow.prompt, /nobody opened the link before it closed/);
});

test('the call: its partner briefing and fixed opening, a token that opens no route, a restart with it, one hand-over', async () => {
  const juno = await h.start({ agent: 'juno' });
  const d = await dialled(juno);
  assert.equal((await voice('call-ticket', { ticket: d.ticket })).status, 200);
  const ask = { agent: 'juno', lang: 'en', callout: d.id, phone: true, request: 0, pins: [] };
  const ctx = (await voice('call-context', ask)).body;
  assert.equal(
    ctx.opening,
    "Hi, this is Juno from Testco. I'm an AI assistant, calling about our parcel. I keep a written transcript of this call for our records.",
  );
  assert.equal(ctx.objected, "No problem, I won't keep one.");
  assert.deepEqual(
    [ctx.tools, ctx.callout, ctx.voice, ctx.who, ctx.lang, ctx.timeZone],
    ['partner', d.id, 'alba', 'Print API', 'en', 'Europe/Amsterdam'],
  );
  assert.match(ctx.prompt, /You're on a phone call with Print API/);
  assert.match(ctx.prompt, /reprint at their cost/);
  assert.match(
    ctx.prompt,
    new RegExp(`already said this for you, in fixed words: "${ctx.opening.replace(/[.?]/g, '\\$&')}"`),
  );
  assert.match(ctx.prompt, /Never pitch, sell or promote/);
  assert.match(ctx.prompt, /voicemail or an automated menu/);
  assert.doesNotMatch(ctx.prompt, /5550123/);
  assert.doesNotMatch(ctx.prompt, /search|history/);
  assert.equal((await h.agent('search?q=parcel', ctx.token)).status, 403);
  assert.equal((await h.agent('history', ctx.token)).status, 403);
  assert.equal((await h.agent('job', ctx.token, { agent: 'wren', title: 'x', prompt: 'y' })).status, 403);
  assert.equal((await h.agent('callout', ctx.token, { link: true })).status, 403);
  // a restart with its token goes on with it; another token is refused
  assert.equal((await voice('call-context', { ...ask, token: ctx.token })).body.token, ctx.token);
  assert.equal((await voice('call-context', { ...ask, token: 'not-it' })).status, 409);

  const lines = [
    'Print API: Print API, Sanne speaking.',
    'Juno: Hi Sanne, where is parcel PA-1234?',
    'Print API: It ships tomorrow.',
  ];
  const end = {
    agent: 'juno',
    token: ctx.token,
    callout: d.id,
    request: 0,
    lines,
    notes: ['Print API ships PA-1234 tomorrow.'],
    objected: false,
  };
  assert.deepEqual((await voice('call-end', end)).body, { ok: true });
  assert.deepEqual((await voice('call-end', end)).body, { ok: true, ignored: true });
  assert.equal((await h.agent('history', ctx.token)).status, 401);
  const follows = jobsFor('juno', 'Follow up on your call with Print API').filter(j =>
    j.prompt.includes(`call out #${d.id} `),
  );
  assert.equal(follows.length, 1);
  assert.doesNotMatch(follows[0].prompt, /PA-1234 tomorrow/);
  assert.match(follows[0].prompt, /the notes taken on it \(1\) and the transcript \(3 lines\)/);
  assert.match(follows[0].prompt, new RegExp(`hq phone call ${d.id}`));
  assert.match(follows[0].prompt, /hq mail draft/);
  assert.doesNotMatch(follows[0].prompt, /Sanne speaking|ships tomorrow\./);
  // the follow-up reads it whole; another job of the same agent reads its state only
  db.prepare("update jobs set status = 'cancelled' where status = 'queued' and id != ?").run(follows[0].id);
  const followUp = await h.claim();
  assert.equal(followUp?.id, follows[0].id);
  const read = await hq(followUp!, 'phone', 'call', String(d.id));
  assert.match(read.out, /: done\nHow it ended: the call was held/);
  assert.match(read.out, /Print API: Print API, Sanne speaking\./);
  assert.match(read.out, /- Print API ships PA-1234 tomorrow\./);
  // the board reads it whole on the call's card: when, the notes and who said what
  const held = (await pastCard(d.request)).call;
  assert.deepEqual(
    [held.status, held.transcript, held.notes, held.objected, held.kept, !!held.started, !!held.ended],
    ['done', lines, ['Print API ships PA-1234 tomorrow.'], false, true, true, true],
  );
  const other = await h.start({ agent: 'juno' });
  const state = await hq(other, 'phone', 'call', String(d.id));
  assert.match(state.out, /: done/);
  assert.doesNotMatch(state.out, /Sanne/);
  assert.match(state.out, /only to the job that filed it and its follow-up/);
});

test('an objection keeps only the notes, and 12 months after a call its words go but its row stays', async () => {
  const juno = await h.start({ agent: 'juno' });
  const d = await dialled(juno);
  await voice('call-ticket', { ticket: d.ticket });
  const ctx = (await voice('call-context', { agent: 'juno', lang: 'en', callout: d.id, phone: true })).body;
  await voice('call-end', {
    agent: 'juno',
    token: ctx.token,
    callout: d.id,
    lines: ['Print API: please keep no transcript'],
    notes: ['They reprint PA-1234.'],
    objected: true,
  });
  assert.deepEqual(
    [JSON.parse(row(d.id).transcript), JSON.parse(row(d.id).notes), row(d.id).objected],
    [[], ['They reprint PA-1234.'], 1],
  );
  assert.match(jobsFor('juno', 'Follow up on your call with Print API').at(-1)!.prompt, /rather we kept no transcript/);
  assert.deepEqual(
    (({ transcript, notes, objected, kept }) => ({ transcript, notes, objected, kept }))(
      (await pastCard(d.request)).call,
    ),
    { transcript: [], notes: ['They reprint PA-1234.'], objected: true, kept: true },
  );
  db.prepare('update callouts set ended = ? where id = ?').run(
    new Date(Date.now() - 366 * 86_400_000).toISOString(),
    d.id,
  );
  await sweeper.sweep();
  assert.deepEqual(
    [row(d.id).transcript, row(d.id).notes, row(d.id).status, row(d.id).who],
    [null, null, 'done', 'Print API'],
  );
  const gone = (await pastCard(d.request)).call;
  assert.deepEqual([gone.transcript, gone.notes, gone.kept, gone.deleted], [[], [], false, true]);
});

test('a call whose hand-over never came ends done, and its card says nothing was handed over, never that it was deleted', async () => {
  const juno = await h.start({ agent: 'juno' });
  const d = await dialled(juno);
  await voice('call-ticket', { ticket: d.ticket });
  assert.equal(
    await twilio(`/api/twilio/status?callout=${d.id}`, {
      CallSid: row(d.id).sid,
      CallStatus: 'completed',
      AccountSid: ACCOUNT,
    }),
    204,
  );
  await sweeper.sweep(Date.now() + 11 * 60_000);
  const call = (await pastCard(d.request)).call;
  assert.deepEqual([call.status, call.kept, call.deleted, call.transcript], ['done', false, false, []]);
  // a year on, the sweep's blanking passes it by: still nothing handed over (the card read in place: the board's
  // session has expired a year on)
  mock.timers.enable({ apis: ['Date'], now: Date.now() + 366 * 86_400_000 });
  try {
    await sweeper.sweep();
    assert.equal(callcard.card({ kind: 'call', id: d.request }).call.deleted, false);
  } finally {
    mock.timers.reset();
  }
});

test("an inbound call still gets the company's message, and a call out's stream isn't the board's", async () => {
  assert.equal(await twilio('/api/twilio/voice', { From: '+31205550123', AccountSid: ACCOUNT }), 200);
  assert.equal((await voice('call-ticket', { ticket: 'unknown' })).status, 404);
});

// ---- walk-throughs
const { ORIGIN } = await import('./config.ts');
const watchStore = await import('../../../shared/watchalong/store.ts');
const watching = watchStore.open(db, `${h.dataDir}/watchalong`);
const HELLO_PAGE = 'https://hello.preview.company.test/';
// The board's share of the hello preview with Sam (feedback.ts): its id
const shareHello = async () => {
  const shared = await board('/api/review/shares', {
    page: HELLO_PAGE,
    name: 'Sam',
    email: 'sam@example.org',
    days: 3,
  });
  assert.equal(shared.status, 200);
  return Number(shared.body.id);
};
const startWatching = (token: string) =>
  h.send('/api/watchalong/join', { origin: ORIGIN, 'content-type': 'application/json' }, { token });
const live = async (id: number) =>
  (await voice('call-context', { agent: 'juno', lang: 'en', callout: id, phone: false, request: 0, pins: [] })).body;
const batch = { events: [{ type: 4, timestamp: Date.now(), data: {} }] };
const postEvents = async (events: string) =>
  (await h.send(events, { origin: ORIGIN, 'content-type': 'application/json' }, batch)).status;

test("a join link walks through a share the board made: its card says so, and its page frames the share's preview", async () => {
  const juno = await h.start({ agent: 'juno' });
  const share = await shareHello();
  for (const [flags, why] of [
    [['--to', PARTNER, '--share', String(share)], /--share: with --link only/],
    [['--link', '--share', '999999'], /no share #999999/],
  ] as const)
    assert.match((await fileCall(juno, ...flags)).out, why);
  const f = filed((await fileCall(juno, '--link', '--share', String(share))).out);
  const card = await cardOf(f.request);
  assert.match(card.title, /A call room with Print API about our parcel, walking through /);
  assert.equal(card.call.share.id, share);
  const { link } = (await board('/api/callouts/approve', { id: f.request })).body;
  assert.match(
    (db.prepare('select answer from requests where id = ?').get(f.request) as { answer: string }).answer,
    /Everyone on the share it walks through finds the call on their invite too/,
  );
  const page = await h.send(new URL(link).pathname);
  assert.equal(page.status, 200);
  assert.match(page.text, /<iframe class="walk" data-src="https:\/\/hello\.preview\.company\.test\/"/);
  assert.match(page.text, /Join and show our pages/);
  assert.match(page.headers['content-security-policy'], /frame-src 'self' https:\/\/hello\.preview\.company\.test;/);
  // an ordinary link frames nothing
  const plain = filed((await fileCall(juno, '--link')).out);
  const plainPage = await h.send(
    new URL((await board('/api/callouts/approve', { id: plain.request })).body.link).pathname,
  );
  assert.doesNotMatch(plainPage.text, /<iframe class="walk"/);
  // a share that ended has nothing to walk through: refused when filed, and the page goes back to an ordinary call's
  await board('/api/review/shares/end', { id: share });
  assert.match((await fileCall(juno, '--link', '--share', String(share))).out, /has ended/);
  assert.doesNotMatch((await h.send(new URL(link).pathname)).text, /<iframe class="walk"/);
});

test("a walk-through records only once its call is on, on the join link's own token, and ends or goes with the call", async () => {
  const juno = await h.start({ agent: 'juno' });
  const share = await shareHello();
  const walk = async () => {
    const f = filed((await fileCall(juno, '--link', '--share', String(share))).out);
    const { link } = (await board('/api/callouts/approve', { id: f.request })).body;
    return { ...f, token: link.split('/join/')[1] as string };
  };
  const kept = await walk();
  assert.equal((await startWatching(kept.token)).status, 409, 'nobody is in the call yet');
  assert.equal((await startWatching('x'.repeat(43))).status, 409);
  const ctx = await live(kept.id);
  const started = await startWatching(kept.token);
  assert.equal(started.status, 200);
  const { id, events } = started.json;
  assert.equal(watchStore.find(watching, id)!.typed, 'hidden', "a guest's typing is never kept");
  // (its mirror shows only the previews the share reaches.)
  assert.deepEqual(watchStore.find(watching, id)!.origins, ['https://hello.preview.company.test']);
  assert.equal(await postEvents(events), 200);
  // the page loaded again (a reload, a second tab): one recording a link, the newest, and the first one's batches 409
  const again = await startWatching(kept.token);
  assert.equal(again.status, 200);
  assert.equal(await postEvents(events), 409);
  assert.equal(await postEvents(again.json.events), 200);
  const handOver = { agent: 'juno', token: ctx.token, callout: kept.id, notes: [], objected: false };
  await voice('call-end', { ...handOver, lines: ['Sam: This button is hard to find.'] });
  assert.equal(await postEvents(again.json.events), 409, 'the call is over, so is its recording');
  assert.equal(watchStore.read(watching, id)!.events.length, 1);
  assert.equal((await startWatching(kept.token)).status, 409);

  // a call whose other side would rather we kept no transcript takes its recording with it
  const gone = await walk();
  const goneCtx = await live(gone.id);
  const goes = (await startWatching(gone.token)).json;
  assert.equal(await postEvents(goes.events), 200);
  await voice('call-end', { ...handOver, token: goneCtx.token, callout: gone.id, lines: [], objected: true });
  assert.equal(watchStore.find(watching, goes.id), undefined);
  assert.equal(existsSync(`${h.dataDir}/watchalong/${goes.id}.ndjson.gz`), false);
});
