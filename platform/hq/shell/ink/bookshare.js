// Where a page goes by its folded corner (bookdogear.js): three targets in the rail's place over the page bar, Submit to
// the CEO (bookpagesend.js), PDF and PNG. They show as drop targets while the page is carried, or as a small menu (the
// corner pressed with a key, or tapped). PDF and PNG download the page's picture, for the board to keep or share from
// its downloads. A page that can't be sent (sent already, or a call's notes page) has only PDF and PNG. Its look:
// bookshare.css. (Submit in the rail's place, the call's target gone)
import * as world from '../../world/world.js';
import { esc } from '../../util.js';
import { callAgent, ceoName } from '../desk.js';
import { titleOf } from './bookhead.js';
import { pagePicture } from './bookpaperdraw.js';
import { saved } from './booksave.js';
import { POINTS_PER_PX, cutsOf, fileName, pdfOf, piecesFor } from './booksharefiles.js';

// how a JPEG in a PDF is pressed (0–1): the paper's dots and the ink's edges kept clean
const JPEG_QUALITY = 0.92;
// A long page's picture drawn in strips at most this tall (px) for a PDF: iOS refuses a canvas over 16.7 million px,
// and a picture can be 2400 wide.
const STRIP_PX = 4000;

// The three targets in lane (the line of the rail and the book's islands, bookui.js), hidden. act(kind, box) a target
// taken ('submit' | 'pdf' | 'png', its box on the screen); closed() the menu put away with a key. Returns
// { carrying(sendable), menu(sendable), under(x, y), over(item), take(item), hide(), shown() }.
export function mountTargets(lane, { act, closed }) {
  const row = document.createElement('div');
  row.className = 'bk-share';
  row.setAttribute('role', 'menu');
  row.setAttribute('aria-label', 'Where this page goes');
  row.hidden = true;
  row.innerHTML = KINDS.map(kind => `<button role="menuitem" data-share="${kind}" tabindex="-1"></button>`).join('');
  lane.append(row);
  const items = [...row.children],
    targets = { lane, row, items, act, closed };
  row.addEventListener('click', e => {
    const item = e.target.closest('[data-share]');
    if (item && row.dataset.mode === 'menu') take(targets, item);
  });
  row.addEventListener('keydown', e => keyed(targets, e));
  row.addEventListener('focusout', e => !row.contains(e.relatedTarget) && row.dataset.mode === 'menu' && hide(targets));
  return {
    carrying: sendable => show(targets, 'carrying', sendable),
    menu: sendable => {
      show(targets, 'menu', sendable);
      items.find(i => !i.hidden).focus();
    },
    under: (x, y) => (row.hidden ? null : (document.elementFromPoint(x, y)?.closest('.bk-share [data-share]') ?? null)),
    over: item => items.forEach(i => i.toggleAttribute('data-over', i === item)),
    take: item => take(targets, item),
    hide: () => hide(targets),
    shown: () => !row.hidden,
  };
}
const KINDS = ['submit', 'pdf', 'png'];
// Submit names the CEO, its initial on a disc, read each time it shows
function words(kind) {
  if (kind !== 'submit') return esc(kind.toUpperCase());
  const ceo = ceoName();
  return `<i class="bk-share-face" aria-hidden="true">${esc(ceo.charAt(0).toUpperCase())}</i>Submit → ${esc(ceo)}`;
}

// (the rail and the islands make way for them: bookshare.css)
function show({ lane, row, items }, mode, sendable) {
  items.forEach(item => {
    item.innerHTML = words(item.dataset.share);
    item.hidden = item.dataset.share === 'submit' && !sendable;
    item.removeAttribute('data-over');
  });
  row.dataset.mode = mode;
  row.hidden = false;
  lane.toggleAttribute('data-targets', true);
}
function hide({ lane, row, items }) {
  row.hidden = true;
  lane.removeAttribute('data-targets');
  items.forEach(i => i.removeAttribute('data-over'));
}
function take(targets, item) {
  const box = item.getBoundingClientRect();
  hide(targets);
  targets.act(item.dataset.share, box);
}
// The menu's keys: the arrows go round it, Escape puts it away, back on the corner
function keyed(targets, e) {
  const { row } = targets,
    items = targets.items.filter(i => !i.hidden),
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

// The page carried onto the call's window, with a call on (calldrop.js): its picture (a promise of its PNG: filesOf's)
// shown in that call (call.js), a long one's in readable pieces. A page the store doesn't have yet (a blank one, or its
// first save still going) can't go: that's said.
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
