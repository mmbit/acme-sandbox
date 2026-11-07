// A file opened in HQ pinned to the home screen. The pinned app has no browser round it, so a download there (a card's
// file, a mail's attachment, a page's export) would leave HQ for the system's file page, with no way back but closing
// the app. There every download opens here instead: the file shown over HQ with a close key, and Save, which hands it
// to the system's share sheet (Save to Files, Save Image), whose own close comes back to HQ.
import { esc, stylesheet } from '../util.js';
import { tell } from './alert.js';
import { sfx } from './audio.js';
import { icon } from './icons.js';
import { isSound, playerHtml } from './listen.js';

const pinned = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// Every download link, in HQ or made to save a file (a page's export clicks one it makes), opens here in the pinned app,
// where its Save can hand the file on (an installed app with no share sheet keeps its downloads). The sheet's own plain
// download (offerSave's) goes as a download. (capturing: before the link's own handlers, which may stop it)
export function openDownloadsInApp() {
  document.addEventListener(
    'click',
    e => {
      const link = e.target instanceof Element && e.target.closest('a[download]');
      if (!link || link.closest('.fileview') || !pinned() || !navigator.canShare) return;
      e.preventDefault();
      openFile(link.href, link.getAttribute('download') || link.textContent.trim());
    },
    true,
  );
}

// The file at href (HQ's own address, or a blob: of a file made here), shown over HQ by its name
export async function openFile(href, name) {
  await stylesheet('shell/fileview.css');
  const box = document.createElement('dialog');
  box.className = 'fileview';
  box.setAttribute('aria-label', name);
  box.innerHTML = `<header><span class="fn">${esc(name)}</span>
    <button type="button" class="fileview-save" hidden>${icon('download')}Save</button>
    <button type="button" class="fileview-close" aria-label="Close">✕</button></header>
    <p class="fileview-said"></p>
    <div class="fileview-body"><p class="fileview-note">Opening…</p></div>`;
  document.body.append(box);
  let shown = '';
  const close = () => {
    sfx.close();
    box.close();
    box.remove();
    URL.revokeObjectURL(shown);
  };
  box.querySelector('.fileview-close').onclick = close;
  box.addEventListener('cancel', e => {
    e.preventDefault();
    close();
  });
  box.showModal();
  sfx.open();
  const body = box.querySelector('.fileview-body');
  try {
    const answer = await fetch(href);
    if (!answer.ok) throw new Error(`The file couldn’t be opened (${answer.status}).`);
    const bytes = await answer.arrayBuffer(),
      file = new File([bytes], name, { type: typeOf(name, bytes) });
    shown = URL.createObjectURL(file);
    body.innerHTML = viewOf(file, shown);
    offerSave(box.querySelector('.fileview-save'), file, shown, box.querySelector('.fileview-said'));
  } catch (e) {
    body.innerHTML = `<p class="fileview-note">${esc(e.message)}</p>`;
  }
}

// What shows a file of its type. Another page's markup or script never runs on HQ's origin: a text shows in a sandboxed
// frame, no script in it, and a page as its markup there, so nothing in it loads (an outside sender's picture).
function viewOf(file, src) {
  const title = esc(file.name);
  if (file.type.startsWith('image/')) return `<img src="${src}" alt="${title}">`;
  if (isSound(file.name)) return playerHtml({ name: file.name, src });
  if (file.type.startsWith('video/')) return `<video src="${src}" controls playsinline></video>`;
  if (file.type === 'application/pdf') return `<iframe src="${src}" title="${title}"></iframe>`;
  if (file.type.startsWith('text/')) return `<iframe src="${src}" title="${title}" sandbox></iframe>`;
  return '<p class="fileview-note">This file can’t be shown here. Save it to open it in another app.</p>';
}

// Save: to the share sheet where the system takes the file (Safari and the pinned app on iOS), else a plain download of
// src (a .zip, a .docx the share sheet won't have: in the pinned app, the system's file page); a refusal is said on the
// sheet's line (msg)
function offerSave(key, file, src, msg) {
  key.hidden = false;
  key.onclick = () => {
    tell(msg, '');
    if (!navigator.canShare?.({ files: [file] })) {
      const link = Object.assign(document.createElement('a'), { href: src, download: file.name });
      key.after(link);
      link.click();
      link.remove();
      return;
    }
    navigator.share({ files: [file] }).catch(e => {
      if (e.name !== 'AbortError') tell(msg, `Couldn’t save it: ${e.message}`); // (AbortError: closed unshared)
    });
  };
}

// A file's type by its name: a PDF only when its bytes are one, so nothing else is handed to the PDF viewer
function typeOf(name, bytes) {
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'pdf') return new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-' ? 'application/pdf' : '';
  return TYPES[ext] ?? '';
}
// prettier-ignore
const TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm',
  txt: 'text/plain;charset=utf-8', md: 'text/plain;charset=utf-8', csv: 'text/plain;charset=utf-8',
  json: 'text/plain;charset=utf-8', html: 'text/plain;charset=utf-8', htm: 'text/plain;charset=utf-8',
};
