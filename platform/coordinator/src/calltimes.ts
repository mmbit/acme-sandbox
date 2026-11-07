// A call's line times as calls.line_times stores them: the voice line's time for each line, in ms.

export const lineTimes = (lines: string[], times: unknown) =>
  Array.isArray(times) &&
  lines?.length &&
  times.length === lines.length &&
  times.every(t => Number.isFinite(t) && t > 0)
    ? JSON.stringify(times.map(Math.round))
    : null;

// One time a line, or null for a call without them.
export const timesOf = (lineTimes: string | null) => (lineTimes ? (JSON.parse(lineTimes) as number[]) : null);
