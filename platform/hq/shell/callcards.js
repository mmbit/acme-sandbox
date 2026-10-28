// A call's card over HQ and the call alike, recorded as the board sees it: the call engine's (calldrive.js, and Ink's
// calldraw.js on it), so the engine reads nothing of Ink. (was calldraw.js's)
const $ = s => document.querySelector(s);

export function cardOf(c, kind) {
  let box = $('#call-cards');
  if (!box) {
    box = Object.assign(document.createElement('div'), { id: 'call-cards' });
    document.body.append(box);
  }
  box.querySelector(`[data-card="${kind}"]`)?.remove();
  const card = Object.assign(document.createElement('div'), { className: 'toast call-card' });
  card.dataset.card = kind;
  card.setAttribute('role', 'status'); // (read out as it comes, and nothing waits on it)
  box.append(card);
  return card;
}
