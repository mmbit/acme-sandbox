// The board's Notebook as book-check's stories read it: from its play (a context's notebook: notebookplay.js), through
// the store's own routes, and a scrap as the book shows it on screen.
import { landingPage } from '../shell/ink/notebookstack.js';

// My journal's groups, every page's, the newest made last
export function groupsOf(play) {
  const { pages, archived } = play.route('/api/notebooks/pages', { notebook: mineOf(play) });
  return [...pages, ...archived]
    .flatMap(p => play.route('/api/notebooks/pages/groups', { page: p.id }).groups)
    .sort((a, b) => a.id - b.id);
}
// My journal's page where the board's notes land: the store's current page (notebookstack.js)
export const newestPage = play =>
  landingPage(play.route('/api/notebooks/pages', { notebook: mineOf(play) }).pages, p => p.sending || !!p.sent);
const mineOf = play => play.route('/api/notebooks').shelf.find(n => n.kind === 'mine').id;
// A scrap as the page shown draws it, on screen: its photo, the right edge of its card, its words on it, the paper, and
// the left of the tools' island over its right edge (null: not drawn there yet). On the grid, or on its own sheet
// while it's opened (README, A page of scraps).
export const shownScrap = (page, g) =>
  page.evaluate(g => {
    const el =
        document.querySelector('#book .bk-world .bk-page[data-focus]') ??
        document.querySelector('#book .bk-world .bk-page:not([hidden])'),
      photo = el?.querySelector(`.bk-photo[data-g="${g.id}"]`),
      card = el?.querySelector(`.bk-unit[data-unit="${g.id}"]`);
    if (!photo || (!card && !el.hasAttribute('data-focus'))) return null;
    const r = photo.getBoundingClientRect(),
      words = el.querySelector(`:scope > .bk-groups > .bk-words[data-g="${g.id}"] .bk-scrap-words`);
    return {
      photo: { x: r.left, y: r.top, w: r.width, h: r.height },
      right: Math.max(r.right, card?.getBoundingClientRect().right ?? 0),
      words: words?.value ?? words?.textContent ?? '',
      paper: document.querySelector('#book .bk-desk:not(.bk-turn-picture *)').getBoundingClientRect().toJSON(),
      // (the paper's right side where no tools show, as on the grid)
      tools: document.querySelector('#book .bk-strip').checkVisibility()
        ? document.querySelector('#book .bk-strip').getBoundingClientRect().left
        : document.querySelector('#book .bk-desk:not(.bk-turn-picture *)').getBoundingClientRect().right,
    };
  }, g);
