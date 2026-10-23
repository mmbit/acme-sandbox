// The care service's plug-in, its widget side: a working minimal example. The
// engine's widget reads it in the browser (/__care/company/plugin.js) and the care server at start (helper, langs,
// health, links). Every export is optional: a missing one is the engine's default. platform/care/public/widget.js says
// what each one does, and platform/care/README.md shows the whole plug-in. Plain data: no DOM, no imports but its
// neighbours, so both sides can load it.
import en from './health-en.js';

// the helper's name, in the header, About and every label ({helper} in the words)
export const helper = 'Pebble';
// the languages the widget and the server speak (the first is the fallback), and the widget's own words in them over
// the engine's English (platform/care/public/i18n.js has every key)
export const langs = ['en'];
export const words = {
  en: { ab_4: '<b>There’s no live chat with a person</b>, but a person reads and answers every email. That takes longer than this chat: we aim to reply within 2 working days.' },
};
// the health check's terms, one list per language: every message is checked against all of them
export const health = { en };
// the hosts the chat may link to besides the app's own: the company's own sites and its carriers' tracking pages
export const links = ['example.com', 'ups.com', 'fedex.com', 'usps.com', 'dhl.com'];
// Left out here, so the engine's defaults hold:
//   names       { tag, opener, link }: <care-chat>, [data-care] Help links, #care=<token> in the service's emails
//   avatar      ({ title }) => SVG markup: the helper's mark (the engine's: "AI" on the accent)
//   art         { order, box, label, flat, close, print, contents }: SVG drawings for the order picker and photo slots
//   stylesheet  'theme.css': a file in this folder loaded over the engine's chat.css (which says what it may set)
