// HQ's extra files: those outside platform/hq that its pages load by their address, each with its file in the repo. Both
// servers answer them from here: serve.mjs, and the coordinator (server.ts, and feedback.ts for review mode's parts).
// An address ending in / is a folder, its files named [a-z]+.js. The coordinator's extras.test.ts walks HQ's imports and
// the pages they open, and fails on one it doesn't answer for the board.

// The board's, behind its session
export const BOARD_EXTRAS = {
  '/foley.js': 'shared/demo/foley.js', // the platform's sound kit
  '/ask.js': 'shared/ask/ask.js', // the button that asks once more
  '/contrast.js': 'shared/contrast/contrast.js', // the contrast sums, as HQ's looks import them
  '/shared/contrast/contrast.js': 'shared/contrast/contrast.js', // ...and as the signs import them
  '/shared/signs/signs.js': 'shared/signs/signs.js',
  // the keys' motion, and the statistics' drawing, which Slate shares with the brand guide
  '/shared/tactile/': 'shared/tactile/',
  '/shared/stats/': 'shared/stats/',
  '/shared/holidays/holidays.js': 'shared/holidays/holidays.js', // the clock's
  '/shared/format/format.js': 'shared/format/format.js',
  '/shared/qr/qr.js': 'shared/qr/qr.js', // the QR a second screen pairs by
  // a call's recording played back (its replayer's own page: server.ts REPLAY_CSP)
  '/shared/watchalong/player.js': 'shared/watchalong/player.js',
  '/shared/watchalong/scrubber.js': 'shared/watchalong/scrubber.js',
  '/shared/watchalong/replay.html': 'shared/watchalong/replay.html',
  '/shared/watchalong/replay.js': 'shared/watchalong/replay.js',
};

// Anyone's on HQ's host: a call's join link records its walk-through with the watch-along too
export const OPEN_EXTRAS = {
  '/shared/watchalong/watchalong.js': 'shared/watchalong/watchalong.js',
  '/shared/watchalong/canvas.js': 'shared/watchalong/canvas.js',
  '/shared/watchalong/encoder.js': 'shared/watchalong/encoder.js', // (its encoder, a worker)
  '/shared/watchalong/strokes.js': 'shared/watchalong/strokes.js',
};

// Review mode's parts anyone may load, on HQ's host and every product's: pure geometry and drawing, no review mode's own
// logic (the framing rule HQ's note thumbnails share, the pen the Sketchbook draws with and its tap, the anchor, the
// book's paper). Its other parts in shared/review/ go only to whoever gets the tool (feedback.ts).
export const REVIEW_PARTS = {
  '/__review/frame.js': 'shared/review/frame.js',
  '/__review/ink.js': 'shared/review/ink.js',
  // (its live line and the stroke's shapes)
  '/__review/inklive.js': 'shared/review/inklive.js',
  '/__review/inkshape.js': 'shared/review/inkshape.js',
  '/__review/anchor.js': 'shared/review/anchor.js',
  '/__review/paper.js': 'shared/review/paper.js',
  '/__review/tap.js': 'shared/review/tap.js',
  // (whether the microphone is allowed, which HQ's voice.js shares with review mode)
  '/__review/micallowed.js': 'shared/review/micallowed.js',
};

// The file in the repo an address names in one of the tables above, or undefined
export function extraFile(table, address) {
  const folder = address.slice(0, address.lastIndexOf('/') + 1),
    name = address.slice(folder.length);
  if (Object.hasOwn(table, address)) return table[address];
  return Object.hasOwn(table, folder) && /^[a-z]+\.js$/.test(name) ? table[folder] + name : undefined;
}
