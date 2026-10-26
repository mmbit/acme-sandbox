// What's wrong with a request card before the coordinator files it: how the desk phone would read it, and what to fix.
// The coordinator runs this on agents' text in its one event loop: every pattern here stays linear, whatever the input.
import { FENCE, ITEM } from './prose.js';
import { CLIP, deckOf, pairsOf } from './media.js';
import { parseCard, partsOf, shownText, unfenced, overflowOf, instructionIn, listIn, WEB } from './card.js';

// The board taps one choice: more than this many is a list that ran on, or a decision to split.
const MAX_CHOICES = 6;

// A card is short: anything longer is refused before it's read
export const MAX_CARD = 20_000;

// What a card holds, so it reads on a tablet. Set from the cards the board has had: a good card is within every one.
// Words are counted outside fenced blocks, a `value` as one.
export const MAX_STEPS = 8;
export const MAX_STEP_WORDS = 35;
export const MAX_STEP_PARAGRAPH_WORDS = 25; // a paragraph in a step past its first line: text to paste, as a rule
export const MAX_INTRO_WORDS = 50; // the opening paragraph of a card with steps
export const MAX_CARD_WORDS = 250; // all of it but the details under ---
export const MAX_DETAILS_WORDS = 80;

// Why a card would read wrong on the desk phone, with what it would show and how to fix it, or null when it's fine.
// back: the card brings a product back for the board's feedback (--back), which asks its own judgment: it offers no
// answers of its own and recommends nothing
export function cardProblem(body, back = false) {
  if (body.trim() === '')
    return 'the card has no text: the desk phone would show only its title. Write it in the body file';
  if (body.length > MAX_CARD) return `the card is ${body.length} characters long: a card holds at most ${MAX_CARD}`;
  const { pairs, rest } = pairsOf(body),
    text = shownText(rest),
    c = parseCard(text),
    { choices, recommend } = c;
  const pairProblem = pairsProblem(pairs, rest, back);
  if (pairProblem) return pairProblem;
  if (back && c.steps.length)
    return (
      "a card that brings work back carries its pictures and HQ's two answers, nothing for the board to do: leave out " +
      'its Steps: list, and put what the board must do on a card of its own'
    );
  if (back && (recommend || choices.length || c.options.length))
    return (
      "a card that brings work back asks for the board's own judgment, and HQ gives it its two answers, Good now and " +
      'notes on the preview in review mode: leave out its Choose: list, Options: and Recommend: lines'
    );
  if (recommend && !choices.length && !c.options.length)
    return (
      `the card recommends ${opening(recommend)} ` +
      'but offers nothing to choose: a recommendation goes with options (Choose: or Options:), next to them. Drop the Recommend: line, ' +
      'and say what to do in the steps'
    );
  if (choices.length && c.options.length)
    return (
      'the card offers its answers twice, as a Choose: list and an Options: line: the desk phone shows the choices as ' +
      'rows to tap. Drop the Options: line, and make any answer it adds a choice of its own'
    );
  const shown = choices.map(ch => `"${ch.label.length > 60 ? `${ch.label.slice(0, 57)}...` : ch.label}"`).join(', ');
  const how = `A choice is one bullet under Choose:, "- Label: what it means", and the list ends at its first blank line`;
  if (choices.length > MAX_CHOICES)
    return `the desk phone would show ${choices.length} choices to tap: ${shown}. A card offers at most ${MAX_CHOICES}. ${how}`;
  if (choices.some(ch => !ch.label)) return `the desk phone would show a choice without a label: ${shown}. ${how}`;
  return lengthProblem(c, partsOf(text)[0]) ?? (pairs.length ? null : hiddenProblem(c, back));
}

// Why a card's before-and-after pairs would show wrong, or null. A card that brings work back for the board's look
// leads with them: the board looks and answers, it doesn't read. A film, a sound or a presentation is its clip or its
// link instead, and a change with nothing to see says so.
function pairsProblem(pairs, rest, back) {
  const how =
    'Each change is one bullet under "Before and after:", "- What changed: <before picture> <after picture> <its live link>", ' +
    'its pictures under products/_cycles/';
  for (const p of pairs) {
    if (p.pictures !== 2)
      return `the before-and-after line ${opening(p.label || p.link || 'with no words')} names ${p.pictures === 1 ? 'one picture' : `${p.pictures} pictures`}, and a change takes two, the one before first. ${how}`;
    if (!p.label) return `a before-and-after line has no words before its pictures: say in a few what changed. ${how}`;
    if (p.before === p.after)
      return `the before-and-after line ${opening(p.label)} shows the same picture twice: before is the thing as it was. ${how}`;
  }
  const text = unfenced(rest),
    shown = pairs.length || text.match(CLIP) || deckOf(text) || NOTHING_TO_SEE.test(text);
  if (back && !shown)
    return (
      "a card that brings work back for the board's look (good now, or more changes?) leads with a picture of each change, " +
      `as it was and as it is now, and its text folds under More. ${how}. A film or a sound goes in as its clip, a ` +
      'presentation as its link, and a change with nothing to see says so on a line "No pictures: why"'
    );
  return null;
}
const NOTHING_TO_SEE = /^[ \t]*no pictures:[ \t]*\S/im;

// Why a card is too long to take in on a tablet, or null
function lengthProblem(c, main) {
  if (main.split('\n').filter(l => FENCE.test(l.trim())).length % 2)
    return (
      "a fenced block isn't closed: the desk phone would show " +
      'the rest of the card as text to paste. End the block with a line of ```'
    );
  const paste =
    'Text to paste goes in a fenced block (a line of ``` above and below it), where it gets a Copy button and takes a few lines';
  if (c.steps.length > MAX_STEPS)
    return (
      `the card has ${c.steps.length} steps: a card holds at most ${MAX_STEPS}, one action each. ` +
      'Join steps that are one action, or split the work over two cards'
    );
  for (const [i, step] of c.steps.entries()) {
    const paragraph = paragraphsOf(step)
      .slice(1)
      .find(p => wordsIn(p) > MAX_STEP_PARAGRAPH_WORDS);
    if (paragraph)
      return (
        `step ${i + 1} holds a paragraph of ${wordsIn(paragraph)} words (${opening(paragraph)}). ${paste}, ` +
        `under the step. A step's own words are one action, and the why goes under ---`
      );
    if (wordsIn(step) > MAX_STEP_WORDS)
      return (
        `step ${i + 1} runs to ${wordsIn(step)} words (${opening(step)}): a step is one action ` +
        `in at most ${MAX_STEP_WORDS} words. Split it, move the why under ---, and put text to paste in a fenced block (a line of \`\`\` above and below it)`
      );
  }
  const intro = paragraphsOf(c.summary[0]);
  if (c.steps.length && intro.length && wordsIn(intro[0]) > MAX_INTRO_WORDS)
    return (
      `the card opens with ${wordsIn(intro[0])} words ` +
      `(${opening(intro[0])}): a card with steps says what and why in at most ${MAX_INTRO_WORDS} words, and its steps say how, once`
    );
  if (
    c.steps.length &&
    unfenced(c.summary[0])
      .split('\n')
      .some(l => ITEM.test(l))
  )
    return (
      'the text above the steps has a list of its ' +
      'own: the steps say how, once. Make each action a step, and put anything else under ---'
    );
  const words = wordsIn(main);
  if (words > MAX_CARD_WORDS)
    return (
      `the card runs to ${words} words before its ---: a card holds at most ${MAX_CARD_WORDS}, ` +
      `so its first screen is the ask, the choices and the steps. Cut what repeats, move background under ---. ${paste}`
    );
  const details = wordsIn(`${c.details}\n${c.later}`);
  if (details > MAX_DETAILS_WORDS)
    return (
      `the details under --- run to ${details} words: they hold at most ${MAX_DETAILS_WORDS}, ` +
      "only what the board might want before it answers. The rest stays in the job's own notes"
    );
  return null;
}

// Why a card would hide what the board does under More, or null: a numbered list or a web address (instructionIn) in
// text past its first screen, or any list or link in the details. Only a card with steps has a Later: part (how to stop
// or undo it later), and there it's detail. A card that brings work back has no steps: it keeps them above its ---.
function hiddenProblem(c, back) {
  const what = l =>
      `${WEB.test(l) ? 'a link' : /^\s*\d/.test(l) ? 'a numbered list' : 'a list'} (${opening(l.trim())})`,
    step = back
      ? 'A card that brings work back keeps it above the ---, on a line of its own.'
      : 'What the board does is a step, under Steps:, with its link in it.';
  const folding = overflowOf(c).map(instructionIn).find(Boolean);
  if (folding)
    return (
      `the card's text runs past its first screen, and the part the desk phone would fold under More holds ${what(folding)}. ` +
      `${step} Keep the text above it short, and move background under ---`
    );
  if (c.later && !c.steps.length)
    return (
      'the card has a Later: part but no steps: Later: says how to stop or undo what the steps set up. ' +
      `${step} Background goes under --- without it`
    );
  const detail = instructionIn(c.details) ?? listIn(c.details);
  if (detail)
    return (
      `the details under --- hold ${what(detail)}: the desk phone folds them under More, where the board won't look. ${step} ` +
      'Under --- goes background in a sentence or two (figures in a table), and on a card with steps, how to stop or undo ' +
      'it later, after a line "Later:" of its own at the end'
    );
  return null;
}

// Words as the board reads them: outside fenced blocks, a `value` (one tap to copy) as one
const wordsIn = text =>
  unfenced(text)
    .replace(/`[^`\n]*`/g, ' x ')
    .split(/\s+/)
    .filter(w => /[\p{L}\p{N}]/u.test(w)).length;
// The text's paragraphs, outside fenced blocks and lists, in order
const paragraphsOf = text => {
  const paragraphs = [];
  let open = false;
  for (const l of unfenced(text).split('\n')) {
    if (!l.trim() || ITEM.test(l)) {
      open = false;
      continue;
    }
    if (open) paragraphs.push(`${paragraphs.pop()} ${l.trim()}`);
    else paragraphs.push(l.trim());
    open = true;
  }
  return paragraphs;
};
const opening = text => `"${text.length > 50 ? `${text.slice(0, 47).trimEnd()}..."` : `${text}"`}`;
