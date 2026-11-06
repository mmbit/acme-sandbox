// node --test src/callguestsweep.test.ts   (uses a throwaway DATA_DIR)
// A guest's part of the board's call goes 12 months after it (callguestsweep.ts): their lines, their name in any of its
// forms, their scan, the same in the call's items, their words there with a label or without, numbered or not; their
// drawing stays on the board's page, the board's and the agent's lines stay, also when a guest typed their name, and
// search follows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('callguestsweep');
const { ORIGIN } = await import('./config.ts');
const { db } = await import('./db.ts');
const { sweep } = await import('./callguestsweep.ts');
const ledger = await import('./ledger.ts');
const memory = await import('./memory.ts');
const said = (r: { status: number; body: any }) => {
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const stroke = {
  color: '#292722',
  size: 4,
  points: [
    [10, 10, 0.5, 0],
    [60, 40, 0.5, 10],
  ],
};

const gone = 'Guest: (deleted 12 months after the call)';

// A device that scans the call's code and joins as name, → its requests with the session
async function joined(link: string, name: string) {
  const at = new URL(link).pathname;
  const door = await fetch(new URL(at, h.base), {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    body: `name=${encodeURIComponent(name)}&screen=show`,
    redirect: 'manual',
  });
  assert.equal(door.status, 303);
  const cookie = door.headers.get('set-cookie')!.split(';')[0];
  return async (to: string, body: unknown) => {
    const r = await fetch(new URL(to, h.base), {
      method: 'POST',
      headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
}
// An item of the call, recorded as the call's agent records it (ledger.ts), → its id
function item(call: number, what: string, goal: string, quote: string, lines = '3-7') {
  const added = ledger.add(call, { kind: 'task', owner: 'juno', what, goal, quote, lines }, null, false);
  assert.equal(typeof added, 'object', String(added));
  return (added as { id: number }).id;
}
// What search holds of a call
const indexed = (call: number) =>
  (db.prepare('select body from memory where doc = ?').all(`call:${call}`) as { body: string }[])
    .map(c => c.body)
    .join('\n');

test('12 months after the call, its guests’ lines, name and scan go; their drawing and the board’s lines stay', async () => {
  const { call, token } = await h.liveCall('juno');
  const page = said(await h.board('/api/notebooks/call', { call })).page.id as number;
  const { link } = said(await h.board('/api/calls/guest', { call, lang: 'nl' }));
  const esmee = await joined(link, 'esmee'),
    second = await joined(link, 'Esmee');
  const scans = db.prepare('select id, name, pen from call_scans where call = ?').all(call) as {
    id: number;
    name: string;
    pen: number;
  }[];
  assert.deepEqual(
    scans.map(s => s.name),
    ['esmee', 'Esmee 2'],
  );
  const drawn = said(await esmee('/guest/notebooks/api/groups/create', { page, ink: [stroke] }));
  said(await second('/guest/notebooks/api/groups/create', { page, ink: [stroke] }));
  const lines = [
    'Board: Esmee zit er ook bij.',
    'Juno: Welkom, Esmee. Will you draw?',
    'esmee: Ja, ik teken. Een rood huis met een boom.',
    'Esmee 2: Ik ook.',
    'esmee: (on screen: #1 13:19:26 on /; a picture of the screen went with it)',
    `Esmee 2: (drew #${drawn.id} on the call's notes page)`,
    'Board: Willem en Esmeralda zien het straks. Ja.',
  ];
  const times = lines.map((_, i) => Date.now() + i * 1000);
  said(await h.voice('call-end', { agent: 'juno', lines, times, token }));
  // An item quoting her words with the board's, one naming her in its own words, and one quoting her words without
  // her name: a whole line, part of one, and a sentence of hers after the board's
  const quoted = item(call, 'Tekenen op de pagina', 'Esmee wil meer kleur', [lines[2], lines[3], lines[6]].join('\n')),
    named = item(call, 'Esmee’s schets uitwerken', 'Wat Esmee 2 tekende', 'Board: Werk uit wat Esmee tekende.'),
    bare = item(
      call,
      'Rood huis tekenen',
      'Wat zij wil',
      ['Ja, ik teken. Een rood huis met een boom.', '"…een rood huis"', 'Board: Mooi. Ik ook.', 'Ja.'].join('\n'),
    );
  // (the board's yes to one, in its words, and another dropped, with why)
  assert.equal(typeof ledger.done(named, 'Ja, met Esmee', 0), 'object');
  assert.equal(typeof ledger.drop(quoted, 'Esmee tekent het al', 0), 'object');
  const ended = Date.parse((db.prepare('select ts from calls where id = ?').get(call) as { ts: string }).ts);
  // (search has the call, their lines and name with it)
  await memory.refresh();
  assert.match(indexed(call), /esmee: Ja, ik teken/);

  // Not before its 12 months
  assert.deepEqual(sweep(ended + 364 * 86_400_000), []);
  assert.equal((db.prepare('select count(*) n from call_scans where call = ?').get(call) as { n: number }).n, 2);

  assert.deepEqual(sweep(ended + 366 * 86_400_000), [call]);
  const row = db.prepare('select lines, line_times from calls where id = ?').get(call) as {
    lines: string;
    line_times: string;
  };
  assert.deepEqual(JSON.parse(row.lines), [
    'Board: Guest zit er ook bij.',
    'Juno: Welkom, Guest. Will you draw?',
    gone,
    gone,
    gone,
    gone,
    'Board: Willem en Esmeralda zien het straks. Ja.',
  ]);
  // (each line keeps its place and its time: the items' line ranges still point at the same lines)
  assert.equal(JSON.parse(row.line_times).length, lines.length);
  // The call's items alike: her lines in a quote keep their place, her words without her name go too (the board's 'Ja.'
  // stays, as the board said it as well), her name goes wherever it stands
  const items = (
    db.prepare('select id, what, goal, quote, why, said from call_items where call = ? order by id').all(call) as {
      id: number;
      what: string;
      goal: string;
      quote: string;
      why: string | null;
      said: string | null;
    }[]
  ).map(i => ({ ...i }));
  assert.deepEqual(items, [
    {
      id: quoted,
      what: 'Tekenen op de pagina',
      goal: 'Guest wil meer kleur',
      quote: [gone, gone, lines[6]].join('\n'),
      why: 'Guest tekent het al',
      said: null,
    },
    {
      id: named,
      what: 'Guest’s schets uitwerken',
      goal: 'Wat Guest tekende',
      quote: 'Board: Werk uit wat Guest tekende.',
      why: null,
      said: 'Ja, met Guest',
    },
    {
      id: bare,
      what: 'Rood huis tekenen',
      goal: 'Wat zij wil',
      quote: [gone, gone, 'Board: Mooi. (deleted 12 months after the call)', 'Ja.'].join('\n'),
      why: null,
      said: null,
    },
  ]);
  // Their scans and places on the call go; their pens stay, without their names
  assert.equal((db.prepare('select count(*) n from call_scans where call = ?').get(call) as { n: number }).n, 0);
  assert.equal(
    (db.prepare("select count(*) n from call_guests where call = ? and guest like 'scan:%'").get(call) as { n: number })
      .n,
    0,
  );
  const pens = db.prepare(`select guest from sketch_guests where id in (${scans.map(s => s.pen).join(',')})`).all() as {
    guest: string;
  }[];
  assert.deepEqual(
    pens.map(p => p.guest),
    ['Guest', 'Guest'],
  );
  // ...and their drawings stay on the board's page, by their pens
  const groups = said(await h.board(`/api/notebooks/pages/groups?page=${page}`)).groups as { id: number; by: string }[];
  assert.deepEqual(
    groups.map(g => g.by),
    scans.map(s => `guest:${s.pen}`),
  );
  // Search reads the call again: nothing of them in it
  await memory.refresh();
  assert.match(indexed(call), /Willem en Esmeralda/);
  assert.doesNotMatch(indexed(call), /esmee\b|ik teken/i);
  // Once swept, nothing more
  assert.deepEqual(sweep(ended + 400 * 86_400_000), []);
});

// A call with these guests and lines, an item quoting all its lines, swept 12 months on → its lines and the item's quote
async function swept(guests: string[], lines: string[]) {
  const { call, token } = await h.liveCall('juno');
  const { link } = said(await h.board('/api/calls/guest', { call, lang: 'nl' }));
  for (const g of guests) await joined(link, g);
  const times = lines.map((_, i) => Date.now() + i * 1000);
  said(await h.voice('call-end', { agent: 'juno', lines, times, token }));
  const id = item(call, 'Het gesprek', 'Wat er gezegd is', lines.join('\n'), `1-${lines.length}`);
  const shown = (
    db.prepare('select name from call_scans where call = ? order by id').all(call) as { name: string }[]
  ).map(s => s.name);
  assert.deepEqual(sweep(Date.now() + 366 * 86_400_000), [call]);
  const row = db.prepare('select lines from calls where id = ?').get(call) as { lines: string };
  const { quote } = db.prepare('select quote from call_items where id = ?').get(id) as { quote: string };
  return { shown, lines: JSON.parse(row.lines) as string[], quote: quote.split('\n') };
}
test('a guest’s name goes in every form: in parts, in any case, and in the agent’s words alone', async () => {
  const parts = await swept(
    ['Esmee de Vries'],
    [
      'Juno: Welkom, Esmee.',
      'Board: Dag mevrouw de Vries. ESMEE DE VRIES, toch? Vries met een v.',
      'Esmee de Vries: Ja, dat ben ik.',
      'Board: De tekening ligt op de tafel.',
    ],
  );
  const scrubbed = [
    'Juno: Welkom, Guest.',
    'Board: Dag mevrouw Guest. Guest, toch? Guest met een v.',
    gone,
    // ('de' alone is no part of her that names her: the board's sentence keeps it)
    'Board: De tekening ligt op de tafel.',
  ];
  assert.deepEqual(parts, { shown: ['Esmee de Vries'], lines: scrubbed, quote: scrubbed });

  const caps = await swept(['ESMEE'], ['Juno: Welkom, Esmee.', 'ESMEE: Hoi.', 'Board: esmee tekent mee.']);
  assert.deepEqual(caps.lines, ['Juno: Welkom, Guest.', gone, 'Board: Guest tekent mee.']);
});

test('a guest who typed the board’s or the agent’s name: the board’s and the agent’s lines and names stay', async () => {
  const lines = [
    'Board: Hoi Juno. Welkom, Board 2 en Juno 2.',
    'Juno: Dag Board, dag allemaal.',
    'Board 2: Ik heet ook Board.',
    'Juno 2: En ik Juno.',
    'Board: Dan zeg ik het: the board tekent.',
  ];
  const { shown, ...after } = await swept(['Board', 'Juno'], lines);
  assert.deepEqual(shown, ['Board 2', 'Juno 2']);
  const scrubbed = [
    'Board: Hoi Juno. Welkom, Guest en Guest.',
    'Juno: Dag Board, dag allemaal.',
    gone,
    gone,
    'Board: Dan zeg ik het: the board tekent.',
  ];
  assert.deepEqual(after, { lines: scrubbed, quote: scrubbed });
});

test('a name that is also a word goes wherever it stands, the word too', async () => {
  const { lines } = await swept(
    ['will'],
    ['Board: I will send it to Will.', 'will: Thanks!', 'Juno: Willem will too.'],
  );
  assert.deepEqual(lines, ['Board: I Guest send it to Guest.', gone, 'Juno: Willem Guest too.']);
});

test('a quote with the transcript’s numbers, or a guest’s turn run into a board line: their words go, the board’s stay', async () => {
  const lines = [
    'Board: Klaar. Esmee: wil jij tekenen?',
    'Esmee: Ja, ik teken een huis.',
    'Juno: Mooi.',
    'Board: Ik wil stoppen.',
    'Esmee: Ik wil stoppen.',
  ];
  const { call, token } = await h.liveCall('juno');
  const { link } = said(await h.board('/api/calls/guest', { call, lang: 'nl' }));
  await joined(link, 'Esmee');
  said(await h.voice('call-end', { agent: 'juno', lines, times: lines.map((_, i) => Date.now() + i * 1000), token }));
  // (as the agent reads the transcript: ledger.ts transcript)
  const { text } = ledger.transcript(call) as { text: string };
  const id = item(
    call,
    'Het gesprek',
    'Wat er gezegd is',
    [
      text,
      'Board: Mooi. Esmee: Ja, ik teken een huis.',
      // (her words a little differently, and her turn after the board's same words)
      'Board: Mooi. Esmee: ja ik teken een huis',
      'Board: Ik wil stoppen. Esmee: Ik wil stoppen.',
    ].join('\n'),
    '1-3',
  );
  assert.deepEqual(sweep(Date.now() + 366 * 86_400_000), [call]);
  const { quote } = db.prepare('select quote from call_items where id = ?').get(id) as { quote: string };
  assert.deepEqual(quote.split('\n'), [
    // (a board sentence that starts with her name and a colon is the board's: only her name goes)
    '[1] Board: Klaar. Guest: wil jij tekenen?',
    `[2] ${gone}`,
    '[3] Juno: Mooi.',
    '[4] Board: Ik wil stoppen.',
    `[5] ${gone}`,
    'Board: Mooi. (deleted 12 months after the call)',
    'Board: Mooi. (deleted 12 months after the call)',
    'Board: Ik wil stoppen. (deleted 12 months after the call)',
  ]);
});

test('a guest named with a number in front: their unnumbered line goes with its label', async () => {
  const lines = ['Board: Hoi.', '[1] Esmee: Mijn adres is Lindestraat 10.'];
  const { call, token } = await h.liveCall('juno');
  const { link } = said(await h.board('/api/calls/guest', { call, lang: 'nl' }));
  await joined(link, '[1] Esmee');
  said(await h.voice('call-end', { agent: 'juno', lines, times: lines.map((_, i) => Date.now() + i * 1000), token }));
  const { text } = ledger.transcript(call) as { text: string };
  const id = item(call, 'Het gesprek', 'Wat er gezegd is', [text, lines[1]].join('\n'), '1-2');
  assert.deepEqual(sweep(Date.now() + 366 * 86_400_000), [call]);
  const { quote } = db.prepare('select quote from call_items where id = ?').get(id) as { quote: string };
  assert.deepEqual(quote.split('\n'), ['[1] Board: Hoi.', `[2] ${gone}`, gone]);
});

test('a guest named like a numbered line of the board: the board’s numbered line stays, theirs goes', async () => {
  const lines = ['Board: Keep the approved plan.', '[1] Board: I prefer blue.'];
  const { call, token } = await h.liveCall('juno');
  const { link } = said(await h.board('/api/calls/guest', { call, lang: 'en' }));
  await joined(link, '[1] Board');
  said(await h.voice('call-end', { agent: 'juno', lines, times: lines.map((_, i) => Date.now() + i * 1000), token }));
  const { text } = ledger.transcript(call) as { text: string };
  const id = item(call, 'The call', 'What was said', [text, lines[1]].join('\n'), '1-2');
  assert.deepEqual(sweep(Date.now() + 366 * 86_400_000), [call]);
  const { quote } = db.prepare('select quote from call_items where id = ?').get(id) as { quote: string };
  assert.deepEqual(quote.split('\n'), ['[1] Board: Keep the approved plan.', `[2] ${gone}`, gone]);
});
