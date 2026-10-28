// What the tips book (booktips.js) shows: the book's hidden things, one tip a page, in four parts. Each tip says what
// the book does today, in a line or two, over a scene of it (booktipscene.js), and names the code it describes (from):
// a change to that behaviour changes its tip here in the same pull request, a new hidden thing adds one, and a thing
// taken out takes its tip with it. The tips book shows only what's built.
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
    title: 'Write on anything',
    words:
      'Draw on any page of HQ. Rest the pen a moment and your mark lifts into the book, with what you said as you drew.',
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
    title: 'No Pencil? Use the pin',
    words: 'With a mouse or a finger, tap the pin among the book’s controls, then draw on HQ the same way.',
    from: 'platform/hq/shell/pinsummon.js',
    scene: draw.scene(
      draw.hqPage(),
      draw.bookEdge(),
      `<g class="tb-pin" transform="translate(222 52) rotate(45)"><path d="M-3-9h6l-.8 5.5L5-1v2H-5v-2l2.8-2.5z"/><path d="M0 1v8"/></g>`,
      draw.tap(222, 54, 0.15),
      draw.during(0.22, 1, '<circle class="tb-pinned" cx="146" cy="128" r="8"/>'),
      draw.written('M40 98c20-8 50-8 70 0', 0.42, 0.66, { by: draw.mouse }),
    ),
  },
  {
    part: 'Writing',
    title: 'Type on a page',
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
    title: 'Paste a picture',
    words: `Copy a picture anywhere and paste it in the book (${MOD}+V): it lands taped on the page you’re on.`,
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
    part: 'Gestures',
    title: 'Ring what you mean',
    words: 'A ring round something on HQ marks just that thing, so your note knows what it’s about.',
    from: 'shared/review/gestures.js',
    scene: draw.scene(
      draw.hqPage(8, 10, 224, 130),
      draw.during(0.42, 1, '<rect class="tb-picked" x="18" y="64" width="204" height="30" rx="3"/>'),
      draw.written('M14 80c0-14 60-22 120-20s96 6 94 20-60 20-118 18-96-6-96-20c2-8 20-12 34-12', 0.08, 0.4),
    ),
  },
  {
    part: 'Gestures',
    title: 'Scribble a mark out',
    words: 'Changed your mind while drawing on HQ? Scribble over the mark before it settles, and it’s gone.',
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
    title: 'Move about the page',
    words: `Two fingers pan and pinch to zoom. With a mouse: hold Space and drag, or scroll. ${MOD} and scroll zooms.`,
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
    title: 'See all your pages',
    words:
      'Pinch out past a page to see the notebook’s pages side by side. Pinch out again for the Shelf of notebooks. Tap one to open it.',
    from: 'platform/hq/shell/ink/bookzoom.js, platform/hq/shell/ink/bookshelf.js',
    scene: draw.scene(
      draw.during(0, 0.42, draw.moved(0.1, 0.4, { scale: 0.3, cx: 120, cy: 75 }, draw.bookPage(20, 8, 200, 134))),
      draw.during(0.4, 1, [0, 1, 2].map(i => draw.bookPage(18 + i * 72, 44, 60, 40)).join('')),
      draw.finger('M140 60l30-20', 0.1, 0.4),
      draw.finger('M100 90l-30 20', 0.1, 0.4),
    ),
  },
  {
    part: 'Gestures',
    title: 'Pick things up',
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
    title: 'Answers hang under your writing',
    words:
      'An agent’s answer hangs under the writing it answers. Tick its box to say it’s done. Write under it to reply.',
    from: 'platform/hq/shell/ink/bookgroups.js',
    scene: draw.scene(
      draw.bookPage(),
      draw.ink('M44 40c10-14 30 10 44-4s20 8 30 0M48 56c14-6 40 4 60-2', 0, 0.01),
      draw.moved(
        0.08,
        0.3,
        { dy: 70 },
        `<g transform="translate(0 -70)"><rect class="tb-slip" x="52" y="66" width="140" height="54" rx="2"/><path class="tb-clip" d="M62 60v14a4 4 0 0 0 8 0V62"/><path class="tb-typed-line" d="M64 84h80M64 96h60"/><rect class="tb-box" x="150" y="98" width="16" height="16" rx="2"/></g>`,
      ),
      draw.written('M150 106l7 8 14-18', 0.44, 0.58),
    ),
  },
  {
    part: 'Controls',
    title: 'Share a page by its corner',
    words:
      'Drag the turned-down corner of a page onto PDF or PNG for a file of it, or onto Call to talk it over with the CEO. Tap the corner for the same three.',
    from: 'platform/hq/shell/ink/bookdogear.js, platform/hq/shell/ink/bookshare.js',
    scene: draw.scene(
      target(26, 'PDF'),
      target(62, 'PNG'),
      target(98, 'Call'),
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
      draw.finger('M184 16c10 20 20 40 32 60', 0.1, 0.5),
      draw.during(
        0.6,
        0.84,
        draw.moved(
          0.6,
          0.84,
          { dx: 14, dy: -2, scale: 0.4, cx: 208, cy: 76 },
          '<path class="tb-plane" d="M190 70l28 6-28 8 6-8z"/>',
        ),
      ),
    ),
  },
  {
    part: 'Controls',
    title: 'Undo anything',
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
    title: 'Fold the book away',
    words: 'Tap the book’s tab to fold it away or bring it back, or drag its spine. Drag it left to spread it wide.',
    from: 'platform/hq/shell/ink/book.js',
    scene: draw.scene(
      draw.hqPage(8, 10, 160, 130),
      draw.moved(0.18, 0.46, { dx: 60 }, draw.bookEdge(172, 6, 64, 138)),
      draw.during(0.46, 1, '<rect class="tb-tab" x="232" y="64" width="8" height="22" rx="2"/>'),
      draw.tap(186, 75, 0.14),
    ),
  },
];
