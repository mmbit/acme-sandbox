// How the board answers an agent in the book: it writes on a try's versions (a tick, a krul, a cross, a question mark,
// words: just ink, the agent reads it), sent once the pen rests; and it fills in a form's questions and sends them.
import { chips, given, inputHtml, said } from '../questions.js';
import { esc } from '../../util.js';
import { lineOf, pathsOf } from './bookanswerart.js';
import { INK } from './bookwrite.js';
import { word } from './bookscope.js';
import { inkOf } from './agentink.js';

// How long the pen rests before what it wrote goes
const REST_MS = 800;
// The reply's ink: the board's own pen, a little finer than on the page
const REPLY_INK = { color: INK.color, size: 3 };
// Where the pen's wet ink goes: its own strip's (a versions page's frames hold their versions' strips too)
const WET = ':scope > .bk-reply-ink .bk-reply-wet';

// The strip taking the board's pen: strokes that start in it are drawn there and, once the pen has rested REST_MS,
// go as one reply (send(ink): ink in page px, origin() the strip's top-left on the page). takes(e): as wirePen's
export function wireReply(strip, hooks) {
  let resting = 0;
  const pen = wirePen(strip, {
    ...hooks,
    down: () => clearTimeout(resting),
    drew: () => {
      resting = setTimeout(() => {
        sendStrokes(strip, pen.ink(), hooks);
        pen.clear();
      }, REST_MS);
    },
  });
}
// The strip's pen: strokes that start in it are drawn there, wet, and kept (down(): a stroke starts, drew(): one is
// lifted). A press here is the strip's alone, never the page's pan or ink. (takes(e), whether a press is the strip's
// at all, else it's the page's as if the strip weren't there: a versions page's frames take a finger only on a
// version, so the page still moves under one.) Its strokes: ink(), in page px (origin(): the strip's top-left on the
// page) and each stroke's time from its own start; clear() lets them go, their wet ink drawn till the next stroke
// starts or the page is drawn again.
export function wirePen(strip, { takes, origin, down, drew }) {
  const wet = strip.querySelector(WET);
  let strokes = [],
    stroke = null;
  const local = e => {
    const r = strip.getBoundingClientRect(),
      k = r.width / strip.offsetWidth || 1;
    return [(e.clientX - r.left) / k, (e.clientY - r.top) / k, e.pressure || 0.5, Math.round(e.timeStamp)];
  };
  const drawWet = () => (wet.innerHTML = pathsOf([...strokes, ...(stroke ? [stroke] : [])]));
  strip.addEventListener('pointerdown', e => {
    if (e.button > 0 || (takes && !takes(e))) return;
    e.stopPropagation();
    e.preventDefault();
    try {
      strip.setPointerCapture(e.pointerId);
    } catch {
      /* a pointer the browser doesn't track (one a script made): its moves come here all the same */
    }
    down?.();
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
    drew?.();
  };
  strip.addEventListener('pointerup', lift);
  strip.addEventListener('pointercancel', lift);
  for (const type of ['touchstart', 'touchmove'])
    strip.addEventListener(type, e => (stroke || !takes) && e.stopPropagation());
  return {
    ink: () => inPage(strokes, origin()),
    clear: () => {
      strokes = [];
    },
  };
}
// Strokes in the strip's px in the page's (o: the strip's top-left there), each point's time from its stroke's start
const inPage = (strokes, o) =>
  strokes.map(s => ({ ...s, points: s.points.map(([x, y, p, t]) => [x + o.x, y + o.y, p, t - s.points[0][3]]) }));
// What the pen wrote in the strip sent as one reply; refused, it says why there and the ink goes
async function sendStrokes(strip, ink, { send, refused, done }) {
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
        }<div class="qa">${inputHtml(q, { id: `bk-q-${a.id}-${k}`, placeholder: q.optional ? word('optional') : '' })}</div></div>`,
    )
    .join('');
  return `<div class="bk-answer-form">${asked}<p class="bk-answer-foot"><span class="bk-answer-said" role="status"></span><button type="button" class="bk-answer-send">${word('send')}</button></p></div>`;
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
    if (missing >= 0) return tell(word('questionUnanswered', { n: missing + 1 }));
    button.disabled = true;
    tell(word('sending'));
    try {
      await send(answers);
      tell('');
    } catch (e) {
      tell(e.message);
      button.disabled = false;
    }
  });
}
// The forms and their focused control kept across a redraw
export function formsIn(layer) {
  const focused = document.activeElement;
  return {
    drawn: new Map(
      [...layer.querySelectorAll('.answer-slip .bk-answer-form')].map(f => [
        Number(f.closest('[data-slip]').dataset.slip),
        f,
      ]),
    ),
    focused: layer.contains(focused) && focused.closest('.bk-answer-form') ? focused : null,
  };
}
// The slips' forms on a page's layer in their agents' ink, their answers going with send(answer, answers), a promise
// (wireForm). Keep an unchanged form's element and listeners so a page read preserves its unfinished answers and
// submission.
export function wireForms(page, layer, { drawn, focused }, send) {
  const answers = new Map(
    [...(page.groups?.values() ?? [])]
      .flatMap(g => g.children ?? [])
      .filter(c => c.kind === 'answer')
      .map(c => [c.id, c]),
  );
  for (const form of layer.querySelectorAll('.answer-slip .bk-answer-form')) {
    const a = answers.get(Number(form.closest('[data-slip]').dataset.slip));
    const key = JSON.stringify([a.form, a.form_answer]),
      previous = drawn.get(a.id);
    if (previous?.answerKey === key) {
      form.replaceWith(previous);
      continue;
    }
    form.answerKey = key;
    form.style.setProperty('--ink', inkOf(a.by));
    wireForm(form, a, sent => send(a, sent));
  }
  if (focused?.isConnected) focused.focus({ preventScroll: true });
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
