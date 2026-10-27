#!/usr/bin/env node
// A walk-through call's recording of HQ keeps customers' details out: the board's own call (what it types kept) records
// Care's list and a card, Mail with a message open, an email card, a delivery address card and a key card on the desk
// phone, and a guest card's people, while the board types in them. Nothing of the mock data's customers (their
// emails, words, order numbers, an email's subject and sender) and nothing typed there is in the stream; the screens'
// own headings are.
//   node platform/hq/private-check.mjs   (needs platform/coordinator's node_modules: npm ci there)
// HQ in dev mode on the foundation's mock data (its brand runs care), with an address card added.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serve, ROOT } from './serve.mjs';
import { playwright, openPage, until } from '../../shared/browser/browser.mjs';

const mock = name => JSON.parse(readFileSync(join(ROOT, `platform/hq/mock/${name}.json`), 'utf8'));
const ADDRESS_CARD = {
  id: 99,
  created: '2026-09-27T01:30:00Z',
  agent: 'wren',
  kind: 'credential',
  title: 'A test parcel: where it goes',
  body: 'The address for one test parcel.',
  secrets: 'PARCEL_NAME,PARCEL_STREET,PARCEL_POSTCODE,PARCEL_CITY',
  address: true,
  addresses: [{ id: 1, label: 'Home' }],
};
const requests = [...mock('requests'), ADDRESS_CARD];
const care = mock('care'),
  cards = mock('care-cards'),
  mail = mock('mail');
// What the board types into those views, and a key
const TYPED = {
  reply: 'Dear Annabel Customer, a new kite is on its way',
  subject: 'For Bram Partner at his office',
  street: 'Kerkstraat 12',
  name: 'Jan Jansen',
  postcode: '1234 AB',
  key: 'sk-test-NEVER-RECORDED',
};
// The customers' details in the mock data: long enough to be theirs alone (a masked text keeps only its length)
const theirs = text => (typeof text === 'string' && text.trim().length >= 8 ? [text.trim().slice(0, 40)] : []);
const DETAILS = [
  ...care.cards.flatMap(c => theirs(c.preview)),
  ...care.mailOnly,
  ...(care.held ?? []).flatMap(h => theirs(h.words)),
  ...Object.values(cards).flatMap(c => [
    ...theirs(c.to),
    ...theirs(c.words),
    ...(c.lines ?? []).flatMap(l => theirs(l.text)),
    ...theirs(c.facts?.order),
  ]),
  ...mail.flatMap(m => [...theirs(m.subject), ...theirs(m.sender)]),
  ...requests.filter(r => r.mail).flatMap(r => r.mail.to), // (its subject is the card's title, the agent's words)
  ...requests.flatMap(r => r.guest?.people ?? []).map(p => p.address),
  ...Object.values(TYPED),
];
const HEADINGS = ['Replies to check', 'Your saved addresses'];

const RECORDER = `${ROOT}/platform/coordinator/node_modules/@rrweb/record/dist/record.js`;
const files = {
  'mock/requests.json': JSON.stringify(requests),
  'shared/watchalong/watchalong.js': readFileSync(`${ROOT}/shared/watchalong/watchalong.js`),
  'shared/watchalong/canvas.js': readFileSync(`${ROOT}/shared/watchalong/canvas.js`),
  'shared/watchalong/encoder.js': readFileSync(`${ROOT}/shared/watchalong/encoder.js`),
  'shared/watchalong/vendor/rrweb-record.js': readFileSync(RECORDER),
};
// (the foundation's mock, never a company's own in theme/hq/mock/)
const read = p =>
  p.startsWith('theme/hq/mock/') ? Promise.reject(new Error('the foundation’s mock')) : readFile(join(ROOT, p));
const server = await serve(read, 0, files);
const base = `http://localhost:${server.address().port}`;
const browser = await playwright().chromium.launch();
try {
  const { page, context, errors } = await openPage(browser, { viewport: { width: 1024, height: 768 } });
  const batches = [];
  await context.route(`${base}/watchalong-events`, route => {
    batches.push(JSON.parse(route.request().postData()));
    route.fulfill({ contentType: 'application/json', body: '{}' });
  });
  await page.goto(`${base}/?intro=0`);
  await until(page, '#loading.gone');
  await page.evaluate(async () => {
    const { watch } = await import('/shared/watchalong/watchalong.js');
    window.watching = watch({ url: '/watchalong-events', typed: 'shown', canvasFps: 0.5 });
  });
  const desk = (fn, ...a) => page.evaluate(([fn, a]) => import('/shell/desk.js').then(m => m[fn](...a)), [fn, a]);
  // the phone at a card, from closed: one with text typed in stays as it is
  const phoneAt = async id => {
    await page.keyboard.press('Escape');
    await desk('openPhone', id);
  };

  // Care: the list, then a card, the board writing its reply
  await desk('openComputer', 'care');
  await page.waitForSelector('.cr .cr-sec');
  await page.click('[data-card="11"]');
  await page.waitForSelector('.cr-card');
  const draft = page.locator('#cr-draft');
  if (await draft.count()) await draft.fill(TYPED.reply);
  // Mail: a message open
  await desk('openComputer', 'mail', { force: true });
  await page.waitForSelector('.rows.mail summary');
  await page.locator('.rows.mail summary').first().click();
  await page.waitForFunction(() => document.querySelector('.rows.mail .mailbody')?.textContent !== '…');
  // The desk phone: an email card, an address card, a key card, a guest card
  await phoneAt(9);
  await page.locator('#mail-subject').fill(TYPED.subject);
  await phoneAt(99);
  const address = page.locator('[data-key]');
  for (const [i, typed] of [TYPED.name, TYPED.street, TYPED.postcode].entries()) await address.nth(i).fill(typed);
  await phoneAt(90);
  await page.locator('[data-key]').first().fill(TYPED.key);
  await phoneAt(12);
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.watching.stop());
  assert.deepEqual(errors, []);
  await context.close();

  const events = batches.flatMap(batch => batch.events);
  const stream = JSON.stringify(events);
  const kept = DETAILS.filter(detail => stream.includes(detail));
  assert.deepEqual(kept, [], 'no customer detail, nor what the board typed in a private part, is in the recording');
  for (const heading of HEADINGS)
    assert.ok(stream.includes(heading), `the screens' own words are recorded: ${heading}`);
  const canvases = events.filter(e => e.type === 3 && e.data.source === 9).length;
  assert.ok(canvases > 0, 'the building is in the recording as canvas pictures');
  console.log(`ok: ${events.length} events, ${canvases} canvas pictures, ${DETAILS.length} details kept out`);
} finally {
  await browser.close();
  server.close();
}
