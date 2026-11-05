// hq prototype: a page built for the board's live call, saved with the call as a throwaway prototype (the
// coordinator's callprototypes.ts), with no pull request and no review.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as api from './api.ts';
import { print, stop, text } from './output.ts';

const USAGE = 'usage: hq prototype --call <n> "<name>" <folder | file.html> [--about "<line>"]';
// The most of a prototype's files in all: callprototypes.ts FILES_MOST
const FILES_MOST = 8 << 20;

export const prototype = {
  help: `
   hq prototype --call <n> "<name>" <folder>         save a page for the board's live call <n> as its throwaway
       [--about "<line>"]                            prototype: the folder's index.html and its files (dot-files and
                                                     node_modules left out, 8 MB at most), or one HTML file. It
                                                     appears on the call's page and the board's iPads with its
                                                     picture. The same name again makes its next version, --about
                                                     says what that version changes. No pull request and no review:
                                                     commit nothing for it`,

  async run(args: string[]) {
    const { call, about, given } = argumentsOf(args);
    const [name, path] = given;
    const files = filesAt(path);
    const size = [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0);
    if (size > FILES_MOST)
      stop(`Nothing saved: ${path} has ${(size / 2 ** 20).toFixed(1)} MB of files, and a prototype takes 8 MB at most`);
    const encoded = Object.fromEntries([...files].map(([file, bytes]) => [file, bytes.toString('base64')]));
    const body = api.withSpeaker({ call: Number(call), name, ...(about !== undefined && { about }), files: encoded });
    const answer = await api.change('prototype', { body });
    if (!api.isSuccess(answer.status)) stop(`Nothing saved: ${api.errorIn(answer.body, 'HQ refused it')}`);
    const saved = JSON.parse(answer.body);
    print(text(saved.ok), ...(saved.link ? [text(saved.link)] : []));
  },
};

// --call and --about, anywhere, and the name and the path in order
function argumentsOf(args: string[]) {
  const flags = new Map<string, string>();
  const given: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--call' && args[i] !== '--about') given.push(args[i]);
    else if (args[i + 1] === undefined) stop(USAGE);
    else flags.set(args[i], args[++i]);
  }
  const call = flags.get('--call') ?? '';
  if (!/^[0-9]+$/.test(call) || given.length !== 2 || !given[0].trim()) stop(USAGE);
  return { call, about: flags.get('--about'), given };
}

// The prototype's files by their path in it: one file is its index.html
function filesAt(path: string) {
  const found = statSync(path, { throwIfNoEntry: false });
  if (!found) stop(`Nothing saved: there's no ${path}`);
  if (!found.isDirectory()) return new Map([['index.html', readFileSync(path)]]);
  const files = new Map<string, Buffer>();
  addFolder(path, '', files);
  if (!files.has('index.html')) stop(`Nothing saved: ${path} has no index.html, the page`);
  return files;
}

// (a link is left out with the dot-files: only the folder's own files go)
function addFolder(root: string, folder: string, files: Map<string, Buffer>) {
  for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const file = folder ? `${folder}/${entry.name}` : entry.name;
    if (entry.isDirectory()) addFolder(root, file, files);
    else if (entry.isFile()) files.set(file, readFileSync(join(root, file)));
  }
}
