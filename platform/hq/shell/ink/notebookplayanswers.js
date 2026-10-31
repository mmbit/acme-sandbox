// The Notebook store's answers, played (notebookplay.js): the agents' answers on a group as HQ reads them with it
// (groupanswers.ts answersOf: its children, the answer still coming, its try), a form answered and an answer ticked or
// a version picked (bookanswer.ts answerForm and tickAnswer, bookpick.ts pick), the open list (bookanswer.ts
// openList) and a card under a group answered on the desk phone, with the coordinator's answers and refusals. The runs
// an answer comes from aren't played: a seeded group (or play.asking and play.trying) says where they are.
//   - group.asking: its owner's quick run going, { by, spot, reason? } (bookslips.ts comingOf); an answer on the group
//     ends it.
//   - group.tried: its try run, { by, expect, going, said? } (booktry.ts): going while it makes versions, said its last
//     line once it ended (groupanswers.ts endedEmpty).
import { given } from '../questions.js';
import { refuse } from './notebookplaychecks.js';

// What an answer is unless it says otherwise (bookslips.ts slipOf)
const SLIP = { note: null, grp: null, text: '', picture: null, link: null, preview: null, now: null, now_at: null };
Object.assign(SLIP, { ticked: null, face: null, style: 'text', ink: null, form: null, form_answer: null });
Object.assign(SLIP, { version: null, patch: false, spot: null, picked: null, source: null, branch: null });
Object.assign(SLIP, { crossed: null, cleared: null, branch_failed: null });
export const slipRow = (s, x) => ({ ...SLIP, ...x, name: x.name ?? s.name(x.by) });

// A group's run said where it is (play.asking, play.trying): run, its asking or tried
export function ran(s, group, run) {
  const g = s.group(Number(group));
  if (!g) throw new Error(`no group ${group}`);
  Object.assign(g, run);
  s.changed(s.page(g.page).notebook, g.page);
}

export const ANSWER_ROUTES = {
  'POST /api/notebooks/answers/form': answerForm,
  'POST /api/notebooks/answers/tick': tickAnswer,
  'GET /api/notebooks/open': openList,
  'POST /api/requests/answer': answerAsk,
};

// A group's answers (on the notes it and its replies went as, or on the groups themselves, each once), the answer
// still coming on it or a reply of its, its try and the cards on its notes: { answers, waiting, try, asks }
export function answersOf(s, g, replies) {
  const notes = [g, ...replies].flatMap(x => (x.note ? [x.note] : [])),
    ids = [g, ...replies].map(x => x.id);
  const answers = s.slips.filter(a => notes.includes(a.note) || ids.includes(a.grp));
  const top = g.parent === null;
  return {
    answers,
    waiting: top ? ([g, ...replies].map(x => x.asking && comingOf(s, x.asking)).find(w => w) ?? null) : null,
    try: top ? tryOf(s, g, answers) : null,
    // (or the design ask it is, on an Asks page: askpages.ts, its group.)
    asks: [...notes.flatMap(n => s.asks.filter(a => a.note === n)), ...s.asks.filter(a => a.group === g.id)],
  };
}
const comingOf = (s, { by, spot, reason }) => ({
  by,
  name: s.name(by),
  spot: spot ?? null,
  style: 'text',
  ...(reason && { reason }),
});
function tryOf(s, g, answers) {
  if (!g.tried) return null;
  const { by, expect, going, said } = g.tried,
    name = s.name(by);
  const state = going ? 'coming' : answers.some(a => a.style === 'version') ? 'made' : 'empty';
  const reason = said
    ? `${name} made no version: ${said}`
    : `${name}'s try ended without a version. Write on the scrap to ask again.`;
  return { state, expect, by, name, reason: state === 'empty' ? reason : null };
}

// The group an answer is on, unless it's deleted: its own (grp), else the group its note went as (notebookgroups.ts
// groupOn)
export function groupOn(s, slip) {
  const g = slip.grp !== null ? s.group(slip.grp) : s.groups.find(x => x.note !== null && x.note === slip.note);
  return g?.deleted === null ? g : undefined;
}
// The top group of a group or reply
export const rootOf = (s, g) => (g.parent === null ? g : s.group(g.parent));
// The answer on a group's page read again, as every change is (notebook.ts changed)
function changedOn(s, slip) {
  const g = groupOn(s, slip);
  const p = g && s.page(rootOf(s, g).page);
  if (p) s.changed(p.notebook, p.id);
}
const slipById = (s, v) => s.slips.find(x => x.id === Number(v));

// The board's answers to an answer's form, kept (its reply note goes to the agent on a sheet of its own: the old
// book's, not the notebook's)
function answerForm(s, b) {
  const slip = slipById(s, b?.id);
  if (!slip?.form) refuse(404);
  if (slip.grp !== null && !groupOn(s, slip)) refuse(404);
  if (slip.form_answer) refuse(409, 'this form has been answered');
  if (!Array.isArray(b.answers) || b.answers.length !== slip.form.length)
    refuse(400, 'answers is one answer per question, in their order');
  const answers = slip.form.map((q, k) => given(q, b.answers[k]));
  const wrong = answers.findIndex(a => a === null);
  if (wrong >= 0) refuse(400, `question ${wrong + 1}: that answer doesn't fit it`);
  slip.form_answer = answers;
  changedOn(s, slip);
  return { answer: { ...slip } };
}
// A tick closes an answer; on a version it picks it, the rest of its set not (false: open again, unpicked)
function tickAnswer(s, b) {
  const slip = slipById(s, b?.id);
  if (!slip) refuse(404);
  if (typeof b.ticked !== 'boolean') refuse(400, 'ticked is true or false');
  const when = b.ticked ? s.stamp() : null;
  if (slip.style === 'version' && when) pick(s, slip, when);
  else slip[slip.style === 'version' ? 'picked' : 'ticked'] = when;
  changedOn(s, slip);
  return { answer: { ...slip } };
}
// A version picked, the rest of its set not (picked already, or cleared: nothing new)
function pick(s, v, when) {
  if (v.picked || v.cleared) return;
  for (const x of s.slips)
    if (
      x.style === 'version' &&
      (x === v || (v.grp !== null && x.grp === v.grp) || (v.note !== null && x.note === v.note))
    )
      Object.assign(x, x === v ? { picked: when, crossed: null } : { picked: null });
}
// What waits on the board: forms not answered yet, and questions with no reply or tick yet, oldest first; none on a
// deleted group
function openList(s) {
  const open = s.slips
    .filter(x => x.ticked === null && x.picked === null)
    .filter(
      x =>
        (x.form && !x.form_answer) ||
        (x.style === 'question' && !s.groups.some(r => r.answers === x.id && r.deleted === null)),
    )
    .filter(x => x.grp === null || groupOn(s, x))
    .sort((a, b) => a.id - b.id);
  const items = open.map(x => [!!x.form, itemOf(s, x)]);
  return {
    forms: items.filter(([form]) => form).map(([, i]) => i),
    questions: items.filter(([form]) => !form).map(([, i]) => i),
  };
}
function itemOf(s, x) {
  const g = groupOn(s, x),
    top = g && rootOf(s, g),
    p = top && s.page(top.page);
  return {
    ...{ id: x.id, group: top?.id ?? null, page: p?.id ?? null, notebook: p?.notebook ?? null },
    ...{ day: p?.created.slice(0, 10) ?? null, by: x.by, name: x.name, text: x.text, created: x.created },
  };
}
// The desk phone's answer to a card (jobs.ts answerRequest), for one under a group: answered, its group's page read
// again. Its questions all answered first (an optional one may be blank), as the desk phone's own route refuses.
function answerAsk(s, b) {
  const a = s.asks.find(x => x.id === Number(b?.id) && x.status === 'open');
  if (!a) refuse(404);
  if ((a.questions ?? []).some((q, k) => !q.optional && !String(b.answers?.[k] ?? '').trim()))
    refuse(400, 'a question still needs its answer');
  Object.assign(a, { status: 'answered', answer: String(b.answer ?? ''), answered: s.stamp() });
  const g = s.groups.find(x => (a.group ? x.id === a.group : x.note === a.note));
  if (g) s.changed(s.page(g.page).notebook, g.page);
  return { ok: true };
}
