#!/usr/bin/env node
// Prices in films, decks and recordings: one source, recorded per render, and a check. A scene, deck or flow never
// types a price: it names the ones it shows by key in its settings (`"prices": ["notebook"]`), and the kit asks the
// company's price source for each at render time, in the film's language. A scene or deck reads them as
// `demo.price(key)` (a deck's words also as `{price:key}`), and every render records them in its .render.json
// (`prices`: { key, lang, cents, text }). A render made from others (a copy, a re-encode, a cut: its command names
// them) records theirs too, as their notes had them when it was made. The check lists every render whose prices
// aren't today's, with the command that renders it again, and every ad running with one.
//
// The company's setting is company/prices.json, its modules by their paths from the repo root:
//   { "source": "<module>", "ads": "<module>" }
//   source exports price(key, lang): today's price as { cents, text }, the text as its customers read it in that
//     language (lang undefined: the company's first), and throws for a key it doesn't know (a thing no longer sold)
//   ads (optional) exports async running(): [{ ad, films }], each ad showing now (or waiting for its yes) with the
//     repo paths of the films and pictures it shows
//
//   node shared/demo/prices.mjs check [path...] [--ads]   the renders whose prices aren't today's and what redoes each;
//                                                          --ads: the ads running with them too (in a job). Exits 1 if any
//   node shared/demo/prices.mjs note <file>... [--from <scene | deck | flow> | --prices a,b] [--lang xx]
//                                                          records the prices of a render made before its scene named them:
//                                                          its scene's (--from's, or --prices for a script of its own),
//                                                          today's; one made from others, theirs as recorded. Look at the render first: it must show today's prices
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROOT, SIDE, inputsOf, tracked } from './renders.mjs';

const SETTING = join(ROOT, 'company/prices.json');
const setting = () => (existsSync(SETTING) ? JSON.parse(readFileSync(SETTING, 'utf8')) : {});
const load = async name => {
  const path = setting()[name];
  return path ? import(pathToFileURL(join(ROOT, path)).href) : null;
};

// The prices a scene names, today's: [{ key, lang, cents, text }] (lang null: the source's first language)
export async function pricesFor(keys = [], lang) {
  if (!keys.length) return [];
  const source = await load('source');
  if (!source)
    throw new Error(
      `the scene names prices (${keys.join(', ')}), but ${relative(ROOT, SETTING)} has no "source": add one (shared/demo/README.md, "Prices")`,
    );
  return keys.map(key => ({ key, lang: lang ?? null, ...source.price(key, lang ?? undefined) }));
}

// A scene's, deck's or flow's own settings: the prices it names and its language. An HTML scene keeps them in its
// <script id="demo">, a deck or a flow is JSON. A scene's language is its data's when it names none (a film without
// --lang reads demo.data.lang), a flow's its locale's
function settingsOf(file) {
  const text = readFileSync(file, 'utf8');
  const json = file.endsWith('.json') ? text : text.match(/<script[^>]*id=["']demo["'][^>]*>([\s\S]*?)<\/script>/)?.[1];
  const own = json ? JSON.parse(json) : {};
  return { prices: keysOf(own.prices), lang: own.lang ?? own.data?.lang ?? own.locale?.slice(0, 2) };
}
// `"prices": ["a", "b"]` in a scene's settings, or `--prices a,b`
export const keysOf = prices => (Array.isArray(prices) ? prices : prices ? String(prices).split(',') : []);

const read = side => JSON.parse(readFileSync(side, 'utf8'));
const fileOf = side => relative(ROOT, side.slice(0, -SIDE.length));
// The renders (under paths, all without) whose prices aren't today's: { file, prices: [{ ...shown, now }], redo },
// those a render is made from before it
export async function stale(paths = []) {
  const source = await load('source');
  if (!source) return [];
  const today = p => {
    try {
      return source.price(p.key, p.lang ?? undefined);
    } catch {
      return null; // a thing no longer sold
    }
  };
  const depth = (side, seen = new Set()) => {
    if (seen.has(side)) return 0;
    seen.add(side);
    return 1 + Math.max(0, ...inputsOf(fileOf(side), read(side).command).map(i => depth(join(ROOT, i + SIDE), seen)));
  };
  return tracked(paths)
    .map(side => {
      const prices = (read(side).prices ?? [])
        .map(p => ({ ...p, now: today(p) }))
        .filter(p => p.now?.cents !== p.cents);
      const file = fileOf(side);
      const redo = read(side).command
        ? `node shared/demo/renders.mjs render ${file}`
        : `none: rendered before renders were kept, so render it again from its scene (its ${SIDE} names no command)`;
      return { file, prices, redo, depth: depth(side) };
    })
    .filter(r => r.prices.length)
    .sort((a, b) => a.depth - b.depth || a.file.localeCompare(b.file))
    .map(({ file, prices, redo }) => ({ file, prices, redo }));
}

// The ads showing any of those renders, as the company's ads module says: [{ ad, films }]
export async function runningWith(renders) {
  const ads = await load('ads');
  if (!ads) return [];
  const old = new Set(renders.map(r => r.file));
  return (await ads.running()).map(a => ({ ...a, films: a.films.filter(f => old.has(f)) })).filter(a => a.films.length);
}

// The check's words: one line per render and its prices, then what redoes it
export const report = renders =>
  renders
    .map(
      r =>
        `${r.file} shows ${r.prices
          .map(
            p =>
              `${p.key}${p.lang ? ` (${p.lang})` : ''} at ${p.text}, ${p.now ? `today ${p.now.text}` : 'no longer sold'}`,
          )
          .join('; ')}\n  redo: ${r.redo}`,
    )
    .join('\n');

// note <file>: the prices its scene names (or keys), today's, in its .render.json. The scene is the one its kit command
// names (ad.mjs's scene, present.mjs's deck, record.mjs's flow) or --from; the language its --lang, --lang or the
// scene's. A render made from others (a cp, a re-encode) gets the prices their notes record
async function note(file, from, lang, keys) {
  const side = resolve(file) + SIDE,
    record = read(side),
    [, tool, scene] = record.command ?? [];
  const kit = /^shared\/demo\/(ad|present|record)\.mjs$/.test(tool ?? '');
  if (!from && !kit && !keys.length) {
    const prices = inputsOf(fileOf(side), record.command).flatMap(input => read(join(ROOT, input + SIDE)).prices ?? []);
    if (!prices.length)
      throw new Error(
        `${file}: neither a kit tool nor a priced render made it: say which scene with --from, or --prices`,
      );
    writeFileSync(side, JSON.stringify({ ...record, prices }, null, 2) + '\n');
    return console.log(`${file}: ${prices.map(p => `${p.key} ${p.text}`).join(', ')}, as its inputs show them`);
  }
  const settings = from || kit ? settingsOf(from ? resolve(from) : join(ROOT, scene)) : {};
  if (keys.length) settings.prices = keys;
  const flag = record.command?.indexOf('--lang') ?? -1;
  const prices = await pricesFor(settings.prices, lang ?? (flag > 0 ? record.command[flag + 1] : settings.lang));
  if (!prices.length) throw new Error(`${file}: its scene names no prices`);
  writeFileSync(side, JSON.stringify({ ...record, prices }, null, 2) + '\n');
  console.log(`${file}: ${prices.map(p => `${p.key} ${p.text}`).join(', ')}`);
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const opt = name => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
  const paths = rest.filter((a, i) => !a.startsWith('--') && !['--from', '--lang', '--prices'].includes(rest[i - 1]));
  if (cmd === 'check') {
    const renders = await stale(paths);
    console.log(renders.length ? report(renders) : "Every render shows today's prices.");
    if (renders.length && rest.includes('--ads'))
      for (const a of await runningWith(renders))
        console.log(`RUNNING with an old price: ${a.ad} (${a.films.join(', ')})`);
    process.exitCode = renders.length ? 1 : 0;
  } else if (cmd === 'note')
    for (const file of paths) await note(file, opt('--from'), opt('--lang'), keysOf(opt('--prices')));
  else {
    console.error(
      readFileSync(fileURLToPath(import.meta.url), 'utf8')
        .split('\nimport')[0]
        .replace(/^#!.*\n/, '')
        .replace(/^\/\/ ?/gm, ''),
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2)).catch(e => {
    console.error(e.message);
    process.exitCode = 1;
  });
