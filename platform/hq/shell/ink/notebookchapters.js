// A notebook's chapters, its bookmarks (bookmarks.js), in the book's order. A round's book (notebookrounds.ts): its
// guests' pages, its Asks and its Advice. Every other book: Sketch (the board's own pages), Asks (a project's design
// asks, ink/askpages.ts) and Calls (a call's notes page, ink/callnotes.ts). Shared by the store (notebook.ts) and the
// book's played store (notebookplay.js).
const CHAPTERS = { round: ['guests', 'asks', 'advice'], book: ['sketch', 'asks', 'calls'] };
// the chapter a page of this kind is in, where its book has it
const OWN = { asks: 'asks', call: 'calls', advice: 'advice' };

// The chapters of a notebook of this kind ('mine', 'round', 'project', 'invited'), in order
export const chaptersOf = notebookKind => CHAPTERS[notebookKind === 'round' ? 'round' : 'book'];

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
