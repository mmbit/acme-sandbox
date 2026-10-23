#!/usr/bin/env node
// HQ-OS › Care in a real browser: customer text
// stays text, Ask for changes and the redraft that comes back, a draft's translation, a claim's email to the supplier with its
// photos, Send → Sent with Undo, the busy switch, a bug report's picture only as an <img>, a health case with no AI draft,
// the desk phone's Care line, and nothing off the screen on a phone, a tablet and a small laptop. Care ›
// Numbers: from the list and from a Numbers dashboard's chat line and back, the app and Live · Preview switches, "not
// counted yet" never shown as 0, and its strings as text.
// An email's text in Care and in Mail, compact and a long link short; an email's card back to Mail, and Settings › Care's senders marked not
// customers. A claim a new one waits on: the supplier's answer, noted by the board.
// A company's own button on a case: under the reply, refused in words, then done.
// Without the remedies slot: no list of every remedy, no money owed.
// A case deleted at the customer's request (the confirm step, then gone; Find a case says so), and a bug card with no reply
// address and no Send, linking its email to a person. Held orders: their words, Release, Refuse and Undo.
//   node platform/hq/care-check.mjs        (screenshots go to a temp folder, printed at the end)
// Part one runs HQ in dev mode on mock/care*.json (its mock/brand.json says the company runs care); part two on a fake /api
// (not dev mode), for what only the real routes show: the picture's address, the coordinator's refusals in its own words,
// no email key, and no remedies slot.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from './serve.mjs';
import { playwright, openPage, until } from '../../shared/browser/browser.mjs';

const XSS = '<img src=x onerror=alert(1)>';
const shots = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'care-check-'));
const server = await serve(), base = `http://localhost:${server.address().port}`;
const browser = await playwright().chromium.launch();

async function open(viewport, api) {
  const opened = await openPage(browser, { viewport });
  if (api) await opened.context.route(`${base}/api/**`, api);
  await opened.page.goto(`${base}/?intro=0`);
  await until(opened.page, '#loading.gone');
  return opened;
}
const desk = (page, fn, ...a) => page.evaluate(([fn, a]) => import('/shell/desk.js').then(m => m[fn](...a)), [fn, a]);
const care = async page => { await desk(page, 'openComputer', 'care'); await page.waitForSelector('.cr .cr-sec'); };
const card = async (page, id) => { await page.click(`[data-card="${id}"]`); await page.waitForSelector('.cr-card'); };
// a list row: its words, icon and links, in a box under its button (prose.js covered) or in the button itself
const row = id => `.cr-row:is([data-card="${id}"], :has(> [data-card="${id}"]))`;
// a tap where a finger lands, on whatever is on top there
const tapOn = async (page, sel) => { await page.locator(sel).scrollIntoViewIfNeeded(); const b = await page.locator(sel).boundingBox(); await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); };
// Settings › Care: Settings' list, then its Care row (force: away from a field with text in it)
const settingsCare = async (page, force = false) => { await desk(page, 'openComputer', 'settings', { force }); await page.click('[data-section=care]'); await page.waitForSelector('#care-name'); };
// customer text shows as itself, and nothing in it became an element
async function textOnly(page, where) {
  assert.equal(await page.locator('img[src="x"], [onerror]').count(), 0, `${where}: an element came out of customer text`);
  assert.ok((await page.textContent('#crt')).includes(XSS), `${where}: the words should show as text`);
}
// nothing runs off the side of the screen, and the screen itself doesn't scroll sideways
async function fits(page, where) {
  const over = await page.evaluate(() => {
    const w = document.documentElement.clientWidth, s = document.querySelector('#crt, #phone-screen');
    // (an element cut off inside a box that clips it, like a long crumb's ellipsis, isn't off the screen: the box is checked)
    const clipped = e => { for (let p = e.parentElement; p; p = p.parentElement) if (['hidden', 'clip'].includes(getComputedStyle(p).overflowX)) return true; return false; };
    const out = [...document.querySelectorAll('#tool *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && (r.right > w + 0.5 || r.left < -0.5) && !clipped(e); });
    return { out: out.slice(0, 3).map(e => `${e.tagName.toLowerCase()}.${e.className}`), sideways: s.scrollWidth > s.clientWidth + 1 };
  });
  assert.deepEqual(over, { out: [], sideways: false }, `${where}: something runs off the screen`);
}
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) });
const crumbIs = async (page, re) => assert.match(await page.textContent('.device header b'), re);
// Care › Numbers on one app: picked in the app switch if it isn't showing
async function careNumbers(page, slug) {
  await care(page); await page.click('[data-cr-numbers]'); await page.waitForSelector('.cn .cn-switch, .cn .cn-head');
  if (slug && await page.getAttribute(`[data-cn-app="${slug}"]`, 'aria-checked') !== 'true') {
    await page.click(`[data-cn-app="${slug}"]`); await page.waitForSelector(`[data-cn-app="${slug}"][aria-checked=true]`);
  }
}
// An email as Care and Mail show it (emailtext.js): runs of empty and spacer-only lines, then a 2,000-character link. Each run
// shows as one empty line, and the link as its host and the start of its path, opening the whole address.
const LINK = `https://auth.openai.com/u/login/identifier?state=${'hKFo2SBxbXRoeVNDZ0dZWjJ4M0VY'.repeat(80)}`.slice(0, 2000);
const SPACED = ['Your sign-in link', '', '\u00a0', '', '\u200b \u00a0', '', '', 'Tap to sign in:', LINK, '', '\u00a0', '\u00a0', '', 'Thanks'].join('\n');
async function emailShown(page, sel, where) {
  const { text, links } = await page.$eval(sel, e => ({ text: e.textContent, links: [...e.querySelectorAll('a')].map(a => ({ shown: a.textContent, href: a.href })) }));
  assert.doesNotMatch(text, /\n[\s\u00a0\u200b]*\n[\s\u00a0\u200b]*\n/, `${where}: a run of empty lines`);
  assert.equal(links.length, 1); assert.equal(links[0].href, LINK, `${where}: the link goes to the whole address`);
  assert.ok(links[0].shown.startsWith('auth.openai.com/') && links[0].shown.length <= 60, `${where}: the long link shows short (${links[0].shown.length})`);
  const [tab] = await Promise.all([page.waitForEvent('popup'), page.click(`${sel} a`)]);
  await tab.waitForLoadState(); assert.equal(tab.url(), LINK, `${where}: a tap opens the whole address`); await tab.close();
  await fits(page, where);
}

// ---------------------------------------------------------------- part one: dev mode, the board's flow on a phone
{
  const { context, page, errors } = await open({ width: 390, height: 844 });
  // the home screen: Care with its count
  await desk(page, 'openComputer');
  await page.waitForSelector('[data-app=care]');
  await page.waitForSelector('.apps li.has-count .count');
  await page.click('[data-app=care]');
  await page.waitForSelector('.cr .cr-sec');
  assert.match(await page.textContent('.device header b'), /Care/);
  await textOnly(page, 'the list');

  // the busy switch: Off, and it says so
  await page.click('[data-busy=off]');
  await page.waitForSelector('[data-busy=off][aria-checked=true]');
  assert.match(await page.textContent('.cr-busy .state'), /Off now/);
  await page.click('[data-busy=auto]');
  await page.waitForSelector('[data-busy=auto][aria-checked=true]');

  // each row opens its own case from its words and its icon, its job link opens that job, and the controls around the
  // rows stay their own
  for (const [id, cs] of [[11, 'H-1001'], [14, 'H-1004'], [17, 'H-1007']]) for (const part of ['.t b', '.ic']) {
    await tapOn(page, `${row(id)} ${part}`);
    await page.waitForSelector('.cr-card');
    assert.match(await page.textContent('.cr-card .cr-h span'), new RegExp(`^${cs} `), `row ${id}'s ${part} opens its case`);
    await care(page); await page.waitForSelector('.cr-list');
  }
  assert.deepEqual(await page.$$eval(`${row(14)} a.job-link`, a => a.map(e => e.textContent)), ['PW-REPLY']);
  const onTop = sel => page.$eval(sel, e => { e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return e.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)); });
  for (const sel of [`${row(14)} a.job-link`, '[data-busy=on]', '.cr-find input', '.cr-sec h3']) assert.ok(await onTop(sel), `${sel} is under no row's button`);
  assert.equal(await page.getAttribute(`${row(14)} a.job-link`, 'href'), '/?open=jobs&job=4321');
  await tapOn(page, `${row(14)} a.job-link`);
  await page.waitForFunction(() => !document.querySelector('#projects').hidden);
  assert.equal(await page.locator('.cr-card').count(), 0, 'the job link opens the job, not the case');
  await page.evaluate(() => import('/shell/projects.js').then(m => m.closeProjects()));
  await page.waitForFunction(() => document.querySelector('#projects').hidden);
  await care(page);

  // a card: the words, a fact and a chat line of markup are text
  await card(page, 12);
  await textOnly(page, 'the card');
  for (const sel of ['.cr-words', '.cr-facts', '.cr-lines']) assert.ok((await page.textContent(sel)).includes(XSS), `${sel} shows the markup as text`);
  await shot(page, 'card-phone');

  // Ask for changes: while the team redrafts, the draft isn't a field (nothing to overwrite) and the list says so; the
  // redraft comes back to the card, and "Back to the text before" undoes it
  await page.click('[data-ask]');
  await page.fill('#cr-ask', 'warmer, and say when it arrives');
  await page.click('[data-ask-go]');
  await page.waitForSelector('.cr-asked');
  assert.match(await page.textContent('.cr-asked'), /You asked for: .*warmer, and say when it arrives/);
  assert.equal(await page.locator('#cr-draft, [data-send]').count(), 0, 'no field and no Send while it is redrafted');
  assert.match(await page.textContent('.cr-by'), /The team is redrafting it/);
  await page.click('[data-later]');
  await page.waitForSelector('[data-card="12"]');
  assert.match(await page.textContent(row(12)), /Redrafting as you asked/);
  await page.waitForTimeout(1700);
  await card(page, 12);
  assert.match(await page.inputValue('#cr-draft'), /Redrafted as you asked: warmer, and say when it arrives/);
  assert.match(await page.textContent('.cr-lines'), /Redrafted as you asked: “warmer, and say when it arrives”/);
  await page.click('[data-back]');
  await page.waitForFunction(() => document.querySelector('#cr-draft')?.value === '');
  assert.equal(await page.locator('[data-back]').count(), 0);

  // Send: an empty reply is refused here; with no name for the sign-off, it asks for one; then Sent, with Undo counting down
  await page.click('[data-send]');
  assert.match(await page.textContent('.cr-msg'), /empty/);
  await page.fill('#cr-draft', 'Hello! <b>Yes</b>, it can go to Belgium.');
  await page.click('[data-send]');
  await page.waitForSelector('#cr-name');
  assert.match(await page.textContent('.cr-naming'), /name for the sign-off is missing/);
  await page.fill('#cr-name', 'Sam Example');
  await page.click('[data-name-send]');
  await page.waitForSelector('.cr-sent [data-undo]');
  const first = Number(await page.textContent('[data-undo-n]'));
  assert.ok(first >= 9 && first <= 10, `Undo starts at 10 s (${first})`);
  await page.waitForTimeout(1300);
  assert.ok(Number(await page.textContent('[data-undo-n]')) < first, 'Undo counts down');
  assert.match(await page.textContent('.cr-draft .sign'), /Sam Example/);
  await shot(page, 'sent-phone');
  // Undo: back on the card, the reply as it was
  await page.click('[data-undo]');
  await page.waitForSelector('#cr-draft');
  assert.equal(await page.inputValue('#cr-draft'), 'Hello! <b>Yes</b>, it can go to Belgium.');
  // send it for real: after the 10 s it's Sent, with no Undo
  await page.click('[data-send]');
  await page.waitForSelector('.cr-sent [data-undo]');
  await page.waitForSelector('.cr-banner.done', { timeout: 15_000 });
  assert.match(await page.textContent('.cr-banner.done'), /Sent/);
  assert.equal(await page.locator('[data-undo]').count(), 0);
  await page.click('[data-home]');
  await page.waitForSelector('.cr .cr-sec');
  assert.equal(await page.locator('.cr-sec.replies [data-card="12"]').count(), 0, 'a sent card leaves the list');

  // the email service didn't answer: Send again puts the reply back to send; nothing is resent by itself
  await card(page, 13);
  assert.match(await page.textContent('.cr-banner.warn'), /may or may not have gone/);
  await page.click('[data-unsure="0"]');
  await page.waitForSelector('#cr-draft');
  await page.click('[data-home]'); await page.waitForSelector('.cr .cr-sec');

  // a draft in another language: its translation under it, folded, saying only that text goes out
  await card(page, 17);
  await page.click('.cr-tr summary');
  assert.match(await page.textContent('.cr-tr'), /How annoying!.*Only the NL text above goes out/s);
  await page.click('[data-home]'); await page.waitForSelector('.cr .cr-sec');

  // a claim: in its own section, its email to the supplier with the photos as images (never links), the deadline as
  // words, no Ask for changes; Send names the supplier and goes there
  assert.match(await page.textContent('.cr-sec.claims'), /Claims to send to Printco · 1.*send by/s);
  await card(page, 16);
  assert.match(await page.textContent('.cr-draft h4'), /Email to Printco.*by email to claims@printco\.example/);
  assert.match(await page.textContent('.cr-facts'), /Claim deadline\s*safe by Thu 8 Oct · likely Tue 13 Oct/);
  assert.equal(await page.locator('.cr-photos img').count(), 2);
  assert.equal(await page.locator('.cr-photos a').count(), 0, 'a photo is never a link');
  await page.click('[data-photo="LT-7Q2W-1-box.jpg"]');
  await page.waitForSelector('.cr-photos li.big');
  assert.equal(await page.locator('[data-ask]').count(), 0, 'the team doesn’t redraft a claim’s emails');
  assert.match(await page.textContent('.cr-by'), /with its 2 photos attached/);
  assert.equal(await page.getAttribute('[data-to=partner]', 'aria-checked'), 'true');
  assert.match(await page.textContent('[data-send]'), /Send to Printco/);
  await page.click('[data-send]');
  await page.waitForSelector('.cr-sent');
  assert.match(await page.textContent('.cr-sent'), /Sent to claims@printco\.example/);
  await page.click('[data-undo]'); await page.waitForSelector('#cr-draft');
  // turned to the customer, still no Ask for changes (the team would redraft it as the supplier’s email)
  await page.click('[data-to=customer]'); await page.waitForSelector('[data-to=customer][aria-checked=true]');
  assert.match(await page.textContent('[data-send]'), /Send by email/);
  assert.equal(await page.locator('[data-ask]').count(), 0, 'nor its reply to the customer');
  await page.click('[data-to=partner]'); await page.waitForSelector('[data-to=partner][aria-checked=true]');
  await page.click('[data-home]'); await page.waitForSelector('.cr .cr-sec');

  // a health case (the customer sent a health detail to a person): it says no AI drafts it, there's no Ask for changes,
  // the customer's message is marked as theirs to a person, and the sign-off names no AI (job #3766)
  assert.match(await page.textContent(row(22)), /Health detail: no AI/);
  await card(page, 22);
  assert.match(await page.textContent('.cr-by'), /Health detail: written by a person, no AI draft/);
  assert.equal(await page.locator('[data-ask]').count(), 0, 'no AI redrafts a health case');
  assert.equal(await page.inputValue('#cr-draft'), '', 'no draft: the board writes it');
  assert.match(await page.textContent('.cr-lines .ln:last-child .meta'), /sent to a person from the health card/);
  assert.equal(await page.locator('.cr-lines .meta .health').count(), 1, 'only that message is marked');
  assert.match(await page.textContent('.cr-draft .sign'), /^Written and sent by /);
  await page.click('[data-home]'); await page.waitForSelector('.cr .cr-sec');

  // a bug report: the log line of markup is a log line, the picture an <img> (dev mode: the mock picture)
  await card(page, 15);
  await textOnly(page, 'the bug card');
  assert.ok((await page.textContent('.cr-log')).includes(XSS));
  assert.equal(await page.locator('.cr-pic img').count(), 1);
  assert.equal(await page.locator('.cr-pic a, .cr-bundle a').count(), 0, 'the picture is never a link');
  assert.match(await page.textContent('.cr-acts.bug'), /Fixed.*Hand to Example Owner/);
  // no reply address and nothing to send on a bug: its email to a person (H-1003) is where a reply goes, a tap away
  assert.equal(await page.locator('[data-send], [data-ask], #cr-draft').count(), 0, 'no reply on a bug card');
  assert.ok(!(await page.textContent('.cr-card')).includes('pat@example.com'));
  await page.click('[data-handoff]');
  await until(page, '.toast:last-child', /job DUREK/);
  await page.waitForSelector('.cr-banner, .cr-acts.bug');
  await page.click('[data-open-card="13"]');
  await page.waitForFunction(() => / › H-1003$/.test(document.querySelector('.device header b span')?.textContent ?? ''));
  await page.click('[data-home]'); await page.waitForSelector('.cr .cr-sec');
  assert.match(await page.textContent(row(15)), /Handed on \(job DUREK\)/);

  // feedback the helper passed on: its own section, a note in the helper's words, nobody to reply to, Close where a reply would be
  assert.match(await page.textContent('.cr-sec.feedback'), /Feedback passed on · 1/);
  assert.equal(await page.locator('.cr-sec.replies [data-card="24"]').count(), 0, 'not a reply anyone waits on');
  await card(page, 24);
  await textOnly(page, 'the feedback card');
  assert.match(await page.textContent('.cr-card .cr-h b'), /^Feedback$/);
  assert.match(await page.textContent('.cr-words h4'), /In the helper’s words/);
  assert.match(await page.textContent('.cr-facts'), /None: written in general words, refused with an email address or a phone or order number in it/);
  assert.equal(await page.locator('[data-send], [data-ask], #cr-draft').count(), 0, 'no reply on a note');
  assert.equal(await page.locator('.cr-more [data-close-card]').count(), 0, 'Close is not under More');
  await page.click('.cr-acts [data-close-card]');
  await page.waitForSelector('.cr .cr-sec');
  assert.equal(await page.locator('.cr-sec.feedback').count(), 0, 'closed: the section goes');

  // the customer asked us to delete their case: More › Delete, a confirm step that says what goes (Keep it changes
  // nothing), then it's gone, and Find a case says what became of it
  await card(page, 17);
  await page.click('.cr-more summary'); await page.click('[data-erase]');
  await page.waitForSelector('.cr-erase');
  assert.ok((await page.textContent('.cr-erase')).includes('H-1007'), 'the step names the case');
  await page.waitForTimeout(300); await fits(page, 'the delete step'); await shot(page, 'delete-step');
  await page.click('[data-erase-cancel]'); await page.waitForSelector('[data-erase]');
  await page.click('[data-erase]'); await page.click('[data-erase-go]');
  await page.waitForSelector('.cr .cr-sec');
  assert.equal(await page.locator('[data-card="17"]').count(), 0, 'gone from the list');
  await page.fill('#cr-find', 'h1007'); await page.click('.cr-find button');
  await page.waitForFunction(() => /H-1007 was deleted at the customer’s request: only its reference is kept/.test(document.querySelector('.cr-find + .cr-msg')?.textContent ?? ''));
  await page.fill('#cr-find', '1001'); await page.press('#cr-find', 'Enter');
  await page.waitForFunction(() => / › H-1001$/.test(document.querySelector('.device header b span')?.textContent ?? ''));

  // an email line opens Mail at that message
  await page.click('[data-home]');
  await card(page, 11);
  await page.click('[data-mail="1"]');
  await page.waitForSelector('details[data-mail="1"][open]');
  assert.match(await page.textContent('.device header b'), /Mail/);

  // a remedy: Approve in one tap, and it's gone
  await care(page);
  const remedies = await page.locator('.cr-sec.remedies .cr-remedy').count();
  await page.click('.cr-sec.remedies .cr-remedy[data-remedy="902"] [data-approve]');
  await page.waitForFunction(n => document.querySelectorAll('.cr-sec.remedies .cr-remedy').length === n - 1 || (n === 1 && !document.querySelector('.cr-sec.remedies')), remedies);

  // Sent and Every remedy load when opened, a page at a time
  await page.click('details[data-fold=sent] summary');
  await page.waitForSelector('details[data-fold=sent] .cr-row');
  await page.click('details[data-fold=remedies] summary');
  await page.waitForSelector('details[data-fold=remedies] .cr-rows li');
  await page.click('[data-older=remedies]');
  await page.waitForFunction(() => document.querySelectorAll('details[data-fold=remedies] .cr-rows li').length > 2);
  await textOnly(page, 'every remedy');

  // held orders: what's printed on each as text, Release with Undo until its app
  // has read the answer, Refuse, and an app that hasn't checked in for a while
  await care(page);
  const held = page.locator('.cr-held'), pip = held.first(), lamp = held.nth(1);
  assert.equal(await held.count(), 2);
  assert.match(await pip.textContent(), /“Pip & Grumbleguts · 14 May · Lindelaan 12 · Utrecht”\s*Pinwheel · Kite, printed sail · order PW-7K2Q\s*Held: its words hit the word check · Paid/);
  assert.ok((await lamp.textContent()).includes('“<b>Bram</b> <img src=x onerror=alert(1)>”'), 'the words show as text');
  assert.ok((await lamp.textContent()).includes('Held: its run was stopped <i>while</i> the shop was closed'), 'and why, as text');
  assert.equal(await page.locator('.cr-held img, .cr-held .t b b, .cr-held i').count(), 0, 'no element came out of the words');
  assert.match(await lamp.textContent(), /test mode.*Lanternly hasn’t checked in for over 10 minutes, so it won’t hear an answer until it’s back/s);
  assert.match(await page.textContent('[data-jump=held]'), /^2\s*held$/);
  await pip.locator('[data-release]').click();
  await pip.locator('[data-undo]').waitFor();
  assert.match(await pip.textContent(), /Released: it goes on to the printer at Pinwheel’s next check, usually within a minute\./);
  assert.match(await page.textContent('[data-jump=held]'), /^1\s*held$/);
  await pip.locator('[data-undo]').click();
  await pip.locator('[data-release]').waitFor();
  await lamp.locator('[data-refuse]').click();
  await lamp.locator('[data-undo]').waitFor();
  assert.match(await lamp.textContent(), /Refused: it’s to be cancelled and refunded in full at Lanternly’s next check.*so your answer waits for it/s);
  await fits(page, 'held orders'); await lamp.scrollIntoViewIfNeeded(); await shot(page, 'held-phone');
  await lamp.locator('[data-undo]').click();
  await lamp.locator('[data-refuse]').waitFor();
  // a tap for words that changed since is turned back, with the words as they are now
  await lamp.evaluate(b => { b.dataset.revision = 'older'; });
  await lamp.locator('[data-release]').click();
  await page.locator('.cr-held').nth(1).getByText('What’s on it changed since you looked').waitFor();
  assert.ok(await page.locator('.cr-held').nth(1).locator('[data-release]').isVisible(), 'not released');

  // the desk phone's line opens Care
  await desk(page, 'openPhone');
  await page.waitForSelector('.care-line');
  assert.match(await page.textContent('.care-line'), /Care: \d+ (reply|replies) to check, 1 claim to send.*, 2 held orders to look at›$/);
  await page.click('.care-line');
  await page.waitForSelector('.cr .cr-sec');

  // an email HQ's own check found a health term in (job #4092): the same health note and tag as a chat's, in its own
  // words; no draft, no translation, no Ask for changes; the sign-off names no AI
  assert.match(await page.textContent(row(23)), /Health detail: no AI/);
  await card(page, 23);
  assert.match(await page.textContent('.cr-by'), /Health detail: written by a person, no AI draft\. It may mention a health detail, so no AI read it/);
  assert.match(await page.textContent('.cr-lines'), /no AI read it: there’s no draft and no translation/);
  assert.equal(await page.locator('[data-ask], .cr-tr').count(), 0, 'no Ask for changes, no translation');
  assert.equal(await page.inputValue('#cr-draft'), '', 'no draft: the board writes it');
  assert.match(await page.textContent('.cr-draft .sign'), /^Geschreven en verstuurd door /);
  await page.click('[data-home]'); await page.waitForSelector('.cr .cr-sec');

  // an email to the company: its words and subject are text, no Ask for changes; "Not a customer: back to Mail" closes it
  assert.match(await page.textContent(row(21)), /An email/);
  assert.ok(await page.$(`${row(21)} .ic svg`), 'its row shows the kind\'s icon');
  await card(page, 21);
  await textOnly(page, 'an email card');
  for (const sel of ['.cr-facts', '.cr-lines']) assert.ok((await page.textContent(sel)).includes(XSS), `${sel} shows the markup as text`);
  assert.equal(await page.locator('[data-ask]').count(), 0, 'no Ask for changes on an email');
  // "Not a customer" sits in More
  assert.equal(await page.locator('.cr-more [data-tomail]').count(), 1, '"Not a customer" is in More, with Close and Delete');
  await page.click('.cr-more summary'); await page.click('[data-tomail]');
  await page.waitForSelector('.cr .cr-sec');
  assert.equal(await page.locator('[data-card="21"]').count(), 0, 'back in Mail: off the list');

  // Care › Numbers, from the list: the first app (not launched, nothing counted yet), then the other in the app switch
  await care(page);
  await page.click('[data-cr-numbers]');
  await page.waitForSelector('.cn .cn-banner');
  await crumbIs(page, /Care › Numbers( › Lanternfold)?$/);
  assert.match(await page.textContent('.cn'), /No numbers yet for Lanternfold’s preview/);
  assert.doesNotMatch(await page.textContent('.cn'), /launched/i, 'no launch notice (board, call #81)');
  assert.equal(await page.locator('[data-cn-mode]').count(), 0, 'no Live switch for an app not launched');
  await page.click('[data-cn-app="pebble-pals"]');
  await page.waitForSelector('[data-cn-app="pebble-pals"][aria-checked=true]');
  await crumbIs(page, /Care › Numbers$/); // (a phone: the app's name is on the screen, not in the header)
  assert.equal(await page.getAttribute('[data-cn-mode=live]', 'aria-checked'), 'true', 'a live app opens on its live numbers');
  // resolved without a person always beside emails to a person, with the reading rule
  assert.match(await page.textContent('.cn-pair'), /Resolved without a person\s*126.*35\.1 per 100.*Emails to a person\s*31.*8\.6 per 100.*if resolved rises while emails fall/s);
  assert.match(await page.textContent('.cn-today'), /Today so far.*not in the numbers above/s);
  assert.match(await page.textContent('.cn-reply'), /aim to reply within 3 working days.*86\.7%.*Busy notice: on now: one has waited/s);
  assert.match(await page.textContent('.cn-questions'), /job TAPIR \(running\), job SUDEK \(queued\), 1 waiting for you here in Care/);
  assert.match(await page.textContent('.cn-words'), /p50 ≤ 2\.5 s\s*the bands can’t tell/);
  assert.equal(await page.locator('.cn-words .cn-bar').count(), 2);
  // the day by day fold: a row a day, a day with nothing as a dash, still open after a redraw
  await page.click('.cn-days summary');
  assert.equal(await page.locator('.cn-table tbody tr').count(), 28);
  assert.equal(await page.locator('.cn-table tr.none').count(), 2);
  // Preview: what care doesn't count yet says so, never a 0
  await page.click('[data-cn-mode=preview]');
  await page.waitForSelector('[data-cn-mode=preview][aria-checked=true]');
  assert.match(await page.textContent('.cn-helped'), /Not counted yet/);
  assert.match(await page.textContent('.cn-outage'), /The provider was down\s*not counted yet.*Past our cap\s*not counted yet/s);
  assert.match(await page.textContent('.cn'), /Preview: the board’s and the team’s own tries, never mixed/);
  assert.ok(await page.locator('.cn-days[open]').count(), 'the fold stays open');
  await fits(page, 'Care › Numbers, preview');
  // back: Numbers → the list
  await page.click('[data-home]');
  await page.waitForSelector('.cr .cr-sec');
  await crumbIs(page, /Care$/);

  // from an app's dashboard in Numbers: its chat line, Care › Numbers in the dashboard's mode, and back to that dashboard
  await desk(page, 'openComputer', 'numbers');
  await page.click('[data-nx-app="lanternfold"]');
  await page.waitForSelector('.nx .tiles');
  assert.equal(await page.locator('.nx .chat').count(), 0, 'no chat line for an app the chat never counted');
  await page.click('[data-home]'); await page.waitForSelector('.nxh');
  await page.click('[data-nx-app="pebble-pals"]');
  await page.waitForSelector('.nx .chat');
  assert.match(await page.textContent('.nx .chat'), /The support chat\s*Conversations\s*\d+\s*Resolved without a person.*per 100\s*Emails to a person/s);
  await page.click('[data-mode=preview]');
  await page.waitForSelector('[data-mode=preview][aria-pressed=true]');
  await page.waitForSelector('.nx:not(.busy) .chat');
  await page.click('[data-nx-care]');
  await page.waitForSelector('.cn .cn-head');
  await crumbIs(page, /Care › Numbers$/);
  assert.match(await page.textContent('.cn > .cap'), /NUMBERS · PEBBLE PALS/);
  assert.equal(await page.getAttribute('[data-cn-mode=preview]', 'aria-checked'), 'true', 'in the dashboard’s mode');
  await page.click('[data-home]');
  await page.waitForSelector('.nx .chat');
  await crumbIs(page, /Numbers › Pebble Pals/);
  assert.equal(await page.getAttribute('[data-mode=preview]', 'aria-pressed'), 'true', 'back on the dashboard as it was');
  await page.click('[data-home]'); await page.waitForSelector('.nxh');

  // Settings › Care: the name on replies, and the senders marked not customers, each with Back to Care; the back arrow
  // goes to Settings' list, then home (the saved name in its field doesn't hold it)
  await settingsCare(page);
  assert.equal(await page.inputValue('#care-name'), 'Sam Example');
  await crumbIs(page, /Settings › Care$/);
  assert.doesNotMatch(await page.textContent('#crt'), /ends with a line/, 'no help text under the name');
  assert.deepEqual(await page.locator('.cr-kept li span').allTextContents(), ['sales@supplier.example', 'news@kites.example', 'sam.k@example.com']);
  await page.click('[data-tocare="sales@supplier.example"]');
  await page.waitForFunction(() => /Back in Care/.test(document.querySelector('[data-kept-msg]')?.textContent ?? ''));
  assert.deepEqual(await page.locator('.cr-kept li span').allTextContents(), ['news@kites.example', 'sam.k@example.com']);
  await fits(page, 'Settings › Care'); await page.evaluate(() => document.querySelector('.cr-kept').scrollIntoView({ block: 'center' })); await shot(page, 'settings-kept-phone');
  await page.click('[data-home]'); await page.waitForSelector('[data-section=care]');
  await crumbIs(page, /Settings$/);
  await page.click('[data-home]'); await page.waitForSelector('.apps');

  assert.deepEqual(errors, []);
  await context.close();
}

// ---------------------------------------------------------------- the three screens: nothing off the side
for (const [name, viewport] of [['phone', { width: 390, height: 844 }], ['tablet', { width: 820, height: 1180 }], ['tablet-sideways', { width: 1180, height: 820 }], ['laptop', { width: 1280, height: 800 }]]) {
  const { context, page, errors } = await open(viewport);
  await care(page);
  await fits(page, `${name}: the list`); await shot(page, `list-${name}`);
  for (const id of [11, 13, 15, 16, 17, 21, 22, 23, 24]) {
    await card(page, id);
    if (id === 11) await page.click('[data-ask]');
    await page.waitForTimeout(100);
    await fits(page, `${name}: card ${id}`); await shot(page, `card${id}-${name}`);
    if (id === 16 || id === 17) { await page.evaluate(() => document.querySelector('.cr-draft').scrollIntoView()); await shot(page, `card${id}-reply-${name}`); }
    // the three buttons keep their words
    if (id === 17) await page.click('.cr-tr summary');
    if (id === 11) for (const b of ['Not now', 'Ask for changes', 'Send by email']) {
      const btn = page.locator('.cr-acts').getByRole('button', { name: b, exact: true });
      assert.ok(await btn.isVisible() && await btn.evaluate(e => e.scrollWidth <= e.clientWidth + 1), `${name}: "${b}" shows whole`);
    }
    await page.click('[data-home]'); await page.waitForSelector('.cr .cr-sec');
  }
  await desk(page, 'openPhone'); await page.waitForSelector('.care-line');
  await page.waitForTimeout(400); await fits(page, `${name}: the phone`); await shot(page, `phone-${name}`);
  // Care › Numbers: each part, the day by day open; a not-launched app with nothing yet; a dashboard's chat line
  await careNumbers(page, 'pebble-pals');
  await page.click('.cn-days summary');
  await fits(page, `${name}: Care › Numbers`);
  // the month's part for HQ's own email drafts, apart (job #4184)
  assert.match(await page.textContent('.cn-meter .keys'), /email drafts €0\.42/, `${name}: the drafts' part has its key`);
  assert.equal(await page.locator('.cn-meter .track .hq').count(), 1, `${name}: and its segment`);
  for (const [part, sel] of [['top', null], ['reply', '.cn-grid'], ['words', '.cn-words'], ['cost', '.cn-cost'], ['days', '.cn-days']]) {
    await page.evaluate(s => s ? document.querySelector(s).scrollIntoView() : document.querySelector('#crt').scrollTo(0, 0), sel);
    await shot(page, `numbers-${part}-${name}`);
  }
  await page.click('[data-cn-app="lanternfold"]'); await page.waitForSelector('[data-cn-app="lanternfold"][aria-checked=true]');
  await fits(page, `${name}: Care › Numbers, nothing yet`); await shot(page, `numbers-empty-${name}`);
  assert.equal(await page.locator('.cn-meter .hq').count(), 0, `${name}: no drafts' spend, no key for it`);
  await desk(page, 'openComputer', 'numbers'); await page.click('[data-nx-app="pebble-pals"]'); await page.waitForSelector('.nx .chat');
  await page.waitForSelector('.nx-sheet:not(.feeding)'); // (the printout has fed out)
  await page.evaluate(() => document.querySelector('.nx .chat').scrollIntoView({ block: 'center' }));
  await fits(page, `${name}: the dashboard's chat line`); await shot(page, `dashboard-chat-${name}`);
  const btn = page.locator('[data-nx-care]');
  assert.ok(await btn.evaluate(e => e.scrollWidth <= e.clientWidth + 1), `${name}: "Care › Numbers ›" shows whole`);
  assert.deepEqual(errors, []);
  await context.close();
}

// ---------------------------------------------------------------- part two: the real routes (not dev mode)
{
  const list = await (await fetch(`${base}/mock/care.json`)).json(), full = await (await fetch(`${base}/mock/care-cards.json`)).json();
  Object.assign(list, { name: 'Sam Example', email: false, counts: { replies: 3, bugs: 1, remedies: 2, owed: 2 } });
  const posts = [];
  // the draft a card is drawn with, which Send carries (`was`)
  const drawn = id => ({ ...list.cards.find(c => c.id === id), ...full[id] }).draft;
  // the draft saves, kept apart from the other posts; `slow`: how long a save's answer takes, as on a slow connection
  const saves = [];
  let slow = 0;
  // Care › Numbers on the real route, every string in it markup: names, the model, why busy, a job's status
  const nm = await (await fetch(`${base}/mock/care-numbers.json`)).json(), asks = [];
  for (const a of nm.apps) a.name = `${a.name} ${XSS}`;
  const dirty = nm.detail['pebble-pals:live'];
  Object.assign(dirty, { name: `Pebble Pals ${XSS}`, model: XSS, busy: { switch: 'on', on: true, why: XSS, held: true }, month: { ...dirty.month, eur: 17.4, app: 12.1, hq: 3.2 } });
  dirty.questions.team[0].status = XSS;
  const numbersRoute = url => {
    const app = url.searchParams.get('app'), mode = url.searchParams.get('mode');
    asks.push(`${app ?? ''}:${mode ?? ''}`);
    if (!app) return { json: { apps: nm.apps } };
    const d = nm.detail[`${app}:${mode ?? nm.apps.find(a => a.slug === app)?.status}`];
    return d ? { json: d } : { status: 404, json: { error: 'no such app' } };
  };
  const { context, page, errors } = await open({ width: 390, height: 844 }, async r => {
    const url = new URL(r.request().url()), path = url.pathname;
    if (path === '/api/org') return r.fulfill({ response: await r.fetch({ url: `${base}/mock/org.json` }) });
    if (path === '/api/requests' || path === '/api/gazette') return r.fulfill({ json: [] });
    if (path === '/api/care') return r.fulfill({ json: list });
    if (path === '/api/care/count') return r.fulfill({ json: list.counts });
    if (path === '/api/care/card' && url.searchParams.has('case')) return r.fulfill({ status: 404, json: { error: `There’s no case ${url.searchParams.get('case')} in Care.` } });
    if (path === '/api/care/erase') { posts.push({ erase: r.request().postDataJSON() }); return r.fulfill({ status: 409, json: { error: 'A reply on this card is on its way: Undo it, or wait until it’s gone, then delete the case. Nothing was deleted.' } }); }
    if (path === '/api/care/numbers') return r.fulfill(numbersRoute(url));
    if (path === '/api/care/card') { const id = Number(url.searchParams.get('id')); return r.fulfill({ json: { ...list.cards.find(c => c.id === id), ...full[id] } }); }
    if (path === '/api/care/picture') return r.fulfill({ response: await r.fetch({ url: `${base}/mock/review-shot.svg` }) });
    if (path === '/api/care/photo') return r.fulfill({ response: await r.fetch({ url: `${base}/mock/care-photo.jpg` }) });
    if (path === '/api/mail') return r.fulfill({ response: await r.fetch({ url: `${base}/mock/mail.json` }) });
    if (path === '/api/mail/one') return r.fulfill({ json: { id: Number(url.searchParams.get('id')), body: SPACED, attachments: '[]' } });
    if (path === '/api/care/claim-answer') { posts.push({ claimAnswer: r.request().postDataJSON() }); full[16].canAnswer = false; return r.fulfill({ json: { ok: true } }); }
    // a company's own button on the case: refused once in the kit's words, then done, its note in the conversation
    if (path === '/api/care/action') {
      posts.push({ action: r.request().postDataJSON() });
      if (posts.filter(p => p.action).length === 1) return r.fulfill({ status: 409, json: { error: 'The letters list isn’t reachable just now: try again in a minute.' } });
      full[11].actions[0].done = true; full[11].lines.push({ id: 21, at: '2026-10-02T11:00:00Z', who: 'note', text: 'You marked: no more letters to this customer.' });
      return r.fulfill({ json: { ok: true } });
    }
    if (path === '/api/care/tomail' || path === '/api/care/tocare') { posts.push({ [path.slice(10)]: r.request().postDataJSON() }); return r.fulfill({ json: { ok: true } }); }
    // a draft save, as the coordinator does it: refused once the card holds another draft than the one the screen showed,
    // else kept
    if (path === '/api/care/draft') {
      const b = r.request().postDataJSON(); saves.push(b);
      if (slow) await new Promise(go => setTimeout(go, slow));
      if (b.was !== (drawn(b.id) ?? '')) return r.fulfill({ status: 409, json: { error: 'The team put a new draft on this card while you had it open: read it first. Nothing was saved.' } });
      full[b.id].draft = b.text;
      return r.fulfill({ json: { ok: true } });
    }
    if (path === '/api/care/send') {
      const b = r.request().postDataJSON(); posts.push(b);
      if (b.was !== (drawn(b.id) ?? '')) return r.fulfill({ status: 409, json: { error: 'The team put a new draft on this card while you had it open: read it first. Yours is under “Back to the text before”. Nothing was sent.' } });
      if (b.id === 16 && full[16].photosDue.length && !b.without) return r.fulfill({ status: 409, json: { error: 'The customer’s photo (label) hasn’t reached HQ yet. Nothing was sent.' } });
      if (b.id === 16 && b.to !== 'partner') return r.fulfill({ status: 409, json: { error: 'This card writes to Printco now, not the customer. Nothing was sent.' } });
      if (full[b.id].lines.some(l => l.id > b.seen)) return r.fulfill({ status: 409, json: { error: 'A new message came in while you wrote: read it first. Your reply is kept; nothing was sent.' } });
      return r.fulfill({ status: 409, json: { error: 'Someone else answered this one a minute ago.' } });
    }
    return r.fulfill({ status: 404, body: '' });
  });
  await care(page);
  // the bug report's picture comes from Care's own route, as an <img>
  await card(page, 15);
  assert.equal(await page.getAttribute('.cr-pic img', 'src'), '/api/care/picture?id=15');
  assert.equal(await page.locator('[data-send]').count(), 0, 'a bug card with to: null has no Send');
  // Delete goes to the coordinator by the card's id; a refusal shows in its own words in the delete step
  await page.click('.cr-more summary'); await page.click('[data-erase]'); await page.click('[data-erase-go]');
  await page.waitForFunction(() => /on its way: Undo it/.test(document.querySelector('.cr-erase .cr-msg')?.textContent ?? ''));
  assert.deepEqual(posts.pop(), { erase: { id: 15 } });
  await page.click('[data-home]');
  // Find a case: the coordinator's words for a case it doesn't have
  await page.fill('#cr-find', 'H-9'); await page.click('.cr-find button');
  await page.waitForFunction(() => /no case H-9 in Care/.test(document.querySelector('.cr-find + .cr-msg')?.textContent ?? ''));
  // a claim's photos come from Care's own route, by card and name
  await card(page, 16);
  assert.equal(await page.getAttribute('.cr-photos img', 'src'), '/api/care/photo?id=16&name=LT-7Q2W-1-box.jpg');
  await page.click('[data-home]');
  // no email key: Send says so plainly and sends nothing
  await card(page, 11);
  await page.click('[data-send]');
  assert.match(await page.textContent('.cr-msg'), /email key isn’t on the server yet, so nothing was sent/);
  assert.equal(posts.length, 0);
  // the customer writes while the board edits (the card isn't redrawn then): Send says what it read up to, the coordinator
  // refuses, and the card shows the new message with the reply as it was edited
  list.email = true;
  await page.click('[data-home]'); await card(page, 11);
  await page.fill('#cr-draft', 'A new kite is on its way today.');
  full[11].lines.push({ id: 20, at: '2026-10-02T10:00:00Z', who: 'customer', text: 'Oh, and the string is missing too.' });
  await page.click('[data-send]');
  await page.waitForFunction(() => /A new message came in/.test(document.querySelector('.cr-msg')?.textContent ?? ''));
  assert.equal(posts.length, 1); assert.equal(posts[0].seen, 4, 'Send says the last line the card showed'); assert.equal(posts[0].to, 'customer', 'and whom it showed it going to');
  assert.equal(posts[0].was, drawn(11) ?? '', 'and the draft it was drawn with');
  assert.match(await page.textContent('.cr-lines'), /the string is missing too/);
  assert.equal(await page.inputValue('#cr-draft'), 'A new kite is on its way today.');
  // read now: a refusal shows in the coordinator's own words
  await page.click('[data-send]');
  await page.waitForFunction(() => /Someone else answered/.test(document.querySelector('.cr-msg')?.textContent ?? ''));
  assert.equal(posts.length, 2); assert.equal(posts[1].seen, 20);
  assert.ok(await page.locator('#cr-draft').isVisible(), 'the reply is still there to send again');
  // the team puts a new draft on the card while the board edits it: Send is refused, and the card shows the team's draft,
  // not the board's text over it
  const before = drawn(11);
  full[11].draft = 'The team’s new reply, after a look at the order.';
  await page.fill('#cr-draft', 'My own words.');
  await page.click('[data-send]');
  await page.waitForFunction(() => /new draft on this card/.test(document.querySelector('.cr-msg')?.textContent ?? ''));
  assert.equal(posts.at(-1).was, before ?? '');
  assert.equal(await page.inputValue('#cr-draft'), 'The team’s new reply, after a look at the order.');
  // an edit, then Send at once on a slow connection: the tap's save goes first, and Send says the draft it left
  slow = 800;
  await page.fill('#cr-draft', 'A new kite today, and the string with it.');
  await page.click('[data-send]');
  await page.waitForFunction(() => /Someone else answered/.test(document.querySelector('.cr-msg')?.textContent ?? ''));
  assert.deepEqual([saves.at(-1).text, posts.at(-1).text, posts.at(-1).was], Array(3).fill('A new kite today, and the string with it.'));
  // Send tapped, and the board leaves for another card while that save is still on its way: the save keeps to its own card,
  // and nothing is sent, least of all the other card's text to this card's customer
  slow = 1500;
  const sent = posts.length, saved = saves.length;
  await page.fill('#cr-draft', 'Words for this card only.');
  await page.click('[data-send]');
  await page.click('[data-later]'); await card(page, 17);
  await page.fill('#cr-draft', 'Words for card 17.');
  await page.waitForTimeout(2_500);
  assert.equal(posts.length, sent, 'nothing sent from a card the board left');
  assert.deepEqual(saves.slice(saved).map(b => [b.id, b.text]), [[11, 'Words for this card only.']]);
  assert.equal(await page.inputValue('#cr-draft'), 'Words for card 17.');
  slow = 0;
  // a claim whose photo hasn't come: the card says so, Send waits for it, and "Send without" says so to the coordinator
  full[16].photosDue = ['label']; full[16].photos = full[16].photos.slice(0, 1);
  await page.click('[data-home]'); await card(page, 16);
  assert.match(await page.textContent('.cr-by'), /with its photo attached\. A photo still on its way \(label\): Send waits for it/);
  await page.click('[data-send]');
  await page.waitForFunction(() => /hasn’t reached HQ yet/.test(document.querySelector('.cr-msg')?.textContent ?? ''));
  assert.equal(posts.at(-1).to, 'partner'); assert.equal(posts.at(-1).without, undefined);
  await page.click('[data-send-without]');
  await page.waitForFunction(() => /Someone else answered/.test(document.querySelector('.cr-msg')?.textContent ?? ''));
  assert.equal(posts.at(-1).without, true); assert.equal(posts.at(-1).to, 'partner');
  await fits(page, 'a claim waiting for a photo'); await shot(page, 'claim-photo-due');
  // a claim a new one waits on: before it went, only "We make it ourselves"; once it went, the supplier's yes too, and the
  // tap tells the coordinator which
  const answers = () => page.locator('[data-claim-answer]').evaluateAll(b => b.map(x => x.dataset.claimAnswer));
  Object.assign(full[16], { canAnswer: true, supplier: 'Printco' });
  await page.click('[data-home]'); await card(page, 16);
  assert.deepEqual(await answers(), ['ours']);
  full[16].claim = { to: 'claims@printco.example', name: 'Printco', sent: '2026-10-02T12:00:00Z' };
  await page.click('[data-home]'); await card(page, 16);
  assert.deepEqual(await answers(), ['supplier', 'ours']);
  assert.match(await page.textContent('.cr-answer'), /Printco’s answer.*Printco makes a new one.*We make it ourselves/s);
  await page.locator('.cr-answer').scrollIntoViewIfNeeded();
  await fits(page, 'a claim a new one waits on'); await shot(page, 'claim-answer');
  await page.click('[data-claim-answer=supplier]');
  await page.waitForFunction(() => !document.querySelector('.cr-answer'));
  assert.deepEqual(posts.at(-1), { claimAnswer: { id: 16, answer: 'supplier', seen: 0 } });   // (seen: the last line it showed, none here)
  // a company's own button on a case: low on the card (under the reply), its hint under it; a refusal in the kit's words
  // under the button; the tap names the card and the button only; once done, the label with a tick and no button
  full[11].actions = [{ id: 'no-letters', label: 'No more letters', done: false, hint: 'They asked us not to write to them again.' }];
  await page.click('[data-home]'); await card(page, 11);
  assert.ok(await page.$eval('.cr-actions', s => !!(document.querySelector('.cr-acts').compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING)), 'under the reply');
  assert.match(await page.textContent('.cr-actions'), /No more letters.*not to write to them again/s);
  await page.locator('.cr-actions').scrollIntoViewIfNeeded();
  await fits(page, 'a case with a button of the company’s'); await shot(page, 'case-action');
  await page.click('[data-case-action=no-letters]');
  await page.waitForFunction(() => /isn’t reachable just now/.test(document.querySelector('.cr-actions .cr-msg')?.textContent ?? ''));
  await page.click('[data-case-action=no-letters]');
  await page.waitForSelector('.cr-actions .done');
  // (to: the address the card's heading named, so a card rematched since is refused)
  const tapped = { action: { id: 11, action: 'no-letters', to: full[11].to } };
  assert.ok(full[11].to, 'the card names its customer');
  assert.deepEqual(posts.filter(p => p.action), [tapped, tapped]);
  assert.equal(await page.locator('[data-case-action], .cr-actions .cr-msg').count(), 0, 'done: no button, the refusal gone');
  assert.match(await page.textContent('.cr-actions .done'), /No more letters\s*done/);
  assert.match(await page.textContent('.cr-lines'), /You marked: no more letters/);
  await page.locator('.cr-actions').scrollIntoViewIfNeeded();
  await fits(page, 'a case with the company’s button done'); await shot(page, 'case-action-done');
  // Care › Numbers: markup from the coordinator shows as text; the month near the cap is gold
  await page.click('[data-home]'); await page.waitForSelector('.cr .cr-sec'); // (a card with text in its draft keeps the computer where it is)
  await careNumbers(page, 'pebble-pals');
  assert.ok(asks.includes('pebble-pals:'), 'an app opens in its own mode (none asked)');
  assert.equal(await page.locator('img[src="x"], [onerror]').count(), 0, 'Care › Numbers: an element came out of the data');
  for (const sel of ['.cn-switch.cn-apps', '.cn > .cap', '.cn-busy', '.cn-questions', '.cn-cost']) assert.ok((await page.textContent(sel)).toLowerCase().includes(XSS.toLowerCase()), `${sel} shows the markup as text`);
  assert.equal(await page.locator('.cn-meter.near').count(), 1, 'past 80% of the cap: gold');
  assert.match(await page.textContent('.cn-meter .keys'), /email drafts €3\.20/);
  assert.match(await page.textContent('.cn-meter .hd'), /every app and the drafts together/);
  assert.match(await page.textContent('.cn-busy'), /On anyway/);
  await fits(page, 'Care › Numbers with markup'); await page.evaluate(() => document.querySelector('.cn-cost').scrollIntoView()); await shot(page, 'numbers-near-cap');
  // an email's text, in Care and then in Mail
  await context.route(/^https:\/\/auth\.openai\.com\//, r => r.fulfill({ contentType: 'text/plain', body: 'signed in' }));
  full[21].lines[0].text = SPACED;
  await page.click('[data-home]'); await card(page, 21);
  await emailShown(page, '.cr-lines .ln.email .txt', 'an email in Care'); await shot(page, 'email-care');
  await page.click('.cr-lines .cr-mail'); await page.waitForSelector('[data-mail="7"][data-loaded]');
  await emailShown(page, '[data-mail="7"] .mailbody', 'an email in Mail'); await shot(page, 'email-mail');
  // an email back to Mail, and an address back to Care
  await care(page); await card(page, 21);
  await page.click('.cr-more summary'); await page.click('[data-tomail]'); // in More
  await page.waitForSelector('.cr .cr-sec');
  assert.deepEqual(posts.at(-1), { tomail: { id: 21 } });
  await settingsCare(page); await page.waitForSelector('[data-tocare]');
  await page.click('[data-tocare="news@kites.example"]');
  await page.waitForFunction(() => /Back in Care/.test(document.querySelector('[data-kept-msg]')?.textContent ?? ''));
  assert.deepEqual(posts.at(-1), { tocare: { address: 'news@kites.example' } });
  // nobody marked: no section, no text about it
  const marked = list.mailOnly; list.mailOnly = [];
  await settingsCare(page);
  assert.equal(await page.locator('.cr-kept').count(), 0); assert.doesNotMatch(await page.textContent('#crt'), /NOT CUSTOMERS|Mail/);
  list.mailOnly = marked;
  // without the remedies slot: the remedies waiting for a tap still show, but no list of every remedy and no money owed
  list.slots = { remedies: false };
  await desk(page, 'openComputer', 'care'); await page.waitForSelector('.cr .cr-sec');   // (Settings' saved name in its field doesn't hold the computer)
  assert.ok(await page.locator('.cr-remedy').count() > 0, 'the remedies waiting for a tap still show');
  assert.equal(await page.locator('[data-fold=remedies], .cr-owed').count(), 0, 'no list of every remedy, no money owed');
  assert.deepEqual(errors, []);
  await context.close();
}

// ---------------------------------------------------------------- part three: every string an attack
// Every string the coordinator sends Care (dates aside) ends in markup, attribute breakers ("> and '>), a javascript:
// link and a web address with attribute breakers in it: the list, the folds, every card with its details open and its forms, and Settings › Care's senders marked not customers. Nothing may become an
// element or an attribute, run, or open a dialog, and an attribute that holds data holds it whole.
{
  const ATTACK = `${XSS}"><svg onload=alert(2)>'><svg onload=alert(3)> javascript:alert(4) \`\${alert(5)}\` https://x.example/'onmouseover=alert(8)'"onfocus=alert(9)`;   // (the link)
  const DATES = new Set(['created', 'since', 'at', 'replyBy', 'sentAt', 'undoUntil', 'placed_at', 'shipped_at', 'month', 'day', 'safe', 'likely', 'status']);
  const poison = (v, k = '') => typeof v === 'string' ? (DATES.has(k) ? v : v + ATTACK) : Array.isArray(v) ? v.map(x => poison(x, k))
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([kk, x]) => [kk, poison(x, kk)])) : v;
  const mock = async f => poison(await (await fetch(`${base}/mock/${f}`)).json());
  const list = await mock('care.json'), full = await mock('care-cards.json'), done = await mock('care-done.json'), every = await mock('care-remedies.json');
  Object.assign(list, { email: true, mailOnly: [`a"><svg onload=alert(6)>@x.example`, 'javascript:alert(7)'] });
  const { context, page, errors } = await open({ width: 1280, height: 900 }, async r => {
    const url = new URL(r.request().url()), path = url.pathname;
    if (path === '/api/org') return r.fulfill({ response: await r.fetch({ url: `${base}/mock/org.json` }) });
    if (path === '/api/requests' || path === '/api/gazette') return r.fulfill({ json: [] });
    if (path === '/api/care') return r.fulfill({ json: list });
    if (path === '/api/care/count') return r.fulfill({ json: { replies: 3, bugs: 1, remedies: 2, owed: 2 } });
    if (path === '/api/care/done') return r.fulfill({ json: done });
    if (path === '/api/care/remedies') return r.fulfill({ json: every });
    if (path === '/api/care/card') { const id = Number(url.searchParams.get('id')); return r.fulfill({ json: { ...list.cards.find(c => c.id === id), ...full[id] } }); }
    if (path === '/api/care/picture') return r.fulfill({ response: await r.fetch({ url: `${base}/mock/review-shot.svg` }) });
    if (path === '/api/care/photo') return r.fulfill({ response: await r.fetch({ url: `${base}/mock/care-photo.jpg` }) });
    if (path.startsWith('/api/care/')) return r.fulfill({ status: 409, json: { error: `Refused. ${ATTACK}` } });
    return r.fulfill({ status: 404, body: '' });
  });
  const inert = async where => assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#tool *')].flatMap(e => [...e.attributes]
    .filter(a => /^on/i.test(a.name) || (/^(href|src|action|formaction|xlink:href)$/i.test(a.name) && /^\s*javascript:/i.test(a.value)))
    .map(a => `${e.tagName.toLowerCase()}[${a.name}]`))), [], `${where}: an attribute came out of the data`);
  await care(page);
  assert.equal(await page.locator('#crt svg[onload], #crt img[src="x"]').count(), 0, 'the list: an element came out of the data');
  assert.ok((await page.textContent('#crt')).includes('"><svg onload=alert(2)>'), 'the list shows the attack as text');
  await page.evaluate(() => document.querySelectorAll('details.cr-fold').forEach(d => { d.open = true; d.dispatchEvent(new Event('toggle')); }));
  await page.waitForFunction(() => !/Opening…/.test(document.querySelector('#crt')?.textContent ?? ''));
  await inert('the list and its folds');
  let cards = 0;
  for (const { id } of list.cards) {
    await desk(page, 'openComputer', 'care', { force: true }); await page.waitForSelector('.cr .cr-sec');
    await card(page, id); cards++;
    await page.evaluate(() => document.querySelectorAll('#crt details').forEach(d => { d.open = true; }));
    await inert(`card ${id}`);
    for (const sel of ['.cr-more summary', '[data-ask]', '[data-send]']) {
      const b = page.locator(sel).first();
      if (await b.count() && await b.isVisible() && await b.isEnabled()) { await b.click(); await page.waitForTimeout(100); await inert(`card ${id}, after ${sel}`); }
    }
  }
  await settingsCare(page, true); await page.waitForSelector('[data-tocare]');
  await inert('Settings › Care');
  assert.deepEqual(await page.$$eval('[data-tocare]', bs => bs.map(b => b.dataset.tocare)), list.mailOnly, 'not customers: each address whole in its attribute');
  assert.deepEqual(errors, [], 'every string an attack: no page error, no dialog');
  assert.equal(cards, list.cards.length);
  await context.close();
}

await browser.close(); server.close();
console.log(`care-check: text stays text (every string an attack too: markup, attribute breakers, javascript: links), Care › Numbers (from the list and a dashboard's chat line, and back), a case deleted at the customer's request (and Find a case), a bug card with no reply address, a feedback note (its section, no reply, Close), Ask for changes and its redraft, a draft's translation, a claim to the supplier with its photos, no remedies slot, an email's text in Care and Mail (spacer lines compact, a 2,000-character link short), an email back to Mail and Settings › Care (its back arrow too; nobody marked: no section), Send → Sent with Undo, a message that came in while writing shown before anything goes, the busy switch, the bug picture, a health case with no AI draft (a chat's and an email's), the phone's line; nothing off-screen at 390, 820, 1180 and 1280 wide. Screenshots: ${shots}`);
