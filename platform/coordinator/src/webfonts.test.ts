// node --test src/webfonts.test.ts
// The mirror's web fonts: Google's stylesheets of fonts and font files, typed by their address, fetched once each and
// nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEPT_BYTES, webFonts } from './webfonts.ts';

const CSS = 'https://fonts.googleapis.com/css2?family=Pixelify+Sans:wght@400;600&display=swap',
  TTF = 'https://fonts.gstatic.com/s/pixelifysans/v3/CHy2V-3HFUT7aC4iv1TxGDR9DHEserHN25py2TTp0H1Y.ttf';

// A stand-in for Google: each address's answer (a status, or a body size in bytes), and what was asked
function google(answers: Record<string, number | { status: number }>) {
  const asked: string[] = [];
  const get = (async (url: URL, init: RequestInit) => {
    asked.push(url.href);
    assert.equal(init.redirect, 'error');
    const answer = answers[url.href] ?? { status: 404 };
    if (typeof answer === 'number')
      return new Response(Buffer.alloc(answer, 'f'), { headers: { 'content-type': 'x/y' } });
    return new Response(null, { status: answer.status });
  }) as typeof fetch;
  return { asked, webFont: webFonts(get) };
}

test("Google's stylesheet of fonts and its font file are answered as text/css and font/ttf, each fetched once", async () => {
  const { asked, webFont } = google({ [CSS]: 300, [TTF]: 9000 });
  const css = await webFont(new URL(CSS), 1000);
  assert.equal(css?.type, 'text/css');
  assert.equal(css?.body.length, 300);
  assert.equal((await webFont(new URL(TTF), 1000))?.type, 'font/ttf');
  await webFont(new URL(CSS), 1000);
  await webFont(new URL(TTF), 1000);
  assert.deepEqual(asked, [CSS, TTF]);
});

test("any other address there or anywhere else isn't fetched; one Google doesn't have is null and asked again", async () => {
  const { asked, webFont } = google({});
  const others = [
    'https://fonts.googleapis.com/icon?family=Material+Icons',
    'https://fonts.gstatic.com/s/pixelifysans/v3/page.html',
    'https://fonts.gstatic.com/s/x/app.js',
    'http://fonts.gstatic.com/s/x/a.ttf',
    'https://fonts.gstatic.com:8443/s/x/a.ttf',
    'https://user@fonts.gstatic.com/s/x/a.ttf',
    'https://fonts.gstatic.com.example.com/s/x/a.ttf',
    'https://example.com/a.woff2',
  ];
  for (const other of others) assert.equal(await webFont(new URL(other), 1000), null, other);
  assert.deepEqual(asked, []);
  const missing = 'https://fonts.gstatic.com/s/gone/v1/a.woff2';
  assert.equal(await webFont(new URL(missing), 1000), null);
  assert.equal(await webFont(new URL(missing), 1000), null);
  assert.deepEqual(asked, [missing, missing]);
});

test('a file bigger than all that is kept fails, and past that much the oldest are fetched again', async () => {
  const font = (n: number) => `https://fonts.gstatic.com/s/f/v1/${n}.woff2`;
  const third = Math.floor(KEPT_BYTES / 3) - 100; // (and its address)
  const { asked, webFont } = google({
    [font(1)]: third,
    [font(2)]: third,
    [font(3)]: third,
    [font(4)]: third,
    [TTF]: KEPT_BYTES + 1,
  });
  await assert.rejects(webFont(new URL(TTF), 1000), /larger than 16 MB/);
  for (const n of [1, 2, 3, 4, 4, 2, 1]) await webFont(new URL(font(n)), 1000);
  assert.deepEqual(asked, [TTF, ...[1, 2, 3, 4, 1].map(font)]);
});

test('an answer is kept by its address, which counts with it: past that much the oldest go', async () => {
  const long = (n: number) => `${CSS}&text=${String(n).padStart(KEPT_BYTES / 4, '0')}`;
  const { asked, webFont } = google({ [long(1)]: 10, [long(2)]: 10, [long(3)]: 10, [long(4)]: 10 });
  for (const n of [1, 2, 3, 4, 2, 1]) await webFont(new URL(long(n)), 1000);
  assert.deepEqual(asked, [1, 2, 3, 4, 1].map(long));
});

test("an answer of Google's but a 404 fails, saying which", async () => {
  const { webFont } = google({ [CSS]: { status: 400 }, [TTF]: { status: 503 } });
  await assert.rejects(webFont(new URL(CSS), 1000), /^Error: 400 from fonts.googleapis.com$/);
  await assert.rejects(webFont(new URL(TTF), 1000), /^Error: 503 from fonts.gstatic.com$/);
});
