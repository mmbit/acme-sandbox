// The board's read-only live view of an invited notebook.
import { esc } from '../../util.js';
import { renderGroups } from './notebookcards.js';
import { mountPen } from './notebookpen.js';
import { words, refusal } from './notebookwords.js';

const POLL_MS = 1000;

export function mountNotebook(host, { api, watch = true, notebook = null }) {
  const text = words[document.documentElement.lang];
  host.classList.add('ng-book');
  host.innerHTML = `<header class="ng-head"><div><p class="ng-eyebrow">${text.notebook}${watch ? ` · ${text.watching}` : ''}</p>
    <h1></h1></div><button type="button" data-new-page hidden>${text.newPage}</button></header>
    <nav class="ng-notebooks" aria-label="${text.notebooks}"></nav><nav class="ng-pages" aria-label="${text.pages}"></nav>
    <p class="ng-state" role="status"></p><section class="ng-groups" aria-label="${text.pageNotes}"></section>
    <form class="ng-compose"><label for="ng-words">${text.addNote}</label><textarea id="ng-words" name="words" rows="3" placeholder="${text.writeToAgents}"></textarea>
    <div class="ng-actions"><button>${text.addNote}</button><button type="button" data-draw>${text.drawNote}</button></div></form>
    <section class="ng-drawing" hidden><p>${text.drawingHelp}</p><canvas aria-label="${text.drawingPage}"></canvas></section>
    <form class="ng-invite" hidden><h2>${text.inviteColleague}</h2><p></p><label>${text.name}<input name="name" required></label><label>${text.email}<input name="email" type="email" required></label><button>${text.makeLink}</button><a hidden target="_blank" rel="noopener">${text.openLink}</a></form>
    <footer class="ng-foot"><button type="button" data-send>${text.sendPage}</button><button type="button" data-undo hidden>${text.unsend}</button><span class="ng-error" role="alert"></span></footer>`;
  const s = {
    host,
    text,
    api,
    watch,
    notebook,
    page: null,
    books: [],
    groups: [],
    signature: '',
    drawings: new Map(),
    drafts: new Map(),
    wanted: { notebook, page: null },
    intent: 0,
    again: false,
    reading: false,
    stopped: false,
  };
  host.addEventListener('click', e => clicked(s, e));
  host.addEventListener('submit', e => submitted(s, e));
  s.pen = mountPen(
    host.querySelector('.ng-drawing canvas'),
    (ink, page) => saveDrawing(s, ink, page),
    () => s.page,
  );
  refresh(s);
  const timer = setInterval(() => refresh(s), POLL_MS);
  return () => {
    s.stopped = true;
    clearInterval(timer);
    s.pen.destroy();
  };
}

function saveDrawing(s, ink, page) {
  let drawing = s.drawings.get(page);
  if (!drawing) {
    drawing = { group: null, ink: [], saving: Promise.resolve() };
    s.drawings.set(page, drawing);
  }
  drawing.ink.push(...ink);
  const snapshot = [...drawing.ink];
  drawing.saving = drawing.saving.then(async () => {
    drawing.group = drawing.group
      ? await request(s, '/edit', { id: drawing.group.id, since: drawing.group.updated, ink: snapshot })
      : await request(s, '/create', { page, ink: snapshot });
    await refresh(s);
  });
  return drawing.saving;
}

async function request(s, path, body) {
  // A dropped connection or a proxy's page during a deploy fails in the guest's words, not the browser's
  const response = await fetch(s.api + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).catch(() => {
    throw new Error(s.text.failed);
  });
  const answer = await response.json().catch(() => {
    throw new Error(s.text.failed);
  });
  if (!response.ok) {
    const message = refusal(document.documentElement.lang, answer.reason, s.limits) ?? answer.error;
    throw Object.assign(new Error(message), { status: response.status });
  }
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
    const read = await request(s, s.watch ? '' : '/list');
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
    if (s.notebook !== book.id || s.page !== page?.id) turnPage(s, page?.id);
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
    if (!s.watch && [401, 403].includes(error.status)) {
      empty(s);
      s.host.querySelector('.ng-state').textContent = error.message;
    }
    showError(s, error);
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
  if (s.host.querySelector('.ng-groups textarea:focus, [data-editing], .ng-drawing:not([hidden])')) return;
  s.signature = signature;
  renderGroups(s);
}

function turnPage(s, page) {
  const compose = s.host.querySelector('.ng-compose');
  s.drafts.set(s.page, compose.elements.words.value);
  compose.elements.words.value = s.drafts.get(page) ?? '';
  s.host.querySelector('.ng-groups').replaceChildren();
  s.host.querySelector('.ng-drawing').hidden = true;
  s.signature = '';
}

function empty(s) {
  s.host.querySelector('h1').textContent = s.text.noNotebooks;
  s.host.querySelector('.ng-state').textContent = s.text.invitationEnded;
  s.host.querySelector('.ng-compose').hidden = true;
  s.host.querySelector('.ng-foot').hidden = true;
  s.host.querySelector('.ng-drawing').hidden = true;
  s.host.querySelector('.ng-groups').replaceChildren();
  s.host.querySelector('.ng-invite').hidden = true;
  s.host.querySelector('[data-new-page]').hidden = true;
  s.drawings.clear();
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
  host.querySelector('.ng-state').textContent = book.kind === 'round' ? s.text.round[book.state] : s.text.pagesStay;
  const invite = host.querySelector('.ng-invite');
  invite.hidden = s.watch || !book.invites;
  if (book.invites) {
    invite.querySelector('p').textContent = s.text.invitations(book.invites.domain, book.invites.left);
    invite.querySelector('button').disabled = book.invites.left === 0;
  }
  const writable = !s.watch && page && !page.readonly;
  host.querySelector('.ng-compose').hidden = !writable;
  if (!writable) host.querySelector('.ng-drawing').hidden = true;
  host.querySelector('[data-new-page]').hidden = s.watch || book.kind !== 'invited';
  host.querySelector('[data-send]').hidden = s.watch || !page?.canSend;
  const undo = host.querySelector('[data-undo]');
  undo.hidden = s.watch || !page?.canUndo;
  undo.textContent = book.kind === 'round' && book.state === 'open' ? s.text.unsend : s.text.undoSend;
}

async function clicked(s, event) {
  const target = event.target.closest('button');
  if (!target) return;
  if (target.dataset.edit) return editNote(s, Number(target.dataset.edit));
  if (target.dataset.delete || target.dataset.restore) return deleteNote(s, target);
  if (target.dataset.notebook) {
    s.wanted = { notebook: Number(target.dataset.notebook), page: null };
    s.intent++;
    return refresh(s);
  }
  if (target.dataset.page) {
    s.wanted = { notebook: s.notebook, page: Number(target.dataset.page) };
    s.intent++;
    return refresh(s);
  }
  if (target.hasAttribute('data-draw')) {
    const drawing = s.host.querySelector('.ng-drawing');
    if (drawing.hidden) {
      s.drawings.delete(s.page);
      s.pen.clear();
    }
    drawing.hidden = !drawing.hidden;
    s.pen.resize();
    return refresh(s);
  }
  const action = target.hasAttribute('data-send')
    ? '/send'
    : target.hasAttribute('data-undo')
      ? '/undo'
      : target.hasAttribute('data-new-page')
        ? '/pages/create'
        : null;
  if (!action) return;
  target.disabled = true;
  try {
    if (action === '/send') await s.drawings.get(s.page)?.saving;
    const answer = await request(s, action, action === '/pages/create' ? { notebook: s.notebook } : { id: s.page });
    if (action === '/pages/create') {
      s.wanted.page = answer.id;
      s.intent++;
    }
    await refresh(s);
  } catch (error) {
    showError(s, error);
  } finally {
    target.disabled = false;
  }
}

async function submitted(s, event) {
  const form = event.target;
  event.preventDefault();
  if (form.classList.contains('ng-invite')) return inviteColleague(s, form);
  const words = form.elements.words?.value.trim();
  if (!words) return;
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    if (form.dataset.editing) {
      const group = s.groups.find(g => g.id === Number(form.dataset.editing));
      await request(s, '/edit', {
        id: group.id,
        since: form.dataset.since,
        ...(group.kind === 'scrap'
          ? { words, said: 'typed' }
          : { texts: [{ x: group.box?.x ?? 40, y: group.box?.y ?? 40, w: 500, text: words, color: '#292722' }] }),
      });
      form.remove();
    } else if (form.dataset.answer)
      await request(s, '/reply', { answer: Number(form.dataset.answer), words, said: 'typed' });
    else {
      const y = Math.max(40, ...s.groups.map(g => (g.box?.y ?? 0) + (g.box?.h ?? 0) + 32));
      await request(s, '/create', { page: s.page, texts: [{ x: 40, y, w: 500, text: words, color: '#292722' }] });
    }
    form.reset();
    s.host.querySelector('.ng-error').textContent = '';
    await refresh(s);
  } catch (error) {
    showError(s, error);
  } finally {
    button.disabled = false;
  }
}

async function inviteColleague(s, form) {
  try {
    const answer = await request(s, '/invite', {
      notebook: s.notebook,
      name: form.elements.name.value,
      email: form.elements.email.value,
    });
    const link = form.querySelector('a');
    link.href = answer.person.link;
    link.hidden = false;
    form.elements.name.value = '';
    form.elements.email.value = '';
    await refresh(s);
  } catch (error) {
    showError(s, error);
  }
}

function editNote(s, id) {
  const article = s.host.querySelector(`[data-group="${id}"]`);
  if (article.querySelector('[data-editing]')) return;
  const group = s.groups.find(g => g.id === id);
  const form = document.createElement('form');
  form.dataset.editing = id;
  form.dataset.since = group.updated;
  form.innerHTML = `<label>${s.text.editNote}<textarea name="words" rows="3" required></textarea></label><button>${s.text.saveEdit}</button>`;
  form.elements.words.value = group.texts.map(t => t.text).join('\n') || group.words;
  article.append(form);
  form.elements.words.focus();
}

async function deleteNote(s, button) {
  try {
    if (button.dataset.restore) {
      await request(s, '/restore', { id: Number(button.dataset.restore) });
      button.remove();
    } else {
      const id = Number(button.dataset.delete);
      await request(s, '/delete', { id });
      const undo = document.createElement('button');
      undo.type = 'button';
      undo.dataset.restore = id;
      undo.textContent = s.text.undoDelete;
      s.host.querySelector('.ng-foot').append(undo);
    }
    await refresh(s);
  } catch (error) {
    showError(s, error);
  }
}

function showError(s, error) {
  s.host.querySelector('.ng-error').textContent = error.message;
}
