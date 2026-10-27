// The intake's cards on the CEO's intercom lines (the coordinator's chat.ts card, set by hq intake), each drawn under its
// line until the board says something after it. What runs by itself: switches with the CEO's picks set, flipped here and
// sent as they stand by the intercom's one Send (switchesLine), which folds the card into the board's line, each switch by
// its name as said in a sentence. The ask keys: the manual's (tips.js ASKS), each starting the board's sentence.
import { esc, stylesheet } from '../util.js';
import { sfx } from './audio.js';
import { ASKS } from './tips.js';

stylesheet('shell/intake.css');
// Each card's switches as the board has flipped them, by its line's id: kept while the chat repaints
const flipped = new Map();

// The card at messages[i], while nothing the board said follows it
const open = (messages, i) => !!messages[i].card && !messages.slice(i + 1).some(m => m.who === 'board');
const switchesOf = m => flipped.get(m.id) ?? m.card.switches.map(s => s.on);

export function intakeCardHtml(messages, i) {
  if (!open(messages, i)) return '';
  const m = messages[i],
    c = m.card;
  if (c.kind === 'asks')
    return `<li class="intake asks">${ASKS.map((a, k) => `<button type="button" data-ask="${k}">${esc(a.key)}</button>`).join('')}</li>`;
  const on = switchesOf(m);
  return `<li class="ceo intake switches" data-card="${m.id}"><b class="title">${esc(c.title)}</b>${c.switches
    .map(
      (s, k) =>
        `<div class="sw"><span id="sw-${m.id}-${k}"><b>${esc(s.name)}</b><small>${esc(s.what)}</small></span><button type="button" class="switch" role="switch" data-sw="${k}" aria-checked="${on[k]}" aria-labelledby="sw-${m.id}-${k}"><i></i></button></div>`,
    )
    .join('')}${c.note ? `<p class="note">${esc(c.note)}</p>` : ''}</li>`;
}

// start(words): the intercom with the board's sentence started
export function wireCards(list, messages, start) {
  list
    .querySelectorAll('.intake [data-ask]')
    .forEach(b => (b.onclick = () => (sfx.press(), start(ASKS[+b.dataset.ask].starts))));
  list.querySelectorAll('.intake[data-card]').forEach(card => {
    const m = messages.find(l => String(l.id) === card.dataset.card);
    card.querySelectorAll('[data-sw]').forEach(
      b =>
        (b.onclick = () => {
          const on = [...switchesOf(m)];
          on[+b.dataset.sw] = !on[+b.dataset.sw];
          flipped.set(m.id, on);
          b.setAttribute('aria-checked', on[+b.dataset.sw]);
          sfx.toggle(on[+b.dataset.sw]);
        }),
    );
  });
}

// The board's line for the open switches card, as they stand ('' with none open): its words for what's on, or for none
export function switchesLine(messages) {
  const i = messages.findLastIndex(m => m.card?.kind === 'switches');
  if (i < 0 || !open(messages, i)) return '';
  const m = messages[i],
    on = switchesOf(m),
    names = m.card.switches.filter((s, k) => on[k]).map(s => s.said ?? s.name);
  return names.length ? `${m.card.says}: ${names.join(', ')}.` : m.card.none;
}
