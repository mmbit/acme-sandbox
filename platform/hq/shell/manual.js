// The manual: How HQ works, the Library's first shelf. Every tip whether it has come or not, the ones with a film as tiles
// and the rest as keys, each opening its card (tipcard.js) with Show me; and Things you can ask for, keys that open the
// intercom with the board's sentence started.
import { esc, cap, stylesheet } from '../util.js';
import { sfx } from './audio.js';
import { ASKS, tipOf } from './tips.js';
import { tipHtml, cardAbout, wireTip, runTip, stillAddress } from './tipcard.js';
import { show, body, closePanel } from './panel.js';
import { openPhone, openComputer, openIntercomWith, closeTool, waitingCards, ceoName } from './desk.js';
import { names } from './brand.js'; // (and the tips in its names)

stylesheet('shell/tips.css');
// Four as tiles, each with its film's still (tip-films.mjs cuts one per look), then the rest as keys, the desk phone's
// first (its tip has no film). A tile whose still the company doesn't have joins the keys, as text only. Asking for anything is the shelf's second half.
const TILES = ['artifact', 'machines', 'look', 'notifications'],
  KEYS = ['deskphone', 'endnow', 'pin', 'calls', 'deadlines', 'seats'];
const named = key => esc(tipOf(key, names).name);

export function manualHtml() {
  const stills = TILES.filter(key => stillAddress(tipOf(key, names))),
    keys = [...KEYS, ...TILES.filter(key => !stills.includes(key))];
  // (a tap on the still opens its card, where the film plays)
  const tile = key =>
    `<li><button type="button" class="frame" data-tip="${key}" aria-label="${named(key)}"><img src="${esc(stillAddress(tipOf(key, names)))}" alt="" loading="lazy"><i class="play" aria-hidden="true"></i></button>` +
    `<b>${named(key)}</b><button type="button" class="show" data-show="${key}">Show me ›</button></li>`;
  return `<section class="manual"><h3>How HQ works</h3>${stills.length ? `<ul class="tiles">${stills.map(tile).join('')}</ul>` : ''}
    <p class="keys">${keys.map(k => `<button type="button" data-tip="${k}">${named(k)}</button>`).join('')}</p>
    <h3>Things you can ask for</h3><p class="lead">Ask ${esc(cap(ceoName()))} on the ${esc(names.intercom)}, in your own words. A tap starts the sentence for you.</p>
    <p class="keys asks">${ASKS.map((a, i) => `<button type="button" data-ask="${i}">${esc(a.key)}</button>`).join('')}</p></section>`;
}

// back: the Library as it was
export function wireManual(el, back) {
  el.querySelectorAll('.manual [data-tip]').forEach(b => (b.onclick = () => openTip(b.dataset.tip, back)));
  el.querySelectorAll('.manual [data-show]').forEach(
    b => (b.onclick = () => runTip(tipOf(b.dataset.show, names), {}, phone())),
  );
  el.querySelectorAll('.manual [data-ask]').forEach(
    b =>
      (b.onclick = () => {
        sfx.press();
        closePanel();
        openIntercomWith(ASKS[+b.dataset.ask].starts);
      }),
  );
}

// Show me from here: the panel makes way, and there's nothing to file after. A tip about the desk phone opens it on the
// card it's about (card: its id).
const phone = card => ({
  close: () => (closePanel(), closeTool()),
  open: where => (closePanel(), openComputer(where.app, where)),
  toCard: () => (closePanel(), openPhone(card)),
  end: () => {},
});

// A tip's card, as the desk phone shows it, in the Library: Got it goes back to the shelf
function openTip(key, back) {
  const tip = tipOf(key, names),
    r = { id: `manual:${key}`, tip: key, title: tip.name, body: tip.lines(), details: {} },
    cards = waitingCards(),
    about = cardAbout(r, cards);
  show('tip', `<button class="back">← Back</button>${tipHtml(r, 'How HQ works', about)}`, key);
  body.querySelector('.back').onclick = back;
  wireTip(body, r, phone(cards[about]?.id));
  body.querySelector('[data-got]').onclick = () => (sfx.press(), back());
}
