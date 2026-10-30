// The board's Notebook as book-check's stories read it: from its play (a context's notebook: notebookplay.js), through
// the store's own routes, and a scrap as the book shows it on screen.
import { landingPage } from './shell/ink/notebookstack.js';

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
// A scrap as the page shown draws it, on screen: its photo (one of the page's pictures), the right edge of it and its
// words under it, those words, the paper, and the left of the islands over its right edge (null: not drawn there yet)
export const shownScrap = (page, g) =>
  page.evaluate(g => {
    const el = document.querySelector('#book .bk-world .bk-page:not([hidden])'),
      under = el?.querySelector(`:scope > .bk-groups > .bk-under[data-g="${g.id}"]`);
    if (!under) return null;
    const o = el.getBoundingClientRect(),
      k = o.width / el.offsetWidth,
      c = g.pictures[0],
      photo = { x: o.left + c.x * k, y: o.top + c.y * k, w: c.w * k, h: c.h * k },
      words = under.querySelector('.bk-scrap-words');
    return {
      photo,
      right: Math.max(photo.x + photo.w, under.getBoundingClientRect().right),
      words: words?.value ?? words?.textContent ?? '',
      paper: document.querySelector('#book .bk-desk').getBoundingClientRect().toJSON(),
      tools: document.querySelector('#book .bk-islands').getBoundingClientRect().left,
    };
  }, g);
