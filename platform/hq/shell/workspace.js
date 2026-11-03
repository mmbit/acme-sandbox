// A shared workspace whole, in the Companies app (companies.js): its threads, each with its messages in order, and its
// files, each with every version to download. The other company's words are outside text: escaped, never markup.
import { esc } from '../util.js';
import { dayTime } from '../world/clock.js';
import { workspaceFileUrl } from './data.js';
import * as world from '../world/world.js';

// hq: who (our agents' names), ago
export function workspaceHtml(w, hq) {
  const gone =
    w.linkState === 'linked'
      ? ''
      : `<p class="co-gone-note">Unlinked: both companies keep what’s here, and nothing more crosses.</p>`;
  const threads = w.threads.length
    ? w.threads.map(t => threadHtml(t, hq)).join('')
    : '<p class="dim">No threads yet.</p>';
  const files = w.files.length
    ? `<ul class="co-files">${w.files.map(f => fileHtml(w, f, hq)).join('')}</ul>`
    : '<p class="dim">No files yet.</p>';
  return `<div class="seats-app co-app co-workspace">
    <div class="seat-top"><b class="seat-name">${esc(w.title)}</b><span class="seat-now">${esc(w.company)}</span></div>
    <p class="dim">Opened by ${authorHtml(w.by, hq)}, ${esc(when(w.opened))}</p>${gone}
    <p class="cap"><i class="prompt">&gt; </i>THREADS</p>${threads}
    <p class="cap"><i class="prompt">&gt; </i>FILES</p>${files}</div>`;
}

// ---- threads
function threadHtml(t, hq) {
  return `<section class="co-thread"><h3>${esc(t.subject)}</h3>
    <ol class="co-messages">${t.messages.map(m => messageHtml(m, hq)).join('')}</ol></section>`;
}
// One message: who and when, urgent marked, its text as written (line breaks kept), and where it is: ours on its way,
// arrived or read by them; theirs new until one of us reads it
function messageHtml(m, hq) {
  const side = m.by.ours ? 'ours' : 'theirs';
  const flags = [
    m.urgent ? '<em class="co-urgent">Urgent</em>' : '',
    !m.by.ours && !m.read ? '<em class="co-unread">New</em>' : '',
  ];
  return `<li class="co-msg ${side}${m.urgent ? ' urgent' : ''}">
    <p class="co-who">${authorHtml(m.by, hq)} <span class="dim">· ${esc(when(m.at))}</span> ${flags.filter(Boolean).join(' ')}</p>
    <p class="co-text">${esc(m.text)}</p>${m.by.ours ? `<p class="co-where dim">${esc(whereOurs(m, hq))}</p>` : ''}</li>`;
}
const whereOurs = (m, hq) =>
  m.read ? `Read by them ${hq.ago(m.read)}` : m.arrived ? `Arrived ${hq.ago(m.arrived)}, not read yet` : 'On its way';

// ---- files: each path with its versions, newest first
function fileHtml(w, f, hq) {
  const versions = f.versions.toReversed().map(v => {
    const href = workspaceFileUrl(world.dev, w.id, f.path, v.n);
    const facts = [when(v.at), size(v.size), v.by.ours && !v.arrived ? 'on its way' : ''].filter(Boolean);
    const factsHtml = facts.map(fact => `<span class="co-fact">${esc(fact)}</span>`).join(' · ');
    return `<li><span class="co-v">v${esc(v.n)}</span><span class="co-vtext">${authorHtml(v.by, hq)} · ${factsHtml}${v.note ? `<span class="co-note">${esc(v.note)}</span>` : ''}</span>
      <a class="act co-get" href="${esc(href)}" download="${esc(f.path.split('/').pop())}">Download</a></li>`;
  });
  return `<li><b class="co-path">${esc(f.path)}</b><ol class="co-versions">${versions.join('')}</ol></li>`;
}

// Who wrote it: an agent of ours by its name here, the other company's as they call it, each with its company's name
function authorHtml(by, hq) {
  const name = by.ours ? hq.who(by.agent) : by.agent.charAt(0).toUpperCase() + by.agent.slice(1);
  return `<b class="co-${by.ours ? 'ours' : 'theirs'}">${esc(name)}</b> <span class="co-company">(${esc(by.company)})</span>`;
}
const when = iso => (iso ? dayTime(Date.parse(iso)) : '');
const size = bytes =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 ** 2
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
