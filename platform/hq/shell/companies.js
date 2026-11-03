// HQ-OS › Companies: the work shared with linked companies (platform/coordinator/docs/companies.md), read-only, since
// the board talks to its own agents and never posts here. The list of workspaces, the other company's name on each, and
// a workspace whole: its threads and its files (workspace.js). desk.js loads it as a platform app, on the home screen
// only while the company has a link or an open invitation (shown). Linking itself is Settings › Companies
// (companylinks.js).
import { esc, stylesheet } from '../util.js';
import { loadLinks, loadWorkspaces, loadWorkspace } from './data.js';
import { workspaceHtml } from './workspace.js';
import { sfx } from './audio.js';

// ---- what HQ calls
export const app = {
  name: 'Companies',
  what: 'Work shared with linked companies',
  icon: 'app-companies',
  group: 'talk',
};

// What the board has open: null (the list) or a workspace's id
let opened = null;
let shownEl = null;
let drawn = ''; // the markup shown: an unchanged one leaves the screen, the board's place and selection alone
let seq = 0;

// Each time the computer (re)draws it: on opening and every 15 s. A new screen element is a fresh opening, on the list.
export async function draw(el, hq) {
  if (el !== shownEl) {
    shownEl = el;
    opened = null;
    drawn = '';
  }
  await stylesheet('shell/companies.css');
  await paint(el, hq);
}

// The header's back button: from a workspace back to the list (true), else the computer's (false)
export function back() {
  if (opened === null || !shownEl?.isConnected) return false;
  sfx.blip();
  opened = null;
  shownEl.scrollTop = 0;
  paint(shownEl, lastHq);
  return true;
}

// On the home screen while there's a link (linked or not any more) or an invitation still open
export const shown = async dev => {
  const links = await loadLinks(dev);
  return links.links.length > 0 || links.invitations.length > 0;
};

let lastHq = null;
let title = ''; // the open workspace's, for the header
async function paint(el, hq) {
  lastHq = hq;
  const me = ++seq;
  const want = opened;
  const html = want === null ? listHtml((await loadWorkspaces(hq.dev)).workspaces, hq) : await workspacePage(want, hq);
  if (me !== seq || !el.isConnected || want !== opened) return;
  crumb(el, want === null ? '' : title);
  el.closest('.device')?.classList.add('co-wide');
  if (html === drawn) return;
  el.innerHTML = drawn = html;
  for (const button of el.querySelectorAll('[data-workspace]'))
    button.onclick = () => {
      sfx.blip();
      opened = Number(button.dataset.workspace);
      el.scrollTop = 0;
      paint(el, hq);
    };
}
async function workspacePage(id, hq) {
  try {
    const workspace = await loadWorkspace(hq.dev, id);
    title = workspace.title;
    return workspaceHtml(workspace, hq);
  } catch (err) {
    if (err.status !== 404) throw err;
    return '<div class="seats-app co-app"><p class="dim">That workspace isn’t here any more.</p></div>';
  }
}
// The header's crumb after the app's name: the workspace open, if one is
function crumb(el, title) {
  const span = el.closest('.computer')?.querySelector('header b span');
  if (span) span.textContent = ` › ${app.name}${title ? ` › ${title}` : ''}`;
}

// ---- the list: each workspace, newest activity first, with the other company's name, what's unread and when it moved
function listHtml(workspaces, hq) {
  const row = w => {
    const unread = w.unread
      ? `<span class="co-new">${w.unread} unread${w.urgent ? ` · <em>${w.urgent} urgent</em>` : ''}</span>`
      : '';
    const state = w.linkState === 'linked' ? '' : '<span class="co-unlinked">Unlinked</span>';
    const parts = [
      w.company,
      plural(w.threads, 'thread', 'threads'),
      plural(w.files, 'file', 'files'),
      `last ${hq.ago(w.last)}`,
    ];
    return `<li><button data-workspace="${esc(w.id)}"${w.linkState === 'linked' ? '' : ' class="co-quiet"'}>
      <b>${esc(w.title)}</b><span class="to">›</span><span class="dim">${esc(parts.join(' · '))}</span>${unread}${state}</button></li>`;
  };
  const none =
    '<p class="dim">Nothing shared yet. Your agents open a workspace with a linked company when there’s work to share, and it shows here.</p>';
  return `<div class="seats-app co-app"><p class="cap"><i class="prompt">&gt; </i>SHARED WORK</p>
    ${workspaces.length ? `<ul class="rows settings co-list">${workspaces.map(row).join('')}</ul>` : none}
    <p class="co-foot dim">Read-only: your agents post here, and you talk to them as always.</p></div>`;
}
export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
