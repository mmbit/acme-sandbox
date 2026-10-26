// A request card as the desk phone reads it (cardcheck.js says what's wrong with one before the coordinator files it).
// The coordinator runs this on agents' text in its one event loop: every pattern here stays linear, whatever the input.
import { FENCE, ITEM, fencedLines, tableParts, linked, bare } from './prose.js';
import { PIC, CLIP, deckOf, pairsOf } from './media.js';

// The card the phone shows: a line that only names a clip becomes that clip's title in the row below, so it leaves the
// text (and so does a line that only names a picture). Long text folds under More. A card with before-and-after pairs
// leads with them, and all its text folds under More.
export const cardOf = body => {
  const { pairs, rest } = pairsOf(body),
    c = parseCard(shownText(rest));
  return pairs.length ? { ...pictured(c), pairs } : { ...folded(c), pairs };
};
const media = (l, re) =>
  !l.match(re) ||
  l
    .replace(re, '')
    .replace(/https?:\/\/\S+/g, '')
    .trim().length > 60;
// A Markdown link: its words and its address (prose.js shows it as a link)
const MD_LINK = /\[([^\][\n]*)\]\(([^\s()]+)\)/g;
// The presentation's address shows once, as HQ's button: a line that only gives
// it (alone or after a label, "Presentation:") leaves the text; anywhere else it's "the presentation above", and a
// Markdown link to it its words.
export const shownText = body => {
  const deck = deckOf(body),
    toDeck = (l, words) => l.replace(MD_LINK, (link, text, url) => (url === deck ? words(text) : link)),
    unlinked = l => (deck ? toDeck(l, text => text).replaceAll(deck, 'the presentation above') : l),
    // (what's on the line besides the address: nothing, or a label that only names it, "Presentation:", and a list's bullet)
    alone = l => {
      if (!deck || !l.includes(deck)) return false;
      const rest = toDeck(l, () => '')
        .replaceAll(deck, '')
        .replace(/\*\*/g, '')
        .replace(/^\s*[-*]\s+/, '')
        .trim();
      return (
        rest === '' || /^(?:the |our )?(?:presentation|deck|slides?|link|preview|address)\b[^.!?:]{0,20}:$/i.test(rest)
      );
    };
  return fencedLines(body)
    .filter(({ line, fence, fenced }) => fence || fenced || (media(line, CLIP) && media(line, PIC) && !alone(line)))
    .map(({ line, fence, fenced }) =>
      fence || fenced ? line : unlinked(line.replace(CLIP, 'the clip below').replace(PIC, 'the picture below')),
    )
    .join('\n');
};

const pictured = c => ({
  ...c,
  summary: [''],
  after: '',
  afterSteps: '',
  details: [c.summary[0], c.after, c.afterSteps, c.details].filter(Boolean).join('\n\n'),
});

// Agents write a request as a short card (company/playbooks/board-requests.md): a line or two on what and why,
// then optionally "Options: A | B" (tap to answer) or "Choose:" (a list of choices, one bullet each), never both (cardcheck.js
// refuses that), "Recommend:" (only with either),
// "Steps:" (a numbered list: a checklist, with a copy button for every `value`), "Claude: yes" (a web task Claude in
// Chrome can do with the board), and after a line of --- the details, folded away, ending in "Later:" (how to stop or
// undo it later, laterOf) on a card with steps. A fenced block (``` lines) is text to paste, kept exactly. A step goes on
// with its wrapped lines, a list and a fenced block, and the steps end at an empty line followed by anything else, which
// shows below them.
export function parseCard(body) {
  const [main, rest] = partsOf(body),
    [details, later] = laterOf(rest);
  const c = {
    summary: [],
    steps: [],
    options: [],
    choices: [],
    after: '',
    afterSteps: '',
    recommend: '',
    claude: false,
    details,
    later,
  };
  const after = [],
    afterSteps = [],
    steps = []; // the text after the choices and after the steps; each step's lines
  let inSteps = false,
    inChoices = false,
    gap = false,
    fence = null,
    stepIndent = 0; // (fence: where a fenced block's lines go)
  for (const raw of main.split('\n')) {
    const l = raw.trim(),
      indent = raw.search(/\S/);
    let m;
    if (fence) {
      fence.push(raw);
      if (FENCE.test(l)) fence = null;
      continue;
    }
    // A step list ends at an empty line followed by a line that is no step, no further in and no fenced block
    if (inSteps && steps.length && gap && l && indent <= stepIndent && !STEP.test(l) && !FENCE.test(l)) inSteps = false;
    gap = !l;
    const step = inSteps ? steps.at(-1) : undefined;
    const into = step ?? (steps.length ? afterSteps : c.choices.length ? after : c.summary);
    // A choice list is one list: the first blank line after a choice ends it, and what follows is the card's text again
    if (!l && inChoices && c.choices.length) inChoices = false;
    if (!l) {
      if (step || (!inSteps && !inChoices)) into.push('');
      continue;
    }
    if (FENCE.test(l)) (fence = into).push(raw);
    else if ((m = l.match(/^recommend(?:ation|ed)?:\s*(.+)/i))) c.recommend = m[1];
    else if ((m = l.match(/^options?:\s*(.+)/i)))
      c.options = m[1]
        .split('|')
        .map(s => s.trim())
        .filter(Boolean);
    else if (/^claude:\s*yes\b/i.test(l)) c.claude = true;
    else if (/^steps?:$/i.test(l)) {
      inSteps = true;
      inChoices = false;
    } else if (/^(choose|choices|options?):$/i.test(l)) {
      inChoices = true;
      inSteps = false;
    } else if (inChoices && (m = choiceOf(l))) {
      const label = m[0].replace(/ ?\((recommended|aanbevolen)\) ?/i, ' ').trim();
      c.choices.push({ label, desc: m[1], rec: /\(recommended|aanbevolen\)/i.test(m[0]) });
    } else if (inChoices && c.choices.length) c.choices[c.choices.length - 1].desc += ' ' + l;
    else if (inSteps && STEP.test(l) && (!step || indent <= stepIndent)) {
      if (!step) stepIndent = indent;
      // (its end kept: a break prose shows)
      steps.push([raw.trimStart().replace(/^\d+[.)]\s+/, '')]);
    } else if (step) step.push(raw);
    else into.push(raw.trimStart());
  }
  c.steps = steps.map(stepText);
  c.summary = [c.summary.join('\n').trim()];
  c.after = after.join('\n').trim();
  c.afterSteps = afterSteps.join('\n').trim();
  const rec = c.recommend.toLowerCase();
  for (const ch of c.choices) if (rec && rec.startsWith(ch.label.toLowerCase())) ch.rec = true;
  c.card = !!(c.steps.length || c.options.length || c.choices.length || c.recommend || c.claude || rest);
  return c;
}
const STEP = /^\d+[.)]\s+(.+)/;
const BREAK = /( {2}|\\)$/;

// The details and their part from a line "Later:" to the end: how to stop, undo or remove later what the steps set up
// (company/playbooks/board-requests.md), under More with a heading of its own
function laterOf(details) {
  const lines = fencedLines(details),
    at = lines.findIndex(({ line, fence, fenced }) => !fence && !fenced && /^later:$/i.test(line.trim())),
    text = part =>
      part
        .map(({ line }) => line)
        .join('\n')
        .trim();
  return at < 0 ? [details, ''] : [text(lines.slice(0, at)), text(lines.slice(at + 1))];
}

// The card's Recommend: line where the phone shows it: only beside options to tap or choices, and only when no choice
// is marked (recommended) instead. A card without them says what to do in its steps.
export const shownRecommend = c =>
  c.recommend && (c.options.length || c.choices.length) && !c.choices.some(ch => ch.rec) ? c.recommend : '';

// The card's own part and its details: split at a line of --- (not the first line, nor the last, nor in a fenced
// block), tested a line at a time
export function partsOf(body) {
  const parts = [[]];
  let fenced = false;
  body.split('\n').forEach((l, i, all) => {
    if (FENCE.test(l.trim())) fenced = !fenced;
    if (!fenced && i && i < all.length - 1 && /^-{3,}$/.test(l.trim())) parts.push([]);
    else parts.at(-1).push(l);
  });
  const [main, ...rest] = parts.map(p => p.join('\n').trim());
  return [main, rest.join('\n\n').trim()];
}

// A step's text from its lines: a wrapped line goes on with the line before it, and a list item, a table's row, a fenced
// block, a line after an empty one and one after a break (two spaces or a backslash at a line's end) each start a line
// of their own (prose shows them as a list, a table, a block, a paragraph and a break)
function stepText(lines) {
  const out = [];
  const tables = tableParts(lines);
  let fenced = false,
    joins = false; // (joins: the last line takes a wrapped line)
  for (const [i, raw] of lines.entries()) {
    const l = raw.trim(),
      fence = FENCE.test(l);
    const row = !!tables[i];
    if (joins && l && !fence && !fenced && !row && !ITEM.test(raw) && !BREAK.test(out.at(-1)))
      out.push(`${out.pop()} ${raw.trimStart()}`);
    else out.push(raw);
    if (fence) fenced = !fenced;
    joins = !!l && !fence && !fenced && !row;
  }
  return out.join('\n').trim();
}

// A choice line, "- Label: what it means" or "- Label - what it means" (or an en or em dash), as [label, desc]: its
// whitespace runs made one space, then the first divider found with indexOf (no backtracking over long runs)
function choiceOf(l) {
  if (!/^[-*•]\s/.test(l)) return null;
  const s = l.slice(1).replace(/\s+/g, ' ').trim();
  const at = [': ', ' - ', ' – ', ' — ']
    .map(d => [s.indexOf(d, 1), d.length])
    .filter(([i]) => i > 0)
    .sort((a, b) => a[0] - b[0])[0];
  return at ? [s.slice(0, at[0]), s.slice(at[0] + at[1]).trim()] : [s, ''];
}

// What the phone folds under More, ahead of the details, so its first screen is the ask, the choices and the steps: a
// request in plain prose past its opening, and a card's own text past FOLD_CHARS characters (its steps and choices
// always show). Text whose folded part would hold what the board does (instructionIn), a list or a table shows whole.
export const FOLD_CHARS = 600;
const PROSE_FOLD_CHARS = 320;
function folded(c) {
  const parts = foldsOf(c).map(([text, shown, rest]) => (rest && !keptShown(rest) ? [shown, rest] : [text, '']));
  const [[summary], [after], [afterSteps]] = parts;
  return {
    ...c,
    summary: [summary],
    after,
    afterSteps,
    details: [...parts.map(([, rest]) => rest), c.details].filter(Boolean).join('\n\n'),
  };
}
// The card's own text, each part as [text, its first screen, the rest] by its length alone
const foldsOf = c =>
  [
    [c.summary[0], c.card ? FOLD_CHARS : PROSE_FOLD_CHARS],
    [c.after, FOLD_CHARS],
    [c.afterSteps, FOLD_CHARS],
  ].map(([text, at]) => [text, ...foldAt(text, at)]);
// What would go past the first screen of a card's own text, part by part
export const overflowOf = c => foldsOf(c).flatMap(([, , rest]) => (rest ? [rest] : []));

// The first line that tells the board to do something, by the card's structure: a numbered list (a procedure) or a web
// address, outside fenced blocks. A step holds it, never text under More.
export const instructionIn = text =>
  unfenced(text)
    .split('\n')
    .find(l => NUMBERED.test(l) || WEB.test(l));
const NUMBERED = /^\s*\d+[.)]\s+\S/;
export const WEB = /https?:\/\/\S/;
// A list's first line, numbered or bulleted, outside fenced blocks
export const listIn = text =>
  unfenced(text)
    .split('\n')
    .find(l => ITEM.test(l));
const keptShown = text =>
  instructionIn(text) !== undefined || listIn(text) !== undefined || tableParts(text.split('\n')).some(Boolean);

// Text cut near `at` characters, at the last empty line (past the first 80 characters) or else the last sentence's end
// (past the first 200), never inside a fenced block or a table. A table's characters don't count: it's the card's
// content. Text with no such place shows whole.
function foldAt(text, at) {
  const tables = tableParts(text.split('\n'));
  let fenced = false,
    paragraph = -1,
    sentence = -1;
  for (let start = 0, i = 0; start <= at && start < text.length; i++) {
    const end = text.includes('\n', start) ? text.indexOf('\n', start) : text.length,
      line = text.slice(start, end);
    if (FENCE.test(line.trim())) fenced = !fenced;
    else if (tables[i]) at += line.length + 1;
    else if (!fenced && !line.trim() && start > 80) paragraph = start;
    else if (!fenced) {
      const dot = line.slice(0, at - start).lastIndexOf('. ');
      if (dot >= 0 && start + dot > 200) sentence = start + dot + 1;
    }
    start = end + 1;
  }
  if (text.length <= at) return [text, ''];
  const cut = paragraph > 0 ? paragraph : sentence;
  return cut > 0 ? [text.slice(0, cut).trim(), text.slice(cut).trim()] : [text, ''];
}

export const unfenced = text =>
  fencedLines(text)
    .map(({ line, fence, fenced }) => (fence || fenced ? '' : line))
    .join('\n');

// (documents)
// A document named by its file on a card (`board-requests.md`, company/AUTHORITY.md) opens in the board's Library: the
// desk phone links it (desk.js inline), in a card's every part but fenced blocks, a code span only when it's the whole
// name, and never inside a link's text or address, read as the phone shows the card (shownText: a link to the
// presentation keeps its words). Its Library document is the one at that path, else any with that file name (news.js).
// The coordinator refuses a card naming one no shelf shows at the folders it gives (library.ts unshelvedProblem).
export const DOC_CODE = /^[\w./-]+\.md$/;
// A text's words and the documents it names, apart: [words, document, words, …]. In a run of path characters, the
// document is the run up to its last `<name>.md` (the rest of the run stays words).
export function docParts(text) {
  const parts = [''];
  String(text)
    .split(PATH_RUN)
    .forEach((s, i) => {
      const doc = i % 2 ? s.match(UP_TO_DOC)?.[0] : null;
      if (doc) parts.push(doc, s.slice(doc.length));
      else parts[parts.length - 1] += s;
    });
  return parts;
}
const PATH_RUN = /([\w./-]+)/,
  UP_TO_DOC = /^.*[\w-]\.md(?!\w)/;
export const docsIn = text => {
  const found = [];
  const words = t => bare(t, w => (found.push(...docParts(w).filter((_, k) => k % 2)), ''));
  unfenced(shownText(String(text)))
    .split(/`([^`\n]+)`/)
    .forEach((p, i) => (i % 2 ? DOC_CODE.test(p) && found.push(p) : linked(p, words, () => '')));
  return found;
};
export const docOn = (shelves, name) =>
  shelves.find(x => x.path === name) ?? shelves.find(x => x.path.endsWith('/' + name.split('/').pop()));
