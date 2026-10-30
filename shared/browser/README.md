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

## Checks from an agent's checkout

`hq run --kind render` runs ordinary browser commands on the lent helper, including Chromium and WebKit. It carries
the whole checkout, including edits and new files, and the comparison base as `origin/main`. It installs the pinned
gates, coordinator and browser packages. Page servers can listen on loopback inside the helper's existing closed
network. The helper reaches package registries through its proxy, without access to the job's credentials or live HQ.
This works from a subfolder too, with that folder as the command's working directory.

From the repo root:

```sh
# One notebook story, with its screenshots returned. Add --webkit for the iPad browser.
hq run --kind render --bring .data/book-shots -- node platform/hq/book-check.mjs --stories 'a page grows' --shots .data/book-shots

# The whole notebook check, including WebKit.
hq run --kind render --bring .data/book-shots -- node platform/hq/book-check.mjs --shots .data/book-shots

# HQ pages in one look. Repeat with the other look only when the change needs it.
hq run --kind render --bring .data/page-shots -- node platform/hq/screens-check.mjs brownstone --out .data/page-shots

# Any ordinary page check or Playwright story uses the same command prefix.
hq run --kind render -- node platform/hq/seatwarning-check.mjs

# Full suites and gates use the existing tests kind. It includes the worker's Chromium.
hq run --kind tests -- npm run tests -- --all
hq run --kind tests -- npm run gates
```

`--bring` names paths inside the checkout, relative to the folder where `hq run` starts. Screenshots and reports
return even when the command fails. The command's exit code remains its exit code. `--minutes` sets the helper run
budget (60 by default), with exit 124 when it ends. A lost or unavailable helper leaves the check incomplete. These
commands never retry the check on the busy server. An authored helper check is separate from the push's stored results.
`--with` includes named ignored inputs. `--commit` checks that commit instead. Leave out `--paths` for these checkout
checks. Explicit `--paths` keeps the original bare-folder run, without dependency setup, as the demo kit uses it.

The worker reports CPU pressure, memory and room with its regular resource sample. Each running job hears one
warning at its next tool step during an overload spell, and one recovery message after the spell it heard ends.
`errorsOf(page)` records Chromium's real page-crash event in the job's temporary folder so the worker can combine it
with measured pressure. A crash on an otherwise idle, roomy server alone does not declare overload.

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

## Push tests


Browser test areas (`shared/gates/tests.ts`, `BROWSER_AREAS`) receive the worker's Chromium headless shell, its
runtime resources and shared libraries. Full Chromium and unused browser assets stay out of push-test bundles.
Add an area there when it gains a browser push test, including an entry point that imports another area's test. The bootstrap sets `PLAYWRIGHT_BROWSERS_PATH` and `LD_LIBRARY_PATH` to the bundled
copies, for both the change and its base comparison. `BROWSER_HEADLESS_SHELL` selects the bundled
shell for `launched()`, unless its caller supplies an executable, a channel or headed mode. Authored browser
commands on a kind with `browsers: true` retain the full installed browser set. Playwright still installs from
`shared/browser`'s lock through npm. No browser download or extra proxy destination is needed. The worker and tests helper must keep the same Debian
base for these libraries. Playwright's root-only `deb.deps` and `rpm.deps` hints are excluded from the archive.
HQ-load checks require Chromium and fail if it is missing.

Checkout checks use the setup in `shared/gates`. Rebase an older checkout on main before using them.
A check stopped at its `--minutes` limit brings no files back.
