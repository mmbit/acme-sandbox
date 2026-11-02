// A notebook's chapters, its bookmarks (bookmarks.js), in the book's order. A round's book (notebookrounds.ts): its
// guests' pages, its Asks and its Advice. Every other book: Sketch (the board's own pages), Asks (a project's design
// asks, ink/askpages.ts) and Calls (a call's notes page, ink/callnotes.ts). Shared by the store (notebook.ts) and the
// book's played store (notebookplay.js).
const CHAPTERS = { round: ['guests', 'asks', 'advice'], book: ['sketch', 'asks', 'calls'] };
// the chapter a page of this kind is in, where its book has it
const OWN = { asks: 'asks', call: 'calls', advice: 'advice' };
// each chapter's name, as the book's words have it (bookscope.js word())
export const CHAPTER_WORDS = {
  sketch: 'chapterSketch',
  asks: 'chapterAsks',
  calls: 'chapterCalls',
  guests: 'chapterGuests',
  advice: 'chapterAdvice',
};

// The chapters of a notebook of this kind ('mine', 'round', 'project', 'invited'), in order
export const chaptersOf = notebookKind => CHAPTERS[notebookKind === 'round' ? 'round' : 'book'];
// The chapters a book ({ kind, round }) has tabs for, in order: a round's Advice once it's done
export const tabsOf = book => chaptersOf(book.kind).filter(c => c !== 'advice' || book.round?.state === 'done');

// A page's chapter by its kind ('free', 'asks', 'call', 'advice', ...) in a notebook of notebookKind: its own where the
// book has it, else the book's first (Sketch, a round's guests)
export function chapterOf(pageKind, notebookKind) {
  const chapters = chaptersOf(notebookKind);
  return chapters.includes(OWN[pageKind]) ? OWN[pageKind] : chapters[0];
}

// A notebook of notebookKind's pages ({ kind, pos, id }) in its chapters' order, each chapter's in the notebook's own
// (pos, then id)
export function inChapters(notebookKind, pages) {
  const chapters = chaptersOf(notebookKind),
    rank = p => chapters.indexOf(chapterOf(p.kind, notebookKind));
  return [...pages].sort((a, b) => rank(a) - rank(b) || a.pos - b.pos || a.id - b.id);
}

// The indexes in pages (a notebook's, in the book's order) of chapter's pages: the arrows, the counter and the page
// list all go by these
export const indexesIn = (pages, chapter) => pages.flatMap((p, i) => (p.chapter === chapter ? [i] : []));
// The index in pages of the page a book shows once its page (gone, one of before: its pages then) has gone: the next
// page of the same chapter still there, else that chapter's last page, else (the chapter empty) the page now at the
// gone page's place
export function shownAfter(before, gone, pages) {
  const was = before.indexOf(gone),
    later = new Set(before.slice(was + 1).map(p => p.id)),
    mates = indexesIn(pages, gone?.chapter);
  return mates.find(k => later.has(pages[k].id)) ?? mates.at(-1) ?? Math.max(0, Math.min(was, pages.length - 1));
}
