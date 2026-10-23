#!/usr/bin/env node
// The desk phone's saved delivery addresses, end to end, on a phone and on a desktop: an address card (hq ask/request
// --address, four of a tool's own keys, like a test parcel's) with nothing saved yet shows its four fields under plain
// names; the board types an address, ticks Save this address and names it, and saves. The next address card offers it
// above the fields: picking it fills the card's keys on the server (the fields say from which), and the card saves with
// nothing typed. A name already taken is refused before anything is kept. The board removes a saved one with two taps.
// The address itself never comes back to the browser, nor into a card's answer.
//   node platform/hq/address-check.mjs [--shots dir]
// The real coordinator (the test company, a throwaway DATA_DIR) on localhost.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { playwright, openPage } from '../../shared/browser/browser.mjs';

const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
if (shots) await mkdir(shots, { recursive: true });
const listen = (server, port = 0) => new Promise(r => server.listen(port, '127.0.0.1', () => r(server.address().port)));

// ---- the coordinator: the test company, its origin http://localhost:<port>
const free = createServer();
const port = await listen(free);
free.close();
const { fixtureRepo } = await import('../coordinator/src/fixture.ts');
fixtureRepo();
const data = await mkdtemp(`${tmpdir()}/address-check-`);
Object.assign(process.env, {
  DATA_DIR: data,
  SECRETS_DIR: `${data}/secrets`,
  PUBLIC_HOST: 'localhost',
  PORT: String(port),
  WORKER_TOKEN: 'worker-secret',
  VOICE_TOKEN: 'voice-secret',
});
const secrets = await import('../coordinator/src/secrets.ts');
const { app } = await import('../coordinator/src/server.ts');
const { db } = await import('../coordinator/src/db.ts');
const jobs = await import('../coordinator/src/jobs.ts');
const addresses = await import('../coordinator/src/addresses.ts');
db.prepare('insert or replace into sessions (token, expires) values (?, ?)').run('board-session', Date.now() + 3600e3);
const server = createServer(app);
await new Promise(r => server.listen(port, '127.0.0.1', r));

// a card for a fixture tool's four address keys, one line each
const LINE = /^[^\p{Cc}]{1,200}$/u;
let parcels = 0;
function parcelCard() {
  const at = ++parcels;
  const keys = ['NAME', 'STREET', 'POSTCODE', 'CITY'].map(k => `PARCEL_CHECK_${at}_${k}`);
  secrets.registerKeys(Object.fromEntries(keys.map(k => [k, LINE])));
  const body =
    'Three things in one box, each with made-up names. Type where it should go in the four fields below. Saving them is your yes to this one order.\n\n' +
    'Where: the Netherlands only. A company name on the parcel is fine. The address goes into this one order and is deleted from it once the parcel has shipped; one you save for next time stays until you remove it.';
  const { id } = jobs.createRequest({
    kind: 'credential',
    title: `Test parcel ${at}: where should it go?`,
    body,
    agent: 'wren',
    secrets: keys.join(','),
    address: true,
    topic: 'Test prints',
  });
  return { id, keys };
}
const HOME = ['Testco Board', 'Nowhere Lane 1', '1234 AB', 'Utrecht'];

const browser = await playwright().chromium.launch();
async function run(name, options, label) {
  const { context, page, errors } = await openPage(browser, options);
  await context.addCookies([
    { name: 's', value: 'board-session', domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Strict' },
  ]);
  const shot = async what => shots && page.screenshot({ path: `${shots}/${name}-${what}.png` });
  const onCard = async id => {
    await page.waitForFunction(
      t => document.querySelector('.req h3')?.textContent === t,
      `Test parcel ${id}: where should it go?`,
    );
  };
  const first = parcelCard();
  await page.goto(`http://localhost:${port}/?intro=0&open=phone`);
  await page.waitForSelector(`[data-key="${first.keys[0]}"]`);
  await onCard(parcels);

  // nothing saved yet: no list, the four fields under plain names, Save this address under them
  assert.equal(await page.locator('[data-address-pick]').count(), 0);
  assert.deepEqual(
    (await page.locator('.req label.key:has([data-key])').allTextContents()).map(t => t.trim()),
    ['Name', 'Street and house number', 'Postcode', 'City'],
  );
  // shown as typed, with the browser's address fill
  assert.deepEqual(await page.$$eval('.req [data-key]', fs => fs.map(f => `${f.type} ${f.autocomplete}`)), [
    'text name',
    'text street-address',
    'text postal-code',
    'text address-level2',
  ]);
  assert.ok(await page.locator('.address-name').isHidden());
  for (const [i, k] of first.keys.entries()) await page.fill(`[data-key="${k}"]`, HOME[i]);
  await page.check('[data-address-save]');
  assert.ok(await page.locator('[data-address-label]').isVisible());
  // ticked, no name: the name's field asks for it, nothing is sent
  await page.click('#send-answer');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.addressLabel !== undefined), true);
  await page.fill('[data-address-label]', label);
  assert.equal(await page.inputValue(`[data-key="${first.keys[1]}"]`), HOME[1]); // ticking redrew nothing typed
  await shot('1-typed');
  await page.click('#send-answer');
  await page.waitForSelector('.req.done');
  assert.deepEqual(first.keys.map(secrets.secret), HOME);
  const saved = addresses.list().find(a => a.label === label);
  assert.ok(saved, 'saved under its name');
  assert.deepEqual(addresses.parts(saved.id), HOME);

  // the next card offers it: picking it fills the fields' place, and the card saves with nothing typed
  const second = parcelCard();
  await page.evaluate(() => document.querySelector('[data-close]')?.click());
  await page.goto(`http://localhost:${port}/?intro=0&open=phone`);
  await onCard(parcels);
  await page.waitForSelector('[data-address-pick]');
  await page.selectOption('[data-address-pick]', String(saved.id));
  assert.equal(await page.getAttribute(`[data-key="${second.keys[0]}"]`, 'placeholder'), `From “${label}”`);
  assert.ok(await page.locator(`[data-key="${second.keys[0]}"]`).isDisabled());
  assert.ok(await page.locator('.address-keep').isHidden());
  assert.ok(await page.locator('[data-address-remove]').isVisible());
  await shot('2-picked');
  // the browser never gets the address back: not in the cards it reads
  const listed = await page.evaluate(() => fetch('/api/requests').then(r => r.text()));
  assert.ok(!listed.includes(HOME[1]) && listed.includes(label));
  await page.click('#send-answer');
  await page.waitForSelector('.req.done');
  assert.deepEqual(second.keys.map(secrets.secret), HOME);
  for (const id of [first.id, second.id]) {
    const answer = jobs.listRequests('answered').find(r => r.id === id).answer;
    assert.ok(!answer.includes(HOME[1]) && !answer.includes(label), 'no address or name in the answer');
  }

  // a name already taken is refused, in the message line, before anything is kept; then the board removes the saved one
  const third = parcelCard();
  await page.goto(`http://localhost:${port}/?intro=0&open=phone`);
  await onCard(parcels);
  await page.waitForSelector('[data-address-pick]');
  for (const [i, k] of third.keys.entries()) await page.fill(`[data-key="${k}"]`, HOME[i]);
  await page.check('[data-address-save]');
  await page.fill('[data-address-label]', label.toUpperCase());
  await page.click('#send-answer');
  await page.waitForFunction(() =>
    /already have an address called/.test(document.querySelector('#answer-msg')?.textContent ?? ''),
  );
  await shot('3-name-taken');
  assert.deepEqual(secrets.stored(third.keys), []);
  await page.selectOption('[data-address-pick]', String(saved.id));
  await page.click('[data-address-remove]');
  assert.equal(await page.textContent('[data-address-remove]'), 'Tap again to remove');
  await page.click('[data-address-remove]');
  await page.waitForFunction(() => !document.querySelector('[data-address-pick]'));
  assert.equal(
    addresses.list().find(a => a.label === label),
    undefined,
  );
  assert.ok(!existsSync(`${data}/secrets/SAVED_ADDRESS_${saved.id}`));
  assert.ok(await page.locator(`[data-key="${third.keys[0]}"]`).isEnabled());
  await shot('4-removed');
  jobs.answerRequest(third.id, '', Object.fromEntries(third.keys.map((k, i) => [k, HOME[i]])));
  assert.deepEqual(errors, [], name);
  await context.close();
}

await run(
  'phone',
  { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  'Home',
);
await run('desktop', { viewport: { width: 1280, height: 800 } }, 'Office');
await browser.close();
server.close();
console.log('address-check: ok');
process.exit(0);
