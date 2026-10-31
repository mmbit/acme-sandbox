// The page's title, written where its name is listed: while the notebook's pages are open (bookcontrols.js), their
// card has the page's title at its head, its field ruled like a notebook's line. Enter or a tap away saves what was written, Escape leaves the
// title as it was (nothing sent: the title route marks what it gets as the board's), and an empty title leaves the
// page Untitled page. A save that's refused says why quietly over the field, which keeps what was written: Enter or
// a tap away tries again, Escape or a tap on the note lets it go. While a save is out, the field can't be written in.
import { titlePage } from './notebookdata.js';
import { untitledPage } from './bookhead.js';
import { word } from './bookscope.js';
import { named, said } from './booksave.js';

// name: the rail's control the pages opened from, the focus's way back; within: the pages' card, the field at its
// head, where a tap isn't one away;
// answered(ended): the edit ended (true: saved, let go, or ended from outside) or its save was refused (false: it
// stays, saying so). Returns { page, box, field, end(keep) }: end(true) saves what was written when it changed,
// end(false) puts the name back at once, a save still out then landing on its page alone; end resolves true once the
// title is through (false: its save was refused, or the edit was let go before it came back).
export function editTitle(name, book, within, answered) {
  const page = book.views[book.cur].page,
    edit = { name, book, page, within, was: page.label ?? '', answered, saving: null, ended: false };
  Object.assign(edit, mountField(within, edit.was));
  const { box, field, error } = edit,
    end = keep => endTitle(edit, keep);
  field.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    end(e.key === 'Enter');
  });
  // (a tap away saves, and tries again after a refusal, for as long as the edit lasts, the field focused or not; the
  // focus moved on by the keys does too. A blur to nowhere, as a Safari tap on a page's row, leaves it to the tap.)
  edit.away = e => !box.contains(e.target) && !within.contains(e.target) && end(true);
  addEventListener('pointerdown', edit.away, true);
  // (Escape lets it go wherever the focus is, for as long as the edit lasts: the field's own keys stop at the field)
  edit.escape = e => e.key === 'Escape' && end(false);
  addEventListener('keydown', edit.escape);
  field.addEventListener('blur', e => e.relatedTarget && !within.contains(e.relatedTarget) && end(true));
  error.addEventListener('click', () => end(false));
  return { page, box, field, end };
}
// edit: editTitle's record of the edit (its page and field, the save out, whether it's ended)
function endTitle(edit, keep) {
  if (edit.ended) return Promise.resolve(false);
  if (!keep) return Promise.resolve(closeEdit(edit));
  if (edit.saving) return edit.saving;
  const title = edit.field.value.trim();
  if (title === edit.was.trim()) return Promise.resolve(closeEdit(edit));
  edit.field.readOnly = true;
  edit.saving = titlePage(edit.book.dev, edit.page.id, title).then(
    saved => {
      named(edit.book, edit.page, saved.title);
      return !edit.ended && closeEdit(edit);
    },
    e => {
      // (let go meanwhile: said on its page, the bar left to the page it shows now)
      if (edit.ended) return (said(edit.book, edit.page, e.message), false);
      edit.error.firstChild.textContent = e.message;
      edit.error.hidden = false;
      edit.field.setAttribute('aria-invalid', 'true');
      edit.field.readOnly = false;
      edit.saving = null;
      edit.answered(false);
      return false;
    },
  );
  return edit.saving;
}
// The edit's last step: the field out, the listeners gone (ended first: Chromium blurs the field as
// it's taken out, which would end it again)
function closeEdit(edit) {
  const focused = [edit.box, edit.within].some(el => el.contains(document.activeElement));
  edit.ended = true;
  removeEventListener('pointerdown', edit.away, true);
  removeEventListener('keydown', edit.escape);
  edit.box.remove();
  if (focused) edit.name.focus({ preventScroll: true });
  edit.answered(true);
  return true;
}
// The field at the head of the pages' card, and its error, hidden: a tap on it lets the title go
function mountField(within, was) {
  const box = document.createElement('span'),
    field = document.createElement('input'),
    error = document.createElement('small');
  box.className = 'bk-title';
  field.type = 'text';
  field.value = was;
  field.maxLength = 80; // The title route's LABEL_MAX.
  field.placeholder = untitledPage();
  field.autocomplete = 'off';
  field.enterKeyHint = 'done';
  field.setAttribute('aria-label', word('Page title'));
  error.className = 'bk-title-error';
  error.setAttribute('role', 'status');
  error.append(
    document.createElement('span'),
    Object.assign(document.createElement('span'), { textContent: word('Tap here to keep the title as it was') }),
  );
  error.hidden = true;
  box.append(field, error);
  const fit = () => (box.dataset.value = field.value || untitledPage());
  fit();
  field.addEventListener('input', () => {
    fit();
    error.hidden = true;
    field.removeAttribute('aria-invalid');
  });
  within.prepend(box);
  return { box, field, error };
}
