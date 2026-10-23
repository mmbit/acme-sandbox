// Care's own preview host (care.preview.<zone>/, behind the preview login): a small status page the board opens from
// HQ's Apps tab and leaves notes on. What it shows is what the old status line said and nothing more: the service is up
// (it answered), the model's breaker, the busy notice. Nothing about any customer or conversation (house rule 7).
// Review mode is the template's tag: Caddy sends /__review/* to the coordinator, which gives the real tool to the board only.
// The helper's name and mark are the plug-in's (company.ts).
import { settings, avatar } from './company.ts';

// the page's own policy: its one script is review mode's (same origin), its style inline; review.js's screenshot draws
// the page into a canvas from a data: image, and its notes and voice clips go to /__review/ on this host
export const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; "
  + "connect-src 'self'; media-src 'self' blob:; base-uri 'none'; form-action 'none'";

// the company's own zone (settings.timeZone), named after the time: "14:05 CEST", "14:05 UTC"
const time = (t: number) => new Date(t).toLocaleTimeString('en-GB', { timeZone: settings.timeZone, hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function page({ model, busy, at = Date.now() }: { model: 'up' | 'down'; busy: boolean; at?: number }) {
  const helper = esc(settings.helper);
  const row = (name: string, ok: boolean, value: string, note: string) =>
    `<li class="${ok ? 'ok' : 'warn'}"><span class="dot" aria-hidden="true"></span><b>${name}</b><span class="v">${value}</span><small>${note}</small></li>`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Care (${helper}'s service)</title>
<script src="/__review/review.js" defer></script>
<style>
  /* the widget's neutral defaults and status colours (chat.css), the same in every app: no company's look */
  :root { --ink: #1f2430; --paper: #f6f7f9; --card: #fff; --line: color-mix(in srgb, var(--ink) 15%, transparent);
    --muted: color-mix(in srgb, var(--ink) 78%, var(--paper)); --ok: #5f9a45; --warn: #d58a12; --warn-ink: #6e4600; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 24px 16px 96px; background: var(--paper);
    color: var(--ink); font: 16px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif; -webkit-text-size-adjust: 100%; }
  main { width: min(100%, 26rem); }
  header { display: flex; align-items: center; gap: 14px; margin-bottom: 18px; }
  header svg { width: 56px; height: 56px; flex: none; border-radius: 50%; box-shadow: 0 2px 0 var(--line); }
  h1 { margin: 0; font: 600 1.35rem/1.2 Georgia, 'DejaVu Serif', serif; }
  header p { margin: 2px 0 0; color: var(--muted); font-size: .9rem; }
  ul { list-style: none; margin: 0; padding: 0; background: var(--card); border: 1px solid var(--line); border-radius: 14px; }
  li { display: grid; grid-template-columns: auto 1fr auto; align-items: center; column-gap: 10px; padding: 14px 16px; }
  li + li { border-top: 1px solid var(--line); }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 4px color-mix(in srgb, var(--ok) 18%, transparent); }
  .warn .dot { background: var(--warn); box-shadow: 0 0 0 4px color-mix(in srgb, var(--warn) 18%, transparent); }
  .v { font-weight: 600; }
  .warn .v { color: var(--warn-ink); }
  small { grid-column: 2 / -1; color: var(--muted); font-size: .85rem; }
  footer { margin-top: 14px; color: var(--muted); font-size: .8rem; text-align: center; }
</style>
<main>
  <header>${avatar?.() ?? ''}<div><h1>Care</h1><p>${helper}'s service: the support chat behind every app</p></div></header>
  <ul>
    ${row('Service', true, 'up', 'It answered this page.')}
    ${row('Model', model === 'up', model, model === 'up' ? 'No outage seen.' : 'What customers write waits, and is answered once it’s back.')}
    ${row('Busy notice', !busy, busy ? 'on' : 'off', busy ? `Where the chat says a person aims to reply within ${settings.busy.aim} working days, it adds that it may take longer.` : `The chat says a person aims to reply within ${settings.busy.aim} working days.`)}
  </ul>
  <footer>As of ${time(at)}. Reload for the latest.</footer>
</main>
</html>
`;
}
