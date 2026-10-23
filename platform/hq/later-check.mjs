#!/usr/bin/env node
// Cards for later on the desk phone: Later in the pager offers days, a pick puts
// the card aside (POST /api/requests/later) and the next screen says until when with Undo; the waiting cards' list ends
// in "n for later", whose list brings one back. On a phone, with a stand-in /api.
//   node platform/hq/later-check.mjs [screenshot-folder]
import assert from 'node:assert/strict';
import { serve } from './serve.mjs';
import { playwright, openPage, until } from '../../shared/browser/browser.mjs';

const { chromium, devices } = playwright();

const server = await serve(),
  base = `http://localhost:${server.address().port}`;
// The phone is in Los Angeles at 17:30 on Saturday 10 October, which is already 02:30 on Sunday the 11th on the company's
// clock (Amsterdam): the days it offers are the company's, as the server reads a day
const NOW = Date.parse('2026-10-11T00:30:00Z');
const ago = m => new Date(NOW - m * 60_000).toISOString();
const card = (id, title, topic) => ({
  id,
  created: ago(id),
  agent: 'wren',
  kind: 'decision',
  title,
  body: `About ${title}.`,
  urgency: 'today',
  topic,
});
let list = [card(3, 'A new bench for the garden?', 'garden'), card(4, 'Blue or green for the sign?', 'signs')];
let later = [];
const asked = [];
// a day as the phone sends it: the company's calendar day (Sunday 11 October), n days on
const dayIn = n => new Date(Date.UTC(2026, 9, 11 + n)).toISOString().slice(0, 10);

const browser = await chromium.launch();
const { context, page, errors } = await openPage(browser, { ...devices['Pixel 7'], timezoneId: 'America/Los_Angeles' });
await context.clock.setFixedTime(NOW);
await context.route(`${base}/api/**`, async r => {
  const path = new URL(r.request().url()).pathname;
  if (path === '/api/org') {
    const org = await (await r.fetch({ url: `${base}/mock/org.json` })).json();
    return r.fulfill({ json: { ...org, company: { ...org.company, timeZone: 'Europe/Amsterdam' } } });
  }
  if (path === '/api/requests') return r.fulfill({ json: list });
  if (path === '/api/requests/later' && r.request().method() === 'GET') return r.fulfill({ json: later });
  if (path === '/api/requests/later') {
    // as the server does: off the list until the day starts (saying that day on the company's clock), or back now as a
    // new card
    const { id, day } = r.request().postDataJSON();
    asked.push({ id, day });
    if (day === null) {
      const back = later.find(x => x.id === id);
      later = later.filter(x => x.id !== id);
      list = [{ ...back, changed: new Date(NOW).toISOString() }, ...list];
      return r.fulfill({ json: { ok: true, until: null } });
    }
    const until = new Date(`${day}T00:00+02:00`).toISOString();
    later = [...later, { ...list.find(x => x.id === id), hidden_until: until, day }];
    list = list.filter(x => x.id !== id);
    return r.fulfill({ json: { ok: true, until, day } });
  }
  if (path === '/api/seen') return r.fulfill({ json: {} });
  if (['/api/gazette', '/api/mail', '/api/review/products'].includes(path)) return r.fulfill({ json: [] });
  return r.fulfill({ status: 404, body: '' });
});
await page.goto(`${base}/?intro=0`);
await until(page, '#loading.gone');
const shot = name => process.argv[2] && page.screenshot({ path: `${process.argv[2]}/later-${name}.png` });
await page.evaluate(() => import('/shell/desk.js').then(m => m.openPhone()));
await page.waitForSelector('#phone-screen h3');
assert.equal(await page.textContent('#phone-screen h3'), 'A new bench for the garden?');
assert.equal(await page.$('[data-later-list]'), null, 'nothing for later: no link to it');

// Later: the days to pick, then one of them
await page.tap('[data-later]');
assert.equal(await page.getAttribute('[data-later]', 'aria-expanded'), 'true');
const days = await page.$$eval('.later-pick [data-day]', bs =>
  bs.map(b => [b.querySelector('b').textContent, b.dataset.day]),
);
// the company's clock, not the phone's own: the next working day there is Monday the 12th
assert.deepEqual(days, [
  ['Next workday', dayIn(1)],
  ['In 2 workdays', dayIn(2)],
  ['In a week', dayIn(7)],
]);
// with Pick a day, two rows of two the same width
const boxes = await page.$$eval('.later-pick .days > *', es =>
  es.map(e => e.getBoundingClientRect()).map(r => [Math.round(r.x), Math.round(r.y), Math.round(r.width)]),
);
assert.equal(boxes.length, 4);
assert.deepEqual(
  [new Set(boxes.map(b => b[0])).size, new Set(boxes.map(b => b[1])).size, new Set(boxes.map(b => b[2])).size],
  [2, 2, 1],
);
// 02:30 there: this morning's 08:00 is still ahead, so the calendar starts today; no day whose 08:00 has come
assert.equal(await page.getAttribute('.later-pick input[type=date]', 'min'), dayIn(0), 'no day whose morning has come');
await shot('1-days');
await page.tap('.later-pick [data-day]');
await page.waitForFunction(
  () => document.querySelector('#phone-screen h3')?.textContent === 'Blue or green for the sign?',
);
assert.deepEqual(asked, [{ id: 3, day: dayIn(1) }]);
assert.match(await page.textContent('.later-note'), /^Back on .+Undo$/);
assert.equal(await page.textContent('.pager [data-list]'), '1 of 1');
await shot('2-aside');

// Undo: the card is back, first
await page.tap('[data-undo]');
await page.waitForFunction(
  () => document.querySelector('#phone-screen h3')?.textContent === 'A new bench for the garden?',
);
assert.deepEqual(asked.at(-1), { id: 3, day: null });
assert.equal(await page.$('.later-note'), null);

// from a Friday the working days skip the weekend; from an ordinary Tuesday they follow on
const offered = async at => {
  await context.clock.setFixedTime(Date.parse(at));
  await page.tap('[data-later]');
  const shown = await page.$$eval('.later-pick [data-day]', bs =>
    bs.map(b => [b.querySelector('b').textContent, b.dataset.day]),
  );
  await page.tap('[data-later]');
  return shown;
};
assert.deepEqual(await offered('2026-10-16T10:00:00Z'), [
  ['Next workday', '2026-10-19'],
  ['In 2 workdays', '2026-10-20'],
  ['In a week', '2026-10-23'],
]);
assert.deepEqual(await offered('2026-10-13T10:00:00Z'), [
  ['Next workday', '2026-10-14'],
  ['In 2 workdays', '2026-10-15'],
  ['In a week', '2026-10-20'],
]);
// after midnight on a working day its morning is still to come: the next working day is that day (00:30 on Monday 19
// October in Amsterdam); from 08:00 it's the day after
assert.deepEqual(await offered('2026-10-18T22:30:00Z'), [
  ['Next workday', '2026-10-19'],
  ['In 2 workdays', '2026-10-20'],
  ['In a week', '2026-10-26'],
]);
assert.deepEqual(await offered('2026-10-19T06:00:00Z'), [
  ['Next workday', '2026-10-20'],
  ['In 2 workdays', '2026-10-21'],
  ['In a week', '2026-10-26'],
]);
await context.clock.setFixedTime(NOW);

// a day picked in the calendar
await page.tap('[data-later]');
await page.fill('.later-pick input[type=date]', dayIn(12));
await page.waitForFunction(
  () => document.querySelector('#phone-screen h3')?.textContent === 'Blue or green for the sign?',
);
assert.deepEqual(asked.at(-1), { id: 3, day: dayIn(12) });

// the list ends in "1 for later"; that list brings it back, shown
await page.tap('.pager [data-list]');
assert.match(await page.textContent('[data-later-list]'), /1 for later/);
await page.tap('[data-later-list]');
assert.deepEqual(await page.$$eval('.later-list b', bs => bs.map(b => b.textContent)), ['A new bench for the garden?']);
assert.match(await page.textContent('.later-list .meta'), /^Back .+ · Wren$/);
await shot('3-later');
await page.tap('[data-now]');
await page.waitForFunction(
  () => document.querySelector('#phone-screen h3')?.textContent === 'A new bench for the garden?',
);
assert.equal(await page.textContent('.pager [data-list]'), '1 of 2');

// nothing waiting, one for later: the empty phone links to it. The first goes aside with an answer half typed: the
// phone still moves on
await page.fill('#phone-screen textarea', 'The bench by the pond');
await page.tap('[data-later]');
await page.tap('.later-pick [data-day]');
await page.waitForSelector('#phone-screen h3:text("Blue or green for the sign?")');
await page.tap('[data-later]');
await page.tap('.later-pick [data-day]');
await page.waitForSelector('.quiet [data-later-list]');
assert.match(await page.textContent('.quiet [data-later-list]'), /2 for later/);
await shot('4-quiet');

assert.deepEqual(errors, []);
console.log('later-check: ok');
await browser.close();
server.close();
