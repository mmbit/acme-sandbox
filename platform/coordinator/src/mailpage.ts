// An email's words, filled in: the plain text part, and an HTML part set in a look of the sender's own.
//
// The words are plain text with a little markup that reads as plain text too:
//   ## Heading        a section's heading (the text part drops the marks)
//   - an item         a list item. "- Label: https://…" links the label in the HTML part, "- Label: more" sets it in
//                     bold
//   ---               the rest is small print (the text part drops the line)
//   https://…         a link, in the words themselves
//   [Label]: address  a button: the label on a button linking the address (https://… in the words, or a link slot);
//                     the text part shows the label and a colon, the address on its own line under it
// Slots ({name}) are filled from `values`. A slot alone on its line may bring several lines, and a line holding only a
// slot left empty goes. A slot the sender fills with receipt rows (`rows`: each thing's picture, name, details and
// price) is a table in the HTML part, the picture beside the words and the price
// on the right, and each row's `text` a line of the text part. What a slot brings is escaped and never linked, beyond a
// "- Label: https://…" item: it may hold a customer's own words. The sender may name slots that hold a link of its own
// (a tracking link, a leave link): one of those is linked, its address whole. A slot the sender fills with a marked
// line (`marked`: its words and a small picture, a closing wish with its season's mark, say) is that line, the picture
// beside the words in the HTML part. Blank lines that a slot left empty brings together are one in the text part.
//
// The look is a YAML file the sender names: `page`, the whole HTML document around the words with {lang}, {subject} and
// {content}, and `styles`, the inline style of each part the words become (mail apps drop a page's own style sheet). A
// button is a one-cell table (`button`, its cell `button_cell`, its link `button_link`): Outlook's Word engine pads a
// cell but not a link, so the cell carries `mso-padding-alt` and the link the padding everyone else uses. Receipt rows
// are a table (`rows`), each row's cells the picture's (`row_picture`, its image `row_img`), the words' (`row_text`:
// the name in `strong`, each detail in `row_detail`) and the price's (`row_amount`). A marked line is a one-row table
// too (`marked`), its picture's cell (`marked_picture`, its image `marked_img`) and its words' (`marked_text`). A
// letter's signature (head.signature: plain lines, the sender's name first) goes in the page's {signature}, or under
// the words if it has none: one paragraph in the `sign` style, its first line in bold, its https addresses linked. It
// stays out of the text part: the caller has it there already.
import { existsSync } from 'node:fs';
import { escapeHtml } from '../../../shared/html/escape.ts';
import { yamlFile } from './company.ts';
import { REPO_DIR } from './config.ts';

export type Look = { page: string; styles: Partial<Record<Part, string>> };
type Part =
  | 'h2'
  | 'p'
  | 'ul'
  | 'li'
  | 'a'
  | 'strong'
  | 'small'
  | 'sign'
  | 'button'
  | 'button_cell'
  | 'button_link'
  | 'rows'
  | 'row_picture'
  | 'row_img'
  | 'row_text'
  | 'row_detail'
  | 'row_amount'
  | 'marked'
  | 'marked_picture'
  | 'marked_img'
  | 'marked_text';
// One thing on a receipt: its picture (an https address, or none), its name, its details (what's on it, what a voucher
// paid), its price as written, and the line the text part shows for it
export type Row = { text: string; picture?: string | null; name: string; details: string[]; amount: string };
// A line with a small picture beside it: its words, and the picture's https address and size as shown (or none)
export type Marked = { text: string; picture: { src: string; width: number; height: number } | null };
type Line = { text: string; ours: boolean; rows?: Row[]; marked?: Marked };
const PICTURE_PX = 72;

const SLOT = /\{([a-z_]+)\}/g;
// The slots an email's words may hold: `slot` finds each to fill, `notSlot` a {word} HQ doesn't fill
export const slotsOf = (names: string[]) => ({
  slot: new RegExp(`\\{(${names.join('|')})\\}`, 'g'),
  notSlot: new RegExp(`\\{(?!(${names.join('|')})\\})[a-z_]+\\}`),
});
// Words their writer hasn't finished (<<...>>): a live email never goes with them
export const UNFINISHED = /<<[\s\S]*?>>/;
// The subject with its slots filled, on one line
export const subjectOf = (subject: string, slot: RegExp, values: Record<string, string>) =>
  subject
    .replace(slot, (_, name: string) => values[name])
    .replace(/\s+/g, ' ')
    .trim();
const ONLY_SLOT = /^\{([a-z_]+)\}$/;
const URL_IN_WORDS = /https:\/\/[^\s<>"]+[^\s<>".,:;!?)]/g;
const WHOLE_URL = /^https:\/\/[^\s<>"]+$/;
const LABELLED_LINK = /^([^:]{1,80}): (https:\/\/\S+)$/;
const LABELLED = /^([^:]{1,80}): (.+)$/;
const BUTTON = /^\[([^\]]{1,60})\]: (\S+)$/;

// The look in a file, or what is wrong with it. Null when there is no file: that sender sends plain text alone.
export function readLook(file: string): Look | string | null {
  if (!existsSync(`${REPO_DIR}/${file}`)) return null;
  const look = yamlFile(file);
  if (typeof look.page !== 'string' || !look.page.includes('{content}')) return `${file}: a page with {content}`;
  const styles = look.styles ?? {};
  if (typeof styles !== 'object' || Object.values(styles).some(style => typeof style !== 'string'))
    return `${file}: styles, each a string`;
  return { page: look.page, styles };
}

export function fill(
  words: string,
  values: Record<string, string>,
  look: Look | null,
  head: { lang: string; subject: string; signature?: string },
  linkSlots: string[] = [],
  rows: Record<string, Row[]> = {},
  marked: Record<string, Marked> = {},
) {
  const value = (name: string) => values[name] ?? `{${name}}`;
  const lines: Line[] = [];
  for (const line of words.split('\n')) {
    const slotAlone = line.trim().match(ONLY_SLOT)?.[1] ?? '';
    const receipt = rows[slotAlone];
    if (receipt) {
      if (receipt.length) lines.push({ text: receipt.map(row => row.text).join('\n'), ours: false, rows: receipt });
      continue;
    }
    if (Object.hasOwn(marked, slotAlone)) {
      lines.push({ text: marked[slotAlone].text, ours: false, marked: marked[slotAlone] });
      continue;
    }
    const filled = line.replace(SLOT, (_, name) => value(name));
    if (line.match(SLOT) && !filled.trim()) continue;
    const brought = slotAlone && !linkSlots.includes(slotAlone) ? value(slotAlone).split('\n') : null;
    lines.push(...(brought ? brought.map(text => ({ text, ours: false })) : [{ text: line, ours: true }]));
  }
  const text =
    lines
      .filter(line => !(line.ours && line.text === '---'))
      .map(line => (line.ours ? textOf(line.text).replace(SLOT, (_, name) => value(name)) : line.text))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim() + '\n';
  if (!look) return { text };
  const signature = head.signature ? signatureOf(head.signature, look.styles) : '';
  const pageHasSignatureSlot = look.page.includes('{signature}');
  const content =
    htmlOf(lines, look.styles, value, linkSlots) + (signature && !pageHasSignatureSlot ? `\n${signature}` : '');
  const parts: Record<string, string> = {
    content,
    signature,
    lang: escapeHtml(head.lang),
    subject: escapeHtml(head.subject),
  };
  const page = look.page.replace(/\{(lang|subject|content|signature)\}/g, (_, slot) => parts[slot]);
  return { text, html: page };
}

const textOf = (line: string) => {
  const button = line.match(BUTTON);
  return button ? `${button[1]}:\n${button[2]}` : line.replace(/^## /, '');
};

// ---- the HTML part
function htmlOf(lines: Line[], styles: Look['styles'], value: (name: string) => string, linkSlots: string[]) {
  const tag = tagIn(styles),
    linked = linkedIn(tag);
  // The label is HTML that is already escaped.
  const link = (url: string, label: string) => tag('a', label, ` href="${escapeHtml(url)}"`);
  // A link slot's value is one address, linked whole: trailing punctuation is part of it, not of a sentence.
  const linkedSlot = (address: string) =>
    WHOLE_URL.test(address) ? link(address, shown(address)) : escapeHtml(address);
  // Our own lines get links and escaped slot words.
  // A line a slot brought is escaped whole, and linked only as a "- Label: https://…" item (see item).
  const inline = (line: Line) => {
    if (!line.ours) return escapeHtml(line.text);
    return line.text
      .split(/(\{[a-z_]+\})/)
      .map(piece => {
        const slot = piece.match(ONLY_SLOT);
        if (!slot) return linked(piece);
        return linkSlots.includes(slot[1]) ? linkedSlot(value(slot[1])) : escapeHtml(value(slot[1]));
      })
      .join('');
  };
  // A button links a link slot's address or one in our words; anything else stays words.
  const button = (label: string, address: string) => {
    const slot = address.match(ONLY_SLOT)?.[1];
    const url = slot ? (linkSlots.includes(slot) ? value(slot) : '') : address.includes('{') ? '' : address;
    if (!WHOLE_URL.test(url)) return tag('p', `${escapeHtml(label)}: ${inline({ text: address, ours: true })}`);
    const link = tag('button_link', escapeHtml(label), ` href="${escapeHtml(url)}"`);
    const cell = tag('button_cell', link);
    return tag('button', `<tr>${cell}</tr>`, ' role="presentation" cellspacing="0" cellpadding="0"');
  };
  const item = (line: Line) => {
    const words = line.text.slice(2);
    const labelledLink = words.match(LABELLED_LINK);
    if (labelledLink) return tag('li', link(labelledLink[2], escapeHtml(labelledLink[1])));
    const labelled = words.match(LABELLED);
    if (labelled && !line.ours)
      return tag('li', `${tag('strong', escapeHtml(labelled[1]))}: ${escapeHtml(labelled[2])}`);
    return tag('li', inline({ ...line, text: words }));
  };

  const blocks: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let small = false;
  const close = () => {
    if (paragraph.length) blocks.push(tag(small ? 'small' : 'p', paragraph.join('<br>')));
    if (list.length) blocks.push(tag('ul', list.join('')));
    paragraph = [];
    list = [];
  };
  for (const line of lines) {
    const withPicture = line.marked ? markedOf(line.marked, styles) : null;
    if (line.rows) {
      close();
      blocks.push(receiptOf(line.rows, styles));
    } else if (withPicture) {
      close();
      blocks.push(withPicture);
    } else if (line.ours && line.text === '---') {
      close();
      small = true;
    } else if (line.ours && line.text.startsWith('## ')) {
      close();
      blocks.push(tag('h2', inline({ ...line, text: line.text.slice(3) })));
    } else if (line.ours && BUTTON.test(line.text)) {
      close();
      const [, label, address] = line.text.match(BUTTON)!;
      blocks.push(button(label, address));
    } else if (!line.text.trim()) {
      close();
    } else if (line.text.startsWith('- ')) {
      if (paragraph.length) close();
      list.push(item(line));
    } else {
      if (list.length) close();
      paragraph.push(inline(line));
    }
  }
  close();
  return blocks.join('\n');
}
// The picture's cell is there on every row, empty without one, so the names line up
function receiptOf(rows: Row[], styles: Look['styles']) {
  const tag = tagIn(styles);
  const tableRows = rows.map(row => {
    const picture = row.picture && WHOLE_URL.test(row.picture) ? row.picture : null;
    const img = picture
      ? `<img src="${escapeHtml(picture)}" width="${PICTURE_PX}" alt=""${styleOf(styles, 'row_img')}>`
      : '';
    const words = [tag('strong', escapeHtml(row.name)), ...row.details.map(d => tag('row_detail', escapeHtml(d)))];
    const cells =
      tag('row_picture', img, ` width="${PICTURE_PX + 14}"`) +
      tag('row_text', words.join('<br>')) +
      tag('row_amount', escapeHtml(row.amount), ' align="right"');
    return `<tr>${cells}</tr>`;
  });
  return tag('rows', tableRows.join(''), ' role="presentation" cellspacing="0" cellpadding="0" width="100%"');
}
// The picture's cell as wide as the picture, beside the words' first line (the look pads the gap)
function markedOf({ text, picture }: Marked, styles: Look['styles']) {
  if (!picture) return null;
  const tag = tagIn(styles);
  const { src, width, height } = picture;
  const img = `<img src="${escapeHtml(src)}" width="${width}" height="${height}" alt=""${styleOf(styles, 'marked_img')}>`;
  const cells =
    tag('marked_picture', img, ` width="${width}" valign="top"`) +
    tag('marked_text', escapeHtml(text), ' valign="top"');
  return tag('marked', `<tr>${cells}</tr>`, ' role="presentation" cellspacing="0" cellpadding="0" width="100%"');
}
function signatureOf(signature: string, styles: Look['styles']) {
  const tag = tagIn(styles),
    linked = linkedIn(tag);
  const [name, ...rest] = signature.trim().split('\n');
  return tag('sign', [tag('strong', linked(name)), ...rest.map(linked)].join('<br>'));
}
// Words of ours: each https address in them becomes a link that shows the address without its scheme.
const shown = (url: string) => escapeHtml(url.replace(/^https:\/\/(www\.)?/, ''));
const linkedIn = (tag: ReturnType<typeof tagIn>) => (words: string) => {
  const urls = words.match(URL_IN_WORDS) ?? [];
  return words
    .split(URL_IN_WORDS)
    .map((text, i) => escapeHtml(text) + (urls[i] ? tag('a', shown(urls[i]), ` href="${escapeHtml(urls[i])}"`) : ''))
    .join('');
};
const TAGS: Partial<Record<Part, string>> = {
  small: 'p',
  sign: 'p',
  button: 'table',
  button_cell: 'td',
  button_link: 'a',
  rows: 'table',
  row_picture: 'td',
  row_text: 'td',
  row_detail: 'span',
  row_amount: 'td',
  marked: 'table',
  marked_picture: 'td',
  marked_text: 'td',
};
const tagIn =
  (styles: Look['styles']) =>
  (part: Part, inner: string, attributes = '') => {
    const name = TAGS[part] ?? part;
    return `<${name}${attributes}${styleOf(styles, part)}>${inner}</${name}>`;
  };
const styleOf = (styles: Look['styles'], part: Part) => (styles[part] ? ` style="${escapeHtml(styles[part])}"` : '');
