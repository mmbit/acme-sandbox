// An agent's words as HQ shows them: a call's notes, the intercom's replies, a job's report, a card's details. Agents
// write a little Markdown (paragraphs, lists, bold, links, pictures), and HQ shows it as such in every one of those
// places, from this one renderer. Anything else in the text stays text.
import { esc, jobName } from '../util.js';

// The text as HTML blocks: paragraphs, bulleted and numbered lists, a heading as a bold line, a table, and a fenced block
// (``` lines) as a block of text kept exactly. A wrapped line goes on with the one before it, as Markdown joins them: in a
// paragraph, and in a list item (an indented line, or any line straight after it). A line break stays only where the
// writer meant one, at a line ending in two spaces or a backslash, or at every
// line with `breaks` (what someone typed in a chat box). Each run of words goes through `span`: links, bold, italics,
// code and pictures by default; the desk phone passes its own, with bare links and copy buttons too. (Fenced blocks)
export function prose(text, span = strong, { breaks = false } = {}) {
  const blocks = [];
  let open = null;   // the paragraph or list the next line can go on
  let fence = null;   // the fenced block being read, and its opening line's indent (taken off each line in it)
  // a line onto the runs of a paragraph or an item: on the last run, unless that one broke or `apart`
  const onto = (runs, raw, apart = false) => {
    const words = raw.trim();
    if (open.slash && !apart) runs.push(runs.pop().slice(0, -1).trimEnd());
    if (open.broke || apart || !runs.length) runs.push(words); else runs.push(`${runs.pop()} ${words}`);
    open.broke = breaks || HARD_BREAK.test(raw); open.slash = !breaks && /\\$/.test(raw); open.gap = false;
  };
  const all = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const tables = tableParts(all);
  for (const [i, raw] of all.entries()) {
    if (tables[i] === 'dashes') continue;
    const line = raw.trim(), item = raw.match(ITEM);
    if (fence) { if (FENCE.test(line)) fence = null; else fence.lines.push(raw.replace(fence.indent, '')); continue; }
    if (FENCE.test(line)) { blocks.push(fence = { tag: 'pre', lines: [], indent: new RegExp(`^ {0,${raw.search(/\S/)}}`) }); open = null; continue; }
    if (!line || RULE.test(line)) { if (open?.tag === 'p' || open?.tag === 'table' || line) open = null; else if (open) open.gap = true; continue; }   // (a list goes on past an empty line)
    // A table, as tableParts reads it
    if (tables[i] === 'row') { open.rows.push(cellsOf(line)); continue; }
    if (open?.tag === 'table') open = null;
    if (tables[i] === 'head') { blocks.push(open = { tag: 'table', head: cellsOf(line), align: alignOf(all[i + 1]), rows: [] }); continue; }
    if (HEADING.test(line)) { blocks.push({ tag: 'h', lines: [line.replace(HEADING, '')] }); open = null; }
    else if (item) {
      const words = raw.slice(item[0].length);
      if (!words.trim()) continue;   // (a bullet with nothing after it)
      const tag = /\d/.test(item[1]) ? 'ol' : 'ul';
      if (open?.tag !== tag) blocks.push(open = { tag, start: parseInt(item[1], 10), items: [] });
      open.items.push([]); open.broke = open.slash = false;
      onto(open.items.at(-1), words);
    } else if (open?.items && (/^\s/.test(raw) || !open.gap)) onto(open.items.at(-1), raw, open.gap);   // (past an empty line, on a line of its own)
    else {
      if (open?.tag !== 'p') blocks.push(open = { tag: 'p', lines: [] });
      onto(open.lines, raw);
    }
  }
  const lines = l => l.map(span).join('<br>');
  // (the cells a row has, up to the head's: no padding, so a wide head over short rows stays as long as its text)
  const cells = (tag, row, align) => row.slice(0, align.length).map((c, i) => `<${tag}${align[i] ? ` class="${align[i]}"` : ''}>${span(c)}</${tag}>`).join('');
  const table = b => `<div class="table"><table><thead><tr>${cells('th', b.head, b.align)}</tr></thead>`
    + `<tbody>${b.rows.map(r => `<tr>${cells('td', r, b.align)}</tr>`).join('')}</tbody></table></div>`;
  return blocks.map(b => b.tag === 'table' ? table(b) : b.tag === 'pre' ? `<pre><code>${esc(b.lines.join('\n'))}</code></pre>`
    : b.tag === 'p' ? `<p>${lines(b.lines)}</p>` : b.tag === 'h' ? `<p><b>${lines(b.lines)}</b></p>`
    : `<${b.tag}${b.tag === 'ol' && b.start > 1 ? ` start="${b.start}"` : ''}>${b.items.map(i => `<li>${lines(i)}</li>`).join('')}</${b.tag}>`).join('');
}

// (links)
// One line's words: `code` as it is, [links](https://…) and bare https://… addresses, ![a picture](/its/path), **bold**
// and *italics* around and in them, the rest escaped with its job numbers linked. A link's own text gets no second link.
export const strong = t => {
  const words = jobsIn(String(t));
  return runs(t, s => linked(s, w => pictured(w, x => bare(x, words)), label));
};
const label = t => runs(t, esc);
const runs = (t, words) => String(t).split(/`([^`]+)`/).map((s, i) => i % 2 ? `<code>${esc(s)}</code>`
  : words(s).replace(BOLD, '<b>$1</b>').replace(/(^|[\s(])\*(?=\S)([^*]+?)\*(?=$|[\s).,;:!?])/g, '$1<i>$2</i>')).join('');
// A picture HQ serves itself (a path on its own host), as HQ's page loads no other: an address elsewhere stays text. Its
// address and words carry no `*`, as bold and italics go over the line after.
const PICTURE = /!\[([^\]]*)\]\(\s*(\S+?)\s*\)/;
const pictured = (s, text = esc) => s.split(PICTURE).map((p, j, all) => j % 3 === 0 ? text(p) : j % 3 === 2 ? picture(all[j - 1], p) : '').join('');
const unstarred = s => esc(s).replace(/\*/g, '&#42;');
const picture = (alt, src) => ownHost(src) ? `<img src="${unstarred(src)}" alt="${unstarred(alt)}" loading="lazy">` : esc(`![${alt}](${src})`);
// (new URL, as URL.parse is Safari 18's and HQ runs from iOS 16.4: an address it can't read is no picture)
const ownHost = src => { try { return new URL(src, location.href).origin === location.origin; } catch { return false; } };

// A Markdown link, [text](address), as a link with that text, opening in a new tab: http and https only (anything else
// stays as written). `words` renders the text around the links and, unless `label` is given, inside them (where a bare
// address or a document's name mustn't become a second link). Bold and italics go over the result after: no `*` gets
// into an address, so they never land inside a tag. A picture's ![…](…) is no link (pictured).
const LINK = /(?<!!)\[([^[\]\n]+)\]\((https?:\/\/(?:[^\s()<>"]|\([^\s()<>"]*\))+)\)/;
export const linked = (t, words, label = words) => String(t).split(LINK)
  .map((s, i, all) => i % 3 === 0 ? words(s) : i % 3 === 1 ? link(all[i + 1], label(s)) : '').join('');
export const link = (url, html) => `<a href="${esc(url).replace(/\*/g, '%2A')}" target="_blank" rel="noopener">${html} ↗</a>`;
// A bare address, https://www.example.com/a/, as a link showing example.com/a; `words` renders the text around it. The
// punctuation after it (a full stop, a closing bracket, bold's `**`) stays out, and one level of brackets stays in.
const ADDRESS = /(https?:\/\/(?:[^\s()<>"]|\([^\s()<>"]*\))*(?:[^\s()<>"'.,;:!?*]|\([^\s()<>"]*\)))/;
export const bare = (t, words) => String(t).split(ADDRESS).map((s, i) => i % 2
  ? link(s, esc(s.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')).replace(/\*/g, '&#42;')) : words(s)).join('');
export const BOLD = /\*\*(.+?)\*\*/g;

export const ITEM = /^\s*([-*+•]|\d+[.)])\s+/;
const HEADING = /^#{1,6}\s+/;
// A table's row as its cells: the pipes at its ends dropped, a \| kept as a pipe in its cell
const cellsOf = line => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
// A table's line of dashes as each column's alignment ('', 'left', 'center' or 'right'), or null for any other line
const alignOf = line => {
  if (!line?.includes('|')) return null;
  const marks = cellsOf(line);
  return marks.every(m => /^:?-+:?$/.test(m)) ? marks.map(m => m.endsWith(':') ? (m.startsWith(':') ? 'center' : 'right') : m.startsWith(':') ? 'left' : '') : null;
};
// Each of a text's lines as its part in a table, 'head', 'dashes' or 'row' (undefined outside one): a head is a line with
// a pipe over a line of dashes as many cells wide (which aligns its columns), its rows the lines with a pipe after, up
// to any other line, outside fenced blocks. Leading pipes are optional. prose() shows these tables, and the desk phone
// keeps their lines apart and whole by them.
export function tableParts(lines) {
  const parts = [];
  let fenced = false,
    open = false;
  lines.forEach((raw, i) => {
    const line = raw.trim(),
      fence = FENCE.test(line);
    if (fence) fenced = !fenced;
    if (parts[i] === 'dashes') return;
    if (fence || fenced) open = false;
    else if (open && line.includes('|')) parts[i] = 'row';
    else {
      open = line.includes('|') && alignOf(lines[i + 1])?.length === cellsOf(line).length;
      if (open) [parts[i], parts[i + 1]] = ['head', 'dashes'];
    }
  });
  return parts;
}
const RULE = /^([-*_])(\s*\1){2,}$/;   // --- between parts: the gap is enough
export const FENCE = /^```/;
const HARD_BREAK = /( {2}|\\)$/;

// Each line with its fence state, so text to paste survives transformations unchanged.
export function fencedLines(text) {
  let fenced = false;
  return text.split('\n').map(line => {
    const fence = FENCE.test(line.trim());
    if (fence) fenced = !fenced;
    return { line, fence, fenced };
  });
}

// ---- job links

// Text escaped, each job number in it a link to that job (main.js opens it in the projects view; a middle-click, a new
// HQ). A number is a job's unless the word just before it names another kind of thing HQ numbers: "card #89", "PR
// #785", "call #58", "cards #95 and #96" stay text, while "job #12", "task #12", "Handed to Ansel (#12)", "since #12"
// and "#12's fix" are jobs'. A list carries its kind across punctuation and separators. Markdown's * and ` around
// either don't hide it. Only text[from, to) is returned, read after the words before it (a number cut at either end
// stays text).
export function withJobLinks(text, from = 0, to) {
  text = String(text ?? '');
  const end = to ?? text.length;
  let html = '', at = from, previousEnd = 0, isJob = true;
  for (const m of text.matchAll(JOB_REF)) {
    if (m.index + m[0].length > end) break;   // (a number cut off at the end isn't that job's)
    const gap = text.slice(previousEnd, m.index).replace(/[*`]/g, '');
    if (!previousEnd || !REFERENCE_GAP.test(gap)) {
      const words = gap.replace(/[(:\s]+$/, ''), word = words.match(LAST_WORD)?.[1];
      isJob = !(word && OTHER_KIND.test(word)) && !OTHER_PHRASE.test(words);
    }
    previousEnd = m.index + m[0].length;
    if (m.index < from) continue;
    html += esc(text.slice(at, m.index)) + (isJob ? jobLink(m[1]) : esc(m[0]));
    at = previousEnd;
  }
  return html + esc(text.slice(at, end));
}
// A link to a job: its words as HTML, its number unless given
export const jobLink = (id, html = `#${Number(id)}`) =>
  `<a class="job-link" href="/?open=jobs&amp;job=${Number(id)}" data-job="${Number(id)}">${html}</a>`;
// A job HQ names itself (util.js jobName: its code, else its number), as a link to it
export const jobNameLink = (id, code) => jobLink(id, esc(jobName(id, code)));
// The words of one line, run by run, each read after the whole line's words before it (code, links and all), so "cards
// `#95` and #96" stays cards'. Every run is a piece of the line, in order.
export const jobsIn = line => {
  let read = 0;
  return run => {
    const from = line.indexOf(run, read);
    read = from + run.length;
    return withJobLinks(line, from, read);
  };
};

// A tap target whose words hold job links (a card's title in a list, a toast, a Care row): a link can't go in a button,
// so the words sit in a box (`look`: its classes) beside the button (`action`: its attributes; `name`: what it reads as),
// which style.css stretches over the box, under each link. A tap off a link is the button's.
export const covered = (look, action, name, words) =>
  `<div class="covered ${look}"><button type="button" class="cover" ${action} aria-label="${esc(name)}"></button>${words}</div>`;

// The same in a document HQ shows as HTML (the Library's): its text outside links and code, each piece read after the
// words before it in its block, so "Card <b>#89</b>" stays a card's
export function linkJobsIn(root) {
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), hits = [];
  while (walk.nextNode()) if (!walk.currentNode.parentElement.closest('a, code, pre') && /#\d/.test(walk.currentNode.data)) hits.push(walk.currentNode);
  for (const node of hits) {
    const block = node.parentElement.closest(BLOCK), range = document.createRange();
    range.setStart(block && root.contains(block) ? block : root, 0);
    range.setEnd(node, 0);
    const before = range.toString(), html = withJobLinks(before + node.data, before.length);
    if (!html.includes('data-job')) continue;
    const t = document.createElement('template');
    t.innerHTML = html;
    node.replaceWith(t.content);
  }
}
export const BLOCK = 'p, li, dt, dd, td, th, h1, h2, h3, h4, h5, h6, blockquote, figcaption';

const JOB_REF = /(?<![\w&/#])#([1-9]\d*)\b/g;   // (not "&#39;", an address's "/#12" or "##")
// A list carries its kind across punctuation and separators, with each gap read once.
const REFERENCE_GAP = /^(?:['’]s)?(?:\s|[,;/&–—():-]|\b(?:and|or|to)\b)*$/i;
const LAST_WORD = /([\p{L}\p{N}'’]+)\s*$/u;
// the words before a number that make it another kind's than a job's: the things HQ and its agents number (desk-phone
// cards, pull requests, calls and their items, requests, mails and drafts, pictures, review findings, proposals and the
// inbox, notes, pins, messages, meetings and their asks, decisions, helper runs, tester shares, spare parts,
// questions, posts) and what the world numbers (issues, tickets, orders, invoices, colours, a machine's process ids)
const OTHER_KIND = /^(?:cards?|prs?|requests?|calls?|items?|e?mails?|drafts?|pictures?|photos?|findings?|proposals?|inbox|notes?|pins?|messages?|msgs?|meetings?|asks?|decisions?|runs?|shares?|parts?|questions?|posts?|issues?|tickets?|orders?|invoices?|colou?rs?|pids?)$/i;
// and the two words that do where either alone doesn't: an "hq say" message (not "let's say #12") and the worker's
// "stopped process #48213" (worker.ts; a department's "Process #12" is a job's)
const OTHER_PHRASE = /\b(?:hq\s+say|stopped\s+process)$/i;
