// A second device signs into the same Notebook with a one-time code. Sign in another device shows it, in the book bar's
// dots menu after Preferences (bookcontrols.js).
import { stylesheet } from '../../util.js';
import { act } from '../data.js';
import { qrCode, qrPath } from '/shared/qr/qr.js';
import { button, island, lineIcon } from './bookui.js';

// (a phone with a code on its screen)
const DEVICE = lineIcon(
  '<rect x="6.5" y="2.5" width="11" height="19" rx="2.4"/><path d="M10.5 18.5h3"/><path d="M9.5 8.5h2v2h-2zM12.5 8.5h2v2h-2zM9.5 11.5h2v2h-2z" stroke-width="1.3"/>',
);

export function initPair() {
  const leaf = document.querySelector('#book .bk-leaf');
  if (!leaf || !document.querySelector('#book .bk-rail')) return;
  stylesheet('shell/ink/pair.css');
  const card = document.createElement('section');
  card.className = 'pair-card bk-card';
  card.hidden = true;
  card.setAttribute('aria-label', 'Sign in another device');
  // its code signs a device in as the board: never in a call's recording (shared/watchalong).
  card.setAttribute('data-watchalong-hide', '');
  leaf.append(card);
  const row = button({
    icon: DEVICE,
    label: 'Sign in another device',
    onClick: () => {
      if (!card.hidden) {
        card.hidden = true;
        return;
      }
      showCode(card);
    },
  });
  island('book').querySelector('.bk-cog').after(row);
}

// A one-time sign-in code for another device ({ code, expires }) and the link its QR carries. view: a preview's
// address the device opens in HQ's viewer once signed in (viewer.js), or none for HQ as it opens.
export async function pairLink(view = null) {
  const code = await act('/api/notebooks/pair', {});
  return {
    ...code,
    link: `${location.origin}/pair#${new URLSearchParams({ code: code.code, ...(view && { view }) })}`,
  };
}
export function qrSvg(link, label) {
  const qr = qrCode(link, { level: 'M' }),
    n = qr.size + 8;
  return `<svg class="pair-qr" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="${label}"><rect width="${n}" height="${n}" fill="#fff"/><path fill="#000" d="${qrPath(qr)}"/></svg>`;
}

async function showCode(card) {
  card.hidden = false;
  card.innerHTML = '<p>Making a one-time sign-in code…</p>';
  try {
    const pairing = await pairLink();
    card.innerHTML = `<b class="pair-head">Sign in another device</b>
      ${qrSvg(pairing.link, 'Scan to sign in')}
      <p class="pair-words">Scan this code, or open <a href="/pair">${location.host}/pair</a> and enter <b class="pair-digits"></b>. Good once, for a minute. Your Notebook syncs after sign-in.</p>`;
    card.querySelector('.pair-digits').textContent = pairing.code;
    const close = button({
      text: 'Close',
      onClick: () => {
        card.hidden = true;
      },
    });
    card.append(close);
    setTimeout(
      () => {
        if (!card.isConnected) return;
        card.querySelector('.pair-digits')?.replaceChildren(document.createTextNode('Expired'));
      },
      Math.max(0, pairing.expires - Date.now()),
    );
  } catch (error) {
    card.textContent = error.message;
  }
}
