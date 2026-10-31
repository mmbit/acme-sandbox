// The board watches a guest's book live: a guest's journal or their pages on shared work, opened from its cover on the
// Shelf. Guests are invited from the work itself (Share on it, desk.js), so there's no central guest screen here.
import { stylesheet } from '../../util.js';
import { mountNotebook } from './notebookguest.js';

export async function watchGuestBook(notebook) {
  await Promise.all([stylesheet('shell/ink/bookinvites.css'), stylesheet('shell/ink/notebookguest.css')]);
  const dialog = document.createElement('dialog');
  dialog.className = 'bi-dialog device computer';
  dialog.setAttribute('aria-label', 'Watching live');
  dialog.innerHTML = `<header class="bi-bar"><b>Watching live</b><button class="x" type="button" data-close aria-label="Close">×</button></header>
    <div class="crt"><div class="bi-body screen"><section class="bi-watch"></section></div></div>`;
  document.body.append(dialog);
  dialog.showModal();
  const stop = mountNotebook(dialog.querySelector('.bi-watch'), {
    api: '/api/notebooks/guests',
    watch: true,
    notebook,
  });
  dialog.addEventListener(
    'close',
    () => {
      stop?.();
      dialog.remove();
      document.dispatchEvent(new Event('book:changed'));
    },
    { once: true },
  );
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
}
