// An agent's desk-phone card about a note (hq ask --note), under the note's group on its Notebook page
// (notebookgroups.ts asks): a slip in the answers' look, tinted as an ask, "Lark asks", the card's summary, its Choose:
// as chips and its questions drawn by the desk phone's own fields (questions.js). A tap on a choice answers it; words
// written under it are the card's "anything to add" (or its whole answer, with nothing to choose). It goes to the desk
// phone's own route, so one answer closes the card in both places. Answered, it reads like a ticked slip with the pick.
// A card for a secret, a step or built work never comes here: it stays on the desk phone (bookasks.ts deskOnly). Its
// look: bookasks.css.
import { esc } from '../../util.js';
import { parseCard } from '../card.js';
import { chips, given, inputHtml } from '../questions.js';
import { sfx } from '../audio.js';
import { answerAsk } from './notebookdata.js';
import { names } from '../brand.js';

const ASK_CLIP =
  '<svg class="slip-clip" viewBox="0 0 14 34" aria-hidden="true"><path d="M10 9v15a3.5 3.5 0 0 1-7 0V6a5 5 0 0 1 10 0v19"/></svg>';
const ASK_TICK = '<svg class="ask-tick" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13l5.5 5L21 4"/></svg>';

// A group's cards, under its answers
export const asksHtml = g => (g.asks ?? []).map(askHtml).join('');
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
  )}" placeholder="${free && !asked ? 'Write under it to answer' : 'Or write under it'}"></textarea><p class="ask-foot"><span>The same card is on your ${esc(names.phone)}.</span><button type="button" class="ask-send"${
    asked || free ? '' : ' hidden'
  }>Send</button></p><p class="slip-said" hidden></p></section>`;
}

// The cards under root wired to the desk phone's answer: a choice tapped answers at once (with any words written under
// it, and the questions' answers when it has some); Send, or Enter in the words, answers with what's there.
// dev: on the played store. asks: the cards drawn there, by id. answered(): one answered, for the page to read again.
export function wireAsks(root, { dev, asks, answered }) {
  for (const slip of root.querySelectorAll('.ask-slip:not([data-answered])')) {
    const a = asks.get(Number(slip.dataset.ask));
    if (a) wireAsk(slip, a, { dev, answered });
  }
}
function wireAsk(slip, a, on) {
  const field = slip.querySelector('.ask-words'),
    send = slip.querySelector('.ask-send');
  for (const chip of slip.querySelectorAll('.ask-q .chip')) chip.addEventListener('click', () => toggled(chip, a));
  field.addEventListener('input', () => {
    field.style.height = 'auto';
    field.style.height = `${field.scrollHeight}px`;
    // (with choices to tap, Send shows once there are words to send alone)
    if (!a.questions?.length && slip.querySelector('[data-choice]')) send.hidden = !field.value.trim();
  });
  const go = pick => answer(slip, a, on, pick);
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
async function answer(slip, a, on, pick) {
  const field = slip.querySelector('.ask-words'),
    said = slip.querySelector('.slip-said');
  const tell = text => Object.assign(said, { textContent: text, hidden: !text });
  if (slip.hasAttribute('aria-busy')) return;
  const answers = (a.questions ?? []).map((q, k) => answerIn(slip.querySelector(`[data-q="${k}"]`), q));
  const missing = (a.questions ?? []).findIndex((q, k) => given(q, answers[k]) === null);
  if (missing >= 0) return tell(`Question ${missing + 1} still needs its answer`);
  const words = [pick, field.value.trim()].filter(Boolean).join('\n\n');
  if (!words && pick === undefined && !a.questions?.length) return field.focus();
  slip.setAttribute('aria-busy', 'true');
  tell('Sending…');
  try {
    await answerAsk(on.dev, a.id, words, a.questions?.length ? answers : undefined);
    sfx.jingle();
    field.blur();
    tell('');
    slip.toggleAttribute('data-answered', true);
    for (const el of slip.querySelectorAll('.ask-chips, .ask-q, .ask-words, .ask-foot')) el.remove();
    slip.insertAdjacentHTML('beforeend', `${ASK_TICK}<p class="ask-answer">${esc(words || 'Got it')}</p>`);
    on.answered();
  } catch (e) {
    tell(e.status === 400 ? 'That didn’t go through: a question still needs its answer.' : e.message);
  }
  slip.removeAttribute('aria-busy');
}
// A question's answer as its field holds it: the chip (or chips) on, or the box's words
function answerIn(el, q) {
  if (!chips(q)) return el.querySelector('input')?.value ?? '';
  const on = [...el.querySelectorAll('.chip.on')].map(c => c.dataset.answer);
  return q.many ? on : (on[0] ?? '');
}
