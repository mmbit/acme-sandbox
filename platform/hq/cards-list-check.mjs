#!/usr/bin/env node
// The desk phone's list of the open cards, grouped by topic: the pager's "All cards" opens it, a tap on a title opens that
// card, and the pager steps through the cards as before. A job's number in a title, a toast or a document opens that job,
// and a card's stays text: a link beside the title's button, reached by Tab. On a phone, with a stand-in /api.
//   node platform/hq/cards-list-check.mjs [screenshot.png]
import assert from 'node:assert/strict';
import { serve } from './serve.mjs';
import { playwright, openPage, until } from '../../shared/browser/browser.mjs';

const { chromium, devices } = playwright();

const server = await serve(),
  base = `http://localhost:${server.address().port}`;
const ago = m => new Date(Date.now() - m * 60_000).toISOString();
// newest first, as the coordinator lists them
const cards = [
  ['A new bench for the garden?', 'Garden'],
  ['This week: which plan for the winter?', 'Planning'],
  ['The blue sign’s two colours', 'Signs'],
  ['A hedge: trim it, then plant four shrubs', 'garden'],
  ['The green sign’s two colours', 'Signs'],
  ['The red sign’s three colours', 'Signs'],
  ['A card from before topics, after #3399 and card #89', null],
  ['Two samples have arrived', 'Samples'],
  ['The third sample has arrived too', 'Samples'],
  ['Signs on three walls', 'Signs'],
  ['The yellow sign’s colour', 'Signs'],
  ['The new invoice address is ready', 'Billing'],
  ['Doorbell: tap Done once it rings', 'Doorbell'],
  ['Billing: switch on two reminders', 'Billing'],
  ['Hosting: a second machine, yes or no', 'Hosting'],
  ['The billing account and its owner', 'Billing'],
  ['The doorbell: a chime and a button', 'Doorbell'],
].map(([title, topic], i) => ({
  id: 200 - i,
  created: ago(10 * i + 1),
  agent: 'wren',
  kind: 'decision',
  title,
  body: `About ${title}.`,
  urgency: 'today',
  topic,
}));
let list = cards;
const job = {
  id: 3399,
  agent: 'wren',
  title: 'The doorbell’s chime',
  status: 'done',
  created: ago(90),
  finished: ago(60),
  engine: 'claude',
  attempts: 1,
  review: 0,
  paused: 0,
  ready: 0,
  downtime: 0,
  after: null,
  result: "Rang it after #3400's fix. Card #3 has the choice.",
};
// (the job its report names)
const fix = { ...job, id: 3400, title: 'The doorbell’s wiring', result: 'Rewired it.' };

const doc = {
  path: 'knowledge/notes/doorbell.md',
  shelf: 'Notes',
  title: 'The doorbell, after #3399',
  html: '<p>A chime and a button. Queued as job #3971. Card #89 has the rest.</p>',
};
// (a job's number at a paragraph's start, after a heading: the search window starts right at it; a pull request's own
// link and code that only look like jobs')
const shipped = {
  path: 'knowledge/notes/shipped.md',
  shelf: 'Notes',
  title: 'The porch light',
  html: '<h2>Shipped</h2><p>#120 shipped the porch light and is now ready.</p><p>Merged in <a href="https://github.com/x/y/pull/785">#785</a>, and <code>see #45</code>.</p>',
};
// (a job's number the search window starts inside of)
const clipped = {
  path: 'knowledge/notes/clipped.md',
  shelf: 'Notes',
  title: 'A long word',
  html: `<p>Job #4567 ${'x'.repeat(36)}zebra</p>`,
};

const browser = await chromium.launch();
const { context, page, errors } = await openPage(browser, devices['Pixel 7']);
await context.route(`${base}/api/**`, async r => {
  const path = new URL(r.request().url()).pathname;
  if (path === '/api/org') return r.fulfill({ response: await r.fetch({ url: `${base}/mock/org.json` }) });
  if (path === '/api/requests') return r.fulfill({ json: list });
  if (path === '/api/seen') return r.fulfill({ json: {} });
  if (path === '/api/projects') return r.fulfill({ response: await r.fetch({ url: `${base}/mock/projects.json` }) });
  if (path === '/api/room') return r.fulfill({ json: { line: null } });
  if (path === '/api/jobs/find')
    return r.fulfill({
      json: { job: [job, fix].find(j => j.id === Number(new URL(r.request().url()).searchParams.get('id'))) ?? null },
    });
  if (path === '/api/library') return r.fulfill({ json: [doc, shipped, clipped] });
  if (['/api/gazette', '/api/mail', '/api/review/products'].includes(path)) return r.fulfill({ json: [] });
  return r.fulfill({ status: 404, body: '' });
});
await page.goto(`${base}/?intro=0`);
await until(page, '#loading.gone');
const desk = fn => page.evaluate(name => import('/shell/desk.js').then(m => m[name]()), fn);
await desk('openPhone');
await page.waitForSelector('#phone-screen h3');
const place = async () => page.textContent('.pager [data-list]');
assert.equal(await place(), '1 of 17');

await page.tap('.pager [data-list]');
const groups = await page.$$eval('#phone-screen .topic', hs => hs.map(h => h.textContent.trim()));
assert.deepEqual(
  groups,
  ['Garden 2', 'Planning 1', 'Signs 5', 'Samples 2', 'Billing 3', 'Doorbell 2', 'Hosting 1', 'Other 1'],
  'groups in the order of their newest card, "Garden" and "garden" as one, cards without a topic last',
);
assert.deepEqual(
  await page.$$eval('#phone-screen .card-list', ls => ls[5].innerText.split('\n')),
  ['Doorbell: tap Done once it rings', 'The doorbell: a chime and a button'],
  'newest first within a group',
);
assert.equal(
  await page.$eval('[aria-current]', b => b.getAttribute('aria-label')),
  'A new bench for the garden?',
  'the card the phone was on is marked',
);
if (process.argv[2]) await page.screenshot({ path: process.argv[2], fullPage: true });

// a new card while the list is open: the list takes it in
list = [
  {
    id: 300,
    created: ago(0),
    agent: 'kit',
    kind: 'decision',
    title: 'The white sign’s colour',
    body: 'One colour.',
    urgency: 'today',
    topic: 'signs',
  },
  ...cards,
];
await desk('refreshRequests');
assert.deepEqual(await page.$$eval('#phone-screen .topic', hs => hs.slice(0, 3).map(h => h.textContent)), [
  'Signs 6',
  'Garden 2',
  'Planning 1',
]);

// a card's topic changed (hq topic) while the list is open: the list regroups
list = list.map(r => (r.id === 300 ? { ...r, topic: 'Hosting' } : r));
await desk('refreshRequests');
assert.deepEqual(await page.$$eval('#phone-screen .topic', hs => hs.slice(0, 3).map(h => h.textContent)), [
  'Hosting 2',
  'Garden 2',
  'Planning 1',
]);

// one tap on a title opens that card, and the pager goes on from there
await page.getByRole('button', { name: 'The doorbell: a chime and a button' }).tap();
assert.equal(await page.textContent('#phone-screen h3'), 'The doorbell: a chime and a button');
assert.equal(await place(), '18 of 18');
await page.tap('[data-step="-1"]');
assert.equal(await page.textContent('#phone-screen h3'), 'The billing account and its owner');
await page.tap('.pager [data-list]');
assert.equal(
  await page.$eval('[aria-current]', b => b.getAttribute('aria-label')),
  'The billing account and its owner',
);
const box = await page.locator('.card-list button').first().boundingBox();
assert.ok(box.height >= 40, `a title is a full finger's tap (${box.height} px)`);

// a job's number in a title is a link beside the title's button (a link can't go in one): Tab reaches it after the
// button and Enter opens that job, a modified click opens it in a new HQ, a card's number stays text
const opened = '#projects .pj-card[data-job-open="3399"]';
const closeProjects = () => page.evaluate(() => import('/shell/projects.js').then(m => m.closeProjects()));
assert.deepEqual(await page.$$eval('.card-list a.job-link', t => t.map(e => e.dataset.job)), ['3399']);
assert.equal(await page.$$eval('button a, button .job-link', a => a.length), 0, 'no link inside a button');
await page.focus('.card-list button[aria-label^="A card from before topics"]');
await page.keyboard.press('Tab');
assert.equal(await page.evaluate(() => document.activeElement.dataset.job), '3399');
assert.equal(await page.getAttribute('.card-list a.job-link', 'href'), '/?open=jobs&job=3399');
const asked = context.waitForEvent('request', q => q.isNavigationRequest()),
  newHq = context.waitForEvent('page');
await page.click('.card-list a.job-link', { modifiers: ['Control'] });
assert.equal(new URL((await asked).url()).search, '?open=jobs&job=3399', 'a new HQ, at that job');
await (await newHq).close();
assert.equal(await page.$$eval(opened, d => d.length), 0, 'a modified click leaves this HQ as it is');
await page.keyboard.press('Enter');
await page.waitForSelector(opened);
// its report links the job it names, and a tap there opens that one; the card's number stays text
await page.tap(`${opened} [data-turn]`);
assert.deepEqual(await page.$$eval(`${opened} .pj-report a.job-link`, a => a.map(e => e.textContent)), ['#3400']);
await page.tap(`${opened} .pj-report a.job-link`);
await page.waitForSelector('#projects .pj-card[data-job-open="3400"]');
await closeProjects();

// the same in a toast; the rest of the toast is still its own tap
const toast = html =>
  page.evaluate(
    h =>
      Promise.all([import('/shell/hud.js'), import('/shell/prose.js')]).then(([hud, p]) => {
        window.toasted = 0;
        hud.toast(p.withJobLinks(h), () => window.toasted++, { sticky: true });
      }),
    html,
  );
await toast('Sent to Wren · job #3399');
await page.focus('.toast:last-child > button');
await page.keyboard.press('Tab');
assert.equal(await page.evaluate(() => document.activeElement.dataset.job ?? document.activeElement.outerHTML), '3399');
await page.keyboard.press('Enter');
await page.waitForSelector(opened);
assert.equal(await page.evaluate(() => window.toasted), 0, 'the toast heard nothing');
await closeProjects();
await page.tap('.toast:last-child', { position: { x: 6, y: 6 } });
assert.equal(await page.evaluate(() => window.toasted), 1);
assert.equal(
  await page.$$eval('.toast', t => t.filter(e => e.textContent.includes('Sent to Wren')).length),
  0,
  'the tap closed it',
);

// a Library search's excerpt links its jobs as the document does, beside the result's button, and marks what was searched
const search = async words => {
  await page.evaluate(w => import('/shell/news.js').then(m => m.openLibrary(w)), words);
  await page.waitForSelector('.results li mark');
};
await search('3971');
assert.deepEqual(await page.$$eval('.results a.job-link', a => a.map(e => e.dataset.job)), ['3399', '3971']);
assert.equal(await page.$$eval('button a, button .job-link', a => a.length), 0, 'no link inside a button');
assert.deepEqual(await page.$$eval('.results mark', m => m.map(e => e.textContent)), ['3971']);
assert.match(await page.textContent('.results li'), /Card #89 has/);
await page.tap('.results li', { position: { x: 8, y: 8 } });
await page.waitForSelector('#panel h2:has-text("The doorbell")');
// an excerpt's links are the document's: a number whole in the excerpt is a job's even right at its start, after a
// heading; one the excerpt cuts into is text, and a link's or code's stays theirs
await search('ready');
assert.deepEqual(await page.$$eval('.results a.job-link', a => a.map(e => e.textContent)), ['#120']);
assert.match(
  await page.textContent('.results li span'),
  /^…#120 shipped the porch light and is now ready\. Merged in #785, and see #45\./,
);
await search('zebra');
assert.equal(await page.$$eval('.results a.job-link', a => a.length), 0, 'a number cut off stays text');
assert.match(await page.textContent('.results li span'), /^…567 x+zebra/);

// in a document's HTML, bold or italics around a number or its kind don't change whose it is
assert.deepEqual(
  await page.evaluate(() =>
    import('/shell/prose.js').then(p => {
      const doc = document.createElement('div');
      doc.innerHTML =
        '<p>Card <strong>#89</strong>, PR <b>#785</b> and <b>card</b> #90, picture #5, question #2.</p><p>Job <b>#12</b>, after <em>#13</em> and #14; <code>#15</code>, <a href="#">#16</a>.</p><ul><li><b>cards</b> #95, <i>#96</i></li><li>#17</li></ul>';
      p.linkJobsIn(doc);
      return [...doc.querySelectorAll('a[data-job]')].map(a => a.dataset.job);
    }),
  ),
  ['12', '13', '14', '17'],
);

assert.deepEqual(errors, []);
console.log('cards-list-check: ok');
await browser.close();
server.close();
