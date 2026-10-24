#!/usr/bin/env node
// A work link in a real browser, on the mocks: wherever it is (a machine's key out big in Wire, an agent's panel in
// Brownstone, a card on the desk phone), a tap closes what it's in and opens the projects view on the job's own thread,
// its card in front; while the projects load the thread's skeleton shows, not a blank view; closing the card leaves the
// board on that thread. The card gives one finish time, its work live, and a job at work what it has left.
//   node platform/hq/worklink-check.mjs  (screenshots go to a temp folder, printed at the end)
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, ROOT } from './serve.mjs';
import { playwright, errorsOf, tap } from '../../shared/browser/browser.mjs';

const server = await serve(undefined, 0),
  base = `http://localhost:${server.address().port}`;
const out = mkdtempSync(join(tmpdir(), 'worklink-check-')),
  // (WebGL on SwiftShader, as screens-check.mjs has it: without it the holo look takes minutes a page)
  browser = await playwright().chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
const mock = name => JSON.parse(readFileSync(join(ROOT, 'platform/hq/mock', name), 'utf8'));
// the platform's mock crew (rook, wren, poppy: the projects mock's agents); The rig running rook's task 58, Gift wrap's
const machines = mock('machines.json').map((m, i) =>
  i ? m : { ...m, run: { ...m.run, job: 58, job_code: 'HQ-WRAP', agent: 'rook', title: null, kind: 'tests' } },
);
// a card that names Care replies' first task
const requests = mock('requests.json').map((r, i) => (i ? r : { ...r, title: `${r.title} (job #45)` }));
// (a clip and a long wait: under load a full-page shot waits forever for the stage to settle)
const shot = (page, name) =>
  page.screenshot({ path: `${out}/${name}.png`, clip: { x: 0, y: 0, width: 820, height: 1180 }, timeout: 90_000 });
const text = (page, sel) => page.$eval(sel, e => e.textContent.replace(/\s+/g, ' ').trim());

async function openHq(look) {
  const page = await browser.newPage({ viewport: { width: 820, height: 1180 }, hasTouch: true });
  const errors = errorsOf(page);
  page.setDefaultTimeout(90_000);
  await page.route('**/mock/org.json', r => r.fulfill({ path: join(ROOT, 'platform/hq/mock/org.json') }));
  await page.route('**/mock/machines.json', r => r.fulfill({ json: machines }));
  await page.route('**/mock/requests.json', r => r.fulfill({ json: requests }));
  // (the projects slow to load, as the board's are: the skeleton shows meanwhile)
  await page.route('**/mock/projects.json', async r => {
    await new Promise(go => setTimeout(go, 1500));
    await r.continue();
  });
  await page.goto(`${base}/?intro=0&renderer=${look}`);
  await page.waitForSelector('#loading.gone', { state: 'attached', timeout: 60_000 });
  await page.waitForTimeout(1200);
  return { page, errors };
}

// After a tap on the link: the skeleton, nothing left over the view, then the thread with the job's card, and the
// thread once the card is closed
async function lands(page, at, { job, thread, title }) {
  await page.waitForSelector('#projects .pj-skeleton', { state: 'attached', timeout: 1400 });
  await page.waitForTimeout(500); // (the view's flight in)
  assert.ok(await page.$('#projects .pj-skeleton'), `${at}: the skeleton while the projects load`);
  await shot(page, `${at}-skeleton`);
  const over = await page.evaluate(() => ({
    tool: !document.querySelector('#tool').hidden,
    panel: document.querySelector('#panel').classList.contains('open'),
    big: Boolean(document.querySelector('.alone')),
  }));
  assert.deepEqual(over, { tool: false, panel: false, big: false }, `${at}: what the link was in closes`);
  await page.waitForSelector(`#projects .pj-card[data-job-open="${job}"]`, { timeout: 30_000 });
  await page.waitForTimeout(600);
  await shot(page, `${at}-card`);
  assert.equal(await page.$eval('#projects', e => e.dataset.level), 'thread', `${at}: on its thread`);
  assert.equal(await text(page, '#projects .pj-head h1'), thread, at);
  assert.equal(await text(page, '#projects .pj-card .pj-front h2'), title, at);
  const card = await text(page, '#projects .pj-card .pj-front');
  assert.equal(card.match(/Done about /g)?.length, 1, `${at}: one finish time: ${card}`);
  assert.doesNotMatch(card, /Merged/, at);
  await tap(page, '#projects .pj-card [data-close]');
  await page.waitForFunction(() => !document.querySelector('#projects .pj-card'));
  await page.waitForTimeout(400);
  assert.equal(await page.$eval('#projects', e => e.dataset.level), 'thread', `${at}: still on its thread`);
  assert.equal(await text(page, '#projects .pj-head h1'), thread, at);
  assert.ok(await page.$(`#projects .pj-tasks [data-job="${job}"]`), `${at}: its row in the thread`);
  await shot(page, `${at}-thread`);
  return card;
}

// Wire: The rig's key out big, its "Rook's job HQ-WRAP" link
{
  const { page, errors } = await openHq('wire');
  await page.click('.wire .board .key.machine');
  await page.waitForSelector('.alone .whose a.job-link');
  await shot(page, `wire-machine`);
  await page.click('.alone .whose a.job-link');
  const card = await lands(page, 'wire-machine', { job: 58, thread: 'Gift wrap', title: 'Gift wrap at checkout' });
  assert.match(card, /About 20 min of work, 5 min left/, 'a job at work: its size and what it has left');
  assert.deepEqual(errors, [], 'wire');
  await page.close();
}
// Brownstone: an agent's panel, a job in its recent activity
{
  const { page, errors } = await openHq('brownstone');
  await page.evaluate(async () => {
    const world = await import('/world/world.js'),
      { openAgent } = await import('/shell/panel.js');
    const A = world.agents.get('wren');
    A.logs.push({ ts: Date.now(), type: 'say', text: 'Next up: job #54.' });
    openAgent(A);
  });
  await page.waitForSelector('#panel.open .log a.job-link[data-job="54"]');
  await shot(page, `brownstone-panel`);
  await page.click('#panel .log a.job-link[data-job="54"]');
  await lands(page, 'brownstone-panel', {
    job: 54,
    thread: 'Gift wrap',
    title: 'Gift wrap at checkout: the ribbon picker',
  });
  assert.deepEqual(errors, [], 'brownstone');
  await page.close();
}
// Holo: a card on the desk phone that names a job
{
  const { page, errors } = await openHq('holo');
  await page.evaluate(() => import('/shell/desk.js').then(m => m.openPhone()));
  await page.waitForSelector('#tool .device.phone a.job-link[data-job="45"]');
  await shot(page, `holo-card`);
  await page.click('#tool .device.phone a.job-link[data-job="45"]');
  await lands(page, 'holo-card', { job: 45, thread: 'Care replies', title: 'A care reply template for late parcels' });
  assert.deepEqual(errors, [], 'holo');
  await page.close();
}
// A link to a job of a done thread: a move made while that thread loads (the card closed) ends the landing, whether
// the load comes back or fails: the view stays where the move took it, saying nothing.
{
  const { page, errors } = await openHq('wire');
  await page.evaluate(() => import('/shell/projects.js').then(m => m.openProjects()));
  await page.waitForSelector('#projects .pj-head h1');
  await page.waitForTimeout(600);
  const before = await text(page, '#projects .pj-head h1');
  await page.evaluate(async () => {
    const { loadJobs } = await import('/shell/data.js');
    const done = await (await fetch('mock/threads.json')).json();
    (await loadJobs(true)).push({ ...done['news/launch'].jobs[0], thread: 'news/launch' });
  });
  // (the failure first: a load that comes back is kept, and the next would not ask again)
  for (const fails of [true, false]) {
    const at = `late-${fails ? 'failure' : 'load'}`;
    let release;
    const held = new Promise(r => (release = r));
    await page.route('**/mock/threads.json', async r => {
      await held;
      await (fails ? r.fulfill({ status: 503, body: '' }) : r.continue());
    });
    const asked = page.waitForRequest('**/mock/threads.json');
    // (not awaited: the view opens once the held load is let go)
    await page.evaluate(() => void import('/shell/projects.js').then(m => m.openProjects({ job: 37 })));
    await asked;
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#projects .pj-card'));
    await page.waitForTimeout(600); // (the move's exit, so it has committed)
    release();
    await page.waitForResponse('**/mock/threads.json');
    await page.waitForTimeout(800);
    assert.equal(await text(page, '#projects .pj-head h1'), before, `${at}: the view stays where the move took it`);
    assert.ok(!(await page.$('#projects .pj-card')), `${at}: no card comes back`);
    assert.doesNotMatch(await text(page, '#projects .pj-board'), /didn’t open/, `${at}: and no word of its thread`);
    await page.unroute('**/mock/threads.json');
  }
  await shot(page, 'late-landing');
  assert.deepEqual(errors, [], 'late landing');
  await page.close();
}
await browser.close();
server.close();
console.log(`Work links land on their work. Screenshots: ${out}`);
