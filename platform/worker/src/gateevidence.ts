// Actual ordinary gate inputs, retained only when memory blocks an eligible seat.
import type { AdmissionInput } from './admission.ts';
import { QUIET_MS } from './availability.ts';

export type GateEvaluation = {
  ready: { seat: string; engine: string; state: string; check: boolean }[];
  shortClaims: { engine: string; throttled: boolean; exclusion: 'throttled' | 'nonpositive room' | null }[];
  ordinarySelected: boolean;
};
export type OrdinaryGate = Omit<GateEvaluation, 'shortClaims'> & {
  room: AdmissionInput;
  shortClaims: (GateEvaluation['shortClaims'][number] & { input: AdmissionInput })[];
};

export function ordinaryGate(evaluation: GateEvaluation | undefined, inputs: AdmissionInput[]): OrdinaryGate | null {
  if (!evaluation) return null;
  const room = inputs.find(input => input.operation === 'room');
  if (!room) return null;
  const claims = inputs.filter(input => input.operation === 'claimMb');
  return {
    ...evaluation,
    room,
    shortClaims: evaluation.shortClaims.map((claim, index) => ({ ...claim, input: claims[index] })),
  };
}

export function pressureBlocked(gate: OrdinaryGate | null) {
  if (!gate || gate.ordinarySelected || gate.room.value !== false || !braked(gate.room)) return false;
  return gate.shortClaims.some(
    claim =>
      !claim.throttled &&
      claim.exclusion === 'nonpositive room' &&
      Number(claim.input.value) <= 0 &&
      braked(claim.input) &&
      gate.ready.some(seat => seat.state === 'ready' && !seat.check && seat.engine === claim.engine),
  );
}

function braked(input: AdmissionInput) {
  const measurement = input.measurement;
  return measurement.underPressure && measurement.availableBytes === 0 && !!measurement.lastPressureTrigger;
}

export function quietAdmission(inputs: AdmissionInput[]) {
  return (
    inputs.length > 0 &&
    inputs.every(input => {
      const measurement = input.measurement;
      const quiet = measurement.quietPredecessor;
      return (
        !measurement.underPressure &&
        measurement.previousOomEvents !== null &&
        measurement.readEndedAt >= measurement.pressureUntil &&
        !!quiet &&
        quiet.last.readEndedAt - quiet.first.readStartedAt >= QUIET_MS
      );
    })
  );
}
