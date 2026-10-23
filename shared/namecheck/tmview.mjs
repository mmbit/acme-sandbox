// A name's first pass through the trade mark registers on TMview, in a real browser (shared/namecheck/README.md).
import { playwright } from '../demo/core.mjs';

const TMVIEW = 'https://www.tmdn.org/tmview';
const PAGE_SIZE = 100;
// TMview's firewall turns us away after a few hundred calls in a short while, so one search stays far below that.
// Classes are filtered here, after fetching: TMview's API hasn't been confirmed to filter them itself.
export const MAX_PAGES = 5;
const SETTLE_MS = 3_000;
const DEAD = new Set([
  'Expired',
  'Ended',
  'Withdrawn',
  'Refused',
  'Application withdrawn',
  'Application refused',
  'Surrendered',
  'Cancelled',
  'Revoked',
  'Invalidated',
]);
const TURNED_AWAY =
  'turned away by its firewall (after many searches). Try again in an hour, or search by hand at ' + `${TMVIEW}.`;
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

if (import.meta.main) await main(parseArgs(process.argv.slice(2)));

async function main(args) {
  const browser = await playwright().chromium.launch();
  try {
    const request = await openTmview(browser);
    const lookupOutcome = request.error
      ? request
      : args.detail
        ? await detail(request, args.detail)
        : await search(request, args);
    if (lookupOutcome.error) {
      console.error(`TMview: ${lookupOutcome.error}`);
      process.exitCode = 1;
    } else if (args.detail) printDetail(lookupOutcome.detail);
    else printMarks(lookupOutcome.marks);
  } finally {
    await browser.close();
  }
}

function parseArgs(argv) {
  const options = { name: '', offices: 'EM,BX,GB,WO', classes: '9,41,42', allClasses: false, detail: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--offices') options.offices = argv[++i];
    else if (arg === '--classes') options.classes = argv[++i];
    else if (arg === '--all-classes') options.allClasses = true;
    else if (arg === '--detail') options.detail = argv[++i];
    else options.name = arg;
  }
  const classesValid = options.classes.split(',').every(niceClass => niceClassNumber(niceClass) !== null);
  if ((!options.name && !options.detail) || !classesValid) {
    console.error(
      'usage: node shared/namecheck/tmview.mjs <name> [--offices EM,BX,GB,WO] [--classes 9,41,42] ' +
        '[--all-classes] | --detail <ST13>',
    );
    process.exit(2);
  }
  return options;
}

// TMview's API answers only a page that has run a search of its own (its firewall's cookies), so we open a results
// page once and call the API from inside it. The request it returns gives back the status and the raw text.
async function openTmview(browser) {
  const page = await browser.newPage({ userAgent: USER_AGENT });
  await page.goto(`${TMVIEW}/#/tmview/results?page=1&pageSize=30&criteria=C&basicSearch=name`, {
    waitUntil: 'networkidle',
    timeout: 60_000,
  });
  await page.waitForTimeout(SETTLE_MS);
  if (page.url().includes('/error/')) return { error: TURNED_AWAY };
  return (path, body) =>
    page.evaluate(
      async ([url, body]) => {
        const init = body
          ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
          : {};
        const response = await fetch(url, init);
        return { status: response.status, text: await response.text() };
      },
      [`${TMVIEW}${path}`, body],
    );
}

// ---- search and detail: request(path, body) → { status, text }; each returns its result or { error }

export async function search(request, options) {
  const query = {
    criteria: 'C',
    basicSearch: options.name,
    fOffices: options.offices.split(','),
    fields: [
      'ST13',
      'tmName',
      'tmOffice',
      'applicationNumber',
      'applicationDate',
      'tradeMarkStatus',
      'niceClass',
      'applicantName',
    ],
  };
  const incomplete = problem => ({ error: `search for "${options.name}" incomplete: ${problem}` });
  let marks = [];
  let totalPages = 1;
  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
    const body = { ...query, page: String(pageNumber), pageSize: String(PAGE_SIZE) };
    const searchPage = await readJson(await request('/api/search/results?translate=true', body), `page ${pageNumber}`);
    if (searchPage.error) return searchPage;
    if (pageNumber === 1) totalPages = searchPage.totalPages;
    const problem = checkPage(searchPage, pageNumber, totalPages);
    if (problem) return incomplete(`page ${pageNumber} ${problem}`);
    marks = marks.concat(searchPage.tradeMarks);
  }
  // A page that comes back twice would stand in for the page that never came.
  if (new Set(marks.map(mark => mark.ST13)).size < marks.length) {
    return incomplete('the same mark came back twice, so a page is missing');
  }
  const classified = marks.map(mark => ({ ...mark, niceClass: niceClassNumbers(mark.niceClass) }));
  if (options.allClasses) return { marks: classified };
  // A mark whose classes we can't read might be in ours: leaving it out would hide it.
  const unclassified = classified.find(mark => mark.niceClass === null);
  if (unclassified) {
    return incomplete(`${unclassified.ST13} comes without readable classes. Search with --all-classes to see it`);
  }
  const wantedClasses = new Set(options.classes.split(',').map(niceClassNumber));
  const inWantedClasses = mark => mark.niceClass.some(niceClass => wantedClasses.has(niceClass));
  return { marks: classified.filter(inWantedClasses) };
}

// What's wrong with a page of results, or '' when it can be counted. totalPages is what page 1 said.
function checkPage(searchPage, pageNumber, totalPages) {
  const marksOnPage = searchPage.tradeMarks;
  if (!Array.isArray(marksOnPage)) return 'has no list of marks';
  if (!Number.isInteger(searchPage.totalPages) || searchPage.totalPages < 0) return 'has no page count';
  if (searchPage.totalPages !== totalPages) {
    return `says ${searchPage.totalPages} pages where page 1 said ${totalPages}`;
  }
  if (totalPages > MAX_PAGES) {
    return (
      `says ${totalPages} pages, over the ${MAX_PAGES}-page budget that keeps us under TMview's firewall. ` +
      'Narrow it (--offices, or the name with a look-alike) and search again'
    );
  }
  if (marksOnPage.some(mark => typeof mark?.ST13 !== 'string')) return 'has a mark without its ST13 number';
  if (totalPages === 0) return marksOnPage.length > 0 ? 'says 0 pages but lists marks' : '';
  if (marksOnPage.length === 0) return 'is empty';
  if (marksOnPage.length > PAGE_SIZE) return `has more than ${PAGE_SIZE} marks`;
  // Every page but the last is full, so a short one has lost marks on the way.
  if (pageNumber < totalPages && marksOnPage.length < PAGE_SIZE) {
    return `has ${marksOnPage.length} marks where a page before the last has ${PAGE_SIZE}`;
  }
  return '';
}

// A mark's classes as numbers, or null when TMview sent none or ones we can't read.
function niceClassNumbers(niceClasses) {
  if (!Array.isArray(niceClasses) || niceClasses.length === 0) return null;
  const numbers = niceClasses.map(niceClassNumber);
  return numbers.includes(null) ? null : numbers;
}

// TMview sends a class as a number. Text like "09" is read as well, since some offices' records may carry it so.
function niceClassNumber(niceClass) {
  const readable = Number.isInteger(niceClass) || (typeof niceClass === 'string' && /^\d{1,2}$/.test(niceClass));
  const number = readable ? Number(niceClass) : 0;
  return number >= 1 && number <= 45 ? number : null;
}

export async function detail(request, st13) {
  const detailPath = `/api/trademark/detail/${encodeURIComponent(st13)}?translate=true`;
  const detailResponse = await readJson(await request(detailPath), `detail of ${st13}`);
  if (detailResponse.error) return detailResponse;
  const mark = detailResponse.tradeMark;
  if (typeof mark?.applicationNumber !== 'string') return { error: `detail of ${st13} has no mark in it` };
  if (!Array.isArray(mark.goodAndServices) || mark.goodAndServices.length === 0) {
    return { error: `detail of ${st13} lists no goods or services` };
  }
  if (!Array.isArray(detailResponse.applicants)) return { error: `detail of ${st13} has no owner` };
  return { detail: detailResponse };
}

async function readJson({ status, text }, what) {
  if (text.trimStart().startsWith('<')) return { error: TURNED_AWAY };
  if (status < 200 || status > 299) return { error: `${what} failed: HTTP ${status}` };
  try {
    const json = JSON.parse(text);
    return json && typeof json === 'object' ? json : { error: `${what} is not a JSON object` };
  } catch {
    return { error: `${what} is not JSON` };
  }
}

// ---- printing

function printMarks(marks) {
  const live = marks.filter(mark => !DEAD.has(mark.tradeMarkStatus));
  const dead = marks.filter(mark => DEAD.has(mark.tradeMarkStatus));
  console.log(`${live.length} live, ${dead.length} expired or ended (status as TMview has it today)\n`);
  for (const mark of [...live, ...dead]) {
    const classes = mark.niceClass?.join(',') ?? 'unknown';
    const filed = (mark.applicationDate ?? '').slice(0, 10);
    const owners = (mark.applicantName ?? []).join('; ');
    console.log(
      [
        mark.tmOffice,
        mark.applicationNumber,
        JSON.stringify(mark.tmName),
        mark.tradeMarkStatus,
        `classes ${classes}`,
        `filed ${filed}`,
        owners,
        mark.ST13,
      ].join(' | '),
    );
  }
}

function printDetail(detail) {
  const mark = detail.tradeMark;
  const owners = detail.applicants.map(owner => owner.organizationName ?? owner.fullName).join('; ');
  console.log(`${mark.tmName} | ${mark.registrationOfficeCode} ${mark.applicationNumber} | ${mark.markFeature} mark`);
  console.log(`Owner: ${owners}`);
  console.log(
    `Status: ${mark.markCurrentStatusCode}, registered ${(mark.codeRegistrationDate ?? '').slice(0, 10)}, ` +
      `expires ${(mark.expiryDate ?? '').slice(0, 10)}`,
  );
  console.log(`Register: ${detail.officeUrl}\nPicture: ${mark.markImageURI}\n`);
  for (const goods of mark.goodAndServices) console.log(`Class ${goods.niceClass}: ${goods.goodsAndServices}\n`);
}
