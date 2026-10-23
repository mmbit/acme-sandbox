// node --test platform/hq/shell/questions.test.js   (questions as form fields, as plain functions; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { question, questions, answer, given, said, answerLines, inputHtml, chips } from './questions.js';

test('a question is a text, a yes or no, a number with a unit, or a choice', () => {
  assert.deepEqual(question({ title: ' Anything else? ' }), { title: 'Anything else?' });
  assert.deepEqual(question({ title: 'Sharp?', type: 'yes-no' }), { title: 'Sharp?', type: 'yes-no' });
  assert.deepEqual(question({ title: 'Gap', type: 'number', unit: 'mm', detail: 'at the top' }), {
    title: 'Gap',
    detail: 'at the top',
    type: 'number',
    unit: 'mm',
  });
  assert.deepEqual(question({ title: 'Finish', options: ['Matte', 'Gloss'] }), {
    title: 'Finish',
    options: ['Matte', 'Gloss'],
  });
  assert.deepEqual(question({ title: 'Plain', type: 'text' }), { title: 'Plain' });
});

test('a question that makes no sense says why', () => {
  for (const [q, why] of [
    [{}, /title/],
    [{ title: 'a\nb' }, /title/],
    [{ title: 'x', type: 'date' }, /type/],
    [{ title: 'x', unit: 'mm' }, /unit/],
    [{ title: 'x', type: 'yes-no', unit: 'mm' }, /unit/],
    [{ title: 'x', options: ['one'] }, /options/],
    [{ title: 'x', options: ['a', 'a'] }, /options/],
    [{ title: 'x', options: ['a', 'b'], type: 'yes-no' }, /options/],
    [{ title: 'x', detail: 7 }, /detail/],
    [{ title: 'x', optional: 'yes' }, /optional/],
  ])
    assert.match(question(q), why, JSON.stringify(q));
  assert.match(questions([]), /1 to 40/);
  assert.match(questions([{ title: 'ok' }, { title: 'x', type: 'nope' }]), /^question 2: /);
  assert.equal(questions(Array.from({ length: 3 }, (_, k) => ({ title: `q${k}`, type: 'yes-no' }))).length, 3);
});

test('an answer is stored as it fits its question, or refused', () => {
  const yes = { title: 'Sharp?', type: 'yes-no' },
    mm = { title: 'Gap', type: 'number', unit: 'mm' },
    pick = { title: 'Finish', options: ['Matte', 'Gloss'] };
  assert.equal(answer(yes, 'yes'), 'yes');
  assert.equal(answer(yes, 'Nee'), 'no'); // the guest page's Dutch chip
  assert.equal(answer(yes, 'maybe'), null);
  assert.equal(answer(mm, '3,5'), '3.5');
  assert.equal(answer(mm, ' 12 mm'), '12');
  assert.equal(answer(mm, '-2'), '-2');
  assert.equal(answer(mm, 'three'), null);
  assert.equal(answer(mm, '1e3'), null);
  assert.equal(answer(pick, 'Gloss'), 'Gloss');
  assert.equal(answer(pick, 'gloss'), null);
  assert.equal(answer({ title: 'Note' }, '  fine  '), 'fine');
  assert.equal(answer({ title: 'Note' }, '   '), null);
  assert.equal(answer({ title: 'Note' }, undefined), null);
});

test('an optional question may be left blank, but what is given still fits it', () => {
  const skip = question({ title: 'What to change, if anything', optional: true }),
    mm = { title: 'Gap', type: 'number', optional: true };
  assert.deepEqual(skip, { title: 'What to change, if anything', optional: true });
  assert.deepEqual(question({ title: 'Must', optional: false }), { title: 'Must' });
  assert.equal(given(skip, '  '), '');
  assert.equal(given(skip, ' less red '), 'less red');
  assert.equal(given(mm, undefined), '');
  assert.equal(given(mm, 'three'), null);
  assert.equal(given({ title: 'Must' }, ''), null);
  assert.equal(
    answerLines([{ title: 'Ok?', type: 'yes-no' }, skip], ['yes', '']),
    '1. Ok? → Yes\n2. What to change, if anything → (left blank)',
  );
});

test('an answer as people read it, and as the agent gets them all', () => {
  const list = [{ title: 'Sharp?', type: 'yes-no' }, { title: 'Gap', type: 'number', unit: 'mm' }, { title: 'Note' }];
  assert.equal(said(list[0], 'no', 'nl'), 'Nee');
  assert.equal(said(list[1], '3.5'), '3.5 mm');
  assert.equal(said(list[1], '3.5', 'nl'), '3,5 mm');
  assert.equal(said({ title: 'n', type: 'number' }, '12'), '12');
  assert.equal(answerLines(list, ['yes', '3.5', 'fine']), '1. Sharp? → Yes\n2. Gap → 3.5 mm\n3. Note → fine');
});

test('a field: chips post on the guest page, toggle on the desk phone; boxes escape what they hold', () => {
  const yes = { title: 'Sharp?', type: 'yes-no' };
  assert.ok(chips(yes) && chips({ title: 'x', options: ['a', 'b'] }) && !chips({ title: 'x', type: 'number' }));
  assert.equal(
    inputHtml(yes, { value: 'no', lang: 'nl', post: true }),
    '<button name="answer" value="yes" class="chip" aria-pressed="false">Ja</button><button name="answer" value="no" class="chip on" aria-pressed="true">Nee</button>',
  );
  assert.match(inputHtml(yes), /^<button type="button" data-answer="yes" class="chip"/);
  const box = inputHtml({ title: 'Gap', type: 'number', unit: 'm"m' }, { id: 'g', value: '"><b>' });
  assert.match(box, /inputmode="decimal"/);
  assert.match(inputHtml({ title: 'Gap', type: 'number' }, { id: 'g', value: '82.5', lang: 'nl' }), /value="82,5"/);
  assert.ok(!box.includes('"><b>') && box.includes('<span class="unit">m&quot;m</span>'));
  assert.match(
    inputHtml({ title: 'Note' }, { id: 'n', placeholder: 'Your answer', required: true }),
    /^<input id="n" name="answer" value="" maxlength="8000" placeholder="Your answer" required>$/,
  );
});

test('a pick-many: every option starts picked, any of them is an answer (none too), and the agent reads which', () => {
  const fixes = ['1. Posters on a wall', "2. The logo's size", '3. Sinterklaas'];
  const q = question({ title: 'Which fixes shall we make?', options: fixes, many: true });
  assert.deepEqual(q, { title: 'Which fixes shall we make?', options: fixes, many: true });
  assert.match(question({ title: 'x', many: true }), /goes with options only/);
  assert.match(question({ title: 'x', options: ['a', 'b'], many: 'yes' }), /many: true/);
  const twenty = Array.from({ length: 20 }, (_, k) => `${k + 1}. A change`);
  assert.equal(typeof question({ title: 'x', options: twenty, many: true }), 'object');
  assert.match(question({ title: 'x', options: twenty }), /2 to 8/); // (a one-pick choice stays at eight)
  assert.equal(answer(q, [fixes[2], fixes[0]]), JSON.stringify([fixes[0], fixes[2]])); // in the question's order
  assert.equal(answer(q, []), '[]');
  assert.equal(answer(q, JSON.stringify([fixes[1]])), JSON.stringify([fixes[1]]));
  assert.equal(answer(q, ['4. Something else']), null);
  assert.equal(answer(q, undefined), null);
  assert.equal(said(q, answer(q, fixes)), `all: ${fixes.join('; ')}`);
  assert.equal(said(q, answer(q, [fixes[1]])), fixes[1]);
  assert.equal(said(q, '[]'), 'none');
  assert.equal(answerLines([q], ['[]']), '1. Which fixes shall we make? → none');
  // on the desk phone, all on until the board takes one off
  assert.equal((inputHtml(q).match(/class="chip on"/g) ?? []).length, 3);
  assert.equal((inputHtml(q, { value: [fixes[1]] }).match(/aria-pressed="true"/g) ?? []).length, 1);
  assert.ok(chips(q));
});
