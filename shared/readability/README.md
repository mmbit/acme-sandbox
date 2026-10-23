# Readability count


The weekly readability review's numbers (`shared/routines/code-quality.md`), per area, counted the same way every
week: what makes code hard to read or change, measured against CODE_STYLE.md. A company keeps its weekly results in a
note of its own.

```sh
node shared/readability/count.ts                         # three tables, per area: size and shape, comments, copies and tests
node shared/readability/count.ts --list squeezed         # each finding of one measure, with its file and line
node shared/readability/count.ts --list money platform/  # narrowed to a path prefix (either form)
```

It reads the code the gates hold (`.prettierignore` leaves out throwaway work), as git has it: JavaScript and
TypeScript through TypeScript's parser, Python's functions through Python's, shell by its lines. It needs the gates'
tools (`npm ci` at the repo root, or the worker's copy).

| Measure | What counts |
|---|---|
| files past 400 lines, functions past 50 | CODE_STYLE.md's limits. A function counts from its first line to its last, nested ones on their own too, so a factory full of helpers counts with them |
| lines past 120 columns | any line, comments too |
| squeezed control flow | a block of two statements or more on one line, an if with its else, or a try with its catch, on one line. Prettier takes these apart, so they're old, unformatted files |
| comment lines | lines holding only a comment, as a share of all lines |
| openings past 3 lines | a file's opening comment (one line on what it's for, CODE_STYLE.md) longer than three lines |
| files more comment than code | as it says |
| comments telling history | a job, card, request, round, item or pull request number prefixed with `#`, or a call number, in a comment, the foundation's `company:` tag aside |
| lines copied from another file | six significant lines in a row (150 characters at least without spaces) that another file has too. JavaScript, TypeScript and Python lines compare as their tokens (TypeScript's parse tree, Python's tokenizer), blank lines, comments and imports aside, so spacing and indentation don't count; their strings, templates and regular expressions compare as written, every line of one counting whatever it holds. Shell lines compare as written, every one, blank and comment lines too (a quote can hold either), so a shell copy spaced another way escapes it. Exact copies only: a copy with small changes escapes it |
| money, dates formatted by hand | outside `shared/format` and tests: `style: 'currency'`, `/ 100).toFixed(2)`, `€${…}`, `toLocaleString` with fraction digits; `Intl.DateTimeFormat`, `toLocale(Date\|Time)String`, `toISOString().slice(`, `getMonth() + 1` |
| routing by string matching | outside `shared/routes`: `path === '/x'`, `path.startsWith('/x')`, `method === 'GET'` and the like |
| tests reading source text | a test that reads a `.ts`, `.js`, `.py`, `.html` or `.css` file as text |
| mocks and spies in tests | `mock.fn`, `mock.method`, `mock.module`, Python's `patch` and `MagicMock` |

The patterns are a lower bound: a copy with small changes escapes the copy count, and so does money built from a
helper. Read the lists, then hand-check what they hint at.

Test: `node --test shared/readability/count.test.ts`.
