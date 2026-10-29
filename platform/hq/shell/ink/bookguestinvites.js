// Colleague invitations on an existing guest round, beside the shared Notebook's controls.
import { button, island } from './bookui.js';
import { notebookRequest } from './bookscope.js';
import { words } from './notebookwords.js';
import { esc } from '../../util.js';

export function mountGuestInvites(notebook) {
  const text = words[document.documentElement.lang];
  const form = document.createElement('form');
  form.className = 'bk-card bk-guest-invite';
  form.hidden = true;
  form.innerHTML = `<h2>${esc(text.inviteColleague)}</h2><p></p><label>${esc(text.name)}<input name="name" required></label><label>${esc(text.email)}<input type="email" name="email" required></label><button>${esc(text.makeLink)}</button><button type="button" data-close>×</button><a hidden target="_blank" rel="noopener">${esc(text.openLink)}</a><p data-invite-error role="alert"></p>`;
  form.querySelector('[data-close]').onclick = () => {
    form.hidden = true;
  };
  const invite = button({
    text: text.inviteColleague,
    onClick: () => {
      form.hidden = !form.hidden;
    },
  });
  invite.hidden = !notebook.invites;
  island('book').append(invite);
  document.querySelector('#book').append(form);
  form.onsubmit = async event => {
    event.preventDefault();
    try {
      const answer = await notebookRequest('/api/notebooks/invite', {
        notebook: notebook.id,
        name: form.elements.name.value,
        email: form.elements.email.value,
      });
      const link = form.querySelector('a');
      link.href = answer.person.link;
      link.hidden = false;
      form.querySelector('[data-invite-error]').textContent = '';
    } catch (error) {
      form.querySelector('[data-invite-error]').textContent = error.message;
    }
  };
  return {
    update(book) {
      invite.hidden = !book.invites;
      if (!book.invites) {
        form.hidden = true;
        return;
      }
      form.querySelector('p').textContent = text.invitations(book.invites.domain, book.invites.left);
      form.querySelector('button').disabled = book.invites.left === 0;
    },
  };
}
