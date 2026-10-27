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
import { paint, redrawInk, refresh, reset } from './acts.js';
import { toBook } from './settle.js';
import { PAPER } from './paper.js';
import { ownerNamed } from './markpage.js';

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
      .polaroid { flex: none; width: 112px; background: #fff; padding: 6px 6px 18px; box-shadow: 0 3px 10px rgba(29,26,47,.25); transform: rotate(2.5deg); position: relative; }
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

// TOLD: an outsider was told what goes with a note
const TOLD = '__hq_review_told';
// Whether the open mark is this screen's own on the page's screen of a pairing (<html data-paired="page">), which goes
// to the other screen (handover.js) rather than open its post-it here, nor the mic. Never on HQ, where a mark goes into the book from the screen it's drawn on (settle.js)
export const across = r => !r.book && document.documentElement.dataset.paired === 'page' && !r.mark?.taken && !r.call;

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
  // (the mic: the first mark starts it; on a call the call hears the board, and no post-it shows: callnotes.js.
  // A paired phone's own mark goes to the other screen without a post-it, so without the mic too: nothing listens
  // unseen.)
  if (r.call) return;
  // (the mic is decided here, once. A post-it kept back for a mark going across asks again as it lands: a pairing that
  // ended meanwhile shows it on this screen, the mic not started.)
  const unseen = across(r);
  if (canRecord && !r.rec && !r.stopping && !unseen) startMic(r);
  // (a mark on HQ, the Pencil's or a mouse's, has no post-it: it goes into the book as it settles, settle.js; a page
  // with no book keeps it.)
  if (r.book) return;
  setTimeout(() => stuck(r, mark, unseen), 380); // let the pin land, then the note
}
// The mark's screenshot, developed in the polaroid while the mark is open: the picture is the mark's either way, for
// one that left for the other screen meanwhile (handover.js.)
function shoot(r, mark) {
  const pol = r.$('.polaroid'),
    img = r.$('.polaroid .img');
  pol.classList.add('busy');
  img.textContent = '';
  r.exposure = null;
  // (on a call the snip goes to the call's agent: masked.)
  return snapshot(r, { masked: !!r.call }).then(
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
function stuck(r, mark, unseen) {
  if (r.mark !== mark) return;
  r.veil.classList.add('marked');
  r.dock.hidden = true;
  redrawInk(r);
  const t = mark.element,
    words = t.text ? ` “${t.text.slice(0, 40)}${t.text.length > 40 ? '…' : ''}”` : '';
  r.$('.chip').textContent = `<${t.tag}>${t.video ? ` at ${clock(t.video.time)}` : ''}${words}`; // (the moment before the words the chip may cut)
  r.$('.page').textContent = r.towards ?? here(); // (whose sheet, on HQ: towards, below.)
  r.$('.who h2').textContent = mark.kind === 'circle' ? 'About this bit…' : 'About this…';
  if (unseen && across(r)) return; // (the pairing ended meanwhile: it shows here.)
  showSheet(r);
  if (mark.frameless) r.msg.textContent = `${r.msg.textContent} ${mark.frameless}`.trim();
}
// Where the note goes, on its post-it: its Send names the sheet's owner ("Send to Juno"), and the line under its head
// says it's that sheet in the Sketchbook, the same owner the note is filed under (marks.js post). Not on a call, where
// the call's page takes it.
export function towards(r, mark) {
  r.towards = null;
  if (r.call) return;
  ownerNamed(r, mark.el).then(
    ({ name }) => {
      if (r.mark !== mark) return;
      r.towards = `For ${name}’s sheet in your Sketchbook`;
      r.pinIt.textContent = `Send to ${name}`;
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
  if (r.book) towards(r, r.mark);
}
// A mark from the other screen that can't land on this one's layout (handover.js): a note about the page, its picture
// the other screen's own with the mark on it (snap: a data URL, or null when it had none; el: what it marked there, by
// its anchor), nothing drawn on this page.
export function snapped(r, snap, el) {
  general(r);
  r.$('.chip').textContent = el
    ? `<${el.tag}>${el.text ? ` “${el.text.slice(0, 40)}${el.text.length > 40 ? '…' : ''}”` : ''}`
    : '';
  r.mark.snap = snap;
  r.mark.taken = true;
  r.$('.who h2').textContent = 'From your other screen';
  r.$('.page').textContent = `${snap ? 'As it looked there' : 'No picture came across'} · ${here()}`;
  r.text.placeholder = r.ask;
  if (!snap) return;
  r.sheet.classList.remove('bare');
  const img = r.$('.polaroid .img');
  r.$('.polaroid').classList.remove('busy');
  const pic = Object.assign(document.createElement('img'), {
    src: snap,
    alt: 'The mark as your other screen showed it',
  });
  Object.assign(pic.style, { objectFit: 'contain', objectPosition: 'center' }); // (the snip is cut round the mark: all of it shows)
  img.replaceChildren(pic);
}
export function showSheet(r) {
  r.msg.textContent = '';
  r.sheet.hidden = false;
  r.sheet.classList.remove('away');
  // an outsider hears once what goes with a note (a general note has no picture, so its line doesn't count as that)
  if (r.outside && r.mark && !kept(localStorage, TOLD)) {
    if (r.mark.kind === 'general') r.msg.textContent = 'Your notes go to the crew. Please don’t type personal details.';
    else {
      r.msg.textContent = 'Your notes and a picture of the screen go to the crew. Please don’t type personal details.';
      keep(localStorage, TOLD, '1');
    }
  }
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
  const open = opened(r); // (asked after each wait, the mic's too.)
  // words still being spoken or transcribed belong in this note: wait for them before reading it
  if (r.rec || r.stopping) {
    r.pinIt.disabled = true;
    await stopMic(r);
    if (!open()) return;
    r.pinIt.disabled = false;
    if (r.mode !== 'note') return;
  }
  const note = r.text.value.trim();
  if (r.book) return booked(r);
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
// A new note: once it's in, the post-it flies off and the board's menu counts it. The board's goes on its book's sheet
// for the page's owner, and so does an outsider's; said: how its words came. Each step after a wait is this note's
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
    r.state.notes += 1;
    if (r.mark === mark) {
      r.text.value = '';
      r.sheet.classList.add('away');
    }
    // Pinned: the menu's button boings and counts it (refresh). Nothing over the page being reviewed.
    setTimeout(() => {
      if (r.mark === mark) reset(r);
      paint(r);
      refresh(r);
      r.more.classList.add('boing');
      setTimeout(() => r.more.classList.remove('boing'), 700);
    }, 450);
  } catch (err) {
    if (r.mark !== mark) return;
    r.mode = 'note';
    r.pinIt.disabled = false;
    r.msg.textContent = err instanceof RefusedError ? err.message : 'Could not reach HQ. Try again?';
  }
}
// On HQ: the note on its sheet in the book (a mark needs no words there: its ink says it), and the post-it flies off;
// as pinned's, only while its mark is the one open
async function booked(r) {
  if (r.mark.kind === 'general' && !r.mark.snap && !r.text.value.trim()) {
    r.text.focus();
    r.msg.textContent = 'A word or two first?';
    return;
  }
  r.mode = 'sending';
  r.pinIt.disabled = true;
  r.msg.textContent = 'Putting it in the book…';
  const mark = r.mark,
    open = () => r.mark === mark;
  try {
    const { photoless } = (await toBook(r)) ?? {};
    if (!open()) return;
    r.text.value = '';
    // (a note that went without its photo says so before the post-it goes)
    if (photoless) r.msg.textContent = 'In the book. No photo this time.';
    setTimeout(
      () => {
        if (!open()) return;
        r.sheet.classList.add('away');
        setTimeout(() => open() && reset(r), 450);
      },
      photoless ? 1800 : 0,
    );
  } catch (err) {
    if (!open()) return;
    r.mode = 'note';
    r.pinIt.disabled = false;
    r.msg.textContent = err?.status ? `The book said no: ${err.message}` : 'Could not reach the book. Try again?';
  }
}
export function setupPostit(r) {
  r.$('[data-cancel]').onclick = () => reset(r);
  // (words typed after any were said: the Pencil keeps its own.)
  if (!r.book) r.text.addEventListener('input', () => (r.typed = true));
  r.pinIt.onclick = () => pinIt(r);
  // With the on-screen keyboard up (Chrome on Android resizes only the visual viewport), lift the note above it.
  const vv = window.visualViewport;
  if (!vv) return;
  const fit = () => r.sheet.style.setProperty('--kb', `${Math.max(0, innerHeight - vv.height - vv.offsetTop)}px`);
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
}
