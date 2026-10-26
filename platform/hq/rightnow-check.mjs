#!/usr/bin/env node
// An agent's "Right now" in its panel in a real browser, fed as the coordinator's events feed it: each running job under
// the project and thread it serves; with two, one at a time with "1 of 2", a tap or an arrow key stepping either way and
// round, each with its own time and lines, the one shown kept through a redraw; with one again, no pager. In each look,
// on a phone and a laptop.
// And one opened after the agent moved on to another job unheard: never the old one
//   node platform/hq/rightnow-check.mjs [looks]  (wire: that one only; screenshots go to a temp folder, printed at the end)
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';
import { playwright, errorsOf, until } from '../../shared/browser/browser.mjs';
import { lookNames } from './looks.mjs';

const RENDERERS = process.argv[2]?.split(',') ?? lookNames();
const server = await serve(undefined, 0),
  base = `http://localhost:${server.address().port}`;
const MOCK_ORG = fileURLToPath(new URL('mock/org.json', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'rightnow-check-')),
  browser = await playwright().chromium.launch();

// kit: an agent the dev mode's scripted feed never sets to work or counts lines for
const minutesAgo = n => new Date(Date.now() - n * 60_000).toISOString();
const seats = () => ({
  id: 41,
  task: 'Seats for five to ten',
  project: 'HQ’s looks',
  thread: 'Meeting room seating',
  since: minutesAgo(40),
});
const board = () => ({
  id: 42,
  task: 'Reviewing: Make the wall board read right (round 5)',
  project: 'Board lines',
  thread: 'The wall board',
  since: minutesAgo(10),
});
const feed = (page, event) =>
  page.evaluate(
    event =>
      import('/world/world.js').then(world => world.apply({ agent: 'kit', ts: new Date().toISOString(), ...event })),
    event,
  );
const openAgent = page =>
  page.evaluate(() =>
    Promise.all([import('/shell/panel.js'), import('/world/world.js')]).then(([panel, world]) =>
      panel.openAgent(world.agents.get('kit')),
    ),
  );
// (in one evaluation: the panel redraws its section as the feed comes in)
const rightNow = page =>
  page.evaluate(() => {
    const task = document.querySelector('#panel .task');
    return {
      place: task.querySelector('.jobs-pager span')?.textContent ?? null,
      where: task.querySelector('.where')?.textContent ?? null,
      task: task.querySelector(':scope > p:not(.where)').textContent,
      onJob: task.querySelector('.on-job')?.textContent ?? '',
    };
  });
// its time on the job counted from since (a minute less when the machine took one between the panel's drawing and
// this read), and its lines
const assertOnJob = (onJob, since, lines, at) => {
  const minutes = Math.max(1, Math.round((Date.now() - Date.parse(since)) / 60_000));
  const [, shown, rest] = onJob.match(/^(\d+) min on it · (.*)$/) ?? [];
  assert.ok(Number(shown) >= minutes - 1 && Number(shown) <= minutes, `${at}: ${onJob}, ${minutes} min since`);
  assert.equal(rest, lines, at);
};
// the pager's keys whole inside the panel, where a tap reaches them
const pagerInside = page =>
  page.$eval('#panel', panel => {
    const box = panel.getBoundingClientRect();
    return [...panel.querySelectorAll('.jobs-pager button')].every(b => {
      const r = b.getBoundingClientRect(),
        hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return r.left >= box.left && r.right <= box.right && r.width > 0 && b.contains(hit);
    });
  });

for (const look of RENDERERS)
  for (const [w, h, device] of [
    [390, 844, 'phone'],
    [1280, 800, 'laptop'],
  ]) {
    const page = await browser.newPage({
      viewport: { width: w, height: h },
      hasTouch: device === 'phone',
      isMobile: device === 'phone',
    });
    const errors = errorsOf(page);
    const at = `${look}, ${device}`;
    console.log(`${at}…`);
    // (the platform's mock people: the dev org is otherwise the company's)
    await page.route('**/mock/org.json', route => route.fulfill({ path: MOCK_ORG }));
    await page.goto(`${base}/?intro=0&renderer=${look}`);
    await page.waitForFunction(() => document.querySelector('#loading')?.classList.contains('gone'));
    const shot = async name => {
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${out}/${look}-${device}-${name}.png` });
    };

    const SEATS = seats(),
      BOARD = board();
    // one job: as before, with its project and thread above it
    await feed(page, {
      type: 'status',
      state: 'working',
      job: 41,
      text: SEATS.task,
      jobs: [SEATS],
      since: SEATS.since,
    });
    await openAgent(page);
    await page.waitForSelector('#panel .task');
    const one = await rightNow(page);
    assert.deepEqual([one.place, one.where, one.task], [null, 'HQ’s looks · Meeting room seating', SEATS.task], at);
    assertOnJob(one.onJob, SEATS.since, '+0 −0 lines', at);
    await shot('one');

    // two: the newest first, "1 of 2", and each its own time and lines
    await feed(page, { type: 'status', state: 'working', text: BOARD.task, jobs: [BOARD, SEATS] });
    await feed(page, { type: 'lines', job: 41, add: 30, del: 4 });
    await page.waitForSelector('#panel .jobs-pager');
    const first = await rightNow(page);
    assert.deepEqual(
      [first.place, first.where, first.task],
      ['1 of 2', 'Board lines · The wall board', BOARD.task],
      at,
    );
    assertOnJob(first.onJob, BOARD.since, '+0 −0 lines', at);
    assert.ok(await pagerInside(page), `${at}: the pager's keys are whole and on top`);
    await shot('two');
    await page.click('#panel .jobs-pager [data-step="1"]');
    const second = await rightNow(page);
    assert.deepEqual(
      [second.place, second.where, second.task],
      ['2 of 2', 'HQ’s looks · Meeting room seating', SEATS.task],
      at,
    );
    assertOnJob(second.onJob, SEATS.since, '+30 −4 lines', at);
    await shot('stepped');
    // round to the first and back, by tap and by key, and the one shown kept through a redraw
    await page.click('#panel .jobs-pager [data-step="1"]');
    assert.equal((await rightNow(page)).place, '1 of 2', `${at}: past the last, the first`);
    await page.keyboard.press('ArrowLeft');
    assert.equal((await rightNow(page)).place, '2 of 2', `${at}: an arrow key steps too`);
    await page.evaluate(() => import('/shell/panel.js').then(p => p.refreshAgent('kit')));
    assert.equal((await rightNow(page)).task, SEATS.task, `${at}: a redraw keeps the one shown`);
    // what it says it's doing in one of them reads in that one
    await feed(page, { type: 'status', state: 'working', text: 'Fitting the tenth chair', job: 41 });
    assert.equal((await rightNow(page)).task, 'Fitting the tenth chair', at);

    // one ends: the other alone, without a pager, in its own words and lines, as the coordinator carries them
    await feed(page, { type: 'lines', job: 42, add: 12, del: 3 });
    const left = { ...SEATS, task: 'Fitting the tenth chair', lines: { add: 30, del: 4 } };
    await feed(page, { type: 'status', state: 'working', job: 41, text: left.task, jobs: [left], since: SEATS.since });
    const alone = await rightNow(page);
    assert.deepEqual(
      [alone.place, alone.where, alone.task],
      [null, 'HQ’s looks · Meeting room seating', left.task],
      at,
    );
    assertOnJob(alone.onJob, SEATS.since, '+30 −4 lines', `${at}: alone`);
    assert.deepEqual(errors, [], at);
    await page.close();
  }

// Opened after the agent moved on to a new job while the feed was cut off (a tablet asleep): the panel never shows the
// old job, only a quiet line until the coordinator's read is in, then the new one, its clock from the job's own start;
// its next run (sleeping, then at work again) keeps that clock; the job ending while it's open shows at once.
const ROUND_4 = 'Reviewing: Make the wall board read right (round 4)',
  ROUND_5 = 'Reviewing: Make the wall board read right (round 5)';
const statusOf = (task, minutes) => ({ state: 'working', task, since: minutesAgo(minutes) });
for (const look of RENDERERS) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const errors = errorsOf(page),
    at = `${look}, moved on`;
  console.log(`${at}…`);
  // the coordinator, as HQ reads it: the org with kit's status, held back once asked to; a feed that stays quiet
  let kit = statusOf(ROUND_4, 30),
    held = null,
    failing = false;
  const org = JSON.parse(readFileSync(MOCK_ORG, 'utf8'));
  await page.route(`${base}/api/**`, async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/events')
      return route.fulfill({ headers: { 'content-type': 'text/event-stream' }, body: 'retry: 600000\n\n' });
    if (path === '/api/gazette' || path === '/api/requests') return route.fulfill({ json: [] });
    if (path === '/api/seen') return route.fulfill({ json: {} });
    if (path !== '/api/org') return route.fulfill({ status: 404, body: '' });
    if (failing) return route.fulfill({ status: 503, body: '' });
    await held?.promise;
    for (const d of org.departments)
      for (const a of d.agents ?? []) a.status = a.id === 'kit' ? kit : { state: 'idle' };
    return route.fulfill({ json: org });
  });
  await page.goto(`${base}/?intro=0&renderer=${look}`);
  await page.waitForFunction(() => document.querySelector('#loading')?.classList.contains('gone'));
  assert.equal(await page.evaluate(() => import('/world/world.js').then(w => w.agents.get('kit').task)), ROUND_4, at);

  // round 4 ended and round 5 started, and HQ heard neither
  kit = statusOf(ROUND_5, 50);
  held = Promise.withResolvers();
  await page.evaluate(() => {
    window.shown = [];
    new MutationObserver(() => {
      const task = document.querySelector('#panel .task');
      if (task) window.shown.push(task.innerText);
    }).observe(document.querySelector('#panel'), { childList: true, subtree: true, characterData: true });
  });
  await openAgent(page);
  await page.waitForSelector('#panel .task');
  assert.equal(
    await page.$eval('#panel .task p', p => p.textContent),
    'Checking the desk…',
    `${at}: a quiet line first`,
  );
  held.resolve();
  await until(page, '#panel .task p', /\(round 5\)$/);
  assertOnJob((await rightNow(page)).onJob, kit.since, '+0 −0 lines', at);
  const shown = await page.evaluate(() => window.shown);
  assert.ok(!shown.some(text => text.includes(ROUND_4)), `${at}: never the old job: ${shown.join(' | ')}`);
  await page.screenshot({ path: `${out}/${look}-moved-on.png` });

  // its next run: asleep a moment, then at work on it again, its clock still from the job's start
  await feed(page, { type: 'status', state: 'sleeping', text: 'Paused' });
  await feed(page, { type: 'status', state: 'working', text: ROUND_5, since: kit.since });
  assertOnJob((await rightNow(page)).onJob, kit.since, '+0 −0 lines', `${at}: a second run`);
  // the job ends with the panel open: at once
  await feed(page, { type: 'status', state: 'idle' });
  assert.equal((await rightNow(page)).task, 'Nothing on the desk right now.', `${at}: ended`);

  // Opened again after it took a new job unheard, and the read fails: it says so, never the idle it last knew; the
  // next read that comes in shows the job
  kit = statusOf(ROUND_5, 5);
  failing = true;
  await page.evaluate(() => (window.shown = []));
  await openAgent(page);
  await until(page, '#panel .task p', /can’t be checked/);
  await page.screenshot({ path: `${out}/${look}-read-failed.png` });
  failing = false;
  await page.evaluate(() => import('/shell/main.js').then(main => main.refreshOrg()));
  await until(page, '#panel .task p', /\(round 5\)$/);
  const unread = await page.evaluate(() => window.shown);
  assert.ok(!unread.some(text => text.includes('Nothing on the desk')), `${at}, read failed: ${unread.join(' | ')}`);
  assert.deepEqual(errors, [], at);
  await page.close();
}

await browser.close();
server.close();
console.log(`rightnow-check: all good (${RENDERERS.length} looks × phone and laptop). Screenshots: ${out}`);
