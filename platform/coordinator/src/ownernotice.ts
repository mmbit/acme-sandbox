// (split from proposals.ts.)
// A proposal whose owner couldn't be told (messages.ts send refused the line, with its status): nothing that came with
// it is kept. proposals.ts untold runs the change in one step and answers the refusal instead.
export class OwnerNotificationError extends Error {
  status: number;
  constructor(status: number, owner: string) {
    const why: Record<number, string> = {
      429: 'the job sending it has sent its messages for this hour',
    };
    super(`${owner} couldn't be told: ${why[status] ?? `the message was refused (${status})`}. Nothing changed`);
    this.status = status;
  }
}
