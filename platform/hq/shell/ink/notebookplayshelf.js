// The Notebook's store played in memory (notebookplay.js): what the shelf reads of a notebook besides its name, as
// notebookshelf.ts has it: its cover (a seeded one's address, or the data URL given it here) and its new answers and
// asks (seeded: news, asks { open, all }); a cover given from the shelf.
import { refuse } from './notebookplaychecks.js';

export const shelfOf = n => ({ cover: n.cover ?? null, news: n.news ?? 0, asks: { open: 0, all: 0, ...n.asks } });

// POST /api/notebooks/cover { id, picture }: a PNG or JPEG data URL, refused otherwise
export function setCover(s, b) {
  const n = s.notebook(Number(b?.id)) ?? refuse(404);
  if (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(String(b.picture)))
    refuse(400, 'the picture is a PNG or JPEG data URL');
  n.cover = b.picture;
  s.changed(n.id, null);
  return { id: n.id, cover: n.cover };
}
