#!/usr/bin/env node
// A call out's card (hq phone call): the desk phone shows who the agent calls or meets, about what, in which language and
// when, with no answer box. A phone call's number shows only by its last digits until Show fetches it, and stays on no
// storage. Call posts the approval, a refusal says why, Don't call asks first. A call room's Call shows the link to send on
// until Done, through a poll, and Copy copies it. The archive shows who and how, and its answer's link copies with a tap;
// a held call shows when, the notes and its transcript (only the notes once they objected).
//   node platform/hq/callout-check.mjs
// HQ on its own files with a fake /api (so it isn't in dev mode), the phone open on three call outs, at phone size.
import assert from 'node:assert/strict';
import { serve } from './serve.mjs';
import { playwright, openPage } from '../../shared/browser/browser.mjs';

const OUT = process.env.TMPDIR ?? '/tmp';
const server = await serve(),
  base = `http://localhost:${server.address().port}`;
const call = { id: 7, kind: 'phone', who: 'Print API', about: 'our parcel', lang: 'en', at: null, ending: '123', digits: true,
  status: 'open', hours: 'Mon–Fri 09:00–17:00', timeZone: 'Europe/Amsterdam', name: 'Juno' }; // prettier-ignore
const room = { ...call, id: 8, kind: 'link', who: 'the framing workshop', about: 'the frame samples', lang: 'nl',
  at: '2026-10-20T13:00:00Z', ending: null, digits: false, name: 'Dex' }; // prettier-ignore
const card = (id, title, c) => ({ id, created: new Date().toISOString(), agent: c.name.toLowerCase(), kind: 'call',
  title, body: 'They asked for a call. It may agree to a reprint at no cost to us.', urgency: 'today', topic: 'calls', call: c }); // prettier-ignore
let cards = [
  card(31, 'Call Print API about our parcel', call),
  card(32, 'Meet the framing workshop', room),
  card(33, 'Meet the framing workshop again', { ...room, id: 9 }),
];
const LINK = 'https://hq.example/join/abc123';
const archived = {
  ...card(30, 'Meet the paper mill', { ...room, id: 6, who: 'the paper mill', status: 'approved' }),
  status: 'answered',
  answered: new Date().toISOString(),
  answer: `Call approved. It opens for one call. The link to send them: \`${LINK}\``,
};
// a call that was held, whole for the board: when, the notes, who said what; and one where they'd rather we kept none
const held = {
  ...call, id: 5, status: 'done', ending: null, outcome: 'the call was held', started: '2026-10-19T12:06:10Z',
  ended: '2026-10-19T12:09:40Z', objected: false, kept: true, notes: ['Print API answers by email today.'],
  transcript: ['Print API: Print API, Sanne speaking.', 'Juno: Hi Sanne, about our parcel.', '(Juno ended the call.)'],
}; // prettier-ignore
const heldCard = { ...card(29, 'Call Print API about our parcel', held), status: 'answered',
  answered: '2026-10-19T12:00:00Z', answer: 'Approved: Juno calls Print API now.' }; // prettier-ignore
const objected = { ...heldCard, id: 28, call: { ...held, id: 4, objected: true, transcript: [] } };
const posted = [];
const approvals = [
  [409, { error: 'Outside calling hours: it calls from Monday 09:00.' }],
  [200, { ok: true }],
  [200, { ok: true, link: LINK, opens: new Date(Date.now() - 60_000).toISOString(), closes: '2026-10-20T16:00:00Z' }],
];
const numbers = [[404, {}], [200, { number: '+31 20 555 0123' }]]; // prettier-ignore
const browser = await playwright().chromium.launch();
const { context, page, errors } = await openPage(browser, {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
  locale: 'en-GB',
  timezoneId: 'Europe/Amsterdam',
});
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
await context.route(`${base}/api/**`, async r => {
  const path = new URL(r.request().url()).pathname;
  if (path === '/api/org') return r.fulfill({ response: await r.fetch({ url: `${base}/mock/org.json` }) });
  if (path === '/api/requests') return r.fulfill({ json: cards });
  if (path === '/api/requests/archive')
    return r.fulfill({ json: { cards: [archived, heldCard, objected], more: false, total: 3 } });
  if (path === '/api/gazette') return r.fulfill({ json: [] }); // (HQ's boot waits for it)
  if (path === '/api/callouts/number') {
    posted.push({ path, id: Number(new URL(r.request().url()).searchParams.get('id')) });
    const [status, json] = numbers.shift();
    return r.fulfill({ status, json });
  }
  if (path.startsWith('/api/callouts/') || path === '/api/requests/answer') {
    posted.push({ path, ...r.request().postDataJSON() });
    const [status, json] = path === '/api/callouts/approve' ? approvals.shift() : [200, { ok: true }];
    if (status === 200) cards = cards.filter(c => c.id !== posted.at(-1).id);
    return r.fulfill({ status, json });
  }
  return r.fulfill({ status: 404, body: '' });
});
const msg = text => page.waitForFunction(t => document.querySelector('#answer-msg')?.textContent === t, text);
const title = text => page.waitForFunction(t => document.querySelector('.req h3')?.textContent === t, text);
const poll = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
await page.goto(`${base}/?intro=0&open=phone`);
await page.waitForSelector('#call-go');

// a phone call: who, about, the number's last digits, the language, when; the fixed opening's hint; no answer box, mic or
// pictures, and the whole number nowhere on the page
const rows = async () => (await page.locator('.req .mailto').innerText()).replace(/\s+/g, ' ');
assert.equal(
  await rows(),
  'Who Juno calls Print API About our parcel Number Ending 123Show, then types dial-in digits Language English ' +
    'When As soon as you say Call, only within calling hours (Mon–Fri 09:00–17:00)',
);
assert.match(
  await page.textContent('.req .hint'),
  /^Juno says first that they’re an AI .* One call, never redialled\.$/,
);
assert.deepEqual(await page.locator('#answer, #answer-mic, #answer-attach').count(), 0);
assert.doesNotMatch(await page.content(), /555/);
await page.screenshot({ path: `${OUT}/callout-check-phone.png`, fullPage: true });

// Show: a call no longer to come says so; then the whole number, in place, kept nowhere on the device
await page.click('#call-show');
await msg('The number shows only while the call is still to come.');
await page.click('#call-show');
await page.waitForFunction(() => document.querySelector('#call-number')?.textContent === '+31 20 555 0123');
assert.equal(await page.locator('#call-show').count(), 0);
const kept = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
assert.doesNotMatch(kept, /555/);
await page.screenshot({ path: `${OUT}/callout-check-number.png`, fullPage: true });

// Call: a refusal says why and leaves the buttons; the next Call approves it and the card goes
await page.click('#call-go');
await msg('Outside calling hours: it calls from Monday 09:00.');
assert.equal(await page.isEnabled('#call-go'), true);
await page.click('#call-go');
await msg('Calling is approved.');

// a call room: when, on the company's clock, and no number; Don't call asks first in its own spot, then declines
await title('Meet the framing workshop');
assert.equal(
  await rows(),
  'Who Dex meets the framing workshop in a call room About the frame samples Language Dutch When Tue 20 Oct, 15:00',
);
assert.equal(await page.textContent('.req .hint'), 'You get a link to send them. It opens for one call.');
await page.screenshot({ path: `${OUT}/callout-check-room.png`, fullPage: true });
await page.click('#call-decline');
assert.equal(await page.textContent('#call-decline'), 'Tap again to decline');
assert.match(await page.textContent('#answer-msg'), /^Don’t call\? Nobody is called, and Dex hears so\.$/);
await page.waitForTimeout(600); // (a second tap within 500 ms is the same gesture's)
await page.click('#call-decline');
await msg('Declined. Nobody is called.');

// a call room's Call: the link to send on stays through a poll until Done, and Copy copies it
await title('Meet the framing workshop again');
await page.click('#call-go');
await page.waitForSelector('.call-link');
assert.equal(await page.textContent('.call-url'), LINK);
assert.equal(
  await page.textContent('.call-link .hint'),
  'Send them this link. Open now until Tue 20 Oct, 18:00, for one call.',
);
assert.equal(await page.locator('.req .hint').count(), 1);
await page.screenshot({ path: `${OUT}/callout-check-link.png`, fullPage: true });
await poll();
await page.waitForTimeout(500);
assert.equal(await page.textContent('.call-url'), LINK);
await page.click('#call-copy');
await msg('Copied: paste it into a message');
assert.equal(await page.evaluate(() => navigator.clipboard.readText()), LINK);
await page.click('#call-done');
await page.waitForSelector('.quiet');

assert.deepEqual(
  posted.map(p => [p.path, p.id]),
  [
    ['/api/callouts/number', 31],
    ['/api/callouts/number', 31],
    ['/api/callouts/approve', 31],
    ['/api/callouts/approve', 31],
    ['/api/callouts/decline', 32],
    ['/api/callouts/approve', 33],
  ],
);

// the archive: who and how without the number, and the answer's link copies with a tap
await page.click('[data-past]');
await page.click('[data-card="0"]');
assert.equal(
  await rows(),
  'Who Dex meets the paper mill in a call room About the frame samples Language Dutch When Tue 20 Oct, 15:00',
);
await page.click(`.said [data-copy="${LINK}"]`);
await page.waitForFunction(() => document.querySelector('.said .copy')?.classList.contains('copied'));
assert.equal(await page.evaluate(() => navigator.clipboard.readText()), LINK);
await page.evaluate(() => navigator.clipboard.writeText(''));
await page.screenshot({ path: `${OUT}/callout-check-archive.png`, fullPage: true });

// a held call in the archive: the list says it has a transcript; its card says when, the notes and who said what
await page.click('[data-list]');
assert.match(await page.textContent('[data-card="1"] .has'), /^transcript$/);
assert.equal(await page.locator('[data-card="0"] .has, [data-card="2"] .has').count(), 0);
await page.click('[data-card="1"]');
assert.match(await rows(), /Held Mon 19 Oct, 14:06, 4 min$/);
assert.equal(await page.textContent('.call-held ul'), 'Print API answers by email today.');
assert.equal(await page.textContent('.transcript summary'), 'Transcript · 3 lines');
assert.deepEqual(await page.locator('.transcript p b').allTextContents(), ['Print API', 'Juno']);
assert.equal(await page.textContent('.transcript p:last-child'), '(Juno ended the call.)');
await page.screenshot({ path: `${OUT}/callout-check-held.png`, fullPage: true });
// they'd rather we kept no transcript: the notes only, and it says so
await page.click('[data-step="1"]');
assert.equal(await page.textContent('.call-held ul'), 'Print API answers by email today.');
assert.equal(await page.locator('.transcript').count(), 0);
assert.equal(
  await page.textContent('.call-held .hint'),
  'They’d rather we kept no transcript, so there is none: only Juno’s notes.',
);

assert.deepEqual(errors, []);
await browser.close();
server.close();
console.log('callout-check: ok');
