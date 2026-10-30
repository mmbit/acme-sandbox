// Where a line of the intercom is on its way to the CEO (chat.sent).
export const WAITING = 0; // for the CEO's next turn
export const ANSWERED = 1; // heard: its turn ended done (a failed turn's lines go to the CEO again)
export const WITH_CEO = 2; // in a turn that hasn't answered yet
export const NEXT_TURN = 3; // goes with the next turn but starts none: the notes of a call the CEO's follow-up job already handled (callNotes())
export const OFFERED = 4; // offered to the running turn's hook, not yet confirmed printed (ack()): a turn that ends done with it still
// offered never took it, so it waits again
