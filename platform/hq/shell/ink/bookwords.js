// Words that land on a page from outside (pasted, dropped, heard), made tidy and cut into boxes the store keeps. No
// DOM, so node tests it (bookwords.test.js); booktexts.js puts them on the page.
import { TEXT_MAX } from './notebookparts.js';

// Words as they read on paper: one kind of line break, no stray spaces or invisible characters, a blank line at most
// between paragraphs, indents kept
export function tidy(words) {
  return words
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(/[\u200b-\u200d\ufeff\u00ad]/g, '')
    .replace(/[\u00a0\t]/g, ' ')
    .split('\n')
    .map(line => line.replace(/(\S) {2,}/g, '$1 ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\s+$/g, '');
}

// Words cut into boxes of at most max characters: whole paragraphs together where they fit, a paragraph too long for
// one box cut after a sentence, else a line, else a word
export function boxesOf(words, max = TEXT_MAX) {
  const boxes = [];
  let box = '';
  for (const paragraph of words.split(/\n{2,}/)) {
    if (box && box.length + 2 + paragraph.length <= max) {
      box += `\n\n${paragraph}`;
      continue;
    }
    if (box) boxes.push(box);
    box = paragraph;
    while (box.length > max) {
      const cut = cutAt(box, max);
      boxes.push(box.slice(0, cut).trimEnd());
      box = box.slice(cut).trimStart();
    }
  }
  if (box) boxes.push(box);
  return boxes;
}
// Where a too-long paragraph is cut: after its last sentence, line or word that fits in max, else at max
function cutAt(paragraph, max) {
  const head = paragraph.slice(0, max + 1);
  for (const end of [/[.!?…][)"'’”]*\s/g, /\n/g, /\s/g]) {
    const ends = [...head.matchAll(end)].map(m => m.index + m[0].length - 1);
    const last = ends.findLast(i => i > 0 && i <= max);
    if (last > max / 2) return last;
  }
  return max;
}

// How far a box ({ x0, y0, x1, y1 }, page px) must move down to clear the boxes already on a page, at least gap from
// each: 0 when it covers none
export function downToClear(box, others, gap) {
  let dy = 0;
  for (let moved = true; moved;) {
    moved = false;
    for (const o of others)
      if (box.x0 < o.x1 && o.x0 < box.x1 && box.y0 + dy < o.y1 + gap && o.y0 < box.y1 + dy + gap) {
        dy = o.y1 + gap - box.y0;
        moved = true;
      }
  }
  return dy;
}
