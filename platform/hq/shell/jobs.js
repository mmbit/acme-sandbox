// Jobs as the board reads them, shared by the projects view (projects.js, threads.js, jobsheet.js), the HUD's line and
// the looks: a job's state and its chip's word, where it is now in words, what another waits for, and a title with its
// asides quieter.
import { esc } from '../util.js';
import { withJobLinks } from './prose.js';
import { timeOf } from '../world/clock.js';
import { loadJobs, loadSchedule } from './data.js';
import { engineName } from './engine.js';

// Where a job is, as the board reads it: its chip's word, and whether it's active, waiting or done
export const state = j => j.status === 'queued' ? (j.paused ? 'paused' : j.ready ? 'next' : holdsOf(j).length ? 'waits' : 'later') : j.status;
export const CHIP = { running: 'working', blocked: 'for you', paused: 'paused', next: 'next', waits: 'waits', later: 'later' };
export const tabOf = j => j.status === 'running' ? 'active' : j.status === 'queued' || j.status === 'blocked' ? 'waiting' : 'done';
// The job another waits for: where it is now, or how a further wait's job ended without merged work
export const AFTER = { queued: 'not started yet', running: 'being worked on', board: 'waiting for you', review: 'in review', call: 'waiting for your call',
  unmerged: 'finished without merged work', failed: 'stopped with an error', cancelled: 'cancelled' };
// A title quoted inside another job's line: the opening, marked when it's cut (the whole of it is on that job's own row)
const cut = (t, n = 60) => t.length <= n ? t : `${t.slice(0, n).replace(/\s+\S*$/, '')}…`;
// A title's own words, with what's around them quieter: a review loop job's step before the work's title it carries
// (jobs.step, from review.ts's named()), and the asides in brackets and the #numbers, its job numbers linked
const NOISE = /\([^()]*\)|#\d+/g;
export function titleHtml(j) {
  const quiet = html => `<span class="aside">${html}</span>`;
  const words = s => { let html = '', at = 0; for (const m of s.matchAll(NOISE)) { html += withJobLinks(s, at, m.index) + quiet(withJobLinks(s, m.index, m.index + m[0].length)); at = m.index + m[0].length; } return html + withJobLinks(s, at); };
  return (j.step ? quiet(esc(`${j.step}:`)) + ' ' : '') + (unnamed(j) ? nameHtml(j) : words(String(j.title ?? '').trim()));
}
// A name the board reads (the coordinator's boardnames.ts: a project's, a thread's or a task's, field of x): its plain
// words, or while it has none (naming), that it's being named or why that failed, never the agent's words. The HTML
// one sets that apart, and links the job numbers in a job's title (a project's and a thread's names have none: the
// coordinator's plainnames.ts.).
const unnamed = (x, field = 'title') => x[field] == null && field in (x.naming ?? {});
export const nameText = (x, field = 'title') =>
  !unnamed(x, field) ? x[field] : x.naming[field] ? `Couldn’t be named: ${x.naming[field]}` : 'Being named…';
export const nameHtml = (x, field = 'title') =>
  unnamed(x, field) ? `<i>${esc(nameText(x, field))}</i>` : field === 'title' ? withJobLinks(x[field]) : esc(x[field]);

// The HUD's status line (hud.js): how many jobs are active, waiting and recurring
export async function jobCounts(dev) {
  const [list, rec] = await Promise.all([loadJobs(dev), loadSchedule(dev).catch(() => [])]);
  const n = t => list.filter(j => tabOf(j) === t).length;
  return { active: n('active'), waiting: n('waiting'), recurring: rec.length };
}
// Where a job is now, in words: what it waits for (a --when job's events too, holdsOf), or when it started or ended
export function whereNow(j, { who, ago }) {
  const s = state(j), engine = engineName(j.engine);
  return s === 'running' ? `asked ${ago(j.created)}`
    : s === 'blocked' ? `waits for your answer on the desk phone${j.request_title ? `: “${cut(j.request_title)}”` : ''}`
    : s === 'paused' ? (j.until ? `paused until ${timeOf(j.until)}` : 'goes on at the next free seat')
    : s === 'next' ? `starts at the next free ${engine} seat${j.downtime ? ' with room to spare' : ''}`
    : s === 'waits' ? holdsOf(j).map(h => h.wake ?? (h.card ? `after your answer on the desk phone: “${cut(h.title ?? '')}”`
      : `after ${who(h.agent)}’s “${cut(nameText(h) ?? '')}”, ${AFTER[h.state] ?? 'not finished'}`)).join('; ')
    : s === 'later' ? `not before ${timeOf(j.until)}`
    : `${j.status === 'done' ? 'finished' : j.status} ${ago(j.finished ?? j.created)}`;
}

// The jobs a queued one waits for: its `after` while that's pending, and its further waits (the coordinator's listJobs
// waits), each with its agent, title and state. Then the cards it waits for (listJobs cards), marked `card`, and the
// events (hq job --when: listJobs wakes, in words), marked `wake`.
export function holdsOf(j) {
  const waits = j.waits ?? [], cards = (j.cards ?? []).map(c => ({ ...c, card: true })), wakes = (j.wakes ?? []).map(text => ({ wake: text }));
  if (!j.after_state) return [...waits, ...cards, ...wakes];
  const after = { id: j.after, agent: j.after_agent, title: j.after_title, naming: j.after_naming, state: j.after_state };
  return [after, ...waits.filter(w => w.id !== j.after), ...cards, ...wakes];
}
