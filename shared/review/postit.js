// The post-it: the note for the team, stuck over the page once something is marked (or as a general note, pinned to
// nothing): a polaroid of the screen as it was, framed on the mark and developed again with every line drawn, the
// words typed or said, the pictures added, one Send ("Pin it") and Cancel.
import { MIC, kept, keep, post, refusal, RefusedError } from './base.js';
import { frameMark } from './frame.js';
import { here } from './trail.js';
import { clock, describe, marked, onScreen, videoAt, viewNow } from './mark.js';
import { box } from './anchor.js';
import { expose, photo, snapshot } from './snapshot.js';
import { addFrame, picturesNow, unpicture } from './pictures.js';
import { canRecord, startMic, stopMic } from './dictation.js';
import { redrawInk } from './surface.js';
import { paint, refresh } from './menu.js';
import { cancel, reset } from './tool.js';
import { toBook } from './pencil.js';

export const CSS = `
      /* The post-it is a scrap of the book (platform/hq/shell/booklook.css): its paper and dot grid, a head torn along
         the grid, the gold of its ribbon down the side, the photo taped on, the book's indigo for Send. The same on every
         page and every look. */
      /* (100cqw: .ui's width, base.js) */
      .sheet { pointer-events: auto; position: absolute; left: 50%; bottom: calc(max(12px, env(safe-area-inset-bottom)) + var(--kb, 0px)); width: min(540px, calc(100cqw - 20px));
        transform: translateX(-50%) rotate(-.6deg); isolation: isolate; padding: 26px 18px 14px 36px; color: #2a2352;
        font-family: "Atkinson Hyperlegible", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        background: radial-gradient(circle, rgba(42,35,82,.16) 1px, transparent 1.3px) 4px 14px / 16px 16px, linear-gradient(#fffaf0, #fffaf0) 0 7px / 100% 100% no-repeat;
        border-radius: 0 0 5px 5px; filter: drop-shadow(0 10px 18px rgba(29,26,47,.28)) drop-shadow(0 1px 2px rgba(29,26,47,.18));
        animation: pop .35s cubic-bezier(.3,1.5,.5,1); max-height: calc(100dvh - 24px - var(--kb, 0px)); overflow: auto; }
      .sheet[hidden] { display: none; }
      .sheet::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 8px; z-index: -1; background: #fffaf0;
        clip-path: polygon(0 6px, 4% 3px, 8% 7px, 13% 2px, 18% 6px, 23% 3px, 28% 8px, 34% 3px, 39% 6px, 45% 1px, 50% 7px, 56% 3px, 61% 8px, 67% 2px, 72% 6px, 78% 1px, 83% 7px, 89% 3px, 94% 6px, 100% 2px, 100% 100%, 0 100%); }
      .sheet::after { content: ""; position: absolute; left: 13px; top: 5px; width: 10px; height: min(150px, 62%); z-index: -1;
        background: linear-gradient(90deg, #b98322 0 .8px, #e2ad45 .8px 3px, #f6d27a 3px 5.4px, #e2ad45 5.4px calc(100% - .8px), #b98322 calc(100% - .8px));
        clip-path: polygon(0 0, 100% 0, 100% 100%, 50% calc(100% - 8px), 0 100%); }
      .sheet.away { animation: away .5s cubic-bezier(.6,-.3,.7,.5) forwards; }
      @keyframes pop { from { transform: translateX(-50%) translateY(40px) rotate(3deg) scale(.9); opacity: 0 } }
      @keyframes away { to { transform: translate(35vw, 20vh) rotate(25deg) scale(.1); opacity: 0 } }
      .top { display: flex; gap: 16px; align-items: flex-start; }
      .polaroid { flex: none; width: 112px; background: #fff; padding: 6px 6px 18px; box-shadow: 0 3px 10px rgba(29,26,47,.25); transform: rotate(2.5deg); position: relative; }
      .polaroid::before { content: ""; position: absolute; left: 50%; top: -8px; width: 54px; height: 15px; z-index: 1; transform: translateX(-50%) rotate(-4deg); background: rgb(246 236 200 / 80%); box-shadow: 0 1px 2px rgba(29,26,47,.12); }
      .polaroid .img { width: 100%; aspect-ratio: 3 / 4; background: #3a3148; display: grid; place-items: center; overflow: hidden; position: relative; } /* (relative: a framed img sits on the mark) */
      .polaroid img, .polaroid canvas { width: 100%; height: 100%; object-fit: cover; object-position: top; display: block; animation: develop 1.2s ease-out; }
      .polaroid .framed { position: absolute; max-width: none; object-fit: fill; }
      .polaroid .img span { color: #f3e6d0; font-size: 11px; text-align: center; padding: 6px; }
      .polaroid.busy .img { background: linear-gradient(110deg, #3a3148 30%, #5a5478 50%, #3a3148 70%) 0 0 / 300% 100%; animation: shimmer 1.4s linear infinite; }
      @keyframes develop { from { filter: brightness(2.2) sepia(.6) blur(2px); opacity: .4 } }
      .who { min-width: 0; flex: 1; padding-top: 2px; }
      .who h2 { margin: 0 0 8px; font-size: 13px; font-weight: 700; line-height: 1.3; letter-spacing: .14em; text-transform: uppercase; color: #2a2352; }
      .chip { display: inline-block; max-width: 100%; background: #f7efdf; box-shadow: inset 0 0 0 1px #e8dcc4, inset 0 -2px 0 #e2ad45; border-radius: 3px; padding: 2px 8px; font: 13px/1.4 ui-monospace, Menlo, monospace;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .page { display: block; margin-top: 5px; color: #5a5478; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .redraw { margin-top: 6px; padding: 4px 0; font-size: 14px; font-weight: 700; color: #c23c44; text-decoration: underline; text-underline-offset: 3px; }   /* changing a note: its mark drawn again */
      .redraw[hidden] { display: none; }
      .sheet.bare .polaroid, .sheet.bare .chip { display: none; } /* a general note: no photo */
      textarea { display: block; width: 100%; margin: 14px 0 10px; min-height: 104px; resize: vertical; border: 0; outline: 0; padding: 4px 2px; color: #1d1a2f; font-family: inherit; font-size: 18px; line-height: 28px; background: transparent; }
      textarea::placeholder { color: #8f88a8; }
      .row { display: flex; gap: 10px; align-items: center; }
      .grow { flex: 1; }
      .ghost { padding: 12px 14px; border-radius: 999px; color: #5a5478; font-weight: 700; }
      .send { padding: 12px 22px; border-radius: 999px; background: #2a2352; color: #fffaf0; font-weight: 700; box-shadow: 0 3px 0 #1d1a2f, 0 4px 10px rgba(29,26,47,.25); }
      .send:active { transform: translateY(3px); box-shadow: 0 0 0 #1d1a2f; } .send[disabled] { opacity: .5; }
      .msg { min-height: 20px; margin: 8px 2px 0; font-size: 14px; color: #5a5478; }
      /* (no message over the page after a pin) */`;

export const HTML = `<div class="sheet" hidden role="dialog" aria-label="A note for the team">
        <div class="top"><div class="polaroid busy"><div class="img"></div></div>
          <div class="who"><h2>Note to self… er, to the team</h2><span class="chip"></span><span class="page"></span><button class="redraw" hidden>Redraw</button></div></div>
        <textarea placeholder="What should change? Type it, or tap the mic and say it." maxlength="4000"></textarea>
        <div class="row"><button class="mic" aria-label="Dictate the note">${MIC}</button><span class="grow"></span>
          <button class="ghost" data-cancel>Cancel</button><button class="send">Pin it</button></div>
        <p class="msg" aria-live="polite"></p>
      </div>`;

// TOLD: an outsider was told what goes with a note
const TOLD = '__hq_review_told';

// The note for what was marked: the screenshot taken at the first mark, every line since drawn on it (develop)
export function compose(r) {
  r.mode = 'note';
  const { mark } = r;
  // (a re-pin's frame replaces the last one's; frameless: what to say when no frame went with the note.)
  const video = videoAt(mark);
  if (r.framePic) unpicture(r, r.framePic);
  r.framePic = null;
  if (video) {
    video.pause();
    mark.frameless = addFrame(r, video);
  }
  const moment = video
    ? {
        video: {
          time: Math.round(video.currentTime * 10) / 10,
          src: new URL(video.currentSrc, location.href).pathname,
        },
      }
    : {};
  mark.element = { ...describe(mark.el), kind: mark.kind, area: mark.area && box(mark.area), ...moment };
  mark.view = viewNow();
  mark.page = location.href;
  // changing a note: this mark replaces the one shown, and stays on the page with its element as the sheet comes back
  if (r.editing) r.editing = { ...r.editing, redrawn: true, mark: { ...marked(r), live: mark.el } };
  const pol = r.$('.polaroid'),
    img = r.$('.polaroid .img');
  pol.classList.add('busy');
  img.textContent = '';
  r.exposure = null;
  // (on a call the snip goes to the call's agent: masked.)
  r.shot = snapshot(r, { masked: !!r.call }).then(
    taken => {
      if (r.mark !== mark) return null;
      pol.classList.remove('busy');
      if (taken) {
        r.exposure = taken;
        develop(r);
      } else img.innerHTML = '<span>No photo this time: the note still goes.</span>';
      return taken;
    },
    () => null,
  );
  // (the mic: the first mark starts it; on a call the call hears the board, and no post-it shows: callnotes.js.
  if (r.call) return;
  if (canRecord && !r.rec && !r.stopping) startMic(r);
  setTimeout(() => stuck(r, mark), 380); // let the pin land, then the note
}
function stuck(r, mark) {
  if (r.mark !== mark) return;
  r.veil.classList.add('marked');
  r.dock.hidden = true;
  if (r.editing) r.root.querySelectorAll('.drop').forEach(d => d.remove());
  redrawInk(r);
  const t = mark.element,
    words = t.text ? ` “${t.text.slice(0, 40)}${t.text.length > 40 ? '…' : ''}”` : '';
  r.$('.chip').textContent = `<${t.tag}>${t.video ? ` at ${clock(t.video.time)}` : ''}${words}`; // (the moment before the words the chip may cut)
  r.$('.page').textContent = here();
  r.$('.who h2').textContent = mark.kind === 'circle' ? 'About this bit…' : 'About this…';
  showSheet(r);
  if (mark.frameless) r.msg.textContent = `${r.msg.textContent} ${mark.frameless}`.trim();
}
// The polaroid, framed on the mark: the page as it was with every line drawn so far
export function develop(r) {
  if (!r.exposure) return;
  const img = r.$('.polaroid .img'),
    c = img.querySelector('canvas') ?? img.appendChild(document.createElement('canvas'));
  expose(r, r.exposure, r.mark, c);
  const placement = frameMark(onScreen(r.mark), 3 / 4);
  c.className = placement ? 'framed' : '';
  c.removeAttribute('style');
  if (placement) Object.assign(c.style, placement);
}
// A general note: the same sheet, pinned to nothing and without a photo, saved with the page it's written on
export function general(r) {
  r.mode = 'note';
  r.shot = null;
  r.mark = { kind: 'general', element: { kind: 'general' }, view: viewNow(), page: location.href };
  r.dock.hidden = true;
  r.sheet.classList.add('bare');
  r.$('.who h2').textContent = 'A general note';
  r.$('.page').textContent = `About it all · written on ${here()}`;
  r.text.placeholder = 'Something across the pages, or that differs between them? Type it, or tap the mic and say it.';
  showSheet(r);
}
export function showSheet(r) {
  r.msg.textContent = '';
  r.sheet.hidden = false;
  r.sheet.classList.remove('away');
  // an outsider hears once what goes with a note (a general note has no picture, so its line doesn't count as that)
  // (a note being changed has no mark until it's redrawn, and a redraw's new picture is told too)
  if (r.outside && r.mark && !kept(localStorage, TOLD)) {
    if (r.mark.kind === 'general') r.msg.textContent = 'Your notes go to the crew. Please don’t type personal details.';
    else {
      r.msg.textContent = 'Your notes and a picture of the screen go to the crew. Please don’t type personal details.';
      keep(localStorage, TOLD, '1');
    }
  }
  if (matchMedia('(pointer: fine)').matches) r.text.focus();
}

// Pin it: the words (once any still being said are in), the screenshot and the pictures, to the coordinator next to
// the script; a change saves instead
async function pinIt(r) {
  if (r.mode !== 'note') return;
  // words still being spoken or transcribed belong in this note: wait for them before reading it
  if (r.rec || r.stopping) {
    r.pinIt.disabled = true;
    await stopMic(r);
    r.pinIt.disabled = false;
    if (r.mode !== 'note') return;
  }
  const note = r.text.value.trim();
  if (r.book && !r.editing) return booked(r);
  if (!note) {
    r.text.focus();
    r.msg.textContent = 'A word or two first?';
    return;
  }
  r.mode = 'sending';
  r.pinIt.disabled = true;
  r.msg.textContent = r.shot ? 'Developing the photo…' : 'Sending…';
  const waiting = r.pictures,
    url = photo(r, await Promise.race([r.shot, new Promise(res => setTimeout(() => res(null), 9000))]), r.mark);
  const added = await picturesNow(r, waiting);
  if (!added) {
    r.mode = 'note';
    r.pinIt.disabled = false;
    return;
  }
  r.msg.textContent = 'Sending…';
  return r.editing ? save(r, note, url, added) : pinned(r, note, url, added);
}
// A new note: once it's in, the post-it flies off and the menu counts it
async function pinned(r, note, url, added) {
  try {
    const res = await post(r.ROUTE, 'notes', {
      note,
      page: r.mark.page,
      element: marked(r),
      viewport: r.mark.view,
      trail: r.trail,
      shot: url || null,
      pictures: added,
    });
    await refusal(res);
    // an outsider's 403 is their link's end
    if (!res.ok)
      throw new RefusedError(
        res.status !== 403
          ? `The coordinator said no (${res.status}).`
          : r.outside
            ? 'The link has ended. Thank you for your notes!'
            : 'The review key has expired: open this page from HQ again.',
      );
    r.text.value = '';
    r.state.notes += 1;
    r.sheet.classList.add('away');
    // Pinned: the menu's button boings and counts it, and HQ's viewer bar shows Send N (refresh). Nothing over the page
    // being reviewed.
    setTimeout(() => {
      r.pinIt.disabled = false;
      reset(r);
      paint(r);
      refresh(r);
      r.more.classList.add('boing');
      setTimeout(() => r.more.classList.remove('boing'), 700);
    }, 450);
  } catch (err) {
    r.mode = 'note';
    r.pinIt.disabled = false;
    r.msg.textContent = err instanceof RefusedError ? err.message : 'Could not reach HQ. Try again?';
  }
}
// On HQ: the note on its sheet in the book (a mark needs no words there: its ink says it), and the post-it flies off.
async function booked(r) {
  if (r.mark.kind === 'general' && !r.text.value.trim()) {
    r.text.focus();
    r.msg.textContent = 'A word or two first?';
    return;
  }
  r.mode = 'sending';
  r.pinIt.disabled = true;
  r.msg.textContent = 'Putting it in the book…';
  try {
    const photoless = await toBook(r);
    r.text.value = '';
    // (a note that went without its photo says so before the post-it goes)
    if (photoless) r.msg.textContent = 'In the book. No photo this time.';
    setTimeout(
      () => {
        r.sheet.classList.add('away');
        setTimeout(() => {
          r.pinIt.disabled = false;
          reset(r);
        }, 450);
      },
      photoless ? 1800 : 0,
    );
  } catch (err) {
    r.mode = 'note';
    r.pinIt.disabled = false;
    r.msg.textContent = err?.status ? `The book said no: ${err.message}` : 'Could not reach the book. Try again?';
  }
}
// A change: the words and pictures, and a mark drawn again with its screenshot; then back to My notes (pictures)
async function save(r, note, url, added) {
  const redrawn = r.editing.redrawn
    ? { page: r.mark.page, element: marked(r), viewport: r.mark.view, shot: url || null }
    : {};
  try {
    const res = await post(r.ROUTE, 'edit', { id: r.editing.n.id, note, pictures: added, ...redrawn });
    await refusal(res);
    if (!res.ok)
      throw new RefusedError(
        res.status === 404
          ? 'That note has gone already: sent, or deleted.'
          : `The coordinator said no (${res.status}).`,
      );
    r.pinIt.disabled = false;
    cancel(r);
  } catch (err) {
    r.mode = 'note';
    r.pinIt.disabled = false;
    r.msg.textContent = err instanceof RefusedError ? err.message : 'Couldn’t save it. Try again?';
  }
}

export function setupPostit(r) {
  r.$('[data-cancel]').onclick = () => cancel(r);
  r.pinIt.onclick = () => pinIt(r);
  // With the on-screen keyboard up (Chrome on Android resizes only the visual viewport), lift the note above it.
  const vv = window.visualViewport;
  if (!vv) return;
  const fit = () => r.sheet.style.setProperty('--kb', `${Math.max(0, innerHeight - vv.height - vv.offsetTop)}px`);
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
}
