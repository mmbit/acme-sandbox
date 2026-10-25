#!/usr/bin/env node
// Outside notes end to end, on phones: the board opens Share in the viewer and invites two people (the days choice shows
// before the first invite only); the box lists both with Send link and Remove. Each, in a fresh browser (no preview key),
// signs in with the code from their email, opens the preview, pins a note (the second also a general note, from the pin's
// menu) and taps Send my notes twice in that menu: it's in reach beside the pin, and once sent the pin is away, a
// thank-you shows and the menu keeps only Add more notes, every line of it on one line. They reach nothing else.
// After the first has sent theirs nothing is queued; Reviews opens on My notes, and its Shared folds the share to one
// line (people, notes sent, until when) that opens to its people (not the notes), and Invite and Remove work there too.
// After the second, the owner's job holds both people's notes, each signed, and the share stays in Reviews with End now:
// the first's link says Sent, thank you, and its Add more notes takes them up again; a later note goes as a follow-up job.
// The board's End now closes it for good: Reviews lists the ended share and the notes with who wrote them, the links are
// shut, and a link says why.
// Then a deck shared view only: its box offers the people shared with lately (Recent), a tap invites one again, and a
// plus on a name gives them a title, a badge on their row; no review mode, and
// its "try the demo" opens the demo on the product's host. Then the
// shop shared to try out: the tester's door is a greeting and four steps (the company's own last), the voucher in the
// first with a button that copies it, a quieter aside on what happens to their notes, and a small line with the company's
// own note and until when, on a phone and on a desktop.
//   node platform/hq/shares-check.mjs [--shots dir]
// The real coordinator (the test company, a throwaway DATA_DIR) behind a stand-in for Caddy on https://*.company.test (a
// self-signed certificate): forward_auth before a product's pages, /__preview and /__review/* straight to the coordinator,
// as infra/products.py writes them. A stand-in email service keeps the codes.
// (Send link's share, the link alone, throughout)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { tmpdir } from 'node:os';
import { playwright, openPage, until } from '../../shared/browser/browser.mjs';
import { wrappedMenuLines } from '../../shared/review/lines.mjs';

const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
if (shots) await mkdir(shots, { recursive: true });
const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));

// ---- the email service: keeps what it took
const mails = [];
const lettermint = createServer(async (q, s) => {
  let body = '';
  for await (const chunk of q) body += chunk;
  mails.push(JSON.parse(body));
  s.writeHead(202).end(JSON.stringify({ message_id: `m-${mails.length}` }));
});
const mailPort = await listen(lettermint);

// ---- the coordinator: the test company, live mode (a real zone) with the stand-in email service
const { fixtureRepo } = await import('../coordinator/src/fixture.ts');
const repo = fixtureRepo();
// a deck whose button opens the demo on the product's own host
await mkdir(`${repo}/products/_cycles/2026-03-03-deck/presentation`, { recursive: true });
await writeFile(
  `${repo}/products/_cycles/2026-03-03-deck/presentation/index.html`,
  `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Deck</title>
  <h1>Our deck</h1><a href="https://hello.preview.company.test/">Try the demo</a>`,
);
// the shop, whose preview a tester invite opens
await mkdir(`${repo}/products/front`, { recursive: true });
await writeFile(`${repo}/products/front/product.yaml`, 'name: The shop\nstatus: preview\nowner: bolt\n');
// and the company's own line for its testers (brand.yaml testerNote), in the door's small line, and its own last step (testerFeedback)
await appendFile(
  `${repo}/company/brand.yaml`,
  '\ntesterNote:\n  en: "Read the Product safety page before you use what you ordered."\n' +
    'testerFeedback:\n  en: "Tell us how unpacking it went at hello@example.com!"\n',
);
const data = await mkdtemp(`${tmpdir()}/shares-check-`);
Object.assign(process.env, {
  DATA_DIR: data,
  SECRETS_DIR: `${data}/secrets`,
  PUBLIC_HOST: 'hq.company.test',
  WORKER_TOKEN: 'worker-secret',
  VOICE_TOKEN: 'voice-secret',
  CARE_EMAIL_SERVICE: 'lettermint',
  EMAIL_API: `http://127.0.0.1:${mailPort}/v1`,
});
await mkdir(`${data}/secrets`);
await writeFile(`${data}/secrets/CARE_EMAIL_API_KEY`, 'lm-key-0123456789abcdefghij');
const { app } = await import('../coordinator/src/server.ts');
const { db } = await import('../coordinator/src/db.ts');
db.prepare('insert or replace into sessions (token, expires) values (?, ?)').run('board-session', Date.now() + 3600e3);
const coordinatorPort = await listen(createServer(app));

// ---- Caddy, played: HQ whole; a preview host's own routes, and its pages behind forward_auth
const PRODUCT = 'https://hello.preview.company.test';
const PAGE = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Hello</title>
  <style>body { font: 18px system-ui; margin: 24px; } h1 { margin-top: 80px; }</style>
  <h1>Hello, whoever you are</h1><p>A little card for a friend.</p><script src="/__review/review.js" defer></script>`;
function proxy(req, res) {
  const q = request(
    { host: '127.0.0.1', port: coordinatorPort, path: req.url, method: req.method, headers: req.headers },
    r => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    },
  );
  req.pipe(q);
}
async function caddy(req, res) {
  const host = req.headers.host.split(':')[0],
    path = new URL(req.url, 'https://x').pathname;
  if (!host.includes('.preview.') || path === '/__preview' || path.startsWith('/__review/')) return proxy(req, res);
  const checked = await new Promise((done, fail) =>
    request(
      {
        host: '127.0.0.1',
        port: coordinatorPort,
        path: '/api/preview/check',
        headers: { cookie: req.headers.cookie ?? '', 'x-forwarded-host': host, 'x-forwarded-uri': req.url },
      },
      done,
    )
      .on('error', fail)
      .end(),
  );
  checked.resume();
  if (checked.statusCode !== 200)
    return res.writeHead(checked.statusCode, { location: checked.headers.location }).end();
  if (host.startsWith('cycles.')) return proxy(req, res); // the cycles' pages: the coordinator serves their HTML
  res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
}
const certs = await mkdtemp(`${tmpdir()}/shares-cert-`);
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=company.test',
    '-keyout',
    `${certs}/key.pem`,
    '-out',
    `${certs}/cert.pem`,
    '-addext',
    'subjectAltName=DNS:*.company.test,DNS:*.preview.company.test',
  ],
  { stdio: 'ignore' },
);
const httpsPort = await listen(
  createHttps({ key: await readFile(`${certs}/key.pem`), cert: await readFile(`${certs}/cert.pem`) }, caddy),
);

const browser = await playwright().chromium.launch({
  args: [`--host-resolver-rules=MAP *.company.test:443 127.0.0.1:${httpsPort}`],
});
const pageErrors = [];
async function context() {
  const opened = await openPage(browser, {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    hasTouch: true,
    ignoreHTTPSErrors: true,
  });
  await opened.context.addInitScript(() => {
    const a = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (o) {
      return a.call(this, { ...o, mode: 'open' });
    };
  });
  pageErrors.push(opened.errors);
  return opened;
}
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

// What the board's Send link hands the share sheet, and
// the code in an address's latest email
const shared = async page => {
  const d = await page.evaluate(() => window.shared.at(-1));
  assert.deepEqual(Object.keys(d), ['url'], 'Send link shares the link alone');
  return d.url;
};
const codeFor = address => /(\d{6})/.exec(mails.findLast(m => [m.to].flat().includes(address)).text)[1];
// Reviews' Shared: its one open share folded to a line (its people, notes sent, until when), tapped open
async function unfold(page, line) {
  await page.click('[data-shown=shared]');
  await page.waitForSelector('[data-shown=shared][aria-checked=true]');
  const summary = await page.waitForSelector('section.share > details:not([open]) > summary');
  assert.match(await summary.$eval('.dim', d => d.textContent), line);
  assert.equal(await page.isVisible('section.share .invites li'), false, 'folded: its people out of sight');
  await summary.click();
}
// Nothing in a people block wider than its box, nor the page wider than the phone
async function fits(page, scope, what) {
  const bad = await page.$eval(scope, el => {
    const out = [],
      box = el.getBoundingClientRect();
    if (document.scrollingElement.scrollWidth > innerWidth) out.push(`page ${document.scrollingElement.scrollWidth}`);
    if (box.left < 0 || box.right > innerWidth + 0.5) out.push(`box ${box.left}–${box.right}`);
    for (const x of el.querySelectorAll('.invites li, .invites li button, .invites form.invite > *')) {
      const r = x.getBoundingClientRect(),
        outer = (x.closest('li') === x ? x.parentElement : x.closest('li, form')).getBoundingClientRect();
      if (r.right > outer.right + 0.5 || r.left < outer.left - 0.5) out.push(`${x.tagName} ${x.textContent || x.name}`);
    }
    return out;
  });
  assert.deepEqual(bad, [], `${what}: nothing wider than the phone`);
}
const rows = (page, scope) =>
  page.$$eval(`${scope} .invites li:not(.none)`, li =>
    li.map(x => [
      x.querySelector('.person b').textContent,
      x.querySelector('.person .meta:not(.at)').textContent, // (not the last child)
      !!x.querySelector('[data-send-link]'),
      !!x.querySelector('[data-remove]'),
    ]),
  );
const said = (page, scope, text) =>
  page.waitForFunction(([s, t]) => document.querySelector(`${s} .invites .msg`)?.textContent === t, [scope, text]);
async function invite(page, scope, name, email) {
  await page.fill(`${scope} .invites [name=name]`, name);
  await page.fill(`${scope} .invites [name=email]`, email);
  await page.click(`${scope} .invites form.invite > button`);
  await said(page, scope, `${name} invited. Send link sends them theirs.`);
}
const outsideJobs = () =>
  db.prepare("select id, agent, title, prompt from jobs where title like 'Outside notes on %'").all();
const tool = sel => `review-mode >> ${sel}`;

// An outside reviewer in a browser of their own: the code by email, the door, the preview, a note
async function reviewer(link, address, note) {
  const { page } = await context();
  await page.goto(link);
  assert.match(await page.textContent('main'), new RegExp(`${address[0]}••••@example\\.org`));
  await page.click('button:has-text("Send the code")');
  await page.waitForSelector('#code');
  await page.fill('#code', codeFor(address));
  await page.click('button:has-text("Open the page")');
  await page.waitForSelector('text=for your notes');
  assert.match(await page.textContent('main'), /tap Send my notes/);
  await page.click('a:has-text("Open Hello")');
  await page.waitForURL(`${PRODUCT}/`);
  assert.deepEqual(
    (await page.context().cookies(PRODUCT)).map(c => [c.name, c.domain]),
    [['ps', 'hello.preview.company.test']],
    'one host-only cookie',
  );
  await page.waitForSelector(tool('.coach:not([hidden])'));
  assert.equal(await page.textContent(tool('.coach b')), 'Tap the red pin to leave a note for the Testco crew');
  assert.ok(await page.isHidden(tool('[data-mine]')), 'no Send my notes before a note');
  await pinNote(page, note, true);
  return page;
}
// A note pinned to the page's heading, the first of the page's notes still to go (first: the browser's first, which asks
// for no personal details)
async function pinNote(page, note, first = false) {
  await page.click(tool('.fab'), { force: true }); // (it bobs while the coach is up)
  const h1 = await page.locator('h1').boundingBox();
  await page.mouse.click(h1.x + 40, h1.y + h1.height / 2);
  await page.waitForSelector(tool('.sheet:not([hidden])'));
  if (first) assert.match(await page.textContent(tool('.msg')), /Please don’t type personal details/);
  await page.fill(tool('textarea'), note);
  await page.click(tool('.send'));
  await page.waitForFunction(
    () => document.querySelector('review-mode').shadowRoot.querySelector('.count').textContent === '1',
    null,
    { timeout: 20_000 },
  );
  assert.equal(db.prepare('select status from review_notes where note = ?').get(note).status, 'outside');
}
// A general note from the pin's menu: the same sheet, without a photo or an element
async function generalNote(page, words, count) {
  await page.click(tool('.more'));
  await page.click(tool('[data-general]'));
  await page.waitForSelector(tool('.sheet:not([hidden])'));
  assert.equal(await page.textContent(tool('.who h2')), 'A general note');
  assert.ok(await page.isHidden(tool('.polaroid')), 'no photo with a general note');
  await page.fill(tool('textarea'), words);
  await page.click(tool('.send'));
  await page.waitForFunction(
    n => document.querySelector('review-mode').shadowRoot.querySelector('.count').textContent === n,
    String(count),
    { timeout: 20_000 },
  );
  const saved = db.prepare('select element, shot, status from review_notes where note = ?').get(words);
  assert.deepEqual([JSON.parse(saved.element).kind, saved.shot, saved.status], ['general', null, 'outside']);
}
// The pin's menu as it shows now
const items = page => page.$$eval(tool('.menu .items button:not([hidden])'), b => b.map(x => x.firstChild.textContent));
// Their Send my notes, two taps in the pin's menu: in reach on a phone and clear of the pin; the first only asks; after the
// second the pin is away and a thank-you shows, and on their next page too the tool is only its menu's Add more notes
async function sendMine(page, name, shot, count = 1) {
  // another page of theirs counts the note too: the count is the coordinator's, not the page's
  const again = await page.context().newPage();
  await again.goto(page.url());
  await again.waitForFunction(
    n => document.querySelector('review-mode')?.shadowRoot.querySelector('.count')?.textContent === n,
    String(count),
    { timeout: 20_000 },
  );
  await again.close();
  // (once the pin's boing at the new count has played; in the pin's menu)
  await page.click(tool('.more'));
  const where = await page.evaluate(async () => {
    const pin = document.querySelector('review-mode').shadowRoot.querySelector('.fab');
    await Promise.all(
      pin
        .getAnimations()
        .filter(a => a.effect.getTiming().iterations !== Infinity)
        .map(a => a.finished.catch(() => {})),
    );
    const root = document.querySelector('review-mode').shadowRoot,
      done = root.querySelector('[data-mine]'),
      d = done.getBoundingClientRect(),
      f = root.querySelector('.fab').getBoundingClientRect();
    return {
      text: done.firstChild.textContent,
      inView: d.left >= 0 && d.top >= 0 && d.right <= innerWidth && d.bottom <= innerHeight && d.width > 0,
      onTop: root.elementFromPoint(d.x + d.width / 2, d.y + d.height / 2) === done,
      clear: d.right <= f.left || d.left >= f.right || d.bottom <= f.top || d.top >= f.bottom,
      at: [d, f].map(r => [r.left, r.top, r.right, r.bottom].map(Math.round).join(',')).join(' / '),
    };
  });
  const { at, ...seen } = where;
  assert.deepEqual(
    seen,
    { text: 'Send my notes', inView: true, onTop: true, clear: true },
    `${name}'s Send my notes (${at})`,
  );
  assert.match(await page.textContent(tool('[data-mine] small')), /Testco/);
  assert.deepEqual(await page.evaluate(wrappedMenuLines), [], `${name}'s menu, every line on one line on a phone`);
  if (shot) await shot(page, `${name.toLowerCase()}-send-my-notes`);
  await page.click(tool('[data-mine]'));
  assert.equal(await page.$eval(tool('[data-mine]'), b => b.firstChild.textContent), 'Tap again to send');
  assert.deepEqual(await page.evaluate(wrappedMenuLines), [], `${name}'s menu, asking again`);
  const person = () => db.prepare('select submitted from review_share_people where guest = ?').get(name);
  assert.equal(person().submitted, null, 'the first tap only asks');
  await page.click(tool('[data-mine]'));
  await page.waitForSelector(tool('.tip.show'));
  assert.equal(await page.textContent(tool('.tip')), 'Sent to the Testco crew. Thank you!');
  assert.ok(await page.isHidden(tool('.fab')), 'the pin is away');
  assert.ok(person().submitted);
  if (shot) await shot(page, `${name.toLowerCase()}-sent`);
  await page.reload();
  await page.waitForSelector(tool('.more'));
  assert.ok(await page.isHidden(tool('.fab')), `${name} pins no more notes`);
  await page.click(tool('.more'));
  assert.deepEqual(await items(page), ['Add more notes'], `${name}'s menu, sent`);
  assert.deepEqual(await page.evaluate(wrappedMenuLines), [], `${name}'s menu, sent, on one line each`);
  await page.click(tool('.more'));
}

try {
  // ---- the board: the preview in HQ's viewer, Share; nobody on it yet, open for 1 day
  const { context: boardCtx, page: hq } = await context();
  await boardCtx.addCookies([
    {
      name: 's',
      value: 'board-session',
      domain: 'hq.company.test',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
  await boardCtx.addInitScript(() => {
    window.shared = [];
    navigator.share = async d => {
      window.shared.push(d);
    };
  });
  await hq.goto('https://hq.company.test/?intro=0');
  await until(hq, '#loading.gone');
  await hq.evaluate(href => {
    const a = document.createElement('a');
    a.href = href;
    document.body.append(a);
    a.click();
    a.remove();
  }, `${PRODUCT}/`);
  await hq.waitForSelector('#viewer .bar .pin:not([hidden])', { timeout: 15_000 }); // the board's own review mode in the frame
  const fitsBar = await hq.$eval('#viewer .bar', bar =>
    [...bar.children]
      .filter(c => !c.hidden)
      .every(c => c.getBoundingClientRect().right <= bar.getBoundingClientRect().right + 0.5),
  );
  assert.ok(fitsBar, 'the bar with Share still fits a phone');
  const BOX = '#viewer .sharebox';
  await hq.click('#viewer .bar .share');
  await hq.waitForSelector(`${BOX} .invites li.none`);
  assert.equal(await hq.textContent(`${BOX} .invites li.none`), 'Nobody yet.');
  assert.deepEqual(await hq.$$eval(`${BOX} [data-days]`, b => b.map(x => x.textContent)), [
    '1 day',
    '3 days',
    '7 days',
  ]);
  await hq.click(`${BOX} [data-days="1"]`);
  await fits(hq, BOX, 'the empty share box');
  await shot(hq, 'share-empty');

  // two invites: the first opens it for the day chosen, after which the days go and the box says until when
  await invite(hq, BOX, 'Sam', 'sam@example.org');
  assert.equal(await hq.$(`${BOX} [data-days]`), null, 'the days show before the first invite only');
  assert.match(await hq.textContent(`${BOX} .dim`), /^Until .*Once everyone has sent their notes, they go to Bolt\.$/);
  const ends = Date.parse(db.prepare('select ends from review_shares').get().ends) - Date.now();
  assert.ok(ends > 86_000e3 && ends <= 86_400e3, 'open for 1 day');
  await invite(hq, BOX, 'Kim', 'kim@example.org');
  assert.deepEqual(await rows(hq, BOX), [
    ['Sam', 'Hasn’t opened it yet', true, true],
    ['Kim', 'Hasn’t opened it yet', true, true],
  ]);
  assert.equal(db.prepare('select count(*) n from review_shares').get().n, 1, 'one share, two people');
  await fits(hq, BOX, 'the share box with two people');
  await shot(hq, 'share-two');
  // each one's Send link hands the share sheet their own link
  const links = {};
  for (const name of ['Sam', 'Kim']) {
    await hq.click(`${BOX} [data-send-link="${name}"]`);
    await hq.waitForFunction(n => window.shared.length === n, Object.keys(links).length + 1);
    const link = await shared(hq);
    assert.match(link, /^https:\/\/hq\.company\.test\/guest\/[\w-]{43}$/);
    links[name] = link;
  }
  assert.notEqual(links.Sam, links.Kim);

  // ---- Sam: a note, Send my notes; nothing goes to the owner while Kim hasn't sent hers
  const sam = await reviewer(links.Sam, 'sam@example.org', 'The headline is lovely, but where do I start?');
  await shot(sam, 'note');
  await sendMine(sam, 'Sam', shot);
  assert.deepEqual(outsideJobs(), [], 'nothing queued while Kim has not sent hers');
  // nothing else: another preview host and HQ send Sam to the board's login
  await sam.goto('https://cycles.preview.company.test/');
  assert.equal(new URL(sam.url()).pathname, '/login');

  // ---- the board's Reviews: the share with its people, not the note; Invite and Remove there too
  await hq.click('#viewer [data-close]');
  await hq.click('#btn-computer');
  await hq.click('[data-app=notes]');
  // (Reviews opens on My notes, the board's own: the share is under Shared, folded to one line)
  await hq.waitForSelector('[data-shown=mine][aria-checked=true]');
  assert.equal(await hq.textContent('[data-shown=shared] i'), '1');
  assert.equal(!!(await hq.$('section.share')), false, 'no share among My notes');
  assert.equal(await hq.$$eval('[data-note]', b => b.length), 0, "the outsiders' notes are not among the board's");
  const SEC = 'section.share';
  await unfold(hq, /^Sam, Kim · 1 note sent · until /);
  await hq.waitForSelector(`${SEC} .invites li`);
  assert.match(await hq.textContent(`${SEC} h3`), /Outside notes on Hello \(platform test\)/);
  assert.deepEqual(await rows(hq, SEC), [
    ['Sam', 'Sent 1 note', true, true],
    ['Kim', 'Hasn’t opened it yet', true, true],
  ]);
  await invite(hq, SEC, 'Lee', 'lee@example.org');
  assert.match(
    await hq.textContent(`${SEC} summary .dim`),
    /^Sam, Kim, Lee · /,
    'the fold line follows, and stays open',
  );
  assert.ok(await hq.$eval(`${SEC} details`, d => d.open));
  assert.deepEqual(
    (await rows(hq, SEC)).map(r => r[0]),
    ['Sam', 'Kim', 'Lee'],
  );
  await fits(hq, SEC, 'Reviews with three people');
  await shot(hq, 'reviews-open');
  await hq.click(`${SEC} [data-remove="Lee"]`);
  assert.equal(await hq.textContent(`${SEC} [data-remove="Lee"]`), 'Tap again to remove');
  await hq.click(`${SEC} [data-remove="Lee"]`);
  await said(hq, SEC, 'Lee removed.');
  assert.deepEqual(
    (await rows(hq, SEC)).map(r => r[0]),
    ['Sam', 'Kim'],
  );
  assert.ok(db.prepare("select removed from review_share_people where guest = 'Lee'").get().removed);
  assert.deepEqual(outsideJobs(), [], 'removing Lee, who sent nothing, leaves the share waiting on Kim');

  // ---- Kim: a note and a general note, Send my notes; now everyone has, so the share ends and the owner's job has both, each signed
  const kim = await reviewer(links.Kim, 'kim@example.org', 'Could the card come in green?');
  await generalNote(kim, 'The pages say thanks in two different ways', 2);
  await shot(kim, 'kim-general-note-sent');
  await sendMine(kim, 'Kim', shot, 2);
  const [job] = outsideJobs();
  assert.ok(job, "the owner's job, once everyone has sent theirs");
  assert.equal(job.agent, 'bolt');
  assert.match(job.title, /^Outside notes on Hello \(platform test\): 3 from Sam and Kim$/);
  assert.match(
    job.prompt,
    /By: Sam \(sam@example\.org\), an outside reviewer\nNote \(typed on the preview page\): The headline is lovely, but where do I start\?/,
  );
  assert.match(
    job.prompt,
    /By: Kim \(kim@example\.org\), an outside reviewer\nNote \(typed on the preview page\): Could the card come in green\?/,
  );
  assert.match(job.prompt, /everyone sent their notes/);
  assert.match(
    job.prompt,
    /By: Kim \(kim@example\.org\), an outside reviewer\nNote \(typed on the preview page\): The pages say thanks in two different ways\nGeneral note: pinned to nothing/,
  );

  // ---- Reviews (at its next refresh): everyone has sent theirs, and until its date whoever did may add more, so the
  // share stays among the open ones, with End now
  await hq.waitForFunction(
    sel => document.querySelector(sel)?.textContent.startsWith('Everyone has sent their notes'),
    `${SEC} > details > .dim`,
    { timeout: 30_000 },
  );
  assert.match(
    await hq.textContent(`${SEC} > details > .dim`),
    new RegExp(
      `^Everyone has sent their notes: 3 notes to Bolt · job #${job.id}\\. Until .*, anyone who sent theirs can add more, which opens it again; End now stops that\\.$`,
    ),
  );
  assert.deepEqual(await rows(hq, SEC), [
    ['Sam', 'Sent 1 note', true, true],
    ['Kim', 'Sent 2 notes', true, true],
  ]);
  assert.equal(await hq.textContent(`${SEC} [data-end]`), 'End now');
  assert.equal(await hq.$('section.shares'), null, 'nothing ended for good');
  await fits(hq, SEC, 'Reviews, everyone sent');
  await shot(hq, 'reviews-everyone-sent');

  // ---- Sam's link: Sent, thank you, and its Add more notes takes them up again; a later note goes as a follow-up
  await sam.goto(links.Sam);
  await sam.waitForSelector('text=Sent, thank you');
  assert.match(
    await sam.textContent('main'),
    /went to Testco’s crew\. Thought of more\? Add more notes opens it again/,
  );
  await fits(sam, '.card', 'the door, sent');
  await shot(sam, 'door-sent');
  await sam.click('a:has-text("Add more notes")');
  await sam.waitForURL(`${PRODUCT}/`);
  await sam.waitForSelector(tool('.fab:not([hidden])'));
  assert.equal(db.prepare('select ended from review_shares').get().ended, null, 'open again');
  await pinNote(sam, 'The footer could say who made it');
  await sendMine(sam, 'Sam');
  const later = outsideJobs().find(j => j.id !== job.id);
  assert.ok(later, 'the later note, once everyone is in again');
  assert.match(later.title, /^Outside notes on Hello \(platform test\): 1 from Sam$/);
  assert.match(later.prompt, /whoever took their notes up again sent them/);
  assert.match(later.prompt, new RegExp(`a follow-up to the first ones \\(job #${job.id}\\)`));
  assert.match(later.prompt, /Note \(typed on the preview page\): The footer could say who made it/);

  // ---- the board's End now (two taps) closes it for good: the ended share and the notes with who wrote them
  await hq.waitForFunction(
    ([sel, n]) => document.querySelector(sel)?.textContent.includes(`job #${n}`),
    [`${SEC} > details > .dim`, later.id],
    { timeout: 30_000 },
  );
  await hq.click(`${SEC} [data-end]`);
  assert.equal(await hq.textContent(`${SEC} [data-end]`), 'Tap again to end it');
  await hq.click(`${SEC} [data-end]`);
  const ended = await hq.waitForSelector('section.shares li.old', { timeout: 30_000 });
  assert.match(
    await ended.textContent(),
    new RegExp(`Hello \\(platform test\\).*4 notes to Bolt · job #${later.id}.*Sam, Kim`, 's'),
  );
  assert.equal(await hq.$(SEC), null, 'no open share left');
  await hq.click('[data-shown=mine]');
  await hq.waitForSelector('section.notes li.old');
  const history = await hq.$$eval('section.notes li.old', li => li.map(x => x.textContent.replace(/\s+/g, ' ')));
  assert.ok(
    history.some(t => /The headline is lovely.*by Sam \(sam@example\.org\)/.test(t)),
    `Sam's note, signed: ${history}`,
  );
  assert.ok(
    history.some(t => /Could the card come in green\?.*by Kim \(kim@example\.org\)/.test(t)),
    `Kim's note, signed: ${history}`,
  );
  assert.ok(
    history.some(t => /The pages say thanks in two different ways.*General note · by Kim/.test(t)),
    `Kim's general note reads as one: ${history}`,
  );
  // on a phone: each ended row shows its words (who was on the share, the note), not just its by-line, and fits its box
  const clipped = () =>
    hq.$$eval('section.shares li.old, section.notes li.old', li =>
      li
        .filter(x => {
          const b = x.querySelector('b');
          return b.clientWidth < Math.min(b.scrollWidth, 120) || x.scrollWidth > x.clientWidth;
        })
        .map(x => x.textContent.replace(/\s+/g, ' ').trim()),
    );
  assert.deepEqual(await clipped(), [], 'ended rows readable on a phone');
  // (the ended share, under Shared)
  await hq.click('[data-shown=shared]');
  await hq.waitForSelector('section.shares li.old');
  assert.deepEqual(await clipped(), [], 'ended shares readable on a phone');
  await hq.$eval('section.shares', s => s.scrollIntoView({ block: 'start' }));
  await shot(hq, 'reviews-ended');
  // and their ways in have closed; Kim's link says why
  for (const page of [sam, kim]) {
    await page.goto(`${PRODUCT}/`);
    assert.equal(new URL(page.url()).pathname, '/login');
  }
  await kim.goto(links.Kim);
  assert.equal(await kim.textContent('h1'), 'These notes were sent and this invite has ended.');

  // ---- a deck, view only, for Robin: no review mode, and the deck's demo opens on its own host
  await hq.evaluate(href => {
    const a = document.createElement('a');
    a.href = href;
    document.body.append(a);
    a.click();
    a.remove();
  }, 'https://cycles.preview.company.test/2026-03-03-deck/presentation/');
  await hq.waitForSelector('#viewer .bar .pin:not([hidden])', { timeout: 15_000 });
  await hq.click('#viewer .bar .share');
  await hq.waitForSelector(`${BOX} [data-kind="view"]`);
  assert.equal(await hq.$(`${BOX} [data-kind="tester"]`), null, 'to try out: on the shop’s preview only');
  await hq.click(`${BOX} [data-kind="view"]`);
  assert.equal(await hq.textContent(`${BOX} > b`), 'View only');
  // Recent: everyone shared with lately, the latest first; a tap invites Sam again by name alone, at the address he had
  assert.deepEqual(await hq.$$eval(`${BOX} .again button`, b => b.map(x => x.textContent)), ['Lee', 'Kim', 'Sam']);
  await fits(hq, BOX, 'the share box with Recent');
  await shot(hq, 'share-recent');
  await hq.click(`${BOX} [data-again="Sam"]`);
  await said(hq, BOX, 'Sam invited. Send link sends them theirs.');
  await invite(hq, BOX, 'Robin', 'robin@example.org');
  assert.match(await hq.textContent(`${BOX} .dim`), /^Until .*They see it as it is: no notes, nothing to answer\.$/);
  assert.deepEqual(await rows(hq, BOX), [
    ['Sam', 'Hasn’t opened it yet', true, true],
    ['Robin', 'Hasn’t opened it yet', true, true],
  ]);
  assert.equal(await hq.textContent(`${BOX} li:first-child .at`), 's••••@example.org');
  assert.deepEqual(await hq.$$eval(`${BOX} .again button`, b => b.map(x => x.textContent)), ['Lee', 'Kim']);
  // the plus on Sam's name: his title, a badge on his row, the board's own (Robin's row keeps its plus)
  await hq.click(`${BOX} [data-title="Sam"].plus`);
  await hq.fill(`${BOX} .titlefield`, 'UX specialist');
  await hq.press(`${BOX} .titlefield`, 'Enter');
  await hq.waitForSelector(`${BOX} .badge[data-title="Sam"]`);
  assert.equal(await hq.textContent(`${BOX} .badge`), 'UX specialist');
  assert.equal(db.prepare("select title from guests where name = 'Sam'").get().title, 'UX specialist');
  assert.equal(await hq.$$eval(`${BOX} .plus`, b => b.length), 1);
  // his badge opens the same field, the title in it, in the badge's place; Escape leaves it as it was
  await hq.click(`${BOX} .badge`);
  assert.equal(await hq.inputValue(`${BOX} .titlefield`), 'UX specialist');
  assert.equal(await hq.isVisible(`${BOX} .badge`), false);
  await hq.press(`${BOX} .titlefield`, 'Escape');
  assert.equal(await hq.$(`${BOX} .titlefield`), null);
  assert.equal(await hq.isVisible(`${BOX} .badge`), true);
  await fits(hq, BOX, 'the view-only share box');
  await shot(hq, 'share-view-only');
  await hq.click(`${BOX} [data-send-link="Robin"]`);
  await hq.waitForFunction(() => window.shared.length === 3);
  const viewLink = await shared(hq);
  const { page: robin } = await context();
  await robin.goto(viewLink);
  await robin.click('button:has-text("Send the code")');
  await robin.waitForSelector('#code');
  await robin.fill('#code', codeFor('robin@example.org'));
  await robin.click('button:has-text("Open the page")');
  await robin.waitForSelector('text=is sharing 2026-03-03-deck with you');
  assert.doesNotMatch(await robin.textContent('main'), /notes|pin/i);
  await shot(robin, 'door-view-only');
  await robin.click('a:has-text("Open 2026-03-03-deck")');
  await robin.waitForURL('https://cycles.preview.company.test/2026-03-03-deck/presentation/');
  await robin.waitForLoadState('networkidle');
  assert.equal(await robin.$('review-mode'), null, 'no review mode on the deck');
  await robin.click('a:has-text("Try the demo")');
  await robin.waitForURL(`${PRODUCT}/`);
  await robin.waitForSelector('h1:has-text("Hello, whoever you are")');
  await robin.waitForLoadState('networkidle');
  assert.equal(await robin.$('review-mode'), null, 'no review mode on the demo');
  assert.deepEqual(
    (await robin.context().cookies(PRODUCT)).map(c => [c.name, c.domain]),
    [['ps', 'hello.preview.company.test']],
    "the demo's own host-only cookie",
  );
  await shot(robin, 'demo-view-only');
  // nothing the deck doesn't link to
  await robin.goto('https://cycles.preview.company.test/');
  assert.equal(new URL(robin.url()).pathname, '/login');
  await hq.click('#viewer [data-close]');
  await hq.keyboard.press('Escape'); // (Reviews was still open under the viewer)
  await hq.click('#btn-computer');
  await hq.click('[data-app=notes]');
  await unfold(hq, /^Sam, Robin · until /);
  await hq.waitForSelector(`${SEC} .invites li`);
  assert.match(await hq.textContent(`${SEC} h3`), /View only on 2026-03-03-deck/);
  // (Sam, from Recent, with his title)
  assert.deepEqual(await rows(hq, SEC), [
    ['Sam', 'Hasn’t opened it yet', true, true],
    ['Robin', 'Opened it', true, true],
  ]);
  assert.equal(await hq.textContent(`${SEC} .badge`), 'UX specialist');

  // ---- the shop's preview, to try out, for Tess: her door shows a voucher of her own, and the shop opens with the pin
  await hq.keyboard.press('Escape');
  await hq.evaluate(href => {
    const a = document.createElement('a');
    a.href = href;
    document.body.append(a);
    a.click();
    a.remove();
  }, 'https://front.preview.company.test/');
  await hq.waitForSelector('#viewer .bar .pin:not([hidden])', { timeout: 15_000 });
  await hq.click('#viewer .bar .share');
  await hq.waitForSelector(`${BOX} [data-kind="tester"]`);
  await hq.click(`${BOX} [data-kind="tester"]`);
  assert.equal(await hq.textContent(`${BOX} > b`), 'Testers');
  assert.equal(
    await hq.inputValue(`${BOX} form.cap [name=cap]`),
    '50',
    'a voucher pays up to €50 until the board says',
  );
  await invite(hq, BOX, 'Tess', 'tess@example.org');
  assert.match(await hq.textContent(`${BOX} .dim`), /voucher for one free order up to €50, made and sent for real/);
  // the board's amount, set after the invite went out: Tess's voucher pays up to it
  await hq.fill(`${BOX} form.cap [name=cap]`, '45');
  await hq.click(`${BOX} form.cap button`);
  await hq.waitForFunction(
    box => document.querySelector(`${box} .invites .msg`)?.textContent === 'Each voucher now pays up to €45.',
    BOX,
  );
  assert.match(await hq.textContent(`${BOX} .dim`), /voucher for one free order up to €45,/);
  assert.deepEqual(await rows(hq, BOX), [['Tess', 'Hasn’t opened it yet · no order yet', true, true]]);
  await fits(hq, BOX, 'the testers’ share box');
  await shot(hq, 'share-tester');
  await hq.click(`${BOX} [data-send-link="Tess"]`);
  await hq.waitForFunction(() => window.shared.length === 4);
  const testLink = await shared(hq);
  const { page: tess } = await context();
  await tess.goto(testLink);
  await tess.click('button:has-text("Send the code")');
  await tess.waitForSelector('#code');
  await tess.fill('#code', codeFor('tess@example.org'));
  await tess.click('button:has-text("Open the page")');
  await tess.waitForSelector('text=The shop, to try out');
  assert.match(
    await tess.textContent('.voucher'),
    /^Your voucher, for one order up to €45, delivery includedTESTER(-[A-HJ-NP-Z2-9]{4}){3}$/,
  );
  // a greeting, three steps with the voucher in the first, the company's own fourth, then the small line
  assert.equal(await tess.textContent('.intro'), 'Testco’s crew would love you to try The shop before it opens.');
  const steps = await tess.$$eval('ol.steps > li', li =>
    li.map(x =>
      [...x.childNodes]
        .filter(n => !n.classList?.contains('voucherbox'))
        .map(n => n.textContent)
        .join(''),
    ),
  );
  assert.equal(steps.length, 4);
  assert.match(steps[0], /^Look around and order something for real: it’s actually made.*🎁.*basket’s code box\.$/);
  assert.doesNotMatch(steps[0], /\*/);
  assert.equal(
    await tess.textContent('ol.steps > li:first-child strong'),
    'it’s actually made and sent to your address',
  );
  assert.match(steps[1], /red pin.*confirmation page/);
  assert.match(steps[2], /Send my notes/);
  assert.equal(steps[3], 'Tell us how unpacking it went at hello@example.com!');
  assert.ok(await tess.$('ol.steps > li:first-child .voucher'), 'the voucher sits in step 1');
  // under the steps, quieter than them, what happens to their notes
  assert.equal(await tess.textContent('ol.steps + .aside > b'), 'What happens to your notes');
  assert.equal((await tess.$$('.aside li')).length, 3);
  const size = sel => tess.$eval(sel, x => parseFloat(getComputedStyle(x).fontSize));
  assert.ok((await size('.aside li')) < (await size('ol.steps > li')), 'the aside is smaller than the steps');
  assert.match(
    await tess.textContent('.card .small'),
    /^Read the Product safety page before you use what you ordered\. Your notes include your screen size and browser, so we see what you saw\. Open until \d+ \w+ (at )?\d\d:\d\d\.$/,
  );
  await fits(tess, '.card', 'the tester’s door');
  // its copy button copies the code alone and says so for a moment
  await tess.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(testLink).origin });
  const voucherCode = await tess.textContent('.voucher b');
  await tess.tap('button.copy');
  await tess.waitForSelector('button.copy:has-text("Copied")');
  assert.equal(await tess.evaluate(() => navigator.clipboard.readText()), voucherCode);
  await tess.waitForSelector('button.copy:has-text("Copy"):not(:has-text("Copied"))');
  await shot(tess, 'door-tester');
  await tess.setViewportSize({ width: 1280, height: 800 });
  await fits(tess, '.card', 'the tester’s door on a desktop');
  await shot(tess, 'door-tester-desktop');
  await tess.click('a:has-text("Open The shop")');
  await tess.waitForURL('https://front.preview.company.test/');
  await tess.waitForSelector(tool('.fab'));
  // ---- in the tool itself: Tess pins a note and writes a general note; My
  // notes is a sidebar with the pinned one's screenshot, served from HQ's host for her own guest desk session (never
  // the shop's own origin; its code can't read it); she changes the general note's words there, then sends from its
  // foot, and Add more notes right there brings the pin back
  await tess.click(tool('.fab'), { force: true });
  const tessH1 = await tess.locator('h1').boundingBox();
  await tess.mouse.click(tessH1.x + 40, tessH1.y + tessH1.height / 2);
  await tess.waitForSelector(tool('.polaroid canvas')); // (a new mark's screenshot is drawn there)
  await tess.fill(tool('textarea'), 'The headline could be warmer');
  await tess.click(tool('.send'));
  await tess.waitForFunction(
    () => document.querySelector('review-mode').shadowRoot.querySelector('.count').textContent === '1',
    null,
    { timeout: 20_000 },
  );
  await generalNote(tess, 'The privacy pages differ from app to app', 2);
  await tess.click(tool('.more'));
  assert.deepEqual(await items(tess), ['General note', 'My notes', 'Listen as I draw', 'Send my notes']);
  assert.equal(await tess.textContent(tool('.menu .cap')), 'Review · 2 notes to send');
  assert.deepEqual(await tess.evaluate(wrappedMenuLines), [], "Tess's menu, on a desktop");
  await shot(tess, 'menu-tester-desktop');
  await tess.click(tool('[data-list]'));
  await tess.waitForSelector(tool('.side li .shot img'));
  await tess.waitForFunction(
    () => document.querySelector('review-mode').shadowRoot.querySelector('.side .shot img').naturalWidth > 0,
    null,
    { timeout: 10_000 },
  );
  const tessShot = await tess.$eval(tool('.side .shot img'), i => i.src);
  assert.match(
    tessShot,
    /^https:\/\/hq\.company\.test\/guest\/review-shot\/\d+\?v=\d+\.jpg$/,
    "the screenshot comes from HQ's host",
  );
  assert.equal(await tess.$$eval(tool('.side li'), l => l.length), 2);
  assert.equal(await tess.$$eval(tool('.side .shot'), l => l.length), 1, 'the general note has no screenshot');
  // the shop's own code can't read it: no CORS from HQ's host
  assert.equal(
    await tess.evaluate(
      u =>
        fetch(u).then(
          () => 'read',
          () => 'refused',
        ),
      tessShot,
    ),
    'refused',
  );
  // and her link, handed on, is nothing without her session
  const { context: strangerCtx, page: stranger } = await context();
  assert.equal((await stranger.goto(tessShot)).status(), 404, 'her link, without her session, is nothing');
  await strangerCtx.close();
  await shot(tess, 'my-notes-desktop');
  // Change: the pinned note's sheet with its element outlined on the page again
  await tess.click(tool('.side li:has-text("The headline") button:has-text("Change")'));
  await tess.waitForSelector(tool('.sheet:not([hidden]) .polaroid img'));
  assert.ok(
    (await tess.isVisible(tool('.hl'))) && (await tess.isVisible(tool('.redraw'))),
    'the headline outlined, and it can be marked again',
  );
  await tess.waitForTimeout(1500); // (the photo develops)
  await shot(tess, 'change-tester-desktop');
  await tess.click(tool('[data-cancel]'));
  await tess.waitForSelector(tool('.side:not([hidden]) li'));
  await tess.click(tool('.side li:has-text("The privacy pages") button:has-text("Change")'));
  assert.equal(await tess.inputValue(tool('.sheet textarea')), 'The privacy pages differ from app to app');
  await tess.fill(tool('.sheet textarea'), 'The privacy pages differ from app to app: one would do');
  await tess.click(tool('.send'));
  await tess.waitForSelector(tool('.side:not([hidden]) .words:has-text("one would do")'));
  assert.deepEqual(
    db
      .prepare("select note from review_notes where author = 'Tess' order by id")
      .all()
      .map(n => n.note),
    ['The headline could be warmer', 'The privacy pages differ from app to app: one would do'],
  );
  await tess.setViewportSize({ width: 390, height: 844 });
  await shot(tess, 'my-notes-tester-phone');
  await tess.click(tool('.side footer [data-send]'));
  assert.equal(await tess.$eval(tool('.side footer [data-send]'), b => b.firstChild.textContent), 'Tap again to send');
  await tess.click(tool('.side footer [data-send]'));
  await tess.waitForSelector(tool('.tip.show'));
  assert.ok(await tess.isHidden(tool('.side')), 'sent: the sidebar is put away');
  assert.ok(await tess.isHidden(tool('.fab')), 'sent: the pin is away');
  await tess.click(tool('.more'));
  assert.deepEqual(await items(tess), ['Add more notes']);
  await shot(tess, 'menu-tester-sent');
  await tess.click(tool('[data-again]'));
  await tess.waitForSelector(tool('.fab:not([hidden])'));
  assert.equal(await tess.textContent(tool('.more .count')), '2');
  assert.deepEqual(pageErrors.flat(), []);
  console.log(
    'shares-check: two invited from the viewer on a phone, each signs in, pins a note (the second a general note too, from the pin’s menu) and sends it (Send my notes in the menu, in reach, then only Add more notes); nothing queued until both sent, then one job with both signed; Invite and Remove in Reviews; the first’s link takes their notes up again and a later note goes as a follow-up, until the board’s End now; the ended share and the signed notes listed; a deck shared view only opens its demo on the product host, without review mode; the shop shared to try out, its vouchers’ amount changed after the invite, gives the tester a greeting and four steps on her door (one bold part, the company’s own last) and a quieter aside on her notes, her voucher up to it in the first with a copy button, then opens with the pin; her pinned note and general note in the My notes sidebar (the screenshot from HQ’s host, unreadable by the page), the general one changed there and both sent from its foot, and taken up again there',
  );
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await browser.close();
  process.exit(); // (the coordinator's timers would keep it running)
}
