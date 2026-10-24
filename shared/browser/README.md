# Browser

What the browser checks (`*-check.mjs`) write alike: Playwright wherever it's installed, a page that keeps its errors,
a click by script and a wait for words.

```js
import { playwright, openPage, errorsOf, tap, until } from '../../shared/browser/browser.mjs';

const browser = await playwright().chromium.launch(); // or webkit; devices too
const { context, page, errors } = await openPage(browser, { viewport: { width: 390, height: 844 } });
await context.route(`${base}/api/**`, api); // routes and init scripts still go on before the first goto
await page.goto(`${base}/?intro=0`);
await until(page, '#loading.gone'); // till it's there
await tap(page, '[data-app=seats]');
await until(page, '.seats-app', /signed in/); // till its words match, in any case
assert.deepEqual(errors, []);
```

- `openPage(browser, options)` makes a context of its own (options as `newContext`'s) with service workers blocked
  and Google Fonts answered empty, so a check lays out the same on every machine. A check that wants the real fonts, or
  its own context, keeps `browser.newPage()` and takes `errorsOf(page)`.
- `errors` holds the page's uncaught errors and any dialog it opened (a page never asks in the browser's dialogs).
- `tap` clicks by script, for scenes whose elements never hold still for Playwright's own click.
- `until(page, selector, pattern, timeout)` polls on a timer, since a busy scene's frames can hold animation-frame
  polling back for seconds. Without a timeout it takes Playwright's.
- `listenTo(page)` puts an analyser on the page's `window.sfx` output and returns `level()`, the loudest RMS over the
  next 400 ms in dBFS, to await beside what makes a sound: `const [, on] = await Promise.all([tap(page, s), level()])`.

`shared/demo/core.mjs` hands on the same `playwright()`.


## Heavy renders

HQ's `harness.mjs` sends room previews and pixel comparisons to a lent helper whenever one is present. The helper's run
kind is the one `runs.browser` names in org.yaml, or `render` when it names none. Give the browser a kind of its own
when the films' image has no git: the snapshot arrives as a git bundle, and the harnesses read the comparison ref with
git. Busy helpers keep the work queued. The snapshot includes
uncommitted files, the selected comparison ref and an optional brand file. Pictures return to `--out` (a new temporary
folder by default), and `--record` keeps the original branch, commit and command. Remote failures and timeouts are
final, with the render's exit code.

The kind uses `sockets: true`, so its local page servers run on the manager's closed network. It has no server helper
container. If no lent render helper is present, the caller runs on the worker under an exclusive kernel lock on the
shared `/run/lock` directory. Every job and checkout uses that same inode, across slot users. The supervisor holds the
lock until its render and all descendants have stopped. No lock file can go stale or be removed by job cleanup.

The supervisor uses Linux's child subreaper facility to collect detached Chromium descendants. An idle render stops
with exit 124 after 120 seconds without harness progress (four default 30-second Playwright operation budgets), or at
the 30-minute run budget shared with the test helper. Harness operations report progress over IPC, independent of
console output. Cancellation, script failures and normal exits also clean up descendants before releasing the slot.
Pixel comparisons run two scenarios at once, with two pages per comparison, instead of increasing their page count
with the host's core count. Room previews retain their two-page pool.

Pixel comparisons capture the visible viewport through Playwright, including DOM, 2D and WebGL renderers. Each shot
compares the selected reference's page with the working tree's page. The dev fixture's `mock/brand.json` picks the
initial renderer. `--brand <file>` supplies the same brand and renderer settings to both sides.

`shared/browser/package-lock.json` pins the helper's Playwright and YAML dependencies. Keep Playwright's version in
step with the worker image and the company's render image. The official Playwright image supplies Node 24, browsers,
fonts and system libraries. `onhelper.sh` installs only the pinned npm packages through the existing helper proxy.
The pictures use the same software browser rendering as the worker, without GPU access.

Run `node --test shared/browser/render.test.ts` for concurrency, snapshot, artifact, failure and cleanup checks.
