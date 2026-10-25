// CHROMIUM_PATH=… node --test shared/watchalong/mirror.test.ts  .
// The mirror in a real Chromium (skipped without one, or without the coordinator's node_modules: rrweb's replayer and
// sharp): what the recorded page carries never runs, and its canvas frames are still drawn.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Mirrors } from './mirror.ts';
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
    const start = Date.now();
    await mirrors.open(1, [...page(start), frame(start + 10, red)], NONE);
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
