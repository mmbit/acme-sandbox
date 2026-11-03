// A slip: an agent's answer clipped onto a note in the book (the coordinator's bookslips.ts), typed on a strip of paper
// under a paper clip, with "then and now": the note's snip as it was marked beside the running preview of something
// new, or a cut of the same place kept from before rule zero (a page no longer cuts one: nothing of a note follows it
// on the page). A tick in its box closes the note; the reader's reply is its own (the book's: drawn in the room it
// pulls out under the slip, `more`). A fix (slip.fix, the change it proposes) has its box beside its line instead,
// round its drawing when it's drawn: ticked, it's built once the page is sent. A picture says where its numbers came
// from under it (slip.source). The book (HQ's bookgroups.js) draws it with
// slipHtml and wires it with wireSlips; isTick, the Pencil's tick written on a slip in the book, is plain maths
// (slip.test.js). Its words come from the caller in the reader's language: say(key, places), a word by its key with
// its {places} filled (HQ's book: notebookwords.js, slip* keys).

// The look: the book's paper and indigo, the answer typed
export const CSS = `
      .answer-slip { position: relative; margin: 12px 0 2px; padding: 14px 12px 10px; background: #fffdf6; color: #2a2352;
        border-radius: 2px; transform: rotate(.5deg); box-shadow: 0 1px 0 rgba(42,35,82,.08), 0 3px 10px rgba(42,35,82,.14);
        font: 14px/1.45 "Atkinson Hyperlegible", system-ui, -apple-system, sans-serif; text-align: left; }
      .answer-slip + .answer-slip { transform: rotate(-.4deg); }
      .answer-slip[data-ticked] { opacity: .62; }
      .slip-clip { position: absolute; left: 16px; top: -13px; width: 14px; height: 34px; fill: none; stroke: #8d8aa3;
        stroke-width: 1.6; stroke-linecap: round; }
      .slip-by { display: block; margin: 0 34px 3px 18px; font-weight: 700; font-size: 12px; letter-spacing: .03em; color: #5a5478; }
      .slip-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere;
        font-family: "American Typewriter", "Courier Prime", "Courier New", ui-monospace, monospace; font-size: 13.5px; }
      .slip-pic { display: block; max-width: 100%; margin-top: 8px; border-radius: 2px; }
      .slip-source { margin: 3px 0 0; font-size: 11.5px; line-height: 1.35; color: #5a5478; }
      .answer-slip[data-fix][data-ticked] { opacity: 1; }
      .slip-fix { position: relative; display: flex; align-items: center; gap: 10px; margin-top: 10px; }
      .slip-fix .slip-tick { position: relative; right: auto; top: auto; flex: none; background: var(--bk-chosen, #d6ea3c); }
      .slip-fix .slip-tick svg { stroke: #2a2352; }
      .slip-fix .slip-tick:disabled { cursor: default; }
      .slip-fix-words { font-weight: 700; font-size: 14px; line-height: 1.3; }
      .slip-fix[data-art] { flex-direction: column; align-items: flex-start; gap: 14px; }
      .slip-fix-art { position: relative; box-sizing: border-box; max-width: 100%; padding: 16px; border-radius: 3px;
        cursor: pointer; box-shadow: inset 0 0 0 1.5px #2a2352; transition: background-color .2s ease-out; }
      .slip-fix-art .slip-tick { position: absolute; right: -10px; bottom: -10px; }
      .answer-slip[data-ticked] .slip-fix-art { background: var(--bk-chosen, #d6ea3c); }
      .slip-fix-said { margin: 6px 0 0; font-size: 12px; color: #5a5478; }
      .slip-then { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }
      .slip-then figure { margin: 0; min-width: 0; }
      .slip-then img, .slip-then .slip-none { display: block; width: 100%; aspect-ratio: 4 / 3; object-fit: cover;
        border-radius: 2px; box-shadow: inset 0 0 0 1px #e8dcc4; background: #f6efe0; }
      .slip-then .slip-none { display: grid; place-items: center; padding: 6px; box-sizing: border-box; color: #5a5478;
        font-size: 11.5px; line-height: 1.3; text-align: center; }
      .slip-then figcaption { margin-top: 3px; font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: #5a5478; }
      .answer-slip a { color: #2a2352; font-weight: 700; text-underline-offset: 2px; }
      .slip-tick { all: unset; box-sizing: border-box; position: absolute; right: 10px; top: 9px; width: 26px; height: 26px;
        border-radius: 3px; box-shadow: inset 0 0 0 1.5px #2a2352; cursor: pointer; display: grid; place-items: center; }
      .slip-tick::after { content: ""; position: absolute; inset: -9px; }
      .slip-tick:focus-visible { outline: 2px solid #2a2352; outline-offset: 2px; }
      .slip-tick svg { width: 24px; height: 24px; fill: none; stroke: #e03131; stroke-width: 3; stroke-linecap: round;
        stroke-linejoin: round; stroke-dasharray: 40; stroke-dashoffset: 40; transition: stroke-dashoffset .3s ease-out; }
      .slip-tick[aria-pressed="true"] svg { stroke-dashoffset: 0; }
      .slip-said { margin: 4px 0 0; font-size: 12px; color: #5a5478; }`;

const CLIP =
  '<svg class="slip-clip" viewBox="0 0 14 34" aria-hidden="true"><path d="M10 9v15a3.5 3.5 0 0 1-7 0V6a5 5 0 0 1 10 0v19"/></svg>';
const TICK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13l5.5 5L21 4"/></svg>';
const esc = s =>
  String(s ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

// What "now" shows beside the note's snip: something new's running preview (its cover, a link to it, or that it's being
// built), else a cut of the same place kept from before rule zero, else nothing: the snip alone. { src?, href?, label,
// empty? } or null
export function nowOf(slip, say) {
  const p = slip.preview;
  if (p?.pending) return { label: say('slipNow'), empty: say('slipPreviewPending') };
  if (p)
    return {
      src: p.picture,
      href: p.open,
      label: say('slipNowOf', { name: p.name ?? say('slipPreview') }),
      empty: say('slipRunning'),
    };
  return slip.now ? { src: slip.now, label: say('slipNow') } : null;
}

// One slip under its note (note: the store's, with its snip), as HTML. say: the reader's words; mark: what follows the
// agent's name to say it's an AI (a guest's book: charter rule 5); more: the reader's own HTML under its words (a
// notebook answer's form, and the room to answer in); art: a fix's drawing, drawn inside its box.
export function slipHtml(slip, note, { say, mark = '', more = '', art = '' }) {
  const ticked = Boolean(slip.ticked),
    name = slip.name ?? slip.by,
    marked = mark ? `${name} · ${mark}` : name;
  // its words in the reader's language, named before the markup they go in
  const label = esc(say('slipAnswer', { name: marked })),
    by = esc(marked),
    tick = esc(tickWords(ticked, say, Boolean(slip.fix), slip.builder)),
    made = esc(say('slipMade', { name }));
  const marks = `${ticked ? ' data-ticked' : ''}${slip.fix ? ' data-fix' : ''}`;
  const box = `<button class="slip-tick" type="button" aria-pressed="${ticked}" aria-label="${tick}"${
    slip.builder ? ' disabled' : ''
  }>${TICK}</button>`;
  const words = `<b class="slip-by">${by}</b><p class="slip-text">${esc(slip.text)}</p>`;
  const picture = slip.picture ? `<img class="slip-pic" src="${esc(slip.picture)}" alt="" loading="lazy">` : '';
  const source = slip.picture && slip.source ? `<p class="slip-source">${esc(slip.source)}</p>` : '';
  const fix = slip.fix ? fixHtml(slip, box, art, say) : '';
  const link = slip.link
    ? `<p class="slip-said"><a href="${esc(slip.link)}" target="_blank" rel="noopener">${made}</a></p>`
    : '';
  const then = thenHtml(note, nowOf(slip, say), say);
  return `<section class="answer-slip" data-slip="${slip.id}"${marks} aria-label="${label}">${CLIP}${
    slip.fix ? '' : box
  }${words}${picture}${source}${fix}${link}${then}${more}<p class="slip-said" hidden></p></section>`;
}
// A fix's box beside its line, or at the corner of its drawing, and what its tick does under it
function fixHtml(slip, box, art, say) {
  const line = `<b class="slip-fix-words">${esc(say('slipFix', { fix: slip.fix }))}</b>`;
  const fix = art
    ? `<div class="slip-fix" data-art><div class="slip-fix-art">${art}${box}</div>${line}</div>`
    : `<div class="slip-fix">${box}${line}</div>`;
  return `${fix}<p class="slip-fix-said">${esc(fixWords(Boolean(slip.ticked), say, slip.builder))}</p>`;
}
// The note's snip as it was marked beside what's there now (nowOf), or nothing when the note has no snip
function thenHtml(note, now, say) {
  if (!note.snip) return '';
  const thenAlt = esc(say('slipThenAlt')),
    thenCaption = esc(say('slipThen')),
    nowAlt = esc(say('slipNowAlt'));
  const nowPic =
    now &&
    (now.src
      ? `<img src="${esc(now.src)}" alt="${nowAlt}" loading="lazy">`
      : `<span class="slip-none">${esc(now.empty)}</span>`);
  const nowFig = now?.href ? `<a href="${esc(now.href)}" target="_blank" rel="noopener">${nowPic}</a>` : nowPic;
  const then = `<figure><img src="${esc(note.snip)}" alt="${thenAlt}" loading="lazy"><figcaption>${thenCaption}</figcaption></figure>`;
  return `<div class="slip-then">${then}${
    now ? `<figure>${nowFig}<figcaption>${esc(now.label)}</figcaption></figure>` : ''
  }</div>`;
}
// What a slip's box says (fix: a fix's box, which says what its tick does; builder: who's building it)
const tickWords = (ticked, say, fix, builder = null) =>
  fix ? fixWords(ticked, say, builder, 'slipFixTick') : say(ticked ? 'slipTicked' : 'slipTick');
// What a fix's tick does: built once the page is sent, or being built (builder: by whom)
const fixWords = (ticked, say, builder = null, unticked = 'slipFixSend') =>
  builder ? say('slipFixBuilt', { name: builder }) : say(ticked ? 'slipFixTicked' : unticked);

// The slips under root wired: a tap on a tick box ticks it (or takes the tick back). on: { tick(id, ticked) }, a
// promise; refused, the slip says why and stays as it was. say: the reader's words, as slipHtml's.
export function wireSlips(root, on, say) {
  for (const slip of root.querySelectorAll('.answer-slip')) {
    const box = slip.querySelector('.slip-tick'),
      said = slip.querySelector('.slip-said[hidden]');
    // (a finger or the Pencil here is the slip's: never the book's pan or the page's ink)
    for (const type of ['pointerdown', 'touchstart', 'touchmove']) box.addEventListener(type, e => e.stopPropagation());
    const tell = text => Object.assign(said, { textContent: text, hidden: !text });
    box.addEventListener('click', () =>
      tickBox(slip, on, !slip.hasAttribute('data-ticked'), say).catch(e => tell(e.message)),
    );
    // (a fix's drawing ticks it too, a tap on it: a finger still moves the page from it)
    slip.querySelector('.slip-fix-art')?.addEventListener('click', e => e.target.closest('.slip-tick') || box.click());
  }
}
// A slip ticked (or not), its box at once, back as it was if the store refuses
export async function tickBox(slip, on, ticked, say) {
  const box = slip.querySelector('.slip-tick'),
    fix = slip.hasAttribute('data-fix'),
    said = slip.querySelector('.slip-fix-said');
  // (a built fix's box is disabled: it never comes here)
  const show = t => {
    slip.toggleAttribute('data-ticked', t);
    box.setAttribute('aria-pressed', String(t));
    box.setAttribute('aria-label', tickWords(t, say, fix));
    if (said) said.textContent = fixWords(t, say);
  };
  show(ticked);
  try {
    await on.tick(Number(slip.dataset.slip), ticked);
  } catch (e) {
    show(!ticked);
    throw e;
  }
}

// ---- a tick written with the Pencil

// Whether a line is a tick: down to a low point, then up the other way, further than it came down (a V counts), with
// little else in it (a scribble's length is far more than its two legs). points: [x, y, ...] in px.
export function isTick(points) {
  if (points.length < 3) return false;
  const low = points.reduce((best, p, i) => (p[1] > points[best][1] ? i : best), 0);
  const [a, m, b] = [points[0], points[low], points.at(-1)];
  const down = m[1] - a[1],
    up = m[1] - b[1],
    w = Math.abs(b[0] - a[0]);
  if (low === 0 || low === points.length - 1 || down < 4 || up < down * 0.6 || w < 8) return false;
  // (both legs go the same way across: left to right, or right to left)
  if (Math.sign(m[0] - a[0] || 1) !== Math.sign(b[0] - m[0])) return false;
  let length = 0;
  for (let i = 1; i < points.length; i++)
    length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  const legs = Math.hypot(m[0] - a[0], down) + Math.hypot(b[0] - m[0], up);
  return length <= legs * 1.5;
}
// The slip a line lies over: the one whose box holds the middle of its bounds. slips: [{ id, x, y, w, h }]
export function slipUnder(points, slips) {
  const xs = points.map(p => p[0]),
    ys = points.map(p => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2,
    cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  return slips.find(s => cx >= s.x && cx <= s.x + s.w && cy >= s.y && cy <= s.y + s.h) ?? null;
}

// Whether a note (or a mark) has an answer not yet ticked
export const answered = n => (n.slips ?? []).some(s => !s.ticked);
// A slip's corner peeking out under a note's number: a little paper with a clip
export function tab(g, b) {
  const x = Math.max(12, b.x - 6) + 6,
    y = Math.max(12, b.y - 6) + 4;
  g.save();
  g.translate(x, y);
  g.rotate(0.12);
  g.fillStyle = '#fffdf6';
  g.shadowColor = 'rgba(42,35,82,.3)';
  g.shadowBlur = 3;
  g.shadowOffsetY = 1;
  g.fillRect(0, 0, 18, 13);
  g.shadowColor = 'transparent';
  g.strokeStyle = '#2a2352';
  g.lineWidth = 1;
  for (const dy of [4, 7, 10]) {
    g.beginPath();
    g.moveTo(3, dy);
    g.lineTo(dy === 10 ? 10 : 15, dy);
    g.stroke();
  }
  g.restore();
}
