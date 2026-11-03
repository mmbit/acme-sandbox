// Settings › Companies: the companies ours works with (platform/coordinator/docs/companies.md). Our own name and HQ's
// address; each linked company, how its HQ is answering and Unlink; Invite a company, an invitation shown once to copy
// and give to the other company's board, with the open ones to withdraw; Accept an invitation, pasted from another
// company's board; and the companies unlinked, quieter. Settings draws it (desk.js), and changed() tells the computer's
// home screen, which shows the Companies app (companies.js) once there's a link or an invitation.
import { esc, stylesheet } from '../util.js';
import { dayTime } from '../world/clock.js';
import { loadLinks, inviteCompany, withdrawInvitation, joinCompany, unlinkCompany } from './data.js';
import { askAgain } from '/ask.js';
import { sfx } from './audio.js';

// What the board has under way, kept through every redraw: the invitation just made (shown until it leaves the page),
// what has a request on its way ('invite', 'join'), and the last outcome to say in the status line
const ui = { made: null, sending: new Set(), said: '' };
let current = null; // the element the page was last opened into: an answer meant for an earlier one is dropped

// h: dev, ago (how long ago, in words), changed() after a link or an invitation came or went
export async function companyLinks(el, h) {
  current = el;
  Object.assign(ui, { made: null, said: '' });
  ui.sending.clear();
  await stylesheet('shell/companies.css');
  await redraw(el, h);
}

async function redraw(el, h) {
  const links = await loadLinks(h.dev);
  if (current !== el || !el.isConnected) return;
  const typed = el.querySelector('[name="invitation"]')?.value ?? '';
  el.innerHTML = page(links, h);
  el.querySelector('[name="invitation"]').value = typed;
  wire(el, h, links);
}

// ---- the page
function page(links, h) {
  const linked = links.links.filter(l => l.state === 'linked');
  const unlinked = links.links.filter(l => l.state !== 'linked');
  const host = new URL(links.address).host;
  return `<div class="seats-app companies">
    <p class="co-us"><b>${esc(links.name)}</b> <span class="dim">· ${esc(host)}</span></p>
    <p class="cap"><i class="prompt">&gt; </i>LINKED COMPANIES</p>
    ${linked.length ? `<ul class="rows co-links">${linked.map(l => linkRow(l, h)).join('')}</ul>` : '<p class="dim">None yet. Invite a company, or accept another company’s invitation, below.</p>'}
    <p class="cap"><i class="prompt">&gt; </i>INVITE A COMPANY</p>
    ${inviteBox(links.invitations)}
    <p class="cap"><i class="prompt">&gt; </i>ACCEPT AN INVITATION</p>
    <p>Paste the invitation another company’s board gave you.</p>
    <div class="co-field"><input name="invitation" autocomplete="off" spellcheck="false" placeholder="https://…#invite_…" aria-label="The invitation" data-watchalong-hide>
    <button class="cta" data-join${ui.sending.has('join') ? ' disabled' : ''}>${ui.sending.has('join') ? 'Linking…' : 'Accept'}</button></div>
    <p class="msg co-said" role="status">${esc(ui.said)}</p>
    ${unlinked.length ? `<p class="cap"><i class="prompt">&gt; </i>UNLINKED</p><ul class="rows co-links co-gone">${unlinked.map(goneRow).join('')}</ul>` : ''}
  </div>`;
}
// A linked company: its name and since when, its HQ's last answers, what it shares with us, and Unlink
function linkRow(l, h) {
  const shared = [plural(l.workspaces, 'workspace', 'workspaces'), l.unread ? `${l.unread} unread` : ''].filter(
    Boolean,
  );
  const answers = [
    l.reached ? `reached ${h.ago(l.reached)}` : 'not reached yet',
    l.heard ? `heard from ${h.ago(l.heard)}` : 'not heard from yet',
  ];
  const waiting = l.waiting
    ? `<span class="co-waiting">${plural(l.waiting, 'entry', 'entries')} waiting for its HQ since ${esc(when(l.waitingSince))}</span>`
    : '';
  // (their HQ's own words: outside text)
  const refused = l.refused ? `<span class="co-waiting">Its HQ refused our last entries: ${esc(l.refused)}</span>` : '';
  return `<li data-link="${esc(l.id)}"><div class="seat-top"><b>${esc(l.name)}</b><span class="seat-now">Linked</span></div>
    <span class="dim">Linked since ${esc(when(l.linked))} · ${esc(shared.join(' · '))}</span>
    <span class="dim">Its HQ: ${esc(answers.join(', '))}</span>${waiting}${refused}
    <span class="co-acts"><button class="act" data-unlink="${esc(l.id)}">Unlink</button></span>
    <p class="msg" data-unlink-said="${esc(l.id)}" role="status" hidden></p></li>`;
}
// An invitation just made, shown once with Copy; then the ones still open, each to withdraw
function inviteBox(invitations) {
  const made = ui.made
    ? `<div class="seat-signin co-made"><p><b>Invitation made.</b> It links one company, once. Give it to the other company’s board: they paste it into their HQ’s Settings › Companies and tap Accept.</p>
      <p class="acts"><button class="cta" data-copy>Copy the invitation</button></p></div>`
    : '';
  const open = invitations.map(
    i => `<li data-invitation="${esc(i.id)}"><span>Made ${esc(when(i.made))}, not used yet</span>
    <span class="co-acts"><button class="act" data-withdraw="${esc(i.id)}">Withdraw</button></span><p class="msg" role="status" hidden></p></li>`,
  );
  return `<p>An invitation lets one other company link with ours. Nothing else to set up: both boards then see the work shared here, in the Companies app.</p>
    ${made}<p class="acts"><button class="${ui.made ? 'act' : 'cta'}" data-invite${ui.sending.has('invite') ? ' disabled' : ''}>${ui.made ? 'Make another' : 'Make an invitation'}</button></p>
    ${open.length ? `<ul class="rows co-invitations">${open.join('')}</ul>` : ''}`;
}
// A company no longer linked: who unlinked and when, quieter
function goneRow(l) {
  const who = l.unlinkedBy === 'us' ? 'We unlinked' : l.unlinkedBy === 'them' ? 'They unlinked' : 'Unlinked';
  return `<li data-link="${esc(l.id)}"><b>${esc(l.name)}</b>
    <span class="dim">${who} ${esc(when(l.unlinked))}. Linked since ${esc(when(l.linked))}. ${plural(l.workspaces, 'workspace', 'workspaces')} kept.</span></li>`;
}
const when = iso => (iso ? dayTime(Date.parse(iso)) : '');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---- what the board taps
function wire(el, h, links) {
  const said = el.querySelector('.co-said');
  el.querySelector('[data-invite]').onclick = () => invite(el, h);
  el.querySelector('[data-copy]')?.addEventListener('click', copyInvitation(el, said, ui.made?.invitation));
  el.querySelector('[data-join]').onclick = () => join(el, h);
  for (const button of el.querySelectorAll('[data-unlink]')) {
    const link = links.links.find(l => String(l.id) === button.dataset.unlink);
    askAgain(button, {
      status: el.querySelector(`[data-unlink-said="${button.dataset.unlink}"]`),
      label: 'Unlink',
      again: 'Tap again to unlink',
      question: `Both companies keep what was shared so far, and nothing more crosses. To work with ${link.name} again, one of you invites the other.`,
      act: () => change(el, h, button, () => unlinkCompany(h.dev, link.id), `Unlinked from ${link.name}.`),
    });
  }
  for (const button of el.querySelectorAll('[data-withdraw]')) {
    askAgain(button, {
      status: button.closest('li').querySelector('.msg'),
      label: 'Withdraw',
      again: 'Tap again to withdraw',
      question: 'Nobody can link with it after this.',
      act: () =>
        change(
          el,
          h,
          button,
          () => withdrawInvitation(h.dev, Number(button.dataset.withdraw)),
          'Invitation withdrawn.',
        ),
    });
  }
}
async function invite(el, h) {
  sfx.blip();
  ui.sending.add('invite');
  await redraw(el, h);
  try {
    ui.made = await inviteCompany(h.dev);
    ui.said = 'Copy it now: HQ shows it only this once.';
    h.changed();
  } catch (err) {
    ui.said = err.refusal?.error ?? 'No invitation made. Try again.';
  }
  ui.sending.delete('invite');
  await redraw(el, h);
}
async function join(el, h) {
  const invitation = el.querySelector('[name="invitation"]').value.trim();
  if (!invitation) {
    el.querySelector('.co-said').textContent = 'Paste the invitation first.';
    return;
  }
  sfx.blip();
  Object.assign(ui, { said: 'Asking their HQ…' });
  ui.sending.add('join');
  await redraw(el, h);
  try {
    const { link } = await joinCompany(h.dev, invitation);
    el.querySelector('[name="invitation"]').value = '';
    ui.said = `Linked with ${link.name}.`;
    h.changed();
  } catch (err) {
    ui.said = err.refusal?.error ?? 'Not linked: their HQ didn’t answer. Try again in a minute.';
  }
  ui.sending.delete('join');
  await redraw(el, h);
}
// Unlink and Withdraw: the request, then the page again with what came of it
async function change(el, h, button, request, done) {
  sfx.blip();
  button.disabled = true;
  try {
    await request();
    ui.said = done;
    h.changed();
  } catch (err) {
    ui.said = err.refusal?.error ?? 'Didn’t change. Try again.';
  }
  await redraw(el, h);
}

// Copy the invitation: to the clipboard, or where there's none, the invitation itself, selected, to copy by hand
const copyInvitation = (el, said, invitation) => async e => {
  sfx.blip();
  try {
    await navigator.clipboard.writeText(invitation);
    e.target.textContent = 'Copied';
    said.textContent = 'Give it to the other company’s board.';
  } catch {
    let box = el.querySelector('.co-made textarea');
    if (!box) {
      box = Object.assign(document.createElement('textarea'), { readOnly: true, rows: 2 });
      // never in a call's recording (shared/watchalong).
      box.setAttribute('data-watchalong-hide', '');
      e.target.closest('.acts').after(box);
    }
    box.value = invitation;
    box.select();
  }
};
