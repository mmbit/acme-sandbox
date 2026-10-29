// The invited person's Ink notebook: the board's shell with access to their own pages and no Shelf.
import { initBook } from './book.js';
import { button, island } from './bookui.js';
import { notebookRequest } from './bookscope.js';
import { mountGuestInvites } from './bookguestinvites.js';
import { words, refusals } from './notebookwords.js';

const text = words[document.documentElement.lang];
const query = new URLSearchParams(location.search);
const api = '/guest/notebooks/api';
const status = document.querySelector('[data-notebook-status]');
const response = await fetch(
  `${api}/list${query.has('notebook') ? `?notebook=${encodeURIComponent(query.get('notebook'))}` : ''}`,
);
const read = await response.json();
if (!response.ok || !read.notebooks.length) {
  status.textContent = read.error ?? text.invitationEnded;
} else {
  const notebook = read.notebooks[0];
  await initBook({
    scope: { api, notebook: notebook.id, page: notebook.pages.at(-1)?.id, singlePage: notebook.kind === 'round' },
  });
  document.documentElement.append(document.querySelector('#toasts'));
  const invites = mountGuestInvites(notebook);
  const undo = button({
    text: text.unsend,
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
  undo.hidden = true;
  island('pages').append(undo);
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
      undo.hidden = book.kind !== 'round' || !book.pages[0]?.canUndo;
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
