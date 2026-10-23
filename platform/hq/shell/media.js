// What a card shows beside its words: pictures, clips, a presentation, and before-and-after pairs, found in its text.
// The coordinator runs this on agents' text in its one event loop: every pattern here stays linear, whatever the input.
import { fencedLines } from './prose.js';

// Pictures a card refers to (products/_cycles/…, or the cycles preview host's same files: shown from /cycles/, on HQ's
// own origin) and clips (a venture cycle's presentation, an ad: played from /cycles/). A path is at most 300 characters
// (ours are about 100): unbounded, a line of /cycles/ over and over would be read again from every one of them.
export const PIC =
  /(?:products\/_cycles\/|\/cycles\/|https:\/\/cycles\.preview\.[a-z0-9.-]{1,300}\/)[\w\-./]{1,300}\.(?:png|jpe?g|webp|gif)\b/g;
// A picture's file under products/_cycles/, and where the desk phone shows it from (main, at /cycles/)
export const pictureFile = p =>
  p.replace(/^(?:products\/_cycles\/|\/cycles\/|https:\/\/cycles\.preview\.[a-z0-9.-]+\/)/, '');
export const pictureSrc = p => `/cycles/${pictureFile(p)}`;
export const CLIP = /(?:products\/_cycles\/|\/cycles\/)[\w\-./]{1,300}\.(?:mp4|webm)/g;

// A card's before-and-after pairs, and its text without them: a line "Before and after:", then one bullet per change,
// "- What changed: <before picture> <after picture> <its live link>" (the link optional). The list ends at its first
// blank line, or at a line that is no bullet.
export function pairsOf(body) {
  const pairs = [],
    rest = [];
  let listing = false;
  for (const { line, fence, fenced } of fencedLines(body)) {
    const l = line.trim();
    if (!fence && !fenced && PAIRS.test(l)) listing = true;
    else if (listing && !fence && !fenced && /^[-*•]\s/.test(l)) pairs.push(pairOf(l.slice(1).trim()));
    else if (listing && !l && !pairs.length) continue;
    else {
      listing = false;
      rest.push(line);
    }
  }
  return { pairs, rest: rest.join('\n') };
}
const PAIRS = /^before and after:$/i;
// (pictures: how many the line names, two in a good one)
function pairOf(s) {
  const named = s.match(PIC) ?? [],
    at = s.search(PIC),
    link = s.replace(PIC, ' ').match(/https?:\/\/[^\s<>"]+[^\s<>".,)]/)?.[0] ?? '';
  const label = (at < 0 ? s : s.slice(0, at)).replace(/[\s:–—-]+$/, '').trim();
  return { label, before: named[0] ?? '', after: named[1] ?? '', link, pictures: named.length };
}

// A presentation on the cycles preview host (a link there that isn't a picture or a clip), without the brackets of a
// Markdown link around it
export const deckOf = body =>
  (body || '')
    .match(/https:\/\/cycles\.preview\.[^\s<>"()[\]]+/g)
    ?.find(u => !/\.(?:png|jpe?g|webp|gif|mp4|webm)$/i.test(u));
