// Questions as form fields, one engine for every form that asks them: a guest's
// checklist (the coordinator's guests.ts, on its page) and a desk-phone card (hq ask --questions, the phone in desk.js).
// Plain functions, no DOM: the coordinator imports this file from here (as it does card.js), and HQ serves it.
//   A question is { title, detail?, type?, unit?, options?, many? }: a short text (the default), a yes or no ("yes-no"), a
//   number ("number", with a unit like "mm" shown after its box), or a choice of 2 to 8 short options (options, no type).
// With many: true, a choice is a pick-many of 2 to 20 (a deck's numbered changes):
//   every option starts picked, a tap takes one off or puts it back, and none picked is an answer too. A card's only (the
//   guest page's chips post one answer each).
//   Its answer is stored as typed or tapped: "yes" or "no", a number with a point ("3.5"), the option, or the text; a
//   pick-many's, the options picked as a JSON list, in their order ("[]": none).
//   optional: true, a question its reader may leave blank ("What to change, if anything"); the rest need their answer
//   (a pick-many always has one).

import { esc } from '../util.js';

export const MAX_TITLE = 140,
  MAX_DETAIL = 200,
  MAX_OPTIONS = 8,
  MAX_MANY = 20,
  MAX_OPTION = 40,
  MAX_UNIT = 12,
  MAX_ANSWER = 8000,
  MAX_QUESTIONS = 40;
const TYPES = ['text', 'yes-no', 'number'];
// The words a yes-or-no shows, in the reader's language (the guest page's languages; HQ reads English)
export const WORDS = {
  en: { yes: 'Yes', no: 'No', point: '.' },
  nl: { yes: 'Ja', no: 'Nee', point: ',' },
  de: { yes: 'Ja', no: 'Nein', point: ',' },
};
// a stored number as the reader writes it (3,5 in Dutch)
const written = (a, lang) => String(a).replace('.', (WORDS[lang] ?? WORDS.en).point);

const line = (v, max) => (typeof v === 'string' && v.trim() && v.length <= max && !/[\r\n]/.test(v) ? v.trim() : null);

// One question as an agent wrote it: the clean question, or what's wrong with it (worded for the agent to fix)
export function question(q) {
  if (!q || typeof q !== 'object') return 'a question is an object with a title';
  if (!line(q.title, MAX_TITLE)) return `a question's title is one line of up to ${MAX_TITLE} characters`;
  if (q.detail !== undefined && !line(q.detail, MAX_DETAIL))
    return `a question's detail is one line of up to ${MAX_DETAIL} characters`;
  if (q.many !== undefined && (q.many !== true || q.options === undefined))
    return 'many: true makes a choice (options) a pick-many, and goes with options only';
  const most = q.many ? MAX_MANY : MAX_OPTIONS;
  if (q.options !== undefined) {
    const ok =
      Array.isArray(q.options) &&
      q.options.length >= 2 &&
      q.options.length <= most &&
      q.options.every(o => line(o, MAX_OPTION)) &&
      new Set(q.options.map(o => o.trim())).size === q.options.length;
    if (!ok || q.type !== undefined)
      return `options make a question a choice: 2 to ${most} different lines of up to ${MAX_OPTION} characters, and no type`;
  }
  if (q.type !== undefined && !TYPES.includes(q.type))
    return `a question's type is ${TYPES.join(', ')} (or options for a choice)`;
  if (q.unit !== undefined && (q.type !== 'number' || !line(q.unit, MAX_UNIT)))
    return `a unit (up to ${MAX_UNIT} characters, like mm) goes with type number`;
  if (q.optional !== undefined && q.optional !== true && q.optional !== false)
    return 'optional is true for a question that may be left blank (or left out)';
  return {
    title: q.title.trim(),
    ...(q.detail !== undefined ? { detail: q.detail.trim() } : {}),
    ...(q.type && q.type !== 'text' ? { type: q.type } : {}),
    ...(q.unit !== undefined ? { unit: q.unit.trim() } : {}),
    ...(q.options ? { options: q.options.map(o => o.trim()) } : {}),
    ...(q.optional ? { optional: true } : {}),
    ...(q.many ? { many: true } : {}),
  };
}
// A card's questions (hq ask --questions): a list of 1 to 40, or what's wrong, with the question's number
export function questions(list) {
  if (!Array.isArray(list) || !list.length || list.length > MAX_QUESTIONS)
    return `questions are a list of 1 to ${MAX_QUESTIONS}`;
  const out = [];
  for (const [k, q] of list.entries()) {
    const c = question(q);
    if (typeof c === 'string') return `question ${k + 1}: ${c}`;
    out.push(c);
  }
  return out;
}

// An answer as it's stored, or null when it doesn't fit the question: a yes-or-no takes yes or no (in any of WORDS'
// languages), a number takes digits with a point or a comma (3,5 is 3.5), its unit after it or not, a choice one of its options, a text 1 to 8000
// characters
export function answer(q, raw) {
  if (q.many) return picks(q, raw);
  const a = String(raw ?? '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!a || a.length > MAX_ANSWER) return null;
  if (q.options) return q.options.includes(a) ? a : null;
  if (q.type === 'yes-no')
    return (
      Object.values(WORDS)
        .flatMap(w => [
          ['yes', w.yes],
          ['no', w.no],
        ])
        .find(([, word]) => word.toLowerCase() === a.toLowerCase())?.[0] ?? null
    );
  if (q.type === 'number') {
    // (with its unit typed after it too: "3 mm")
    const n = q.unit && a.toLowerCase().endsWith(q.unit.toLowerCase()) ? a.slice(0, -q.unit.length).trim() : a;
    return /^-?\d{1,12}(?:[.,]\d{1,6})?$/.test(n) ? String(Number(n.replace(',', '.'))) : null;
  }
  return a;
}
// An answer as a card takes it: answer()'s, or '' for an optional question left blank (null still refuses one that
// doesn't fit).
export const given = (q, raw) => (q.optional && !q.many && !String(raw ?? '').trim() ? '' : answer(q, raw));
// A pick-many's answer: the options tapped (a list, or its JSON as stored), in the question's order, or null when one
// isn't an option
function picks(q, raw) {
  let list = raw;
  if (typeof raw === 'string')
    try {
      list = JSON.parse(raw);
    } catch {
      return null;
    }
  if (!Array.isArray(list) || list.some(o => !q.options.includes(o))) return null;
  return JSON.stringify(q.options.filter(o => list.includes(o)));
}
// An answer as a person reads it: Yes, 3.5 mm, the option or the text (lang: the reader's, WORDS); a pick-many's, the
// options picked (all of them, or none)
export function said(q, a, lang = 'en') {
  if (a == null || a === '') return '';
  if (q.many) {
    const list = JSON.parse(a);
    return !list.length ? 'none' : `${list.length === q.options.length ? 'all: ' : ''}${list.join('; ')}`;
  }
  if (q.type === 'yes-no') return (WORDS[lang] ?? WORDS.en)[a] ?? a;
  if (q.type === 'number') return `${written(a, lang)}${q.unit ? ` ${q.unit}` : ''}`;
  return a;
}
// A card's answers as the agent reads them: each question with its answer, numbered as they were asked (an optional
// one left blank says so)
export const answerLines = (list, answers) =>
  list
    .map((q, k) => `${k + 1}. ${q.title} → ${said(q, answers[k]) || (q.optional ? '(left blank)' : '(no answer)')}`)
    .join('\n');

// The input for one question, without its label (its form puts that around it): chips to tap for a yes-or-no and a choice,
// a box for a number (its unit after it) or a short text. A pick-many's chips are each on or off (value: the list picked,
// every one when there's none yet).
//   post: the guest page's plain form, where a chip is a submit button that posts its answer (name, value); otherwise (the
//   desk phone) a chip is a toggle its script reads (data-answer, aria-pressed). id: the box's id, for its label.
export function inputHtml(
  q,
  { id = '', name = 'answer', value = '', lang = 'en', post = false, placeholder = '', required = false } = {},
) {
  const w = WORDS[lang] ?? WORDS.en,
    number = q.type === 'number',
    chips =
      q.type === 'yes-no'
        ? [
            ['yes', w.yes],
            ['no', w.no],
          ]
        : q.options?.map(o => [o, o]);
  const on = v => (q.many ? (Array.isArray(value) ? value : q.options).includes(v) : value === v);
  if (chips)
    return chips
      .map(
        ([v, label]) =>
          `<button ${post ? `name="${esc(name)}" value="${esc(v)}"` : `type="button" data-answer="${esc(v)}"`} class="chip${on(v) ? ' on' : ''}" aria-pressed="${on(v)}">${esc(label)}</button>`,
      )
      .join('');
  const box = `<input id="${esc(id)}" name="${esc(name)}" value="${esc(number && value ? written(value, lang) : value)}"${number ? ' inputmode="decimal" autocomplete="off"' : ` maxlength="${MAX_ANSWER}"`}${placeholder ? ` placeholder="${esc(placeholder)}"` : ''}${required ? ' required' : ''}>`;
  return number && q.unit ? `<span class="num">${box}<span class="unit">${esc(q.unit)}</span></span>` : box;
}
// Whether a question is answered by chips (the rest by a box)
export const chips = q => q.type === 'yes-no' || !!q.options;
