// The coordinator: serves HQ, its API and the live event feed.
// (its messages say deliverable, the board's word for a thread)
import * as startProfile from './start-profile.ts';
import * as tooling from './tooling.ts';
import * as seatwarning from './seatwarning.ts';
import * as tips from './tips.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, normalize } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PORT, REPO_DIR, KITS_DIR, COMMIT, WORKER_TOKEN, VOICE_TOKEN, ORIGIN, ZONE } from './config.ts';
import { isAuthed, enrollOptions, enrollVerify, loginOptions, loginVerify, keepOwnDevice } from './auth.ts';
import { loginPage, enrollPage, csp, checkoutCsp, hqIndex, hqManifest, darkLogo, logo } from './pages.ts';
import { org, brand, brandLook, theme, gazette, watchGazette, ceo, roles, reads } from './company.ts';
import { library, unshelvedProblem } from './library.ts';
import { TYPES } from './types.ts';
import { attachment, findFile, inside, HQ_DIR, THEME_DIR, hqDir } from './files.ts';
import { subscribe, publish, endAll } from './events.ts';
import { db, companyOnce, scrubOnStart, optimize, inOneStep } from './db.ts'; // (db: the artifact's tip.)
import * as jobs from './jobs.ts';
import * as engineOnly from './engineonly.ts';
import * as room from './room.ts';
import * as blocks from './blocks.ts';
import * as seats from './seats.ts';
import { stallSweep } from './stalls.ts';
import { crashCheck } from './crashes.ts';
import * as summary from './summary.ts';
import * as proposals from './proposals.ts';
import * as reviewinbox from './reviewinbox.ts';
import { writePlan } from './redraws.ts';
import { PlanCycleError } from './plancycles.ts';
import * as plan from './plan.ts';
import * as meetings from './meetings.ts';
import * as meetingseats from './meetingseats.ts';
import * as lowmemory from './lowmemory.ts';
import * as diskwarnings from './diskwarnings.ts';
import * as threadorder from './threadorder.ts';
import { oneTaskThread } from './made.ts';
import * as threadrelease from './threadrelease.ts';
import * as jobcodes from './jobcodes.ts';
import * as threadends from './threadends.ts';
import * as decisions from './decisions.ts';
import * as visualapproval from './visualapproval.ts';
import * as followthrough from './followthrough.ts';
import * as takeover from './takeover.ts';
import * as models from './models.ts';
import { diskCheck, jobReserve } from './disk.ts';
import { startSchedule, recurring, runNow } from './schedule.ts';
import * as onair from './onair.ts';
import * as preview from './preview.ts';
import * as review from './review.ts';
import * as chat from './chat.ts';
import * as call from './call.ts';
import * as ledger from './ledger.ts';
import * as hiring from './hiring.ts';
import * as phone from './phone.ts';
import { checkLine } from './phonecheck.ts';
import * as phonecode from './phonecode.ts';
import * as feedback from './feedback.ts';
import * as carries from './carries.ts';
import * as owed from './owed.ts';
import * as routing from './routing.ts';
import * as holds from './noteholds.ts';
import * as overseer from './overseer.ts';
import * as oversight from './oversight.ts';
import * as windows from './windows.ts';
import * as askwindow from './askwindow.ts';
import * as wakes from './wakes.ts';
import * as work from './work.ts';
import * as commitLines from './commitlines.ts';
import { jobLog, logStep } from './log.ts';
import { jobFacts } from './jobfacts.ts';
import { transcribe } from './voice.ts';
import { teamEvent, inTeam } from './team.ts';
import * as push from './push.ts';
import * as mail from './mail.ts';   // (askMail, mailKind)
import * as notices from './notices.ts';
import type { MailKind, MailAccess } from './mail.ts';
import { testSecrets, secret, validNames, processOnly, redact } from './secrets.ts';
import * as addresses from './addresses.ts';
import * as payments from './payments.ts';
import * as parcels from './parcels.ts';
import * as ordermail from './ordermail.ts';
import * as listmail from './listmail.ts';
import * as closures from './closures.ts';   // a closing product's refunds, with the board's decision
import * as plans from './plans.ts';   // a product's own plans
import * as seal from './seal.ts';   // a product's backup files, sealed and opened
import * as basketmail from './basketmail.ts';   // the basket's confirmation email
import * as codes from './codes.ts';   // the shop's codes
import * as history from './history.ts';   // the shop's order history
import * as approvals from './approvals.ts';
import * as orders from './orders.ts';
import * as photos from './photos.ts';
import * as studio from './studio.ts';
import * as documents from './documents.ts';
import * as zips from './zips.ts';
import * as pictures from './pictures.ts';   // the board's pictures on the intercom and calls
import * as book from './ink/book.ts';   // the board's book: its pages. (Ink's folder)
import { servePicture } from './ink/bookpicture.ts';   // (and their pictures.)
import * as bookfetch from './ink/bookfetch.ts';   // (and one dragged in from the web.)
import { notFound } from './pagescraps.ts';   // (its files)
import { bookFor, people as bookPeople } from './ink/sketchpeople.ts';   // (and invited people's)
import * as booknotes from './ink/booknotes.ts';   // and its sheets and notes
import * as bookasks from './ink/bookasks.ts';   // and the desk-phone cards about its notes and pages
import * as booksheets from './ink/booksheets.ts';   // and its sheets going out.
import * as bookreads from './ink/bookreads.ts';   // and the agents' and calls' reads of its pages
import * as bookslips from './ink/bookslips.ts';   // and the answers clipped onto its notes
import * as bookcalls from './ink/bookcalls.ts';   // and calls' pages
import * as booksearch from './ink/booksearch.ts';   // and its Search.
import './ink/bookreview.ts';   // and review mode's notes on previews, the ones that waited moved in at start
import * as booktyped from './ink/booktyped.ts';   // and a question typed on its page, answered under it
import * as sketchbook from './ink/sketchbook.ts';   // and the Sketchbook, its free pages
import * as notebookguests from './notebookguests.ts';
import * as notebookguestroom from './notebookguestroom.ts';
import * as notebook from './notebook.ts';   // the Notebook: notebooks and their pages
import * as notebookgroups from './notebookgroups.ts';   // and the groups on its pages
import { createScrap } from './notebookscraps.ts';   // a scrap stacked on one
import * as notebooksend from './notebooksend.ts';   // and a page sent in, a reply under an answer
import * as bookanswer from './ink/bookanswer.ts';   // the agents' answers there
import * as callanswer from './ink/callanswer.ts';   // and a call's agent's on its call's notes
import * as notebookpictures from './notebookpictures.ts';   // and a group's pictures
import * as callnotes from './ink/callnotes.ts';   // and a call's notes page
import * as pair from './pair.ts';   // two of the board's devices paired for a session
import { NOTE_MAX, SAVE_MAX } from './pagechecks.ts';
import * as seen from './seen.ts';   // what the board has read, for every device
import * as language from './language.ts';   // the board's language
import * as messages from './messages.ts';
import { oneLine } from './agreements.ts';
import * as memory from './memory.ts';
import * as merged from './merged.ts';
import * as estimates from './estimates.ts';
import * as when from './when.ts';
import * as forecast from './forecast.ts';
import * as ordering from './ordering.ts';
import * as outlooks from './outlooks.ts';
import * as goingon from './goingon.ts';
import * as predictionlog from './predictionlog.ts';   // each play's predictions logged where they moved, written a minute's at a time
import * as snapshots from './snapshots.ts';   // the play's input kept hourly, for the backtest, written with the log
import * as backtest from './backtest.ts';
import * as calibration from './calibration.ts';
import * as accuracy from './accuracy.ts';
import * as meetinggist from './meetinggist.ts';
import * as plainnames from './plainnames.ts';
import * as handwriting from './handwriting.ts';
import * as smallmodel from './smallmodel.ts';
import { boardJob, boardJobs } from './boardnames.ts'; // (the jobs the board reads, by its names)
import * as sizes from './sizes.ts';
import * as moves from './moves.ts';
import * as projects from './projects.ts';
import * as pad from './pad.ts';
import * as goals from './goals.ts';
import * as reviewrows from './reviewrows.ts';
import * as projectorder from './projectorder.ts';   // the board's order of the projects' tiles
import * as pauses from './pauses.ts';
import * as pausewake from './pausewake.ts';
import { jobThread } from './newthread.ts';
import * as regroup from './regroup.ts';
import * as backup from './backup.ts';
import * as watch from './watch.ts';   // the watch on live apps
import * as spend from './spend.ts';
import * as metrics from './metrics.ts';
import * as guests from './guests.ts';
// the desk phone's own reading of a card, so a card is checked as the board will see it
import { cardProblem } from '../../hq/shell/cardcheck.js';
import { pairsOf, pictureFile } from '../../hq/shell/media.js';
import { looks } from '../../hq/looks.mjs';
import { BOARD_EXTRAS, OPEN_EXTRAS } from '../../hq/extras.mjs';
import { filmFiles } from '../../hq/films/listing.mjs';
import * as apps from './apps.ts';
import * as artifacts from './artifacts.ts';
import * as kits from './kits.ts';   // the company's own parts
import * as care from './care.ts';   // Care, the board's support desk
import * as outbox from './outbox.ts';   // emails to outside parties, drafted by agents, sent by the board
import * as mailforward from './mailforward.ts';   // the bookkeeping mail's copies to the board's own address, and Finance's books to it.
import * as cardFiles from './cardfiles.ts';   // files on a card, to download
import * as reviewBriefs from './reviewbriefs.ts';   // review runs' briefs a week after their pull request settled
import * as callouts from './callouts.ts';   // calls out to partners, filed by agents, approved by the board
import * as callcard from './callcard.ts';   // their card on the desk phone, Call and Don't call
import * as callsweep from './callsweep.ts';   // the dial, and the sweep every minute
import * as callline from './callline.ts';   // and the call itself: the voice line's routes, Twilio's word, the join page
import * as watchalong from './watchalong.ts';
import * as callviews from './callviews.ts';
import * as careNumbers from './care-numbers.ts';   // the lines marked "Care › Numbers"
import * as careCredit from './care-credit.ts';
import * as heldLines from './held-lines.ts';   // a product's paid lines held for a person
import * as later from './later.ts';   // cards kept off the desk phone until a day
import * as claimobservation from './claimobservation.ts';
import * as latency from './latency.ts';   // how fast HQ answers (infra/report.sh)
import * as reins from './reins.ts';   // each job's share of HQ's time
import { stalled } from './stalljobs.ts';
import * as runs from './runs.ts';   // long runs sent to a helper machine (hq run).
import * as testresults from './testresults.ts';   // pushes' tests, kept by the code they tested.
import * as machines from './machines.ts';   // the machines that take them
import { routes, JSON_MAX, readBody, parseJson, type RouteHandler, type RouteRequest, type RouteTable } from '../../../shared/routes/routes.ts';
const MODULES_LOADED_MS = performance.now();

// HQ's own version: a fingerprint of the files it's made of (not the repo's commit, which moves with every product
// change), so an open HQ only offers to move in when HQ itself changed. Recomputed at most every 30 s.
// head: the checkout's commit then, which an open HQ asks what changed since (GET /api/hq/changes).
let hqVersion = { at: 0, v: '', head: '' };
// (safe.directory: the checkout is root's on the server, mounted read-only, as committed.ts reads it)
const git = (...args: string[]) => execFileSync('git', ['-c', `safe.directory=${REPO_DIR}`, '-C', REPO_DIR, ...args],
  { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 << 20 }).trim();
function hqFingerprint() {
  if (Date.now() - hqVersion.at < 30_000) return hqVersion.v;
  const h = createHash('sha1');
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['screenshots', 'mock', 'classic'].includes(e.name)) continue;
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p); else if (/\.(html|js|css|webmanifest|svg|png)$/.test(e.name)) h.update(p).update(readFileSync(p));
    }
  };
  // (and the company's HQ apps, kits/<name>/hq, from the same copy as the kits' routes)
  const kitDirs = () => { try { return readdirSync(KITS_DIR).sort().map(k => `${KITS_DIR}/${k}/hq`); } catch { return []; } };
  try { for (const dir of [HQ_DIR, THEME_DIR, ...kitDirs()]) if (existsSync(dir)) walk(dir); hqVersion = { at: Date.now(), v: h.digest('hex').slice(0, 12), head: hqVersion.head }; } catch { /* keep the last one */ }
  try { hqVersion.head = git('rev-parse', 'HEAD'); } catch { /* no git: no list of changes */ }
  return hqVersion.v;
}
const WEBAUTHN = new URL('../node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js', import.meta.url);
// HQ's files a browser fetches without the board's session
const PUBLIC = new Set(['/icon.svg', '/icon-192.png', '/icon-512.png',
  '/icon-maskable-512.png', '/apple-touch-icon.png', '/favicon-32.png', '/badge-96.png', // and the brand's dark logo (the login page's)
  '/phone/chime.mp3', // Twilio plays it to callers before the shops' phone message (phone.ts)
  '/sw.js', // the service worker: browsers fetch and re-check it for updates, and a redirect to /login would break it
]);

// HQ's pages run with the board's session: script only from HQ's own files (and the inline scripts of the pages
// in pages.ts, by hash). Files under /knowledge/ and /cycles/ are written by agents and get their own sandbox.
const HQ_CSP = csp();
// The watch-along's replay (shared/watchalong/replay.html, framed by HQ's call player) draws a recorded page's own
// stylesheets, which are inline, and runs only its two scripts: nothing the recorded page carries (an onerror, a
// javascript: address) runs, in its frame or in the replayer's frames under it, which take its policy on. A walk-through
// of a preview (a guest's, or one in HQ's viewer) draws with that preview's pictures, styles and fonts, which the board's
// own browser may load.
const REPLAY_PAGE = '/shared/watchalong/replay.html', PREVIEWS = ZONE ? `https://*${preview.PREVIEW}` : '';
const REPLAY_CSP = `default-src 'self'; script-src ${ORIGIN}/shared/watchalong/replay.js ${ORIGIN}/shared/watchalong/vendor/rrweb-replay.js; ` +
  `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com ${PREVIEWS}; font-src 'self' data: https://fonts.gstatic.com ${PREVIEWS}; ` +
  `img-src 'self' data: blob: ${PREVIEWS}; media-src 'self' blob: ${PREVIEWS}; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; ` +
  "frame-ancestors 'self'";
const PAGE_CSP: Record<string, string | undefined> = { '/login': csp(loginPage()), '/enroll': csp(enrollPage()), [REPLAY_PAGE]: REPLAY_CSP };

// The words of a route's refusal by its status alone
const ERRORS: Record<number, string> = { 400: 'invalid', 403: 'not allowed', 404: 'not found', 409: 'it changed meanwhile', 413: 'too long', 429: 'too many' };
// A refusal that says why, for the caller to pass on as is (hq job prints it; on a call the agent hears it).
// `more`: what the caller needs besides the words to act on it, e.g. which pictures a line can't go with
class Refused {
  status: number; error: string; more: Record<string, unknown>;
  constructor(status: number, error: string, more = {}) { this.status = status; this.error = error; this.more = more; }
}
// One app's numbers (metrics.ts) with the support chat's line for the same days and mode, when it has one (Care › Numbers),
// and what the company's parts add (kits.ts)
const withChat = (r: any) => kits.numbers(r?.slug ? { ...r, chat: careNumbers.line(r.slug, r.mode, r.days) } : r);
const refusal = (r: unknown) => typeof r === 'string' ? new Refused(400, r) : Array.isArray(r) ? new Refused(r[0], r[1], r[2]) : r;
// A board's route on a book it names (who: its own, or an invited person's, sketchpeople.ts bookFor): then's answer, or
// none's for a book that isn't one (404).
const inBook = (who: unknown, then: (who: string) => unknown, none: () => unknown = () => 404) => {
  const found = bookFor(who);
  return found ? then(found) : none();
};
// What HQ refuses a job that holds a customer's details for good (outbox.ts file, guests.ts write): recorded, so the job's
// ending done doesn't handle a call item it carries (ledger.ts withheld).
const refusedDeliverable = (me: Me, what: string, r: unknown) => {
  if (Array.isArray(r) && r[0] === 403 && jobs.holdsCustomerData(me.id)) ledger.refused(me.id, what, "the job held a customer's details");
  return refusal(r);
};
// hq item link to a job: one that now carries an item of a customer call reads that call (ledger.mine), so it holds their
// details from here on, as one handed out for it does.
const linked = (item: number, job: number | undefined, r: unknown) => {
  const call = ledger.itemCall(item);
  if (job && (r as { ok?: boolean })?.ok && call != null && ledger.mine(job, call) && memory.customerCall(call)) jobs.handedCustomerData(job);
  return refusal(r);
};
// The CEO's job, on an item ready for the board's yes (ledger.ts done)
const ceoOnReady = (me: Me, id: number) => !me.call && me.agent === ceo() && ledger.item(id)?.status === 'ready';
// A job reads a call and corrects its items when it works for it (ledger.mine), or follows up a call that carried on from
// it (ledger.resumed: the board rang back before it was followed up), or is org.yaml's roles.asks's (keepsAsks).
const works = (me: Me, call: number) => ledger.mine(me.id, call) || ledger.resumed(me.id, call) || keepsAsks(me, call);
// A job of org.yaml's roles.asks sees that every call's items have work and close: it reads any call's
// items, links them and hands them out as the call's follow-up does, but drops and replaces none (that cancels jobs and
// changes the board's words: ledger.decides, the follow-up's). Only a call any agent reads (memory.callAccess): not one
// about a customer (charter rule 7), a card for keys or still live.
const keepsAsks = (me: Me, call: number) => !me.call && !!me.id && me.agent === roles().asks
  && !memory.customerCall(call) && !memory.keysCall(call) && memory.callAccess(call, me) === true;
// hq items: what's open on every call. An item's goal comes from what was said on its call, so it goes only to a reader
// who may read that call (one that works for it, or memory.ts callAccess: not a live call, a card for keys or a
// customer's), and a customer call's marks its reader, as hq call does: its job, or on a call the call itself (jobs.ts
// readerHanded), whose transcript then goes only to its follow-up.
function openItemsFor(me: Me) {
  const reads = new Map<number, boolean>();
  const readable = (call: number) => reads.get(call) ?? reads.set(call, works(me, call) || memory.callAccess(call, me) === true).get(call)!;
  const list = ledger.openItems().map(({ goal, ...i }) => goal != null && readable(i.call) ? { ...i, goal } : i);
  if (list.some(i => 'goal' in i && memory.customerCall(i.call))) jobs.readerHanded(me);
  return list;
}
const send = (res: ServerResponse, code: number, body: unknown, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type });
  res.end(typeof body === 'string' || body instanceof Buffer ? body : JSON.stringify(body));
};

// the routes whose JSON carries files (cardfiles.ts JSON_MAX): a card's, and a guest checklist's items' (guests.ts)
const FILE_ROUTES = new Set(['POST /api/agent/request', 'POST /api/agent/guest', 'POST /api/agent/guest-add']);
// Streams a file, honouring a single byte range: Safari won't play a video without one (the cycle presentations).
// Its tag (size and modified time) lets a browser check a copy it holds: a no-cache file it already has comes back as a
// bodiless 304, never sent again. (Its lookup, findFile, is shared with cyclePage. files.ts)
// `scripts: false`: a script goes out as plain text, which the browser won't run (nosniff), so no page on HQ's origin can
// load one from the folder (audit P18: the Library's are research scripts and covers' drawing code, which HQ never runs).
async function sendFile(req: IncomingMessage, res: ServerResponse, dir: string, path: string, scripts = true) {
  const found = findFile(dir, path);
  if (!found) return send(res, 404, 'not found', 'text/plain');
  const { real, size, modifiedMs } = found, m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  const tag = `W/"${size.toString(36)}-${Math.trunc(modifiedMs).toString(36)}"`;
  res.setHeader('etag', tag);
  if (String(req.headers['if-none-match'] ?? '').split(/\s*,\s*/).includes(tag)) { res.writeHead(304); return res.end(); }
  const type = !scripts && found.type === TYPES['.js'] ? 'text/plain; charset=utf-8' : found.type;
  let start = 0, end = size - 1;
  if (m && (m[1] || m[2])) {
    start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end) { res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end(); }
  }
  const partial = end - start + 1 < size;
  res.writeHead(partial ? 206 : 200, { 'content-type': type, 'content-length': end - start + 1, 'accept-ranges': 'bytes',
    ...(partial ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) });
  if (req.method === 'HEAD' || size === 0) return res.end();
  await pipeline(createReadStream(real, { start, end }), res).catch(() => res.destroy());
}
// A page of the cycles' (cycles.preview.<zone>, infra/products.py sends their HTML here behind the preview login), with review
// mode added: agents write these pages by hand, and the board's pin comes with every one of them, a demo opened from a deck
// too, without each page having to carry the script. An outside reviewer's share opens its own folder's (preview.ts viewer).
async function cyclePage(req: IncomingMessage, res: ServerResponse, path: string) {
  if (!preview.viewer(req, String(req.headers.host ?? '').toLowerCase(), req.url ?? '/')) return send(res, 403, 'not allowed', 'text/plain');
  const found = findFile(`${REPO_DIR}/products/_cycles`, path.endsWith('/') ? `${path}index.html` : path);
  if (found?.type !== TYPES['.html']) return send(res, 404, 'not found', 'text/plain');
  // the same frame-ancestors as Caddy's for the site: HQ's viewer and the cycles' own pages may frame it
  res.setHeader('content-security-policy', `frame-ancestors 'self' ${ORIGIN}`);
  res.setHeader('cache-control', 'no-cache');
  return send(res, 200, feedback.withReviewMode(await readFile(found.real, 'utf8')), TYPES['.html']);
}
// The board's routes, from HQ's pages: a value is the JSON, a number an error status, a Refused a refusal in words
type BoardRoute = (req: IncomingMessage, res: ServerResponse, body: any) => unknown;
// Its sign-in, before it has a session (auth.ts)
const signIn: Record<string, BoardRoute> = {
  'POST /api/notebooks/pair/join': (q, s, b) => pair.joinDevice(q, s, b),
  'POST /api/enroll/options': enrollOptions,
  'POST /api/enroll/verify': enrollVerify,
  'POST /api/login/options': loginOptions,
  'POST /api/login/verify': loginVerify,
};
const api: Record<string, BoardRoute> = {
  'POST /api/notebooks/pair': q => pair.createCode(q),
  // (machines: the machines lent for long runs, live, as GET /api/machines has them, for every look's rig; shows: On
  // Air's, by name and hosts, for Brownstone's recording booth)
  // (studio: the photo studio's darkroom, or null: studio.ts office.)
  'GET /api/org': () => ({ ...care.getOrg(), machines: runs.listMachines(), shows: onair.shows().map(({ id, name, hosts }) => ({ id, name, hosts: hosts ?? [] })),
    studio: studio.office() }),
  // (care: the company runs the care service; studio: the photo studio.)
  'GET /api/brand': () => ({ brand: brandLook(), theme: theme(), care: care.runs(), studio: studio.runs() }),
  'GET /api/gazette': () => gazette(),
  'GET /api/library': () => library(),
  'GET /api/search/meaning': q => memory.nearest(new URL(q.url ?? '/', 'http://x').searchParams.get('q')), // HQ's go-to-anything search
  'GET /api/me': () => ({ authenticated: true }),
  // What changed in HQ's files since the checkout an open HQ loaded from (main.js checkHealth): its commits, newest first
  'GET /api/hq/changes': q => {
    const since = new URL(q.url ?? '/', 'http://x').searchParams.get('since') ?? '';
    if (!/^[0-9a-f]{7,40}$/.test(since)) return { changes: [] };
    try { return { changes: git('log', '--no-merges', '--format=%s', `${since}..HEAD`, '--', 'platform/hq', 'theme/hq', ':(glob)kits/*/hq/**').split('\n').filter(Boolean) }; }
    catch { return { changes: [] }; }
  },
  'GET /api/jobs': () => boardJobs(jobs.listJobs()),
  'GET /api/room': () => room.getRoom({ board: true }),   // (the projects view: no jobs start for memory, naming no job)
  // (each thread with its outlook: outlooks.ts, and its pause: pauses.ts)
  'GET /api/projects': () => pauses.withPauses(outlooks.withOutlooks(projects.listProjectBoard(), forecast.current())),
  // (a done thread with its jobs, which the projects view opens.)
  'GET /api/projects/thread': q => projects.getThread(String(new URL(q.url ?? '/', 'http://x').searchParams.get('id') ?? '')),
  'GET /api/projects/findings': q => reviewrows.findingsOf(Number(new URL(q.url ?? '/', 'http://x').searchParams.get('job'))),
  'POST /api/projects/order': (q, s, b) => refusal(projectorder.orderProjects(b.order)),
  'GET /api/schedule': () => recurring(),
  'GET /api/meetings': () => meetings.list(), // (the meeting room: live and planned meetings.)
  'POST /api/schedule/run': (q, s, b) => refusal(runNow(String(b.id ?? ''))),
  // On Air: the shows and their episodes, and a show's new private feed link (onair.ts)
  'GET /api/onair': () => onair.board(),
  'POST /api/onair/link': (q, s, b) => refusal(onair.renew(String(b.show ?? ''))),
  // Settings › Overseer: the address and key the board gives the Overseer, and a new key that ends the old one
  // (oversight.ts)
  'GET /api/oversight': () => oversight.forBoard(),
  'POST /api/oversight/renew': () => oversight.renew(),
  'GET /api/work': () => ({ days: work.days(), agents: work.agents() }),
  'GET /api/work/piles': () => work.piles(), // (HQ's throughput, hud.js)
  'GET /api/jobs/find': q => ({ job: boardJob(jobs.findJob(Number(new URL(q.url ?? '/', 'http://x').searchParams.get('id')))) }),
  'GET /api/jobs/log': q => jobLog(Number(new URL(q.url ?? '/', 'http://x').searchParams.get('id'))),
  // (a job's record for its card's back.)
  'GET /api/jobs/facts': q => jobFacts(Number(new URL(q.url ?? '/', 'http://x').searchParams.get('id'))),
  'GET /api/chat': () => chat.history(),
  'GET /api/calls': () => call.calls(),
  // "We missed something": one item the board adds to a call, and the call is followed up again (ledger.ts missed())
  'POST /api/calls/item': (q, s, b) => ledger.missed(Number(b.call), b.what),
  // a watch-along on the board's live call, by the call's key (watchalong.ts).
  'POST /api/watchalong/start': (q, s, b) => watchalong.startOnCall(Number(b.call), String(b.key ?? '')),
  'POST /api/chat': (q, s, b) => refusal(chat.fromBoard(String(b.text ?? ''), b.pictures)),
  // HQ's Seats: the board's own changes to the seats, each carried out by the worker (seats.ts).
  'POST /api/seats/add': (q, s, b) => refusal(seats.addSeat(b ?? {})),
  'POST /api/seats/remove': (q, s, b) => refusal(seats.removeSeat(String(b.seat ?? ''))),
  'POST /api/seats/pause': (q, s, b) => refusal(seats.pauseSeat(String(b.seat ?? ''), b.paused !== false)),
  'POST /api/seats/sign-in': (q, s, b) => refusal(seats.signInSeat(String(b.seat ?? ''))),
  'POST /api/seats/code': (q, s, b) => refusal(seats.sendSeatCode(String(b.seat ?? ''), b.code)),
  'POST /api/seats/key': (q, s, b) => refusal(seats.sendSeatKey(String(b.seat ?? ''), b.key)),
  // a seat's stop level, and pacing on or off for all seats
  'POST /api/seats/stop': (q, s, b) => refusal(seats.stopSeat(String(b.seat ?? ''), b.stop)),
  'POST /api/seats/pacing': (q, s, b) => refusal(seats.setPacing(b.on)),
  // whether a seat may spend its account's credits past its plan (the board's choice).
  'POST /api/seats/credits': (q, s, b) => refusal(seats.creditsSeat(String(b.seat ?? ''), b.on)),
  'GET /api/seats/providers': () => seats.listSeatProviders(),
  // HQ's Machines: the machines the board lends for long runs, live, and its changes to them (runs.ts, machines.ts)
  'GET /api/machines': () => runs.listMachines(),
  'GET /api/machines/setup': () => runs.machineSetup(),
  'POST /api/machines/add': (q, s, b) => refusal(runs.addMachine(b.name)),
  'POST /api/machines/rename': (q, s, b) => refusal(machines.renameMachine(Number(b.machine), b.name)),
  'POST /api/machines/colour': (q, s, b) => refusal(machines.colourMachine(Number(b.machine), b.body ?? null, b.glow ?? null)),
  'POST /api/machines/pause': (q, s, b) => refusal(machines.pauseMachine(Number(b.machine), b.paused !== false)),
  'POST /api/machines/remove': (q, s, b) => refusal(machines.removeMachine(Number(b.machine))),
  'POST /api/machines/install': (q, s, b) => refusal(runs.newInstall(Number(b.machine))),
  // each agent's main model and its one fallback, as the board picks them on the agent's page (models.ts).
  'GET /api/agents/models': () => models.listAgentModels(),
  'POST /api/agents/model': (q, s, b) => refusal(models.setAgentModels(String(b.agent ?? ''), b.main, b.fallback)),
  // the board's tray of pictures for its next line: shown again when the intercom opens, and one it removes is deleted
  // (pictures.ts)
  'GET /api/pictures/waiting': q => pictures.unsent(Number(new URL(q.url ?? '/', 'http://x').searchParams.get('request') ?? 0)),
  'POST /api/pictures/forget': (q, s, b) => pictures.forget(Number(b.id)),
  // the board's book: a day's pages, a page, a new one, its label, archive and delete (book.ts; a save and a note are
  // board rows, for their size), its sheets and notes (booknotes.ts) and slips (bookslips.ts).
  // (who: an invited person's book, the board's too to open and draw in, sketchpeople.ts bookFor; the people with one.
  'GET /api/book': (q, s, b) => inBook(b.who, who => book.listPages(b, who)),
  'GET /api/book/page': (q, s, b) => inBook(b.who, who => book.getPage(Number(b.id), who)),
  // (a call's page: its notes page, open already, if it has one.)
  'POST /api/book/page/new': (q, s, b) => inBook(b.who, who => refusal(callnotes.openPageOf(b, who) ?? book.createPage(b, who))),
  'GET /api/book/people': () => bookPeople(),
  'POST /api/book/page/label': (q, s, b) => refusal(book.labelPage(b)),
  'POST /api/book/page/archive': (q, s, b) => refusal(book.archivePage(b)),
  'POST /api/book/page/delete': (q, s, b) => refusal(book.deletePage(Number(b.id))),
  'GET /api/book/notes': (q, s, b) => booknotes.pageNotes(Number(b.page)),
  'POST /api/book/note/edit': (q, s, b) => refusal(booknotes.editNote(b)),
  'POST /api/book/note/move': (q, s, b) => refusal(booknotes.moveNote(b)),
  'POST /api/book/note/delete': (q, s, b) => refusal(booknotes.wipeNote(Number(b.id))),
  'POST /api/book/note/restore': (q, s, b) => refusal(booknotes.restoreNote(b)),
  'GET /api/book/sheets': () => booksheets.sheets(),
  'GET /api/book/calls': (q, s, b) => refusal(booksheets.callSheets(b.pages)),
  'POST /api/book/sheet/order': (q, s, b) => refusal(booknotes.orderSheet(b)),
  'POST /api/book/send': (q, s, b) => refusal(booksheets.send(Number(b.id), undefined, b.spots)), // (spots)
  'POST /api/book/undo': (q, s, b) => refusal(booksheets.undo(Number(b.id))),
  // two notes linked, and a free page sent on its own
  'POST /api/book/note/link': (q, s, b) => refusal(booknotes.linkNotes(b)),
  'POST /api/book/page/send': async (q, s, b) => refusal(await booksheets.sendPage(b)),
  'POST /api/book/slip/tick': (q, s, b) => refusal(bookslips.tick(b)),
  'POST /api/book/slip/reply': (q, s, b) => refusal(bookslips.replyTo(b)),
  // the book's words found: notes written, said or typed, and answers
  'GET /api/book/search': (q, s, b) => booksearch.searchBook(b.q),
  // the words in the board's ink, read by a small model (handwriting.ts.)
  'POST /api/book/read': async (q, s, b) => refusal(await handwriting.read(b)),
  // the board's Sketchbook, on the book's free pages (sketchbook.ts; its save is a board row, for its size).
  'GET /api/sketches': () => sketchbook.listSketches(),
  'GET /api/sketches/ink': (q, s, b) => sketchbook.getSketch(Number(b.id)),
  'POST /api/sketches/create': (q, s, b) => refusal(sketchbook.createSketch(b)),
  'POST /api/sketches/label': (q, s, b) => refusal(sketchbook.labelSketch(b)),
  'POST /api/sketches/archive': (q, s, b) => refusal(sketchbook.archiveSketch(b)),
  'POST /api/sketches/delete': (q, s, b) => refusal(book.deletePage(Number(b.id))),
  'POST /api/sketches/send': async (q, s, b) => refusal(await sketchbook.sendSketch(Number(b.id))),
  // the Notebook: the shelf, a notebook's pages, a page's groups, a page sent (notebook*.ts; a group's elements are board
  // rows, for their size.).
  'GET /api/notebooks/guests': (q, s, b) => notebookguests.listNotebooks(undefined, Number(b.notebook) || undefined),
  'GET /api/notebooks/guests/list': (q, s, b) => notebookguests.listNotebooks(undefined, Number(b.notebook) || undefined),
  'POST /api/notebooks/guests': (q, s, b) => refusal(notebookguests.createNotebook(b)),
  'POST /api/notebooks/guests/revoke': (q, s, b) => refusal(notebookguests.revokeNotebook(b)),
  'GET /api/notebooks/guests/pages': (q, s, b) => refusal(notebookguests.listPages(b)),
  'GET /api/notebooks/guests/groups': (q, s, b) => refusal(notebookguestroom.listBoardGroups(b)),
  'GET /api/notebooks': () => notebook.listNotebooks(),
  'POST /api/notebooks/archive': (q, s, b) => refusal(notebook.archiveNotebook(b)),
  'GET /api/notebooks/pages': (q, s, b) => refusal(notebookguests.boardPages(b)),
  'POST /api/notebooks/pages/create': (q, s, b) => refusal(notebookguests.boardCreatePage(b)),
  'POST /api/notebooks/pages/order': (q, s, b) => refusal(notebook.orderPages(b)),
  'POST /api/notebooks/pages/archive': (q, s, b) => refusal(notebook.archivePage(b)),
  'POST /api/notebooks/pages/title': (q, s, b) => refusal(notebook.titlePage(b)),
  'POST /api/notebooks/pages/send': async (q, s, b) => refusal(await notebooksend.sendPage(b)),
  'POST /api/notebooks/pages/undo': (q, s, b) => refusal(notebooksend.undoSend(b)),
  'GET /api/notebooks/pages/groups': (q, s, b) => refusal(notebookgroups.listGroups(b)),
  'POST /api/notebooks/groups/move': (q, s, b) => refusal(notebookgroups.moveGroup(b)),
  'POST /api/notebooks/groups/delete': (q, s, b) => refusal(notebookgroups.deleteGroup(b)),
  'POST /api/notebooks/replies/delete': (q, s, b) => refusal(notebooksend.deleteReply(b)),
  'POST /api/notebooks/groups/restore': (q, s, b) => refusal(notebookgroups.restoreGroup(b)),
  'POST /api/notebooks/groups/join': (q, s, b) => refusal(notebookgroups.joinGroups(b)),
  'POST /api/notebooks/groups/split': (q, s, b) => refusal(notebookgroups.splitGroup(b)),
  // the agents' answers: a form answered, an answer ticked (a version picked), and what waits on the board (bookanswer.ts;
  'POST /api/notebooks/answers/form': (q, s, b) => refusal(bookanswer.answerForm(b)),
  'POST /api/notebooks/answers/tick': (q, s, b) => refusal(bookanswer.tickAnswer(b)),
  'GET /api/notebooks/open': () => bookanswer.openList(),
  // (the live call's notes page, opened as the call starts. callnotes.ts)
  'POST /api/notebooks/call': async (q, s, b) => refusal(await callnotes.openFor(b)),
  'POST /api/preview/link': (q, s, b) => preview.link(String(b.url ?? '')),
  'POST /api/jobs': (q, s, b) => jobs.createJob({ agent: b.agent ?? ceo(), title: b.title, prompt: b.prompt ?? b.title }),
  'GET /api/seats': () => seats.listSeats(),
  'GET /api/mail': () => mail.listMail(),
  'GET /api/mail/one': q => mail.getMail(Number(new URL(q.url ?? '/', 'http://x').searchParams.get('id'))),
  // Mail's "Send to the team" on a mail of the board's own: a job for brand.yaml's mail.forwardTo, the only one that reads it
  // (mail.ts forward).
  'POST /api/mail/forward': (q, s, b) => refusal(mail.forward(Number(b?.id), j => jobs.findAgent(j.agent) ? jobs.createJob(j) : null)),
  // Mail's and the Gazette's read marks, one set for all the board's devices
  'GET /api/seen': () => seen.all(),
  'POST /api/seen': (q, s, b) => refusal(seen.mark(b?.list, b?.newest)),
  // The board's language (language.ts): what it reads and hears from its agents, the languages offered, and its choice
  // (the intake's first question, Settings › Language).
  'GET /api/language': () => language.language(),
  'POST /api/language': (q, s, b) => refusal(language.setLanguage(b?.lang)),
  'GET /api/requests': () => tips.onPhone(jobs.listRequests().map(guests.card).map(outbox.card).map(callcard.card).map(bookasks.card)),   // (callcard; tips; bookasks)
  'GET /api/requests/archive/index': () => jobs.listArchiveIndex(),
  'GET /api/requests/archive': q => { const a = jobs.listArchive(Number(new URL(q.url ?? '/', 'http://x').searchParams.get('before')) || undefined);
    return { ...a, cards: a.cards.map(guests.card).map(outbox.card).map(callcard.card) }; },
  // Cards for later (later.ts): the ones off the desk phone until a day, and the board's snooze on a card (day:
  // '2026-10-13'), or day null to bring one back now.
  'GET /api/requests/later': () => later.listLaterRequests(),
  'POST /api/requests/later': (q, s, b) => later.snoozeRequest(Number(b.id), b.day ?? null),
  // A guest card's address (the first time), its guest's language, and its New link, Revoke and Close (guests.ts); each
  // person's (person: their name: revoke 'person' is the card's Remove), their Send link (release) and Invite (person)
  'POST /api/guest/email': (q, s, b) => guests.setEmail(Number(b.id), b.email),
  'POST /api/guest/lang': (q, s, b) => guests.setLang(Number(b.id), b.lang, b.person),
  'POST /api/guest/release': (q, s, b) => guests.release(Number(b.id), b.person),   // its Share
  'POST /api/guest/revoke': (q, s, b) => guests.revoke(Number(b.id), b.what, b.person),
  'POST /api/guest/person': (q, s, b) => refusal(guests.addPerson(Number(b.id), b.name, b.email)),
  'POST /api/guest/colleagues': (q, s, b) => refusal(guests.setColleagues(Number(b.id), b.on)),
  // An email card's Send and Discard (outbox.ts), its only answers
  'POST /api/outbox/send': async (q, s, b) => refusal(await outbox.send(b)),
  'POST /api/outbox/discard': (q, s, b) => refusal(outbox.discard(b)),
  // the card's words for its letter's preview
  'POST /api/outbox/preview': (q, s, b) => refusal(outbox.savePreview(b)),
  // A call card's Call and Don't call (callcard.ts), its only answers, and its number whole for the board
  'POST /api/callouts/approve': (q, s, b) => refusal(callcard.approve(b)),
  'POST /api/callouts/decline': (q, s, b) => refusal(callcard.decline(b)),
  'GET /api/callouts/number': q => callcard.number(q),
  'POST /api/requests/answer': (q, s, b) => outbox.waiting(Number(b.id)) ? new Refused(409, 'an email card: Send or Discard')
    : callcard.waiting(Number(b.id)) ? new Refused(409, "a call card: Call or Don't call")
    : refusal(jobs.answerRequest(Number(b.id), String(b.answer ?? ''), b.secrets ?? {}, b.approve === true, b.address ?? {}, b.answers, b.pictures, b.review === true)),   // a key's why (review)
  // The feature tips (tips.ts): the Settings switch, a tip's Got it or its Show me done (shown), and an event only HQ's
  // page sees (the logo pressed, an urgent card on a device without notifications).
  'GET /api/tips': () => tips.getTips(),
  'POST /api/tips': (q, s, b) => refusal(tips.setTips(b ?? {})),
  'POST /api/tips/end': (q, s, b) => refusal(tips.endTip(Number(b?.id), b?.shown === true)),
  'POST /api/tips/events': (q, s, b) => refusal(tips.pageEvent(String(b?.key ?? ''))),
  // the board removes a saved delivery address (addresses.ts), from an address card
  'POST /api/addresses/remove': (q, s, b) => refusal(addresses.remove(Number(b.id))),
  'GET /api/push/key': () => ({ key: push.publicKey, devices: push.devices() }),
  'POST /api/push/subscribe': (q, s, b) => push.subscribe(b, q.headers['user-agent']),
  'POST /api/push/unsubscribe': (q, s, b) => push.unsubscribe(b),
  'POST /api/push/test': (q, s, b) => push.sendTest(b),
  // (with the company's parts' dashboards, for the days a dashboard's switch asks for)
  'GET /api/numbers': q => { const r = metrics.numbers({ days: new URL(q.url ?? '/', 'http://x').searchParams.get('days') }); return Array.isArray(r) ? new Refused(r[0], r[1]) : kits.numbers(r); },
  'GET /api/apps': () => apps.list(),   // HQ-OS › Numbers' apps
  'GET /api/artifacts': () => artifacts.list(),   // HQ-OS › Artifacts
};

// Workers (platform/worker) authenticate with a shared token and never see the board's session. Only the worker
// process holds that token; agents get a token of their own per job (below).
// Review, login and guest requests are the coordinator's own (answering one merges a PR or signs in a seat; hq guest
// makes a guest card, whose Share is a link to the guest's page; hq mail draft an email card, sent from HQ: outbox.ts,
//); keys are partner keys, and the server's own (its GitHub
// key, phone line and backups: secrets.ts processOnly) are the process team's to
// ask for (they never reach agents, but the board shouldn't be asked by anyone); only an
// approval request says what it approves. Asked live (hq ask) or parked (hq request, .hq/request.json), the same rules.
// A gated tool's card (approvals.ts register) is the coordinator's own too. A key reaches the server only through a card's
// key fields, so a credential request names the keys it asks for (an answer box would take a typed key).
const plainCredential = (r: any) => r.kind === 'credential' && !r.secrets;
// A card has a kind and a title, as strings: a worker's malformed .hq/request.json is refused like any other
const agentRequest = (r: any, agent?: string) => typeof r.kind === 'string' && typeof r.title === 'string' && r.title !== '' && r.kind !== 'review' && r.kind !== 'login' && r.kind !== 'guest' && r.kind !== 'mail' && r.kind !== 'call' && r.kind !== 'late' && !approvals.toolKind(String(r.kind)) &&   // (late: reserved for HQ; call: callouts.ts)
  !plainCredential(r) &&
  // a notice asks nothing: no keys, approval, fields or decision
  (r.kind !== 'notice' || !(r.secrets || r.approves || r.address || r.photos || r.documents || r.zips || r.questions || r.decides)) &&
  (!r.secrets || validNames(r.secrets)) && (!processOnly(String(r.secrets ?? '')) || jobs.inProcess(agent ?? '')) &&
  (!r.approves || (r.kind === 'approval' && approvals.GRANT.test(r.approves)));
const util = (v: unknown) => typeof v === 'number' && v >= 0 ? v : 1;
const REDACT_MAX = 1_000_000;   // characters the worker masks at most (SIGNED_IN_MAX is sized from it)
const worker: Record<string, (b: any) => unknown> = {
  // util: the seat's share of its window, the fuller of the 5-hour and the weekly one (unknown counts as full, so no
  // downtime work starts on a guess). A Codex seat's window is only known from a Codex run, so `probe` (at most one claim
  // at a time, while it's unknown) may start downtime work to measure it; that job yields at its first reading if the
  // seat was already past DOWNTIME_UNDER.
  // room: the worker is below its room line with that many MB free, so a job starts only when its measured memory fits
  // (jobs.ts claim).
  // pacedUntil: the seat's week is running ahead of its pace, so until that weekly reset it takes only the board's word
  // and work that must start before it (the worker's pacedUntil)
  // (a pull request's review, ruling or fix with the board's word from a call as it stands)
  // ownsProject: the project its agent owns through its thread, whose sentence its briefing asks it to keep true
  // (projects.ts withOwnedProject, the worker's closing.ts).
  // resize: a work job's size, for its briefing's line on re-sizing it (sizes.ts withSize).
  // (nothing to start in a slot that holds a meeting's seat: `held`, so the worker keeps its room.)
  'POST /api/worker/claim': b => sizes.withSize(projects.withOwnedProject(review.withTold(jobs.claim(b.seat, b.engine, b.kind === 'chat' ? 'chat' : undefined, b.probe === true ? 0 : util(b.util), b.probe === true,
    typeof b.slot === 'string' ? b.slot : undefined, Number.isInteger(b.room) && b.room >= 0 ? b.room : undefined,
    Number.isInteger(b.pacedUntil) && b.pacedUntil > 0 ? b.pacedUntil : undefined)))) ?? meetingseats.holding(b.slot),
  // (never held, so the run keeps its lease: past its job's share of HQ's time, the beat's dear part waits, jobs.ts reined)
  'POST /api/worker/heartbeat': b => !jobs.runsOn(Number(b.job), b.seat) ? 409 : jobs.heartbeat(Number(b.job), {
    util: b.util === undefined ? undefined : util(b.util), probe: b.probe === true, reined: reins.heldFor(Number(b.job)) > 0,
    short: b.short === true, capped: Array.isArray(b.capped) ? b.capped.filter((e: unknown) => typeof e === 'string') : [] }),
  // Whether a job was handed a customer's own details, as its run ends: its memory copy stays with it (worker copyback.ts).
  // And the worker's own text before it goes back to the company (the memory copy, a pull request's body), keys masked.
  'POST /api/worker/customers': b => jobs.jobAgent(Number(b.job)) ? { customers: jobs.holdsCustomerData(Number(b.job)) } : 404,
  'POST /api/worker/redact': b => typeof b.text !== 'string' ? 400 : b.text.length > REDACT_MAX ? 413 : { text: redact(b.text) },
  // solo: the run started no one else who holds its token, so the CEO's notes to the Overseer it held go out (overseer.ts)
  'POST /api/worker/finish': b => {
    if (!jobs.runsOn(Number(b.job), b.seat)) return 409;
    if (b.request && !agentRequest(b.request, jobs.jobAgent(Number(b.job)))) return 400;
    if (b.tooling !== undefined) {
      tooling.keepMetrics(Number(b.job), b.toolingEngine, b.tooling);
    }
    const done = jobs.finish(Number(b.job), b);
    if (done !== 404) overseer.runEnded(Number(b.job), b.solo === true);
    if (done !== 404) feedback.ended(Number(b.job));   // the board's notes it left open go back to routing
    return done;
  },
  // A task's push: the thread's title and tasks for the pull request it opens (threadorder.ts pullOf). Every push opens
  // it; `opens` answers a worker that still asks.
  'POST /api/worker/thread-push': b => (jobs.jobAgent(Number(b.job)) ? { opens: true, pull: threadorder.pullOf(Number(b.job)) } : 404),
  'POST /api/worker/ended': b => Array.isArray(b.ids) && b.ids.length <= 5000 && b.ids.every(Number.isInteger) ? jobs.ended(b.ids) : 400,
  'POST /api/worker/seat': b => seats.reportSeat(b),   // (b's windows)
  // the board's seats and its changes to them (seats.ts): the worker's list at its start, then every few seconds
  'POST /api/worker/seats': b => seats.seedSeats(b.seats),
  'POST /api/worker/seat-list': () => seats.workerSeats(),
  'POST /api/worker/seat-action': b => seats.settleAction(Number(b.id), b.status, b.words),
  'POST /api/worker/seat-key': b => seats.takeKey(String(b.seat ?? '')),
  'POST /api/worker/signin': b => seats.reportSignin(String(b.seat ?? ''), b),
  'GET /api/worker/agent': b => jobs.findAgent(b.id) ?? 404,
  'POST /api/worker/team': b => !b.done && colleague(String(b.id ?? '')) ? 400 : teamEvent({ ...b, department: b.department ?? jobs.findAgent(b.lead ?? '')?.department }),
  'POST /api/worker/secrets': () => testSecrets(),
  // Main merged into a passed pull request that GitHub calls conflicting, by git's own merge (review.ts mergeMain).
  'POST /api/worker/main-merges': () => review.mainMerges(),
  'POST /api/worker/main-merged': b => review.mainMerged(b),
  // Main's line along its first parents whenever it moves: a commit outside HQ's merges gets a check job (carries.ts,
  'POST /api/worker/main-moved': b => carries.mainMoved(b ?? {}),
  // the worker's room and each job's share of it, every minute (room.ts)
  'POST /api/worker/disk': () => jobReserve(),
  'POST /api/worker/room': b => room.reportRoom(b ?? {}),
  // a run the worker blocked for its job's share, and the words its output gets (blocks.ts).
  'POST /api/worker/blocked': b => blocks.blocked(b ?? {}),
  // Retired workers cannot change a saved estimate.
  'POST /api/worker/sizes/claim': () => ({}),
  'POST /api/worker/sizes/answer': () => 410,
  // a live meeting's bubbles, by the same: the next lines to put in bubbles, and the model's answer (meetinggist.ts.)
  'POST /api/worker/gists/claim': () => meetinggist.claim() ?? {},
  'POST /api/worker/gists/answer': b => meetinggist.answer(b ?? {}),
  // the names the board reads, put plainly by the same: the next names due, and the model's answer (plainnames.ts.)
  'POST /api/worker/names/claim': () => plainnames.claim() ?? {},
  'POST /api/worker/names/answer': b => plainnames.answer(b ?? {}),
  // the small model's short calls, by the same: the next to make (the board's handwriting read into type, the book's
  // judge) and the model's answer (smallmodel.ts)
  'POST /api/worker/reads/claim': () => smallmodel.claim() ?? {},
  'POST /api/worker/reads/answer': b => smallmodel.answer(b ?? {}),
  // a push's tests, kept by the code they tested: the claim before they run, and their result (testresults.ts)
  'POST /api/worker/tests/claim': b => testresults.claimTests(b),
  'POST /api/worker/tests/done': b => testresults.doneTests(b),
  'POST /api/worker/tests/comparison': b => testresults.comparisonTicket(b),
};

// Agents (the hq CLI) authenticate with their job's token: the coordinator knows the job and the agent, and a team
// member may speak as itself only if the worker registered it for that job.
// call: an agent on a live call with the board (call.ts's token), with no job: CALL_ROUTES names its tools' routes.
// callout: an agent on a call out to a partner (callouts.ts's token): no route
type Me = { id: number; agent: string; call?: boolean; callId?: number; listed?: number[]; callout?: number };
const str = (v: unknown) => v == null ? undefined : String(v);
// A team member never takes a colleague's name (a sub-agent named after the CEO can't speak as the CEO), nor the board's.
// Alumni stay allowed: a lead brings one back under its own name.
const staff = (id: string) => { const a = jobs.findAgent(id); return !!a && !a.temp; };   // org.yaml, not a team member
const colleague = (id: string) => staff(id) || jobs.boardId(id);
const speaker = (as: unknown, me: Me) => jobs.boardId(me.agent) ? undefined : as == null || as === me.agent ? me.agent
  : me.call ? undefined
  : inTeam(me.id, String(as)) && !colleague(String(as)) ? String(as) : undefined;
// A card that brings a product back (its --back slugs, or the open card's own, for hq rewrite: b.id) recommends nothing
// (cardcheck.js cardProblem)
const bringsBack = (b: any) => Array.isArray(b.back) && b.back.length > 0 || owed.productsOf(Number(b.id) || 0).some(p => p.back);
// The card as the phone shows it: its Share part (text the board forwards, jobs.ts sharePart) is no part of it
const cardIssue = (b: any) => cardProblem(jobs.sharePart(String(b.body ?? '')).body, bringsBack(b));
// A card's --visible-from it can't read (later.ts), as hq ask and hq request say it.
const laterProblem = (b: any) => { const at = later.hiddenUntil(b.visibleFrom); return at.ok ? null : `--visible-from ${at.why}`; };
// A card's before-and-after pictures show from main (/cycles/), so one not there yet would show broken, unless the card
// waits for its work to go live: --when deployed:<job> (a --when it can't read is refused at filing), a call's work, or
// held already, for hq rewrite (b.id)
const unseenProblem = (b: any, me: Me) => {
  const holds = b.id ? later.heldFor(Number(b.id)) : later.holdsFor(me.id, b.when);
  if (typeof holds === 'string' || holds?.length) return null;
  const root = `${REPO_DIR}/products/_cycles/`;
  const unseen = pairsOf(String(b.body ?? '')).pairs.flatMap(p => [p.before, p.after]).filter(p => {
    const file = normalize(root + pictureFile(p));
    return !file.startsWith(root) || !existsSync(file);
  });
  return unseen.length ? `${unseen.length === 1 ? `the picture ${unseen[0]} isn't` : `the pictures ${unseen.join(', ')} aren't`} on main yet, ` +
    "and the desk phone shows a card's pictures from main: commit them in this job and hold the card until it's live " +
    '(hq ask ... --when deployed:<this job>), or file it once they are merged' : null;
};
// hq photos: for the agent who asked, and a job it queued after the card (jobs.ts cardAccess). A customer card's
// photos are a customer's details: they go to whoever reads its text (jobs.ts readsCard: the job working on the card,
// its own agent's or not, and roles.customerData), refused with why for anyone else, and the job that reads them holds
// customer data from then on. (No job waits for a customer card.)
const seePhotos = (id: number, me: Me, read: () => unknown) => {
  const access = jobs.cardAccess(id, me);
  if (access !== true) return refusal(access);
  const r = read();
  if (r !== 404 && jobs.customerCard(id)) jobs.handedCustomerData(me.id);
  return r;
};
// Work goes to an org.yaml agent or an alumnus (a lead brings one back), never to the board.
const assignable = (id: string) => staff(id) || (org().alumni ?? []).some((a: { id: string }) => a.id === id);
// The thread a job queued by an agent serves (hq job --thread; one started for it is the plan's: newthread.ts).
function threadFor(b: any, me: Me): { thread: string } | { from?: number } | Refused {
  const thread = jobThread(b, { agent: me.agent, job: me.id || undefined });
  return 'refusal' in thread ? new Refused(thread.status, thread.refusal) : thread;
}
function jobOrigin(b: any, me: Me) {
  const title = String(b.title ?? '').trim(), brief = me.call ? String(b.prompt ?? '').trim() : b.prompt;
  if (!b.agent || !title) return new Refused(400, 'a job needs an agent and a title');
  // Someone org.yaml on main doesn't have yet: work for a colleague being hired waits for the hiring (hiring.ts)
  const hire = !assignable(String(b.agent));
  const notHired = hire && hiring.refusal(String(b.agent), Number(b.after) || undefined, me);
  if (notHired) return new Refused(403, notHired);
  const refused = me.call && callRefusal(title, brief);
  if (refused) return refused;
  let from: { call: number; item: number; words?: string; due?: number } | undefined;
  const own = me.call ? undefined : ledger.carried(me.id);
  if ((own?.status === 'dropped' || own?.status === 'replaced') && !(b.item != null && ledger.followsUp(me.id)))
    return new Refused(409, `this job's item #${own.id} (call #${own.call}) was ${own.status}: ${own.why}. If the board changed it, the call's follow-up hands out the new item`);
  const failedJobId = b.lands == null ? undefined : Number(b.lands);
  const landingSource = failedJobId === undefined ? undefined
    : !Number.isSafeInteger(failedJobId) ? '--lands names a job by its number'
    : b.item != null ? '--lands carries the failed job\'s item, so it takes no --item'
    : takeover.landing(failedJobId, String(b.agent), me.agent);
  if (typeof landingSource === 'string') return new Refused(409, landingSource);
  if (b.item != null) {
    const h = ledger.handOut(Number(b.item), c => me.call ? c === me.callId : ledger.mine(me.id, c) || keepsAsks(me, c));
    if (typeof h === 'string') return new Refused(409, h);
    from = h;
  } else if (own && !landingSource) from = { call: own.call, item: own.id, words: ledger.goalLine(own) };
  const landingItem = landingSource ? ledger.carried(failedJobId!) : undefined;
  // An own brief takes the place of the failed job's, which carried its goal
  const landingGoal = brief && landingItem ? ledger.goalLine(landingItem) : '';
  const landingBrief = `${landingSource?.branch ? `\n\nThis job takes over the saved work of #${failedJobId}: \`git fetch origin refs/outgoing/${landingSource.branch}\`.` : ''}${landingGoal ? `\n\n${landingGoal}` : ''}`;
  const ownBrief = brief || landingSource?.prompt;
  // hq job --after request:<id>: it waits for the card's answer (jobs.ts addCardWait)
  const card = b.afterRequest == null ? undefined : Number(b.afterRequest);
  const cardRefused = card !== undefined && (Number.isSafeInteger(card) ? jobs.whyNotAgentCard(card, me.agent) : 'cards are named by their numbers');
  if (cardRefused) return new Refused(409, cardRefused);
  // hq job --when: it starts once those events have happened (wakes.ts)
  const when = wakes.readWhen(b.when);
  if (typeof when === 'string') return new Refused(400, when);
  return { title, brief: ownBrief, hire, from, failedJobId, landingSource, landingBrief, card, when };
}

function jobPlacement(b: any, me: Me, origin: Exclude<ReturnType<typeof jobOrigin>, Refused>) {
  const { failedJobId, from, landingSource } = origin;
  // Its task's code: the word its queuer names (hq job --code) with its project's prefix, checked before a thread is
  // started for it too. A fix or a landing is a step of its task and carries that task's (jobcodes.ts).
  const step = failedJobId !== undefined || b.findings != null;
  const early = b.newThread != null && !step ? jobcodes.claim(b.code, { project: String(b.newThread.project ?? '') }) : undefined;
  if (early && 'refused' in early) return new Refused(409, early.refused);
  const threadSource = failedJobId !== undefined && b.thread == null && b.newThread == null ? { ...me, id: failedJobId } : me;
  const thread = threadFor(b, threadSource);
  if (thread instanceof Refused) return thread;
  // Its item's time, given on its call (by whoever was on the call), is the window of the job's thread: one named or
  // started, else the one it inherits (createJob's from). So is --by's (askwindow.ts). Work in no open thread has
  // nowhere to take it, so it's refused before anything is queued.
  const by = askwindow.readBy(b.by);
  if (by && by !== 'none' && 'refused' in by) return new Refused(400, by.refused);
  const itemDue = b.item != null ? from?.due : undefined;
  if (itemDue !== undefined && by !== undefined) return new Refused(409, `item #${b.item} has its time from the call: the job takes no --by`);
  const window = itemDue !== undefined ? { deadline: itemDue, aim: itemDue } : by === 'none' ? undefined : by;
  const target = 'thread' in thread ? thread.thread : thread.from ? jobs.threadOf(thread.from) : null;
  // A running job adds no task to a thread that isn't its agent's to draw, nor waits across threads (threadorder.ts).
  const outOfOrder = me.call ? undefined : threadorder.jobRefusal(me.agent, target, Number(b.after) || undefined);
  if (outOfOrder) return new Refused(409, outOfOrder);
  const timed = window === undefined ? undefined : target === null ? projects.untimedRefusal() : windows.threadOf({ thread: target });
  if (typeof timed === 'string')
    return new Refused(409, target === null ? timed : `${timed}. Retry with --deliverable <project>/<slug> (hq deliverable list)`);
  // One handed out for an item carries the words on the call (ledger.handOut); one its job queues, the item's goal.
  // The answer says which threads it moves (moves.ts)
  const fix = reviewinbox.fixFor(target, b.findings, me.agent);
  if (typeof fix === 'string') return new Refused(400, fix);
  // One thread, one pull request: work waiting for its thread's own work deployed can't be in it, so it gets a thread
  // of its own in that project, after the release (threadrelease.ts): a fresh one, which nothing timed waits on.
  const release = !!target && !fix && !landingSource && threadrelease.waitsForRelease(target, origin.when);
  // The board's ask with no time, on the thread it ends up on, which nothing timed waits on: the CEO is asked for its
  // time (askwindow.ts). A task of the board's notes (--notes) is its ask too.
  const source = askwindow.sourceOf(me, b.item != null) ?? (b.notes != null ? 'notes' : null);
  const untimed = source && !window && by !== 'none' && (release || !askwindow.servedWindow(target)) ? source : null;
  if (untimed && me.agent === ceo() && !me.call) return new Refused(409, askwindow.untimedRefusal(untimed));
  const named = fix || landingSource ? undefined : jobcodes.claim(b.code, target);
  if (named && 'refused' in named) return new Refused(409, named.refused);
  // hq job --only: work only one engine does, by its rule's id (engineonly.ts).
  if (b.only != null && !engineOnly.byId(b.only))
    return new Refused(400, `--only names a rule of company/org.yaml engineOnly: ${engineOnly.rules().map(rule => rule.id).join(', ') || 'it has none'}`);
  return { thread, window, byCall: itemDue !== undefined, target, timed, untimed, source, fix, named, release };
}

// A plan change (redraws.ts writePlan) that a Refused thrown in it rolls back whole, answered with that refusal.
function refusable(change: () => unknown) {
  try {
    return writePlan(change);
  } catch (err) {
    if (err instanceof Refused) return err;
    throw err;
  }
}
// hq job --notes: the CEO's routing makes the board's notes a task, they and how the product comes back at the end of
// its brief (routing.ts forTask).
function jobNotes(b: any, me: Me) {
  if (b.notes == null) return undefined;
  if (!Array.isArray(b.notes) || !b.notes.every(Number.isSafeInteger))
    return new Refused(400, '--notes names the notes by their numbers (hq route lists them)');
  const taken = routing.forTask(me, String(b.agent), [...new Set<number>(b.notes)]);
  return typeof taken === 'string' ? new Refused(409, taken) : taken;
}
const shownThread = (job: number) => { const thread = jobs.threadOf(job); return thread ? { thread } : {}; };
// The board's ask queued with no window (askwindow.ts): on a live call its agent judges the time itself or leaves it
// untimed, never asking the board; a run's (a follow-up of another agent's call handing out its item) asks the CEO,
// unless the call is a customer's, whose details stay with its agent. (The CEO's own run was refused: jobPlacement.)
function askedForTime(me: Me, job: { id: number; agent: string; title: string }, source: askwindow.AskSource, from?: { call: number }) {
  const inThread = !!jobs.threadOf(job.id), told = { untimed: askwindow.untimedLine(job.id, !!me.call, inThread) };
  if (me.call || me.agent === ceo() || (from && memory.customerCall(from.call))) return told;
  const sent = askwindow.askCeo({ agent: me.agent, job: me.id }, job, source, inThread);
  return typeof sent === 'object' ? { askedCeo: ceo() } : told;
}
// The work a live call's promise names (hq item add --job), checked before anything is recorded: its owner's (a misheard
// number names someone else's: call.ts reach), under way, and in an open thread, or put on the one the promise names
// (--thread) if the call queued it in none (askwindow.ts untimedLine).
function promisedWork(b: any, due: number | undefined, me: Me) {
  const id = Number(b.job), onto = str(b.thread);
  if (!me.call) return new Refused(400, '--job is for a live call: its follow-up links the item to the work (hq item link)');
  if (due === undefined) return new Refused(400, '--job goes with --deadline: the time the work\'s deliverable takes');
  const whose = Number.isSafeInteger(id) && id > 0 ? call.notTheirs(String(b.owner), id) : [404, `there's no job #${b.job}`] as const;
  if (whose) return new Refused(whose[0], whose[1]);
  if (windows.finished(id) || windows.dropped(id))
    return new Refused(409, `job #${id} isn't work under way: note the promise without it, and the follow-up links it`);
  const queuedHere = call.queuedHere(me.callId, id);
  if (onto === undefined) {
    const thread = windows.threadOf({ job: id });
    if (typeof thread !== 'string') return { job: id };
    return new Refused(409, queuedHere ? `${thread}: note the promise with the open deliverable it serves too (thread)`
      : `${thread}: note the promise without it, and the follow-up puts the work on a deliverable`);
  }
  const had = jobs.threadOf(id);
  if (had && projects.isOpen(had)) return new Refused(409, `job #${id} is on ${had} already: note the promise without the deliverable`);
  if (!queuedHere) return new Refused(409, `job #${id} wasn't queued on this call: only one you queued goes on a deliverable now`);
  if (!projects.isOpen(onto)) return new Refused(409, `${onto} isn't an open deliverable (eta lists them)`);
  return { job: id, thread: onto };
}
// The window of the deliverable an ask's thread serves, when it's another thread's (the job's own shows as its thread's).
function servesOther(job: number) {
  const own = jobs.threadOf(job), served = askwindow.servedWindow(own);
  return served && served.thread !== own ? { serves: { thread: served.thread, deadline: new Date(served.deadline).toISOString() } } : {};
}
// The thread hq window names (by id, job or PR: windows.ts), with who names it.
function namedThread(b: any, me: Me) {
  const agent = speaker(b.as, me);
  if (!agent) return new Refused(403, 'only an agent sets a deliverable\'s window');
  const [job, pr] = [b.job, b.pr].map(v => v == null ? undefined : Number(v));
  const named = [b.thread, job, pr].filter(v => v !== undefined && v !== null);
  if (named.length !== 1 || [job, pr].some(v => v !== undefined && (!Number.isSafeInteger(v) || v <= 0)))
    return new Refused(400, 'name one deliverable (<project>/<slug>), or one job or pull request (pr:<n>) on it');
  const thread = windows.threadOf({ thread: str(b.thread), job, pr });
  return typeof thread === 'string' ? new Refused(409, thread) : { ...thread, agent };
}
// A call's job carries its whole brief as its prompt, in the JSON body: hq_tools.py hands it to hq on stdin, never as a
// file (hq reads files as the voice line's uid, which can open the seat's token: guard.py). A short title (what HQ
// shows) and a brief that fits: longer is refused with the reason, never cut, whatever the client did (hq_tools.py
// checks the same). Counted in characters, as Python counts them.
const CALL_TITLE = 140, CALL_BRIEF = 8000;
const chars = (s: string) => [...s].length, n = (x: number) => x.toLocaleString('en-US');
function callRefusal(title: string, brief: string) {
  if (!brief) return new Refused(400, "a job from a call needs a brief: the whole hand-off, in the colleague's terms");
  if (chars(title) > CALL_TITLE) return new Refused(400, `title too long (${n(chars(title))} > ${n(CALL_TITLE)}): keep it to one short line and put the rest in the brief`);
  if (chars(brief) > CALL_BRIEF) return new Refused(400, `brief too long (${n(chars(brief))} > ${n(CALL_BRIEF)}): split it into two jobs`);
}
// What of the inbox a job's agent reads by its work (org.yaml's roles): no job is handed a mail itself, so a role is the
// only way (a customer's case comes with hq care). A customer's mail: roles.customerData, or roles.customerMail for the
// mail alone.
const mayReadMail = (me: Me): MailAccess => ({ business: reads(me.agent, 'businessMail'), customer: reads(me.agent, 'customerData') || reads(me.agent, 'customerMail') });
const MAIL_REFUSED: Record<MailKind, string> = {
  customer: "a customer's mail goes only to the agents whose work needs them (org.yaml's roles.customerData, or roles.customerMail for their mail alone); a customer's case comes to the job HQ hands it (hq care)",
  business: "mail to the business addresses goes only to the agents whose work needs it (org.yaml's roles.businessMail): ask one of them, or the agent in org.yaml's roles.process to add you",
};
const NO_RAW_MAIL = new Refused(410, 'HQ has no raw copy of that mail: none was stored, or retention cleared it. hq mail <id> shows what HQ kept');
// A job's read of mail of that kind: refused, or read, and the job holds customer data from then on unless every mail it
// read is a partner's business mail (outbox.ts fromPartner: an answer to an email the board sent, from where it went, or
// mail from a partner brand.yaml names).
// Other business mail can hold a customer's details too (a customer can write to invoices@). null: no such mail, so
// nothing to refuse or mark. An answer to an email the job's agent drafted (outbox.ts answerFor) it reads without the role.
// A mail of the board's own it handed to this job (mail.ts forward) it reads whatever its roles, and only it.
function readMailAs(me: Me, access: MailAccess, kind: MailKind | null, read: () => unknown, id?: number) {
  if (kind && !mayRead(me, access, kind, id)) return new Refused(403, MAIL_REFUSED[kind]);
  const r = read(), mails = id ? [id] : Array.isArray(r) ? r.map(m => Number(m.id)) : [];
  if (kind && !mails.every(outbox.fromPartner)) jobs.handedCustomerData(me.id);
  return r;
}
// What a job's agent may read: mail of a kind its roles allow, or an answer to an email it drafted (outbox.ts answerFor)
// (or the board's own mail it handed this job, or an account's notice it was handed: notices.ts)
const mayRead = (me: Me, access: MailAccess, kind: MailKind, id?: number) => access[kind]
  || (!!id && (outbox.answerFor(id, me.agent) !== null || mail.forwardedTo(id) === me.id || notices.jobOf(id) === me.id));
// One mail a job's agent may read (readMailAs's rule), for hq mail draft --answers (a board's mail handed to the job too:
const mayReadOne = (me: Me) => (id: number) => {
  const kind = mail.mailKind(id, me.id);
  return !!kind && mayRead(me, mayReadMail(me), kind, id);
};
// A line of the job's own log or feed as it's kept: one the worker didn't guard (guarded: shown as a job holding a
// customer's details shows it, steps.ts) from a job that holds them now (handed them mid-run, the line on its way or
// sent before the worker heard) goes to the board's own HQ session alone, with nothing for agents to read. The answer
// carries the job's mark, which the worker's guard follows from then on.
function kept(me: Me, b: any, text: string | undefined, board: string | undefined) {
  const customers = jobs.holdsCustomerData(me.id);
  return customers && b.guarded !== true ? { text: '', board: board ?? text, customers } : { text, board, customers };
}
const RENDER_SEND_MAX = 200 * 1024 * 1024;   // (GET /api/agent/render: a film is tens of MB)
const agentApi: Record<string, (b: any, me: Me) => unknown> = {
  'POST /api/agent/review-output': (b, me) => ({ error: review.outputProblem(me.id, b.output) ?? null }),
  // A worker-issued ticket restricts comparisons to a claimed push and its pinned base.
  'POST /api/agent/tests/base/claim': (b, me) => testresults.claimBaseTests(b, me.id),
  'POST /api/agent/tests/base/done': (b, me) => testresults.doneBaseTests(b, me.id),
  'GET /api/agent/tooling': (b, me) => {
    if (!jobs.inProcess(me.agent) || me.call) return new Refused(403, 'Run hq tooling from a Process job. Only aggregate counts are available.');
    const interval = tooling.getInterval(b.since, b.until);
    return interval ? tooling.listMetrics(interval.since, interval.until) : new Refused(400, 'Use --since and --until with ISO times, since before until.');
  },
  // a render the server put back in its checkout (infra/renders.py), for a job's clone, which has only its .render.json
  // (shared/demo/renders.mjs fetch): only a file with one beside it, as base64 like a photo
  'GET /api/agent/render': b => {
    const path = String(b.path ?? ''), found = inside(REPO_DIR, path), side = inside(REPO_DIR, `${path}.render.json`);
    if (!found || !side) return 404;
    return found.size > RENDER_SEND_MAX ? new Refused(413, 'too big to send: render it again') : { data: readFileSync(found.real).toString('base64') };
  },
  // a line of the job's own log (log.ts), by its lead or a team member
  'POST /api/agent/step': (b, me) => {
    const agent = speaker(b.as, me);
    if (!agent) return 403;
    if (typeof b.text !== 'string') return 400;
    const line = kept(me, b, b.text, str(b.board));
    logStep(me.id, agent, line.text ?? '', line.board);
    return { ok: true, customers: line.customers };
  },
  // hq preview: a view-only pass to a product's preview for this run, or its test player's (preview.ts createPass).
  // (player)
  'POST /api/agent/preview-passes': (b, me) => {
    const agent = speaker(b.as, me);
    return agent ? refusal(preview.createPass(me.id, agent, b.slug, b.player)) : 403;
  },
  'POST /api/agent/event': (b, me) => {
    const agent = speaker(b.as, me);
    if (!agent) return 403;
    if (!['status', 'chat', 'log', 'lines', 'tokens'].includes(b.type)) return 400;
    // whole numbers: the lines a job changes so far (the worker's countLines; a day's come from main's history:
    // commitlines.ts); the tokens it has written so far, and what they grew by
    // since its last reading (tellTokens)
    const n = (v: unknown, type: string) => b.type === type && Number.isInteger(v) && (v as number) >= 0 && (v as number) < 10_000_000 ? v as number : undefined;
    if (b.type === 'lines') {
      publish({ type: 'lines', agent, job: me.id, add: n(b.add, 'lines') ?? 0, del: n(b.del, 'lines') ?? 0 }); // (job)
      return { ok: true };
    }
    if (b.type === 'tokens') {
      // (what the job wrote since its last reading counts toward the day's, as the worker says: the status here forgets
      // its readings on a restart, and a job's whole total would count again)
      publish({ type: 'tokens', agent, total: n(b.total, 'tokens') ?? 0 });
      work.count({ tokens: n(b.grew, 'tokens') });
      return { ok: true };
    }
    // board: a job holding a customer's details, the step itself, for the board's own HQ session alone (events.ts)
    const line = b.type === 'log' ? kept(me, b, str(b.text), str(b.board)) : { text: str(b.text), board: undefined, customers: jobs.holdsCustomerData(me.id) };
    // (since: the agent's own status counts from its job's start, a team member's from its words.)
    const since = b.type === 'status' && agent === me.agent && !me.call ? jobs.startedOf(me.id) : undefined;
    publish({ type: b.type, agent, job: me.id, to: str(b.to), text: line.text, state: str(b.state), since, board: line.board }, 'agent'); // (job)
    return { ok: true, customers: line.customers };
  },
  // An agent's job is plain work (reviews and merges are the coordinator's own); the answer is its id, which anyone can check.
  // With an item (hq job --item), the job carries it, its call and the words on the call (ledger.ts). Without one, a job
  // queued by a job that carries an item carries it too, so a correction reaches it. With --lands, the job instead
  // replaces a failed job and carries its call and item (takeover.ts landing). A job whose item was dropped or
  // replaced queues nothing more, not even another item on its call (unless it's a call's follow-up: that one's its work).
  // --expedite: the CEO's structural HQ fix, first in line and merged on its checks (review.ts mergeExpedited).
  'POST /api/agent/job': (b, me) => refusable(() => {
    if (b.expedite === true && me.agent !== ceo()) return new Refused(403, `only the CEO expedites a job: ask ${ceo()}`);
    const size = sizes.readQueuedSize(b);
    if (typeof size === 'string') return new Refused(400, size);
    const origin = jobOrigin(b, me);
    if (origin instanceof Refused) return origin;
    const notes = jobNotes(b, me);
    if (notes instanceof Refused) return notes;
    const placement = jobPlacement(b, me, origin);
    if (placement instanceof Refused) return placement;
    // (a task of notes held where it's placed: refused, the thread drawn for it too.)
    const held = notes && holds.placeRefusal({ thread: placement.target, after: Number(b.after) || null, card: origin.card ?? null });
    if (held) throw new Refused(409, held);
    const { title, brief, hire, from, failedJobId, landingSource, landingBrief, card, when } = origin;
    const { thread, window, byCall, target, timed, untimed, source, fix, named, release } = placement;
    const earlier = moves.before();
    const job = jobs.createJob({ agent: String(b.agent), title, ...thread, check: b.check === true, only: b.only ?? undefined,
      prompt: `${brief || title}${notes ? `\n\n${notes.text}` : ''}${fix ? `\n\n${reviewinbox.instructions(fix)}` : ''}${from?.words ? `\n\n${from.words}` : ''}${landingBrief}\n\n(Assigned by ${me.agent}${me.call ? ', on a call with the board' : ''}.)`,  // (notes)
      after: Number(b.after) || undefined, queuedBy: me.agent, size, engine: hire ? hiring.HIRING : undefined,
      downtime: b.downtime === true, call: from?.call, item: from?.item, insteadOf: failedJobId, code: named?.code, expedite: b.expedite === true,
      ...(fix && { branch: fix.branch, round: fix.round, stage: fix.stage, insteadOf: fix.replaces }) });
    if (fix) reviewinbox.recordTask(job.id, fix);
    notes?.take(job.id);
    // (a thread of its own after the release: jobPlacement)
    const ownThread = release && b.expedite !== true ? oneTaskThread(projects.findThread(target!)!.project, { id: job.id, title }) : null;
    const followOn = ownThread ? { followOn: target } : {};
    if (card !== undefined) jobs.holdForCard(job.id, card);
    // Work queued on a call waits for the call's end, so what the board adds on it (add) goes into its brief and it
    // starts whole. It starts at once only when the call's agent says so (now), its judgment or the board's word each
    // time.
    const untilEnd = me.callId && b.now !== true ? [{ kind: 'ended' as const, arg: String(me.callId) }] : [];
    wakes.hold(job.id, [...when, ...untilEnd]);
    if (me.callId) call.queuedOn(me.callId, job.id);   // (its agent may add to it while the call goes on: call.ts addToJob)
    if (from && memory.customerCall(from.call)) jobs.handedCustomerData(job.id);   // a customer call's item: its job holds their details
    if (landingSource?.customers) jobs.handedCustomerData(job.id);
    // (a correction handed out: the replaced item's running jobs hear it now, and the answer says which weren't told)
    // (a job on a paused thread is queued, and told it's held: pauses.ts)
    // (--by never loosens the window its thread has: askwindow.ts narrowed)
    const windowOn = timed && (ownThread ? projects.findThread(ownThread)! : timed);
    const given = windowOn && (byCall ? window : askwindow.narrowed(windowOn.id, window!));
    const promised = given && windows.set(windowOn, given, byCall ? ledger.callAgent(from!.call) : me.agent);
    const kept = windowOn && !promised ? { deadline: new Date(windowOn.deadline!).toISOString() } : {};
    const ask = untimed ? askedForTime(me, { id: job.id, agent: String(b.agent), title }, untimed, from) : source ? servesOther(job.id) : {};
    const due = { ...promised && { deadline: promised.deadline }, ...kept, ...ask, ...untilEnd.length && { untilCall: me.callId }, ...shownThread(job.id), ...followOn, ...pauses.heldBy(job.id), ...moves.since(earlier) };
    return b.item != null ? { ...job, ...due, ...ledger.handedOut(from!.item, job.id, me.call ? null : me.id) } : { ...job, ...due };
  }),
  // hq thread list, and hq project say: a project's threads and its owner's sentence (projects.ts), as the speaker (a
  // team member under its own name, never with its lead's rights).
  'GET /api/agent/threads': b => projects.listThreads({ project: str(b.project), all: b.all === '1' }),
  // hq plan: a project's plan, and its owner's or the CEO's changes to it; hq project new | owner: the CEO's (plan.ts).
  'GET /api/agent/plan': b => plan.planOf(String(b.project ?? ''), forecast.current()) ?? 404,
  'POST /api/agent/plan/thread': (b, me) => {
    const agent = speaker(b.as, me);
    if (!agent) return 403;
    if (b.needs !== undefined && (!Array.isArray(b.needs) || b.needs.some((n: unknown) => typeof n !== 'string' || !n.trim())))
      return new Refused(400, 'needs must be a list of deliverable identifiers');
    return refusal(plan.newThread({ project: String(b.project ?? ''), name: b.name, goal: b.goal,
      needs: b.needs, slug: str(b.slug) }, { agent, job: me.id || undefined }));
  },
  'POST /api/agent/plan/need': (b, me) => {
    const agent = speaker(b.as, me);
    if (!agent) return 403;
    const [thread, needs] = [b.thread, b.needs].map(v => String(v ?? ''));
    return refusal(b.drop === true ? plan.unneed(thread, needs, agent) : plan.need(thread, needs, agent));
  },
  'POST /api/agent/plan/move': (b, me) => { const agent = speaker(b.as, me); return agent ? refusal(plan.move(Number(b.id), Number(b.place), agent)) : 403; },
  'POST /api/agent/plan/drop': (b, me) => { const agent = speaker(b.as, me); return agent ? refusal(plan.drop(Number(b.id), b.why, agent)) : 403; },
  'POST /api/agent/plan/done': (b, me) => { const agent = speaker(b.as, me); return agent ? refusal(plan.done(String(b.thread ?? ''), agent)) : 403; },
  // hq plan rename | title, hq project rename | done: names that show the level.
  'POST /api/agent/plan/rename': (b, me) => {
    const agent = speaker(b.as, me);
    return agent ? refusal(plan.rename(String(b.thread ?? ''), { name: b.name, goal: b.goal, slug: b.slug }, agent)) : 403;
  },
  'POST /api/agent/plan/title': (b, me) => { const agent = speaker(b.as, me); return agent ? refusal(plan.title(Number(b.id), b.title, agent)) : 403; },
  'POST /api/agent/projects/rename': (b, me) => { const agent = speaker(b.as, me); return agent ? refusal(plan.renameProject(String(b.id ?? ''), b.name, agent)) : 403; },
  'POST /api/agent/projects/done': (b, me) => { const agent = speaker(b.as, me); return agent ? refusal(plan.projectDone(String(b.id ?? ''), agent)) : 403; },
  'POST /api/agent/projects/new': (b, me) => {
    const agent = speaker(b.as, me);
    return agent ? refusal(plan.newProject({ id: b.id, name: b.name, owner: b.owner, business: b.business, code: b.code }, agent, staff)) : 403;
  },
  // hq project code: the CEO gives a project made before prefixes its tasks' prefix (plan.ts setCode).
  'POST /api/agent/code': (b, me) => refusal(jobcodes.name(me.id, b.code)), // (hq code.)
  'POST /api/agent/projects/code': (b, me) => { const agent = speaker(b.as, me); return agent ? refusal(plan.setCode(String(b.id ?? ''), b.code, agent)) : 403; },
  'POST /api/agent/projects/owner': (b, me) => {
    const agent = speaker(b.as, me);
    return agent ? refusal(plan.setOwner(String(b.id ?? ''), String(b.owner ?? ''), { agent, job: me.id }, staff)) : 403;
  },
  // hq project business: the CEO moves a project into a business, or out of any (plan.ts setBusiness).
  'POST /api/agent/projects/business': (b, me) => { const agent = speaker(b.as, me); return agent ? refusal(plan.setBusiness(String(b.id ?? ''), b.business, agent)) : 403; },
  // hq projects and hq thread <id>: every open thread's outlook, or one's with its jobs (outlooks.ts).
  'GET /api/agent/projects': () => outlooks.lines(forecast.current()),
  // (with the pause holding it and what lifts it: pauses.ts)
  'GET /api/agent/thread': b => {
    const detail = outlooks.detail(String(b.id ?? ''), forecast.current());
    return detail ? { ...detail, pause: pauses.pauseOf(detail.id) } : 404;
  },
  // the call's eta tool and hq projects <words>: threads found by name or words, waits by name.
  'GET /api/agent/outlooks': b => refusal(outlooks.findOutlooks(String(b.q ?? ''), forecast.current())),
  // hq now, the call's eta tool with no query: who's at work and what each open card holds up (goingon.ts).
  'GET /api/agent/now': () => ({ text: goingon.words(forecast.current()) }),
  // hq thread move and hq job move: work regrouped by the CEO, the process team or its owner (regroup.ts).
  'POST /api/agent/threads/move': (b, me) => {
    const agent = speaker(b.as, me);
    return agent ? refusal(regroup.moveThread(String(b.id ?? ''), String(b.project ?? ''), agent, String(b.why ?? ''))) : 403;
  },
  'POST /api/agent/jobs/move': (b, me) => {
    const agent = speaker(b.as, me);
    return agent ? refusal(regroup.moveJob(Number(b.id), String(b.thread ?? ''), agent, me.id, String(b.why ?? ''))) : 403;
  },
  // hq thread pause | resume and hq project pause | resume: the CEO or the project's owner holds its queued work, or lets
  // it go again (pauses.ts).
  'POST /api/agent/pauses': (b, me) => {
    const agent = speaker(b.as, me);
    const until = Array.isArray(b.until) ? b.until : [];
    // (what wakes its owner, or by hand)
    const ask = { thread: str(b.thread), project: str(b.project), why: b.why, until, untilTime: str(b.untilTime), byHand: b.byHand === true };
    return agent ? refusal(pauses.pause(ask, agent)) : 403;
  },
  'POST /api/agent/pauses/resume': (b, me) => {
    const agent = speaker(b.as, me);
    return agent ? refusal(pauses.resume({ thread: str(b.thread), project: str(b.project) }, agent)) : 403;
  },
  'POST /api/agent/project-notes': (b, me) => {
    const agent = speaker(b.as, me);
    return agent ? refusal(projects.say(String(b.project ?? ''), b.text, agent)) : 403;
  },
  // hq project goal: the CEO marks a project a goal, or no longer (goals.ts).
  'POST /api/agent/projects/goal': (b, me) => {
    const agent = speaker(b.as, me);
    return agent ? refusal(goals.markGoal(String(b.id ?? ''), b.goal === true, agent)) : 403;
  },
  // hq pad: the CEO's page, its versions, and the CEO's jobs' rewrite of it (pad.ts).
  'GET /api/agent/pad': b => (b.history === '1' ? { versions: pad.padHistory() } : { page: pad.pad() }),
  'POST /api/agent/pad': (b, me) => refusal(pad.writePad(b.text, { agent: me.agent, job: me.id })),
  'GET /api/agent/seat-warnings': () => ({ warning: seatwarning.getSeatWarning() }),
  'POST /api/agent/seat-warnings': (b, me) => {
    const agent = speaker(b.as, me);
    if (!agent || (agent !== ceo() && !jobs.inProcess(agent))) return 403;
    return refusal(seatwarning.setSeatWarning(b.warning));
  },
  // hq decision "name" --blocks ...: a decision of the board's that what depends on it waits for; hq decision link: the
  // card that asks it (decisions.ts)
  'POST /api/agent/decisions': (b, me) => refusal(decisions.create(b.name, Array.isArray(b.blocks) ? b.blocks : [], me.agent)),
  // hq decision show <id>: the waiting visual changes, for their card author (decisions.ts).
  'GET /api/agent/decisions/show': (b, me) => refusal(decisions.show(Number(b.id), me.agent)),
  'POST /api/agent/decisions/link': (b, me) => refusal(decisions.link(Number(b.id), Number(b.card), me.agent)),
  // hq decision settle <id> item:<n> | card:<n>: the CEO settles a visual decision, citing the board's word given
  // elsewhere (visualapproval.ts)
  'POST /api/agent/decisions/settle': async (b, me) =>
    refusal(await visualapproval.settle(Number(b.id), String(b.word ?? ''), me.agent)),
  // hq propose: new work proposed to a project's owner, out of the queue; hq inbox: the open proposals waiting for the
  // agent (all of them for the CEO with --all) and its own, and the owner's or the CEO's accept or drop (proposals.ts).
  'POST /api/agent/proposals': (b, me) => {
    const agent = speaker(b.as, me);
    return agent ? refusal(proposals.propose({ agent, job: me.id }, b, assignable)) : 403;
  },
  'GET /api/agent/proposals': (b, me) => { const agent = speaker(b.as, me); return agent ? proposals.list(agent, b.all === '1', me.id) : 403; },
  'POST /api/agent/proposals/accept': (b, me) => { const agent = speaker(b.as, me); return agent
    ? refusal(proposals.accept(reviewinbox.inboxId(b.id), agent, { thread: b.thread, newThread: b.newThread, for: b.for, findings: b.findings, code: b.code, title: b.title, size: b.size, refs: b.refs, why: b.why })) : 403; },  // (title)
  'POST /api/agent/proposals/drop': (b, me) => { const agent = speaker(b.as, me); return agent
    ? refusal(proposals.drop(reviewinbox.inboxId(b.id), { agent, job: me.id }, b.why)) : 403; },
  // hq meeting: an ask to the CEO, the CEO's open asks and the meetings set from them, and a seat's lines (meetings.ts).
  'POST /api/agent/meetings/ask': (b, me) => {
    const agent = speaker(b.as, me);
    return agent ? refusal(meetings.ask({ agent, job: me.id }, b, assignable)) : 403;
  },
  'GET /api/agent/meetings/asks': () => meetings.openAsks(),
  'POST /api/agent/meetings/set': (b, me) => refusal(meetings.set(b.asks, b.topic, b.at, { agent: me.agent, job: me.id, code: b.code })), // (code)
  'POST /api/agent/meetings/join': (b, me) => refusal(meetings.join(Number(b.meeting), Number(b.ask), me.agent)),
  'POST /api/agent/meetings/drop': (b, me) => refusal(meetings.drop(Number(b.ask), b.why, { agent: me.agent, job: me.id })),
  'POST /api/agent/meetings/say': (b, me) => refusal(meetingseats.say(me.id, b.text, b.to)),
  'POST /api/agent/meetings/listen': (b, me) => refusal(meetingseats.listen(me.id)),
  // (a seat hands in and stays; the chair sends changes back and closes the meeting with its post in parts.)
  'POST /api/agent/meetings/hand-in': (b, me) => refusal(meetingseats.handIn(me.id, b.changed)),
  'POST /api/agent/meetings/withdraw': (b, me) => refusal(meetingseats.withdraw(me.id)),
  'POST /api/agent/meetings/reopen': (b, me) => refusal(meetingseats.reopen(me.id, b.agents, b.text)),
  'POST /api/agent/meetings/close': (b, me) => refusal(meetingseats.close(me.id, b, b.stalled)),
  'POST /api/agent/meetings/read': (b, me) => meetingseats.read(me.id, b.lines),
  'GET /api/agent/meetings': () => meetings.list(),
  'GET /api/agent/meetings/one': b => meetings.one(Number(b.id)),
  // hq window: a thread's, named by its id or by a job or pull request on it, set or only tried (nothing kept), with every
  // thread whose planned finish it moves and every window the plan misses after it (windows.ts, moves.ts change).
  'POST /api/agent/window': (b, me) => {
    const now = Date.now();
    const at = b.deadline === 'none' ? null : windows.parse(String(b.deadline ?? ''), now);
    if (typeof at === 'string') return new Refused(400, at);
    const aim = b.aim == null ? undefined : windows.parse(String(b.aim), now, true);
    if (typeof aim === 'string') return new Refused(400, `--aim: ${aim}`);
    if (at === null && aim !== undefined) return new Refused(400, 'none takes the window off, with its aim: give no --aim');
    const thread = namedThread(b, me);
    if (thread instanceof Refused) return thread;
    const window = at === null ? null : windows.windowOf(thread, at, aim);
    if (typeof window === 'string') return new Refused(400, window);
    const tried = b.try === true;
    const { made, ...said } = moves.change(() => windows.set(thread, window, thread.agent),
      queue => windows.withWindow(queue, thread.id, window), later => ({ misses: windows.misses(later) }), tried);
    return { ...made, tried, ...said };
  },
  // hq stop <job> "why": a running job of the caller's own, or any as the CEO, ends now (jobs.ts stopJob).
  // hq expedite <job>: the CEO's, from a job or a call. A queued or running job starts first and merges on its checks;
  // one that has pushed, its pull request still in review, merges now if its last push passed them, and is reviewed
  // after. A thread's task that never started leaves its thread for it (review.ts expedite).
  'POST /api/agent/expedite': async (b, me) => {
    if (me.agent !== ceo()) return new Refused(403, `only the CEO expedites a job: ask ${ceo()}`);
    const done = await review.expedite(Number(b.id), me.agent);
    return typeof done === 'string' ? new Refused(409, done) : { ok: true, ...done };
  },
  'POST /api/agent/stop': (b, me) => {
    const why = String(b.why ?? '').trim();
    if (!why) return new Refused(400, 'say why: hq stop <job> "why"');
    return refusal(jobs.stopJob(Number(b.id), me.agent, why));
  },
  // hq cancel <job>: a queued job that never ran, the caller's own or one it queued, and for the CEO and Process any an
  // agent queued (not one the coordinator made: ledger.ts cancelJob).
  'POST /api/agent/cancel': (b, me) => {
    const refused = ledger.cancelRefusal(Number(b.id), me.agent);
    if (refused) return new Refused(409, refused);
    const earlier = moves.before();   // (the threads it moves: moves.ts)
    return ledger.cancelJob(Number(b.id), `by ${me.agent}${b.why ? `: ${String(b.why).slice(0, 200)}` : ''}`, me.agent)
      ? { ok: true, ...moves.since(earlier) } : new Refused(404, `job #${b.id} isn't a queued job that never ran and that you or a colleague queued for you`);
  },
  // hq waits <job> add|move|drop: a further wait added (`to` alone), moved to the work replacing its job (`from` and `to`),
  // or dropped (`from` alone): jobs.ts addWait, moveWait, dropWait. A card's wait (`request`) is added, or dropped (`drop`).
  // (add)
  'POST /api/agent/waits': (b, me) => {
    const [id, from, to] = [b.id, b.from, b.to].map(n => n == null ? null : Number(n));
    const answer = (r: string | { ok: boolean }) => typeof r === 'string' ? new Refused(409, r) : r;
    if (b.request != null) {
      const request = Number(b.request);
      if (![id, request].every(n => Number.isSafeInteger(n) && n! > 0)) return new Refused(400, 'jobs and cards are named by their numbers');
      return answer(b.drop === true ? jobs.dropCardWait(id!, request, me.agent, String(b.why ?? '')) : jobs.addCardWait(id!, request, me.agent, String(b.why ?? '')));
    }
    // (a job number given that isn't one, "x" or 1.5, is refused: as NaN it would pass the checks and change nothing)
    if ([id, from, to].some(n => n != null && !(Number.isSafeInteger(n) && n > 0))) return new Refused(400, 'jobs are named by their numbers');
    if (id != null && from == null && to != null) return answer(jobs.addWait(id, to, me.agent, String(b.why ?? '')));
    if (id != null && from != null && to != null) return answer(jobs.moveWait(id, from, to, me.agent, String(b.why ?? '')));
    if (id != null && from != null) return answer(jobs.dropWait(id, from, me.agent, String(b.why ?? '')));
    return new Refused(400, 'name a job to wait for (add), one to move a wait from and to (move), or one to stop waiting for (drop)');
  },
  // hq review <pr>: a stuck pull request goes back to the panel, same round and commit, or to its author's job when the
  // branch moved outside any job after a ruling, whose push gets the next round (review.ts resume()).
  'POST /api/agent/review': async (b, me) => { const r = await review.resume(Number(b.pr), me.agent); return typeof r === 'string' ? new Refused(409, r) : r; },
  // The call ledger (ledger.ts), for a job that works for the call only (charter rule 7: not every agent): its items in
  // full (hq items <call>) and its transcript, numbered (hq call <id> [a-b]). hq items alone: what's open on every
  // call, one plain line each (no words from any call), and its goal where the reader may read that call (openItemsFor).
  // A customer call's items hold their details: reading them marks the reader, as hq call does.
  'GET /api/agent/items': (b, me) => {
    if (!b.call) return openItemsFor(me);
    if (!works(me, Number(b.call))) return 404;
    if (memory.customerCall(Number(b.call))) jobs.handedCustomerData(me.id);
    return ledger.items(Number(b.call));
  },
  // hq item add: on the call this job follows up (or the one it names, if it works for it); hq item replace: the same,
  // with the earlier item's kind and owner. Only a call's follow-up replaces an item (that drops it and cancels its jobs
  // that never ran), and a live call's own token (the voice line's promise and replace tools), on its own call's list:
  // a promise, or the board's correction of an open item while it's on the line (the cancelling happens
  // before the follow-up starts; the running ones hear it from the follow-up: ledger.tell), only of an item its briefing
  // numbered (call.ts) or one the call recorded itself: a misheard number doesn't cancel an unrelated item's jobs. Nothing
  // else from a call.
  'POST /api/agent/item': (b, me) => {
    const on = me.call ? me.callId : b.call ? Number(b.call) : ledger.callOf(me.id);
    if (typeof on === 'string') return new Refused(409, on);
    const old = b.replaces != null ? ledger.item(Number(b.replaces)) : undefined;
    if (me.call && old) b = { ...b, kind: old.kind, owner: old.owner };
    else if (old) b = { kind: old.kind, owner: old.owner, ...b };
    if (!on || (me.call ? b.replaces == null && b.kind !== 'promise' : !ledger.mine(me.id, on))) return new Refused(403, me.call ? 'on a call, only a promise or a correction goes on the list' : "this job doesn't work for that call");
    if (b.replaces != null && !me.call && !ledger.followsUp(me.id)) return new Refused(403, "only a call's follow-up replaces an earlier item");
    if (b.replaces != null && !old) return new Refused(409, `item #${b.replaces} isn't there to replace`);
    // (a ready item is still open: its work ended, the board's yes is still to come, and the briefing lists it)
    if (me.call && b.replaces != null && !['open', 'ready'].includes(old!.status)) return new Refused(409, `item #${b.replaces} isn't open: on a call, only an open item is replaced (the call's follow-up can replace a handled one)`);
    if (me.call && old && old.call !== me.callId && !me.listed?.includes(old.id)) return new Refused(409, `item #${old.id} isn't one from your briefing: the call's follow-up corrects it from the transcript`);
    if (!assignable(String(b.owner ?? ''))) return new Refused(400, `${b.owner} isn't a colleague who takes work`);
    // --deadline: the time the board was given for it, which its job takes
    const due = b.deadline == null ? undefined : windows.parse(String(b.deadline), Date.now(), true);
    if (typeof due === 'string') return new Refused(400, due);
    // --job, on a live call: the work under way the promise is about. The item is linked to it as it's added (as hq item
    // link job:<id>, --thread too), so its thread takes the time at once and it's handled when that work ends done: both
    // or neither (askwindow.ts).
    const work = b.job == null ? undefined : promisedWork(b, due, me);
    if (work instanceof Refused) return work;
    if (b.thread != null && !work) return new Refused(400, '--deliverable goes with --job: it puts that work on the deliverable');
    const add = () => ledger.add(on, { ...b, owner: String(b.owner), quote: me.call && !b.quote ? b.what : b.quote, due }, me.call ? null : me.id);
    if (!work) return refusal(add());
    try {
      return refusal(inOneStep(() => {
        const added = add();
        if (typeof added !== 'object') return added;
        const link = ledger.link(added.id, work, me.agent, me.id);
        if (typeof link === 'string') throw new Refused(409, link);   // (the item with it: inOneStep rolls it back)
        linked(added.id, work.job, link);   // (a customer call's: it holds their details, as item-link marks it)
        return { ...added, job: work.job, ...'deadline' in link && { deadline: link.deadline, thread: link.thread } };
      }));
    } catch (err) {
      if (err instanceof Refused) return err;
      throw err;
    }
  },
  // hq item link <item> job:<id> | request:<id> | pause:<thread or project> | <ref>, and hq item drop <item> "why": the
  // call's follow-up, or (a link only) the job that carries the item or a job of roles.asks (keepsAsks). A job handed out
  // for one item doesn't close or cancel a colleague's. (works: also the follow-up of a call that carried on from the item's)
  // (pause: an open pause, which carries the item from then on: pauses.ts)
  'POST /api/agent/item-link': (b, me) => {
    const on = ledger.itemCall(Number(b.id)) ?? 0;
    const chief = me.agent === ceo() && !memory.customerCall(on) && !memory.keysCall(on)
      && memory.callAccess(on, me) === true;
    if (!works(me, on) && !chief) return 404;
    const ordinary = ledger.decides(me.id, Number(b.id), true) || keepsAsks(me, on);
    if (!ordinary && !chief) return new Refused(403, `item #${b.id} is the call's follow-up's to link, or its own job's`);
    const why = oneLine(String(b.why ?? ''));
    if (!ordinary && !why) return new Refused(400, 'say why the CEO links this item with --why "reason": HQ shows it on the feed');
    const pause = b.to?.pause == null ? undefined : pauses.openPause(String(b.to.pause));
    if (typeof pause === 'string') return new Refused(409, pause);
    const link = ledger.link(Number(b.id), { job: Number(b.to?.job) || undefined, request: Number(b.to?.request) || undefined, pause, ref: b.to?.ref, thread: str(b.thread) }, me.agent, me.id);
    if (typeof link !== 'string' && why) publish({ type: 'log', agent: me.agent, text: `Linked call item: ${why}` });
    return linked(Number(b.id), Number(b.to?.job) || undefined, link);
  },
  // (a ready item, its work ended without the board's yes: the CEO's too, as hq item done is)
  'POST /api/agent/item-drop': (b, me) => ceoOnReady(me, Number(b.id)) ? refusal(ledger.drop(Number(b.id), b.why, me.id))
    : !works(me, ledger.itemCall(Number(b.id)) ?? 0) ? 404
    : !ledger.decides(me.id, Number(b.id)) ? new Refused(403, `only the call's follow-up drops an item (it cancels the item's jobs)`)
    : refusal(ledger.drop(Number(b.id), b.why, me.id)),
  // hq item done <item> "what the board said": the board has the task or promise and said yes. The CEO's jobs only, on
  // any call (it reads nothing of the call); a live call's token records none.
  'POST /api/agent/item-done': (b, me) => me.call || me.agent !== ceo() ? new Refused(403, "only the CEO records the board's yes on an item")
    : refusal(ledger.done(Number(b.id), b.said, me.id)),
  // hq intake: a card on the CEO's intercom reply (chat.ts card).
  'POST /api/agent/intake': (b, me) => refusal(chat.card(me.id, b)),
  // hq reply: what the board reads after the call, apart from the job's report (ledger.ts reply).
  'POST /api/agent/reply': (b, me) => refusal(ledger.reply(me.id, String(b.text ?? ''))),
  // A lead can ask the board and keep its session (and team) alive while it waits: hq ask / hq wait.
  'POST /api/agent/request': (b, me) => {
    const agent = speaker(b.as, me);
    if (!agent) return 403;
    if (plainCredential(b)) return new Refused(400, 'a credential request names the keys it asks for (their names after the brief file, comma-separated): the board types them into key fields, never an answer box');
    if (!agentRequest(b, me.agent)) return 400;
    const problem = cardIssue(b) ?? unshelvedProblem(String(b.body ?? '')) ?? laterProblem(b) ?? jobs.questionsProblem(b.questions) ?? unseenProblem(b, me);
    if (problem) return new Refused(400, problem);
    const files = cardFiles.read(b.files); // files to download
    if (typeof files === 'string') return new Refused(400, files);
    // (the note or page it's about, which the book shows it under)
    const place = bookasks.place(b, agent);
    if (typeof place === 'string') return new Refused(400, place);
    const card = jobs.fileCard({ files, kind: String(b.kind), title: String(b.title), body: String(b.body ?? ''), urgency: str(b.urgency),
      agent, job: me.id, secrets: str(b.secrets), approves: str(b.approves), photos: b.photos, documents: b.documents, zips: b.zips, products: b.products, back: b.back, topic: b.topic, visibleFrom: b.visibleFrom,
      address: b.address, questions: b.questions, decides: b.decides, when: b.when, walk: b.walk, ...place });   // (topic, zips, visibleFrom, address, questions, decides, when; walk)
    return refusal(card);   // (a card about a page stays on the desk phone)
  },
  'POST /api/agent/request-answer': (b, me) => refusal(jobs.requestAnswer(Number(b.id), me.id)),
  // (only cards agents file, and a team member's only from its own job: its name isn't unique. An email card: its drafter
  // withdraws the open draft, outbox.ts)
  'POST /api/agent/request-close': (b, me) => { const agent = speaker(b.as, me), id = Number(b.id), job = agent === me.agent ? undefined : me.id;
    if (!agent) return 403;
    if (jobs.cardKind(id) === 'mail') return refusal(outbox.withdraw(id, agent, job));
    if (jobs.cardKind(id) === 'call') return refusal(callouts.withdraw(id, agent, job));
    if (!jobs.agentCard(id)) return 404;
    return jobs.closeRequest(id, agent, job); },
  'POST /api/agent/request-rewrite': (b, me) => { const agent = speaker(b.as, me);
    const problem = cardIssue(b) ?? unshelvedProblem(String(b.body ?? '')) ?? unseenProblem(b, me);
    return !agent ? 403 : problem ? new Refused(400, problem) : jobs.rewriteRequest(Number(b.id), agent, String(b.body ?? ''), me.id, agent !== me.agent); },
  // hq topic <id> "topic": the card's group in the desk phone's list
  'POST /api/agent/request-topic': (b, me) => { const agent = speaker(b.as, me);
    return !agent ? 403 : jobs.setTopic(Number(b.id), agent, b.topic, me.id, agent !== me.agent); },
  // hq request checks its card here before it parks: the worker files it once the job has ended, too late to fix it.
  // (parks: hq request's, which a job doing a call's work can't: later.ts parkProblem)
  'POST /api/agent/card-check': (b, me) => { const problem = cardIssue(b) ?? unshelvedProblem(String(b.body ?? '')) ?? laterProblem(b) ?? jobs.questionsProblem(b.questions) ?? (b.parks ? later.parkProblem(me.id) : null) ?? unseenProblem(b, me); return problem ? new Refused(400, problem) : { ok: true }; },
  'GET /api/agent/phone': () => ({ number: secret('TWILIO_PHONE_NUMBER') || null }), // hq phone: public anyway, it goes on the Imprint pages
  'GET /api/agent/phone/check': async () => ({ lines: await checkLine() }), // hq phone --check
  // hq jobs [agent]: what's in flight (open work jobs), everyone's or one agent's, but not the caller's own job.
  'GET /api/agent/jobs': (b, me) => jobs.openJobs({ agent: str(b.agent), except: me.id }),
  'GET /api/agent/room': () => room.getRoom(),   // (hq jobs: the same, naming the job by its number)
  // hq followthrough: the CEO's read of what the board agreed against the work under way; ok | acted "line": the
  // running check's verdict; requeue <job> "line": a failed job's agreed work back to its call's agent (followthrough.ts,
  // takeover.ts)
  'GET /api/agent/followthrough': (b, me) => (me.agent === ceo() ? { text: followthrough.read(me) } : 403),
  // hq summary: the CEO's picture of what the board waits for, what's late or stuck, and the queue (summary.ts)
  'GET /api/agent/summary': (b, me) => (me.agent === ceo() ? { text: summary.read(forecast.current()).text } : 403),
  'POST /api/agent/followthrough-verdict': (b, me) =>
    b.verdict !== 'ok' && b.verdict !== 'acted' ? 400
      : refusal(followthrough.recordVerdict(me.id, b.verdict, String(b.said ?? ''))),
  // (hq complete work: a check's session ends only with its verdict in)
  'GET /api/agent/followthrough-owed': (b, me) => ({ owed: followthrough.checkUnderWay(me.id) }),
  'POST /api/agent/followthrough-requeue': (b, me) =>
    !Number.isInteger(b.job) ? 400 : refusal(takeover.requeue(me.id, b.job, String(b.said ?? ''))),
  // hq route: the CEO reads the notes to route and the open work by thread, and routes them into a waiting job (a task of
  // them: hq job --notes); hq route log --since: every note sent since then, with
  // its times (routing.ts).
  'GET /api/agent/route': (b, me) => (me.agent === ceo() ? { text: routing.read(me) } : 403),
  // hq guestnotes: the CEO reads where invited people's notes wait in the board's Notebook, and sends one owner's on the
  // board's word (notebooksend.ts).
  'GET /api/agent/guestnotes': (b, me) => (me.agent === ceo() && !me.call ? notebooksend.guestNotes() : 403),
  'POST /api/agent/guestnotes/send': async (b, me) =>
    me.agent === ceo() && !me.call ? refusal(await notebooksend.sendGuestNotes(b)) : 403,
  'POST /api/agent/route': (b, me) => {
    if (me.agent !== ceo()) return 403;
    const notes = Array.isArray(b.notes) ? [...new Set<number>(b.notes.map(Number))] : [];
    if (typeof b.to !== 'string' || !notes.every(Number.isInteger)) return 400;
    return refusal(routing.route(me, b.to, notes));
  },
  'GET /api/agent/route-log': b => (Number.isNaN(Date.parse(b.since)) ? 400 : routing.log(new Date(b.since).toISOString())),
  // hq owed: products that owe the board a return after its feedback; hq owed close <slug> "why" (owed.ts)
  'GET /api/agent/owed': () => owed.list(),
  'POST /api/agent/owed-close': (b, me) => refusal(owed.close(String(b.slug ?? ''), me.agent, me.id, String(b.why ?? ''))),
  // hq overseer: the CEO's note to the Overseer, refused for anyone else and held till the run ends (overseer.ts); hq
  // overseer alone: the notes sent.
  //
  'POST /api/agent/overseer': (b, me) => refusal(overseer.send(String(b.text ?? ''), me, speaker(b.as, me))),
  'GET /api/agent/overseer': () => overseer.list(),
  'GET /api/agent/claim-plans': () => ({ cohorts: claimobservation.listCohorts() }),
  // hq report: the server's status report as HQ keeps it, the newest or one at a time, whole or what changed since; hq
  // report --list: the kept reports' times (oversight.ts)
  'GET /api/agent/report': async b => {
    if (b.list === '1') return { kept: oversight.reportTimes() };
    const [since, at] = [b.since, b.at].map(t => (t === undefined ? null : Date.parse(String(t))));
    if (Number.isNaN(since) || Number.isNaN(at)) return new Refused(400, 'a time is an ISO time, as the reports give it');
    const r = await oversight.report({ since, at });
    return r.status === 200 ? { text: r.text, asOf: r.asOf } : new Refused(r.status, r.text);
  },
  // hq extend <id>: more for a job that hasn't started yet, signed by whoever adds it. On a call, only a job the call
  // queued, started or not (call.ts addToJob).
  'POST /api/agent/extend': (b, me) => {
    if (me.call) return refusal(call.addToJob(me, Number(b.id), String(b.text ?? '')));
    const agent = speaker(b.as, me); return agent ? jobs.extendJob(Number(b.id), agent, String(b.text ?? '')) : 403;
  },
  'GET /api/agent/requests': (b, me) => jobs.openRequests(me, Number(b.id) || undefined),
  // hq mail: the company inbox, by what each mail is (mail.ts business): business mail for org.yaml's roles.businessMail,
  // a customer's mail for roles.customerData or roles.customerMail. Anyone else's job is refused, with how to get it: a bad
  // package in a job can't read what the job was never handed. The job that reads it holds customer data (jobs.ts).
  //
  // A listing says which mail answers an email HQ sent (outbox.ts markAnswers)
  'GET /api/agent/mail': (b, me) => {
    const access = mayReadMail(me), { kind, read } = mail.askMail(b, access, me.id);
    if (b.id) return readMailAs(me, access, kind, read, Number(b.id));
    return readMailAs(me, access, kind, () => outbox.markAnswers(read()));
  },
  // hq mail <id> saves a mail's attachments
  'GET /api/agent/mail-file': (b, me) => readMailAs(me, mayReadMail(me), mail.mailKind(Number(b.id), me.id), () => mail.attachmentForWorker(Number(b.id), Number(b.n), me.id), Number(b.id)),
  // hq mail <id> --raw saves a mail as received
  'GET /api/agent/mail-raw': (b, me) => readMailAs(me, mayReadMail(me), mail.mailKind(Number(b.id), me.id), () => mail.rawMail(Number(b.id), me.id) ?? NO_RAW_MAIL, Number(b.id)),
  // hq mail summary (mailforward.ts sendReport): a month's books to the board's own address, sent by org.yaml's
  // roles.finance only, from a job; its state for Finance and Process. Never the address.
  'GET /api/agent/mail-summary': (b, me) => {
    if (me.agent !== roles().finance && !jobs.inProcess(me.agent))
      return new Refused(403, "the books' deliveries are Finance's (org.yaml's roles.finance) and Process's to read");
    const receipts = mailforward.reports(b.month === undefined ? undefined : String(b.month));
    return typeof receipts === 'string' ? new Refused(400, receipts) : receipts;
  },
  'POST /api/agent/mail-summary': async (b, me) => me.agent !== roles().finance
    ? new Refused(403, "only Finance (org.yaml's roles.finance) sends the books, from its job")
    : refusal(await mailforward.sendReport(b)),
  'POST /api/agent/mail-summary/arrived': (b, me) => me.agent !== roles().finance
    ? new Refused(403, "only Finance (org.yaml's roles.finance) records the books' arrival, from its job")
    : refusal(mailforward.confirmArrival(b)),
  // hq note <id>: a review note the board sent, and its screenshot, for the agent whose job it was sent to; an outside
  // reviewer's for the jobs its share's notes went to (feedback.ts noteFor).
  'GET /api/agent/note': (b, me) => feedback.noteFor(Number(b.id), me),
  // hq notes [<slug>]: the notes hq note would give this agent, listed (feedback.ts sentTo).
  'GET /api/agent/notes': (b, me) => feedback.sentTo(me, b.slug ? String(b.slug) : undefined, b.before ? Number(b.before) : undefined),
  // hq note <id> fixed [job:<n>] "...": a job marks a note hq notes lists for its agent fixed (feedback.ts markFixed).
  'POST /api/agent/note-fixed': (b, me) => {
    if (!me.id) return new Refused(403, 'only a job marks a note fixed');
    const r = feedback.markFixed(Number(b.id), b.how, b.by == null ? null : Number(b.by), { id: me.id, agent: me.agent });
    return typeof r === 'string' ? new Refused(409, r) : r;
  },
  // hq note <id> answered "...": the job a note went to answers one that needs no work (feedback.ts markAnswered); the
  // work Stop hook: the notes still open this run hasn't been told about (feedback.ts untold).
  'POST /api/agent/note-answered': (b, me) => {
    if (!me.id) return new Refused(403, 'only a job answers a note');
    const r = feedback.markAnswered(Number(b.id), b.how, { id: me.id, agent: me.agent });
    return typeof r === 'string' ? new Refused(409, r) : r;
  },
  'POST /api/agent/notes-untold': (_b, me) => (me.id ? feedback.untold(me.id) : 403),
  // hq photos <id>: a request's photo fields, and each saved photo, for the agent who asked (or whose job asked).
  'GET /api/agent/photos': (b, me) => seePhotos(Number(b.id), me, () => photos.forWorker(Number(b.id))),
  'GET /api/agent/photo': (b, me) => seePhotos(Number(b.id), me, () => photos.photoForWorker(Number(b.id), Number(b.field))),
  // hq picture <id>: a picture the board shared on the intercom or a call, for whoever may read what it came with
  // hq studio: the photo studio's photos, for its keeper to edit and for anyone to use once approved (studio.ts).
  'GET /api/agent/studio': async () => refusal(await studio.answer(() => studio.listForAgent())),
  'POST /api/agent/studio/add': async (b, me) => refusal(await studio.answer(() => studio.addFromCard(b, me))),
  'GET /api/agent/studio/picture': async (b, me) => refusal(await studio.answer(() => studio.pictureForAgent(b, me, b.which))),
  'POST /api/agent/studio/edit': async (b, me) => refusal(await studio.answer(() => studio.editForAgent(b, me))),
  'POST /api/agent/studio/ready': async (b, me) => refusal(await studio.answer(() => studio.readyForAgent(b, me))),
  'POST /api/agent/studio/stop': async (b, me) => refusal(await studio.answer(() => studio.stopForAgent(b, me))),
  'POST /api/agent/studio/placed': async (b, me) => refusal(await studio.answer(() => studio.placedForAgent(b, me))),
  // (the shots asked for)
  'POST /api/agent/studio/request': async (b, me) => refusal(await studio.answer(() => studio.requestForAgent(b, me))),
  'POST /api/agent/studio/return': async (b, me) => refusal(await studio.answer(() => studio.returnForAgent(b, me))),
  'GET /api/agent/studio/record': async () => refusal(await studio.answer(() => studio.record())),
  // (pictures.ts)
  'GET /api/agent/picture': (b, me) => refusal(pictures.forWorker(Number(b.id), me)),
  // hq sketches [--archived], hq sketch <id>: the book's pages, for any job, a call's as its call (bookreads.ts); hq answer:
  // an answer clipped onto a note the board sent or a group of its notebook (bookanswer.ts).
  'GET /api/agent/sketches': (b, me) => bookreads.listForAgent(b.archived === '1', me),
  'GET /api/agent/sketch': async (b, me) => refusal(await bookreads.getForAgent(Number(b.id), me)),
  'POST /api/agent/answer': (b, me) => refusal(bookanswer.answer(b, me)), // (bookanswer.ts)
  // the call's answer_note tool (hq answer-note): its agent's answer on a note the board drew on the call (callanswer.ts;
  'POST /api/agent/call-answer': (b, me) => refusal(callanswer.answerOnCall(b, me)),
  // hq say: a message to a colleague (org.yaml or alumni), stored, and queued for its running Claude job or made a job
  // (messages.ts); hq inbox --hook (the worker's hook) takes this job's own, then acknowledges the ones it printed (only
  // that marks them delivered); hq sent says what became of yours.
  // On a call: the board's word to one job under way, by its number (call.ts reach).
  'POST /api/agent/message': (b, me) => { if (me.call) return refusal(call.reach(me, String(b.to ?? ''), Number(b.job), String(b.what ?? ''), String(b.goal ?? ''), String(b.text ?? '')));
    const agent = speaker(b.as, me), to = String(b.to ?? '');
    if (b.needsAnswer !== undefined && typeof b.needsAnswer !== 'boolean') return 400;
    const r = !agent ? 403 : !assignable(to) ? 404 : messages.send({ agent, job: me.id }, to, String(b.text ?? ''), undefined, undefined, b.needsAnswer === true);
    return r === 409 ? new Refused(409, `a chain of messages may start ${messages.CHAIN} jobs, and this one has`) : r; },
  // (a meeting seat's lines, and the server's memory: lowmemory.ts)
  'POST /api/agent/inbox': (b, me) => [...messages.take(me.id), ...meetingseats.take(me.id), ...lowmemory.take(me.id, b.stopping === true), ...diskwarnings.take(me.id, b.stopping === true)],
  // (and the meeting lines it printed, lines)
  'POST /api/agent/inbox-ack': (b, me) => {
    if (b.disk !== undefined && diskwarnings.ack(me.id, b.disk) === 400) return 400;
    if (b.lines !== undefined) meetingseats.read(me.id, b.lines);
    return messages.ack(me.id, b.ids);
  },
  'GET /api/agent/sent': (b, me) => { const agent = speaker(b.as, me);
    return agent ? messages.sent(agent, me, Number(b.id) || undefined) : 403; },
  // hq search, hq history, hq call (memory.ts): the shared files and the board's calls (with their summaries) for
  // everyone, and only the token's own agent's jobs and requests (a team member's go through its lead's). What holds a
  // customer's own details only for the job working on it (memory.ts readsDoc). Never on the board's HQ.
  //
  'GET /api/agent/search': (b, me) => memory.search(b.q, me, b.limit),
  'GET /api/agent/history': (b, me) => memory.history(me, b.q, b.limit),
  // hq intercom: the board's intercom with the CEO, everyone's like the board's calls, a day read whole (intercom.ts) or
  // its lines found by words and meaning (memory.ts)
  'GET /api/agent/intercom': async (b, me) => refusal(await memory.findIntercom(b.q, me, b.limit, b.day)),
  // hq estimate: work sized on done jobs like it (a queued job with its ETA), and the seats' headroom (estimates.ts)
  'GET /api/agent/estimate': b => estimates.estimate(b),
  'GET /api/agent/estimate/audit': () => estimates.audit(),
  // hq when: when new work could be done without making any window miss, or whether by a time and what would make it
  // (when.ts).
  'GET /api/agent/when': async (b, me) => refusal(await when.when(b, me.agent)),
  // An explicit CEO revision of a saved estimate, and the threads that moved (sizes.ts setSize)
  'POST /api/agent/sizes': (b, me) => {
    const agent = speaker(b.as, me);
    if (!agent) return 403;
    const earlier = moves.before();
    const size = sizes.setSize(Number(b.job), String(b.time ?? ''), String(b.why ?? ''), agent);
    return Array.isArray(size) ? refusal(size) : { ok: true, size, ...moves.since(earlier) };
  },
  // hq estimate --accuracy: how well the estimates held, set against what happened (accuracy.ts)
  'GET /api/agent/estimate/accuracy': b => accuracy.report(b),
  // hq estimate --calibration: both layers' misses, the sizes by agent, area and sizer, the ETAs by lead (calibration.ts);
  // hq estimate --backtest: the play replayed on the kept snapshots, and with --save those snapshots with what happened,
  // for a play on a branch (backtest.ts, scripts/backtest.ts).
  'GET /api/agent/estimate/calibration': b => calibration.report(b),
  'GET /api/agent/estimate/backtest': b => backtest.report(b),
  'GET /api/agent/estimate/snapshots': b => backtest.saved(b),
  // hq call <id> [a-b]: a call this job works for (the call ledger: its follow-up, or a job handed out for one of its
  // items) is its numbered transcript; otherwise any call memory.ts shows this agent, every line and its summary. A call
  // about a customer goes only to the jobs working on it (memory.ts callAccess), and marks its reader as holding their
  // details (on a call, the call: jobs.ts readerHanded, its moments and screen too);
  // one about a card for keys marks it as holding keys (jobs.ts holdsKeys).
  // hq call <id> moments | screen <time> (view): its recording on the same access, an ended call's (callviews.ts).
  'GET /api/agent/call': async (b, me) => {
    const id = Number(b.id), working = !!me.id && (ledger.mine(me.id, id) || ledger.resumed(me.id, id));
    const access = working || memory.callAccess(id, me);
    if (access !== true) return refusal(access);
    if (memory.customerCall(id)) jobs.readerHanded(me);
    if (chat.carriesKeys(id)) jobs.handedKeys(me.id);
    if (b.view === 'moments') return refusal(callviews.timeline(id));
    if (b.view === 'screen') return refusal(await callviews.screenAt(id, str(b.at)));
    if (b.view != null) return new Refused(400, 'view is moments or screen');
    return refusal(working ? ledger.transcript(id, b.lines) : memory.call(id, me));
  },
  // hq orders [since|all]: our live Print API orders as HQ last read them (orders.ts), for checking Print API's invoice. Only
  // what that check needs is kept (no address, names or text), but an order's id opens and cancels it on a product's
  // site (a shop's /api/orders/<id>): only org.yaml's roles.orders read them, and their job holds customer data, as
  // hq mail's does.
  'GET /api/agent/orders': (b, me) => {
    if (!reads(me.agent, 'orders')) return new Refused(403, orders.REFUSED);
    jobs.handedCustomerData(me.id);
    const r = orders.list(str(b.since));
    return typeof r === 'string' ? new Refused(400, r) : r;
  },
  // hq numbers [<slug>]: the apps' counts and orders per day, as HQ's Numbers shows them (metrics.ts). Numbers per day
  // only, nothing about a customer, so a call may read it too.
  'GET /api/agent/numbers': b => { const r = metrics.numbers(b); return Array.isArray(r) ? new Refused(r[0], r[1]) : withChat(r); },   // (Care › Numbers, and the company's parts')
  // hq spend <slug> <day> <euros>: a day's ad spend on an app, for the watch (spend.ts)
  'POST /api/agent/spend': (b, me) => { const r = spend.recordSpend(b, me.agent); return typeof r === 'string' ? new Refused(400, r) : r; },
  // hq care <case>, hq care draft <case> <file> (care.ts): the one card HQ handed this job (a question for the knowledge
  // keeper, a bug report for the app's owner), never another, except org.yaml's roles.care's job, which also reads any open
  // customer waiting on a person; the job that reads it holds customer data
  'GET /api/agent/care': (b, me) => { const r = care.forJob(String(b.case ?? ''), me.id, me.agent); if (r !== 404) jobs.handedCustomerData(me.id); return r; },
  // hq care: the open cases roles.care's job may read, one line each with nothing of the customer's
  'GET /api/agent/care-open': (b, me) => care.openForJob(me.agent),
  // hq care orders <case>: the live orders placed with an investigated card's address, for a job that may read the card;
  // Stripe failing is refused with its reason, to ask again once Stripe answers
  'GET /api/agent/care-orders': async (b, me) => {
    let r;
    try { r = await care.ordersForJob(String(b.case ?? ''), me.id, me.agent); } catch (err) { if (err instanceof payments.StripeError) return new Refused(err.status, err.message); throw err; }
    if (r !== 404) jobs.handedCustomerData(me.id);
    return typeof r === 'string' ? new Refused(409, r) : r;
  },
  // (with what an investigating job found, and its pass to the job that drafts from the board's answer)
  // (roles.care's job on any open one, not just the card it was handed)
  'POST /api/agent/care-draft': (b, me) => care.draftFromJob(String(b.case ?? ''), b.draft, me.id, b.found, me.agent),
  'POST /api/agent/care-pass': (b, me) => care.passFromJob(String(b.case ?? ''), b.job, me.id),
  // hq mail draft (outbox.ts): an email to an outside party, for the board to send from HQ, and one of the agent's own
  // drafts as it stands. The job's agent or its team member, never a call. --answers: a mail the job's agent may read
  'POST /api/agent/outbox': (b, me) => { const agent = speaker(b.as, me); return agent ? refusedDeliverable(me, 'an email draft', outbox.file(agent, me.id, b, mayReadOne(me))) : 403; },
  'GET /api/agent/outbox': (b, me) => { const agent = speaker(b.as, me); return agent ? outbox.forAgent(Number(b.id), agent) : 403; },
  // hq phone call (callouts.ts): a call out to a partner, for the board to approve, and one of the agent's own
  'POST /api/agent/callout': (b, me) => { const agent = speaker(b.as, me); return agent ? refusal(callouts.file(agent, me.id, b)) : 403; },
  'GET /api/agent/callout': (b, me) => { const agent = speaker(b.as, me); return agent ? callouts.forAgent(Number(b.id), agent, me.id) : 403; },
  // hq guest (guests.ts): a checklist for a named outside colleague, the board's card for it, and the answers on its items.
  // The job's agent only, never from a call.
  'POST /api/agent/guest': (b, me) => refusedDeliverable(me, "a guest's checklist", guests.write(me, b.guest, b.title, b.spec)),
  'GET /api/agent/guest': (b, me) => b.item ? guests.read(me, Number(b.item)) : guests.open(me),
  'POST /api/agent/guest-reply': (b, me) => refusal(guests.reply(me, Number(b.item), Number(b.n), b.text, b.pictures)),   // (pictures)
  'POST /api/agent/guest-add': (b, me) => refusal(guests.add(me, Number(b.item), b.spec)),
  'POST /api/agent/guest-drop': (b, me) => refusal(guests.drop(me, Number(b.item), Number(b.n))),
  'POST /api/agent/guest-close': (b, me) => guests.close(me, Number(b.item)),
};

// The worker token, compared in constant time (hashed first, so the lengths match).
const digest = (s: string) => createHash('sha256').update(s).digest();
// What a live call's token may do: hq job, add to a job it queued (hq extend), look things up (hq search, history, call
// and intercom: memory.ts, intercom.ts; hq when), and a promise or a correction on its own call's list. Its hand-off
// is a job, which carries the whole brief, and what the board adds to it goes into that job (call.ts addToJob). Its hq
// say reaches a job under way, for real need, as often as the board's word needs (call.ts reach).
// It reads no items, and earlier calls as its agent does (memory.ts), never the numbered transcript of a call a job
// works for. Everything else on /api/agent/* is a job's.
// A call out's token (callouts.ts) opens none: nothing of the company's is looked up for an outside partner, whose words
// could steer the look-up (house rule 9); what a call needs is in the why its agent filed
const PARTNER_ROUTES = new Set<string>();
// Routes for the voice line's manage tool (hq_tools.py MANAGE), with each route's own rules on who may
// (speaker, me.agent). A call has no job to speak as. Its follow-up links and drops its items.
// On a call about a customer's details (memory.ts customerCall: its card, its follow-up's, or a look-up on the call that
// handed it them, jobs.ts readerHanded) a change that carries the agent's own words is refused (CUSTOMER_CALL_SHUT,
// WORDS): a why, a name, a goal, a title, a topic, a note's text, a new slug or code go into HQ's feed and to
// colleagues' jobs, which don't hold the customer's details, and a call can't mark those jobs as holding them (jobs.ts
// handedCustomerData) the way a job working on the customer is marked. The call's follow-up, a job that holds them,
// makes those. A change that only names records already there (a job, a thread, a card by its number or slug) or sets
// a number or a time (a window, a place) carries none, and goes ahead: a cancel without a why, a window, a move, waits,
// a resume, a thread or project done, a project's owner, a meeting joined, a decision linked or settled on the board's word. A stop, a pause, a plan,
// meeting or proposal drop and an owed close each need a why, which reaches the feed and colleagues: those stay with
// the follow-up. Its reads stay open.
const MANAGE_ROUTES = ['POST /api/agent/cancel', 'POST /api/agent/stop', 'POST /api/agent/waits', 'POST /api/agent/window',
  'POST /api/agent/review', 'POST /api/agent/jobs/move', 'GET /api/agent/plan', 'POST /api/agent/plan/thread', 'POST /api/agent/plan/need',
  'POST /api/agent/plan/move', 'POST /api/agent/plan/drop', 'POST /api/agent/plan/done', 'POST /api/agent/plan/rename', 'POST /api/agent/plan/title',
  'GET /api/agent/threads', 'GET /api/agent/thread', 'POST /api/agent/threads/move', 'POST /api/agent/pauses', 'POST /api/agent/pauses/resume',
  'GET /api/agent/projects', 'POST /api/agent/project-notes', 'POST /api/agent/projects/new', 'POST /api/agent/projects/code',
  'POST /api/agent/projects/owner', 'POST /api/agent/projects/rename', 'POST /api/agent/projects/done', 'POST /api/agent/decisions',
  'POST /api/agent/decisions/link', 'POST /api/agent/decisions/settle', 'GET /api/agent/proposals', 'POST /api/agent/proposals/accept', 'POST /api/agent/proposals/drop',
  'GET /api/agent/meetings', 'GET /api/agent/meetings/one', 'GET /api/agent/meetings/asks', 'POST /api/agent/meetings/ask', 'POST /api/agent/meetings/set',
  'POST /api/agent/meetings/join', 'POST /api/agent/meetings/drop', 'GET /api/agent/jobs', 'GET /api/agent/room', 'GET /api/agent/requests',
  'POST /api/agent/request-close', 'POST /api/agent/request-topic', 'GET /api/agent/summary', 'GET /api/agent/followthrough',
  'POST /api/agent/sizes', 'GET /api/agent/owed', 'POST /api/agent/owed-close'];
const CUSTOMER_CALL_SHUT = new Set(MANAGE_ROUTES.filter(route => route.startsWith('POST ')));
const WORDS = ['why', 'name', 'goal', 'title', 'topic', 'text', 'blocks', 'business', 'newThread', 'slug', 'code'];
const carriesWords = (b: Record<string, unknown>) => WORDS.some(k => typeof b[k] === 'string' ? !!(b[k] as string).trim() : b[k] != null);
// The reads a job has, the board's call agent's too: the status report (its report tool), the notes to the Overseer,
// the notes routed to jobs, every call's open items as one line each (never one call's items: those are its
// follow-up's, rule 7), the estimates' checks (its manage tool).
const CALL_READS = ['GET /api/agent/report', 'GET /api/agent/overseer', 'GET /api/agent/route-log', 'GET /api/agent/items',
  'GET /api/agent/estimate/audit', 'GET /api/agent/estimate/calibration'];
// (the when tool: the eta tool)
const CALL_ROUTES = new Set(['POST /api/agent/job', 'POST /api/agent/item', 'GET /api/agent/search', 'GET /api/agent/history', 'GET /api/agent/call', 'GET /api/agent/intercom',
  'GET /api/agent/seat-warnings', 'POST /api/agent/seat-warnings',
  'GET /api/agent/numbers', 'GET /api/agent/when', 'GET /api/agent/estimate', 'GET /api/agent/outlooks', 'GET /api/agent/now', 'GET /api/agent/estimate/accuracy', 'POST /api/agent/extend', 'POST /api/agent/message',
  'POST /api/agent/expedite',
  'POST /api/agent/call-answer',
  ...MANAGE_ROUTES, ...CALL_READS]);
// The company's own agent routes (kits.ts): answered like the platform's, never on a call
for (const [k, r] of kits.agentRoutes(new Set(Object.keys(agentApi)))) agentApi[k] = async (b, me) => refusal(await r(b, me));
// The voice line (platform/voice), with its own token: a call's context (and its agent's call token), the transcript
// afterwards, a phone call's one-time ticket, and a picture the board shows on the live call (its screen on a
// walk-through, one of its sketches). Nothing else takes this token, and this token nothing else.
const voice: Record<string, (b: any) => unknown> = {
  'GET /api/voice/call-context': b => call.context(String(b.agent ?? ceo()), String(b.lang ?? 'en'), Number(b.request) || 0),
  // (the same, with the call's token in the body when the voice line restarts its agent mid-call: the call goes on)
  // phone: the call is on the phone line, with no screen for pictures
  // a call out to a partner (callouts.ts): its briefing, its hand-over, its ticket, and a join link's room
  'POST /api/voice/call-context': b => b.callout != null ? callline.context(b) : call.context(String(b.agent ?? ceo()), String(b.lang ?? 'en'), Number(b.request) || 0, String(b.token ?? ''),
    b.phone === true, b.walk === true),   // (walk)
  'POST /api/voice/call-end': b => b.callout != null ? callline.handOver(b) : call.handOver(String(b.agent ?? ''), Array.isArray(b.lines) ? b.lines.map(String) : [], Number(b.request) || 0, String(b.token ?? ''), b.times),
  'POST /api/voice/call-ticket': b => callline.redeem(String(b.ticket ?? '')) ?? phone.redeem(String(b.ticket ?? '')),
  'POST /api/voice/phone-done': b => phone.phoneDone(String(b.call ?? '')),   // the agent on the shop's line hung up
  'POST /api/voice/join-ticket': b => callline.joinTicket(String(b.token ?? '')),
  // (a picture the board shared on the live call, for its agent: pictures.ts)
  'GET /api/voice/picture': b => pictures.forVoice(Number(b.id), Number(b.call)),
  // (a walk-through: the screen's moments and a picture with a caller's turn, and the agent's screen tool, by the
  // watch-along's purpose and what it belongs to: watchalong.ts).
  'POST /api/voice/screen-turn': b => watchalong.screenTurn(b), // (each purpose's briefing: watchalong.ts)
  'POST /api/voice/screen': async b => refusal(await watchalong.screen(b)),
  // (a board call's sketch tool: one of the book's pages by its number or label, bookreads.ts.).
  'POST /api/voice/sketch': async b => refusal(await bookreads.forVoice(b)),
  // (a note the board drew on the live call, as the Pencil lifted: bookcalls.ts.)
  'GET /api/voice/note': b => bookcalls.forVoice(Number(b.id), Number(b.call)),
  // (a call's notes page: the agent's scraps, one per change, and its title. callnotes.ts)
  'POST /api/voice/scrap': async b => refusal(await callnotes.scrap(b)),
  'POST /api/voice/title': b => refusal(callnotes.title(b)),
};
const voiceAuthed = (h?: string) => !!VOICE_TOKEN && timingSafeEqual(digest(h ?? ''), digest(`Bearer ${VOICE_TOKEN}`));
const workerAuthed = (h?: string) => !!WORKER_TOKEN && timingSafeEqual(digest(h ?? ''), digest(`Bearer ${WORKER_TOKEN}`));
const bearer = (h?: string) => h?.startsWith('Bearer ') ? h.slice(7) : '';

// ---- the routes
// One table on shared/routes, each kind's sign-in a wrapper around its handlers. Ahead of it: what any host asks (HQ's
// health and sign-in, the previews' check), then the cycles' host. Its last row: HQ's own files.
async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x'), path = url.pathname;
  latency.time(req, res, path);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('content-security-policy', PAGE_CSP[path] ?? (/^\/(knowledge|cycles)\//.test(path) ? 'sandbox'
    : path.startsWith('/pay/imitation/') ? checkoutCsp : HQ_CSP)); // the test checkout: its own inline style, and Pay redirects to the product
  return anyHost(req, res, url);
}

// The JSON answer of a route in the kinds' tables: a value, a status (its word from ERRORS), a refusal in words, or a
// file as a Blob
async function answer(res: ServerResponse, routeReply: unknown) {
  if (routeReply instanceof Blob) return send(res, 200, Buffer.from(await routeReply.arrayBuffer()), routeReply.type);
  return typeof routeReply === 'number' ? send(res, routeReply, { error: ERRORS[routeReply] ?? 'refused' })
    : routeReply instanceof Refused ? send(res, routeReply.status, { error: routeReply.error, ...routeReply.more }) : send(res, 200, routeReply ?? null);
}
// A body from a sender already signed in (the board, a job, the worker, the voice line): the worker sizes its finish
// report (git.ts) and the text it masks (REDACT_MAX) to a million characters, which UTF-8 takes in at most 3 bytes each.
// A request before any sign-in has shared/routes's JSON_MAX.
const SIGNED_IN_MAX = 3_000_000;
// Linux execve(2): argv + envp cannot exceed 3/4 of _STK_LIM (8 MiB), even with a larger stack.
// https://man7.org/linux/man-pages/man2/execve.2.html
// A command byte can need six JSON bytes. The remaining report fields keep the normal signed-in budget.
const LINUX_COMMAND_MAX = 3 / 4 * 8 * 1024 ** 2;
const BLOCKED_MAX = 6 * LINUX_COMMAND_MAX + SIGNED_IN_MAX;
// A route's handler called with a POST's JSON body (refused when it isn't JSON within max) or a GET's query, and answered.
// jobOf: the job the request is for, whose share of HQ's time it's held to (reined); holds: false for a request spent
// from it but never held
const answered = async (
  request: RouteRequest,
  handle: (body: any) => unknown,
  max = SIGNED_IN_MAX,
  jobOf: (body: any) => number | undefined = () => undefined,
  holds = true,
) => {
  const { req, url, res, jsonBody } = request;
  const body = req.method === 'POST' ? await jsonBody(max) : Object.fromEntries(url.searchParams);
  if (body === null) return answer(res, new Refused(400, `the body: JSON of at most ${n(max)} bytes`));
  const job = jobOf(body);
  const waitsMs = holds ? Number(req.headers['x-hq-wait-ms']) || Infinity : 0;
  return job ? reined(res, job, () => handle(body), waitsMs) : answer(res, await handle(body));
};
// A job's request within its share of HQ's time (reins.ts): held while the job is past it, at most half of what its caller
// waits for the answer (x-hq-wait-ms: a worker report's or a timed hq command's own deadline), the other half left for
// HQ's answer, and at most half a run's lapse when it gives none (a run's heartbeat is never held: forWorker). Its
// handler's and answer's work, after their awaits too, is spent from its share (charged), and it's told on its answer.
const reinedMs = new WeakMap<ServerResponse, number>();   // (a held request's wait holds nothing: app's heldLong)
async function reined(res: ServerResponse, job: number, handle: () => unknown, waitsMs: number) {
  const heldMs = waitsMs > 0 ? await reins.admit(job, Math.min(waitsMs, jobs.STALE_MS) / 2) : 0;
  reinedMs.set(res, heldMs);
  const routeReply = await reins.charged(job, handle), told = reins.words(job, heldMs);
  if (told) res.setHeader('x-hq-rein', told);
  return reins.charged(job, () => answer(res, routeReply));
}
// A table's rows, each handler inside its wrapper
type Wrap<H> = (key: string, handle: H) => RouteHandler;
const wrapped = <H>(table: Record<string, H>, wrap: Wrap<H>) => Object.fromEntries(Object.entries(table).map(([key, handle]) => [key, wrap(key, handle)]));
const forWorker: Wrap<(b: any) => unknown> = (key, handle) => request => {
  if (!workerAuthed(request.req.headers.authorization)) return send(request.res, 401, { error: 'worker token' });
  jobs.workerHeard();   // (the intercom says when it isn't: chat.ts paused)
  return answered(request, handle, key === 'POST /api/worker/blocked' ? BLOCKED_MAX : undefined, b => Number(b.job) || undefined,
    key !== 'POST /api/worker/heartbeat');
};
const forVoice: Wrap<(b: any) => unknown> = (key, handle) => request =>
  voiceAuthed(request.req.headers.authorization) ? answered(request, handle) : send(request.res, 401, { error: 'voice token' });
const forAgent: Wrap<(b: any, me: Me) => unknown> = (key, handle) => request => {
  const me = agentOf(bearer(request.req.headers.authorization));
  if (!me) return send(request.res, 401, { error: 'agent token' });
  // (a call's agent repeats the refusal to the board, so it says why.)
  if (me.call && !CALL_ROUTES.has(key)) return send(request.res, 403, { error: "a call can't do this, as none of the call's tools reaches it: the call's follow-up does it" });
  if (me.callout && !PARTNER_ROUTES.has(key)) return send(request.res, 403, { error: ERRORS[403] });
  const shut = (b: Record<string, unknown>) => me.call && CUSTOMER_CALL_SHUT.has(key) && carriesWords(b) && memory.customerCall(me.callId!);
  // (a card's files come in its JSON: cardfiles.ts JSON_MAX)
  return answered(request, b => shut(b) ? new Refused(409, "this call is about a customer's details, and this change's words would reach HQ's feed and colleagues who don't hold them: make it without them where the command takes none (a cancel's why), or the call's follow-up makes it")
    : handle(b, me), FILE_ROUTES.has(key) ? cardFiles.JSON_MAX : undefined, () => me.id || undefined);
};
// A job's token, a live call's (call.ts) or a call out's (callline.ts)
function agentOf(token: string): Me | undefined {
  const job = jobs.tokenJob(token);
  if (job) return job;
  const onCall = call.callAgent(token);
  if (onCall) return { id: 0, agent: onCall.agent, call: true, callId: onCall.call ?? undefined, listed: JSON.parse(onCall.listed) };
  const partner = callline.tokenAgent(token);
  return partner ? { id: 0, agent: partner.agent, callout: partner.id } : undefined;
}
// Product previews (<slug>.preview.<zone>) are the same site as HQ, so SameSite=Strict still sends the board's
// session with a product page's fetch: anything that changes state must come from HQ's own pages, with their Origin.
const fromHq = (req: IncomingMessage) => req.method === 'GET' || req.method === 'HEAD' || req.headers.origin === ORIGIN;
const sameOrigin = (handle: RouteHandler): RouteHandler => request =>
  fromHq(request.req) ? handle(request) : send(request.res, 403, { error: 'origin' });
// The board's own, behind its session: an API answers 401, a page sends it to the sign-in
const forBoard = (handle: RouteHandler) => sameOrigin(request => {
  const { req, res, url } = request;
  if (!isAuthed(req)) return url.pathname.startsWith('/api/') ? send(res, 401, { error: 'login required' }) : redirect(res, '/login');
  keepOwnDevice(req, res);   // the board's device marked as its own, if it isn't yet (auth.ts).
  return handle(request);
});
// The board's JSON routes: a handler gets the request, its answer and its body
const boardJson = (handle: BoardRoute, max?: number): RouteHandler => request =>
  answered(request, b => handle(request.req, request.res, b), max);
const redirect = (res: ServerResponse, location: string) => { res.writeHead(302, { location }); res.end(); };
// One of HQ's files, always checked with the server: a browser mixing a cached stylesheet with new scripts breaks the page
const hqFile = (dir: string, file: string): RouteHandler => ({ req, res }) => { res.setHeader('cache-control', 'no-cache'); return sendFile(req, res, dir, file); };

// What any host may ask, a product preview's too
const anyHost = routes({
  'GET /health': ({ res }) => send(res, 200, { ok: true, commit: COMMIT, hq: hqFingerprint(), head: hqVersion.head }),
  'GET /vendor/webauthn.js': async ({ res }) => send(res, 200, await readFile(WEBAUTHN), TYPES['.js']),
  'GET /login': ({ res }) => send(res, 200, loginPage(brand()), TYPES['.html']),
  'GET /enroll': ({ res }) => send(res, 200, enrollPage(brand()), TYPES['.html']),
  // Product previews: Caddy's forward_auth check and the key hand-off run without the board session.
  '* /api/preview/check': ({ req, res }) => preview.check(req, res),
  '* /__preview': ({ req, res }) => preview.accept(req, res),
  // ...and a page's link for another device, from the page's own origin
  'POST /__preview/handoff': async ({ req, res, jsonBody }) => preview.handOn(req, res, await jsonBody()),
  // Review mode on a product host (feedback.ts): the board's key, not the HQ session, opens it
  '* /__review/*': ({ req, res }) => feedback.product(req, res),
  '* /*': ({ req, res, url }) => onHost(req, res, url),
});
// A shelf's review mode on the front's preview door (/<slug>/__review/*), and the cycles' pages, which get it from here
function onHost(req: IncomingMessage, res: ServerResponse, url: URL) {
  const product = feedback.productOf(req);
  if (product?.base) return feedback.product(req, res);
  if (product?.slug === owed.CYCLES) return cyclePage(req, res, url.pathname);
  return hq(req, res, url);
}

// A table of HQ's extra files (platform/hq/extras.mjs) as routes, a folder's by its files' names (feedback.ts answers
// review mode's parts).
const extraRoutes = (table: Record<string, string>): RouteTable => Object.fromEntries(Object.entries(table).map(([address, file]) =>
  address.endsWith('/')
    ? [`GET ${address}:file([a-z]+\\.js)`, (request: RouteRequest) => hqFile(`${REPO_DIR}/${file}`, `/${request.params.file}`)(request)]
    : [`GET ${address}`, hqFile(`${REPO_DIR}/${dirname(file)}`, `/${basename(file)}`)]));
// The board's own rows, from HQ's pages and its apps (kits.ts)
const board: RouteTable = {
  '* /api/events': ({ res }) => subscribe(res),
  ...kits.routeTable('board'),
  'GET /api/care/numbers': ({ res, url }) => { // (Care › Numbers: the board's)
    const r = careNumbers.board(Object.fromEntries(url.searchParams));
    return careNumbers.refused(r) ? send(res, r.status, { error: r.why }) : send(res, 200, r);
  },
  '* /api/care{/*}?': ({ req, res }) => care.board(req, res), // the board's Care app
  '* /api/studio{/*}?': ({ req, res }) => studio.board(req, res), // the board's Studio app (studio.ts).
  'POST /api/requests/photo': ({ req, res }) => photos.upload(req, res), // a photo for a desk-phone request
  // a photo the board added to a card, for the desk phone's archive
  'GET /api/requests/photo': ({ req, res, url }) => {
    const file = jobs.archivePhoto(Number(url.searchParams.get('id')), Number(url.searchParams.get('field')));
    if (file) res.setHeader('cache-control', 'private, no-store'); // the board's own photos: not kept in a cache, like Mail's files
    return file ? sendFile(req, res, photos.DIR, file.slice(photos.DIR.length)) : send(res, 404, 'not found', 'text/plain');
  },
  'POST /api/requests/document': ({ req, res }) => documents.upload(req, res), // a file for one
  // a big zip for one, in chunks, and how its import is going
  'POST /api/requests/zip': ({ req, res }) => zips.upload(req, res),
  'GET /api/requests/zip': ({ req, res }) => zips.show(req, res),
  'POST /api/pictures': ({ req, res }) => pictures.upload(req, res), // a picture for the intercom or a call
  'GET /api/pictures/file': ({ req, res }) => pictures.serve(req, res),
  // a call's walk-through to watch back, with its notes and items as the call log has them (callviews.ts forBoard),
  // and rrweb's replayer, which the player's page (HQ's extras) runs in a page of its own (REPLAY_CSP).
  'GET /api/calls/recording': ({ res, url }) => {
    const id = Number(url.searchParams.get('call')), listed = call.calls().find(c => c.id === id);
    if (!listed) return send(res, 404, { error: 'not found' });
    return callviews.forBoard(res, id, { agent: listed.agent, ts: listed.ts, request: listed.request, notes: listed.processed ? listed.reply : null, items: listed.items });
  },
  'GET /shared/watchalong/vendor/rrweb-replay.js': async ({ res }) => send(res, 200, await readFile(new URL('replay.js', watchalong.REPLAY)), TYPES['.js']),
  'GET /shared/watchalong/vendor/rrweb-replay.css': async ({ res }) => send(res, 200, await readFile(new URL('style.css', watchalong.REPLAY)), TYPES['.css']),
  // a page's ink and scraps, a note with its snip, and the pictures to show: a page's drawn here, a scrap, a snip and a
  // slip's (book.ts, booknotes.ts, bookslips.ts).
  // (who and every book's pictures)
  // (a question typed there asks: booktyped.ts.)
  'POST /api/book/page/save': boardJson((q, s, b) => notebookguests.managedPage(Number(b.id)) ? 403 : inBook(b.who, who => refusal(booktyped.savePage(b, who))), SAVE_MAX),
  'POST /api/book/note': boardJson((q, s, b) => refusal(booknotes.addNote(b)), NOTE_MAX),
  'GET /api/book/picture': ({ req, res }) => servePicture(req, res, null),
  'POST /api/book/scrap': ({ req, res, url }) =>
    inBook(url.searchParams.get('who'), who => book.uploadScrap(req, res, who), () => notFound(res)),
  'GET /api/book/scrap': ({ req, res }) => book.serveScrap(req, res, null),
  // a picture on the web dragged or pasted into the Notebook, fetched for it
  'GET /api/book/fetch': ({ res, url }) => bookfetch.fetchPicture(res, url.searchParams.get('url') ?? ''),
  'GET /api/book/snip': ({ req, res }) => booknotes.serveSnip(req, res),
  'GET /api/book/slip/picture': ({ req, res }) => bookslips.serveSlipPicture(req, res),
  // a notebook group's elements, a scrap with its snip, a reply with its ink, and a group's pictures
  'GET /api/notebooks/guests/pictures': ({ req, res }) => notebookguestroom.serveBoardPicture(req, res),
  'GET /api/notebooks/guests/slip/picture': ({ req, res }) => notebookguestroom.serveBoardPicture(req, res),
  'GET /api/notebooks/guests/slip/now': ({ req, res }) => notebookguestroom.serveBoardPicture(req, res),
  'POST /api/notebooks/groups/create': boardJson((q, s, b) => refusal(notebookgroups.createGroup(b)), SAVE_MAX),
  'POST /api/notebooks/groups/edit': boardJson((q, s, b) => refusal(notebookgroups.editGroup(b)), SAVE_MAX),
  'POST /api/notebooks/groups/scrap': boardJson((q, s, b) => refusal(createScrap(b)), NOTE_MAX),
  'POST /api/notebooks/groups/reply': boardJson(async (q, s, b) => refusal(await notebooksend.replyTo(b)), NOTE_MAX),
  'POST /api/notebooks/pictures': ({ req, res }) => notebookpictures.uploadPicture(req, res),
  'GET /api/notebooks/pictures': ({ req, res }) => notebookpictures.servePicture(req, res),
  // a slip's current picture and the board's own free-page saves
  'GET /api/book/slip/now': ({ req, res }) => bookslips.serveSlipPicture(req, res, undefined, 'now'),
  'POST /api/sketches/save': boardJson((q, s, b) => notebookguests.managedPage(Number(b.id)) ? 403 : refusal(sketchbook.saveSketch(b)), SAVE_MAX),
  'GET /api/sketches/picture': ({ req, res }) => servePicture(req, res, null),
  'POST /api/sketches/scrap': ({ req, res }) => book.uploadScrap(req, res, book.BOARD, '/api/sketches'),
  'GET /api/sketches/scrap': ({ req, res }) => book.serveScrap(req, res, null),
  'GET /api/guest/pictures': ({ req, res }) => guests.getPicture(req, res), // a guest reply's picture, on its card
  'GET /api/outbox/file': ({ req, res }) => outbox.getFile(req, res), // an email draft's attachment, on its card
  'GET /api/requests/file': ({ req, res }) => cardFiles.serve(req, res), // a card's file
  'GET /api/outbox/preview': ({ req, res }) => outbox.getPreview(req, res), // the letter as it will go, on its card
  'POST /api/voice': async ({ req, res }) => {
    const r = await transcribe(req, language.boardLanguage());   // the board's
    return typeof r === 'number' ? send(res, r, { error: 'voice' }) : send(res, 200, r);
  },
  '* /desk': ({ res }) => redirect(res, '/?open=phone'), // an old link or bookmark: HQ with the desk phone open
  '* /api/review/*': ({ req, res }) => feedback.hq(req, res), // the board's review notes, per product
  'GET /api/numbers/:app': ({ res, url, params }) => { // one app's numbers (metrics.ts)
    const r = metrics.numbers({ ...Object.fromEntries(url.searchParams), app: params.app });
    return Array.isArray(r) ? send(res, r[0], { error: r[1] }) : send(res, 200, withChat(r));   // (Care › Numbers, and the company's parts')
  },
  'GET /api/apps/icon': ({ req, res, url }) => { // an app's icon, for HQ's Apps
    const dir = apps.iconOf(String(url.searchParams.get('app')));
    return dir ? sendFile(req, res, dir, '/icon.png') : send(res, 404, 'not found', 'text/plain');
  },
  'GET /api/artifacts/picture': ({ req, res, url }) => { // an artifact's cover, for HQ's Artifacts
    const picture = artifacts.pictureOf(String(url.searchParams.get('id')));
    if (!picture) return send(res, 404, 'not found', 'text/plain');
    // (its address names the file's time, so a browser keeps it without asking again: a list redrawn never blanks it)
    if (url.searchParams.has('v')) res.setHeader('cache-control', 'private, max-age=31536000, immutable');
    return sendFile(req, res, picture.dir, picture.file);
  },
  'GET /api/mail/file': ({ res, url }) => sendAttachment(res, mail.attachment(Number(url.searchParams.get('id')), Number(url.searchParams.get('n')))),
  'GET /knowledge/*': ({ req, res, url }) => sendFile(req, res, `${REPO_DIR}/knowledge`, url.pathname.slice('/knowledge'.length), false),
  'GET /cycles/*': ({ req, res, url }) => sendFile(req, res, `${REPO_DIR}/products/_cycles`, url.pathname.slice('/cycles'.length)), // venture cycle presentations
  'GET /{index.html}?': async ({ res }) => {
    res.setHeader('cache-control', 'no-cache');
    return send(res, 200, hqIndex(await readFile(`${hqDir('/index.html')}/index.html`, 'utf8'), brandLook()), TYPES['.html']);
  },
  // the looks HQ ships, read from their folders
  'GET /renderers/looks.json': ({ res }) => send(res, 200, looks(HQ_DIR)),
  // the company's tip films, by file name
  'GET /films/films.json': ({ res }) => send(res, 200, filmFiles(THEME_DIR)),
  ...extraRoutes(BOARD_EXTRAS),
  // a company's own HQ apps (kits/<name>/hq/, at /kits/<name>/…, from the copy its routes run from)
  'GET /kits/:kit([a-z0-9][a-z0-9\\-]*)/*': request => {
    const { kit } = request.params;
    return hqFile(`${KITS_DIR}/${kit}/hq`, request.url.pathname.slice(`/kits/${kit}`.length))(request);
  },
};
const hq = routes({
  // The phone line's webhooks, from Twilio (signed; phone.ts checks the caller and the PIN, everyone else hears the company's message)
  'POST /api/twilio/:step(voice|pin|after)': ({ req, res, params }) => phone.webhook(req, res, params.step as 'voice' | 'pin' | 'after'),
  'POST /api/twilio/status': ({ req, res }) => callline.status(req, res),   // a call out's end, from Twilio
  // The company's own routes for its services and product servers, each with its own token
  ...kits.routeTable('service'),
  // Payments (payments.ts): product servers call with their own token; the imitation checkout page is for test mode only
  '* /api/pay/email': ({ req, res }) => ordermail.handle(req, res),   // a product's own order emails
  '* /api/pay/code': ({ req, res }) => phonecode.handle(req, res),   // the phone line's code, to an order's payer
  '* /api/pay/answer': ({ req, res }) => phonecode.handle(req, res),   // and an answer after a call
  '* /api/list/email': ({ req, res }) => listmail.handle(req, res),   // and its list's
  '* /api/list/notices': ({ req, res }) => listmail.handleNotice(req, res),   // the email service's webhook: its own leave link, an email it couldn't deliver
  '* /api/pay/parcel/*': ({ req, res }) => parcels.handle(req, res),   // the shop's one parcel
  '* /api/pay/line/held': ({ req, res }) => heldLines.handle(req, res),   // a line held for a person
  '* /api/pay/basket/code{/*}?': ({ req, res }) => codes.handle(req, res),
  '* /api/pay/closures{/*}?': ({ req, res }) => closures.handle(req, res),
  '* /api/pay/plans{/*}?': ({ req, res }) => plans.handle(req, res),
  '* /api/pay/backup/*': ({ req, res }) => seal.handle(req, res),
  '* /api/pay/viewer': ({ req, res }) => preview.companyViewer(req, res),   // whether a preview's viewer is the company's.
  '* /api/pay/history{/*}?': ({ req, res }) => history.handle(req, res),
  '* /api/pay/line/:kind(number|keep)': ({ req, res }) => history.handle(req, res),
  '* /api/pay/*': ({ req, res }) => payments.handle(req, res),
  '* /pay/imitation/*': ({ req, res }) => payments.imitationPage(req, res),
  // Counting (metrics.ts): product servers push their tallies with their own token.
  '* /api/metrics/push': ({ req, res }) => metrics.handle(req, res),
  // The support chat's service (care.ts): its cards for the board, a claim's photos and the state it reads, with its own
  // token
  '* /api/care/:what(cards|photos|state)': ({ req, res }) => care.service(req, res),
  'POST /api/care/numbers': ({ req, res }) => careNumbers.service(req, res), // (Care › Numbers: the day's counts)
  '* /api/care/credit': ({ req, res }) => careCredit.service(req, res), // the model credit running low
  // Inbound mail from the Cloudflare Worker (infra/mail), with its own token
  'POST /api/mail/inbound': async ({ req, res }) => { const r = await mail.receiveMail(req); return typeof r === 'number' ? send(res, r, { error: 'mail' }) : send(res, 200, r); },
  // What the Overseer reads, with its own key: the status report and the CEO's notes (oversight.ts). x-as-of: the time
  // to ask what changed since, next time.
  'GET /api/overseer/*': async ({ req, res, url }) => {
    const reading = await oversight.read(url.pathname.slice('/api/overseer/'.length), req.headers.authorization, url.searchParams.get('since'));
    res.setHeader('cache-control', 'private, no-store');
    if (reading.asOf) res.setHeader('x-as-of', reading.asOf);
    return send(res, reading.status, reading.text, 'text/markdown; charset=utf-8');
  },
  // Runs (runs.ts): agents' with their job's token, the helper's with its own key, from outside.
  ...runs.routeTable,
  ...wrapped(worker, forWorker),
  ...wrapped(agentApi, forAgent),
  ...wrapped(voice, forVoice),

  // From HQ's own pages, or a page of its own without the board's session
  ...wrapped(signIn, (key, handle) => sameOrigin(boardJson(handle, JSON_MAX))),
  'GET /pair': ({ res }) => send(res, 200, pair.pairPage, 'text/html; charset=utf-8'),
  'GET /pair/signin.js': hqFile(hqDir('/pairsignin.js'), '/pairsignin.js'),
  'GET /pair/signin.css': hqFile(hqDir('/pairsignin.css'), '/pairsignin.css'),
  // The guest desk (guests.ts): an outside colleague's page (and its script), opened by its link and a code by email, never by the board's session
  '* /guest/*': sameOrigin(({ req, res }) => guests.page(req, res)),
  // A call out's join link (callouts.ts): its page by its token, never the board's session
  'GET /join/*': ({ req, res }) => callline.joinRoute(req, res),
  // A watch-along's batches by its own key, and its recorder, from HQ's pages or a join link's: never the board's
  // session (watchalong.ts).
  'POST /api/watchalong/events': sameOrigin(({ req, res }) => watchalong.addEvents(req, res)),
  // a guest's walk-through, on the join link's own token (callline.ts).
  'POST /api/watchalong/join': sameOrigin(boardJson((q, s, b) => callline.startWatching(String(b.token ?? '')))),
  ...extraRoutes(OPEN_EXTRAS),
  'GET /shared/watchalong/vendor/rrweb-record.js': async ({ res }) => send(res, 200, await readFile(watchalong.RECORDER), TYPES['.js']),
  // On Air's podcast feeds and their sound, for podcast apps: by the show's key, never the board's session (onair.ts)
  '* /onair/*': sameOrigin(({ req, res, url }) => {
    const r = onair.outside(url.pathname, url.searchParams.get('key'));
    if (!r) return send(res, 404, 'not found', 'text/plain');
    res.setHeader('cache-control', 'private, no-cache');
    return 'xml' in r ? send(res, 200, r.xml, 'application/rss+xml; charset=utf-8') : sendFile(req, res, `${REPO_DIR}/knowledge`, r.file, false);
  }),
  // A preview's sign-in: an outside guest a share opens the page for goes on there without the board's session, anyone
  // else to the sign-in (guests.ts onward)
  '* /preview/login': request => isAuthed(request.req) ? forBoard(({ req, res }) => preview.login(req, res))(request)
    : sameOrigin(({ res, url }) => redirect(res, `/guest/onward${url.search}`))(request),
  'GET /manifest.webmanifest': async ({ res }) => {
    res.setHeader('cache-control', 'no-cache');
    return send(res, 200, hqManifest(await readFile(`${hqDir('/manifest.webmanifest')}/manifest.webmanifest`, 'utf8'), brandLook()), TYPES['.webmanifest']);
  },

  // The board's, behind its session: its own rows and the API its pages call
  ...wrapped(board, (key, handle) => forBoard(handle)),
  ...wrapped(api, (key, handle) => forBoard(boardJson(handle))),
  // HQ's own files, behind the board's session but for the few a browser fetches without it (PUBLIC). An API no row
  // answers is a 404 whoever asks.
  '* /*': request => {
    const path = request.url.pathname, file = path.endsWith('/') ? `${path}index.html` : path;
    if (path.startsWith('/api/')) return send(request.res, 404, { error: 'not found' });
    const open = PUBLIC.has(path) || path === `/${darkLogo(brand())}` || path === `/${logo(brand())}`;
    return (open ? sameOrigin : forBoard)(hqFile(hqDir(file), file))(request);
  },
});

// A mail's attachment, for HQ's Mail: always a download, never a page on HQ's origin
async function sendAttachment(res: ServerResponse, a: ReturnType<typeof mail.attachment>) {
  if (!a) return send(res, 404, 'not found', 'text/plain');
  const bytes = await readFile(a.file), pdf = /\.pdf$/i.test(a.name) && bytes.subarray(0, 5).toString('latin1') === '%PDF-';
  res.writeHead(200, { 'content-type': pdf ? 'application/pdf' : 'application/octet-stream', 'content-length': bytes.length,
    'content-disposition': attachment(a.name),
    'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'", 'cache-control': 'private, no-store' });
  return res.end(bytes);
}

export const app = (req: IncomingMessage, res: ServerResponse) => {
  const t = performance.now();
  return handle(req, res)
    .catch(err => {
      // work for an agent no seat runs, refused where any route makes it, in words for the caller
      if (err instanceof PlanCycleError && !res.headersSent) return send(res, 409, { error: err.message });
      if (err instanceof jobs.NoSeat && !res.headersSent) return send(res, 422, { error: err.message });
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: 'internal' });
    })
    .finally(() => heldLong(`${req.method} ${(req.url ?? '').split('?')[0].split('/').slice(0, 4).join('/').replace(/\d+/g, 'n').slice(0, 60)}`, t + (reinedMs.get(res) ?? 0)));
};

// What holds the server half a second or more, by name, in the log and the status report's holds (latency.ts held): a
// request, or a timer's callback (its synchronous part, all that blocks).
const heldLong = (name: string, t: number) => {
  const ms = performance.now() - t;
  if (ms >= latency.HOLD_MS) latency.held(name, ms);
};
const timed = <A extends unknown[]>(fn: (...a: A) => unknown) => {
  const name = fn.name || String(fn).replace(/\s+/g, ' ').slice(0, 100);
  return (...a: A) => { const t = performance.now(); try { return fn(...a); } finally { heldLong(name, t); } };
};
for (const k of ['setInterval', 'setTimeout'] as const) {
  const original = globalThis[k] as (fn: unknown, ms?: number, ...rest: unknown[]) => unknown;
  (globalThis as Record<string, unknown>)[k] = (fn: unknown, ms?: number, ...rest: unknown[]) =>
    original(typeof fn === 'function' ? timed(fn as (...a: unknown[]) => unknown) : fn, ms, ...rest);
}

const calloutSweep = () => callsweep.sweep().catch(err => console.error('Could not sweep the calls out:', err));
const cardFilesSweep = () => { try { cardFiles.sweep(); } catch (err) { console.error("Could not clear old cards' files:", err); } };
const reviewBriefsSweep = () => { try { reviewBriefs.sweep(); } catch (err) { console.error("Could not clear old review runs' briefs:", err); } };
const owedSweep = () => { try { owed.sweep(); } catch (err) { console.error('Could not check what the board is owed:', err); } };
const shareSweep = () => { try { feedback.endDue(); } catch (err) { console.error('Could not end the shares due:', err); } };
const laterSweep = () => {
  try { later.sweep(); } catch (err) { console.error('Could not look at the cards for later:', err); }
  try { tips.sweep(); } catch (err) { console.error('Could not look for the tips time brings:', err); }
  try { artifactTip(); } catch (err) { console.error('Could not read the artifacts for their tip:', err); }
};
// A deploy brings what's on main, the first artifact too (artifacts.ts reads them from the checkout): its tip (tips.ts),
// looked for once per deploy taken into the deploys table, whichever reader took it in.
let artifactsRead: string | null = null; // the newest deploy the artifacts were read at
const artifactTip = () => {
  if (!tips.due('artifact')) return;
  const newest = (db.prepare('select max(finished) at from deploys where ok = 1').get() as { at: string | null }).at;
  if (!newest || newest === artifactsRead) return;
  artifactsRead = newest;
  if (artifacts.list().length) tips.offer('artifact');
};
// New work's estimate and the minute's forecast in one play (forecast.ts sweep), on the deploys read in (its deploy lag).
const forecastSweep = () => {
  try { wakes.readDeploys(); } catch (err) { console.error('Could not read the deploys:', err); }
  try { forecast.sweep(); } catch (err) { console.error('Could not play the queue:', err); }
};
// (the play's kept input with the log, in one step)
const predictionWrite = () => { try { inOneStep(() => { predictionlog.write(); snapshots.write(); }); } catch (err) { console.error('Could not write the prediction log and the kept play inputs:', err); } };
const hireSweep = () => { try { hiring.sweep(); } catch (err) { console.error('Could not check the hires:', err); } };
const stallCheck = () => { try { stallSweep(); } catch (err) { console.error('Could not check the engines for a stall:', err); } };
const crashSweep = () => { try { crashCheck(); } catch (err) { console.error('Could not check the services for crashes:', err); } };
const followThroughCheck = () => {
  try { pausewake.sweep(); } catch (err) { console.error('Could not sweep the pauses (decided, or their owner to wake):', err); }
  try { followthrough.followThroughSweep(); } catch (err) { console.error("Could not run the CEO's follow-through check:", err); }
};
const overseerSweep = () => { try { overseer.sweep(); } catch (err) { console.error("Could not sweep the Overseer's notes:", err); } };
const reviveSweep = () => review.reviveRounds().catch(err => console.error('Could not look for lost reviews:', err));
const stuckSweep = () => review.settleStuck().catch(err => console.error('Could not look at stuck pull requests:', err));
const server = createServer({ shouldUpgradeCallback: feedback.dictates }, app);
// The only upgrade: review mode's live dictation (feedback.ts dictate).
server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => socket.destroy());   // (a reviewer gone mid-way)
  try { feedback.dictate(req, socket, head); } catch (err) { console.error(err); socket.destroy(); }
});
if (import.meta.main) server.listen(PORT, () => {  // tests import app without starting the server
  jobs.liftPlainKeyCards();
  feedback.markOutsideJobs();
  companyOnce(); // the company's own one-offs (company/migrations.sql), before the schedule can queue any work
  // and one that reaches the checkout later runs within a minute, not at the next restart.
  // A one-off that fails (it needs a deploy's new code) is rolled back and tried again at the next minute.
  setInterval(() => { try { companyOnce(); } catch (err) { console.error('Company one-off:', err); } }, 60_000);
  // every module's tables exist now: text written before the key store held a key gets it masked, if the keys changed since
  // the last pass (db.ts).
  scrubOnStart();
  console.log(`Coordinator ${COMMIT} listening on ${PORT}`);
  publish({ type: 'log', agent: roles().process, text: `Coordinator started (${COMMIT.slice(0, 7)}).` });
  startSchedule();
  memory.start(); // the search index (hq search): at start, then every 2 minutes, in the background
  merged.start(); // each merged pull request's lines, from the checkout's merges, for the sizer
  ledger.startSweep(); // calls whose follow-up failed get another (3 at most), then an alert
  watchalong.startSweep(); // recordings past their days
  bookcalls.startSweep(); // call pages nobody wrote on, once their walk-through ended or call is gone
  watchGazette(); // new posts: a toast in HQ, the unread count, a push
  onair.watchOnAir(); // new episodes: a push
  studio.watch(); // the photo studio's waiting photos, once its key is in.
  care.start(); // Care: replies held for Undo go out, cards past their time go
  outbox.start(); // an email cut off mid-send is open again, saying it may have gone
  notices.start(); // an account's notices of the last day without a job get one, then every 10 minutes
  // a card's files a month after it closed
  cardFilesSweep(); setInterval(cardFilesSweep, 3_600_000);
  // review runs' briefs a week after their pull request settled
  reviewBriefsSweep(); setInterval(reviewBriefsSweep, 60_000);
  callsweep.start(); setInterval(calloutSweep, 60_000); // a dial cut off ends failed; then what's due is dialled, and old transcripts go
  kits.start(); // the company's own parts' timers (kits.ts)
  plans.start(); // open plan checkouts read every 2 minutes
  payments.start(); // open basket sessions read every 2 minutes, old delivery addresses blanked
  codes.start();
  history.start(); // older baskets' payer hashes, and the records' end once a day
  parcels.start(); // the shop's parcels placed and read back every 2 minutes
  basketmail.start(); // basket emails not surely sent yet go again every 2 minutes
  orders.start(); // our live Print API orders (hq orders): read hourly once the live keys are in, only what the invoice check needs
  backup.start(); // the nightly off-site backup (infra/backup.py): a missed night reaches HQ's feed and the CEO
  watch.start(); // the live apps: up and able to sell every 5 minutes, the daily error scan and money check
  // proposals left for a planning job that ended go to their owner again
  const proposalSweep = () => { try { proposals.sweep(); } catch (err) { console.error('Could not pass the proposals on:', err); } };
  proposalSweep(); setInterval(proposalSweep, 60_000);
  setInterval(() => { try { meetingseats.sweep(); } catch (err) { console.error('Meetings:', err); } }, 60_000); // a meeting past its limit, or left by all, ends
  // threads whose work merged before this closed
  threadends.closeSettled();
  messages.sweep(); setInterval(messages.sweep, 60_000); // unread messages of a job whose finish stopped halfway become jobs
  setInterval(owedSweep, 60_000); // a product's return whose job ended gets a follow-up (owed.ts)
  setInterval(shareSweep, 60_000); // an outside reviewer's link past its date ends (feedback.ts endDue)
  setInterval(laterSweep, 60_000); // a card for later that shows now rings, if it's urgent (later.ts), and the tips time brings come (tips.ts)
  // new work gets its estimate (predictions.ts), and the queue is played (forecast.ts, again a moment after every change),
  // first a moment after the start: until then a request plays it, and hq job twice; its moved predictions written each
  // minute (predictionlog.ts)
  forecast.start(); forecast.playSoon(); ordering.start(); setInterval(forecastSweep, 60_000); setInterval(predictionWrite, 60_000);
  commitLines.refresh(); setInterval(commitLines.refresh, 60_000); // main's new commits onto the days' lines changed (commitlines.ts)
  setInterval(hireSweep, 60_000); // work queued for a colleague being hired starts once org.yaml has them
  setInterval(stallCheck, 60_000); // an engine with a ready seat and waiting work that starts nothing: HQ's feed and the CEO's summary (stalls.ts)
  setInterval(crashSweep, 60_000); // a service that keeps crashing is the process role's job, one per service (crashes.ts)
  setInterval(followThroughCheck, 60_000); // while the board's agreements are open or the summary has something, the CEO's hourly check, and its alarm (followthrough.ts)
  setInterval(overseerSweep, 60_000); // the CEO's notes a run cut off left held go (overseer.ts)
  review.actOnRulings(); setInterval(review.actOnRulings, review.RULING_SWEEP_MS); // a ruling a restart cut off is acted on after all
  diskCheck(); setInterval(diskCheck, 10 * 60_000); // an alarm for the CEO once the disk is 85% full (disk.ts)
  reviveSweep(); setInterval(reviveSweep, 5 * 60_000); // a round whose hand-off to the panel was lost comes back
  stuckSweep(); setInterval(stuckSweep, 5 * 60_000); // a stuck one whose work landed through another pull request is merged
  optimize(); setInterval(optimize, 60 * 60_000); // the query planner's statistics (db.ts)
  latency.start(stalled); // each minute's request times and event loop delays, for infra/report.sh; a stall is a job (stalljobs.ts)
  runs.start();
  // Caddy holds HQ's requests while the coordinator starts (infra/Caddyfile); this line logs how long the start took.
  const seconds = (milliseconds: number) => (milliseconds / 1000).toFixed(1);
  console.log(`Coordinator: answering ${seconds(performance.now())} s after its process started (its modules read at ${seconds(startProfile.READ_MS)} s, in at ${seconds(MODULES_LOADED_MS)} s)`);
  const busiestPlaces = startProfile.busiest();
  if (busiestPlaces) console.log(`Coordinator: its start's CPU went to ${busiestPlaces}`);
});

// A deploy stops this container (SIGTERM, through compose's init). The requests on their way finish and the feeds end, and
// new ones find no listener: Caddy holds those until the next coordinator listens (infra/Caddyfile, `upstream`) rather than
// cut a reply off. 5 s at most, inside Docker's 10. A connection kept alive after its last reply (Caddy's) is closed as
// soon as it idles. The search model's thread ends before the process does, between two of its batches (memory.ts
// stopModel()).
export function stop(on = server, exit: (code: number) => void = code => process.exit(code)) {
  const idle = setInterval(() => on.closeIdleConnections(), 50);
  on.close(() => {
    clearInterval(idle);
    try { latency.flush(); } catch (err) { console.error('Latency: the last minute was not written:', err); }
    predictionWrite();
    void memory.stopModel().then(() => exit(0));
  });
  endAll();
  on.closeIdleConnections();
  setTimeout(() => exit(0), 5_000).unref();
}
if (import.meta.main) process.once('SIGTERM', () => stop());
