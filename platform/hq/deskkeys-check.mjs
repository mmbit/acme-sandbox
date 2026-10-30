#!/usr/bin/env node
// The desk phone's keys and their room, in every look (the board's notes, job #7921). A card's row of answers lights one
// key at most (the one to press), and so do an email card's and an Approve card's. In Slate no key in
// a row is wider than its words and its padding (but for a phone's lone key across the row), and a row of three stays
// one line. In every look no key is narrower than its words (the board's note #493: Approve's clipped on a desktop
// window, where the phone is as narrow as on a phone).
// The phone's header keys stand a gap apart and clear of its edge, an app's line keeps its arrow off its end, the pager
// is one even row (a lone card's has no dead arrows), and Later's days stand a gap apart inside their box's padding, Pick
// a day written out like the others, with room under the box. On a phone (Pixel 7), a tablet and a desktop window (the
// board's, 1278×1304), in Brownstone, Holodeck and Slate (Oat and Night).
//   node platform/hq/deskkeys-check.mjs [--look wire|wire-night|brownstone|holo]… [--size phone|tablet|desktop]…
//                                       [--shots <dir>]
//                                       [--tree <checkout>]
// --tree serves another checkout's HQ (main's, for before pictures; its failures are reported, not thrown). On the shared
// machine a look that crashes Chromium ('Target crashed') runs alone with --look.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serve } from './serve.mjs';
import { playwright, openPage, tap } from '../../shared/browser/browser.mjs'; // (tap: Holodeck's scene never holds still)

const { chromium, devices } = playwright();
const args = process.argv.slice(2),
  arg = k => args.flatMap((a, i) => (a === k ? [args[i + 1]] : []));
const SHOTS = arg('--shots')[0],
  TREE = arg('--tree')[0];
const SIZES = {
  phone: devices['Pixel 7'],
  tablet: devices['iPad Mini'],
  desktop: { viewport: { width: 1278, height: 1304 }, deviceScaleFactor: 1 },
};
// (a look, the renderer it is and Slate's colourway)
const LOOKS = {
  brownstone: ['brownstone'],
  holo: ['holo'],
  wire: ['wire', 'oat'],
  'wire-night': ['wire', 'night'],
};
const runs = (arg('--look').length ? arg('--look') : Object.keys(LOOKS)).flatMap(look =>
  (arg('--size').length ? arg('--size') : Object.keys(SIZES)).map(size => [look, size]),
);
// Each look's accents, the colours a key to press wears (brownstone's gold and green, Holodeck's cyan, Slate's accent)
const ACCENTS = { brownstone: ['--gold', '--green'], holo: ['--cy'], wire: ['--key-on-bg', '--green'] };
const SLACK = 3; // (px a measure may be off by: rounding, a border)

const NOW = Date.parse('2026-10-22T09:30:00Z');
const ago = m => new Date(NOW - m * 60_000).toISOString();
const card = (id, more) => ({ id, created: ago(id), agent: 'wren', kind: 'decision', urgency: 'today', ...more });
const CARDS = {
  back: [
    card(1, {
      title: 'The shop front, good now?',
      body: 'Both of your notes on the shop front are fixed.',
      back: true,
    }),
  ],
  mail: [
    card(2, {
      kind: 'mail',
      title: 'Our transfer assessment',
      body: 'They asked for it.',
      mail: {
        id: 4,
        to: ['legal@partner.example'],
        from: 'hello@testco.example',
        subject: 'Our transfer assessment',
        text: 'Dear legal team,\n\nHere it is.\n\nKind regards,',
        status: 'open',
        signoff: 'Ada Board\nTestco',
        name: 'Ada Board',
        ready: true,
      },
    }),
  ],
  approve: [
    card(3, {
      title: 'Let Wren buy the domain?',
      body: 'It costs 12 a year.',
      approves: true,
      grants: 'Buys testco.example.com',
    }),
  ],
  // (two, for the pager's arrows)
  two: [
    card(5, { title: 'A new bench for the garden?', body: 'About the bench.' }),
    card(6, { title: 'Blue or green for the sign?', body: 'About the sign.' }),
  ],
};
const server = await serve(TREE ? p => readFile(join(TREE, p)) : undefined),
  base = `http://localhost:${server.address().port}`;
const [org, brand] = await Promise.all(['org', 'brand'].map(async f => (await fetch(`${base}/mock/${f}.json`)).json()));
const failures = [];
for (const [look, size] of runs) {
  const browser = await chromium.launch();
  try {
    await checkIn(browser, look, size);
    console.log(`deskkeys-check ${look} ${size}: one key lit a row, keys their words' size, the phone's room even`);
  } catch (err) {
    failures.push(`${look} ${size}`);
    console.error(`deskkeys-check ${look} ${size}: ${err.message}`);
  } finally {
    await browser.close();
  }
}
server.close();
if (failures.length) console.error(`deskkeys-check: failed in ${failures.join(', ')}`);
process.exit(failures.length && !TREE ? 1 : 0);

async function checkIn(browser, look, size) {
  const [renderer, colourway] = LOOKS[look];
  let list = [];
  const { context, page, errors } = await openPage(browser, {
    ...SIZES[size],
    deviceScaleFactor: SHOTS ? SIZES[size].deviceScaleFactor : 1,
  });
  page.setDefaultTimeout(90_000);
  await context.clock.setFixedTime(NOW);
  if (colourway)
    await context.addInitScript(w => localStorage.setItem('hq.wire.colourway', JSON.stringify(w)), colourway);
  await context.route(`${base}/api/**`, async r => {
    const path = new URL(r.request().url()).pathname;
    // (the company runs Care, so its line shows over the cards)
    if (path === '/api/brand') return r.fulfill({ json: { ...brand, care: true } });
    if (path === '/api/org') return r.fulfill({ json: org });
    if (path === '/api/requests') return r.fulfill({ json: list });
    if (path === '/api/care/count') return r.fulfill({ json: { replies: 1 } });
    if (path === '/api/requests/later' && r.request().method() === 'GET') return r.fulfill({ json: [] });
    if (path === '/api/seen') return r.fulfill({ json: {} });
    if (['/api/gazette', '/api/mail', '/api/review/shares', '/api/review/recent'].includes(path))
      return r.fulfill({ json: [] });
    return r.fulfill({ status: 404, body: '' });
  });
  const named = name => join(SHOTS, `${look}-${size}-${name}.png`);
  // (by the device's box: Holodeck's glow never holds still for a locator's own screenshot)
  const shot = async (name, selector = '#tool .device') =>
    SHOTS &&
    (await page.screenshot({
      path: named(name),
      clip: await page.locator(selector).first().boundingBox(),
      animations: 'disabled',
    }));
  const phoneOn = async cards => {
    list = cards;
    await page.evaluate(() => import('/shell/desk.js').then(m => m.refreshRequests()));
    await page.evaluate(() => import('/shell/desk.js').then(m => m.openPhone()));
    await page.waitForFunction(t => document.querySelector('#phone-screen .req h3')?.textContent === t, cards[0].title);
    await page.waitForTimeout(400); // (a key's drop in)
  };

  await page.goto(`${base}/?intro=0&renderer=${renderer}`);
  await page.waitForSelector('#loading.gone');
  // (each accent as the page computes a colour, to hold a key's face against)
  const lit = await page.evaluate(names => {
    const probe = document.body.appendChild(document.createElement('i'));
    const colours = names.map(n => {
      probe.style.backgroundColor = `var(${n})`;
      return getComputedStyle(probe).backgroundColor;
    });
    probe.remove();
    return colours;
  }, ACCENTS[renderer]);
  const problems = [];
  const expect = (fn, what) => {
    try {
      fn();
    } catch (err) {
      problems.push(`${what}: ${err.message.split('\n')[0]}`);
    }
  };

  // ---- a card brought back for a look: Good now lit, Add notes plain, with Care's line over it
  await phoneOn(CARDS.back);
  await page.waitForSelector('#phone-screen > .app-line');
  const back = await rowOf(page, '.req .btns', lit);
  expect(() => assert.deepEqual(back.lit, ['Good now']), 'a card brought back lights Good now alone');
  expect(() => keysTheirSize(back, size, renderer), 'a card brought back');
  const head = await page.evaluate(() => {
    const device = document.querySelector('#tool .device').getBoundingClientRect();
    const [past, x] = ['.device header .past-btn', '.device header .x'].map(s =>
      document.querySelector(s).getBoundingClientRect(),
    );
    const line = document.querySelector('#phone-screen > .app-line'),
      arrow = line.querySelector('i').getBoundingClientRect();
    return {
      between: x.left - past.right,
      edge: device.right - x.right,
      arrow: line.getBoundingClientRect().right - arrow.right,
    };
  });
  expect(() => assert.ok(head.between >= 8, `Answered and × ${head.between} px apart`), "the header's keys");
  expect(() => assert.ok(head.edge >= 12, `× ${head.edge} px from the edge`), "the header's keys");
  expect(() => assert.ok(head.arrow >= 12, `› ${head.arrow} px from its end`), "an app's line");
  const lone = await pagerOf(page);
  expect(() => assert.deepEqual(lone.words, ['1 of 1', 'Later']), "a lone card's pager has no dead arrows");
  expect(() => evenGaps(lone.gaps), "a lone card's pager");
  await shot('back');

  // ---- Later opened: its days a gap apart, inside the box, Pick a day written out, the card a gap under it
  await tap(page, '[data-later]');
  await page.waitForSelector('.later-pick');
  const pick = await page.evaluate(() => {
    const box = document.querySelector('.later-pick'),
      r = box.getBoundingClientRect(),
      days = [...box.querySelectorAll('.days > *')].map(d => d.getBoundingClientRect());
    const pickDay = box.querySelector('.pick-day');
    const field = pickDay.querySelector('input');
    const next = box.nextElementSibling.getBoundingClientRect();
    return {
      inside: Math.min(...days.map(d => Math.min(d.left - r.left, r.right - d.right, r.bottom - d.bottom))),
      across: days[1].left - days[0].right,
      down: days[2].top - days[0].bottom,
      under: next.top - r.bottom,
      words: pickDay.innerText.replace(/\s+/g, ' ').trim(),
      field:
        field.type === 'date' && getComputedStyle(field).opacity !== '0' && field.getBoundingClientRect().width > 0,
      offs: [...box.querySelectorAll('.days > *')].map(d => d.scrollWidth > d.clientWidth),
    };
  });
  expect(() => assert.ok(pick.inside >= 10, `a day ${pick.inside} px from the box's side`), "Later's days");
  expect(
    () =>
      assert.ok(
        pick.across >= 10 && Math.abs(pick.across - pick.down) <= 1,
        `${pick.across} px across, ${pick.down} down`,
      ),
    "Later's days a gap apart",
  );
  expect(() => assert.ok(pick.under >= 10, `${pick.under} px under the box`), "the card under Later's days");
  expect(() => assert.match(pick.words, /^Pick a day \S/), 'Pick a day says a day');
  expect(() => assert.ok(!pick.field, 'the bare date field shows'), 'Pick a day');
  expect(() => assert.deepEqual(pick.offs, [false, false, false, false]), "Later's days' words fit");
  await shot('later');
  await tap(page, '[data-later]');

  // ---- two cards: the arrows, Later and the count an even row
  await phoneOn(CARDS.two);
  const pager = await pagerOf(page);
  expect(() => assert.deepEqual(pager.words, ['‹', '1 of 2', '›', 'Later']), 'the pager of two');
  expect(() => evenGaps(pager.gaps), 'the pager of two');

  // ---- an email card: Send email lit, Discard plain
  await phoneOn(CARDS.mail);
  const mail = await rowOf(page, '.req .btns', lit);
  expect(() => assert.deepEqual(mail.lit, ['Send email']), 'an email card lights Send email alone');
  expect(() => keysTheirSize(mail, size, renderer), 'an email card');
  await page.locator('.req .btns').scrollIntoViewIfNeeded();
  await shot('mail');

  // ---- Approve and Not now
  await phoneOn(CARDS.approve);
  const approve = await rowOf(page, '.req .btns', lit);
  expect(() => assert.deepEqual(approve.lit, ['Approve']), 'an Approve card lights Approve alone');
  expect(() => keysTheirSize(approve, size, renderer), 'an Approve card');
  await page.locator('.req .btns').scrollIntoViewIfNeeded();
  await shot('approve');

  expect(() => assert.deepEqual(errors, [], errors.join(' | ')), 'no errors');
  await context.close();
  if (problems.length) throw new Error(problems.join('; '));
}

// A row's keys: their words, which are lit (their face in one of the look's accents), each one's width against its words'
// and padding's, whether it is the row's only key and how many lines the row takes
function rowOf(page, row, lit) {
  return page.evaluate(
    ([selector, accents]) => {
      const keys = [...document.querySelector(selector).querySelectorAll(':scope > button')].filter(
        b => b.offsetWidth && !b.hidden,
      );
      const sized = keys.map(b => {
        const r = b.getBoundingClientRect(),
          kept = b.style.cssText;
        b.style.setProperty('flex', 'none', 'important');
        b.style.setProperty('width', 'max-content', 'important');
        b.style.setProperty('min-width', '0', 'important');
        const own = b.getBoundingClientRect().width;
        b.style.cssText = kept;
        return { words: b.innerText.trim() || b.id, width: r.width, own, square: Math.abs(r.width - r.height) <= 4 };
      });
      const lines = new Set(keys.map(b => Math.round(b.getBoundingClientRect().top)));
      return {
        keys: sized,
        room: Math.round(document.querySelector(selector).clientWidth),
        lone: keys.length === 1,
        lines: lines.size,
        lit: keys.filter(b => accents.includes(getComputedStyle(b).backgroundColor)).map(b => b.innerText.trim()),
      };
    },
    [row, lit],
  );
}
// (no key narrower than its words in any look; the rest in Slate, the design system's look: Brownstone's and Holodeck's
// answers share their row out, as they did)
function keysTheirSize(row, size, renderer) {
  for (const k of row.keys)
    assert.ok(
      k.width >= k.own - SLACK,
      `${k.words || 'a key'} is ${Math.round(k.width)} px for ${Math.round(k.own)} px of words`,
    );
  if (renderer !== 'wire') return;
  const keys = row.keys.map(k => `${k.words} ${Math.round(k.width)}`).join(', ');
  // (up to three keys: a fourth, a picture's on an Approve card, may take the next line on a phone, as keys wrap whole)
  if (row.keys.length <= 3) assert.equal(row.lines, 1, `${keys} on ${row.lines} lines in ${row.room} px`);
  for (const k of row.keys) {
    if (k.square || (row.lone && size === 'phone')) continue;
    assert.ok(
      k.width <= k.own + SLACK,
      `${k.words || 'a key'} is ${Math.round(k.width)} px for ${Math.round(k.own)} px of words`,
    );
  }
}

// The pager's parts in a row: their words and the gaps between them
function pagerOf(page) {
  return page.evaluate(() => {
    const parts = [...document.querySelectorAll('#phone-screen .pager > *')].filter(p => p.offsetWidth);
    const rects = parts.map(p => p.getBoundingClientRect());
    return {
      words: parts.map(p => p.innerText.trim()),
      gaps: rects.slice(1).map((r, i) => Math.round(r.left - rects[i].right)),
    };
  });
}
function evenGaps(gaps) {
  assert.ok(
    gaps.length && Math.max(...gaps) - Math.min(...gaps) <= 1 && Math.min(...gaps) >= 8,
    `gaps ${gaps.join(', ')}`,
  );
}
