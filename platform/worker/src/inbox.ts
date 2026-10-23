// Colleagues' messages (hq say) reach a running Claude work job through Claude Code hooks, passed with --settings:
// after every tool call, and when the session is about to stop, `hq inbox --hook` takes the job's waiting messages
// from HQ and hands them to the session as context (on Stop it keeps the session going one more turn to read them).
// The hook runs the image's own hq (root's, where no job can write), as the job's uid with the HQ_TOKEN already in its
// env: no token or message text goes on a command line, and one job's hook can't be pointed elsewhere by another.
// The hook's 30 s: more than its two calls to HQ (hq inbox --hook: 10 s each, so it isn't killed between its ack and its
// exit), less than the minute before HQ offers an unacknowledged message again (messages.ts OFFER_AGAIN).
export const HQ_BIN = '/usr/local/bin/hq';
export function inboxHooks(hq = HQ_BIN) {
  const hook = [{ hooks: [{ type: 'command', command: `${hq} inbox --hook`, timeout: 30 }] }];
  return { PostToolUse: hook, Stop: hook };
}
export const inboxSettings = (hq = HQ_BIN) => JSON.stringify({ hooks: inboxHooks(hq) });
