// What someone can feel, shown over their head in every look
import { clamp } from '../util.js';

// A glyph that also comes as a colour emoji carries U+FE0E, so every device draws it as plain type, never an emoji
export const EMOTES = {
  love: { means: 'fond of someone', glyph: '♥\uFE0E', color: '#e8505b' },
  happy: { means: 'pleased: a job well done', glyph: '☺\uFE0E', color: '#f2a33a' },
  celebrate: { means: 'something shipped', glyph: '★', color: '#f2c14e' },
  idea: { means: 'struck by an idea', glyph: '!', color: '#f0b547' },
  question: { means: 'puzzled', glyph: '?', color: '#5b8def' },
  thinking: { means: 'mulling it over', glyph: '…', color: '#8b8fa3' },
  sleepy: { means: 'tired', glyph: 'z', color: '#9b8fc4' },
};
export const EMOTE_S = 4; // how long an emote shows unless its sender says otherwise
const FADE_IN_S = 0.25,
  FADE_OUT_S = 0.6;

// How much of an emote ({ kind, s, left }, or none) shows now, 0..1: it fades in, holds, and fades out as it ends.
export const fade = e => (e ? clamp(Math.min((e.s - e.left) / FADE_IN_S, e.left / FADE_OUT_S), 0, 1) : 0);
