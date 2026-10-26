// Reads the company from the repo: the org chart, its brand, the newsletter's posts, and the Library
// (handbook, playbooks, notes).
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { parse, parseDocument, isAlias, isMap, isScalar, Scalar, type Pair } from 'yaml';
import { marked } from 'marked';
import { REPO_DIR } from './config.ts';
import { status, publish } from './events.ts';
import { db } from './db.ts';
import { sendToBoard } from './push.ts';
import { teamMembers, lastStep } from './team.ts';
import { TYPES, typeOf } from './types.ts';
import { formats } from '../../../shared/format/format.js';
import { contrastChannels } from '../../../shared/contrast/contrast.js';
import { zoneOf } from './clock.ts';

export function org() {
  const o = orgChart();
  for (const d of o.departments ?? [])
    for (const a of d.agents ?? []) a.status = status.get(a.id) ?? { state: 'idle' };
  // Sub-agents working in a lead's session sit in the lead's department while the job runs.
  const known = new Set((o.departments ?? []).flatMap((d: any) => (d.agents ?? []).map((a: any) => a.id)));
  const team = teamMembers(), names = new Map<string, string>([...(o.departments ?? []).flatMap((d: any) =>
    (d.agents ?? []).map((a: any) => [a.id, a.name])), ...team.map(m => [m.id, m.name] as [string, string])]);
  // Right now: the task its lead gave it, or for one its lead only named, its latest step, which HQ keeps following
  // (steps). No look: HQ quotes one, and a member's would only be its name.
  for (const m of team) {
    const d = (o.departments ?? []).find((x: any) => x.id === m.department);
    if (!d || known.has(m.id)) continue;
    known.add(m.id);
    const current = status.get(m.id) ?? { state: m.state, task: m.task ?? undefined }, named = !m.task;
    const rightNow = named ? { ...current, task: current.task || lastStep(m.job, m.id) } : current;
    (d.agents ??= []).push({ id: m.id, name: m.name, role: 'Team member', ...(m.parent && { focus: `with ${names.get(m.parent) ?? m.parent}` }),
      engine: 'claude', temp: true, ...(named && { steps: true }), status: rightNow });
  }
  return o;
}
// org.yaml, parsed again only when its text changes: every lookup of an agent reads it (jobs.ts findAgent), and parsing it
// takes tens of milliseconds. A copy each time, as org() adds to it. A missing or broken one throws.
const orgChart = () => structuredClone(readOnce(`${REPO_DIR}/company/org.yaml`, text => parse(text)));
// HQ's look: the company's brand and its HQ theme, {} for a file it doesn't have or that doesn't parse (HQ then runs on
// the foundation's defaults, platform/hq/shell/brand.js). The job queue reads the brand's mascots (jobs.ts boardId), so
// a typo in it is logged once, never thrown; each file is parsed again only when it changes.
const read = new Map<string, { stamp: string; value: any }>();
function optional(path: string, shape = (v: any) => v) {
  const file = `${REPO_DIR}/${path}`, s = statSync(file, { throwIfNoEntry: false });
  const stamp = s ? `${s.mtimeMs} ${s.size}` : '';
  if (read.get(path)?.stamp === stamp) return read.get(path)!.value;
  let value = {};
  try {
    const v = s && parse(readFileSync(file, 'utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) value = shape(v);
  } catch (err) { console.error(`${path} doesn't parse, so HQ reads it as empty:`, (err as Error).message); }
  read.set(path, { stamp, value });
  return value;
}
// A mascot is a map with its id: mascots that aren't a list of them read as none
export const brand = () => optional('company/brand.yaml', b => b.mascots === undefined ? b
  : { ...b, mascots: Array.isArray(b.mascots) ? b.mascots.filter((m: unknown) => m && typeof m === 'object') : [] });
// The brand as HQ and the guest page wear it: its one colour (brand.yaml colour, its logo's) is the title bar's
// (app.themeColour) and the guest page's accent, with black or white letters on it, whichever reads, where they name
// none of their own (Wire's colourways take it in scene.js, which trusts it's #rrggbb). One that isn't throws, so what
// wears the look fails with it (GET /api/brand's 500), while brand() stays the file for mail, jobs, care and calls; the
// gates refuse it before it's deployed (shared/gates/brand.ts).
export function brandLook() {
  const b = brand(), colour = b.colour;
  if (colour === undefined) return b;
  if (typeof colour !== 'string' || !/^#[0-9a-f]{6}$/i.test(colour)) throw new Error(`company/brand.yaml's colour ${JSON.stringify(colour)} isn't #rrggbb`);
  const channels = [1, 3, 5].map(i => parseInt(colour.slice(i, i + 2), 16));
  const onAccent = contrastChannels(channels, [0, 0, 0]) > contrastChannels(channels, [255, 255, 255]) ? '#000000' : '#ffffff';
  const guest = b.guest ?? {}, own = guest.colours ?? {};
  return { ...b, app: { themeColour: colour, ...b.app },
    guest: { ...guest, colours: own.accent === undefined ? { ...own, accent: colour, onAccent: own.onAccent ?? onAccent } : own } };
}
// Words the speech engines say wrong, respelt as they should sound, by language (brand.yaml speech.respell): the voice
// line gets them with a call's context and a care ticket, and says the respelling (platform/voice/aloud.py respelt).
export const respellings = (): Record<string, Record<string, string>> => brand().speech?.respell ?? {};
// The company's mail domains, in lower case: brand.yaml's mail.domain first (the public one, which HQ sends from and gives
// out), then mail.also (further domains whose mail reaches HQ the same way). None without mail.domain.
export function mailDomains(): string[] {
  const mailSettings = brand().mail ?? {};
  const publicMailDomain = normalizeMailDomain(mailSettings.domain);
  if (!publicMailDomain) return [];
  const additionalDomains = Array.isArray(mailSettings.also) ? mailSettings.also : [];
  const normalizedAdditionalDomains = additionalDomains.map(normalizeMailDomain)
    .filter((mailDomain: string | null): mailDomain is string => !!mailDomain);
  return [...new Set([publicMailDomain, ...normalizedAdditionalDomains])];
}
const normalizeMailDomain = (candidateDomain: unknown) => {
  if (typeof candidateDomain !== 'string') return null;
  const trimmedMailDomain = candidateDomain.trim();
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(trimmedMailDomain) ? trimmedMailDomain.toLowerCase() : null;
};
export function mailDomainPattern(domainNames = mailDomains()) {
  const escapedDomains = domainNames.map(mailDomain => mailDomain.replace(/[.+]/g, '\\$&'));
  return `(?:${escapedDomains.join('|') || '(?!)'})`;
}
export const theme = () => optional('theme/hq.yaml');
// The board's projects: each an id, its name, its owner (an agent id) and maybe its product (a products/<slug>) and
// business, kept in HQ's db (the projects table, made with hq project new). company/projects.yaml's old `projects:` list
// is lifted into it as the file is read, each id not in it yet (an entry without an id, a name and an owner is left out),
// and then leaves the file.
// The file's settings: requireThread: a job queued by hand must name a thread when it has none to inherit (server.ts),
// which a company turns on once its open work is in threads. A missing or empty file means none. YAML that cannot be
// parsed throws.
// made: the project each kind of job HQ makes goes to, by its app (made.ts): errors, the error scan's triage (the app's
// slug, care: the chat); checks, the hourly check and its repair, alarms, the CEO's (hq): those two carry a window, so a
// company needs their project (a new one has the template's file: template/company/projects.yaml). The board's notes
// become tasks in their projects as the CEO routes them (routing.ts).
// businesses: what the projects are grouped under, in the board's order, each an id, a name, maybe a cover (a file
// under theme/hq/), maybe its owner (an agent id) and maybe the style its covers are drawn in (its own and its projects':
// `pixel` shows them at whole pixels, any other word or none smooth.). A project
// names its business. groups: the projects view's side groups beside the businesses (recurring: the routines'
// projects, schedule.ts keepProjects; unsorted: the work outside the projects), each maybe with a cover and its style
// the same way. Both as declared.
// A group may carry its own name for the view: a company that names
// unsorted, the CEO's desk (call follow-ups and the CEO's own work, projects.ts listProjectBoard), has it as a standing
// tile.
// covers: each project's cover by its id, a file under theme/hq/ the same way (the projects are HQ's data, their pictures
// the company's).
export type Business = { id: string; name: string; cover?: string; owner?: string; style?: string };
export type GroupKind = 'recurring' | 'unsorted' | 'meetings'; // (meetings: the meetings' seats.)
export type MadeKind = 'errors' | 'checks' | 'alarms';
export type Project = { id: string; name: string; owner: string; product?: string; business?: string };
export type ProjectSettings = {
  list: Project[]; businesses: Business[];
  groups: Partial<Record<GroupKind, { cover?: string; style?: string; name?: string; code?: string }>>; // (code: its tasks' prefix, as a project's: jobcodes.ts.)
  covers: Record<string, string>;
  made: Partial<Record<MadeKind, Record<string, string>>>;
  requireThread: boolean;
};
export function projects(): ProjectSettings {
  let file;
  try {
    file = readOnce(`${REPO_DIR}/company/projects.yaml`, source => liftProjects(parse(source) ?? {}));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    file = {};
  }
  const list = db.prepare("select id, name, owner, product, business from projects where status = 'open' order by rowid").all()
    .map(p => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== null)) as Project);
  return { list, businesses: file.businesses ?? [], groups: file.groups ?? {}, covers: file.covers ?? {}, made: file.made ?? {},
    requireThread: file.requireThread === true };
}
// A project's cover where projects.yaml names one, and the style its business gives its covers.
export const coverOf = (project: Project) => ({
  cover: projects().covers[project.id],
  style: projects().businesses.find(b => b.id === project.business)?.style,
});
// The file's `projects:` entries the table hasn't got, put in it (once the file's text changes: readOnce)
function liftProjects(file: any) {
  const text = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : null;
  const lift = db.prepare(`insert into projects (id, name, owner, product, business, created, by, code)
    values (?, ?, ?, ?, ?, ?, 'projects.yaml', ?) on conflict(id) do nothing`);
  for (const p of Array.isArray(file.projects) ? file.projects : []) {
    const [id, name, owner, product, business, code] = [p?.id, p?.name, p?.owner, p?.product, p?.business, p?.code].map(text);
    if (id && name && owner) lift.run(id, name, owner, product, business, new Date().toISOString(), code);
  }
  return file;
}
// any other YAML file of the company's, read the same way (a company's own parts import no package: kits.ts)
export const yamlFile = (path: string) => optional(path);
// YAML not yet in the repo (a draft an agent sends for a look), parsed the same way.
export const yamlText = (text: string): unknown => parse(text);
// The CEO's agent id (org.yaml's company.ceo): whom the board's intercom, directives and calls go to by default
export const ceo = (): string => String(optional('company/org.yaml').company?.ceo ?? '');
// A company with no team yet: org.yaml has nobody but the CEO, as a new company starts (template/company/org.yaml)
export const unstaffed = () => (org().departments ?? []).every((d: any) => (d.agents ?? []).every((a: any) => a.id === ceo() || a.temp));
// Who does the work the coordinator hands out itself (org.yaml's roles, agent ids): the review panel and the one who
// rules on its rounds, who builds fixes to how the company works and hears what goes wrong with it, and in whose name
// mail arrives. A role left out is the CEO's; no reviewers means the consolidator reads every change alone.
// And who reads what HQ otherwise hands only to the job working on it (server.ts). Left out, nobody does.
//
// - businessMail: mail to the company's business addresses (mail.ts business)
// - customerData: a customer's own details wherever HQ holds them: their mail, a call about them, a
//   customer card, and the report of a job that holds them (jobs.ts readsCustomerData)
// - customerMail: a customer's mail alone (server.ts mayReadMail), for whoever routes what comes in: their cards, calls
//   and other jobs' reports stay with customerData
// - orders: the order ids that open a customer's order on a product's site (hq orders)
// - finance: who hears of money swings on the live apps (money.ts)
// - triage: who triages every kind the daily error scan finds (triage.ts); left out, an app's owner and the process role
//   for Care's
// - asks: who sees that every ended call's items have work and close, except customer or keys calls (server.ts keepsAsks)
//   Left out, only the jobs working for a call
//   Left out, only the jobs working for a call
// - foundation: the foundation keeper, one more reader on a first round that touches the foundation's paths (reviewkeeper.ts
//   keeperSeat). Left out, there is no keeper
export function roles() {
  const r = optional('company/org.yaml').roles ?? {}, id = (v: unknown) => typeof v === 'string' && v ? v : ceo();
  const ids = (v: unknown) => (Array.isArray(v) ? v : []).filter((a: unknown) => typeof a === 'string') as string[];
  const consolidators = Array.isArray(r.consolidator) ? ids(r.consolidator) : [id(r.consolidator)];
  return { reviewers: ids(r.reviewers), consolidator: consolidators[0] ?? ceo(), consolidators, process: id(r.process), inbox: id(r.inbox), finance: id(r.finance),
    businessMail: ids(r.businessMail), customerData: ids(r.customerData), customerMail: ids(r.customerMail), orders: ids(r.orders),
    triage: r.triage as string | undefined, asks: r.asks as string | undefined,
    foundation: typeof r.foundation === 'string' && r.foundation ? r.foundation : undefined };
}
// Whether an agent's work needs what one of those roles reads
export type ReadingRole = 'businessMail' | 'customerData' | 'customerMail' | 'orders';
export const reads = (agent: string, role: ReadingRole) => roles()[role].includes(agent);
export { reviewSettings } from './reviewsettings.ts';
// The company's clock (clock.ts): the schedule's times, and the times briefs and alerts say.
export const timeZone = () => zoneOf(optional('company/org.yaml'));
// Money and days as the coordinator writes them (shared/format), in British English on the company's clock: a binding
// per clock and currency, as a payment carries its own and a day needs none.
// locales: another language's, for an email in it (shared/format's).
const bindings = new Map<string, ReturnType<typeof formats>>();
export function companyFormats(currency?: string, locales: Record<string, string> = { en: 'en-GB' }) {
  const zone = timeZone(), key = `${zone} ${currency ?? ''} ${JSON.stringify(locales)}`;
  return bindings.get(key) ?? bindings.set(key, formats({ locales, currency, timeZone: zone })).get(key)!;
}
// A time as alerts say it, on the company's clock: "8 Oct, 14:05"
export const companyTime = (ms: number) => {
  const f = companyFormats();
  return `${f.day(f.dayAt(ms), 'en', { short: true })}, ${f.time(ms, 'en')}`;
};
// A day on the company's clock, as YYYY-MM-DD
export const companyDay = (ms: number) => companyFormats().dayAt(ms);
// What the board sees things called, in the words the coordinator writes itself (push titles, its own pages, prompts):
// the brand's name and names over the foundation's defaults, the ones platform/hq/shell/brand.js has. A name reads as it
// does mid-sentence ("New in the newsletter"): cap() starts a sentence with it.
const NAMES = { name: 'Company', hq: 'HQ', os: 'Desktop', newsletter: 'the newsletter', phone: 'desk phone', intercom: 'intercom' };
export function names() {
  const b = brand(), plain = (v: unknown) => typeof v === 'string' && /^[^<>"]+$/.test(v) ? v : undefined;
  return Object.fromEntries(Object.entries(NAMES).map(([k, d]) => [k, plain(k === 'name' ? b.name : b.names?.[k]) ?? d])) as typeof NAMES;
}
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
// Who an agent is in a prompt: org.yaml's plain title, with its focus (what the title doesn't say) after it
export const titleOf = (a: { role?: unknown; focus?: unknown }, none = 'team member') => `${String(a.role ?? none)}${a.focus ? ` (${String(a.focus)})` : ''}`;
// Pocket TTS voices for platform/voice. org.yaml's voice overrides pronoun selection.
// Other pronouns, or none, return null for the line's default.
const PRONOUN_VOICES = new Map([['she', 'jane'], ['he', 'alba']]);
export function voiceOf(a: { voice?: string; pronouns?: string }): string | null {
  return a.voice ?? PRONOUN_VOICES.get((a.pronouns ?? '').trim().toLowerCase().split('/')[0]) ?? null;
}
// The company's names on its server and accounts (company/infra.env: KEY=value lines, never secrets); {} without one
export function infra(): Record<string, string> {
  try {
    return Object.fromEntries(readFileSync(`${REPO_DIR}/company/infra.env`, 'utf8').split('\n').map(l => l.trim())
      .filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  } catch { return {}; } // a checkout without one: nothing named
}
// (No department's work is marked for dealing with customers any more: a customer's details are kept where they came in,
// jobs.ts holdsCustomerData.)
export function frontmatter(src: string) {
  const m = src.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: src };
  try { return { meta: parse(m[1]) ?? {}, body: m[2] }; } catch { return { meta: {}, body: m[2] }; } // one bad note can't empty the Library
}

// What the Library would read cut from a document's frontmatter (the text between its --- lines), for the review
// (review.ts), from yaml's own document: frontmatter that doesn't parse, or parses into something parse() refuses (an
// unresolved alias: `title: *Bold*`), so frontmatter() reads none of it and the document shows with no title, author
// or date; and a top-level unquoted value with a comment on its own last line (an unquoted ' #' starts one, and the
// Library reads the value without it). Each names the key and, where it can, the line to write instead.
export function unreadable(text: string) {
  const doc = parseDocument(text);
  const pairs = isMap(doc.contents) ? doc.contents.items : [];
  const src = (n: unknown) => (n as Scalar | undefined)?.range;
  const key = (p: Pair) => { const r = src(p.key); return r ? text.slice(r[0], r[1]).slice(0, 80) : String(p.key).slice(0, 80); };
  // How to quote it: the line to write, the key as written and the whole value as a double-quoted string (JSON's escapes
  // are YAML's); one too long to repeat here gets the rule instead, never a line that drops part of the value.
  const fix = (p: Pair, value: string) => {
    const r = src(p.key), line = `${r ? text.slice(r[0], r[1]) : String(p.key)}: ${JSON.stringify(value.trim())}`;
    return line.length <= 300 ? `quote the value in double quotes: ${line}`
      : 'wrap the whole value in double quotes, words unchanged (a " inside becomes \\")';
  };
  // A value that starts on its key's line, up to the end of that line.
  const rest = (p: Pair) => {
    const k = src(p.key), v = src(p.value);
    if (!k || !v || text.slice(k[1], v[0]).includes('\n')) return undefined;
    const end = text.indexOf('\n', v[0]);
    return text.slice(v[0], end < 0 ? undefined : end);
  };
  const broken = (why: string, p?: Pair) => {
    const line = p && rest(p);
    return [line !== undefined
      ? `the frontmatter doesn't parse at \`${key(p!)}\` (${why}), so the Library reads none of it: no title, author or date. To fix it, ${fix(p!, line)}`
      : `the frontmatter doesn't parse (${why}), so the Library reads none of it: no title, author or date. Fix that line so it parses (a value with ": ", " #" or a leading * in it goes in double quotes).`];
  };
  if (doc.errors.length) {
    const e = doc.errors[0];
    // the top-level pair whose value the error is in
    return broken(e.message.split('\n')[0].replace(/:$/, '').replace(/ at line \d+, column \d+/, '$&, counting from the line after the first ---'),
      pairs.find(p => { const v = src(p.value); return v && v[0] <= e.pos[0] && e.pos[0] < v[2]; }));
  }
  try { doc.toJS(); }
  catch (e) { return broken(String((e as Error).message ?? e).split('\n')[0].slice(0, 200), pairs.find(p => isAlias(p.value))); }
  const out: string[] = [];
  for (const p of pairs) {
    const v = p.value;
    if (!isScalar(v) || v.type !== Scalar.PLAIN || v.comment === undefined || !v.range || !v.source) continue;
    // the comment's # on the value's last line (one on a line of its own below it is attached to the value too)
    const hash = text.indexOf('#', v.range[1]);
    if (hash < 0 || text.slice(v.range[1], hash).includes('\n')) continue;
    out.push(`\`${key(p)}\` is cut at the " #" that starts a YAML comment: the Library reads only ${JSON.stringify(v.source.slice(0, 300))}` +
      `${v.source.length > 300 ? '…' : ''}. If that's a comment, put it on a line of its own; if it's part of the value, ${fix(p, `${v.source} #${v.comment}`)}.`);
  }
  return out;
}

// Links and pictures in posts and notes.
// A post's or note's Markdown points at files next to it (a picture beside index.md: `![…](burst.jpg)`), but HQ shows
// it on its own page, at /, where `burst.jpg` would be fetched as /burst.jpg. So each relative link and picture starts
// at the site root instead, in the folder the server serves the document from (/knowledge/…), from marked's own tokens.
// A path from the root, a web or mail address, data: and an #anchor stay as written; so does every link of a document
// whose folder isn't served (the handbook's: `dir` null). So does one no URL can be made of (`https:` with no host): the
// browser makes nothing of it either, and the page still renders.
function located(href: string, dir: string) {
  if (!href || URL.canParse(href) || /^[/#?]/.test(href)) return href;
  const u = URL.parse(href, `http://hq/${dir}/`);
  return u ? u.pathname + u.search + u.hash : href;
}
export const render = (body: string, dir: string | null) => marked.parse(body, {
  walkTokens: dir ? t => { if (t.type === 'link' || t.type === 'image') t.href = located(t.href, dir); } : null }) as string;

// The files a post or note points at that HQ can't show, by their paths in `files`, for the review (review.ts): a picture,
// a sound or a link HQ would fetch from /knowledge/, resolved as HQ gets it, each with its line in the file. One that
// isn't in the repo, or whose kind the server doesn't serve (types.ts); a picture must be an image. A link to a note is
// fine: HQ opens it in the Library (news.js).
const NOTE = /^knowledge\/notes\/[^/]+\/(?!README\.md$)[^/]+\.md$/;
const SERVED = (kinds: RegExp) => Object.keys(TYPES).filter(e => kinds.test(TYPES[e])).join(', ');
export function missing(path: string, text: string, files: Set<string>) {
  const dir = path.slice(0, path.lastIndexOf('/')), body = frontmatter(text).body, out: string[] = [];
  let at = text.length - body.length;
  marked.walkTokens(marked.lexer(body), t => {
    if (t.type !== 'link' && t.type !== 'image') return;
    const found = text.indexOf(t.raw, at);   // tokens come in the text's order (a link's picture inside the link)
    if (found >= 0) at = found + 1;
    const href = located(t.href, dir);
    if (!href.startsWith('/knowledge/')) return;
    let file = new URL(href, 'http://hq').pathname.slice(1);
    try { file = decodeURIComponent(file); } catch { /* a stray %: the path as written */ }
    if (file.endsWith('/')) return;
    const picture = t.type === 'image', shown = picture ? 'a broken picture' : 'a dead link';
    const why = !files.has(file) ? `points at ${file}, which isn't in the repo, so HQ shows ${shown}. Add the file (a post's pictures sit ` +
        `next to its index.md, a note's in its topic's folder) or fix the path.`
      : (picture ? typeOf(file)?.startsWith('image/') : typeOf(file) || NOTE.test(file)) ? ''
      : `points at ${file}, a kind of file HQ doesn't ${picture ? 'show as a picture' : 'serve'}, so it shows ${shown}. ${picture
        ? `A picture loads as ${SERVED(/^image\//)}`
        : `A link opens a note (.md, in the Library) or one of ${SERVED(/./)}`} (any case).`;
    if (why) out.push(`${found >= 0 ? `line ${text.slice(0, found).split('\n').length}, ` : ''}\`${t.raw.slice(0, 200)}\` ${why}`);
  });
  return out;
}

// Newest first, by `published` (date and time), else the date in the slug.
// Covers are still pixel art (shared/covers); a post can carry a sound (`sound:`), played only when tapped.
export function gazette(): Post[] {
  const dir = `${REPO_DIR}/knowledge/posts`;
  return (existsSync(dir) ? readdirSync(dir) : []).filter(slug => existsSync(`${dir}/${slug}/index.md`)).map(slug => readOnce(`${dir}/${slug}/index.md`, text => {
    const { meta, body } = frontmatter(text);
    const url = (f?: string) => (f ? `/knowledge/posts/${slug}/${f}` : null);
    return {
      slug, title: meta.title, author: meta.author, date: slug.slice(0, 10), tags: meta.tags ?? [], board: meta.for === 'board', links: (meta.links ?? []).map((l: string) => `knowledge/${l}`),
      cover: /\.(png|svg|jpe?g|webp)$/i.test(meta.cover ?? '') ? url(meta.cover) : null, sound: url(meta.sound), html: render(body, `knowledge/posts/${slug}`), t: String(meta.published ?? slug.slice(0, 10)),
    };
  })).concat(feeds.flatMap(feed => feed())).sort((a, b) => b.t.localeCompare(a.t));
}
// Posts from HQ's own records beside those in files, as gazette gives them (a meeting's summary, with what its cover is
// drawn from: meetingchair.ts.).
type Post = Record<'slug' | 'title' | 'author' | 'date' | 'html' | 't', string> & { tags: string[]; board: boolean; links: string[]; cover: string | null; sound: string | null;
  meeting?: { people: string[]; pictures: string[] } };
const feeds: (() => Post[])[] = [];
export const feedFrom = (feed: (typeof feeds)[number]) => void feeds.push(feed);

// A file as HQ reads it, made again only when its text changes: rendering every note's Markdown takes most of a second,
// and the Library's every opening and the newsletter's watch each minute would redo it.
const readings = new Map<string, { text: string; reading: any }>();
export function readOnce<T>(file: string, read: (text: string) => T): T {
  const text = readFileSync(file, 'utf8'), known = readings.get(file);
  if (known?.text === text) return known.reading;
  const reading = read(text);
  readings.set(file, { text, reading });
  return reading;
}

// New newsletter posts arrive with a deploy. Each one is announced once: to HQ (a toast, and the unread count on the
// newspaper) and as a push notification (a newer one replaces the older, per feed). What's been announced is kept,
// so a restart doesn't announce it again; on the first run, everything already there counts as announced.
export function watchGazette() {
  const check = () => {
    const posts = gazette(), row = db.prepare("select value from settings where key = 'gazette.announced'").get() as { value: string } | undefined;
    const known = new Set<string>(row ? JSON.parse(row.value) : posts.map(p => p.slug));
    const fresh = posts.filter(p => !known.has(p.slug)).reverse();
    for (const p of fresh) {
      publish({ type: 'post', agent: p.author, text: p.title, state: p.board ? 'board' : undefined });
      sendToBoard({ title: p.board ? 'For the board 📰' : `New in ${names().newsletter} 📰`, body: String(p.title ?? '').slice(0, 200),
        tag: p.board ? 'gazette-board' : 'gazette', url: `/?open=gazette${p.board ? '&board=1' : ''}` }).catch(err => console.error('Could not announce the post:', err));
    }
    if (fresh.length || !row) db.prepare("insert into settings (key, value) values ('gazette.announced', ?) on conflict(key) do update set value = excluded.value")
      .run(JSON.stringify([...new Set([...known, ...posts.map(p => p.slug)])]));
  };
  try { check(); } catch (err) { console.error('Newsletter watch:', err); }
  setInterval(() => { try { check(); } catch (err) { console.error('Newsletter watch:', err); } }, 60_000);
}
