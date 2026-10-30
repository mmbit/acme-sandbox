// The invited person's Ink notebook: the board's shell with access to their own pages. A guest with more than one book
// picks one from their own small shelf first (bookguestshelf.js). In a review round their page's send marks it done,
// Undo under it taking that back while the round is open. (shelf and Mark done)
import { initBook } from './book.js';
import { showGuestShelf } from './bookguestshelf.js';
import { button, island } from './bookui.js';
import { notebookRequest } from './bookscope.js';
import { esc, stylesheet } from '../../util.js';
import { mountGuestInvites } from './bookguestinvites.js';
import { words, refusals } from './notebookwords.js';

const text = words[document.documentElement.lang];
stylesheet('shell/ink/bookguest.css'); // (its shelf, and a round's Marked done)
const query = new URLSearchParams(location.search);
const api = '/guest/notebooks/api';
const status = document.querySelector('[data-notebook-status]');
const response = await fetch(
  `${api}/list${query.has('notebook') ? `?notebook=${encodeURIComponent(query.get('notebook'))}` : ''}`,
);
const read = await response.json();
if (!response.ok || !read.notebooks.length) {
  status.textContent = read.error ?? text.invitationEnded;
} else if (!query.has('notebook') && read.notebooks.length > 1) {
  showGuestShelf(read.notebooks, status, text);
} else {
  const notebook = read.notebooks[0];
  await initBook({
    scope: { api, notebook: notebook.id, page: notebook.pages.at(-1)?.id, singlePage: notebook.kind === 'round' },
  });
  document.documentElement.append(document.querySelector('#toasts'));
  const invites = mountGuestInvites(notebook);
  // (a round's send reads Mark done; once done, Marked done with Undo beside it)
  const round = notebook.kind === 'round';
  const send = island('send').querySelector('.bk-send');
  if (round && send) {
    send.innerHTML = `<span>${esc(text.markDone)}</span>`;
    send.setAttribute('aria-label', text.markDone);
    send.classList.add('bk-guest-mark');
  }
  const marked = document.createElement('span');
  marked.className = 'bk-guest-marked';
  marked.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/><path d="M5 8.3l2.1 2.1L11.2 6"/></svg>${esc(text.markedDone)}`;
  marked.hidden = true;
  const undo = button({
    text: round ? text.undo : text.unsend,
    onClick: async () => {
      try {
        await notebookRequest('/api/notebooks/pages/undo', { id: notebook.pages[0].id });
        document.dispatchEvent(new CustomEvent('book:notebook'));
      } catch (error) {
        status.textContent = error.message;
      }
    },
  });
  undo.dataset.notebookUndo = '';
  undo.classList.add('bk-guest-undo');
  undo.hidden = true;
  island('pages').append(marked, undo);
  status.className = 'bk-guest-status';
  document.querySelector('#book .bk-paper').append(status);
  let stopped = false;
  let signature = '';
  const refresh = async () => {
    try {
      const current = await fetch(`${api}/list?notebook=${notebook.id}`);
      const listed = await current.json();
      const book = listed.notebooks?.[0];
      if (!current.ok || !book) {
        stopped = true;
        document.querySelector('#book')?.remove();
        document.body.inert = false;
        document.querySelector('main').append(status);
        status.textContent = refusals[listed.reason]?.[document.documentElement.lang] ?? text.invitationEnded;
        return;
      }
      const page = book.pages[0];
      undo.hidden = book.kind !== 'round' || !page?.canUndo;
      marked.hidden = book.kind !== 'round' || !(page?.canUndo || page?.sent || page?.sending);
      invites.update(book);
      status.textContent = book.kind === 'round' ? text.round[book.state] : '';
      const next = JSON.stringify(book);
      if (signature && signature !== next) document.dispatchEvent(new CustomEvent('book:notebook'));
      signature = next;
      // Answers also change groups without a page summary changing.
      for (const page of book.pages)
        document.dispatchEvent(new CustomEvent('book:notebook', { detail: { page: page.id } }));
    } catch (error) {
      status.textContent = error.message;
    }
    if (!stopped) setTimeout(refresh, 1000);
  };
  refresh();
}
