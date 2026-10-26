// Settings › Seats: the board's seats, kept by the board itself (HQ-OS › Seats shows how they're doing: seatstatus.js).
// One list: each seat a row (its engine's mark, its name, and what it needs from the board or else its
// provider), Add a seat, and pacing. A seat opens its own page: its sign-in, Pause, the level it stops at, whether a
// Codex subscription seat may spend credits past its plan, a new sign-in or key,
// and Remove. Every change says how it went: waiting for the worker, under way, then done or why not. desk.js's
// Settings draws it, and its back button steps back a page here first (seatsBack). Which model each agent runs on is the
// agent's own page's (panel.js).
import { esc } from '../util.js';
import { engineMark } from './engine.js';
import { loadSeats, loadSeatProviders, addSeat, removeSeat, pauseSeat, signInSeat, sendSeatCode, sendSeatKey, setSeatStop, setPacing, setSeatCredits } from './data.js';
import { sfx } from './audio.js';

const STALE_MS = 60_000;        // a 'waiting' action older than this: the worker isn't there to take it up
const SAID_MS = 10 * 60_000;    // how long an action's "done" stays on its page
const POLL_MS = 2000;           // the read while something moves
const IDLE_MS = 15_000;         // and otherwise, while Seats is open
const SIGNING_IN = ['starting', 'open', 'checking'];
const STOPS = [80, 85, 90, 95, 99];   // the levels a seat can stop at, in percent of its limits (the coordinator takes 50 to 99)
// An action under way, in words (action.what: add, remove, pause, resume, sign-in, key, stop, pacing, credits)
const DOING = { add: 'Setting it up', remove: 'Removing it', pause: 'Pausing', resume: 'Resuming', 'sign-in': 'Signing in', key: 'Testing the key', stop: 'Changing it', pacing: 'Changing it', credits: 'Changing it' };
// Where an action's outcome shows on a seat's page: under the control it came from, the rest at the top
const AT = { pause: 'pause', resume: 'pause', stop: 'stop', credits: 'credits' };

// What the board has open or under way, kept through every redraw
const ui = {
  page: null,           // null: the list; { seat } or 'add'
  asking: new Map(),    // seat → 'remove' (its confirm) or 'key' (a field for its key)
  form: null,           // the Add a seat form: { provider, id, named, name, cli, url, model }
  sending: new Set(),   // what has a request on its way: a seat, '<seat>:pause', '<seat>:stop', '<seat>:credits', 'add', 'pacing'
  refused: new Map(),   // the same → why it didn't go through, in words
  removed: new Map(),   // a seat removed here → { at: when it left the list (null: not yet), what: 'sign-in' | 'key' }
  pacing: null,         // { on, at }: the switch just flipped, till the coordinator's list has it
  set: new Map(),       // '<seat>:pause', '<seat>:stop' or '<seat>:credits' → { value, at }: a seat's setting just changed, the same way
};
let shown = null;   // the last read, { el, h, list, setup }, so a tap redraws at once
let drawn = '';     // its markup: an unchanged read leaves the screen, and its focus, alone
let current = null;   // the element Seats was last opened into: an answer meant for an earlier one is dropped
let poll = 0;

// Settings draws Seats here (h: dev, crumb(parts) for the header); `seat` opens one seat's page (a sign-in card's button)
export async function seatSettings(el, h, seat = null) {
  current = el;
  ui.page = seat ? { seat } : null; ui.form = null; ui.asking.clear();
  el.innerHTML = '<p>LOADING…<i class="cursor"></i></p>';
  const loaded = await read(el, h).then(() => true, () => false);
  if (current !== el) return;
  if (loaded) draw(true);
  else el.innerHTML = '<p><i class="prompt">&gt; </i>No signal from the coordinator. Retrying…<i class="cursor"></i></p>';
  pollSoon(el, h);
}
// The header's back button: a seat's page or Add a seat go back to the list (false: on the list already)
export function seatsBack() {
  if (!ui.page || !shown?.el.isConnected) return false;
  sfx.blip(); go(null);
  return true;
}
// What Settings' Seats row says: how many, or how many need the board
export async function seatsSummary(dev) {
  const list = await loadSeats(dev), needed = list.filter(s => !s.removing && needs(s)).length;
  return needed ? `${needed} need${needed === 1 ? 's' : ''} you` : String(list.filter(s => !s.removing).length);
}
// The seats' own pages, as the list shows them, for HQ's search (desk.js settingsSections)
export const seatPages = async dev => (await loadSeats(dev)).filter(s => !s.removing).map(s => ({ page: s.id, name: s.id }));
async function read(el, h) {
  const [list, setup] = await Promise.all([loadSeats(h.dev), loadSeatProviders(h.dev)]);
  if (current !== el) return;
  shown = { el, h, list, setup };
  for (const [key, want] of ui.set) {
    const [id, what] = key.split(':'), s = list.find(x => x.id === id), value = what === 'pause' ? !!s?.paused : what === 'credits' ? !!s?.use_credits : s?.stop;
    if (!s || value === want.value || (s.action?.status === 'failed' && s.action.at >= want.at)) ui.set.delete(key);
  }
  if (ui.pacing && (setup.pacing?.on === ui.pacing.on || (setup.pacing?.action?.status === 'failed' && setup.pacing.action.at >= ui.pacing.at))) ui.pacing = null;
  for (const [id, gone] of ui.removed) {
    if (gone.at === null && !list.some(s => s.id === id)) gone.at = Date.now();
    if (gone.at && Date.now() - gone.at > SAID_MS) ui.removed.delete(id);
  }
}
// force: after the board's own tap. Otherwise a field it's typing in holds the redraw back.
function draw(force) {
  const { el, list, setup, h } = shown;
  const busy = el.contains(document.activeElement) && document.activeElement.matches('input, textarea, select');
  if (!el.isConnected || (busy && !force)) return;
  if (ui.page?.seat && !list.some(s => s.id === ui.page.seat)) ui.page = null;   // (removed: back to the list, which says so)
  const html = page(list, setup);
  h.crumb?.(crumb());
  if (html === drawn && el.querySelector(':scope > .seats-app')) return;
  const typed = [...el.querySelectorAll('[data-keep]')].filter(f => f.value).map(f => [f.name, f.value]);   // (a key or code half typed)
  const top = scroller(el).scrollTop;
  el.innerHTML = drawn = html;
  for (const [name, value] of typed) { const f = el.querySelector(`[data-keep][name="${CSS.escape(name)}"]`); if (f) f.value = value; }
  scroller(el).scrollTop = top;
  wire(el);
}
const scroller = el => el.closest('.screen') ?? el;   // (Settings' screen scrolls, not the page drawn in it)
const crumb = () => !ui.page ? [] : ui.page === 'add' ? ['Add a seat'] : [ui.page.seat];
function go(to) {
  ui.page = to; ui.asking.clear();
  if (to !== 'add') ui.form = null;
  scroller(shown.el).scrollTop = 0;
  draw(true);
}
// Read again every 2 s while an action or a sign-in moves, so its next step shows as it happens, else every 15 s, for
// as long as Seats is on screen. Until a read has landed in `el` (the first one failed), every 2 s.
function pollSoon(el, h) {
  if (current !== el) return;
  clearTimeout(poll);
  poll = setTimeout(async () => {
    if (!el.isConnected || current !== el) return;
    await read(el, h).then(() => draw(false)).catch(() => {});
    pollSoon(el, h);
  }, shown?.el !== el || moving() ? POLL_MS : IDLE_MS);
}
function moving() {
  const { list, setup } = shown;
  const fresh = a => a?.status === 'working' || (a?.status === 'waiting' && Date.now() - a.at < STALE_MS);
  return ui.sending.size > 0 || [...ui.removed.values()].some(r => r.at === null) || fresh(setup.pacing?.action)
    || list.some(s => s.removing || fresh(s.action) || SIGNING_IN.includes(s.signin?.status));
}

// ---- the pages
function page(list, setup) {
  const p = ui.page, seat = p?.seat && list.find(s => s.id === p.seat);
  const body = seat ? seatPage(seat) : p === 'add' ? addForm(list, setup) : listPage(list, setup);
  return `<div class="seats-app">${body}</div>`;
}
// The list: the seats, Add a seat, and pacing
function listPage(list, setup) {
  const gone = [...ui.removed].filter(([, r]) => r.at).map(([id]) => said('done', `✓ ${id} removed.`)).join('');
  const seatRow = s => `<li data-seat="${esc(s.id)}"><button data-open="${esc(s.id)}"${s.removing ? ' disabled' : ''}><b>${engineMark(s.cli ?? s.engine)}${esc(s.id)}</b><span class="to">${now(s)}${s.removing ? '' : ' ›'}</span></button></li>`;
  const pace = setup.pacing ? `<ul class="rows settings"><li class="switch-row"><b id="pace-label">Pace each week</b>${toggle('pacing', pacingOn(setup), 'pace-label', ui.sending.has('pacing'))}
    ${outcome(setup.pacing.action, 'pacing')}</li></ul><p class="seat-foot">When a seat would run out before its weekly reset, it takes only your work and what must start before then.</p>` : '';
  return `${gone}<p class="cap"><i class="prompt">&gt; </i>SEATS</p><ul class="rows settings seats">${list.map(seatRow).join('')}
    <li><button data-add><b>+ Add a seat</b><span class="to">›</span></button></li></ul>${pace}`;
}
// A seat's row in a word or two: what it is or needs while that's the board's to change, else its provider, so two
// seats tell apart
function now(s) {
  const state = s.state ?? 'new', words = { login: s.sign_in === 'key' ? 'Needs a key' : 'Sign in', closed: 'Closed', paused: 'Paused', new: 'Setting up' };
  const [is, word] = s.removing ? ['removing', 'Removing…'] : words[state] ? [state, words[state]] : s.signin?.status === 'failed' ? ['login', 'Sign in'] : [];
  return word ? `<span class="seat-now is-${esc(is)}">${word}</span>` : `<span class="seat-now">${esc(short(s.provider_name ?? s.provider))}</span>`;
}
// A seat's page: which seat, the one thing it needs (a sign-in, its key), then its settings
function seatPage(s) {
  const signing = s.signin && s.action?.what === 'sign-in';   // (its sign-in says how that's going)
  const top = signing || AT[s.action?.what] ? null : s.action;
  const head = `<div class="seat-top"><b class="seat-name">${engineMark(s.cli ?? s.engine)}${esc(s.id)}</b></div>
    <p class="dim">${esc(s.provider_name ?? s.provider ?? '')}</p>`;
  return `${head}${signIn(s)}${outcome(top, s.id)}${main(s)}${s.removing ? '' : settingsOf(s)}`;
}
// a seat's settings, as Settings' rows: Pause, Stop at, Use credits (a Codex subscription seat's), a new sign-in or key, Remove (which
// asks first, in place)
function settingsOf(s) {
  const id = esc(s.id), asking = ui.asking.get(s.id), off = ui.sending.has(s.id) ? ' disabled' : '';
  const mine = what => (AT[s.action?.what] === what ? s.action : null);
  const paused = wanted(s, 'pause', !!s.paused), stop = wanted(s, 'stop', s.stop), credits = wanted(s, 'credits', !!s.use_credits);
  const stops = [...new Set([...STOPS, stop])].sort((a, b) => a - b);
  const again = s.sign_in === 'login' ? ['sign-in', 'Sign in again'] : ['key', 'Change key'];
  const key = asking === 'key' ? settingsKey(s) : '';
  const remove = asking === 'remove' ? `<div class="seat-ask danger-zone"><p>Its ${s.sign_in === 'key' ? 'key' : 'sign-in'} is deleted from our server. The account stays open with ${esc(String(s.provider_name ?? s.provider).split(':')[0])}.</p>
    <div class="seat-btns"><button type="button" class="danger" data-do="remove-sure"${off}>Remove ${id}</button><button type="button" class="act" data-do="keep">Cancel</button></div></div>` : '';
  return `<ul class="rows settings seat-settings">
    <li class="switch-row"><b id="pause-${id}">Pause</b>${toggle('pause', paused, `pause-${id}`, ui.sending.has(`${s.id}:pause`))}${outcome(mine('pause'), `${s.id}:pause`)}</li>
    <li class="switch-row"><b id="stop-${id}">Stop at</b><span class="seg" role="group" aria-labelledby="stop-${id}">${stops.map(n => `<button type="button" data-stop="${n}" aria-pressed="${n === stop}"${ui.sending.has(`${s.id}:stop`) ? ' disabled' : ''}>${n}%</button>`).join('')}</span>${outcome(mine('stop'), `${s.id}:stop`)}</li>
    ${(s.cli ?? s.engine) === 'codex' && s.sign_in === 'login' ? `<li class="switch-row"><b id="credits-${id}">Use credits past the plan</b>${toggle('credits', credits, `credits-${id}`, ui.sending.has(`${s.id}:credits`))}${outcome(mine('credits'), `${s.id}:credits`)}</li>` : ''}
    ${needs(s)?.[0] === again[0] ? '' : `<li><button data-do="${again[0]}"${off}><b>${again[1]}</b><span class="to">›</span></button>${key}</li>`}
    <li><button data-do="remove" class="danger-row"${off}><b>Remove seat</b></button>${remove}</li></ul>`;
}
// An on/off switch, drawn by the look (style.css, a skin's own): a tap flips it at once and sends the change
// (in a span of its own, so Settings' row-button rules don't take it for a row)
const toggle = (what, on, label, busy) => `<span class="ctl"><button type="button" class="switch" role="switch" data-toggle="${what}" aria-checked="${on}" aria-labelledby="${label}"${busy ? ' disabled' : ''}><i></i></button></span>`;
const wanted = (s, what, value) => (ui.set.has(`${s.id}:${what}`) ? ui.set.get(`${s.id}:${what}`).value : value);
const shows = (p, list) => !p.metered || list.some(s => s.provider === p.id);
const pacingOn = setup => ui.pacing ? ui.pacing.on : setup.pacing?.on !== false;
// "Anthropic: Claude subscription" says the company, the plan reads better alone where the seat's engine is plain
const short = name => String(name ?? '').replace(/^[^:]{1,20}:\s*/, '');
// How the board's latest action went, in words: on its way, waiting for the worker, under way, done or didn't work
function outcome(action, key) {
  if (ui.sending.has(key)) return said('moving', 'Sending…');
  if (ui.refused.has(key)) return said('failed', `Didn’t go through. ${ui.refused.get(key)}`);
  if (!action) return '';
  if (action.status === 'waiting') return Date.now() - action.at > STALE_MS ? said('moving', 'The worker is away: it does this once it’s back.')
    : said('moving', `${DOING[action.what] ?? 'Working on it'}: waiting for the worker…`);
  if (action.status === 'working') return said('moving', `${DOING[action.what] ?? 'Working on it'}…`);
  if (action.status === 'failed') return said('failed', `Didn’t work. ${action.words || 'The worker gave no reason.'}`);
  return Date.now() - action.at < SAID_MS ? said('done', `✓ ${action.words || 'Done.'}`) : '';
}
const said = (kind, words) => `<p class="seat-said ${kind}">${esc(words)}${kind === 'moving' ? '<i class="cursor"></i>' : ''}</p>`;
// A login seat's sign-in, step by step: the provider's page to open, then its code pasted here (Claude) or ours typed
// there (Codex), the check, and how it ended
function signIn(s) {
  const si = s.signin, id = esc(s.id);
  if (!si || s.removing) return '';
  if (si.status === 'starting') return said('moving', 'Starting the sign-in…');
  if (si.status === 'checking') return said('moving', 'Checking…');
  if (si.status === 'failed') return said('failed', `Sign-in didn’t work. ${si.words || 'The sign-in tool gave no reason.'}`);
  if (si.status !== 'open') return Date.now() - si.at < SAID_MS ? said('done', `✓ ${si.words || 'Signed in.'}`) : '';
  const claude = (s.cli ?? s.engine) === 'claude';
  const link = /^https:\/\//.test(si.url ?? '') ? `<a class="seat-link" href="${esc(si.url)}" target="_blank" rel="noopener">Open the sign-in page ↗</a>` : '';
  if (si.asks === 'nothing') return `<div class="seat-signin">${link}<p>Type this code there:</p><b class="seat-code">${esc(si.code)}</b>${said('moving', 'Waiting for you')}</div>`;
  return `<div class="seat-signin">${claude ? '<p>Use an account no other seat uses.</p>' : ''}${link}
    <form class="seat-inline" data-code-form><label>Code from the page<input name="code-${id}" data-keep autocomplete="off" autocapitalize="off" spellcheck="false"></label><button class="cta"${ui.sending.has(s.id) ? ' disabled' : ''}>Send</button></form>
    ${claude ? '<p class="dim">Blank page? Sign in at claude.ai first.</p>' : ''}</div>`;
}
// The one thing a seat needs from the board, if any, as the page's big button
function main(s) {
  const n = needs(s);
  return n && !s.removing ? `<div class="seat-acts"><button type="button" class="cta" data-do="${n[0]}"${ui.sending.has(s.id) ? ' disabled' : ''}>${n[1]}</button></div>${ui.asking.get(s.id) === 'key' && n[0] === 'key' ? settingsKey(s) : ''}` : '';
}
const settingsKey = s => `<form class="seat-ask" data-key-form><label>Key<input type="password" name="key-${esc(s.id)}" data-keep autocomplete="off" spellcheck="false"></label>
  <div class="seat-btns"><button class="cta"${ui.sending.has(s.id) ? ' disabled' : ''}>Save key</button><button type="button" class="act" data-do="keep">Cancel</button></div></form>`;
// a sign-in, another try, its key, or to be resumed
function needs(s) {
  const under = what => s.action?.what === what && ['waiting', 'working'].includes(s.action.status);
  const out = ['login', 'closed'].includes(s.state);
  if (s.sign_in === 'login' && s.signin?.status === 'failed') return ['sign-in', 'Try again'];
  if (s.sign_in === 'login' && out && !SIGNING_IN.includes(s.signin?.status) && !under('sign-in')) return ['sign-in', s.state === 'closed' ? 'Sign in again' : 'Sign in'];
  if (s.sign_in === 'key' && out && !under('key')) return ['key', 'Add the key'];
  return null;
}
// Add a seat: the service it runs on (one of ours, or one of the board's own), its name, and a key where it needs one
function addForm(list, setup) {
  const f = ui.form, own = f.provider === 'new', p = setup.providers.find(x => x.id === f.provider), sending = ui.sending.has('add');
  const groups = setup.providers.filter(x => shows(x, list)).map(x => `<option value="${esc(x.id)}"${x.id === f.provider ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
  const field = (label, name, attrs = '') => `<label>${label}<input data-form="${name}" value="${esc(f[name])}" autocomplete="off" autocapitalize="off" spellcheck="false"${attrs}></label>`;
  const service = own ? `${field('Name', 'name', ' placeholder="EU model host"')}
    <label>It speaks<select data-form="cli">${Object.entries(SPEAKS).map(([cli, api]) => `<option value="${cli}"${f.cli === cli ? ' selected' : ''}>${api}</option>`).join('')}</select></label>
    ${field('API address', 'url', ' type="url" inputmode="url" placeholder="https://api.example.com/v1"')}${field('Model', 'model')}` : '';
  const key = own || p?.sign_in === 'key' ? '<label>Key<input type="password" name="add-key" data-keep autocomplete="off" spellcheck="false"></label>' : '';
  return `<form class="seat-form" data-add-form>
    <label>Service<select data-form="provider">${groups}<option value="new"${own ? ' selected' : ''}>Another service…</option></select></label>
    ${service}${field('Seat name', 'id')}${key}${outcome(null, 'add')}
    <div class="seat-btns"><button class="cta"${sending ? ' disabled' : ''}>Add seat</button></div></form>`;
}
// the APIs a service of the board's own can speak, by the CLI that talks to it
const SPEAKS = { claude: 'Anthropic’s API (Claude Code)', codex: 'OpenAI’s Responses API (Codex)' };
// A free name for a new seat: claude-4 for one more Claude subscription, euhost-1 for a service's first. A seat's name is
// one lowercase word, a dash and a number (the coordinator's SEAT_ID), so the service's name is cut down to its letters.
function freeName(f, list, providers) {
  const p = providers.find(x => x.id === f.provider);
  const named = f.provider === 'new' ? f.name : p?.from === 'platform' && ['claude', 'codex'].includes(p.cli) ? p.cli : p?.id;
  const prefix = (named ?? '').toLowerCase().replace(/[^a-z]+/g, '') || 'seat';
  for (let n = 1; ; n++) if (!list.some(s => s.id === `${prefix}-${n}`)) return `${prefix}-${n}`;
}

// ---- the board's taps
function wire(el) {
  const { h } = shown, seat = ui.page?.seat;
  el.querySelectorAll('[data-open]').forEach(b => b.onclick = () => { sfx.blip(); go({ seat: b.dataset.open }); });
  el.querySelector('[data-add]')?.addEventListener('click', () => {
    sfx.blip();
    const first = shown.setup.providers.find(p => shows(p, shown.list))?.id ?? 'new';
    ui.form = { provider: first, id: '', named: false, name: '', cli: 'claude', url: '', model: '' };
    ui.form.id = freeName(ui.form, shown.list, shown.setup.providers);
    go('add');
  });
  el.querySelectorAll('[data-do]').forEach(b => b.onclick = () => tapped(b.dataset.do, seat));
  el.querySelectorAll('[data-toggle]').forEach(b => b.onclick = () => {
    const on = b.getAttribute('aria-checked') !== 'true';
    b.setAttribute('aria-checked', on);   // (it moves at once; the outcome under it says when it's done)
    sfx.toggle(on);
    if (b.dataset.toggle === 'pacing') { ui.pacing = { on, at: Date.now() }; act('pacing', () => setPacing(h.dev, on), null, () => { ui.pacing = null; }); }
    else if (b.dataset.toggle === 'credits') hold(`${seat}:credits`, on, () => setSeatCredits(h.dev, seat, on));
    else hold(`${seat}:pause`, on, () => pauseSeat(h.dev, seat, on));
  });
  el.querySelectorAll('[data-stop]').forEach(b => b.onclick = () => {
    if (b.getAttribute('aria-pressed') === 'true') return;
    sfx.blip();
    el.querySelectorAll('[data-stop]').forEach(x => x.setAttribute('aria-pressed', x === b));
    hold(`${seat}:stop`, Number(b.dataset.stop), () => setSeatStop(h.dev, seat, Number(b.dataset.stop)));
  });
  el.querySelectorAll('[data-code-form]').forEach(form => form.onsubmit = e => {
    e.preventDefault();
    const field = form.querySelector('input'), code = field.value.trim();
    if (!code) return field.focus();
    field.value = ''; field.blur();
    act(seat, () => sendSeatCode(h.dev, seat, code));
  });
  el.querySelectorAll('[data-key-form]').forEach(form => form.onsubmit = e => {
    e.preventDefault();
    const field = form.querySelector('input'), key = field.value.trim();
    if (!key) return field.focus();
    field.value = ''; field.blur();
    act(seat, () => sendSeatKey(h.dev, seat, key), () => ui.asking.delete(seat));
  });
  wireForm(el);
}
// A tap on a seat's action: Remove and a key ask first; the others go to the coordinator at once
function tapped(what, id) {
  const s = shown.list.find(x => x.id === id), dev = shown.h.dev;
  sfx.blip();
  if (what === 'remove' || what === 'key') {
    ui.asking.set(id, what); ui.refused.delete(id); draw(true);
    if (what === 'key') shown.el.querySelector(`[name="key-${CSS.escape(id)}"]`)?.focus();
    return;
  }
  ui.asking.delete(id);
  if (what === 'keep') return draw(true);
  const request = { 'remove-sure': () => removeSeat(dev, id), 'sign-in': () => signInSeat(dev, id) }[what];
  act(id, request, what === 'remove-sure' ? () => ui.removed.set(id, { at: null, what: s?.sign_in === 'key' ? 'key' : 'sign-in' }) : null);
}
function wireForm(el) {
  const form = el.querySelector('[data-add-form]');
  if (!form) return;
  const f = ui.form, idField = form.querySelector('[data-form=id]');
  form.querySelectorAll('[data-form]').forEach(field => field.oninput = () => {
    f[field.dataset.form] = field.value;
    if (field.matches('input')) field.defaultValue = field.value;   // (kept in ui.form, so desk.js's Home and refresh needn't hold back for it)
    if (field.dataset.form === 'id') f.named = true;
    if (field.dataset.form === 'provider') {   // (another service: its own fields, and a key typed for the last one goes)
      const keyField = form.querySelector('[name=add-key]');
      if (keyField) keyField.value = '';
      if (!f.named) f.id = freeName(f, shown.list, shown.setup.providers);
      ui.refused.delete('add');
      draw(true);
    }
    if (field.dataset.form === 'name' && !f.named) idField.defaultValue = idField.value = f.id = freeName(f, shown.list, shown.setup.providers);
  });
  form.onsubmit = e => {
    e.preventDefault();
    const own = f.provider === 'new', keyField = form.querySelector('[name=add-key]');
    const empty = [...form.querySelectorAll('input')].find(i => !i.value.trim());
    if (empty) return empty.focus();
    const key = keyField?.value.trim();
    if (keyField) { keyField.value = ''; keyField.blur(); }
    const seat = own ? { id: f.id.trim(), provider: 'new', name: f.name.trim(), cli: f.cli, url: f.url.trim(), model: f.model.trim(), key } : { id: f.id.trim(), provider: f.provider, ...(key ? { key } : {}) };
    act('add', () => addSeat(shown.h.dev, seat), () => { ui.form = null; ui.page = { seat: seat.id }; });
  };
}
// A seat's setting changed: shown as set at once, and sent
const hold = (key, value, request) => { ui.set.set(key, { value, at: Date.now() }); act(key, request, null, () => ui.set.delete(key)); };
// One request: "Sending…" under its control, then how it went. A refusal stays in words till the next try.
async function act(key, request, done, failed) {
  ui.sending.add(key); ui.refused.delete(key); draw(true);
  try { await request(); done?.(); }
  catch (err) { ui.refused.set(key, refusalWords(err)); failed?.(); }
  ui.sending.delete(key);
  await read(shown.el, shown.h).catch(() => {});
  draw(true);
  pollSoon(shown.el, shown.h);
}
function refusalWords(err) {
  if (err?.refusal?.error) return err.refusal.error;
  const status = Number(String(err?.message).match(/\d{3}$/)?.[0]);
  return status ? `The server couldn’t do it (error ${status}). Try again in a minute.` : 'Couldn’t reach the coordinator. Try again.';
}
