// Photos › one photo, big (studio.js): the edit, a switch flipping to the original and back, a tap for it full size,
// and under it what the board does with it. Approvals: the page it goes on, what it should show and what to check, then
// Accept, or Reject back to the keeper, with an optional comment (once there is one, Reject is the lit button); the next
// one waiting follows.
// History: the pages it's on, and "This should change" with a note, which takes it off the sites and back to the keeper.
// A photo's pane is drawn from the photo alone, so a note being typed stays as the studio changes around it: what
// changes with the rest (Approvals' "2 of 5", the pages, a refusal's line) are parts of their own inside it.
import { esc, grow } from '../util.js';
import { studioAction } from './data.js';
import { part } from './parts.js';
import { sfx } from './audio.js';
import { toast } from './hud.js';
import { zoom } from './zoom.js';
import * as world from '../world/world.js';
import {
  screen,
  SIDE,
  plural,
  waitingOf,
  whatHtml,
  lineHtml,
  keeperHtml,
  dayOf,
  pictureHtml,
  shutter,
  send,
} from './studiophotos.js';

// The picture, big: the edit first, the switch for the original, a tap for the one shown full size
function bigHtml(p, top, below) {
  const edited = p.edit != null;
  const sides = Object.entries(SIDE).map(
    ([side, words]) => `<button role="radio" data-show="${side}">${words}</button>`,
  );
  const flip = edited
    ? `<div class="sd-flip" role="radiogroup" aria-label="Which picture">${sides.join('')}</div>`
    : '';
  return `<div class="sd-bar-top">${flip}${top}</div>
    <button class="sd-view" data-zoom>${pictureHtml(p, 'original')}${edited ? pictureHtml(p, 'edited') : ''}</button>
    <p class="sd-what">${whatHtml(p)}</p>${below}`;
}
function wireFlip(box, p) {
  if (p.edit == null) screen.side = 'original';
  const flipTo = side => {
    screen.side = side;
    sfx.toggle(side === 'edited');
    showSide(box);
  };
  // (a tap: the picture shown, full size)
  const view = box.querySelector('[data-zoom]');
  view.onclick = () => zoom(view.querySelector(`[data-img="${screen.side}"]`).src, `${SIDE[screen.side]}, full size`);
  box.querySelectorAll('[data-show]').forEach(b => (b.onclick = () => flipTo(b.dataset.show)));
  showSide(box);
}
function showSide(box) {
  const view = box.querySelector('[data-zoom]');
  view.dataset.on = screen.side;
  view.setAttribute('aria-label', `${SIDE[screen.side]}: tap to see it full size and zoom`);
  box
    .querySelectorAll('[data-show]')
    .forEach(b => b.setAttribute('aria-checked', String(b.dataset.show === screen.side)));
}
// a note's label, its field (as tall as its text) and the button that sends it
const fieldHtml = (id, label, button) =>
  `<label class="sd-comment" for="${id}">${label}</label><span class="sd-field"><textarea id="${id}" rows="1" required></textarea>${button}</span>`;

// ---- Approvals: the photo it shows stays until it's decided (another device's decision moves on to the next)
function approvalPhoto() {
  const waiting = waitingOf(screen.studio);
  const p = waiting.find(x => x.id === screen.current) ?? waiting[0] ?? null;
  screen.current = p?.id ?? null;
  return p;
}
// Approvals' pane: the photo waiting, or a line when none does
export function paintApproval(el) {
  const p = approvalPhoto();
  part(el, 'approvals', approvalHtml(p), box => wireApproval(el, box, p));
  if (!p) return;
  const waiting = waitingOf(screen.studio);
  part(el, 'approval-count', waiting.length > 1 ? `${waiting.indexOf(p) + 1} of ${waiting.length}` : '');
  part(el, 'approval-line', lineHtml(p.id));
}
function approvalHtml(p) {
  if (!p) return `<p class="sd-empty">Nothing waits for you. ${keeperHtml()} brings the next photos here.</p>`;
  return bigHtml(
    p,
    '<span class="sd-count" data-part="approval-count"></span>',
    `${briefHtml(p)}${commentHtml()}
    <div class="sd-acts sd-decide"><button class="cta" data-accept>Accept</button><button data-reject>Reject</button></div><div data-part="approval-line"></div>`,
  );
}
// What the photo is for, from the shot request it answers: the pages it goes on (or the request's words for where, when
// there are many), what it should show, and what the board checks
function briefHtml(p) {
  const request = p.request;
  const where = request && (request.pages.map(pageHtml).join(', ') || esc(request.where ?? ''));
  const checks = p.checks.map(line => `<li>${esc(line)}</li>`).join('');
  const lines = [
    where && `<p><span>Goes on:</span> ${where}</p>`,
    request && `<p><span>Should show:</span> ${esc(request.show)}</p>`,
    checks && `<div><span>Check:</span><ul>${checks}</ul></div>`,
  ].filter(Boolean);
  return lines.length ? `<div class="sd-brief">${lines.join('')}</div>` : '';
}
// the optional comment, as tall as its text, its words for whom in the field itself, to keep Accept and Reject on a
// phone's screen
const commentHtml = () =>
  `<textarea class="sd-comment-field" rows="1" aria-label="Comment for ${keeperHtml()}" placeholder="Comment for ${keeperHtml()} (optional)"></textarea>`;
function wireApproval(el, box, p) {
  if (!p) return;
  wireFlip(box, p);
  const buttons = [...box.querySelectorAll('.sd-decide button')],
    field = box.querySelector('textarea'),
    comment = () => field.value.trim();
  // (a comment is words to send back: Reject is lit while there is one, Accept while there's none)
  field.oninput = () => {
    grow(field);
    const typed = !!comment();
    box.querySelector('[data-accept]').classList.toggle('cta', !typed);
    box.querySelector('[data-reject]').classList.toggle('cta', typed);
  };
  // (decided: the next one waiting follows, its edit first)
  const decided = after => () => {
    Object.assign(screen, { current: null, side: 'edited' });
    after();
  };
  box.querySelector('[data-accept]').onclick = () => {
    const note = comment();
    send(
      el,
      p,
      buttons,
      () =>
        studioAction(world.dev, 'decide', {
          photos: [{ id: p.id, edit: p.edit }],
          decision: 'approved',
          ...(note ? { note } : {}),
        }),
      decided(() => shutter()),
    );
  };
  box.querySelector('[data-reject]').onclick = () => {
    const note = comment();
    send(
      el,
      p,
      buttons,
      () => studioAction(world.dev, 'reject', { photo: { id: p.id, edit: p.edit }, note }),
      decided(() => {
        sfx.blip();
        // (the comment's first lines)
        toast(
          `<b>Back to ${keeperHtml()}</b><br>${note ? `<span class="sd-said">With your comment: ${esc(note)}</span>` : 'To edit again'}`,
        );
      }),
    );
  };
}

// ---- History: an approved photo, big
const PAGE = /^https?:\/\//i;
// a page's address as the board reads it: no scheme, no www., no trailing slash
export const pageOf = url =>
  String(url)
    .replace(/^https?:\/\/(www\.)?/i, '')
    .replace(/[?#].*$/, '')
    .replace(/\/$/, '');
// History's pane: an approved photo, big
export function paintHistoryPhoto(el, p) {
  const box = part(el, 'history', p ? historyHtml(p) : '', b => p && wireHistory(el, b, p));
  box.hidden = !p;
  if (!p) return;
  part(el, 'history-day', `Approved ${dayOf(p.decided?.at)}`);
  part(el, 'history-places', placesHtml(p.places ?? []));
  part(el, 'history-line', lineHtml(p.id));
}
const placesHtml = places =>
  places.length
    ? `<p class="sd-sub">On ${plural(places.length, 'page', 'pages')}:</p><ul class="sd-places">${places.map(u => `<li>${pageHtml(u)}</li>`).join('')}</ul>`
    : '<p class="sd-sub">Not on a page yet.</p>';
// a page as a link that opens in a new tab, by its address as the board reads it; what isn't an address stays text
const pageHtml = url =>
  PAGE.test(url) ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(pageOf(url))}</a>` : esc(url);
function historyHtml(p) {
  const change = screen.changing
    ? `<form class="sd-retry">${fieldHtml(`sd-change-${p.id}`, `What should change? It comes off the sites, and goes back to ${keeperHtml()} for a new edit to approve.`, `<button class="cta">Send to ${keeperHtml()}</button>`)}</form>`
    : '';
  return bigHtml(
    p,
    '<span class="sd-count" data-part="history-day"></span>',
    `<div data-part="history-places"></div><div class="sd-acts"><button data-change aria-expanded="${screen.changing}">This should change</button></div>${change}<div data-part="history-line"></div>`,
  );
}
function wireHistory(el, box, p) {
  wireFlip(box, p);
  box.querySelector('[data-change]').onclick = () => {
    sfx.blip();
    screen.changing = !screen.changing;
    screen.render(el);
    if (screen.changing) el.querySelector('.sd-retry textarea')?.focus();
  };
  const form = box.querySelector('.sd-retry');
  // (as tall as its text)
  form?.querySelector('textarea').addEventListener('input', e => grow(e.target));
  form?.addEventListener('submit', e => {
    e.preventDefault();
    const note = form.querySelector('textarea').value.trim();
    if (!note) return;
    send(
      el,
      p,
      [form.querySelector('button')],
      () => studioAction(world.dev, 'change', { photo: { id: p.id, edit: p.edit }, note }),
      () => {
        Object.assign(screen, { open: null, changing: false });
        sfx.blip();
        toast(`<b>Back to ${keeperHtml()}</b><br><span class="sd-said">${esc(note)}</span>`);
      },
    );
  });
}
