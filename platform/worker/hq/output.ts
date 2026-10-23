// What hq prints: its lines, the refusals that stop it, how a value reads in a sentence, what counts as set, and how
// money and times look.

export class StopError extends Error {
  exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.exitCode = exitCode;
  }
}

// Ends the command: the message (if any) on stderr, and the exit code. 3 always means "not confirmed": it may have
// happened, so don't do it again.
export function stop(message: string, exitCode = 1): never {
  throw new StopError(message, exitCode);
}

export function print(...lines: string[]) {
  process.stdout.write(lines.map(line => `${line}\n`).join(''));
}

// Settles once the reader has the lines (in a pipe's buffer or a file), or fails when they can't be written. A full
// pipe nobody reads keeps it waiting.
export function printWritten(...lines: string[]) {
  return new Promise<void>((resolve, reject) => {
    process.stdout.write(lines.map(line => `${line}\n`).join(''), error => (error ? reject(error) : resolve()));
  });
}

export const warn = (line: string) => process.stderr.write(`${line}\n`);

// A value in a sentence: a string as it is, anything else as compact JSON (a missing one reads "null").
export function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'null';
  return JSON.stringify(value);
}

// Set means anything but missing, null and false: 0 and '' are set.
export const present = <T>(value: T): value is Exclude<T, undefined | null | false> =>
  value !== undefined && value !== null && value !== false;

// The value as text, or '' when it isn't set.
export const shown = (value: unknown) => (present(value) ? text(value) : '');

export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

// Code point order, the same on every machine (localeCompare depends on the locale)
export function compareText(a: string, b: string) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// 2026-10-08T14:30:12Z reads 2026-10-08 14:30
export const minute = (time: string) => time.slice(0, 16).replace('T', ' ');

// Words from outside (a sender, a subject, a file name) keep to their line: control characters become `by`.
export const oneLine = (words: string, by = '_') => words.replace(/\p{Cc}/gu, by);

// Half away from zero (Math.round takes -2.5 to -2).
export const round = (x: number) => Math.sign(x) * Math.round(Math.abs(x));

// €12.30. A missing amount reads €?, and a negative one -€1.50.
export function euro(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return '€?';
  if (amount < 0) return `-${euro(-amount)}`;
  return euroAmount(amount);
}

// €12.30 for amounts of 0 and up. A negative one keeps its sign in both parts: -1.5 reads €-2.-50.
export function euroAmount(amount: number) {
  const cents = round(amount * 100);
  return `€${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}
