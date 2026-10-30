#!/usr/bin/env node
// The feature tips in every look HQ ships (looks.mjs), at a tablet's size with a stand-in /api: a tip card sits
// after the card that needs an answer, adds nothing to the Phone key, and has Show me and Got it, in view and with nothing
// over them on a tablet and on two short phones (where the film must give up height for them). Show me closes the
// phone, dims HQ around each real control in turn and files the tip once the last is pressed. A tip about the phone
// itself keeps the phone open on the card it's about. In the first look, every tip's Show me finds each of its real
// controls, the pin's switch in Settings and HQ's pin in review mode's layer too, and the logo's press asks for the look's tip. With a folder, it saves a
// tip and a Show me per look.
// Every tip with a film in the company's theme/hq/films (tip-films.mjs) has one in each look, 5 to 8 seconds and small
// enough for a phone, and the card plays the one for the look it's shown in (Playwright's Chromium plays no H.264: the check hands it
// a VP9 copy).
//   node platform/hq/tips-check.mjs [screenshot-folder]
import assert from 'node:assert/strict';
import { serve, ROOT } from './serve.mjs';
import { playwright, openPage, until } from '../../shared/browser/browser.mjs';
import { readFile, mkdtemp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lookNames } from './looks.mjs';
import { notebookPlay } from './shell/ink/notebookplay.js';
import { notebookRoute } from './notebookroute.mjs';
import { filmFiles } from './films/listing.mjs';
import { TIPS, tipOf, filmName } from './shell/tips.js';
import { pinOn } from './bookkit.mjs';

const { chromium } = playwright();
const server = await serve(),
  base = `http://localhost:${server.address().port}`;
const LOOKS = lookNames();
// the sample company's names for its desk phone and intercom, the foundation's
const NAMES = { phone: 'desk phone', intercom: 'intercom' };
const TABLET = { width: 1180, height: 820 },
  PHONES = [
    { width: 375, height: 667 },
    { width: 360, height: 640 },
  ]; // (short phones: the film must give up height for the keys)
const minutesAgo = m => new Date(Date.now() - m * 60_000).toISOString();
const decision = {
  id: 3,
  created: minutesAgo(30),
  agent: 'wren',
  kind: 'decision',
  title: 'A new bench for the garden?',
  body: 'About a bench.',
  urgency: 'now', // (on a browser without notifications: their tip)
};
const REVIEW = new URL('../../shared/review/', import.meta.url);
// an open notes share with one person still to send (Reviews › Shared, End now's tip)
const share = {
  id: 1,
  kind: 'notes',
  what: 'Rocketlings',
  host: 'rocket.preview.example.com',
  prefix: '/',
  created: minutesAgo(600),
  ends: new Date(Date.now() + 3 * 86400_000).toISOString(),
  people: [
    { name: 'Ilse', address: 'i…@example.com', sent: true, notes: 6 },
    { name: 'Joris', address: 'j…@example.com' },
  ],
};
// ...listed after another, with three people still writing: End now's Show me points at its own share, never this one
const writing = {
  ...share,
  id: 2,
  what: 'Lanterns',
  host: 'lanterns.preview.example.com',
  people: ['Ada', 'Bo', 'Cas'].map(name => ({ name, address: `${name[0].toLowerCase()}…@example.com` })),
};
const tipCard = (id, key, details = {}) => ({
  id,
  created: minutesAgo(0),
  agent: null,
  kind: 'tip',
  tip: key,
  title: tipOf(key, NAMES).title,
  body: tipOf(key, NAMES).lines(details),
  details,
  urgency: 'tip',
  topic: 'Tips',
});

// every tip film the company has, in every look: its length, and its size against a phone's data
const films = filmFiles(join(ROOT, 'theme/hq')),
  filmPath = (tip, look) => join(ROOT, 'theme/hq/films', filmName(tip.key, look));
for (const tip of TIPS.filter(t => LOOKS.some(look => films.includes(filmName(t.key, look)))))
  for (const look of LOOKS) {
    const [seconds, bytes] = execFileSync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration,size',
      '-of',
      'csv=p=0',
      filmPath(tip, look),
    ])
      .toString()
      .trim()
      .split(',')
      .map(Number);
    assert.ok(seconds >= 5 && seconds <= 8.1, `${tip.key}'s film in ${look}: ${seconds} s`);
    assert.ok(bytes < 300 * 1024, `${tip.key}'s film in ${look}: ${Math.round(bytes / 1024)} KB`);
  }
const webm = await mkdtemp(join(tmpdir(), 'tips-films-'));
const playable = (tip, look) => {
  const out = join(webm, `${filmName(tip.key, look)}.webm`);
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-i',
    filmPath(tip, look),
    '-c:v',
    'libvpx-vp9',
    '-deadline',
    'realtime',
    '-cpu-used',
    '8',
    out,
  ]);
  return readFile(out);
};

const browser = await chromium.launch();
for (const look of LOOKS) await checkLook(look);
await browser.close();
server.close();
console.log('tips-check: passed in', LOOKS.join(', '));

async function checkLook(look) {
  const every = look === LOOKS[0];
  let list = [
    decision,
    tipCard(4, 'machines', { run: 'Venture sizing', minutes: 40 }),
    tipCard(5, 'deskphone'),
    ...(every
      ? TIPS.map((t, i) => tipCard(10 + i, t.key, t.key === 'endnow' ? { waiting: 'Joris', share: 1 } : {}))
      : []),
  ];
  const ended = [],
    events = [],
    // the board's notebook, where review mode's newest note is looked for (booknewest.js): the store played, one blank
    // page (notebookroute.mjs.)
    notebook = notebookPlay();
  const { context, page, errors } = await openPage(browser, {
    viewport: TABLET,
    deviceScaleFactor: 1.5,
    hasTouch: true,
  });
  // HQ's pin kept in its corner, as the board can drag it there (shared/review dock.js): it never steps up clear of a
  // card's keys, so only the desk phone's own room keeps them out from under it.
  await context.addInitScript(() => {
    localStorage.setItem('hq.sound', 'false');
    localStorage.setItem('__hq_review_pin', JSON.stringify({ left: false, up: 0 }));
  });
  await context.route(`${base}/api/**`, async r => {
    const path = new URL(r.request().url()).pathname;
    if (path === '/api/org') return r.fulfill({ json: await (await r.fetch({ url: `${base}/mock/org.json` })).json() });
    if (path === '/api/requests') return r.fulfill({ json: list });
    if (path === '/api/tips/end') {
      const { id, shown } = r.request().postDataJSON();
      ended.push({ id, shown });
      list = list.filter(x => x.id !== id);
      return r.fulfill({ json: { ok: true } });
    }
    if (path === '/api/tips') return r.fulfill({ json: { off: false } });
    if (path === '/api/tips/events')
      return (events.push(r.request().postDataJSON().key), r.fulfill({ json: { id: null } }));
    if (path === '/api/review/shares') return r.fulfill({ json: [writing, share] });
    if (path === '/api/review/recent') return r.fulfill({ json: [] });
    if (path === '/api/book/sheets') return r.fulfill({ json: { sent: [] } }); // (Reviews › Sent, empty)
    if (path === '/api/review/notes') return r.fulfill({ json: [] });
    if (path.startsWith('/api/notebooks')) return notebookRoute(r, notebook);
    if (path === '/api/book') return r.fulfill({ json: { day: null, today: null, days: [], pages: [] } }); // (the board's book, empty)
    const mocked = await r.fetch({ url: `${base}/mock${path.slice(4)}.json` });
    if (mocked.ok()) return r.fulfill({ response: mocked });
    if (path === '/api/seen') return r.fulfill({ json: {} });
    if (['/api/gazette', '/api/mail', '/api/review/products', '/api/requests/later'].includes(path))
      return r.fulfill({ json: [] });
    return r.fulfill({ status: 404, body: '' });
  });
  // HQ's pin: review mode from shared/review, with nothing to coach and no notes of the board's
  await context.route(`${base}/__review/**`, async r => {
    const name = new URL(r.request().url()).pathname.slice('/__review/'.length);
    if (name.endsWith('.js'))
      return r.fulfill({ contentType: 'text/javascript', body: await readFile(new URL(name, REVIEW)) });
    if (name === 'mine') return r.fulfill({ json: { notes: 0, list: [], sent: false, more: false } });
    return r.fulfill({ json: name === 'coach' ? { show: false } : [] });
  });
  // (the machines tip's film, as Chromium can play it, and only for this look)
  const film = await playable(tipOf('machines', NAMES), look),
    machinesFilm = `/films/${filmName('machines', look)}`;
  await context.route(`${base}/films/*.mp4`, r => {
    const ours = r.request().url().endsWith(machinesFilm);
    return r.fulfill(ours ? { contentType: 'video/webm', body: film } : { status: 404, body: '' });
  });
  await context.route('https://*.preview.example.com/**', r =>
    r.fulfill({ contentType: 'text/html', body: '<p>A preview</p>' }),
  );
  await page.goto(`${base}/?renderer=${look}&intro=0&hour=11&weather=clear`);
  await until(page, '#loading.gone');
  const shot = name => process.argv[2] && page.screenshot({ path: `${process.argv[2]}/tips-${look}-${name}.png` });

  // the tip: after the card that needs an answer, and not on the Phone key
  await page.waitForFunction(() => document.querySelector('#desk-count')?.dataset.n === '1');
  await page.evaluate(() => import('/shell/desk.js').then(m => m.openPhone(4)));
  await page.waitForSelector('#phone-screen .req.tip h3');
  assert.equal(await page.textContent('#phone-screen .req.tip h3'), 'A long run is waiting for the server');
  assert.equal(
    await page.textContent('#phone-screen .pager [data-list]'),
    `2 of ${list.length}`,
    `${look}: the tip after the card`,
  );
  assert.deepEqual(await page.$$eval('#phone-screen .req.tip .btns button', bs => bs.map(b => b.textContent)), [
    'Show me',
    'Got it',
  ]);
  await page.waitForFunction(
    () => document.querySelector('#phone-screen .req.tip .film video')?.readyState >= 2,
    null,
    {
      timeout: 10_000,
    },
  );
  assert.ok(
    await page.$eval('#phone-screen .req.tip .film video', v => !v.paused && v.muted && v.loop),
    `${look}: the tip's film plays, silent, on a loop`,
  );
  await page.waitForTimeout(500); // (the card's bounce settled)
  await shot('1-tip');
  await keysInView(page, look, 'a tablet');
  // on short phones, as the desk phone opens
  for (const phone of PHONES) {
    const size = `${phone.width}x${phone.height}`;
    await page.keyboard.press('Escape');
    await page.setViewportSize(phone);
    await page.waitForTimeout(1000); // (laid out again, and the pin settled)
    await page.evaluate(() => import('/shell/desk.js').then(m => m.openPhone(4)));
    await page.waitForSelector('#phone-screen .req.tip .film video');
    await page.waitForTimeout(500); // (the card's bounce settled)
    await shot(`1-tip-phone-${size}`);
    await keysInView(page, look, `a ${size} phone`);
  }
  await page.setViewportSize(TABLET);

  // Show me: the phone closes, and each step points at its control until it's pressed
  await page.click('[data-show-me]');
  for (const [i, at] of tipOf('machines', NAMES)
    .steps.map(s => s.at)
    .entries()) {
    await page.waitForSelector('.showme-step:not([hidden])');
    await page.waitForFunction(at => !!document.querySelector(at), at);
    await page.waitForTimeout(300);
    const [ring, control] = await page.evaluate(
      at =>
        [
          document.querySelector('.showme-ring'),
          [...document.querySelectorAll(at)].find(e => e.getBoundingClientRect().width > 0),
        ].map(e => e.getBoundingClientRect().toJSON()),
      at,
    );
    assert.ok(
      ring.left <= control.left &&
        ring.right >= control.right &&
        ring.top <= control.top &&
        ring.bottom >= control.bottom,
      `${look}: step ${i + 1}'s ring round ${at}: ${JSON.stringify([ring, control])}`,
    );
    if (i === 1) await shot('2-show-me');
    await page.click(at);
  }
  await page.waitForFunction(() => !document.querySelector('.showme-veil'));
  assert.deepEqual(ended, [{ id: 4, shown: true }], `${look}: the last press filed the tip`);

  // the phone's own tip: Show me stays on the phone, at the card it's about, and points at Later
  await page.evaluate(() => import('/shell/desk.js').then(m => m.openPhone(5)));
  await page.waitForSelector('#phone-screen .req.tip [data-show-me]');
  await page.click('[data-show-me]');
  await page.waitForSelector('.showme-step:not([hidden])');
  assert.equal(
    await page.textContent('#phone-screen h3'),
    'A new bench for the garden?',
    `${look}: on the card it's about`,
  );
  await page.click('.showme-step .got');
  await page.waitForFunction(() => !document.querySelector('.showme-veil'));
  assert.deepEqual(ended.at(-1), { id: 5, shown: false }, `${look}: Got it filed it`);
  if (every) {
    await checkEvery(page, ended, events, list);
    await checkPinOut(page, ended, cards => (list = cards));
    await checkNothingToShow(page, ended, cards => (list = cards));
  }
  assert.deepEqual(errors, [], `${look}: no page errors`);
  await context.close();
}

// Show me and Got it on the desk phone's screen as it opens, under the film, without scrolling, and nothing over them
// (HQ's pin sits in a phone's bottom right corner): what's 3 px inside a key, at its middle, its two ends, its top
// edge, along its bottom edge and on each rounded corner, is the key.
async function keysInView(page, look, device) {
  const { below, covered } = await page.$eval('#phone-screen', screen => {
    const keys = [...screen.querySelectorAll('.req.tip .btns button')];
    // what's over a key at each spot, by name
    const whatCovers = key => {
      const box = key.getBoundingClientRect(),
        radius = parseFloat(getComputedStyle(key).borderBottomRightRadius) || 0, // (a pill's is 999px)
        corner = Math.max(3, Math.min(radius, box.height / 2)),
        slant = (corner - 3) / Math.SQRT2, // (halfway round a corner's arc)
        midX = (box.left + box.right) / 2,
        midY = (box.top + box.bottom) / 2;
      const spots = [
        [midX, midY],
        [box.left + 3, midY],
        [box.right - 3, midY],
        [midX, box.top + 3],
        [box.left + corner - slant, box.top + corner - slant],
        [box.right - corner + slant, box.top + corner - slant],
        [box.left + corner - slant, box.bottom - corner + slant],
        [box.right - corner + slant, box.bottom - corner + slant],
      ];
      for (let along = box.left + corner; along < box.right - corner; along += 8) spots.push([along, box.bottom - 3]);
      spots.push([box.right - corner, box.bottom - 3]);
      return spots
        .map(([x, y]) => document.elementFromPoint(x, y))
        .filter(e => !key.contains(e))
        .map(e => `${key.textContent} under ${e?.id || e?.className || e?.tagName || 'nothing'}`);
    };
    return {
      below: Math.max(...keys.map(k => k.getBoundingClientRect().bottom)) - screen.getBoundingClientRect().bottom,
      covered: keys.flatMap(whatCovers),
    };
  });
  assert.ok(below <= 0, `${look}: on ${device}, Show me and Got it in view (${Math.ceil(below)} px below)`);
  assert.deepEqual(covered, [], `${look}: on ${device}, nothing over Show me and Got it`);
}

// Every tip's Show me, each step's ring round a real control: pressed to go on, and the last one left (it may act for
// real: End now, a call) for the step's Got it. The pin's is pressed: a press inside review mode's layer ends its tip.
async function checkEvery(page, ended, events, list) {
  await page.keyboard.press('Escape'); // (the phone's tip left the phone open)
  await page.click('#hud .brand');
  await page.waitForFunction(() => document.querySelector('.showme-veil') === null);
  assert.deepEqual(
    events,
    ['notifications', 'look'],
    "the urgent card on a device without notifications asks for their tip, the logo's press for the look's",
  );
  for (const [n, tip] of TIPS.entries()) {
    const id = 10 + n;
    if (await page.isVisible('#viewer [data-close]')) await page.click('#viewer [data-close]');
    await page.evaluate(id => import('/shell/desk.js').then(m => m.openPhone(id)), id);
    await page.waitForSelector('#phone-screen .req.tip [data-show-me]');
    await page.click('#phone-screen .req.tip [data-show-me]');
    for (const i of tip.steps.keys()) {
      await page
        .waitForSelector('.showme-step:not([hidden])', { timeout: 5000 })
        .catch(() => assert.fail(`${tip.key}: step ${i + 1} found no control`));
      await page.waitForTimeout(400);
      const { ring, control, said, onTop } = await page.evaluate(
        ([key, i, details, names]) =>
          import('/shell/tips.js').then(({ tipOf }) => {
            const at = tipOf(key, names).steps[i].at;
            const found = (typeof at === 'function' ? [at(details)] : [...document.querySelectorAll(at)]).find(
              e => e && e.getBoundingClientRect().width > 0,
            );
            const words = document.querySelector('.showme-step p'),
              w = words.getBoundingClientRect();
            return {
              ring: document.querySelector('.showme-ring').getBoundingClientRect().toJSON(),
              control: found?.getBoundingClientRect().toJSON(),
              said: words.textContent,
              // (nothing over the step's words, the book beside HQ either)
              onTop: !!document.elementFromPoint(w.x + w.width / 2, w.y + w.height / 2)?.closest('.showme-step'),
            };
          }),
        [tip.key, i, list.find(c => c.id === id).details, NAMES],
      );
      assert.ok(control, `${tip.key}: step ${i + 1}'s control is on the page`);
      assert.equal(said, tip.steps[i].say, `${tip.key}: step ${i + 1} says its words`);
      assert.ok(onTop, `${tip.key}: step ${i + 1}'s words over HQ and the book`);
      assert.ok(
        ring.left <= control.left + 1 &&
          ring.right >= control.right - 1 &&
          ring.top <= control.top + 1 &&
          ring.bottom >= control.bottom - 1,
        `${tip.key}: step ${i + 1}'s ring round its control`,
      );
      const last = i === tip.steps.length - 1,
        pin = tip.key === 'pin';
      if (!last || pin) await page.mouse.click(control.left + control.width / 2, control.top + control.height / 2);
    }
    if (tip.key !== 'pin') await page.click('.showme-step .got');
    await page.waitForFunction(() => !document.querySelector('.showme-veil'));
    assert.deepEqual(ended.at(-1), { id, shown: tip.key === 'pin' }, `${tip.key}: filed`);
    if (tip.key === 'pin') await page.keyboard.press('Escape'); // (the pin's press opened review mode for a note)
    console.log(`tips-check: ${tip.key}'s Show me, ${tip.steps.length} real control${tip.steps.length > 1 ? 's' : ''}`);
  }
}

// The pin's Show me with the pin already out (turned on for this device): only the pin's step, its switch left alone,
// so the pin it rings is there
async function checkPinOut(page, ended, setList) {
  await pinOn(page);
  const out = () => {
    const ask = new CustomEvent('review:pin', { detail: {} });
    dispatchEvent(ask);
    return !!ask.detail.pin;
  };
  await page.waitForFunction(out, null, { timeout: 5000 });
  setList([tipCard(30, 'pin')]);
  await page.evaluate(() => import('/shell/desk.js').then(m => m.openPhone(30)));
  await page.click('#phone-screen .req.tip [data-show-me]');
  await page.waitForSelector('.showme-step:not([hidden])', { timeout: 5000 });
  assert.equal(await page.textContent('.showme-step b'), 'Show me', 'pin, already out: one step');
  assert.equal(
    await page.textContent('.showme-step p'),
    tipOf('pin', NAMES).steps[1].say,
    "pin, already out: the pin's step",
  );
  assert.ok(await page.evaluate(out), 'pin, already out: still out');
  const ring = await page.$eval('.showme-ring', e => e.getBoundingClientRect().toJSON());
  await page.mouse.click(ring.left + ring.width / 2, ring.top + ring.height / 2);
  await page.waitForFunction(() => !document.querySelector('.showme-veil'));
  assert.deepEqual(ended.at(-1), { id: 30, shown: true }, 'pin, already out: pressing it filed the tip');
  await page.keyboard.press('Escape'); // (the pin's press opened review mode for a note)
  console.log("tips-check: the pin's Show me with the pin already out, one step");
}

// A tip about the phone with no card that has its control draws no Show me, and a control that isn't on screen now gets
// a step saying so: closing it leaves the tip
async function checkNothingToShow(page, ended, setList) {
  setList([tipCard(40, 'calls'), tipCard(41, 'endnow', { waiting: 'Joris', share: 3 })]);
  await page.evaluate(() => import('/shell/desk.js').then(m => m.openPhone(40)));
  await page.waitForSelector('#phone-screen .req.tip [data-got]');
  assert.equal(await page.$('#phone-screen .req.tip [data-show-me]'), null, 'calls: no card to call from, no Show me');
  await page.evaluate(() => import('/shell/desk.js').then(m => m.openPhone(41)));
  await page.click('#phone-screen .req.tip [data-show-me]');
  await page.waitForSelector('.showme-step.missing:not([hidden])', { timeout: 6000 });
  assert.match(await page.textContent('.showme-step.missing'), /isn’t on screen now/);
  const filed = ended.length;
  await page.click('.showme-step .got');
  await page.waitForFunction(() => !document.querySelector('.showme-veil'));
  assert.equal(ended.length, filed, 'endnow: closing the step leaves the tip');
  console.log("tips-check: no Show me without its card, and a missing control's step");
}
