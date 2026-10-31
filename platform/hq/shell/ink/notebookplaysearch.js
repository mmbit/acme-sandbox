// The Notebook's store played in memory (notebookplay.js): its search, as the coordinator's booksearch.ts answers it.
import { findIn } from './booksearchwords.js';

// Search (booksearch.ts): a group's words, its handwriting read into type and the answers under it, by their words
export function search(s, q) {
  const entries = [],
    on = s.groups.filter(g => g.deleted === null);
  for (const g of on) {
    const p = s.page(g.page),
      top = g.parent ?? g.id;
    const at = {
      ...{ note: top, n: on.filter(x => x.page === g.page && x.parent === null && x.id <= top).length, page: p.id },
      notebook: p.notebook,
      ...{ day: p.created.slice(0, 10), kind: s.notebook(p.notebook).kind, owner: g.owner },
    };
    if (g.words) entries.push({ ...at, how: g.said ?? 'typed', by: g.by, text: g.words, at: g.created });
    for (const t of g.texts) if (t.text) entries.push({ ...at, how: 'written', by: g.by, text: t.text, at: g.updated });
    for (const a of g.note ? s.slips.filter(l => l.note === g.note) : [])
      entries.push({ ...at, how: 'answer', by: a.by, text: a.text, at: a.created });
  }
  const query = typeof q?.q === 'string' ? q.q : '';
  return { q: query, ...findIn(entries, query) };
}
