// The join link's page: an outside partner opens /join/<token>, types their name and joins a call with one of our
// agents, drawn on screen and alive while it listens, thinks and speaks (callouts.ts checks the token and serves what
// this makes). The call itself runs in the page's script (joinpage.js) over the voice line's /voice/join.
//   - Before anyone joins, the page names the agent as an AI all along ("Ada (AI) · Testco") and says we keep a
//     written transcript, never a recording, with a link to the privacy page (partner-calls.md §4).
//   - The agent's drawing is the company's own, theme/join/<agent id>.svg, its parts named by data-part (README in
//     joinfigure.js), or the platform's simple figure in the brand's colours. Never a realistic face.
//   - No cookies, no analytics, nothing from another site. The page keeps only the name typed, in sessionStorage, for a
//     rejoin.
//   - Words: the platform's below in English, Dutch and German, each overridable by brand.yaml's callsOut.join.<lang>.
//   - A walk-through (a link naming a shared preview, callouts.ts) says more before joining: that the agent sees our
//     pages and what's recorded (walkNotice, watch), with two buttons of equal weight, to join and show them or to join
//     without (the guest agrees to being recorded before it starts, and saying no costs them nothing). Joined, the
//     preview fills the page in a frame, the call minimised over it (joinwalk.js). The page's own parts are never
//     recorded: they sit in .own, marked data-watchalong-hide, and only the frame's page records itself.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ORIGIN, REPO_DIR } from './config.ts';
import { escapeHtml } from '../../../shared/html/escape.ts';
import { brand } from './company.ts';
import { inside } from './files.ts';
import { look, palette } from './guests.ts';
import { logo } from './pages.ts';

export type JoinLang = 'en' | 'nl' | 'de';
export type JoinView = {
  token: string;
  lang: JoinLang;
  agent: { id: string; name: string; pronouns?: string };
  company: string;
  words: Record<string, string> | undefined;
  privacy: string | null;
  until: string;
  opens?: string; // a call at a set time: the link works from a little before it
  // a walk-through: where its frame starts, the origins it may reach (the share's hosts), and what it shows
  walk?: { url: string; hosts: string[]; what: string };
};

// The longest name the call takes, in characters: room.py's NAME_LENGTH, worked out there (a real full name, and what
// it costs on every transcript line). The page says so when a typed name is longer. It never cuts one.
const NAME_LENGTH = 70;

// {agent} and {company} are filled in here, {time}, {length} and {most} by the page (the partner's own clock)
export const WORDS: Record<JoinLang, Record<string, string>> = {
  en: {
    plate: '{agent} (AI) · {company}',
    title: 'Join {agent} from {company}',
    notice: '{agent} is an AI assistant. We keep a written transcript of this call, never a recording.',
    privacyLink: 'How we handle it',
    name: 'Your name',
    nameHint: 'Everyone in the call sees it, and it’s in our transcript.',
    nameNeeded: 'Type your name first.',
    nameLong: 'Your name is {length} characters long, and the call takes {most} at most. A shorter form works.',
    mic: 'Your browser will ask to use your microphone.',
    join: 'Join the call',
    joining: 'Joining…',
    until: 'This link works until {time}.',
    opens: 'The call opens at {time}.',
    waiting: '{agent} will say hello in a moment.',
    people: 'In the call',
    you: 'you',
    ai: 'AI',
    captions: 'What {agent} says',
    listening: 'Listening',
    thinking: 'Thinking',
    speaking: 'Speaking',
    mute: 'Mute',
    unmute: 'Unmute',
    muted: 'Muted',
    leave: 'Leave',
    reconnecting: 'Reconnecting…',
    left: 'You left the call.',
    rejoin: 'Rejoin',
    ended: 'The call has ended. Thanks for talking with {agent}.',
    full: 'This call is full.',
    closed: 'This link has closed. Ask the person who sent it for a new one.',
    micDenied: 'The microphone didn’t start. Allow it in your browser’s settings, then try again.',
    dropped: 'The connection dropped. Try joining again.',
    // a walk-through's
    walkTitle: 'A walk-through of {what} with {agent} from {company}',
    walkNotice: '{agent} is an AI assistant. We keep a written transcript of this call, never its sound.',
    watch:
      '{agent} also sees our pages as you use them, never another tab or app. We record what’s on them, where you scroll, tap and draw, and that you type, never what. We keep it 90 days, to see where our pages are unclear and fix them. Pause stops it at any time.',
    show: 'Join and show our pages',
    noShow: 'Join without showing them',
    callWith: 'Call with {agent}',
    pause: 'Pause',
    resume: 'Resume',
    open: 'Open the call',
    pages: 'Back to the pages',
    watched: '{agent} sees this page',
    paused: 'Paused: {agent} doesn’t see this page',
  },
  nl: {
    plate: '{agent} (AI) · {company}',
    title: 'In gesprek met {agent} van {company}',
    notice: '{agent} is een AI-assistent. We houden een geschreven verslag van dit gesprek bij, nooit een opname.',
    privacyLink: 'Hoe we daarmee omgaan',
    name: 'Je naam',
    nameHint: 'Iedereen in het gesprek ziet hem, en hij staat in ons verslag.',
    nameNeeded: 'Vul eerst je naam in.',
    nameLong: 'Je naam is {length} tekens lang. Hier passen er hoogstens {most}. Een kortere vorm werkt.',
    mic: 'Je browser vraagt of hij je microfoon mag gebruiken.',
    join: 'Deelnemen',
    joining: 'Verbinden…',
    until: 'Deze link werkt tot {time}.',
    opens: 'Het gesprek opent om {time}.',
    waiting: '{agent} zegt zo hallo.',
    people: 'In het gesprek',
    you: 'jij',
    ai: 'AI',
    captions: 'Wat {agent} zegt',
    listening: 'Luistert',
    thinking: 'Denkt na',
    speaking: 'Praat',
    mute: 'Dempen',
    unmute: 'Microfoon aan',
    muted: 'Gedempt',
    leave: 'Verlaten',
    reconnecting: 'Opnieuw verbinden…',
    left: 'Je hebt het gesprek verlaten.',
    rejoin: 'Opnieuw deelnemen',
    ended: 'Het gesprek is afgelopen. Bedankt voor het gesprek met {agent}.',
    full: 'Dit gesprek is vol.',
    closed: 'Deze link werkt niet meer. Vraag wie hem stuurde om een nieuwe.',
    micDenied: 'De microfoon startte niet. Sta hem toe in de instellingen van je browser en probeer het opnieuw.',
    dropped: 'De verbinding viel weg. Probeer opnieuw deel te nemen.',
    // a walk-through's
    walkTitle: 'Een rondleiding door {what} met {agent} van {company}',
    walkNotice: '{agent} is een AI-assistent. We houden een geschreven verslag van dit gesprek bij, nooit het geluid.',
    watch:
      '{agent} ziet ook onze pagina’s terwijl je ze gebruikt, nooit een ander tabblad of andere app. We nemen op wat erop staat, waar je scrolt, tikt en tekent, en dat je typt, maar nooit wat. We bewaren het 90 dagen, om te zien waar onze pagina’s onduidelijk zijn en dat te verbeteren. Met Pauze stopt het meteen.',
    show: 'Deelnemen en onze pagina’s laten zien',
    noShow: 'Deelnemen zonder ze te laten zien',
    callWith: 'Gesprek met {agent}',
    pause: 'Pauze',
    resume: 'Verder',
    open: 'Gesprek openen',
    pages: 'Terug naar de pagina’s',
    watched: '{agent} ziet deze pagina',
    paused: 'Gepauzeerd: {agent} ziet deze pagina niet',
  },
  de: {
    plate: '{agent} (KI) · {company}',
    title: 'Gespräch mit {agent} von {company}',
    notice: '{agent} ist ein KI-Assistent. Wir führen ein schriftliches Protokoll dieses Gesprächs, nie eine Aufnahme.',
    privacyLink: 'So gehen wir damit um',
    name: 'Dein Name',
    nameHint: 'Alle im Gespräch sehen ihn, und er steht in unserem Protokoll.',
    nameNeeded: 'Gib zuerst deinen Namen ein.',
    nameLong: 'Dein Name hat {length} Zeichen. Hier passen höchstens {most}. Eine kürzere Form geht.',
    mic: 'Dein Browser fragt, ob er dein Mikrofon nutzen darf.',
    join: 'Beitreten',
    joining: 'Verbinden…',
    until: 'Dieser Link funktioniert bis {time}.',
    opens: 'Das Gespräch beginnt um {time}.',
    waiting: '{agent} begrüßt dich gleich.',
    people: 'Im Gespräch',
    you: 'du',
    ai: 'KI',
    captions: 'Was {agent} sagt',
    listening: 'Hört zu',
    thinking: 'Denkt nach',
    speaking: 'Spricht',
    mute: 'Stumm',
    unmute: 'Ton an',
    muted: 'Stumm',
    leave: 'Verlassen',
    reconnecting: 'Verbindung wird wiederhergestellt…',
    left: 'Du hast das Gespräch verlassen.',
    rejoin: 'Wieder beitreten',
    ended: 'Das Gespräch ist beendet. Danke für das Gespräch mit {agent}.',
    full: 'Dieses Gespräch ist voll.',
    closed: 'Dieser Link ist geschlossen. Frag die Person, die ihn geschickt hat, nach einem neuen.',
    micDenied:
      'Das Mikrofon ist nicht angegangen. Erlaube es in den Einstellungen deines Browsers und versuch es noch einmal.',
    dropped: 'Die Verbindung ist abgebrochen. Tritt noch einmal bei.',
    // a walk-through's
    walkTitle: 'Eine Führung durch {what} mit {agent} von {company}',
    walkNotice:
      '{agent} ist ein KI-Assistent. Wir führen ein schriftliches Protokoll dieses Gesprächs, nie eine Tonaufnahme.',
    watch:
      '{agent} sieht auch unsere Seiten, während du sie nutzt, nie einen anderen Tab oder eine andere App. Wir zeichnen auf, was darauf steht, wo du scrollst, tippst und zeichnest, und dass du etwas eingibst, aber nie was. Wir bewahren es 90 Tage auf, um zu sehen, wo unsere Seiten unklar sind, und sie zu verbessern. Mit Pause stoppt es sofort.',
    show: 'Beitreten und unsere Seiten zeigen',
    noShow: 'Beitreten, ohne sie zu zeigen',
    callWith: 'Gespräch mit {agent}',
    pause: 'Pause',
    resume: 'Weiter',
    open: 'Gespräch öffnen',
    pages: 'Zurück zu den Seiten',
    watched: '{agent} sieht diese Seite',
    paused: 'Pausiert: {agent} sieht diese Seite nicht',
  },
};

const CSS = readFileSync(new URL('./joinpage.css', import.meta.url), 'utf8');
// the page's script, the drawing's, and the call's audio with its microphone worklet (HQ's call screen's own: the same
// sound, and the same frames for the line). Served from the coordinator's image: the root .dockerignore lets each in
// (image.test.ts).
export const ASSETS: Record<string, URL> = {
  'join.js': new URL('./joinpage.js', import.meta.url),
  'figure.js': new URL('./joinfigure.js', import.meta.url),
  'people.js': new URL('./joinpeople.js', import.meta.url),
  'callaudio.js': new URL('../../hq/shell/callaudio.js', import.meta.url),
  'audiolevel.js': new URL('../../hq/shell/audiolevel.js', import.meta.url),
  'screenlock.js': new URL('../../hq/shell/screenlock.js', import.meta.url),
  'mic-worklet.js': new URL('../../hq/shell/mic-worklet.js', import.meta.url),
  // a walk-through's: the frame and the minimised call over it, HQ's own bubble, and the watch-along's recorder
  'walk.js': new URL('./joinwalk.js', import.meta.url),
  'callbubble.js': new URL('../../hq/shell/callbubble.js', import.meta.url),
  'floating.js': new URL('../../hq/shell/floating.js', import.meta.url),
  'watchalong.js': new URL('../../../shared/watchalong/watchalong.js', import.meta.url),
  'strokes.js': new URL('../../../shared/watchalong/strokes.js', import.meta.url),
  'vendor/rrweb-record.js': new URL('../node_modules/@rrweb/record/dist/record.js', import.meta.url), // (watchalong.ts RECORDER)
};

export function joinPage(view: JoinView): { html: string; csp: string } {
  const words = wordsFor(view),
    b = brand(),
    l = look();
  const css = `${palette(':root', l)}${l.fonts}:root{--glow:${hex(b.colours?.gold) ?? '#ffd966'};--font:${l.family}system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}\n${CSS}`;
  const src = l.logo ? `/guest/theme/${l.logo}` : `/${esc(logo(b))}`;
  const page = {
    lang: view.lang,
    until: view.until,
    opens: view.opens ?? null,
    agent: view.agent.name,
    nameLength: NAME_LENGTH,
    words,
    walk: !!view.walk,
  };
  const json = JSON.stringify(page).replace(/</g, '\\u003c');
  const html = `<!doctype html><html lang="${view.lang}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title data-watchalong-hide>${esc(words.plate)}</title>${l.favicon ? `<link rel="icon" href="/guest/theme/${l.favicon}">` : ''}
<style>${css}</style><script type="module" src="/join/assets/join.js"></script>
<body class="lobby"><div class="own" data-watchalong-hide><header class="top"><img class="logo${l.pixelated ? ' pixelated' : ''}" src="${src}" alt="${esc(b.logo?.alt ?? view.company)}"><p class="live" hidden><i></i><time>0:00</time></p></header>
<main>
<section class="stage">
<figure class="agent" data-ai-generated="true" data-participant="ai" data-state="idle">
<div class="drawing">${drawing(view.agent)}</div>
<div class="thought" aria-hidden="true"><i></i><i></i><i></i></div>
<figcaption class="plate"><span class="dot"></span>${esc(words.plate)}</figcaption>
</figure>
<p class="captions" data-ai-generated="true" aria-live="polite" aria-label="${esc(words.captions)}"></p>
</section>
<section class="side">
<div class="card lobbycard">
<h1>${esc(view.walk ? words.walkTitle : words.title)}</h1>
<p class="notice"><b class="badge">${esc(words.ai)}</b> <span>${esc(view.walk ? words.walkNotice : words.notice)}</span>${view.privacy ? ` <a href="${esc(view.privacy)}" target="_blank" rel="noopener noreferrer">${esc(words.privacyLink)}</a>` : ''}</p>${view.walk ? `\n<p class="notice watch">${esc(words.watch)}</p>` : ''}
<form class="joinform" novalidate>
<label for="name">${esc(words.name)}</label>
<input id="name" name="name" autocomplete="name" required>
<p class="hint">${esc(words.nameHint)}</p>
${joinButtons(view, words)}
<p class="error" role="alert" hidden></p>
<p class="small">${esc(words.mic)} <span class="until"></span></p>
</form>
</div>
<div class="card room" hidden>
<h2>${esc(words.people)} <span class="count"></span></h2>
<ul class="people"></ul>
<p class="waiting">${esc(words.waiting)}</p>
</div>
<div class="card over" hidden><p class="said"></p><button type="button" class="rejoin">${esc(words.rejoin)}</button></div>
</section>
</main>
<nav class="controls" hidden><button type="button" class="mute" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path class="on" d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3"/><path class="off" d="M4 4l16 16"/></svg><span>${esc(words.mute)}</span></button><button type="button" class="leave"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 14c5-5 13-5 18 0l-2.5 2.5-3.5-2v-2.6a10 10 0 0 0-6 0v2.6l-3.5 2z"/></svg><span>${esc(words.leave)}</span></button>${view.walk ? PAGES_BUTTON.replaceAll('{pages}', esc(words.pages)) : ''}</nav>
<p class="reconnecting" role="status" hidden>${esc(words.reconnecting)}</p>
<script type="application/json" id="join-page">${json}</script></div>
${view.walk ? `<iframe class="walk" data-src="${esc(view.walk.url)}" title="${esc(view.walk.what)}"></iframe>` : ''}
</body></html>`;
  const hash = createHash('sha256').update(css).digest('base64');
  // the voice line is on the page's own host; named too, as older Safari doesn't count wss: as 'self'
  // a walk-through's frame: the share's hosts, and HQ's own for the sign-in it passes through on the way (preview.ts).
  // The recorder compares a changed style attribute in a scratch document of this page's, under this policy (this page
  // puts no outside markup anywhere).
  const walk = view.walk ? `; frame-src 'self' ${view.walk.hosts.join(' ')}; style-src-attr 'unsafe-inline'` : '';
  const csp = `default-src 'none'; script-src 'self'; style-src 'sha256-${hash}'; img-src 'self'; font-src 'self'; connect-src 'self' ${ORIGIN.replace(/^http/, 'ws')}; media-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'${walk}`;
  return { html, csp };
}

// Join, or on a walk-through the two of equal weight: to show our pages, or not (the same class, so the same look).
// A disabled button ahead of them is the form's default, so Enter in the name field chooses neither.
const joinButtons = (view: JoinView, words: Record<string, string>) =>
  view.walk
    ? `<button type="submit" hidden disabled aria-hidden="true"></button><button type="submit" class="join" value="show">${esc(words.show)}</button><button type="submit" class="join" value="">${esc(words.noShow)}</button>`
    : `<button type="submit" class="join">${esc(words.join)}</button>`;
const PAGES_BUTTON = `<button type="button" class="pages" aria-label="{pages}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><rect class="fill" x="11.5" y="11.5" width="7" height="5.5" rx="1.2"/></svg><span>{pages}</span></button>`;

export function joinAsset(name: string): { type: string; body: string } | null {
  const file = Object.hasOwn(ASSETS, name) ? ASSETS[name] : null;
  return file ? { type: 'text/javascript; charset=utf-8', body: readFileSync(file, 'utf8') } : null;
}

// the platform's words, the company's over them (only strings, short), with the agent and company filled in
function wordsFor(view: JoinView) {
  const own = Object.fromEntries(
    Object.entries(view.words ?? {}).filter(
      ([k, v]) => Object.hasOwn(WORDS.en, k) && typeof v === 'string' && v.length <= 300,
    ),
  );
  const merged = { ...WORDS[view.lang], ...own };
  return Object.fromEntries(
    Object.entries(merged).map(([k, v]) => [
      k,
      v
        .replaceAll('{agent}', view.agent.name)
        .replaceAll('{company}', view.company)
        .replaceAll('{what}', view.walk?.what ?? ''),
    ]),
  );
}

// ---- the drawing
// The company's own drawing of the agent, or the platform's figure. Ours is trusted (it's in the repo), but one that
// could run script or load something falls back too: the page's CSP would block it anyway, and broken is worse.
const DRAWINGS = `${REPO_DIR}/theme/join`;
const UNSAFE = /<script|<foreignObject|\son\w+\s*=|\shref\s*=\s*["'](?!#)|\sstyle\s*=/i;
function drawing(agent: JoinView['agent']) {
  const found = /^[a-z0-9-]{1,40}$/.test(agent.id) ? inside(DRAWINGS, `${agent.id}.svg`, REPO_DIR) : null;
  const svg = found ? readFileSync(found.real, 'utf8').replace(/^<\?xml[^>]*>\s*/, '') : '';
  return svg.startsWith('<svg') && !UNSAFE.test(svg) ? svg : figure(agent.name);
}

// A friendly round figure with a little light on top that glows while it speaks, in the brand's colours.
function figure(name: string) {
  const c = brand().colours ?? {},
    g = brand().guest?.colours ?? {};
  const body = hex(c.blue) ?? '#5b8def',
    ink = hex(g.ink) ?? hex(c.ink) ?? '#1b2130';
  const face = mix(body, '#ffffff', 0.78),
    cheek = hex(c.red) ?? '#e8505b',
    glow = hex(c.gold) ?? '#ffd966';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" role="img" aria-label="${esc(name)}, drawn"><g data-part="figure" stroke="${ink}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
<g data-part="body"><path fill="${body}" d="M84 420C84 330 136 282 200 282C264 282 316 330 316 420Z"/><path fill="none" stroke-opacity=".35" d="M150 330C170 342 230 342 250 330"/></g>
<g data-part="head"><path fill="none" d="M200 98V70"/><circle data-part="light" cx="200" cy="60" r="11" fill="${glow}"/>
<rect x="104" y="98" width="192" height="170" rx="85" fill="${face}"/>
<g fill="${cheek}" stroke="none" opacity=".45"><ellipse cx="146" cy="210" rx="16" ry="9"/><ellipse cx="254" cy="210" rx="16" ry="9"/></g>
<g data-part="brows" fill="none" stroke-width="5"><path d="M148 140C156 134 168 134 176 138"/><path d="M224 138C232 134 244 134 252 140"/></g>
<g data-part="eyes" stroke="none"><g data-part="pupils" fill="${ink}"><ellipse cx="162" cy="174" rx="10" ry="13"/><ellipse cx="238" cy="174" rx="10" ry="13"/><circle cx="166" cy="168" r="3.5" fill="#fff"/><circle cx="242" cy="168" r="3.5" fill="#fff"/></g></g>
<g data-part="mouth"><path data-part="mouth-shut" fill="none" d="M184 218C194 228 206 228 216 218"/><g data-part="mouth-open"><path fill="${mix(ink, '#c0304a', 0.5)}" stroke-width="3.5" d="M183 215C194 212 206 212 217 215C217 232 209 240 200 240C191 240 183 232 183 215Z"/></g></g>
</g></g></svg>`;
}

const hex = (v: unknown) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : null);
// a colour part of the way to another (0: the first, 1: the second)
const mix = (from: string, to: string, part: number) =>
  '#' +
  [1, 3, 5]
    .map(i => Math.round(parseInt(from.slice(i, i + 2), 16) * (1 - part) + parseInt(to.slice(i, i + 2), 16) * part))
    .map(n => n.toString(16).padStart(2, '0'))
    .join('');
const esc = (value: unknown) => escapeHtml(String(value ?? ''));
