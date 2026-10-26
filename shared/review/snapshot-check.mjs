// Review mode's screenshot against the browser's own (shared/review/README.md, "Testing locally"). A page of plain
// colours, held like a phone: a sticky header with a row under it, an awning drawn
// by the header's ::after from a picture file, and a chat in a custom element with an open shadow root (its styles
// from a <link> in the root, a 0×0 fixed host at the page's end like a support chat's, its panel fixed over the
// header). Then what a fixed or sticky box's ancestors and siblings do to it: a dialog in a faded-out wrapper and one
// in a positioned wrapper with a filter, a box with a high z-index in a parent below a sibling, a fixed box under a
// later positioned sibling, a sticky box clipped by its overflow:hidden parent and a fixed one that isn't, a sticky box
// in an overflow:clip box (it cuts but doesn't scroll) and a fixed box in a positioned overflow:hidden box under that
// box's later positioned sibling. Then flip cards in a preserve-3d context, each face backface-visibility: hidden, and
// an inline box of text that the browser can't turn.
// At the top and scrolled, each spot of the note's screenshot must be the colour the browser shows there. Scrolled, the
// note is pinned on the chat's panel: the note's element must be the panel, inside its shadow root. Then the same on
// two more pages: a sticky header with sticky rows and a sticky band, and pages that scroll their own boxes (HEADER and
// SCROLLER below say what's on them), and pages with popups open (POPUP, POPUP_FIRST and POPUP_NESTED: the note pinned inside them), and a fixed box over another one's band (STACKED).
//   node shared/review/snapshot-check.mjs [--shots dir]
// Exit 1 on any failure.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { playwright } from '../browser/browser.mjs';
import { fulfilPart } from './parts.mjs';

const REPO = new URL('../..', import.meta.url).pathname;
const at = process.argv.indexOf('--shots'), SHOTS = at > 0 ? process.argv[at + 1] : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const { chromium } = playwright();
const REVIEW_JS = readFileSync(join(REPO, 'shared/review/review.js'), 'utf8');

const C = {
  strip: '#94a3b8', header: '#1d4ed8', awning: '#dc2626', row: '#16a34a', page: '#fde68a', panel: '#9333ea', box: '#0891b2',
  cover: '#f97316', front: '#be185d', back: '#65a30d',
};
const PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width">
<style>
  body { margin: 0; background: ${C.page}; }
  .strip { height: 30px; background: ${C.strip}; }
  header { position: sticky; top: 0; z-index: 50; height: 60px; background: ${C.header}; }
  header::after { content: ''; position: absolute; left: 0; top: 100%; width: 25%; height: 12px; background: url(/awning.svg); }
  .row { height: 60px; background: ${C.row}; }
  .tall { height: 2000px; overflow: clip; }
  .mark { position: sticky; top: 300px; margin-left: 20px; width: 60px; height: 40px; background: ${C.box}; }
  .cutter { position: absolute; left: 260px; top: 300px; width: 10px; height: 40px; overflow: hidden; }
  .cutter .fix { left: 140px; top: 300px; width: 100px; height: 60px; }
  .sibling { position: absolute; left: 140px; top: 300px; width: 100px; height: 60px; background: ${C.cover}; }
  .fade, .low { position: absolute; top: 300px; } /* on screen at the top and scrolled */
  .fade { opacity: 0; }
  .dialog, .pop, .over, .shelf, .fix { position: fixed; top: 230px; width: 100px; height: 60px; }
  .dialog { left: 20px; background: ${C.box}; }
  .low { z-index: 1; }
  .pop { left: 140px; z-index: 10; background: ${C.box}; }
  .over { left: 140px; z-index: 2; background: ${C.cover}; }
  .shelf { left: 260px; height: 100px; background: ${C.strip}; }
  .clip { overflow: hidden; height: 40px; }
  .stuck { position: sticky; top: 0; height: 80px; background: ${C.box}; }
  .shelf.lower, .fix { left: 20px; top: 380px; }
  .shelf.lower .clip { position: relative; } /* would cut the fixed box's copy positioned in it: lifted out */
  .fix { height: 80px; background: ${C.box}; }
  .under, .later { position: fixed; left: 140px; top: 560px; width: 100px; height: 40px; background: ${C.box}; }
  .later { position: absolute; background: ${C.cover}; } /* over the fixed box at the top, above it when scrolled */
  .filtered { position: absolute; top: 300px; filter: opacity(0); }
  .filtered .dialog { top: 180px; height: 40px; } /* positioned in its wrapper: on screen at 480 at the top, 180 scrolled */
  .cards { position: fixed; left: 20px; top: 505px; display: flex; gap: 15px; }
  .flip { position: relative; width: 40px; height: 50px; transform-style: preserve-3d; }
  .flip.turned { rotate: y 180deg; }
  .face { position: absolute; inset: 0; backface-visibility: hidden; background: ${C.front}; }
  /* two colours side by side: drawn mirrored, the copy would show them the wrong way round */
  .face.back { transform: rotateY(180deg); background: linear-gradient(90deg, ${C.back} 50%, ${C.cover} 50%); }
  .seen { position: fixed; left: 20px; top: 160px; width: 40px; perspective: 400px; perspective-origin: 200px 25px; }
  .flip.edge { rotate: y 100deg; } /* seen from far to its right: its front, though a flat view would see its back */
  .cards.more { top: 160px; left: 75px; gap: 10px; } .more .flip { width: 30px; } /* clear of the tool's tip */
  .flip.shifted { translate: calc(10% - 3px); } /* a calc() the computed style keeps: 0px here */
  .flip.hinted { will-change: opacity; } /* flattens it: the front, painted on it, turns with it, mirrored */
  .wrap { position: absolute; inset: 0; overflow: hidden; transform-style: preserve-3d; } /* flattens it too */
  .face.deep { transform-style: preserve-3d; } /* turned away: its plain child goes with it, one with a transform not */
  .dot { position: absolute; left: 0; right: 0; bottom: 0; height: 15px; background: ${C.box}; }
  .dot.own { top: 0; bottom: auto; transform: scale(1); }
  .face.deep::after { content: ""; position: absolute; inset: 15px 0; background: ${C.box}; } /* goes with it too */
  .line { position: fixed; left: 250px; top: 590px; line-height: 50px; } /* clear of the tool's tip and button */
  .line span { padding: 10px 20px; transform: rotateY(180deg); backface-visibility: hidden; background: ${C.front}; }
</style></head><body>
<div class="strip"></div><header></header><div class="row"></div><div class="tall"><div class="mark"></div></div>
<div class="fade"><div class="dialog"></div></div>
<div class="low"><div class="pop"></div></div><div class="over"></div>
<div class="shelf"><div class="clip"><div class="stuck"></div></div></div>
<div class="shelf lower"><div class="clip"><div class="fix"></div></div></div>
<div class="under"></div><div class="later"></div>
<div class="filtered"><div class="dialog"></div></div>
<div class="cutter"><div class="fix"></div></div><div class="sibling"></div>
<!-- --><div class="cards"><div class="flip"><div class="face"></div><div class="face back"></div></div><div class="flip turned"><div class="face"></div><div class="face back"></div></div></div>
<div class="cards more"><div class="flip shifted"><div class="face"></div><div class="face back"></div></div><div class="flip turned hinted"><div class="face"></div><div class="face back"></div></div>
  <div class="flip turned"><div class="wrap"><div class="face"></div><div class="face back"></div></div></div><div class="flip turned"><div class="face deep"><div class="dot"></div><div class="dot own"></div></div></div></div>
<div class="seen"><div class="flip edge"><div class="face"></div></div></div>
<div class="line"><span>x</span></div>
<chat-box></chat-box>
<script>
  customElements.define('chat-box', class extends HTMLElement {
    connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<link rel="stylesheet" href="/chat.css"><section class="panel"></section>'; }
  });
</script>
<script src="/__review/review.js" defer></script></body></html>`;
// A page held like a phone and scrolled, its header sticky above the top so only its first row stays on screen: a box
// sticky in that row, and a band under it drawn by the header's sticky ::before, which covers the row under it once
// scrolled. A tall box whose last child is shifted by position:relative, and whose sticky ::after sticks to the bottom
// of the screen at the top and sits under the child's place in the flow once scrolled, another that ends in a line
// of text, with leading under the letters, and a third whose last child is a line shifted down by position:relative,
// its band stuck to the bottom of the screen as it is under the line's place in the flow. A pill whose label's font comes from a stylesheet the screenshot can't read,
// so its copy draws the label wider (as Firefox draws text a hair wider than on screen): the label stays on one line
const HEADER = `<!doctype html><html><head><meta name="viewport" content="width=device-width">
<link rel="stylesheet" href="http://fonts.test/slim.css">
<style>
  body { margin: 0; background: ${C.page}; }
  header { position: sticky; top: -40px; z-index: 50; background: ${C.header}; }
  header::before { content: ''; display: block; position: sticky; top: 0; z-index: 1; height: 40px; margin-bottom: -40px; background: ${C.strip}; }
  .bar { display: flex; flex-wrap: wrap; }
  .logo, .nav { position: sticky; top: 0; z-index: 2; width: 80px; height: 40px; background: ${C.panel}; }
  .nav { margin-left: auto; width: 60px; background: ${C.box}; }
  .search { order: 3; flex: 1 1 100%; height: 30px; margin: 0 10px 10px 0; background: ${C.row}; }
  .lead, .next { margin-left: 160px; width: 30px; }
  .lead i { display: block; height: 200px; margin: 30px 0; background: ${C.awning}; }
  .next { height: 300px; background: ${C.cover}; }
  .tall { height: 2000px; }
  .pill { position: fixed; left: 20px; top: 300px; font: 16px/30px Slim, monospace; }
  .pill b { font-weight: normal; color: ${C.front}; background: ${C.front}; }
  .price { position: fixed; left: 20px; top: 380px; width: 120px; font: 16px/30px monospace; }
  .price :is(b, span) { font-weight: normal; color: ${C.front}; background: ${C.front}; }
  .icon { position: fixed; left: 300px; top: 460px; }
  .icon .square { fill: ${C.panel}; }
  .card { position: fixed; left: 200px; top: 300px; width: 150px; }
  .card i { display: block; height: 20px; margin-bottom: 20px; background: ${C.cover}; }
  .card .after { height: 20px; background: ${C.box}; }
  article { position: absolute; left: 350px; top: 100px; width: 40px; height: 1000px; }
  article p { height: 600px; margin: 0 0 10px; position: relative; top: 100px; }
  article::after, .words::after, .shifted::after { content: ''; display: block; position: sticky; bottom: 0; height: 40px; background: ${C.awning}; }
  .words { position: absolute; left: 300px; top: 100px; width: 40px; height: 1000px; line-height: 40px; }
  .words p { height: 520px; margin: 0; }
  .shifted { position: absolute; left: 220px; top: 600px; width: 40px; height: 1000px; line-height: 20px; }
  .shifted span { position: relative; top: 40px; color: transparent; }
</style></head><body>
<header><div class="bar"><div class="logo"></div><div class="search"></div><div class="nav"></div></div></header>
<div class="lead"><i></i></div><div class="next"></div><div class="tall"></div><article><p></p></article><div class="words"><p></p>Hi</div><span class="pill"><b>Waving by the door</b></span>
<div class="price"><b>€39.95</b><span> delivered</span></div>
<div class="card"><div><i></i></div><div class="after"></div></div><div class="shifted"><span>Hi</span></div>
<svg class="icon" width="40" height="40"><rect class="square" width="40" height="40"/></svg>
<script src="/__review/review.js" defer></script></body></html>`;
// A page that scrolls its own boxes, not itself: a row scrolled sideways, a main scrolled down with a sticky header that
// stays at its top, centred and narrower than a wide box in main, and beside it a positioned box scrolled down with an
// absolutely positioned box inside, which scrolls with it.
const STRIPES = ['strip', 'row', 'box', 'cover'];
const SCROLLER = `<!doctype html><html><head><meta name="viewport" content="width=device-width">
<style>
  body { margin: 0; height: 100vh; display: flex; flex-direction: column; background: ${C.page}; }
  body::before { content: ''; position: fixed; left: 290px; top: 400px; width: 80px; height: 40px; z-index: -1; background: ${C.front}; }
  .lane { flex: none; height: 60px; display: flex; overflow-x: auto; }
  .lane i { flex: none; width: 100px; }
  .two { flex: 1; display: flex; min-height: 0; }
  main { flex: 1; overflow: auto; padding: 10px 0; }
  main h2 { position: sticky; top: 0; width: 100px; height: 30px; margin: 0 auto; background: ${C.panel}; }
  main u { display: block; width: 1000px; height: 1px; }
  main i { display: block; height: 100px; }
  aside { position: relative; width: 120px; overflow: auto; }
  aside .tall { height: 1000px; }
  aside .dot { position: absolute; left: 10px; top: 300px; width: 100px; height: 50px; background: ${C.front}; }
</style></head><body>
<div class="lane">${STRIPES.concat(STRIPES).map(c => `<i style="background:${C[c]}"></i>`).join('')}</div>
<div class="two"><main><h2></h2>${Array.from({ length: 20 }, (_, i) => `<i style="background:${C[STRIPES[i % 4]]}"></i>`).join('')}<u></u></main>
<aside><div class="tall"></div><div class="dot"></div></aside></div>
<script src="/__review/review.js" defer></script></body></html>`;
// Pages with popups open. POPUP: a modal dialog moved down by a transform over a
// sticky header with a high z-index, its backdrop a colour of its own and a z-index of -1 (the top layer ignores it),
// opened in one go with three popovers from outside it: one with a high z-index just before it, under its backdrop,
// and two after it, the first with a high z-index under the second with a low one where they overlap. The note is
// pinned on a button in the dialog, which stays open (it shuts on a tap beside what it shows). POPUP_FIRST: two modal
// dialogs open before review mode starts, opened in the reverse of their order on the page: the one opened last is over
// the other, and the note is pinned in it. POPUP_NESTED: a modal dialog opened inside another, then a popover inside the
// outer one but outside the inner one, over it: the note is pinned in the inner dialog, the one a tap reaches.
const POPUP = `<!doctype html><html><head><meta name="viewport" content="width=device-width">
<style>
  body { margin: 0; background: ${C.page}; }
  header { position: sticky; top: 0; z-index: 50; height: 60px; background: ${C.header}; }
  .tall { height: 2000px; }
  dialog { width: 300px; height: 300px; max-width: none; max-height: none; padding: 0; border: 0; z-index: -1; background: ${C.box}; transform: translateY(40px); }
  dialog::backdrop { background: ${C.strip}; }
  dialog p { height: 60px; margin: 20px; background: ${C.panel}; }
  dialog button { display: block; width: 120px; height: 40px; margin: 20px; border: 0; background: ${C.cover}; }
  [popover] { position: fixed; inset: auto; width: 80px; height: 40px; margin: 0; padding: 0; border: 0; }
  #low { left: 300px; top: 20px; z-index: 2000; background: ${C.row}; }
  #high { left: 10px; top: 100px; z-index: 1000; background: ${C.awning}; }
  #last { left: 50px; top: 120px; z-index: 1; background: ${C.header}; }
</style></head><body><header></header><div class="tall"></div>
<dialog id="popup"><p></p><button id="inside"></button></dialog>
<div id="low" popover="manual"></div><div id="high" popover="manual"></div><div id="last" popover="manual"></div>
<script>addEventListener('load', () => setTimeout(() => { low.showPopover(); popup.showModal(); high.showPopover(); last.showPopover(); }, 50));
  popup.addEventListener('click', e => { if (!e.target.closest('p, button')) popup.close(); });</script>
<script src="/__review/review.js" defer></script></body></html>`;
const POPUP_FIRST = `<!doctype html><html><head><meta name="viewport" content="width=device-width">
<style>
  body { margin: 0; background: ${C.page}; }
  dialog { position: fixed; inset: auto; width: 220px; height: 220px; max-width: none; max-height: none; margin: 0; padding: 0; border: 0; }
  #upper { left: 30px; top: 100px; background: ${C.box}; }
  #upper::backdrop { background: none; }
  #lower { left: 150px; top: 250px; background: ${C.cover}; }
  #lower::backdrop { background: ${C.strip}; }
  dialog button { display: block; width: 120px; height: 40px; margin: 20px; border: 0; background: ${C.panel}; }
</style></head><body>
<dialog id="upper"><button id="reach"></button></dialog><dialog id="lower"><button></button></dialog>
<script>lower.showModal(); upper.showModal();</script>
<script src="/__review/review.js" defer></script></body></html>`;
const POPUP_NESTED = `<!doctype html><html><head><meta name="viewport" content="width=device-width">
<style>
  body { margin: 0; background: ${C.page}; }
  dialog, [popover] { position: fixed; inset: auto; max-width: none; max-height: none; margin: 0; padding: 0; border: 0; }
  #outer { left: 20px; top: 80px; width: 360px; height: 480px; background: ${C.box}; }
  #outer::backdrop { background: ${C.strip}; }
  #inner { left: 60px; top: 200px; width: 200px; height: 200px; background: ${C.cover}; }
  #inner::backdrop { background: none; }
  #tip { left: 220px; top: 150px; width: 120px; height: 100px; background: ${C.awning}; }
  #inner button { display: block; width: 120px; height: 40px; margin: 20px; border: 0; background: ${C.panel}; }
</style></head><body>
<dialog id="outer"><dialog id="inner"><button id="deep"></button></dialog><div id="tip" popover="manual"></div></dialog>
<script>addEventListener('load', () => setTimeout(() => { outer.showModal(); inner.showModal(); tip.showPopover(); }, 50));</script>
<script src="/__review/review.js" defer></script></body></html>`;
// A screen-sized fixed box (an app's board) whose ::after band has a z-index, and a later fixed box over the band (its
// status line, moved by a transform): the band stacks inside its fixed box, so the later box paints over it (copy.js's
// isolation).
const STACKED = `<!doctype html><html><head><meta name="viewport" content="width=device-width">
<style>
  body { margin: 0; background: ${C.page}; }
  .board { position: fixed; inset: 0; }
  .board::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 200px; z-index: 1; background: ${C.cover}; }
  .foot { position: fixed; left: 20px; top: 600px; width: 200px; height: 60px; transform: translateY(-100%); background: ${C.box}; }
</style></head><body>
<div class="board"></div><div class="foot"></div>
<script src="/__review/review.js" defer></script></body></html>`;
const FILES = {
  '/': ['text/html', PAGE],
  '/popup': ['text/html', POPUP],
  '/popup-first': ['text/html', POPUP_FIRST],
  '/popup-nested': ['text/html', POPUP_NESTED],
  '/stacked': ['text/html', STACKED],
  '/header': ['text/html', HEADER],
  '/scroller': ['text/html', SCROLLER],
  '/slim.css': ['text/css', '@font-face { font-family: Slim; src: local("Liberation Sans Narrow"), local("DejaVu Sans Condensed"), local("Arial Narrow"); }'],
  '/awning.svg': ['image/svg+xml', `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="12"><rect width="20" height="12" fill="${C.awning}"/></svg>`],
  '/chat.css': ['text/css', `:host { all: initial; position: fixed; z-index: 1000; } .panel { position: fixed; right: 10px; top: 20px; width: 150px; height: 200px; background: ${C.panel}; }`],
};
// [x, y, colour]: the header, the awning and the panel over it; the row under the header (at the top) or the page
// (scrolled); then the same at both: no faded-out dialog, the sibling over the high box, the sticky box cut at its
// parent's edge and the fixed one whole, the sticky box in the overflow:clip box; then the later sibling over the fixed
// box at the top (the fixed box alone, scrolled), no filtered-out dialog and the positioned sibling over the fixed box
// in its overflow:hidden sibling at the top (that fixed box alone, scrolled)
const BOXES = [[70, 260, 'page'], [190, 260, 'cover'], [310, 250, 'box'], [310, 300, 'strip'], [70, 440, 'box'],
  [50, 320, 'box']];
// [x, y, colour] of each flip card, at the top and scrolled
const CARDS = {
  // front up: only its front
  up: [[28, 530, 'front'], [52, 530, 'front']],
  // turned by the rotate property: only its back, the right way round
  turned: [[83, 530, 'back'], [107, 530, 'cover']],
  // turned just past edge-on under an off-centre perspective: its front, as in the browser
  edge: [[39, 185, 'front']],
  // moved by a calc() translate: its front
  shifted: [[82, 185, 'front'], [98, 185, 'front']],
  // flattened by will-change: opacity: its front
  hinted: [[122, 185, 'front'], [138, 185, 'front']],
  // flattened by an overflow:hidden box between it and its faces: its front
  wrapped: [[162, 185, 'front'], [178, 185, 'front']],
  // a preserve-3d face turned away: nothing but its child with a transform
  deep: [[210, 167, 'box'], [210, 185, 'page'], [210, 203, 'page']],
  // an inline box of text turned away: the browser doesn't turn it, so it shows
  inline: [[255, 615, 'front']],
};
BOXES.push(...Object.values(CARDS).flat());
const CASES = {
  top: { y: 0, tap: [20, 600], spots: [[20, 15, 'strip'], [100, 60, 'header'], [50, 96, 'awning'], [150, 96, 'row'], [100, 130, 'row'],
    [300, 60, 'panel'], [300, 200, 'panel'], [100, 300, 'page'], ...BOXES, [190, 580, 'cover'], [70, 500, 'page'],
    [190, 330, 'cover']] },
  scrolled: { y: 300, tap: [370, 120], pinned: 'body > chat-box section.panel', spots: [[100, 30, 'header'], [50, 66, 'awning'], [150, 66, 'page'], [300, 40, 'panel'],
    [300, 200, 'panel'], [100, 300, 'page'], ...BOXES, [190, 580, 'box'], [70, 200, 'page'], [190, 330, 'box']] },
  // the header's rows, then the pill's label on its one line and nothing under it, and the tall box's band stuck to the
  // bottom of the screen, and the shifted line's band stuck there too
  header: { path: '/header', y: 0, tap: [200, 500], spots: [[40, 20, 'panel'], [200, 20, 'strip'], [370, 20, 'box'], [200, 55, 'row'],
    [200, 72, 'header'], [25, 315, 'front'], [25, 345, 'page'], [110, 395, 'page'], [25, 425, 'front'], [250, 310, 'cover'], [250, 330, 'page'],
    [250, 350, 'box'], [170, 100, 'page'], [170, 150, 'awning'], [170, 330, 'page'], [170, 350, 'cover'],
    [320, 480, 'panel'], [386, 590, 'page'], [386, 630, 'awning'], [310, 605, 'awning'],
    [240, 590, 'page'], [240, 610, 'awning'], [240, 630, 'awning']] },
  // scrolled: the box and the band in the first row, over the row under it, and below the header the box after one
  // that's off screen, its child's margins between them; the tall box's band under its content
  headerScrolled: { path: '/header', y: 400, tap: [200, 500], spots: [[40, 20, 'panel'], [200, 10, 'strip'], [200, 30, 'strip'],
    [370, 20, 'box'], [200, 60, 'page'], [25, 315, 'front'], [25, 345, 'page'], [110, 395, 'page'], [25, 425, 'front'], [250, 310, 'cover'], [250, 330, 'page'],
    [250, 350, 'box'], [170, 200, 'cover'], [170, 230, 'cover'], [170, 260, 'page'],
    [320, 480, 'panel'], [370, 305, 'page'], [370, 345, 'awning'], [305, 280, 'awning']] },
  // the row's second, third and fourth stripe; main's eighth, ninth and tenth; the positioned box where its scroll has
  // it; main's header at main's top
  scroller: { path: '/scroller', y: 0, scroll: { '.lane': [150, 0], main: [0, 760], aside: [0, 250] }, tap: [100, 450],
    spots: [[20, 30, 'row'], [100, 30, 'box'], [200, 30, 'cover'], [100, 100, 'cover'], [100, 200, 'strip'], [100, 300, 'row'],
      [330, 130, 'front'], [330, 200, 'page'], [330, 420, 'front'], [100, 75, 'panel']] },
  // the backdrop over the header, the page and the popover opened before the dialog; the dialog, its box and button;
  // the first popover after it alone, then under the second where they overlap, and the second alone
  popup: { path: '/popup', y: 0, tap: [160, 330], pinned: 'button#inside', open: '#popup', spots: [[200, 30, 'strip'], [200, 600, 'strip'],
    [380, 120, 'strip'], [330, 40, 'strip'], [340, 450, 'box'], [200, 260, 'panel'], [100, 340, 'cover'], [30, 110, 'awning'],
    [70, 130, 'header'], [110, 150, 'header']] },
  // the lower dialog's backdrop, the upper dialog alone and over the lower one, the lower one alone, the button
  popupFirst: { path: '/popup-first', y: 0, tap: [80, 140], pinned: 'button#reach', open: '#upper', spots: [[20, 600, 'strip'],
    [60, 250, 'box'], [200, 290, 'box'], [300, 400, 'cover'], [150, 150, 'panel']] },
  // the outer dialog's backdrop, the outer dialog, the inner one, the popover alone and over the inner one, the button
  popupNested: { path: '/popup-nested', y: 0, tap: [100, 240], pinned: 'button#deep', open: '#inner', spots: [[10, 600, 'strip'],
    [40, 100, 'box'], [100, 350, 'cover'], [300, 180, 'awning'], [240, 225, 'awning'], [180, 245, 'panel']] },
  // the later fixed box over the band, the band beside it, the page above the band
  stacked: { path: '/stacked', y: 0, tap: [100, 150], spots: [[120, 570, 'box'], [300, 570, 'cover'], [300, 300, 'page']] },
};

const browser = await chromium.launch();
const failures = [];
for (const [name, { path = '/', y, scroll = {}, tap, pinned, open, spots }] of Object.entries(CASES)) {
  const ctx = await browser.newContext({ viewport: { width: 400, height: 640 }, deviceScaleFactor: 1, hasTouch: true });
  let shot, element;
  await ctx.route('http://fonts.test/**', r => r.fulfill({ contentType: 'text/css', body: FILES['/slim.css'][1] })); // read only by the page
  await ctx.route('http://shot.test/**', r => {
    const path = new URL(r.request().url()).pathname;
    if (path === '/__review/notes') { ({ shot, element } = JSON.parse(r.request().postData())); return r.fulfill({ contentType: 'application/json', body: '{"id":1}' }); }
    if (fulfilPart(r, path, REVIEW_JS)) return;   // (review mode and its parts)
    const file = FILES[path]; return file ? r.fulfill({ contentType: file[0], body: file[1] }) : r.fulfill({ status: 404 });
  });
  await ctx.addInitScript(() => { // the tool's own root is closed: open it to drive the note
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (o) { return attach.call(this, { ...o, mode: 'open' }); };
  });
  const page = await ctx.newPage();
  await page.goto(`http://shot.test${path}`); await page.waitForTimeout(500);
  await page.evaluate(([top, boxes]) => {
    scrollTo(0, top);
    for (const [selector, [left, down]] of Object.entries(boxes)) document.querySelector(selector).scrollTo(left, down);
  }, [y, scroll]);
  await page.waitForTimeout(300);
  const label = await page.evaluate(() => {
    const b = document.querySelector('.pill b'), wide = b?.cloneNode(true);
    if (!b) return null;
    wide.style.font = '16px monospace'; document.body.append(wide);
    const narrow = b.offsetWidth < wide.offsetWidth; wide.remove();
    return { narrow, lines: b.getClientRects().length };
  });
  if (label && (!label.narrow || label.lines !== 1)) failures.push(`${name}: the pill's label isn't on one line in a narrow font on the page (no narrow font here?): fix the check`);
  const seen = await page.screenshot();
  const ui = () => [...document.querySelectorAll('*')].find(e => e.shadowRoot?.querySelector('.fab')).shadowRoot;
  // the pin tapped as the board does, where it is on screen (an inert one doesn't take it)
  const pin = await page.evaluate(`(() => { const r = (${ui})().querySelector('.fab').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  await page.mouse.click(...pin); await page.waitForTimeout(400);
  if (!(await page.evaluate(`!(${ui})().querySelector('.veil').hidden`))) { failures.push(`${name}: a tap on the pin didn't start a note`); await ctx.close(); continue; }
  await page.mouse.click(...tap); await page.waitForTimeout(800); // a pin clear of the spots
  await page.evaluate(`{ const r = (${ui})(); r.querySelector('textarea').value = 'a note'; r.querySelector('.send').click(); }`);
  for (let t = 0; t < 50 && !shot; t++) await page.waitForTimeout(200);
  if (!shot) { failures.push(`${name}: no screenshot came with the note`); await ctx.close(); continue; }
  if (pinned && element?.el?.selector !== pinned) failures.push(`${name}: the note is pinned on ${element?.el?.selector}, not ${pinned}`);
  if (open && !(await page.evaluate(s => document.querySelector(s).open, open))) failures.push(`${name}: the popup closed`);
  if (SHOTS) { writeFileSync(join(SHOTS, `${name}-browser.png`), seen); writeFileSync(join(SHOTS, `${name}-review.jpg`), Buffer.from(shot.split(',')[1], 'base64')); }
  const read = src => page.evaluate(async ([src, spots]) => {
    const img = new Image(); img.src = src; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 640;
    const context = canvas.getContext('2d'); context.drawImage(img, 0, 0, 400, 640);
    return spots.map(([x, y]) => [...context.getImageData(x, y, 1, 1).data.slice(0, 3)]);
  }, [src, spots]);
  const [browserPx, reviewPx] = [await read(`data:image/png;base64,${seen.toString('base64')}`), await read(shot)];
  const rgb = hex => [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16)), near = (a, b) => a.every((value, at) => Math.abs(value - b[at]) < 40);
  spots.forEach(([x, y, want], spot) => {
    if (!near(browserPx[spot], rgb(C[want]))) failures.push(`${name}: the page itself isn't ${want} at ${x},${y} (${browserPx[spot]}): fix the check`);
    else if (!near(reviewPx[spot], rgb(C[want]))) failures.push(`${name}: the screenshot shows ${reviewPx[spot]} at ${x},${y}, the browser ${want}`);
  });
  await ctx.close();
}
await browser.close();
for (const failure of failures) console.log('FAIL', failure);
console.log(failures.length ? `${failures.length} failed` : `ok: ${Object.values(CASES).reduce((n, c) => n + c.spots.length, 0)} spots match the browser, and the pin on the chat is on its panel`);
process.exit(failures.length ? 1 : 0);
