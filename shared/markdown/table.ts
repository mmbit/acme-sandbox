// Markdown table cells, tokenized by Marked without padding or discarding mismatched body cells.
import { createRequire } from 'node:module';

// The gates do not install this module's runtime dependency before checking types.
const { Lexer } = createRequire(import.meta.url)('marked');

export type Table = { headings: string[]; rows: (string[] | null)[] };

export function tokenizeTable(lines: string[]): Table | null {
  const [heading, separator, ...body] = lines;
  if (!separator) return null;
  const headings = tableHeadings(heading, separator);
  if (!headings) return null;
  return { headings, rows: body.map(row => tableHeadings(row, separator)) };
}

function tableHeadings(row: string, separator: string): string[] | null {
  // Marked checks header widths against separators, but pads or truncates body rows. Tokenize each row as a header
  // so callers can refuse mismatches instead of silently changing the written table.
  const tokens = Lexer.lex(`${row}\n${separator}\n`, { gfm: true });
  if (tokens.length !== 1 || tokens[0].type !== 'table') return null;
  return tokens[0].header.map((cell: { text: string }) => cell.text);
}
