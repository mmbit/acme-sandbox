// Resolves file operands or fixed rejection diagnostics for literal reads.
const catOptions = new Set([
  '--show-all',
  '--number-nonblank',
  '--show-ends',
  '--number',
  '--squeeze-blank',
  '--show-tabs',
  '--show-nonprinting',
]);
const headTailOptions = new Set(['--quiet', '--silent', '--verbose', '--zero-terminated']);

export type ReadDiagnostic = 'readFlags' | 'readTerminator';

export function fileOperands(
  program: string,
  args: string[],
): { files: string[] } | { diagnostic: ReadDiagnostic | undefined } {
  const files: string[] = [];
  let diagnostic: ReadDiagnostic | undefined;
  for (let i = 0; i < args.length;) {
    const arg = args[i];
    if (arg === '--') {
      diagnostic ??= 'readTerminator';
      files.push(...args.slice(i + 1));
      break;
    }
    if (arg === '-' || !arg.startsWith('-')) {
      files.push(arg);
      i++;
      continue;
    }
    diagnostic = 'readFlags';
    const consumed = optionWords(program, args, i);
    if (consumed === null) return { diagnostic };
    i += consumed;
  }
  return files.length && files.every(file => file !== '-') ? { files } : { diagnostic };
}

function optionWords(program: string, args: string[], index: number): number | null {
  const option = args[index];
  if ((program === 'cat' ? catOptions : headTailOptions).has(option)) return 1;
  if (program !== 'cat') {
    const longCount = /^--(lines|bytes)(?:=(.*))?$/.exec(option);
    if (longCount) {
      const attached = longCount[2] !== undefined;
      return validCount(attached ? longCount[2] : args[index + 1]) ? (attached ? 1 : 2) : null;
    }
  }
  if (!/^-[^-]/.test(option)) return null;
  const flags = program === 'cat' ? 'AbEenstTuv' : 'qvz';
  for (let i = 1; i < option.length; i++) {
    const flag = option[i];
    if (flags.includes(flag)) continue;
    if (program === 'cat' || !'nc'.includes(flag)) return null;
    const attached = option.slice(i + 1);
    return validCount(attached || args[index + 1]) ? (attached ? 1 : 2) : null;
  }
  return 1;
}

const validCount = (value: string | undefined) =>
  value !== undefined && /^[+-]?\d+$/.test(value) && Number.isSafeInteger(Number(value));
