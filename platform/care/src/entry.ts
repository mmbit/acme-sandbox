// One knowledge entry as its file has it (kb/README.md in the template): the cases it answers (`answers:`), the pages
// that show it (`faq:`, a company's own places), its question and answer per language and what only the chat needs. The
// answer in English is the text before any `## ` heading, another language's its `## <lang>` section, `## chat` the
// chat's part; an entry without headings is its English answer. kb.ts gives a conversation its language's view of it,
// and a company's pages read the same entries (their FAQ), so both read them one way. No imports: a page's build step
// reads it too.
export type Entry = {
  front: string[]; // the frontmatter's other lines (source, verified, …)
  question: Record<string, string>; // `question:` (en) and `question.<lang>:`
  answer: Record<string, string>;
  chat: string;
  answers: string[]; // the case ids it answers (H-1234)
  places: string[]; // where a page shows it
};

const unquote = (s: string) => s.trim().replace(/^(["'])(.*)\1$/, '$2');
const list = (s: string) =>
  unquote(s)
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);

export function parseEntry(raw: string): Entry {
  const text = raw.trim(),
    end = text.startsWith('---\n') ? text.indexOf('\n---', 4) : -1;
  const e: Entry = { front: [], question: {}, answer: {}, chat: '', answers: [], places: [] };
  for (const line of end < 0 ? [] : text.slice(4, end).split('\n')) {
    const m = /^(answers|faq|question(?:\.(\w+))?):(.*)$/.exec(line);
    if (!m) e.front.push(line);
    else if (m[1] === 'answers') e.answers.push(...list(m[3]).filter(id => /^H-\d{4,9}$/.test(id)));
    else if (m[1] === 'faq') e.places.push(...list(m[3]));
    else e.question[m[2] ?? 'en'] = unquote(m[3]);
  }
  const parts = (end < 0 ? text : text.slice(end + 4).trim()).split(/^## (\w+)[ \t]*$/m);
  e.answer.en = parts[0].trim();
  for (let i = 1; i < parts.length; i += 2) {
    if (parts[i] === 'chat') e.chat = parts[i + 1].trim();
    else e.answer[parts[i]] = parts[i + 1].trim();
  }
  return e;
}

// The entry as a conversation in one language reads it: its frontmatter with that language's question (English where
// it has none, the answer too), without `answers:` and `faq:`, then the answer and the chat's part, their quotes in
// that language only
export function inLanguage(e: Entry, lang: string) {
  const l = e.answer[lang] && e.question[lang] ? lang : 'en';
  return [heading(e, l), ownQuotes(e.answer[l], lang), ownQuotes(e.chat, lang)].filter(Boolean).join('\n');
}
function heading(e: Entry, l: string) {
  const question = e.question[l] ?? e.question.en;
  const head = [...(question == null ? [] : [`question: ${question}`]), ...e.front];
  return head.length ? ['---', ...head, '---'].join('\n') : '';
}

// A page quoted word for word in several languages, in an answer or the chat's part: one paragraph per language, each
// starting with its code (`EN: `, `NL: `, `DE: `), side by side. A conversation reads only its own language's of each
// such run (the English where the run has none), so the other languages cost the prompt nothing; quotes() gives them
// when a customer writes in another (the company's tool for it).
const QUOTE = /^([A-Z]{2}): /;
const paragraphs = (text: string) => text.split(/\n[ \t]*\n/);
function ownQuotes(text: string, lang: string) {
  const out: string[] = [];
  let run: string[] = [];
  for (const p of paragraphs(text)) {
    if (QUOTE.test(p)) {
      run.push(p);
      continue;
    }
    out.push(...quotesIn(run, lang), p);
    run = [];
  }
  out.push(...quotesIn(run, lang));
  return out.join('\n\n');
}
// one run's paragraphs in a language: its own, else the English, else the whole run
function quotesIn(run: string[], lang: string) {
  const pick = (code: string) => run.filter(p => QUOTE.exec(p)![1] === code);
  return [pick(lang.toUpperCase()), pick('EN'), run].find(x => x.length) ?? [];
}
// an entry's word-for-word quotes in one language, under its question ('' when it has none in that language)
export function quotes(e: Entry, lang: string) {
  const code = lang.toUpperCase(),
    own = [e.answer.en, e.chat].flatMap(paragraphs).filter(p => QUOTE.exec(p)?.[1] === code);
  return own.length ? [heading(e, lang), ...own].join('\n') : '';
}
