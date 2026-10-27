// node --test platform/hq/shell/bookfaces.test.js   (the rail's faces counted from the sheets; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { facesOf } from './bookfaces.js';

const MOCK = JSON.parse(readFileSync(new URL('../mock/book-sheets.json', import.meta.url), 'utf8'));
const sheet = (owner, notes, status = 'open') => ({ owner, status, notes });
const note = (status, slips = []) => ({ status, slips });

test("HQ's mock sheets: a face per open sheet with its notes counted, the CEO's for nobody's, a dot for a sent answer", () => {
  assert.deepEqual(facesOf(MOCK, 'juno'), [
    { id: 'wren', owner: 'wren', count: 2, dot: false, sending: null },
    { id: 'kit', owner: 'kit', count: 1, dot: false, sending: null },
    { id: 'juno', owner: null, count: 1, dot: false, sending: null },
    // (Lark's sheet on today's page of the mock book)
    { id: 'lark', owner: 'lark', count: 2, dot: false, sending: null },
    { id: 'moss', owner: 'moss', count: 0, dot: true, sending: null },
  ]);
});

test("the CEO's own sheet and one nobody owns are one face, their notes added up", () => {
  const faces = facesOf({ open: [sheet(null, [note('open')]), sheet('juno', [note('open'), note('open')])] }, 'juno');
  assert.deepEqual(faces, [{ id: 'juno', owner: null, count: 3, dot: false, sending: null }]);
});

test('only open notes count; a ticked answer leaves no dot, an unticked one on an open sheet does', () => {
  const faces = facesOf(
    {
      open: [
        sheet('kit', [note('open'), note('sent'), note('wiped')]),
        sheet('wren', [note('sent', [{ ticked: null }])]),
      ],
      sent: [sheet('moss', [note('sent', [{ ticked: '2026-10-26' }])], 'sent')],
    },
    'juno',
  );
  assert.deepEqual(faces, [
    { id: 'kit', owner: 'kit', count: 1, dot: false, sending: null },
    { id: 'wren', owner: 'wren', count: 0, dot: true, sending: null },
  ]);
});

test('a send in its seconds rings its face; a page sent on its own counts no note waiting', () => {
  const going = { ...sheet('kit', [note('open'), note('open')]), status: 'sending' },
    page = { ...sheet('wren', [note('open')]), status: 'sending', page: 7 };
  assert.deepEqual(facesOf({ open: [going, page] }, 'juno'), [
    { id: 'kit', owner: 'kit', count: 2, dot: false, sending: going },
    { id: 'wren', owner: 'wren', count: 0, dot: false, sending: page },
  ]);
});

test('no sheets, no faces', () => assert.deepEqual(facesOf({}, 'juno'), []));
