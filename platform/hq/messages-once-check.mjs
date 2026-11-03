#!/usr/bin/env node
// A message arrives once: in Slate (renderer wire) an agent's message to another and the CEO's to the intercom each fly
// from key to key and land with one sound, and the feed's replay of its latest events every time it connects again
// (a deploy, a tablet waking) never sends them again. On the intercom, a poll asked before the board's line went that
// answers after it, without it, doesn't chime the CEO's reply before it a second time. A CEO reply while the intercom
// is open flies and chimes, one sound between them, in Brownstone's plane and the Holodeck's flight too. With a stand-in /api whose event
// feed ends after each answer, so the browser connects again a second later, as often as the check waits.
//   node platform/hq/messages-once-check.mjs
import assert from 'node:assert/strict';
import { serve, ROOT } from './serve.mjs';
import { playwright, openPage, until } from '../../shared/browser/browser.mjs';

// (the foundation's stand-in company, with a CEO and colleagues to message: the company's own may have only its CEO)
const ORG = `${ROOT}/platform/hq/mock/org.json`;
const server = await serve(),
  base = `http://localhost:${server.address().port}`;
const browser = await playwright().chromium.launch();
const { context, page, errors } = await openPage(browser, { viewport: { width: 1280, height: 860 } });
page.setDefaultTimeout(90_000);

// what the page plays and flies: every source started (a sample of the sound kit, a look's tone or noise: audio.js),
// every slip. A sound is its sources together, a look's layers starting within a few milliseconds: sounds(from) counts
// those since the from-th source. (A loop is a bed under them, the rain's, never a sound arriving.)
await context.addInitScript(() => {
  window.heard = [];
  window.sounds = from => window.heard.slice(from).filter((t, i, h) => !i || t - h[i - 1] > 80).length;
  window.slips = [];
  for (const Node of [AudioBufferSourceNode, OscillatorNode]) {
    const start = Node.prototype.start;
    Node.prototype.start = function (...a) {
      if (!this.loop) window.heard.push(performance.now());
      return start.apply(this, a);
    };
  }
  new MutationObserver(ms => {
    for (const m of ms)
      for (const n of m.addedNodes) if (n.classList?.contains('slip')) window.slips.push(n.textContent);
  }).observe(document, { childList: true, subtree: true });
});

// The feed as the coordinator gives it (events.ts subscribe): its latest events, marked history, then who's at work;
// the first two connections then bring the two messages live, one each (a second apart: two sounds landing together
// would count as one), each later one replays them with the rest. queued: what the next connection brings live.
const old = { type: 'chat', agent: 'rook', to: 'nib', text: 'Your diff drops the null check.' };
const said = [
  { type: 'chat', agent: 'wren', to: 'moss', text: 'Can the duck idea get a logo?' },
  { type: 'chat', agent: 'juno', to: 'board', text: 'The weekly plan is ready.' },
];
const line = e => `data: ${JSON.stringify({ ts: new Date().toISOString(), ...e })}\n\n`;
const sent = [old],
  queued = [said[0]];
let connections = 0,
  unlocked,
  tapped = new Promise(r => (unlocked = r));
const chat = [{ id: 1, ts: new Date().toISOString(), who: 'juno', text: 'Morning: the plan is on your desk.' }];
// holdNextPoll: the next poll of the conversation waits. heldPoll: that poll once it's waiting, until the board's line
// went: { release, messages: what it had when asked }
let holdNextPoll = false,
  heldPoll = null;
await context.route(`${base}/api/**`, async r => {
  const path = new URL(r.request().url()).pathname,
    method = r.request().method();
  if (path === '/api/org') return r.fulfill({ path: ORG });
  if (path === '/api/events') {
    if (++connections === 1) await tapped; // (the sound on first: a tap unlocks it)
    const history = sent.map(e => line({ ...e, history: true })).join(''),
      live = queued.splice(0);
    sent.push(...live);
    return r.fulfill({
      contentType: 'text/event-stream',
      body: `retry: 1000\n\n${history}${line({ type: 'statuses', statuses: {} })}${live.map(line).join('')}`,
    });
  }
  if (path === '/api/chat' && method === 'GET') {
    if (holdNextPoll) {
      holdNextPoll = false;
      const messages = structuredClone(chat);
      await new Promise(release => (heldPoll = { release, messages }));
      return r.fulfill({ json: { messages, thinking: false } });
    }
    return r.fulfill({ json: { messages: chat, thinking: false } });
  }
  if (path === '/api/chat') {
    chat.push({
      id: chat.length + 1,
      ts: new Date().toISOString(),
      who: 'board',
      text: r.request().postDataJSON().text,
    });
    return r.fulfill({ json: { messages: chat, thinking: true } });
  }
  if (path === '/api/seen') return r.fulfill({ json: {} });
  if (['/api/gazette', '/api/mail', '/api/requests', '/api/review/products', '/api/requests/later'].includes(path))
    return r.fulfill({ json: [] });
  return r.fulfill({ status: 404, body: '' });
});

await page.goto(`${base}/?renderer=wire&intro=0&weather=clear`); // (dry: rain taps the glass now and then)
await until(page, '#loading.gone');
// a tap starts HQ's sound (audio.js unlock), on the page's edge, where nothing answers it
await page.mouse.click(2, 430);
await page.waitForFunction(() => import('/shell/audio.js').then(a => a.ready()));
assert.equal(await page.evaluate(() => window.heard.length), 0, 'nothing has played yet');
unlocked();

// the two messages, then the feed connecting again four times
await page.waitForFunction(() => window.slips.length >= 1);
queued.push(said[1]);
await page.waitForFunction(() => window.slips.length >= 2);
const first = connections;
while (connections < first + 4) await page.waitForTimeout(250);
await page.waitForTimeout(2500); // (a slip in the air lands: under 2 s)
const flown = await page.evaluate(() => ({ slips: window.slips, sounds: window.sounds(0) }));
assert.deepEqual(
  flown.slips,
  said.map(e => e.text),
  `each message flies once, the old one never, over ${connections} connections`,
);
assert.equal(flown.sounds, 2, 'each lands with one sound');

// The intercom: the board's line goes while a poll asked before it is still out, which then answers without it
await page.evaluate(() => import('/shell/desk.js').then(m => m.openIntercom()));
await page.waitForSelector('#chat:not([aria-busy]) [data-m]');
holdNextPoll = true;
while (!heldPoll) await page.waitForTimeout(100);
const before = await page.evaluate(() => window.heard.length);
await page.fill('#dir-title', 'Thanks, reading it now.');
await page.click('#dir-send');
await page.waitForSelector('#chat .me');
heldPoll.release();
await page.waitForTimeout(3500); // (the held poll answers, then the next one)
const intercom = await page.evaluate(
  from => ({
    sounds: window.sounds(from),
    lines: [...document.querySelectorAll('#chat [data-m]')].map(l => l.textContent),
  }),
  before,
);
assert.equal(intercom.sounds, 1, 'the board’s line has its one sound, and the CEO’s reply before it no other');
assert.deepEqual(
  intercom.lines,
  chat.map(m => m.text),
  'the line stays shown',
);

// A CEO reply while the intercom is open: the feed brings it live (chat.ts publishes each) and the next poll shows it
const reply = { type: 'chat', agent: 'juno', to: 'board', text: 'Glad it helps.' };
const [heardBefore, flownBefore] = await page.evaluate(() => [window.heard.length, window.slips.length]);
chat.push({ id: chat.length + 1, ts: new Date().toISOString(), who: reply.agent, text: reply.text });
queued.push(reply);
await page.waitForFunction(n => window.slips.length > n, flownBefore);
await page.waitForFunction(
  text => [...document.querySelectorAll('#chat .ceo')].some(l => l.textContent === text),
  reply.text,
);
await page.waitForTimeout(2500); // (its slip lands)
assert.equal(
  await page.evaluate(from => window.sounds(from), heardBefore),
  1,
  'the CEO’s reply flies and chimes, one sound',
);

// The same in Brownstone, whose plane flies to the board's room, and the Holodeck, whose flight goes to its core: the
// ding is the reply's one sound, the landing as silent as the send. (At night: Brownstone's birds sing by day.)
for (const look of ['brownstone', 'holo']) {
  await page.goto(`${base}/?renderer=${look}&intro=0&hour=1&weather=clear`);
  await until(page, '#loading.gone');
  await page.mouse.click(2, 430);
  await page.waitForFunction(() => import('/shell/audio.js').then(a => a.ready()));
  await page.evaluate(() => import('/shell/desk.js').then(m => m.openIntercom()));
  await page.waitForSelector('#chat:not([aria-busy]) [data-m]');
  await page.waitForTimeout(1500); // (the intercom's opening sounds end)
  const heardBefore = await page.evaluate(() => window.heard.length);
  const text = `Done in ${look}.`;
  chat.push({ id: chat.length + 1, ts: new Date().toISOString(), who: reply.agent, text });
  queued.push({ ...reply, text });
  await page.waitForFunction(t => [...document.querySelectorAll('#chat .ceo')].some(l => l.textContent === t), text);
  await page.waitForTimeout(4000); // (its plane or flight lands: under 3 s)
  assert.equal(
    await page.evaluate(from => window.sounds(from), heardBefore),
    1,
    `in ${look}, the CEO’s reply chimes, one sound, and lands silent`,
  );
}

assert.deepEqual(errors, [], 'no page errors');

console.log(
  `messages-once-check: 2 messages flew and sounded once over ${connections} feed connections; the intercom chimed once, and once for a CEO reply while open in Slate, Brownstone and the Holodeck`,
);
await browser.close();
server.close();
