// Words from HQ and trusted work, shown as plain debug lines on the notebook page open when they arrive.
import { on } from './notebooklink.js';
import { viewOf } from './bookview.js';

export function mountMessages(book) {
  on('message', ({ kind, detail }) => {
    const view = viewOf(book);
    if (!view) return;
    let log = view.el.querySelector('.bk-messages');
    if (!log) {
      log = document.createElement('div');
      log.className = 'bk-messages';
      log.setAttribute('role', 'log');
      log.setAttribute('data-no-ink', '');
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'bk-messages-close';
      close.setAttribute('aria-label', 'Close');
      close.textContent = '×';
      close.addEventListener('click', () => log.remove());
      log.append(close);
      view.el.append(log);
    }
    const line = document.createElement('div');
    line.textContent = `${kind}: ${wordsOf(detail)}`;
    log.append(line);
    log.scrollTop = log.scrollHeight;
  });
}

function wordsOf(detail) {
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail, (_, value) => (typeof value === 'bigint' ? String(value) : value)) ?? String(detail);
  } catch (error) {
    return `(not shown: ${error.message})`;
  }
}
