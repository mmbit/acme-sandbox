// A seat's id names its folder on the worker (/seats/<id>), so it's a name safe for one: lowercase letters and digits in
// two or more parts joined by single dashes, starting with a letter (claude-4, codex-board, claude-team2,
// codex-team-b-3). The one rule the worker (seatlist.ts, worker.ts's SEATS) and the
// coordinator (seats.ts, whose image takes this file: .dockerignore) check by; HQ's mock Seats (shell/data.js) keeps a
// copy of the rule and its words.
export const SEAT_NAME = '[a-z][a-z0-9]*(?:-[a-z0-9]+)+';
export const SEAT_ID = new RegExp(`^${SEAT_NAME}$`);
// (the board's words when a name doesn't fit)
export const SEAT_RULE = `A seat's name is lowercase letters and digits in two or more parts joined by dashes, starting with a letter, like claude-4 or claude-team-2.`;
