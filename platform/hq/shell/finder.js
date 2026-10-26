// HQ's go-to-anything search: / (or the search key on a phone) opens one field that finds and opens an app, a piece of
// work, a card, a ticket, an artifact, a call, a mail, a Library document, a person or a setting. Words come first: the
// whole title or code, then its start, then every word in titles and codes, then in the line under them; anything older
// than a week after all of those that are fresher, unless its whole title or code was typed. Meaning comes below
// them when words find little: the coordinator's memory search names what's near (loadMeaning), and HQ shows a hit only
// where one of the lists below already holds it. Every list is the one its own screen shows, so each category keeps that
// screen's rules.
import { esc, fold } from '../util.js'; // (fold)
import * as world from '../world/world.js';
import { icon } from './icons.js';
import { sfx } from './audio.js';
import { loadMeaning } from './data.js';
import { companyApps } from './desk.js';
import { BUILT_IN } from './finder-lists.js';

const $ = s => document.querySelector(s);
// A list read once stays this long while the field opens and closes: typing ranks what's here, never a request
const FRESH_MS = 60_000;
// Fewer keyword hits than this, and meaning is asked too, once the typing pauses
const FEW = 5,
  MEANING_WAIT_MS = 300;
// Rows a category shows while all are searched (the rest one tap away, on its chip): an old item is never one of them
// while something fresher in that category matches
const PER_GROUP = 5;
// An item is old once its date (its list's at) is this far behind
const OLD_MS = 7 * 24 * 3600_000;

let categories = BUILT_IN,
  // what each category holds: id → { at, items, missed, failed }
  held = new Map(),
  // the category picked on the chips, the rows shown (in order) and the one Enter opens
  only = null,
  rows = [],
  active = 0,
  meaningTimer = null,
  near = [],
  // why meaning didn't answer the words in the field ('' when it gave no reason), or null
  meaningWhy = null;

export function initFinder() {
  const box = document.createElement('div');
  box.id = 'finder';
  box.hidden = true;
  box.innerHTML = `<div class="finder" role="dialog" aria-label="Go to anything">
    <label class="finder-field">${icon('find')}<input type="search" role="combobox" aria-expanded="true" aria-controls="finder-list"
      aria-autocomplete="list" autocomplete="off" enterkeyhint="go" placeholder="Go to anything"></label>
    <div class="finder-chips" role="group" aria-label="Look in"></div>
    <ul id="finder-list" class="finder-list" role="listbox"></ul></div>`;
  document.body.append(box);
  const input = box.querySelector('input');
  input.oninput = typed;
  input.onkeydown = keyed;
  box.addEventListener('click', clicked);
  addEventListener('keydown', e => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || !box.hidden || typingSomewhere()) return;
    e.preventDefault();
    openFinder();
  });
  // (Escape closes the field alone: main.js starts this before the projects view's and the devices' own listeners)
  addEventListener(
    'keydown',
    e => {
      if (e.key !== 'Escape' || box.hidden) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      closeFinder();
    },
    { capture: true },
  );
  $('#btn-find')?.addEventListener('click', () => openFinder());
}
const typingSomewhere = () =>
  document.activeElement?.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]');

export async function openFinder() {
  const box = $('#finder'),
    input = box.querySelector('input');
  sfx.blip();
  box.hidden = false;
  only = null;
  input.value = '';
  input.focus();
  paint();
  categories = [...BUILT_IN.slice(0, 1), ...(await companyCategories()), ...BUILT_IN.slice(1)];
  typed(); // (a prefix typed while the company's categories loaded)
  for (const c of categories) fill(c);
}
function closeFinder() {
  clearTimeout(meaningTimer);
  $('#finder input').blur();
  $('#finder').hidden = true;
}
// A company app's category, its prefix its own unless one before it has that prefix
async function companyCategories() {
  const taken = new Set(BUILT_IN.map(c => c.prefix));
  return (await companyApps())
    .filter(k => k.mod.finds)
    .map(k => {
      const { name, prefix } = k.mod.finds,
        free = prefix && !taken.has(prefix);
      if (free) taken.add(prefix);
      return { id: k.id, name, prefix: free ? prefix : null, list: () => k.mod.finds.list(k.hq) };
    });
}
// A category's list, read again when it's older than FRESH_MS; a list that fails stays out, and the field says so, as it
// does for each part a list missed (template/kits/README.md)
async function fill(c) {
  if (Date.now() - (held.get(c.id)?.at ?? -Infinity) < FRESH_MS) return;
  try {
    const listed = await c.list();
    const items = listed
      .filter(item => !item.missed)
      .map(item => ({ ...item, category: c.id, old: isOld(item.at), ...folded(item) }));
    held.set(c.id, { at: Date.now(), items, missed: listed.filter(item => item.missed).map(item => item.missed) });
  } catch (e) {
    console.error(`[hq] search: ${c.id} didn't load`, e);
    held.set(c.id, { at: Date.now(), items: [], missed: [c.name], failed: true });
  }
  if (!$('#finder').hidden) paint();
}
const isOld = at => at != null && Date.now() - new Date(at).getTime() > OLD_MS;
// folded, and "#12" found by "12" (fold)
const findable = s => fold(s).replace(/#/g, '');
function folded({ title, codes = [], sub = '' }) {
  const whole = [title, ...codes].filter(Boolean).map(findable);
  const words = whole.flatMap(f => [f, ...f.split(/[^\p{L}\p{N}]+/u)]).filter(Boolean);
  return { whole, words, text: findable(`${title} ${codes.join(' ')} ${sub}`) };
}

// ---------------------------------------------------------------- typing and keys
// The field's words, a typed prefix ("w:") picking its chip first
function typed() {
  const input = $('#finder input'),
    prefix = input.value.match(/^\s*([a-z]{1,3}):\s*/i);
  const c = prefix && categories.find(x => x.prefix === prefix[1].toLowerCase());
  if (c) {
    only = c.id;
    input.value = input.value.slice(prefix[0].length);
  }
  active = 0;
  near = [];
  meaningWhy = null;
  paint();
  askMeaning();
}
function keyed(e) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (rows.length) active = (active + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
    paintActive();
  } else if (e.key === 'Enter' && rows[active]) {
    e.preventDefault();
    go(rows[active]);
  } else if (e.key === 'Backspace' && !e.target.value && only) {
    only = null;
    paint();
  }
}
function clicked(e) {
  if (e.target.id === 'finder') return closeFinder();
  const chip = e.target.closest('[data-only]'),
    row = e.target.closest('[data-row]');
  if (chip) {
    sfx.blip();
    only = only === chip.dataset.only ? null : chip.dataset.only;
    active = 0;
    paint();
    $('#finder input').focus();
  } else if (row) go(rows[Number(row.dataset.row)]);
}
function go(item) {
  sfx.press();
  closeFinder();
  item.open();
}
// Meaning, once the typing pauses and words found little: what it names that a list holds and words didn't find
function askMeaning() {
  clearTimeout(meaningTimer);
  const q = $('#finder input').value.trim();
  if (q.length < 3 || ranked(q).length >= FEW) return;
  meaningTimer = setTimeout(async () => {
    const { hits, why = null } = await loadMeaning(world.dev, q).catch(e => {
      console.error("[hq] search: meaning didn't answer", e);
      return { hits: [], why: '' };
    });
    if ($('#finder').hidden || $('#finder input').value.trim() !== q) return;
    meaningWhy = why;
    const byKey = new Map(
      searched()
        .flatMap(c => c.items)
        .map(item => [`${meaningKind(item)}:${item.key}`, item]),
    );
    near = hits.map(h => byKey.get(`${h.kind}:${h.id}`)).filter(Boolean);
    paint();
  }, MEANING_WAIT_MS);
}
// (the kinds the coordinator names: memory.ts nearest)
const meaningKind = item =>
  ({ library: 'library', cards: 'card', calls: 'call', work: item.task ? 'task' : '' })[item.category] ?? '';

// ---------------------------------------------------------------- ranking
const searched = () =>
  categories
    .filter(c => !only || c.id === only)
    .map(c => {
      const listed = held.get(c.id);
      return { ...c, items: listed?.items ?? [], missed: listed?.missed ?? [], failed: !!listed?.failed };
    });
// 0 the whole title or a code, 1 its start, 2 every word starting a word of a title or code, 3 every word anywhere in
// the row; null none
function tier(item, q, words) {
  if (item.whole.includes(q)) return 0;
  if (item.whole.some(f => f.startsWith(q))) return 1;
  if (words.every(w => item.words.some(f => f.startsWith(w)))) return 2;
  if (words.every(w => item.text.includes(w))) return 3;
  return null;
}
// The matches, best first: the fresh before the old (late), then by tier, then in the categories' order, each list's own
// order within. An old item typed whole (its title or a code) isn't late: the board asked for that one.
function ranked(typedWords) {
  const q = typedQuery(typedWords),
    words = q.split(' ').filter(Boolean);
  if (!q) return [];
  return searched()
    .flatMap((c, order) => c.items.map((item, i) => ({ item, order, i, tier: tier(item, q, words) })))
    .filter(m => m.tier !== null)
    .map(m => ({ ...m, late: m.tier > 0 && m.item.old }))
    .sort(inOrder);
}
// With nothing typed, a category's own list, the old after the fresh
const listed = shown =>
  shown.flatMap((c, order) => c.items.map((item, i) => ({ item, order, i, tier: 0, late: item.old }))).sort(inOrder);
const inOrder = (a, b) => a.late - b.late || a.tier - b.tier || a.order - b.order || a.i - b.i;
const typedQuery = typedWords => findable(typedWords.trim()).replace(/\s+/g, ' ');

// ---------------------------------------------------------------- drawing
// Grouped by category, the group with the best match first; with nothing typed, the picked category's list (the apps
// when none is picked). Meaning's hits under them. Over them, a line for each place looked in that didn't answer, so a
// search that missed one never reads as "Nothing found".
function paint() {
  const q = $('#finder input').value;
  const shown = searched().filter(c => q.trim() || only || c.id === 'apps');
  const matches = q.trim() ? ranked(q) : listed(shown);
  const groups = new Map();
  for (const m of matches) groups.set(m.item.category, [...(groups.get(m.item.category) ?? []), m]);
  const found = new Set(matches.map(m => m.item));
  const meant = near.filter(item => !found.has(item));
  rows = [];
  // (all searched: a category's first rows, its old ones only when nothing fresher there matches)
  const first = ms => ms.slice(0, Math.min(PER_GROUP, ms.filter(m => !m.late).length || PER_GROUP));
  const list = [...groups]
    .map(([id, ms]) =>
      groupHtml(
        id,
        (only || !q.trim() ? ms : first(ms)).map(m => m.item),
        ms.length,
        typedQuery(q),
      ),
    )
    .join('');
  const meaning = meant.length
    ? `<li class="finder-cap" role="presentation">Near in meaning</li>${meant.map(item => rowHtml(item, true)).join('')}`
    : '';
  const hint = q.trim() ? '' : `<li class="finder-hint" role="presentation">${hintLine()}</li>`;
  const missed = [
    ...shown.flatMap(c => c.missed).map(name => `${esc(name)} didn’t load, so it isn’t searched.`),
    ...(meaningWhy == null ? [] : [`Search by meaning didn’t answer${meaningWhy ? `: ${esc(meaningWhy)}` : ''}.`]),
  ];
  const failed = missed.map(line => `<li class="finder-failed" role="presentation">${line}</li>`).join('');
  const none =
    q.trim() && shown.some(c => !c.failed)
      ? `<li class="finder-none" role="presentation">${noneLine(q, missed.length)}</li>`
      : '';
  $('#finder-list').innerHTML = hint + failed + (list + meaning || none);
  paintChips();
  paintActive();
}
const nameOf = id => categories.find(c => c.id === id)?.name ?? '';
function groupHtml(id, items, total, q) {
  const more =
    total > items.length
      ? `<li role="presentation"><button class="finder-more" data-only="${esc(id)}">${total - items.length} more in ${esc(nameOf(id))}</button></li>`
      : '';
  return `<li class="finder-cap" role="presentation">${esc(nameOf(id))}</li>${items.map(item => rowHtml(item, false, q)).join('')}${more}`;
}
function rowHtml(item, named = false, q = '') {
  const n = rows.push(item) - 1;
  const sub = [named && nameOf(item.category), item.sub].filter(Boolean).join(' · ');
  const code = codeOf(item, q);
  return `<li id="finder-row-${n}" role="option" data-row="${n}"><b>${esc(item.title)}</b>${code ? `<code>${esc(code)}</code>` : ''}${sub ? `<small>${esc(sub)}</small>` : ''}</li>`;
}
// The code a row shows: the one the words start (a look's name on Look), else its first
const codeOf = ({ codes = [] }, q) => (q && codes.find(c => findable(c).startsWith(q))) || codes[0];
const noneLine = (q, missed) =>
  `Nothing found for “${esc(q.trim())}”${only ? ` in ${esc(nameOf(only))}` : missed ? ' in the places that answered' : ''}.`;
// The field's hint while it's empty: the prefixes
function hintLine() {
  const prefixes = categories
    .filter(c => c.prefix)
    .map(c => `<kbd>${esc(c.prefix)}:</kbd> ${esc(c.name.toLowerCase())}`);
  return `Type a name, a code or a few words. Look in one place with ${prefixes.join(', ')}.`;
}
function paintChips() {
  $('.finder-chips').innerHTML = categories
    .map(c => {
      const failed = held.get(c.id)?.failed ? ' title="Didn’t load: try again in a minute"' : '';
      return `<button data-only="${esc(c.id)}" aria-pressed="${only === c.id}"${failed}>${esc(c.name)}</button>`;
    })
    .join('');
}
function paintActive() {
  active = Math.min(active, Math.max(0, rows.length - 1));
  const input = $('#finder input'),
    on = $(`#finder-row-${active}`);
  $('#finder-list')
    .querySelectorAll('[aria-selected]')
    .forEach(el => el.removeAttribute('aria-selected'));
  if (on) on.setAttribute('aria-selected', 'true');
  on?.scrollIntoView({ block: 'nearest' });
  if (on) input.setAttribute('aria-activedescendant', on.id);
  else input.removeAttribute('aria-activedescendant');
}
