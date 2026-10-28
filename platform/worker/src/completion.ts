// The worker's trusted completion hooks, shared by Claude Code and Codex. A work job's hook names its checkout and the
// folders beside it the gates may read (the git mirror): the hook confines the checkout's gates to those (hq complete).
// messages: the inbox hooks (inbox.ts), or 'steps' for the after-each-tool-call one alone (Codex).
import { HQ_BIN, inboxHooks } from './inbox.ts';

export function completionHooks(
  kind: string,
  {
    hq = HQ_BIN,
    messages = false,
    checkout,
    readable = [],
  }: { hq?: string; messages?: boolean | 'steps'; checkout?: string; readable?: string[] } = {},
) {
  // (try)
  const inbox =
    messages && ['work', 'meeting', 'chat', 'try'].includes(kind) ? inboxHooks(hq, messages === 'steps') : undefined;
  const check =
    kind === 'work'
      ? ['work', checkout, ...readable].join(' ')
      : ['review', 'consolidate'].includes(kind)
        ? 'review'
        : undefined;
  return {
    ...inbox,
    ...(check
      ? {
          Stop: [
            { hooks: [{ type: 'command', command: `${hq} complete ${check}`, timeout: kind === 'work' ? 600 : 30 }] },
            ...(inbox?.Stop ?? []),
          ],
        }
      : {}),
  };
}
