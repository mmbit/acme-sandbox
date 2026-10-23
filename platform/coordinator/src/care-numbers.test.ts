// node --test src/care-numbers.test.ts   (a throwaway DATA_DIR, the real hq)
// Care › Numbers (care-numbers.ts): the day's counts the care service sends, stored by app and day; what HQ adds itself
// (reply times, open questions and their jobs, the knowledge base's entries, the month against the cap); the board's
// route, the chat's line on an app's dashboard in Numbers, and hq numbers' lines. Throwaway DATA_DIR, the real hq.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

const h = await harness('care-numbers', { env: { PUBLIC_HOST: 'hq.testco.example' }, before: repo => {
  writeFileSync(`${repo}/company/brand.yaml`, readFileSync(`${repo}/company/brand.yaml`, 'utf8') + `
care:
  numbers: { cap: { month: 19, console: 20 }, first_words: { plain: [1500, 3000], lookup: [2500, 5000] } }
`);
  // a shop with a dashboard in Numbers, one without any chat numbers, and the chat's knowledge base (two shared entries
  // and the shop's own one; the README isn't an entry)
  for (const [slug, name] of [['pinwheel', 'Pinwheel'], ['quietshop', 'Quiet Shop']]) {
    mkdirSync(`${repo}/products/${slug}/app`, { recursive: true });
    writeFileSync(`${repo}/products/${slug}/product.yaml`, `name: ${name}\nowner: wren\nstatus: preview\n`);
    writeFileSync(`${repo}/products/${slug}/app/metrics.json`, JSON.stringify({ steps: [{ id: 'page' }], tests: [] }));
  }
  for (const f of ['shared/README.md', 'shared/returns.md', 'shared/vat.md', 'pinwheel/sizes.md', 'quietshop/other.md']) {
    mkdirSync(`${repo}/products/care/kb/${f.split('/')[0]}`, { recursive: true });
    writeFileSync(`${repo}/products/care/kb/${f}`, '---\nquestion: x\n---\nx\n');
  }
} });
const { db, board: boardCall } = h;
const numbers = await import('./care-numbers.ts');
const { signed } = await import('./payments.ts');

const CARE = signed('care:hq');
const careCall = (path: string, body?: unknown, token = CARE) => h.call(path, token, body);
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam' }).format(new Date());
const day = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const words = (p50: number, p95: number, bands: number[]) => ({ p50, p95, to_1500: bands[0], to_3000: bands[1], to_5000: bands[2], over_5000: bands[3] });
const counts = (over: Record<string, unknown> = {}) => ({ conversations: 10, resolved_helped: 3, resolved_remedy: 1, person_cases: 2, question_cases: 1,
  helped_asked: 4, helped_yes: 3, helped_no: 1, replies_plain: 20, replies_lookup: 5,
  first_words_ms: { plain: words(1200, 2800, [12, 7, 1, 0]), lookup: words(2600, 4800, [1, 3, 1, 0]) },
  outage_minutes: 3, cap_minutes: 0, model_calls: 30, emails: 12, cost_eur: 0.5, cost_eur_p95: 0.08, model: 'model-x', ...over });
const push = (app: string, d: string, c: Record<string, unknown> = counts(), extra: Record<string, unknown> = {}) => careCall('/api/care/numbers', { app, day: d, counts: c, ...extra });
// A day as the board's Numbers shows it (live pinwheel; today is "now", today so far)
const shown = async (d: string) => { const v = (await boardCall('/api/care/numbers?app=pinwheel&mode=live')).body; return d === today ? v.now : v.daily.find((x: any) => x.day === d); };
// What HQ's database keeps: the promise is that it's counts only, nothing of a customer
const stored = (app: string, d: string) => (db.prepare('select counts from care_numbers where app = ? and day = ?').get(app, d) as { counts: string }).counts;
// Each test starts from care having sent nothing (no route forgets a day)
const fresh = () => db.prepare('delete from care_numbers').run();

test("care's numbers come only with care's token, whole and of the right types; only the named counts reach HQ's database", async () => {
  assert.equal((await push('pinwheel', day(-1))).status, 200);
  const bad = async (body: unknown, auth = CARE) => (await careCall('/api/care/numbers', body, auth)).status;
  assert.equal(await bad({ app: 'pinwheel', day: day(-1), counts: counts() }, ''), 401);
  assert.equal(await bad({ app: 'pinwheel', day: day(-1), counts: counts() }, `Bearer ${signed('pay:pinwheel:live')}`), 401);
  assert.equal((await boardCall('/api/care/numbers', { app: 'pinwheel', day: day(-1), counts: counts() })).status, 401, "the board's session isn't care's token");
  assert.equal((await careCall('/api/care/numbers')).status, 401, "care's token doesn't read the board's numbers");
  for (const [why, body] of [
    ['not a day', { app: 'pinwheel', day: '2026-02-30', counts: counts() }],
    ['a day to come', { app: 'pinwheel', day: day(3), counts: counts() }],
    ['a count below 0', { app: 'pinwheel', day: day(-1), counts: counts({ conversations: -1 }) }],
    ['a count with a fraction', { app: 'pinwheel', day: day(-1), counts: counts({ person_cases: 1.5 }) }],
    ['a count as text', { app: 'pinwheel', day: day(-1), counts: counts({ helped_yes: '3' }) }],
    ['a band as text', { app: 'pinwheel', day: day(-1), counts: counts({ first_words_ms: { plain: { ...words(1, 2, [1, 1, 1, 1]), to_3000: 'x' } } }) }],
    ['a model id with markup', { app: 'pinwheel', day: day(-1), counts: counts({ model: '<b>x</b>' }) }],
    ['a timing series not named', { app: 'pinwheel', day: day(-1), counts: counts({ timing: { 'anthropic.chat.turn.done; drop': { 100: 1 } } }) }],
    ['a timing step as text', { app: 'pinwheel', day: day(-1), counts: counts({ timing: { 'anthropic.chat.turn.done': { soon: 1 } } }) }],
    ['a timing count as text', { app: 'pinwheel', day: day(-1), counts: counts({ timing: { 'anthropic.chat.turn.done': { 100: '1' } } }) }],
    ['partial as text', { app: 'pinwheel', day: today, counts: counts(), partial: 'yes' }],
    ['no counts', { app: 'pinwheel', day: day(-1) }],
  ] as [string, unknown][]) assert.equal(await bad(body), 400, why);
  assert.equal((await shown(day(-1))).conversations, 10, 'nothing refused was stored');
  // an app that isn't ours, or a day older than Numbers reads: taken (care's queue goes on to the next day), not kept
  for (const [app, d] of [['nosuch', day(-1)], ['', day(-1)], ['../company', day(-1)], ['pinwheel', day(-401)]]) {
    const r = await careCall('/api/care/numbers', { app, day: d, counts: counts() });
    assert.deepEqual([r.status, r.body], [200, { ok: true, kept: false }], `${app} ${d}`);
  }
  assert.deepEqual((await boardCall('/api/care/numbers')).body.apps.map((a: any) => a.slug), ['pinwheel']);
  // anything beyond the named counts never reaches HQ's database (counts only: no ids, no case, no customer)
  await push('pinwheel', day(-1), { ...counts(), conversation_ids: [1, 2], case: 'H-1042', email: 'anna@example.com' });
  const kept = JSON.parse(stored('pinwheel', day(-1)));
  assert.deepEqual(Object.keys(kept).sort(), ['cap_minutes', 'conversations', 'cost_eur', 'cost_eur_p95', 'emails', 'first_words', 'helped_asked', 'helped_no',
    'helped_yes', 'model', 'model_calls', 'outage_minutes', 'person_cases', 'question_cases', 'replies_lookup', 'replies_plain', 'resolved_helped', 'resolved_remedy']);
  assert.doesNotMatch(stored('pinwheel', day(-1)), /anna|H-1042|conversation_ids/);
});

test('stored by app and day, replacing; today so far never replaces a finished day', async () => {
  await push('pinwheel', day(-2), counts({ conversations: 11 }));
  await push('pinwheel', day(-2), counts({ conversations: 12 }));
  assert.equal((await shown(day(-2))).conversations, 12, 'the same day again replaces it');
  await push('pinwheel', today, counts({ conversations: 3 }), { partial: true });
  await push('pinwheel', today, counts({ conversations: 5 }), { partial: true });
  const now = async () => { const v = await shown(today); return [v.conversations, !!v.partial]; };
  assert.deepEqual(await now(), [5, true]);
  await push('pinwheel', today, counts({ conversations: 6 }));
  await push('pinwheel', today, counts({ conversations: 1 }), { partial: true });
  assert.deepEqual(await now(), [6, false], 'a late partial left the finished day as it was');
  fresh();
});

test("asking care again: today, while the board looks, in care's state until it comes or an hour goes by", async () => {
  assert.equal((await careCall('/api/care/state')).body.numbers, undefined, 'nothing asked: no numbers key');
  assert.equal((await boardCall('/api/care/numbers?app=pinwheel&mode=preview')).status, 200);
  await boardCall('/api/care/numbers?app=pinwheel&mode=preview');
  assert.deepEqual((await careCall('/api/care/state')).body.numbers, [today], 'asked once');
  await push('pinwheel@preview', today, counts(), { partial: true });
  assert.equal((await careCall('/api/care/state')).body.numbers, undefined, 'had: dropped from the list');
  await boardCall('/api/care/numbers?app=pinwheel&mode=preview');
  assert.equal((await careCall('/api/care/state')).body.numbers, undefined, 'today so far is fresh: not asked again');
  // time passing, which no route makes
  db.prepare("update care_numbers set at = ? where app = 'pinwheel@preview'").run(new Date(Date.now() - 20 * 60e3).toISOString());
  await boardCall('/api/care/numbers?app=pinwheel&mode=preview');
  assert.deepEqual((await careCall('/api/care/state')).body.numbers, [today], 'a quarter of an hour old: asked again');
  db.prepare('update care_numbers_asks set at = ?').run(Date.now() - 61 * 60e3);
  assert.equal((await careCall('/api/care/state')).body.numbers, undefined, 'an hour without an answer: dropped');
  fresh();
});

test('one app: the last 28 finished days, live and preview apart, today so far apart; a count not sent is "not counted", never 0', async () => {
  await push('pinwheel@preview', day(-1), counts());
  await push('pinwheel@preview', day(-2), counts({ conversations: 20 }));
  await push('pinwheel@preview', day(-29), counts({ conversations: 100 }));   // before the 28 days
  await push('pinwheel@preview', today, counts({ conversations: 7 }), { partial: true });
  const { helped_asked: _a, helped_yes: _y, helped_no: _n, ...noHelp } = counts({ conversations: 50, first_words_ms: { plain: words(4000, 9000, [1, 1, 1, 7]) } });
  await push('pinwheel', day(-1), noHelp);
  const d = (await boardCall('/api/care/numbers?app=pinwheel&mode=preview')).body;
  assert.deepEqual([d.app, d.mode, d.from, d.to, d.daily.length], ['pinwheel@preview', 'preview', day(-28), day(-1), 28]);
  const t = d.totals;
  assert.equal(t.conversations, 30); assert.equal(d.now.conversations, 7); assert.equal(d.now.partial, true);
  assert.deepEqual([t.resolved, t.resolvedHelped, t.resolvedRemedy, t.resolvedRate], [8, 6, 2, 26.7], 'resolved without a person: helped and remedies added');
  assert.deepEqual([t.person, t.personRate, t.questions, t.questionRate], [4, 13.3, 2, 6.7]);
  assert.deepEqual(t.helped, { asked: 8, yes: 6, no: 2 });
  assert.deepEqual([t.outage, t.cap, t.cost, t.perConversation, t.costP95], [6, 0, 1, 0.033, 0.08]);
  assert.deepEqual(t.bands.plain, [24, 14, 2, 0]);
  assert.equal(d.daily.at(-1).conversations, 10); assert.equal(d.daily[0].none, true);
  assert.equal(d.model, 'model-x');
  // the design's targets: from the bands where they can tell, and the days whose own figure met it
  const target = (k: string, p: string) => d.targets.find((x: any) => x.kind === k && x.p === p);
  assert.deepEqual([target('plain', 'p50').met, target('plain', 'p50').daysMet, target('plain', 'p50').days], [true, 2, 2]);
  assert.equal(target('plain', 'p95').met, true, '38 of 40 within 3 s is 95%');
  assert.equal(target('lookup', 'p50').met, null, '2.5 s sits inside a band: the bands can’t tell');
  assert.deepEqual([target('lookup', 'p50').daysMet, target('lookup', 'p95').met], [0, true]);
  const live = (await boardCall('/api/care/numbers?app=pinwheel&mode=live')).body;
  assert.equal(live.totals.conversations, 50, 'live apart from preview');
  assert.deepEqual(live.totals.helped, { asked: null, yes: null, no: null }, 'not sent: not counted yet');
  await push('pinwheel', day(-2), counts({ conversations: 0, first_words_ms: { plain: words(0, 0, [0, 0, 0, 0]), lookup: words(0, 0, [0, 0, 0, 0]) } }));
  const quiet = (await boardCall('/api/care/numbers?app=pinwheel&mode=live')).body;
  assert.deepEqual(quiet.daily.at(-2).words, { plain: { p50: null, p95: null }, lookup: { p50: null, p95: null } }, 'no replies, no percentile (care sends 0)');
  assert.equal(quiet.targets.find((x: any) => x.kind === 'plain' && x.p === 'p50').days, 1, 'and that day isn’t one the target was met on');
  assert.equal(live.targets.find((x: any) => x.kind === 'plain' && x.p === 'p50').met, false);
  assert.equal(live.now, null);
  // the knowledge base: the shared entries and the app's own, the README not one; the month: every app's cost together
  assert.deepEqual(d.kb, { entries: 3, shared: 2, own: 1 });
  const month = [day(-1), day(-2), today].filter(x => x.startsWith(today.slice(0, 7))).length * 0.5 + (day(-1).startsWith(today.slice(0, 7)) ? 0.5 : 0);
  assert.deepEqual([d.month.month, d.month.eur, d.month.cap, d.month.console], [today.slice(0, 7), month, 19, 20]);
  // the apps the chat has numbers for, and the refusals
  assert.deepEqual((await boardCall('/api/care/numbers')).body.apps, [{ slug: 'pinwheel', name: 'Pinwheel', live: true, preview: true, status: 'preview' }]);
  assert.equal((await boardCall('/api/care/numbers?app=nosuch')).status, 404);
  assert.equal((await boardCall('/api/care/numbers?app=..%2Fcompany')).status, 404);
  assert.equal((await boardCall('/api/care/numbers?app=pinwheel&mode=test')).status, 400);
  assert.equal((await careCall('/api/care/numbers?app=pinwheel')).status, 401, 'the board’s login');
  fresh();
});

test("HQ's own drafts (app hq): only their spend kept, counted in the month and apart, and never an app (job #4184)", async () => {
  // as care sends it now, and a day it closed before (with the chat's counts too: only the spend is kept)
  assert.deepEqual((await push('hq', today, { model_calls: 2, cost_eur: 0.42, model: 'model-y' }, { partial: true })).body, { ok: true });
  assert.deepEqual((await push('hq', day(-1), counts({ cost_eur: 0.3, first_words_ms: 'x' }))).body, { ok: true });
  assert.deepEqual(JSON.parse(stored('hq', day(-1))), { model_calls: 30, cost_eur: 0.3, model: 'model-x' });
  assert.equal((await push('hq', today, { model_calls: 2, cost_eur: -1 })).status, 400, 'its spend is checked like any app’s');
  for (const app of ['hq@preview', 'HQ']) assert.deepEqual((await push(app, today, { model_calls: 1, cost_eur: 1 })).body, { ok: true, kept: false }, app);
  await push('pinwheel', today, counts({ cost_eur: 1 }), { partial: true });
  const m = (await boardCall('/api/care/numbers?app=pinwheel&mode=live')).body.month, last = day(-1).startsWith(today.slice(0, 7)) ? 0.3 : 0;
  assert.deepEqual([m.eur, m.app, m.hq], [Math.round((1.42 + last) * 100) / 100, 1, Math.round((0.42 + last) * 100) / 100], 'in the month, as the cap counts it, and apart');
  assert.equal((await boardCall('/api/care/numbers?app=pinwheel&mode=preview')).body.month.hq, m.hq, 'the same for either mode');
  // never an app: not listed, no screen of its own, no chat line
  assert.deepEqual((await boardCall('/api/care/numbers')).body.apps.map((a: any) => a.slug), ['pinwheel']);
  assert.equal((await boardCall('/api/care/numbers?app=hq')).status, 404);
  assert.equal(numbers.line('hq', 'live', 28), null);
  db.prepare("delete from care_numbers where app = 'hq'").run();   // (a month without any)
  assert.equal((await boardCall('/api/care/numbers?app=pinwheel&mode=live')).body.month.hq, null, 'none: no part (the meter shows no key)');
  fresh();
});

test("reply times are HQ's own: a person card's arrival to the board's Send, in working days; open questions and their jobs", async () => {
  const t = Date.parse('2026-10-14T12:00:00Z');   // a Wednesday
  let n = 5000;
  // a card's history, on fixed days in the past (no route back-dates a card): filed by care, then where it stands
  const card = async (kind: string, created: string, status: string, sent?: string, app = 'pinwheel') => {
    const id = (await careCall('/api/care/cards', { kind, app, case: `H-${++n}`, check: 'none', to: 'anna@example.com', lang: 'en', words: 'Hello',
      summary: 'A question in general words.', facts: {}, chat: [], draft: null })).body.id;
    db.prepare('update care_cards set created = ?, since = ?, status = ? where id = ?').run(created, created, status, id);
    if (sent) db.prepare("insert into care_lines (card, at, who, text) values (?, ?, 'board', 'Thanks!')").run(id, sent);
    return id;
  };
  await card('person', '2026-10-05T10:00:00Z', 'sent', '2026-10-07T09:00:00Z');      // Monday → Wednesday: 2, within
  await card('person', '2026-10-01T10:00:00Z', 'sent', '2026-10-08T09:00:00Z');      // Thursday → next Thursday: 5, late
  await card('person', '2026-10-09T10:00:00Z', 'waiting');                           // 3 so far: not decided yet
  await card('person', '2026-10-06T10:00:00Z', 'waiting');                           // 6 so far: past 3
  await card('person', '2026-10-02T10:00:00Z', 'closed');                            // closed without a reply
  await card('person', '2026-09-01T10:00:00Z', 'sent', '2026-09-01T12:00:00Z');      // before the 28 days
  await card('person', '2026-10-05T10:00:00Z', 'waiting', undefined, 'pinwheel@preview');   // the preview's, apart
  const job = { id: h.queue({ agent: 'kit', title: 'A question' }) };
  const q = await card('question', '2026-10-12T10:00:00Z', 'team');
  db.prepare('update care_cards set job = ? where id = ?').run(job.id, q);
  await card('question', '2026-10-13T10:00:00Z', 'waiting');
  await card('question', '2026-10-01T10:00:00Z', 'answered');
  const d = numbers.detail('pinwheel', 'live', 28, t);
  assert.deepEqual(d.reply, { arrived: 5, answered: 2, within: 1, late: 1, share: 33.3, median: 2, longest: 5, waiting: 2, closed: 1,
    oldest: { since: '2026-10-06T10:00:00Z', days: 6 }, aim: 3 });
  assert.equal(numbers.detail('pinwheel', 'preview', 28, t).reply.waiting, 1);
  // hq numbers' line says the aim the share is counted against (a line needs a day the chat counted)
  if (!numbers.line('pinwheel', 'live', 28, t)) assert.equal((await push('pinwheel', day(-1))).status, 200);
  assert.deepEqual(numbers.line('pinwheel', 'live', 28, t)!.reply, { share: 33.3, aim: 3, answered: 2, waiting: 2, oldest: 6 });
  // waiting now is every card waiting today: one from before the period, and one answered that came back with a follow-up
  await card('person', '2026-08-03T10:00:00Z', 'waiting');
  await card('person', '2026-10-07T10:00:00Z', 'waiting', '2026-10-08T09:00:00Z');
  const now = numbers.detail('pinwheel', 'live', 28, t).reply;
  assert.equal(now.waiting, 4); assert.equal(now.oldest!.since, '2026-08-03T10:00:00Z');
  assert.equal(now.late, 1, 'the late count stays the period’s own');
  assert.deepEqual(d.questions, { open: 2, team: [{ job: job.id, job_code: h.job(job.id).code, status: 'queued' }], board: 1 });
  // a question the team handed back (its job kept) is the board's; a card that came and was answered today isn't the period's
  const back = await card('question', '2026-10-13T11:00:00Z', 'waiting');
  db.prepare('update care_cards set job = ? where id = ?').run(job.id, back);
  await card('person', '2026-10-14T08:00:00Z', 'sent', '2026-10-14T09:00:00Z');
  const later = numbers.detail('pinwheel', 'live', 28, t);
  assert.deepEqual(later.questions, { open: 3, team: [{ job: job.id, job_code: h.job(job.id).code, status: 'queued' }], board: 2 });
  assert.deepEqual([later.reply.arrived, later.reply.answered], [now.arrived, now.answered]);
  assert.equal(d.busy.held, true, 'the busy notice, as care reads it: on while someone waits past 3 working days');
});

test("each app's dashboard in Numbers carries the chat's line for its days and mode, and hq numbers prints it", async () => {
  await push('pinwheel@preview', day(-1), counts());
  await push('pinwheel@preview', day(-3), counts({ conversations: 20 }));
  const dash = (await boardCall('/api/numbers/pinwheel?mode=preview&days=28')).body;
  assert.deepEqual([dash.chat.app, dash.chat.conversations, dash.chat.resolved, dash.chat.resolvedRate, dash.chat.person, dash.chat.personRate, dash.chat.kb],
    ['pinwheel@preview', 30, 8, 26.7, 4, 13.3, 3]);
  assert.equal((await boardCall('/api/numbers/pinwheel?mode=preview&days=2')).body.chat.conversations, 10, "the dashboard's own period");
  assert.equal((await boardCall('/api/numbers/quietshop')).body.chat, null, 'no chat numbers for that app: no line');
  assert.equal((await boardCall('/api/numbers')).body.chat, undefined, 'not on the home list');
  const kit = await h.start({ agent: 'kit', title: 'growth session' });
  const run = async (...args: string[]) => (await h.hq(kit, 'numbers', ...args)).out;
  const out = await run('pinwheel', '--mode', 'preview');
  assert.match(out, /support chat \(pinwheel@preview/);
  assert.match(out, /30 conversations.*without a person: 8 \(26\.7 .*to a person: 4 \(13\.3 /);
  assert.match(out, /asked 8, Yes 6, Not really 2/);
  assert.match(out, /Outage: 6 minutes.*past a cap: 0 minutes.*€1\.00 \(€0\.03 a conversation\)/);
  assert.match(out, /Turn timing: not counted yet\./, 'days from before care sent timing');
  // turn timing: each series' histograms added up over the days, as a count, median, 95th and longest
  await push('pinwheel@preview', day(-1), counts({ timing: { 'anthropic.chat.turn.done': { 1200: 3, 9000: 1 }, 'anthropic.chat.rounds.done': { 1: 3, 2: 1 } } }));
  await push('pinwheel@preview', day(-3), counts({ timing: { 'anthropic.chat.turn.done': { 1200: 1, 30000: 1 }, 'fake.chat.turn.done': { 100: 2 }, 'anthropic.phone.turn.done': { 121000: 1 } } }));
  assert.deepEqual((await boardCall('/api/numbers/pinwheel?mode=preview&days=28')).body.chat.timing, {
    'anthropic.chat.rounds.done': { n: 4, p50: 1, p95: 2, max: 2 }, 'anthropic.chat.turn.done': { n: 6, p50: 1200, p95: 30000, max: 30000 },
    'anthropic.phone.turn.done': { n: 1, p50: { over: 120000 }, p95: { over: 120000 }, max: { over: 120000 } },
    'fake.chat.turn.done': { n: 2, p50: 100, p95: 100, max: 100 } });
  const timed = await run('pinwheel', '--mode', 'preview');
  assert.match(timed, /anthropic\.chat\.turn\.done: 6, median 1\.2 s, 95th 30 s, longest 30 s/);
  assert.match(timed, /anthropic\.chat\.rounds\.done: 4 turns, rounds: median 1, 95th 2, most 2/);
  assert.match(timed, /anthropic\.phone\.turn\.done: 1, median >120 s, 95th >120 s, longest >120 s/);
  assert.doesNotMatch(await run('quietshop'), /support chat/);
  // a count care hasn't sent yet says so, with no unit left dangling
  for (const d of [day(-1), day(-3)]) await push('pinwheel@preview', d, counts({ outage_minutes: null, cap_minutes: null }));
  assert.match(await run('pinwheel', '--mode', 'preview'), /Outage: not counted yet \(at the provider\); past a cap: not counted yet \(ours\)/);
});
