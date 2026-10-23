#!/usr/bin/env node
// A card's questions on the desk phone, end to end: a real card (createRequest)
// with yes-or-nos, a number in mm, a choice and a photo field shows each question as its own field, in order, before the
// photo and the answer box. Send marks the first question still open, then a number that isn't one; the answers given
// stay through a reload; a missing photo still holds it; with the photo in, it sends with no typed text and the agent's
// answer lists each question with its answer. At a phone's size (touch) and a desktop's. And a card that asks for one
// file only: Send holds without it, and goes with it and no typed text (the same rule as for questions).
// And a card with an optional question: Send holds for the required one only, an optional chip taps off again, and the
// answer says "(left blank)".
// And a card's note takes pictures as the intercom does: one pasted, one picked,
// both still there after a reload, one removed; Send goes with the picture alone, and the answer names it for hq picture.
// And a card with a product shot tags each photo field as a product or a check photo and says once what each needs;
// a card without one (the first) shows neither.
//   node platform/hq/questions-check.mjs [shots-dir]   (needs the coordinator's node_modules; a throwaway DATA_DIR)
// HQ on its own files (serve.mjs); /api/requests* goes to the real handlers, the rest is stood in for here.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { serve } from './serve.mjs';
import { playwright, openPage, until } from '../../shared/browser/browser.mjs';

const { fixtureRepo } = await import('../coordinator/src/fixture.ts');
fixtureRepo();
process.env.DATA_DIR = `${mkdtempSync(`${tmpdir()}/questions-check-`)}/data`;
const jobs = await import('../coordinator/src/jobs.ts');
const photos = await import('../coordinator/src/photos.ts');
const documents = await import('../coordinator/src/documents.ts');
const pictures = await import('../coordinator/src/pictures.ts');
const { db } = await import('../coordinator/src/db.ts');
const shots = process.argv[2];

const coordinator = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  if (url.pathname === '/api/requests/photo' && req.method === 'POST') return photos.upload(req, res);
  if (url.pathname === '/api/requests/document' && req.method === 'POST') return documents.upload(req, res);
  // a card's pictures
  if (url.pathname === '/api/pictures' && req.method === 'POST') return pictures.upload(req, res);
  if (url.pathname === '/api/pictures/file') return pictures.serve(req, res);
  if (url.pathname === '/api/pictures/waiting')
    return json(200, pictures.unsent(Number(url.searchParams.get('request') ?? 0)));
  if (url.pathname === '/api/pictures/forget') {
    let body = '';
    for await (const c of req) body += c;
    const forgot = pictures.forget(Number(JSON.parse(body).id));
    return typeof forgot === 'number' ? json(forgot, {}) : json(200, forgot);
  }
  if (url.pathname === '/api/requests/answer') {
    let body = '';
    for await (const c of req) body += c;
    const b = JSON.parse(body),
      answered = jobs.answerRequest(Number(b.id), b.answer, b.secrets, false, {}, b.answers, b.pictures);
    return typeof answered === 'number' || Array.isArray(answered)
      ? json(typeof answered === 'number' ? answered : answered[0], answered[2] ?? {})
      : json(200, answered);
  }
  return json(200, jobs.listRequests());
});
await new Promise(r => coordinator.listen(0, r));
const real = `http://localhost:${coordinator.address().port}`;
const server = await serve(),
  base = `http://localhost:${server.address().port}`;

const QUESTIONS = [
  { title: 'Rails: how much of the top does the rail cover?', type: 'number', unit: 'mm' },
  { title: 'Edges: any white line or anything cut off?', type: 'yes-no' },
  { title: 'Colours: anything clearly off from the phone?', type: 'yes-no' },
  { title: 'Which wall would you hang it on?', options: ['Living room', 'Hallway', 'Neither'] },
  // a pick-many: all on, the board takes off what it doesn't want
  { title: 'Which fixes shall we make?', options: ['1. The rail', '2. The edges', '3. The colours'], many: true },
];
// A 4×4 PNG, the photo the board picks
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAF0lEQVQI12P8z4AALKsZQrFzGBkYEAoBe+gECZtuXNMAAAAASUVORK5CYII=',
  'base64',
);

const browser = await playwright().chromium.launch();
// HQ in a browser of its own, its desk phone open on the real cards
async function phone(viewport, touch) {
  const { context, page, errors } = await openPage(browser, { viewport, hasTouch: touch, isMobile: touch });
  await context.route(`${base}/api/**`, async r => {
    const url = new URL(r.request().url());
    if (url.pathname === '/api/org') return r.fulfill({ response: await r.fetch({ url: `${base}/mock/org.json` }) });
    if (
      url.pathname === '/api/requests' ||
      url.pathname.startsWith('/api/requests/') ||
      url.pathname.startsWith('/api/pictures')
    )
      return r.fulfill({ response: await r.fetch({ url: `${real}${url.pathname}${url.search}` }) });
    if (url.pathname === '/api/seen') return r.fulfill({ json: {} });
    if (['/api/gazette', '/api/mail', '/api/review/products'].includes(url.pathname)) return r.fulfill({ json: [] });
    return r.fulfill({ status: 404, body: '' });
  });
  const open = async (shows = '.questions') => {
    await page.goto(`${base}/?intro=0`);
    await until(page, '#loading.gone');
    await page.evaluate(() => import('/shell/desk.js').then(m => m.openPhone()));
    await page.waitForSelector(shows, { state: 'attached' });
  };
  return { context, page, errors, open };
}
for (const [name, viewport, touch] of [
  ['phone', { width: 390, height: 844 }, true],
  ['desktop', { width: 1280, height: 800 }, false],
]) {
  const job = jobs.createJob({ agent: 'dex', title: `The test poster (${name})`, prompt: '.' }).id;
  const { id } = jobs.createRequest({
    kind: 'action',
    title: `The test poster arrived (${name})`,
    body: 'The test poster is in. Hang it in daylight, then answer below and add a photo.',
    agent: 'dex',
    job,
    topic: 'test prints',
    photos: [{ label: 'The top edge with a ruler' }],
    questions: QUESTIONS,
  });
  const { context, page, errors, open } = await phone(viewport, touch);
  const msg = () => page.textContent('#answer-msg');
  const li = k => `.questions > li[data-q="${k}"]`;
  const tap = sel => (touch ? page.tap(sel) : page.click(sel));

  // 1. Each question its own field, in order, before the photo and the answer box (optional now)
  await open();
  assert.deepEqual(
    await page.$$eval('.questions > li .ql', l => l.map(e => e.textContent)),
    QUESTIONS.map(q => q.title),
  );
  assert.deepEqual(
    await page.$$eval('.req .questions, .req .photos, .req #answer', l => l.map(e => e.className || e.id)),
    ['questions', 'photos', 'answer'],
  );
  assert.equal(await page.getAttribute('#answer', 'placeholder'), 'Anything to add (optional)');
  assert.deepEqual(await page.$$eval(`${li(1)} .chip`, l => l.map(e => e.textContent)), ['Yes', 'No']);
  assert.equal(await page.textContent(`${li(0)} .unit`), 'mm');
  assert.equal(await page.locator('.req .photo .shot, .req .hint.shots').count(), 0, 'no product shot, no tags');
  // every field the board types in is 16px or more (iOS Safari zooms in on a smaller one)
  assert.ok(await page.$eval(`${li(0)} input`, e => parseFloat(getComputedStyle(e).fontSize) >= 16));
  if (shots) await page.locator('.req').screenshot({ path: `${shots}/${name}-1-card.png` });

  // 2. Send with nothing answered: the first question is marked, nothing is sent
  await tap('#send-answer');
  assert.match(await msg(), /Answer “Rails: how much of the top does the rail cover\?” first\./);
  assert.ok(await page.$eval(li(0), e => e.classList.contains('missing')));
  // a number that isn't one
  await page.fill(`${li(0)} input`, 'about three');
  await tap(`${li(1)} .chip[data-answer="no"]`);
  await tap(`${li(2)} .chip[data-answer="yes"]`);
  await tap(`${li(3)} .chip[data-answer="Hallway"]`);
  await tap(`${li(2)} .chip[data-answer="no"]`); // changed its mind: one chip on
  assert.equal(await page.locator(`${li(4)} .chip.on`).count(), 3, 'a pick-many starts with every option on');
  await tap(`${li(4)} .chip[data-answer="2. The edges"]`); // one off, the others stay on
  assert.deepEqual(
    await page.$$eval(`${li(2)} .chip`, l => l.map(e => [e.classList.contains('on'), e.getAttribute('aria-pressed')])),
    [
      [false, 'false'],
      [true, 'true'],
    ],
  );
  await tap('#send-answer');
  assert.match(await msg(), /“Rails: how much of the top does the rail cover\?” takes a number, like 3 or 3\.5\./);
  await page.fill(`${li(0)} input`, '3,5');
  await page.locator('#answer').blur();

  // 3. The answers stay through a reload (kept on this device until it sends)
  await open();
  assert.equal(await page.inputValue(`${li(0)} input`), '3,5');
  assert.deepEqual(await page.$$eval('.questions .chip.on', l => l.map(e => e.dataset.answer)), [
    'no',
    'no',
    'Hallway',
    '1. The rail',
    '3. The colours',
  ]);

  // 4. The photo still holds it; with the photo in, it sends without typed text
  await tap('#send-answer');
  assert.match(await msg(), /Add a photo for “The top edge with a ruler” first\./);
  await page.setInputFiles('input[data-photo="0"]', { name: 'top.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForSelector('.photo.is-saved');
  if (shots) await page.locator('.req').screenshot({ path: `${shots}/${name}-2-answered.png` });
  await tap('#send-answer');
  await page.waitForFunction(() => document.querySelector('.req')?.classList.contains('done'), null, {
    timeout: 10_000,
  });
  const done = db.prepare('select status, answer from requests where id = ?').get(id);
  assert.equal(done.status, 'answered');
  assert.equal(
    done.answer,
    [
      '1. Rails: how much of the top does the rail cover? → 3.5 mm',
      '2. Edges: any white line or anything cut off? → No',
      '3. Colours: anything clearly off from the phone? → No',
      '4. Which wall would you hang it on? → Hallway',
      '5. Which fixes shall we make? → 1. The rail; 3. The colours',
      '',
      `Photos: 1 of 1 saved. Fetch them with \`hq photos ${id}\`.`,
    ].join('\n'),
  );
  assert.equal(
    await page.evaluate(k => localStorage.getItem(k), `hq.answers.${id}`),
    'null',
    'the kept answers go once sent',
  );
  assert.deepEqual(errors, []);
  await context.close();
  console.log(`${name}: ok`);
}

// A card with one required file and nothing else: Send holds until the file is in, then goes without typed text
{
  const { id } = jobs.createRequest({
    kind: 'action',
    title: 'The invoice',
    body: 'Pick the invoice below, as it is.',
    agent: 'penny',
    documents: [{ label: 'The invoice', to: 'invoices' }],
  });
  const { context, page, open } = await phone({ width: 390, height: 844 }, true);
  await open('input[data-document="0"]');
  assert.equal(await page.getAttribute('#answer', 'placeholder'), 'Your answer');
  await page.tap('#send-answer');
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    'answer',
    'no file, no text: the answer box asks first',
  );
  await page.fill('#answer', 'here');
  await page.tap('#send-answer');
  assert.match(await page.textContent('#answer-msg'), /Add the file for “The invoice” first\./);
  await page.fill('#answer', '');
  await page.setInputFiles('input[data-document="0"]', {
    name: 'invoice.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n%%EOF\n'),
  });
  await page.waitForSelector('.photo.file.is-saved');
  await page.tap('#send-answer');
  await page.waitForFunction(() => document.querySelector('.req')?.classList.contains('done'), null, {
    timeout: 10_000,
  });
  assert.match(
    db.prepare('select status, answer from requests where id = ?').get(id).answer,
    /^Documents: 1 of 1 filed as mail/,
  );
  await context.close();
  console.log('a file, no text: ok');
}

// A card with a required question and optional ones (card #176's "What to change, if anything"): only the required one
// holds Send; an optional chip taps off again; the answer shows the blank ones
{
  const { id } = jobs.createRequest({
    kind: 'action',
    title: 'The re-cut',
    body: 'The new teams, as on the call.',
    agent: 'lyra',
    questions: [
      { title: 'Go ahead?', type: 'yes-no' },
      { title: 'What to change, if anything', optional: true },
      { title: 'Which first?', options: ['Engine', 'Arcade'], optional: true },
    ],
  });
  const { context, page, errors, open } = await phone({ width: 390, height: 844 }, true);
  const li = k => `.questions > li[data-q="${k}"]`;
  await open();
  assert.equal(await page.getAttribute(`${li(1)} input`, 'placeholder'), 'Optional');
  assert.equal(await page.getAttribute(`${li(1)} input`, 'required'), null);
  await page.tap('#send-answer');
  assert.match(await page.textContent('#answer-msg'), /Answer “Go ahead\?” first\./);
  await page.tap(`${li(0)} .chip[data-answer="yes"]`);
  await page.tap(`${li(2)} .chip[data-answer="Arcade"]`);
  await page.tap(`${li(2)} .chip[data-answer="Arcade"]`); // tapped off: blank again
  assert.equal(await page.$$eval(`${li(2)} .chip.on`, l => l.length), 0);
  await page.tap(`${li(0)} .chip[data-answer="yes"]`); // a required one stays on
  assert.equal(await page.$$eval(`${li(0)} .chip.on`, l => l.length), 1);
  if (shots) await page.locator('.req').screenshot({ path: `${shots}/optional-question.png` });
  await page.tap('#send-answer');
  await page.waitForFunction(() => document.querySelector('.req')?.classList.contains('done'), null, {
    timeout: 10_000,
  });
  assert.equal(
    db.prepare('select answer from requests where id = ?').get(id).answer,
    '1. Go ahead? → Yes\n2. What to change, if anything → (left blank)\n3. Which first? → (left blank)',
  );
  assert.deepEqual(errors, []);
  await context.close();
  console.log('an optional question left blank: ok');
}

// A card's note takes pictures
{
  const { id } = jobs.createRequest({
    kind: 'action',
    title: 'The menu',
    body: 'How does it look on yours?',
    agent: 'kit',
  });
  const { context, page, errors, open } = await phone({ width: 390, height: 844 }, true);
  await open('#answer-attach');
  assert.equal(await page.isHidden('.req .tray'), true);
  // pasted into the note
  await page.focus('#answer');
  await page.evaluate(async b64 => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0)),
      dt = new DataTransfer();
    dt.items.add(new File([bytes], 'shot.png', { type: 'image/png' }));
    document
      .querySelector('#answer')
      .dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG.toString('base64'));
  await page.waitForFunction(() => document.querySelectorAll('.req .tray .pic:not(.busy)').length === 1);
  // picked with the button
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.tap('#answer-attach')]);
  await chooser.setFiles({ name: 'photo.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForFunction(() => document.querySelectorAll('.req .tray .pic:not(.busy)').length === 2);
  const waiting = () => pictures.unsent(id).pictures.map(p => p.id);
  assert.equal(waiting().length, 2);
  assert.deepEqual(pictures.unsent().pictures, [], 'not in the intercom’s tray');
  if (shots) await page.screenshot({ path: `${shots}/card-pictures.png` });
  // still there after a reload; one taken out goes from the coordinator too
  await open('#answer-attach');
  await page.waitForFunction(() => document.querySelectorAll('.req .tray .pic:not(.busy)').length === 2);
  const [kept, gone] = waiting();
  await page.tap('.req .tray .pic:nth-child(2) button');
  await page.waitForFunction(() => document.querySelectorAll('.req .tray .pic').length === 1);
  assert.deepEqual(waiting(), [kept]);
  // the picture alone is an answer
  await page.tap('#send-answer');
  await page.waitForFunction(() => document.querySelector('.req')?.classList.contains('done'), null, {
    timeout: 10_000,
  });
  const answer = db.prepare('select answer from requests where id = ?').get(id).answer;
  assert.ok(answer.includes(`hq picture ${kept}`) && !answer.includes(`#${gone}`), answer);
  assert.deepEqual(errors, []);
  await context.close();
  console.log('a picture in a card’s note: ok');
}
// A card with a product shot: each photo field tagged, and the line on what each kind needs, once. One with product
// shots only says nothing of check photos.
{
  const card = photos =>
    jobs.createRequest({ kind: 'action', title: 'Shop photos', body: 'Two photos, please.', agent: 'dex', photos }).id;
  const tags = page => page.$$eval('.req .photo .shot', l => l.map(e => e.textContent));
  const mixed = card([
    { label: 'The print with a ruler' },
    { label: 'The mug, handle left, on white', shot: 'product' },
    { label: 'Anything that looks wrong', optional: true },
  ]);
  const { ctx, page, open } = await phone({ width: 390, height: 844 }, true),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await open('.req .photos');
  assert.deepEqual(await tags(page), ['Check photo', 'Product photo', 'Check photo']);
  assert.equal(
    await page.getAttribute('input[data-photo="1"]', 'aria-label'),
    'Product photo: The mug, handle left, on white',
  );
  const line = await page.textContent('.req .hint.shots');
  assert.ok(/Product photo:.*ruler/.test(line) && /Check photo:.*ruler/.test(line), line);
  if (shots) await page.locator('.req').screenshot({ path: `${shots}/product-shot.png` });
  // the product photo goes in like any other, and keeps its tag
  await page.setInputFiles('input[data-photo="1"]', { name: 'mug.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForSelector('.photo[data-field="1"].is-saved');
  assert.equal(await page.textContent('.photo[data-field="1"] .shot'), 'Product photo');

  jobs.closeRequest(mixed, 'dex');
  card([{ label: 'The mug, straight on', shot: 'product' }]);
  await open('.req .photos');
  assert.deepEqual(await tags(page), ['Product photo']);
  assert.doesNotMatch(await page.textContent('.req .hint.shots'), /Check photo/);
  assert.deepEqual(errors, []);
  await ctx.close();
  console.log('a product shot: ok');
}
await browser.close();
server.close();
coordinator.close();
console.log('questions-check: ok');
