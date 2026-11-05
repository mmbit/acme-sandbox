// The guests a scrap can be handed to, as the board sees them (bookassign.js): the short list (the guests picked most
// recently, each at their whole name, then More…), everyone in a sheet that scrolls with a search over it, and the tags
// a scrap wears for whom it went to (bookgroups.js draws them). Each list is a book's list card (bookcard.js), grown to
// its longest name. Its look: bookassign.css.
//
// A person is the store's { to, name, kind } (kind: 'guest', or 'agent' on a tag from before scraps went to guests
// only).
import { esc } from '../../util.js';
import { icon } from '../icons.js';
import { scope, word } from './bookscope.js';
import { cardOf } from './bookcard.js';
import { faceHtml } from './bookfaces.js';

// what a person is, by their kind
const KIND_WORDS = { guest: 'kindGuest', agent: 'kindAgent' };

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
    >${word('done')}</button></div><label class="bk-assign-search">${icon('find')}<input type="search" autocomplete="off"
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

// A group's tags, at its card's bottom-right corner (bookunitcards.js places them): the face of each person it went to,
// as the seen mark draws one (their initial on a disc ringed in their colour), a tick on it once they've answered.
export function tagsHtml(g) {
  if (scope || !g.assigned?.length) return '';
  const tags = g.assigned.map(p => {
    const label = p.answered ? word('nameAnswered', { name: p.name }) : word('assignedTo', { name: p.name });
    const fresh = popping(g, p) ? ` data-new style="--wait:${Math.round(given.at - performance.now())}ms"` : '',
      colour = p.colour ? ` style="--face:${esc(p.colour)}"` : '';
    return `<span class="bk-tag" data-assigned${p.answered ? ' data-answered' : ''}${fresh} title="${esc(label)}"
      aria-label="${esc(label)}" role="img"><span${colour}>${faceHtml({ by: p.to, name: p.name })}</span>${
        p.answered ? TICK : ''
      }</span>`;
  });
  return `<div class="bk-tags" data-g="${g.id}">${tags.join('')}</div>`;
}
// The seen tick of the agent it went to, when it needs nothing back (groupanswers.ts seenTick): on its own, beside
// what they read (bookunitcards.js places it.)
export function seenMarkHtml(g) {
  if (scope || !g.seen || g.assigned?.some(p => p.to === g.seen.by)) return '';
  return `<div class="bk-seen" data-g="${g.id}">${seenHtml(g.seen)}</div>`;
}
// Seen: the face of the agent who read it, as HQ's look draws them (their initial where it draws none: bookfaces.js), a
// small tick on it in the brand's colour (the board: its avatar, not a letter.)
export function seenHtml(seen) {
  const label = word('seenBy', { name: seen.name });
  return `<span class="bk-tag" data-seen title="${esc(label)}" aria-label="${esc(label)}" role="img">${faceHtml(seen)}${TICK}</span>`;
}
// A tick drawn as the Notebook's own ink, never HQ's pixel icons, which stay on its menus and bars (the board: nothing
// in the Notebook is pixel art.)
const TICK = `<svg class="bk-tick" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.6 8.6c1.1.9 2 1.9 2.8 3.1 1.4-2.9 3.3-5.3 6-7.4"/></svg>`;
// (drawn again after it has popped in, it's just there)
const popping = (g, p) => given?.g === g.id && given.to === p.to && performance.now() < given.at;
