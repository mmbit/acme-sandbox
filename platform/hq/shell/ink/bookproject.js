// A project's book opens first in its project's view: HQ's projects view tells the book the project it shows, once each
// time it changes (shownProject), and the book opens that project's book when it has one and another is open
// (followProject; the coordinator's ink/askpages.ts makes project books). Told once a change, the board's own choice of
// book stands while it stays there.
import { loadShelf } from './notebookdata.js';

let shown = null;
// projects.js: the project its view shows, or null as it closes
export function shownProject(project) {
  if (project === shown) return;
  shown = project;
  if (project) document.dispatchEvent(new CustomEvent('book:project', { detail: { project } }));
}
// bookpages.js: open(id) opens a notebook in the book
export function followProject(book, open) {
  document.addEventListener('book:project', async e => {
    const project = e.detail?.project,
      found = (await loadShelf(book.dev).catch(() => null))?.shelf.find(n => n.project === project);
    if (found && found.id !== book.notebook) open(found.id);
  });
}
