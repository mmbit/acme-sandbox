// node --test shared/watchalong/frames.test.ts (needs Playwright Chromium).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openPage, playwright } from '../browser/browser.mjs';

const HQ = 'http://hq.test';
const PREVIEW = 'http://preview.test';
const PUBLIC = 'http://public.test';
const PARENT = `<!doctype html><iframe src="${PUBLIC}/"></iframe><script type="module">
import { frames } from '/frames.js';
import * as notebook from '/notebooklink.js';
const frame = document.querySelector('iframe');
window.notes = [];
window.recordings = [];
notebook.mountFrames(window, { frames: () => [frame.contentWindow], trusts: origin => origin === '${PREVIEW}' });
notebook.on('message', note => window.notes.push(note));
addEventListener('message', event => {
  if (event.data?.type === 'rrweb') window.recordings.push(event.data);
});
window.frameChannels = frames();
</script>`;
const CHILD = `<!doctype html><script>
const note = { hq: 'notebook', kind: 'context', detail: 'from the frame', origin: '${PREVIEW}' };
parent.postMessage(note, '*');
addEventListener('message', event => {
  if (event.data?.watchalong !== 'start') return;
  const port = event.ports[0];
  for (const message of [
    note,
    { hq: 'review', hello: 1 },
    { hq: 'review', callMark: { at: 1 } },
    { hq: 'deck', open: 'elsewhere' },
    { hq: 'book:scrap', text: 'scrap' },
    { onlyonery: 'message' },
    { mic: 'start' },
  ]) port.postMessage({ ...message, origin: '${PREVIEW}' });
  port.postMessage({ ...note, type: 'rrweb', event: { probe: 'recording' }, onlyonery: 'message', mic: 'start', isCheckout: true });
});
</script>`;

test('a public frame cannot use the recording channel to impersonate a trusted notebook or HQ message', async () => {
  const browser = await playwright().chromium.launch();
  const { page, context, errors } = await openPage(browser);
  try {
    await context.route('http://**/*', async (route: any) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/')
        return route.fulfill({ contentType: 'text/html', body: url.origin === HQ ? PARENT : CHILD });
      const file =
        url.pathname === '/frames.js'
          ? new URL('./frames.js', import.meta.url)
          : new URL('../../platform/hq/shell/ink/notebooklink.js', import.meta.url);
      return route.fulfill({ contentType: 'text/javascript', body: await readFile(file) });
    });
    await page.goto(HQ);
    await page.waitForFunction(() => (window as any).frameChannels);
    await page.evaluate(() => (window as any).frameChannels.startAll('hidden'));
    await page.waitForFunction(() => (window as any).recordings.length > 0);
    const received = await page.evaluate(() => ({
      notes: (window as any).notes,
      recordings: (window as any).recordings,
    }));
    assert.deepEqual(received.notes, [], 'neither direct public messages nor port messages can claim preview trust');
    assert.deepEqual(
      received.recordings,
      [{ type: 'rrweb', event: { probe: 'recording' }, origin: PREVIEW }],
      'the recorder receives only rrweb fields, with no other protocol keys',
    );
    await page.evaluate(() => (window as any).frameChannels.stopAll());
    await page.frames()[1].goto(PREVIEW);
    await page.waitForFunction(() => (window as any).notes.length > 0);
    assert.deepEqual(
      await page.evaluate(() => (window as any).notes),
      [{ kind: 'context', detail: 'from the frame', from: 'artifact' }],
      'a browser-authenticated preview message still reaches the notebook',
    );
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    await browser.close();
  }
});
