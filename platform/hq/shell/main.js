// HQ's entry point: boot, and staying current (the org, open requests, a new HQ version) without a reload button.
import { store, esc } from '../util.js';
// (tipEvent: the look's tip.)
import {
  tipEvent,
  loadOrg,
  connectEvents,
  fetchOrg,
  orgKey,
  loadHealth,
  loadHqChanges,
  loadMeetings,
  loadChat,
} from './data.js';
import * as audio from './audio.js';
import * as world from '../world/world.js';
import * as clock from '../world/clock.js';
import * as weather from '../world/weather.js';
import * as mascots from '../world/mascots.js';
import { mount, loop, look, lookName, looks } from './stage.js';
import { bindInput } from './input.js';
import { bindHud, updateStatus, toast, countBadge } from './hud.js';
import { onEvent } from './events.js';
import { devHooks } from './dev.js';
import { initPanel, panelOpen, refreshAgent } from './panel.js';
import { reloadGazette, paintNews, openGazette } from './news.js';
import {
  initDesk,
  openPhone,
  openIntercom,
  openComputer,
  onRequests,
  refreshRequests,
  refreshComputerCount,
  toolOpen,
  cardTime,
  refreshIntercomCount,
  paintIntercomCount,
  openJob,
  bookAt,
  closeTool,
} from './desk.js'; // (the intercom's count; openJob; bookAt)
import { refreshSeen, seen, onSeen } from './seen.js'; // (seen, onSeen: job #7083)
import { registerWorker, syncPush, urgentCards } from './push.js'; // (urgentCards)
import { names, brand, theme } from './brand.js';
import { initProjects, openProjects, readAhead } from './projects.js'; // (readAhead)
import { initTalk } from './talk.js';
import { initFinder } from './finder.js';
import { initBook, openBook } from './ink/book.js'; // (Ink's folder)
import { initPair } from './ink/pair.js';
import { loadFilms } from './tipcard.js';

const $ = s => document.querySelector(s);
const REQUEST_POLL_MS = 20000; // open board requests
const ORG_POLL_MS = 60000; // the org chart: new people, rooms and departments
const HEALTH_POLL_MS = 60000; // the deployed HQ version
const MEETINGS_POLL_MS = 20000; // the agents' meetings, live and planned
const TALK_POLL_MS = 5000; // while one is live: its talk, for the bubbles
const q = new URLSearchParams(location.search);
clock.init(q, brand.calendar);
weather.init(q);
mascots.init(brand.mascots);

// The same addresses opened on a call by its agent (calldrive.js): done(whether HQ has that screen).
function openedOnCall(tools, asked) {
  const tool = tools[asked?.open];
  asked.done?.(!!tool);
  tool?.(asked);
}
async function boot() {
  brandApp();
  const { org, dev } = await loadOrg();
  known = org;
  world.setOrg(org, dev);
  $('#dev').hidden = !dev;
  // the book beside the page, before the stage, so the building is framed in the room it leaves (a book that can't start
  // stops HQ's start, as the stage does).
  await initBook();
  // The tutorial films load before a tip can open.
  await loadFilms();
  initPair();
  await stage(q.get('intro') !== '0');
  initFinder();
  initPanel();
  initDesk();
  initProjects();
  initTalk(); // (initFinder first: its Escape)
  onRequests(showRequests);
  onSeen(paintDeskCount);
  onSeen(paintIntercomCount); // (onSeen)
  await Promise.all([reloadGazette(dev), refreshSeen()]); // (seen)
  setTimeout(() => paintNews());
  connectEvents(onEvent, dev, org);
  bindInput();
  bindHud();
  updateStatus();
  $('#hud .brand').addEventListener('click', () => tipEvent(dev, 'look').catch(() => {}), { once: true }); // the look's tip (tips.js)
  onRequests(list => urgentCards(dev, list).catch(() => {})); // the notifications' tip.
  keepCurrent();
  $('#loading').classList.add('gone');
  refreshMeetings().then(pollMeetings); // (once HQ is up: who's in a meeting walks there)
  readAhead(); // (the projects view's first open paints at once)
  setTimeout(() => $('#hint').classList.add('gone'), 7000);
  openAsked(dev);
  if (dev) window.hq = devHooks();
  requestAnimationFrame(loop);
}
// HQ kept current: the requests, the counts, the org and the deployed version on their polls, and all of them again
// when the page shows (a new HQ moves in while nobody's looking). (Out of boot, its size)
function keepCurrent() {
  refreshRequests();
  setInterval(refreshRequests, REQUEST_POLL_MS);
  refreshComputerCount();
  refreshIntercomCount();
  setInterval(refreshCounts, REQUEST_POLL_MS); // the computer's count, the intercom's
  setInterval(refreshOrg, ORG_POLL_MS);
  checkHealth();
  setInterval(checkHealth, HEALTH_POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (renovated && !busy()) moveIn();
      return;
    } // a new HQ moves in while nobody's looking
    refreshRequests();
    refreshCounts();
    refreshOrg();
    checkHealth();
    refreshMeetings();
  });
}
// What HQ is asked to open, by a tapped notification, a call or its address. (Out of boot, its size)
function openAsked(dev) {
  // Notifications: the service worker, and what a tapped notification asks for. /?open=phone starts HQ with
  // the phone open (/?open=phone&card=<id>: at that card, a ping's); /?open=jobs&job=<id>, the projects view at that job, its report in it (a link to it, as the CEO gives when work is ready). An HQ that's already running gets a message instead.
  // /?open=book&owner=<agent>: the book at the sheet for that agent (review mode's Open the book, in a tab of its own).
  registerWorker();
  if (!dev) syncPush();
  const tools = {
    phone: ({ card }) => openPhone(card),
    intercom: openIntercom,
    computer: () => openComputer(),
    gazette: () => openGazette(q.get('board') === '1' || undefined),
    settings: () => openComputer('settings', { section: 'sys:seats' }),
    // (/?open=jobs&job=<id>: the projects view with that job open, its report in it.)
    jobs: ({ job }) => (Number(job) ? openJob(Number(job)) : openProjects()),
    onair: () => openComputer('onair'),
    projects: () => openProjects(), // (/?open=projects: HQ at the projects view)
    // (no owner: the book as it is, opened if it's folded, left as it is if not: a call's card.)
    book: ({ owner }) => (owner ? bookAt(owner) : document.documentElement.dataset.book === 'folded' && openBook()),
  };
  navigator.serviceWorker?.addEventListener('message', e => {
    if (tools[e.data?.open]) {
      refreshRequests();
      tools[e.data.open](e.data);
    }
  });
  addEventListener('hq:open', e => openedOnCall(tools, e.detail));
  if (tools[q.get('open')]) {
    tools[q.get('open')]({ job: q.get('job'), owner: q.get('owner'), card: q.get('card') });
    q.delete('open');
    q.delete('job');
    q.delete('owner');
    q.delete('card');
    history.replaceState(null, '', location.pathname + (q.size ? `?${q}` : ''));
  }
  // a new company's first visit opens on the intercom, which asks the language first.
  else if (!dev)
    loadChat(dev).then(
      c => c.welcome && openIntercom(),
      () => toast(`<b>Could not reach the coordinator.</b> Open the ${esc(names.intercom)} to try again.`),
    );
}

// The look: ?renderer=<name> for this page load only, else the one this viewer picked, else the company's. One that
// won't start here (no WebGL2, say) falls back to the company's, then the plain wire, with a word: never a dead HQ.
// (wire, not a style of its own; the looks read from their folders)
async function stage(intro) {
  const shipped = (await looks).map(l => l.name);
  const tries = [...new Set([q.get('renderer') ?? store.get('renderer'), theme.renderer, 'wire'])].filter(n =>
    shipped.includes(n),
  );
  for (const [i, name] of tries.entries()) {
    try {
      await mount(name, intro);
    } catch (e) {
      console.error(`HQ could not start the ${name} view:`, e);
      continue;
    }
    if (i)
      toast(
        `<b>${esc(await lookName(tries[0]))} didn't load on this device.</b> Showing ${esc(await lookName(look))} instead.`,
      );
    return;
  }
  throw new Error(`No view of ${names.hq} would start here`);
}

// The app in the brand's words and looks, over index.html's own (the coordinator serves it that way already, but a
// local HQ has only the file; hud.js names the buttons). Colours and font go in a sheet of their own over style.css's,
// so the page's nodes stay as they are.
function brandApp() {
  const { app, logo, font = {}, colours = {} } = brand,
    img = $('#hud .brand img');
  document.title = app.title;
  $('meta[name="description"]').content = app.description;
  $('meta[name="apple-mobile-web-app-title"]').content = names.hq;
  if (app.themeColour) $('meta[name="theme-color"]').content = app.themeColour;
  if (logo.svg && img.getAttribute('src') !== logo.svg) img.src = logo.svg; // (the same src again would fetch it again)
  img.alt = logo.alt;
  // (HQ's CSP takes fonts from Google only; the coordinator puts the same link in index.html, so it's there before boot.
  if (font.href && !$('link[data-brand-font]')) {
    const l = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: font.href });
    l.dataset.brandFont = '';
    $('link[rel=stylesheet]').before(l);
  }
  const sheet = new CSSStyleSheet(),
    root = sheet.cssRules[sheet.insertRule(':root {}')].style;
  for (const [k, v] of Object.entries(colours)) {
    if (/^#[\da-f]{3,8}$/i.test(v)) root.setProperty(`--${k}`, v);
    else console.warn(`[hq] brand.yaml: colours.${k} isn't a #hex colour, so HQ uses its own`);
  }
  if (font.family) root.setProperty('--font', font.family);
  // the logo on dark, for a look whose skin puts it on a dark plate (the name as the login page takes it, pages.ts darkLogo)
  root.setProperty(
    '--logo-dark',
    `url(/${/^[\w-]+\.svg$/.test(logo.svgDark ?? '') ? logo.svgDark : 'wordmark-dark.svg'})`,
  );
  document.adoptedStyleSheets = [sheet];
}

// ---------------------------------------------------------------- staying current without a reload button
// The installed app can't be refreshed by hand, so everything live refreshes itself: the org is re-read
// (every minute, on return to the app, or when an event names someone we don't know) and the building
// rebuilt if its shape changed, and who is at work taken from it (not in dev: its mock org runs no jobs). Requests, the
// newsletter, seats and jobs refresh themselves elsewhere.
// (one read at a time: a second call has the one under way, so an agent's panel waits for it; it tells whether the read
// came in.)
let orgRead = null,
  known = null; // known: the org as last read
export const refreshOrg = () => (orgRead ??= readOrg().finally(() => (orgRead = null)));
async function readOrg() {
  const asked = Date.now(),
    org = await fetchOrg(world.dev);
  if (!org) return false;
  world.setMachines(org.machines);
  world.setStudio(org.studio);
  if (orgKey(org) !== orgKey(known)) {
    known = org;
    world.setOrg(org);
    updateStatus();
    const p = panelOpen();
    if (p?.kind === 'agent') refreshAgent(p.ref);
  }
  if (!world.dev) world.setStatuses(org, asked);
  return true;
}
// The meetings: who sits in the meeting room, what about, and what's next on its door. A failed read leaves them unread
// (null) until a read succeeds, and the room and its panel say so
const refreshMeetings = () =>
  loadMeetings(world.dev).then(world.setMeetings, e => {
    console.error("[hq] The meetings can't be read:", e);
    world.setMeetings(null);
  });
// read more often while a meeting is live, so its bubbles keep up with the talk
const pollMeetings = () =>
  setTimeout(() => refreshMeetings().then(pollMeetings), world.meetings?.live.length ? TALK_POLL_MS : MEETINGS_POLL_MS);
// A new HQ version: a friendly toast to move in, saying what changed (the newest change, and how many more), or (only
// while the app is in the background, with no overlay open and nothing being typed) an automatic reload.
let commit = null,
  head = null,
  renovated = false;
const busy = () => toolOpen() || !!document.activeElement?.matches?.('input, textarea');
const moveIn = () => location.reload();
export async function checkHealth() {
  const h = await loadHealth();
  const v = h?.hq || h?.commit; // HQ's own version (its files), not the repo's: the agents' work doesn't count
  if (!v || renovated) return;
  if (commit == null) {
    commit = v;
    head = h.head;
    return;
  }
  if (v === commit) return;
  renovated = true;
  if (document.hidden && !busy()) return moveIn();
  const changes = head ? await loadHqChanges(head) : [];
  const newest = changes[0]?.length > 120 ? `${changes[0].slice(0, 119).trimEnd()}…` : changes[0];
  const what = newest ? ` ${esc(newest)}${changes.length > 1 ? `, and ${changes.length - 1} more` : ''}.` : '';
  toast(`<b>${esc(names.hq)} was renovated</b>${what} Tap to move in`, moveIn, { sticky: true });
}
// The counts that hang on what the board has read (Mail's, the Gazette's, the intercom's), read again with the requests, so a read on
// another device clears them here too
const refreshCounts = () =>
  refreshSeen().then(() => {
    paintNews();
    refreshIntercomCount();
    return refreshComputerCount();
  });
// Open board requests (see desk.js): refreshed every 20 s, when HQ comes back to the foreground and
// when an agent asks the board something. The badge and the ringing desk phone follow the same list.
// A card that changed (an agent rewrote it) rings and counts as unread like a new one: both go by cardTime.
let cards = [],
  heard = ''; // heard: the newest card time HQ has rung for
// A tip (tips.js) neither rings nor counts.
function showRequests(list) {
  const waiting = list.filter(r => r.kind !== 'tip'),
    n = waiting.length,
    newest = waiting.map(cardTime).sort().at(-1) ?? '';
  cards = waiting;
  paintDeskCount();
  if (newest > heard) {
    if (audio.ready()) audio.sfx.ring();
    heard = newest;
  }
  world.setRequests(n);
  (n ? navigator.setAppBadge?.(n) : navigator.clearAppBadge?.())?.catch(() => {}); // the Home Screen icon's count
  if (panelOpen()?.ref === 'board') refreshAgent('board');
}
// The badge counts the open cards. It turns grey once the board has seen each of them on the desk phone, and red again
// when a card is new or changed. Red until the marks have loaded.
function paintDeskCount() {
  const el = $('#desk-count'),
    seenUpTo = seen?.desk;
  countBadge(el, cards.length);
  el.classList.toggle('read', seenUpTo != null && cards.every(r => cardTime(r) <= seenUpTo));
}

boot().catch(e => {
  console.error(e);
  $('#loading').textContent = `${names.hq} could not load. Try again in a moment.`;
});
