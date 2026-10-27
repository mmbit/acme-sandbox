// The computer's Reviews app: the record of what the board sent (Sent: its book's sheets, newest first, and the review
// notes sent before the book), and what it shared with outside people (Shared).
import { esc } from '../util.js';
import * as world from '../world/world.js';
import { dayTime } from '../world/clock.js';
import { loadSentSheets, loadSentNotes, reviewShot, loadShares } from './data.js';
import { sfx } from './audio.js';
import { jobNameLink } from './prose.js';
import { ago, noteCount, loadRecent, shareTitle, kindOf, untilLine, shareHtml, wireShare } from './desk.js';

const $ = s => document.querySelector(s);

// Nothing waits here: a note goes on its sheet in the book, and the book's plane sends the sheet. Sent lists each sheet
// as one block (who it went to, when, its job, its notes with their snips and how each was answered). The review notes
// sent before the book (and an outside reviewer's, once gathered) follow, one block a job, read only.
// A note's words come from a page agents wrote (a preview's own code can post one), so they always go through esc().
// The refresh skips a render while a picture is open or a share is changing.
let notesBusy = false;
// (a share's change, from the viewer's Share box too, holds the refresh the same way)
export async function holdReviews(work) {
  notesBusy = true;
  try {
    return await work();
  } finally {
    notesBusy = false;
  }
}
// Reviews' two submenus at its top: Sent, opened first, and Shared, what it shared with outside people, each share one
// line that opens to its whole block.
let notesShown = 'sent';
// The computer opening Reviews (openComputer), at Sent, or at Shared (shown, a feature tip's Show me)
export function openReviews(shown = 'sent') {
  notesShown = shown;
}
const notesMenu = open =>
  `<div class="pills" role="radiogroup" aria-label="Reviews">${[
    ['sent', 'Sent', null],
    ['shared', 'Shared', open],
  ]
    .map(
      ([k, label, n]) =>
        `<button role="radio" aria-checked="${k === notesShown}" data-shown="${k}">${label}${n === null ? '' : `<i>${+n}</i>`}</button>`,
    )
    .join('')}</div>`;
export async function notes(el) {
  const idle = () => !notesBusy && !$('#tool .zoom') && el.isConnected;
  if (!idle()) return;
  const [sheets, older, shares] = await Promise.all([
    loadSentSheets(world.dev),
    loadSentNotes(world.dev),
    loadShares(world.dev),
    loadRecent(),
  ]);
  if (!idle()) return;
  const live = shares.filter(s => !s.ended);
  if (notesShown === 'shared') {
    // (a share the board opened stays open through the refresh)
    const unfolded = new Set(
      [...el.querySelectorAll('section.share > details[open]')].map(d => +d.parentElement.dataset.share),
    );
    el.innerHTML = `${notesMenu(live.length)}${shares.length ? sharesHtml(shares, unfolded) : '<p><i class="prompt">&gt; </i>Nothing shared. A preview’s share invites outside people.</p>'}`;
    shareActs(el, shares);
  } else {
    const blocks = [...sheets.map(sheetBlock), ...byJob(older).map(olderBlock)].sort((a, b) =>
      b.when.localeCompare(a.when),
    );
    el.innerHTML = `${notesMenu(live.length)}<p class="cap"><i class="prompt">&gt; </i>SENT</p>
    ${blocks.map(b => b.html).join('') || '<p><i class="prompt">&gt; </i>Nothing sent yet. Mark a page and send its sheet from the book.</p>'}`;
  }
  el.querySelectorAll('[data-shown]').forEach(
    b =>
      (b.onclick = () => {
        if (notesBusy || notesShown === b.dataset.shown) return;
        sfx.blip();
        notesShown = b.dataset.shown;
        el.innerHTML = '';
        notes(el);
        el.scrollTop = 0;
      }),
  );
  // a snip opens bigger over the screen; a tap anywhere closes it
  el.querySelectorAll('[data-zoom]').forEach(
    b =>
      (b.onclick = () => {
        const url = b.dataset.zoom,
          z = document.createElement('div');
        z.className = 'zoom';
        z.innerHTML = `<img src="${esc(url)}" alt="The page around the mark"><a href="${esc(url)}" target="_blank" rel="noopener">Full size ↗</a>`;
        z.onclick = e => {
          if (e.target.tagName !== 'A') z.remove();
        };
        el.parentNode.append(z);
        sfx.blip();
      }),
  );
}

// A sent sheet: who it went to (nobody's goes to the CEO, who routes each note), when, its job, and its notes
function sheetBlock(s) {
  const to = s.name ? `To ${esc(s.name)}` : 'To the CEO, to pass on';
  const job = s.job ? ` · job ${jobNameLink(s.job, s.job_code)}` : '';
  const html = `<section class="notes sent"><h3><span>${to}</span></h3>
    <p class="dim">${esc(noteCount(s.notes.length))} · ${esc(s.sent ? `${dayTime(s.sent)}, ${ago(s.sent)}` : '')}${job}</p>
    <ol class="rows">${s.notes.map(n => noteRow(n.n, n.words, n.snip, answerOf(n.slips))).join('')}</ol></section>`;
  return { when: s.sent ?? s.created ?? '', html };
}
// How a note was answered: its last slip ticked by the board, or answered and waiting for its look
const answerOf = slips => (!slips?.length ? '' : slips.at(-1).ticked ? 'ticked' : 'answered');
// One note: its number, its words, its snip (a tap shows it bigger) and its answer's state
const noteRow = (n, words, snip, state, by = '') =>
  `<li class="sent-note"><b class="n">${+n}</b><span class="words">${esc(words || '(no words: its snip shows the mark)')}</span>${
    snip
      ? `<button class="shot" data-zoom="${esc(snip)}" aria-label="Show the snip bigger"><img src="${esc(snip)}" alt="" loading="lazy"></button>`
      : ''
  }${state ? `<span class="st st-${state}">${state}</span>` : ''}${by}</li>`;

// The notes sent before the book, one block a job (one marked on a call with no job: a block of its own)
function byJob(list) {
  const groups = new Map();
  for (const x of list) {
    const key = x.job ? `job:${x.job}` : `note:${x.id}`;
    groups.set(key, [...(groups.get(key) ?? []), x]);
  }
  return [...groups.values()].map(g => g.sort((a, b) => a.id - b.id));
}
function olderBlock(list) {
  const first = list[0],
    when = list.at(-1).created;
  const job = first.job
    ? ` · job ${jobNameLink(first.job, first.job_code)}`
    : first.call
      ? ' · answered on a call'
      : '';
  // (a note marked sent on a call with no job: answered there. One whose fix is live: fixed. One answered by its job:
  // answered, with its answer. One whose work is held, or that came back to be routed again: rerouting, with why. An
  // outside reviewer's: who wrote it, as they signed in; a general note says so)
  const state = x => (x.fixed_live ? 'fixed' : x.answered ? 'answered' : x.waiting ? 'rerouting' : '');
  const why = x => x.waiting ?? x.answered;
  const by = x => {
    const line = [
      x.element?.kind === 'general' ? 'General note' : '',
      x.author ? `by ${esc(x.author)}${x.author_email ? ` (${esc(x.author_email)})` : ''}` : '',
    ].filter(Boolean);
    return `${line.length ? `<span class="dim by">${line.join(' · ')}</span>` : ''}${why(x) ? `<span class="dim reason">${esc(why(x))}</span>` : ''}`;
  };
  const snip = x => (x.shot ? reviewShot(world.dev, x.id, x.shotFile) : null);
  const html = `<section class="notes sent"><h3><span>To ${esc(first.to?.name ?? 'the owner')}</span></h3>
    <p class="dim">${esc(first.to?.what ?? '')} · ${esc(noteCount(list.length))} · ${esc(`${dayTime(when)}, ${ago(when)}`)}${job}</p>
    <ol class="rows">${list.map((x, i) => noteRow(i + 1, x.note, snip(x), state(x), by(x))).join('')}</ol></section>`;
  return { when, html };
}
// Shared for outside notes: each open
// share with what it opens and until when, its people (Send link, Remove, Invite) and End now (two taps, like Discard),
// as the viewer's Share shows it. An ended one says it ended and who was on it, for a week.
// Each open share is folded to its heading and one line (its people, until when), and
// opens to the rest; the ended ones sit below.
const shareWhere = s => `${esc(s.what)}${s.prefix === '/' ? '' : ` (${esc(s.prefix)})`}`;
const foldLine = s => `${s.people.map(p => p.name).join(', ') || 'Nobody yet'} · until ${dayTime(s.ends)}`;
const openShareHtml = (
  s,
  open,
) => `<details${open ? ' open' : ''}><summary><h3><span>${shareTitle(kindOf(s))} on ${shareWhere(s)}</span></h3><span class="dim">${esc(foldLine(s))}</span></summary>
  <p class="dim">${untilLine(s)}</p>${shareHtml(s)}</details>`;
// (unfolded: the ids of the shares the board has open)
function sharesHtml(shares, unfolded) {
  const ended = s =>
    `<li class="old"><span class="st st-ended">ended</span><b>${shareWhere(s)}</b><span class="dim by">${esc(s.people.map(p => p.name).join(', '))}</span></li>`;
  const old = shares.filter(s => s.ended);
  return `${shares
    .filter(s => !s.ended)
    .map(s => `<section class="notes share" data-share="${+s.id}">${openShareHtml(s, unfolded.has(+s.id))}</section>`)
    .join('')}
    ${old.length ? `<section class="notes shares"><h3><span>Outside notes, ended</span></h3><ul class="rows">${old.map(ended).join('')}</ul></section>` : ''}`;
}
function shareActs(el, shares) {
  el.querySelectorAll('section.share').forEach(sec => {
    const draw = (s, said = '') => {
      if (!s) {
        sec.innerHTML = `<p class="dim">${said}</p>`;
        return;
      }
      sec.innerHTML = openShareHtml(s, sec.querySelector('details')?.open ?? false);
      wireShare(sec, s, { redraw: draw });
      if (said) sec.querySelector('.invites .msg').innerHTML = said;
    };
    draw(shares.find(s => s.id === +sec.dataset.share));
  });
}
