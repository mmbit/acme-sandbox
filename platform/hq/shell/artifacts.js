// HQ's searchable artifact tiles: the company's heroes on top, one row to pick a line of business or the archive.
import { esc } from '../util.js';
import { icon } from './icons.js';
import { loadArtifacts } from './data.js';
import { appTile, inkPictures } from './tiles.js';
import { sfx } from './audio.js';
import { companyFormats } from '../world/clock.js';

// kind: app | prototype | deck | document | art | film
const KINDS = {
  app: 'Apps',
  prototype: 'Prototypes',
  deck: 'Decks',
  document: 'Documents',
  art: 'Art',
  film: 'Films',
};
const ONE = { app: 'App', prototype: 'Prototype', deck: 'Deck', document: 'Document', art: 'Art', film: 'Film' };
// a picture per kind, for a tile with no picture of its own
const GLYPHS = {
  app: icon('artifact-app', 'glyph'),
  prototype: icon('artifact-prototype', 'glyph'),
  deck: icon('artifact-deck', 'glyph'),
  document: icon('artifact-document', 'glyph'),
  art: icon('artifact-art', 'glyph'),
  film: icon('artifact-film', 'glyph'),
};

// What's picked, kept while HQ is open. view: all | place | archive. A place is its level (business, project) and id,
// since a business and a project may share an id.
const ALL = { view: 'all', level: '', id: '' };
let picked = ALL;
const same = (a, b) => a.view === b.view && a.level === b.level && a.id === b.id;
// an artifact's place in the filter row: its line of business, or its project where it has none
const topOf = a => a.place[0];

// desk.js calls this on opening Artifacts and every 15 s
export async function artifactList(el, h) {
  const all = await loadArtifacts(h.dev);
  if (!all.length) {
    el.innerHTML = '<p><i class="prompt">&gt; </i>Nothing here yet.</p>';
    return;
  }
  let box = el.querySelector(':scope > .artifacts');
  if (!box) {
    el.innerHTML =
      '<div class="artifacts"><input class="tilefilter" type="search" placeholder="Search" aria-label="Search" autocomplete="off" enterkeyhint="search">' +
      '<div class="pills" role="group" aria-label="Show"></div>' +
      '<ul class="applist heroes"></ul><ul class="applist"></ul><p class="none" hidden><i class="prompt">&gt; </i>Nothing matches.</p></div>';
    box = el.firstChild;
    box.querySelector('input').oninput = () => narrow(box, box.artifacts);
    box.addEventListener('click', e => {
      const pill = e.target.closest('[data-view]');
      if (!pill) return;
      sfx.blip();
      const { view, level, id } = pill.dataset;
      picked = { view, level, id };
      narrow(box, box.artifacts);
    });
  }
  const heroes = all.filter(a => a.hero && !a.archived),
    rest = all.filter(a => !heroes.includes(a));
  box.artifacts = [...heroes, ...rest];
  const [shelf, list] = box.querySelectorAll('.applist');
  shelf.innerHTML = heroes.map(tile).join('');
  list.innerHTML = rest.map(tile).join('');
  inkPictures(box);
  narrow(box, box.artifacts);
}

function tile(a) {
  const line = `<span class="dim">${esc(a.waiting ? 'set to launch' : day(a.shown) || (a.status ?? ''))}</span>`;
  const site = a.public.length
    ? `<a class="public" href="${esc(a.public[0])}" target="_blank" rel="noopener" data-external="1" title="The public site, no notes">live&nbsp;↗</a>`
    : '';
  const pic = a.picture
    ? `<img class="cover" alt="" src="${esc(a.picture)}" loading="lazy">`
    : a.icon
      ? ''
      : GLYPHS[a.kind];
  return appTile(a, { href: a.open, lines: line, after: site, pic, newTab: true });
}
const day = shown => (shown ? companyFormats().day(shown, 'en', { short: true }) : '');
// lower case, without accents, so "cafe" finds "Café"
const fold = s => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

// Show what the pick and the search keep: the archive alone, or everything else, all of it or one place's
function narrow(box, all) {
  const words = fold(box.querySelector('input').value).split(/\s+/).filter(Boolean);
  const places = placesOf(all.filter(a => !a.archived));
  const archive = all.some(a => a.archived) ? [{ view: 'archive', level: '', id: '', name: 'Archive' }] : [];
  const choices = [{ ...ALL, name: 'All' }, ...places, ...archive];
  if (!choices.some(choice => same(choice, picked))) picked = ALL;
  const inPick = a => {
    if (picked.view === 'archive') return a.archived;
    const top = topOf(a);
    return !a.archived && (picked.view === 'all' || (top?.level === picked.level && top.id === picked.id));
  };
  const kept = a => inPick(a) && words.every(w => fold(searchText(a)).includes(w));
  const row = box.querySelector('.pills');
  const pills = choices
    .map(
      choice =>
        `<button aria-pressed="${same(choice, picked)}" data-view="${choice.view}" data-level="${choice.level}" data-id="${esc(choice.id)}">${esc(choice.name)}</button>`,
    )
    .join('');
  // (drawn again only when it changes, so a row swiped sideways stays where it is)
  if (row.dataset.drawn !== pills) row.innerHTML = row.dataset.drawn = pills;
  const shown = all.map(kept);
  box.querySelectorAll('.applist > li').forEach((li, i) => {
    li.hidden = !shown[i];
  });
  const shelf = box.querySelector('.heroes');
  shelf.hidden = !shelf.querySelector('li:not([hidden])');
  box.querySelector('.none').hidden = shown.includes(true);
}
const searchText = a =>
  [
    a.name,
    a.about,
    ONE[a.kind],
    KINDS[a.kind],
    ...a.place.map(p => p.name),
    ...a.cards.map(c => c.title),
    day(a.shown),
  ].join(' ');
// The places the filter row offers, by name
function placesOf(all) {
  const seen = new Map(
    all
      .map(topOf)
      .filter(Boolean)
      .map(p => [`${p.level} ${p.id}`, { view: 'place', level: p.level, id: p.id, name: p.name }]),
  );
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
