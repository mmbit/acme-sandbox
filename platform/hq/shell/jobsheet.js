// A job of the projects view, opened over its thread as a big key that turns over, like the home page's: on its front
// what it is, who does it, where it is (the board's card first when it waits on it), when the planner has it start and
// be done, and what it waits for, and a finished one what it did in a line or two; on its back its record (when it ran,
// its agent time, its pull request), who reviewed it and what they found, its reviews and fixes, its report, what
// follows it (together or one after another) and its steps, as the agent's big key on HQ home shows them (steplog.js).
// A review loop job's output is for HQ to read, never shown: its triage and findings are, in words.
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
  left,
  clock,
  fateWords,
} from './threads.js';
import { face } from './projectkeys.js';
import { icon } from './icons.js';
import { stepLines, fillSteps } from './steplog.js';
import { glance, lasted } from '../../../shared/signs/signs.js';

// all: every job the view holds (each with its project and thread); back: whether it's turned over (kept across paints);
// findings: a finished review's, and facts: its record, as projects.js loaded them (findingsOf, factsOf). Its turn mark
// sits in the card's bottom corner as the agents' big keys' does, under the face that scrolls, so it's always there.
export function jobSheet(j, all, { back = false, findings = null, facts = null } = {}) {
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
  const reverse = backOf(j, all, row, { findings, facts });
  const turned = back && reverse;
  return `<div class="pj-pop"><article class="pj-card${turned ? ' flipped' : ''}" role="dialog" aria-label="${esc(nameText(j))}" data-job-open="${Number(j.id)}">
    <div class="pj-card-keys"><button class="pj-key" data-close aria-label="Close">${icon('close')}</button></div>
    <div class="pj-card-faces"><section class="pj-front">${frontOf(j, row)}</section>${reverse ? `<section class="pj-back">${reverse}</section>` : ''}</div>
    ${reverse ? `<button class="pj-turns" data-turn aria-label="${turned ? 'Turn back to its front' : 'Turn over: its record and steps'}">${icon('redo')}</button>` : ''}</article></div>`;
}

// The front: its code and title, who, where it is, when it starts and is done, and what it waits for first
function frontOf(j, row) {
  const s = stateOf(j),
    kind = kindOf(j),
    card = cardsOf(j.projectThread ?? { jobs: [] }).find(x => x.id === j.id),
    lit = forBoard(card ?? j),
    asks = lit ? (card?.asks ?? asksOf([j])) : [];
  const before = [
    ...(j.after_state ? [{ id: j.after, agent: j.after_agent, title: j.after_title, state: j.after_state }] : []),
    ...(j.waits ?? []).filter(w => w.id !== j.after),
  ];
  // (a job waiting on others names each in its list, not in a sentence)
  const why = asks.length
    ? `Waits for your ${asks.length > 1 ? 'answers' : 'answer'} on the desk phone.`
    : jobState(j) === 'waits' && before.length
      ? ''
      : `${cap(whereNow(j, { who, ago }))}.`;
  // (a review loop job's in plain words, doingOf; one at work its size with what's left of it.)
  const work = size(j) && `About ${size(j)} of work${s === 'working' && left(j) ? `, ${left(j)} left` : ''}`;
  const what = [j.review ? doingOf(j) : kind === 'work' ? '' : cap(kind), work];
  // the planner's times: when it starts, for one not started yet, and its one finish, its work live (threads.js planned)
  const { start, done } = planned(j);
  const times = [
    s !== 'working' && start && { words: start, icon: 'tour' },
    done && { words: done, icon: 'finish' },
  ].filter(Boolean);
  // (a finished one's state as the icon set's tick, and what it did in a line or two)
  const said = finished(j) ? summaryOf(j) : '',
    mark = !lit && s === 'done' ? icon('tick', 'pj-done') : '';
  return `<small class="pj-code-line">${esc(jobName(j.id, j.code))}</small><h2>${nameHtml(j)}</h2>
    <div class="pj-who">${face(j.agent, 'big')}<div><b>${esc(who(j.agent))}</b><small>${withJobLinks(what.filter(Boolean).join(' · '))}</small></div></div>
    ${said ? `<p class="pj-summary">${said}</p>` : ''}
    <div class="pj-why-big ${lit ? 'you' : s}"><p><b>${mark}${esc(lit ? 'For you' : cap(word(j)))}</b>${esc(why)}</p>${asks.map(c => `<button class="pj-key on" data-card="${Number(c.id)}">${icon('phone')}<span>${asks.length > 1 ? esc(c.title) : 'Open the card'}</span></button>`).join('')}</div>
    ${times.length ? `<p class="pj-times">${times.map(time => `<span class="pj-note">${icon(time.icon)}<span>${esc(cap(time.words))}</span></span>`).join('')}</p>` : ''}
    ${before.length ? `<h4>Starts once these are merged</h4><ul class="pj-rows">${before.map(x => row(x, AFTER[x.state] ?? x.state)).join('')}</ul>` : ''}`;
}

// What a finished job did, in a line or two, for its front: a review loop job's from what HQ read of its output (who its
// triage chose and why, what a reviewer found, how its ruling went), any other's its report's opening; never a review
// loop job's output itself, which is for HQ (machine-read JSON).
const RULED = {
  merge: 'Ruled it ready to merge',
  changes: 'Sent it back for another round',
  close: 'Ruled to close it',
  board: 'Left it for you to decide',
  panel: 'Asked the whole panel to read it',
};
export function summaryOf(j) {
  const chosen = j.stage === 'triage' && j.triage?.selection,
    f = j.findings;
  if (chosen?.decision === 'escalate') return `Left it for its owner to decide: ${opening(chosen.reason)}`;
  if (chosen) {
    const names = listed((chosen.reviewers ?? []).map(r => who(r.agent)));
    return names ? `Chose ${esc(names)} to review it: ${opening(chosen.reason)}` : opening(chosen.reason);
  }
  if (f?.verdict)
    return `${esc(RULED[f.verdict] ?? cap(f.verdict))}${f.blocking ? `, over ${counted(f.blocking, 'blocking finding')}` : ''}.`;
  if (f) {
    const parts = [f.blocking && counted(f.blocking, 'blocking finding'), f.notes && counted(f.notes, 'note')];
    return parts.some(Boolean) ? `Found ${listed(parts.filter(Boolean))}.` : 'Found nothing to fix.';
  }
  return reportOf(j) ? opening(reportOf(j)) : '';
}
// A job's report as prose: none for a review loop job's (its output is HQ's to read) or one that's data, not words
const reportOf = j => (j.kind === 'review' || j.kind === 'consolidate' || isData(j.result) ? '' : (j.result ?? ''));
function isData(text) {
  try {
    const value = JSON.parse(String(text ?? '').trim());
    return typeof value === 'object' && value !== null;
  } catch {
    return false;
  }
}
// A text's opening as markup: its first paragraph or list item as Markdown shows it, its first sentence, and the next
// while that's short, cut at OPENING characters
const OPENING = 220;
function opening(text) {
  const shown = document.createElement('template');
  shown.innerHTML = prose(String(text ?? ''));
  const first =
    [...shown.content.querySelectorAll('p, li, pre, td')].map(e => e.textContent.trim()).find(Boolean) ?? '';
  const sentences = [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(first)].map(x => x.segment);
  let words = sentences.shift() ?? '';
  while (sentences.length && words.length < 90) words += sentences.shift();
  words = words.trim();
  if (words.length > OPENING) words = `${words.slice(0, OPENING).replace(/\s+\S*$/, '')}…`;
  return withJobLinks(words);
}
const counted = (n, what) => `${n} ${what}${n > 1 ? 's' : ''}`;
const listed = words => (words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);

// A finished review's findings, loaded as its sheet opens (load: by its id), then painted on it (repaint): null while
// they load, 'failed' when they didn't.
let found = { job: null, list: null };
export function findingsOf(j, load, repaint) {
  if (!j?.findings) return (found = { job: null, list: null }).list;
  if (found.job === j.id) return found.list;
  found = { job: j.id, list: null };
  load(j.id)
    .then(r => r.findings)
    .catch(() => 'failed')
    .then(list => {
      if (found.job !== j.id) return;
      found.list = list;
      repaint();
    });
  return null;
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
  return `<h4>${finished(j) ? 'Who read this round, and why' : 'Who reads this round, and why'}</h4>${why ? `<p class="pj-chosen">${withJobLinks(why)}</p>` : ''}
    <ul class="pj-rows pj-readers">${[...reads, ...rules, ...out].join('')}</ul>`;
}

// The back: its record, who read its round and what was found, its reviews and fixes, what it did, what follows it, and
// last its steps, filling the rest of the card as the agent's big key's log does; empty for one with none of them yet.
function backOf(j, all, row, { findings, facts }) {
  const reviews = stepsOf(j, j.projectThread).filter(x => x.id !== j.id);
  const report = reportOf(j);
  const parts = [
    recordOf(j, facts),
    readersOf(j),
    foundOf(j, findings),
    reviews.length
      ? `<h4>Its reviews and fixes</h4><ul class="pj-rows">${reviews.map(x => row(x, cap(word(x)), stateOf(x), { name: doingOf(x) })).join('')}</ul>`
      : '',
    report ? `<h4>What it did</h4><div class="prose pj-report">${prose(report)}</div>` : '',
    followers(j, all, row),
  ].join('');
  const shown = logged.job === j.id && Array.isArray(logged.lines) ? logged.lines : null;
  const log =
    j.status === 'queued'
      ? ''
      : `<h4>Its steps</h4><ol class="log steplog pj-steplog" data-log="${Number(j.id)}">${shown ? stepsHtml(j, shown) : '<li class="aside">Loading its steps…</li>'}</ol>`;
  return parts || log
    ? `<small class="pj-code-line">${esc(jobName(j.id, j.code))}</small><h2>${nameHtml(j)}</h2>${parts}${log}`
    : '';
}

// A job's record (the coordinator's jobfacts.ts), loaded as its card opens (load: by its id) and again with each read of
// the board it's painted from (read) while the card stays open, as its task and pull request move on; then painted on it
// (repaint): null while it first loads, 'failed' when a read didn't, the one before kept while the next loads. None for a
// job not started.
let record = { job: null, read: null, facts: null };
export function factsOf(j, load, repaint, read) {
  if (!j || j.status === 'queued') return (record = { job: null, read: null, facts: null }).facts;
  if (record.job === j.id && record.read === read) return record.facts;
  const asked = (record = { job: j.id, read, facts: record.job === j.id ? record.facts : null });
  load(j.id)
    .catch(() => 'failed')
    .then(facts => {
      if (record !== asked) return; // (another card's, or a later read's)
      record.facts = facts;
      repaint();
    });
  return record.facts;
}
// Its record as a few figures, each under its words, as the agents' big keys show their numbers: when it started and
// finished and how long that took, its agent time against the size it was given, its lines, and its pull request.
const PR = { merged: 'Merged', closed: 'Closed unmerged', board: 'Yours to decide' };
function recordOf(j, facts) {
  if (j.status === 'queued') return '';
  if (facts === null) return '<p class="pj-record-wait">Loading its record…</p>';
  if (facts === 'failed')
    return '<p class="pj-record-wait">Its record didn’t load. Open it again to try once more.</p>';
  const at = iso => Date.parse(iso ?? ''),
    start = at(facts.started),
    end = at(facts.finished),
    pr = facts.pr;
  const figures = [
    !isNaN(start) && [clock(start), 'Started'],
    !isNaN(end) && [clock(end), 'Finished'],
    !isNaN(start) && !isNaN(end) && end > start && [lasted(end - start), 'Start to end'],
    facts.agent_ms && [
      lasted(facts.agent_ms),
      facts.estimate_ms ? `Agent time, sized ${glance(facts.estimate_ms)}` : 'Agent time',
    ],
    pr && pr.added !== null && [`+${Number(pr.added)} −${Number(pr.removed ?? 0)}`, 'Lines'],
    pr && [
      PR[pr.status] ?? 'In review',
      pr.status === 'merged' && pr.merged_at ? clock(at(pr.merged_at)) : 'Its pull request',
    ],
  ].filter(Boolean);
  return figures.length
    ? `<dl class="pj-record">${figures.map(([figure, words]) => `<div><dt>${esc(words)}</dt><dd>${esc(figure)}</dd></div>`).join('')}</dl>`
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

// A job's steps (its log), as the agent's big key shows them (steplog.js), on its card's back: read as the card opens,
// again every few seconds while it runs, and kept for the card's next paint (logged, with the job's status as they were
// read), so a repaint shows them at once, where the board had them (kept: stepsKept's, from the card before the paint).
// card: the card painted.
const LOG_MS = 5000;
let logged = { job: null, lines: null, status: null };
export const stepsKept = el => {
  const ol = el.querySelector('.pj-card .steplog');
  return ol && { top: ol.scrollTop, open: [...ol.querySelectorAll('li.open')].map(li => li.dataset.k) };
};
export async function followSteps(card, j, load, kept = null) {
  const ol = card.querySelector('.steplog');
  if (!ol) return;
  if (kept) {
    for (const li of ol.querySelectorAll('li[data-k]')) li.classList.toggle('open', kept.open.includes(li.dataset.k));
    ol.scrollTop = kept.top;
  } else ol.scrollTop = ol.scrollHeight; // (a card opened: its newest step)
  if (logged.job === j.id && logged.lines && logged.status !== 'running' && j.status !== 'running') return;
  let first = !kept;
  while (ol.isConnected) {
    try {
      const lines = await load(j.id);
      logged = { job: j.id, lines, status: j.status };
      if (!ol.isConnected) return;
      fillSteps(ol, lines, { time: stamp, text: l => stepText(j, l), empty: 'No steps logged for this job.', first });
      first = false;
    } catch {
      if (logged.job !== j.id)
        ol.innerHTML = `<li class="aside">${j.status === 'running' ? 'Its steps didn’t load. Trying again…' : 'Its steps didn’t load. Open it again to try once more.'}</li>`;
    }
    if (j.status !== 'running') return;
    await new Promise(r => setTimeout(r, LOG_MS));
  }
}
// (a team member's step names them; its words with their jobs linked)
const stepText = (j, l) =>
  `${l.agent && l.agent !== j.agent ? `<i>${esc(who(l.agent))}</i> ` : ''}${withJobLinks(l.text)}`;
const stepsHtml = (j, lines) =>
  lines.length
    ? stepLines(lines, { time: stamp, text: l => stepText(j, l) })
    : '<li class="aside">No steps logged for this job.</li>';
const stamp = ts => {
  const d = new Date(ts);
  return isNaN(d) ? '' : clock(d.getTime());
};
