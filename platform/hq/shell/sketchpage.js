// One sketch, full screen: the paper on the desk, the tray of pens under it, and a bar with its label, undo and redo,
// archive and delete, and Send to the CEO, which hands it to them on the intercom. Every change saves itself a moment
// later; closing waits for the last save, and stays open if it can't be made.
// Pictures go on the page too (scraps): pasted (Cmd/Ctrl+V, or a press held on the paper, then Paste), dropped, or
// brought from review mode, which wait on the sketch until it opens.
// Whose sketches they are, and what's around the page, is the book's (sketchshelf.js): its routes, whom Send goes to,
// what follows a send, its toasts.
import { esc, stylesheet } from '../util.js';
import { sfx } from './audio.js';
import { sheetPen, pictureOf } from './sketchpen.js';
import { offerPaste, placeWaiting, wirePictures } from './sketchpaste.js';
import { tray } from './sketchtools.js';

const SAVE_AFTER_MS = 1200,
  RETRY_MS = 5000,
  // the bar's and the tray's room around the page, and the page's margin on the desk
  BAR_PX = 60,
  TRAY_PX = 132,
  MARGIN_PX = 16;

// A new sketch, its page as big as this screen has room for, opened at once
export async function newSketch(book, closed) {
  const w = Math.round(Math.min(4000, Math.max(100, innerWidth - 2 * MARGIN_PX))),
    h = Math.round(Math.min(4000, Math.max(100, innerHeight - BAR_PX - TRAY_PX - 2 * MARGIN_PX)));
  const made = await book.act('create', { w, h });
  sfx.flip();
  return openSketch(book, made.id, closed);
}

// closed(): once the page has gone (archived, deleted or put back), to show the Sketchbook as it is now
export async function openSketch(book, id, closed) {
  const [sketch] = await Promise.all([
    book.load(id),
    stylesheet('shell/sketchpage.css'),
    stylesheet('shell/sketchtray.css'),
  ]);
  const box = document.createElement('dialog');
  box.className = 'sk-page';
  box.setAttribute('aria-label', sketch.label || 'Untitled sketch');
  box.innerHTML = pageHtml(sketch, book.to);
  document.body.append(box);
  const page = { book, sketch, box, closed, find: s => box.querySelector(s), adding: new Set() };
  page.say = (words, warn) => say(page, words, warn);
  const inHand = tray(page.find('.sk-tray'), held => box.classList.toggle('erasing', held.kind === 'eraser'));
  page.save = saver(page);
  page.ink = sheetPen(page.find('.sk-sheet'), sketch, {
    tool: () => inHand(),
    changed: () => {
      page.save.soon();
      steps(page);
    },
    paste: at => offerPaste(page, at),
  });
  place(page);
  const fits = new ResizeObserver(() => place(page));
  fits.observe(page.find('.sk-desk'));
  const pictures = wirePictures(page);
  page.stop = () => {
    fits.disconnect();
    pictures.stop();
  };
  wireBar(page);
  box.showModal();
  steps(page);
  sfx.open();
  placeWaiting(page);
  return page;
}

// (the wet canvas: data-watchalong-hide, a walk-through's recording takes its stroke as ink, strokes.js).
function pageHtml(s, to) {
  const ceo = esc(to);
  return `<header class="sk-bar">
      <button class="sk-back" data-back aria-label="Back to the Sketchbook">‹<span> Sketchbook</span></button>
      <input class="sk-label" value="${esc(s.label)}" placeholder="Untitled" maxlength="80" aria-label="Label" enterkeyhint="done" autocomplete="off">
      <span class="sk-state" aria-live="polite"></span>
      <button class="sk-step" data-undo aria-label="Undo" title="Undo">↶</button>
      <button class="sk-step" data-redo aria-label="Redo" title="Redo">↷</button>
      <span class="sk-more"><button data-more aria-expanded="false" aria-label="More" title="More">⋯</button>
        <span class="sk-menu" hidden><button data-archive>${s.archived ? 'Move out of the archive' : 'Archive'}</button><button data-delete>Delete…</button></span></span>
      <button class="sk-send" data-send title="Send it to ${ceo} on the intercom">${PLANE}<span>Send to ${ceo}</span></button>
    </header>
    <div class="sk-desk"><div class="sk-sheet"><canvas class="dry"></canvas><canvas class="wet" data-watchalong-hide></canvas></div></div>
    <footer class="sk-tray" role="toolbar" aria-label="Pens"></footer>`;
}
const PLANE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 11.2 21 3.5l-4.6 17-5.2-4.4-3 3.1.3-5.1L17.8 6.6 7 12.9z"/></svg>`;

// The page as big as the desk lets it be, the sketch's shape kept
function place(page) {
  const desk = page.find('.sk-desk'),
    sheet = page.find('.sk-sheet'),
    { w, h } = page.sketch;
  const k = Math.min((desk.clientWidth - 2 * MARGIN_PX) / w, (desk.clientHeight - 2 * MARGIN_PX) / h);
  if (!(k > 0)) return;
  Object.assign(sheet.style, { width: `${w * k}px`, height: `${h * k}px` });
  page.ink.layout(k);
}

function steps(page) {
  page.find('[data-undo]').disabled = !page.ink.canUndo;
  page.find('[data-redo]').disabled = !page.ink.canRedo;
}
const say = (page, words, warn = false) => {
  const state = page.find('.sk-state');
  state.textContent = words;
  state.classList.toggle('warn', warn);
};

// Saving: a moment after the last change, the whole sketch and its picture. One that fails says so and tries again.
function saver(page) {
  let timer = null,
    dirty = false,
    running = Promise.resolve();
  const now = () => {
    clearTimeout(timer);
    timer = null;
    if (!dirty) return running;
    dirty = false;
    const save = saving(page);
    say(page, 'Saving…');
    running = running.then(save).then(
      s => {
        Object.assign(page.sketch, s);
        if (!dirty) say(page, 'Saved');
      },
      e => {
        dirty = true;
        // (a page past what a sketch holds: trying again can't help, the next change tries.)
        if (e.status === 413) return full(page, e.message);
        say(page, `Not saved yet: ${e.message}`, true);
        timer ??= setTimeout(now, RETRY_MS);
      },
    );
    return running;
  };
  return {
    soon() {
      dirty = true;
      page.find('.sk-full')?.remove();
      say(page, '');
      clearTimeout(timer);
      timer = setTimeout(now, SAVE_AFTER_MS);
    },
    now,
    // (a deleted sketch: nothing left to save)
    drop() {
      clearTimeout(timer);
      dirty = false;
    },
    get pending() {
      return dirty;
    },
  };
}

// A save refused for its size: a note over the page says so and what to do, with a New sketch that leaves this one as
// it was last saved; the next change takes it away and tries again (undo, say).
function full(page, words) {
  page.find('.sk-full')?.remove();
  const note = Object.assign(document.createElement('p'), { className: 'sk-full', role: 'alert' });
  note.append(words, ' ');
  const fresh = Object.assign(document.createElement('button'), { textContent: 'New sketch' });
  fresh.onclick = () => {
    page.save.drop();
    shut(page, '');
    newSketch(page.book, page.closed).catch(e => page.book.toast(esc(e.message)));
  };
  note.append(fresh);
  page.find('.sk-desk').append(note);
  say(page, 'Not saved', true);
  sfx.tick();
}

// The sketch as it is now, saved once its pictures are loaded to be drawn: its lines, its pictures (one still on its way
// up isn't the sketch's yet) and the page rendered
function saving(page) {
  const ink = page.ink.lines.slice(),
    scraps = page.ink.scraps.filter(s => s.file).map(s => ({ ...s }));
  return () =>
    page.ink.ready().then(() =>
      page.book.act('save', {
        id: page.sketch.id,
        ink,
        scraps: scraps.map(({ file, x, y, w, h, tilt }) => ({ file, x, y, w, h, tilt })),
        picture: ink.length || scraps.length ? pictureOf({ ...page.sketch, ink, scraps }) : null,
      }),
    );
}

function wireBar(page) {
  const { box, find } = page;
  find('[data-back]').onclick = () => close(page);
  find('[data-undo]').onclick = () => page.ink.undo();
  find('[data-redo]').onclick = () => page.ink.redo();
  find('[data-send]').onclick = () => send(page);
  find('[data-archive]').onclick = () => archive(page);
  find('[data-delete]').onclick = e => remove(page, e.currentTarget);
  find('[data-more]').onclick = e => menu(page, e.currentTarget.getAttribute('aria-expanded') !== 'true');
  const label = find('.sk-label');
  label.addEventListener('change', () => relabel(page, label));
  label.addEventListener('keydown', e => e.key === 'Enter' && label.blur());
  box.addEventListener('cancel', e => {
    e.preventDefault();
    close(page);
  });
  box.addEventListener('keydown', e => {
    if (e.key === 'Escape') e.stopPropagation();
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z' || e.target === label) return;
    e.preventDefault();
    if (e.shiftKey) page.ink.redo();
    else page.ink.undo();
  });
  box.addEventListener('pointerdown', e => !e.target.closest('.sk-more') && menu(page, false));
}
function menu(page, open) {
  page.find('[data-more]').setAttribute('aria-expanded', String(open));
  page.find('.sk-menu').hidden = !open;
  if (open) return;
  const del = page.find('[data-delete]');
  del.classList.remove('sure');
  del.textContent = 'Delete…';
}

async function relabel(page, input) {
  try {
    Object.assign(page.sketch, await page.book.act('label', { id: page.sketch.id, label: input.value }));
    input.value = page.sketch.label;
    page.box.setAttribute('aria-label', page.sketch.label || 'Untitled sketch');
    say(page, 'Saved');
  } catch (e) {
    say(page, e.message, true);
  }
}

// Shut once the last change is saved: one that can't be saved keeps the page open, saying why
async function close(page, after = '') {
  if (page.shutting) return;
  page.shutting = true;
  await Promise.all(page.adding); // (a picture on its way up)
  await page.save.now();
  page.shutting = false;
  if (page.save.pending) return;
  shut(page, after);
}
function shut(page, after) {
  page.stop();
  page.box.close();
  page.box.remove();
  sfx.close();
  if (after) page.book.toast(after);
  page.closed();
}

async function archive(page) {
  const archived = !page.sketch.archived;
  await page.save.now();
  if (page.save.pending) return;
  try {
    await page.book.act('archive', { id: page.sketch.id, archived });
    shut(page, archived ? 'Archived: it’s in the Sketchbook’s archive.' : 'Back among your sketches.');
  } catch (e) {
    say(page, e.message, true);
  }
}
// The first press asks, the second deletes it for good
async function remove(page, button) {
  if (!button.classList.contains('sure')) {
    button.classList.add('sure');
    button.textContent = 'Delete it for good';
    sfx.tick();
    return;
  }
  try {
    // (the last strokes saved first, so a delete that fails loses nothing; once it's gone, nothing left to save)
    await page.save.now();
    await page.book.act('delete', { id: page.sketch.id });
    page.save.drop();
    sfx.boom();
    shut(page, 'Deleted.');
  } catch (e) {
    say(page, e.message, true);
  }
}

// To the CEO: saved first, then sent; the page folds away into a paper plane and flies off to the intercom
async function send(page) {
  const button = page.find('[data-send]');
  button.disabled = true;
  await page.save.now();
  try {
    if (page.save.pending) throw new Error('it isn’t saved yet');
    await page.book.act('send', { id: page.sketch.id });
    fly(page);
    page.book.toast(`Sent to ${esc(page.book.to)}${page.book.sent ? ' on the intercom' : ''}.`, () => {
      shut(page, '');
      page.book.sent?.();
    });
    say(page, `Sent to ${page.book.to}`);
  } catch (e) {
    say(page, e.message, true);
  } finally {
    button.disabled = false;
  }
}
function fly(page) {
  const sheet = page.find('.sk-sheet'),
    from = sheet.getBoundingClientRect(),
    to = page.find('[data-send]').getBoundingClientRect();
  const copy = Object.assign(document.createElement('img'), {
    src: pictureOf({ ...page.sketch, ink: page.ink.lines, scraps: page.ink.scraps }),
    alt: '',
  });
  copy.className = 'sk-flying';
  Object.assign(copy.style, {
    left: `${from.left}px`,
    top: `${from.top}px`,
    width: `${from.width}px`,
    height: `${from.height}px`,
  });
  page.box.append(copy);
  const dx = to.left + to.width / 2 - (from.left + from.width / 2),
    dy = to.top + to.height / 2 - (from.top + from.height / 2);
  sfx.whoosh();
  copy
    .animate(
      [
        { transform: 'none', opacity: 1 },
        { transform: 'scale(0.55) rotate(-4deg)', opacity: 1, offset: 0.35 },
        { transform: `translate(${dx}px, ${dy}px) scale(0.04) rotate(-28deg)`, opacity: 0.2 },
      ],
      { duration: 720, easing: 'cubic-bezier(.5,0,.2,1)' },
    )
    .finished.then(() => copy.remove());
}
