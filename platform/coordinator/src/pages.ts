import { createHash } from 'node:crypto';
import { ORIGIN, PUBLIC_HOST, ZONE } from './config.ts';
import { publicOrigins } from './approvals.ts';

// HQ's Content-Security-Policy. The inline <script> and <style> blocks of a page (the pages below: fixed text, no data
// in them) are allowed by hash; HQ's own app has none. Style attributes stay allowed (HQ sets a few colours inline);
// they can't run script, and img-src limits what they can load (blob: for the desk phone's photo previews, which HQ's
// own script makes from the board's picked file). Fonts come from Google Fonts. Calls stream over a
// WebSocket to the voice line on HQ's own host (named too: older Safari doesn't count wss: as 'self'), and the viewer
// frames product previews, whose test checkout can step through HQ's own /pay/imitation/, and beside them the same page
// live at the product's public address.
export function csp(html = '') {
  const hashes = (tag: string) => [...html.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))]
    .map(m => ` 'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`).join('');
  return `default-src 'self'; script-src 'self'${hashes('script')}; style-src 'self' https://fonts.googleapis.com${hashes('style')}; ` +
    "style-src-attr 'unsafe-inline'; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self'; " +
    `connect-src 'self' ${ORIGIN.replace(/^http/, 'ws')}; frame-src 'self'${ZONE ? ` https://*.preview.${ZONE}` : ''}${publicOrigins().map(o => ` ${o}`).join('')}; ` +
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
}

// The test checkout (payments.ts, on HQ's host but no HQ page): no script at all, its one inline style block, and
// its Pay button returns to the product (any https shop; http only when running locally). The preview viewer may
// frame it, mid-checkout.
export const checkoutCsp = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'self'; " +
  `form-action 'self' https:${PUBLIC_HOST === 'localhost' ? ' http://localhost:*' : ''}`;

// ---- HQ's own pages, named by the company's brand (company/brand.yaml) before any script runs. What the brand doesn't
// say stays as the page has it: HQ's own words, the defaults platform/hq/shell/brand.js has too.

// A word from the brand, escaped for HTML (null when it says none). Only " < > need it: a lone & can't end an attribute
// or start a tag, and a font's URL is full of them.
const word = (v: unknown) => typeof v === 'string' ? v.replace(/["<>]/g, c => `&#${c.charCodeAt(0)};`) : null;

// The brand's logo for a dark ground: an .svg in HQ's folder (or the company's theme/hq/), as it's public (the login page shows it), and a path
// that isn't one could open something else to the logged out
export const darkLogo = (b: any) => typeof b.logo?.svgDark === 'string' && /^[\w-]+\.svg$/.test(b.logo.svgDark) ? b.logo.svgDark
  : 'wordmark-dark.svg';
// and on a light one (the guest page's: guests.ts), public the same way
export const logo = (b: any) => typeof b.logo?.svg === 'string' && /^[\w-]+\.svg$/.test(b.logo.svg) ? b.logo.svg : 'wordmark.svg';

// index.html's words and looks the brand replaces, each found by what's around it (the page's script names them all
// again at boot: shell/main.js)
const INDEX: [RegExp, (b: any) => unknown][] = [
  [/(?<=<meta name="theme-color" content=")[^"]*/, b => b.app?.themeColour],
  [/(?<=<meta name="apple-mobile-web-app-title" content=")[^"]*/, b => b.names?.hq],
  [/(?<=<meta name="description" content=")[^"]*/, b => b.app?.description],
  [/(?<=<title>)[^<]*/, b => b.app?.title],
  [/(?<=<div class="brand"><img src=")[^"]*/, b => b.logo?.svg],
  [/(?<=<div class="brand"><img src="[^"]*" alt=")[^"]*/, b => b.logo?.alt],
];
// The brand's font goes in before HQ's stylesheet, so its words never paint in the fallback face (index.html has none:
// each look's skin brings its own.)
export const hqIndex = (html: string, b: any) => {
  const named = INDEX.reduce((h, [at, value]) => {
    const w = word(value(b));
    return w === null ? h : h.replace(at, () => w);
  }, html);
  const font = word(b.font?.href);
  return font === null ? named : named.replace('<link rel="stylesheet" href="style.css">', at => `<link href="${font}" rel="stylesheet" data-brand-font>\n  ${at}`);
};

// The web app manifest: the home-screen name, and the colours of the splash screen and the title bar
export function hqManifest(json: string, b: any) {
  const m = JSON.parse(json), { title, description, themeColour } = b.app ?? {}, said = (v: unknown) => typeof v === 'string';
  if (said(title)) m.name = m.short_name = title;
  if (said(description)) m.description = description;
  if (said(b.colours?.ink)) m.background_color = b.colours.ink;
  if (said(themeColour)) m.theme_color = themeColour;
  return JSON.stringify(m, null, 2);
}

// The pages you see before you're logged in: the passkey's two, and a device code's (pair.ts). They wear HQ's look:
// the one this device picked (its hq.renderer, as stage.js keeps it), else the company's (`look`, theme/hq.yaml's
// renderer) where it picked none, each in its own type, colours and keys from its skin (renderers/<name>/skin.css), on
// one card. A pick it can't read (storage refused, a broken value) throws, never passing for none. A look this page
// doesn't know wears Slate's. The logo takes its own shape at 45 px high:
// the foundation's 15 px wordmark at 3x, whole pixels, the light one on a light card. `body` goes under the heading,
// with #msg for what went wrong; `scripts` runs the page.
const LOOK_FONTS = 'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400..800' +
  '&family=Pixelify+Sans:wght@400;600&family=Rajdhani:wght@500;600;700&display=swap';
const shell = (title: string, b: any, body: string, scripts: string, look = 'wire') => `<!doctype html>
<html lang="en" data-look="${word(look) ?? 'wire'}"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<link rel="icon" href="/icon.svg"><link rel="manifest" href="/manifest.webmanifest"><link rel="stylesheet" href="${LOOK_FONTS}">
<script>const l=JSON.parse(localStorage.getItem('hq.renderer'));if(l!==null)document.documentElement.dataset.look=l</script>
<style>:root{--ground:#ece6da;--card:#f7f3ec;--ink:#1d1b17;--muted:#5c554a;--key:#d6ea3c;--on-key:#1d1b17;--key-edge:0;
--lip:0 4px 0 #8f9f14;--field:#fff;--line:rgba(29,27,23,.16);--r:14px;--r-card:28px;--edge:0;--shadow:none;--alarm:#b3261e;
--font:'Bricolage Grotesque',system-ui,-apple-system,'Segoe UI',sans-serif;--head:800}
[data-look=brownstone]{--ground:#1d1a2f;--card:#fdf3e1;--ink:#1d1a2f;--muted:#6b6580;--key:#ffd966;--on-key:#1d1a2f;
--key-edge:2px solid #1d1a2f;--lip:3px 3px 0 #1d1a2f;--field:#fffaf0;--line:#1d1a2f;--r:4px;--r-card:6px;--edge:3px solid #1d1a2f;
--shadow:6px 6px 0 #0c0b16;--alarm:#c0392b;--font:'Pixelify Sans',ui-monospace,monospace;--head:600}
[data-look=holo]{--ground:#020c12 repeating-linear-gradient(0deg,rgba(110,225,255,.05) 0 1px,transparent 1px 3px);
--card:rgba(5,20,28,.84);--ink:#dcf8ff;--muted:#8cc0cf;--key:rgba(110,225,255,.18);--on-key:#dcf8ff;
--key-edge:1px solid rgba(110,225,255,.6);--lip:0 0 8px rgba(90,220,255,.35);--field:rgba(2,12,18,.6);--line:rgba(110,225,255,.5);
--r:3px;--r-card:6px;--edge:1px solid rgba(110,225,255,.5);--shadow:0 0 32px rgba(90,220,255,.22),inset 0 0 28px rgba(90,220,255,.07);
--alarm:#ff6b7a;--font:Rajdhani,'DejaVu Sans','Segoe UI',sans-serif;--head:700}
*{box-sizing:border-box}body{margin:0;min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:16px;
background:var(--ground);color:var(--ink);font:18px/1.5 var(--font);text-align:center;-webkit-font-smoothing:antialiased}
main{width:min(26rem,calc(100vw - 32px));padding:28px 24px 24px;background:var(--card);border:var(--edge);border-radius:var(--r-card);box-shadow:var(--shadow)}
h1{margin:0 0 18px;font-size:22px;font-weight:var(--head)}h1 img{height:45px;vertical-align:-12px}.night,[data-look=holo] .day{display:none}
[data-look=holo] .night{display:inline}h2{margin:0 0 10px;font-size:26px;line-height:1.2;font-weight:var(--head)}p{margin:0 0 18px;color:var(--muted)}
label{display:block;font-size:15px;font-weight:600}input{display:block;width:8em;margin:6px auto 18px;padding:8px;font:inherit;
font-size:28px;letter-spacing:.2em;text-align:center;color:var(--ink);background:var(--field);border:1.5px solid var(--line);border-radius:var(--r)}
input:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid var(--ink);outline-offset:3px}
button{width:100%;min-height:52px;padding:10px 20px;font:inherit;font-weight:var(--head);color:var(--on-key);background:var(--key);
border:var(--key-edge);border-radius:var(--r);box-shadow:var(--lip);cursor:pointer}button:active{transform:translateY(3px);box-shadow:none}
button:disabled{opacity:.6}a{display:inline-block;padding:10px 4px 0;color:var(--ink);font-size:15px}#msg{min-height:1.5em;margin:12px 0 0;color:var(--alarm)}#msg:empty{margin:0}</style>
<main><h1><img class="day" src="/${logo(b)}" alt="${word(b.logo?.alt) ?? ''}" height="45"><img class="night" src="/${darkLogo(b)}" alt="${word(b.logo?.alt) ?? ''}" height="45"> ${word(b.names?.hq) ?? 'HQ'}</h1>${body}</main>
${scripts}`;

// A passkey page: its one button, and its script inline
const passkey = (title: string, script: string, b: any, look?: string) => shell(title, b, `<p id="msg"></p><button id="go">${title}</button>`,
  `<script src="/vendor/webauthn.js"></script><script>
const $ = s => document.querySelector(s), post = (u, b) => fetch(u, {method: 'POST',
  headers: {'content-type': 'application/json'}, body: JSON.stringify(b ?? {})});
${script}</script>`, look);

export const loginPage = (b: any = {}, look?: string) => passkey('Unlock', `
$('#go').onclick = async () => {
  try {
    const o = await post('/api/login/options');
    if (!o.ok) throw new Error('HQ is busy right now. Try again in a few minutes.');
    const opts = await o.json();
    const r = await post('/api/login/verify', await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: opts }));
    if (!r.ok) throw new Error('That passkey is not enrolled here.');
    location.href = '/';
  } catch (e) { $('#msg').textContent = e.message; }
};`, b, look);

export const enrollPage = (b: any = {}, look?: string) => passkey('Enroll this device', `
const code = location.hash.slice(1);
$('#go').onclick = async () => {
  try {
    const o = await post('/api/enroll/options', { code });
    if (!o.ok) throw new Error('This link is not active yet, or it expired or was used. If you just created it, wait a minute and try again.');
    const r = await post('/api/enroll/verify', await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: await o.json() }));
    if (!r.ok) throw new Error('Enrollment failed. Run the workflow again for a fresh link.');
    history.replaceState(null, '', '/enroll');
    location.href = '/';
  } catch (e) { $('#msg').textContent = e.message; }
};`, b, look);


// Another of the board's devices signs in with a one-time code (pair.ts); its script is HQ's file (pairsignin.js)
export const pairPage = (b: any = {}, look?: string) => shell('Sign in on this device', b, `<h2>Sign in on this device</h2>
<p>On a device that’s signed in, open the Notebook’s Shelf and press Devices. Scan its square with this device’s camera,
or type the code it shows.</p>
<form><label for="code">One-time code</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code"
pattern="[0-9 ]{6,7}" maxlength="7" required autofocus><button>Sign in</button></form>
<p id="msg" role="alert"></p><a href="/login">Use a passkey instead</a>`, '<script type="module" src="/pair/signin.js"></script>', look);
