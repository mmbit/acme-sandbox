#!/usr/bin/env node
// A zip field on the desk phone, end to end: HQ sends a big zip in chunks to the coordinator's own handler (zips.ts),
// a dropped chunk is sent again, the same file picked after a reload carries on where it stopped, a last chunk whose
// answer was lost is taken as in, and the card shows the import. Send then answers with where the files are. A card
// closed while its zip is unpacked ends the wait. Send goes once the box says imported, after the board went to another
// card and back mid-way.
//   node platform/hq/zip-check.mjs   (needs the coordinator's node_modules; a throwaway DATA_DIR)
// HQ on its own files (serve.mjs); /api/requests* goes to the real handlers, the rest is stood in for here.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { serve } from './serve.mjs';
import { playwright, openPage, until } from '../../shared/browser/browser.mjs';

const { fixtureRepo } = await import('../coordinator/src/fixture.ts');
fixtureRepo();
const scratch = mkdtempSync(`${tmpdir()}/zip-check-`);
process.env.DATA_DIR = `${scratch}/data`;
const zips = await import('../coordinator/src/zips.ts');
const jobs = await import('../coordinator/src/jobs.ts');
const { db } = await import('../coordinator/src/db.ts');
zips.ROOM.minFree = 0;

// The board's zip: a folder around everything, two concepts with their trailers (noise, like a video), node_modules
const zipPath = `${scratch}/forty.zip`;
execFileSync('python3', [
  '-c',
  `
import os, random, zipfile
random.seed(1)
with zipfile.ZipFile('${zipPath}', 'w', zipfile.ZIP_DEFLATED) as z:
    for c in ['puzzle', 'kites']:
        z.writestr(f'forty/{c}/src/app.js', 'console.log("hi")\\n' * 300)
        z.writestr(f'forty/{c}/node_modules/react/index.js', 'x' * 400000)
        z.writestr(zipfile.ZipInfo(f'forty/{c}/out/trailer.mp4'), random.randbytes(9 * 1024 * 1024))
`,
]);
const zipBytes = readFileSync(zipPath).length;

const coordinator = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  if (url.pathname === '/api/requests/zip' && req.method === 'POST') return zips.upload(req, res);
  if (url.pathname === '/api/requests/zip') {
    const field = zips.getField(Number(url.searchParams.get('id')), url.searchParams.get('field'));
    return typeof field === 'number' ? json(field, {}) : json(200, field);
  }
  if (url.pathname === '/api/requests/answer') {
    let body = '';
    for await (const c of req) body += c;
    const b = JSON.parse(body),
      answered = jobs.answerRequest(Number(b.id), b.answer);
    return typeof answered === 'number' ? json(answered, {}) : json(200, answered);
  }
  return json(200, jobs.listRequests());
});
await new Promise(r => coordinator.listen(0, r));
const real = `http://localhost:${coordinator.address().port}`;
const server = await serve(),
  base = `http://localhost:${server.address().port}`;

const job = jobs.createJob({ agent: 'bolt', title: 'The forty concepts', prompt: '.' }).id;
const card = jobs.createRequest({
  kind: 'action',
  title: 'The forty concepts',
  body: 'Upload the zip, please.',
  agent: 'bolt',
  job,
  zips: [{ label: 'The forty concepts' }],
});

const browser = await playwright().chromium.launch();
const { context, page, errors } = await openPage(browser, { viewport: { width: 820, height: 1180 }, hasTouch: true });
const chunks = []; // each zip chunk the page sent: [offset, bytes, what became of it]
let drop = null; // (offset) => whether to cut this chunk off on the way
let loseAnswer = null; // (offset) => whether the server gets this chunk but its answer is lost
let unpacking = false; // the field (and the list) reads as still being unpacked, while the server answers 200
let polls = 0; // GET /api/requests/zip, while the page waits on the unpacking
await context.route(`${base}/api/**`, async r => {
  const url = new URL(r.request().url());
  if (url.pathname === '/api/org') return r.fulfill({ response: await r.fetch({ url: `${base}/mock/org.json` }) });
  if (url.pathname.startsWith('/api/requests')) {
    const offset = Number(url.searchParams.get('offset')),
      posting = r.request().method() === 'POST' && url.pathname === '/api/requests/zip';
    if (posting && drop?.(offset)) {
      chunks.push([offset, r.request().postDataBuffer().length, 'dropped']);
      return r.abort('connectionreset');
    }
    const response = await r.fetch({ url: `${real}${url.pathname}${url.search}` });
    if (posting && loseAnswer?.(offset)) {
      chunks.push([offset, r.request().postDataBuffer().length, 'answer lost']);
      return r.abort('connectionreset');
    }
    if (posting) chunks.push([offset, r.request().postDataBuffer().length, response.status()]);
    if (url.pathname === '/api/requests/zip' && !posting) polls++;
    if (url.pathname === '/api/requests/zip' && !posting && unpacking && response.ok())
      return r.fulfill({ json: { ...(await response.json()), state: 'importing' } });
    if (url.pathname === '/api/requests' && unpacking && response.ok())
      return r.fulfill({
        json: (await response.json()).map(x => ({ ...x, zips: x.zips?.map(z => ({ ...z, state: 'importing' })) })),
      });
    return r.fulfill({ response });
  }
  if (url.pathname === '/api/seen') return r.fulfill({ json: {} });
  if (['/api/gazette', '/api/mail', '/api/review/products'].includes(url.pathname)) return r.fulfill({ json: [] });
  return r.fulfill({ status: 404, body: '' });
});
const open = async () => {
  await page.goto(`${base}/?intro=0`);
  await until(page, '#loading.gone');
  await page.evaluate(() => import('/shell/desk.js').then(m => m.openPhone()));
  await page.waitForSelector('[data-zip-input="0"]', { state: 'attached' });
};
const line = () => page.textContent('[data-zip-field="0"]');

// 1. The first chunk goes, then the line drops for good: the box says where it stopped.
await open();
assert.match(await line(), /Pick zip/);
drop = offset => offset > 0;
await page.setInputFiles('[data-zip-input="0"]', zipPath);
await page.waitForFunction(
  () => /dropped at 8 MB/.test(document.querySelector('[data-zip-field="0"]').textContent),
  null,
  { timeout: 15_000 },
);
assert.deepEqual(chunks.slice(0, 2), [
  [0, 8 * 1024 ** 2, 200],
  [8 * 1024 ** 2, 8 * 1024 ** 2, 'dropped'],
]);

// 2. HQ reloaded (the tab closed, say), the same file picked again: it carries on from 8 MB, after one dropped chunk.
// The last chunk's answer is lost: sent again, it's taken as in, and the import stays.
await open();
assert.match(await line(), /Stopped at 8 MB of 18 MB\. Pick the same file to carry on\./);
let dropped = 0;
drop = () => dropped++ === 1;
loseAnswer = offset => offset === 16 * 1024 ** 2 && !chunks.some(c => c[2] === 'answer lost');
chunks.length = 0;
await page.setInputFiles('[data-zip-input="0"]', zipPath);
await page.waitForFunction(() => /imported ✓/.test(document.querySelector('[data-zip-field="0"]').textContent), null, {
  timeout: 60_000,
});
const sent = chunks.filter(c => c[2] === 200).reduce((n, c) => n + c[1], 0);
assert.deepEqual(
  chunks.map(c => c.slice(0, 1).concat(c[2])),
  [
    [0, 416],
    [8 * 1024 ** 2, 'dropped'],
    [8 * 1024 ** 2, 200],
    [16 * 1024 ** 2, 'answer lost'],
    [16 * 1024 ** 2, 200],
  ],
);
assert.equal(sent, zipBytes - 8 * 1024 ** 2, 'only the rest was sent');
assert.match(await line(), /forty\.zip: 2 folders, 18 MB, leaving out \d+ KB a computer can rebuild/);
await page.screenshot({ path: `${scratch}/imported.png` });

// 3. Send answers with where the files are; node_modules never reached the disk.
await page.fill('#answer', 'Here they are.');
await page.click('#send-answer');
await page.waitForFunction(() => document.querySelector('.req.done'));
const answer = jobs.requestAnswer(card.id, job).answer;
const folder = `${scratch}/data/imports/${card.id}-the-forty-concepts`;
assert.ok(answer.includes(`Zips: 1 of 1 imported.`) && answer.includes(folder), answer);
assert.deepEqual(readdirSync(folder).sort(), ['_import.md', 'kites', 'puzzle']);
assert.deepEqual(readdirSync(`${folder}/puzzle`).sort(), ['out', 'src']);
assert.deepEqual(readdirSync(zips.INCOMING), [], 'the zip is gone');

// 4. Another card, closed while its zip is still unpacking: the page stops asking, and says so.
const closing = jobs.createRequest({
  kind: 'action',
  title: 'More concepts',
  body: 'Upload the zip, please.',
  agent: 'bolt',
  zips: [{ label: 'More concepts' }],
});
loseAnswer = null;
unpacking = true;
await open();
await page.setInputFiles('[data-zip-input="0"]', zipPath);
await page.waitForFunction(() => /Unpacking/.test(document.querySelector('[data-zip-field="0"]').textContent));
db.prepare("update requests set status = 'closed' where id = ?").run(closing.id);
await page.waitForFunction(() => /answered or closed/.test(document.querySelector('#answer-msg')?.textContent ?? ''));
// The refusal's message comes before the page's last look at the field (desk.js, a GET): count from after it.
await page.waitForFunction(() => /No longer waiting/.test(document.querySelector('[data-zip-field="0"]').textContent));
const asked = polls;
await page.waitForTimeout(4000);
assert.equal(polls, asked, 'no more polls once the card is closed');

// 5. Send after the board steps to another card and back while the zip unpacks, a poll replaces the list, and the answer
// is typed (so nothing redraws): once the box says imported, Send goes
jobs.createRequest({ kind: 'action', title: 'Something else', body: 'Anything.', agent: 'bolt' });
const again = jobs.createRequest({
  kind: 'action',
  title: 'The forty concepts, again',
  body: 'Upload the zip, please.',
  agent: 'bolt',
  job,
  zips: [{ label: 'The forty concepts (zip)' }],
});
unpacking = true;
await open();
while ((await page.textContent('.req h3')) !== 'The forty concepts, again') await page.click('[data-step="1"]');
await page.setInputFiles('[data-zip-input="0"]', zipPath);
await page.waitForFunction(() => /Unpacking/.test(document.querySelector('[data-zip-field="0"]').textContent));
const step = (await page.isEnabled('[data-step="1"]')) ? 1 : -1;
await page.click(`[data-step="${step}"]`);
await page.click(`[data-step="${-step}"]`);
await page.evaluate(() => import('/shell/desk.js').then(m => m.refreshRequests()));
await page.fill('#answer', 'Here they are.');
unpacking = false;
await page.waitForFunction(() => /imported ✓/.test(document.querySelector('[data-zip-field="0"]').textContent), null, {
  timeout: 30_000,
});
await page.click('#send-answer');
await page
  .waitForFunction(() => document.querySelector('.req.done'), null, { timeout: 10_000 })
  .catch(async () => assert.fail(`Send didn't go: ${await page.textContent('#answer-msg')}`));
assert.match(jobs.requestAnswer(again.id, job).answer, /Zips: 1 of 1 imported/);
assert.deepEqual(errors, []);
console.log(
  `ok: chunks, a dropped line, a resume after a reload, a lost answer, the import, the answer, a closed card's wait and Send after another card (screenshot: ${scratch}/imported.png)`,
);
await browser.close();
server.close();
coordinator.close();
