// The helper's knowledge (the plug-in's kb/): `shared/` plus the app's own folder, read once, at start: a merged entry reaches
// the chat with the next deploy. An entry's frontmatter may name the question cases it answers (`answers: "H-1012,
// H-1015"`, kb/README.md, "The no-answer loop"): answers.ts emails those customers; the line itself never goes into the
// prompt (case ids are noise for the model). An entry quotes the chat's own labels by their key, `{label:m_delete}`:
// knowledge() fills in the widget's words for it (public/i18n.js, the plug-in's over the engine's) in the customer's
// language, so the helper names a button as the customer sees it, and a renamed button renames it here too.
// An entry a page shows too (a company's FAQ, `faq:` in its frontmatter: kb/README.md) carries its question and answer
// in each language: a conversation gets only its own language's (the English where it has none) and the chat's part,
// so another language costs the prompt nothing (entry.ts, the one reading of an entry).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { KB } from './config.ts';
import { DIR as COMPANY, settings } from './company.ts';
import { words } from '../public/i18n.js';
import { parseEntry, inLanguage, quotes as quotesOf, type Entry as Parsed } from './entry.ts';

const DIR = process.env.CARE_KB_DIR || join(COMPANY, 'kb'); // the company's (its plug-in folder's kb/); the tests read their own
const base = (app: string) => app.replace(/@preview$/, '');
// the folder an app reads besides shared/ (CARE_KB maps another slug to one)
export const folderOf = (app: string) => KB[base(app)] ?? base(app);

type Entry = { file: string; text: string; parsed: Parsed };
const read = new Map<string, Entry[]>();
function entries(folder: string): Entry[] {
  if (!/^[a-z0-9-]+$/.test(folder)) return [];
  if (!read.has(folder)) {
    let files: string[] = [];
    try { files = readdirSync(join(DIR, folder)).filter(f => f.endsWith('.md')).sort(); } catch { /* no folder */ }
    read.set(folder, files.map(f => {
      const text = readFileSync(join(DIR, folder, f), 'utf8').trim();
      return { file: f, text, parsed: parseEntry(text) };
    }));
  }
  return read.get(folder)!;
}

const LABEL = /\{label:(\w+)\}/g;

// an app's knowledge in one language (the conversation's): a label with no words stays its key, so a typo in an entry
// never stops the chat (unknownLabels() is the check that finds it). shared false: the app's own folder only (the phone
// adds each stall's to the shop's). The plug-in's live entries come last, so a change in them re-writes as little of the
// cached prefix as can be; live false leaves them for the caller to add last itself (the phone's shopKnowledge())
export function knowledge(app: string, lang: string, { shared = true, live = shared }: { shared?: boolean; live?: boolean } = {}) {
  const text = entriesOf(app, shared).map(e => labelled(inLanguage(e.parsed, lang), lang));
  return [...text, ...(live ? [liveKnowledge(lang)] : [])].filter(Boolean).join('\n\n');
}
const entriesOf = (app: string, shared = true) => {
  const folder = folderOf(app);
  return [...(shared ? entries('shared') : []), ...(folder === 'shared' ? [] : entries(folder))];
};
const labelled = (text: string, lang: string) => {
  const label = words(lang);
  return text.replace(LABEL, (quote, key) => { try { return label(key); } catch { return quote; /* no such label */ } });
};
// an app's word-for-word page quotes in one language, entry by entry (entry.ts: a conversation's knowledge holds only
// its own language's; a company's tool gives these to a customer writing in another). shared false: the app's own
// folder only, as in knowledge().
export function quotes(app: string, lang: string, { shared = true }: { shared?: boolean } = {}) {
  return entriesOf(app, shared).map(e => labelled(quotesOf(e.parsed, lang), lang)).filter(Boolean).join('\n\n');
}
// the plug-in's entries from live data, in a language ('' for none)
export function liveKnowledge(lang: string) {
  return settings.liveKnowledge(lang).trim();
}
// which knowledge an answer was tried with (answers.ts): a case it couldn't answer is tried again only once that changes
export const version = (app: string, lang: string) => createHash('sha256').update(knowledge(app, lang)).digest('hex').slice(0, 16);

// every label an entry quotes that the chat has no words for: the company's own test of its knowledge fails on one
export function unknownLabels(): { folder: string; file: string; key: string }[] {
  const label = words('en'); // a key missing in a language falls back to English, so English has every key there is
  const known = (key: string) => { try { label(key); return true; } catch { return false; /* words() throws for an unknown key */ } };
  return folders().flatMap(folder => entries(folder).flatMap(e => [...e.text.matchAll(LABEL)].map(m => ({ folder, file: e.file, key: m[1] }))))
    .filter(x => !known(x.key));
}

// every case an entry names, with where it's named: the folder ('shared' answers any app's) and the file
export function named(): { ref: string; folder: string; file: string }[] {
  return folders().flatMap(folder => entries(folder).flatMap(e => e.parsed.answers.map(ref => ({ ref, folder, file: e.file }))));
}
function folders() {
  try { return readdirSync(DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort(); } catch { return []; /* no kb */ }
}
