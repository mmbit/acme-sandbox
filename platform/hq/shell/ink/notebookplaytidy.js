// A notebook's blank pages let go once left, played in memory (notebookplay.js): notebooktidy.ts's route with the same
// answer and refusals, on the store's state s.
import { refuse } from './notebookplaychecks.js';

// A route's handler for its 'METHOD path': (s, the body)
export const TIDY_ROUTES = { 'POST /api/notebooks/pages/tidy': tidyPages };
// The notebook's open, untitled sketch pages no group was ever made on, but the one shown (keep), let go: { gone }
function tidyPages(s, b) {
  const n = s.notebook(Number(b?.notebook)) ?? refuse(404),
    keep = Number(b?.keep);
  if (!Number.isInteger(keep)) refuse(400, 'keep is the page shown, its id');
  const blank = p =>
    p.notebook === n.id &&
    p.id !== keep &&
    p.kind === 'free' &&
    !p.archived &&
    p.send_at === null &&
    !p.label &&
    !s.groups.some(g => g.page === p.id);
  const gone = s.pages.filter(blank);
  for (const p of gone) s.pages.splice(s.pages.indexOf(p), 1);
  if (gone.length) s.changed(n.id, null);
  return { gone: gone.length };
}
