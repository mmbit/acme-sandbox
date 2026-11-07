// A word as one single-quoted shell argument, for a command an agent's brief tells it to run: nothing in it expands
// (' becomes '\'').
export const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
