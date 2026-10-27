// A slip: an agent's answer clipped onto a note in the book (the coordinator's bookslips.ts), typed on a strip of paper
// under a paper clip, with "then and now": the note's snip as it was marked beside the running preview of something
// new, or a cut of the same place kept from before rule zero (a page no longer cuts one: nothing of a note follows it
// on the page). A tick in its box closes the note; writing under it is the
// board's reply, a new note for the same agent. The book (HQ's bookslips.js) draws it with slipHtml and wires it with
// wireSlips; isTick, the Pencil's tick written on a slip in the book, is plain maths (slip.test.js).

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
      .slip-reply { display: block; width: 100%; box-sizing: border-box; margin: 10px 0 0; padding: 4px 0; min-height: 0; resize: none;
        border: 0; border-bottom: 1px dashed #c9bfa6; background: transparent; color: #2a2352; font: inherit; outline: none;
        overflow: hidden; }
      .slip-reply::placeholder { color: #9b94b0; }
      .slip-reply:focus { border-bottom: 1.5px solid #ffd966; }
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
export function nowOf(slip) {
  const p = slip.preview;
  if (p?.pending) return { label: 'Now', empty: 'Its preview shows here once it runs' };
  if (p) return { src: p.picture, href: p.open, label: `Now · ${p.name ?? 'the preview'}`, empty: 'Running' };
  return slip.now ? { src: slip.now, label: 'Now' } : null;
}

// One slip under its note (note: the store's, with its snip), as HTML
export function slipHtml(slip, note) {
  const now = nowOf(slip),
    ticked = Boolean(slip.ticked);
  const nowPic =
    now &&
    (now.src
      ? `<img src="${esc(now.src)}" alt="The same place now" loading="lazy">`
      : `<span class="slip-none">${esc(now.empty)}</span>`);
  const nowFig = now?.href ? `<a href="${esc(now.href)}" target="_blank" rel="noopener">${nowPic}</a>` : nowPic;
  const then = note.snip
    ? `<div class="slip-then"><figure><img src="${esc(note.snip)}" alt="As it was marked" loading="lazy"><figcaption>Then</figcaption></figure>${
        now ? `<figure>${nowFig}<figcaption>${esc(now.label)}</figcaption></figure>` : ''
      }</div>`
    : '';
  const link = slip.link
    ? `<p class="slip-said"><a href="${esc(slip.link)}" target="_blank" rel="noopener">Open what ${esc(slip.name ?? slip.by)} made</a></p>`
    : '';
  return `<section class="answer-slip" data-slip="${slip.id}"${ticked ? ' data-ticked' : ''} aria-label="${esc(
    `${slip.name ?? slip.by}'s answer`,
  )}">${CLIP}<button class="slip-tick" type="button" aria-pressed="${ticked}" aria-label="${
    ticked ? 'Ticked: done' : 'Tick it: done'
  }">${TICK}</button><b class="slip-by">${esc(slip.name ?? slip.by)}</b><p class="slip-text">${esc(slip.text)}</p>${
    slip.picture ? `<img class="slip-pic" src="${esc(slip.picture)}" alt="" loading="lazy">` : ''
  }${link}${then}<textarea class="slip-reply" rows="1" aria-label="Reply to ${esc(
    slip.name ?? slip.by,
  )}" placeholder="Write under it to reply"></textarea><p class="slip-said" hidden></p></section>`;
}

// The slips under root wired: a tap on a tick box ticks it (or takes the tick back), and words written under one go as
// the reply once the field is left or Enter is pressed. on: { tick(id, ticked), reply(id, words) → the store's answer
// ({ note, asked }) }, each a promise; refused, the slip says why and stays as it was.
export function wireSlips(root, on) {
  for (const slip of root.querySelectorAll('.answer-slip')) {
    const id = Number(slip.dataset.slip),
      box = slip.querySelector('.slip-tick'),
      field = slip.querySelector('.slip-reply'),
      said = slip.querySelector('.slip-said[hidden]');
    // (a finger or the Pencil here is the slip's: never the book's pan or the page's ink)
    for (const el of [box, field])
      for (const type of ['pointerdown', 'touchstart', 'touchmove'])
        el.addEventListener(type, e => e.stopPropagation());
    const tell = text => Object.assign(said, { textContent: text, hidden: !text });
    box.addEventListener('click', () =>
      tickBox(slip, on, !slip.hasAttribute('data-ticked')).catch(e => tell(e.message)),
    );
    const fitted = () => {
      field.style.height = 'auto';
      field.style.height = `${field.scrollHeight}px`;
    };
    field.addEventListener('input', fitted);
    let sending = false;
    const go = async () => {
      const words = field.value.trim();
      if (!words || sending) return;
      sending = true;
      try {
        const { note, asked } = await on.reply(id, words);
        field.value = '';
        fitted();
        tell(
          asked ? 'Asked: the answer clips on in a moment' : `On the sheet as note ${note.n}: it goes with the plane`,
        );
      } catch (e) {
        tell(e.message);
      }
      sending = false;
    };
    field.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      e.preventDefault();
      go();
    });
    field.addEventListener('blur', go);
  }
}
// A slip ticked (or not), its box at once, back as it was if the store refuses
export async function tickBox(slip, on, ticked) {
  const box = slip.querySelector('.slip-tick');
  const show = t => {
    slip.toggleAttribute('data-ticked', t);
    box.setAttribute('aria-pressed', String(t));
    box.setAttribute('aria-label', t ? 'Ticked: done' : 'Tick it: done');
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
