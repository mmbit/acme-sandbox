// The post-it: the note for the team, stuck over the page once something is marked (or as a general note, pinned to
// nothing): a polaroid of the screen as it was, framed on the mark and developed again with every line drawn, the
// words typed or said, the pictures added, one Send ("Pin it") and Cancel.
import { MIC, post, refusal, RefusedError } from './base.js';
import { frameMark } from './frame.js';
import { pageName } from './trail.js';
import { clock, describe, marked, onScreen, videoAt, viewNow } from './mark.js';
import { box } from './anchor.js';
import { expose, photo, snapshot } from './snapshot.js';
import { addFrame, picturesNow, unpicture } from './pictures.js';
import { stopMic } from './dictation.js';
import { redrawInk, reset } from './acts.js';
import { nextMark, toBook } from './settle.js';
import { lift } from './lift.js';
import { openLines, paint as paintInk } from './marks.js';
import { PAPER } from './paper.js';
import { ownerNamed } from './markpage.js';
import { setupPostitPen } from './postitpen.js';
import { showNotice } from './postitnotice.js';

export const CSS = `
      /* The post-it is a scrap of the book (paper.js): its paper and dot grid, a head torn along
         the grid, the photo taped on, the book's indigo for Send. The same on every page and every look. */
      /* (100cqw: .ui's width, base.js) */
      .sheet { ${PAPER}
        pointer-events: auto; position: absolute; left: 50%; bottom: calc(max(12px, env(safe-area-inset-bottom)) + var(--kb, 0px)); width: min(540px, calc(100cqw - 20px));
        transform: translateX(-50%) rotate(-.6deg); isolation: isolate; padding: 26px 18px 14px; color: var(--bk-night);
        font-family: "Atkinson Hyperlegible", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        background: var(--bk-dots) 4px 14px / 16px 16px, linear-gradient(var(--bk-paper), var(--bk-paper)) 0 7px / 100% 100% no-repeat;
        border-radius: 0 0 5px 5px; filter: drop-shadow(0 10px 18px rgba(29,26,47,.28)) drop-shadow(0 1px 2px rgba(29,26,47,.18));
        animation: pop .35s cubic-bezier(.3,1.5,.5,1); max-height: calc(100dvh - 24px - var(--kb, 0px)); overflow: auto; }
      .sheet[hidden] { display: none; }
      .sheet::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 8px; z-index: -1; background: var(--bk-paper);
        clip-path: polygon(0 6px, 4% 3px, 8% 7px, 13% 2px, 18% 6px, 23% 3px, 28% 8px, 34% 3px, 39% 6px, 45% 1px, 50% 7px, 56% 3px, 61% 8px, 67% 2px, 72% 6px, 78% 1px, 83% 7px, 89% 3px, 94% 6px, 100% 2px, 100% 100%, 0 100%); }
      .sheet.away { animation: away .5s cubic-bezier(.6,-.3,.7,.5) forwards; }
      @keyframes pop { from { transform: translateX(-50%) translateY(40px) rotate(3deg) scale(.9); opacity: 0 } }
      @keyframes away { to { transform: translate(35vw, 20vh) rotate(25deg) scale(.1); opacity: 0 } }
      .top { display: flex; gap: 16px; align-items: flex-start; }
      /* (the photo takes no touch: the iPad's handwriting looks for a field round the pen's start, and the framed
         screenshot's whole box, far wider than the photo, would hide the words' field from it.) */
      .polaroid { pointer-events: none; flex: none; width: 112px; background: #fff; padding: 6px 6px 18px; box-shadow: 0 3px 10px rgba(29,26,47,.25); transform: rotate(2.5deg); position: relative; }
      .polaroid::before { content: ""; position: absolute; left: 50%; top: -8px; width: 54px; height: 15px; z-index: 1; transform: translateX(-50%) rotate(-4deg); background: rgb(246 236 200 / 80%); box-shadow: 0 1px 2px rgba(29,26,47,.12); }
      .polaroid .img { width: 100%; aspect-ratio: 3 / 4; background: #3a3148; display: grid; place-items: center; overflow: hidden; position: relative; } /* (relative: a framed img sits on the mark) */
      .polaroid img, .polaroid canvas { width: 100%; height: 100%; object-fit: cover; object-position: top; display: block; animation: develop 1.2s ease-out; }
      .polaroid .framed { position: absolute; max-width: none; object-fit: fill; }
      .polaroid .img span { color: #f3e6d0; font-size: 11px; text-align: center; padding: 6px; }
      .polaroid.busy .img { background: linear-gradient(110deg, #3a3148 30%, #5a5478 50%, #3a3148 70%) 0 0 / 300% 100%; animation: shimmer 1.4s linear infinite; }
      @keyframes develop { from { filter: brightness(2.2) sepia(.6) blur(2px); opacity: .4 } }
      .who { min-width: 0; flex: 1; padding-top: 2px; }
      .who h2 { margin: 0 0 8px; font-size: 13px; font-weight: 700; line-height: 1.3; letter-spacing: .14em; text-transform: uppercase; color: var(--bk-night); }
      .chip { display: inline-block; max-width: 100%; background: var(--bk-paper2); box-shadow: inset 0 0 0 1px var(--bk-line), inset 0 -2px 0 var(--bk-gold); border-radius: 3px; padding: 2px 8px; font: 13px/1.4 ui-monospace, Menlo, monospace;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .page { display: block; margin-top: 5px; color: var(--bk-muted); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .sheet.bare .polaroid, .sheet.bare .chip { display: none; } /* a general note: no photo */
      textarea { display: block; width: 100%; margin: 14px 0 10px; min-height: 104px; resize: vertical; border: 0; outline: 0; padding: 4px 2px; color: #1d1a2f; font-family: inherit; font-size: 18px; line-height: 28px; background: transparent; }
      textarea::placeholder { color: #8f88a8; }
      .row { display: flex; gap: 10px; align-items: center; }
      .grow { flex: 1; }
      .ghost { padding: 12px 14px; border-radius: 999px; color: var(--bk-muted); font-weight: 700; }
      .send { padding: 12px 22px; border-radius: 999px; background: var(--bk-night); color: var(--bk-paper); font-weight: 700; box-shadow: 0 3px 0 #1d1a2f, 0 4px 10px rgba(29,26,47,.25); }
      .send:active { transform: translateY(3px); box-shadow: 0 0 0 #1d1a2f; } .send[disabled] { opacity: .5; }
      .msg { min-height: 20px; margin: 8px 2px 0; font-size: 14px; color: var(--bk-muted); }
      /* (no message over the page after a pin) */`;

export const HTML = `<div class="sheet" hidden role="dialog" aria-label="A note for the team">
        <div class="top"><div class="polaroid busy"><div class="img"></div></div>
          <div class="who"><h2>Note to self… er, to the team</h2><span class="chip"></span><span class="page"></span></div></div>
        <textarea placeholder="What should change? Type it, or tap the mic and say it." maxlength="4000"></textarea>
        <div class="row"><button class="mic" aria-label="Dictate the note">${MIC}</button><span class="grow"></span>
          <button class="ghost" data-cancel>Cancel</button><button class="send">Pin it</button></div>
        <p class="msg" aria-live="polite"></p>
      </div>`;

// Whether a call is on: HQ's own (callnotes.js) or one HQ's viewer tells of (callframe.js.)
const onCall = r => !!(r.call || r.calling);

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
  r.shot = shoot(r, mark);
  // (on a call the call hears the board, and no post-it shows: callnotes.js, and in HQ's viewer callframe.js. Off one the mic starts only at its button on the post-it, never at the mark: the
  // board, call 154.)
  if (onCall(r)) return;
  // (a mark on HQ, the Pencil's or a mouse's, has its post-it too, as on any page: its Save puts it in the Notebook as
  // a scrap, the board's pin flow.)
  setTimeout(() => stuck(r, mark), 380); // let the pin land, then the note
}
// The mark's screenshot, developed in the polaroid while the mark is open.
function shoot(r, mark) {
  const pol = r.$('.polaroid'),
    img = r.$('.polaroid .img');
  pol.classList.add('busy');
  img.textContent = '';
  r.exposure = null;
  // (on a call the snip goes to the call's agent: masked.)
  return snapshot(r, { masked: onCall(r) }).then(
    taken => {
      if (r.mark !== mark) return taken;
      pol.classList.remove('busy');
      if (taken) {
        r.exposure = taken;
        develop(r);
      } else img.innerHTML = '<span>No photo this time: the note still goes.</span>';
      return taken;
    },
    () => null,
  );
}
function stuck(r, mark) {
  if (r.mark !== mark) return;
  r.veil.classList.add('marked');
  r.dock.hidden = true;
  redrawInk(r);
  const t = mark.element,
    words = t.text ? ` “${t.text.slice(0, 40)}${t.text.length > 40 ? '…' : ''}”` : '';
  r.$('.chip').textContent = `<${t.tag}>${t.video ? ` at ${clock(t.video.time)}` : ''}${words}`; // (the moment before the words the chip may cut)
  r.$('.page').textContent = r.towards ?? pageName(); // (whose sheet, on HQ: towards, below.)
  r.$('.who h2').textContent = mark.kind === 'circle' ? 'About this bit…' : 'About this…';
  showSheet(r);
  if (mark.frameless) r.msg.textContent = `${r.msg.textContent} ${mark.frameless}`.trim();
}
// Where the note goes, on its post-it: the line under its head says the newest page of the Notebook, and whose work it's
// about, the owner its page's send gives it to (marks.js post). Not on a call, where the call's page takes it.
export function towards(r, mark) {
  r.towards = null;
  if (r.call) return;
  ownerNamed(r, mark.el).then(
    ({ name }) => {
      if (r.mark !== mark) return;
      r.towards = `To your Notebook’s newest page, for ${name}`;
      if (!r.sheet.hidden) r.$('.page').textContent = r.towards;
    },
    () => {}, // (the org unread: a plain Send, which still files it)
  );
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
function general(r) {
  r.mode = 'note';
  r.shot = null;
  r.mark = { kind: 'general', element: { kind: 'general' }, view: viewNow(), page: location.href };
  r.dock.hidden = true;
  r.sheet.classList.add('bare');
  r.$('.who h2').textContent = 'A general note';
  r.$('.page').textContent = `About it all · written on ${pageName()}`;
  r.text.placeholder = 'Something across the pages, or that differs between them? Type it, or tap the mic and say it.';
  showSheet(r);
  if (r.book) towards(r, r.mark);
}
export function showSheet(r) {
  r.msg.textContent = '';
  r.sheet.hidden = false;
  r.sheet.classList.remove('away');
  showNotice(r);
  if (matchMedia('(pointer: fine)').matches) r.text.focus();
}

// The note open as a step began, still open after its wait: its mark, which a Cancel clears
function opened(r) {
  const { mark } = r;
  return () => r.mark === mark;
}
// Pin it: the words (once any still being said are in), the screenshot and the pictures, to the coordinator next to
// the script
async function pinIt(r) {
  if (r.mode !== 'note') return;
  if (r.book) return booked(r); // (its words waited for there, once its strokes are gone)
  const open = opened(r); // (asked after each wait, the mic's too.)
  // words still being spoken or transcribed belong in this note: wait for them before reading it
  if (r.rec || r.stopping) {
    r.pinIt.disabled = true;
    await stopMic(r);
    if (!open()) return;
    r.pinIt.disabled = false;
    if (r.mode !== 'note') return;
  }
  // and words written with the Pencil still being read (postitpen.js): the press on Pin closed their gap.
  if (r.wordGap) {
    r.pinIt.disabled = true;
    await r.wordGap.close();
    if (!open()) return;
    r.pinIt.disabled = false;
    if (r.mode !== 'note') return;
  }
  const note = r.text.value.trim();
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
  if (!open()) return; // (cancelled meanwhile: the next note, if one's begun, is its own.)
  if (!added) {
    r.mode = 'note';
    r.pinIt.disabled = false;
    return;
  }
  r.msg.textContent = 'Sending…';
  return pinned(r, note, url, added);
}
// A saved note becomes a scrap on the writer's Notebook page, and the post-it flies off.
// said: how its words came. Each step after a wait is this note's
// only while its mark is still the one open: a post-it cancelled meanwhile, and another begun, is left alone
async function pinned(r, note, url, added) {
  const mark = r.mark;
  try {
    const res = await post(r.ROUTE, 'notes', {
      note,
      said: r.spoken && !r.typed ? 'spoken' : 'typed',
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
    // (the board's, inside HQ's viewer: a scrap on its Notebook's newest page, which HQ's book turns to or keeps for
    // the pull tab's tap.)
    if (r.framed && !r.outside) res.json().then(a => r.toHq({ scrap: { id: a.id, page: a.page } }));
    if (r.mark === mark) {
      r.text.value = '';
      r.sheet.classList.add('away');
    }
    // Pinned: nothing over the page being reviewed
    setTimeout(() => r.mark === mark && reset(r), 450);
  } catch (err) {
    if (r.mark !== mark) return;
    r.mode = 'note';
    r.pinIt.disabled = false;
    r.msg.textContent = err instanceof RefusedError ? err.message : 'Could not reach HQ. Try again?';
  }
}
// On HQ: the note a scrap on the Notebook's newest page (a mark needs no words there: its ink says it). Its strokes go
// from the page the moment Save is pressed (rule zero), flying into the Notebook while the last words said come and the
// scrap goes in; then the book turns to it ('book:scrap' { id, page }: HQ's booklanding.js) and the post-it flies off.
// As pinned's, each step only while its mark is the one open; one the Notebook didn't take keeps its strokes and its
// post-it, and says why.
async function booked(r) {
  const mark = r.mark,
    open = () => r.mark === mark,
    wordless = () => mark.kind === 'general' && !r.text.value.trim();
  if (wordless() && !r.rec && !r.stopping) return askWords(r);
  r.mode = 'sending';
  r.pinIt.disabled = true;
  r.msg.textContent = 'Saving…';
  const lines = openLines(r);
  mark.filed = true;
  paintInk(r);
  if (!r.call) lift(r, { lines, note: { id: null, page: null, group: true } });
  try {
    if (r.rec || r.stopping) await stopMic(r);
    if (!open()) return;
    if (wordless()) {
      refiled(r, mark);
      return askWords(r);
    }
    const { photoless, note } = (await toBook(r)) ?? {};
    if (!open()) return;
    r.text.value = '';
    if (note?.group)
      document.dispatchEvent(new CustomEvent('book:scrap', { detail: { id: note.id, page: note.page } }));
    // (a note that went without its photo says so before the post-it goes)
    if (photoless) r.msg.textContent = 'In the Notebook. No photo this time.';
    setTimeout(() => open() && away(r), photoless ? 1800 : 0);
  } catch (err) {
    if (!open()) return;
    refiled(r, mark);
    r.msg.textContent = err?.status
      ? `The Notebook said no: ${err.message}`
      : 'Could not reach the Notebook. Try again?';
  }
}
// The note open again as it was, its strokes drawn, Save ready
function refiled(r, mark) {
  mark.filed = false;
  r.mode = 'note';
  r.pinIt.disabled = false;
  paintInk(r);
  nextMark(r);
}
function askWords(r) {
  r.text.focus();
  r.msg.textContent = 'A word or two first?';
}
function away(r) {
  const mark = r.mark;
  r.sheet.classList.add('away');
  setTimeout(() => {
    if (r.mark !== mark) return;
    reset(r);
    nextMark(r);
  }, 450);
}
// The post-it's button: the board's note is saved into its Notebook, a guest's pinned
export const saveWord = r => (r.outside ? 'Pin it' : 'Save');
export function setupPostit(r) {
  r.pinIt.textContent = saveWord(r);
  r.$('[data-cancel]').onclick = () => reset(r);
  // (words typed after any were said: the Pencil keeps its own.)
  if (!r.book) r.text.addEventListener('input', () => (r.typed = true));
  r.pinIt.onclick = () => pinIt(r);
  setupPostitPen(r); // (its words edited with the Pencil.)
  // With the on-screen keyboard up (Chrome on Android resizes only the visual viewport), lift the note above it.
  const vv = window.visualViewport;
  if (!vv) return;
  const fit = () => r.sheet.style.setProperty('--kb', `${Math.max(0, innerHeight - vv.height - vv.offsetTop)}px`);
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
}
