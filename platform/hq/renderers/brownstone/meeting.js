// The meeting room's board and door sign, drawn every frame from the meetings (world.js): the topic of each live meeting
// the room holds on the board, in turn, with a tag for each project whose plan it changed (lit for a minute after each
// change), and the next planned meetings running across the door sign: time, topic and who. While the meetings can't be
// read, the door sign says so. rooms.js builds the room (meetingRoom), sim.js seats its people.
import { canvas } from '../../util.js';
import { F, text, textW, upright } from './iso.js';
import { clockWhen } from '../../world/clock.js';

const INK = '#3b3355',
  TAG = '#bfe3ff',
  LIT = '#ffd966',
  AMBER = '#ffb35a',
  RED = '#e8505b',
  PIP = '#7dffb0', // the ledge's pip for the meeting on the board: a green none of its chips, words or markers use
  PIP_OFF = '#3fae6e', // the ledge's pip for each other meeting the room holds: a darker green, still clear on the ledge
  ROW = 8, // px from one row of the board's words to the next (a letter takes 5, and the wall's slant 1 more)
  TURN_S = 6, // s each live meeting's topic stays on the board when the room holds more than one
  LIT_MS = 60_000, // how long a project's tag stays lit after its plan changed
  TICK = 9; // px a second the door sign runs

export function drawMeeting(g, room, S, t) {
  const held = S.world.meetingsIn(room.src),
    k = ((t / TURN_S) | 0) % Math.max(1, held.length);
  if (held.length) drawBoard(g, room.art.anchors.board, held[k], k, held.length, t);
  drawDoor(g, room.art.anchors.door, S.world, t);
}

// the board: the topic and the projects' tags under it, every word upright on the wall's slant (upright), and on its
// ledge, while the room holds more than one meeting, a pip for each, the one on the board (turn k of n) lit
function drawBoard(g, board, m, k, n, t) {
  const now = Date.now(),
    tags = m.projects ? m.projects.map(p => ({ name: p.name, changed: Date.parse(p.changed) })) : [],
    lit = tags.map(p => now - p.changed < LIT_MS),
    blink = lit.some(Boolean) ? (t * 2) | 0 : 0,
    key = JSON.stringify([m.topic, tags.map(p => p.name), lit, blink % 2, k, n]);
  if (board.key !== key) {
    board.key = key;
    board.img = canvas(board.w, board.h);
    const f = board.img.getContext('2d'),
      letters = Math.floor((board.w + 1) / 4),
      rows = board.F.cols(...wallPlace(board), board.w, board.h).map(([, y]) => y);
    // the topic in two rows over the tags, in three when there are none
    const lines = wrap(m.topic, tags.length ? [letters, letters] : [letters, letters, letters]);
    lines.forEach((line, row) => upright(f, line, 0, row * ROW, INK, rows));
    let x = 0;
    for (const chip of tagRow(tags, lit, board.w)) {
      const w = textW(chip.s) + 2;
      F(f, x, 2 * ROW - 1, w, 8, chip.lit && blink % 2 === 0 ? LIT : TAG);
      if (chip.lit) F(f, x, 2 * ROW + 6, w, 1, RED);
      upright(f, chip.s, x + 1, 2 * ROW, INK, rows);
      x += w + 2;
    }
    board.pips = n > 1 ? canvas(board.w, 2) : null; // as wide as the words, so the pips start where they do
    for (const pip of board.pips ? turnPips(k, n) : []) F(board.pips.getContext('2d'), pip.x, 0, 2, 2, pip.c);
  }
  board.F.flat(g, board.img, ...wallPlace(board));
  if (board.pips) board.F.flat(g, board.pips, board.a0, board.a1, 0, board.ledge);
}
// the turn's pips on the ledge, 2 px square with 2 px of ledge between them so each reads apart at the shots' size:
// turn k of n lit
const turnPips = (k, n) => Array.from({ length: n }, (_, j) => ({ x: 4 * j, c: j === k ? PIP : PIP_OFF }));
// where the board's words go on its wall (rooms.js meetingWall)
const wallPlace = board => [board.a0, board.a1, 0, board.zb];

// the tags' chips in a row at most w px wide, in the order they come (the coordinator's: the oldest change first): the
// latest that fit and, when some don't, a first chip with how many earlier ones, lit when one of them is. The latest
// is always named: a board is wide enough for it and a count (rooms.js meetingWall)
function tagRow(tags, lit, w) {
  const chips = tags.map((p, k) => ({ s: plain(p.name).slice(0, 6), lit: lit[k] })).filter(chip => chip.s),
    more = k => ({ s: `+${chips.length - k}`, lit: chips.slice(0, chips.length - k).some(chip => chip.lit) }),
    row = k => (k < chips.length ? [more(k), ...chips.slice(chips.length - k)] : chips),
    width = cells => cells.reduce((x, chip) => x + textW(chip.s) + 4, -2);
  let k = chips.length;
  while (k > 1 && width(row(k)) > w) k--;
  return row(k);
}

// words on lines of at most widths[k] letters, a line for each width at most. Cut short, the last runs on into the
// words left and ends in '..'; a word longer than its line ends the words there, cut and ending in '..' too
function wrap(s, widths) {
  const lines = [];
  let words = plain(s).split(' ').filter(Boolean);
  while (words.length && lines.length < widths.length) {
    const n = widths[lines.length];
    if (words[0].length > n) return [...lines, `${words[0].slice(0, n - 2)}..`];
    let line = words.shift();
    while (words.length && line.length + 1 + words[0].length <= n) line += ` ${words.shift()}`;
    lines.push(line);
  }
  const last = lines.length - 1,
    rest = [lines[last], ...words].join(' ');
  if (words.length) lines[last] = `${rest.slice(0, widths[last] - 2).trimEnd()}..`;
  return lines;
}

// the door sign: the next meetings, running from right to left; dark without any, and in red while they can't be read
function drawDoor(g, door, world, t) {
  if (world.meetings === undefined) return;
  const at = p => clockWhen(Date.parse(p.at)),
    line = world.meetings
      ? world.meetings.planned
          .slice(0, 3)
          .map(p => `${at(p)} ${plain(p.topic)}: ${plain(names(world, p.seats))}`)
          .join('  ·  ')
      : 'NO SIGNAL FROM THE COORDINATOR';
  if (!line) return;
  if (door.line !== line) {
    door.line = line;
    door.strip = canvas(textW(line) + 24, 5);
    text(door.strip.getContext('2d'), line, 0, 0, world.meetings ? AMBER : RED);
    door.img ??= canvas(door.w, door.h);
  }
  const f = door.img.getContext('2d'),
    x = Math.round(door.w - ((t * TICK) % (door.strip.width + door.w)));
  F(f, 0, 0, door.w, door.h, '#141a2e');
  f.drawImage(door.strip, x, 4);
  door.F.flat(g, door.img, door.a0, door.a1, door.d, door.zb);
}

const names = (world, seats) => seats.map(id => world.agents.get(id)?.data.name ?? id).join(' ');

// what the pixel font has: accents dropped, any other mark a space
const plain = s =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 .!?:'/+&-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
