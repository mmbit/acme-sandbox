// An email's text as HQ shows it, in Care and Mail alike: compact, escaped, and its web addresses as links, a long one
// shown short. The stored mail is unchanged.
import { esc } from '../util.js';

// An email's text as HTML. Everything else in it stays text.
export const emailHtml = t =>
  compact(t)
    .split(ADDRESS)
    .map((s, n) => (n % 2 ? link(s) : esc(s)))
    .join('');

// A mail's layout leaves runs of empty lines, and lines of only spacers (non-breaking and zero-width spaces), where its HTML
// had empty blocks: one empty line stands for each run.
export const compact = t =>
  String(t ?? '')
    .split('\n')
    .map(s => (/^[\u034f\s\u00ad\u180e\u200b-\u200f\u2060\ufeff]*$/.test(s) ? '' : s.trimEnd()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

// (the capture keeps the addresses in split's list, at the odd places)
const ADDRESS = /(https?:\/\/[^\s<>"\]]+)/;
const LONG = 60;
const link = address =>
  `<a href="${esc(address)}" target="_blank" rel="noopener noreferrer">${esc(address.length > LONG ? short(address) : address)}</a>`;

// A long address as its own host and the start of its path: auth.openai.com/u/…. A tracking link that wraps another
// address shows the tracker's host, as that's where the tap goes: nothing in it is decoded.
function short(address) {
  let url;
  try {
    url = new URL(address);
  } catch {
    return `${address.slice(0, LONG - 20)}…`;
  } // not a real address: its start
  const { host, pathname } = url,
    first = pathname.split('/')[1];
  return `${host}/${first && first.length <= 16 ? `${first}/` : ''}…`;
}
