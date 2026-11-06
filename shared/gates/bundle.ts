// Worker tools and Chromium runtime assets bundled for checks on lent helpers.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import type { Run } from './suites.ts';

const TOOLS_BIN = process.env.TESTS_TOOLS_BIN ?? '/usr/local/bin';
// Compose and static jq are optional until the worker image supplies them. Their infra tests skip when absent.
const TOOLS = [
  ...['age', 'age-keygen', 'versitygw', 'caddy'],
  ...['docker-compose', 'jq'].filter(tool => existsSync(join(TOOLS_BIN, tool))),
].map(name => join(TOOLS_BIN, name));
// Playwright's package-manager hints are not runtime assets.
const EXCLUDE = ['*/deb.deps', '*/rpm.deps'];

const BROWSERS = process.env.TESTS_BROWSERS_PATH ?? '/ms-playwright';

type Browser = 'shell' | 'chromium';
type BrowserAssets = 'none' | 'all' | Browser[];

export function helperBundle({ tools, browsers }: { tools: boolean; browsers: BrowserAssets }) {
  const none = browsers === 'none' || !browsers.length;
  const runtime = none ? { directories: [], libraries: [], exclude: [] } : browserBundle(browsers);
  return {
    tools: [...(tools ? TOOLS : []), ...runtime.libraries],
    directories: runtime.directories,
    exclude: [...EXCLUDE, ...runtime.exclude],
  };
}

// The browsers a set of runs' tests launch, from what each test file and the files it imports, to the end, use:
// Playwright, directly or through shared/browser, runs the headless shell; a path to Playwright's full Chromium (FULL),
// for shared/chromium's CHROMIUM_PATH, runs that (its text has the font's own widths). Read from the checkout as it is
// (a push's tests run in one at their commit), or at the revision `at` (the base a comparison runs).
export function browsersOf(root: string, runs: Run[], at?: string): Browser[] {
  const found = new Set<Browser>();
  const texts = new Map<string, string>();
  const read = (file: string) => {
    if (!texts.has(file))
      try {
        const text = at
          ? execFileSync('git', ['cat-file', 'blob', `${at}:${file}`], { cwd: root, encoding: 'utf8', stdio: 'pipe' })
          : readFileSync(join(root, file), 'utf8');
        texts.set(file, text.replace(TYPE_IMPORT, ''));
      } catch {
        texts.set(file, ''); // (an import that isn't a file here, such as one in a test's fixture text)
      }
    return texts.get(file)!;
  };
  const look = (file: string) => {
    const text = read(file);
    if (text.includes(FULL)) found.add('chromium');
    const targets = [];
    for (const [, spec] of text.matchAll(IMPORT)) {
      if (/^playwright(-core)?(\/|$)/.test(spec)) found.add('shell');
      if (!spec.startsWith('.')) continue;
      const target = normalize(join(dirname(file), spec));
      if (target === 'shared/browser/browser.mjs') found.add('shell');
      targets.push(target);
    }
    return targets;
  };
  const walk = (file: string) => {
    if (texts.has(file)) return;
    for (const target of look(file)) walk(target);
  };
  for (const run of runs) run.files.forEach(walk);
  return [...found];
}
const IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"\n]+)['"]/g;
const FULL = 'chrome-linux64/chrome';
const TYPE_IMPORT = /\bimport\s+type\s[^;]*;/g; // (gone when it runs)

// Authored browser commands keep all installed assets. Push tests take only the browsers they launch.
function browserBundle(browsers: 'all' | Browser[]) {
  const assets = readdirSync(BROWSERS);
  const shell = assets.find(name => name.startsWith('chromium_headless_shell-'))!;
  const chromium = assets.find(name => name.startsWith('chromium-'))!;
  const kept = browsers === 'all' ? assets : browsers.map(b => (b === 'shell' ? shell : chromium));
  const binaries = [
    ...(kept.includes(shell) ? [join(BROWSERS, shell, 'chrome-headless-shell-linux64/chrome-headless-shell')] : []),
    ...(kept.includes(chromium) ? [join(BROWSERS, chromium, FULL)] : []),
  ];
  const libraries = [...new Set(binaries.flatMap(librariesOf))];
  const exclude = assets.filter(name => !kept.includes(name)).map(name => `*/${name}`);
  return { directories: [BROWSERS], libraries, exclude };
}

function librariesOf(binary: string) {
  const dependencies = execFileSync('ldd', [binary], { encoding: 'utf8' });
  return [...dependencies.matchAll(/=> (\/\S+)/g)].map(match => match[1]);
}
