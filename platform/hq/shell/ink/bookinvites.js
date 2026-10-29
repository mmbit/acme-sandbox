// The board creates guest notebooks, shares their invitations and watches their pages.
import { stylesheet } from '../../util.js';
import { act, loadPeople } from '../data.js';
import { peopleHtml, wirePeople } from '../people.js';
import * as world from '../../world/world.js';
import { mountNotebook } from './notebookguest.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

export async function showGuestNotebooks(notebook = null) {
  const [, , known] = await Promise.all([
    stylesheet('shell/ink/bookinvites.css'),
    stylesheet('shell/ink/notebookguest.css'),
    loadPeople(world.dev),
  ]);
  const dialog = document.createElement('dialog');
  dialog.className = 'bi-dialog device computer';
  dialog.setAttribute('aria-label', 'Guest notebooks');
  dialog.innerHTML = `<header class="bi-bar"><b>Guest notebooks</b><button class="x" type="button" data-close aria-label="Close guest notebooks">×</button></header>
    <div class="crt"><div class="bi-body screen"><section class="bi-manage notes"><h2>Invite someone</h2>
    ${peopleHtml([], true, { again: known, notebook: true })}
    <section class="bi-list" aria-label="Guest notebooks"></section></section>
    <section class="bi-watch" hidden></section></div></div>`;
  document.body.append(dialog);
  dialog.showModal();
  let stop = null;
  const watch = id => {
    stop?.();
    dialog.querySelector('.bi-manage').hidden = true;
    const host = dialog.querySelector('.bi-watch');
    host.hidden = false;
    stop = mountNotebook(host, { api: '/api/notebooks/guests', watch: true, notebook: id });
    dialog.querySelector('.bi-bar b').textContent = 'Watching live';
  };
  bindDialog(dialog, watch, () => stop?.(), known);
  if (notebook !== null) watch(notebook);
  else await list(dialog);
}

function bindDialog(dialog, watch, stop, known) {
  dialog.addEventListener(
    'close',
    () => {
      stop();
      dialog.remove();
      document.dispatchEvent(new Event('book:changed'));
    },
    { once: true },
  );
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  wirePeople(dialog, {
    known,
    invite: async (name, email) => {
      const notebookName = dialog.querySelector('[name=notebookName]').value.trim() || name;
      await act('/api/notebooks/guests', { name: notebookName, people: [{ name, ...(email ? { email } : {}) }] });
      dialog.querySelector('form.invite').reset();
      dialog.querySelector('[name=notebookName]').placeholder = 'Their name';
      await list(dialog);
      document.dispatchEvent(new Event('book:changed'));
      return `${esc(name)} invited. Send them their invitation link below.`;
    },
  });
  const name = dialog.querySelector('[name=name]');
  name.addEventListener(
    'input',
    () => (dialog.querySelector('[name=notebookName]').placeholder = name.value.trim() || 'Their name'),
  );
  dialog.querySelector('.bi-list').addEventListener('click', async event => {
    const target = event.target.closest('button');
    if (!target) return;
    if (target.dataset.watch) return watch(Number(target.dataset.watch));
    if (target.dataset.revoke) {
      try {
        await act('/api/notebooks/guests/revoke', { notebook: Number(target.dataset.revoke) });
        await list(dialog);
      } catch (error) {
        dialog.querySelector('.invites .msg').textContent = error.message;
      }
    }
  });
}

async function list(dialog) {
  const read = await act('/api/notebooks/guests');
  dialog.querySelector('.bi-list').innerHTML = read.notebooks
    .filter(book => book.kind === 'invited')
    .map(
      book => `<article><h3>${esc(book.name)}</h3>
    <p>Invited notebook · ${book.people.every(person => person.revoked) ? 'Access revoked' : esc(book.state)}</p>
    ${(book.people ?? []).map(person => `<p class="bi-invitation"><b>${esc(person.name)}</b> ${person.revoked ? '<span>Access revoked</span>' : `<a href="${esc(person.link)}" target="_blank" rel="noopener">Invitation link</a>`}</p>`).join('')}
    <div class="bi-actions"><button type="button" data-watch="${book.id}">Watch live</button>${book.people.every(person => person.revoked) ? '' : `<button type="button" data-revoke="${book.id}">Revoke access</button>`}</div></article>`,
    )
    .join('');
}
