// A shared workspace in the Companies app (companies.js): its threads by subject and its files as a folder tree (a
// file's newest two versions to get), and a thread opened, its long messages folded to two lines. The other company's
// words are outside text: escaped, never markup.
import { esc } from '../util.js';
import { dayTime } from '../world/clock.js';
import { workspaceFileUrl } from './data.js';
import * as world from '../world/world.js';

// The workspace: its threads, the latest activity first, each a row to open (data-thread), and its files. hq: who (our
// agents' names), ago. open: the folders and files whose versions are open (data-path), kept through a redraw.
export function workspaceHtml(w, hq, open) {
  const threads = w.threads.length
    ? `<ul class="rows settings co-list co-threads">${w.threads
        .map(t => ({ t, last: t.messages.at(-1)?.at ?? t.opened }))
        .sort((a, b) => b.last.localeCompare(a.last))
        .map(({ t, last }) => threadRow(t, last, hq))
        .join('')}</ul>`
    : '<p class="dim">No threads yet.</p>';
  const files = w.files.length
    ? `<ul class="co-tree">${folderHtml(treeOf(w.files), '', { w, hq, open })}</ul>`
    : '<p class="dim">No files yet.</p>';
  return `<div class="seats-app co-app co-workspace">
    <div class="seat-top"><b class="seat-name">${esc(w.title)}</b><span class="seat-now">${esc(w.company)}</span></div>
    <p class="dim">Opened by ${authorHtml(w.by, hq)}, ${esc(when(w.opened))}</p>${goneHtml(w)}
    <p class="cap"><i class="prompt">&gt; </i>THREADS</p>${threads}
    <p class="cap"><i class="prompt">&gt; </i>FILES</p>${files}</div>`;
}

// One thread: its subject (unless it only repeats the workspace's title) and its messages in order, each long one folded
// but the newest. unfolded: the messages the board has open, kept through a redraw.
export function threadHtml(w, t, hq, unfolded) {
  const newest = t.messages.at(-1)?.id;
  const repeats = t.subject.trim().toLowerCase() === w.title.trim().toLowerCase();
  const subject = repeats ? '' : `<div class="seat-top"><b class="seat-name">${esc(t.subject)}</b></div>`;
  const messages = t.messages.map(m => messageHtml(m, hq, !unfolded.has(m.id) && m.id !== newest)).join('');
  return `<div class="seats-app co-app co-workspace co-open-thread">${subject}
    <p class="dim">Started by ${authorHtml(t.by, hq)}, ${esc(when(t.opened))} · ${plural(t.messages.length, 'message', 'messages')}</p>${goneHtml(w)}
    <ol class="co-messages">${messages}</ol></div>`;
}

// After a thread is drawn: which messages are long enough to fold (more than two lines at this width), each a tap that
// folds or unfolds it
export function foldable(el) {
  for (const li of el.querySelectorAll('.co-msg')) {
    const text = li.querySelector('.co-text');
    const long = text.scrollHeight > 2 * parseFloat(getComputedStyle(text).lineHeight) + 2;
    li.classList.toggle('co-long', long);
    li.querySelector('.co-more').textContent = long ? (li.classList.contains('fold') ? 'More ▾' : 'Less ▴') : '';
    li.onclick = long ? () => unfold(li) : null;
  }
}
function unfold(li) {
  if (getSelection()?.toString()) return; // (selecting words to copy isn't a tap)
  li.classList.toggle('fold');
  li.querySelector('.co-more').textContent = li.classList.contains('fold') ? 'More ▾' : 'Less ▴';
}

const goneHtml = w =>
  w.linkState === 'linked'
    ? ''
    : `<p class="co-gone-note">Unlinked: both companies keep what’s here, and nothing more crosses.</p>`;

// ---- threads
// A thread's row: its subject, who wrote in it, how many messages and when the last came, and what of theirs is unread
function threadRow(t, last, hq) {
  const writers = [...new Map(t.messages.map(m => [`${m.by.ours}:${m.by.agent}`, nameOf(m.by, hq)])).values()];
  const unread = t.messages.filter(m => !m.by.ours && !m.read);
  const urgent = unread.filter(m => m.urgent).length;
  const marks = unread.length
    ? `<span class="co-new">${unread.length} unread${urgent ? ` · <em>${urgent} urgent</em>` : ''}</span>`
    : '';
  const facts = [writers.join(', '), plural(t.messages.length, 'message', 'messages'), `last ${hq.ago(last)}`];
  return `<li><button data-thread="${esc(t.id)}"><b>${esc(t.subject)}</b><span class="to">›</span>
    <span class="dim">${esc(facts.filter(Boolean).join(' · '))}</span>${marks}</button></li>`;
}

// One message: who and when, urgent marked, its text as written (line breaks kept), and where it is: ours on its way,
// arrived or read by them; theirs new until one of us reads it. fold: two lines of it, until it's tapped.
function messageHtml(m, hq, fold) {
  const side = m.by.ours ? 'ours' : 'theirs';
  const flags = [
    m.urgent ? '<em class="co-urgent">Urgent</em>' : '',
    !m.by.ours && !m.read ? '<em class="co-unread">New</em>' : '',
  ];
  return `<li class="co-msg ${side}${m.urgent ? ' urgent' : ''}${fold ? ' fold' : ''}" data-message="${esc(m.id)}">
    <p class="co-who">${authorHtml(m.by, hq)} <span class="dim">· ${esc(when(m.at))}</span> ${flags.filter(Boolean).join(' ')}</p>
    <p class="co-text">${esc(m.text)}</p><p class="co-more"></p>${m.by.ours ? `<p class="co-where dim">${esc(whereOurs(m, hq))}</p>` : ''}</li>`;
}
const whereOurs = (m, hq) =>
  m.read ? `Read by them ${hq.ago(m.read)}` : m.arrived ? `Arrived ${hq.ago(m.arrived)}, not read yet` : 'On its way';

// ---- files: a folder tree, each file on one line with its newest version, its older ones folded under it
// The paths as folders, each with its folders and its files by name
function treeOf(files) {
  const root = { folders: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] });
      node = node.folders.get(part);
    }
    node.files.push({ name: parts.at(-1), file });
  }
  return root;
}
// A folder's folders (closed until opened, with how many files they hold) and then its files
function folderHtml(node, at, view) {
  const folders = [...node.folders].sort(([a], [b]) => a.localeCompare(b));
  const files = node.files.toSorted((a, b) => a.name.localeCompare(b.name));
  const folderRows = folders.map(([name, inner]) => {
    const path = `${at}${name}/`;
    return `<li class="co-dir"><details data-path="${esc(path)}"${view.open.has(path) ? ' open' : ''}>
      <summary><span class="co-name">${esc(name)}/</span><span class="co-facts">${esc(plural(countOf(inner), 'file', 'files'))}</span></summary>
      <ul class="co-tree">${folderHtml(inner, path, view)}</ul></details></li>`;
  });
  return [...folderRows, ...files.map(({ name, file }) => fileHtml(name, file, view))].join('');
}
const countOf = node => node.files.length + [...node.folders.values()].reduce((n, inner) => n + countOf(inner), 0);

// A file: its name, which gets the newest version, and that version's facts. One with older versions opens to them all.
function fileHtml(name, f, { w, hq, open }) {
  const newest = f.versions.at(-1);
  const get = `<a class="co-name" href="${esc(fileUrl(w, f, newest))}" download="${esc(name)}">${esc(name)}</a>`;
  const facts = [when(newest.at), size(newest.size), newest.by.ours && !newest.arrived ? 'on its way' : ''];
  const factsHtml = esc(facts.filter(Boolean).join(' · '));
  if (f.versions.length === 1) return `<li class="co-file">${get}<span class="co-facts">${factsHtml}</span></li>`;
  const versions = f.versions.toReversed().map(v => versionHtml(w, f, v, hq));
  return `<li class="co-file"><details data-path="${esc(f.path)}"${open.has(f.path) ? ' open' : ''}>
    <summary>${get}<span class="co-facts"><span class="co-vs">v${esc(newest.n)}</span> · ${factsHtml}</span></summary>
    <ol class="co-versions">${versions.join('')}</ol></details></li>`;
}
// One version in a file's list: its number (which gets it), who put it, when, its size and note. One past the newest
// two has its bytes cleared: its line stays, with nothing to get.
function versionHtml(w, f, v, hq) {
  const facts = [when(v.at), size(v.size), v.by.ours && !v.arrived ? 'on its way' : '', v.cleared ? 'cleared' : ''];
  const name = f.path.split('/').pop();
  const n = `v${esc(v.n)}`;
  const get = v.cleared
    ? `<span class="co-v">${n}</span>`
    : `<a class="co-v" href="${esc(fileUrl(w, f, v))}" download="${esc(name)}">${n}</a>`;
  return `<li>${get}
    <span>${authorHtml(v.by, hq)} · ${esc(facts.filter(Boolean).join(' · '))}${v.note ? `<span class="co-note">${esc(v.note)}</span>` : ''}</span></li>`;
}
const fileUrl = (w, f, v) => workspaceFileUrl(world.dev, w.id, f.path, v.n);

// Who wrote it: an agent of ours by its name here, the other company's as they call it, each with its company's name
const authorHtml = (by, hq) =>
  `<b class="co-${by.ours ? 'ours' : 'theirs'}">${esc(nameOf(by, hq))}</b> <span class="co-company">(${esc(by.company)})</span>`;
const nameOf = (by, hq) => (by.ours ? hq.who(by.agent) : by.agent.charAt(0).toUpperCase() + by.agent.slice(1));
const when = iso => (iso ? dayTime(Date.parse(iso)) : '');
export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const size = bytes =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 ** 2
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
