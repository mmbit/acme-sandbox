// Worker tools and Chromium runtime assets bundled for checks on lent helpers.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const TOOLS_BIN = process.env.TESTS_TOOLS_BIN ?? '/usr/local/bin';
// Compose and static jq are optional until the worker image supplies them. Their infra tests skip when absent.
const TOOLS = [
  ...['age', 'age-keygen', 'versitygw', 'caddy'],
  ...['docker-compose', 'jq'].filter(tool => existsSync(join(TOOLS_BIN, tool))),
].map(name => join(TOOLS_BIN, name));
// Playwright's package-manager hints are not runtime assets.
const EXCLUDE = ['*/deb.deps', '*/rpm.deps'];

const BROWSERS = process.env.TESTS_BROWSERS_PATH ?? '/ms-playwright';

type BrowserAssets = 'none' | 'shell' | 'all';

export function helperBundle({ tools, browsers }: { tools: boolean; browsers: BrowserAssets }) {
  const runtime = browsers === 'none' ? { directories: [], libraries: [], exclude: [] } : browserBundle(browsers);
  return {
    tools: [...(tools ? TOOLS : []), ...runtime.libraries],
    directories: runtime.directories,
    exclude: [...EXCLUDE, ...runtime.exclude],
  };
}

// Authored browser commands keep all installed assets. Push tests consume only the headless shell.
function browserBundle(browsers: 'shell' | 'all') {
  const assets = readdirSync(BROWSERS);
  const headless = assets.find(name => name.startsWith('chromium_headless_shell-'))!;
  const binary = join(BROWSERS, headless, 'chrome-headless-shell-linux64/chrome-headless-shell');
  const binaries = [binary];
  if (browsers === 'all') {
    const chromium = assets.find(name => name.startsWith('chromium-'))!;
    binaries.push(join(BROWSERS, chromium, 'chrome-linux64/chrome'));
  }
  const libraries = [...new Set(binaries.flatMap(librariesOf))];
  const exclude = browsers === 'shell' ? assets.filter(name => name !== headless).map(name => `*/${name}`) : [];
  return { directories: [BROWSERS], libraries, exclude };
}

function librariesOf(binary: string) {
  const dependencies = execFileSync('ldd', [binary], { encoding: 'utf8' });
  return [...dependencies.matchAll(/=> (\/\S+)/g)].map(match => match[1]);
}
