// A job of the projects view, opened over its thread as a big key that turns over, like the home page's: on its front
// what it is, who does it, where it is (the board's card first when it waits on it), when the planner has it start and
// be done, and what it waits for; on its back its reviews and fixes, its report, what follows it (together or one
// after another) and its steps.
import { esc, cap, jobName } from '../util.js'; // (jobName)
import { state as jobState, AFTER, whereNow, holdsOf, nameHtml, nameText } from './jobs.js';
import { who, ago } from './desk.js';
import { prose, withJobLinks, covered } from './prose.js';
import {
  stateOf,
  word,
  kindOf,
  doingOf,
  cardsOf,
  stepsOf,
  finished,
  forBoard,
  asksOf,
  planned,
  size,
  clock,
  fateWords,
} from './threads.js';
import { face } from './projectkeys.js';
import { icon } from './icons.js';

// all: every job the view holds (each with its project and thread); steps: whether its steps show, back: whether it's
// turned over (both kept across paints); findings: a finished review's, as projects.js loaded them
export function jobSheet(j, all, { steps = false, back = false, findings = null } = {}) {
  if (!j) return '';
  const byId = id => all.find(x => x.id === id);
  // a job of another thread names it, quietly
  const where = x =>
    x.projectThread && x.projectThread.id !== j.projectThread?.id
      ? `<small>${nameHtml(x.project, 'name')} · ${nameHtml(x.projectThread, 'name')}</small>`
      : '';
  // note: a quiet line under its title (what else a follower waits for). name: its own words for it in place of its
  // title (a review's or fix's step: the job it's of is the sheet's). One that opens is a tap target with the job
  // numbers in its words linked beside it (prose.js covered).
  const row = (x, label, cls = '', { note = '', name = '' } = {}) => {
    const on = byId(x.id);
    const inner = `${face(x.agent)}<span class="pj-row-text"><b>${name ? withJobLinks(name) : nameHtml(on ?? x)}</b>${on ? where(on) : ''}${note ? `<small>${withJobLinks(note)}</small>` : ''}</span><span class="pj-tag ${cls}">${esc(label)}</span>`;
    return on
      ? `<li>${covered('pj-row', `data-job="${Number(x.id)}"`, `${name || nameText(on)}, ${label}`, inner)}</li>`
      : `<li><div class="pj-row pj-flat">${inner}</div></li>`;
  };
  const reverse = backOf(j, all, row, steps);
  return `<div class="pj-pop"><article class="pj-card${back && reverse ? ' flipped' : ''}" role="dialog" aria-label="${esc(nameText(j))}" data-job-open="${Number(j.id)}">
    <div class="pj-card-keys">${reverse ? `<button class="pj-key" data-turn aria-label="Turn over">${icon('redo')}</button>` : ''}<button class="pj-key" data-close aria-label="Close">${icon('close')}</button></div>
    <div class="pj-card-faces"><section class="pj-front">${frontOf(j, row)}${foundOf(j, findings)}${readersOf(j)}</section>${reverse ? `<section class="pj-back">${reverse}</section>` : ''}</div></article></div>`;
}

// The front: its code and title, who, where it is, when it starts and is done, and what it waits for first
function frontOf(j, row) {
  const s = stateOf(j),
    kind = kindOf(j),
    card = cardsOf(j.projectThread ?? { jobs: [] }).find(x => x.id === j.id),
    lit = forBoard(card ?? j),
    asks = lit ? (card?.asks ?? asksOf([j])) : [];
  const before = [
    ...(j.after_state
      ? [{ id: j.after, agent: j.after_agent, title: j.after_title, naming: j.after_naming, state: j.after_state }]
      : []),
    ...(j.waits ?? []).filter(w => w.id !== j.after),
  ];
  // (a job waiting on others names each in its list, not in a sentence)
  const why = asks.length
    ? `Waits for your ${asks.length > 1 ? 'answers' : 'answer'} on the desk phone.`
    : jobState(j) === 'waits' && before.length
      ? ''
      : `${cap(whereNow(j, { who, ago }))}.`;
  const merged = j.estimate?.merged && !finished(j) ? ` Merged about ${clock(j.estimate.merged)}.` : '';
  // (a review loop job's in plain words, doingOf.)
  const what = [j.review ? doingOf(j) : kind === 'work' ? '' : cap(kind), size(j) ? `About ${size(j)} of work` : ''];
  // the planner's times: when it starts, for one not started yet, and when it's done
  const { start, done } = planned(j);
  const times = [
    s !== 'working' && start && { words: start, icon: 'tour' },
    done && { words: done, icon: 'finish' },
  ].filter(Boolean);
  return `<small class="pj-code-line">${esc(jobName(j.id, j.code))}</small><h2>${nameHtml(j)}</h2>
    <div class="pj-who">${face(j.agent, 'big')}<div><b>${esc(who(j.agent))}</b><small>${withJobLinks(what.filter(Boolean).join(' · '))}</small></div></div>
    <div class="pj-why-big ${lit ? 'you' : s}"><p><b>${esc(lit ? 'For you' : cap(word(j)))}</b>${esc(why)}${esc(merged)}</p>${asks.map(c => `<button class="pj-key on" data-card="${Number(c.id)}">${icon('phone')}<span>${asks.length > 1 ? esc(c.title) : 'Open the card'}</span></button>`).join('')}</div>
    ${times.length ? `<p class="pj-times">${times.map(time => `<span class="pj-note">${icon(time.icon)}<span>${esc(cap(time.words))}</span></span>`).join('')}</p>` : ''}
    ${before.length ? `<h4>Starts once these are merged</h4><ul class="pj-rows">${before.map(x => row(x, AFTER[x.state] ?? x.state)).join('')}</ul>` : ''}`;
}

// A finished review's findings, each in a line marked blocking or a note, with what became of it.
function foundOf(j, findings) {
  if (!j.findings) return '';
  const list =
    findings === null
      ? '<li>Loading its findings…</li>'
      : findings === 'failed'
        ? '<li>Its findings didn’t load. Open it again to try once more.</li>'
        : findings.length
          ? findings.map(f => foundLine(f)).join('')
          : '<li>No findings.</li>';
  return `<h4>Its findings</h4><ul class="pj-findings">${list}</ul>`;
}
const foundLine = f =>
  `<li class="${f.blocking ? 'blocking' : 'note'}"><span class="pj-found${f.blocking ? ' blocking' : ''}">${f.blocking ? 'Blocking' : 'Note'}</span><span>${withJobLinks(f.issue)}${fateWords(f) ? `<small>${esc(fateWords(f))}</small>` : ''}</span></li>`;

// Who reads its round and why, as the round's triage chose them: the reason for the whole, each reader's own, who
// rules it, and each finder of an open blocker left out with why, so a read missing shows. None for a round before
// triage (the coordinator's jobs.ts jobRows, reviewtriage.ts).
function readersOf(j) {
  const chosen = (j.kind === 'review' || j.kind === 'consolidate') && j.triage?.selection;
  if (!chosen) return '';
  const reader = (agent, words, tag) =>
    `<li><div class="pj-row pj-flat">${face(agent)}<span class="pj-row-text"><b>${esc(who(agent))}</b>${words ? `<small>${withJobLinks(words)}</small>` : ''}</span><span class="pj-tag">${esc(tag)}</span></div></li>`;
  const reads = (chosen.reviewers ?? []).map(r => {
    const tag = [r.domain, r.security && 'security'].filter(Boolean).join(' · ');
    return reader(r.agent, r.reason, tag ? cap(tag) : 'Reads');
  });
  const out = (chosen.exceptions ?? []).map(x => reader(x.agent, x.reason, 'Left out'));
  const rules = chosen.consolidator ? [reader(chosen.consolidator, '', 'Rules')] : [];
  const why =
    chosen.decision === 'escalate' ? `For its owner to decide: ${chosen.reason ?? ''}` : (chosen.reason ?? '');
  return `<h4>Who reads this round, and why</h4>${why ? `<p class="pj-chosen">${withJobLinks(why)}</p>` : ''}
    <ul class="pj-rows pj-readers">${[...reads, ...rules, ...out].join('')}</ul>`;
}

// The back: its reviews and fixes, what it did, what follows it, and its steps; empty for one with none of them yet
function backOf(j, all, row, steps) {
  const reviews = stepsOf(j, j.projectThread).filter(x => x.id !== j.id);
  const parts = [
    reviews.length
      ? `<h4>Its reviews and fixes</h4><ul class="pj-rows">${reviews.map(x => row(x, cap(word(x)), stateOf(x), { name: doingOf(x) })).join('')}</ul>`
      : '',
    j.result ? `<h4>What it did</h4><div class="prose pj-report">${prose(j.result)}</div>` : '',
    followers(j, all, row),
  ].join('');
  const log =
    j.status === 'queued'
      ? ''
      : `<details class="pj-steps"${steps ? ' open' : ''}><summary class="pj-key">${icon('list')}<span>Its steps</span></summary><ol class="pj-log" data-log="${Number(j.id)}"><li>Loading its steps…</li></ol></details>`;
  return parts || log
    ? `<small class="pj-code-line">${esc(jobName(j.id, j.code))}</small><h2>${nameHtml(j)}</h2>${parts}${log}`
    : '';
}

// What follows a job: the jobs waiting for it, from everything each still waits for (holdsOf). Those it's the last
// thing for start once it's merged, together when several; the rest name what else they wait for. Under each, what
// waits for that one in turn, as a chain; a job waiting for two shows under both.
function followers(j, all, row) {
  const open = all.filter(x => !finished(x));
  const next = x => open.filter(y => y.id !== x.id && holdsOf(y).some(h => !h.card && !h.wake && h.id === x.id));
  // what else y waits for once the last of path is merged, in words (the ones before it in the chain are by then);
  // none: it starts then
  const besides = (y, path) => [
    ...holdsOf(y)
      .filter(h => h.card || h.wake || !path.includes(h.id))
      .map(h => h.wake ?? (h.card ? 'your answer on the desk phone' : `${who(h.agent)}’s “${nameText(h) ?? ''}”`)),
    ...(jobState(y) === 'paused' ? ['its pause'] : []),
  ];
  const line = (y, path, label) => {
    const also = besides(y, path),
      after = path.length < 4 ? next(y).filter(z => !path.includes(z.id)) : [];
    const own = also.length ? row(y, 'also waits', '', { note: `Also after ${also.join(' and ')}` }) : row(y, label);
    const chain = after.map(z => line(z, [...path, y.id], 'then')).join('');
    return own + (chain ? `<li class="pj-chain"><ul class="pj-rows">${chain}</ul></li>` : '');
  };
  const first = next(j),
    free = first.filter(y => !besides(y, [j.id]).length),
    held = first.filter(y => besides(y, [j.id]).length);
  const together =
    free.length > 1 ? `Then ${free.length === 2 ? 'both' : `all ${free.length}`} start together, once it’s merged` : '';
  const starts = free.map(y => line(y, [j.id], 'starts then')).join('');
  const waits = held.map(y => line(y, [j.id], '')).join('');
  const startsSection = starts
    ? `<h4>${together || 'Then, once it’s merged'}</h4><ul class="pj-rows">${starts}</ul>`
    : '';
  const heldSection = waits ? `<h4>Also waiting for it</h4><ul class="pj-rows">${waits}</ul>` : '';
  return startsSection + heldSection;
}

// An open job's steps (its log), newest first, read again every few seconds while it runs and they're open
const LOG_MS = 5000;
export async function followSteps(details, j, load) {
  const ol = details.querySelector('.pj-log');
  while (details.open && details.isConnected) {
    try {
      const rows = await load(j.id);
      ol.innerHTML = rows.length
        ? rows
            .slice()
            .reverse()
            .map(
              l =>
                `<li><time>${esc(stamp(l.ts))}</time>${l.agent && l.agent !== j.agent ? ` <i>${esc(who(l.agent))}</i>` : ''} <span>${withJobLinks(l.text)}</span></li>`, // (its jobs linked)
            )
            .join('')
        : '<li>No steps logged for this job.</li>';
    } catch {
      ol.innerHTML = '<li>Its steps didn’t load. Trying again…</li>';
    }
    if (j.status !== 'running') return;
    await new Promise(r => setTimeout(r, LOG_MS));
  }
}
const stamp = ts => {
  const d = new Date(ts);
  return isNaN(d) ? '' : clock(d.getTime());
};
