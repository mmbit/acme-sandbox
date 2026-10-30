// A second device signs into the same Notebook with a one-time code.
import { stylesheet } from '../../util.js';
import { act } from '../data.js';
import { qrCode, qrPath } from '/shared/qr/qr.js';
import { button, island } from './bookui.js';

export function initPair() {
  const leaf = document.querySelector('#book .bk-leaf');
  if (!leaf || !document.querySelector('#book .bk-rail')) return;
  stylesheet('shell/ink/pair.css');
  const card = document.createElement('section');
  card.className = 'pair-card bk-card';
  card.hidden = true;
  card.setAttribute('aria-label', 'Sign in another device');
  leaf.append(card);
  const shortcut = button({
    text: 'Devices',
    label: 'Sign in another device',
    onClick: () => {
      if (!card.hidden) {
        card.hidden = true;
        return;
      }
      showCode(card);
    },
  });
  island('overview').append(shortcut);
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
