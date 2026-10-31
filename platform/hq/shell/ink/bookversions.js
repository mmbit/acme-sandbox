// A try's versions under the board's scrap, on the scrap's own page: one answer scrap, "<Name> · on staging", with a
// frame per version (A, B, C…: its screenshot, its two-word name, what's different, its live preview), a frame of
// pencil dots for each still coming, or, once a try ended with none, why, in their place.
// The board's pen anywhere on the frames (a circle, a tick, a cross, words) goes, once it rests, as a reply on the
// version it's on (frameUnder: where it is, never its shape), with the box that version's picture shows in, so the
// coordinator's judge reads it over the frame: a circle or a tick chooses it (stamped CHOSEN), a cross crosses it out.
//
// versionsEl(g, parts, was) → the block's <section>, or null when g has neither a try nor a version
//   g: a group as HQ reads it: its try ({ state: 'coming' | 'made' | 'empty', expect, by, name, reason } or null) and
//     its children, the versions among them (answers of style 'version', in order: A, B, C…) with the board's replies.
//   parts: { root, faceHtml, wirePen }. root: the element whose px are the page's, that the block is in (a reply's ink
//     and frame are in its px). faceHtml({ by, name }): an agent's face. wirePen(el, { origin, to }): the board's pen
//     on el (bookanswers.js, over bookanswerreply.js wireReply), to(ink) naming the version it goes to ({ answer,
//     frame }, or null for none).
//   was: the block it's drawn again over, if any, so a version that just came lands and a pick just made is pressed.
// The caller puts it in place and gives it the width it may take (left, top, width); it takes less where its frames
// need less, and they wrap within it, 1 to 4 across.
import { esc } from '../../util.js';
import { inkOf } from './agentink.js';
import { DOTS, inkBox, pathsOf } from './bookanswerart.js';
import { frameUnder } from './bookversionframes.js';
import { LETTERS, versionsOf } from './bookversionsof.js';

export function versionsEl(g, parts, was = null) {
  const read = versionsOf(g);
  if (!read) return null;
  const { who, versions, coming } = read;
  const el = document.createElement('section');
  el.className = 'bk-versions';
  el.dataset.g = g.id;
  el.style.setProperty('--ink', inkOf(who.by));
  el.style.setProperty('--frames', String(Math.max(1, versions.length + coming)));
  el.setAttribute('aria-label', `${who.name}’s versions of “${g.words ?? ''}”`);
  const frames = [
    ...versions.map(({ v, letter, fate }) => versionHtml(v, letter, fate)),
    ...Array.from({ length: coming }, (_, i) => comingHtml(LETTERS[versions.length + i])),
  ];
  el.innerHTML = `<header class="bk-versions-head">${parts.faceHtml(who)}<b>${esc(who.name)}</b><span>· on staging</span></header>${
    read.ended
      ? `<p class="bk-versions-ended" role="status">${esc(read.ended)}</p>`
      : `<div class="bk-versions-frames">${frames.join('')}${inkHtml(versions.flatMap(({ replies }) => replies))}</div>`
  }`;
  if (was) markNew(el, was);
  const surface = el.querySelector('.bk-versions-frames');
  if (surface) wirePen(surface, parts);
  // (a press on a live preview is its own: never the pen's, nor the page's pan)
  for (const link of el.querySelectorAll('.bk-version-link'))
    for (const type of ['pointerdown', 'touchstart']) link.addEventListener(type, e => e.stopPropagation());
  return el;
}

// ---- a frame

// A version: its screenshot (CHOSEN stamped on it once the board chose it), then its letter, name, what's different,
// and its live preview, or what's become of it (its fate)
function versionHtml(v, letter, fate) {
  const marks = [v.picked && 'data-picked', v.crossed && 'data-crossed', fate && 'data-cleared'].filter(Boolean);
  const label = `${letter}, ${v.version ?? ''}${v.picked ? ', chosen' : ''}${v.crossed ? ', crossed out' : ''}`;
  return `<figure class="bk-version" data-answer="${v.id}" ${marks.join(' ')} aria-label="${esc(label)}"><div class="bk-version-paper">${
    v.picture ? `<img src="${esc(v.picture)}" alt="" draggable="false">` : ''
  }${v.picked ? STAMP : ''}</div><figcaption><b class="bk-version-letter">${letter}</b><span class="bk-version-name">${esc(
    v.version ?? '',
  )}</span></figcaption>${v.text ? `<p class="bk-version-text">${esc(v.text)}</p>` : ''}${footHtml(v, fate)}</figure>`;
}
// (a preview opens in HQ's viewer: desk.js hears the tap on its link, as on any preview's. A version with its branch
// and no preview is a product's with a server of its own, which has none: its picture is the version. One GitHub
// refused a branch says so, its reply in the coordinator's log)
const footHtml = (v, fate) =>
  fate
    ? `<p class="bk-version-foot bk-version-fate">${fate}</p>`
    : `<p class="bk-version-foot">${
        v.link
          ? `<a class="bk-version-link" href="${esc(v.link)}" target="_blank" rel="noopener">live preview ↗</a>`
          : v.branch
            ? 'picture only: its app has no preview per version'
            : v.branch_failed
              ? 'no branch or preview: GitHub refused it'
              : ''
      }</p>`;
// CHOSEN, a rubber stamp pressed a little crooked across the chosen one's picture
const STAMP =
  '<svg class="bk-version-stamp" viewBox="0 0 200 56" role="img" aria-label="Chosen"><rect x="3" y="3" width="194" height="50" rx="7"/><rect x="9" y="9" width="182" height="38" rx="4"/><text x="100" y="39" text-anchor="middle">CHOSEN</text></svg>';
const comingHtml = letter =>
  `<figure class="bk-version" data-empty aria-label="${letter}, still coming"><div class="bk-version-paper">${DOTS}</div><figcaption><b class="bk-version-letter">${letter}</b></figcaption></figure>`;

// The board's ink on the versions (versionsOf's replies), each reply's in a layer
// of its own that fitInk lays over its version's frame
function inkHtml(replies) {
  return `<svg class="bk-reply-ink" aria-hidden="true"><g class="bk-reply-sent">${replies
    .map(
      r =>
        `<g data-on="${r.answers}"${r.frame ? ` data-frame="${esc(JSON.stringify(r.frame))}"` : ''}>${pathsOf(r.ink ?? [])}</g>`,
    )
    .join('')}</g><g class="bk-reply-wet"></g></svg>`;
}

// One that wasn't there a moment ago lands in its empty frame; one chosen a moment ago gets its stamp pressed
function markNew(el, was) {
  const before = new Map(
    [...was.querySelectorAll('.bk-version[data-answer]')].map(f => [f.dataset.answer, f.hasAttribute('data-picked')]),
  );
  for (const frame of el.querySelectorAll('.bk-version[data-answer]')) {
    if (!before.has(frame.dataset.answer)) frame.classList.add('bk-version-landed');
    if (before.get(frame.dataset.answer) === false && frame.hasAttribute('data-picked'))
      frame.classList.add('bk-version-stamped');
  }
}

// ---- the board's pen on the frames

// What the pen writes goes to the version it's on, with the box its picture shows in, both in root's px; the ink sent
// before is laid over its version's frame wherever the frames wrap to now (laid again as the block's size changes)
function wirePen(surface, { root, wirePen: wire }) {
  const origin = () => offsetIn(surface, root);
  wire(surface, {
    origin,
    to: ink => {
      const drawn = inkBox(ink),
        shown = framesIn(surface, root),
        i = drawn
          ? frameUnder(
              drawn,
              shown.map(f => f.whole),
            )
          : -1;
      return i < 0 ? null : { answer: shown[i].answer, frame: shown[i].paper };
    },
  });
  new ResizeObserver(() => surface.offsetWidth && fitInk(surface, root)).observe(surface);
}
// Each reply's ink where it was written: over the frame it was written on, moved and sized with it, or where it was on
// the page for a reply sent without one
function fitInk(surface, root) {
  const o = offsetIn(surface, root),
    shown = new Map(framesIn(surface, root).map(f => [String(f.answer), f.paper]));
  for (const layer of surface.querySelectorAll('.bk-reply-sent > g')) {
    const then = layer.dataset.frame && JSON.parse(layer.dataset.frame),
      now = shown.get(layer.dataset.on);
    layer.setAttribute(
      'transform',
      then && now
        ? `translate(${now.x - o.x} ${now.y - o.y}) scale(${now.w / then.w}) translate(${-then.x} ${-then.y})`
        : `translate(${-o.x} ${-o.y})`,
    );
  }
}
// The versions' frames in root's px: { answer, whole (the frame with its caption, where a mark counts as on it),
// paper (the box its picture shows in) }
const framesIn = (surface, root) =>
  [...surface.querySelectorAll('.bk-version[data-answer]')].map(f => {
    const at = offsetIn(f, root),
      paper = f.querySelector('.bk-version-paper');
    return {
      answer: Number(f.dataset.answer),
      whole: { x: at.x, y: at.y, w: f.offsetWidth, h: f.offsetHeight },
      paper: { x: at.x + paper.offsetLeft, y: at.y + paper.offsetTop, w: paper.offsetWidth, h: paper.offsetHeight },
    };
  });
// Where el's top-left is in root's px (its offset parents up to root, and the borders inside them)
function offsetIn(el, root) {
  let x = 0,
    y = 0;
  for (let at = el; at && at !== root; at = at.offsetParent) {
    const inside = at.offsetParent === root ? null : at.offsetParent;
    x += at.offsetLeft + (inside?.clientLeft ?? 0);
    y += at.offsetTop + (inside?.clientTop ?? 0);
  }
  return { x, y };
}
