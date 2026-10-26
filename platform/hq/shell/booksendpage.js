// A free page sent to anyone: its head has the sheet's paper plane too. A tap fans out a row of faces (the rail's first,
// then every agent); picking one sends the page as it is, with the same ten seconds to undo, then "Sent to Kit 15:31".
import { esc } from '../util.js';
import * as world from '../world/world.js';
import { portrait } from './bookrail.js';
import { facesOf } from './bookfaces.js';
import { sendPage } from './booksheetdata.js';
import { pageSends, sendOrder, sentLine } from './booksheetplace.js';
import { PLANE, flightHtml, sendNow, undoNow } from './bookplane.js';

export function mountPageSend(sh) {
  // a tap anywhere else puts the faces away
  addEventListener('pointerdown', e => {
    if (!e.target.closest?.('.bs-pick, .bs-plane'))
      for (const p of document.querySelectorAll('#book .bs-pick')) p.remove();
  });
  return { draw: v => draw(sh, v) };
}

function draw(sh, v) {
  const at = v.el.querySelector('[data-slot=plane]');
  // (a blank page has nothing to send: it's kept once it's written on)
  if (!at || !v.page.id) return;
  if (at.querySelector('.bs-pick')) return;
  const { sending, sent } = pageSends(sh.sheets, v.page.id);
  at.innerHTML = sending
    ? flightHtml(sh, sending, sh.name(sending.owner))
    : `<button class="bs-plane" aria-label="Send this page to someone" title="Send this page">${PLANE}</button>${
        sent
          ? `<span class="bs-stamp">${esc(sentLine(sent.sent, new Date(), `Sent to ${sh.name(sent.owner)}`))}</span>`
          : ''
      }`;
  at.onpointerdown = e => e.stopPropagation();
  at.onclick = e => {
    const who = e.target.closest('[data-to]'),
      back = e.target.closest('[data-undo]');
    if (back) return undoNow(sh, v, sh.sheet(back.dataset.undo));
    if (who) {
      at.querySelector('.bs-pick')?.remove();
      const plane = at.querySelector('.bs-plane');
      return sendNow(sh, v, { id: 0, owner: who.dataset.to }, plane, () => sendPage(sh.dev, v.page.id, who.dataset.to));
    }
    if (e.target.closest('.bs-plane')) pick(sh, at);
  };
}
// The faces to send it to, fanned out under the plane: the rail's first, then everyone else by name
function pick(sh, at) {
  if (at.querySelector('.bs-pick')) return at.querySelector('.bs-pick').remove();
  const agents = [...(world.agents?.keys() ?? [])].map(id => ({ id, name: sh.name(id) })),
    faces = facesOf(sh.sheets, sh.ceo()).map(f => f.id);
  const row = document.createElement('div');
  row.className = 'bs-pick';
  row.innerHTML = sendOrder(agents, faces)
    .map(({ id, name }) => {
      const face = portrait(id);
      return `<button data-to="${esc(id)}" aria-label="Send to ${esc(name)}" title="${esc(name)}"><i${
        face ? ` style="background-image:url(${face})"` : ''
      }>${face ? '' : esc(name[0] ?? '')}</i><span>${esc(name)}</span></button>`;
    })
    .join('');
  at.append(row);
  row.animate(
    [
      { opacity: 0, transform: 'translateY(-6px) scale(0.96)' },
      { opacity: 1, transform: 'none' },
    ],
    {
      duration: 160,
      easing: 'ease-out',
    },
  );
}
