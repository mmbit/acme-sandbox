// The call screen's Add a guest: someone in the room with the board joins this call's page from a device of their own,
// with their own pen, muted (the coordinator's callguests.ts). The board gives their name and email address, and the
// language their door speaks; the card then shows a QR code and its link. Their door says first that the agent is an AI
// and the call is written down, they sign in with a code emailed to them, and the call's page opens. Good until the
// call ends.
import { act } from './data.js';
import { esc } from '../util.js';
import { qrCode, qrPath } from '/shared/qr/qr.js';

const LANGS = { nl: 'Nederlands', en: 'English', de: 'Deutsch' };

// The key waits for the call to pick up (call.js asks again then), and goes with its end
export function guestKey(c) {
  const key = c.layer?.querySelector('#call-guest');
  if (key) key.disabled = !c.call || !!c.over;
}

// The key shows the card, and again hides it
export function addGuest(c) {
  const card = c.layer?.querySelector('#call-guest-card');
  if (!card) return;
  if (!card.hidden) return void (card.hidden = true);
  card.hidden = false;
  const lang = c.dial?.lang ?? 'en'; // (the call's own, as a start)
  card.innerHTML = `<b>Add a guest</b>
    <form class="guest-form">
      <label>Name <input name="name" autocomplete="off" required maxlength="60"></label>
      <label>Email <input name="email" type="email" autocomplete="off" required></label>
      <label>Their language <select name="lang">${Object.entries(LANGS)
        .map(([k, v]) => `<option value="${k}"${k === lang ? ' selected' : ''}>${v}</option>`)
        .join('')}</select></label>
      <p>They join this call’s page with their own pen, muted. They get a code by email to sign in.</p>
      <div class="guest-keys"><button type="submit">Make their link</button><button type="button" class="guest-close">Close</button></div>
    </form>`;
  card.querySelector('.guest-close').onclick = () => (card.hidden = true);
  const form = card.querySelector('form');
  form.onsubmit = async e => {
    e.preventDefault();
    const asked = Object.fromEntries(new FormData(form));
    form.querySelector('[type=submit]').disabled = true;
    try {
      const { link, name } = await act('/api/calls/guest', { call: c.call, ...asked });
      shown(card, link, name);
    } catch (err) {
      form.querySelector('[type=submit]').disabled = false;
      form.querySelector('p').textContent = err.message;
    }
  };
  card.querySelector('input').focus();
}

function shown(card, link, name) {
  const qr = qrCode(link, { level: 'M' }),
    n = qr.size + 8;
  card.innerHTML = `<b>${esc(name)}’s link</b>
    <svg class="guest-qr" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="Scan to join this call’s page"><rect width="${n}" height="${n}" fill="#fff"/><path d="${qrPath(qr)}"/></svg>
    <p>${esc(name)} scans this on their own device, or opens the link. A code goes to their email to sign in, then this call’s page opens. Muted: the sound stays here. Good until the call ends.</p>
    <a class="guest-link" target="_blank" rel="noopener noreferrer"></a>
    <button type="button" class="guest-close">Close</button>`;
  const a = card.querySelector('.guest-link');
  a.href = a.textContent = link;
  card.querySelector('.guest-close').onclick = () => (card.hidden = true);
}
