// The answers on a sheet's notes in the book: each slip clipped on under its note (review mode's slip.js draws it, as
// on HQ's page), its tick box, the reply written under it, and a tick written over it with the Pencil. booksheet.js
// puts them in its notes.
import { CSS, isTick, slipHtml, slipUnder, tickBox, wireSlips } from '/__review/slip.js';
import { refreshRail } from './bookrail.js';
import { replySlip, tickSlip } from './booksheetdata.js';
// (the desk phone's cards in the book)
import { ringAround } from '/__review/ring.js';
import { esc } from '../util.js';
import { parseCard } from './card.js';
import { chips, given, inputHtml } from './questions.js';
import { answerRequest } from './data.js';
import { sfx } from './audio.js';
import { inkOf } from './agentink.js';

// The slip's look, once in HQ's document (review mode's own copy lives in its shadow root)
const style = Object.assign(document.createElement('style'), { textContent: CSS });
document.head.append(style);

// A note's slips, under its words
export const slipsHtml = n => (n.slips ?? []).map(s => slipHtml(s, n)).join('');

// The slips on a page view wired to the store; a tick, or a reply, reads the sheets again (the faces' dot, the page)
export function wire(sh, slot) {
  wireSlips(slot, handlers(sh));
}
const handlers = sh => ({
  tick: async (id, ticked) => {
    await tickSlip(sh.dev, id, ticked);
    refreshRail();
  },
  reply: async (id, words) => {
    const answer = await replySlip(sh.dev, id, words);
    refreshRail();
    return answer;
  },
});

// A line drawn with the Pencil over a slip on a sheet page: a tick ticks it (taken back by Undo), and the sheet takes
// the line rather than keeping it as ink. Anything else stays ink.
export function tickLine(sh, v, stroke) {
  if (v.page.kind !== 'sheet' || !isTick(stroke.points)) return false;
  const at = v.el.getBoundingClientRect();
  const slips = [...v.el.querySelectorAll('.answer-slip')].map(el => {
    const r = el.getBoundingClientRect();
    return { el, x: r.left - at.left, y: r.top - at.top, w: r.width, h: r.height };
  });
  const hit = slipUnder(stroke.points, slips);
  if (!hit || hit.el.hasAttribute('data-ticked')) return false;
  const on = handlers(sh);
  const told = e => sh.tell(v.page, e);
  sh.book.steps.push({ undo: () => tickBox(hit.el, on, false).catch(told) });
  tickBox(hit.el, on, true).catch(told);
  return true;
}

// ---- the desk phone's cards about a note or a page, in the book.
// A card an agent filed with hq ask --note (or --page: a page with no note on it) is clipped under that note (or under
// the agent's ring on its sheet page): a slip in the answers' look, tinted as an ask, "Lark asks", the card's summary,
// its Choose: as chips and its questions drawn by the desk phone's own fields (questions.js). A tap on a choice answers
// it; words written under it are the card's "anything to add" (or its whole answer, with nothing to choose). It goes
// to the desk phone's own route, so one answer closes the card in both places. Answered, it reads like a ticked slip
// with the pick. A card the book can't answer (keys, uploads, an approval: bookasks.ts says which) shows its title and
// "Answer on the desk phone".
const ASK_CLIP =
  '<svg class="slip-clip" viewBox="0 0 14 34" aria-hidden="true"><path d="M10 9v15a3.5 3.5 0 0 1-7 0V6a5 5 0 0 1 10 0v19"/></svg>';
const ASK_TICK = '<svg class="ask-tick" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13l5.5 5L21 4"/></svg>';

// A note's cards, under its slips
export const asksHtml = n => (n.asks ?? []).map(askHtml).join('');
// The cards about a page, each under its agent's ring round what it's about, in the agent's ink
export const pageAsksHtml = asks =>
  asks.length
    ? `<section class="bs-asks">${asks
        .map(
          a =>
            `<div class="ask-on" style="--ink: ${inkOf(a.agent ?? '')}"><p class="ask-ringed">${ringHtml(a.id)}${esc(
              a.name ?? 'An agent',
            )} asks about <span class="ask-url">${esc(placeOf(a.page))}</span></p>${askHtml(a)}</div>`,
        )
        .join('')}</section>`
    : '';
// A page's place in words: a page of HQ by its address there, a preview by its name
const placeOf = url => (url.startsWith('/') ? `HQ, ${url}` : URL.canParse(url) ? new URL(url).host.split('.')[0] : url);
// A loop round the line, as a hand draws one (review mode's ring), stretched to it
const ringHtml = seed => {
  const { points } = ringAround({ x: 10, y: 10, w: 280, h: 30 }, '', seed * 2654435761);
  const d = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join('');
  return `<svg class="ask-ring" viewBox="0 0 300 50" preserveAspectRatio="none" aria-hidden="true"><path d="${d}"/></svg>`;
};

function askHtml(a) {
  const c = parseCard(a.body ?? ''),
    said = (c.summary[0] || a.title).trim();
  const by = `<b class="slip-by">${esc(a.name ?? 'An agent')} asks</b>`;
  const head = `${ASK_CLIP}${by}<p class="slip-text">${esc(said)}</p>`;
  const label = `${a.name ?? 'An agent'} asks: ${a.title}`;
  if (a.status === 'answered')
    return `<section class="ask-slip" data-ask="${a.id}" data-answered aria-label="${esc(label)}, answered">${head}${ASK_TICK}<p class="ask-answer">${esc(
      a.answer ?? '',
    )}</p></section>`;
  if (a.desk)
    return `<section class="ask-slip" data-ask="${a.id}" data-desk aria-label="${esc(label)}">${ASK_CLIP}${by}<p class="slip-text">${esc(
      a.title,
    )}</p><p class="ask-foot"><b>Answer on the desk phone</b></p></section>`;
  const choices = c.choices.length ? c.choices.map(ch => ch.label) : c.options;
  const chosen = choices.length
    ? `<div class="ask-chips" role="group" aria-label="Your choice">${choices
        .map(o => `<button type="button" class="chip" data-choice="${esc(o)}" aria-pressed="false">${esc(o)}</button>`)
        .join('')}</div>`
    : a.kind === 'notice'
      ? '<div class="ask-chips"><button type="button" class="chip" data-choice="" aria-pressed="false">Got it</button></div>'
      : '';
  const asked = (a.questions ?? [])
    .map(
      (q, k) =>
        `<div class="ask-q" data-q="${k}"><span class="ask-qt">${esc(q.title)}</span>${
          q.detail ? `<span class="ask-qd">${esc(q.detail)}</span>` : ''
        }<div class="qa">${inputHtml(q, { id: `ask-${a.id}-${k}`, placeholder: q.optional ? 'Optional' : '' })}</div></div>`,
    )
    .join('');
  const free = !choices.length && a.kind !== 'notice';
  return `<section class="ask-slip" data-ask="${a.id}" aria-label="${esc(label)}">${head}${chosen}${asked}<textarea class="ask-words" rows="1" aria-label="${esc(
    `Your answer to ${a.name ?? 'the agent'}`,
  )}" placeholder="${free && !asked ? 'Write under it to answer' : 'Or write under it'}"></textarea><p class="ask-foot"><span>The same card is on your desk phone.</span><button type="button" class="ask-send"${
    asked || free ? '' : ' hidden'
  }>Send</button></p><p class="slip-said" hidden></p></section>`;
}

// The cards under root wired to the desk phone's answer: a choice tapped answers at once (with any words written under
// it, and the questions' answers when it has some); Send, or Enter in the words, answers with what's there.
// dev: dev mode's played store (data.js); asks: the cards drawn there, by id
export function wireAsks(root, dev, asks) {
  for (const slip of root.querySelectorAll('.ask-slip:not([data-answered]):not([data-desk])')) {
    const a = asks.get(Number(slip.dataset.ask));
    if (a) wireAsk(slip, a, dev);
  }
}
function wireAsk(slip, a, dev) {
  const field = slip.querySelector('.ask-words'),
    send = slip.querySelector('.ask-send');
  // (a finger or the Pencil here is the card's: never the book's pan or the page's ink)
  for (const el of slip.querySelectorAll('button, textarea, input'))
    for (const type of ['pointerdown', 'touchstart', 'touchmove']) el.addEventListener(type, e => e.stopPropagation());
  for (const chip of slip.querySelectorAll('.ask-q .chip')) chip.addEventListener('click', () => toggled(chip, a));
  field.addEventListener('input', () => {
    field.style.height = 'auto';
    field.style.height = `${field.scrollHeight}px`;
    // (with choices to tap, Send shows once there are words to send alone)
    if (!a.questions?.length && slip.querySelector('[data-choice]')) send.hidden = !field.value.trim();
  });
  const go = pick => answerAsk(slip, a, dev, pick);
  for (const chip of slip.querySelectorAll('[data-choice]'))
    chip.addEventListener('click', () => {
      chip.classList.add('on');
      chip.setAttribute('aria-pressed', 'true');
      go(chip.dataset.choice);
    });
  send.addEventListener('click', () => go(undefined));
  field.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    go(undefined);
  });
}
// A question's chip tapped: a choice's one on (the others off), a pick-many's on or off
function toggled(chip, a) {
  const q = a.questions[Number(chip.closest('[data-q]').dataset.q)],
    on = !q.many || chip.getAttribute('aria-pressed') !== 'true';
  if (!q.many)
    for (const other of chip.parentElement.querySelectorAll('.chip')) {
      other.classList.remove('on');
      other.setAttribute('aria-pressed', 'false');
    }
  chip.classList.toggle('on', on);
  chip.setAttribute('aria-pressed', String(on));
}
// The card answered as the desk phone answers it (pick: the choice tapped), then shown ticked with the answer; refused,
// the slip says why and stays as it was
async function answerAsk(slip, a, dev, pick) {
  const field = slip.querySelector('.ask-words'),
    said = slip.querySelector('.slip-said');
  const tell = text => Object.assign(said, { textContent: text, hidden: !text });
  if (slip.hasAttribute('aria-busy')) return;
  const answers = (a.questions ?? []).map((q, k) => answerIn(slip.querySelector(`[data-q="${k}"]`), q));
  const missing = (a.questions ?? []).findIndex((q, k) => given(q, answers[k]) === null);
  if (missing >= 0) return tell(`Question ${missing + 1} still needs its answer`);
  const answer = [pick, field.value.trim()].filter(Boolean).join('\n\n');
  if (!answer && pick === undefined && !a.questions?.length) return field.focus();
  slip.setAttribute('aria-busy', 'true');
  tell('Sending…');
  try {
    await answerRequest(dev, a.id, answer, {}, false, undefined, a.questions?.length ? answers : undefined);
    sfx.jingle();
    field.blur();
    tell('');
    slip.toggleAttribute('data-answered', true);
    for (const el of slip.querySelectorAll('.ask-chips, .ask-q, .ask-words, .ask-foot')) el.remove();
    slip.insertAdjacentHTML('beforeend', `${ASK_TICK}<p class="ask-answer">${esc(answer || 'Got it')}</p>`);
    // (the desk phone and the book read their cards again)
    document.dispatchEvent(new CustomEvent('book:changed'));
  } catch (e) {
    tell(/\b400$/.test(e.message) ? 'That didn’t go through: a question still needs its answer.' : e.message);
  }
  slip.removeAttribute('aria-busy');
}
// A question's answer as its field holds it: the chip (or chips) on, or the box's words
function answerIn(el, q) {
  if (!chips(q)) return el.querySelector('input')?.value ?? '';
  const on = [...el.querySelectorAll('.chip.on')].map(c => c.dataset.answer);
  return q.many ? on : (on[0] ?? '');
}
