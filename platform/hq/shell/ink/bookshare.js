// Where a page goes by its folded corner (bookdogear.js): three targets over the paper, PDF, PNG and a call, the page
// dimmed under them. They show as drop targets while the page is carried, or as a small menu (the corner pressed with a
// key, or tapped). PDF and PNG download the page's picture, for the board to keep or share from its downloads
//; the call, named for the agent, rings the CEO with the page's picture, or with
// a call on shows it in that one. Its look: bookshare.css. (dimmed, named)
import * as world from '../../world/world.js';
import { callAgent, ceoName } from '../desk.js';
import { callName } from '../call.js';
import { titleOf } from './bookhead.js';
import { pagePicture } from './bookpaperdraw.js';
import { saved } from './booksave.js';
import { POINTS_PER_PX, cutsOf, fileName, pdfOf, piecesFor } from './booksharefiles.js';

// how a JPEG in a PDF is pressed (0–1): the paper's dots and the ink's edges kept clean
const JPEG_QUALITY = 0.92;
// A long page's picture drawn in strips at most this tall (px) for a PDF: iOS refuses a canvas over 16.7 million px,
// and a picture can be 2400 wide.
const STRIP_PX = 4000;

// The three targets on el (the pages' box), hidden. act(kind, box) a target taken ('pdf' | 'png' | 'call', its box on
// the screen); closed() the menu put away with a key. Returns { carrying(), menu(), under(x, y), over(kind), hide(),
// shown() }.
export function mountTargets(el, { act, closed }) {
  const row = document.createElement('div');
  row.className = 'bk-share';
  row.setAttribute('role', 'menu');
  row.setAttribute('aria-label', 'Share this page');
  row.hidden = true;
  // (the page dimmed under the targets, so they read)
  const dim = Object.assign(document.createElement('div'), { className: 'bk-share-dim', hidden: true });
  row.innerHTML = TARGETS.map(
    ({ kind, icon }) =>
      `<button role="menuitem" data-share="${kind}" tabindex="-1">${icon}<span class="bk-share-word"></span></button>`,
  ).join('');
  el.append(dim, row);
  const items = [...row.children],
    targets = { row, dim, items, act, closed };
  row.addEventListener('click', e => {
    const item = e.target.closest('[data-share]');
    if (item && row.dataset.mode === 'menu') take(targets, item);
  });
  row.addEventListener('keydown', e => keyed(targets, e));
  row.addEventListener('focusout', e => !row.contains(e.relatedTarget) && row.dataset.mode === 'menu' && hide(targets));
  return {
    carrying: () => show(targets, 'carrying'),
    menu: () => {
      show(targets, 'menu');
      items[0].focus();
    },
    under: (x, y) => (row.hidden ? null : (document.elementFromPoint(x, y)?.closest('.bk-share [data-share]') ?? null)),
    over: item => items.forEach(i => i.toggleAttribute('data-over', i === item)),
    take: item => take(targets, item),
    hide: () => hide(targets),
    shown: () => !row.hidden,
  };
}
// The targets as they read, the call's name read each time they show: whom the call on is with, else the CEO
const TARGETS = [
  { kind: 'pdf', word: () => 'PDF', icon: icon('M7 3h7l4 4v14H7z M14 3v4h4 M9.5 12h6 M9.5 15h6 M9.5 18h4') },
  {
    kind: 'png',
    word: () => 'PNG',
    icon: icon('M4 5.5h16v13H4z M4.5 16l5-5 4 4 2.5-2.5 4 4 M15 8.6a1.3 1.3 0 1 0 .01 0'),
  },
  {
    kind: 'call',
    word: () => callName() ?? ceoName(),
    icon: icon(
      'M6.2 3.8 9 3.4l1.6 4.2-2 1.4c.9 2.3 2.7 4.2 5 5.2l1.4-2 4.2 1.5-.3 2.9c-.2 1-1 1.6-2 1.6C10.6 18 5.6 13 5 6.1c0-1 .3-2 1.2-2.3z',
    ),
  },
];
// A small line drawing, as if inked with the book's pen
function icon(d) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
}

function show({ row, dim, items }, mode) {
  items.forEach((item, i) => {
    item.querySelector('.bk-share-word').textContent = TARGETS[i].word();
    item.removeAttribute('data-over');
  });
  row.dataset.mode = mode;
  row.hidden = dim.hidden = false;
}
function hide({ row, dim, items }) {
  row.hidden = dim.hidden = true;
  items.forEach(i => i.removeAttribute('data-over'));
}
function take(targets, item) {
  const box = item.getBoundingClientRect();
  hide(targets);
  targets.act(item.dataset.share, box);
}
// The menu's keys: the arrows go round it, Escape puts it away, back on the corner
function keyed(targets, e) {
  const { row, items } = targets,
    at = items.indexOf(document.activeElement),
    step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  if (row.dataset.mode !== 'menu') return;
  if (step) items[(at + step + items.length) % items.length].focus();
  else if (e.key === 'Home' || e.key === 'End') items.at(e.key === 'Home' ? 0 : -1).focus();
  else if (e.key === 'Escape') {
    hide(targets);
    targets.closed();
  } else return;
  e.preventDefault();
  e.stopPropagation();
}

// ---- what each does

// A page's files, started now so they're ready as it's let go: { png, pdf } (promises of Files). book: bookpages.js's.
// The page is saved first, so its picture is the page as it shows now.
export function filesOf(book, page) {
  const named = ext => fileName(titleOf(page), page.day, ext),
    shot = pictureOf(book, page);
  const files = {
    png: shot.then(png => new File([png], named('png'), { type: 'image/png' })),
    pdf: shot.then(png => pdfFile(png, page, named('pdf'))),
  };
  // (a failure is said when the file is asked for: downloaded())
  for (const file of Object.values(files)) file.catch(() => {});
  return files;
}
// The page's picture as a PNG: the store's (bookpicture.ts), the same agents see; drawn here in dev mode, or for a page
// the store doesn't have (a blank one)
async function pictureOf(book, page) {
  // (a save that fails stops it: the store's picture would be the page as it was)
  await saved(book, page).catch(e => {
    throw new Error(`The page couldn’t be saved, so its picture would be out of date. ${e.message}`);
  });
  if (book.dev || !page.id) return blobOf(await pagePicture(page), 'image/png');
  const answer = await fetch(`/api/book/picture?id=${Number(page.id)}`);
  if (!answer.ok) throw new Error(`The page’s picture couldn’t be made (${answer.status}). Try again in a moment.`);
  return answer.blob();
}
// The picture as a one-page PDF, the page's own shape at its size in the book, its strips going down it
async function pdfFile(png, page, name) {
  const bitmap = await createImageBitmap(png),
    images = [];
  for (let top = 0; top < bitmap.height; top += STRIP_PX) {
    const canvas = cut(bitmap, top, Math.min(STRIP_PX, bitmap.height - top));
    const jpeg = new Uint8Array(await (await blobOf(canvas, 'image/jpeg', JPEG_QUALITY)).arrayBuffer());
    images.push({ jpeg, w: canvas.width, h: canvas.height });
  }
  const pageW = page.w * POINTS_PER_PX;
  const pdf = pdfOf({
    images,
    ...{ pageW, pageH: (pageW * bitmap.height) / bitmap.width, title: titleOf(page) || 'Notebook page' },
  });
  return new File([pdf], name, { type: 'application/pdf' });
}
// A strip of a picture as a canvas: its whole width, h px from top
function cut(bitmap, top, h) {
  const canvas = Object.assign(document.createElement('canvas'), { width: bitmap.width, height: h });
  canvas.getContext('2d').drawImage(bitmap, 0, -top);
  return canvas;
}
const blobOf = (canvas, type, quality) =>
  new Promise((done, failed) =>
    canvas.toBlob(
      blob => (blob ? done(blob) : failed(new Error('The page’s picture couldn’t be drawn.'))),
      type,
      quality,
    ),
  );

// A file downloaded, never the share sheet: the board keeps it, or shares it from its downloads.
export async function downloaded(file) {
  const ready = await file;
  const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(ready), download: ready.name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}

// The page on a call: its picture (picture, a promise of its PNG: filesOf's) shown in the call on, or a call with the CEO
// started with it (call.js), a long one's in readable pieces. A page the store doesn't have yet (a blank one, or its
// first save still going) can't go: that's said, and no call starts without it.
export async function callAbout(page, picture) {
  if (!page.id)
    throw new Error('The page isn’t saved yet, so it can’t go on a call: write on it, or try again in a moment.');
  return callAgent(world.company.ceo, ceoName(), { pictures: piecesOf(picture), page: page.id });
}
// A page's picture in pieces down it, as many as the picture's own shape asks for (it grows past the page's box to the
// answers under its groups: the coordinator's bookrender.ts), as the call's sketch tool cuts it (bookreads.ts): a
// promise of their list, so the call starts as it's let go, each a promise of a PNG. One piece is the picture as it is.
async function piecesOf(picture) {
  const png = await picture,
    whole = await createImageBitmap(png),
    n = piecesFor(whole.width, whole.height);
  if (n === 1) return [png];
  return cutsOf(n, whole.height).map(async ({ top, height }, i) => {
    const piece = await blobOf(cut(whole, top, height), 'image/png');
    return new File([piece], `${png.name.replace(/\.png$/, '')} (${i + 1} of ${n}).png`, { type: 'image/png' });
  });
}
