// The overview's open list, in its head: the forms the agents asked the board to fill in and the questions they asked
// it, not yet answered, each a tap from its page.
import { esc, stylesheet } from '../../util.js';
import * as world from '../../world/world.js';
import { inkOf } from './agentink.js';
import { loadOpen } from './bookanswersdata.js';

stylesheet('shell/ink/bookshelfopen.css');

// head: the overview's head; open(page, notebook): that page shown (bookzoom.js's)
export function mountOpen(head, { open }) {
  const list = document.createElement('section');
  list.className = 'bk-open';
  list.hidden = true;
  list.setAttribute('aria-label', 'Open forms and questions');
  head.append(list);
  let items = [];
  const refresh = async () => {
    let read;
    try {
      read = await loadOpen(world.dev);
    } catch (e) {
      return console.error('[hq] The open forms and questions can’t be read:', e);
    }
    items = [
      ...(read?.forms ?? []).map(f => ({ ...f, kind: 'form' })),
      ...(read?.questions ?? []).map(q => ({ ...q, kind: 'question' })),
    ].sort((a, b) => a.created.localeCompare(b.created));
    list.hidden = !items.length;
    list.innerHTML = `<h4 class="bk-open-head">Waiting for you</h4><ul>${items.map(itemHtml).join('')}</ul>`;
  };
  list.addEventListener('click', e => {
    const tapped = e.target.closest('.bk-open-item'),
      item = tapped && items.find(i => String(i.id) === tapped.dataset.answer);
    if (item) open({ id: item.page }, item.notebook);
  });
  document.addEventListener('book:changed', refresh);
  refresh();
}

const itemHtml = i =>
  `<li><button type="button" class="bk-open-item" data-answer="${i.id}" data-kind="${i.kind}" style="--ink:${inkOf(
    i.by,
  )}"><b>${esc(i.name)}</b> <span class="bk-open-kind">${i.kind === 'form' ? 'asks you to fill in' : 'asks'}</span> <span class="bk-open-text">${esc(
    i.text ?? '',
  )}</span></button></li>`;
