// The page's title field, opened by its name in the bottom bar.
import { titlePage } from './notebookdata.js';
import { word } from './bookscope.js';
import { named } from './booksave.js';

export function mountTitle(card, book, done) {
  const page = book.views[book.cur].page,
    form = document.createElement('form'),
    label = document.createElement('label'),
    field = document.createElement('input'),
    save = document.createElement('button'),
    error = document.createElement('p');
  form.className = 'bk-page-title';
  label.textContent = word('Page title');
  field.type = 'text';
  field.value = page.label;
  field.maxLength = 80; // The title route's LABEL_MAX.
  field.placeholder = word('Untitled page');
  label.append(field);
  save.type = 'submit';
  save.textContent = word('Save title');
  error.setAttribute('role', 'status');
  error.hidden = true;
  form.append(label, save, error);
  card.prepend(form);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    save.disabled = true;
    try {
      const saved = await titlePage(book.dev, page.id, field.value);
      named(book, page, saved.title);
      done();
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
      save.disabled = false;
    }
  });
  return field;
}
