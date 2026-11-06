// A seat's admission and active work in words, for the hq command and the coordinator's reports (the worker's
// seatstatus.ts judges them). Here, under hq/, so the installed command carries it.
// A seat's state as the worker reports it (HQ also hears 'paused': the worker's reportSeat)
export type SeatState = 'login' | 'ready' | 'draining' | 'sleeping' | 'closed';
export type SeatStatus = {
  admission: 'open' | 'paced' | 'unavailable';
  until: number | null;
  running: number;
  state: SeatState | 'paused';
};

export function seatStatusWords(status: SeatStatus, at: (ms: number) => string) {
  const running = `${status.running} running`;
  const when = status.until === null ? undefined : at(status.until);
  if (status.admission === 'unavailable') {
    const waitsFor = when ? `until ${when}` : (UNTIMED[status.state] ?? 'with no return time reported');
    return `${running}. New work waits ${waitsFor}`;
  }
  if (status.admission === 'paced')
    return `${running}. New non-urgent work waits for pacing${when ? ` until ${when} at current usage` : ''}. Urgent work, a board call's follow-up and board conversations may run`;
  return `${running}. Takes new work within available room`;
}
// What a seat with no return time waits for, by its state
const UNTIMED: Partial<Record<SeatState | 'paused', string>> = {
  login: 'until the board signs the seat in again',
  paused: 'until the board resumes the seat',
  closed: 'until the board decides on the account its provider closed',
};
