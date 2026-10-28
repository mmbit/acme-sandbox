// The board creates guest notebooks, shares their invitations and watches their pages.
import { stylesheet } from '../../util.js';
import { act } from '../data.js';
import { mountNotebook } from './notebookguest.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

export async function showGuestNotebooks(notebook = null) {
  stylesheet('shell/ink/bookinvites.css');
  stylesheet('shell/ink/notebookguest.css');
  const dialog = document.createElement('dialog');
  dialog.className = 'bi-dialog';
  dialog.innerHTML = `<div class="bi-bar"><b>Guest notebooks</b><button type="button" data-close aria-label="Close guest notebooks">Close</button></div>
    <div class="bi-body"><section class="bi-manage"><h2>Invite someone</h2><form class="bi-create">
    <label>Notebook name<input name="name" required autocomplete="off" placeholder="Site review: 2026-10-27"></label>
    <label>Kind<select name="kind"><option value="round">Review round</option><option value="invited">Invited notebook</option></select></label>
    <fieldset><legend>People</legend><div class="bi-people">${personFields()}</div><button type="button" data-add>Add a reviewer</button></fieldset>
    <label data-colleagues><input name="colleagues" type="checkbox"> Allow reviewers to invite up to three colleagues at their email domain</label>
    <label data-expiry>Link expires after <input name="days" type="number" min="1" value="7"> days</label>
    <button>Create and invite</button></form><p role="alert" class="bi-error"></p><section class="bi-list" aria-label="Guest notebooks"></section></section>
    <section class="bi-watch" hidden></section></div>`;
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
  bindDialog(dialog, watch, () => stop?.());
  if (notebook !== null) watch(notebook);
  else await list(dialog);
}

function bindDialog(dialog, watch, stop) {
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
  dialog
    .querySelector('[data-add]')
    .addEventListener('click', () =>
      dialog.querySelector('.bi-people').insertAdjacentHTML('beforeend', personFields()),
    );
  dialog.querySelector('[name=kind]').addEventListener('change', () => kindChanged(dialog));
  dialog.querySelector('.bi-create').addEventListener('submit', event => create(dialog, event));
  dialog.querySelector('.bi-list').addEventListener('click', async event => {
    const target = event.target.closest('button');
    if (!target) return;
    if (target.dataset.watch) return watch(Number(target.dataset.watch));
    if (target.dataset.revoke) {
      try {
        await act('/api/notebooks/guests/revoke', { notebook: Number(target.dataset.revoke) });
        await list(dialog);
      } catch (error) {
        dialog.querySelector('.bi-error').textContent = error.message;
      }
    }
  });
}

const personFields = () =>
  `<div class="bi-person"><label>Name<input name="person" required autocomplete="off"></label><label>Email<input name="email" type="email" required autocomplete="off"></label></div>`;

function kindChanged(dialog) {
  const invited = dialog.querySelector('[name=kind]').value === 'invited';
  dialog.querySelector('[data-add]').hidden = invited;
  dialog.querySelector('[data-expiry]').hidden = invited;
  dialog.querySelector('[data-colleagues]').hidden = invited;
  const people = dialog.querySelector('.bi-people');
  if (invited) for (const person of [...people.children].slice(1)) person.remove();
}

async function create(dialog, event) {
  event.preventDefault();
  const form = event.target,
    button = form.querySelector(':scope > button');
  button.disabled = true;
  try {
    const people = [...form.querySelectorAll('.bi-person')].map(person => ({
      name: person.querySelector('[name=person]').value,
      email: person.querySelector('[name=email]').value,
    }));
    await act('/api/notebooks/guests', {
      kind: form.elements.kind.value,
      name: form.elements.name.value,
      people,
      days: Number(form.elements.days.value),
      colleagues: form.elements.colleagues.checked,
    });
    form.reset();
    kindChanged(dialog);
    dialog.querySelector('.bi-error').textContent = '';
    await list(dialog);
    document.dispatchEvent(new Event('book:changed'));
  } catch (error) {
    dialog.querySelector('.bi-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function list(dialog) {
  const read = await act('/api/notebooks/guests');
  dialog.querySelector('.bi-list').innerHTML = read.notebooks
    .map(
      book => `<article><h3>${esc(book.name)}</h3>
    <p>${book.kind === 'round' ? 'Review round' : 'Invited notebook'} · ${book.people.every(person => person.revoked) ? 'Access revoked' : esc(book.state)}</p>
    ${(book.people ?? []).map(person => `<p class="bi-invitation"><b>${esc(person.name)}</b> ${person.revoked ? '<span>Access revoked</span>' : `<a href="${esc(person.link)}" target="_blank" rel="noopener">Invitation link</a>`}</p>`).join('')}
    <div class="bi-actions"><button type="button" data-watch="${book.id}">Watch live</button>${book.people.every(person => person.revoked) ? '' : `<button type="button" data-revoke="${book.id}">Revoke access</button>`}</div></article>`,
    )
    .join('');
}
