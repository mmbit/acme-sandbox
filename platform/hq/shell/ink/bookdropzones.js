// The two drop zones the line out of a circled scrap is drawn into (bookgridgesture.js): People along the paper's top,
// everyone the scrap can go to (invited people, never agents: the store's list), and Pages along its foot, the open
// pages of the scrap's chapter and a new page. They slide in as the line starts, while the page's controls fade, each
// mark big enough for the Pencil; the one under the line's end lights, and they slide away after. Their look:
// bookdropzones.css.
import { esc, stylesheet } from '../../util.js';
import { sfx, foley } from '../audio.js';
import { icon } from '../icons.js';
import { word } from './bookscope.js';
import { nameOf } from './bookhead.js';
import { initial } from './bookassignlist.js';
import { tidy } from './bookassignfly.js';

stylesheet('shell/ink/bookdropzones.css');

// a mark is under the line's end this far (px) outside it too: a Pencil's lift wanders a little
const SLOP_PX = 10;
// the marks' pops, a note each, as they come in one by one (bookdropzones.css's 60 ms apart)
const NOTES = ['A5', 'C6', 'D6', 'E6', 'G6'];

// The zones over room (the paper's part of the screen, a DOMRect): people, a promise of the store's { everyone } (or
// null: no People zone), pages the chapter's (here among them, muted). → { at(x, y), light(mark), person(mark),
// page(mark), close() }: the mark under a point, lit, what a mark stands for ({ to, name, … } or a page, null: a new
// one), the zones gone.
export function openZones(room, { people, pages, here }) {
  const home = document.getElementById('book') ?? document.body;
  const zone = (kind, title) => {
    const el = document.createElement('div');
    el.className = `bk-zone bk-zone-${kind}`;
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', title);
    el.innerHTML = `<p class="bk-zone-head">${esc(title)}</p><div class="bk-zone-marks"></div>`;
    Object.assign(el.style, { left: `${room.left + 8}px`, width: `${room.width - 16}px` });
    home.append(el);
    return el;
  };
  const els = [],
    known = { everyone: [] };
  if (people) els.push(peopleZone(zone('people', word('zonePeople')), room, people, known));
  const foot = zone('pages', word('zonePages'));
  foot.querySelector('.bk-zone-marks').innerHTML = `${pages.map((p, i) => pageHtml(p, i, p === here)).join('')}<button
    type="button" class="bk-mark" data-page="new" tabindex="-1" style="--i:${pages.length}"><span class="bk-mark-face"
    >${icon('plus')}</span><span class="bk-mark-name">${esc(word('newPage'))}</span></button>`;
  foot.style.top = `${room.bottom - 8 - foot.offsetHeight}px`;
  popped(foot);
  els.push(foot);
  let lit = null;
  return {
    at: (x, y) => markAt(els, x, y),
    light(mark) {
      if (mark === lit) return;
      lit?.removeAttribute('data-lit');
      mark?.setAttribute('data-lit', '');
      if (mark) sfx.tick();
      lit = mark;
    },
    person: mark => known.everyone.find(p => p.to === mark.dataset.to) ?? null,
    page: mark => pages.find(p => String(p.id) === mark.dataset.page) ?? null,
    close: () => tidy(els),
  };
}

// The People zone at the paper's top, its marks once the store's list is in (known.everyone)
function peopleZone(top, room, people, known) {
  top.style.top = `${room.top + 8}px`;
  const marks = top.querySelector('.bk-zone-marks');
  marks.innerHTML = '<span class="bk-zone-wait" aria-hidden="true"><i></i><i></i><i></i></span>';
  people.then(
    read => {
      known.everyone = read.everyone;
      if (!top.isConnected) return;
      marks.innerHTML = read.everyone.length
        ? read.everyone.map(personHtml).join('')
        : `<span class="bk-zone-none">${esc(word('zoneNobody'))}</span>`;
      popped(top);
    },
    () => (marks.innerHTML = ''),
  );
  return top;
}
// The mark under a point on the screen (or this near it), or null
function markAt(els, x, y) {
  for (const el of els)
    for (const mark of el.querySelectorAll('.bk-mark:not([aria-disabled])')) {
      const r = mark.getBoundingClientRect();
      if (x >= r.left - SLOP_PX && x <= r.right + SLOP_PX && y >= r.top - SLOP_PX && y <= r.bottom + SLOP_PX)
        return mark;
    }
  return null;
}
// (each mark pops in with a note of its own)
const popped = el =>
  el
    .querySelectorAll('.bk-mark')
    .forEach((_, i) => foley('bubble', { note: NOTES[i % NOTES.length] }, { vol: 0.25, at: 0.04 + i * 0.06 }));

// A person: their initial on a disc in their colour, their name under it
const personHtml = (p, i) =>
  `<button type="button" class="bk-mark" data-to="${esc(p.to)}" tabindex="-1" style="--i:${i}${
    p.colour ? `;--face:${esc(p.colour)}` : ''
  }"><span class="bk-mark-face bk-mark-person">${esc(p.initial ?? initial(p.name))}</span><span class="bk-mark-name"
  >${esc(p.name)}</span></button>`;
// A page: a page's icon and its name; the scrap's own page muted
const pageHtml = (p, i, here) =>
  `<button type="button" class="bk-mark"${here ? ' aria-disabled="true"' : ` data-page="${p.id}"`} tabindex="-1"
  style="--i:${i}"><span class="bk-mark-face">${icon('page')}</span><span class="bk-mark-name">${esc(nameOf(p))}</span
  ></button>`;
