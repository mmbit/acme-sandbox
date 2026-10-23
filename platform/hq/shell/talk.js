// A live meeting's talk as speech bubbles: each turn put in a few plain lines by the coordinator's small model
// (meetinggist.ts), shown over its speaker one at a time, long enough to read. With time to spare a turn's lines follow
// each other, main one first. Once a newer turn has its lines, the room moves on to it, skipping any in between, so the
// bubbles keep to the latest point and never pile up.
import * as world from '../world/world.js';
import { bubble } from './overlay.js';

// A bubble stays up for the time to find it and read it: GLANCE_S, plus a reader's pace (about 200 words a minute, at a
// glance over a moving picture), and never less than LEAST_S.
const GLANCE_S = 1.5,
  WORD_S = 0.3,
  LEAST_S = 3;

let shown = null; // { turn, bubble, until }: the turn up now (a transcript line's id), which of its lines, until when (ms)
let timer = 0;

export function initTalk() {
  world.on('meetings', advance);
}

// Called when a turn's bubbles arrive and when a bubble's time is up: whatever comes next, or nothing yet.
function advance() {
  if (shown && Date.now() < shown.until) return;
  const turns = (world.meetings?.live ?? []).flatMap(m => m.said ?? []).filter(s => s.bubbles?.length),
    newest = turns.reduce((a, s) => (!a || s.id > a.id ? s : a), null);
  if (newest && (!shown || newest.id > shown.turn)) show(newest, 0);
  else if (shown) {
    const turn = turns.find(s => s.id === shown.turn);
    if (turn && shown.bubble + 1 < turn.bubbles.length) show(turn, shown.bubble + 1);
  }
}

function show(turn, bubbleIndex) {
  const text = turn.bubbles[bubbleIndex],
    seconds = Math.max(LEAST_S, GLANCE_S + WORD_S * text.split(/\s+/).length);
  bubble(turn.agent, text, '', seconds);
  shown = { turn: turn.id, bubble: bubbleIndex, until: Date.now() + seconds * 1000 };
  clearTimeout(timer);
  timer = setTimeout(advance, seconds * 1000);
}
