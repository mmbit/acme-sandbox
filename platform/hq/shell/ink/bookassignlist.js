// The guests a scrap can be handed to, as the board sees them (bookassign.js): the short list (the guests picked most
// recently, each at their whole name, then More…), everyone in a sheet that scrolls with a search over it, and the tags
// a scrap wears for whom it went to (bookgroups.js draws them). Each list is a book's list card (bookcard.js), grown to
// its longest name. Its look: bookassign.css.
//
// A person is the store's { to, name, kind } (kind: 'guest', or 'agent' on a tag from before scraps went to guests
// only).
import { esc } from '../../util.js';
import { scope, word } from './bookscope.js';
import { cardOf } from './bookcard.js';

// what a person is, by their kind
const KIND_WORDS = { guest: 'kindGuest', agent: 'kindAgent' };
const TICK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8.5l3.5 3.5 7.5-8"/></svg>';
const LOOK =
  '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="M13 13l4.5 4.5"/></svg>';

// The short list for people (the store's recent), then More… with the count of everyone: a card in the book, not yet
// placed
export function shortList(people, total) {
  const card = cardOf('bk-assign-short', word('assignTo'));
  card.innerHTML = `<p class="bk-list-head">${word('recent')}</p>${people.map(rowHtml).join('')}<button type="button"
    class="bk-person bk-row bk-list-more" role="menuitem" data-more style="--i:${people.length}"><span class="bk-face" aria-hidden="true">
    <i></i><i></i><i></i></span><span class="bk-name">${word('morePeople')} <small>${word('allPeople', { n: total })}</small>
    </span></button>`;
  return card;
}

// Everyone, A to Z, in a sheet: Share with, Done, a search over them and their rows, which scroll
export function everyoneSheet(people) {
  const card = cardOf('bk-assign-all', word('shareWith'));
  card.innerHTML = `<div class="bk-assign-top"><b>${word('shareWith')}</b><button type="button" class="bk-assign-done"
    >${word('done')}</button></div><label class="bk-assign-search">${LOOK}<input type="search" autocomplete="off"
    placeholder="${esc(word('searchPeopleCount', { n: people.length }))}" aria-label="${esc(word('searchPeople'))}"
    ></label><div class="bk-assign-rows">${people.map(p => rowHtml(p, 0)).join('')}<p class="bk-assign-none" hidden>${word(
      'nobodyByName',
    )}</p></div>`;
  const field = card.querySelector('input');
  field.addEventListener('input', () => {
    const want = folded(field.value.trim());
    const rows = [...card.querySelectorAll('.bk-person')];
    for (const row of rows) row.hidden = !folded(row.querySelector('.bk-name').textContent).includes(want);
    card.querySelector('.bk-assign-none').hidden = rows.some(row => !row.hidden);
  });
  return card;
}

// A person's row: their initial in a circle, their whole name, what they are (popping in i-th)
const rowHtml = (p, i) =>
  `<button type="button" class="bk-person bk-row" role="menuitem" data-to="${esc(p.to)}" style="--i:${i}"><span
    class="bk-face" aria-hidden="true">${esc(initial(p.name))}</span><span class="bk-name">${esc(p.name)}</span><span
    class="bk-kind">${word(KIND_WORDS[p.kind])}</span></button>`;
export const initial = name => ([...name.trim()][0] ?? '?').toUpperCase();
// (a search finds Moreno in "moreno" and Eloïse in "eloise")
const folded = s => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

// ---- a scrap's tags

// the tag just given ({ g, to, at }: it pops in at `at`, performance.now()'s ms), whenever its group is drawn
let given = null;
export const freshTag = (g, to, at) => (given = { g, to, at });

// A group's tags, at its unit's bottom-right corner (bookunits.js places them): an initial in a circle for each person
// it went to, with a tick by it once they've answered; and the seen tick of the agent it went to, when it needs
// nothing back (groupanswers.ts seenTick)
export function tagsHtml(g) {
  const seen = g.seen && !g.assigned?.some(p => p.to === g.seen.by) ? seenHtml(g.seen) : '';
  if (scope || (!g.assigned?.length && !seen)) return '';
  const tags = (g.assigned ?? []).map(p => {
    const label = p.answered ? word('nameAnswered', { name: p.name }) : word('assignedTo', { name: p.name });
    const fresh = popping(g, p) ? ` data-new style="--wait:${Math.round(given.at - performance.now())}ms"` : '';
    return `<span class="bk-tag" title="${esc(label)}" aria-label="${esc(label)}"${fresh}>${p.answered ? TICK : ''}<span
      class="bk-face">${esc(initial(p.name))}</span></span>`;
  });
  return `<div class="bk-tags" data-g="${g.id}">${tags.join('')}${seen}</div>`;
}
// Seen: a small tick with the initial of the agent who read it, in the brand's colour
export function seenHtml(seen) {
  const label = word('seenBy', { name: seen.name });
  return `<span class="bk-tag" data-seen title="${esc(label)}" aria-label="${esc(label)}" role="img">${TICK}<span
      class="bk-face">${esc(initial(seen.name))}</span></span>`;
}
// (drawn again after it has popped in, it's just there)
const popping = (g, p) => given?.g === g.id && given.to === p.to && performance.now() < given.at;
