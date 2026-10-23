#!/usr/bin/env node
// Checks foley.js end to end: the same sound renders identically every time and in the browser as in Node,
// pitch moves every sound, no sound is harsh (harsh.mjs) nor any the company's products play, every built deck carries
// this foley.js, and in Chromium the player stays silent until a gesture, plays after one, and its mute toggle silences
// what is playing or scheduled and is remembered, and a listening piece's loops, prepared takes and stop(destination) work,
// and a take rendered elsewhere (renderTake) and kept (sfx.keep) plays without a render.
//   node shared/demo/foley-check.mjs
import { createHash } from 'node:crypto';
import { render, renderTake, SOUNDS } from './foley.js';
import { kitSounds, productSounds, productFiles, harshness, BARS } from './harsh.mjs';
import { serve, playwright, ROOT } from './core.mjs';
import { listenTo } from '../browser/browser.mjs';
import { builtDecks, rebuild } from '../deck/inlined.mjs';

let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`); if (!ok) failed++; };
const hash = s => createHash('sha1').update(Buffer.from(s.L.buffer)).update(Buffer.from(s.R.buffer)).digest('hex').slice(0, 12);

// 1. deterministic in Node, and every sound renders clean
for (const name of Object.keys(SOUNDS)) {
  const a = render(name, { seed: 3 }, 44100), b = render(name, { seed: 3 }, 44100), c = render(name, { seed: 4 }, 44100);
  let pk = 0, bad = false; for (let i = 0; i < a.L.length; i++) { const v = Math.max(Math.abs(a.L[i]), Math.abs(a.R[i])); if (!Number.isFinite(v)) bad = true; pk = Math.max(pk, v); }
  if (bad || pk > 1 || hash(a) !== hash(b) || hash(a) === hash(c)) check(false, `render ${name}`, bad ? 'not finite' : pk > 1 ? `peak ${pk}` : 'seeds not deterministic/distinct');
}
check(!failed, `all ${Object.keys(SOUNDS).length} sounds render deterministically, vary by seed, peak under 0 dBFS`);

// 2. pitch moves every sound, and a run with `step` climbs (tuned sounds retune, the rest are varispeeded)
const flat = Object.keys(SOUNDS).filter(n => hash(render(n, { seed: 3, pitch: 0 }, 44100)) === hash(render(n, { seed: 3, pitch: 7 }, 44100)));
check(!flat.length, 'pitch changes every sound', flat.length ? `no change: ${flat.join(' ')}` : '');
const zc = s => { let z = 0; for (let i = 1; i < s.L.length; i++) if ((s.L[i - 1] < 0) !== (s.L[i] < 0)) z++; return z / s.L.length; }; // crossings per sample: rises with pitch
const up = render('deal', { seed: 1, pitch: 12 }, 44100), down = render('deal', { seed: 1, pitch: -12 }, 44100), mid = render('deal', { seed: 1 }, 44100);
check(zc(up) > zc(mid) && zc(mid) > zc(down) && up.hit < mid.hit && mid.hit < down.hit, 'an untuned sound goes up with pitch (and its hit comes sooner)', `crossings ${[down, mid, up].map(zc).map(x => x.toFixed(3)).join(' < ')}`);
check(hash(render('deal', { seed: 1, count: 3, step: 2 }, 44100)) !== hash(render('deal', { seed: 1, count: 3, step: 0 }, 44100)), '`step` makes a run climb (deal, count 3, step 2)');
// renderTake is the take play() renders: the player's own params (vol, vary, delay) left out, seed 1 when unpinned
check(hash(renderTake('knock', { seed: 3, vol: 0.2, vary: 0, delay: 1 })) === hash(render('knock', { seed: 3 })) && hash(renderTake('knock', { vol: 0.5 })) === hash(render('knock', { seed: 1 })),
  "renderTake renders what play() would, without the player's own params");

// 3. never harsh: every sound, the variants the kit plays and synth.mjs's effects
// within the bars of their kind, and the noise sounds under the sharpness bar at the bright end (bright 1, an octave up)
const kit = await kitSounds(), harsh = kit.filter(sound => sound.over.length);
check(kit.length > Object.keys(SOUNDS).length && !harsh.length, `all ${kit.length} sounds and movements within the harshness bars of their kind`, harsh.map(sound => `${sound.label} (${sound.kind}): ${sound.over.map(k => `${k} ${sound.measurements[k].toFixed(1)} (${sound.worst[k]})`).join(', ')}`).join('; '));
const sharp = Object.keys(SOUNDS).filter(n => !SOUNDS[n].tuned).map(n => [n, harshness(render(n, { seed: 2, bright: 1, pitch: 12 }, 48000)).sharpness]).filter(([, v]) => v > BARS.texture.sharpness);
check(!sharp.length, 'the noise sounds stay under the sharpness bar when made bright and an octave up', sharp.map(([n, v]) => `${n} ${v.toFixed(2)} acum`).join(', '));
const tone = Float32Array.from({ length: 24000 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 10000 * i) / 48000)), wide = harshness({ L: tone, R: tone.map(v => -v), sr: 48000 });
check(wide?.sharpness > BARS.tone.sharpness, 'a sharp sound in opposite phase on the two sides is measured, not cancelled', wide ? `${wide.sharpness.toFixed(2)} acum` : 'silent');

// 4. every built deck plays this kit: build.mjs inlines foley.js into the page, so a kit change reaches a deck only when
// it's rebuilt
const decks = builtDecks(ROOT, ['kit']), old = decks.filter(deck => deck.stale.length);
check(!old.length, `all ${decks.length} built decks carry this foley.js`, old.map(deck => `${deck.path} (rebuild: ${rebuild(deck)})`).join('; '));

// 5. in Chromium, through the soundboard page (the same module an app loads)
const srv = await serve(), { chromium } = playwright(), browser = await chromium.launch();
try {
  const ctx = await browser.newContext(), page = await ctx.newPage();
  page.on('pageerror', e => check(false, 'page error', e.message));
  await page.goto(srv.origin + '/shared/demo/examples/foley.html');
  await page.waitForFunction(() => window.sfx);
  check(await page.evaluate(() => window.sfx.context === null && window.sfx.play('knock') === null), 'silent before a user gesture (no AudioContext, play() returns null)');

  await page.click('[data-sound="knock"]');
  await page.waitForFunction(() => window.sfx.ready, null, { timeout: 5000 }).catch(() => {});
  check(await page.evaluate(() => window.sfx.ready && typeof window.lastPlay === 'number'), 'the first tap starts audio and plays', `state ${await page.evaluate(() => window.sfx.context?.state)}`);

  const level = await listenTo(page);
  const [, on] = await Promise.all([page.click('[data-sound="stamp"]'), level()]);
  check(on > -40, 'a tap on "stamp" is audible on the output', `${on.toFixed(1)} dBFS RMS`);

  // muting silences what is already playing and what is scheduled, and unmuting doesn't bring those back
  const quiet = off => off < -80;
  await page.evaluate(() => window.sfx.play('pour', { seed: 1, vary: 0 })); await page.waitForTimeout(300);
  const pouring = await level();
  await page.evaluate(() => window.sfx.setMuted(true)); await page.waitForTimeout(150);
  const afterMute = await level();
  check(pouring > -40 && quiet(afterMute), 'muting mid-sound silences it (pour)', `${pouring.toFixed(1)} -> ${afterMute.toFixed(1)} dBFS RMS`);
  await page.evaluate(() => { window.sfx.setMuted(false); window.sfx.play('stamp', { delay: 0.3 }); window.sfx.setMuted(true); });
  const delayedMuted = await level();
  check(quiet(delayedMuted), 'a delayed play, then mute: silent when it was due', `${delayedMuted.toFixed(1)} dBFS RMS`);
  await page.evaluate(async () => { window.sfx.setMuted(false); window.sfx.play('stamp', { delay: 0.4 }); window.sfx.setMuted(true); await new Promise(r => setTimeout(r, 150)); window.sfx.setMuted(false); });
  const resurrected = await level();
  check(quiet(resurrected), 'a sound cancelled by mute stays cancelled after unmuting', `${resurrected.toFixed(1)} dBFS RMS`);
  await page.evaluate(() => { window.sfx.setMuted(true); window.sfx.setVolume(0.8); });
  check(await page.evaluate(() => new Promise(r => setTimeout(() => r(window.sfx.output.gain.value), 150))) < 1e-3, 'setVolume while muted stays silent');
  await page.evaluate(() => { window.sfx.setVolume(0.35); window.sfx.setMuted(false); });
  const [, back] = await Promise.all([page.click('[data-sound="stamp"]'), level()]);
  check(back > -40, 'unmuted, it plays again at its volume', `${back.toFixed(1)} dBFS RMS`);

  await page.click('#mute');
  check(await page.evaluate(() => window.sfx.muted && localStorage.getItem('foley:soundboard') === 'off' && document.getElementById('mute').getAttribute('aria-pressed') === 'false'),
    'the mute toggle mutes, says so (aria-pressed) and is stored');
  const [, off] = await Promise.all([page.click('[data-sound="stamp"]'), level()]);
  check(off < -80 && (await page.evaluate(() => window.lastPlay)) === null, 'muted taps are silent', `${off.toFixed(1)} dBFS RMS`);

  await page.reload(); await page.waitForFunction(() => window.sfx);
  check(await page.evaluate(() => window.sfx.muted && document.getElementById('mute').textContent === '🔇'), 'mute is remembered after a reload');
  await page.click('#mute');
  check(await page.evaluate(() => !window.sfx.muted && localStorage.getItem('foley:soundboard') === 'on'), 'unmuting is stored too');

  // a listening piece: a prepared loop into a gain of its own, stopped by that gain alone, and a one-shot that says it's over
  await page.click('[data-sound="knock"]');
  const prepared = await page.evaluate(() => window.sfx.prepare([['pour', { dur: 2 }, { loop: true }]]).then(() => true));
  await page.evaluate(() => { const s = window.sfx; window.__bed = s.context.createGain(); window.__other = s.context.createGain();
    window.__bed.connect(s.output); window.__other.connect(s.output); window.__an = s.context.createAnalyser(); window.__an.fftSize = 2048; s.output.connect(window.__an); s.loop('pour', { dur: 2, destination: window.__bed }); });
  await page.waitForTimeout(2100);
  const looped = await level();
  check(prepared && looped > -40, 'a prepared loop keeps sounding past its length', `${looped.toFixed(1)} dBFS RMS after 2.1 s of a 2 s loop`);
  await page.evaluate(() => window.sfx.stop(window.__bed, 0.1)); await page.waitForTimeout(200);
  const bedStopped = await level();
  check(quiet(bedStopped), 'stop(destination) fades out and stops what plays into it', `${bedStopped.toFixed(1)} dBFS RMS`);
  const [, other] = await Promise.all([page.evaluate(() => { window.__ended = false; window.sfx.play('stamp', { destination: window.__other, onended: () => (window.__ended = true) }); window.sfx.stop(window.__bed); }), level()]);
  const ended = await page.waitForFunction(() => window.__ended, null, { timeout: 3000 }).then(() => true, () => false);
  check(other > -40 && ended, 'stop(destination) leaves other nodes playing, and onended says when a sound is over', `${other.toFixed(1)} dBFS RMS`);
  // a take kept from elsewhere (a worker's renderTake) is the one play() plays, whatever its own params: a silent take
  // with a hit no render gives, so nothing was rendered on the play
  const keptHit = await page.evaluate(() => { const L = new Float32Array(4800); window.sfx.keep('knock', { seed: 9, vol: 0.5 }, { L, R: L.slice(), hit: 0.0123, sr: 48000 });
    return window.sfx.play('knock', { seed: 9, vol: 0.2, vary: 0 }); });
  check(keptHit === 0.0123, "a kept take plays as it was kept, not rendered on the play, the player's own params aside", `hit ${keptHit}`);

  // the browser renders the same samples as Node, so an app and its ad sound alike
  let worst = 0;
  for (const name of Object.keys(SOUNDS)) {
    const b = await page.evaluate(async n => { const { render } = await import('/shared/demo/foley.js'); const s = render(n, { seed: 5, size: 1.1, pitch: 3 }, 44100); return [Array.from(s.L), Array.from(s.R)]; }, name);
    const a = render(name, { seed: 5, size: 1.1, pitch: 3 }, 44100);
    if (b[0].length !== a.L.length) { worst = Infinity; break; }
    for (let i = 0; i < a.L.length; i++) worst = Math.max(worst, Math.abs(a.L[i] - b[0][i]), Math.abs(a.R[i] - b[1][i]));
  }
  check(worst < 1e-6, 'Chromium renders every sound sample-for-sample like Node', `max difference ${worst}`);
} finally { await browser.close(); srv.close(); }

// 6. never harsh, as the products play it: every call in the company's products (company/sounds.json), measured as the
// kit's own are; last, as a product's files add sounds of their own to SOUNDS.
const files = productFiles(), own = await productSounds(files), off = own.filter(sound => sound.over.length);
if (files.length) check(!off.length, `all ${own.length} sounds the products play (${files.length} files) within the bars of their kind`, off.map(sound => `${sound.label} (${sound.kind}): ${sound.over.map(k => `${k} ${sound.measurements[k].toFixed(1)} (${sound.worst[k]})`).join(', ')}`).join('; '));
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
