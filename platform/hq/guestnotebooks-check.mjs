#!/usr/bin/env node
// Guest notebooks on the real coordinator (bookguests.mjs). book-check.mjs --stories 'guest notebooks' runs this after
// its browser dispatch (render.ts), with its --out as --shots: the coordinator reads its config once, at its first
// import, so the stories run in a process that has loaded no coordinator module before harness() sets the env. On the
// render helper, as hq run installs the coordinator's packages:
//   hq run --kind render -- node platform/hq/book-check.mjs --stories 'guest notebooks' [--out dir] [--chromium-only]
import { guestNotebookStories } from './bookguests.mjs';

const arg = name => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
await guestNotebookStories({ shots: arg('--shots'), webkit: !process.argv.includes('--chromium-only') });
process.exit(0);
