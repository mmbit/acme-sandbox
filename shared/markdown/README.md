# Markdown

`table.ts` uses Marked, the same Markdown dependency as the coordinator. Import `tokenizeTable(lines)` by its repo
path. It returns `null` for invalid headings or a separator. Otherwise it returns heading text and one cells array
per body row, with `null` for a row whose width does not match. Escaped pipes stay within their cells. No HTML is
rendered. Callers own content validation, inline rendering and accessibility.

Run `npm ci` here before using it. An app image copies `table.ts`, `package.json` and `package-lock.json` into
`/repo/shared/markdown/`, then runs `npm ci --omit=dev` there. The dependency loads through `createRequire` so the
gates can check the module without installing its runtime package.

Tests: `node --test shared/markdown/table.test.ts` from the repo root.

