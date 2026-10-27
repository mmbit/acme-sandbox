// What a send carries, said for a moment on the page in the book's own paper and type as the plane lands in its face:
// "3 notes to Bolt" with each note's snip small, taped on, and whether the page itself goes. A sheet's send carries its
// notes (each one's snip, words and mark: booksheets.ts) and the board's writing on the page beside each (bookwriting.ts.), never the page itself, so pictures taped on it say they stay here; a page
// given by its corner goes whole, as drawn. Then the ring round the face, and the sheet's stamp of what went to whom
// (booksheet.js). Its look: bookwent.css. (the face's: job #19861)
import { esc } from '../util.js';
import { notesWord } from './booksheetplace.js';

// how long it stays, and the most snips it shows (the rest counted)
const SHOW_MS = 2600;
const CUTS = 5;

// sheet: the sheet sent (its open notes go) or, a free page sent on its own, { page: true }; to: whom, by name
export function went(v, sheet, to) {
  v.el.querySelector('.bs-went')?.remove();
  const card = document.createElement('aside');
  card.className = 'bs-went';
  card.setAttribute('role', 'status');
  card.innerHTML = sheet.notes ? notesHtml(v, sheet, to) : pageHtml(to);
  v.el.append(card);
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  card.animate(
    still
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [
          { opacity: 0, transform: 'translateY(-10px) rotate(-1deg) scale(0.96)' },
          { opacity: 1, transform: 'rotate(-1deg)' },
        ],
    { duration: 180, easing: 'cubic-bezier(.2,.8,.3,1)' },
  );
  setTimeout(() => {
    card
      .animate(
        still
          ? [{ opacity: 1 }, { opacity: 0 }]
          : [
              { opacity: 1, transform: 'rotate(-1deg)' },
              { opacity: 0, transform: 'translateY(-6px) rotate(-1deg) scale(0.98)' },
            ],
        { duration: 220, easing: 'ease-in', fill: 'forwards' },
      )
      .finished.then(
        () => card.remove(),
        () => card.remove(),
      );
  }, SHOW_MS);
  return card;
}

function notesHtml(v, sheet, to) {
  const going = sheet.notes.filter(n => n.status === 'open'),
    snips = going.filter(n => n.snip).slice(0, CUTS),
    more = going.length - snips.length;
  // (the board's own writing on this page goes beside its notes; pictures taped on it stay.)
  const wrote = v.page.ink?.length,
    kept = v.page.scraps?.length;
  return `<b>${esc(notesWord(going.length))} to ${esc(to)}</b>${
    snips.length
      ? `<span class="bs-went-cuts">${snips
          .map(n => `<i><img src="${esc(n.snip)}" alt="" draggable="false"></i>`)
          .join('')}${more > 0 ? `<em>+${more}</em>` : ''}</span>`
      : ''
  }<small>${wrote ? 'Each with its snip and words, and any new writing you put beside it.' : 'Each with its snip and words.'}${
    kept ? ' Your pictures on this page stay here.' : ''
  }</small>`;
}
const pageHtml = to => `<b>This page to ${esc(to)}</b><small>The whole page, as you drew it.</small>`;
