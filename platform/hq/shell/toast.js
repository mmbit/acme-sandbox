// The shared toast, independent of the board's HUD and world.
import { stylesheet } from '../util.js';

stylesheet('shell/toast.css');
const $ = s => document.querySelector(s);

// A tap off a job's link in it is the toast's (prose.js covered).
export function toast(html, onClick, { sticky = false } = {}) {
  const t = document.createElement('div'),
    tap = document.createElement('button');
  t.className = 'toast covered' + (sticky ? ' sticky' : '');
  t.innerHTML = html;
  tap.type = 'button';
  tap.className = 'cover';
  tap.setAttribute('aria-label', t.textContent);
  tap.onclick = () => {
    t.remove();
    onClick?.();
  };
  t.prepend(tap);
  // under the HUD as it stands: its rows of tools wrap to however many the company's apps need
  const hud = $('#hud')?.getBoundingClientRect();
  if (hud?.height) $('#toasts').style.top = `${Math.round(hud.bottom + 8)}px`;
  $('#toasts').append(t);
  if (sticky) return t; // stays until tapped
  setTimeout(() => t.classList.add('gone'), 5200);
  setTimeout(() => t.remove(), 5600);
  return t;
}
