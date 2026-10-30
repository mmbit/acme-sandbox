#!/usr/bin/env node
// The intake's end in the CEO's chat, in each look (Slate, Brownstone, Holodeck), at a tablet's size with the intercom
// larger and a stand-in /api playing the CEO. What runs by itself comes as a card of switches with the CEO's picks set;
// the board flips two and types a line, and the one Send sends the switches as they stand with the words after them,
// folding the card. The CEO's last question has the manual's ask keys under it: a key starts the board's sentence, another
// key's start replaces it, and the keys go once the board answers. With a folder, it saves the two moments per look.
//   node platform/hq/intake-check.mjs [screenshot-folder]
import assert from 'node:assert/strict';
import { serve } from './serve.mjs';
import { playwright, openPage, until } from '../../shared/browser/browser.mjs';
import { ASKS } from './shell/tips.js';
import { lookNames } from './looks.mjs';
import { notebookPlay } from './shell/ink/notebookplay.js';

const { chromium } = playwright();
const server = await serve(),
  base = `http://localhost:${server.address().port}`;
const LOOKS = lookNames();
const shots = process.argv[2];
// The card as hq intake sets it (the coordinator's chat.ts card)
const switches = {
  kind: 'switches',
  title: 'What runs by itself',
  says: 'Runs by itself',
  none: 'Nothing runs by itself for now.',
  note: 'Each one spends some of the seats’ time. You can change them later in Settings.',
  switches: [
    {
      name: 'Care',
      what: 'Answers customers in a chat on your sites, by email and on a phone line. Needs a mail service, and the phone a number',
      on: true,
    },
    {
      name: 'The morning round',
      said: 'the morning round',
      what: 'A short read on what happened overnight, every morning at 8',
      on: true,
    },
    {
      name: 'Security check',
      said: 'the security check',
      what: 'Looks for known holes in what we use, once a week',
      on: true,
    },
    {
      name: 'Photo studio',
      said: 'the photo studio',
      what: 'Edits product photos you take into shop pictures',
      on: false,
    },
    { name: 'Seat warning', said: 'the seat warning', what: 'A push when an AI seat is about to run low', on: false },
  ],
};
// The CEO's next reply to each line the board sends
const REPLIES = [
  {
    text: 'Here’s what we settled: we make games that click, in pixel art, for kids and their parents. Care, the morning round and the photo studio run by themselves. Anything to change?',
  },
  {
    text: 'Good. The plan comes to your desk phone as a deck in a few minutes. One more thing: is there anything else you’d like me to research or set up? People often start with one of these.',
    card: { kind: 'asks' },
  },
  { text: 'On it.' },
];

// What the rest of HQ reads as it boots, answered quietly: the intercom is all this check looks at. The Notebook's
// routes go to its store played in memory, as dev mode's (notebookplay.js), and the work piles are the mock's
const BOOT = {
  '/api/review/products': [],
  '/api/requests/later': [],
  '/api/notebooks/open': { forms: [], questions: [] },
  '/api/pictures/waiting': { pictures: [] },
  '/api/work/piles': (await (await fetch(`${base}/mock/work.json`)).json()).piles,
  '/api/room': { line: null },
  '/api/language': { lang: 'en' },
};

const browser = await chromium.launch();
for (const look of LOOKS) await checkLook(look);
await browser.close();
server.close();
console.log('intake-check: passed in', LOOKS.join(', '));

async function checkLook(look) {
  const { context, page, errors } = await openPage(browser, {
    viewport: { width: 1180, height: 820 },
    deviceScaleFactor: 1.5,
    hasTouch: true,
  });
  await context.addInitScript(() => {
    localStorage.setItem('hq.sound', 'false');
    localStorage.setItem('hq.intercomSize', 'large');
  });
  const ceo = (await (await fetch(`${base}/mock/org.json`)).json()).company.ceo;
  const line = (who, text, card) => ({
    id: messages.length + 1,
    ts: new Date().toISOString(),
    who,
    text,
    ...(card ? { card } : {}),
  });
  const messages = [];
  messages.push(line('board', 'Mostly people who already play our games, I think. Kids and their parents.'));
  messages.push(
    line(
      ceo,
      'Then care matters early: parents ask about purchases. Last part: what should run by itself? I’ve set what I’d pick. Flip anything, then send.',
      switches,
    ),
  );
  const sent = [],
    notebook = notebookPlay();
  await context.route(`${base}/api/**`, async r => {
    const url = new URL(r.request().url()),
      path = url.pathname;
    if (path === '/api/chat' && r.request().method() === 'POST') {
      sent.push(r.request().postDataJSON().text);
      messages.push(line('board', sent.at(-1)));
      const reply = REPLIES[sent.length - 1];
      messages.push(line(ceo, reply.text, reply.card));
    }
    if (path === '/api/chat') return r.fulfill({ json: { messages, thinking: false, welcome: false } });
    if (path === '/api/org') return r.fulfill({ json: await (await r.fetch({ url: `${base}/mock/org.json` })).json() });
    if (path === '/api/tips') return r.fulfill({ json: { off: false } });
    if (path === '/api/book') return r.fulfill({ json: { day: null, today: null, days: [], pages: [] } }); // (the board's book, empty)
    const mocked = await r.fetch({ url: `${base}/mock${path.slice(4)}.json` });
    if (mocked.ok()) return r.fulfill({ response: mocked });
    if (path in BOOT) return r.fulfill({ json: BOOT[path] });
    if (path.startsWith('/api/notebooks'))
      return r.fulfill({ json: notebook.route(path, url.searchParams, r.request().postDataJSON() ?? undefined) });
    if (path === '/api/events') return r.fulfill({ body: 'retry: 600000\n\n', contentType: 'text/event-stream' }); // (no events)
    return r.fulfill({ status: 404, body: '' });
  });
  await page.goto(`${base}/?renderer=${look}&intro=0&hour=11&weather=clear`);
  await until(page, '#loading.gone');
  await page.click('#btn-intercom');

  // the switches card, the CEO's picks set
  await page.waitForSelector('#chat .intake.switches');
  const states = () =>
    page.$$eval('#chat .intake [data-sw]', l => l.map(b => b.getAttribute('aria-checked') === 'true'));
  assert.deepEqual(
    await states(),
    switches.switches.map(s => s.on),
    `${look}: the CEO's picks are set`,
  );
  assert.equal(await page.$$eval('#chat .intake button:not(.switch)', l => l.length), 0, `${look}: no key of its own`);
  await page.waitForTimeout(400);
  if (shots) await page.screenshot({ path: `${shots}/intake-${look}-switches.png` });

  // flipped, and a repaint keeps them; the one Send sends them as they stand, the typed words after
  await page.click('#chat .intake [data-sw="2"]');
  await page.click('#chat .intake [data-sw="3"]');
  await page.waitForTimeout(3500); // (a poll's repaint)
  assert.deepEqual(await states(), [true, true, false, true, false], `${look}: the flips stay`);
  await page.fill('#dir-title', 'The phone line can wait.');
  await page.click('#dir-send');
  await page.waitForFunction(n => document.querySelectorAll('#chat li.ceo.prose').length === n, 2);
  assert.deepEqual(
    sent,
    ['Runs by itself: Care, the morning round, the photo studio.\n\nThe phone line can wait.'],
    `${look}: the switches as they stand, then the words`,
  );
  assert.equal(await page.$('#chat .intake'), null, `${look}: the card folds into the board's line`);

  // the last question, its keys under it
  await page.fill('#dir-title', 'No, that’s right.');
  await page.click('#dir-send');
  await page.waitForSelector('#chat .intake.asks');
  assert.equal(sent.at(-1), 'No, that’s right.', `${look}: an ordinary line once the card is sent`);
  assert.deepEqual(
    await page.$$eval('#chat .intake.asks button', l => l.map(b => b.textContent)),
    ASKS.map(a => a.key),
    `${look}: the manual's ask keys`,
  );
  await page.waitForTimeout(400);
  if (shots) await page.screenshot({ path: `${shots}/intake-${look}-asks.png` });
  await page.click('#chat .intake [data-ask="1"]');
  assert.equal(await page.inputValue('#dir-title'), ASKS[1].starts, `${look}: a key starts the sentence`);
  await page.click('#chat .intake [data-ask="0"]');
  assert.equal(await page.inputValue('#dir-title'), ASKS[0].starts, `${look}: another key's start replaces it`);
  await page.keyboard.type('reads the reviews every Friday');
  await page.click('#dir-send');
  await page.waitForFunction(() => !document.querySelector('#chat .intake'));
  assert.equal(sent.at(-1), `${ASKS[0].starts}reads the reviews every Friday`, `${look}: the board's first request`);

  assert.deepEqual(errors, [], `${look}: no page errors`);
  await context.close();
  console.log(`intake-check: ${look}`);
}
