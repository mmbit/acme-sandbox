// Review mode's scripts as they're served: the tool and the watch-along's answer with HQ's origin filled in, for
// feedback.ts and the checks alike, and its parts for the checks that play it in a browser.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// A script of shared/ that names HQ (review/review.js, the tool, or watchalong/framed.js, the watch-along's answer in a
// page HQ frames) as it's served, for HQ at origin: its origin filled in, so it runs inside HQ's viewer and only there.
// root is the repo it's read from: this checkout, or the coordinator's REPO_DIR when it serves.
export const scriptForHq = (script, origin, root = fileURLToPath(new URL('../..', import.meta.url))) =>
  readFileSync(`${root}/shared/${script}`, 'utf8').replace('{{HQ_ORIGIN}}', origin);

// Any /__review/<part>.js (or a shelf's /<slug>/__review/<part>.js) from shared/review/, review.js itself as the check
// gives it (its placeholders filled in). Null for anything else.
export function reviewPart(path, reviewJs) {
  const part = /\/__review\/([a-z]+)\.js$/.exec(path)?.[1];
  if (!part) return null;
  if (part === 'review') return reviewJs;
  const file = new URL(`./${part}.js`, import.meta.url);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}
// ...as a Playwright route fulfils it, or false when the path isn't one
export const fulfilPart = (r, path, reviewJs) => {
  const body = reviewPart(path, reviewJs);
  return body !== null && r.fulfill({ contentType: 'text/javascript; charset=utf-8', body });
};
