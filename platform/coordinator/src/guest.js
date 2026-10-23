// The guest page's script (guests.ts serves it): a tick, an answer or a question posts in place, and the item it changed
// eases into its new state instead of the page reloading. Without it every form still posts and the page comes back whole.
const bar = () => {
  const p = document.getElementById('progress'), i = document.querySelector('#bar i');
  if (p && i) i.style.width = `${p.dataset.pct}%`;
};

document.addEventListener('submit', async e => {
  const form = e.target;
  if (!(form instanceof HTMLFormElement) || !form.hasAttribute('data-live')) return;
  e.preventDefault();
  const item = form.closest('.item'), open = item?.querySelector('details')?.open;
  form.querySelectorAll('button').forEach(b => b.disabled = true);
  try {
    // the page's own answer to the post (it redirects back to the page), read for the parts that changed
    const res = await fetch(form.action, { method: 'POST', body: new URLSearchParams(new FormData(form, e.submitter)) });
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html'), fresh = item && doc.getElementById(item.id);
    if (!res.ok || !fresh) throw new Error(`HTTP ${res.status}`);
    const was = item.classList.contains('done');
    if (open) fresh.querySelector('details')?.setAttribute('open', '');
    if (!was && fresh.classList.contains('done')) fresh.classList.add('just');   // the check animates only when it's just ticked
    item.replaceWith(fresh);
    // the bar keeps its element, so it moves from where it is to where it's now
    const now = doc.getElementById('progress'), here = document.getElementById('progress');
    if (now && here) { here.querySelector('b').textContent = now.querySelector('b').textContent; here.dataset.pct = now.dataset.pct; bar(); }
    if (open) fresh.querySelector('details textarea')?.focus();
  } catch {
    // anything unexpected: post it the plain way, with the button that was pressed
    if (e.submitter?.name) form.append(Object.assign(document.createElement('input'), { type: 'hidden', name: e.submitter.name, value: e.submitter.value }));
    form.submit();
  }
});
// A reply's picture opens big over the page. A tap or Escape closes it. Without the script, its link opens the picture.
document.addEventListener('click', e => {
  const a = e.target instanceof Element && e.target.closest('a.pic');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
  e.preventDefault();
  const alt = a.querySelector('img')?.alt ?? '';
  const zoom = Object.assign(document.createElement('div'), { className: 'zoom', tabIndex: -1 });
  zoom.setAttribute('role', 'dialog');
  zoom.setAttribute('aria-modal', 'true');
  zoom.setAttribute('aria-label', alt);
  zoom.append(Object.assign(new Image(), { src: a.href, alt }));
  const key = k => {
    if (k.key === 'Escape') close();
  };
  const close = () => {
    zoom.remove();
    document.removeEventListener('keydown', key);
    a.focus();
  };
  zoom.onclick = close;
  document.addEventListener('keydown', key);
  document.body.append(zoom);
  zoom.focus();
});
// A door's code copies with a tap: its button shows only with the script, and says it's copied for a moment
//. Where the clipboard API is missing or refused, a hidden textarea's selection does the copy.
document.querySelectorAll('button[data-copy]').forEach(b => b.hidden = false);
document.addEventListener('click', async e => {
  const b = e.target instanceof Element && e.target.closest('button[data-copy]');
  if (!b) return;
  let copied;
  try {
    await navigator.clipboard.writeText(b.dataset.copy);
    copied = true;
  } catch {
    const t = Object.assign(document.createElement('textarea'), { value: b.dataset.copy, readOnly: true });
    t.style.cssText = 'position:fixed;opacity:0';
    document.body.append(t);
    t.select();
    t.setSelectionRange(0, t.value.length);
    copied = document.execCommand('copy');
    t.remove();
  }
  if (!copied) return;
  b.dataset.label ??= b.textContent;
  b.textContent = b.dataset.copied;
  clearTimeout(b.timer);
  b.timer = setTimeout(() => (b.textContent = b.dataset.label), 1600);
});
