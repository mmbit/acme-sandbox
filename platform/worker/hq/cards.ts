// The board's desk phone: asking it (hq ask, hq request), waiting for its answer, and keeping a card right (its topic,
// its text, closing it), with the photos the board adds to one.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as api from './api.ts';
import { shootSpot } from './askspot.ts';
import { MAX_FILE_BYTES, fileToSend, isFile, isReadable, privateFolder, readText, saveInFolder } from './files.ts';
import { compareText, print, stop, text } from './output.ts';

// (--address)
// (--product-shot)
// (several products on one approval, site:<slug>,<slug>)
const CARD_USAGE = `[KEY,KEY | live:<slug> | site:<slug>] [--address] [--photo "label"]... [--optional-photo "label"]...
                                                     [--product-shot "label"]... [--optional-product-shot "label"]...
                                                     [--document "label"]... [--optional-document "label"]... [--documents-to <address>]
                                                     [--zip "label"]... [--optional-zip "label"]... [--questions <file.json>] [--file <path>]...
                                                     [--product <slug>]... [--back <slug>]... [--visible-from <day>] [--decides <id>] --topic "topic"`;
// (--questions; a question's "optional": true)

export const ask = {
  help: `
   hq ask <kind> <urgency> "title" <body-file> ${CARD_USAGE} [--when deployed:<job>]... [--walk]
                                                     [--note <n> | --page <address> | --book <project | journal | n>]
                                                     [--at <address> --spot <selector>]
                                                     ask the board now; prints the request id (session stays alive).
                                                     Every card has a topic, a word or two the board's list of open
                                                     cards groups it under (e.g. billing, hosting): an open card's
                                                     where one fits (hq requests shows them), else a new one.
                                                     News that asks nothing of the board: kind notice. The
                                                     board closes it with Got it, a note optional (it reaches
                                                     you only if it types one); no keys, approval, fields or
                                                     --decides on a notice.
                                                     For keys: kind credential and the names (e.g. STRIPE_TEST_SECRET_KEY);
                                                     the board types them into password fields and they reach later jobs
                                                     as environment variables. Never ask for keys in the body.
                                                     A delivery address: --address on a credential card whose
                                                     four keys are one address, a company tool's own (name,
                                                     street and number, postcode, city, in that order). The
                                                     board can pick one it saved before, or save the one it
                                                     types; a job never sees a saved one
                                                     A product's launch: kind approval and live:<slug>; its public site
                                                     alone, ordering closed: site:<slug>. Several products on one card:
                                                     site:<slug>,<slug> (each its own record). The board gets Approve / Not
                                                     now, and only Approve records the approval (HQ says what it unlocks). No keys
                                                     with an approval.
                                                     Photos: each --photo adds a picture field next to the answer box (1 to 8,
                                                     labels up to 80 characters, all different; not with keys or an approval).
                                                     The board adds them from its tablet; the server removes GPS and other metadata.
                                                     A photo the shop may show (the photo studio edits it): --product-shot
                                                     "label" (or --optional-product-shot), a photo field whose label gives the
                                                     shot (the angle, the setting). The desk phone tags it a product photo and
                                                     asks for no ruler or tape, nothing else in the frame and a clean
                                                     background. The card's other photos are then check photos, only for us
                                                     to check a print, a ruler welcome. hq studio add takes product shots only.
                                                     Documents: each --document adds a file field (a PDF, JPEG or PNG the board has,
                                                     like an invoice from a billing page; labels as for photos), kept byte for byte.
                                                     --documents-to names one of the company's addresses (invoices, documents@):
                                                     the answer files each file as mail to it, kept as that mail is (invoices@: as
                                                     an invoice), and says which mail ids; read them with hq mail <id>.
                                                     Zips: each --zip adds a field for one big zip the board has (a few
                                                     GB at most; labels as for photos). HQ sends it in chunks and resumes after a
                                                     dropped line; the server unpacks it as it arrives, leaving out what a computer
                                                     can rebuild (node_modules, build output, caches, .git, system files) and keys
                                                     (.env), into a folder of its own that jobs read in place, read-only (/imports/
                                                     <request>-<label>). The answer gives the folder, what it holds and what was left
                                                     out; its _import.md lists each folder and every video.
                                                     Questions: anything the board must answer is a field, never a line in
                                                     the text or under "More". --questions names a JSON list, each one
                                                     {"title": "...", "detail": "one optional line"} and a "type":
                                                     "yes-no" (it taps Yes or No), "number" (with a "unit" like "mm"),
                                                     none for a short text, or "options": [...] to tap one (the guest
                                                     checklist's question shape; 1 to 40). "many": true with options
                                                     makes a pick-many (2 to 20): every option starts picked, the board
                                                     takes off what it doesn't want, none is an answer too. Never a
                                                     choice and a box to type it again. They show in order, beside
                                                     the photo fields; each needs its answer unless it says
                                                     "optional": true, for one the board may skip ("What to change,
                                                     if anything"), and the answer box goes optional. The answer lists
                                                     each question with the board's answer ("1. Is the cut straight?
                                                     → Yes", or "(left blank)"), then anything it typed.
                                                     Files for the board to put in place itself (a site's pages, a
                                                     config): --file <path> (hq ask; up to 8, 5 MB in all). The card
                                                     shows each as a download by its file's name, so a step says
                                                     "download page.html and put it in place of ...": never paste a
                                                     file's text into a block to copy. A key in a text file is
                                                     replaced by its name, as in any text.
                                                     Pictures in pairs, on any card: a line "Before and after:" in
                                                     the body, then one line per pair, "- Its label: <before
                                                     picture> <after picture> <its live link>" (the link optional;
                                                     pictures under products/_cycles/, on main or this job's own
                                                     with --when deployed:<this job>). The card leads with them,
                                                     and a tap opens one viewer: before and after in one place,
                                                     one pair after another.
                                                     A card about a product: --product <slug> (repeat for more), and its answer is
                                                     feedback the product's owner hears too. A card that brings a product back
                                                     to the board after its feedback (a new presentation, or why not):
                                                     --back <slug>, which closes what the product owes the board (hq owed).
                                                     Such a card leads with each change as it was and as it is
                                                     now, in its before-and-after pairs (Pictures in pairs,
                                                     above). Its text folds under More. A film or sound is its clip; a
                                                     change with nothing to see says "No pictures: why". HQ gives
                                                     it its answers (Good now, or notes on the preview in review
                                                     mode, which queue their own job): no Choose:, Options: or Steps:
                                                     A card that can't be acted on before a day (waiting on time or on
                                                     something outside): --visible-from 2026-10-13 keeps it off the desk
                                                     phone until 08:00 that day (the company's clock; or a UTC time,
                                                     2026-10-13T08:00Z), then it shows as a new card. It's open all the
                                                     while, and a job waiting on it waits; hq requests says until when
                                                     The card for a CEO decision or a review-assigned visual decision: --decides
                                                     <id>. Its answer lets go what waits for the decision
                                                     A card about work that isn't live yet (what this job handed out):
                                                     --when deployed:<job> (or deployed:pr:<n>; repeat for more) holds it
                                                     off the desk phone until that work is merged and deployed, then it
                                                     shows as a new card. From a call's follow-up or a job carrying a
                                                     call's item, it's held for this job's own work too. A held card's
                                                     answer isn't waited for (no hq wait): queue the step that needs it
                                                     with hq job --after request:<id>
                                                     Finished work worth showing (a new feature, a new screen; not an
                                                     icon or a setting: your judgment): --walk, and the card offers
                                                     "Walk me through it". Its tap rings you about the card, on a call
                                                     that opens a page in the board's book (kept only if it writes on
                                                     it): open the work on its screen, drive it and ring things as you
                                                     talk
                                                     A card about a note the board sent you: --note <n> (its number in
                                                     your brief), and the card shows in the board's book too, clipped
                                                     under that note, its choices and questions answered there or on
                                                     the desk phone: one answer closes both. This is how to ask the
                                                     board about a note (an answer of yours that ends in a question
                                                     asks nothing). The book is Ink Studio, the design stage: a card
                                                     for keys, uploads, files, an approval, steps or finished work
                                                     (--walk, --back) stays on the desk phone only, its note shown
                                                     there.
                                                     About a page with no note on it: --page <address>
                                                     (a path on HQ, or a preview's https address): the book clips it
                                                     on your sheet page of the day, under your ring
                                                     A design ask (a choice, a sketch, a question about how something
                                                     looks or works): --book <project>, and the card is also a scrap on
                                                     the Asks page of that project's book on the board's shelf (--book
                                                     journal: My journal, for HQ or work with no project yet; a project
                                                     with no book yet: My journal too; --book <n>: a guest's book,
                                                     one guest's or an open review round's, by its number, its
                                                     Share part what the board forwards to the guest). One answer,
                                                     in the book or on the desk phone, closes both; hq close takes
                                                     the scrap too, and the board deleting the scrap the card. Keys,
                                                     logins, approvals (money, launches), uploads, files, steps in
                                                     another system and finished work are refused with --book: they
                                                     go on the desk phone alone.
                                                     About one thing on a page: add --at <its https address, a
                                                     preview's> --spot <a CSS selector>. hq opens the page in
                                                     Chromium, and the scrap is its shot with the thing ringed in
                                                     pencil and where it is. The board's tap opens the page there,
                                                     the thing flashing. A page that won't load or a selector that
                                                     matches nothing files nothing`,
  // (--at, --spot)
  // (--walk; --note, --page; Ink Studio's desk-only cards; --book)
  // (topics:, zips, --visible-from; --address; --questions; notice; --when)
  // (a pick-many, --file)
  // (Before and after; pictures in pairs on any card)
  // (--visible-from's 08:00)

  async run(given: string[]) {
    const card = await readCard(given, 'ask');
    const { visibleFrom, questions, when } = card.request;
    await checkCard(card.bodyPath, card.back, { visibleFrom, questions, when });
    if (card.at) card.request.spot = await shootSpot(card.at.address, card.at.selector);
    const refusal =
      "The coordinator didn't take the request. A --topic is 1 to 40 characters. Photo, document and zip fields need 1 to 8 different labels of 1 to 80 characters, and can't go with keys or an approval; --documents-to names one of the company's own addresses, not one for the board alone; an approval grants live:<slug> or site:<slug> only (several slugs comma-separated); --product and --back name products (products/<slug>), never on a card for keys; --address goes on a credential card asking for four of a company tool's own keys; --decides names an awaited CEO decision or your review-assigned visual decision; a notice asks nothing (no keys, approval, fields or --decides); --note names a note of the board's sent to you, by its number in your brief, --page a path on HQ or a preview's https address, --book a project, journal or a guest's book's number (a design ask: no keys, approval, uploads, files or steps), one of them at most."; // (--note, --page, --book)
    const filed = await api.orStop(api.postJson('request', api.withSpeaker(card.request)), refusal, true);
    const id = text(filed.id);
    if (filed.held)
      return print(
        `Request #${id} is held off the board's desk phone until ${text(filed.held)} is merged and deployed; then it shows as a new card.`,
        `Queue the step that needs the answer: hq job --after request:${id} <agent> "title" <brief>, and finish this job.`,
      );
    const book = filed.book
      ? [
          `It's also a scrap on the Asks page of ${text(filed.book.name)} in the board's book${
            filed.book.fell
              ? ` (${text(card.request.book)} has no book yet: the CEO makes one with hq projectbook)`
              : ''
          }: an answer in either place closes both.`,
        ]
      : [];
    print(
      `Request #${id} is on the board's desk phone. Run: hq wait ${id}`,
      ...book,
      `If only a later step needs the answer, queue that step instead: hq job --after request:${id} <agent> "title" <brief>`,
    );
  },
};

export const request = {
  help: `
   hq request <kind> <urgency> "title" <body-file> ${CARD_USAGE} [--park]
                                                     ask the board and park this job (stop working after this). A job
                                                     with work that isn't in review yet files nothing at first: parking
                                                     would hold that work, and the jobs after it, until the answer. Use hq
                                                     ask and queue the step that needs the answer (hq job --after
                                                     request:<id>), or add --park when nothing can go on without it`,

  async run(given: string[]) {
    const park = given.includes('--park');
    const cardArguments = given.filter(arg => arg !== '--park');
    const card = await readCard(cardArguments, 'request');
    // (a card held for work going live is hq ask's, and so is one with files)
    if (card.request.files)
      stop(
        'Nothing was filed: --file goes with hq ask (a parked job ends before its files could go). Ask with hq ask --file, queue the step that needs the answer with hq job --after request:<id>, and finish this job.',
      );
    if (card.request.walk)
      stop(
        "Nothing was filed: --walk offers a walk-through of finished work, which a parked job hasn't got. Ask with hq ask --walk once the work's done.",
      );
    if (card.request.note !== undefined || card.request.page !== undefined || card.request.book !== undefined)
      stop(
        'Nothing was filed: --note, --page and --book go with hq ask (the book shows the card while your job goes on). Ask with hq ask, queue the step that needs the answer with hq job --after request:<id>, and finish this job.',
      );
    if (card.request.when)
      stop(
        'Nothing was filed: --when holds a card until work is live, and a parked job would wait for that. Ask with hq ask --when, queue the step that needs the answer with hq job --after request:<id>, and finish this job.',
      );
    const { visibleFrom, questions } = card.request;
    await checkCard(card.bodyPath, card.back, { visibleFrom, questions, parks: true });
    const jobFolder = process.env.HQ_JOB_DIR;
    if (jobFolder === undefined) stop('hq: HQ_JOB_DIR: unbound variable');
    if (!park) refuseParkingWork(dirname(jobFolder));
    mkdirSync(jobFolder, { recursive: true });
    writeFileSync(`${jobFolder}/request.json`, `${JSON.stringify(card.request, null, 2)}\n`);
    print('Request saved. It is sent when you stop; finish your notes and end your turn now.');
  },
};

// Parking a job holds its work, and every job queued after it, until the board answers, though often only a later step
// needs the answer. So a job whose clone has work that isn't in review yet (changes, or commits its upstream doesn't have)
// files nothing until it says --park. Exit 2, as hq job's overlap check: nothing was sent.
function refuseParkingWork(clone: string) {
  if (!hasUnreviewedWork(clone)) return;
  stop(
    "Nothing filed yet: this job has work that isn't in review. Parking holds it, and every job queued after this one, until the board answers. If only a later step needs the answer, ask with hq ask, queue that step with hq job --after request:<id>, and finish this job so its work goes to review. If this job can't go on at all without the answer, run the same command again with --park.",
    2,
  );
}

function hasUnreviewedWork(clone: string) {
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', clone, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    return git('status', '--porcelain') !== '' || Number(git('rev-list', '--count', '@{upstream}..HEAD')) > 0;
  } catch {
    stop(
      "Nothing filed: couldn't check this job's work. Fix the clone's git status and upstream, or use --park to park explicitly.",
    );
  }
}

type Field = { label: string; optional?: true; to?: string; shot?: 'product' };

type Card = {
  bodyPath: string;
  back: string[];
  request: Record<string, unknown>;
  at: { address: string; selector: string } | null;
};

// ask and request: the flags anywhere after the command, then kind, urgency, title, the body's file and the grant or
// keys.
async function readCard(given: string[], command: string): Promise<Card> {
  const { flags, args } = takeCardFlags(given);
  // Every card has a topic: the desk phone's list groups the open cards by it.
  if (flags.topic.replaceAll(' ', '') === '' && args.length >= 1) {
    const topics = await openTopics();
    stop(
      `Nothing was filed: give the card a topic, --topic "a word or two" (what the board files it under on the desk phone). Use an open card's topic if it fits${topics ? ` (${topics})` : ''}, or a new one.`,
    );
  }
  if (args.length < 4)
    stop(`usage: hq ${command} <kind> <urgency> "title" <body-file> [KEY,KEY | live:<slug> | site:<slug>] ...`);
  const [kind, urgency, title, bodyPath, grantOrKeys = ''] = args;
  // A card with no text reaches the board as only its title
  if (!isReadable(bodyPath))
    stop(`Nothing was filed: the body file ${bodyPath} can't be read (a file's path; - isn't stdin).`);
  const body = readText(bodyPath).replace(/\n+$/, '');
  if (body.trim() === '') stop(`Nothing was filed: the body file ${bodyPath} is empty. The card's text goes in it.`);
  if (flags.note !== '' && !/^\d+$/.test(flags.note))
    stop(`Nothing was filed: --note is a note's number, the number in your brief (not "${flags.note}").`);
  const request = {
    kind,
    urgency,
    title,
    body,
    ...grantOf(kind, flags.approves, grantOrKeys),
    ...(flags.address && { address: true }),
    ...(flags.photos.length > 0 && { photos: flags.photos }),
    ...(flags.documents.length > 0 && { documents: flags.documents }),
    ...(flags.zips.length > 0 && { zips: flags.zips }),
    ...(flags.questions !== '' && { questions: questionsIn(flags.questions) }),
    ...(flags.files.length > 0 && { files: filesIn(flags.files) }),
    ...(flags.products.length > 0 && { products: flags.products }),
    ...(flags.back.length > 0 && { back: flags.back }),
    topic: flags.topic,
    ...(flags.visibleFrom !== '' && { visibleFrom: flags.visibleFrom }),
    ...(flags.decides !== '' && { decides: Number(flags.decides) }),
    ...(flags.when.length > 0 && { when: flags.when }),
    ...(flags.walk && { walk: true }),
    ...(flags.note !== '' && { note: Number(flags.note) }), // (note, page)
    ...(flags.page !== '' && { page: flags.page }),
    ...(flags.book !== '' && { book: flags.book }),
  };
  return { bodyPath, back: flags.back, request, at: spotOf(flags, command) };
}

// --at and --spot: the page and the thing on it a design ask is about, shot by hq ask (askspot.ts)
function spotOf(flags: CardFlags, command: string) {
  if (flags.at === '' && flags.spot === '') return null;
  if (flags.at === '' || flags.spot === '')
    stop('Nothing was filed: --at <address> and --spot <selector> go together: the page, and the thing on it.');
  if (command !== 'ask' || flags.book === '')
    stop(
      "Nothing was filed: --at and --spot go with hq ask --book: the ask's scrap in the board's book shows the spot.",
    );
  return { address: flags.at, selector: flags.spot };
}

// --questions: the file's list, as JSON (the coordinator checks each question and says what's wrong with one)
function questionsIn(path: string): unknown {
  if (!isReadable(path)) stop(`--questions: can't read ${path}`);
  try {
    return JSON.parse(readText(path));
  } catch {
    return stop(`--questions: ${path} isn't JSON (a list of questions: run hq for its shape)`);
  }
}

// The coordinator's limit on a card's files (platform/coordinator/src/cardfiles.ts MAX_FILES), said here first
const MAX_FILES = 8;
// --file: each file's name and its bytes, in base64 (files.ts)
function filesIn(paths: string[]) {
  const files = paths.map(
    path => fileToSend(path) ?? stop(`Nothing was filed: --file ${path} isn't a file that can be read.`),
  );
  if (files.length > MAX_FILES) stop(`Nothing was filed: a card takes up to ${MAX_FILES} files (--file).`);
  if (files.reduce((n, f) => n + f.size, 0) > MAX_FILE_BYTES)
    stop(
      `Nothing was filed: a card's files take ${MAX_FILE_BYTES / 1024 / 1024} MB in all (--file). Hand the board fewer or smaller files.`,
    );
  if (new Set(files.map(f => f.name)).size < files.length)
    stop('Nothing was filed: two --file files with the same name. The board downloads each by its name.');
  if (files.some(f => !f.size)) stop('Nothing was filed: a --file file is empty.');
  return files.map(f => ({ name: f.name, data: f.data }));
}

// An approval names its grant (live:<slug> or site:<slug>, or --approves), a credential request its keys.
function grantOf(kind: string, approves: string, grantOrKeys: string) {
  if (approves !== '') return { approves };
  if (kind === 'approval' && grantOrKeys !== '') return { approves: grantOrKeys };
  return { secrets: grantOrKeys };
}

type CardFlags = {
  topic: string;
  approves: string;
  photos: Field[];
  documents: Field[];
  zips: Field[];
  documentsTo: string;
  questions: string;
  files: string[];
  products: string[];
  back: string[];
  visibleFrom: string;
  decides: string;
  when: string[];
  address: boolean;
  walk: boolean;
  note: string; // (note, page)
  page: string;
  book: string; // (a design ask's book: a project, journal, or a guest's book's number)
  at: string; // (the page a design ask is about, and the thing on it: askspot.ts)
  spot: string;
};

// (--product-shot: a photo field marked as a product photo)
type FieldFlag = { list: 'photos' | 'documents' | 'zips'; optional: boolean; shot?: 'product' };
const FIELD_FLAGS = new Map<string, FieldFlag>([
  ['--photo', { list: 'photos', optional: false }],
  ['--optional-photo', { list: 'photos', optional: true }],
  ['--product-shot', { list: 'photos', optional: false, shot: 'product' }],
  ['--optional-product-shot', { list: 'photos', optional: true, shot: 'product' }],
  ['--document', { list: 'documents', optional: false }],
  ['--optional-document', { list: 'documents', optional: true }],
  ['--zip', { list: 'zips', optional: false }],
  ['--optional-zip', { list: 'zips', optional: true }],
]);

// What each flag's value is, for the refusal when it has none
const NEEDS = new Map([
  ['--topic', 'a topic'],
  ['--approves', 'a grant'],
  ['--product', "a product's slug"],
  ['--back', "a product's slug"],
  ['--documents-to', 'an address (like invoices)'],
  ['--questions', 'a JSON file with a list of questions'],
  ['--file', "a file's path"],
  ['--visible-from', 'a day (2026-10-13)'],
  ['--decides', 'a decision (hq decision)'],
  ['--when', 'work going live (deployed:<job>)'],
  ['--note', "a note's number (from your brief)"], // (--note, --page)
  ['--page', "a page's address (a path on HQ, or a preview's https address)"],
  ['--book', "a project, journal, or a guest's book by its number"],
  ['--at', "a page's https address"],
  ['--spot', 'a CSS selector'],
]);

// The flags that take no value: an address card, and a walk-through offered
const SWITCHES = new Map<string, 'address' | 'walk'>([
  ['--address', 'address'],
  ['--walk', 'walk'],
]);

// A card's flags before any is read (out of takeCardFlags)
const noFlags = (): CardFlags => ({
  topic: '',
  approves: '',
  photos: [],
  documents: [],
  zips: [],
  documentsTo: '',
  questions: '',
  files: [],
  products: [],
  back: [],
  visibleFrom: '',
  decides: '',
  when: [],
  address: false,
  walk: false,
  note: '',
  page: '',
  book: '',
  at: '',
  spot: '',
});

// --topic, --approves <grant>, --photo / --optional-photo / --product-shot / --optional-product-shot "label",
// --document / --optional-document "label" with --documents-to <address> (each field with its address), --zip /
// --optional-zip "label", and --product / --back <slug>
function takeCardFlags(given: string[]) {
  const flags = noFlags();
  const args: string[] = [];
  for (let i = 0; i < given.length; i++) {
    const flag = given[i];
    const on = SWITCHES.get(flag);
    if (on) {
      flags[on] = true;
      continue;
    }
    const field = FIELD_FLAGS.get(flag);
    if (!field && !NEEDS.has(flag)) {
      args.push(flag);
      continue;
    }
    if (i + 1 >= given.length) stop(`${flag} needs ${field ? 'a label' : NEEDS.get(flag)}`);
    const value = given[++i];
    if (field) flags[field.list].push(fieldOf(field, value));
    else if (flag === '--topic') flags.topic = value;
    else if (flag === '--approves') flags.approves = value;
    else if (flag === '--product') flags.products.push(value);
    else if (flag === '--back') flags.back.push(value);
    else if (flag === '--visible-from') flags.visibleFrom = value;
    else if (flag === '--decides') flags.decides = value;
    else if (flag === '--when') flags.when.push(value);
    else if (flag === '--questions') flags.questions = value;
    else if (flag === '--file') flags.files.push(value);
    else if (flag === '--note') flags.note = value;
    else if (flag === '--page') flags.page = value;
    else if (flag === '--book') flags.book = value;
    else if (flag === '--at') flags.at = value;
    else if (flag === '--spot') flags.spot = value;
    else flags.documentsTo = value;
  }
  checkDocuments(flags);
  flags.documents = flags.documents.map(document => ({ ...document, to: flags.documentsTo }));
  return { flags, args };
}

// A field flag's label as the card carries it
const fieldOf = (flag: FieldFlag, label: string): Field => ({
  label,
  ...(flag.optional && { optional: true as const }),
  ...(flag.shot && { shot: flag.shot }),
});

// --document and --documents-to come together
function checkDocuments(flags: CardFlags) {
  if (flags.documents.length > 0 && flags.documentsTo === '') {
    stop('--document needs --documents-to <address>: where the files are filed as mail (like invoices)');
  }
  if (flags.documentsTo !== '' && flags.documents.length === 0) {
    stop('--documents-to needs --document or --optional-document "label": the file boxes it files');
  }
}

// The open cards' topics, each once, as the desk phone lists them; '' when HQ doesn't say.
async function openTopics() {
  let open: { topic?: unknown }[];
  try {
    open = await api.getJson('requests');
  } catch {
    return '';
  }
  const topics = open.map(card => card.topic).filter((topic): topic is string => typeof topic === 'string');
  const byLowerCase = topics
    .map(topic => ({ topic, key: asciiLowerCase(topic) }))
    .sort((a, b) => compareText(a.key, b.key));
  const once = byLowerCase.filter((entry, i) => i === 0 || entry.key !== byLowerCase[i - 1].key);
  return once.map(entry => `"${entry.topic}"`).join(', ');
}

const asciiLowerCase = (words: string) => words.replace(/[A-Z]/g, letter => letter.toLowerCase());

// ask, request and rewrite: the card as the desk phone will read it (platform/hq/shell/card.js, which the coordinator
// runs). One whose choices would show wrong isn't filed, and the author hears what the phone would show. Only that
// refusal stops it: without an answer, hq request still parks its card, and the coordinator checks it again as it files it.
// hq rewrite passes the open card it replaces (a card that brings a product back, by its --back or that card's own,
// recommends nothing). A --visible-from it can't read is refused here too, and hq request's parking (parks) from a job
// whose card would be held. The work a card is held for (when) lets its before-and-after pictures be this job's own,
// not on main yet.
async function checkCard(
  bodyPath: string,
  back: string[],
  {
    id,
    visibleFrom,
    questions,
    parks,
    when,
  }: { id?: number; visibleFrom?: unknown; questions?: unknown; parks?: true; when?: unknown },
) {
  const body = {
    body: readText(bodyPath),
    back,
    ...(id !== undefined && { id }),
    ...(visibleFrom !== undefined && { visibleFrom }),
    ...(questions !== undefined && { questions }),
    ...(parks && { parks }),
    ...(when !== undefined && { when }),
  };
  const answer = await api.orNoAnswer(api.call('card-check', { body, timeoutMs: 30_000 }));
  if (answer.status !== 400) return;
  stop(`The card wasn't filed: ${api.errorIn(answer.body, 'its choices would show wrong on the desk phone')}.`);
}

export const wait = {
  help: `
   hq wait <id>                                      wait for the board's answer (up to ~9 min per call; repeat)`,

  async run([id]: string[]) {
    if (!/^[0-9]+$/.test(id ?? '')) stop('usage: hq wait <id>');
    for (let i = 0; i < 54; i++) {
      // (a held card is refused with why)
      const reply = await api.call('request-answer', { body: { id: Number(id) } });
      if (reply.status === 409) stop(`hq wait: ${api.errorIn(reply.body)}.`);
      if (!api.isSuccess(reply.status)) stop(`hq wait: HQ answered ${api.httpCode(reply.status)}.`);
      const card = JSON.parse(reply.body);
      if (card.status !== 'open') {
        const answer = typeof card.answer === 'string' ? card.answer : JSON.stringify(card.answer ?? null, null, 2);
        return print(`The board answered: ${answer}`);
      }
      await new Promise(resolve => setTimeout(resolve, 10_000));
    }
    stop(`No answer yet. Run hq wait ${id} again (waiting costs nothing).`, 2);
  },
};

export const topic = {
  help: `
   hq topic <id> "topic"                             change the topic of an open card of yours (an email draft's or a
                                                     guest's too). The CEO can, on any open card.`,

  async run([id, newTopic]: string[]) {
    if (!/^[0-9]+$/.test(id ?? '') || !newTopic) stop('usage: hq topic <id> "topic"');
    const answer = await api.change('request-topic', {
      body: api.withSpeaker({ id: Number(id), topic: newTopic }),
      timeoutMs: 30_000,
    });
    if (answer.status === 200)
      return print(`Request #${id} is under "${text(JSON.parse(answer.body).topic)}" on the desk phone now.`);
    const why = answer.status === 400 ? 'a topic is 1 to 40 characters' : `request #${id} isn't an open card of yours`;
    stop(`Couldn't set it: ${why}.`);
  },
};

export const close = {
  help: `
   hq close <id>                                     take your own request off the board's desk phone (it's dealt with)
                                                     a job of yours parked on it (hq request) is cancelled, and jobs --after it start.
                                                     Jobs waiting for it (--after request:<id>) start, and read that it went unanswered
                                                     your own email draft's card, while it's open: the draft is withdrawn
                                                     unsent (one filed again in its place); the archive says you withdrew it`,

  // (why it's refused)
  async run([id]: string[]) {
    if (!/^[0-9]+$/.test(id ?? '')) stop('usage: hq close <id>');
    const answer = await api.change('request-close', { body: api.withSpeaker({ id: Number(id) }), timeoutMs: 30_000 });
    if (answer.status === 200) return print(`Request #${id} is off the desk phone.`);
    const why =
      answer.status === 404
        ? `request #${id} isn't an open card of yours that hq close takes`
        : api.errorIn(answer.body) || `HTTP ${answer.status}`;
    stop(`Couldn't close it: ${why}.`);
  },
};

//
export const requests = {
  help: `
   hq requests [id]                                  what's on the board's desk phone now (open requests, with their text;
                                                     a card with a customer's own details: title only, unless this job
                                                     works on it, and this job then holds them too; a card for later
                                                     says until when, a held one what work it waits for)`,

  async run([id]: string[]) {
    if (id && !/^[0-9]+$/.test(id)) stop('usage: hq requests [id]');
    const list = await api.orStop(api.get(id ? `requests?id=${id}` : 'requests'), "hq requests: HQ didn't answer.");
    if (id && list.replace(/\n+$/, '') === '[]') stop(`Request #${id} isn't open on the desk phone.`);
    for (const card of JSON.parse(list)) {
      const body = card.body ?? `(${text(card.left_out)})`;
      // a card for later: off the desk phone until then
      const later = card.hidden_until ? ` (for later: off the desk phone until ${text(card.hidden_until)})` : '';
      // a held card: until the work it waits for is live
      const held = card.held ? ` (held: off the desk phone until ${text(card.held)} is live)` : '';
      // its questions, as fields under the text
      const asked = Array.isArray(card.questions)
        ? `Questions:\n${card.questions.map((q: { title?: unknown }, k: number) => `${k + 1}. ${text(q.title)}`).join('\n')}\n`
        : '';
      print(
        `#${card.id} ${text(card.kind)} from ${text(card.agent ?? 'hq')} · ${text(card.title)} [${text(card.topic ?? 'no topic')}]${held}${later}\n${text(body)}\n${asked}`,
      );
    }
  },
};

export const rewrite = {
  help: `
   hq rewrite <id> <body-file>                       replace your own open request's text (the CEO: any request's)`,

  async run([id, bodyPath]: string[]) {
    if (!/^[0-9]+$/.test(id ?? '') || !isFile(bodyPath ?? '')) stop('usage: hq rewrite <id> <body-file>');
    await checkCard(bodyPath, [], { id: Number(id) });
    const body = api.withSpeaker({ id: Number(id), body: readText(bodyPath) });
    await api.orStop(api.post('request-rewrite', body), `Couldn't rewrite #${id}: it must be open and yours.`);
    print(`Request #${id} rewritten.`);
  },
};

export const photos = {
  help: `
   hq photos <id>                                    save a request's photos to a new folder $TMPDIR/request-<id>.XXXXXX/ and list
                                                     them (label → file; a product shot says so)`,

  async run([id]: string[]) {
    if (!/^[0-9]+$/.test(id ?? '')) stop('usage: hq photos <id>');
    const fields: PhotoField[] = JSON.parse(
      await api.orStop(api.get(`photos?id=${id}`), `Request #${id} has no photo fields (or isn't yours).`),
    );
    let folder: string;
    try {
      folder = privateFolder(`request-${id}`);
    } catch {
      stop("Couldn't make a folder for them.");
    }
    for (const field of fields) {
      const label = tabSeparated(field.label);
      const shot = field.shot === 'product' ? ' (product shot)' : '';
      if (field.saved === true) {
        const extension = field.type === 'image/png' ? 'png' : 'jpg';
        const path = `${folder}/${text(field.field)}-${slugOf(label) || 'photo'}.${extension}`;
        const photo = await api.getJson(`photo?id=${id}&field=${text(field.field)}`);
        saveInFolder(path, Buffer.from(text(photo.data), 'base64'));
        print(`${label}${shot} → ${path}`);
      } else if (field.optional === true) {
        print(`${label}${shot} (optional) → left empty`);
      } else {
        print(`${label}${shot} → not saved yet`);
      }
    }
  },
};

type PhotoField = { field: number; saved: boolean; optional: boolean; shot?: 'product'; type?: string; label: string };

// A label as a tab-separated line carried it: its backslashes, tabs and line breaks written out.
const tabSeparated = (label: string) =>
  label.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');

// A file name's part from a label: lower case, runs of anything else a single -, at most 40 characters.
function slugOf(label: string) {
  const slug = label
    .replace(/[A-Z]/g, letter => letter.toLowerCase())
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-/, '')
    .slice(0, 40);
  return slug.replace(/-$/, '');
}
