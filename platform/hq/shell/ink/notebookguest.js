// The board's read-only live view of an invited notebook.
import { esc } from '../../util.js';
import { renderGroups } from './notebookcards.js';
import { words, refusal } from './notebookwords.js';

const POLL_MS = 1000;

// api: the board's routes for guests' books (GET api: their notebooks, GET api/groups?page=: a page's groups)
export function mountNotebook(host, { api, notebook = null }) {
  const text = words[document.documentElement.lang];
  host.classList.add('ng-book');
  host.innerHTML = `<header class="ng-head"><div><p class="ng-eyebrow">${text.notebook} · ${text.watching}</p>
    <h1></h1></div></header>
    <nav class="ng-notebooks" aria-label="${text.notebooks}"></nav><nav class="ng-pages" aria-label="${text.pages}"></nav>
    <p class="ng-state" role="status"></p><section class="ng-groups" aria-label="${text.pageNotes}"></section>
    <p class="ng-error" role="alert"></p>`;
  const s = {
    host,
    text,
    api,
    notebook,
    page: null,
    books: [],
    groups: [],
    signature: '',
    wanted: { notebook, page: null },
    intent: 0,
    again: false,
    reading: false,
    stopped: false,
  };
  host.addEventListener('click', e => clicked(s, e));
  refresh(s);
  const timer = setInterval(() => refresh(s), POLL_MS);
  return () => {
    s.stopped = true;
    clearInterval(timer);
  };
}

async function request(s, path) {
  // A dropped connection or a proxy's page during a deploy fails in the reader's words, not the browser's
  const response = await fetch(s.api + path).catch(() => {
    throw new Error(s.text.failed);
  });
  const answer = await response.json().catch(() => {
    throw new Error(s.text.failed);
  });
  if (!response.ok) throw new Error(refusal(document.documentElement.lang, answer.reason, s.limits) ?? answer.error);
  return answer;
}

async function refresh(s) {
  if (s.stopped) return;
  if (s.reading) {
    s.again = true;
    return;
  }
  s.reading = true;
  const intent = s.intent,
    wanted = { ...s.wanted };
  try {
    const read = await request(s, '');
    if (s.stopped) return;
    const book = read.notebooks.find(n => n.id === wanted.notebook) ?? read.notebooks[0];
    if (!book) return empty(s);
    const page = book.pages.find(p => p.id === wanted.page) ?? book.pages.at(-1);
    const contents = page ? await request(s, `/groups?page=${page.id}`) : { groups: [] };
    if (s.stopped) return;
    if (intent !== s.intent) {
      s.again = true;
      return;
    }
    if (s.notebook !== book.id || s.page !== page?.id) turnPage(s);
    Object.assign(s, {
      books: read.notebooks,
      limits: read.limits,
      notebook: book.id,
      page: page?.id ?? null,
      groups: contents.groups,
    });
    s.wanted = { notebook: book.id, page: page?.id ?? null };
    navigation(s, book, page);
    updateGroups(s, contents);
  } catch (error) {
    s.host.querySelector('.ng-error').textContent = error.message;
  } finally {
    s.reading = false;
    if (s.again) {
      s.again = false;
      queueMicrotask(() => refresh(s));
    }
  }
}

function updateGroups(s, contents) {
  const signature = JSON.stringify(contents);
  if (signature === s.signature) return;
  s.signature = signature;
  renderGroups(s);
}

function turnPage(s) {
  s.host.querySelector('.ng-groups').replaceChildren();
  s.signature = '';
}

function empty(s) {
  s.host.querySelector('h1').textContent = s.text.noNotebooks;
  s.host.querySelector('.ng-state').textContent = s.text.invitationEnded;
  s.host.querySelector('.ng-groups').replaceChildren();
  s.page = null;
  s.groups = [];
  s.signature = '';
}

function navigation(s, book, page) {
  const { host } = s;
  host.querySelector('h1').textContent = book.name;
  host.querySelector('.ng-notebooks').innerHTML =
    s.books.length > 1
      ? s.books
          .map(
            n =>
              `<button type="button" data-notebook="${n.id}" aria-pressed="${n.id === book.id}">${esc(n.name)}</button>`,
          )
          .join('')
      : '';
  host.querySelector('.ng-pages').innerHTML = book.pages
    .map(
      (p, i) =>
        `<button type="button" data-page="${p.id}" aria-pressed="${p.id === page?.id}">${esc(p.title || s.text.page(i + 1))}${p.sent || p.sending ? ` · ${s.text.sent}` : ''}</button>`,
    )
    .join('');
  host.querySelector('.ng-state').textContent = book.kind === 'round' ? s.text.round[book.state] : s.text.pagesShow;
}

function clicked(s, event) {
  const target = event.target.closest('button');
  if (target?.dataset.notebook) s.wanted = { notebook: Number(target.dataset.notebook), page: null };
  else if (target?.dataset.page) s.wanted = { notebook: s.notebook, page: Number(target.dataset.page) };
  else return;
  s.intent++;
  refresh(s);
}
