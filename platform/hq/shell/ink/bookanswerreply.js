// How the board answers an agent's answer in the book: it writes in the light ruled strip under it (a tick, a krul, a
// cross, a question mark, words: just ink, the agent reads it), sent once the pen rests; and it fills in a form's
// questions and sends them.
import { chips, given, inputHtml, said } from '../questions.js';
import { esc } from '../../util.js';
import { lineOf, pathsOf } from './bookanswerart.js';
import { INK } from './bookwrite.js';
import { word } from './bookscope.js';

// How long the pen rests before what it wrote goes
const REST_MS = 800;
// The reply's ink: the board's own pen, a little finer than on the page
const REPLY_INK = { color: INK.color, size: 3 };
// Where the pen's wet ink goes: its own strip's (a versions page's frames hold their versions' strips too)
const WET = ':scope > .bk-reply-ink .bk-reply-wet';

// The strip's markup: its sent replies' ink (page px, put in place by fitReplies) and room to write
export const replyHtml = (replies, label) =>
  `<div class="bk-answer-reply" role="img" aria-label="${esc(label)}" data-hint="${esc(word('reply'))}"><svg class="bk-reply-ink" aria-hidden="true"><g class="bk-reply-sent">${pathsOf(
    replies.flatMap(r => r.ink ?? []),
  )}</g><g class="bk-reply-wet"></g></svg></div>`;

// The sent replies' ink put where it was written: page px less the strip's own top-left on the page (origin), and the
// strip as tall as what's in it
export function fitReplies(strip, origin) {
  const sent = strip.querySelector('.bk-reply-sent');
  sent.setAttribute('transform', `translate(${-origin.x} ${-origin.y})`);
  const box = sent.getBBox();
  strip.style.minHeight = sent.childElementCount ? `${Math.ceil(box.y + box.height - origin.y + 14)}px` : '';
}

// The strip taking the board's pen: strokes that start in it are drawn there and, once the pen has rested REST_MS,
// go as one reply (send(ink): ink in page px, origin() the strip's top-left on the page). A press here is the
// strip's alone, never the page's pan or ink. (takes(e), whether a press is
// the strip's at all, else it's the page's as if the strip weren't there: a versions page's frames take a finger only
// on a version, so the page still moves under one)
export function wireReply(strip, hooks) {
  const wet = strip.querySelector(WET);
  let strokes = [],
    stroke = null,
    resting = 0;
  const local = e => {
    const r = strip.getBoundingClientRect(),
      k = r.width / strip.offsetWidth || 1;
    return [(e.clientX - r.left) / k, (e.clientY - r.top) / k, e.pressure || 0.5, Math.round(e.timeStamp)];
  };
  const drawWet = () => (wet.innerHTML = pathsOf([...strokes, ...(stroke ? [stroke] : [])]));
  strip.addEventListener('pointerdown', e => {
    if (e.button > 0 || (hooks.takes && !hooks.takes(e))) return;
    e.stopPropagation();
    e.preventDefault();
    try {
      strip.setPointerCapture(e.pointerId);
    } catch {
      /* a pointer the browser doesn't track (one a script made): its moves come here all the same */
    }
    clearTimeout(resting);
    strip.toggleAttribute('data-inking', true); // (till it's gone)
    stroke = { ...REPLY_INK, points: [local(e)] };
    drawWet();
  });
  strip.addEventListener('pointermove', e => {
    if (!stroke) return;
    e.stopPropagation();
    stroke.points.push(local(e));
    wet.lastElementChild?.setAttribute('d', lineOf(stroke.points));
  });
  const lift = e => {
    if (!stroke) return;
    e.stopPropagation();
    strokes.push(stroke);
    stroke = null;
    resting = setTimeout(() => {
      sendStrokes(strip, strokes, hooks);
      strokes = [];
    }, REST_MS);
  };
  strip.addEventListener('pointerup', lift);
  strip.addEventListener('pointercancel', lift);
  for (const type of ['touchstart', 'touchmove'])
    strip.addEventListener(type, e => (stroke || !hooks.takes) && e.stopPropagation());
}
// What the pen wrote in the strip sent as one reply, in page px and each stroke's time from its own start; refused,
// it says why there and the ink goes
async function sendStrokes(strip, strokes, { origin, send, refused, done }) {
  const o = origin(),
    ink = strokes.map(s => ({
      ...s,
      points: s.points.map(([x, y, p, t]) => [x + o.x, y + o.y, p, t - s.points[0][3]]),
    }));
  strip.toggleAttribute('data-sending', true);
  try {
    await send(ink);
  } catch (e) {
    refused(e.message);
    strip.querySelector(WET).innerHTML = '';
  }
  strip.removeAttribute('data-sending');
  strip.removeAttribute('data-inking');
  done?.();
}

// ---- a form

// A form's questions as questions.js draws them, and Send; answered, its answers as said
export function formHtml(a) {
  if (a.form_answer)
    return `<dl class="bk-answer-form" data-answered>${a.form
      .map((q, k) => `<dt>${esc(q.title)}</dt><dd>${esc(said(q, a.form_answer[k]) || '—')}</dd>`)
      .join('')}</dl>`;
  const asked = a.form
    .map(
      (q, k) =>
        `<div class="bk-answer-q" data-q="${k}"><label class="bk-answer-qt" for="bk-q-${a.id}-${k}">${esc(q.title)}</label>${
          q.detail ? `<span class="bk-answer-qd">${esc(q.detail)}</span>` : ''
        }<div class="qa">${inputHtml(q, { id: `bk-q-${a.id}-${k}`, placeholder: q.optional ? word('Optional') : '' })}</div></div>`,
    )
    .join('');
  return `<div class="bk-answer-form">${asked}<p class="bk-answer-foot"><span class="bk-answer-said" role="status"></span><button type="button" class="bk-answer-send">${word('Send')}</button></p></div>`;
}

// The form's chips and Send: the answers, each checked, go with send(answers); refused, it says why there
export function wireForm(form, a, send) {
  if (form.hasAttribute('data-answered')) return;
  for (const el of form.querySelectorAll('button, input'))
    for (const type of ['pointerdown', 'touchstart', 'touchmove']) el.addEventListener(type, e => e.stopPropagation());
  for (const chip of form.querySelectorAll('.chip')) chip.addEventListener('click', () => toggled(chip, a));
  const tell = text => (form.querySelector('.bk-answer-said').textContent = text);
  const button = form.querySelector('.bk-answer-send');
  button.addEventListener('click', async () => {
    const answers = a.form.map((q, k) => answerIn(form.querySelector(`[data-q="${k}"]`), q));
    const missing = a.form.findIndex((q, k) => given(q, answers[k]) === null);
    if (missing >= 0) return tell(word('Question {n} still needs its answer', { n: missing + 1 }));
    button.disabled = true;
    tell(word('Sending…'));
    try {
      await send(answers);
      tell('');
    } catch (e) {
      tell(e.message);
      button.disabled = false;
    }
  });
}
// A chip tapped: a choice's one on (the others off), a pick-many's on or off
function toggled(chip, a) {
  const q = a.form[Number(chip.closest('[data-q]').dataset.q)],
    on = !q.many || chip.getAttribute('aria-pressed') !== 'true';
  if (!q.many)
    for (const other of chip.parentElement.querySelectorAll('.chip')) {
      other.classList.remove('on');
      other.setAttribute('aria-pressed', 'false');
    }
  chip.classList.toggle('on', on);
  chip.setAttribute('aria-pressed', String(on));
}
// A question's answer as its field holds it: the chip (or chips) on, or the box's words
function answerIn(el, q) {
  if (!chips(q)) return el.querySelector('input')?.value ?? '';
  const on = [...el.querySelectorAll('.chip.on')].map(c => c.dataset.answer);
  return q.many ? on : (on[0] ?? '');
}
