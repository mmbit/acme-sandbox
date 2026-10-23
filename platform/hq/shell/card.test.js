// node --test platform/hq/shell/card.test.js   (the desk phone's card reader, as plain functions; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCard, cardOf, shownRecommend, FOLD_CHARS, docsIn, docOn, docParts } from './card.js';
import { cardProblem, MAX_CARD } from './cardcheck.js';
import { pairsOf } from './media.js';
import { prose } from './prose.js';

// Three choices, then the card's own text, with lists of its own
const CARD = `Option A, option B, or both. Which first?

Choose:
- Option A (recommended): 100 a month, every product.
- Option B: two more people, about 6 hours a week.
- Both, smaller: 50 and one person.

The sums:
- Product one: 1,000 a month
- Product two: 500
Every Monday:
- a report

---
How we got the numbers.`;

test("a choice list ends at its first blank line: the bullets further down stay the card's text, below the choices", () => {
  const c = parseCard(CARD);
  assert.deepEqual(
    c.choices.map(ch => ch.label),
    ['Option A', 'Option B', 'Both, smaller'],
  );
  assert.equal(c.choices[0].rec, true);
  assert.equal(c.choices[2].desc, '50 and one person.');
  assert.equal(c.summary[0], 'Option A, option B, or both. Which first?');
  assert.equal(c.after, 'The sums:\n- Product one: 1,000 a month\n- Product two: 500\nEvery Monday:\n- a report');
  assert.equal(c.details, 'How we got the numbers.');
  assert.equal(cardProblem(CARD), null);
});

test('a choice wrapped over two lines is one choice, and a blank line before the first choice is fine', () => {
  const c = parseCard('Which box?\n\nChoose:\n\n- Small: fits a mug,\n  and the card.\n- Big - fits two.\n- Huge\n');
  assert.deepEqual(
    c.choices.map(ch => [ch.label, ch.desc]),
    [
      ['Small', 'fits a mug, and the card.'],
      ['Big', 'fits two.'],
      ['Huge', ''],
    ],
  );
  assert.equal(c.after, '');
});

test('details start after a line of ---, wherever it is between the first line and the last', () => {
  assert.deepEqual(
    ['Short.\n  ---  \nMore.\n---\nAnd more.', 'Short.\n\n\n----\n\nMore.\n---\nAnd more.'].map(
      b => parseCard(b).details,
    ),
    ['More.\n\nAnd more.', 'More.\n\nAnd more.'],
  );
  assert.equal(parseCard('---\nShort.').details, '');
  assert.equal(parseCard('Short.\n---').details, '');
});

test('filing refuses a card whose list would show more than six choices, or a choice without a label, and says what the phone would show', () => {
  // one list with no blank line to end it: a card's sums written as more bullets
  const runOn =
    'Which first?\n\nChoose:\n' +
    [
      'Option A: 100',
      'Option B: two people',
      'Both: smaller',
      'Product one: 1,000',
      'Product two: 500',
      'Product three: 300',
      'Every Monday: a report',
      'Starts: 12 October',
    ]
      .map(l => `- ${l}`)
      .join('\n');
  assert.match(cardProblem(runOn), /"Option A".*"Starts"/);
  assert.ok(cardProblem('Which?\n\nChoose:\n- (recommended): the first one\n- Other: the second'));
  assert.equal(cardProblem('Ready to launch?\n\nOptions: Yes | Not yet'), null);
});

test("a card that brings a product back (--back) recommends nothing: the board's own judgment is asked", () => {
  const rec = 'Back?\n\nNo pictures: a sound.\n\nChoose:\n- Good now (recommended): ship it\n- More changes: say what';
  assert.match(cardProblem(rec, true), /HQ gives it its two answers/);
  assert.match(
    cardProblem('Back?\n\nNo pictures: a sound.\n\nRecommend: good now\nOptions: Good now | More changes', true),
    /HQ gives it its two answers/,
  );
  assert.equal(cardProblem('Back?\n\nNo pictures: a sound.', true), null);
  assert.equal(cardProblem(rec), null); // any other card may recommend, when there's a view behind it
});

test('a recommendation goes with options: a card with none is refused, and the phone shows no box for it', () => {
  const steps =
    'Check the provider account.\n\nRecommend: leave the consent off if it is off already\n\nSteps:\n1. Open the account.\n2. Leave the consent off.';
  assert.match(cardProblem(steps), /offers nothing to choose.*Drop the Recommend: line/);
  assert.match(cardProblem('Send it on?\nRecommendation: send it'), /recommends "send it"/);
  assert.equal(cardProblem(steps.replace(/Recommend: .*\n\n/, '')), null);
  assert.equal(shownRecommend(parseCard(steps)), '');
  // beside options to tap, or choices none of which is marked, it shows; a marked choice shows it instead
  for (const body of [
    'Launch?\n\nRecommend: yes\nOptions: Yes | Not yet',
    'Which?\n\nRecommend: the first\n\nChoose:\n- One: a\n- Two: b',
  ]) {
    assert.equal(cardProblem(body), null);
    assert.ok(shownRecommend(parseCard(body)));
  }
  const marked = parseCard('Which?\n\nRecommend: One\n\nChoose:\n- One: a\n- Two: b');
  assert.equal(shownRecommend(marked), '');
  assert.ok(marked.choices[0].rec);
});

test('the check counts what the phone shows: a line that only names a picture is no choice', () => {
  const six = Array.from({ length: 6 }, (_, i) => `- Choice ${i + 1}: the ${i + 1}th`).join('\n');
  assert.equal(cardProblem(`Which?\n\nChoose:\n${six}\n- products/_cycles/x/one.png\n`), null);
});

test('a long run of newlines, spaces or dashes reads in linear time, and a card over the cap is refused unread', () => {
  // CPU time, not the clock: the suites run side by side on shared cores
  const n = MAX_CARD - 100,
    t = process.cpuUsage(),
    ms = () => Math.round(process.cpuUsage(t).user / 1000);
  for (const body of [
    'x\n' + '\n'.repeat(n),
    'Which?\n\nChoose:\n- a' + ' '.repeat(n) + 'b',
    'Which?\n\nChoose:\n- a' + ' -'.repeat(n / 2) + 'b',
    'Which?\n\nChoose:\n- a' + ' '.repeat(n) + '(recommended)b',
    'x\n' + ' \n'.repeat(n / 2) + '-'.repeat(50),
    'products/_cycles/' + 'a.'.repeat(n / 2),
    '/cycles/'.repeat(n / 8),
    'https://cycles.preview.example.org/x/\n' + '['.repeat(n),
    'https://cycles.preview.example.org/x/\n' + '[x]('.repeat(n / 4),
  ])
    assert.equal(cardProblem(body), null);
  assert.ok(ms() < 200, `took ${ms()} ms of CPU`);
  assert.match(cardProblem('x'.repeat(MAX_CARD + 1)), /at most 20000/);
});

// A step with a list and text to paste under it, and the card's own text after the steps
const PASTE = `Ask the register to take the address off. About five minutes.

Steps:
1. Open the form and pick "Privacy".
2. Add the pages it is on:
   - https://example.org/one
   - https://example.org/two
3. Paste this as the reason:
   \`\`\`
   I ask you to remove my home address.
     It is my home, not a business address.
   \`\`\`
4. Send it.

Keep the confirmation mail.

---
The register has had the address since 2019.`;

test('a step keeps its list and its block to paste, and the steps end at an empty line followed by anything else', () => {
  const c = parseCard(PASTE);
  assert.deepEqual(c.steps, [
    'Open the form and pick "Privacy".',
    'Add the pages it is on:\n   - https://example.org/one\n   - https://example.org/two',
    'Paste this as the reason:\n   ```\n   I ask you to remove my home address.\n     It is my home, not a business address.\n   ```',
    'Send it.',
  ]);
  assert.equal(c.afterSteps, 'Keep the confirmation mail.');
  assert.equal(c.details, 'The register has had the address since 2019.');
  assert.equal(cardProblem(PASTE), null);
});

test("a wrapped step is one line, and a line of --- in a block to paste is the block's", () => {
  const c = parseCard(
    'Do it.\n\nSteps:\n1. Open the page\n   and sign in.\n2. Paste:\n```\nabove\n---\nbelow\n```\n3. Done.',
  );
  assert.deepEqual(c.steps, ['Open the page and sign in.', 'Paste:\n```\nabove\n---\nbelow\n```', 'Done.']);
  assert.equal(c.details, '');
});

test("a break the writer meant (two spaces or a backslash at a line's end) reaches prose, in the card's text and a step", () => {
  const c = cardOf(
    'First line.  \nSecond line.\nStill second.\n\nSteps:\n1. Open it  \n   and sign in\\\n   then wait.\n2. Done.',
  );
  assert.equal(prose(c.summary[0]), '<p>First line.<br>Second line. Still second.</p>');
  assert.deepEqual(
    c.steps.map(s => prose(s)),
    ['<p>Open it<br>and sign in<br>then wait.</p>', '<p>Done.</p>'],
  );
});

test("a card's long text folds under More ahead of its details, never inside a block to paste; its steps always show", () => {
  const long = Array.from({ length: 16 }, (_, i) => `Sentence ${i} says a little more about why.`).join(' ');
  const c = cardOf(`${long}\n\n\`\`\`\nkept whole\n\`\`\`\n\nSteps:\n1. Do it.\n\n---\nBackground.`);
  assert.ok(c.summary[0].length <= FOLD_CHARS && c.summary[0].endsWith('.'), c.summary[0]);
  assert.match(c.details, /```\nkept whole\n```[\s\S]*Background\.$/);
  assert.deepEqual(c.steps, ['Do it.']);
  const prose = cardOf(`${long}\n\n${long}`);
  assert.equal(prose.card, false);
  assert.ok(prose.summary[0].length <= 320 && prose.details.endsWith('why.'));
});

const LONG = Array.from({ length: 16 }, (_, i) => `Sentence ${i} says a little more about why.`).join(' ');
const TABLE = '| Page | NL | DE |\n|---|---:|---:|\n| Home | 1,200 | 90 |\n| Shop | 40 | 12 |';

test('the phone never folds a link, a numbered list or a table out of its first screen', () => {
  for (const kept of ['Open https://shop.example/admin to see it.', '1. Open the shop.\n2. Tap Save.', TABLE]) {
    const c = cardOf(`${LONG}\n\n${kept}\n\nRecommend: Yes\nOptions: Yes | No`);
    assert.ok(c.summary[0].endsWith(kept), kept);
    assert.equal(c.details, '');
  }
  // prose with nothing to do or read in a table still folds
  assert.match(cardOf(`${LONG}\n\n${LONG}\n\nOptions: Yes | No`).details, /why\.$/);
});

test("a table is the card's content: its characters don't count toward the fold, and a step keeps its rows apart", () => {
  const wide = Array.from({ length: 14 }, (_, i) => `| Page ${i} | ${i * 100} | ${i * 7} |`).join('\n');
  const c = cardOf(`Searches a month, per page.\n\n${TABLE}\n${wide}\n\nSo the shop leads.\n\n${LONG}\n\nOptions: Got it`);
  assert.ok(c.summary[0].includes('So the shop leads.'), c.summary[0]);
  assert.match(c.details, /^Sentence 0/);
  const step = parseCard(`Check them.\n\nSteps:\n1. Compare:\n   ${TABLE.replaceAll('\n', '\n   ')}\n2. Tap Save.`).steps[0];
  assert.equal(step, `Compare:\n   ${TABLE.replaceAll('\n', '\n   ')}`);
  assert.match(prose(step), /<table>.*<td class="right">1,200<\/td>/);
});

test('a table written without its outer pipes reads as one: kept apart in a step, uncounted and unfolded in the text', () => {
  const pipeless = 'Page | NL | DE\n---|---:|---:\nHome | 1,200 | 90\nShop | 40 | 12';
  const step = parseCard(`Check them.\n\nSteps:\n1. Compare:\n   ${pipeless.replaceAll('\n', '\n   ')}\n2. Tap Save.`).steps[0];
  assert.equal(step, `Compare:\n   ${pipeless.replaceAll('\n', '\n   ')}`);
  assert.match(prose(step), /<table>.*<td class="right">1,200<\/td>/);
  const wide = Array.from({ length: 14 }, (_, i) => `Page ${i} | ${i * 100} | ${i * 7}`).join('\n');
  const c = cardOf(`Searches a month, per page.\n\n${pipeless}\n${wide}\n\nSo the shop leads.\n\n${LONG}\n\nOptions: Got it`);
  assert.ok(c.summary[0].includes('So the shop leads.'), c.summary[0]);
  const kept = cardOf(`${LONG}\n\n${pipeless}\n\nOptions: Yes | No`);
  assert.ok(kept.summary[0].endsWith(pipeless));
  // a line with a pipe and no line of dashes under it is prose, as prose() shows it
  assert.equal(parseCard('Do it.\n\nSteps:\n1. Pick\n   a | b\n2. Tap Save.').steps[0], 'Pick a | b');
});

test('filing refuses a link or a numbered list the phone would fold under More, and says to make it a step', () => {
  const refused = [
    [`${LONG}\n\nThen open https://shop.example/admin.\n\nOptions: Done`, /past its first screen.*a link \("Then open/],
    [`${LONG.slice(0, 300)}\n\n1. Open the shop.\n2. Tap Save.`, /past its first screen.*a numbered list \("1\. Open/],
    ['We changed the shop.\n\n---\nSee https://shop.example/admin.', /details under --- hold a link/],
    ['Which one?\n\nOptions: A | B\n\n---\n1. Open the shop.\n2. Pick one.', /details under --- hold a numbered list/],
    ['Do it.\n\nSteps:\n1. Tap Save.\n\n---\nOpen https://shop.example/admin first.', /details under --- hold a link/],
    [
      'Do it.\n\nSteps:\n1. Tap Save.\n\n---\nHow to undo it later:\n1. Tap Undo.\n\nOr open https://shop.example/admin.',
      /details under --- hold a link \("Or open/,
    ],
  ];
  for (const [card, why] of refused) assert.match(cardProblem(card) ?? 'null', why, card);
});

test('filing lets a card keep detail under ---: how to undo it later, a plain list, a table, and links on its first screen', () => {
  const allowed = [
    'Do it.\n\nSteps:\n1. Open https://shop.example/admin and tap Save.\n\n---\nHow to undo it later:\n1. Open https://shop.example/admin.\n2. Tap Undo.',
    'Do it.\n\nSteps:\n1. Tap Save.\n\n---\n**To stop it:**\n- open https://shop.example/admin\n- tap Stop',
    'Which one?\n\nOptions: A | B\n\n---\nWhat each costs:\n- A: 5 a month\n- B: 7 a month',
    `Searches a month.\n\n${TABLE}\n\n---\n${TABLE}`,
    `The figures are in. See https://shop.example/stats.\n\n${LONG}\n\nOptions: Got it`,
  ];
  for (const card of allowed) assert.equal(cardProblem(card), null, card);
});

test('filing refuses a card that is too long to take in on a tablet, and says how to fix it', () => {
  const words = n => `${Array.from({ length: n }, (_, i) => `word${i}`).join(' ')}.`;
  const card = (steps, more = '') => `Do it.\n\nSteps:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n${more}`;
  const fenced = text => `   \`\`\`\n   ${text}\n   \`\`\``;
  assert.match(cardProblem(card(Array(9).fill('Tap.'))), /9 steps: a card holds at most 8/);
  assert.match(cardProblem(card(['Tap.', words(36)])), /step 2 runs to 36 words/);
  assert.equal(cardProblem(card(['Tap.', words(35)])), null);
  assert.match(
    cardProblem(card([`Paste this:\n\n   ${words(26)}`])),
    /step 1 holds a paragraph of 26 words.*fenced block/,
  );
  // text to paste in a block is no step's words, and a `value` is one
  assert.equal(cardProblem(card([`Paste this:\n${fenced(words(200))}`, `Type \`${words(40)}\` there.`])), null);
  assert.match(cardProblem(`${words(51)}\n\nSteps:\n1. Tap.`), /opens with 51 words/);
  assert.match(cardProblem('Do it.\n- first\n- then\n\nSteps:\n1. Tap.'), /list of its own/);
  assert.match(
    cardProblem(card(['Tap.'], `\n${Array(9).fill(words(30)).join('\n\n')}`)),
    /runs to 2\d\d words before its ---: a card holds at most 250/,
  );
  assert.match(cardProblem(card(['Tap.'], `---\n${words(81)}`)), /details under --- run to 81 words/);
  assert.match(cardProblem(card(['Paste:\n```\nnever closed'])), /isn't closed/);
});

test("a card's [text](address) link reaches the phone whole, and shows as a link with its text", () => {
  const c = cardOf('Shop front: About us and the delivery box, good now?\n\nLive: [About us](https://shop.example/en/about-us)\n\nRecommend: Yes\nOptions: Yes | No');
  assert.equal(prose(c.summary.join('\n\n')),
    '<p>Shop front: About us and the delivery box, good now?</p><p>Live: <a href="https://shop.example/en/about-us" target="_blank" rel="noopener">About us ↗</a></p>');
});

const BACK = `Both notes are fixed, in all three languages.

Before and after:
- About us, who we are: products/_cycles/t/about-before.png products/_cycles/t/about-after.png https://front.example/en/about-us/
- The delivery box: /cycles/t/box-before.jpg → /cycles/t/box-after.jpg

---
The links became buttons.`;

test('a card with before-and-after pairs leads with them: its text folds under More', () => {
  const c = cardOf(BACK);
  assert.deepEqual(
    c.pairs.map(p => [p.label, p.before, p.after, p.link]),
    [
      [
        'About us, who we are',
        'products/_cycles/t/about-before.png',
        'products/_cycles/t/about-after.png',
        'https://front.example/en/about-us/',
      ],
      ['The delivery box', '/cycles/t/box-before.jpg', '/cycles/t/box-after.jpg', ''],
    ],
  );
  assert.equal(c.summary[0], '');
  assert.equal(c.details, 'Both notes are fixed, in all three languages.\n\nThe links became buttons.');
  assert.doesNotMatch(pairsOf(BACK).rest, /about-before|Before and after/); // (so they aren't shown again as the card's pictures)
  assert.equal(cardProblem(BACK, true), null);
  assert.deepEqual(cardOf('Which?\n\nOptions: Yes | No').pairs, []);
});

test('a card that brings work back shows each change before and after, or its clip, or says there is nothing to see', () => {
  const words = 'Both notes are fixed.';
  assert.match(cardProblem(words, true), /leads with a picture of each change.*"No pictures: why"/);
  assert.equal(cardProblem(words), null); // any other card may be words alone
  assert.equal(cardProblem(`No pictures: the change is in how the email is sent.\n\n${words}`, true), null);
  assert.equal(cardProblem(`The new jingle: products/_cycles/t/jingle.mp4\n\n${words}`, true), null);
  const one = BACK.replace(' products/_cycles/t/about-after.png', '');
  assert.match(cardProblem(one, true), /"About us, who we are" names one picture, and a change takes two/);
  assert.match(cardProblem(BACK.replace('About us, who we are: ', ''), true), /no words before its pictures/);
  assert.match(cardProblem(BACK.replace('about-after', 'about-before'), true), /the same picture twice/);
  // HQ gives it its two answers: Good now, or notes on the preview in review mode
  assert.match(
    cardProblem(BACK.replace('\n\n---', '\n\nSteps:\n1. Open the page.\n\n---'), true),
    /leave out its Steps: list/,
  );
  for (const answers of [
    'Choose:\n- Good now\n- More changes',
    'Options: Good now | More changes',
    'Recommend: good now',
  ])
    assert.match(cardProblem(BACK.replace('\n\n---', `\n\n${answers}\n\n---`), true), /HQ gives it its two answers/);
});

test("the presentation's address leaves the text once HQ makes its button from it: alone it goes, in a sentence it's the presentation above", () => {
  const deck = 'https://cycles.preview.example.org/2026-10-21-notes/';
  const c = cardOf(
    `${deck}\n\nFive fixes. The slides at ${deck} show each, now and proposed side by side, with what we'd leave.\n\n**We recommend:** yes to all five.`,
  );
  assert.equal(
    c.summary[0],
    "Five fixes. The slides at the presentation above show each, now and proposed side by side, with what we'd leave.\n\n**We recommend:** yes to all five.",
  );
  assert.ok(!cardOf(`Presentation: ${deck}\n\nFive fixes.`).summary[0].includes('cycles'));
  // a block to paste keeps it, as other links stay
  const kept = cardOf(`Five fixes.\n\n\`\`\`\n${deck}\n\`\`\`\n\nSee https://front.preview.example.org/en/ too.`)
    .summary[0];
  assert.ok(kept.includes(deck) && kept.includes('https://front.preview.example.org/en/'));
});

test('a short sentence or a step that names the presentation keeps its words: only a line with nothing else (or a label) goes', () => {
  const deck = 'https://cycles.preview.example.org/2026-10-21-notes/';
  assert.equal(
    cardOf(`Please review ${deck} before approving the €100 spend.`).summary[0],
    'Please review the presentation above before approving the €100 spend.',
  );
  const c = cardOf(`Two fixes.\n\nSteps:\n1. Open ${deck} and read slide 3.\n2. Tap Send.`);
  assert.deepEqual(c.steps, ['Open the presentation above and read slide 3.', 'Tap Send.']);
  for (const line of [
    deck,
    `Presentation: ${deck}`,
    `- The deck: ${deck}`,
    `**Presentation:** ${deck}`,
    `[The deck](${deck})`,
  ])
    assert.equal(cardOf(`${line}\n\nTwo fixes.`).summary[0], 'Two fixes.', line);
  // a lead-in that says more than what the address is stays, the address becoming "the presentation above"
  assert.equal(
    cardOf(`Check slide 3 before you approve: ${deck}\n\nTwo fixes.`).summary[0],
    'Check slide 3 before you approve: the presentation above\n\nTwo fixes.',
  );
  // a Markdown link to it in a sentence keeps its words, not the address
  assert.equal(cardOf(`The [slides](${deck}) show both.`).summary[0], 'The slides show both.');
});

test('the documents a card names are those the desk phone links to the Library, found as the Library opens them', () => {
  const body = 'Read `board-requests.md` and company/briefs/6728-foundation-licence.md, then ../x.md.bak.\n\n' +
    '[a.md](https://h.example/b.md) and https://h.example/c.md stay links; `not a doc.md` and foo.mdx are words.\n\n```\nin-a-fence.md\n```';
  assert.deepEqual(docsIn(body), ['board-requests.md', 'company/briefs/6728-foundation-licence.md', '../x.md']);
  assert.deepEqual(docParts('see a/b.md, then c.md'), ['see ', 'a/b.md', ', then ', 'c.md', '']);
  assert.equal(docsIn('a.'.repeat(10_000) + 'md').length, 1);   // (linear on a long run)
  // a link to the presentation shows its words, so a document they name is named
  assert.deepEqual(docsIn('Read [notes.md](https://cycles.preview.example.invalid/demo/) first.'), ['notes.md']);
  const shelves = [{ path: 'company/playbooks/board-requests.md' }, { path: 'company/CHARTER.md' }];
  assert.equal(docOn(shelves, 'board-requests.md'), shelves[0]);
  assert.equal(docOn(shelves, 'company/CHARTER.md'), shelves[1]);
  assert.equal(docOn(shelves, 'company/briefs/6728-foundation-licence.md'), undefined);
});
