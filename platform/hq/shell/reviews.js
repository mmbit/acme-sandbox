// The computer's Reviews app: the board's review notes waiting to be sent to a product's owner (My notes), and what it
// shared with outside people (Shared).
import { esc } from '../util.js';
import * as world from '../world/world.js';
import { dayTime } from '../world/clock.js';
import {
  loadReviewProducts,
  loadReviewNotes,
  reviewShot,
  reviewPicture,
  sendNotes,
  discardNotes,
  loadShares,
} from './data.js';
import { sfx } from './audio.js';
import { toast } from './hud.js';
import { askAgain } from '/ask.js'; // a button that asks once more (shared/ask/ask.js)
import { jobNameLink } from './prose.js';
import { callAgent } from './call.js';
import { frameMark } from '/__review/frame.js';
import {
  who,
  ago,
  refreshWaitingNotes,
  paintWaiting,
  loadRecent,
  toldReview,
  unpin,
  noteCount,
  shareTitle,
  kindOf,
  untilLine,
  shareHtml,
  wireShare,
  went,
} from './desk.js';

const $ = s => document.querySelector(s);

// Review notes: what the board pinned on product preview pages. They wait here until the board sends the ones it
// ticked to the product's owner.
// A preview page runs the product's own code, which can post notes too, so only a batch sent from here reaches an
// agent, and note text, being page-controlled, always goes through esc().
// A note starts unticked (one that arrives during the 15 s refresh must never ride along unseen); the ones the board
// ticks live in `ticked`, so the refresh keeps them. The refresh skips a render while a screenshot is open or a send
// is on its way.
// A note shows what the board needs to send or discard it: its words, where it was pinned in human terms (the
// element's text, the screenshot), when, and what it was seen on. The page address and the selector travel with the
// note to the owner's job, not here.
// A sent note is one line; the safety line shows only while notes wait, and Tick all sits by the heading for two
// notes or more.
const ticked = new Set(),
  SEND_MAX = 50;
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
// The send step (sendStep) opens the tab at one product: notesWanted is { slug, sent }. The first paint scrolls to
// that product and ticks nothing. A send from that product calls `sent`.
let notesWanted = null;
// Reviews' two submenus at its top: My notes, the board's own notes waiting to be sent, opened
// first, and Shared, what it shared with outside people, each share one line that opens to its whole block.
let notesShown = 'mine';
// The computer opening Reviews (openComputer), at My notes and at opts.notes when it's the send step
export function openReviews(want = null) {
  notesWanted = want;
  notesShown = 'mine';
  if (notesWanted) ticked.clear(); // a send step starts with nothing ticked: a tick left from before mustn't ride along unseen
}
const notesMenu = (waiting, open) =>
  `<div class="pills" role="radiogroup" aria-label="Reviews">${[
    ['mine', 'My notes', waiting],
    ['shared', 'Shared', open],
  ]
    .map(
      ([k, label, n]) =>
        `<button role="radio" aria-checked="${k === notesShown}" data-shown="${k}">${label}<i>${+n}</i></button>`,
    )
    .join('')}</div>`;
const shorten = (s, n) => (s.length > n ? `${s.slice(0, n).replace(/[\s.,;:]+$/, '')}…` : s);
// (a general note is pinned to nothing)
const pinnedOn = e =>
  e?.kind === 'general' ? 'General note · ' : e?.el?.text ? `on “${esc(shorten(e.el.text, 48))}” · ` : '';
// The thumbnail is framed on the note's mark (frameMark), in the padding box of .notes li.pending .shot (style.css):
// its img then gets the class framed.
const SHOT_ASPECT = 70 / 52;
function shotFrame(element) {
  const placement = frameMark(element, SHOT_ASPECT);
  return placement
    ? ` class="framed" style="width:${placement.width};height:${placement.height};left:${placement.left};top:${placement.top}"`
    : '';
}
// A picture the reviewer added to a note, small under its words
const pictureButton = (id, file) =>
  `<button data-picture="${+id}" data-file="${esc(file)}" aria-label="Show the picture bigger">` +
  `<img src="${esc(reviewPicture(world.dev, id, file))}" alt="" loading="lazy"></button>`;
export async function notes(el) {
  const idle = () => !notesBusy && !$('#tool .zoom') && el.isConnected;
  if (!idle()) return;
  const [products, shares] = await Promise.all([loadReviewProducts(world.dev), loadShares(world.dev), loadRecent()]);
  const lists = await Promise.all(products.map(p => loadReviewNotes(world.dev, p.slug)));
  if (!idle()) return;
  const waiting = paintWaiting(products),
    want = notesWanted,
    first = want && !want.shown;
  const open = new Set(
    lists
      .flat()
      .filter(x => x.status === 'pending')
      .map(x => +x.id),
  );
  ticked.forEach(id => open.has(id) || ticked.delete(id)); // sent or discarded since
  const pending =
    x => `<li class="pending"><input type="checkbox" id="rn-${+x.id}" data-note="${+x.id}" ${ticked.has(+x.id) ? 'checked' : ''}>
      <label for="rn-${+x.id}"><b>${esc(x.note)}</b></label><span class="dim">${pinnedOn(x.element)}${esc(ago(x.created))}</span>
      ${x.seen ? `<span class="dim seen">${esc(x.seen)}</span>` : ''}
      ${x.shot ? `<button class="shot" data-shot="${+x.id}" data-file="${esc(x.shotFile ?? '')}" aria-label="Show the screenshot bigger"><img src="${esc(reviewShot(world.dev, x.id, x.shotFile))}" alt="" loading="lazy"${shotFrame(x.element)}></button>` : ''}
      ${x.pictures?.length ? `<span class="pics">${x.pictures.map(file => pictureButton(x.id, file)).join('')}</span>` : ''}</li>`; // (pictures)
  // (a note marked sent on a call with no job, or answered by its job: answered. One whose fix is live: fixed. One whose
  // work is held, or that came back to be routed again: rerouting, with why; waiting is an unsent note's, the board's to
  // send.)
  const state = x =>
    x.fixed_live
      ? 'fixed'
      : x.answered || (x.status === 'sent' && !x.job && x.call)
        ? 'answered'
        : x.waiting
          ? 'rerouting'
          : x.status;
  const why = x =>
    x.waiting
      ? `<span class="dim reason">${esc(x.waiting)}</span>`
      : x.answered
        ? `<span class="dim reason">${esc(x.answered)}</span>`
        : '';
  // (an outside reviewer's, once it went: who wrote it, as they signed in; and a general note says so)
  const by = x => {
    const line = [
      x.element?.kind === 'general' ? 'General note' : '',
      x.author ? `by ${esc(x.author)}${x.author_email ? ` (${esc(x.author_email)})` : ''}` : '',
    ].filter(Boolean);
    return line.length ? `<span class="dim by">${line.join(' · ')}</span>` : '';
  };
  // (only a rerouting note has its own colour: answered and fixed keep their status's)
  const done = x => {
    const said = state(x);
    return `<li class="old"><span class="st st-${esc(said === 'rerouting' ? said : x.status)}">${esc(said)}</span><b>${esc(x.note)}</b><span class="dim">${esc(ago(x.created))}</span>${by(x)}${why(x)}</li>`;
  };
  const live = shares.filter(s => !s.ended || s.reopens);
  if (notesShown === 'shared') {
    // (a share the board opened stays open through the refresh)
    const unfolded = new Set(
      [...el.querySelectorAll('section.share > details[open]')].map(d => +d.parentElement.dataset.share),
    );
    el.innerHTML = `${notesMenu(waiting, live.length)}${shares.length ? sharesHtml(shares, unfolded) : '<p><i class="prompt">&gt; </i>Nothing shared. A preview’s share invites outside people.</p>'}`;
    shareActs(el, shares);
  } else
    el.innerHTML = `${notesMenu(waiting, live.length)}<p class="cap"><i class="prompt">&gt; </i>REVIEW NOTES · ${waiting} WAITING</p>
    ${waiting ? '<p class="warn notes-warn">Send only the notes you recognise: a preview page can write notes too.</p>' : ''}
    ${
      products
        .map((p, i) => {
          // (a discarded note is gone from the list, kept on the server.)
          const open = lists[i].filter(x => x.status === 'pending'),
            old = lists[i].filter(x => !['pending', 'discarded'].includes(x.status));
          if (!open.length && !old.length) return '';
          // (wanted: by the notes pinned in the viewer too, as a deck's are about its cycle folder; data-agent for Call.
          const wanted = want && (p.slug === want.slug || open.some(x => want.ids?.has(+x.id)));
          return `<section class="notes${wanted ? ' wanted' : ''}" data-slug="${esc(p.slug)}" data-owner="${esc(p.ownerName || who(p.owner))}" data-agent="${esc(p.owner)}">
        <h3><span>${esc(p.name || p.slug)}${+p.pending ? ` · ${+p.pending} waiting` : ''}</span>${open.length > 1 ? '<button data-all></button>' : ''}</h3>
        ${open.length ? `<ul class="rows">${open.map(pending).join('')}</ul><p class="acts"><button class="cta" data-send></button><button data-call></button><button data-discard></button><span class="msg" role="status"></span></p>` : ''}
        ${old.length ? `<ul class="rows">${old.slice(0, 10).map(done).join('')}</ul>${old.length > 10 ? `<p class="dim">+ ${old.length - 10} earlier</p>` : ''}` : ''}
      </section>`;
        })
        .join('') ||
      '<p><i class="prompt">&gt; </i>No notes yet. Open a product preview and tap the pin to leave one.</p>'
    }`;
  el.querySelectorAll('section.notes').forEach(s => wireProduct(el, s));
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
  // a thumbnail opens the screenshot (or a picture added to the note) over the screen; a tap anywhere closes it
  el.querySelectorAll('[data-shot], [data-picture]').forEach(
    b =>
      (b.onclick = () => {
        const picture = b.dataset.picture,
          z = document.createElement('div');
        const url = picture
          ? reviewPicture(world.dev, picture, b.dataset.file)
          : reviewShot(world.dev, b.dataset.shot, b.dataset.file);
        const alt = picture ? 'A picture added to the note' : 'Screenshot of the page when the note was made';
        z.className = 'zoom';
        z.innerHTML = `<img src="${esc(url)}" alt="${alt}"><a href="${esc(url)}" target="_blank" rel="noopener">Full size ↗</a>`;
        z.onclick = e => {
          if (e.target.tagName !== 'A') z.remove();
        };
        el.parentNode.append(z);
        sfx.blip();
      }),
  );
  if (!first) return;
  want.shown = true;
  const section = el.querySelector('section.wanted');
  if (section) requestAnimationFrame(() => section.scrollIntoView({ block: 'start' }));
}
// A product's section: its ticks, and Send, Call and Discard on the ticked notes
function wireProduct(el, s) {
  const ui = {
    boxes: [...s.querySelectorAll('[data-note]')],
    send: s.querySelector('[data-send]'),
    drop: s.querySelector('[data-discard]'),
    msg: s.querySelector('.msg'),
  };
  const ring = s.querySelector('[data-call]');
  const all = s.querySelector('[data-all]');
  if (!ui.send) return;
  const { boxes, send, drop } = ui;
  const chosen = () => boxes.filter(b => b.checked).map(b => +b.dataset.note);
  const paint = () => {
    const n = Math.min(chosen().length, SEND_MAX),
      every = chosen().length === boxes.length;
    send.textContent = n ? `Send ${n}` : 'Send';
    send.disabled = drop.disabled = !n;
    ask.show();
    ring.textContent = `Call ${s.dataset.owner}`;
    ring.disabled = !n;
    if (all) {
      all.textContent = every ? 'Untick all' : 'Tick all';
      all.dataset.every = every ? 1 : '';
    }
  };
  wireTicks(boxes, all, paint);
  const busy = busyIn(el, ui, paint);
  const ask = discardAsk(ui, chosen, busy);
  paint();
  send.onclick = () => {
    const ids = chosen().slice(0, SEND_MAX);
    busy(
      'Sending…',
      () => sendNotes(world.dev, s.dataset.slug, ids),
      r => {
        sfx.ding(0.6);
        toast(
          `<b>Sent to ${esc(r.name)}</b><br>${r.count} ${r.count === 1 ? 'note' : 'notes'} · job ${jobNameLink(r.job, r.job_code)}`,
        );
        if (s.classList.contains('wanted')) notesWanted?.sent?.(ids, r.count, r.name);
      },
    );
  };
  // a call about the ticked notes sends none of them: on it, the maker marks each one sent or leaves it waiting here
  ring.onclick = () => {
    sfx.blip();
    callAgent(s.dataset.agent, s.dataset.owner, 0, chosen().slice(0, SEND_MAX));
  };
}
function wireTicks(boxes, all, paint) {
  const set = (b, on) => {
    b.checked = on;
    ticked[on ? 'add' : 'delete'](+b.dataset.note);
  };
  boxes.forEach(
    b =>
      (b.onchange = () => {
        set(b, b.checked);
        paint();
      }),
  );
  if (all)
    all.onclick = () => {
      const on = !all.dataset.every;
      boxes.forEach(b => set(b, on));
      paint();
      sfx.blip();
    };
}
// a send or discard on its way: the section's keys wait, its line says what's happening, and Reviews draws again after
const busyIn =
  (el, { send, drop, msg }, paint) =>
  async (doing, fn, done) => {
    notesBusy = true;
    send.disabled = drop.disabled = true;
    msg.textContent = doing;
    try {
      done(await fn());
    } catch (e) {
      const status = +String(e.message).match(/\d{3}$/)?.[0];
      msg.textContent = status
        ? `That didn’t go through (error ${status}). Try again in a minute.`
        : 'Could not reach the coordinator. Try again.';
      notesBusy = false;
      paint();
      return;
    }
    notesBusy = false;
    notes(el);
    refreshWaitingNotes();
    toldReview();
  };
// discarding can't be undone: the first tap asks, the second does it. The discarded notes no longer count on the
// viewer's Send. (steady: the row beside it stays put. Asking, the key says only "Sure?", no wider than Discard, so
// it keeps its own word's size; the line under it says what a second tap does.)
const discardAsk = ({ drop, msg }, chosen, busy) =>
  askAgain(drop, {
    status: msg,
    label: 'Discard',
    again: 'Sure?',
    question: () => `Tap again to discard ${noteCount(chosen().length)} for good.`,
    steady: true,
    act: () => {
      const ids = chosen();
      busy(
        'Discarding…',
        () => discardNotes(world.dev, ids),
        r => {
          sfx.blip();
          toast(`<b>Discarded</b><br>${r.count} ${r.count === 1 ? 'note' : 'notes'}`);
          unpin(ids);
        },
      );
    },
  });
// Shared for outside notes: each open
// share with what it opens and until when, its people (Send link, Remove, Invite) and End now (two taps, like Discard),
// as the viewer's Share shows it. An ended one says who was on it and where its notes went, for a week.
// Each open share is folded to its heading and one line (its people, the notes they sent, until when), and
// opens to the rest; the ended ones sit below.
const shareWhere = s => `${esc(s.what)}${s.prefix === '/' ? '' : ` (${esc(s.prefix)})`}`;
const foldLine = s =>
  [
    s.people.map(p => p.name).join(', ') || 'Nobody yet',
    s.view ? '' : `${noteCount(s.people.reduce((n, p) => n + (p.sent ? +p.notes : 0), 0))} sent`,
    `until ${dayTime(s.ends)}`,
  ]
    .filter(Boolean)
    .join(' · ');
const openShareHtml = (
  s,
  open,
) => `<details${open ? ' open' : ''}><summary><h3><span>${shareTitle(kindOf(s))} on ${shareWhere(s)}</span></h3><span class="dim">${esc(foldLine(s))}</span></summary>
  <p class="dim">${untilLine(s)}</p>${shareHtml(s)}</details>`;
// (unfolded: the ids of the shares the board has open)
function sharesHtml(shares, unfolded) {
  const ended = s =>
    `<li class="old"><span class="st st-ended">ended</span><b>${shareWhere(s)}</b><span class="dim by">${[went(s), esc(s.people.map(p => p.name).join(', '))].filter(Boolean).join(' · ')}</span></li>`;
  const old = shares.filter(s => s.ended && !s.reopens);
  return `${shares
    .filter(s => !s.ended || s.reopens)
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
