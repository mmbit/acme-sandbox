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

export function helperBundle({ tools, browsers }: { tools: boolean; browsers: boolean }) {
  const runtime = browsers ? browserBundle() : { directories: [], libraries: [] };
  return { tools: [...(tools ? TOOLS : []), ...runtime.libraries], directories: runtime.directories, exclude: EXCLUDE };
}

function browserBundle() {
  const headless = readdirSync(BROWSERS).find(name => name.startsWith('chromium_headless_shell-'))!;
  const binary = join(BROWSERS, headless, 'chrome-headless-shell-linux64/chrome-headless-shell');
  const dependencies = execFileSync('ldd', [binary], { encoding: 'utf8' });
  const libraries = [...dependencies.matchAll(/=> (\/\S+)/g)].map(match => match[1]);
  return { directories: [BROWSERS], libraries };
}
