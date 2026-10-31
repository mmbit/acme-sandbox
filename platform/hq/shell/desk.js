// The board's desk, as in-game pixel tools: each overlay does one thing.
//   Phone     open requests, one card at a time, answered in place (a login card opens Seats), and
//             the answered ones, to open their presentations, clips and pictures again
//   Intercom  a directive for the CEO: one line (typed, or held-to-talk and transcribed), optional details
//   Computer  a retro screen: everyone in the building (the directory), the inbox, the review notes waiting for
//             the board, the AI seats, the latest jobs and this device's notifications
import { lasted } from '../../../shared/signs/signs.js';
import { esc, cap, grow, store as saved, roleHtml, stylesheet } from '../util.js';   // (stylesheet).
// (endTip: a tip filed.)
import { endTip, loadRequests, loadLater, snoozeRequest, loadArchive, archivePhoto, answerRequest, removeAddress, previewLink,
  loadChat, sendChat, loadCalls, addCallItem, loadMail, loadMailOne, forwardMail, transcribe, pushKey,
  uploadPhoto, uploadDocument, sendZipChunk, loadZipField, pictureUrl, guestEmail, guestLang, guestRelease, guestRevoke, guestAdd, outboxSend, outboxDiscard, outboxPreview,
  calloutApprove, calloutDecline, calloutNumber,
  loadShares, makeShare, removeFromShare, endShare, setShareCap, loadPeople, setPersonTitle, guestColleagues, loadLanguage, setLanguage } from './data.js';
import { peopleHtml, wirePeople, refused, dot, sameName } from './people.js';
import { sfx, hush } from './audio.js';
import { callAgent, inCall, callInFront, minimiseCall } from './call.js';   // (a call, over whatever is open).
import * as world from '../world/world.js';
import { ago, companyFormats, dayTime, timeOf } from '../world/clock.js';
import { scene, look, pick, lookName, looks, dressed, cover } from './stage.js';   // (cover; looks)
import { toast, flyTo, visitMascot } from './hud.js';
import { openLibraryDoc } from './news.js';   // (Team's Gazette and Library buttons gone)
import { onDirective } from './events.js';
import { record, canRecord, MAX_SECONDS, TRANSCRIBER } from './voice.js';
import { dictate } from './dictate.js';
import { pushState, enablePush, disablePush, testPush } from './push.js';
import { makeAgeKey } from './agekey.js';
import { names, brand, theme, runs } from './brand.js';
import { countBadge, paintComputerCount } from './hud.js';   // (a company app's count on its icon; the computer's)
import { numbers, numbersBack, numbersFor } from './numbers.js';
import { artifactList } from './artifacts.js';
import { openProjects } from './projects.js';
import { closePanel } from './panel.js';
import { onair } from './onair.js';
import { oversight } from './oversight.js';
import { seatSettings, seatsBack, seatsSummary, seatPages } from './seats.js';
import { machineSettings, machinesBack, machinesSummary, machinePages } from './machines.js';
import { seatStatus } from './seatstatus.js';
import { engineMark } from './engine.js';
import { cardOf, unfenced, shownRecommend, docParts, DOC_CODE } from './card.js';   // (docParts, DOC_CODE)
import { PIC, CLIP, deckOf, pairsOf, pictureSrc } from './media.js';
import { viewPictures } from './pictures.js';
import { seen, markSeen } from './seen.js';
import { emailHtml } from './emailtext.js';
import { inputHtml, chips, given } from './questions.js';   // a card's questions, the guest page's engine
import { askAgain } from '/ask.js';   // a button that asks once more (shared/ask/ask.js)
import { prose, fencedLines, linked, bare, BOLD, covered, jobNameLink, jobsIn, withJobLinks } from './prose.js';   // (job links, covered)
import { copyBlocks } from './copy.js';   // (text to paste on a card, lists in its steps)
import { icon } from './icons.js';
import { Tray, shrink } from './tray.js';
import { notes, openReviews, holdReviews } from './reviews.js';   // (the computer's Reviews app)
import { openAt } from './ink/book.js';   // (review mode's Open the book: bookAt.)
import * as notebook from './ink/notebooklink.js';
import { mountStage } from './viewer.js';   // (the viewer's frames)
import { mountPin, pinOn, setPin, tellPin } from './pinsetting.js';   // (Settings › Pin on HQ.)
import { mountTips } from './booktips.js';   // (the tips book)
import { frameMic, helloFrom, stopFrameMic } from './framemic.js';   // (review mode's mic for the viewer's page; helloFrom)
import { tipHtml, cardAbout, wireTip, tipSettings, tipsSummary } from './tipcard.js';
import { voiceSettings, voicesSummary } from './voices.js';
import { intakeCardHtml, wireCards, switchesLine } from './intake.js';
import { ASKS } from './tips.js';

const $ = s => document.querySelector(s);
// The company's own HQ apps: theme/hq.yaml's apps, each kits/<name>/hq/app.js at /kits/<name>/app.js
// (template/kits/README.md), on the computer's home screen in the group it names (homeGroups). One that doesn't
// load is left out, and HQ runs on without it. Loaded once this module has run, never awaited here: an app imports HQ's
// own modules, and some of those import this one. A home screen opened before they came is drawn again with them.
// Care (care.js) is the platform's own app on the same interface, when the company runs the care service, and the
// photo studio's (studio.js), when the company runs the studio.
let own = [], ownDone = false;
const kitApps = (Array.isArray(theme.apps) ? theme.apps : []).filter(n => typeof n === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(n)).map(id => [id, `/kits/${id}/app.js`]);
// (the Sketchbook app is gone: the notebook is the one book.)
const platformApps = [...(runs.care ? [['care', '/shell/care.js']] : []), ...(runs.studio ? [['studio', '/shell/studio.js']] : [])];
const ownLoaded = Promise.resolve().then(() => Promise.all([...platformApps, ...kitApps]
  .map(([id, url]) => import(url).then(mod => mod.app && mod.draw ? { id, mod } : null, e => { console.warn(`[hq] ${url}: its HQ app didn't load`, e); return null; }))))
  .then(list => { own = list.filter(Boolean); ownDone = true; if (own.length && open === 'computer' && tab === 'home') openComputer('home'); });
const ownApp = id => own.find(k => k.id === id);
// For HQ's search (finder.js): the computer's apps as text (id, name, what), and the company's once loaded, each with what
// HQ lends it
export const computerApps = () => [...APPS.map(([id, name, what]) => ({ id, name, what })), ...own.map(k => ({ id: k.id, name: k.mod.app.name, what: k.mod.app.what ?? '' }))];
export const companyApps = () => ownLoaded.then(() => own.map(k => ({ id: k.id, mod: k.mod, hq: hq() })));
// what a company app may do in HQ: open a computer app (Mail at a message: { mail: id }; force: move on from a field with
// text in it, which the app saved first), open one app's dashboard in Numbers with a way back, name an agent, say how long ago
const hq = () => ({ dev: world.dev, open: (which, opts) => openComputer(which, opts), numbers: (app, back) => { numbersFor(app, back); openComputer('numbers'); }, who, ago });
let open = null, idx = 0, tab = 'people', timer = null;
const root = () => $('#tool');
export { callAgent };
// Shared with the projects view
export { ago };
export const who = id => world.agents.get(id)?.data.name || (id ? id[0].toUpperCase() + id.slice(1) : 'Someone');
// someone's engine as its mark, where HQ knows it
const markOf = id => { const engine = world.agents.get(id)?.data.engine; return engine ? engineMark(engine) : ''; };
// times, days and vouchers' euros on the company's clock and in its formats
const euros = n => companyFormats('EUR').money(n, 'en', { unit: 'major', wholeWithoutCents: true });

export function initDesk() {
  // with an on-screen keyboard up, fit the overlay to what's still visible and keep the field in view
  const vv = window.visualViewport, fit = () => { const s = document.documentElement.style; s.setProperty('--vvh', `${vv.height}px`); s.setProperty('--vvt', `${vv.offsetTop}px`); };
  if (vv) { vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); fit(); }
  root().addEventListener('focusin', e => { if (e.target.matches(FIELDS)) setTimeout(() => e.target.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300); });
  // the backdrop closes the overlay only on a press that starts there too: a text selection dragged out of the overlay
  // ends in a click on the backdrop as well
  let onBackdrop = false;
  root().addEventListener('pointerdown', e => { onBackdrop = e.target === root(); });
  root().addEventListener('click', e => { if ((e.target === root() && onBackdrop) || e.target.closest('[data-close]')) closeTool(); });
  // product previews and cycle decks open inside HQ: a browser the link would otherwise go to may not have
  // the board's login (or its passkey), and the preview login goes through HQ's
  document.addEventListener('click', e => {
    const a = e.target.closest('a[href]');
    if (a && !a.dataset.external && PREVIEW.test(a.href)) { e.preventDefault(); openLink(a.href); }
  });
  // a job's number in HQ's words is a link to it (prose.js jobLink), and so is a job's title that a look marks
  // (.job-title): a plain tap or Enter opens it here, before the tap target under
  // it hears it
  const jobLinked = e => {
    const link = e.target.closest?.('a.job-link[data-job], .job-title[data-job]');
    if (!link || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault(); e.stopPropagation();
    openJob(Number(link.dataset.job));
  };
  document.addEventListener('click', jobLinked, true);
  document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches?.('.job-title[data-job]')) jobLinked(e); }, true);
  addEventListener('keydown', e => { if (e.key !== 'Escape') return; if (callInFront()) minimiseCall(); else if (open) closeTool(); });   // (a call in front goes small)
  addEventListener('message', fromViewer);
  // (the viewer's page hears the notebook's moves and may talk back to it.)
  notebook.mountFrames(window, { frames: () => (viewing ? [stagingFrame().contentWindow] : []), trusts: origin => PREVIEW.test(`${origin}/`) });
  followCall();
  loadPin();
  // (a card answered in the book, or the book changed on the store: the cards read again, so one answered there leaves
  // the open list.)
  document.addEventListener('book:changed', refreshRequests);
  document.addEventListener('visibilitychange', () => { if (document.hidden && voice && voice.phase !== 'sending') finishVoice(); });
}
function show(kind, html, force = false) {
  const el = root(), was = open;
  if (was === kind && typing() && !force) return false; // already open with text in it: leave it be (unless a company app asks to move on)
  if (was === 'phone' && kind !== 'phone') forgetAge();
  open = kind; el.hidden = false; el.dataset.kind = kind;
  el.innerHTML = `<div class="device ${kind}" role="dialog" aria-modal="true" data-keep-clear>${html}</div>`;   // (a minimised call steps clear of it: callbubble.js.)
  if (!was) sfx.open(); else sfx.blip();
  clearInterval(timer); timer = null; homeFit?.disconnect(); homeFit = null;   // (homeFit)
  opened(kind);
  return true;
}
// What's open on HQ's page told on the document (hq:open: { open, app }), for a second screen to follow (pair.js).
const opened = kind => document.dispatchEvent(new CustomEvent('hq:open', { detail: { open: kind, ...(kind === 'computer' && { app: tab }) } }));
export const toolOpen = () => !!open;
export const PREVIEW = /^https:\/\/[a-z0-9-]+\.preview\.[a-z0-9.-]+(\/|$)/;   // (exported for calldrive.js)
// The origin of the page in the viewer while review mode runs there (it said hello), or none: what calldrive.js sends to
// and hears from, and no other page the frame may have gone on to.
export const viewerOrigin = () => viewing?.review ?? null;
export const viewerUrl = () => viewing?.url ?? null;   // (the page the viewer opened: calldrive.js.)
export const openLink = url => PREVIEW.test(url) ? openViewer(url) : window.open(url, '_blank', 'noopener');
const PIN = icon('pin');
// A preview in a frame of its own origin: it can't reach HQ's page, and it can't navigate HQ away. Both the
// frame and "Open in browser" get their own one-time sign-in link, so the preview never asks for a login.
// Review mode (shared/review/review.js) runs in the frame once HQ answers its hello; then the bar gets a pin too.
// No microphone for the frame: Chrome keys a frame's microphone to the top page, so with HQ's allowed (the intercom,
// calls) any preview's own code could record the board unasked. Dictation works in "Open in browser", where the
// preview asks for itself, and here by HQ's own mic key laid over the post-it's, which only the board's tap starts
// (framemic.js).
// A deck's "try the preview" button opens its preview here as well, with a way back to the deck.
// Chrome shows no PDF in a sandboxed frame, so the preview hosts answer a PDF the frame loads as a download, which the
// frame allows (infra/products.py, PDF_IN_FRAME): it saves, and the page stays.
// Share makes a link for an outside person to leave notes on this preview, or only see it: shareBox.
// The bar is one slim row, the page's room before all: Back and Close as quiet glyphs, the address as the link that
// opens it in the browser, and what review mode does filled: Note. Review mode's notes go into the board's book.
let viewing = null; // { url, back, review: the frame's origin while review mode runs there, heard: when it last said hello, link: the outside link } (heard)
let staged = null; // the stage's { close, toStaging } (viewer.js.)
// The frame of the page the viewer opened, the one review mode runs in (a live page may sit beside it: viewer.js)
export const stagingFrame = () => $('#viewer .pane.after iframe');
async function openViewer(url, back = null) {
  const v = $('#viewer');
  stopFrameMic(); // (the page before's recording, if any, goes with it)
  const me = viewing = { url, back, review: null, link: null };
  v.innerHTML = `<div class="bar">${back ? '<button class="glyph" data-back aria-label="Back">‹</button>' : ''}
    <a class="where" target="_blank" rel="noopener" data-external="1" title="Open in the browser">${where(url)}</a>
    <button class="pin" hidden aria-label="Pin a note on this page">${PIN}<span>Note</span></button>
    <button class="share" aria-label="Share with an outside person">${SHARE}<span>Share</span></button>
    <button class="glyph" data-close aria-label="Close">×</button></div>
    <div class="sharebox" hidden></div>
    <div class="stage"><div class="head"></div><div class="frames"><div class="pane after" data-side="after"><div class="sized">
      <iframe title="Preview" allow="autoplay; fullscreen; clipboard-write"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"></iframe></div></div></div></div>`;
  if (v.hidden) { v.hidden = false; sfx.blip(); hush(true); cover(true, 'viewer'); coverPin(true); }   // (cover)
  // (the stage: live beside it, device sizes, the notebook over or beside, the QR.)
  staged?.close(); staged = mountStage(v, url);
  const frame = stagingFrame(), out = v.querySelector('.bar .where');
  v.querySelector('[data-close]').onclick = () => { staged?.close(); staged = null; stopFrameMic(); viewing = null; v.hidden = true; v.innerHTML = ''; delete v.dataset.ground; hush(false); cover(false, 'viewer'); coverPin(false); };
  v.querySelector('[data-back]')?.addEventListener('click', () => openViewer(back));
  // (Note pins on staging, brought to the front where it takes turns with live.)
  v.querySelector('.pin').onclick = () => { if (!me.review) return; staged?.toStaging(); frame.contentWindow.postMessage({ hq: 'hq', pin: 1 }, me.review); };
  frame.addEventListener('load', () => {
    frame.style.background = ''; // a backdrop lasts until the next page is there: backdropOf
    stopFrameMic(); // (the page before's ask and recording, its goodbye or not: framemic.js.)
    delete v.dataset.ground; // (the page before's colour: groundOf)
    askReview(me, frame);
  });
  v.querySelector('.bar .share').onclick = () => shareBox(me);
  paintPin();
  // The outside link signs in once, within two minutes: a used or older one is replaced as it's tapped (the new tab
  // opens at once, so the browser doesn't take it for a popup, and gets its address when the new link is there).
  out.onclick = e => {
    const fresh = me.link && Date.now() - me.link.at < 100_000;
    me.link = null;
    if (fresh) return;
    e.preventDefault();
    const tab = window.open('', '_blank');
    if (!tab) return;
    tab.opener = null;
    previewLink(world.dev, url).then(l => tab.location.replace(spot(l)), () => tab.close());
  };
  // the sign-in link keeps only the path: its redirect carries the #fragment (a deck's slide) along
  function spot(link) { const h = new URL(url).hash; return h && !link.includes('#') ? link + h : link; }
  try {
    const [inFrame, outside] = await Promise.all([previewLink(world.dev, url), previewLink(world.dev, url)]);
    if (viewing !== me) return;
    frame.src = spot(inFrame); out.href = spot(outside); me.link = { at: Date.now() };
  } catch { if (viewing === me) out.textContent = 'Could not reach the coordinator. Close and try again.'; }
}
// Every page the frame loads is asked whether review mode runs there, and the bar's Note goes if nothing answers within
// a second. A page's goodbye as it unloads doesn't always arrive (Chromium drops it), and a page without review mode says
// nothing, so the bar kept a Note that did nothing there. The question carries nothing: any page may hear it.
const ASK_MS = 1000;
function askReview(me, frame) {
  if (viewing !== me) return;
  const asked = performance.now();
  frame.contentWindow?.postMessage({ hq: 'hq', ask: 1 }, '*');
  setTimeout(() => { if (viewing === me && me.review && !(me.heard > asked)) { me.review = null; paintPin(); } }, ASK_MS);
}
// The address: the product's name bright, the rest of the host dim (it's what gets cut on a phone), and ↗
function where(url) {
  const [name, ...rest] = new URL(url).host.split('.');
  return `<b>${esc(name)}</b><span>${rest.length ? `.${esc(rest.join('.'))}` : ''}</span><i aria-hidden="true">↗</i>`;
}
function paintPin() {
  const b = $('#viewer .pin'); if (!b || !viewing) return;
  b.hidden = !viewing.review || calling;
}
// On a call the board scribbles in red for the call's agent: the bar has no Note, and the viewer's page no pin (told
// now, and in every answer to its hello), as HQ's own has none (pinsetting.js). After the call they're back (the board,
// call 161.).
let calling = false;
function followCall() {
  const set = on => {
    calling = on; paintPin();
    const frame = stagingFrame();
    if (viewing?.review && frame) frame.contentWindow.postMessage({ hq: 'hq', call: on }, viewing.review);
  };
  document.addEventListener('call:on', () => set(true));
  document.addEventListener('call:off', () => set(false));
  // (the agent's turn on a note done: the page in the viewer drops its ink if the mark was its own.)
  document.addEventListener('call:had', e => {
    const frame = stagingFrame();
    if (viewing?.review && frame && Number.isInteger(e.detail?.note)) frame.contentWindow.postMessage({ hq: 'hq', had: e.detail.note }, viewing.review);
  });
}
// The review tool (shared/review) on HQ's own screens, for the board's notes on HQ itself, loaded once at start: the
// coordinator serves the real one only behind the board's sign-in (feedback.ts).
function loadPin() {
  const script = Object.assign(document.createElement('script'), { src: '/__review/review.js' });
  script.dataset.summoned = '';
  script.dataset.book = '';   // the Pencil writes on HQ's pages, its notes in the board's book.
  script.onload = () => { coverPin(!!viewing); tellPin(); };
  document.head.append(script);
  mountPin();   // (away till Settings turn it on)
  mountTips();   // (under it, the tips book)
}
// HQ's pin is for HQ's own screens: while the viewer is up, the preview in it has its own, so HQ's steps aside until it
// closes and only one pin ever shows
const coverPin = on => dispatchEvent(new CustomEvent('review:cover', { detail: on }));
// The book open beside the page (and the viewer over it), asked for an owner's notes (HQ's address, main.js, and a
// card's On the page). It opens at the current page, slid to the newest note pinned there, and turns
// there if it's open already. at: a place in the book to land on instead, { page, notebook, note } (a card's On the
// page: book.js's openAt).
export function bookAt(owner, at = null) {
  if (typeof owner !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(owner)) return;
  sfx.blip();
  openAt(at);
}
// Share for outside notes: the people
// invited to pin notes on this preview (a product's whole preview, the shop's, or a deck's or demo's own cycle folder),
// each with where they stand, Send link and Remove, and Invite (peopleHtml) from the board's address book: everyone it
// ever shared with. Two kinds of guest only (Ink 1.1, the deck's Guests chapter): lasting, a colleague's for good, or a
// review round, open a week. Send link sends their one link, the same every time, to their shelf of books.
// They sign in with a code sent to the address the board gives (the guest desk's sign-in). Their notes never come here:
// they're on the round's pages in the board's book; the board closes it, and the CEO writes its Advice (notebookrounds.ts). It opens
// at the page the viewer opened. Reviews lists the same (sharesHtml).
// View only: a share of its own, chosen at the top of the box; the same links, the
// pages without review mode and nothing asked of them. A deck's share also opens the demos its pages link to.
// To try out: a tester invite, on the shop's preview or a product's with plans: notes as above, and each person's link
// carries a voucher of their own, free, up to the amount the box sets (capHtml, €50 until the board sets one). On the
// shop it pays one real order, made and sent like a customer's; on a product, one of its plans, with nothing charged
// (the deck's two kinds, and a tester invite where one opens; View only's shares still list in Reviews.)
const ROUND_DAYS = 7;
// a share's kind as the box chooses it; the shop's preview door (the coordinator's FRONT), and the cycles host, where no
// tester invite opens
const KINDS = [['lasting', 'Lasting'], ['notes', 'A week’s round'], ['tester', 'To try out']];
export const kindOf = s => s.tester ? 'tester' : s.view ? 'view' : s.lasting ? 'lasting' : 'notes';
const onShop = url => new URL(url).host.startsWith('front.preview.');
const onCycles = url => new URL(url).host.startsWith('cycles.');
// the open share a page is in: its host, and its folder unless it opens the host whole
function shareOn(list, url, kind) {
  const u = new URL(url);
  return list.find(s => !s.ended && kindOf(s) === kind && s.host === u.host && (s.prefix === '/' || u.pathname.startsWith(s.prefix))) ?? null;
}
async function shareBox(me) {
  const box = $('#viewer .sharebox');
  if (!box || viewing !== me) return;
  sfx.blip();
  if (!box.hidden) { box.hidden = true; return; }
  box.hidden = false;
  closeOutside(box);
  box.innerHTML = '<p class="dim">Loading…</p>';
  let list;
  // (and Recent)
  try { [list] = await Promise.all([loadShares(world.dev), loadRecent()]); } catch { box.innerHTML = '<p class="dim">Could not reach the coordinator. Try again.</p>'; return; }
  if (viewing !== me || box.hidden) return;
  drawShareBox(box, me, list, 'lasting');
  if (!shareOn(list, me.url, 'lasting')) box.querySelector('[name=name]').focus();
}
// A tap anywhere outside the box closes it: on the bar or the page around it, or in the preview (its frame takes the
// focus, so this page loses it). Share itself toggles it.
function closeOutside(box) {
  const off = () => { removeEventListener('pointerdown', tap, true); removeEventListener('blur', away); };
  const tap = e => { if (box.hidden) return off(); if (!box.contains(e.target) && !e.target.closest('#viewer .share')) { box.hidden = true; off(); } };
  const away = () => setTimeout(() => { if (document.activeElement?.tagName === 'IFRAME' && !box.hidden) { box.hidden = true; off(); } });
  addEventListener('pointerdown', tap, true);
  addEventListener('blur', away);
}
// kind: the kind the box shows, for notes, view only or to try out; list: the shares as loaded, with the ones it has made
// since
function drawShareBox(box, me, list, kind, s = shareOn(list, me.url, kind), said = '') {
  const live = s && !s.ended ? s : null;
  const kinds = KINDS.filter(([k]) => k !== 'tester' || !onCycles(me.url));
  // (who has access, on what; the kinds one segmented control)
  box.innerHTML = `<b>Who has access</b><p class="dim">${live ? `${esc(live.what)} · ` : ''}${esc(new URL(me.url).host)}</p>
    <div class="seg" role="group" aria-label="Share">${kinds.map(([k, label]) => `<button type="button" data-kind="${k}" aria-pressed="${k === kind}">${label}</button>`).join('')}</div>
    <p class="dim">${live ? untilLine(live) : aheadLine(kind)}</p>
    ${kind === 'tester' ? capHtml(live, onShop(me.url)) : ''}${shareHtml(live)}`;
  box.querySelectorAll('[data-kind]').forEach(b => b.onclick = () => { sfx.blip(); drawShareBox(box, me, list, b.dataset.kind); });
  const redraw = (next, text) => {
    if (next) list = [next, ...list.filter(x => x.id !== next.id)];
    if (viewing === me) drawShareBox(box, me, list, kind, next, text);
  };
  const capField = box.querySelector('form.cap [name=cap]');
  wireShare(box, live, { page: me.url, kind, days: () => ROUND_DAYS, cap: () => Number(capField?.value), redraw });
  wireCap(box, live, redraw);
  if (said) box.querySelector('.invites .msg').innerHTML = said;
}
// A tester invite's amount: what each of its vouchers pays at most, delivery included on the shop. Before the first invite
// it goes with it; on an open invite Set changes it for every voucher not yet spent, the ones already sent too.
const capHtml = (s, shop) => `<form class="cap" novalidate><label>Vouchers pay up to €<input name="cap" type="number" inputmode="numeric" min="1" max="500" step="1" value="${+(s?.cap ?? 50)}" aria-label="Most a voucher pays, in euros"></label>${s ? '<button>Set</button>' : ''}<span class="dim">${shop ? 'Delivery included. ' : ''}A new amount counts for the vouchers already sent too.</span></form>`;
function wireCap(box, s, redraw) {
  const form = box.querySelector('form.cap'), msg = () => box.querySelector('.invites .msg');
  form?.addEventListener('submit', async e => {
    e.preventDefault();
    const field = form.elements.cap, amount = +field.value;
    if (!s || !Number.isInteger(amount) || amount < 1 || amount > 500) { field.focus(); return; }
    const button = form.querySelector('button');
    button.disabled = true;
    // (the amount, not the euros formatter)
    try { redraw(await setShareCap(world.dev, s.id, amount), `Each voucher now pays up to ${euros(amount)}.`); sfx.blip(); }
    catch (err) { button.disabled = false; tell(msg(), refused(err)); }
  });
}
export const shareTitle = kind => ({ lasting: 'Lasting guests', notes: 'Review round', view: 'View only', tester: 'Testers' })[kind];
// Before the first invite of a kind: what it gives them
const aheadLine = kind => esc(kind === 'lasting' ? 'A lasting guest keeps it on their own shelf until you remove them.'
  : kind === 'notes' ? 'A review round: open a week, on their own shelf, then it ends.'
  : 'A review round with a voucher each: open a week.');
// An open share's line (as HTML): until when, and where its notes go: each person's on their own page in the round
// notebook on the board's Shelf, reaching the team when they send it.
const intoBook = () => 'Each person writes on their own page in the round notebook on your Shelf; their notes reach the team when they send it.';
export const untilLine = s => esc(s.lasting ? 'Lasting: on their own shelf until you remove them. Their notes land on their own page in its book on your Shelf.'
  : s.view ? `Until ${dayTime(s.ends)}. They see it as it is: no notes, nothing to answer.`
  : s.tester && s.pays === 'plan' ? `Until ${dayTime(s.ends)}. Each link carries a voucher for one plan up to ${euros(s.cap)}: nothing charged, nothing recurring. ${intoBook(s)}`
  : s.tester ? `Until ${dayTime(s.ends)}. Each link carries a voucher for one free order up to ${euros(s.cap)}, made and sent for real. ${intoBook(s)}`
  : `Until ${dayTime(s.ends)}. ${intoBook(s)}`);
// a share's people and End now (none before the first invite): whether each opened it, and a tester's order
const reviewState = (s, p) => `${p.opened ? `Guest since ${dayTime(p.opened)}` : `Invited · on ${p.name.split(' ')[0]}’s shelf now`}${ordered(s, p)}`;
// a tester's order, once placed: the stalls it was from, or the plan and tiers it took
const ordered = (s, p) => !s.tester ? '' : s.pays === 'plan' ? (p.ordered ? ` · took ${p.ordered.join(' with ')}` : ' · no plan yet')
  : p.ordered ? ` · ordered${p.ordered.length ? ` from ${p.ordered.join(', ')}` : ''}` : ' · no order yet';
// (titled, and Recent: everyone shared with lately who isn't on it)
export const shareHtml = s => `${peopleHtml((s?.people ?? []).map(p => ({ ...p, state: reviewState(s, p) })), true, { titled: true, again: recent.filter(r => !s?.people.some(p => sameName(p.name, r.name))) })}${s ? '<p class="row acts"><button type="button" data-end>End now</button></p>' : ''}`;
// The people the board shared with in the last three weeks, by name and its title for them (loadPeople), as Share and
// Reviews last loaded them: the box's Recent, a tap invites one again
let recent = [];
export const loadRecent = () => loadPeople(world.dev).then(list => { recent = list; }, () => { /* Recent stays as it was: the box and Reviews work without it */ });
export const noteCount = n => `${+n} ${+n === 1 ? 'note' : 'notes'}`;
// Send link, Remove, Invite and End now on a share (in the viewer's box, or a share in Reviews): o.redraw(share, what to
// say, as HTML) draws it again, o.page and o.days() make a new one with the first invite
export function wireShare(el, s, o) {
  const busy = holdReviews;
  const after = (next, text) => {
    o.redraw(next.ended ? null : next, text);
    return text;
  };
  wirePeople(el, {
    // (a guest's one link to their shelf, where the share has one: notebookguestshelf.ts)
    send: (name, button, out) => { const p = s?.people.find(x => x.name === name), url = p?.shelf ?? p?.link; if (url) share({ url }, out); },
    remove: name => busy(async () => after(await removeFromShare(world.dev, s.id, name), `${esc(name)} removed.`)),
    invite: (name, email) => busy(async () => {
      const next = await makeShare(world.dev, s ? { id: s.id, name, email } : { page: o.page, name, email, days: o.days(), lasting: o.kind === 'lasting', view: o.kind === 'view', tester: o.kind === 'tester', ...(o.kind === 'tester' ? { cap: o.cap() } : {}) });
      if (!s) sfx.ding(0.6);
      return after(next, `${esc(name)} invited. Send link sends them theirs.`);
    }),
    title: (name, title) => busy(async () => {
      const saved = await setPersonTitle(world.dev, name, title);
      for (const p of [...s.people, ...recent]) if (sameName(p.name, name)) p.title = saved.title;
      o.redraw(s, '');
    }),
  });
  const end = el.querySelector('[data-end]'), msg = () => el.querySelector('.invites .msg');
  if (end) end.onclick = async () => {
    if (!end.dataset.sure) { end.dataset.sure = 1; end.textContent = 'Tap again to end it'; sfx.blip(); return; }
    end.disabled = true; msg().textContent = 'Ending…';
    try { await busy(() => endShare(world.dev, s.id)); } catch { tell(msg(), 'That didn’t go through. Try again in a minute.'); end.disabled = false; return; }
    sfx.blip(); o.redraw(null, 'Ended: their links no longer open it.');
  };
}
// Messages from the page in the viewer, and only from it: review mode saying hello (or goodbye, or asking for the mic:
// framemic.js), a deck's button asking for a preview, a deck saying hello (it gets the look's
// slides.css), or a page asking for a backdrop (backdropOf). Anything else, or from anywhere else, is ignored.
function fromViewer(e) {
  const frame = stagingFrame(), d = e.data, me = viewing;
  if (!me || !frame || e.source !== frame.contentWindow || !PREVIEW.test(`${e.origin}/`) || !d || typeof d !== 'object') return;
  // Decks built before 2026-10-04 inline the old deck.js: it tags its messages { onlyonery: 'deck' } and hears the look
  // under that key. Still a deck's, answered the way it listens.
  const old = d.hq === undefined && d.onlyonery === 'deck', tag = old ? 'deck' : d.hq;
  if (tag === 'review') {
    // (told on the document too, for an ask's spot waiting to flash there: ink/bookaskspot.js.)
    if (d.hello) { me.review = e.origin; me.heard = performance.now(); e.source.postMessage({ hq: 'hq', call: calling }, e.origin); helloFrom(d.doc); groundOf(d.ground, frame); document.dispatchEvent(new CustomEvent('viewer:review', { detail: { url: me.url } })); }   // (heard; helloFrom)
    else if (d.bye && me.review === e.origin) { me.review = null; stopFrameMic(); }
    // (its post-it open: HQ's own mic key over the post-it's, the frame having no microphone, and only its tap records;
    // the offer's line, e.ports, carries the rest: framemic.js.)
    else if (d.mic === 'offer' && Number.isInteger(d.doc) && e.ports[0]) frameMic(d.doc, e.ports[0], voiceLang(), frame, d.at);
    // (the board's note saved there as a scrap in its Notebook: the book lands it, booklanding.js.)
    else if (d.scrap && Number.isInteger(d.scrap.id) && Number.isInteger(d.scrap.page))
      document.dispatchEvent(new CustomEvent('book:scrap', { detail: { id: d.scrap.id, page: d.scrap.page } }));
    // (on a call, the Pencil's mark there: HQ's review mode files it as its own call's, callnotes.js, and the page hears
    // how it went.)
    else if (d.callMark && Number.isInteger(d.callMark.id) && me.review === e.origin) {
      const to = e.source, from = e.origin, id = d.callMark.id;
      const answer = a => to.postMessage({ hq: 'hq', callMark: { id, ...a } }, from);
      if (!calling) answer({ failed: 'The call had ended.' });
      else document.dispatchEvent(new CustomEvent('call:mark', { detail: { anchor: d.callMark.anchor, snip: typeof d.callMark.snip === 'string' ? d.callMark.snip : null, ago: Number(d.callMark.ago) || 0, answer } }));
    }
    paintPin();
  } else if (tag === 'backdrop') {
    frame.style.background = backdropOf(d) ?? '';
  } else if (tag === 'deck' && e.origin.startsWith('https://cycles.preview.') && typeof d.open === 'string' && PREVIEW.test(d.open)) { // decks only, not product pages
    sfx.blip(); openViewer(d.open, backTo(d.back, e.origin) ?? me.url);
  } else if (tag === 'deck' && d.hello && e.origin.startsWith('https://cycles.preview.') && dressed) { // a deck wears the look (its slides.css)
    const to = e.source, name = look;
    fetch(`renderers/${name}/slides.css`).then(r => r.ok ? r.text() : null)
      .then(css => { if (css && viewing === me) to.postMessage({ [old ? 'onlyonery' : 'hq']: 'hq-look', look: name, css }, e.origin); })
      .catch(() => { /* the deck keeps its own look */ });
  }
}
// The page's own background colour, as its review mode tells it (the frame's own where the page is clear), on the
// viewer for the Notebook: under the book as it lifts off beside the page (book.js). A page that tells none leaves HQ's
// dark backdrop there.
function groundOf(colour, frame) {
  const v = $('#viewer');
  if (colour === null) v.dataset.ground = getComputedStyle(frame).backgroundColor;
  else if (typeof colour === 'string' && CSS.supports('color', colour)) v.dataset.ground = colour;
}
// A page that fades into a colour as it leaves for the next one (the shop's door into a stall) asks for that colour, and
// a picture on it, behind the frame: a tab keeps the old page on screen until the next one paints, a frame shows its own
// background in between, for a frame or more (white: a flash). Behind it until the frame's next page has loaded. The
// colour as #rrggbb, the picture a PNG data URL at its place and size in the frame, in CSS pixels; without a picture
// that fits, the colour alone.
function backdropOf({ colour, picture }) {
  if (typeof colour !== 'string' || !/^#[0-9a-f]{6}$/i.test(colour)) return null;
  const isLength = v => Number.isFinite(v);
  const isPicture = typeof picture?.src === 'string' && /^data:image\/png;base64,[a-z0-9+/]+=*$/i.test(picture.src);
  return isPicture && [picture.left, picture.top, picture.width, picture.height].every(isLength)
    ? `${colour} url("${picture.src}") ${picture.left}px ${picture.top}px / ${picture.width}px ${picture.height}px no-repeat`
    : colour;
}
// The deck sends where it is as a path and slide (/<date>/presentation/#7), never a whole address: back is on its own
// origin
function backTo(path, origin) {
  if (typeof path !== 'string' || !path.startsWith('/')) return null;
  const url = new URL(path, origin);
  return url.origin === origin ? url.href : null;
}
export function closeTool() {   // (exported for calldrive.js and a second screen's page closed)
  if (!open) return;
  forgetAge();   // (a call goes on: it's a layer of its own, call.js)
  open = null; clearInterval(timer); timer = null; homeFit?.disconnect(); homeFit = null;   // (homeFit)
  if (voice) { voice.rec.cancel(); voice = null; }
  const el = root(); el.hidden = true; el.innerHTML = ''; sfx.close();
  opened(null);
}
// Nothing re-renders an overlay while the board is typing in it (an answer on the phone, a directive on
// the intercom, anything on the computer), or while the intercom records or transcribes: that would wipe the
// text and close the keyboard. (Checkboxes aren't typing: the Notes tab keeps their state itself.) Nor while the phone
// shows a call room's link to send on, until the board taps Done.
const FIELDS = 'input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not(.tilefilter), textarea';   // (a tile filter never holds a redraw back: tiles.js keeps it)
// A field holding what it was drawn with (a saved name in Settings) isn't being typed in.
const typing = () => !!voice || !!dictation || photoBusy() || !!root().querySelector('.call-link') || [...root().querySelectorAll(FIELDS)].some(t => t.value !== t.defaultValue || document.activeElement === t);
let stale = false; // the phone skipped a re-render for that; it catches up once the field is empty and left
const refusedKeys = new Map(); // request id → { key: why the server refused it }, shown under the field until the next Save
// An error or a done on a tool's own line (the intercom's, a card's, a call's) as the design system's alert part: its
// sign, then what happened. Each look draws it its own way (style.css, controls.css, a look's kit). A line's plain words
// (Sending…) replace it, and an empty line has none.
const SIGNS = { problem: icon('alert'), done: icon('tick') };
const alertHtml = (html, kind = 'problem') => `<span class="alert ${kind}" role="${kind === 'problem' ? 'alert' : 'status'}"><span class="sign">${SIGNS[kind]}</span><span class="words">${html}</span></span>`;
// (and an empty or problem state's sign, which a look shows if it draws one: style.css hides it)
const stateSign = name => `<span class="sign">${icon(name)}</span>`;
export function tell(line, words, kind = 'problem') {
  if (line) line.innerHTML = words ? alertHtml(esc(words), kind) : '';
}
// ---------------------------------------------------------------- open requests: one source of truth
// The HUD badge, the ringing desk phone, the board's panel and the phone overlay all read this list.
// Responses that arrive out of order (a slow poll after a newer one, or after an answer) are dropped,
// and a request that hangs can't stall polling.
const store = { list: [], seq: 0, subs: [] };
export const onRequests = fn => store.subs.push(fn);
export const waitingCards = () => store.list; // (the Library's manual, manual.js)
// A card's time on the desk phone: when it was filed, or last changed. A changed card leads the list and counts as
// unread again, as a new one does
export const cardTime = r => r.changed || r.created;
// A request's Share part is in the key, so a card whose Share part was corrected
// (hq rewrite) or withdrawn (rewritten in a keys job's words) re-renders like a new list would; so is an email card's state,
// so one that's being sent, or may have gone, says so; and when a card last changed,
// so any rewritten card re-renders
// And its text, so a seat's sign-in card, which takes its new link and code without changing, re-renders with them
// A card's topic too, so the grouped list regroups when one changes (hq topic)
// And a guest card's people's own Share parts and whether each was sent, so one invited, removed or sent their link shows
// And its zips' states, so a zip unpacked meanwhile shows
// And an address card's saved addresses, so one saved or removed on another device shows
// And the cards for later (held: the list as it came, or null when it wasn't asked for), so their list and count show
function setRequests(list, held = null) {
  if (held) later = held;
  const key = JSON.stringify([list.map(r => [r.id, r.share ?? null, r.changed ?? null, r.body ?? null, r.mail?.status ?? null, r.mail?.doubt ?? null, r.call?.status ?? null, r.topic ?? null,
    r.guest?.people?.map(p => [p.share ?? null, !!p.released]) ?? null, r.zips?.map(z => z.state) ?? null, r.addresses?.map(a => a.id) ?? null]), later.map(r => [r.id, r.hidden_until])]), changed = key !== store.key;
  Object.assign(store, { list, key }); store.seq++;
  for (const id of cardTrays.keys()) if (!list.some(r => r.id === id)) cardTrays.delete(id);
  for (const f of store.subs) f(list);
  if (open === 'phone' && changed && !past) { if (typing()) { stale = true; mailState(); zipsState(); } else renderPhone(); }
}
// A card answered or put off slides away (the .req.done animation in style.css, FILED_MS long), then leaves the list.
// card: null when the phone shows another card by now.
const FILED_MS = 450;
function fileAway(card, r, wait = FILED_MS) {
  card?.classList.add('done');
  setTimeout(() => setRequests(store.list.filter(x => x.id !== r.id)), wait);
}
export async function refreshRequests() {
  paintLines(true); // (the company's apps' lines)
  const seq = ++store.seq, timeout = new Promise(r => setTimeout(() => r(null), 10000));
  // (the cards for later only while the phone is open: nothing else shows them)
  const got = await Promise.race([Promise.all([loadRequests(world.dev), open === 'phone' ? loadLater(world.dev) : null]), timeout]);
  if (got?.[0] && seq === store.seq) setRequests(...got);
}

// ---------------------------------------------------------------- the company's apps' lines on the phone
// A company app may keep a line at the top of the phone's screen (its phone(el, hq,
// { fresh })): fresh with every requests poll, from what it has on every repaint. It repaints only its own line,
// never a card being answered.
// el is the app's own slot, the same element for good, at the top of every screen drawn, in the order of `own`: the
// lines keep that order whichever app answers first, and a fresh line lands in the screen drawn meanwhile. The answered
// cards' screens (past) have no slots: each draws its whole screen, so a line painted late lands in a slot off screen.
const lineSlots = new Map();
function paintLines(fresh = false) {
  const el = $('#phone-screen'); if (!el) return;
  const apps = own.filter(k => k.mod.phone);
  const slots = apps.map(k => lineSlots.get(k.id) ?? lineSlots.set(k.id, Object.assign(document.createElement('div'), { className: 'line-slot' })).get(k.id));
  if (!past && slots.some((s, i) => el.children[i] !== s)) el.prepend(...slots);   // (moved only when out of place: a pressed line keeps its focus)
  apps.forEach((k, i) => Promise.resolve().then(() => k.mod.phone(slots[i], hq(), { fresh })).catch(e => console.warn(`[hq] ${k.id}: its phone line failed`, e)));   // (by its id, Care being no kit)
}

// ---------------------------------------------------------------- phone
// listing: the phone shows the open cards as one list, grouped by topic (renderList), instead of one card.
const LIST = icon('list');
let listing = false, openingCard = null;
// at: a card's id, to open the phone at that card (the projects view's "for you" jobs; a ping's notification, its id as
// text)
export async function openPhone(at) {
  if (!show('phone', `<header>${icon('phone', 'device-icon')}<b>${esc(cap(names.phone))}</b><button class="past-btn" data-past aria-pressed="false">${FILED}<span>Answered</span></button><button class="x" data-close aria-label="Close">×</button></header><div class="screen" id="phone-screen"><p class="muted">Dialling…</p></div>`)) return;
  idx = 0; past = null; listing = false; laterView = false; openingCard = at ?? null;
  const screen = $('#phone-screen');
  root().querySelector('[data-past]').onclick = () => { sfx.blip(); if (past) leavePast(); else openPast(); };
  if (openingCard == null) renderPhone();
  await refreshRequests();
  if ($('#phone-screen') !== screen) return;
  const card = at ? store.list.findIndex(r => r.id === Number(at)) : -1;
  openingCard = null;
  if (card >= 0) idx = card;
  renderPhone();
}
// The cards the board has seen on the phone, as they were then (id → card time). The desk mark moves to the newest card's
// time only once every open card has been seen, on this page or before the mark: the newest one shown doesn't make an
// older changed card read
const seenCards = new Map();
function shown(r) {
  seenCards.set(r.id, cardTime(r));
  const all = store.list, upTo = seen?.desk;
  if (all.every(x => (seenCards.get(x.id) ?? '') >= cardTime(x) || (upTo != null && cardTime(x) <= upTo))) markSeen('desk', all.map(cardTime).sort().at(-1));
}
// Finished work its maker offers to walk the board through (hq ask --walk): the card's call is that walk-through, in
// those words.
const walkButton = r => `<div class="row btns walk"><button class="talk" id="call-about" title="${esc(who(r.agent))} walks you through it, on a call">${PHONE}<span>Walk me through it</span></button></div>`;
// A card about a note or a page (hq ask --note, --page): On the page, the note's snip, whose and where it is, its words,
// and Open in the book, which turns to its group's page there (bookAt). It shows in the book too, under the note's
// group, answered in either place. One about a page shows here only.
function placeHtml(r) {
  const p = r.place, where = placeName(p.url);
  const said = p.note
    ? `Your note ${esc(String(p.n))} for ${esc(who(p.owner))}, on ${esc(where)}${p.words ? `: “${esc(p.words)}”` : ''}`
    : `${esc(who(r.agent))}’s question about ${esc(where)}`; // (on the desk phone only)
  return `<div class="on-page">${p.snip ? `<img src="${esc(p.snip)}" alt="Your note as you marked it" loading="lazy">` : ''}<div><b class="op-k">On the page</b><p>${said}</p>${
    p.page ? '<button class="op-open" data-in-book>Open in the book</button>' : ''}</div></div>`;
}
// A page's place in words: HQ's own, or a preview by its name
function placeName(url) {
  try {
    const u = new URL(url, location.origin);
    return u.origin === location.origin ? 'HQ' : u.host.split('.')[0];
  } catch {
    return url;
  }
}
function renderPhone() {
  if (openingCard != null) return;
  const el = $('#phone-screen'), reqs = store.list; if (!el) return;
  stale = false;
  for (const [at, a] of ages) if (!reqs.some(x => x.id === a.id)) ages.delete(at); // answered elsewhere
  const held = reqs.findIndex(x => [...ages.values()].some(a => a.id === x.id && a.secret)); // mid-way through making a backup key: stay on it
  if (held >= 0) { idx = held; listing = false; laterView = false; }
  if (laterView) return renderLater(el);
  if (!reqs.length) { listing = false; el.innerHTML = `${asideNote()}<div class="quiet">${stateSign('phone')}<b>No calls waiting.</b><span>Enjoy your day.</span><button class="past-link" data-past-link>Your answered cards ›</button>${laterLink('past-link')}</div>`;
    el.querySelector('[data-past-link]').onclick = () => { sfx.blip(); openPast(); }; wireLaterLink(el); wireAside(el); paintLines(); return; } // (the company's apps' lines, here and below)
  idx = Math.min(idx, reqs.length - 1);
  if (listing) return renderList(el, reqs);
  const r = reqs[idx], login = r.kind === 'login';
  if (!document.hidden) shown(r);   // unless HQ is in the background
  if (r.kind === 'tip') return renderTip(el, r, reqs);
  const keys = r.secrets ? r.secrets.split(',') : null; // a credential request: a password field per key instead of an answer
  const saved = new Set(r.saved || []), grant = r.approves ? r.grants || '' : null; // keys already on the server; what Approve (or saving the keys) does
  const address = keys && r.address ? addressOf(r) : null; // an address card: the board's saved addresses
  const body = r.body || '';
  // a venture cycle's interactive presentation (on the preview domain) leads; the full text folds away under it
  const deck = deckOf(r.body), card = cardOf(body), unpaired = pairsOf(body).rest; // (its pictures but the before-and-after pairs, which lead)
  const guest = r.kind === 'guest' ? r.guest : null, asking = !!guest?.needsEmail && !guest.revoked; // a guest card: its address, asked once
  const mail = r.kind === 'mail' && ['open', 'sending'].includes(r.mail?.status) ? r.mail : null; // an email card: the email itself, Send and Discard
  const call = r.kind === 'call' && r.call ? r.call : null; // a call out: who, how and when, Call and Don't call
  const notice = r.kind === 'notice'; // news that asks nothing: Got it, a word optional
  const action = r.kind === 'action'; // steps for the board to do: once done there's often nothing to say, so a word optional
  // work brought back for a look: HQ's own two answers, Good now, or notes on the
  // preview in review mode (which queue their own job), and no box to type changes in. A card's own choices don't show.
  // Both answers sit on one row with Call as its phone alone (the name in its
  // title): with a name, three don't fit a phone's card.
  const back = !!r.back && !keys && grant === null && !guest && !mail && !call && !notice;
  const shownCard = back ? { ...card, choices: [], options: [], recommend: '' } : card;
  const asked = !keys && r.questions?.length ? r.questions : null; // questions as fields
  const pics = !login && !asking && !keys && !back && r.kind !== 'credential' && r.kind !== 'mail' && !call ? cardTray(r) : null; // pictures with the answer, as on the intercom: the cards jobs.ts takesPictures lets take them
  // the Call key shows its phone and the name alone: the desk phone is never wider than 440 px.
  // the Share key shows its icon and its word as plain text.
  el.innerHTML = `
    ${pagerHtml(reqs)}
    ${asideNote()}<article class="req u-${esc((r.urgency || '').replace(/\s+/g, '-'))}">
      <p class="meta"><span class="tag-k">${esc(r.kind || 'request')}</span> ${r.agent ? `from <b>${esc(who(r.agent))}</b> · ` : ''}${esc(ago(r.created))}${r.urgency ? ` · <em>${esc(r.urgency)}</em>` : ''}</p>
      <h3>${withJobLinks(r.title)}</h3>
      ${deck ? `<a class="signin" href="${esc(deck)}" target="_blank" rel="noopener">Open the presentation ↗</a>` : ''}
      ${pairsHtml(card.pairs)}${cardHtml(r, shownCard, clipsHtml(unpaired) + picsHtml(unpaired) + filesHtml(r) + (r.place ? placeHtml(r) : ''))}${guest ? guestHtml(r) : ''}
      ${r.grants ? `<p class="grant">${esc(r.grants)}</p>` : ''}
      ${login ? '' : mail ? mailHtml(r, mail) : call ? callHtml(call, true) : asking ? `<label class="key" data-private>${esc(guest.name)}’s email address<input type="email" id="guest-email" autocomplete="off" spellcheck="false"></label><p class="hint">Asked once. The page sends a code there before it shows anything, and never shows the address.</p>`
        : keys ? (address ? addressPickHtml(r, address) : '') + keys.map((k, i) => AGE.test(k) ? ageHtml(r, k, saved.has(k)) : `<label class="key"${address ? ' data-private' : ' data-watchalong-hide'}>${esc(address ? ADDRESS_PARTS[i] : keyLabel(k))}${saved.has(k) ? ' <b class="saved">saved ✓</b>' : ''}<input type="${address ? 'text' : 'password'}" data-key="${esc(k)}" autocomplete="${address ? ADDRESS_FILL[i] : 'off'}" spellcheck="false"${saved.has(k) ? ' placeholder="Saved. Type here only to replace it."' : ''}></label>${refusedKeys.get(r.id)?.[k] ? `<p class="hint refused">${SIGNS.problem}<span>${esc(refusedKeys.get(r.id)[k])}</span></p>` : ''}`).join('')
        + (address ? addressKeepHtml(address) : keys.length > 1 ? '<p class="hint">Save the ones you have now; the others can follow later.</p>' : '') : back ? answerFields(r, '') : `
      ${answerFields(r, `${pics ? '<div class="tray" id="answer-pics" hidden></div>' : ''}<label class="sr" for="answer">Your answer</label>
      <textarea id="answer" rows="3" placeholder="${guest ? `Anything for ${esc(who(r.agent))} (optional)` : grant !== null || notice || action || card.choices.length || asked ? 'Anything to add (optional)' : 'Your answer'}"></textarea>`)}`}
      ${r.walk && r.agent && !login && window.AudioWorkletNode ? walkButton(r) : ''}<div class="row btns">${login ? '<button class="send" id="open-seats">Open Seats</button>' : mail ? `<button class="send" id="mail-send"${mail.ready && mail.status === 'open' ? '' : ' disabled'}>${SEND}Send email</button><button class="send later" id="mail-discard"${mail.status === 'open' ? '' : ' disabled'}>Discard</button>` : call ? callButtons(call) : asking ? `<button class="send" id="guest-save">${TICK}Save</button>` : guest ? `<button class="send" id="send-answer">${TICK}Done</button>` : notice ? `<button class="send" id="send-answer">${TICK}Got it</button>` : back ? '<button class="send" id="send-answer">Good now</button><button class="send later" id="in-review" title="Leave your notes on the preview in review mode">Add notes</button>' : grant !== null ? `<button class="send approve" id="approve">${TICK}Approve</button><button class="send later" id="send-answer">Not now</button>` : `<button class="send" id="send-answer">${address ? `${TICK}Save address` : keys ? `${KEY}Save keys` : `${SEND}Send`}</button>`}${canRecord && !login && !keys && !back && grant === null && !asking && !mail && !call ? `<button class="mic" id="answer-mic" title="Tap to talk, tap again to stop" aria-label="Dictate the answer">${MIC}</button>` : ''}${pics ? `<button class="mic attach" id="answer-attach" title="Add a picture" aria-label="Add a picture">${PICTURE}</button><input type="file" id="answer-file" accept="image/*" multiple hidden>` : ''}${r.agent && !login && window.AudioWorkletNode && !r.walk ? (`<button class="talk${back ? ' icon' : ''}" id="call-about" title="Call ${esc(who(r.agent))} about this"${back ? ` aria-label="Call ${esc(who(r.agent))}">${PHONE}` : ` aria-label="Call ${esc(who(r.agent))}">${PHONE}<span class="name">${esc(who(r.agent))}</span>`}</button>`) : ''}${r.share ? `<button class="share" id="share" title="Send this on to whoever has to act on it" aria-label="Share">${SHARE}Share</button>` : ''}<span class="msg" id="answer-msg"></span></div>
    </article>`;
  wirePager(el);
  el.querySelector('[data-in-book]')?.addEventListener('click', () => {
    const { page, notebook, note, owner } = r.place;
    bookAt(owner ?? r.agent, { page, notebook, note }); // (the note's group's page)
  });
  wireCard(el, r, card, keys); wireAge(el, r); wirePics(el, { pairs: card.pairs }); wireSnooze(el, r); wireAside(el); paintLines();
  const fields = [...el.querySelectorAll('#answer, [data-key]')];
  if (address) wireAddress(el, address);
  const shots = !keys && r.photos?.length ? r.photos : null; // photo fields next to the answer box
  const files = !keys && r.documents?.length ? r.documents : null; // and document fields
  if (shots) wirePhotos(el, r);
  if (files) wireDocuments(el, r);
  const zipsAsked = !keys && r.zips?.length ? r.zips : null; // and zip fields
  if (zipsAsked) wireZips(el, r);
  if (asked) wireQuestions(el, r);
  if (pics) wireTray(el, pics);
  fields.forEach(f => f.onblur = () => { if (stale && !typing()) renderPhone(); });
  if (canRecord && !login && !keys && !back && grant === null && !asking && !mail && !call) $('#answer-mic').onclick = () => dictateInto($('#answer'), $('#answer-mic'), $('#answer-msg'));
  $('#call-about')?.addEventListener('click', () => callAgent(r.agent, who(r.agent), { request: r.id, walk: !!r.walk }));
  // The Share button (r.share, at the end of the button row above) and its tap.
  // The tap sends the Share part as the server has it now (the latest poll), not as it was when the card was drawn: the
  // phone may have held off a re-render while the board types. One withdrawn since sends nothing, and the button goes.
  $('#share')?.addEventListener('click', e => {
    const text = store.list.find(x => x.id === r.id)?.share, button = e.currentTarget;
    if (!text) { button.remove(); $('#answer-msg').textContent = 'Nothing to share on this card any more'; return; }
    const trimmed = text.trim(), linkOnly = /^https?:\/\/\S+$/.test(trimmed);
    share(linkOnly ? { url: trimmed } : { text }, $('#answer-msg'));
  });
  if (guest) wireGuest(el, r);
  if (mail) wireMail(el, r);
  if (call) wireCall(el, r);
  const send = async (approve, review = false) => {
    // keys: at least one filled in (the rest can follow); an approval's, a notice's and an action card's note is optional; anything else needs an answer
    const pick = card.choices[chosen.get(choiceKey(r))]?.label;
    // (address; the answer box is optional where the board answers in fields: questions, or a file in a photo, document or zip field)
    const empty = keys ? (address?.use != null || fields.some(f => f.value.trim()) ? null : fields.find(f => !saved.has(f.dataset.key) && f.type !== 'hidden') || el.querySelector('.agekey button, .agekey input:not([type=hidden])') || fields[0])
      : grant !== null || back || pick || guest || notice || action || answeredInFields(r) || pics?.batch().length ? null : card.choices.length && !fields[0]?.value.trim() ? el.querySelector('.choice input') : fields.find(f => !f.value.trim());
    if (empty) { empty.focus(); return; }
    if (address?.use == null && address?.save && !address.label.trim()) { el.querySelector('[data-address-label]').focus(); return; }
    if (asked && !questionsReady(el, r)) return;
    if ((shots || files || zipsAsked) && !fieldsReady(el, r)) return;
    // the pictures with the answer, once uploaded
    const batch = pics?.batch() ?? [], buttons = [...el.querySelectorAll('.send')], article = el.querySelector('.req');   // (the nodes of this card: the board may be on another by the time the answer is sent)
    buttons.forEach(b => b.disabled = true); pics?.sending(batch, true);
    const answer = keys || review ? '' : back ? 'Good now' : [pick, $('#answer').value.trim()].filter(Boolean).join('\n\n'), secrets = Object.fromEntries(fields.filter(f => f.dataset.key && f.value.trim()).map(f => [f.dataset.key, f.value.trim()]));
    const questions = asked ? answersIn(el) : undefined;   // read before the upload's wait: the board may be on another card when it ends
    const pictureIds = await pics?.sent(batch);
    if (pics && !pictureIds) { buttons.forEach(b => b.disabled = false); pics.sending(batch, false); return; }
    // whether this card is on screen now (not another card, the card list, Later or the archive): if not, the answer only updates the store
    const showing = () => store.list[idx]?.id === r.id && el.isConnected && !listing && !laterView && !past;
    if (showing()) $('#answer-msg').textContent = 'Sending…';
    refusedKeys.delete(r.id); if (showing()) el.querySelectorAll('.refused').forEach(p => p.remove());
    try {
      const picked = address?.use != null ? { use: address.use } : address?.save ? { save: address.label.trim() } : undefined;
      const res = await answerRequest(world.dev, r.id, answer, secrets, approve, picked, questions, pictureIds?.length ? pictureIds : undefined, review);
      sfx.jingle();
      fields.forEach(f => { f.value = ''; f.blur(); }); // sent: the board isn't typing any more
      for (const k in secrets) ages.delete(`${r.id}:${k}`); // a backup key's public half is on the server: done with the pair
      if (res?.missing?.length) { // some keys still to come: the request stays, showing what's saved
        (store.list.find(x => x.id === r.id) || r).saved = keys.filter(k => !res.missing.includes(k));
        if (showing()) { renderPhone(); $('#answer-msg').textContent = `Saved. Still to come: ${res.missing.length} of ${keys.length}.`; }
        return;
      }
      addressState.delete(r.id);
      article.querySelectorAll('[data-address-label]').forEach(f => { f.defaultValue = f.value; f.blur(); });   // the name is sent, so typing() no longer holds the card back
      if (shots) forgetThumbs(r.id);
      if (pics) { pics.takeOut(batch); cardTrays.delete(r.id); }
      if (asked) { forgetAnswers(r); article.querySelectorAll('.questions input').forEach(i => { i.defaultValue = i.value; i.blur(); }); }
      fileAway(article, r);
    } catch (err) {
      const status = +String(err.message).match(/\d{3}$/)?.[0], why = err.refusal?.refused;
      buttons.forEach(b => b.disabled = false);
      if (pics) {   // pictures no longer waiting leave the tray, and the board looks before sending again
        pics.sending(batch, false);
        const missing = err.refusal?.missing;
        if (missing) { pics.refused(batch, missing); if (showing()) tell($('#answer-msg'), `${missing.length === 1 ? 'A picture is' : `${missing.length} pictures are`} no longer there, so nothing was sent. Check the pictures, then send again.`); return; }
      }
      if (keys && why) { // the server says why, per field: each under its own; the others in it were saved
        if (Object.keys(why).length) {
          refusedKeys.set(r.id, why);
          if (err.refusal.missing) (store.list.find(x => x.id === r.id) || r).saved = keys.filter(k => !err.refusal.missing.includes(k));
          fields.forEach(f => { f.value = ''; f.blur(); });
        }
        if (!showing()) return; // the board has moved to another card: this one shows the reasons when it's back
        if (Object.keys(why).length) renderPhone();
        const done = Object.keys(secrets).filter(k => !why[k]).length;
        tell($('#answer-msg'), Object.keys(why).length ? `${done ? 'The rest is saved. ' : ''}Not saved: the reason is under the field.` : err.refusal.error);
        return;
      }
      if (showing()) tell($('#answer-msg'), status === 400 ? (keys ? 'That didn’t go through: fill in at least one key, each copied whole into its own field.' : asked ? 'That didn’t go through: a question still needs its answer.' : shots ? 'That didn’t go through: a photo is still missing.' : files ? 'That didn’t go through: a file is still missing.' : zipsAsked ? 'That didn’t go through: a zip is still missing or being unpacked.' : 'That didn’t go through.')   // (if showing())
        : status === 507 ? 'The server has no room to file these right now. Nothing was sent. Try again later.'
        : status ? `The server couldn’t save that (error ${status}). Try again in a minute.` : 'Could not reach the coordinator. Try again.');
    }
  };
  $('#send-answer')?.addEventListener('click', () => send(false));
  $('#in-review')?.addEventListener('click', () => send(false, true));
  $('#open-seats')?.addEventListener('click', () => { sfx.blip(); openComputer('settings', { section: 'sys:seats', page: r.seat }); });
  $('#approve')?.addEventListener('click', () => send(true));
}

// The pager over a card: back and on, the card list, and Later (a tip's too.)
const pagerHtml = reqs => `<nav class="pager">${arrowsAround(idx, idx < reqs.length - 1, 'Previous', 'Next', `<button class="to-list" data-list aria-label="All cards, by topic (${idx + 1} of ${reqs.length})">${LIST}${idx + 1} of ${reqs.length}</button>`)}${LATER_BTN}</nav>`;
function wirePager(el) {
  el.querySelectorAll('[data-step]').forEach(b => b.onclick = () => { idx += +b.dataset.step; forgetAge(); sfx.blip(); renderPhone(); });
  el.querySelector('[data-list]').onclick = () => {
    listing = true;
    forgetAge();
    sfx.blip();
    renderPhone();
    el.scrollTop = 0;
  };
}
// A tip (tipcard.js) under the pager. Show me on a tip about the phone goes to the card it's about (cardAbout); Got it, or Show
// me's last press, files it with the answered cards.
function renderTip(el, r, reqs) {
  const about = cardAbout(r, reqs);
  el.innerHTML = `${pagerHtml(reqs)}${asideNote()}${tipHtml(r, ago(r.created), about)}`;
  wirePager(el); wireSnooze(el, r); wireAside(el); paintLines();
  const article = el.querySelector('.req.tip');
  wireTip(el, r, {
    close: closeTool,
    open: where => openComputer(where.app, where),
    toCard: () => { idx = about; renderPhone(); },
    end: shown => endTip(world.dev, r.id, shown).then(() => fileAway(article, r, shown ? 0 : FILED_MS), () => { if (article.isConnected) tell(article.querySelector('#answer-msg'), 'Could not reach the coordinator. Try again.'); }),
  });
}

// The open cards as one list, grouped by their topic (hq ask/request --topic). A tap on a title opens that card.
// The groups come in the order of their newest card, and cards without a topic come last. The card the phone was on is marked.
function renderList(el, reqs) {
  const groups = new Map();
  reqs.forEach((r, i) => {
    const name = (r.topic || '').trim(), key = name.toLowerCase();
    if (!groups.has(key)) groups.set(key, { name, cards: [] });
    groups.get(key).cards.push({ r, i });
  });
  const sorted = [...groups.values()].sort((a, b) => Number(!a.name) - Number(!b.name));
  const item = ({ r, i }) => `<li>${covered('', `data-card="${i}"${i === idx ? ' aria-current="true"' : ''}`, r.title, withJobLinks(r.title))}</li>`;
  const group = g => `<h4 class="topic">${esc(g.name ? cap(g.name) : 'Other')} <span>${g.cards.length}</span></h4><ul class="card-list">${g.cards.map(item).join('')}</ul>`;
  el.innerHTML = `<p class="past-cap">${reqs.length} waiting ${reqs.length === 1 ? 'card' : 'cards'}, by topic</p>${sorted.map(group).join('')}${laterLink('past-older')}`;
  el.querySelectorAll('[data-card]').forEach(b => b.onclick = () => {
    idx = +b.dataset.card;
    listing = false;
    sfx.blip();
    renderPhone();
    el.scrollTop = 0;
  });
  wireLaterLink(el);
  paintLines();
}

// ---------------------------------------------------------------- cards for later
// A card can be put aside until a day: Later on the card offers the next working day or the one after, in a week or a
// day the board picks, and the card leaves the phone until 08:00 that day (the server's later.ts), then comes back as a new card. One its author filed for a day still ahead (--visible-from) waits
// the same way. Both are still open. The waiting cards' list (and the empty phone) ends in a quiet "n for later", the
// list of them, each with Bring back.
const MOON = icon('moon');
// A pager: its count between ‹ and › (next: whether there's one after), or the count alone where there's nothing either way,
// no arrows that go nowhere.
const arrowsAround = (at, next, back, on, count) => !at && !next ? count
  : `<button data-step="-1" ${at ? '' : 'disabled'} aria-label="${back}">‹</button>${count}<button data-step="1" ${next ? '' : 'disabled'} aria-label="${on}">›</button>`;
const LATER_BTN = `<button class="later-btn" data-later aria-expanded="false" title="Put this card aside until a day you pick">${MOON}<span>Later</span></button>`;
let later = [], laterView = false; // the cards for later (GET /api/requests/later, while the phone is open), and whether the phone lists them
// The card just put aside: the next screen says until when, with Undo, for a few seconds (style.css fades it)
let aside = null;
const ASIDE_MS = 8000;
const asideNote = () => aside && Date.now() - aside.at < ASIDE_MS
  ? `<p class="later-note" role="status">${MOON}<span>Back on ${esc(backOn(aside.day))}</span><button data-undo>Undo</button></p>` : '';
function wireAside(el) {
  const b = el.querySelector('[data-undo]'), id = aside?.id;
  if (!b) return;
  b.onclick = async () => {
    sfx.blip();
    b.disabled = true;
    if (!(await bringBack(id))) b.disabled = false;
  };
}
// A day as the server says it ('2026-10-13', the company's clock), written out: Tue 13 Oct
const backOn = day => companyFormats().day(day, 'en', { weekday: true, short: true });
const { dayIn, daysToWorkday } = world;
const isoDay = d => d.toISOString().slice(0, 10);
// The next working day, the one after, and in a week: with Pick a day, two rows of two on a phone. Each comes back at the
// first 08:00 still ahead on that day, so before 08:00 the next working day is today (world.firstMorning)
function laterDays(now, first) {
  return [[daysToWorkday(1, now, first), 'Next workday'], [daysToWorkday(2, now, first), 'In 2 workdays'], [7, 'In a week']].map(([n, label]) => ({ label, day: dayIn(n, now) }));
}
const laterLink = cls => later.length ? `<button class="${cls} later-link" data-later-list>${MOON}${later.length} for later ›</button>` : '';
function wireLaterLink(el) {
  const b = el.querySelector('[data-later-list]');
  if (!b) return;
  b.onclick = () => {
    laterView = true;
    listing = false;
    sfx.blip();
    renderPhone();
    el.scrollTop = 0;
  };
}
function wireSnooze(el, r) {
  const btn = el.querySelector('[data-later]');
  if (!btn) return;
  btn.onclick = () => {
    sfx.blip();
    const shown = el.querySelector('.later-pick');
    btn.setAttribute('aria-expanded', String(!shown));
    if (shown) return shown.remove();
    const now = Date.now(), first = world.firstMorning(now), min = isoDay(dayIn(first, now)), max = isoDay(dayIn(365, now));
    el.querySelector('.pager').insertAdjacentHTML('afterend', `<div class="later-pick" role="group" aria-label="Back on">
      <p>Off your ${esc(names.phone)} until</p>
      <div class="days">${laterDays(now, first).map(d => `<button data-day="${isoDay(d.day)}"><b>${d.label}</b><span>${esc(backOn(isoDay(d.day)))}</span></button>`).join('')}
        <label class="pick-day"><b>Pick a day</b><span>On the calendar</span><input type="date" min="${min}" max="${max}" aria-label="Pick a day"></label></div></div>`);
    const pick = el.querySelector('.later-pick');
    pick.querySelectorAll('[data-day]').forEach(b => b.onclick = () => snooze(el, r, b.dataset.day));
    // Pick a day: a key like the others, the date field unseen over it opening the device's own calendar, and the day
    // picked written out as theirs are
    const input = pick.querySelector('input'), day = pick.querySelector('.pick-day span');
    input.onclick = () => { try { input.showPicker(); } catch { /* (opened by the tap itself, or no picker to show) */ } };
    input.onchange = () => {
      if (!(input.value >= min && input.value <= max)) return; // (a year typed digit by digit passes through 0002…)
      day.textContent = backOn(input.value);
      snooze(el, r, input.value);
    };
  };
}
async function snooze(el, r, day) {
  const pick = el.querySelector('.later-pick'), card = el.querySelector('.req'), msg = $('#answer-msg');
  pick.querySelectorAll('button, input').forEach(b => b.disabled = true);
  try {
    const res = await snoozeRequest(world.dev, r.id, day);
    sfx.jingle();
    pick.remove();
    // the phone may show another card by now (the board stepped on, a refresh): only this card's own answer goes with it
    if (card.isConnected) card.querySelectorAll(FIELDS).forEach(f => { f.value = ''; f.blur(); });
    aside = { id: r.id, day: res.day, at: Date.now() };
    later = [...later.filter(x => x.id !== r.id), { ...r, hidden_until: res.until, day: res.day }].sort((a, b) => a.hidden_until.localeCompare(b.hidden_until));
    fileAway(card.isConnected ? card : null, r);
  } catch {
    pick.querySelectorAll('button, input').forEach(b => b.disabled = false);
    tell(msg, 'That didn’t go through. Try again in a minute.');
  }
}
// Bring back: the card comes back now, first, and the phone shows it
async function bringBack(id) {
  try { await snoozeRequest(world.dev, id, null); } catch { return false; }
  later = later.filter(x => x.id !== id);
  if (aside?.id === id) aside = null;
  laterView = false; listing = false;
  await refreshRequests();
  idx = Math.max(0, store.list.findIndex(x => x.id === id));
  if (open === 'phone' && !past) renderPhone();
  return true;
}
function renderLater(el) {
  el.innerHTML = `<nav class="pager"><button class="to-list" data-waiting>${LIST}Waiting cards</button></nav>
    ${later.length ? `<p class="past-cap">${later.length} for later, soonest first. Each comes back on its day, as a new card.</p>
    <ul class="later-list">${later.map(r => `<li><div><b>${withJobLinks(r.title)}</b><span class="meta">Back ${esc(backOn(r.day))}${r.agent ? ` · ${esc(who(r.agent))}` : ''}</span></div>
      <button data-now="${+r.id}">Bring back</button></li>`).join('')}</ul>`
    : `<div class="quiet">${stateSign('moon')}<b>Nothing for later.</b><span>Cards you put aside wait here until their day.</span></div>`}`;
  el.querySelector('[data-waiting]').onclick = () => {
    laterView = false;
    sfx.blip();
    renderPhone();
  };
  el.querySelectorAll('[data-now]').forEach(b => b.onclick = async () => {
    sfx.blip();
    b.disabled = true;
    b.textContent = 'Bringing…';
    if (!(await bringBack(+b.dataset.now))) {
      b.disabled = false;
      b.textContent = 'Didn’t work. Again';
    }
  });
  paintLines();
}

// A guest card (guests.ts): the checklist as the guest sees it, with how far along they are, their answers and the
// questions on each item (the guest's words are theirs: text only, no links); and its people, each with where their link
// stands, Send link and Remove, and Invite under them (people()). With several people on it: a legend in their colours,
// and whose each mark is.
// (several people)
// (an agent's reply with its pictures under it, a tap opens one big: wirePics.)
const messageHtml = m => `<div class="tm${m.guest ? ' theirs' : ''}"><p class="meta">${dot(m.colour)}<b>${esc(m.who)}</b> · ${esc(ago(m.ts))}</p><p class="body">${esc(m.text).replace(/\n/g, '<br>')}</p>${figuresHtml(m.pictures || [])}</div>`;
const threadHtml = t => t?.length ? `<div class="thread">${t.map(messageHtml).join('')}</div>` : '';
const MARK = { done: '✓', answered: '✓', na: '–' };
// an item: its mark (in the colour of whoever made it), title, detail, its files, the answer or "doesn't apply", by whom, its thread
function itemHtml(i) {
  const style = i.colour ? ` style="background:${esc(i.colour)};border-color:${esc(i.colour)};color:#fff"` : '';
  const mark = i.kind === 'info' ? 'i' : MARK[i.state] ?? '';
  const detail = i.detail ? `<span class="meta">${esc(i.detail)}</span>` : '';
  const outcome = i.state === 'answered' ? `<span class="ga">${esc(i.answer)}</span>` : i.state === 'na' ? '<span class="meta">Doesn’t apply</span>' : '';
  const by = i.by ? `<span class="meta">${dot(i.colour)}${esc(i.by)}</span>` : '';
  const files = fileListHtml((i.files ?? []).map(f => ({ ...f, src: f.src ?? null })));
  return `<li${i.state ? ' class="on"' : ''}><span class="gm"${style}>${mark}</span><div><b>${esc(i.title)}</b>${detail}${files}${outcome}${by}${threadHtml(i.thread)}</div></li>`;
}
const sectionHtml = s => `<p class="gsec">${esc(s.title)}</p><ul class="glist">${s.items.map(itemHtml).join('')}</ul>`;
function checklistHtml(g) {
  if (!g.items?.length) return '';
  const sections = [];
  for (const i of g.items) { const last = sections.at(-1); if (last?.title === i.section) last.items.push(i); else sections.push({ title: i.section, items: [i] }); }
  const legend = g.legend ? `<p class="glegend">${g.legend.map(l => `<span>${dot(l.colour)}${esc(l.name)}</span>`).join('')}</p>` : '';
  return `<div class="gprog"><b>${g.done} of ${g.total} done</b><span class="bar"><i style="width:${g.total ? Math.round(100 * g.done / g.total) : 100}%"></i></span></div>
    ${legend}${sections.map(sectionHtml).join('')}`;
}
function guestHtml(r) {
  const g = r.guest, open = g.status === 'open', on = (g.people ?? []).filter(p => !p.withdrawn && !p.revoked);
  const state = p => !open ? '' : !p.address ? 'Needs an email address' : !g.mail ? 'Their link opens once email is set up'
    : !p.released ? 'Link not sent yet' : p.verified ? `Opened it ${ago(p.verified)}` : 'Hasn’t opened it yet';
  const invited = p => p.invitedBy ? `Invited by ${p.invitedBy} · ` : '';
  return `${checklistHtml(g)}<p class="gsec">People</p>${peopleHtml(on.map(p => ({ ...p, state: invited(p) + state(p), link: p.share ?? null })), open, { langs: g.languages })}
    ${open ? colleaguesHtml(g.colleagues) : '<p class="hint">The request is closed. Its page stays readable for 30 days.</p>'}`;
}
// The switch that lets the card's guests invite colleagues at their own email domain from their page (guests.ts), with how
// many of its invites they've used; none for a public mail service's domain
function colleaguesHtml(c) {
  if (!c) return '';
  const used = c.on || c.used ? `${c.used} of ${c.most} invites used` : `Up to ${c.most}, each sent their own link by email`;
  return `<label class="colleagues"><input type="checkbox" data-colleagues${c.on ? ' checked' : ''}><span>They may invite colleagues at @${esc(c.domain)}<small>${used}</small></span></label>`;
}
function wireGuest(el, r) {
  const msg = $('#answer-msg'), again = () => refreshRequests();
  $('#guest-save')?.addEventListener('click', async () => {
    const f = $('#guest-email');
    if (!f.value.trim() || !f.checkValidity()) { f.focus(); return; }
    try { await guestEmail(world.dev, r.id, f.value.trim()); f.value = ''; f.blur(); sfx.blip(); await again(); renderPhone(); }
    catch { tell(msg, 'That didn’t go through: check the address.'); }
  });
  // Send link: their link as the latest poll has it, opened on the server before it's sent (one shared before the server
  // took it would answer 404). The share sheet still needs the tap, so where the wait used it up, the next tap sends.
  const send = async (name, button, out) => {
    const p = store.list.find(x => x.id === r.id)?.guest?.people?.find(x => x.name === name);
    if (!p?.share) { button.remove(); out.textContent = `Nothing to send ${name} any more`; return; }
    if (!p.released) {
      button.disabled = true;
      try { await guestRelease(world.dev, r.id, name); p.released = true; }
      catch { out.textContent = `${name}’s link won’t open yet: the server didn’t take it. Tap Send link again.`; return; }
      finally { button.disabled = false; }
      if (navigator.userActivation?.isActive === false) { out.textContent = `${name}’s link opens now: tap Send link again to send it.`; return; }
    }
    share({ url: p.share }, out);
  };
  const redraw = async text => { await again(); renderPhone(); return text; };
  wirePeople(el, {
    send,
    remove: async name => { await guestRevoke(world.dev, r.id, 'person', name); return redraw(`${esc(name)} removed.`); },
    invite: async (name, email) => { await guestAdd(world.dev, r.id, name, email); return redraw(`${esc(name)} invited. Send link sends them theirs.`); },
  });
  el.querySelectorAll('[data-lang]').forEach(s => s.addEventListener('change', async e => {
    try { await guestLang(world.dev, r.id, e.target.value, s.dataset.person); sfx.blip(); await again(); }
    catch { el.querySelector('.invites .msg').textContent = 'That didn’t go through. Try again.'; }
  }));
  el.querySelector('[data-colleagues]')?.addEventListener('change', async e => {
    const box = e.target;
    box.disabled = true;
    try { await guestColleagues(world.dev, r.id, box.checked); sfx.blip(); await again(); renderPhone(); }
    catch (err) { box.checked = !box.checked; box.disabled = false; el.querySelector('.invites .msg').textContent = refused(err); }
  });
}

// An email card (outbox.ts): an agent's email to an outside party, for the board to read, edit and send. Who it goes to
// and where the answer comes in, who signs it (the board, or an agent on the crew's behalf), the subject and the text to
// edit, and the sign-off HQ puts under it. With the company's letter look (m.preview) the email shows as it will go, its
// sign-off as the signature, redrawn as the board edits it.
// (Signed by and its hint)
// (Answers: the mail a reply goes on the thread of.)
// (the answered card shows who it went to: its answer has the text)
const mailtoLine = (label, v) => v?.length ? `<dt>${label}</dt><dd>${esc([v].flat().join(', '))}</dd>` : '';
const mailtoHtml = m => `<dl class="mailto" data-private>${mailtoLine('To', m.to)}${mailtoLine('Cc', m.cc)}${mailtoLine('From', m.from)}${mailtoLine('Replies to', m.replyTo)}${mailtoLine('Signed by', m.signed && `${m.signed}, an AI agent`)}${mailtoLine('Answers', m.answers && `mail #${m.answers}`)}</dl>`;
// its attachments under the text: each picture (a tap shows it big), a PDF by its name
function mailFilesHtml(r, m) {
  const files = (m.attachments ?? []).map(f => ({ ...f, src: world.dev ? f.src : `/api/outbox/file?id=${Number(r.id)}&n=${Number(f.n)}` }));
  const pdfs = files.filter(f => f.type === 'application/pdf');
  const pictures = files.filter(f => f.type !== 'application/pdf').map(f => ({ src: f.src, title: f.name }));
  const pdfLinks = pdfs.map(f => `<a href="${esc(f.src)}" download>${esc(f.name)}</a>`).join(' · ');
  return figuresHtml(pictures) + (pdfs.length ? `<p class="mail-files" data-private>${pdfLinks}</p>` : '');
}
// a card's files (hq ask --file), under its text: each a download by its name, for
// the steps that say where it goes; a month after the card closed, its name alone
const filesHtml = r => fileListHtml((r.files ?? []).map(f => ({ ...f, src: f.kept ? `/api/requests/file?id=${Number(r.id)}&n=${Number(f.n)}` : null })));
// files to download, each { name, size, src } (src: null once its bytes are gone): a card's, or a guest checklist item's
const fileListHtml = files => files.length ? `<ul class="files">${files.map(f => `<li>${f.src
  ? `<a href="${esc(f.src)}" download="${esc(f.name)}">${DOWNLOAD}<span class="fn">${esc(f.name)}</span></a>`
  : `<span class="fn">${esc(f.name)}</span>`}<span class="size">${bytes(f.size)}</span></li>`).join('')}</ul>` : '';
// The board's edits are kept on this device like a card's answers (a redraw, a reload or closing the phone keeps them),
// until it sends or discards the email
const mailKey = m => `mail.${m.id}`;
function mailHtml(r, m) {
  const kept = saved.get(mailKey(m), null);
  return `${mailtoHtml(m)}
    <label class="key" data-private>Subject<input id="mail-subject" maxlength="200" spellcheck="true" value="${esc(kept?.subject ?? m.subject)}"></label>
    <label class="key" data-private>The email<textarea id="mail-text" rows="10" spellcheck="true">${esc(kept?.text ?? m.text)}</textarea></label>
    ${m.preview && !world.dev ? `<p class="mail-as">As it will go</p><iframe class="mail-letter" id="mail-letter" data-private title="The email as it will go" sandbox></iframe>`
      : `<p class="mail-sign">${esc(m.signoff)}</p>`}${mailFilesHtml(r, m)}
    <p class="hint" id="mail-hint" data-mail="${m.id}">${mailHint(m)}</p>`;
}
const mailHint = m => m.status === 'sending' ? 'It’s being sent right now.' : m.doubt ? `${esc(m.doubt)} Send it again, or discard it if it went.`
  : !m.ready ? 'The email service isn’t set up on the server yet, so Send can’t send anything.'
  : !m.name && !m.signed ? 'Your name for the sign-off is missing: add it under Settings › Care first.' : 'Nothing goes out until you send it.';
// A redraw held back while the board edits the email: its state still shows at once (being sent, or it may have gone)
function mailState() {
  const hint = $('#mail-hint'), m = hint && store.list.find(x => x.kind === 'mail' && x.mail?.id === Number(hint.dataset.mail))?.mail;
  if (m) hint.innerHTML = mailHint(m);
}
function wireMail(el, r) {
  const msg = $('#answer-msg'), buttons = () => el.querySelectorAll('#mail-send, #mail-discard');
  const act = async (go, busy, done) => {
    buttons().forEach(b => b.disabled = true); msg.textContent = busy;
    try {
      await go();
      saved.set(mailKey(r.mail), null);
      sfx.jingle(); msg.textContent = done;
      el.querySelectorAll('#mail-subject, #mail-text').forEach(f => { f.defaultValue = f.value; f.blur(); }); // done typing: the card may go
      fileAway(el.querySelector('.req'), r);
    } catch (err) {
      buttons().forEach(b => b.disabled = false);
      tell(msg, err.refusal?.error ?? 'Could not reach the coordinator. Try again.');
    }
  };
  // the letter as it will go follows this card's boxes: drawn from them as the card opens (an edit kept from before, or
  // from another device, never shows), redrawn once the board stops typing for a moment
  const letterFrame = el.querySelector('#mail-letter'), subjectBox = el.querySelector('#mail-subject'), textBox = el.querySelector('#mail-text');
  for (const box of [subjectBox, textBox]) box.addEventListener('input', () => saved.set(mailKey(r.mail), { subject: subjectBox.value, text: textBox.value }));
  if (letterFrame) {
    const redrawLetter = async () => {
      const subject = subjectBox.value.trim(), text = textBox.value;
      if (!letterFrame.isConnected || !subject || !text.trim()) return;   // (the card has gone, or there's nothing to draw)
      try {
        await outboxPreview(r.id, subject, text);
      } catch {
        return;   // a box over the limit, or the coordinator out of reach: the last letter drawn stays
      }
      if (letterFrame.isConnected) letterFrame.src = `/api/outbox/preview?id=${Number(r.id)}&at=${Date.now()}`;
    };
    let redraw;
    for (const box of [subjectBox, textBox]) {
      box.addEventListener('input', () => {
        clearTimeout(redraw);
        redraw = setTimeout(redrawLetter, 700);
      });
    }
    redrawLetter();
  }
  $('#mail-send').addEventListener('click', () => {
    const subject = $('#mail-subject'), text = $('#mail-text');
    const empty = [subject, text].find(f => !f.value.trim());
    if (empty) { empty.focus(); return; }
    act(() => outboxSend(world.dev, r.id, subject.value.trim(), text.value), 'Sending…', 'Sent.');
  });
  askAgain($('#mail-discard'), { status: msg, label: 'Discard', again: 'Tap again to discard', question: `Discard this email? Nothing is sent, and ${who(r.agent)} hears so.`,
    act: () => act(() => outboxDiscard(world.dev, r.id), 'Discarding…', 'Discarded.') });
}

// A call out (hq phone call): an agent phones an outside party, or meets them in a call room by a link the board sends
// on, once the board says Call. The card says who and how, what about, in which language and when, and a phone call's
// number only by its last digits until Show fetches it for this screen alone. The agent's first words (it's an AI, a
// transcript is kept) are fixed, so there's nothing to edit. The archive's card keeps who and how; its answer says how
// it went, and once it was held, what was said (heldHtml).
const LANGUAGE = new Intl.DisplayNames(['en'], { type: 'language' });
const callTime = ms => dayTime(ms, { timeZoneName: true });
// open: the card on the desk phone (the number with its Show, and when it calls without a time set)
function callHtml(c, open = false) {
  const phone = c.kind === 'phone';
  const when = c.at ? callTime(c.at) : open ? 'As soon as you say Call' : '';
  const number = open && phone && c.ending ? `<dt>Number</dt><dd><span id="call-number">Ending ${esc(c.ending)}</span><button type="button" class="call-show" id="call-show">Show</button>${c.digits ? ', then types dial-in digits' : ''}</dd>` : '';
  return `<dl class="mailto" data-private>${mailtoLine('Who', phone ? `${c.name} calls ${c.who}` : `${c.name} meets ${c.who} in a call room`)}${mailtoLine('About', c.about)}${number}
    ${mailtoLine('Language', c.lang && LANGUAGE.of(c.lang))}${mailtoLine('When', when && (phone ? `${when}, only within calling hours (${c.hours})` : when))}${mailtoLine('Held', heldWhen(c))}</dl>
    ${open ? `<p class="hint" id="call-hint">${phone ? `${esc(c.name)} says first that they’re an AI and that a written transcript is kept. One call, never redialled.` : 'You get a link to send them. It opens for one call.'}</p>` : ''}${heldHtml(c)}`;
}
// A call that was held (callcard.ts): when, the agent's notes, then who said what, line by line as the voice line wrote
// it ("<speaker>: …"). Once they objected, the notes only; 12 months on (or never handed over), neither.
const held = c => c.status === 'done' && !!c.started;
const heldWhen = c => held(c) && `${callTime(c.started)}, ${lasted(Date.parse(c.ended) - Date.parse(c.started))}`;
function heldHtml(c) {
  if (!held(c)) return '';
  if (!c.kept) return `<p class="hint">${c.deleted ? 'Its transcript and notes were deleted 12 months after the call.' : 'The voice line handed nothing over: there’s no transcript and no notes.'}</p>`;
  const notes = c.notes.length ? `<ul>${c.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : `<p class="hint">${esc(c.name)} took no notes.</p>`;
  const line = l => { const m = /^(?!\()([^]+?): ([^]*)$/.exec(l); return m ? `<p><b>${esc(m[1])}</b> ${esc(m[2])}</p>` : `<p class="aside">${esc(l)}</p>`; };
  const transcript = c.objected ? `<p class="hint">They’d rather we kept no transcript, so there is none: only ${esc(c.name)}’s notes.</p>`
    : c.transcript.length ? `<details class="transcript" open><summary>Transcript · ${c.transcript.length} ${c.transcript.length === 1 ? 'line' : 'lines'}</summary>${c.transcript.map(line).join('')}</details>`
    : '<p class="hint">Nothing was said on it.</p>';
  return `<section class="call-held"><h4>${esc(c.name)}’s notes</h4>${notes}${transcript}</section>`;
}
const callButtons = c => `<button class="send approve" id="call-go"${c.status === 'open' ? '' : ' disabled'}>${TICK}Call</button><button class="send later" id="call-decline"${c.status === 'open' ? '' : ' disabled'}>Don’t call</button>`;
function wireCall(el, r) {
  const msg = $('#answer-msg'), buttons = () => el.querySelectorAll('#call-go, #call-decline');
  const act = async (go, busy, done) => {
    buttons().forEach(b => b.disabled = true); msg.textContent = busy;
    try {
      const answer = await go();
      sfx.jingle();
      if (answer?.link) return showLink(answer);
      msg.textContent = done;
      fileAway(el.querySelector('.req'), r);
    } catch (err) {
      buttons().forEach(b => b.disabled = false);
      tell(msg, err.refusal?.error ?? 'Could not reach the coordinator. Try again.');
    }
  };
  // a call room's link stays on screen until Done (typing() holds the phone's redraws back), its card already off the list
  const showLink = ({ link, opens, closes }) => {
    const row = el.querySelector('.req .btns'), open = Date.parse(opens) <= Date.now() ? 'Open now' : `Opens ${callTime(opens)}`;
    row.querySelectorAll('button').forEach(b => b.remove());
    $('#call-hint').remove();
    row.insertAdjacentHTML('beforebegin', `<div class="call-link"><p class="hint">Send them this link. ${esc(open)} until ${esc(callTime(closes))}, for one call.</p><p class="call-url">${esc(link)}</p></div>`);
    row.insertAdjacentHTML('afterbegin', `<button class="send" id="call-copy">Copy</button>${navigator.share ? `<button class="send later" id="call-share">${SHARE}Share</button>` : ''}<button class="send later" id="call-done">Done</button>`);
    msg.textContent = 'Approved.';
    setRequests(store.list.filter(x => x.id !== r.id));
    $('#call-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(link); msg.textContent = 'Copied: paste it into a message'; sfx.blip(); } catch { tell(msg, 'Couldn’t copy on this device'); }
    };
    $('#call-share')?.addEventListener('click', () => share({ url: link }, msg));
    $('#call-done').onclick = () => { sfx.blip(); el.querySelector('.call-link').remove(); renderPhone(); };
  };
  $('#call-show')?.addEventListener('click', async e => {
    const button = e.currentTarget;
    button.disabled = true;
    try { $('#call-number').textContent = (await calloutNumber(world.dev, r.id)).number; button.remove(); sfx.blip(); }
    catch (err) { button.disabled = false; tell(msg, /404$/.test(err.message) ? 'The number shows only while the call is still to come.' : 'Could not reach the coordinator. Try again.'); }
  });
  $('#call-go').addEventListener('click', () => act(() => calloutApprove(world.dev, r.id), 'Approving…', 'Calling is approved.'));
  askAgain($('#call-decline'), { status: msg, label: 'Don’t call', again: 'Tap again to decline', question: `Don’t call? Nobody is called, and ${who(r.agent)} hears so.`,
    act: () => act(() => calloutDecline(world.dev, r.id), 'Declining…', 'Declined. Nobody is called.') });
}

// ---------------------------------------------------------------- answered cards (the archive)
// The cards that have left the desk phone, newest first (GET /api/requests/archive): what the board answered, and the
// card's presentation (opening in the viewer, like an open card's button), clips and pictures, to show again, every card
// whole. The open cards' polling doesn't redraw it; the list loads as it opens, a
// page at a time (Older cards loads the next, so every card stays reachable).
const FILED = icon('filed');
let past = null; // the archive while it's on the phone: { list (the pages so far), more, total, at: the card open (an index), or -1 for the list }
// The phone at an answered card from HQ's search, including cards beyond the first page.
export async function openAnswered(id) { await openPhone(); await openPast(id); }
async function openPast(card = null) {
  const el = $('#phone-screen'); if (!el) return;
  const me = past = { card, list: null, more: false, total: 0, at: -1 };
  laterView = false;
  paintPastBtn(); el.innerHTML = '<p class="muted">Opening the files…</p>';
  try {
    const p = await loadArchive(world.dev);
    Object.assign(me, { list: p.cards, more: p.more, total: p.total, at: p.cards.findIndex(r => r.id === card) });
    while (past === me && card != null && me.at < 0 && me.more) {
      if (!(await olderPast())) throw new Error('The next archive page did not load');
      me.at = me.list.findIndex(r => r.id === card);
    }
  } catch { me.list = null; }
  if (past === me) renderPast();
}
// the next page, after the last card loaded; false if it didn't come
async function olderPast() {
  const me = past;
  try { const p = await loadArchive(world.dev, me.list.at(-1).id); if (past === me) Object.assign(me, { list: me.list.concat(p.cards), more: p.more, total: p.total }); return true; } catch { return false; }
}
function leavePast() { past = null; listing = false; paintPastBtn(); renderPhone(); }
function paintPastBtn() { const b = root().querySelector('[data-past]'); if (!b) return; b.setAttribute('aria-pressed', String(!!past)); b.querySelector('span').textContent = past ? 'Waiting' : 'Answered'; }
const day = ts => {
  const f = companyFormats(), d = f.dayAt(new Date(ts));
  return f.day(d, 'en', { short: true, year: d.slice(0, 4) !== f.today().slice(0, 4) });
};
// What the board answered, in a line: a tapped choice is the answer's first line (send() above writes it that way).
const answerLine = r => r.status === 'done' ? `Taken off your ${names.phone}` : (r.answer || '').split('\n')[0].trim();
function renderPast() {
  const el = $('#phone-screen'); if (!el || !past) return;
  const list = past.list;
  if (!list) { el.innerHTML = `<div class="quiet problem">${stateSign('alert')}<b>The files didn’t open.</b><span>Could not reach the coordinator.</span><button class="past-link" data-again>Try again</button></div>`; el.querySelector('[data-again]').onclick = () => openPast(past.card); return; }
  if (past.at >= 0 && list[past.at]) return renderPastCard(el, list, past.at);
  // (what a card has beyond its words; a held call's transcript)
  const has = r => [r.call?.transcript?.length && 'transcript', deckOf(r.body) && 'presentation', videos(r.body).length && `${videos(r.body).length} ${videos(r.body).length === 1 ? 'clip' : 'clips'}`,
    pictures(r).length && `${pictures(r).length} ${pictures(r).length === 1 ? 'picture' : 'pictures'}`].filter(Boolean).join(' · ');
  const total = Math.max(past.total, list.length);
  el.innerHTML = list.length ? `<p class="past-cap">${total} answered ${total === 1 ? 'card' : 'cards'}, newest first</p><ul class="past-list">${list.map((r, i) => `
    <li${r.kind === 'mail' ? ' data-private' : ''}>${covered('', `data-card="${i}"`, r.title, `<b>${withJobLinks(r.title)}</b><span class="meta">${esc(day(r.answered || r.created))}${r.agent ? ` · ${esc(who(r.agent))}` : ''}${answerLine(r) ? ` · ${esc(answerLine(r).slice(0, 80))}` : ''}</span>${has(r) ? `<span class="has">${esc(has(r))}</span>` : ''}`)}</li>`).join('')}</ul>
    ${past.more ? `<button class="past-older" data-older>Older cards ›</button>` : ''}`
    : `<div class="quiet">${stateSign('filed')}<b>Nothing answered yet.</b><span>Cards you answer are kept here.</span></div>`;
  el.querySelectorAll('[data-card]').forEach(b => b.onclick = () => { past.at = +b.dataset.card; sfx.blip(); renderPast(); el.scrollTop = 0; });
  const older = el.querySelector('[data-older]');
  if (older) older.onclick = async () => {
    sfx.blip(); older.disabled = true; older.textContent = 'Opening…';
    const top = el.scrollTop, me = past;
    if (await olderPast()) { if (past === me) { renderPast(); el.scrollTop = top; } } else { older.disabled = false; older.textContent = 'Didn’t open. Try again ›'; }
  };
}
// closing: HQ's own line on a card whose matter ended by itself, never shown as the board's. An email draft its drafter
// withdrew (hq close) says so.
function renderPastCard(el, list, at) {
  const r = list[at], deck = deckOf(r.body), card = cardOf(r.body || ''), unpaired = pairsOf(r.body || '').rest, said = (r.answer || '').trim();
  const pick = card?.choices.find(ch => said.split('\n')[0].trim() === ch.label)?.label;
  el.innerHTML = `
    <nav class="pager">${arrowsAround(at, at < list.length - 1 || past.more, 'Newer', 'Older', `<button class="to-list" data-list>All answered · ${at + 1} of ${Math.max(past.total, list.length)}</button>`)}</nav>
    <article class="req past">
      <p class="meta"><span class="tag-k">${esc(r.kind || 'request')}</span> ${r.agent ? `from <b>${esc(who(r.agent))}</b> · ` : ''}asked ${esc(day(r.created))}${r.answered ? ` · ${r.status === 'done' ? 'filed' : 'answered'} ${esc(day(r.answered))}` : ''}</p>
      <h3>${withJobLinks(r.title)}</h3>
      ${r.status === 'done' ? `<p class="said"><b>Filed</b> ${esc(r.closing ? names.hq : who(r.agent))} ${r.mail?.status === 'withdrawn' ? 'withdrew the draft: it wasn’t sent' : `took it off your ${esc(names.phone)}`}${said ? `. ${inline(said)}` : '.'}</p>`
        : said ? `<p class="said"${r.kind === 'mail' ? ' data-private' : ''}><b>You answered</b> ${inline(said)}</p>` : ''}
      ${r.closing ? `<p class="said"><b>${esc(names.hq)}</b> ${inline(r.closing)}</p>` : ''}
      ${deck ? `<a class="signin" href="${esc(deck)}" target="_blank" rel="noopener">Open the presentation ↗</a>` : ''}
      ${pairsHtml(card.pairs)}${clipsHtml(unpaired)}${picsHtml(unpaired, r)}${filesHtml(r)}${r.kind === 'guest' && r.guest ? checklistHtml(r.guest) : ''}${r.kind === 'mail' && r.mail ? mailtoHtml(r.mail) : ''}${r.kind === 'call' && r.call ? callHtml(r.call) : ''}
      <details class="more"${deck || videos(r.body).length || pictures(r).length ? '' : ' open'}><summary>The card</summary>${pastCardHtml(card, pick)}</details>
    </article>`;
  el.querySelector('[data-list]').onclick = () => { past.at = -1; sfx.blip(); renderPast(); };
  el.querySelectorAll('[data-step]').forEach(b => b.onclick = async () => {
    const me = past, next = at + +b.dataset.step;
    sfx.blip(); b.disabled = true;
    if (next >= me.list.length && !(await olderPast())) { b.disabled = false; return; } // past the last card loaded: the next page first
    if (past !== me || !me.list[next]) return;
    me.at = next; renderPast(); el.scrollTop = 0;
  });
  el.querySelectorAll('[data-doc]').forEach(a => a.onclick = e => { e.preventDefault(); const back = { ...past }; closeTool(); openLibraryDoc(a.dataset.doc, () => { openPhone().then(() => { past = back; paintPastBtn(); renderPast(); }); }); });
  el.querySelectorAll('.clips video').forEach(v => v.onplay = () => el.querySelectorAll('.clips video').forEach(o => { if (o !== v) o.pause(); }));
  copyBlocks(el.querySelector('.req'), { under: true });
  wirePics(el, { pairs: card.pairs }); wireCopies(el);
}
// The card as it was, to read: no answer box, the choice the board made marked (its details as prose)
const pastCardHtml = (c, pick) => `${textHtml(c.summary[0])}
  ${shownRecommend(c) ? `<p class="rec"><b>Recommended</b> ${inline(c.recommend)}</p>` : ''}
  ${c.choices.length ? `<ul class="was">${c.choices.map(ch => `<li${ch.label === pick ? ' class="on"' : ''}><b>${esc(ch.label)}</b>${ch.label === pick ? '<em>Your choice</em>' : ch.rec ? '<em class="rec-k">Recommended</em>' : ''}${ch.desc ? `<span>${inline(ch.desc)}</span>` : ''}</li>`).join('')}</ul>` : ''}
  ${textHtml(c.after)}
  ${c.steps.length ? `<ol class="was steps-was">${c.steps.map(s => `<li><div class="step prose">${prose(s, inline)}</div></li>`).join('')}</ol>` : ''}
  ${textHtml(c.afterSteps)}
  ${c.options.length ? `<p class="body">Options: ${c.options.map(esc).join(' · ')}</p>` : ''}
  ${textHtml(c.details)}${laterHtml(c)}`;

// Pictures a card refers to (card.js's PIC), and in the archive the photos the board added to it. A tap shows one big,
// over the phone.
const pictures = (r, body = unfenced(r.body || '')) => [
  ...[...new Set((body || '').match(PIC) || [])].map(p => {
    const line = (body.split('\n').find(l => l.includes(p)) || '').replace(p, '').replace(/https?:\/\/\S+/g, '').replace(/[`*_]|^[\s\d.)•*-]+|[\s:–—-]+$/g, '').trim();
    return { src: pictureSrc(p), title: line && line.length <= 60 ? line : pictureTitle(p) };
  }),
  ...(r?.photos || []).map((p, i) => p.saved ? { src: archivePhoto(world.dev, r.id, i), title: `Your photo: ${p.label}` } : null).filter(Boolean)];
// (a picture's file name as its title: slip_front.jpg, "Slip front"; pictureTitle, figuresHtml and picsHtml split out
// for messageHtml.)
const pictureTitle = p => {
  const name = String(p).split('/').pop().replace(/\.\w+$/, '').replace(/[-_]+/g, ' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
};
const figuresHtml = pics => pics.length ? `<div class="pics">${pics.map(p => `<figure><button type="button" data-pic="${esc(p.src)}" data-label="${esc(p.title)}" aria-label="Show ${esc(p.title)} bigger"><img src="${esc(p.src)}" alt="" loading="lazy"></button><figcaption>${esc(p.title)}</figcaption></figure>`).join('')}</div>` : '';
const picsHtml = (body, r = { body }) => figuresHtml(pictures(r, unfenced(body || '')));
// A card's before-and-after pairs (card.js pairsOf) lead it: each change as it
// was and as it is now, side by side, a tap showing one big, and its live link under them
const pairsHtml = pairs => pairs.length ? `<div class="pairs">${pairs.map((p, i) => `<figure class="pair"><figcaption>${esc(p.label)}</figcaption>
  <div class="ba">${[['Before', p.before], ['After', p.after]].map(([was, file]) => `<button type="button" data-pic="${esc(pictureSrc(file))}" data-pair="${i}" data-side="${was.toLowerCase()}" aria-label="Show ${esc(p.label)} (${was.toLowerCase()}) bigger"><img src="${esc(pictureSrc(file))}" alt="" loading="lazy"><span>${was}</span></button>`).join('')}</div>
  ${p.link ? `<p class="live">${inline(p.link)}</p>` : ''}</figure>`).join('')}</div>` : '';
// A tap opens one viewer for all the pictures beside it (a card's, or one intercom line's: within `each`): the card's
// pairs first, as they lead it, a pair's two as one (pictures.js), then its other pictures.
function wirePics(el, { pairs = [], each } = {}) {
  for (const group of each ? el.querySelectorAll(each) : [el]) {
    const singles = [...group.querySelectorAll('[data-pic]:not([data-pair])')];
    const items = [...pairs.map(p => ({ label: p.label, before: pictureSrc(p.before), after: pictureSrc(p.after) })),
      ...singles.map(b => ({ label: b.dataset.label, src: b.dataset.pic }))];
    group.querySelectorAll('[data-pair]').forEach(b => b.onclick = () => viewPictures(items, +b.dataset.pair, b.dataset.side, root()));
    singles.forEach((b, i) => b.onclick = () => viewPictures(items, pairs.length + i, 'before', root()));
  }
}

// ---------------------------------------------------------------- request cards (card.js reads them)
// a document's file name opens it in the Library (the board reads documents there, never in the repo): card.js docParts
const docLink = n => `<a href="#" class="doc-link" data-doc="${esc(n)}">${esc(n.split('/').pop().replace(/\.md$/, '').replace(/[-_]/g, ' '))} (${esc(names.libraryShort)})</a>`;
// [text](address) links and bare addresses: prose.js's `linked` and `bare`; its jobs linked as prose.js's `strong` links
// them
const inline = s => {
  const words = jobsIn(s);
  return s.split(/`([^`\n]+)`/).map((p, i) => i % 2
    ? (DOC_CODE.test(p) ? docLink(p) : `<button type="button" class="copy" data-copy="${esc(p)}" title="Copy">${esc(p)}</button>`)
    : linked(p, t => bare(t, q => docParts(q).map((u, k) => k % 2 ? docLink(u) : words(u)).join('')), esc).replace(BOLD, '<b>$1</b>').replace(/\n/g, '<br>')).join('');
};
// An older card can carry both a Choose: list and an Options: line: an option that repeats a choice shows once, as its
// row
function cardHtml(r, c, clips = '') {
  const done = new Set(saved.get(`steps.${r.id}`, []));
  const options = c.options.filter(o => !c.choices.some(ch => ch.label === o));
  return `${textHtml(c.summary[0])}${clips}
    ${shownRecommend(c) ? `<p class="rec"><b>Recommended</b> ${inline(c.recommend)}</p>` : ''}
    ${c.choices.length ? `<div class="choices" role="radiogroup" aria-label="Your choice">${c.choices.map((ch, i) => `<label class="choice${chosen.get(choiceKey(r)) === i ? ' on' : ''}"><input type="radio" name="choice-${r.id}" value="${i}"${chosen.get(choiceKey(r)) === i ? ' checked' : ''}><span class="cl"><b>${esc(ch.label)}</b>${ch.rec ? '<em>Recommended</em>' : ''}</span>${ch.desc ? `<span class="cd">${inline(ch.desc)}</span>` : ''}</label>`).join('')}</div>` : ''}
    ${textHtml(c.after)}
    ${c.steps.length ? `<ol class="steps">${c.steps.map((s, i) => `<li${done.has(i) ? ' class="done"' : ''}><label class="tick"><input type="checkbox" data-tick="${i}"${done.has(i) ? ' checked' : ''}><span class="sr">Done</span></label><div class="step prose">${prose(s, inline)}</div></li>`).join('')}</ol>` : ''}
    ${textHtml(c.afterSteps)}
    ${c.claude ? '<button type="button" class="claude-task" data-claude>Copy task for Claude</button>' : ''}
    ${options.length ? `<div class="opts">${options.map(o => `<button type="button" data-opt="${esc(o)}">${esc(o)}</button>`).join('')}</div>` : ''}
    ${c.details || c.later ? `<details class="more"><summary>More</summary>${textHtml(c.details)}${laterHtml(c)}</details>` : ''}`;
}
// How to stop or undo it later (card.js laterOf), under More: never part of what the board does now
const laterHtml = c => c.later ? `<p class="body later"><b>To stop or undo it later</b></p>${textHtml(c.later)}` : '';
// A card's own text and its details are prose: lists, and fenced blocks to paste (copy.js gives them a Copy button)
const textHtml = text => text ? `<div class="body prose">${prose(text, inline)}</div>` : '';
// What Claude in Chrome gets: the task, the steps, and when to hand over to the board. Keys never go through it.
function claudeTask(r, c, keys) {
  const plain = s => fencedLines(s).map(({ line, fence, fenced }) => fence || fenced ? line
    : line.replace(/`([^`]+)`/g, '"$1"').replace(/\*\*(.+?)\*\*/g, '$1')).join('\n');
  const ext = keys?.filter(k => !AGE.test(k)); // a backup key is made in HQ, never by Claude
  return `Help me with a setup task in this browser, for my company (${world.company.legal ? `${world.company.legal}, trading as ` : ''}${world.company.name}): ${r.title}.

${plain(c.summary[0] || '')}

Steps:
${c.steps.map((s, i) => `${i + 1}. ${plain(s).replace(/\n/g, '\n   ')}`).join('\n')}
${c.afterSteps ? `\n${plain(c.afterSteps)}\n` : ''}${c.details ? `\nBackground:\n${plain(c.details)}\n` : ''}
How to work:
- Do the clicking and typing for me, one step at a time, and tell me briefly what you're doing.
- Stop and hand over to me for: passwords, 2FA or passkeys, identity or document uploads, anything that costs money, and accepting terms or signing anything.
- If a page doesn't match these steps, stop and ask me.
- Never type, read out or repeat keys, passwords or codes in this chat.${ext?.length ? `\n- At the end, stop on the page that shows ${ext.map(keyLabel).join(', ')} and tell me: I'll copy them into ${names.hq} myself.` : ''}`;
}
const chosen = new Map(); // a card as last changed → the choice tapped (kept across re-renders)
// a rewritten card starts with nothing chosen: its choices may have changed
const choiceKey = r => `${r.id} ${cardTime(r)}`;
function wireCard(el, r, c, keys) {
  el.querySelectorAll('[data-doc]').forEach(a => a.onclick = e => { e.preventDefault(); const from = idx; closeTool(); openLibraryDoc(a.dataset.doc, () => { openPhone().then(() => { idx = from; renderPhone(); }); }); });
  // one clip plays at a time
  el.querySelectorAll('.clips video').forEach(v => v.onplay = () => el.querySelectorAll('.clips video').forEach(o => { if (o !== v) o.pause(); }));
  el.querySelectorAll('.choice input').forEach(i => i.onchange = () => {
    chosen.set(choiceKey(r), +i.value); el.querySelectorAll('.choice').forEach(l => l.classList.toggle('on', l.contains(i))); sfx.blip();
    const a = $('#answer'); if (a) a.placeholder = 'Anything to add (optional)';
  });
  wireCopies(el);
  el.querySelectorAll('.req').forEach(req => copyBlocks(req, { under: true })); // (Copy under the block)
  el.querySelectorAll('[data-tick]').forEach(t => t.onchange = () => {
    const done = new Set(saved.get(`steps.${r.id}`, [])); t.checked ? done.add(+t.dataset.tick) : done.delete(+t.dataset.tick);
    saved.set(`steps.${r.id}`, [...done]); t.closest('li').classList.toggle('done', t.checked); sfx.blip();
  });
  el.querySelectorAll('[data-opt]').forEach(b => b.onclick = () => {
    const a = $('#answer'); if (!a) return;
    a.value = b.dataset.opt; el.querySelectorAll('[data-opt]').forEach(x => x.classList.toggle('on', x === b)); sfx.blip();
  });
  el.querySelector('[data-claude]')?.addEventListener('click', async e => {
    try { await navigator.clipboard.writeText(claudeTask(r, c, keys)); e.target.textContent = 'Copied: paste it into Claude in Chrome'; sfx.blip(); }
    catch { e.target.textContent = 'Couldn’t copy on this device'; }
  });
}

// a card's `words` to copy, a tap each (the archive's too)
const wireCopies = el => el.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => {
  try { await navigator.clipboard.writeText(b.dataset.copy); b.classList.add('copied'); sfx.blip(); setTimeout(() => b.classList.remove('copied'), 1200); } catch { /* no clipboard */ }
});
// Everything HQ shares: a link ({ url }: Send link, a card's Share part that is only a link) or a card's Share part written
// as a message ({ text }; the server's, by its author for an outsider; never a card about keys). The phone's own share
// sheet, or the clipboard where there's none. A link goes as its URL alone, no text or title: with text, Windows' sheet
// offers no Copy and Teams receives nothing. share() runs straight from the tap, as iOS wants.
async function share(shareData, msg) {
  if (navigator.share) {
    try { await navigator.share(shareData); return; }
    catch (e) { if (e.name === 'AbortError') return; } // closed the sheet; anything else falls back to copying
  }
  try { await navigator.clipboard.writeText(shareData.url ?? shareData.text); msg.textContent = 'Copied: paste it into a message'; sfx.blip(); }
  catch { tell(msg, 'Couldn’t share or copy on this device'); }
}

// ---------------------------------------------------------------- questions on the desk phone
// A card's questions (hq ask --questions: a yes or no, a number, a short text, a choice) are fields, each its own input in
// order, drawn by the engine the guest page uses (questions.js). They come first, with the photo and file fields after
// them, and the answer box, optional then, last; a card without questions keeps its answer box above its file fields.
// What the board has answered so far is kept on this device until it sends (a redraw or a reload keeps it). An optional
// question may be left blank: its box says so, and its chip taps off again.
const draftKey = r => `answers.${r.id}`;
const forgetAnswers = r => saved.set(draftKey(r), null);
function answerFields(r, box) {
  const files = `${photoFields(r)}${documentFields(r)}${zipFields(r)}`;
  if (!r.questions?.length) return `${box}${files}`;
  const got = saved.get(draftKey(r), null) ?? {};
  const one = (q, k) => {
    const id = `q${r.id}-${k}`, title = chips(q) ? `<span class="ql" id="${id}">${esc(q.title)}</span>` : `<label class="ql" id="${id}" for="${id}-a">${esc(q.title)}</label>`;
    return `<li data-q="${k}"${q.many ? ' data-many' : ''}>${title}${q.detail ? `<span class="qd">${esc(q.detail)}</span>` : ''}<div class="qa"${chips(q) ? ` role="group" aria-labelledby="${id}"` : ''}>${inputHtml(q, { id: `${id}-a`, value: got[k] ?? '', placeholder: q.optional ? 'Optional' : '' })}</div></li>`;
  };
  return `<ol class="questions">${r.questions.map(one).join('')}</ol>${files}${box}`;
}
// What each question holds now: the chip tapped, or what's typed; a pick-many's, the chips on
const answersIn = el => [...el.querySelectorAll('.questions > li')].map(li => li.hasAttribute('data-many') ? [...li.querySelectorAll('.chip.on')].map(c => c.dataset.answer)
  : li.querySelector('.chip.on')?.dataset.answer ?? li.querySelector('input')?.value.trim() ?? '');
function wireQuestions(el, r) {
  const keep = () => saved.set(draftKey(r), Object.fromEntries(answersIn(el).map((a, k) => [k, a]).filter(([, a]) => a)));
  el.querySelectorAll('.questions .chip').forEach(b => b.onclick = () => {
    const li = b.closest('li'), many = li.hasAttribute('data-many'), off = !many && r.questions[li.dataset.q].optional && b.classList.contains('on');   // (a pick-many's chip goes on or off by itself; an optional choice's taps off again)
    li.querySelectorAll('.chip').forEach(c => { if (many && c !== b) return; const on = many ? !c.classList.contains('on') : c === b && !off; c.classList.toggle('on', on); c.setAttribute('aria-pressed', String(on)); });
    li.classList.remove('missing'); keep(); sfx.blip();
  });
  el.querySelectorAll('.questions input').forEach(i => i.addEventListener('input', () => { i.closest('li').classList.remove('missing'); keep(); }));
}
// Send: every question answered (an optional one may be blank), as the server will take it (a number as a number); the first that isn't is marked
function questionsReady(el, r) {
  const got = answersIn(el), k = r.questions.findIndex((q, i) => given(q, got[i]) === null);
  if (k < 0) return true;
  const q = r.questions[k], li = el.querySelector(`.questions > li[data-q="${k}"]`);
  li.classList.add('missing'); (li.querySelector('input') ?? li.querySelector('.chip')).focus();
  $('#answer-msg').textContent = q.type === 'number' && got[k] ? `“${q.title}” takes a number, like 3 or 3.5.` : `Answer “${q.title}” first.`;
  return false;
}
// The answer box is optional on a card the board answers in its fields: one with questions, or with a file in one of its
// photo, document or zip fields (the required ones are fieldsReady's)
const answeredInFields = r => !!r.questions?.length || [...(r.photos ?? []), ...(r.documents ?? [])].some(f => f.saved)
  || (r.zips ?? []).some((z, i) => zipField(r, i).state === 'imported');
// a card's pictures, a tray like the intercom's (tray.js) for each card with an answer
// box, kept across redraws until its answer is sent. Picked with the button, pasted or dropped on the card.
const cardTrays = new Map();
function cardTray(r) {
  let t = cardTrays.get(r.id);
  if (t) return t;
  const here = () => store.list[idx]?.id === r.id && !listing && !laterView && !past;   // (its card on the phone now)
  t = new Tray(r.id, () => here() ? $('#answer-pics') : null, s => { const m = here() && $('#answer-msg'); if (m) m.textContent = s; });
  cardTrays.set(r.id, t); t.restore();
  return t;
}
function wireTray(el, t) {
  const inp = el.querySelector('#answer-file'), card = el.querySelector('.req');
  const catchUp = () => { if (stale && !typing()) renderPhone(); };
  t.paint();
  el.querySelector('#answer-attach').onclick = () => {
    picking = true; inp.click();   // (no redraw while the picker is open: it would take the input away)
    addEventListener('focus', () => setTimeout(() => { if (picking && !inp.files?.length) { picking = false; catchUp(); } }, 1500), { once: true });
  };
  inp.addEventListener('cancel', () => { picking = false; catchUp(); });
  inp.onchange = () => { picking = false; t.add(inp.files); inp.value = ''; };
  card.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.files ?? [])].filter(f => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); t.add(files); }
  });
  card.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
  card.addEventListener('drop', e => { if (!e.dataTransfer?.files.length || e.target.closest('.photos')) return; e.preventDefault(); t.add(e.dataTransfer.files); });
}

// ---------------------------------------------------------------- photos on the desk phone
// A request can ask for photos next to its answer (photos.ts). Each field is one big tap target around a file input
// (camera or library). A picked picture is redrawn on a canvas (the long side at most 2560 px) and sent as a JPEG at
// once: that drops the camera's metadata (GPS) and turns HEIC into JPEG. The server strips metadata again anyway.
const thumbs = new Map(); // `${request}:${field}` → an object URL of what was just sent, kept across re-renders
let picking = false, uploading = 0;        // a file picker is open, or a photo is on its way: no re-render meanwhile
const photoBusy = () => picking || uploading > 0;
const CAMERA = icon('camera');
function photoFields(r) {
  if (!r.photos?.length) return '';
  const shots = shotsOf(r),
    boxes = r.photos.map((p, i) => photoBox(r, p, i, shots ? SHOT_TAGS[shotOf(p)] : '')).join(''),
    line = shots ? `\n    <p class="hint shots">${shots.join('<br>')}</p>` : '';
  return `<div class="photos" role="group" aria-label="Photos">${boxes}${line}
    <p class="hint">Tap a box to take a photo or pick one. It's sent right away, without the location your camera stores.</p></div>`;
}
// One photo field's box, with its tag (a product or a check photo) on a card that asks for a product shot
function photoBox(r, p, i, tag) {
  const t = thumbs.get(`${r.id}:${i}`);
  return `
    <label class="photo${p.saved ? ' is-saved' : ''}" data-field="${i}">
      <span class="thumb">${t ? `<img src="${t}" alt="">` : CAMERA}</span>
      <span class="pl">${tag ? `<span class="shot shot-${shotOf(p)}">${tag}</span>` : ''}${esc(p.label)}${p.optional ? ' <i>(optional)</i>' : ''}${p.saved ? ' <b class="saved">saved ✓</b>' : ''}</span>
      <span class="act">${p.saved ? 'Replace' : 'Add photo'}</span>
      <input type="file" accept="image/*" data-photo="${i}" aria-label="${tag ? `${tag}: ` : ''}${esc(p.label)}${p.optional ? ' (optional)' : ''}">
    </label>`;
}
// A product shot (photos.ts shot) is a photo for the shop, which the photo studio edits. A card with one tags each
// field as a product or a check photo and says once what each kind needs. A card without one shows no tags.
const SHOT_TAGS = { product: 'Product photo', check: 'Check photo' };
const shotOf = p => (p.shot === 'product' ? 'product' : 'check');
function shotsOf(r) {
  const kinds = new Set(r.photos.map(shotOf));
  if (!kinds.has('product')) return null;
  return [
    '<b>Product photo:</b> no ruler or tape, nothing else in the frame, a clean background, at the angle its label gives.',
    ...(kinds.has('check') ? ['<b>Check photo:</b> only for us to check the print, so a ruler is welcome.'] : []),
  ];
}
function wirePhotos(el, r) {
  const msg = (t, problem = false) => { const m = $('#answer-msg'); if (problem) tell(m, t); else if (m) m.textContent = t; };
  const catchUp = () => { if (stale && !typing()) renderPhone(); };
  el.querySelectorAll('input[data-photo]').forEach(inp => {
    const i = +inp.dataset.photo, box = inp.closest('.photo'), p = r.photos[i], key = `${r.id}:${i}`;
    inp.onclick = () => {
      picking = true; box.classList.remove('missing');
      // browsers without the input's cancel event: coming back without a pick ends it
      addEventListener('focus', () => setTimeout(() => { if (picking && !inp.files?.length) { picking = false; catchUp(); } }, 1500), { once: true });
    };
    inp.addEventListener('cancel', () => { picking = false; catchUp(); });
    inp.addEventListener('blur', () => setTimeout(catchUp)); // once focus has landed: moving on to the answer box isn't "done"
    inp.onchange = async () => {
      picking = false;
      const file = inp.files?.[0];
      if (!file) return catchUp();
      uploading++; box.classList.remove('missing'); box.classList.add('busy'); msg('Getting the picture ready…');
      let url;   // the new picture; `thumbs` keeps the one the server has until this one is saved
      try {
        const blob = await shrink(file);
        url = URL.createObjectURL(blob);
        box.querySelector('.thumb').innerHTML = `<img src="${url}" alt="">`;
        await uploadPhoto(world.dev, r.id, i, blob, pct => msg(`Sending “${p.label}”… ${pct}%`));
        const old = thumbs.get(key); thumbs.set(key, url); if (old) URL.revokeObjectURL(old);
        p.saved = true; box.classList.add('is-saved'); box.querySelector('.act').textContent = 'Replace';
        if (!box.querySelector('.saved')) box.querySelector('.pl').insertAdjacentHTML('beforeend', ' <b class="saved">saved ✓</b>');
        const left = r.photos.filter(x => !x.optional && !x.saved).length + (r.documents || []).filter(x => !x.optional && !x.saved).length;   // (documents)
        msg(left ? `Saved. ${left} more to go.` : 'All the photos are in. Add your answer and send.'); sfx.blip();
      } catch (err) {
        if (url) URL.revokeObjectURL(url);   // back to what the server has: the saved picture, or none
        const t = thumbs.get(key); box.querySelector('.thumb').innerHTML = t ? `<img src="${t}" alt="">` : CAMERA;
        const status = +String(err?.message ?? '').match(/\d{3}$/)?.[0];
        msg(err === 'decode' ? 'Couldn’t read that picture. Try a photo from the camera or a JPEG.'
          : status === 413 ? 'That picture is too big to send. Try another one.'
          : status === 409 ? 'This request was already answered.'
          : status ? `The server couldn’t save that photo (error ${status}). Try again in a minute.` : 'Could not reach the coordinator. Try the photo again.', true);
      } finally {
        uploading--; inp.value = ''; box.classList.remove('busy'); catchUp();
      }
    };
  });
}
// Send answer: every required photo and file first (and none still on its way).
function fieldsReady(el, r) {
  const msg = $('#answer-msg');
  if (uploading) { msg.textContent = 'Wait a moment: a file is still sending.'; return false; }
  const photo = (r.photos || []).findIndex(p => !p.optional && !p.saved), file = (r.documents || []).findIndex(d => !d.optional && !d.saved);
  const zip = (r.zips || []).findIndex((z, i) => !z.optional && zipField(r, i).state !== 'imported');
  if (photo < 0 && file < 0 && zip < 0) return true;
  const box = photo >= 0 ? el.querySelector(`.photo[data-field="${photo}"]`) : file >= 0 ? el.querySelector(`.photo[data-file-field="${file}"]`) : el.querySelector(`.photo[data-zip-field="${zip}"]`);
  box.classList.add('missing'); box.querySelector('input').focus();
  msg.textContent = photo >= 0 ? `Add a photo for “${r.photos[photo].label}” first.` : file >= 0 ? `Add the file for “${r.documents[file].label}” first.` : `Add the zip for “${r.zips[zip].label}” first.`;
  return false;
}
const forgetThumbs = id => { for (const [k, u] of thumbs) if (k.startsWith(`${id}:`)) { URL.revokeObjectURL(u); thumbs.delete(k); } };

// ---------------------------------------------------------------- files on the desk phone
// A request can ask for files the board has, like an invoice downloaded from a billing page (documents.ts). Each field
// is a box like a photo's around a file input. The file is sent as it is, never redrawn: the server keeps it byte for
// byte and files it as mail to the card's address when the answer goes.
const DOCUMENT_TYPES = 'application/pdf,.pdf,image/jpeg,image/png', MAX_DOCUMENT = 10 * 1024 * 1024; // documents.ts MAX_BYTES
const PAGE = icon('page');
function documentFields(r) {
  if (!r.documents?.length) return '';
  const to = [...new Set(r.documents.map(d => d.to))].join(' and ');
  return `<div class="photos files" role="group" aria-label="Files">${r.documents.map((d, i) => `
    <label class="photo file${d.saved ? ' is-saved' : ''}" data-file-field="${i}">
      <span class="thumb">${PAGE}</span>
      <span class="pl">${esc(d.label)}${d.optional ? ' <i>(optional)</i>' : ''}${d.saved ? ` <b class="saved">${d.mail ? 'filed' : 'saved'} ✓</b><small class="fn">${esc(d.name || '')}</small>` : ''}</span>${d.mail ? '' : `
      <span class="act">${d.saved ? 'Replace' : 'Pick file'}</span>
      <input type="file" accept="${DOCUMENT_TYPES}" data-document="${i}" aria-label="${esc(d.label)}${d.optional ? ' (optional)' : ''}">`}
    </label>`).join('')}
    <p class="hint">Pick each file as you downloaded it (a PDF, JPEG or PNG). It's kept exactly as it is and filed as mail to ${esc(to)} when you send.</p></div>`;
}
function wireDocuments(el, r) {
  const msg = (t, problem = false) => { const m = $('#answer-msg'); if (problem) tell(m, t); else if (m) m.textContent = t; };
  const catchUp = () => { if (stale && !typing()) renderPhone(); };
  el.querySelectorAll('input[data-document]').forEach(inp => {
    const i = +inp.dataset.document, box = inp.closest('.file'), d = r.documents[i];
    inp.onclick = () => {
      picking = true; box.classList.remove('missing');
      addEventListener('focus', () => setTimeout(() => { if (picking && !inp.files?.length) { picking = false; catchUp(); } }, 1500), { once: true });
    };
    inp.addEventListener('cancel', () => { picking = false; catchUp(); });
    inp.addEventListener('blur', () => setTimeout(catchUp));
    inp.onchange = async () => {
      picking = false;
      const file = inp.files?.[0];
      if (!file) return catchUp();
      if (file.size > MAX_DOCUMENT) { inp.value = ''; msg('That file is too big to send (10 MB at most).', true); return catchUp(); }
      uploading++; box.classList.remove('missing'); box.classList.add('busy');
      try {
        const sent = await uploadDocument(world.dev, r.id, i, file, pct => msg(`Sending “${d.label}”… ${pct}%`));
        Object.assign(d, { saved: true, name: sent.name });
        box.classList.add('is-saved'); box.querySelector('.act').textContent = 'Replace';
        box.querySelector('.pl').innerHTML = `${esc(d.label)}${d.optional ? ' <i>(optional)</i>' : ''} <b class="saved">saved ✓</b><small class="fn">${esc(d.name)}</small>`;
        const left = r.documents.filter(x => !x.optional && !x.saved).length + (r.photos || []).filter(x => !x.optional && !x.saved).length;
        msg(left ? `Saved. ${left} more to go.` : 'All the files are in. Add your answer and send.'); sfx.blip();
      } catch (err) {
        const status = +String(err?.message ?? '').match(/\d{3}$/)?.[0];
        msg(status === 415 ? 'That isn’t a PDF, JPEG or PNG. Pick the file you downloaded.'
          : status === 413 ? 'That file is too big to send (10 MB at most).'
          : status === 409 ? 'This request was already answered, or that file already filed.'
          : status === 507 ? 'The server has no room for files right now. Try again later.'
          : status ? `The server couldn’t save that file (error ${status}). Try again in a minute.` : 'Could not reach the coordinator. Try the file again.', true);
      } finally {
        uploading--; inp.value = ''; box.classList.remove('busy'); catchUp();
      }
    };
  });
}

// ---------------------------------------------------------------- big zips on the desk phone
// A request can ask for a big zip the board has (zips.ts). HQ sends it in chunks. A chunk that fails is sent again after
// a pause, and the server says where to go on from, so a dropped line, a deploy, or the same file picked again after a
// reload carries on where it stopped. The server unpacks it once the last chunk is in, and the box shows that too.
const ZIP_CHUNK = 8 * 1024 * 1024, ZIP_RETRY_MS = 5000, ZIP_GIVE_UP_MS = 10 * 60_000, ZIP_POLL_MS = 1500;
const BOX = icon('box');
const zipsSending = new Map(); // `${request}:${field}` → { sent, size, note } while this tab sends or waits on it
const zipsStopped = new Map(); // `${request}:${field}` → why this tab stopped waiting on its unpacking, until the next pick
const bytes = n => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${Math.round(n / 1024 ** 2)} MB` : `${Math.ceil(n / 1024)} KB`;
// The server's latest word on a zip field: the list's copy (a poll replaces the list's objects, and the upload's own
// answers go into it), or the drawn card's once it's off the list. The box and Send both read it, so they agree
const zipField = (r, i) => store.list.find(x => x.id === r.id)?.zips?.[i] ?? r.zips[i];
// A zip box as its field is now, wherever it is on screen now (the board may have gone to another card and back), its
// input left as it is
function paintZip(r, i) {
  const at = `${r.id}:${i}`, box = document.querySelector(`[data-zip="${at}"]`), drawn = document.createElement('div');
  if (!box) return;
  drawn.innerHTML = zipBox(r, i, zipField(r, i));
  const next = drawn.firstElementChild;
  box.className = next.className;
  box.classList.toggle('busy', zipsSending.has(at));
  box.querySelector('.pl').innerHTML = next.querySelector('.pl').innerHTML;
  box.querySelector('.act').textContent = next.querySelector('.act').textContent;
}
// A redraw held back while the board types: the zip boxes on screen still follow the list
function zipsState() {
  document.querySelectorAll('#phone-screen [data-zip]').forEach(box => {
    const [id, i] = box.dataset.zip.split(':').map(Number), r = store.list.find(x => x.id === id);
    if (r?.zips?.[i]) paintZip(r, i);
  });
}
function zipLine(r, i, z) {
  const here = zipsSending.get(`${r.id}:${i}`);
  if (here?.note) return here.note;
  if (here && z.state !== 'importing') return `Sending… ${bytes(here.sent)} of ${bytes(here.size)}`;
  if (z.state === 'uploading') return `Stopped at ${bytes(z.received)} of ${bytes(z.size)}. Pick the same file to carry on.`;
  if (z.state === 'importing') return zipsStopped.get(`${r.id}:${i}`) ?? 'Unpacking…';
  if (z.state === 'failed') return `Couldn’t unpack ${z.name}: ${z.error}.`;
  if (z.state !== 'imported') return '';
  const left = z.imported.leftOut.bytes ? `, leaving out ${bytes(z.imported.leftOut.bytes)} a computer can rebuild` : '';
  const what = z.imported.folders ? `${z.imported.folders} folders` : `${z.imported.files} ${z.imported.files === 1 ? 'file' : 'files'}`;
  return `${z.name}: ${what}, ${bytes(z.imported.bytes)}${left}`;
}
// Any file: a zip, or a single file the server keeps as it is
const zipBox = (r, i, z) => `
    <label class="photo file zip${z.state === 'imported' ? ' is-saved' : ''}" data-zip-field="${i}" data-zip="${r.id}:${i}">
      <span class="thumb">${BOX}</span>
      <span class="pl">${esc(z.label)}${z.optional ? ' <i>(optional)</i>' : ''}${z.state === 'imported' ? ' <b class="saved">imported ✓</b>' : ''}<small class="fn">${esc(zipLine(r, i, z))}</small></span>
      <span class="act">${z.state === 'imported' ? 'Replace' : z.state === 'uploading' ? 'Pick again' : 'Pick zip'}</span>
      <input type="file" data-zip-input="${i}" aria-label="${esc(z.label)}${z.optional ? ' (optional)' : ''}">
    </label>`;
function zipFields(r) {
  if (!r.zips?.length) return '';
  return `<div class="photos files" role="group" aria-label="Zips">${r.zips.map((z, i) => zipBox(r, i, z)).join('')}
    <p class="hint">Pick the zip as it is, or a single file. It goes in parts: if the connection drops, it carries on by itself, or pick the same file again. The server unpacks it as it arrives, and leaves out what a computer can rebuild, like node_modules.</p></div>`;
}
function wireZips(el, r) {
  const msg = (t, problem = false) => { const m = $('#answer-msg'); if (problem) tell(m, t); else if (m) m.textContent = t; };
  const catchUp = () => { if (stale && !typing()) renderPhone(); };
  el.querySelectorAll('input[data-zip-input]').forEach(inp => {
    const i = +inp.dataset.zipInput;
    inp.onclick = () => {
      picking = true; inp.closest('.zip').classList.remove('missing');
      addEventListener('focus', () => setTimeout(() => { if (picking && !inp.files?.length) { picking = false; catchUp(); } }, 1500), { once: true });
    };
    inp.addEventListener('cancel', () => { picking = false; catchUp(); });
    inp.addEventListener('blur', () => setTimeout(catchUp));
    inp.onchange = async () => {
      picking = false;
      const file = inp.files?.[0];
      inp.value = '';
      if (!file) return catchUp();
      const at = `${r.id}:${i}`;
      if (zipsSending.has(at)) return; // this tab is sending it already
      zipsStopped.delete(at);
      uploading++;
      // what the server says of the field, here and in the list a poll may have replaced since this card was drawn. A poll
      // already on its way has older news: it's dropped, as after an answer
      const paint = () => paintZip(r, i), latest = () => zipField(r, i);
      const learn = field => {
        if (!Object.keys(field ?? {}).length) return;
        store.seq++;
        for (const f of new Set([r.zips[i], latest()])) Object.assign(f, field);
      };
      zipsSending.set(at, { sent: 0, size: file.size });
      paint();
      try {
        const sent = await sendZip(r.id, i, file, paint);
        learn({ name: file.name, size: file.size, state: sent.state });
        zipsSending.delete(at);
        msg('Sent. Unpacking it now…');
        paint();
        learn(await unpacked(r.id, i));
        msg(latest().state === 'imported' ? 'Unpacked. Add your answer and send.' : `Couldn’t unpack it: ${latest().error}.`, latest().state !== 'imported');
        if (latest().state === 'imported') sfx.blip();
      } catch (err) {
        const status = +String(err?.message ?? '').match(/\d{3}$/)?.[0];
        msg(status === 507 && err.refusal?.short === 'disk' ? 'The server is short of disk space right now. Pick the file again in a few minutes.'
          : status === 507 ? 'The server has no room for a zip that big. Try a smaller one, without node_modules.'
          : status === 409 || status === 404 ? 'This request was already answered or closed, or the last zip is still being unpacked.'
          : status ? `The server couldn’t take the zip (error ${status}). Pick it again to carry on.` : 'The connection dropped for too long. Pick the same file again to carry on.', true);
        learn(await loadZipField(world.dev, r.id, i).catch(() => ({})));
        if (latest().state === 'importing') zipsStopped.set(at, 'No longer waiting: the request was answered or closed.');
      } finally {
        zipsSending.delete(at);
        uploading--;
        paint();
        catchUp();
      }
    };
  });
}
// The file's chunks from wherever the server is: resolves once the last is in ({ state: 'importing' }). A chunk that gets
// no answer, or a server error (a deploy restarts it), is tried again, for up to ZIP_GIVE_UP_MS in a row.
async function sendZip(id, i, file, paint) {
  const at = `${id}:${i}`;
  let offset = 0, waited = 0;
  for (;;) {
    try {
      const sent = await sendZipChunk(world.dev, id, i, file, offset, file.slice(offset, offset + ZIP_CHUNK));
      offset = sent.received;
      waited = 0;
      zipsSending.set(at, { sent: offset, size: file.size });
      paint();
      if (sent.state !== 'uploading') return sent;
    } catch (err) {
      const status = +String(err?.message ?? '').match(/\d{3}$/)?.[0];
      if (status === 416) { offset = err.refusal.received; continue; }
      if ((status && status < 500) || status === 507 || waited >= ZIP_GIVE_UP_MS) throw err;
      zipsSending.set(at, { sent: offset, size: file.size, note: `The connection dropped at ${bytes(offset)}. Trying again…` });
      paint();
      await new Promise(res => setTimeout(res, ZIP_RETRY_MS));
      waited += ZIP_RETRY_MS;
    }
  }
}
// The field once the server is done unpacking it. No answer or a server error is asked again; a refusal (the card was
// answered or closed meanwhile) ends the wait.
async function unpacked(id, i) {
  for (;;) {
    await new Promise(res => setTimeout(res, ZIP_POLL_MS));
    let z = null;
    try {
      z = await loadZipField(world.dev, id, i);
    } catch (err) {
      const status = +String(err?.message ?? '').match(/\d{3}$/)?.[0];
      if (status && status < 500) throw err;
    }
    if (z && z.state !== 'importing') return z;
  }
}

// ---------------------------------------------------------------- an address card's saved addresses
// An address card (hq ask/request --address): its four keys are one delivery address. Above them, the board's saved
// addresses, by the names it gave them: the server keeps the addresses themselves, like keys, and fills the card's keys
// from the one picked, so the fields show which one instead of its words. Under them, "Save this address" with a name.
// The pick, the tick and the name stay while the card is drawn again; a tap changes the fields in place, never what's typed.
const ADDRESS_PARTS = ['Name', 'Street and house number', 'Postcode', 'City'];
// the fields show what the board types, with the browser's own address fill; still kept as keys, never in a card's text
const ADDRESS_FILL = ['name', 'street-address', 'postal-code', 'address-level2'];
const addressState = new Map(); // request id → { use: a saved address's id or null, save, label }
function addressOf(r) {
  const address = addressState.get(r.id) || { use: null, save: false, label: '' };
  if (!(r.addresses || []).some(x => x.id === address.use)) address.use = null; // removed meanwhile
  addressState.set(r.id, address);
  return address;
}
const addressPickHtml = (r, address) => r.addresses?.length ? `<div class="address-pick"><label class="key">Your saved addresses<select data-address-pick>
  <option value="">A new address</option>${r.addresses.map(x => `<option value="${x.id}"${x.id === address.use ? ' selected' : ''}>${esc(x.label)}</option>`).join('')}</select></label>
  <button type="button" class="address-remove" data-address-remove hidden>Remove</button></div>` : '';
const addressKeepHtml = address => `<label class="address-keep"><input type="checkbox" data-address-save${address.save ? ' checked' : ''}>Save this address for next time</label>
  <label class="key address-name">Save it as<input type="text" data-address-label maxlength="40" autocomplete="off" spellcheck="false" placeholder="Home, Office…" value="${esc(address.label)}"></label>`;
function wireAddress(el, address) {
  const pick = el.querySelector('[data-address-pick]'), remove = el.querySelector('[data-address-remove]'), keep = el.querySelector('[data-address-save]');
  const paint = () => {
    const name = pick?.selectedOptions[0]?.textContent;
    el.querySelectorAll('[data-key]').forEach(f => {
      if (address.use != null) f.value = '';
      f.disabled = address.use != null;
      if (address.use != null) f.placeholder = `From “${name}”`; else if (f.placeholder.startsWith('From “')) f.placeholder = '';
    });
    if (remove) { remove.hidden = address.use == null; delete remove.dataset.sure; remove.textContent = 'Remove'; }
    keep.closest('label').hidden = address.use != null;
    el.querySelector('.address-name').hidden = address.use != null || !address.save;
  };
  paint();
  pick?.addEventListener('change', () => { address.use = pick.value ? +pick.value : null; sfx.blip(); paint(); });
  keep.addEventListener('change', () => { address.save = keep.checked; sfx.blip(); paint(); if (address.save) el.querySelector('[data-address-label]').focus(); });
  el.querySelector('[data-address-label]').addEventListener('input', e => address.label = e.target.value);
  remove?.addEventListener('click', async () => {
    if (!remove.dataset.sure) { remove.dataset.sure = 1; remove.textContent = 'Tap again to remove'; sfx.blip(); return; }
    remove.disabled = true;
    try {
      const { addresses } = await removeAddress(world.dev, address.use);
      for (const x of store.list) if (x.address) x.addresses = addresses;
      address.use = null; sfx.blip(); renderPhone();
    } catch { remove.disabled = false; tell($('#answer-msg'), 'That address wasn’t removed. Try again in a minute.'); }
  });
}

// PRINTAPI_TEST_CLIENT_ID → "Printapi test client ID", BACKUP_R2_ENDPOINT → "Backup R2 endpoint", BACKUP_AGE_RECIPIENT → "Backup key (public)"
const keyLabel = k => AGE.test(k) ? `${keyLabel(k.replace(AGE, ''))} key (public)`
  : (k.charAt(0) + k.slice(1).toLowerCase().replace(/_/g, ' ')).replace(/ id\b/, ' ID').replace(/\b(r2|s3|api|url)\b/g, m => m.toUpperCase());

// ---------------------------------------------------------------- the backup key (agekey.js)
// A *_AGE_RECIPIENT key isn't typed in: the board's browser makes an age key pair, shows the private key once for the
// password manager, and only once it's pasted back does the public key fill the request's field. The private key is
// never sent or stored; it lives here, per request and key, so a re-render mid-way keeps it (and keeps the phone on
// that card). Leaving the card or the phone drops it; saving drops the pair.
const AGE = /_AGE_RECIPIENT$/, ages = new Map(); // `${request}:${key}` → { id, secret, recipient } | { id, recipient, ready } | { id, fail }
const forgetAge = () => { for (const [at, a] of ages) if (!a.ready) ages.delete(at); };
function ageFlow(a, done) {
  if (a?.fail) return alertHtml(`This browser can’t make the key. Open ${esc(names.hq)} in a current Safari or Chrome.`);
  if (a?.ready) return alertHtml(`Public key ready: <code>${esc(a.recipient.slice(0, 8))}…${esc(a.recipient.slice(-4))}</code>`, 'done');
  if (a?.secret) return `<p class="hint">Your private key, shown this once:</p><div class="secret"><code>${esc(a.secret)}</code><button type="button" class="copy" data-age-copy>Copy</button></div>
    <p class="hint">Save it in your password manager now. ${esc(names.hq)} never keeps it, and without it no backup can be read.</p>
    <label>Paste it back from your password manager<input type="password" data-age-check autocomplete="off" spellcheck="false" autocapitalize="off"></label>
    <p class="hint" data-age-msg></p>`;
  return done ? '<button type="button" class="make again" data-age-make>Make a new key</button><p class="hint">Backups made before keep needing the old key.</p>'
    : `<button type="button" class="make" data-age-make>${KEY}Make the backup key</button>`;
}
const ageHtml = (r, k, done) => { const a = ages.get(`${r.id}:${k}`); return `<div class="key agekey" data-age="${esc(k)}" data-watchalong-hide>${esc(keyLabel(k))}${done ? ' <b class="saved">saved ✓</b>' : ''}
  <div data-age-flow>${ageFlow(a, done)}</div><input type="hidden" data-key="${esc(k)}" value="${a?.ready ? esc(a.recipient) : ''}"></div>`; };
function wireAge(el, r) {
  el.querySelectorAll('[data-age]').forEach(box => {
    const k = box.dataset.age, at = `${r.id}:${k}`, flow = box.querySelector('[data-age-flow]'), out = box.querySelector('input[type=hidden]');
    const paint = () => { const a = ages.get(at); flow.innerHTML = ageFlow(a, (r.saved || []).includes(k)); out.value = a?.ready ? a.recipient : ''; wire(); };
    const wire = () => {
      flow.querySelector('[data-age-make]')?.addEventListener('click', async e => {
        e.currentTarget.disabled = true;
        let a; try { a = { id: r.id, ...await makeAgeKey() }; } catch { a = { id: r.id, fail: true }; }
        if (!box.isConnected) return; // the board left the card meanwhile
        ages.set(at, a); sfx.blip(); paint();
      });
      flow.querySelector('[data-age-copy]')?.addEventListener('click', async e => {
        const b = e.currentTarget;
        try { await navigator.clipboard.writeText(ages.get(at).secret); b.classList.add('copied'); sfx.blip(); setTimeout(() => b.classList.remove('copied'), 1200); }
        catch { b.textContent = 'Select it and copy'; }
      });
      const check = flow.querySelector('[data-age-check]'), msg = flow.querySelector('[data-age-msg]');
      if (!check) return;
      check.onblur = () => { if (stale && !typing()) renderPhone(); };
      check.oninput = () => {
        const a = ages.get(at), v = check.value.trim().toUpperCase();
        if (v !== a.secret) { msg.textContent = v.length >= a.secret.length ? 'That’s not the same key. Copy it again, save that one, and paste it back.' : ''; return; }
        check.value = ''; ages.set(at, { id: r.id, recipient: a.recipient, ready: true }); // the private key's job here is done
        navigator.clipboard?.writeText('').catch(() => {}); // and it doesn't linger on the clipboard
        sfx.jingle(); paint();
        if (stale && !typing()) renderPhone();
      };
    };
    wire();
  });
}

// Dictation into a form field (the desk phone's answer): tap the mic to start, tap again to stop. Like the
// intercom, the words stream in piece by piece while the board talks, after anything already typed there (dictate.js:
let dictation = null;
function dictateInto(field, mic, msg) {
  if (dictation) { stopDictation(); return; }
  const base = field.value.trim(), d = dictation = { field, mic, msg };
  d.show = text => { field.value = [base, text].filter(Boolean).join(' '); };
  d.rec = dictate({ lang: voiceLang(), onWords: d.show });
  mic.closest('.row').classList.add('on-air'); msg.textContent = 'Listening… tap the mic to stop'; sfx.micOn();
  d.rec.ready.catch(err => { if (dictation !== d) return; dictation = null; mic.closest('.row').classList.remove('on-air'); tell(msg, err?.name === 'NotAllowedError' ? `The microphone is blocked for ${names.hq}.` : 'Could not start the microphone.'); });
}
async function stopDictation() {
  const d = dictation; if (!d || d.stopping) return;
  d.stopping = true; sfx.micOff(); d.msg.textContent = 'Transcribing…';
  d.mic.closest('.row').classList.remove('on-air');
  let text;
  try { ({ text } = await d.rec.stop()); } catch { tell(d.msg, 'The transcriber isn’t available right now. Type it instead?'); dictation = null; return; }
  d.show(text); d.msg.textContent = text ? 'Check the words, then send.' : 'No words came through. Try again?';
  dictation = null; d.field.focus();
}

// Videos a request refers to (card.js's CLIP)
const videos = body => [...new Set(unfenced(body || '').match(CLIP) || [])];
// Clips attached to a request: a row to swipe through, each titled by the words next to it in the request (or its
// file name). "#t=0.1" makes iOS Safari draw the first frame as the thumbnail.
function clipsHtml(body) {
  const clips = videos(body).map(p => {
    const line = (body.split('\n').find(l => l.includes(p)) || '').replace(p, '').replace(/https?:\/\/\S+/g, '').replace(/[`*_]|^[\s\d.)•*-]+|[\s:–—-]+$/g, '').trim();
    const name = p.split('/').pop().replace(/\.\w+$/, '').replace(/[-_]+/g, ' ');
    return { src: p.replace(/^products\/_cycles\//, '/cycles/'), title: line && line.length <= 60 ? line : name.charAt(0).toUpperCase() + name.slice(1) };
  });
  if (!clips.length) return '';
  return `<div class="clips${clips.length > 1 ? ' many' : ''}">${clips.map(c => `<figure><video src="${esc(c.src)}#t=0.1" controls playsinline preload="metadata"></video><figcaption>${esc(c.title)}</figcaption></figure>`).join('')}</div>${clips.length > 1 ? `<p class="hint">${clips.length} clips: swipe for more</p>` : ''}`;
}

// ---------------------------------------------------------------- intercom
// Hold the mic and talk, let go to stop; or tap it once to start and again to stop. The words land in the
// field for review: nothing goes to the CEO until the board taps Send.
const HOLD_MS = 350, TITLE_MAX = 140;
const PHONE = icon('phone');
const SEND = icon('send');
const DOWNLOAD = icon('download');
const TICK = icon('tick');
const KEY = icon('key');
const MIC = icon('mic');
const PICTURE = icon('picture');
// the corner's toggle: small by design, larger for a long conversation; the
// pixel style's on a grid of 6, so a pixel is the close ×'s line
const GROW = icon('grow');
let voice = null; // the recording (then the transcription) in progress: { phase: arming | live | sending, rec, locked, base, preview }
// The board's language (Settings › Language), for the browser's live preview of the intercom's voice note: read as the
// intercom opens and as Settings changes it. A call reads it as it starts (call.js), and the coordinator transcribes
// in it.
let boardLang = 'en';
const voiceLang = () => boardLang;
const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
// The line under the intercom: empty in the normal run of things. A real error (a call, a line, the microphone, the words or
// a picture that didn't go through) shows as one, an alert (tell); it and any hint go when the board does something next.
export const say = (s, error = false) => {
  const m = $('#dir-msg'); if (!m) return;
  if (error) tell(m, s); else m.textContent = s;
};
const micWhy = !TRANSCRIBER ? 'Voice is coming soon: the transcriber isn’t installed yet' : !window.isSecureContext ? `Voice needs ${names.hq} over https` : !canRecord ? 'This browser can’t record audio' : '';

// the CEO (org.yaml's company.ceo), whom the intercom talks to, by name
export const ceoName = () => world.agents.get(world.company.ceo)?.data.name ?? 'the CEO';

export function openIntercom() {
  const ceo = esc(ceoName());
  if (!show('intercom', `<header><span class="grille" aria-hidden="true"></span><b>${esc(cap(names.intercom))} · ${cap(ceo)}</b><span class="onair" aria-hidden="true">ON AIR</span><button class="past-btn grow" id="dir-grow" aria-pressed="false" aria-label="Larger" title="Larger">${GROW}</button><button class="x" data-close aria-label="Close">×</button></header>
    <div class="screen">
      <ol class="chat" id="chat" aria-live="polite" aria-busy="true"><li class="ceo typing">Loading the conversation…</li></ol><!-- (until the history is in) -->
      <div class="tray" id="dir-pics" hidden></div>
      <label class="sr" for="dir-title">Say something to ${ceo}</label>
      <textarea id="dir-title" rows="1" placeholder="${canRecord ? 'Type, or hold the mic' : 'Say something'}" enterkeyhint="send"></textarea><!-- (one line on a phone in every look's font.) -->
      <div class="voicebar" id="voicebar" hidden><span class="meter" aria-hidden="true">${'<i></i>'.repeat(12)}</span><b id="voice-time">0:00</b><span id="voice-hint"></span></div>
      <div class="row">
        <button class="mic" id="mic" ${canRecord ? '' : 'disabled'} title="${esc(micWhy) || 'Hold to talk, or tap to start and stop'}" aria-label="${esc(micWhy) || 'Hold to talk'}">${MIC}</button>
        <button class="mic attach" id="dir-attach" title="Add a picture" aria-label="Add a picture">${PICTURE}</button>
        <input type="file" id="dir-file" accept="image/*" multiple hidden>
        <button class="send" id="dir-send">Send</button>
        ${window.AudioWorkletNode && window.isSecureContext ? `<button class="mic call-btn" id="call" title="Call ${ceo}: talk hands-free" aria-label="Call ${ceo}">${PHONE}</button>` : ''}
      </div>
      <p class="msg" id="dir-msg" aria-live="polite"></p>
    </div>`)) return;
  const t = $('#dir-title'), mic = $('#mic');
  loadLanguage(world.dev).then(l => { boardLang = l.lang; }, () => {});
  t.oninput = () => { grow(t); say(''); };
  if (matchMedia('(pointer: fine)').matches) t.focus();
  t.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#dir-send').click(); } };
  $('#dir-send').onclick = async () => {
    // The pictures in the tray now go with this line, not the ones being removed. Ones added while it's sending wait for
    // the next.
    // (an open switches card goes as it stands, the words typed after it: intake.js.)
    const text = [switchesLine(chatLines), t.value.trim()].filter(Boolean).join('\n\n'), batch = intercomTray.batch();
    if (!text && !batch.length) { t.focus(); return; }
    $('#dir-send').disabled = true; say('');
    intercomTray.sending(batch, true);
    const ready = await intercomTray.sent(batch);
    let missing = null;
    try {
      if (ready) {
        paintChat(await sendChat(world.dev, text, ready));
        t.value = ''; grow(t); intercomTray.takeOut(batch); sfx.ding(0.6);
        onDirective((text || 'a picture').slice(0, TITLE_MAX));
      }
    } catch (e) {
      // Pictures the coordinator no longer has waiting (sent already, removed in another tab, or unsent for a day) leave
      // the tray, and the board looks at what's left before it sends again. The words stay.
      missing = e.refusal?.missing;
      say(!missing ? 'Could not reach the coordinator. Try again.'
        : `${missing.length === 1 ? 'A picture is' : `${missing.length} pictures are`} no longer there, so nothing was sent. Check the pictures, then send again.`, true);
    }
    intercomTray.sending(batch, false);
    if (missing) intercomTray.refused(batch, missing);
    $('#dir-send').disabled = false;
  };
  intercomTray.restore();
  $('#dir-attach').onclick = () => $('#dir-file').click();
  $('#dir-file').onchange = e => { intercomTray.add(e.target.files); e.target.value = ''; };
  const device = root().querySelector('.intercom');
  // the size the board last chose, kept on this device, after a reload too: anything but the larger opens the small one
  // (the larger is the screen's at most, so either fits)
  const size = big => { device.classList.toggle('big', big); $('#dir-grow').setAttribute('aria-pressed', big); };
  size(saved.get('intercomSize') === 'large');
  $('#dir-grow').onclick = () => {
    const big = !device.classList.contains('big');
    size(big); saved.set('intercomSize', big ? 'large' : 'small'); $('#chat').scrollTop = $('#chat').scrollHeight; sfx.blip();
  };
  device.addEventListener('paste', e => {
    if (inCall()) return; // (not during a call: the call screen takes it)
    const files = [...(e.clipboardData?.files ?? [])].filter(f => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); intercomTray.add(files); }
  });
  device.addEventListener('dragover', e => { if (!inCall() && e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
  device.addEventListener('drop', e => { if (inCall() || !e.dataTransfer?.files.length) return; e.preventDefault(); intercomTray.add(e.dataTransfer.files); });
  $('#call')?.addEventListener('click', () => callAgent(world.company.ceo, ceoName(), { onIntercom: true }));
  // (a first load that fails says so under the input while the loader stays, and the next poll tries again; a later one
  // keeps what's shown)
  let failed = false;
  const poll = () => loadChat(world.dev).then(c => { if (failed) { failed = false; say(''); } paintChat(c); }, () => {
    if (failed || !$('#chat')?.hasAttribute('aria-busy')) return;
    failed = true; say('Could not load the conversation. Trying again…', true);
  });
  poll(); timer = setInterval(poll, 3000);
  if (!canRecord) return;
  // press to start; a short press locks it on (tap-to-toggle), a long one stops on release
  mic.onpointerdown = e => {
    e.preventDefault(); mic.setPointerCapture?.(e.pointerId);
    if (voice?.phase === 'sending') return;
    if (voice) { voice.stopping = true; finishVoice(); } else startVoice();
  };
  mic.onpointerup = mic.onpointercancel = () => {
    if (!voice || voice.stopping || voice.phase === 'sending') return;
    if (voice.phase === 'arming' || performance.now() - voice.downAt < HOLD_MS) { voice.locked = true; paintVoice(); }
    else finishVoice();
  };
  mic.oncontextmenu = e => e.preventDefault();
  mic.onclick = e => { if (e.detail) return; if (voice) finishVoice(); else { startVoice(); voice.locked = true; paintVoice(); } }; // keyboard
}
// The intercom with the board's sentence started (the Library's manual, manual.js): words already typed there stay.
export function openIntercomWith(words) {
  openIntercom();
  startWith(words);
}
// (an ask key's start replaces another's: the intake's keys, intake.js.)
function startWith(words) {
  const t = $('#dir-title');
  if (!t.value.trim() || ASKS.some(a => a.starts === t.value)) { t.value = words; grow(t); }
  t.focus();
  t.setSelectionRange(t.value.length, t.value.length);
}
const intercomTray = new Tray(0, () => $('#dir-pics'), say);   // the board's pictures for its next line (tray.js)
// a line's pictures, small, in its bubble: a tap shows one big (wirePics)
// A line from a person the board invited (kept from the old Sketchbook's Send): theirs, not the board's, with its picture.
const guestLine = (m, i) => `<li class="guest" data-m="${i}"><span>${esc(m.text)}</span>${linePictures(m)}</li>`;
const linePictures = m => m.pictures?.length ? `<span class="pics">${m.pictures.map(id => `<button type="button" data-pic="${esc(pictureUrl(world.dev, id))}" data-label="Picture #${Number(id)}" aria-label="Show picture #${Number(id)} bigger"><img src="${esc(pictureUrl(world.dev, id))}" alt="" loading="lazy"></button>`).join('')}</span>` : '';


// Why the CEO's turn waits, as the coordinator knows it (chat.ts paused): the board sees that, not "thinking", and the turn
// starts on its own once it's over. A time today shows as the time, a later one with its day.
const backAt = ms => companyFormats().dayAt(new Date(ms)) === companyFormats().today() ? timeOf(ms) : dayTime(ms);
const pausedLine = (p, ceo) => p.why === 'restarting' ? `Paused: restarting. ${cap(ceo)} picks this up as soon as it's back.`
  : p.why === 'seat' ? `Paused: waiting for a seat, back at about ${backAt(p.until)}.`
  : p.why === 'signin' ? `Paused: waiting for a seat to be signed in (the ${names.phone} has its card).`
  : `Paused after a hiccup: trying again at about ${backAt(p.until)}.`;

// the conversation so far; a new reply from the CEO chimes
// After a call with the CEO the transcript takes a moment to reach the chat (up to half a minute after a dropped line); from
// then until the notes arrive, the coordinator says they're coming (chat.ts history()).
let notesDue = 0;
export const notesComing = () => { notesDue = Date.now(); };
export const intercomOpen = () => open === 'intercom';
// The intercom shows a loader until its history is in, and this only once it came back empty.
const chatHint = ceo => `<li class="hint">Talk with ${ceo}: ask, discuss, decide. ${cap(ceo)} remembers the conversation and puts the team to work.</li>`;
function paintChat(c) {
  const list = $('#chat'); if (!list || !c) return;
  chatLines = c.messages;
  // shown: seen (once the marks have loaded, as the count waits for them; not during a call, which hides the chat)
  if (seen && !inCall() && !document.hidden && c.messages.length) markSeen('intercom', Math.max(...c.messages.map(m => Number(m.id))));
  if (notesDue && (Date.now() - notesDue > 120e3 || c.messages.some(m => m.who === 'call' && new Date(m.ts) > notesDue - 60e3))) notesDue = 0;
  c.thinking = c.thinking || !!notesDue && 'notes';
  const last = c.messages.at(-1)?.id ?? 0, fresh = list.dataset.last && +list.dataset.last !== last && c.messages.at(-1)?.who === world.company.ceo;
  const state = `${c.thinking} ${JSON.stringify(c.paused ?? null)}`;
  if (list.dataset.last === String(last) && list.dataset.thinking === state) return;
  list.dataset.last = last; list.dataset.thinking = state; list.removeAttribute('aria-busy');
  const ceo = esc(ceoName()), hint = c.messages.length ? '' : list.querySelector('.hint')?.outerHTML ?? chatHint(ceo);
  // (the board's own lines break where it typed them, an agent's wrapped ones join); a guest's. The CEO's line with its
  // intake card (intake.js).
  list.innerHTML = hint + c.messages.map((m, i) => m.who === 'call' ? `<li class="call" data-m="${i}">${PHONE}${withJobLinks(m.text)}</li>` : m.who === 'guest' ? guestLine(m, i) : `<li class="${m.who === 'board' ? 'me' : 'ceo'} prose" data-m="${i}">${prose(m.text, undefined, { breaks: m.who === 'board' })}${linePictures(m)}</li>${intakeCardHtml(c.messages, i)}`).join('')
    + (c.thinking === 'notes' ? `<li class="ceo typing">The call notes are on their way to ${ceo}…</li>` : c.paused ? `<li class="ceo typing">${pausedLine(c.paused, ceo)}</li>`
      : c.thinking ? `<li class="ceo typing">${cap(ceo)} is thinking…</li>` : '');
  // a tap copies a message whole: selecting one in a scrolling chat on a phone is fiddly (a selection made by hand stays)
  wirePics(list, { each: 'li' });
  wireCards(list, c.messages, startWith);
  list.querySelectorAll('[data-m]').forEach(li => li.onclick = async e => {
    if (getSelection()?.toString() || e.target.closest('[data-pic], a') || !c.messages[li.dataset.m].text) return;
    try { await navigator.clipboard.writeText(c.messages[li.dataset.m].text.replace(/\*\*(.+?)\*\*/g, '$1')); } catch { return; }
    li.classList.add('copied'); sfx.blip(); setTimeout(() => li.classList.remove('copied'), 1500);
  });
  list.scrollTop = list.scrollHeight;
  if (fresh) sfx.ding(0.4);
  if (c.welcome) paintWelcome(list);
}
// The intercom's count: the CEO's replies that came in since the intercom last showed them on any of the board's devices,
// like Mail's (seen.js, by chat line id); before anything's recorded, the last day's count as new. Read with the other
// counts and when a reply arrives (events.js).
let chatLines = [];
export async function refreshIntercomCount() {
  const c = await loadChat(world.dev).catch(() => null);
  if (c) chatLines = c.messages;
  paintIntercomCount();
}
export function paintIntercomCount() {
  const el = $('#intercom-count'); if (!el || !seen) return;
  const dayAgo = Date.now() - 864e5;
  const n = chatLines.filter(m => m.who === world.company.ceo && (seen.intercom == null ? Date.parse(m.ts) > dayAgo : m.id > seen.intercom)).length;
  countBadge(el, n); el.setAttribute('aria-label', `${n} new ${n === 1 ? 'reply' : 'replies'}`);
}
// A new company's first visit: before anything is said, the board picks the language the company talks in (its one
// language setting, which the CEO's onboarding and everything else the board reads and hears follow), and its name in
// itself is the board's first line.
let welcomeLangs = null; // (not "languages": Settings › Language is languages(), #8345)
async function paintWelcome(list) {
  // (a failed load stays unloaded: the intercom opened again tries again)
  try { welcomeLangs ??= (await loadLanguage(world.dev)).languages; } catch { return say('Could not load the languages. Close the intercom and open it again.', true); }
  const hint = list.querySelector('.hint'); if (!hint) return;
  hint.innerHTML = `Which language shall we talk in?<span class="langs">${welcomeLangs.map(l =>
    `<button type="button" data-lang="${esc(l.code)}">${esc(l.own)}</button>`).join('')}</span>`;
  const picks = [...hint.querySelectorAll('[data-lang]')];
  picks.forEach(b => b.onclick = async () => {
    const l = welcomeLangs.find(l => l.code === b.dataset.lang);
    picks.forEach(p => p.disabled = true); say('');
    try {
      await setLanguage(world.dev, l.code);
      boardLang = l.code; // the voice note hears it from now, not only once the intercom opens again
      paintChat(await sendChat(world.dev, l.own)); sfx.ding(0.6);
    } catch { picks.forEach(p => p.disabled = false); say('Could not reach the coordinator. Try again.', true); }
  });
}
function put(base, text) {
  const t = $('#dir-title'); if (!t) return;
  t.value = [base, text].filter(Boolean).join(' '); grow(t); t.scrollTop = t.scrollHeight;
}
function startVoice() {
  const base = $('#dir-title').value.trim(), lang = voiceLang();
  const v = voice = { phase: 'arming', downAt: performance.now(), base, lang, preview: '', lvl: 0, parts: [], pending: [] };
  const heard = () => v.parts.filter(Boolean).join(' ');
  v.rec = record({ lang,
    onPreview: text => { v.preview = text; if (voice === v && !v.parts.length) put(base, text); },
    onSegment: clip => { // transcribe each piece as it comes, and show the words so far in order
      const i = v.parts.push('') - 1, go = () => transcribe(clip, lang).then(text => { v.parts[i] = text; if (voice === v) put(base, heard() || v.preview); });
      v.pending.push(go().catch(() => new Promise(r => setTimeout(r, 1500)).then(go)).catch(() => { v.failed = true; v.parts[i] = '[…]'; })); // one retry; a lost piece shows as […]
    } });
  v.heard = heard;
  sfx.micOn(); say(''); paintVoice();
  v.rec.ready.then(() => {
    if (voice !== v) return;
    v.phase = 'live'; paintVoice(); meter(v);
    v.limit = setTimeout(() => { if (voice === v) finishVoice(); }, MAX_SECONDS * 1000);
  }, err => {
    if (voice !== v) return;
    voice = null; paintVoice();
    say({ NotAllowedError: `The microphone is blocked for ${names.hq}. Allow it in the browser’s site settings, then try again.`,
      NotFoundError: 'No microphone found on this device.', NotReadableError: 'The microphone is busy in another app.' }[err?.name] ?? 'Could not start the microphone.', true);
  });
}
async function finishVoice() {
  const v = voice; if (!v || v.phase === 'sending') return;
  clearTimeout(v.limit);
  if (v.phase === 'arming') { v.rec.cancel(); voice = null; paintVoice(); return; }
  const secs = v.rec.seconds(), clip = await v.rec.stop();
  sfx.micOff();
  if (!clip || secs < 0.6) { voice = null; put(v.base, ''); paintVoice(); say('Hold the mic while you talk, or tap it once to start and again to stop.'); return; }
  v.phase = 'sending'; paintVoice(); say('');
  let note;
  try {
    // the pieces were sent while talking: only the last may still be on its way. If one went wrong, the whole clip.
    await Promise.all(v.pending);
    const text = v.parts.length ? v.heard() : await transcribe(clip, v.lang); // (the whole clip only when there were no pieces)
    if (voice !== v) return; // closed meanwhile
    put(v.base, text || v.preview);
    note = v.failed ? 'A piece didn’t come through (marked […]). Check the words, then send.' : text ? '' : 'No words came through. Try again, a little closer to the mic?';
  } catch (code) {
    if (voice !== v) return;
    put(v.base, v.preview);
    note = code === 413 ? 'That was too long for one go: try it in two parts.'
      : v.preview ? 'The transcriber is out, so these are the live words. Check them, then send.'
      : code === 0 ? 'Could not reach the coordinator. Try again.' : 'The transcriber isn’t available right now. Type it instead?';
  }
  voice = null; paintVoice(); say(note, true);
}
function paintVoice() {
  const dev = root().querySelector('.intercom'); if (!dev) return;
  const p = voice?.phase, mic = $('#mic');
  dev.classList.toggle('on-air', p === 'arming' || p === 'live');
  dev.classList.toggle('sending', p === 'sending');
  mic.setAttribute('aria-label', voice ? 'Stop recording' : 'Hold to talk');
  mic.disabled = p === 'sending'; $('#dir-send').disabled = !!voice;
  $('#voicebar').hidden = !voice;
  $('#voice-hint').textContent = p === 'sending' ? 'Transcribing…' : p === 'arming' ? 'Opening the mic…' : voice?.locked ? 'Tap the mic to stop' : 'Let go to stop';
  if (!voice) $('#voice-time').textContent = '0:00';
  if (p === 'sending') meter(voice);
}
// the level meter: the live level with a falling peak while recording, a scanning sweep while transcribing
function meter(v) {
  if (v.looping === v.phase) return; v.looping = v.phase;
  const segs = [...root().querySelectorAll('.meter i')], time = $('#voice-time');
  const tick = () => {
    if (voice !== v || v.looping !== v.phase || !segs[0]?.isConnected) return;
    if (v.phase === 'sending') { const k = Math.floor(performance.now() / 70) % (segs.length + 6) - 3; segs.forEach((s, i) => s.classList.toggle('on', Math.abs(i - k) < 2)); }
    else {
      v.lvl = Math.max(Math.min(1, v.rec.level()), v.lvl * 0.9);
      const n = Math.round(v.lvl * segs.length); segs.forEach((s, i) => s.classList.toggle('on', i < n));
      time.textContent = mmss(v.rec.seconds());
    }
    requestAnimationFrame(tick);
  };
  tick();
}

// ---------------------------------------------------------------- computer
const BELL = icon('bell');
// The computer: a home screen of apps, each opening full screen with a way back home.
// (the company's own after them in this list, once they've loaded: apps(), each with the group it names, its app.group,
// which places it on the home screen: homeGroups)
const apps = () => [...APPS, ...own.map(k => [k.id, esc(k.mod.app.name), esc(k.mod.app.what ?? ''), icon(k.mod.app.icon), k.mod.app.group])];
// Each app's last field is its group, by what the board does with it: work to look at, talking, the business, and the
// team and the machine (Settings last). The home screen reads them in HOME_GROUPS' order (homeGroups).
// (the projects view is the HUD's own key, not an app)
const APPS = [
  ['notes', 'Reviews', 'The sheets you sent, and what you shared', icon('app-notes'), 'work'],
  ['artifacts', 'Artifacts', 'Everything you’ve been shown', icon('app-artifacts'), 'work'],
  ['calls', 'Calls', 'Notes from your calls', icon('app-calls'), 'talk'],
  ['mail', 'Mail', 'The company inbox', icon('app-mail'), 'talk'],
  ['onair', 'On Air', 'The company’s shows', icon('app-onair'), 'talk'],
  ['numbers', 'Numbers', 'Sales and funnels, per app', icon('app-numbers'), 'business'],
  ['people', 'Team', 'Who’s who, and where', icon('app-people'), 'team'],
  // (Seats shows how they're doing, Settings › Seats changes them)
  ['seats', 'Seats', 'The team’s AI capacity', icon('app-seats'), 'team'],
  ['settings', 'Settings', 'Seats, alerts, look', icon('app-settings'), 'team'],
];
// A job's link, wherever it is (a machine's key, an agent's panel or key, a card, HQ's search): what it's in closes, and
// the projects view opens on the job's thread with its card in front (a call goes on over it). With words being typed,
// it opens in a new HQ, leaving this one as it is.
export function openJob(id) {
  if (typing()) { window.open(`/?open=jobs&job=${Number(id)}`, '_blank', 'noopener'); return; }
  closeTool(); closePanel();
  if (scene?.carded?.()) scene.focus({ kind: 'home' });   // (a look’s key out big)
  openProjects({ job: id });
}
// (opts.mail opens Mail at that message; opts.call Calls at that call; opts.section opens Settings at a section, opts.page at a page in it, a seat's or a machine's; opts.force
// moves on from a field with text in it, which the app saved first)
export function openComputer(which = 'home', opts = {}) {
  if (open === 'computer' && typing() && !opts.force) return;
  if (!ownDone && which !== 'home' && !apps().some(a => a[0] === which)) { ownLoaded.then(() => openComputer(which, opts)); return; } // (a company app still loading)
  tab = apps().some(a => a[0] === which) ? which : 'home';
  const app = apps().find(a => a[0] === tab);
  mailWanted = tab === 'mail' ? opts.mail ?? null : null;
  if (mailWanted != null) mailGroup = 'all';   // (the message is in All, whichever group it's in)
  callWanted = tab === 'calls' ? opts.call ?? null : null;
  if (tab === 'notes') openReviews(opts.shown);   // (shown)
  section = tab === 'settings' ? opts.section ?? null : null;
  pageWanted = opts.page ?? null;
  show('computer', `<header>${app ? '<button class="home" data-home aria-label="Home" title="Home">◂</button>' : ''}<b>${esc(names.os)}${app ? `<span> › ${app[1]}</span>` : ''}</b><button class="x" data-close aria-label="Close">×</button></header>
    <div class="crt"><div class="screen${tab === 'home' ? ' fit' : ''}" id="crt" tabindex="0"><p>LOADING…<i class="cursor"></i></p></div></div>`, opts.force);   // (fit: the home screen's height is its grid's)
  // Numbers and a company app go back to their own home first (a company app's back())
  root().querySelector('[data-home]')?.addEventListener('click', () => { if (!(tab === 'numbers' && numbersBack()) && !settingsBack() && !ownApp(tab)?.mod.back?.()) openComputer('home'); });
  const load = async () => {
    const el = $('#crt'); if (!el || typing()) return;
    const keep = el.scrollTop; // a refresh doesn't lose the board's place in the list
    try {
      if (tab === 'home') home(el);
      else if (ownApp(tab)) await ownApp(tab).mod.draw(el, hq()); // (a company app)
      else if (tab === 'people') directory(el);
      else if (tab === 'settings') settings(el);
      else if (tab === 'mail') await inbox(el);
      else if (tab === 'calls') { if (!el.querySelector('details.missed[open]')) await callLog(el); }   // (a box being typed in)
      else if (tab === 'notes') await notes(el);
      else if (tab === 'numbers') await numbers(el, { more: own.filter(k => k.mod.numbers).map(k => (d, view) => k.mod.numbers(d, view, hq())), care: ownApp('care') ? careNumbers : null }); // (the company apps' sections; Care › Numbers)
      else if (tab === 'artifacts') await artifactList(el, { dev: world.dev });
      else if (tab === 'onair') await onair(el, { dev: world.dev, who });
      else if (tab === 'seats') await seatStatus(el, { dev: world.dev });
    } catch { el.innerHTML = '<p><i class="prompt">&gt; </i>No signal from the coordinator. Retrying…<i class="cursor"></i></p>'; }
    el.scrollTop = keep;
  };
  load(); if (!['home', 'settings'].includes(tab)) timer = setInterval(load, 15000);
}
// Care › Numbers from an app's dashboard in Numbers: Care's back button prints that dashboard again, in the same mode, its own
// back button still going where it went
function careNumbers(app, back) {
  ownApp('care').mod.careFor({ slug: app.slug, mode: app.mode }, () => { numbersFor(app, back); openComputer('numbers'); });
  openComputer('care');
}
// One grid of equal tiles, icon first, in the groups' order (an app's line is its tooltip): a calm launcher, no gap after
// a group. Up to four across, so it's squarer, like an old computer's screen (the board, call #77: ten apps make three
// rows, the last one not full), as many as the screen has room for, and no more than fill the rows evenly. A tile is as
// wide as its widest label in the look's font, so no label is cut on a narrow phone (two across if that's what fits).
// A turned phone, a resized window or a font that loads late counts the columns again. homeFit disconnects when the
// screen changes.
const HOME_COLUMNS = 4, HOME_TILE_PX = 60, HOME_GAP_PX = 8;   // (the gap: style.css .apps; four)
let homeFit = null;
function homeColumns(el, count) {
  const pad = getComputedStyle(el), width = el.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight);
  const buttonStyle = getComputedStyle(el.querySelector('.apps button'));
  const labelEdges = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth']
    .reduce((sum, k) => sum + parseFloat(buttonStyle[k]), 0);
  const tile = Math.max(HOME_TILE_PX, ...[...el.querySelectorAll('.apps b')].map(b => b.scrollWidth + labelEdges));
  const room = Math.floor((width + HOME_GAP_PX) / (tile + HOME_GAP_PX));
  const rows = Math.ceil(count / Math.max(1, Math.min(HOME_COLUMNS, room)));
  return Math.ceil(count / rows) || 1;
}
function home(el) {
  const button = ([k, name, what, ic]) => `<li><button data-app="${k}" title="${what}">${ic}<b>${name}</b></button></li>`;
  const all = homeGroups().flat();
  el.innerHTML = `<ul class="apps">${all.map(button).join('')}</ul>`;
  const fit = () => { if (el.isConnected) el.querySelector('.apps')?.style.setProperty('--cols', homeColumns(el, all.length)); };
  fit(); document.fonts.ready.then(fit);
  homeFit?.disconnect();
  homeFit = new ResizeObserver(fit);
  homeFit.observe(el);
  el.querySelectorAll('[data-app]').forEach(b => b.onclick = () => { sfx.blip(); openComputer(b.dataset.app); });
  // a company app's count on its icon: what waits on the board there
  for (const k of own) if (k.mod.count) Promise.resolve().then(() => k.mod.count(world.dev))
    .then(c => iconCount(el, k.id, Number(c) || 0, k.mod.app.name), () => { /* no count: the icon shows none */ });
  homeShown = el;   // Mail's icon follows each refresh of its count
  refreshComputerCount();
}
// An icon's count, drawn again when it changes: none at 0 (redrawn, not added)
function iconCount(el, id, n, name) {
  const li = el.querySelector(`[data-app="${id}"]`)?.parentElement;
  if (!li?.isConnected) return;
  li.querySelector('.count')?.remove();
  li.classList.toggle('has-count', !!n);
  if (!n) return;
  li.insertAdjacentHTML('beforeend', '<b class="count"></b>');
  const badge = li.querySelector('.count'); countBadge(badge, n); badge.setAttribute('aria-label', `${n} waiting in ${name}`);
}
// The home screen's order is the company's: brand.yaml's computer.apps, groups of app ids in order, one after the
// other. The apps it doesn't name come after them, in a group of their own (in HOME_GROUPS' order, then any app naming
// a group that isn't one of them), so a new app never shuffles the others.
// Settings is always last, wherever the list puts it. Without the setting, the groups go in HOME_GROUPS' order, a
// company app at the end of the group it names, or with the others that name none in a group of their own before the
// team's. A company app's id counts like any other.
const HOME_GROUPS = ['work', 'talk', 'business', undefined, 'team'];
function homeGroups() {
  const all = apps();
  const grouped = HOME_GROUPS.map(group => all.filter(([, , , , appGroup]) => appGroup === group));
  const wanted = Array.isArray(brand.computer?.apps) ? brand.computer.apps : grouped.map(list => list.map(a => a[0]));
  const settings = all.filter(a => a[0] === 'settings'), placed = new Set(settings);
  const take = id => { const app = all.find(a => a[0] === id); if (!app || placed.has(app)) return []; placed.add(app); return [app]; };
  const groups = wanted.map(ids => Array.isArray(ids) ? ids.flatMap(take) : []);
  const leftover = [...new Set([...grouped.flat(), ...all])].filter(a => !placed.has(a));
  return [...groups, leftover, settings].filter(list => list.length);
}
// Settings: a short list of sections, each opening its own page (Settings › Look); the header's back button goes from a
// page back to the list (settingsBack). The sections are settingsSections', under their captions.
let section = null, pageWanted = null;
function settings(el) {
  const all = settingsSections(), name = id => all.find(s => s.id === id)?.name ?? '';
  const crumb = (more = []) => { const c = root().querySelector('header b span'); if (c) c.textContent = [' › Settings', ...(section ? [name(section)] : []), ...more].join(' › '); };
  crumb();
  // a page draws into its own element, fresh each time: a slow answer for a page the board has left lands nowhere
  const page = pageWanted; pageWanted = null; // (a page asked for, once: back on the list, it's the list)
  if (section === 'sys:seats') { el.innerHTML = '<div></div>'; return seatSettings(el.firstChild, { dev: world.dev, crumb }, page); }
  if (section === 'sys:machines') { el.innerHTML = '<div></div>'; return machineSettings(el.firstChild, { dev: world.dev, crumb }, page); }
  if (section === 'sys:alerts') { el.innerHTML = '<div></div>'; return alerts(el.firstChild); }
  if (section === 'sys:voices') { el.innerHTML = '<div></div>'; return voiceSettings(el.firstChild, { dev: world.dev, ago }); }
  if (section === 'sys:tips') { el.innerHTML = '<div></div>'; return tipSettings(el.firstChild, { dev: world.dev }); }
  if (section === 'sys:overseer') { el.innerHTML = '<div></div>'; return oversight(el.firstChild, { dev: world.dev, ago }); }
  if (section === 'sys:language') { el.innerHTML = '<p class="acts looks"></p><p class="msg"></p>'; return languages(el.firstChild, el.lastChild); }
  if (section === 'sys:look') { el.innerHTML = '<p class="acts looks"></p><section class="look-settings"></section>'; return lookSettings(el.firstChild, el.lastChild); }
  if (section) { el.innerHTML = `<section data-app-settings="${esc(section)}"></section>`; return own.find(k => k.id === section)?.mod.settings(el.firstChild, hq()); } // (a company app's box)
  const row = s => s.run ? `<li><button data-run="${s.id}"><b>${esc(s.name)}</b><span class="to">${s.mark ?? '›'}</span></button></li>`
    : s.set ? switchRow(s) : `<li><button data-section="${esc(s.id)}"><b>${esc(s.name)}</b><span class="to"><span data-now="${esc(s.id)}"></span> ›</span></button></li>`;
  const group = (caption, rows, i) => `<p class="cap${i ? ' more' : ''}"><i class="prompt">&gt; </i>${caption}</p><ul class="rows settings">${rows}</ul>`;
  el.innerHTML = [...new Set(all.map(s => s.caption))].map((caption, i) => group(caption, all.filter(s => s.caption === caption).map(row).join(''), i)).join('');
  el.querySelectorAll('[data-run]').forEach(b => b.onclick = () => all.find(s => s.id === b.dataset.run).run());
  el.querySelectorAll('[data-switch]').forEach(b => b.onclick = () => {
    const on = b.getAttribute('aria-checked') !== 'true';
    sfx.toggle(on); b.setAttribute('aria-checked', String(on));
    all.find(s => s.id === b.dataset.switch).set(on);
  });
  el.querySelectorAll('[data-section]').forEach(b => b.onclick = () => { sfx.blip(); section = b.dataset.section; el.scrollTop = 0; settings(el); });
  // what each is set to now, on its row
  const now = (id, text) => { const s = el.querySelector(`[data-now="${id}"]`); if (s) s.textContent = text; };
  pushState().then(state => now('sys:alerts', { on: 'On', off: 'Off', denied: 'Blocked', install: 'Not yet' }[state] ?? ''), () => {});
  lookName(look).then(t => now('sys:look', t));
  loadLanguage(world.dev).then(l => now('sys:language', l.languages.find(x => x.code === l.lang)?.own ?? ''), () => {});
  seatsSummary(world.dev).then(t => now('sys:seats', t), () => {});
  machinesSummary(world.dev).then(t => now('sys:machines', t), () => {});
  tipsSummary(world.dev).then(t => now('sys:tips', t), () => {});
  voicesSummary(world.dev).then(t => now('sys:voices', t), () => {});
}
// Settings' sections in its order, each under its caption: the compute, Seats (seats.js, with pages of its own: a seat,
// Add a seat) and Machines (machines.js, the same way); the company, a company app's box (its settings()) and the
// Overseer's key (oversight.js) and the board's Language (languages); this device, Notifications, Look and Pin on HQ, a
// switch on its row (on, set); tools, Reload HQ, which runs at once (run). HQ's search finds each by its name, a page in it by the page's name (pages: a seat, a
// machine) and a section by a choice on it (choices: a language, a look, the one set now first). The built-in ids start
// "sys:", so a company app can't take one.
export function settingsSections() {
  const chosen = (list, now) => [...list.filter(x => x === now), ...list.filter(x => x !== now)];
  return [
    { caption: 'COMPUTE', id: 'sys:seats', name: 'Seats', pages: () => seatPages(world.dev) },
    { caption: 'COMPUTE', id: 'sys:machines', name: 'Machines', pages: () => machinePages(world.dev) },
    ...own.filter(k => k.mod.settings).map(k => ({ caption: 'COMPANY', id: k.id, name: k.mod.app.name })),
    { caption: 'COMPANY', id: 'sys:overseer', name: 'Overseer' },
    { caption: 'COMPANY', id: 'sys:tips', name: 'Tips' },
    { caption: 'COMPANY', id: 'sys:voices', name: 'Voices' }, // the voices calls recognise (voices.js).
    { caption: 'COMPANY', id: 'sys:language', name: 'Language', choices: async () => {
      const l = await loadLanguage(world.dev);
      return chosen(l.languages, l.languages.find(x => x.code === l.lang)).map(x => x.own);
    } },
    { caption: 'THIS DEVICE', id: 'sys:alerts', name: 'Notifications' },
    { caption: 'THIS DEVICE', id: 'sys:look', name: 'Look', choices: async () => Promise.all(chosen((await looks).map(l => l.name), look).map(lookName)) },
    { caption: 'THIS DEVICE', id: 'sys:pin', name: `Pin on ${names.hq}`, on: pinOn, set: setPin },
    { caption: 'TOOLS', id: 'sys:reload', name: `Reload ${names.hq}`, mark: '↻', run: () => location.reload() },
  ];
}
// a section that's only a switch, on its row in the list
const switchRow = s => `<li class="switch-row"><b id="${esc(s.id)}-label">${esc(s.name)}</b><span class="ctl"><button type="button" class="switch" role="switch" data-switch="${esc(s.id)}" aria-checked="${s.on()}" aria-labelledby="${esc(s.id)}-label"><i></i></button></span></li>`;
export function settingsBack() {
  const el = $('#crt');
  if (tab !== 'settings' || !section || !el) return false;
  if (section === 'sys:seats' && seatsBack()) return true;
  if (section === 'sys:machines' && machinesBack()) return true;
  sfx.blip(); section = null; settings(el);
  return true;
}
// The board's language: each that works end to end by its own name, the one set pressed. A pick sets it for the whole
// company at once: the next call speaks it, and agents write the board in it from their next turn.
async function languages(el, msg) {
  const l = await loadLanguage(world.dev).catch(() => null);
  if (!l) { msg.textContent = 'The language can’t be read right now. Try again in a moment.'; return; }
  boardLang = l.lang;
  el.innerHTML = l.languages.map(x => `<button data-lang="${esc(x.code)}" aria-pressed="${x.code === l.lang}">${esc(x.own)}</button>`).join('');
  msg.textContent = `What you read and hear from the team: calls, cards, reports, the plan and the ${names.intercom}. ${cap(names.hq)}’s own words stay English for now.`;
  el.querySelectorAll('[data-lang]').forEach(b => b.onclick = async () => {
    el.querySelectorAll('[data-lang]').forEach(x => { x.disabled = true; });
    sfx.blip();
    const kept = await setLanguage(world.dev, b.dataset.lang).then(() => true, () => false);
    await languages(el, msg);
    if (!kept) msg.textContent = 'That didn’t save. Try again in a moment.';
  });
}
// The looks (renderers) by their own names, the one on stage pressed. A pick swaps it in behind the computer, no reload,
// and keeps it for this viewer. Until they pick one, the company's look (theme.renderer) is on stage, and pressed.
// Under them, the look on stage's own settings, when it has any (its scene.js exports settings(el), which draws them).
async function lookSettings(el, box) {
  const shipped = (await looks).map(l => l.name), titles = await Promise.all(shipped.map(lookName));
  el.innerHTML = shipped.map((n, i) => `<button data-look="${n}" aria-pressed="${n === look}">${esc(titles[i])}</button>`).join('');
  el.querySelectorAll('[data-look]').forEach(b => b.onclick = async () => {
    el.querySelectorAll('[data-look]').forEach(x => { x.disabled = true; });
    sfx.blip(); await pick(b.dataset.look); lookSettings(el, box);
  });
  const { settings: own } = await import(`../renderers/${look}/scene.js`);
  box.replaceChildren(); box.hidden = !own;
  own?.(box);
}
// Calls with the team: what came of each (the reply its follow-up set for the board), what we heard on it
// (the call ledger: one plain line per item, and where it stands), and a box for what the team missed. Never the
// transcript, nor the words an item quotes: the board is never shown its own calls' words (the coordinator doesn't send them).
// (ready: its work is done and waits for the board's yes, which the CEO records)
const HEARD = { handled: ['handled', '✓', 'handled'], ready: ['open', '◔', 'ready for your yes'], open: ['open', '○', 'open'], dropped: ['dropped', '✗', 'dropped'], replaced: ['changed', '↻', 'changed'] };
const MISSED_MAX = 200; // one plain line (ledger.ts WHAT): longer is refused, never cut
const handledOf = c => `${Number(c.handled)} of ${Number(c.total)} handled`;
// Where the follow-up stands: its reply once it's through, as the agent wrote it (prose.js), else in our words, never
// a status code. Nothing while it writes: its "writing" badge says it.
function followUpHtml(c) {
  if (c.processed && c.reply && !(c.agent === world.company.ceo && !c.request)) return `<div class="call-notes prose">${prose(c.reply)}</div>`;
  const words = followUpWords(c);
  return words ? `<small>${esc(words)}</small>` : '';
}
function followUpWords(c) {
  const name = who(c.agent);
  if (c.state === 'failed') return `${name}’s follow-up failed ${Number(c.attempts) || 3} times, so it stopped trying: what was said may not be handled. Tell ${name} below what was missed, and it starts again.`;
  if (!c.processed) return c.status === 'running' ? '' : c.status === 'queued' ? `${name} writes up the call as soon as a seat is free.`
    : c.status === 'blocked' ? `${name} is waiting for your answer on the ${names.phone}, then writes up the call.` : `${name} didn’t get through it all and tries again in a few minutes.`;
  return c.agent === world.company.ceo && !c.request ? `${cap(name)}’s notes are in the ${names.intercom} chat.` : `${name} followed up.`;
}
// One item heard on a call, as a list item (its job a link): the call log's, and the call player's (callplayer.js)
export function heardLine(i) {
  const [cls, mark, word] = HEARD[i.status] ?? ['open', '○', i.status];
  const by = i.status === 'handled' ? (i.job ? `${esc(who(i.agent ?? i.owner))} · job ${jobNameLink(i.job, i.job_code)}` : esc(i.request ? `your answer · request #${Number(i.request)}` : who(i.owner)))
    : ['open', 'ready'].includes(i.status) ? `${esc(who(i.owner))}${i.job ? ` · job ${jobNameLink(i.job, i.job_code)}` : ''}` : withJobLinks(i.why ?? '');
  const line = i.status === 'replaced' && by ? by : `${esc(word)}${by ? ` · ${by}` : ''}`; // a correction's why says "changed on a later call" itself
  return `<li class="heard-${esc(cls)}"><span class="mark" title="${esc(word)}">${mark}</span><span>${withJobLinks(i.what)}${i.board ? ' <em>(you added this)</em>' : ''}<span class="by">${line}</span></span></li>`;
}
// A call with a walk-through recorded: its key to watch it back
const watchKey = c => `<button type="button" class="cp-watch" data-watch="${Number(c.id)}"><i aria-hidden="true"></i>Watch it back</button>`;
let callWanted = null;
async function callLog(el) {
  const calls = await loadCalls(world.dev);
  if (calls.some(c => c.recorded)) await stylesheet('shell/callplayer.css');   // (the Watch it back key's look).
  // Another call's box, open or half typed, stays as it was when the list redraws after an add.
  const drafts = new Map([...el.querySelectorAll('details.missed')].map(d => [d.dataset.call, [d.open, d.querySelector('textarea').value]]));
  // What we heard on a finished call folds into one line, and stays as the board left it
  const unfolded = new Map([...el.querySelectorAll('details.heard-box')].map(d => [d.dataset.call, d.open]));
  const badge = c => c.state === 'failed' ? ['failed', 'stuck'] : !c.processed ? ['running', 'writing'] : c.handled < c.total ? ['queued', 'open'] : ['done', 'done'];
  const missed = c => `<details class="missed" data-call="${Number(c.id)}"><summary>+ We missed something</summary>
    <div class="row"><textarea rows="2" enterkeyhint="send" aria-label="What ${esc(who(c.agent))} missed on this call" placeholder="One thing ${esc(who(c.agent))} should pick up"></textarea></div>
    <div class="row"><button class="cta" data-add>Add it</button>${canRecord ? `<button class="mic" data-mic title="Tap to talk, tap again to stop" aria-label="Dictate it">${MIC}</button>` : ''}<span class="chars"></span><span class="msg" role="status"></span></div></details>`;
  // (each call's notes as prose, who it was with by their engine's mark)
  el.innerHTML = calls.length ? `<p class="cap"><i class="prompt">&gt; </i>${calls.length} CALLS</p><ul class="rows calls">${calls.map(c => { const [cls, word] = badge(c);
    return `<li data-call="${Number(c.id)}"><span class="st st-${cls}">${word}</span><b>${markOf(c.agent)}${esc(who(c.agent))}${c.request ? ` · about request #${Number(c.request)}` : ''}</b><span class="dim">${esc(ago(c.ts))}${c.total ? ` · ${handledOf(c)}` : ''}</span>${followUpHtml(c)}${c.recorded ? watchKey(c) : ''}${c.total ? `<details class="heard-box" data-call="${Number(c.id)}"${(unfolded.get(String(c.id)) ?? cls !== 'done') ? ' open' : ''}><summary class="heard-cap">What we heard · ${Number(c.total)}</summary><ul class="heard">${(c.items ?? []).map(heardLine).join('')}</ul></details>` : ''}${missed(c)}</li>`; }).join('')}</ul>`
    : `<p><i class="prompt">&gt; </i>No calls yet. Call anyone from their panel, or ${esc(ceoName())} from the ${esc(names.intercom)}.</p>`;
  el.querySelectorAll('details.missed').forEach(d => {
    const field = d.querySelector('textarea'), add = d.querySelector('[data-add]'), count = d.querySelector('.chars'), msg = d.querySelector('.msg');
    const text = () => field.value.replace(/\s+/g, ' ').trim(); // one line: line breaks (a dictated pause) become spaces
    let adding = false; // one request at a time: typing or focusing while it's out doesn't re-enable Add it (a second POST is a second item)
    const paint = () => { const n = [...text()].length, over = n > MISSED_MAX; count.textContent = `${n}/${MISSED_MAX}`; count.classList.toggle('over', over); add.disabled = adding || !n || over;
      if (over) msg.textContent = `That’s more than one thing: keep it to ${MISSED_MAX} characters, and add the rest as another.`; else if (msg.dataset.over) msg.textContent = ''; msg.dataset.over = over ? 1 : ''; };
    [d.open, field.value] = drafts.get(d.dataset.call) ?? [false, ''];
    field.oninput = field.onfocus = paint; paint();
    d.ontoggle = () => { if (d.open) field.focus(); };
    field.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!add.disabled) add.click(); } };
    d.querySelector('[data-mic]')?.addEventListener('click', e => dictateInto(field, e.currentTarget, msg));
    add.onclick = async () => {
      if (adding) return;
      paint(); if (add.disabled || dictation) return;
      adding = add.disabled = true; msg.textContent = 'Adding…';
      try { await addCallItem(world.dev, Number(d.dataset.call), text()); }
      catch (e) { const status = +String(e.message).match(/\d{3}$/)?.[0]; msg.textContent = status ? `That didn’t go through (error ${status}). Try again in a minute.` : 'Could not reach the coordinator. Try again.'; adding = false; paint(); return; }
      adding = false; sfx.ding(0.6); field.value = ''; d.open = false; field.blur();
      toast(`<b>Added to the call</b><br>${esc(who(calls.find(c => c.id === Number(d.dataset.call))?.agent))} picks it up next.`);
      callLog(el);
    };
  });
  // a walk-through call watched back, full screen over HQ (callplayer.js).
  el.querySelectorAll('[data-watch]').forEach(b => b.onclick = async () => {
    const { openCallPlayer } = await import('./callplayer.js');
    openCallPlayer(calls.find(c => c.id === Number(b.dataset.watch)));
  });
  // (a call asked for by HQ's search, once: its notes open and in view, after the computer puts back its scroll)
  const wanted = callWanted != null && el.querySelector(`li[data-call="${Number(callWanted)}"]`);
  callWanted = null;
  if (wanted) { wanted.querySelector('details.heard-box')?.setAttribute('open', ''); requestAnimationFrame(() => wanted.scrollIntoView({ block: 'start' })); }
}
// After a call: once its follow-up is through, a toast with the count ("3 of 5 handled"), or in words that it stopped
// trying. It checks the call log every 30 s while HQ is open (a call nobody spoke on leaves no row: it stops after 10 min).
// It finds the call by its id (a second call with the same agent is newer and would be found first), or, from a voice
// line that doesn't send one, by agent and time. A silent call's row is deleted and the next call can get its id (the
// agent matched too doesn't tell them apart): a newer watcher for an id stops the older one, so one toast per call.
const watching = new Map();
export function watchCall(agent, since, id) {
  const me = {};
  if (id) watching.set(id, me);
  const check = async () => {
    const list = await loadCalls(world.dev).catch(() => null);
    if (id && watching.get(id) !== me) return;
    const c = list?.find(k => k.agent === agent && (id ? k.id === id : Date.parse(k.ts) >= since - 60e3));
    if (c?.state === 'failed') return toast(`<b>Call with ${esc(who(agent))}: not followed up</b><br>Its follow-up failed ${Number(c.attempts) || 3} times, so it stopped trying. Tap to tell ${esc(who(agent))} what was missed.`, () => openComputer('calls'), { sticky: true });
    if (c?.processed) return toast(`<b>Call with ${esc(who(agent))}: ${c.total ? esc(handledOf(c)) : 'done'}</b><br>What we heard is in ${esc(names.os)} → Calls.`, () => openComputer('calls'));
    if (Date.now() - since < (c ? 3 * 3600e3 : 600e3)) return setTimeout(check, 30e3);
    if (id && watching.get(id) === me) watching.delete(id);
  };
  setTimeout(check, 30e3);
}
// The company inbox (read-only): mail to any address at the company's domain (brand.yaml's mail.domain). Tap a message to read it.
// What shows a person's details (Mail's rows, an email card, a delivery address, people's emails, a call out's number) is
// marked data-private and a card's keys data-watchalong-hide, which a walk-through call's recording keeps out
// (shared/watchalong).
// A company app can open it at one message (openComputer's opts.mail: mailWanted; here and at the end of inbox)
let mailWanted = null;
// The 15 s refresh leaves a message that's open as it is: new mail goes in above it.
// A row: the subject, then when, who from and to whom on one line. (the when first,
// the tidy addresses, the groups and the lock below)
const mailRow = m => `<li><details data-mail="${m.id}"><summary><b>${esc(m.subject || '(no subject)')}</b><span class="dim mailfrom" title="${esc(`${m.sender} → ${m.recipient}`)}">${esc(ago(m.received))} · ${esc(tidyAddress(m.sender))}${mailGroup === 'all' || mailGroup === 'other' ? ` → ${esc(tidyAddress(m.recipient))}` : ''}${m.board && mailMixed() ? LOCK : ''}</span></summary><pre class="mailbody">…</pre></details></li>`;
// An address as it reads at a glance: a bounce address's tags after a + go (bounces+123+ab-x=y.com@… is bounces@…), a long
// generated name becomes …, and the company's own domain goes (hello@). The whole address is the row's tooltip.
function tidyAddress(a) {
  const address = String(a ?? '').match(/<([^>]+)>/)?.[1] ?? String(a ?? ''), at = address.lastIndexOf('@');
  if (at < 0) return address;
  const name = address.slice(0, at).split('+')[0], host = address.slice(at + 1);
  const generated = name.length > 24 || /[0-9a-f-]{12,}/i.test(name);
  return `${generated ? '…' : name}@${host.toLowerCase() === String(brand.mail?.domain ?? '').toLowerCase() ? '' : host}`;
}
// Inboxes in groups: brand.yaml's mail.groups names them (board, documents…), the address before the @; everything else
// is Other. A group's one quiet line says whether our agents can read it (mail.boardOnly); where both kinds mix (All,
// Other), the board's own mail carries a small lock.
const MAIL_GROUPS = (Array.isArray(brand.mail?.groups) ? brand.mail.groups : []).filter(g => typeof g === 'string' && /^[a-z0-9._-]+$/i.test(g));
let mailGroup = 'all';
const recipientNames = m => String(m.recipient ?? '').toLowerCase().match(/[^\s<>,;"]+(?=@)/g) ?? [];
const groupOf = m => MAIL_GROUPS.find(g => recipientNames(m).includes(g.toLowerCase())) ?? 'other';
const mailMixed = () => mailGroup === 'all' || mailGroup === 'other';
const LOCK = icon('lock', 'lock', 'Only you can read it');
const boardOnlyGroup = g => (Array.isArray(brand.mail?.boardOnly) ? brand.mail.boardOnly : []).some(n => String(n).toLowerCase() === g.toLowerCase());
const groupLine = g => g === 'all' ? '' : `<p class="mailwho">${g === 'other' ? 'Our agents can read these, except mail with a lock' : boardOnlyGroup(g) ? 'Only you can read this inbox' : 'Our agents can read this inbox'}</p>`;
function mailGroups(mail) {
  if (!MAIL_GROUPS.length) return '';
  const pills = [['all', 'All'], ...MAIL_GROUPS.map(g => [g, cap(g)]), ['other', 'Other']];
  return `<div class="pills" role="radiogroup" aria-label="Inboxes">${pills.map(([k, l]) => `<button role="radio" aria-checked="${k === mailGroup}" data-group="${esc(k)}">${esc(l)}<i>${k === 'all' ? mail.length : mail.filter(m => groupOf(m) === k).length}</i></button>`).join('')}</div>${groupLine(mailGroup)}`;
}
// Send to the team: one button on a mail at one of the board's own addresses, which hands it to brand.yaml's
// mail.forwardTo as a job, the only one that reads it (mail.ts forward). Once handed, it says so with the job's number,
// and a second click (another device, before a refresh) shows the first job's.
const handable = m => !!m.board && !!brand.mail?.forwardTo && recipientNames(m).some(boardOnlyGroup);
const handButton = job => job ? `<button type="button" class="act" disabled>Sent to the team · job #${Number(job)}</button>`
  : '<button type="button" class="act" data-hand>Send to the team</button>';
function wireHand(d, row) {
  const b = d.querySelector('[data-hand]');
  if (!b) return;
  b.onclick = async () => {
    b.disabled = true; sfx.blip();
    try { row.forwarded = (await forwardMail(world.dev, row.id)).job; b.outerHTML = handButton(row.forwarded); }
    catch (err) { b.disabled = false; b.textContent = err.refusal?.error ? `${cap(err.refusal.error)}. Try again` : 'That didn’t go through. Try again'; }
  };
}
const mailCap = n => `<i class="prompt">&gt; </i>${n} MESSAGES · READ-ONLY`;
// Mail's count: the mail that came in since Mail was last open on any of the board's devices, like the Gazette's. The
// newest mail id shown is kept (seen.js; ids go up in the order mail reaches HQ); before anything's recorded, the last
// day's mail counts as new. (every device) Mail to an address only machines' reports reach (brand.yaml's mail.reports,
// the address before the @: a DMARC record's rua) is listed but never counts as new.
const REPORTS = (brand.mail?.reports ?? []).map(name => name.toLowerCase());
const reportMail = m => { const to = recipientNames(m); return to.length > 0 && to.every(n => REPORTS.includes(n)); };
const newMail = mail => { if (!seen) return 0;
  const dayAgo = Date.now() - 864e5;
  return mail.filter(m => !reportMail(m) && (seen.mail == null ? Date.parse(m.received) > dayAgo : m.id > seen.mail)).length; };
async function inbox(el) {
  const all = await loadMail(world.dev), rows = el.querySelector('.rows');
  if (!el.isConnected) return;   // the board left Mail meanwhile: nothing shown, nothing seen
  if (all.length) markSeen('mail', Math.max(...all.map(m => Number(m.id))));   // shown: seen
  if (mailWaiting) { mailWaiting = 0; paintComputerCount(waitingTotal()); }
  const mail = mailGroup === 'all' ? all : all.filter(m => groupOf(m) === mailGroup);
  if (rows && el.querySelector('details[open]')) {
    const top = Number(rows.querySelector('[data-mail]').dataset.mail);
    rows.insertAdjacentHTML('afterbegin', mail.filter(m => m.id > top).map(mailRow).join(''));
    el.querySelector('.cap').innerHTML = mailCap(mail.length);
  } else el.innerHTML = all.length ? `<p class="cap">${mailCap(mail.length)}</p>${mailGroups(all)}<ul class="rows mail" data-private>${mail.map(mailRow).join('')}</ul>`
    : `<p><i class="prompt">&gt; </i>No mail yet. Anything sent to ${brand.mail?.domain ? `an @${esc(brand.mail.domain)} address` : 'the company'} lands here.</p>`;
  el.querySelectorAll('[data-group]').forEach(b => b.onclick = () => { if (mailGroup === b.dataset.group) return; sfx.blip(); mailGroup = b.dataset.group; el.innerHTML = ''; inbox(el); el.scrollTop = 0; });
  el.querySelectorAll('[data-mail]').forEach(d => d.ontoggle = async () => {
    if (!d.open || d.dataset.loaded) return;
    const m = await loadMailOne(world.dev, d.dataset.mail), files = JSON.parse(m.attachments || '[]');
    // attachments are kept as files (a download each); mail from before that lists only their names
    const kb = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
    const old = files.filter(f => typeof f === 'string'), kept = files.map((f, n) => typeof f === 'object' && f ? { ...f, n } : null).filter(Boolean);
    const text = (m.body || '(empty)') + (old.length ? `\n\nAttachments (not stored): ${old.join(', ')}` : '');
    d.querySelector('.mailbody').innerHTML = emailHtml(text)   // as Care shows an email
      + (kept.length ? `\n\nAttachments: ${kept.map(f => `<a href="/api/mail/file?id=${Number(d.dataset.mail)}&n=${f.n}" download>${esc(f.name)}</a> <span class="dim">(${esc(kb(f.size))})</span>`).join(', ')}` : '');
    const row = all.find(r => String(r.id) === d.dataset.mail);
    if (row && handable(row)) { d.insertAdjacentHTML('beforeend', `<p class="mailfwd">${handButton(row.forwarded)}</p>`); wireHand(d, row); }
    d.dataset.loaded = 1;
  });
  if (mailWanted == null) return;
  const want = el.querySelector(`[data-mail="${Number(mailWanted)}"]`); mailWanted = null;
  if (want) { want.open = true; requestAnimationFrame(() => want.scrollIntoView({ block: 'start' })); }
  else el.insertAdjacentHTML('afterbegin', '<p class="why">That message isn’t among the latest mail shown here.</p>');
}
// What waits on the board in the computer's apps: the company apps' own counts (Care's, say) and Mail's new mail (which
// keeps its last count when the coordinator can't say), summed on the computer's HUD badge, refreshed with the requests
// (main.js) and by the home screen. (Review notes don't count: they go in the book.)
let appsWaiting = 0, mailWaiting = 0, homeShown = null;   // homeShown: the screen home() last drew on
const waitingTotal = () => appsWaiting + mailWaiting;
export async function refreshComputerCount() {
  const [counts, mail] = await Promise.all([ownLoaded.then(() => Promise.all(own.filter(k => k.mod.count).map(k => Promise.resolve().then(() => k.mod.count(world.dev)).then(Number, () => 0)))),
    loadMail(world.dev).catch(() => null)]);
  appsWaiting = counts.reduce((sum, c) => sum + (c || 0), 0);
  if (mail) mailWaiting = newMail(mail);   // counted now: Mail may have been opened while it loaded
  if (homeShown) iconCount(homeShown, 'mail', mailWaiting, 'Mail');   // (no Mail icon on screen: nothing drawn)
  paintComputerCount(waitingTotal());
}
// The directory: every department with its people (their engine's mark, role, what they're doing now) and its mascots,
// the board with its own, and the alumni. Tapping someone flies the camera to them and opens their panel.
const STATE = { working: 'working', waiting: 'queuing', sleeping: 'sleeping', idle: 'idle' };
function directory(el) {
  const agents = [...world.agents.values()], n = s => agents.filter(A => !A.data.board && A.state === s).length;
  const person = A => `<li><button data-person="${esc(A.id)}"><span class="st st-${A.data.board ? 'board' : esc(A.state)}">${A.data.board ? 'board' : esc(STATE[A.state] || A.state)}</span><b>${markOf(A.id)}${esc(A.data.name)}</b>
    <span class="dim">${roleHtml(A.data)}</span>${A.task ? `<small>${esc(A.task)}</small>` : ''}</button></li>`;
  const pet = m => `<li><button data-pet="${esc(m.id)}"><span class="st st-pet">${esc(m.kind)}</span><b>${esc(m.name)}</b><span class="dim">${esc([m.role, scene.where?.({ kind: 'mascot', id: m.id })].filter(Boolean).join(' · '))}</span></button></li>`;
  const people = r => r.agentIds.map(id => person(world.agents.get(id))).join('') + world.mascots.filter(m => m.home === r.id).map(pet).join('');
  const board = world.rooms.find(r => r.board), depts = world.rooms.filter(r => r.deptId);
  const group = (title, items, empty) => `<section><h3>${esc(title)}</h3><ul class="rows">${items || `<li class="dim">${empty}</li>`}</ul></section>`;
  // (one span: a row's grid puts each child in a column of its own)
  const alumnus = a => `<li class="dim"><span>${esc(a.name || a.id)}${a.role || a.focus ? ` · ${roleHtml(a)}` : ''}</span></li>`;
  // (one line: each row says its own state, and the building's footer counts the rest)
  el.innerHTML = `<p class="cap"><i class="prompt">&gt; </i>${agents.filter(A => !A.data.board).length} PEOPLE · ${n('working')} WORKING</p>
    ${board ? group('The Board', people(board), '') : ''}
    ${depts.map(r => group(r.name, people(r), 'Nobody here yet')).join('')}
    ${world.alumni.length ? group('Alumni', world.alumni.map(alumnus).join(''), '') : ''}`;
  el.querySelectorAll('[data-person]').forEach(b => b.onclick = () => { closeTool(); flyTo(b.dataset.person); });
  el.querySelectorAll('[data-pet]').forEach(b => b.onclick = () => { closeTool(); visitMascot(b.dataset.pet); });
}

// Notifications on this device. The desk phone rings it for urgent calls and seat sign-ins; the rest waits for the daily
// digest.
// Settings' rows: this device's switch (or why it can't have one) with its state under it, a test ring while it's on,
// then what rings, as plain text. The permission prompt only ever comes from the switch.
const SHARE = icon('share', 'ico', 'Share');
const PUSH = {
  on: ['', 'On: it rings for what’s below.'],
  off: ['', 'Off: it stays quiet.'],
  denied: ['Blocked', 'Blocked in this device’s settings.'],
  install: ['Not yet', 'Add it to the Home Screen first.'],
  'old-ios': ['Update', 'Needs iOS 16.4 or later.'],
  unsupported: ['Unavailable', 'This browser can’t receive notifications.'],
};
async function alerts(el, note = '') {
  const state = await pushState();
  const info = state === 'on' || state === 'off' ? await pushKey().catch(() => null) : null;
  const [word, line] = PUSH[state] ?? PUSH.unsupported;
  const help = state === 'off' && !info ? 'No signal from the coordinator. Try again in a moment.' : line;
  const control = word ? `<span class="push-now">${word}</span>`
    : `<span class="ctl"><button type="button" class="switch" role="switch" data-push="${state === 'on' ? 'off' : 'on'}" aria-checked="${state === 'on'}" aria-labelledby="push-label"${info || state === 'on' ? '' : ' disabled'}><i></i></button></span>`;
  const steps = {
    denied: `<ol><li>iPhone: Settings › Notifications › ${esc(names.hq)} › Allow Notifications</li><li>Android: long-press the ${esc(names.hq)} icon › App info › Notifications (or in the browser: site settings › Notifications › Allow)</li></ol>
      <p>Then the ${esc(names.phone)} gets through.</p><button type="button" class="act" data-push="check">Check again</button>`,
    install: `<p>On iPhone and iPad, notifications only reach the ${esc(names.hq)} app on the Home Screen (iOS 16.4 or later).</p><ol><li>Tap Share ${SHARE} in Safari</li><li>Choose <b>Add to Home Screen</b></li><li>Open ${esc(names.hq)} from the Home Screen and come back here</li></ol>`,
    'old-ios': '<p>Update the iPhone (Settings › General › Software Update), then come back here.</p>',
    unsupported: '<p>Chrome, Firefox, Edge and Safari can.</p>',
  }[state];
  // A sentence, not rows: rows read as options to tap
  const rings = state === 'on' || state === 'off' ? `<p class="cap"><i class="prompt">&gt; </i>WHAT RINGS</p>
    <p class="push-rings">Requests marked urgent, and an AI seat that needs you to sign in. Everything else waits for the daily digest.</p>` : '';
  el.innerHTML = `<div class="push-app"><p class="cap"><i class="prompt">&gt; </i>THIS DEVICE</p><ul class="rows settings">
    <li class="switch-row"><b id="push-label">Notifications</b>${control}<span class="dim">${esc(help)}</span><p class="push-said" role="status">${esc(note)}</p></li>
    ${state === 'on' ? `<li><button data-push="test"><b><span class="bell">${BELL}</span>Send a test</b><span class="to">›</span></button></li>` : ''}</ul>
    ${steps ? `<div class="push-help">${steps}</div>` : ''}${rings}
    ${info?.devices ? `<p class="push-foot">${info.devices} ${info.devices === 1 ? 'device gets' : 'devices get'} notifications.</p>` : ''}</div>`;
  const btn = el.querySelector('[data-push]');
  el.querySelectorAll('[data-push]').forEach(b => b.onclick = async () => {
    const act = b.dataset.push, msg = el.querySelector('.push-said');
    el.querySelectorAll('[data-push]').forEach(x => { x.disabled = true; });
    try {
      if (act === 'on') { // requestPermission runs first, inside the tap
        b.setAttribute('aria-checked', 'true'); sfx.toggle(true);
        const r = await enablePush(info.key);
        return alerts(el, r === 'on' ? 'Done. Send a test to hear it ring.' : r === 'denied' ? '' : 'Nothing changed: the browser didn’t get a yes.');
      }
      if (act === 'off') { b.setAttribute('aria-checked', 'false'); sfx.toggle(false); await disablePush(); return alerts(el, 'Off. This device stays quiet now.'); }
      if (act === 'test') {
        msg.textContent = 'Ringing…';
        const r = await testPush();
        el.querySelector('.bell').classList.add('ringing'); sfx.ring();
        msg.textContent = r.sent ? 'Sent. It should arrive within a few seconds.' : r.failed ? 'The push service turned it down. Try again later.' : 'The coordinator doesn’t know this device yet: turn it off and on again.';
      }
      if (act === 'check') return alerts(el);
    } catch (e) { return alerts(el, `That didn’t work: ${e.message || e}.`); }
    el.querySelectorAll('[data-push]').forEach(x => { x.disabled = false; });
  });
  if (btn && !note && matchMedia('(pointer: fine)').matches) btn.focus({ preventScroll: true });
}
