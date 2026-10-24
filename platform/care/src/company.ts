// The company's part of the care service, plugged in. The engine is the same for
// every company; what's one company's (its helper's name and instructions, its words, its own tools and rules, its
// calendar, its model) comes from its plug-in folder, CARE_COMPANY_DIR (README.md, "The plug-in"), through `settings`.
// load() reads the folder once, before the service starts: server.ts does it first, and a test that runs a module
// without the server calls it itself. Nothing reads `settings` while a module loads, only when it runs, so the plug-in
// can import the engine's modules by their repo path (`../../../platform/care/src/db.ts`) without a cycle.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IncomingMessage } from 'node:http';
import type { ToolDef } from './model.ts';
import type { Session } from './session.ts';
import type { Ctx, Ask } from './person.ts';
import type { Widget, Out } from './engine.ts';

// the repo's root: the image lays the engine and the plug-in out as in the repo (/app/platform/care, /app/products/care)
const ROOT = new URL('../../..', import.meta.url).pathname;
export const DIR = resolve(ROOT, process.env.CARE_COMPANY_DIR || 'products/care');

// A tool of the company's own for the model. run() gets the device's session as it is now,
// already checked to be in this conversation. A result's `email`: an order of that email's went to the model (the
// conversation holds their data from then on), and `app`, the order's app (the conversation's spend and counts go by it,
// engine.ts about()); `done`: the answer ends with this tool; `speaks`: its words are all the server's (a card's, a
// start's), so the model's words of that round that haven't gone out are taken back, never what the tool wrote
// (helper.ts). log: the input's fields the tool log keeps for the eval (toollog.ts), never a note or anything typed.
export type ToolResult = { content: string; widget?: Widget; done?: boolean; speaks?: true; email?: string; app?: string };
export type Tool = { def: ToolDef; status?: string; log?: string[]; run: (c: Ctx, s: Session, input: any) => Promise<ToolResult> };
// A tool of the company's own for the phone (phone.ts): the call as it stands (its
// conversation, shop, the caller's language, and the one order a read-back code opened, if any) and the model's input.
// It answers data for the model; `done` ends the turn. Information only: nothing on the phone changes an order.
export type PhoneCall = { conversation: number; shop: string; lang: string; granted: { app: string; order: string } | null };
export type PhoneTool = { def: ToolDef; run: (p: PhoneCall, input: any) => Promise<{ content: string; done?: boolean }> };
// A tap on a button of the company's own (an action kind its tools put on a card): the action's id, what the card showed
// (args), and template(), for words from templates
export type Tap = (c: Ctx, key: string, args: any, template: (f: (o: Out) => unknown) => void) => void;

// the plug-in's mark for the helper (plugin.js `avatar`), for care's own status page; none: the page shows no mark
export let avatar: ((o?: { title?: string }) => string) | undefined;

const json = (s: string | undefined) => { try { return JSON.parse(s ?? '') ?? {}; } catch { return {}; } };

// why the helper is down: the AI service, the spending cap, or this chat stopped
export type Outage = 'service' | 'cap' | 'stop';

export const settings = {
  // ---- who answers, and in which languages (the widget's plugin.js: `helper`, `langs`; the first is the fallback)
  helper: 'Helper',
  langs: ['en'] as string[],
  // the fixed texts per language (texts.ts has English defaults for every key)
  texts: {} as Record<string, Record<string, string>>,
  // each app's own words over those, per language: its opening, what its chat can do (the plug-in's apps/<kb folder>.json)
  appWords: {} as Record<string, Record<string, Record<string, string>>>,
  locales: { en: 'en-GB' } as Record<string, string>, // the locale each language's dates are written in (else the language's own)
  // the instructions' long, stable part, which is cached: who the helper is and how it works, then the knowledge
  instructions: null as null | ((name: string, knowledge: string) => string),
  // entries of its own made from live data (what its shop sells today, say), in a language, after the kb's in every
  // conversation's knowledge, chat and phone alike (kb.ts); '' for none. Written the same way for the same data, so the
  // cached prefix changes only when the data does
  liveKnowledge: (_lang: string): string => '',
  // ---- the company, in the prompts that write for the board and the team (drafts.ts, answers.ts, inbox.ts)
  company: 'the company',
  shop: "{company}'s shop",                        // a shop of the company's, in a draft for a customer ({thing}: what it makes)
  about: '{company} sells through its shops ({shops}).', // who the company is, for HQ's email drafts
  partner: 'our partner, who makes and ships',     // the partner a claim goes to, in a claim's redraft ("<partner> <app>'s <thing>s")
  notToRepeat: '',                                 // a personalisation's detail no draft repeats beyond its title, if any
  // what a draft never argues away (drafts.ts rules()): the company's own remedy policy, in a clause
  remedy: 'a fault in what we made, or a parcel damaged or lost on its way, is for us to put right, as a person decides',
  // ---- the model, the apps' names and what each makes (the starting chip), the sender of the service's email
  model: process.env.CARE_MODEL || '',
  names: json(process.env.CARE_NAMES) as Record<string, string>,
  things: json(process.env.CARE_THINGS) as Record<string, string>,
  sender: 'Care <care@example.com>',
  // ---- days: the company's time zone (a day for the counts and the dates in emails) and its public holidays
  timeZone: 'UTC',
  holiday: (_day: string) => false,                // 'YYYY-MM-DD': a day offices close, besides the weekend
  // the busy notice (busy.ts): a season (its reason, or null), more than `waiting` emails waiting, or one older than
  // `days` working days; `aim`: the working days a person's reply takes, as the texts say ("we aim to reply within 3")
  busy: { season: (_t: number): string | null => null, waiting: Infinity, days: Infinity, aim: 3 },
  // ---- the way to a person (person.ts): off, every ask for a person and the ⋯ menu's "Email a person" get the email card
  // at once, and every outage message ends in "Email a person"; on, the chat never offers a person: a conversation's
  // first ask (while the helper can help), and the menu, get the chat's one case for trying here, with "Let's try here"
  // beside "Email a person"; only an insist, or a later ask, gets the card, and only `linkFor`'s outage messages end in
  // the link
  chatFirst: false,
  // with `chatFirst`, the asks whose first one gets the case: the model's reasons (person.ts REASONS), and 'menu' for the ⋯
  // menu's "Email a person"; any other, the email card at once (an insist always). A company whose case is only for a
  // plain ask in words: ['asked']
  caseFor: ['asked', 'complaint', 'dispute', 'no_photos', 'cant_help', 'menu'] as Ask[], // (no 'privacy': rights.ts)
  // with `chatFirst`, the outage causes whose message ends in "Email a person": 'service' (the AI service is down),
  // 'cap' (the spending cap), 'stop' (this chat stopped); any other, no link (the ⋯ menu still has one). A company whose
  // person is one tap away whatever the cause: all three
  linkFor: ['stop'] as Outage[],
  // ---- HQ's own drafts' share of the month's cap, in euros (ledger.ts; CARE_CAP_HQ_MONTH goes over it): the chats get
  // the rest. 0: no share of their own, everything shares the whole month
  hqMonth: 0,
  // ---- the phone (phone.ts): its own month in euros (CARE_CAP_PHONE_MONTH goes
  // over it; 0: the phone is off, and the line plays its recorded message), its instructions' part after `instructions`
  // ('' : the engine's own), and its own tools (none: the engine's only)
  phoneMonth: 0,
  phoneInstructions: '',
  phoneTools: [] as PhoneTool[],
  // the engine's own tools for the caller its line offers, by name (phonetools.ts: check_postcode, send_code,
  // order_status, email_answer, report_fault, ask_for_person, pass_on_feedback); null: all of them. [] for a line that
  // isn't for customers, with only its own phoneTools
  phoneCore: null as null | string[],
  // lines for the facts of a call, after the engine's own (none: '')
  phoneFacts: (_p: PhoneCall): string => '',
  // whether a run of digits a caller says is one of the company's order references (phonecode.ts readCode keeps it as
  // said, never takes it for a code); none: every run of five digits or more is a code or a number
  orderRef: (_digits: string) => false,
  // ---- the company's own tools and their parts (helper.ts, engine.ts, server.ts)
  tools: [] as Tool[],
  facts: (_c: Ctx): string => '',                  // lines for the facts of this conversation (how its own things stand)
  beforeAnswer: async (_c: Ctx): Promise<void> => {}, // before each answer (e.g. asks how what its tools started stands)
  taps: {} as Record<string, Tap>,
  checkWaits: (_c: Ctx): string => '',             // a tap of its own waits for a fresh code check (the model's note)...
  afterCheck: (_c: Ctx) => false,                  // ...and goes on once it's typed: true if one did
  deliveryStatus: null as null | ((order: any, now: number) => unknown), // the order tools' `delivery` beside an order
  resolved: (_app: string, _from: number, _to: number) => 0, // conversations its own tools resolved that day (numbers.ts)
  // a file of its own for this device (a link its tool put in the chat, GET /__care/api/file/<name>): its type, its name
  // and its bytes, or null for none (the plug-in checks the device may have it)
  files: async (_s: Session, _name: string): Promise<{ type: string; name: string; body: Buffer } | null> => null,
  // what its tools need of the visitor's own request (a cookie of the shop's, say): read from each of the widget's
  // requests, held in memory beside the device's session for the answer and the taps that follow (Ctx `visitor`), never
  // stored; {} for none
  visitor: (_req: IncomingMessage): Record<string, string> => ({}),
  start: () => {},                                 // its timers, once the service is up
  sweep: (_t: number) => {},                       // its retention, hourly with the engine's
};
export type Settings = typeof settings;

// The plug-in: `care.ts` (the server's part, all of it optional) and `public/plugin.js` (the widget's, which the server
// reads for the helper's name, the languages, the widget's words, the health terms and the hosts it may link to)
export async function load(dir = DIR) {
  const server = existsSync(join(dir, 'care.ts')) ? await import(pathToFileURL(join(dir, 'care.ts')).href) : {};
  const widget = existsSync(join(dir, 'public', 'plugin.js')) ? await import(pathToFileURL(join(dir, 'public', 'plugin.js')).href) : {};
  use({ ...pick(server), ...(widget.helper ? { helper: widget.helper } : {}), ...(Array.isArray(widget.langs) && widget.langs.length ? { langs: widget.langs } : {}), appWords: appWords(dir) });
  const health = await import('../public/health.js'), catalogue = await import('../public/catalogue.js'), i18n = await import('../public/i18n.js');
  i18n.use({ langs: widget.langs, words: widget.words, helper: widget.helper }); // the chat's labels the knowledge quotes (kb.ts)
  // always: the health check holds nothing until it has its lists, and refuses to run before (no lists: none held).
  // A plug-in without terms doesn't start, unless it says so on purpose (`health = false`): else health details would
  // reach the model, drafts and emails because of a missing file
  health.use(widget.health || {});
  if (widget.health !== false && !Object.values(health.LANG_TERMS ?? {}).some((l: any) => l.length))
    throw new Error('care: the plug-in gives no health terms (public/plugin.js `health`); export `health = false` to run without the health-detail check');
  catalogue.use({ links: widget.links, art: widget.art });
  avatar = typeof widget.avatar === 'function' ? widget.avatar : undefined;
}
// apps/<kb folder>.json, one per app: { "<lang>": { "<text key>": "words" } }
function appWords(dir: string) {
  const folder = join(dir, 'apps');
  if (!existsSync(folder)) return {};
  return Object.fromEntries(readdirSync(folder).filter(f => f.endsWith('.json')).map(f => [basename(f, '.json'), JSON.parse(readFileSync(join(folder, f), 'utf8'))]));
}
// the plug-in's exports that are settings (anything else it exports is its own)
const pick = (m: any) => Object.fromEntries(Object.keys(settings).filter(k => m[k] !== undefined).map(k => [k, m[k]]));

// What the environment says goes over the plug-in (a test, a local run): the model, and the apps' names and things
export function use(p: Partial<Settings>) {
  Object.assign(settings, p);
  if (p.busy) settings.busy = { season: () => null, waiting: Infinity, days: Infinity, aim: 3, ...p.busy };
  settings.model = process.env.CARE_MODEL || settings.model;
  settings.names = { ...settings.names, ...json(process.env.CARE_NAMES) };
  settings.things = { ...settings.things, ...json(process.env.CARE_THINGS) };
}

// an app's name and what it makes, for '<slug>' and '<slug>@preview' alike
export const base = (app: string) => app.replace(/@preview$/, '');
export const nameOf = (app: string) => settings.names[base(app)] ?? base(app);
export const thingOf = (app: string) => settings.things[base(app)] ?? 'order';
