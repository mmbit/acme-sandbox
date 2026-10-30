// What the tips book (booktips.js) shows: the book's hidden things, one tip a page, in four parts. Each tip says what
// the book does today, in a line or two, over a scene of it (booktipscene.js), and names the code it describes (from):
// a change to that behaviour changes its tip here in the same pull request, a new hidden thing adds one, and a thing
// taken out takes its tip with it. The tips book shows only what's built. (the call's tip naming
// the Select carry)
import { MOD } from './ink/bookui.js';
import * as draw from './booktipscene.js';

export const PARTS = ['Writing', 'Gestures', 'Answers', 'Controls'];

// (a ring round HQ's middle card, and the same ring small, lifting into the book at the edge)
const RING = 'M30 60c10-14 70-16 112-6s18 32-30 36-90 2-88-14 8-20 24-22';
// (the lines whose ink is held for a while of its own, so its pen is drawn apart: written() draws the rest)
const MARK = 'M60 40c20-6 40-6 60 2',
  SCRIBBLE = 'M86 42l16-10-12 16 18-14-14 18 18-14-14 16 16-12',
  LASSO = 'M60 44c30-16 100-14 100 18s-80 20-100 4-10-18 10-24';

// (a target the page is dropped on, at the scene's right: bookshare.js's PDF, PNG and Call)
const target = (y, label) =>
  `<g class="tb-key"><rect x="196" y="${y}" width="40" height="26" rx="5"/><text x="216" y="${y + 18}" text-anchor="middle">${label}</text></g>`;

export const TIPS = [
  {
    part: 'Writing',
    title: 'Draw on HQ to make a note',
    words:
      'Draw on any page of HQ. Rest the pen a moment and your mark goes into the book, with what you said as you drew.',
    from: 'shared/review/settle.js',
    scene: draw.scene(
      draw.hqPage(),
      draw.bookEdge(),
      draw.moved(0.5, 0.72, { dx: 120, dy: 10, scale: 0.35, cx: 86, cy: 72 }, draw.ink(RING, 0.08, 0.36)),
      draw.pen(RING, 0.08, 0.36),
      draw.during(0.72, 1, draw.note(184, 62, 50, 22)),
    ),
  },
  {
    part: 'Writing',
    title: 'Tap the pin to draw without a Pencil',
    words: 'With a mouse or a finger, turn on Settings › Pin on HQ, then tap the pin and draw on HQ the same way.',
    // (the pin a pen on HQ's page, as review mode draws it.)
    from: 'platform/hq/shell/pinsetting.js',
    scene: draw.scene(
      draw.hqPage(),
      draw.bookEdge(),
      `<g class="tb-pin" transform="translate(140 122)"><path d="M-7 7l1.5-5 8-8 3.5 3.5-8 8z"/><path d="M-5.5 2l3.5 3.5"/></g>`,
      draw.tap(140, 122, 0.15),
      draw.during(0.22, 1, '<circle class="tb-pinned" cx="146" cy="128" r="8"/>'),
      draw.written('M40 98c20-8 50-8 70 0', 0.42, 0.66, { by: draw.mouse }),
    ),
  },
  {
    part: 'Writing',
    title: 'Double-click a page to type',
    words: 'Double-click bare paper in the book and type. Click the words later to change them.',
    from: 'platform/hq/shell/ink/booktexts.js',
    scene: draw.scene(
      draw.bookPage(),
      draw.mouse('M150 120L70 52', 0, 0.2),
      draw.tap(70, 52, 0.24),
      draw.tap(70, 52, 0.31),
      draw.during(0.36, 1, '<rect class="tb-typed" x="66" y="40" width="110" height="26" rx="2"/>'),
      ...[0, 1, 2, 3, 4, 5].map(i =>
        draw.during(
          0.42 + i * 0.06,
          1,
          `<rect class="tb-letters" x="72" y="48" width="${12 + i * 14}" height="10" rx="2"/>`,
        ),
      ),
    ),
  },
  {
    part: 'Writing',
    title: 'Paste or drop a picture on a page',
    words: `Copy a picture anywhere and paste it in the book (${MOD}+V), or drop a picture file on it: it lands taped on the page you’re on.`,
    from: 'platform/hq/shell/ink/booktape.js',
    scene: draw.scene(
      draw.bookPage(),
      draw.key(30, 112, MOD, 0.1, 34),
      draw.key(68, 112, 'V', 0.14),
      draw.moved(
        0.2,
        0.45,
        { dy: 70, scale: 1 },
        `<g transform="translate(0 -70)"><rect class="tb-photo" x="110" y="26" width="80" height="58" rx="2"/><path class="tb-photo-hill" d="M114 80l22-24 16 14 12-10 22 20z"/><circle class="tb-photo-sun" cx="172" cy="40" r="6"/></g>`,
      ),
      draw.during(
        0.5,
        1,
        '<rect class="tb-tape" x="134" y="18" width="34" height="12" transform="rotate(-6 151 24)"/>',
      ),
    ),
  },
  {
    part: 'Writing',
    title: 'Hold the Pencil still and say your note',
    words: 'Hold the Pencil still on HQ for a moment and talk: what you say goes into the book with your mark.',
    from: 'shared/review/pentouch.js',
    scene: draw.scene(
      draw.hqPage(),
      draw.bookEdge(),
      draw.pen('M90 80l0 0', 0.06, 0.5),
      ...[0, 1, 2].map(i =>
        draw.during(
          0.2 + i * 0.1,
          1,
          `<path class="tb-ink" d="M${106 + i * 8} ${74 - i * 2}a${8 + i * 6} ${8 + i * 6} 0 0 1 0 ${12 + i * 4}"/>`,
        ),
      ),
      draw.during(0.62, 1, draw.note(184, 62, 50, 22)),
    ),
  },
  {
    part: 'Gestures',
    title: 'Circle something to note about it',
    words: 'With the Pencil, draw a circle round something on HQ: your note is then about just that thing.',
    from: 'shared/review/gestures.js',
    scene: draw.scene(
      draw.hqPage(8, 10, 224, 130),
      draw.during(0.42, 1, '<rect class="tb-picked" x="18" y="64" width="204" height="30" rx="3"/>'),
      draw.written('M14 80c0-14 60-22 120-20s96 6 94 20-60 20-118 18-96-6-96-20c2-8 20-12 34-12', 0.08, 0.4),
    ),
  },
  {
    part: 'Gestures',
    title: 'Scribble over a mark to delete it',
    words: 'Changed your mind while drawing on HQ? Scribble over the mark before you rest the pen, and it’s gone.',
    from: 'shared/review/gestures.js',
    scene: draw.scene(
      draw.hqPage(8, 10, 224, 130),
      draw.during(0, 0.62, draw.ink(MARK, 0.04, 0.2)),
      draw.during(0, 0.62, draw.ink(SCRIBBLE, 0.3, 0.56, { cls: 'tb-ink tb-scrub' })),
      draw.pen(MARK, 0.04, 0.2),
      draw.pen(SCRIBBLE, 0.3, 0.56),
    ),
  },
  {
    part: 'Gestures',
    // (the wheel zooms, Ctrl's picks a tool)
    title: 'Drag to move the page, pinch or scroll to zoom',
    words: `A finger moves the page, two pinch to zoom. With a mouse: hold Space and drag, scroll to zoom, ${MOD} and scroll for the next tool.`,
    from: 'platform/hq/shell/ink/bookpan.js',
    scene: draw.scene(
      draw.moved(
        0.15,
        0.5,
        { dx: -40, dy: -14 },
        draw.bookPage(10, 8, 260, 160) +
          draw.ink('M60 50c10-14 30 10 44-4s20 8 30 0', 0, 0.01) +
          draw.ink('M150 106c10-10 30 8 44-2', 0, 0.01),
      ),
      draw.finger('M150 70l-40-14', 0.15, 0.5),
      draw.finger('M176 98l-40-14', 0.15, 0.5),
    ),
  },
  {
    part: 'Gestures',
    title: 'Tap the grid button to see all pages',
    words:
      'Tap the grid button at the foot of the book to see all its pages: drag one to put it in order, tick its box to archive it. Zoom out from there for the Shelf of every notebook.',
    from: 'platform/hq/shell/ink/bookzoom.js, platform/hq/shell/ink/bookshelf.js',
    scene: draw.scene(
      draw.during(0, 0.42, draw.moved(0.1, 0.4, { scale: 0.3, cx: 120, cy: 75 }, draw.bookPage(20, 8, 200, 134))),
      draw.during(0.4, 1, [0, 1, 2].map(i => draw.bookPage(18 + i * 72, 44, 60, 40)).join('')),
      draw.tap(120, 140, 0.08),
    ),
  },
  {
    part: 'Gestures',
    title: 'Loop round ink with Select to move it',
    words:
      'With Select, draw a loop round ink to pick it up, then drag it. Shift adds or takes away. Delete clears it.',
    from: 'platform/hq/shell/ink/bookselect.js',
    scene: draw.scene(
      draw.bookPage(),
      draw.moved(0.56, 0.8, { dx: 40, dy: 24 }, draw.ink('M70 60c10-14 30 10 44-4s20 8 30 0', 0, 0.01)),
      draw.during(0.08, 0.5, draw.ink(LASSO, 0.08, 0.42, { cls: 'tb-lasso' })),
      draw.pen(LASSO, 0.08, 0.42),
      draw.during(
        0.5,
        1,
        draw.moved(0.56, 0.8, { dx: 40, dy: 24 }, '<rect class="tb-frame" x="62" y="44" width="90" height="24"/>'),
      ),
      draw.mouse('M108 56l40 24', 0.56, 0.8),
    ),
  },
  {
    part: 'Answers',
    title: 'Reply to an agent’s answer under it',
    words:
      'An agent’s answer appears beside your note. Write a tick, a cross, a ? or a few words on the lines under it: it’s sent once you rest the pen.',
    from: 'platform/hq/shell/ink/bookanswerreply.js',
    scene: draw.scene(
      draw.bookPage(),
      draw.note(36, 24, 120),
      draw.during(0.08, 1, '<path class="tb-typed-line" d="M52 70h120M52 82h90"/>'),
      draw.during(0.3, 1, '<path class="tb-rule" d="M52 108h140"/>'),
      draw.written('M60 98l7 8 14-18', 0.44, 0.62),
    ),
  },
  {
    part: 'Answers',
    title: 'Circle a version to choose it',
    words:
      'When an agent tries a few versions, they show under your note. Circle the one you like: it’s stamped CHOSEN, and once you submit the page it’s built and the rest are cleared.',
    from: 'platform/hq/shell/ink/bookversions.js',
    scene: draw.scene(
      draw.bookPage(),
      ...[0, 1, 2].map(i => `<rect class="tb-photo" x="${34 + i * 60}" y="40" width="52" height="40" rx="2"/>`),
      draw.written('M150 56c0-16 48-18 52 0s-6 30-30 30-30-12-22-28', 0.12, 0.5),
      draw.during(0.6, 1, '<rect class="tb-picked" x="150" y="88" width="48" height="12" rx="2"/>'),
    ),
  },
  {
    part: 'Controls',
    // (Submit, the call's target gone)
    title: 'Tear a page out by its corner to submit it',
    words:
      'Drag the turned-down corner of a page onto Submit: it flies off as a paper plane, and the page is stamped Sent and locked. Onto PDF or PNG to keep or share it. Tap the corner for the same choices.',
    from: 'platform/hq/shell/ink/bookdogear.js, platform/hq/shell/ink/bookshare.js, platform/hq/shell/ink/bookpagesend.js',
    scene: draw.scene(
      target(26, 'Submit'),
      target(62, 'PDF'),
      target(98, 'PNG'),
      draw.during(0.5, 1, '<rect class="tb-picked" x="192" y="58" width="48" height="34" rx="7"/>'),
      draw.during(
        0,
        0.6,
        draw.moved(
          0.1,
          0.5,
          { dx: 26, dy: 22, scale: 0.3, cx: 190, cy: 54 },
          `${draw.bookPage(16, 8, 174, 134)}<path class="tb-ear" d="M174 8h16v16z"/>`,
        ),
      ),
      draw.finger('M184 16c10 20 20 40 38 60', 0.1, 0.5),
    ),
  },
  {
    part: 'Controls',
    title: 'Drag a page onto a call to show it',
    words:
      'On a call, drag a page by its corner, a picture on a page picked with Select, or a picture from your desktop, onto the agent’s call window. Click the call first and a paste goes to the call, not the book.',
    from: 'platform/hq/shell/calldrop.js',
    scene: draw.scene(
      draw.hqPage(8, 10, 110, 130),
      `<rect class="tb-slip" x="24" y="34" width="76" height="70" rx="4"/>${draw.face(62, 62, 14)}`,
      draw.during(
        0,
        0.62,
        draw.moved(
          0.12,
          0.55,
          { dx: -120, dy: 30, scale: 0.3, cx: 190, cy: 40 },
          `${draw.bookPage(130, 8, 104, 134)}<path class="tb-ear" d="M218 8h16v16z"/>`,
        ),
      ),
      draw.finger('M226 16c-40 10-100 30-160 50', 0.12, 0.55),
    ),
  },
  {
    part: 'Controls',
    title: `Press ${MOD}+Z to undo`,
    words: `${MOD}+Z takes a step back and ${MOD}+Shift+Z puts it back. On HQ, tap two fingers together. Nothing asks “are you sure?”: everything undoes.`,
    from: 'platform/hq/shell/ink/bookedit.js, shared/review/pentouch.js',
    scene: draw.scene(
      draw.bookPage(20, 8, 200, 92),
      draw.during(0, 0.3, draw.note(70, 36)),
      draw.during(0.5, 1, draw.note(70, 36)),
      draw.key(52, 112, MOD, 0.4, 34),
      draw.key(90, 112, 'Z', 0.44),
    ),
  },
  {
    part: 'Controls',
    title: 'Close or widen the book by its edge',
    words:
      'Tap or pull the tab on the book’s edge to close it or bring it back. Drag the cover’s edge to make it wider: far enough and it lies over HQ.',
    from: 'platform/hq/shell/ink/book.js, platform/hq/shell/ink/bookswing.js',
    scene: draw.scene(
      draw.hqPage(8, 10, 160, 130),
      draw.moved(0.18, 0.46, { dx: 60 }, draw.bookEdge(172, 6, 64, 138)),
      draw.during(0.46, 1, '<rect class="tb-tab" x="232" y="64" width="8" height="22" rx="2"/>'),
      draw.tap(186, 75, 0.14),
    ),
  },
  {
    part: 'Controls',
    title: 'Press a letter to pick a tool',
    words:
      'With the pointer over the book: V selects, P is the pen, M the highlighter, E the eraser, S shapes, T type, H moves the page. 1 to 4 pick a colour, [ and ] the width.',
    from: 'platform/hq/shell/ink/bookpalette.js',
    scene: draw.scene(
      draw.bookPage(20, 8, 200, 92),
      ...['V', 'P', 'M', 'E', 'T'].map((k, i) => draw.key(30 + i * 38, 112, k, 0.1 + i * 0.12)),
    ),
  },
  {
    part: 'Controls',
    title: 'Search what you wrote and said',
    words:
      'Search, at the top of the grid of pages, reads your handwriting and what you said as you wrote, across all your notebooks. Write in it with the Pencil, or type.',
    from: 'platform/hq/shell/ink/booksearch.js',
    scene: draw.scene(
      '<rect class="tb-slip" x="20" y="14" width="200" height="28" rx="14"/>',
      draw.written('M36 30c6-8 10 8 16 0s10 8 16 0 10 8 16 0', 0.08, 0.4),
      draw.during(0.5, 1, [0, 1, 2].map(i => draw.bookPage(18 + i * 72, 60, 60, 40)).join('')),
      draw.during(0.6, 1, '<rect class="tb-picked" x="96" y="74" width="40" height="10" rx="2"/>'),
    ),
  },
];
