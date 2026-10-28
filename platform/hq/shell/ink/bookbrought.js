// What a paste or a drop brings the book, read as one thing to land: pictures (files), a picture at an address (an <img>
// dragged from a web page), a link, words (plain text, or a page's HTML made plain text), or files of another kind,
// refused. booktape.js lands it.
import { tidy } from './bookwords.js';

const IMAGE = /^image\//;
const WEB = /^https?:\/\/\S+$/i;

// What a DataTransfer carries (a paste's clipboardData, a drop's dataTransfer: read while its event lasts)
export const carried = dt => ({
  files: [...(dt?.files ?? [])],
  html: dt?.getData('text/html') ?? '',
  uris: dt?.getData('text/uri-list') ?? '',
  text: dt?.getData('text/plain') ?? '',
});
// What the clipboard holds, read when asked (the touch Paste bubble): its items' pictures, HTML and words. A browser
// without read() (or one that refuses it) gives its words only.
export async function clipboard() {
  const got = { files: [], html: '', uris: '', text: '' };
  if (!navigator.clipboard.read) return { ...got, text: await navigator.clipboard.readText() };
  for (const item of await navigator.clipboard.read())
    for (const type of item.types) {
      const blob = await item.getType(type);
      if (IMAGE.test(type)) got.files.push(blob);
      else if (type === 'text/html') got.html ||= await blob.text();
      else if (type === 'text/uri-list') got.uris ||= await blob.text();
      else if (type === 'text/plain') got.text ||= await blob.text();
    }
  return got;
}
// Whether a drag carries anything the book takes (its kinds are known before the drop, its contents only at it)
export const takes = dt => ['Files', 'text/uri-list', 'text/html', 'text/plain'].some(t => dt?.types.includes(t));

// What came, as one thing to land: { pictures: [Blob] }, { picture: url }, { link: url, words }, { words },
// { refused: words } or null for nothing at all
export function whatCame({ files, html, uris, text }) {
  const pictures = files.filter(f => IMAGE.test(f.type)),
    others = files.filter(f => !IMAGE.test(f.type));
  if (pictures.length) return { pictures };
  if (others.length) return { refused: refusalOf(others) };
  if (/^data:image\//.test(text.trim())) return { picture: text.trim() };
  const page = html ? new DOMParser().parseFromString(html, 'text/html') : null,
    words = page ? wordsOf(page.body) : tidy(text),
    link = firstUri(uris) ?? (WEB.test(text.trim()) ? text.trim() : null);
  // (an <img> dragged off a web page: its HTML is the picture and nothing else)
  const img = page?.querySelector('img[src]');
  if (img && !words) return { picture: img.src };
  const anchors = page ? page.querySelectorAll('a[href]') : [];
  if (anchors.length === 1 && words === tidy(anchors[0].textContent)) {
    const href = anchors[0].href;
    return { link: href, words: words && words !== href ? `${words}\n${href}` : href };
  }
  if (link && (!words || words === link)) return { link, words: link };
  return words ? { words } : null;
}
const firstUri = uris =>
  uris
    .split(/\r?\n/)
    .map(l => l.trim())
    .find(l => l && !l.startsWith('#') && WEB.test(l)) ?? null;
const refusalOf = files => {
  const named = files.length === 1 && files[0].name ? `“${files[0].name}” isn’t` : 'those aren’t';
  return `Only pictures and words land on a page: ${named} one of them.`;
};

// ---- a page's HTML as plain words

// blocks that start a new paragraph, and ones that start a line
const PARAGRAPH = new Set([
    'P',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'BLOCKQUOTE',
    'PRE',
    'UL',
    'OL',
    'TABLE',
    'FIGURE',
  ]),
  LINE = new Set(['DIV', 'LI', 'TR', 'DT', 'DD', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'FIGCAPTION', 'HR']),
  UNSEEN = 'script, style, noscript, template, head, title, meta, link';

// An element's words as a reader sees them: its paragraphs a blank line apart, a list's items on lines of their own,
// a table's cells side by side (a dot between), a <pre>'s spacing kept
function wordsOf(root) {
  root.querySelectorAll(UNSEEN).forEach(el => el.remove());
  let out = '';
  const breakTo = n => {
    const had = out.match(/\n*$/)[0].length;
    if (out && had < n) out += '\n'.repeat(n - had);
  };
  const walk = (node, pre) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const words = pre ? node.data : node.data.replace(/\s+/g, ' ');
      out += out.endsWith('\n') || !out ? words.replace(/^ /, '') : words;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName,
      gap = PARAGRAPH.has(tag) ? 2 : LINE.has(tag) ? 1 : 0;
    if (tag === 'BR') return void (out += '\n');
    breakTo(gap);
    if (tag === 'LI')
      out += node.parentElement?.tagName === 'OL' ? `${[...node.parentElement.children].indexOf(node) + 1}. ` : '• ';
    if ((tag === 'TD' || tag === 'TH') && node.previousElementSibling) out += ' · ';
    for (const child of node.childNodes) walk(child, pre || tag === 'PRE');
    breakTo(gap);
  };
  walk(root, false);
  return tidy(out);
}
