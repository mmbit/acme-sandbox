// node shared/deck/build.test.mjs
// The build's posters: it makes one for a video the spec gives none, removes only the ones it made that nothing uses,
// keeps a poster the spec names in posters/ (even one named like a made one), and touches nothing when the build fails.
// Then that the checks can tell a page built on an old kit from one built on today's.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stale } from './inlined.mjs';

const build = join(dirname(fileURLToPath(import.meta.url)), 'build.mjs');
const dir = mkdtempSync(join(tmpdir(), 'deck-test-')), posters = join(dir, 'posters');
mkdirSync(join(dir, 'media')); mkdirSync(posters);
const clip = (name, color) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=${color}:s=90x160:d=0.2`, '-pix_fmt', 'yuv420p', join(dir, 'media', name)]);
clip('a.mp4', 'red'); clip('b.mp4', 'blue'); clip('c.mp4', 'green');
const jpg = (file) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=gold:s=90x160', '-frames:v', '1', join(posters, file)]);
jpg('mine.jpg'); jpg('cover-0123abcd.jpg'); jpg('old-deadbeef.jpg'); jpg('notes.jpg');
const spec = (extra = []) => writeFileSync(join(dir, 'deck.json'), JSON.stringify({ title: 'Test', sfx: false, slides: [
  { title: 'Own poster', media: { video: 'media/a.mp4', poster: 'posters/mine.jpg' } },
  { title: 'Own poster, named like a made one', media: { video: 'media/b.mp4', poster: 'posters/cover-0123abcd.jpg' } },
  { title: 'Made poster', media: { video: 'media/c.mp4' } }, ...extra] }));
const run = () => spawnSync('node', [build, join(dir, 'deck.json')], { encoding: 'utf8' });

// A failed build (a missing file) removes nothing.
spec([{ title: 'Missing', media: { image: 'media/gone.png' } }]);
let r = run();
assert.equal(r.status, 2, r.stderr);
assert.ok(existsSync(join(posters, 'old-deadbeef.jpg')), 'a failed build removed a poster');

// A clean build keeps the spec's posters and anything it didn't make, and removes the made one nothing uses.
spec();
r = run();
assert.equal(r.status, 0, r.stderr);
const left = readdirSync(posters).sort(), made = left.filter((f) => /^c-[0-9a-f]{8}\.jpg$/.test(f));
assert.equal(made.length, 1, `no poster made for c.mp4: ${left}`);
assert.deepEqual(left, ['cover-0123abcd.jpg', made[0], 'mine.jpg', 'notes.jpg'].sort());
const page = readFileSync(join(dir, 'index.html'), 'utf8');
for (const p of ['posters/mine.jpg', 'posters/cover-0123abcd.jpg', `posters/${made[0]}`]) assert.ok(page.includes(`poster="${p}"`), `index.html lacks ${p}`);

// Building again changes nothing.
assert.equal(run().status, 0);
assert.deepEqual(readdirSync(posters).sort(), left);

// Two pictures: a phone and a photo overlap (duo); two photos, a now and a proposed, sit side by side (pair).
writeFileSync(join(dir, 'deck.json'), JSON.stringify({ title: 'Two', sfx: false, slides: [
  { title: 'Duo', media: [{ video: 'media/a.mp4', poster: 'posters/mine.jpg' }, { image: 'posters/notes.jpg' }] },
  { title: 'Pair', media: [{ image: 'posters/mine.jpg', label: 'Now' }, { image: 'posters/notes.jpg', label: 'Proposed' }] }] }));
assert.equal(run().status, 0);
const two = readFileSync(join(dir, 'index.html'), 'utf8');
assert.deepEqual(two.match(/class="vis[^"]*"/g), ['class="vis duo"', 'class="vis pair"']);

// A page carries today's kit, deck.js and deck.css (with sounds or without), and one built on an older kit is told apart
assert.deepEqual(stale(readFileSync(join(dir, 'index.html'), 'utf8')), []);
writeFileSync(join(dir, 'deck.json'), JSON.stringify({ title: 'Sounds', slides: [{ title: 'One' }, { title: 'Two' }] }));
assert.equal(run().status, 0);
const withKit = readFileSync(join(dir, 'index.html'), 'utf8');
assert.deepEqual(stale(withKit), []);
assert.deepEqual(stale(withKit.replace('function render(', 'function renderOld(')), ['kit']);
rmSync(dir, { recursive: true });
console.log('ok: posters made, kept and removed as they should be; two pictures overlap or pair; a page on an old kit is told apart');
