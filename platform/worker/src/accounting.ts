// Structured disk-accounting failures distinguish worker infrastructure from slot-controlled reads.
export const ACCOUNTING_FAILURE_REASONS = [
  'worker-ancestor',
  'worker-scanner',
  'job-tree',
  'process-counters',
  'write-sampling',
] as const;
export type AccountingFailureReason = (typeof ACCOUNTING_FAILURE_REASONS)[number];
export type AccountingFailure = { reason: AccountingFailureReason; message: string };

export class AccountingError extends Error {
  reason: AccountingFailureReason;

  constructor(reason: AccountingFailureReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

export const workerAccountingFailure = (reason: AccountingFailureReason | null) =>
  reason === 'worker-ancestor' || reason === 'worker-scanner';
