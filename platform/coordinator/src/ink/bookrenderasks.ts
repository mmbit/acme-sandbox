// The agents' desk-phone cards on a page's picture, in their ink: a card clipped
// under a unit (bookasks.js), "<name> asks" and its words on its slip, then its choices as chips and its questions, or
// the board's answer ticked once it's given; a form clipped onto an answer, its questions the same way, each with the
// board's answer once it's sent.
import sharp, { type OverlayOptions } from 'sharp';
import { block, column, escaped, layered, paper, WORDS, type Part } from './bookrendertext.ts';

// A question as drawn: its title and the chips to pick from (none: words written under it), or the board's answer as
// said once it's given ('': left blank)
export type Question = { title: string; choices: string[]; answer?: string };
// A form clipped onto an answer, in its agent's ink (color): its questions
export type Form = { color: string; questions: Question[] };
// A card clipped under a group by its agent (name, its ink: color): its words, its choices and questions, the board's
// answer (null: still open)
export type Asked = {
  name: string;
  color: string;
  text: string;
  choices: string[];
  questions: Question[];
  answer: string | null;
};

// The card's slip as the book lays it (bookasks.css .ask-slip): 14 px under what's over it, its padding, its paper (paler
// once answered), 10 px between its parts; a chip (questions.js's, outlined in the agent's ink), 8 px apart
const ASK = {
  gap: 14,
  pad: { top: 16, x: 14, bottom: 10 },
  paper: '#fff4cf',
  answered: '#fffaea',
  shadow: 0.14,
  part: 10,
};
const CHIP = { size: 13, line: 1.3, pad: { x: 12, y: 6 }, gap: 8, stroke: 2 };
// A question's title and what's under it, 6 px apart; the line to write an answer on
const ASKED = { gap: 6, line: 22 };

// A card's slip under a group from top (picture px), as wide as what's under it (x, w in page px)
export async function asked(a: Asked, at: { x: number; w: number }, top: number, k: number) {
  const inner = at.w - 2 * ASK.pad.x,
    tint = (text: string, color = WORDS.ink, bold = false) =>
      words(`<span${bold ? ' weight="bold"' : ''} foreground="${color}">${escaped(text)}</span>`, inner, k);
  const parts: Part[] = [await tint(`${a.name} asks`, a.color, true), await tint(a.text)];
  if (a.answer !== null) parts.push(await tint(`✓ ${a.answer || 'Got it'}`, a.color, true));
  else {
    if (a.choices.length) parts.push(await chips(a.choices, inner, k, a.color));
    for (const q of a.questions) parts.push(await question(q, inner, k, a.color));
  }
  const all = await column(parts, Math.round(inner * k), Math.round(ASK.part * k)),
    h = Math.round((ASK.pad.top + ASK.pad.bottom) * k) + all.height;
  const on = [{ input: all.input, left: Math.round(ASK.pad.x * k), top: Math.round(ASK.pad.top * k) }];
  const look = { paper: a.answer === null ? ASK.paper : ASK.answered, shadow: ASK.shadow, on };
  return paper(Math.round(at.x * k), top + Math.round(ASK.gap * k), Math.round(at.w * k), h, k, look);
}
const words = (markup: string, w: number, k: number) => block(markup, w, k, WORDS);
// A form's questions w page px wide, ASK.part apart
export const formed = async (f: Form, w: number, k: number) =>
  column(
    await Promise.all(f.questions.map(q => question(q, w, k, f.color))),
    Math.round(w * k),
    Math.round(ASK.part * k),
  );
// A question: its title, then its answer in the ink, its chips or a line to write on
async function question(q: Question, w: number, k: number, color: string) {
  const title = await words(`<span weight="bold" foreground="${WORDS.ink}">${escaped(q.title)}</span>`, w, k);
  const under =
    q.answer !== undefined
      ? await words(`<span foreground="${color}">${escaped(q.answer || '—')}</span>`, w, k)
      : q.choices.length
        ? await chips(q.choices, w, k, color)
        : line(w, k, color);
  return column([title, under], Math.round(w * k), Math.round(ASKED.gap * k));
}
// The line an answer is written on
function line(w: number, k: number, color: string): Part {
  const W = Math.max(1, Math.round(w * k)),
    H = Math.round(ASKED.line * k);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><line x1="0" y1="${H - k}" x2="${W}" y2="${H - k}" stroke="${color}" stroke-opacity="0.5" stroke-width="${k}" stroke-dasharray="${3 * k} ${3 * k}"/></svg>`;
  return { input: Buffer.from(svg), height: H, tall: H, lead: 0 };
}
// Choices as chips, side by side and wrapping down within w page px
async function chips(labels: string[], w: number, k: number, color: string): Promise<Part> {
  const px = (n: number) => Math.round(n * k),
    W = Math.max(1, px(w));
  const each = await Promise.all(
    labels.map(async label => {
      const set = await block(
        `<span weight="bold" foreground="${color}">${escaped(label)}</span>`,
        w - 2 * CHIP.pad.x,
        k,
        CHIP,
      );
      const cw = Math.min(W, set.width + px(2 * CHIP.pad.x)),
        ch = set.tall + px(2 * CHIP.pad.y),
        s = CHIP.stroke * k;
      const pill = `<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${ch}"><rect x="${s / 2}" y="${s / 2}" width="${cw - s}" height="${ch - s}" rx="${Math.min(ch / 2, px(18))}" fill="#fffdf6" stroke="${color}" stroke-width="${s}"/></svg>`;
      const input = await sharp(Buffer.from(pill))
        .composite([{ input: set.input, left: px(CHIP.pad.x), top: px(CHIP.pad.y) + set.lead }])
        .png()
        .toBuffer();
      return { input, w: cw, h: ch };
    }),
  );
  const on: OverlayOptions[] = [];
  let x = 0,
    y = 0,
    row = 0;
  for (const c of each) {
    if (x > 0 && x + c.w > W) [x, y, row] = [0, y + row + px(CHIP.gap), 0];
    on.push({ input: c.input, left: x, top: y });
    [x, row] = [x + c.w + px(CHIP.gap), Math.max(row, c.h)];
  }
  return { ...(await layered(on, W, y + row)), lead: 0 };
}
