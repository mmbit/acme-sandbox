// What a product page's /__review/review.js brings for HQ's frame (feedback.ts), as the tests check it: review mode's
// script or its off marker, then the watch-along's answer (shared/watchalong/framed.js) with HQ's origin in it.
import { readFileSync } from 'node:fs';

const OFF = '/* review mode: off */\n';
const FRAMED = readFileSync(new URL('../../../shared/watchalong/framed.js', import.meta.url), 'utf8');

// The watch-along's answer to HQ's frame, HQ at origin hq (the tests' PUBLIC_HOST by default)
export const framedAnswer = (hq = 'https://hq.company.test') => FRAMED.replace('{{HQ_ORIGIN}}', hq);

// Review mode off: its marker, then only the watch-along's answer, nothing else
export const reviewModeOff = (js: string, hq?: string) => js === OFF + framedAnswer(hq);
