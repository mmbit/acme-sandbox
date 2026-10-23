// HQ's Library, the documents the board reads: their shelves, and a card naming a document none shows.
import { readdirSync, existsSync } from 'node:fs';
import { REPO_DIR } from './config.ts';
import { frontmatter, render, readOnce } from './company.ts';
import { docsIn, docOn } from '../../hq/shell/card.js';

// The Library's shelves: the company's handbook, playbooks and departments, the knowledge base's notes by topic, and
// the foundation's craft library (shared/craft) after them. The newsletter's posts are on the Library's shelves too
// (HQ has them already).
const HANDBOOK = ['CHARTER', 'AUTHORITY', 'DECISIONS', 'BUDGET', 'BACKLOG', 'NAMES'];
// Each shelf: a folder's Markdown files but its README, in its order, or with `topics` a shelf per folder in it
const SHELVES: { dir: string; name: string; order?: string[]; topics?: true }[] = [
  { dir: 'company', name: 'Handbook', order: HANDBOOK },
  { dir: 'company/playbooks', name: 'Playbooks' },
  { dir: 'company/departments', name: 'Departments' },
  { dir: 'knowledge/notes', name: 'Notes', topics: true },
  { dir: 'shared/craft', name: 'Shared craft' },
];
export function library() {
  const docs: { path: string; shelf: string; title: string; author?: string; date?: string; html: string }[] = [];
  const shelf = (dir: string, name: string, order: string[] = []) => {
    if (!existsSync(`${REPO_DIR}/${dir}`)) return;
    const files = readdirSync(`${REPO_DIR}/${dir}`)
      .filter(f => f.endsWith('.md') && f !== 'README.md')
      .sort(
        (a, b) =>
          (order.indexOf(a.slice(0, -3)) + 1 || 99) - (order.indexOf(b.slice(0, -3)) + 1 || 99) || a.localeCompare(b),
      );
    for (const f of files)
      docs.push(
        readOnce(`${REPO_DIR}/${dir}/${f}`, text => {
          const { meta, body } = frontmatter(text);
          const heading = body.match(/^#\s+(.+)$/m);
          const title = String(
            meta.title ??
              heading?.[1] ??
              f
                .slice(0, -3)
                .replace(/[-_]/g, ' ')
                .replace(/^./, c => c.toUpperCase()),
          );
          return {
            path: `${dir}/${f}`,
            shelf: name,
            title,
            author: meta.author,
            date: meta.verified ? String(meta.verified) : undefined,
            html: render(
              meta.title || !heading ? body : body.replace(heading[0], ''),
              dir.startsWith('knowledge/') ? dir : null,
            ),
          };
        }),
      );
  };
  for (const { dir, name, order, topics } of SHELVES) {
    if (!topics) shelf(dir, name, order);
    else if (existsSync(`${REPO_DIR}/${dir}`))
      for (const topic of readdirSync(`${REPO_DIR}/${dir}`).sort()) shelf(`${dir}/${topic}`, `${name} · ${topic}`);
  }
  return docs;
}
// A card naming a document by its file that no shelf shows at the folders it gives: the desk phone links it to the
// Library (card.js docsIn), where it would open a search that misses it, or another document with its file name
// (card.js docOn, as the Library opens it). hq ask, hq request and hq rewrite refuse it.
export function unshelvedProblem(body: string) {
  const docs = library(),
    off = [...new Set(docsIn(body))].filter(name => {
      const opens = docOn(docs, name)?.path;
      return !(opens === name || opens?.endsWith('/' + name));
    });
  const where = SHELVES.map(({ dir, name, topics }) => `${dir}/${topics ? '<topic>/' : ''} (${name})`).join(', ');
  return off.length
    ? `the card names ${off.join(', ')}, which the board's Library doesn't show, so the desk phone's link would open a search ` +
        `that misses it. The board reads only the Library's shelves: ${where}. Put what the board must read on the card, or name a document there`
    : null;
}
