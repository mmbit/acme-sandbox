# kits/: the company's own libraries, tools and parts

The platform (`platform/`, `infra/`, `shared/`) is the same for every company: generic engines, tools and app frames.
What only this company needs lives in its own folders, and `kits/` is where its code goes: a library its products copy
in, a tool, or a part that plugs into the platform. A kit is a folder, `kits/<name>/` (lowercase, digits and `-`), with
whatever it needs and its tests next to the code. Nothing in the platform names a kit; the platform finds them by these
files:

| A kit's file | What it plugs in | Where the platform takes it |
|---|---|---|
| `coordinator.ts` | its routes, agents' routes, numbers and timers in the coordinator | `platform/coordinator/src/kits.ts` |
| `hq/app.js` | an app on HQ's computer, named in `theme/hq.yaml`'s `apps` | `platform/hq/shell/desk.js` |
| `hq-<command>.sh` | `hq <command>` for agents | `platform/worker/hq/kits.ts` |

## The coordinator: `coordinator.ts`

Loaded once when the coordinator starts, every kit's in name order. It exports what it adds, all of it optional:

```ts
export const service = { '/api/shop/thing': handle, 'POST /api/shop/push': push, '/api/shop/x/*': other };  // own token
export const board = { '/api/shop/*': forTheBoard };                    // behind the board's session (its HQ app calls them)
export const agent = { 'GET /api/agent/thing': (body, me) => ({ ok: true }) };   // hq <command>'s route
export const numbers = (app) => ({ thing: 3, lines: ['', 'Things: 3'] });          // more for one app's numbers
export const dashboard = (r) => ({ id: 'things', name: 'Things', figures: [{ label: 'Things', value: 3 }] });  // a Numbers tile
export const start = () => { setInterval(tick, 60_000); };                           // its timers
```

- **service** routes come before the platform's own and before the board's login: the caller (a product server, a
  service of the company's) brings its own token, and the route checks it. **board** routes are the board's, behind
  its session. A route is `(req, res, path) => …` and answers the request itself. A key is a path, a prefix ending in
  `/*` (the prefix and everything under it), and either may start with a method (`POST /api/shop/push`).
- **agent** routes are answered like the platform's: a value is the JSON, a number an error status, `[status, 'why']`
  (or a string, a 400) a refusal in words the agent reads. They're never open to a call. A route the platform (or
  another kit) already answers stops the coordinator at start, rather than shadowing it.
- **numbers(app)** gets one app's numbers (`{ slug, mode, days, … }`) and returns fields to add (HQ's Numbers reads
  them through the kit's HQ app) and `lines`, plain text that `hq numbers <slug>` prints under the app's own.
- **dashboard(r)** gets the Numbers home (`{ days, from, to, apps, baskets }`, the days the board picked) and returns a
  dashboard, or a list of them, for counts across the shop rather than one app's: each is a tile on the Numbers home
  beside the apps', and tapping it prints its dashboard the way an app's prints (below, "Numbers"). `hq numbers` prints
  them under its list.
- **start()** runs once the coordinator is up. Background work catches its own errors (CODE_STYLE.md).

### Numbers: a dashboard of the company's own

Numbers are never a sentence or a paragraph with a few figures in bold: they're figures, a chart, a table, bars or a
target, the way HQ prints an app's dashboard, so that is all a dashboard can say (the board, 2026-10-11). Its fields,
every one but `id` and `name` optional:

```ts
{
  id: 'things',                        // lowercase, digits and -; one per id across the kits
  name: 'Things',                      // the tile's name and the printout's title
  about: 'What it counts, in a line',  // under the title (and the tile's tooltip)
  icon: 'things',                      // the tile's picture: an icon's name (as an app's), or rows of # and . (else a sigil from its id): pixel art, drawn in a pixel look alone, its name's initial in any other
  tile: '3 today',                     // the line under the tile's name: short, plain
  figures: [{ label: 'Things', value: 3, unit: 'EUR' | '%' | 'kg', sub: 'a short line under it' }],   // the first is the big one; value null: a dash
  daily: { title: 'Per day', sub: '…', columns: [{ key: 'n', label: 'Things', unit }], rows: [{ day: 'YYYY-MM-DD', n: 3 }] },  // every day of r: a chart of the first column, the table of all
  bars: [{ title: 'By kind', sub: '…', rows: [{ label: 'Red', value: 2, unit }] }],                   // with each one's share
  targets: [{ label: 'Things a day', goal: 2, unit, lower: false, value: 3, mark: 'green' | 'amber' | 'none' }],
}
```

A count that isn't known yet is `null` (a dash), never a 0 that passes for one. Words go in labels and `sub`s; a number
that matters gets a figure, a column or a target of its own.

A kit imports the platform by its path in the repo, `../../platform/coordinator/src/db.ts`: the coordinator's image
copies `kits/` next to the platform's code, laid out as in the repo, so a kit gets the very modules the coordinator
runs. It imports no package of its own (the platform's aren't on its path): `company.ts` reads YAML for it
(`yamlFile`). A platform module that lets a kit hook in says so where it does (`approvals.register`, `mailHooks`,
…). A kit's tests run from the repo's root: `node --test kits/<name>/<x>.test.ts`.

## HQ: `hq/app.js`

`theme/hq.yaml`'s `apps: [<name>, …]` puts these kits' apps on the computer's home screen, in that order, each at the
end of the group its `app.group` names: `work` (Projects, Reviews, Artifacts), `talk` (Calls, Mail, On Air), `business`
(Numbers) or `team` (Team, Seats, with Settings always last). One that names none goes with the others like it, before the team's
(`brand.yaml`'s `computer.apps` sets another order). HQ loads `kits/<name>/hq/app.js` from `/kits/<name>/app.js`
(everything in the kit's `hq/` folder is served there, behind the board's login; in dev mode `platform/hq/serve.mjs`
serves it the same way). It imports HQ's own modules by their address (`/util.js`, `/shell/data.js`: `get`, `toLogin`,
`answerRequest`), and loads its own stylesheet. Two platform apps run on the same interface, ahead of the kits' apps in
the `business` group: Care (below) and Photos, the photo studio (`platform/hq/shell/studio.js`), there when
`company/brand.yaml` has a `studio` block (`template/company/brand.yaml`). An app's `icon` names a drawing the company
makes once per icon style, `theme/hq/icons/<style>/<name>.svg` beside HQ's own in `platform/hq/icons/` (a style per
look: `platform/hq/shell/icons.js`). A look shows only its own style's drawing, and `node --test
platform/hq/shell/icons.test.js` fails a style that lacks one.

A kit's stylesheet laid over every look goes in the same folder, and is served the same way: `kits/<name>/hq/<file>.css`
at `/kits/<name>/<file>.css`. `theme/hq.yaml`'s `styles: [/kits/<name>/<file>.css, …]` lists their URLs. HQ links each
in that order, after its own stylesheet and before the renderer's, so a look can draw what it sets. A company can set
HQ's depth scale this way, for example: the `--depth-*` properties that `platform/hq/style.css` defaults.

A kit can dress one look instead: `theme/hq.yaml`'s `<look>.kit: <name>` lays the kit's `hq/style.css` (at
`/kits/<name>/style.css`) over that look only, after the look's own skin, and takes it off when the viewer picks
another look. Any look and any kit work the same way. A kit with an icon set, `hq/icons/<name>.svg` under HQ's icon
names (`platform/hq/icons/<style>/`), gives that look its icons too: every one from the set, none from HQ's styles. Its
`hq/icons/names.json` (`{ "mobile": "phone" }`) points HQ names that share one drawing to it. A kit that dresses a
look ships `hq/sounds.js` too: `MOMENTS`, each moment's `[[sound, params], …]` of the platform's sound kit
(`shared/demo/foley.js`), and `HQ`, HQ's sound names to the moment each plays (or a function of the sound's arguments
giving its calls), `{}` for none. A sound `HQ` doesn't name stays the look's. A kit's stylesheet or sounds that
fail to load fail the change of look: HQ keeps the look worn before, and says so.
<!--. -->

```js
export const app = { name: 'Things', what: 'What the board sees under the name', icon: 'things', group: 'business' };  // an icon's name (above); its group (optional)
export async function draw(el, hq) { … }   // its screen: on opening, then every 15 s (not while a field has text)
export function back() { return false; }   // optional: a step back inside the app (true), or the computer's home (false)
export async function count(dev) { … }     // optional: the number on its icon
export async function phone(el, hq, { fresh, past }) { … }   // optional: its own line at the top of the desk phone
export async function settings(el, hq) { … }                 // optional: its page in Settings (Settings › its name)
export function numbers(d, view, hq) { return { html, wire(el) {} }; }   // optional: a section on an app's dashboard (figures, never a sentence: "Numbers" above)
```

An app can add its own category to HQ's search (`/` on HQ's home, `platform/hq/shell/finder.js`) with `finds`: a chip
named `name`, a prefix to type (`t:`, unless HQ or another app has it), and the things its own screen lists, each
`{ key, title, sub, codes, at, open }`. Words match `title` and `codes` first (a reference such as `H-1001`), then `sub`;
`at` (optional) is when it came, was answered or was done, and one older than a week waits behind the category's "n more"
while fresher ones match; one still waiting for the board has none, so it's never old. A part of the list that couldn't load
is an item `{ missed: its name }`, and the field names it. `open()` shows it in the app (`hq.open`). List only what the
app's screen shows the board, by that screen's rules.

```js
export const finds = { name: 'Tickets', prefix: 't', async list(hq) { return [{ key, title, sub, codes: [], open() {} }]; } };
```

`hq` is what an app may do in HQ: `hq.dev` (dev mode: read its own mock data), `hq.open(app, { mail, force })` (open
a computer app; Mail at one message; `force` moves on from a field with text in it, which the app saved first),
`hq.numbers(app, back)` (one app's dashboard in Numbers, its back button calling `back`), `hq.who(id)` and
`hq.ago(time)`. Everything from the coordinator is shown as text (`esc()`), as in HQ's own apps. Its checks run HQ in a
real browser the way HQ's do (`kits/<name>/<name>-check.mjs`, on `platform/hq/serve.mjs`); dev mode's mock data for it
is the kit's `hq/mock/`, and a change to a platform mock for it goes in `theme/hq/mock/`.

## hq: `hq-<command>.sh`

`hq <command>` runs `kits/<kit>/hq-<command>.sh` of the repo it's run in (a job's clone; `HQ_REPO` names another) when
the platform has no command of that name. It runs in bash with `set -euo pipefail`, its arguments as `$1…` (`$1` is
the command) and hq's helpers (`platform/worker/hq/kit.sh`): `get <route>` and `api <route> <json>` for
`/api/agent/<route>`, `post`, `uri`, `auth` and `get_unless_refused`. Its opening comment lines are its part of `hq`'s
help, written like the platform's:

```bash
#   hq things [--json]                               what the things are, one line each
r=$(get things) || { echo "Couldn't read the things from HQ." >&2; exit 1; }
jq -r '.[] | .name' <<<"$r"
```

## Care: a kit's parts of HQ's care engine

HQ's side of the support chat is the platform's (`platform/coordinator/src/care.ts`, its settings in `brand.yaml`'s
`care`: `template/company/brand.yaml`). What's one company's plugs in from a kit's `coordinator.ts`, which imports
`care.ts` by its repo path and fills its slots at start, each optional. Care takes
mail only when the company runs the care service (its plug-in, `products/care/product.yaml`; `/api/brand`
says so as `care`), and only then is the Care app on HQ's computer: the platform's (`platform/hq/shell/care.js`, on the
interface above, first among the company's apps), never named in `theme/hq.yaml`'s `apps`. It shows what the slots fill and nothing for those
left empty.

Where each part of a company's Care goes:

| Part | Where | Documented in |
|---|---|---|
| the support chat: its helper, words, look, languages, model, tools, rules, remedies at the chat, holidays, knowledge | the care service's plug-in, `products/care/` (`care.ts`, `public/plugin.js`, `kb/`, `product.yaml`) | `platform/care/README.md`, "The plug-in"; `template/products/care/` is a working example |
| HQ's side: reply time, busy notice, sign-offs, subjects, claims' supplier, inbox, questions' job, Numbers' caps and targets | `company/brand.yaml`'s `care` | `template/company/brand.yaml` |
| HQ's slots: the holiday calendar, the remedies Care lists, a case's own buttons, a gated tool's case | a kit's `coordinator.ts` | below |
| who keeps the chat's knowledge: a question it couldn't answer becomes their job | `company/org.yaml`'s `roles.knowledge` | `template/company/org.yaml` |

```ts
import * as care from '../../platform/coordinator/src/care.ts';
import * as approvals from '../../platform/coordinator/src/approvals.ts';
care.calendars.set('xx', year => [Date.UTC(year, 0, 1), …]);   // brand.yaml care.workdays: xx; each holiday a UTC midnight
care.slots.remedies = { listed, owed, again };                   // what Care shows of the company's remedies
care.slots.actions.push({ id: 'no-letters', label, hint, done, run });   // a button of its own on a customer's case
approvals.register('spare', { kind: 'spare', describe, decide, caseOf: grant => 'H-1042' });   // a gated tool's card, on its case
```

- **calendars**: a public-holiday calendar by name, the one `care.workdays` names counted out of the reply time the
  company aims for (`care.busy.aim` working days, 3 if not set). No calendar of that name: weekends only.
- **remedies**: what Care shows of the company's own remedies: `listed(before)` every remedy, newest first, a page at a
  time (`{ remedies, more }`, Care › Every remedy); `owed()` the money it owes, each with `amount` in words (Money we
  owe); `again(body)` Refund again on one of those (a value, or `[status, 'why']`). Without it, those lists are empty.
- **actions**: the company's own buttons on a customer's case, each acting on the
  address the case replies to (given to the kit's own functions only, never logged). `done(to)` says whether it's done
  for that address already (a quick lookup: it's asked on every read of Care's list), and the card then shows its
  `label` with a tick instead of the button; `run(to)` does it once, on the board's tap, and answers the note the
  conversation keeps ("You marked: …"), or `[status, 'why']` to refuse in words. Each shows with its `hint` under it, low
  on any card with a customer address, open or closed. Without any, a card shows none.
- **a gated tool's case**: a tool the board approves on the desk phone (`approvals.register`) whose grant may be about
  a customer's case says which with `caseOf(grant)` (the case, or null): Care lists its open requests ("Waiting for your
  tap"), on that case's card.

The health-detail check on emails is the care engine's matcher with the lists of the company's care
plug-in (`products/care/public/plugin.js`'s `health`), as the care service runs it.

**Care › Numbers** is the engine's own figures, for any company that runs the care service; there's nothing to plug in.
The service sends each finished day's counts per app (`POST /api/care/numbers`,
its own token: conversations, resolved without a person, emails to a person, questions, "Did this help?", first words,
minutes of outage and past a cap, spend), and HQ adds what only it knows (reply times against `care.busy.aim`, open questions and their jobs, the plug-in's `kb/`
entries, the month's spend against `care.numbers.cap`, first words against `care.numbers.first_words`):
`platform/coordinator/src/care-numbers.ts`. The board reads it in Care › Numbers, and every app's dashboard in Numbers
carries the chat's line for the same days and mode, with the way to Care › Numbers and back; `hq numbers <slug>` prints
it under the app's own. The engine's own work for HQ (its email drafts, app `hq`) counts as spend only: in
the month, shown apart, never an app or a chat line. A kit's `numbers(app)` adds its own fields after it.

A kit's tests of these run HQ's real server with the repo's kits (`node --test kits/<name>/<x>.test.ts`); the platform's
own care tests plug in a made-up company's and pass with or without any kit.
