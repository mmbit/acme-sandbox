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

// The two pages you see before you're logged in. The logo takes its own shape at 45 px high: the foundation's 15 px
// wordmark at 3x, whole pixels.
const shell = (title: string, script: string, b: any) => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<link rel="icon" href="/icon.svg"><link rel="manifest" href="/manifest.webmanifest">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1d1a2f;color:#f6e7c1;
font:18px/1.5 ui-monospace,monospace;text-align:center}button{font:inherit;background:#ffb86b;color:#1d1a2f;
border:0;padding:.8em 1.6em;box-shadow:0 4px 0 #c8553d;cursor:pointer}button:active{transform:translateY(4px);
box-shadow:none}#msg{min-height:1.5em;color:#ff8f8f}</style>
<main><h1><img src="/${darkLogo(b)}" alt="${word(b.logo?.alt) ?? ''}" height="45" style="vertical-align:-10px"> ${word(b.names?.hq) ?? 'HQ'}</h1><p id="msg"></p><button id="go">${title}</button></main>
<script src="/vendor/webauthn.js"></script><script>
const $ = s => document.querySelector(s), post = (u, b) => fetch(u, {method: 'POST',
  headers: {'content-type': 'application/json'}, body: JSON.stringify(b ?? {})});
${script}</script>`;

export const loginPage = (b: any = {}) => shell('Unlock', `
$('#go').onclick = async () => {
  try {
    const o = await post('/api/login/options');
    if (!o.ok) throw new Error('HQ is busy right now. Try again in a few minutes.');
    const opts = await o.json();
    const r = await post('/api/login/verify', await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: opts }));
    if (!r.ok) throw new Error('That passkey is not enrolled here.');
    location.href = '/';
  } catch (e) { $('#msg').textContent = e.message; }
};`, b);

export const enrollPage = (b: any = {}) => shell('Enroll this device', `
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
};`, b);

