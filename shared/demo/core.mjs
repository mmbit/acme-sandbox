// The demo kit's frame engine, shared by ad.mjs, present.mjs and record.mjs.
// An HTML page exposes window.frame(t); we seek it frame by frame in headless Chromium, screenshot
// each frame and pipe the JPEGs into ffmpeg. Pages are served from the repo root, by a tiny server or to a browser's
// requests (answer), which also hands out single frames of MP4s (/__clip), because Playwright's Chromium can't decode
// H.264. In a job, render() draws the frames on a machine the board lends (away.mjs).
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { resolve, extname, dirname, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { noteRender } from './renders.mjs';
import { playwright } from '../browser/browser.mjs';
import { pricesFor } from './prices.mjs';
import * as drawn from './drawn.mjs';

export const HERE = dirname(new URL(import.meta.url).pathname);
export const ROOT = (() => { try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return process.cwd(); } })();

export { playwright };

// --key value / --flag / positionals. Numbers stay strings; callers convert.
export function args(argv = process.argv.slice(2)) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const [k, v] = a.slice(2).split('=', 2);
    if (v !== undefined) o[k] = v;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) o[k] = argv[++i];
    else if (k.startsWith('no-')) o[k.slice(3)] = false;
    else o[k] = true;
  }
  return o;
}

export function probe(file) {
  const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]).toString());
  const v = j.streams.find((s) => s.codec_type === 'video'), a = j.streams.find((s) => s.codec_type === 'audio');
  const [n, d] = (v?.avg_frame_rate || '0/1').split('/').map(Number);
  return { duration: Number(j.format.duration), fps: d ? n / d : 0, width: v?.width, height: v?.height,
    frames: v?.nb_frames ? Number(v.nb_frames) : 0, audio: !!a, size: Number(j.format.size), bitrate: Number(j.format.bit_rate) };
}

// Beat grid for a WAV: <name>.beats.json next to it (chime's synth.mjs writes one), else a plain bpm grid.
export function beatsFor(audio, bpm, offset = 0) {
  const f = audio && audio.replace(/\.[^.]+$/, '.beats.json');
  if (f && existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  return bpm ? { bpm: Number(bpm), beatsPerBar: 4, offset: Number(offset) } : null;
}

export const urlPath = (file) => '/' + relative(ROOT, resolve(file)).split('/').map(encodeURIComponent).join('/');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.wav': 'audio/wav', '.webm': 'video/webm', '.mp4': 'video/mp4' };

// Frames of an MP4 as JPEGs, extracted once per (file, height) into a temp cache.
const clips = new Map();
function clipFrames(file, h) {
  const st = statSync(file);
  const key = createHash('sha1').update(`${file}:${st.size}:${st.mtimeMs}:${h}`).digest('hex').slice(0, 16);
  if (!clips.has(key)) clips.set(key, (async () => {
    const dir = join(tmpdir(), 'demo-clips', key);
    if (!existsSync(join(dir, 'done'))) {
      mkdirSync(dir, { recursive: true });
      const vf = h ? ['-vf', `scale=-2:${h}:flags=lanczos`] : [];
      await run('ffmpeg', ['-v', 'error', '-y', '-i', file, ...vf, '-q:v', '2', join(dir, '%06d.jpg')]);
      await run('sh', ['-c', `touch '${join(dir, 'done')}'`]);
    }
    const info = probe(file);
    return { dir, fps: info.fps, duration: info.duration, width: info.width, height: info.height,
      frames: readdirSync(dir).filter((f) => f.endsWith('.jpg')).length };
  })());
  return clips.get(key);
}

export function run(cmd, argv, opts = {}) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, argv, { stdio: ['ignore', 'inherit', 'inherit'], ...opts });
    p.on('error', fail);
    p.on('close', (c) => (c === 0 ? ok() : fail(new Error(`${cmd} exited ${c}`))));
  });
}

// A repo path from a URL path, or an error: nothing outside ROOT (a sibling like ROOT-private included).
function inRepo(path) {
  const p = resolve(ROOT, '.' + decodeURIComponent(String(path ?? '')));
  if (p !== ROOT && !p.startsWith(ROOT + sep)) throw new Error('outside repo');
  return p;
}

// A request's answer, { status, type, body }: a repo file, the runtime or a clip's frame, a 404 for anything else. A file
// a render on a lent machine needs but wasn't sent is noted (away.mjs) before its 404.
async function answer(url) {
  try {
    const u = new URL(url, 'http://x');
    if (u.pathname === '/__clip' || u.pathname === '/__clipinfo') {
      const c = await clipFrames(drawn.requireSent(inRepo(u.searchParams.get('src'))), Number(u.searchParams.get('h')) || 0);
      if (u.pathname === '/__clipinfo') return { status: 200, type: TYPES['.json'], body: JSON.stringify({ ...c, dir: undefined }) };
      const f = Math.max(0, Math.min(c.frames - 1, Number(u.searchParams.get('f')) || 0));
      return { status: 200, type: 'image/jpeg', body: readFileSync(join(c.dir, String(f + 1).padStart(6, '0') + '.jpg')) };
    }
    const file = u.pathname === '/__demo/runtime.js' ? join(HERE, 'runtime.js') : drawn.requireSent(inRepo(u.pathname));
    return { status: 200, type: TYPES[extname(file)] || 'application/octet-stream', body: readFileSync(file) };
  } catch (e) { return { status: 404, type: 'text/plain', body: String(e.message) }; }
}

export function serve() {
  const server = createServer(async (req, res) => {
    const { status, type, body } = await answer(req.url);
    res.writeHead(status, { 'content-type': type, ...(type === 'image/jpeg' ? { 'cache-control': 'max-age=3600' } : {}) });
    res.end(body);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

// A browser context whose requests to ORIGIN the repo answers, with no server: a run on a lent machine may open no
// socket. localhost, so the page is a secure context, as on a server of its own
const ORIGIN = 'http://localhost';
async function servedContext(browser, options) {
  const ctx = await browser.newContext(options);
  await ctx.route(`${ORIGIN}/**`, async (route) => {
    const { status, type, body } = await answer(route.request().url());
    await route.fulfill({ status, contentType: type, body });
  });
  return ctx;
}

// ffmpeg reading JPEG frames on stdin. Returns { write(buf), drained(), end() }.
// square ({ side, film, over, under }): each frame scaled to film x side px in the middle of a side x side square, its
// side edges fading over FEATHER px into what's around it: `under` (a PNG of the whole square), or without one the film's
// own outermost columns stretched to the edges and softened, so the sides follow the film. `over` (a PNG) goes on top.
export function encoder(out, { fps, audio, audioStart = 0, loop = false, duration, crf = 22, maxrate = '6M', level = '4.1', fadeOut = 0.5, tune, square } = {}) {
  mkdirSync(dirname(resolve(out)), { recursive: true });
  const a = [];
  if (audio) a.push(...(loop ? ['-stream_loop', '-1'] : []), '-ss', String(audioStart), '-i', audio); // loop: a bed shorter than the video repeats
  const af = audio ? ['-af', `afade=t=in:d=0.03,afade=t=out:st=${Math.max(0, duration - fadeOut)}:d=${fadeOut}`, '-c:a', 'aac', '-b:a', '192k', '-t', String(duration)] : [];
  const colour = 'scale=out_color_matrix=bt709:out_range=tv';
  const video = square ? squareGraph(square, audio ? 2 : 1) : ['-map', '0:v', '-vf', colour];
  const argv = ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-', ...a,
    ...video, ...(audio ? ['-map', '1:a'] : []),
    '-c:v', 'libx264', '-preset', 'medium', ...(tune ? ['-tune', tune] : []), '-crf', String(crf), '-maxrate', maxrate, '-bufsize', String(parseFloat(maxrate) * 2) + 'M',
    '-profile:v', 'high', '-level:v', level, '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-r', String(fps), ...af, '-movflags', '+faststart', out];
  const p = spawn('ffmpeg', argv, { stdio: ['pipe', 'inherit', 'inherit'] });
  // A dead ffmpeg (bad args, disk full, killed) must fail the render, never hang it: closed rejects
  // unless ffmpeg exits 0 after end(), and write()/drained() rethrow once it has died.
  let ended = false, dead = null;
  const closed = new Promise((ok, fail) => {
    p.on('error', fail);
    p.on('close', (c, sig) => (c === 0 && ended ? ok() : fail(new Error(`ffmpeg exited ${c ?? sig}${ended ? '' : ' before the last frame'} (${out})`))));
  });
  closed.catch((e) => { dead = e; });
  p.stdin.on('error', () => {}); // EPIPE when ffmpeg dies; closed carries the real error
  return {
    write(buf) { if (dead) throw dead; p.stdin.write(buf); },
    // Checked at call time, so a drain that already happened can't be missed.
    drained: () => (dead ? Promise.reject(dead) : p.stdin.writableNeedDrain ? Promise.race([once(p.stdin, 'drain'), closed]) : null),
    end: () => { ended = true; p.stdin.end(); return closed; },
  };
}

// The square's inputs (the PNGs, after the frames and the audio: the first at input `first`) and its filter graph. Each
// PNG is one frame that the overlay holds for the whole film.
const FEATHER = 32; // px of the film's side edges that fade into the sides
function squareGraph({ side, film, over, under }, first) {
  const half = side / 2, soft = 'gblur=sigma=8:sigmaV=70'; // a side: the film's outermost 2 px stretched, then softened
  const sides = under
    ? `[edge]scale=${side}:${side}[blank];[blank][${first + 1}:v]overlay=0:0[sides]`
    : `[edge]split[a][b];[a]crop=2:ih:0:0,scale=${half}:ih,${soft}[left];[b]crop=2:ih:iw-2:0,scale=${half}:ih,${soft}[right];[left][right]hstack[sides]`;
  const mask = `color=c=white:s=${film}x${side}:d=0.04,format=gray,geq=lum='255*clip(min(X,W-1-X)/${FEATHER},0,1)'[mask]`;
  const graph = [`[0:v]scale=${film}:${side}:flags=lanczos,split[film][edge]`, sides, mask, '[film][mask]alphamerge[faded]',
    '[sides][faded]overlay=(W-w)/2:0[square]', `[square][${first}:v]overlay=0:0,scale=out_color_matrix=bt709:out_range=tv,setsar=1[v]`];
  return ['-i', over, ...(under ? ['-i', under] : []), '-filter_complex', graph.join(';'), '-map', '[v]'];
}

const LABEL = 'Made with AI';
const MAX_RENDER_PAGES = 4;

// Render a seekable page to an MP4. config is handed to the page as window.demo (see runtime.js).
// format 'square' (ad.mjs's second film) seeks the same page with its social-only bits hidden and sets each frame in
// the middle of a square: its sides follow the film's own edges, or are `fill` (any CSS background), and the label goes
// on the square (squareLayers). recipe is the command noted in the file's .render.json. prices: the keys of the prices
// the page shows, today's in its language `lang` (prices.mjs), handed to it as demo.price(key) and noted with the recipe.
// In a job, a lent machine draws it (away.mjs), and there shown has the prices, read where the job runs, and the film
// gets no note: the job notes it once it's back.
export async function render(options) {
  if (drawn.sends()) return (await import('./away.mjs')).send(options);
  const { page: pageUrl, out, width, height, fps = 30, duration, audio, audioStart = 0, loop, beats, label = LABEL,
    labelPos = 'top-left', labelInset, data, workers, crf, maxrate, level, tune, format = width > height ? 'landscape' : 'vertical', fill, recipe,
    prices: keys, lang, shown, social = true } = options;
  const frames = Math.round(duration * fps);
  // Keep page count and frame assignment fixed because Chromium layer promotion and tile reuse depend on each page's
  // previous frames.
  const W = Math.max(1, Math.min(Math.floor(Number(workers) || MAX_RENDER_PAGES), MAX_RENDER_PAGES, frames));
  const { chromium } = playwright();
  const browser = await chromium.launch({ args: ['--font-render-hinting=none', '--disable-lcd-text', '--hide-scrollbars'] });
  const prices = shown ?? await pricesFor(keys, lang);
  const cfg = { fps, duration, width, height, beats, audioStart, label: format === 'square' ? '' : label, labelPos, labelInset, data, format,
    social: format !== 'square' && social, prices: Object.fromEntries(prices.map((p) => [p.key, p.text])) };
  const runtime = readFileSync(join(HERE, 'runtime.js'), 'utf8');
  const pages = await Promise.all(Array.from({ length: W }, async () => {
    const ctx = await servedContext(browser, { viewport: { width, height }, deviceScaleFactor: 1 });
    await ctx.addInitScript(`window.__demoConfig=${JSON.stringify(cfg)};\n${runtime}`);
    const p = await ctx.newPage();
    p.on('pageerror', (e) => console.error('page error:', e.message));
    p.on('console', (m) => m.type() === 'error' && console.error('page console:', m.text()));
    await p.goto(ORIGIN + pageUrl, { waitUntil: 'load' });
    await p.evaluate(() => window.demo.ready());
    return { p, cdp: await ctx.newCDPSession(p) };
  }));
  // the square's one label: a scene that draws its own (data-ai-label, hidden there) lends it its words
  const own = format === 'square' && await pages[0].p.evaluate(() => document.querySelector('[data-ai-label]')?.textContent.trim());
  const square = format === 'square'
    ? await squareLayers(browser, { width, height, fill, label: own || label, labelPos, runtime, base: ORIGIN + pageUrl }) : null;
  const enc = encoder(out, { fps, audio, audioStart, loop, duration, crf, maxrate, level, tune, square });
  let written = 0, t0 = Date.now(), last = 0;
  const done = new Map(), waiting = [];
  const flush = () => {
    while (done.has(written)) { enc.write(done.get(written)); done.delete(written); written++; }
    waiting.splice(0).forEach((r) => r());
    if (Date.now() - last > 500 || written === frames) {
      last = Date.now();
      process.stderr.write(`\r  ${out}: frame ${written}/${frames} (${(written / ((Date.now() - t0) / 1000)).toFixed(1)} fps)   `);
    }
  };
  try {
    await Promise.all(pages.map(async ({ p, cdp }, k) => {
      for (let i = k; i < frames; i += W) {
        await enc.drained();
        while (i - written > W * 3) await new Promise((r) => waiting.push(r));
        await p.evaluate((t) => window.demo.seek(t), i / fps);
        const { data: b64 } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 92, optimizeForSpeed: true });
        done.set(i, Buffer.from(b64, 'base64'));
        flush();
      }
    }));
    await enc.end();
    process.stderr.write('\n');
  } finally {
    await browser.close();
    if (square) rmSync(dirname(square.over), { recursive: true, force: true });
  }
  if (!drawn.drawing()) noteRender(out, recipe, undefined, prices); // its .render.json, committed in its place (renders.mjs)
  return rendered(out, t0);
}

// The film's size and length, said with how long it took
export function rendered(out, t0, where = '') {
  const info = probe(out);
  console.log(`${out}: ${info.width}x${info.height}, ${info.duration.toFixed(2)} s, ${(info.size / 1e6).toFixed(2)} MB, ${(info.bitrate / 1e6).toFixed(2)} Mbps (${((info.size / 1e6) / (info.duration / 60)).toFixed(1)} MB/min), rendered in ${((Date.now() - t0) / 1000).toFixed(0)} s${where}`);
  return info;
}

// A square film's pictures, drawn by Chromium as PNGs the size of the square: `over`, the AI label in the square's
// corner at full size, and `under` with a `fill` (any CSS background; a url() is the scene's).
async function squareLayers(browser, { width, height, fill, label, labelPos, runtime, base }) {
  const side = width, film = 2 * Math.round((side * width) / height / 2);
  const ctx = await servedContext(browser, { viewport: { width: side, height: side }, deviceScaleFactor: 1 });
  await ctx.addInitScript(`window.__demoConfig=${JSON.stringify({ width: side, height: side, label, labelPos })};\n${runtime}`);
  const p = await ctx.newPage();
  await p.setContent(`<base href="${base}"><style>html,body{margin:0;background:transparent}</style>`);
  const dir = mkdtempSync(join(tmpdir(), 'demo-square-')), over = join(dir, 'over.png'), under = fill && join(dir, 'under.png');
  if (fill) {
    const known = await p.evaluate((f) => { document.body.style.background = f; return !!document.body.style.background; }, fill);
    if (!known) throw new Error(`the square's fill isn't a CSS background: ${JSON.stringify(fill)}`);
    await p.waitForLoadState('networkidle');
    await p.screenshot({ path: under });
    await p.evaluate(() => { document.body.style.background = ''; });
  }
  await p.evaluate(() => window.demo.seek(0)); // draws the label
  await p.screenshot({ path: over, omitBackground: true });
  await ctx.close();
  return { side, film, over, under };
}

// A scene/manifest can carry its own settings: <script type="application/json" id="demo">{...}</script>.
export function inlineConfig(htmlFile) {
  const m = readFileSync(htmlFile, 'utf8').match(/<script[^>]*id=["']demo["'][^>]*>([\s\S]*?)<\/script>/);
  return m ? JSON.parse(m[1]) : {};
}
