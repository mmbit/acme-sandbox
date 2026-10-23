#!/usr/bin/env node
// Renders a palette's beds in each of its tunings to small MP3s, `<bed>-<tuning>.mp3` beside each bed, for a
// soundboard's play/stop tiles (an ad renders its bed itself, through mix.mjs). MP3 because every browser decodes it,
// Playwright's Chromium included. A bed is a synth.mjs song that reads the key from tuning() as it renders.
//   node shared/sound/beds.mjs <palette.js> <bed.mjs>...
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { palette, tune } from './engine.js';
import { render, writeWav } from '../demo/synth.mjs';

const [paletteFile, ...beds] = process.argv.slice(2), tmp = path.join(os.tmpdir(), 'bed-preview.wav');
if (!beds.length) { console.error('usage: node shared/sound/beds.mjs <palette.js> <bed.mjs>...'); process.exit(1); }
const load = async file => import(pathToFileURL(path.resolve(file)).href);
await load(paletteFile);
for (const bed of beds) {
  const song = (await load(bed)).default;
  for (const tuningName of Object.keys(palette().tunings)) {
    tune(tuningName); // the bed reads the key when it renders
    const rendered = render(song), out = bed.replace(/\.mjs$/, `-${tuningName}.mp3`);
    writeWav(tmp, rendered.L, rendered.R);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', tmp, '-c:a', 'libmp3lame', '-b:a', '64k', out]);
    console.log(`${out}: ${rendered.beats.duration.toFixed(2)} s, ${rendered.stats.lufs} LUFS, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
  }
}
fs.rmSync(tmp, { force: true });
