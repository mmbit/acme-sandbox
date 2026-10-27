// CHROMIUM_PATH=… node --test shared/watchalong/mirror.test.ts  .
// The mirror in a real Chromium (skipped without one, or without the coordinator's node_modules: rrweb's replayer and
// sharp): what the recorded page carries never runs, and its canvas frames are still drawn.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { Mirrors, shown } from './mirror.ts';
import type { Asked } from '../chromium/chromium.ts';
import type { RecordedEvent } from './store.ts';

const COORDINATOR = new URL('../../platform/coordinator/', import.meta.url);
const REPLAY = new URL('node_modules/@rrweb/replay/dist/', COORDINATOR);
const skip =
  !process.env.CHROMIUM_PATH || !existsSync(REPLAY) ? "needs CHROMIUM_PATH and the coordinator's npm ci" : false;

const SHOP = 'https://shop.test';
const asked: string[] = [];
const mirrors = new Mirrors(REPLAY, ({ url }: Asked) => {
  asked.push(url);
  return Promise.resolve(null); // (nothing of the shop's: its picture fails to load)
});
after(() => mirrors.closeAll());
const NONE = () => false; // (no other origin to show)

// A page as rrweb records it: a picture whose onerror would ask for another, and a canvas
const element = (id: number, tagName: string, attributes: Record<string, string> = {}, childNodes: object[] = []) => ({
  id,
  type: 2,
  tagName,
  attributes,
  childNodes,
});
const page = (at: number): RecordedEvent[] => [
  { type: 4, timestamp: at, data: { href: `${SHOP}/`, width: 400, height: 300 } },
  {
    type: 2,
    timestamp: at,
    data: {
      initialOffset: { top: 0, left: 0 },
      node: {
        id: 1,
        type: 0,
        childNodes: [
          element(2, 'html', {}, [
            element(3, 'head'),
            element(4, 'body', { style: 'margin: 0' }, [
              element(5, 'img', { src: `${SHOP}/missing.png`, onerror: `new Image().src = '${SHOP}/ran.png'` }),
              element(6, 'canvas', { width: '400', height: '300', style: 'display: block' }),
            ]),
          ]),
        ],
      },
    },
  },
];
// A canvas frame as rrweb's canvas sampling sends it: a wipe and a picture
const frame = (at: number, png: Buffer): RecordedEvent => ({
  type: 3,
  timestamp: at,
  data: {
    source: 9,
    id: 6,
    type: 0,
    commands: [
      { property: 'clearRect', args: [0, 0, 400, 300] },
      {
        property: 'drawImage',
        args: [
          {
            rr_type: 'ImageBitmap',
            args: [
              {
                rr_type: 'Blob',
                data: [{ rr_type: 'ArrayBuffer', base64: png.toString('base64') }],
                type: 'image/png',
              },
            ],
          },
          0,
          0,
        ],
      },
    ],
  },
});

// (sharp, from the coordinator's node_modules: what this test uses of it)
type Image = { png(): Image; raw(): Image; toBuffer(): Promise<Buffer> };
type Sharp = (input: Buffer | { create: { width: number; height: number; channels: 3; background: string } }) => Image;

test(
  "a recorded page's own script never runs in the mirror, and its canvas frames are still drawn",
  { skip },
  async () => {
    const sharp = createRequire(COORDINATOR)('sharp') as Sharp;
    const red = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#ff0000' } })
      .png()
      .toBuffer();
    const blue = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#0000ff' } })
      .png()
      .toBuffer();
    const start = Date.now();
    await mirrors.open(1, [...page(start), frame(start + 5, blue), frame(start + 10, red)], NONE);
    const now = await mirrors.now(1, { long: 400 });
    assert.ok(now);
    const data = await sharp(now.bytes).raw().toBuffer();
    const middle = (150 * 400 + 200) * 3;
    assert.ok(
      data[middle] > 200 && data[middle + 1] < 60,
      `the canvas frame is drawn (${[...data.subarray(middle, middle + 3)]})`,
    );
    // a past moment, replayed at once, draws it too
    const past = await mirrors.at([...page(start), frame(start + 10, red)], start + 10, { long: 400 }, NONE);
    const pastData = (await sharp(past!.bytes).raw().toBuffer()).subarray(middle, middle + 3);
    assert.ok(pastData[0] > 200 && pastData[1] < 60, `a past moment's canvas is drawn (${[...pastData]})`);
    assert.ok(asked.includes(`${SHOP}/missing.png`), 'the picture was asked for, and failed');
    assert.ok(!asked.includes(`${SHOP}/ran.png`), 'its onerror never ran');
  },
);

test(
  'the pen ink is drawn over the screen: live as it is drawn, and at a past moment as far as it had gone',
  { skip },
  async () => {
    const sharp = createRequire(COORDINATOR)('sharp') as Sharp;
    const start = Date.now();
    const ink = (at: number, payload: Record<string, unknown>): RecordedEvent => ({
      type: 5,
      timestamp: at,
      data: { tag: 'ink', payload: { n: 1, id: 1, left: 0, top: 0, ...payload } },
    });
    // a blue line across the screen at y 100, its second half drawn 200 ms after its first
    const first = [
        [20, 100, 0.8, 0],
        [200, 100, 0.8, 100],
      ],
      second = [[380, 100, 0.8, 300]];
    const stroke = (points: number[][]) => ({ color: '#0000ff', size: 12, points });
    const drawing = [...page(start), ink(start + 10, { phase: 'start', stroke: stroke(first) })];
    await mirrors.open(2, drawing, NONE);
    const blueAt = async (picture: { bytes: Buffer } | undefined, x: number) => {
      const data = await sharp(picture!.bytes).raw().toBuffer();
      const [r, g, b] = data.subarray((100 * 400 + x) * 3, (100 * 400 + x) * 3 + 3);
      return b > 180 && r < 90 && g < 90;
    };
    const live = await mirrors.now(2, { long: 400 });
    assert.ok((await blueAt(live, 100)) && !(await blueAt(live, 300)), 'live: the line as far as it has been drawn');
    const ended = ink(start + 320, { phase: 'end', stroke: stroke([...first, ...second]) });
    mirrors.feed(2, [ended]);
    assert.ok(await blueAt(await mirrors.now(2, { long: 400 }), 300), 'and once it ends, all of it');
    const whole = [...drawing, ended];
    assert.ok(
      !(await blueAt(await mirrors.at(whole, start + 150, { long: 400 }, NONE), 300)),
      'a past moment: as far as by then',
    );
    assert.ok(
      await blueAt(await mirrors.at(whole, start + 400, { long: 400, png: true }, NONE), 300),
      'and after it, all (a PNG)',
    );
  },
);

test("a mirror opens with what the screen still shows: from the last full snapshot, each canvas's latest picture", () => {
  const png = Buffer.from('picture');
  const drawn = (at: number, id: number): RecordedEvent => ({
    type: 3,
    timestamp: at,
    data: { source: 9, id, type: 0, commands: [{ property: 'fillRect', args: [0, 0, 10, 10] }] },
  });
  const other = (at: number) => ({ ...frame(at, png), data: { ...(frame(at, png).data as object), id: 7 } });
  const ink = { type: 5, timestamp: 40, data: { tag: 'ink', payload: {} } };
  const events = [
    ...page(0),
    frame(10, png),
    ...page(20),
    frame(30, png),
    ink,
    drawn(45, 6),
    other(50),
    frame(60, png),
  ];
  assert.deepEqual(shown(events), [...page(20), ink, drawn(45, 6), other(50), frame(60, png)]);
  // a clear off the corner, or without area, wipes nothing: the picture before it stays. Each misses the rule by one
  // condition, so the test fails if any of them changes
  const clear = (at: number, args: number[]): RecordedEvent => ({
    type: 3,
    timestamp: at,
    data: { source: 9, id: 8, type: 0, commands: [{ property: 'clearRect', args }] },
  });
  const before = clear(65, [0, 0, 400, 300]);
  const partial = [
    [5, 0, 400, 300],
    [0, 5, 400, 300],
    [0, 0, 0, 300],
    [0, 0, 400, 0],
  ].map((args, i) => clear(70 + i, args));
  assert.deepEqual(shown([...page(0), before, ...partial]), [...page(0), before, ...partial]);
  // (no full snapshot yet: all of it)
  assert.deepEqual(shown([frame(10, png), frame(20, png)]), [frame(20, png)]);
});

test(
  "a picture never waits on what the screen doesn't show: a lazy picture below it or in a hidden part",
  { skip, timeout: 30_000 },
  async () => {
    const start = Date.now();
    const events = page(start);
    const body = (events[1].data as { node: { childNodes: { childNodes: { childNodes: object[] }[] }[] } }).node
      .childNodes[0].childNodes[1].childNodes;
    body.push(
      element(7, 'div', { style: 'height: 3000px' }),
      element(8, 'img', { src: `${SHOP}/below.png`, loading: 'lazy' }),
      element(9, 'div', { style: 'display: none' }, [
        element(10, 'img', { src: `${SHOP}/hidden.png`, loading: 'lazy' }),
      ]),
    );
    await mirrors.open(3, events, NONE);
    assert.ok(await mirrors.now(3, { long: 400 }), 'the screen now');
    assert.ok(await mirrors.at(events, start, { long: 400 }, NONE), 'and a past moment');
    assert.equal(mirrors.seen(3), true);
  },
);

test(
  'a live mirror still answers while another opens after it (each tab its own window)',
  { skip, timeout: 30_000 },
  async () => {
    const start = Date.now();
    await mirrors.open(4, page(start), NONE);
    await mirrors.open(5, page(start), NONE);
    assert.ok(await mirrors.now(4, { long: 400 }), 'the first');
    assert.ok(await mirrors.now(5, { long: 400 }), 'and the second');
  },
);

// A recording the replay can't take in: an ink stroke whose colour can't be read as text, which the ink throws on
const unreadable = (at: number): RecordedEvent => ({
  type: 5,
  timestamp: at,
  data: { tag: 'ink', payload: { n: 1, id: 1, phase: 'start', stroke: { color: { toString: 0 } } } },
});

test(
  "a mirror whose step fails isn't seen and is gone, and opens again from the recording when next asked for",
  { skip, timeout: 30_000 },
  async () => {
    const start = Date.now();
    await mirrors.open(6, page(start), NONE);
    mirrors.feed(6, [unreadable(start + 10)]);
    while (mirrors.seen(6) !== false) await sleep(20);
    assert.equal(mirrors.has(6), false, 'a batch it failed on closed it');
    await mirrors.open(6, page(start), NONE);
    assert.ok(await mirrors.now(6, { long: 400 }), 'opened again, it answers');
    assert.equal(mirrors.seen(6), true);
    // and the same when it fails as it opens
    await assert.rejects(mirrors.open(7, [...page(start), unreadable(start + 10)], NONE));
    assert.equal(mirrors.seen(7), false);
    assert.equal(mirrors.has(7), false);
  },
);

// Chromium's process, gone within a few seconds
async function exited(pid: number | undefined) {
  assert.ok(pid);
  for (let tries = 0; tries < 100; tries++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await sleep(50);
  }
  return false;
}

test(
  "a mirror's tab closes once its time runs out: one hanging when its mirror was closed, one whose page never opened, or a live one's step",
  { skip, timeout: 90_000 },
  async () => {
    const folder = mkdtempSync(join(tmpdir(), 'mirror-test-'));
    after(() => rmSync(folder, { recursive: true, force: true }));
    // a stand-in for rrweb's replayer
    const replay = (name: string, script: string) => {
      mkdirSync(join(folder, name));
      writeFileSync(join(folder, name, 'replay.js'), script);
      writeFileSync(join(folder, name, 'style.css'), '');
      return pathToFileURL(join(folder, name, '/'));
    };
    const start = Date.now();
    // the page opens, and a step hangs (no frame ever comes); its mirror is closed before its time runs out
    const stuck = new Mirrors(
      replay('stuck', 'window.requestAnimationFrame = () => 0; export class Replayer { startLive() {} addEvent() {} }'),
      () => Promise.resolve(null),
    );
    const opening = stuck.open(1, page(start), NONE);
    await sleep(3_000);
    const pid = await stuck.pid();
    await stuck.close(1);
    await assert.rejects(opening, /took over/);
    assert.ok(await exited(pid), 'its tab closed, and Chromium with it');
    assert.equal(await stuck.pid(), undefined);
    // the page never opens: a past moment's request ends at its time, and Chromium closes
    const broken = new Mirrors(replay('broken', "throw new Error('no replayer');"), () => Promise.resolve(null));
    const past = broken.at(page(start), start, { long: 400 }, NONE);
    await sleep(1_000);
    const brokenPid = await broken.pid();
    await assert.rejects(past, /took over/);
    assert.ok(await exited(brokenPid), 'its tab closed, and Chromium with it');
    // a live mirror's step hangs (its page's frames stop once a batch with a change comes): it isn't seen and is gone,
    // its tab closed, and it opens again from the recording
    const hanging = new Mirrors(
      replay(
        'hanging',
        'export class Replayer { startLive() {} addEvent(event) { if (event.type === 3) window.requestAnimationFrame = () => 0; } }',
      ),
      () => Promise.resolve(null),
    );
    await hanging.open(1, page(start), NONE);
    assert.equal(hanging.seen(1), true);
    const hangingPid = await hanging.pid();
    hanging.feed(1, [{ type: 3, timestamp: start + 10, data: { source: 2 } }]);
    while (hanging.seen(1) !== false) await sleep(100);
    assert.equal(hanging.has(1), false, 'its step ran out of time and closed it');
    assert.ok(await exited(hangingPid), 'its tab closed, and Chromium with it');
    await hanging.open(1, page(start), NONE);
    assert.equal(hanging.seen(1), true, 'opened again, it is seen');
    await hanging.closeAll();
  },
);

// What changes after a live mirror opens is on its screen: a box added (rrweb
// played every live event as a fast-forward into its virtual DOM, and the screen kept the page as the share found it),
// shown as it ends its fade in (rrweb holds a page's CSS animations where they start), at the screen's size since; and
// a past moment at its own size.
test(
  "what changed after a live mirror opened is shown, faded in, at the screen's new size; a past moment at its size",
  { skip },
  async () => {
    const sharp = createRequire(COORDINATOR)('sharp') as Sharp;
    const start = Date.now();
    const box = element(7, 'div', {
      style: 'position: absolute; left: 0; top: 0; width: 100%; height: 100%; background: #00ff00; animation: in 60s',
    });
    const keyframes = element(8, 'style', {}, [
      { id: 9, type: 3, textContent: '@keyframes in { from { opacity: 0 } to { opacity: 1 } }', isStyle: true },
    ]);
    const later: RecordedEvent[] = [
      {
        type: 3,
        timestamp: start + 20,
        data: {
          source: 0,
          texts: [],
          attributes: [],
          removes: [],
          adds: [
            { parentId: 3, nextId: null, node: keyframes },
            { parentId: 4, nextId: null, node: box },
          ],
        },
      },
      { type: 3, timestamp: start + 30, data: { source: 4, width: 300, height: 400 } },
    ];
    const green = async (picture: { bytes: Buffer; width: number; height: number } | undefined) => {
      const data = await sharp(picture!.bytes).raw().toBuffer();
      const at = (Math.round(picture!.height / 2) * picture!.width + Math.round(picture!.width / 2)) * 3;
      const [r, g, b] = data.subarray(at, at + 3);
      return g > 200 && r < 60 && b < 60;
    };
    await mirrors.open(8, page(start), NONE);
    mirrors.feed(8, later);
    const live = await mirrors.now(8, { long: 400 });
    assert.deepEqual([live?.width, live?.height], [300, 400], "live: the screen's new size");
    assert.ok(await green(live), 'live: the box added since it opened, faded in');
    const past = await mirrors.at([...page(start), ...later], start + 40, { long: 400 }, NONE);
    assert.deepEqual([past?.width, past?.height], [300, 400], "a past moment: the screen's size then");
    assert.ok(await green(past), 'a past moment: the box, faded in');
  },
);

// A stroke on a surface whose dry ink is in recorded canvas pictures (the
// Sketchbook's page) is drawn where it was drawn only until a canvas picture after it holds it: the page may have moved
// since (the window narrowed, the page turned), and the ink stayed over HQ.
test('a pictured stroke is drawn over the screen until a canvas picture after it holds it', { skip }, async () => {
  const sharp = createRequire(COORDINATOR)('sharp') as Sharp;
  const red = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#ff0000' } })
    .png()
    .toBuffer();
  const start = Date.now();
  const stroke = {
    color: '#0000ff',
    size: 12,
    points: [
      [20, 100, 0.8, 0],
      [380, 100, 0.8, 100],
    ],
  };
  const ink = (at: number, payload: Record<string, unknown>): RecordedEvent => ({
    type: 5,
    timestamp: at,
    data: { tag: 'ink', payload: { n: 1, id: 1, left: 0, top: 0, stroke, ...payload } },
  });
  const blueAt = async (picture: { bytes: Buffer } | undefined) => {
    const data = await sharp(picture!.bytes).raw().toBuffer();
    const [r, g, b] = data.subarray((100 * 400 + 200) * 3, (100 * 400 + 200) * 3 + 3);
    return b > 180 && r < 90 && g < 90;
  };
  await mirrors.open(
    9,
    [...page(start), ink(start + 10, { phase: 'start' }), ink(start + 110, { phase: 'end', pictured: true })],
    NONE,
  );
  assert.ok(await blueAt(await mirrors.now(9, { long: 400 })), 'drawn until a picture holds it');
  mirrors.feed(9, [frame(start + 150, red)]);
  assert.ok(await blueAt(await mirrors.now(9, { long: 400 })), 'a picture taken as it ended may not hold it yet');
  mirrors.feed(9, [frame(start + 500, red)]);
  assert.ok(!(await blueAt(await mirrors.now(9, { long: 400 }))), 'a picture after it holds it: not drawn again');
});
