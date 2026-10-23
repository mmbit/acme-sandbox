// What HQ's lines changed count: code and docs. Data never counts (a run's output, a fixture, a lock file, a plate, a
// render's .render.json), nor a file .gitattributes marks linguist-generated or linguist-vendored (GitHub leaves those
// out of its diffs and language stats too). A job's lines (git.ts branchLines) and a day's (the coordinator's
// commitlines.ts) read it.

export const CODE_OR_DOCS =
  /\.(ts|tsx|js|jsx|mjs|cjs|css|scss|html|md|py|sh|sql|yaml|yml|toml|go|rs|rb|java|kt|swift|c|h|cc|cpp|glsl|wgsl|frag|vert|svelte|vue)$|(^|\/)(Dockerfile|Caddyfile|Makefile)[^/]*$/;
export const MARKS = ['linguist-generated', 'linguist-vendored'];

export type FileLines = { path: string; add: number; del: number };

// A `--numstat` row read with core.quotePath=false: a binary file (- -) is none; a renamed one is its new path
// ("dir/{a => b}/f.ts", "a.ts => b.ts").
export function numstatRow(row: string): FileLines | null {
  const [a, d, ...rest] = row.split('\t');
  const add = Number(a),
    del = Number(d);
  if (!rest.length || !a || !d || !Number.isInteger(add) || !Number.isInteger(del)) return null;
  const path = rest
    .join('\t')
    .replace(/^"(.*)"$/, '$1')
    .replace(/\{[^{}]* => ([^{}]*)\}/, '$1')
    .replace(/^.* => /, '')
    .replace(/\/\/+/g, '/');
  return { path, add, del };
}

// The paths `git check-attr -z <MARKS> -- <paths>` printed as set (path, attribute, value, each ending in NUL)
export function markedPaths(checkAttr: string) {
  const parts = checkAttr.split('\0');
  return new Set(parts.flatMap((path, i) => (i % 3 === 0 && ['set', 'true'].includes(parts[i + 2]) ? [path] : [])));
}

// The lines that count: an edited line is one removed and one added, and counts once (the larger of the two)
export function countedLines(files: FileLines[], marked: Set<string>) {
  const kept = files.filter(f => CODE_OR_DOCS.test(f.path) && !marked.has(f.path));
  const add = kept.reduce((n, f) => n + f.add, 0),
    del = kept.reduce((n, f) => n + f.del, 0);
  return { add, del, lines: Math.max(add, del) };
}
