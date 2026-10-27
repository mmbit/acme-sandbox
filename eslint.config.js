// ESLint for our TypeScript and browser JavaScript: bug patterns and security, never formatting (Prettier owns that).
// Run through `npm run gates` (CODE_STYLE.md, "The gates").
import { includeIgnoreFile } from '@eslint/compat';
import js from '@eslint/js';
import security from 'eslint-plugin-security';
import globals from 'globals';
import { defineConfig } from 'eslint/config';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-eslint';

// An .html page's inline scripts, each linted on its own with the rest of the page blanked, so lines and columns stay
// the page's. Only no-alert counts there, and a script ESLint can't read: a page's scripts lean on its markup and on
// each other, which ESLint can't see. A script runs when it has no src and its type is empty, module or a JavaScript
// MIME type (the HTML standard's list); one inside a comment never runs. The browser keeps an attribute's first
// copy, and decodes character references in its value: a type with one in it is linted rather than decoded here.
const JAVASCRIPT = new Set([
  '',
  'module',
  ...'text/javascript application/javascript text/ecmascript application/ecmascript application/x-ecmascript'.split(
    ' ',
  ),
  ...'application/x-javascript text/jscript text/livescript text/x-ecmascript text/x-javascript'.split(' '),
  ...[0, 1, 2, 3, 4, 5].map(minor => `text/javascript1.${minor}`),
]);
// a comment, or a script element: its opening tag's attributes (quoted values may hold a >), then its code
const COMMENT_OR_SCRIPT =
  /<!--[\s\S]*?-->|(<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>)([\s\S]*?)<\/script(?:[\s/][^>]*)?>/gi;
// one attribute: its name, and its value if it has one (quoted or not)
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
const inlineScripts = {
  meta: { name: 'inline-scripts' },
  preprocess(text) {
    const blank = part => part.replace(/[^\n]/g, ' ');
    return [...text.matchAll(COMMENT_OR_SCRIPT)].flatMap((script, i) => {
      const [, tag, attributes, code] = script;
      if (!tag) return []; // a comment
      const named = new Map();
      for (const [, name, ...value] of attributes.matchAll(ATTRIBUTE))
        if (!named.has(name.toLowerCase())) named.set(name.toLowerCase(), value.find(v => v !== undefined) ?? '');
      const type = named.get('type')?.trim().toLowerCase() ?? '';
      if (named.has('src') || !(JAVASCRIPT.has(type) || type.includes('&'))) return [];
      const start = script.index + tag.length;
      const page = blank(text.slice(0, start)) + code + blank(text.slice(start + code.length));
      return [{ text: page, filename: `${i}.${type === 'module' ? 'mjs' : 'cjs'}` }];
    });
  },
  postprocess: messages => messages.flat().filter(m => m.fatal || m.ruleId === 'no-alert'),
};

// CODE_STYLE.md's size limits, in lines: the gates hold Python and shell to them too (shared/gates/sizes.ts)
export const SIZE_LIMITS = { file: 400, function: 50 };

export default defineConfig(
  includeIgnoreFile(fileURLToPath(new URL('.prettierignore', import.meta.url))),
  js.configs.recommended,
  ts.configs.recommended,
  {
    // Node and the browser both: a Playwright check is a Node script whose page code runs in the browser
    languageOptions: { ecmaVersion: 'latest', globals: { ...globals.node, ...globals.browser } },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    plugins: { security },
    rules: {
      // the code style allows `any` at the edges, and an unused name that starts with _ is on purpose
      '@typescript-eslint/no-explicit-any': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // ask in the page's own UI, never the browser's dialogs (CODE_STYLE.md)
      'no-alert': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',
      'security/detect-bidi-characters': 'error',
      'security/detect-buffer-noassert': 'error',
      'security/detect-new-buffer': 'error',
      'security/detect-pseudoRandomBytes': 'error',
    },
  },
  {
    // CODE_STYLE.md's size limits, for code that lasts (a test grows with the behaviour it covers). The gates count them
    // by what a change crosses (shared/gates/sizes.ts).
    files: ['**/*.{ts,js,mjs,cjs}'],
    ignores: ['**/*.test.*', '**/*-check.mjs', '**/check.mjs', '**/tests/**'],
    rules: { 'max-lines': ['error', SIZE_LIMITS.file], 'max-lines-per-function': ['error', SIZE_LIMITS.function] },
  },
  { files: ['**/*.html'], processor: inlineScripts },
);
