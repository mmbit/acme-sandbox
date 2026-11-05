// node --test shared/watchalong/sheets.test.ts
// A recorded page's linked stylesheets replayed as their files say them (sheets.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { READS, SHEETS_BYTES, absolute, noSheets, sheeted } from './sheets.ts';
import type { RecordedEvent } from './store.ts';

const HQ = 'https://hq.test';
// HQ's stylesheet as Chromium reads it back to rrweb's recorder: html and body's font left out
const READ = 'html, body { margin: 0px; }';
const FILE = "@import url('look/shelf.css');\nhtml, body { margin: 0; font: 16px/1.4 var(--font); }";
const FILES: Record<string, string> = {
  [`${HQ}/style.css`]: FILE,
  [`${HQ}/look/shelf.css`]: '.shelf { background: url(wood.png); }',
};
// (as the recorder sends an inlined one: its rel gone, its address kept, watchalong.js withAddress)
const link = (id: number, href: string, cssText = READ) => ({
  type: 2,
  id,
  tagName: 'link',
  attributes: { href, _cssText: cssText },
  childNodes: [],
});
const events: RecordedEvent[] = [
  {
    type: 2,
    timestamp: 1,
    data: {
      node: {
        type: 0,
        id: 1,
        childNodes: [{ type: 2, id: 2, tagName: 'html', attributes: {}, childNodes: [link(3, `${HQ}/style.css`)] }],
      },
    },
  },
  {
    type: 3,
    timestamp: 2,
    data: {
      source: 0,
      texts: [],
      attributes: [],
      removes: [],
      adds: [{ parentId: 2, nextId: null, node: link(4, 'https://elsewhere.test/look.css', 'p { color: red; }') }],
    },
  },
  // (a link added before its stylesheet loaded, inlined once it has)
  {
    type: 3,
    timestamp: 3,
    data: {
      source: 0,
      texts: [],
      removes: [],
      adds: [],
      attributes: [{ id: 5, attributes: { href: `${HQ}/style.css`, _cssText: READ } }],
    },
  },
];
const linkIn = (json: string, id: number) => {
  let found: { attributes: Record<string, string> } | undefined;
  JSON.parse(json, function (_, value) {
    if (value?.tagName === 'link' && value.id === id) found = value;
    return value;
  });
  return found!.attributes;
};

test("a linked stylesheet the mirror has is replayed as its file, one it hasn't as the recorder's reading", async () => {
  const asked: string[] = [];
  const sheets = noSheets();
  const text = (address: string) => {
    asked.push(address);
    return Promise.resolve(FILES[address] ?? null);
  };
  const json = await sheeted(events, sheets, text);
  const file = `.shelf { background: url(${HQ}/look/wood.png); }\nhtml, body { margin: 0; font: 16px/1.4 var(--font); }`;
  assert.equal(linkIn(json, 3)._cssText, file);
  assert.equal(linkIn(json, 3).href, `${HQ}/style.css`);
  assert.equal(linkIn(json, 4)._cssText, 'p { color: red; }');
  assert.equal(JSON.parse(json)[2].data.attributes[0].attributes._cssText, file);
  // (the events themselves as they were, and each address asked for once)
  assert.equal(
    (events[0].data as { node: { childNodes: { childNodes: ReturnType<typeof link>[] }[] } }).node.childNodes[0]
      .childNodes[0].attributes._cssText,
    READ,
  );
  await sheeted(events, sheets, text);
  assert.deepEqual(asked, [`${HQ}/style.css`, 'https://elsewhere.test/look.css', `${HQ}/look/shelf.css`]);
});

test("a stylesheet's addresses made absolute against its own", () => {
  const css = `@import "parts/a.css"; .a { background: url('img/b.png') } .b { mask: url(data:image/svg+xml,x) }
    .c { background: url( "/c.webp" ) } .d { fill: url(#e) } .f { background: url(https://cdn.test/f.png) }`;
  assert.equal(
    absolute(css, `${HQ}/kits/k/hq/look.css`),
    `@import "${HQ}/kits/k/hq/parts/a.css"; .a { background: url('${HQ}/kits/k/hq/img/b.png') } .b { mask: url(data:image/svg+xml,x) }
    .c { background: url("${HQ}/c.webp") } .d { fill: url(#e) } .f { background: url(https://cdn.test/f.png) }`,
  );
});

test('a stylesheet that imports itself, or with a media list, keeps its @import', async () => {
  const self = `@import "style.css";\n@import url(print.css) print;\np { margin: 0; }`;
  const json = await sheeted(events.slice(0, 1), noSheets(), () => Promise.resolve(self));
  assert.match(linkIn(json, 3)._cssText, /@import url\(https:\/\/hq\.test\/print\.css\) print;/);
  assert.equal(linkIn(json, 3)._cssText.split('p { margin: 0; }').length, 6); // (itself four times over, and once)
});

test("a recording's stylesheets past what a mirror may hold fail, read a few at a time", async () => {
  const sheet = 'p { margin: 0; }'.repeat(4096);
  const many = (count: number, address: (n: number) => string) => [
    {
      type: 2,
      timestamp: 1,
      data: { node: { type: 0, id: 1, childNodes: [...Array(count).keys()].map(n => link(n + 2, address(n))) } },
    },
  ];
  let reading = 0,
    most = 0;
  const text = async () => {
    most = Math.max(most, ++reading);
    await new Promise(resolve => setTimeout(resolve, 1));
    reading--;
    return sheet;
  };
  // (one address's file in many links, each expanded; and many addresses of one file, each held)
  const over = Math.ceil(SHEETS_BYTES / sheet.length) + 1;
  await assert.rejects(
    sheeted(
      many(over, () => `${HQ}/style.css`),
      noSheets(),
      text,
    ),
    /over 16 MB/,
  );
  const sheets = noSheets();
  await assert.rejects(
    sheeted(
      many(over, n => `${HQ}/style.css?${n}`),
      sheets,
      text,
    ),
    /over 16 MB/,
  );
  assert.equal(most, READS);
  assert.ok(sheets.texts.size < over && sheets.bytes <= SHEETS_BYTES + READS * (sheet.length + 30), `${sheets.bytes}`);
  // (within it, as HQ's are)
  assert.match(
    await sheeted(
      many(8, n => `${HQ}/style.css?${n}`),
      noSheets(),
      text,
    ),
    /p \{ margin: 0; \}/,
  );
});
