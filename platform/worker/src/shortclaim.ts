// Short ordinary claim room and its actual exclusion reason.
import type { GateEvaluation } from './gateevidence.ts';

export function shortClaimRoom(engine: string, freeMb: number, throttled: boolean, evaluation?: GateEvaluation) {
  const exclusion = throttled ? 'throttled' : freeMb <= 0 ? 'nonpositive room' : null;
  evaluation?.shortClaims.push({ engine, throttled, exclusion });
  return exclusion === null ? freeMb : undefined;
}
