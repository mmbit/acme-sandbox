// Review mode's parts as the coordinator serves them (feedback.ts), for the checks that play it in a browser: any
// /__review/<part>.js (or a shelf's /<slug>/__review/<part>.js) from shared/review/, review.js itself as the check
// gives it (its placeholders filled in). Null for anything else.
import { existsSync, readFileSync } from 'node:fs';

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
