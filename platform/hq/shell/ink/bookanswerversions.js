// A note tried in a few versions: on its page a small tab, "3 versions →", that turns to theirs; on the versions page
// the agent's heading ("Lark tries:" and the note's words), the note as it was, then a frame per version side by side
// and wrapping down, each with its two-word name and a strip to write a reply on, and an empty frame for each still
// being made that fills in as it lands.
// The board writes anywhere on the frames: a ring round a version, a tick on it, words under it. What it wrote goes,
// once the pen rests, as a reply on the version it's on (frameUnder: where it is, never its shape), with the box the
// version's picture shows in, so the judge reads it over the frame; the judge's 'pick' picks it, and its frame gets a
// stamp.
import { esc } from '../../util.js';
import { inkOf } from './agentink.js';
import { SQUIGGLE, inkBox, pathsOf } from './bookanswerart.js';
import { frameUnder, framesLaid } from './bookanswerpace.js';

// Where the versions start on their page (under its heading), and the paper they wrap within at most
const TOP = 72,
  LEFT = 24,
  WIDEST = 960,
  RAIL = 52, // (the book's controls float over the paper's right edge)
  CAPTION = 96; // (under a frame: its name, and the strip to write a reply on)
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];

// The tab a group gets for its versions: { count } (written and still coming), or null for none
export function versionsTab(g) {
  const made = g.children.filter(c => c.kind === 'answer' && c.style === 'version').length,
    count = g.waiting?.style === 'versions' ? Math.max(made, g.waiting.count ?? 0) : made;
  return count || g.tries_page ? { count } : null;
}

// The versions page under its heading: drawn whole again on every read, its frames kept as they were where nothing changed
// (layer: bookanswers.js's; read: { tries, tried }; parts: its faces (faced: what the face is drawn as), reply strips and
// the pen on them)
export function drawVersions(layer, { tried }, parts) {
  const versions = tried.children.filter(c => c.kind === 'answer' && c.style === 'version'),
    replies = tried.children.filter(c => c.kind === 'reply'),
    expected = tried.waiting?.style === 'versions' ? (tried.waiting.count ?? 0) : 0,
    empty = Math.max(0, expected - versions.length),
    by = versions[0] ?? tried.waiting ?? { by: tried.owner ?? '', name: tried.owner_name ?? 'An agent' };
  const paper = paperOf(layer, () => drawVersions(layer, { tried }, parts));
  if (paper === null) return;
  const width = Math.min(WIDEST, paper) - LEFT * 2 - RAIL,
    { frames, height } = framesLaid(1 + versions.length + empty, width, { caption: CAPTION });
  const key = JSON.stringify([tried, width, parts.faced(by.by)]);
  if (layer.drawn.get('versions')?.key === key) return;
  const old = layer.drawn.get('versions')?.el;
  // (never under the board's pen: drawn again once what it's writing has gone.)
  if (old?.querySelector('.bk-versions-frames[data-inking]'))
    return void (layer.later = () => drawVersions(layer, { tried }, parts));
  const el = document.createElement('section');
  el.className = 'bk-versions';
  el.style.cssText = `left:${LEFT}px;top:${TOP}px;width:${width}px;--ink:${inkOf(by.by)}`;
  el.setAttribute('aria-label', `${by.name} tries: ${tried.words}`);
  const cells = [
    snipHtml(tried, frames[0]),
    ...versions.map((v, i) => versionHtml(v, i, frames[i + 1], replies, parts)),
    ...Array.from({ length: empty }, (_, i) =>
      emptyHtml(versions.length + i, frames[versions.length + i + 1], parts.faceHtml(by)),
    ),
  ];
  // (its heading is the page's own: "Lark tries: …", bookpage.js; the replies' ink over the frames, where it was written)
  const mine = replies.filter(r => versions.some(v => v.id === r.answers));
  el.innerHTML = `<div class="bk-versions-frames" style="height:${height}px">${cells.join(
    '',
  )}<svg class="bk-reply-ink" aria-hidden="true"><g class="bk-reply-sent" transform="translate(${-LEFT} ${-TOP})">${pathsOf(
    mine.flatMap(r => r.ink ?? []),
  )}</g><g class="bk-reply-wet"></g></svg></div>`;
  if (old) markNew(el, old);
  wirePen(el.querySelector('.bk-versions-frames'), layer, versions, frames, parts);
  old?.remove();
  layer.slot.append(el);
  layer.drawn.set('versions', { key, el });
}

// The paper's width across at 100%, null before the book has sized it; again() lays the frames again whenever it sizes
// it (bookpages.js's bk:paper on the world, as the book opens and when the screen turns).
export function paperOf(layer, again) {
  layer.again = again;
  const world = layer.slot.closest('.bk-world');
  if (world && !layer.hearsPaper) {
    layer.hearsPaper = true;
    const heard = () => (layer.slot.isConnected ? layer.again() : world.removeEventListener('bk:paper', heard));
    world.addEventListener('bk:paper', heard);
  }
  return paperWidth(layer);
}
// One that wasn't there a moment ago lands in its empty frame; one picked a moment ago gets its stamp
function markNew(el, old) {
  const was = new Map(
    [...old.querySelectorAll('.bk-version[data-answer]')].map(f => [f.dataset.answer, f.hasAttribute('data-picked')]),
  );
  for (const frame of el.querySelectorAll('.bk-version[data-answer]')) {
    if (!was.has(frame.dataset.answer)) frame.classList.add('bk-version-landed');
    if (was.get(frame.dataset.answer) === false && frame.hasAttribute('data-picked'))
      frame.classList.add('bk-version-stamped');
  }
}
// The board's pen on the frames: what it writes goes to the version it's on, with the box that version's picture
// shows in (each frame as the board sees it: its picture, and the caption and strip under it); a read that came while
// it wrote is drawn once that's gone.
function wirePen(frameEl, layer, versions, frames, parts) {
  const under = versions.map((v, i) => ({ v, box: frames[i + 1] }));
  parts.wirePen(frameEl, {
    origin: () => ({ x: LEFT, y: TOP }),
    done: () => {
      const later = layer.later;
      layer.later = null;
      later?.();
    },
    to: ink => {
      const drawn = inkBox(ink),
        i = drawn
          ? frameUnder(
              { x0: drawn.x0 - LEFT, y0: drawn.y0 - TOP, x1: drawn.x1 - LEFT, y1: drawn.y1 - TOP },
              under.map(({ box }) => ({ ...box, h: box.h + CAPTION })),
            )
          : -1;
      if (i < 0) return null;
      const { v, box } = under[i];
      return { answer: v.id, frame: { x: LEFT + box.x, y: TOP + box.y, w: box.w, h: box.h } };
    },
  });
}

// What the book's paper shows across at 100% (bookpages.js's --paper-w), or null before it has a size
const paperWidth = layer =>
  parseFloat(layer.slot.closest('.bk-world')?.style.getPropertyValue('--paper-w') ?? '') || null;

const placed = box => `left:${box.x}px;top:${box.y}px;width:${box.w}px`;

// The note as it was: its picture, or its words and ink on a card
function snipHtml(g, box) {
  const picture = g.pictures?.[0]?.url,
    ink = g.ink ?? [],
    drawn = inkBox(ink);
  const inside = picture
    ? `<img src="${esc(picture)}" alt="">`
    : `${
        drawn
          ? `<svg viewBox="${drawn.x0} ${drawn.y0} ${drawn.x1 - drawn.x0} ${drawn.y1 - drawn.y0}" aria-hidden="true">${pathsOf(ink)}</svg>`
          : ''
      }<span class="bk-snip-words">${esc(g.words)}</span>`;
  return `<figure class="bk-version bk-version-snip" style="${placed(box)}"><div class="bk-version-paper" style="height:${
    box.h
  }px">${inside}</div><figcaption>your note, then</figcaption></figure>`;
}
// (its replies' ink is drawn over all the frames, drawVersions; its strip shows where words go)
function versionHtml(v, i, box, _replies, parts) {
  return `<figure class="bk-version" data-answer="${v.id}" style="${placed(box)}"${v.picked ? ' data-picked' : ''}><div class="bk-version-paper" style="height:${
    box.h
  }px">${v.picture ? `<img src="${esc(v.picture)}" alt="${esc(v.version ?? '')}" draggable="false">` : ''}${
    v.picked ? STAMP : ''
  }</div><figcaption>${i + 1} · ${esc(v.version ?? '')}</figcaption>${parts.replyHtml(
    [],
    `Write on version ${i + 1}, ${v.version ?? ''}, to reply, or circle it to pick it`,
  )}</figure>`;
}
// The pick's stamp, a rubber stamp's "this one" pressed a little crooked on the frame, as a sent page's (bookshelf.css)
const STAMP =
  '<svg class="bk-version-stamp" viewBox="0 0 120 40" role="img" aria-label="Picked"><rect x="2" y="2" width="116" height="36" rx="7"/><rect x="6.5" y="6.5" width="107" height="27" rx="4"/><text x="60" y="27.6" text-anchor="middle">THIS ONE</text></svg>';
function emptyHtml(i, box, face) {
  return `<figure class="bk-version" data-empty style="${placed(box)}"><div class="bk-version-paper" style="height:${
    box.h
  }px">${face}${SQUIGGLE}<span>drawing the ${ORDINALS[i] ?? `next`} one…</span></div></figure>`;
}
