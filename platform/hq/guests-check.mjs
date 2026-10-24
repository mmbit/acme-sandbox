#!/usr/bin/env node
// A guest card's people (guests.ts card(), desk.js peopleHtml): one row per person with their masked address, where
// their link stands, the language their page is in, Send link (which opens their link on the server first, then shares that person's own) and Remove
// (two taps, the last person too), and Invite under them while the request is open; the same with one person, none
// (the board removed the only one: Invite brings someone else in) and on a closed card (no Remove, no Invite). With
// several, a legend in their colours and whose each mark is. Nothing is wider than a phone.
// An agent's reply with two pictures shows them in its item's thread, a tap shows one big.
// An item's files show under it as downloads by their names.
// The switch that lets its guests invite colleagues at their own domain, and who invited whom.
//   node platform/hq/guests-check.mjs [--shots dir]
// HQ on its own files with a fake /api (so it isn't in dev mode and polls /api/requests) that changes the cards as the
// server would, the phone open on a 390×844 screen, and navigator.share recording what it's handed.
// (Send link's share, the link alone, throughout)
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { serve } from './serve.mjs';
import { playwright, openPage } from '../../shared/browser/browser.mjs';

const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
if (shots) await mkdir(shots, { recursive: true });

const server = await serve(),
  base = `http://localhost:${server.address().port}`;
const person = (name, o = {}) => ({
  name,
  address: `${name[0].toLowerCase()}••••@example.org`,
  released: true,
  verified: null,
  lang: 'nl',
  withdrawn: false,
  revoked: false,
  ...o,
});
const item = (n, kind, title, o = {}) => ({
  n,
  section: kind === 'question' ? 'Vragen' : 'Taken',
  kind,
  title,
  detail: null,
  state: null,
  answer: null,
  thread: [],
  ...o,
});
// (the server's Send link: the link alone, so a share sheet offers Copy link and Teams takes it)
const link = name => `https://hq.example/guest/${name.toLowerCase()}`;
const two = {
  id: 156,
  created: new Date().toISOString(),
  agent: 'moss',
  kind: 'guest',
  title: 'For Lot: De pakbon',
  body: '',
  urgency: 'now',
  guest: {
    request: 3,
    name: 'Lot',
    address: 'l••••@example.org',
    needsEmail: false,
    released: true,
    revoked: false,
    verified: null,
    lang: 'nl',
    // (the card's languages, German too)
    languages: [
      { code: 'nl', own: 'Nederlands' },
      { code: 'en', own: 'English' },
      { code: 'de', own: 'Deutsch' },
    ],
    status: 'open',
    closed: null,
    before: null,
    mail: true,
    done: 2,
    total: 3,
    legend: [
      { name: 'Lot', colour: '#2a2352' },
      { name: 'Karen', colour: '#d1495b' },
    ],
    people: [
      person('Lot', {
        verified: new Date(Date.now() - 3600e3).toISOString(),
        colour: '#2a2352',
        share: link('Lot'),
      }),
      // (a long address, which wraps rather than pushes the buttons off the phone)
      person('Karen', {
        address: 'k••••@a-rather-long-company-domain.example.org',
        released: false,
        colour: '#d1495b',
        share: link('Karen'),
      }),
    ],
    items: [
      // (its files to download: one kept, one past its month, a long name that wraps)
      item(1, 'task', 'Pas de pakbon aan', {
        state: 'done',
        by: 'Lot',
        colour: '#2a2352',
        files: [
          { name: 'index.html', size: 4300, src: '/api/requests/file?id=156&n=0' },
          { name: 'pakbon-met-een-heel-lange-naam-voor-de-drukker-2026.pdf', size: 2_400_000 },
        ],
      }),
      item(2, 'question', 'Welke productnaam?', {
        state: 'answered',
        answer: 'Kompas',
        by: 'Karen',
        colour: '#d1495b',
        thread: [
          {
            who: 'Karen',
            guest: true,
            text: 'Met of zonder hoofdletter?',
            ts: new Date().toISOString(),
            colour: '#d1495b',
          },
        ],
      }),
      item(3, 'task', 'Stuur een voorbeeld', {
        thread: [
          {
            who: 'Moss',
            guest: false,
            text: 'Zo ziet hij er nu uit.',
            ts: new Date().toISOString(),
            pictures: [
              { src: '/api/guest/pictures?id=7&k=0', title: 'Slip front' },
              { src: '/api/guest/pictures?id=7&k=1', title: 'Band anywhere' },
            ],
          },
        ],
      }),
    ],
  },
};
// (a 4×3 picture, as the coordinator serves a reply's)
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGM4UWEDRww4OQBiHhHR6R4GfQAAAABJRU5ErkJggg==',
  'base64',
);
const solo = (id, title, people) => ({
  ...two,
  id,
  title,
  guest: {
    ...two.guest,
    name: people[0].name,
    address: people[0].address,
    legend: undefined,
    people,
    items: [item(1, 'task', 'Teken het contract')],
  },
});
const one = solo(157, 'For Ada: Het contract', [person('Ada', { share: link('Ada') })]);
// the board's case: it removed the only person on it (or revoked them), and wants to invite someone else
const removed = solo(158, 'For Robin: De huur', [person('Robin', { withdrawn: true })]);
const revoked = solo(159, 'For Sam: De sleutels', [person('Sam', { revoked: true })]);
// its guests may invite colleagues at their own domain: the switch off, one of them invited by the first already
const colleagues = solo(160, 'For Thijs: De pagina’s', [
  person('Thijs', { address: 't••••@bureau.example', share: link('Thijs') }),
  person('Wietske', {
    address: 'w••••@bureau.example',
    share: link('Wietske'),
    invitedBy: 'Thijs',
    verified: new Date(Date.now() - 600e3).toISOString(),
  }),
]);
colleagues.guest.colleagues = { domain: 'bureau.example', on: false, used: 1, most: 3 };
const closed = {
  ...two,
  guest: { ...two.guest, status: 'closed', people: two.guest.people.map(p => ({ ...p, share: undefined })) },
};

// The fake server: the cards as /api/requests has them, changed by the card's posts as guests.ts would change them
let requests = [];
const posted = [];
const cardOf = id => requests.find(r => r.id === id);
const browser = await playwright().chromium.launch();
const { context, page, errors } = await openPage(browser, {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
});
await context.route(`${base}/api/**`, async r => {
  const path = new URL(r.request().url()).pathname;
  if (path === '/api/org') return r.fulfill({ response: await r.fetch({ url: `${base}/mock/org.json` }) });
  if (path === '/api/requests') return r.fulfill({ json: requests });
  if (path === '/api/gazette') return r.fulfill({ json: [] }); // (HQ's boot waits for it)
  if (path === '/api/guest/pictures') return r.fulfill({ contentType: 'image/png', body: PNG });
  if (!path.startsWith('/api/guest/')) return r.fulfill({ status: 404, body: '' });
  const b = r.request().postDataJSON(),
    g = cardOf(b.id)?.guest,
    on = g?.people.filter(p => !p.withdrawn && !p.revoked);
  posted.push([path, b]);
  if (path === '/api/guest/release') g.people.find(p => p.name === b.person).released = true;
  if (path === '/api/guest/lang') g.people.find(p => p.name === b.person).lang = b.lang;
  if (path === '/api/guest/colleagues') g.colleagues.on = b.on;
  if (path === '/api/guest/revoke' && b.what === 'person')
    Object.assign(
      g.people.find(p => p.name === b.person),
      { withdrawn: true, share: undefined },
    );
  if (path === '/api/guest/person') {
    if (on.some(p => p.name === b.name))
      return r.fulfill({ status: 409, json: { error: `${b.name} is on this request already` } });
    g.people.push(
      person(b.name, {
        address: `${b.email[0]}••••${b.email.slice(b.email.indexOf('@'))}`,
        released: false,
        share: link(b.name),
      }),
    );
  }
  return r.fulfill({ json: { ok: true } });
});
await context.addInitScript(() => {
  window.shared = [];
  navigator.share = async d => {
    window.shared.push(d);
  };
});

// a poll, as HQ does it every 20 s (desk.js is the page's own module: same URL, same instance)
const show = async card => {
  requests = [structuredClone(card)];
  await page.evaluate(() => import('/shell/desk.js').then(m => m.refreshRequests()));
  await page.waitForFunction(t => document.querySelector('.req h3')?.textContent === t, card.title);
};
const rows = () =>
  page.$$eval('.invites li:not(.none)', li =>
    li.map(x => ({
      name: x.querySelector('.person b').textContent,
      state: x.querySelector('.person span.meta:last-of-type').textContent,
      send: !!x.querySelector('[data-send-link]'),
      remove: !!x.querySelector('[data-remove]'),
    })),
  );
const said = text => page.waitForFunction(t => document.querySelector('.invites .msg')?.textContent === t, text);
// Nothing wider than the phone: the page, the phone's screen, and each person's row (its buttons inside it)
async function fitsPhone(what) {
  const out = await page.evaluate(() => {
    const bad = [],
      screen = document.querySelector('#phone-screen');
    if (document.scrollingElement.scrollWidth > 390) bad.push(`page ${document.scrollingElement.scrollWidth}`);
    if (screen.scrollWidth > screen.clientWidth) bad.push(`screen ${screen.scrollWidth} > ${screen.clientWidth}`);
    for (const li of document.querySelectorAll('.invites li')) {
      const box = li.getBoundingClientRect(),
        list = li.parentElement.getBoundingClientRect();
      if (box.right > list.right + 0.5 || li.scrollWidth > li.clientWidth) bad.push(`row ${li.textContent.trim()}`);
      for (const b of li.querySelectorAll('button'))
        if (b.getBoundingClientRect().right > box.right + 0.5) bad.push(`button ${b.textContent} in ${li.textContent}`);
    }
    const form = document.querySelector('.invites form.invite');
    if (form)
      for (const x of form.children)
        if (x.getBoundingClientRect().right > form.getBoundingClientRect().right + 0.5) bad.push(`invite ${x.name}`);
    return bad;
  });
  assert.deepEqual(out, [], `${what}: nothing wider than the phone`);
}
const snap = async name => {
  if (!shots) return;
  await page.$eval('.invites', p => p.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: `${shots}/${name}.png` });
};
// Send link: shared at once when the link is open; opened on the server first when not (where the wait used up the
// tap, the phone says so and the next tap sends)
async function sendLink(name, on = page) {
  const before = await on.evaluate(() => window.shared.length);
  await on.click(`[data-send-link="${name}"]`);
  await on.waitForFunction(
    n => window.shared.length > n || /tap Send link again/.test(document.querySelector('.invites .msg').textContent),
    before,
  );
  if ((await on.evaluate(() => window.shared.length)) === before) await on.click(`[data-send-link="${name}"]`);
  await on.waitForFunction(n => window.shared.length > n, before);
  return on.evaluate(() => window.shared.at(-1));
}
const releases = () => posted.filter(([p]) => p === '/api/guest/release').map(([, b]) => b);

requests = [structuredClone(two)];
await page.goto(`${base}/?intro=0&open=phone`);
await page.waitForSelector('.invites');

// ---- two people: the legend, whose marks, and a row each with their dot, Send link and Remove; Invite under them
assert.deepEqual(await page.$$eval('.glegend span', s => s.map(x => x.textContent)), ['Lot', 'Karen']);
assert.equal(
  await page.$eval('.glist li:nth-child(1) .gm', e => getComputedStyle(e).backgroundColor),
  'rgb(42, 35, 82)',
);
assert.equal(await page.$eval('.glist li:nth-child(1) .gm', e => e.closest('li').textContent.includes('Lot')), true);
assert.equal(await page.$('#share'), null, 'no card-wide Share');
assert.deepEqual(await rows(), [
  { name: 'Lot', state: 'Opened it 1 h ago', send: true, remove: true },
  { name: 'Karen', state: 'Link not sent yet', send: true, remove: true },
]);
assert.deepEqual(await page.$$eval('.invites li .gdot', d => d.map(x => getComputedStyle(x).backgroundColor)), [
  'rgb(42, 35, 82)',
  'rgb(209, 73, 91)',
]);
assert.match(
  await page.textContent('.invites li:nth-child(2) .person'),
  /k••••@a-rather-long-company-domain\.example\.org/,
);
assert.deepEqual(await page.$$eval('.invites form.invite input', i => i.map(x => x.name)), ['name', 'email']);
await fitsPhone('two people');
await snap('guest-two-people');

// an item's files under its title: each a download by its name with its size, one past its month by its name alone
assert.deepEqual(
  await page.$$eval('.glist li:nth-child(1) .files li', l =>
    l.map(x => [
      x.querySelector('a')?.getAttribute('href') ?? null,
      x.querySelector('a')?.getAttribute('download') ?? null,
      x.textContent,
    ]),
  ),
  [
    ['/api/requests/file?id=156&n=0', 'index.html', 'index.html5 KB'],
    [null, null, 'pakbon-met-een-heel-lange-naam-voor-de-drukker-2026.pdf2 MB'],
  ],
);

// the reply's two pictures under it, named by their files; a tap shows one big, another closes it
assert.deepEqual(await page.$$eval('.glist .thread .pics figcaption', f => f.map(x => x.textContent)), [
  'Slip front',
  'Band anywhere',
]);
await page.waitForFunction(() =>
  [...document.querySelectorAll('.glist .thread .pics img')].every(i => i.naturalWidth === 4),
);
await page.click('.glist .thread .pics figure:nth-child(2) button');
assert.equal(
  await page.$eval('.pic-zoom img', i => [i.getAttribute('src'), i.alt].join(' ')),
  '/api/guest/pictures?id=7&k=1 Band anywhere',
);
await page.click('.pic-zoom');
assert.equal(await page.$('.pic-zoom'), null);

// Send link: Karen's link isn't open yet, so it's opened on the server first, then hers is the one shared; Lot's is
// open, so it's shared at once
assert.deepEqual(await sendLink('Karen'), { url: two.guest.people[1].share }); // the URL alone, no text
assert.deepEqual(releases(), [{ id: 156, person: 'Karen' }]);
assert.deepEqual(await sendLink('Lot'), { url: two.guest.people[0].share });
assert.equal(releases().length, 1, "Lot's open link is shared without opening it again");

// Each person's page language: Karen's set to English goes to the server for her alone, and the card shows it
assert.deepEqual(await page.$$eval('[data-lang]', l => l.map(s => [s.dataset.person, s.value])), [
  ['Lot', 'nl'],
  ['Karen', 'nl'],
]);
assert.deepEqual(await page.$$eval('[data-lang][data-person="Karen"] option', l => l.map(o => o.textContent)), [
  'Nederlands',
  'English',
  'Deutsch',
]);
await Promise.all([
  page.waitForResponse(r => r.url().endsWith('/api/guest/lang')),
  page.selectOption('[data-lang][data-person="Karen"]', 'en'),
]);
assert.deepEqual(posted.at(-1), ['/api/guest/lang', { id: 156, lang: 'en', person: 'Karen' }]);
await fitsPhone('the language pickers');

// Invite someone already on it: the refusal says why under the people, and what was typed stays
await page.fill('.invites [name=name]', 'Lot');
await page.fill('.invites [name=email]', 'lot@example.org');
await page.click('.invites form.invite button');
await said('Lot is on this request already.');
assert.deepEqual(posted.at(-1), ['/api/guest/person', { id: 156, name: 'Lot', email: 'lot@example.org' }]);
assert.equal(await page.inputValue('.invites [name=name]'), 'Lot');
await fitsPhone('a refusal');

// Remove takes two taps: the first asks, the second removes Karen, and the card redraws without her
await page.fill('.invites [name=name]', '');
await page.fill('.invites [name=email]', ''); // (while the board types, the phone holds off redrawing)
await page.evaluate(() => document.activeElement?.blur());
const asked = posted.length;
await page.click('[data-remove="Karen"]');
assert.equal(await page.textContent('[data-remove="Karen"]'), 'Tap again to remove');
assert.equal(posted.length, asked, 'the first tap only asks');
await page.click('[data-remove="Karen"]');
await said('Karen removed.');
assert.deepEqual(posted.at(-1), ['/api/guest/revoke', { id: 156, what: 'person', person: 'Karen' }]);
assert.deepEqual(
  (await rows()).map(r => r.name),
  ['Lot'],
);

// ---- one person: no card-wide Share, the same row (Send link, Remove) and Invite
await show(one);
await page.waitForSelector('.invites li [data-send-link="Ada"]');
assert.equal(await page.$('#share'), null);
assert.equal(await page.$('.glegend'), null);
assert.equal(await page.$('.invites li .gdot'), null, 'one person has no colour');
assert.deepEqual(await rows(), [{ name: 'Ada', state: 'Hasn’t opened it yet', send: true, remove: true }]);
assert.ok(await page.$('.invites form.invite'));
assert.deepEqual(await sendLink('Ada'), { url: one.guest.people[0].share });
await fitsPhone('one person');

// ---- the switch: off, a tap turns it on, a person a guest invited says by whom; none on a card without a domain
assert.equal(await page.$('[data-colleagues]'), null, 'no switch without a domain');
await show(colleagues);
await page.waitForSelector('[data-colleagues]');
assert.equal(await page.isChecked('[data-colleagues]'), false);
assert.equal(
  await page.textContent('.req .colleagues span'),
  'They may invite colleagues at @bureau.example1 of 3 invites used',
);
assert.match((await rows())[1].state, /^Invited by Thijs · Opened it 10 min/);
await fitsPhone('the colleagues switch');
await snap('guest-colleagues');
await page.click('.req .colleagues span');
await page.waitForFunction(
  () => document.querySelector('[data-colleagues]')?.checked && !document.querySelector('[data-colleagues]').disabled,
);
assert.deepEqual(posted.at(-1), ['/api/guest/colleagues', { id: 160, on: true }]);
await page.click('[data-colleagues]');
await page.waitForFunction(
  () =>
    document.querySelector('[data-colleagues]')?.checked === false &&
    !document.querySelector('[data-colleagues]').disabled,
);
assert.deepEqual(posted.at(-1), ['/api/guest/colleagues', { id: 160, on: false }]);

// ---- nobody on it (the board removed the only one): "Nobody yet." and Invite, which brings someone else in, whose
// link opens with their first Send link
for (const card of [revoked, removed]) {
  await show(card);
  assert.equal(await page.textContent('.invites li.none'), 'Nobody yet.');
  assert.equal(await page.$('[data-send-link], [data-remove], #guest-email, #share'), null);
  assert.ok(await page.$('.invites form.invite'), `${card.title}: Invite`);
  await fitsPhone(card.title);
}
await snap('guest-nobody');
await page.fill('.invites [name=name]', 'Karen');
await page.fill('.invites [name=email]', 'karen@example.org');
await page.click('.invites form.invite button');
await said('Karen invited. Send link sends them theirs.');
assert.deepEqual(posted.at(-1), ['/api/guest/person', { id: 158, name: 'Karen', email: 'karen@example.org' }]);
assert.deepEqual(await rows(), [{ name: 'Karen', state: 'Link not sent yet', send: true, remove: true }]);
assert.equal(await page.inputValue('.invites [name=name]'), '');
assert.deepEqual(await sendLink('Karen'), { url: link('Karen') });
assert.deepEqual(releases().at(-1), { id: 158, person: 'Karen' });
await fitsPhone('invited after removing the only one');
await snap('guest-invited');

// ---- closed: the people stay listed, but there's no Send link, Remove or Invite
await show(closed);
await page.waitForSelector('.req .hint >> text=The request is closed');
assert.deepEqual(
  (await rows()).map(r => [r.name, r.send, r.remove]),
  [
    ['Lot', false, false],
    ['Karen', false, false],
  ],
);
assert.equal(await page.$('.invites form.invite'), null);
await fitsPhone('closed');

// ---- dev mode (no /api, HQ on its mock data): the mock's guest card, and someone invited on it, share the link alone
// as the server does
const mockGuest = JSON.parse(await readFile(new URL('mock/requests.json', import.meta.url), 'utf8')).find(r => r.guest);
const {
  context: devContext,
  page: dev,
  errors: devErrors,
} = await openPage(browser, { viewport: { width: 390, height: 844 } });
await devContext.route(`${base}/mock/requests.json`, r => r.fulfill({ json: [mockGuest] }));
await devContext.addInitScript(() => {
  window.shared = [];
  navigator.share = async d => {
    window.shared.push(d);
  };
});
await dev.goto(`${base}/?intro=0&open=phone`);
await dev.waitForSelector('.invites form.invite');
const robin = mockGuest.guest.people[0].name;
assert.deepEqual(await sendLink(robin, dev), { url: `https://hq.example/guest/mock-${robin.toLowerCase()}` });
await dev.fill('.invites [name=name]', 'Sam');
await dev.fill('.invites [name=email]', 'sam@example.org');
await dev.click('.invites form.invite button');
await dev.waitForSelector('[data-send-link="Sam"]');
assert.deepEqual(await sendLink('Sam', dev), { url: 'https://hq.example/guest/mock-sam' }, 'dev mode: the link alone');

assert.deepEqual(errors, []);
assert.deepEqual(devErrors, [], 'dev mode');
await browser.close();
server.close();
console.log(
  "guests-check: a guest card's people on a phone: legend, marks and dots; Send link each (opened first when it isn't), Remove in two taps, Invite and its refusal; one person; nobody left, then Invite (the board's case); closed; dev mode's mock shares the link alone; nothing wider than 390 px; a reply's two pictures, tap to enlarge; an item's files as downloads",
);
