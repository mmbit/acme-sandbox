// The nightly off-site backup's watch. infra/backup.py runs on the host (a systemd timer) and leaves its status in this
// volume (backup-status.json). Once the board's four keys are in, a night without a good backup is a line in HQ's feed,
// once per missed night, and an alarm for the CEO (alarms.ts) per run of bad nights, and the process role (org.yaml's
// roles) gets one job per run to find out why: at once when the night failed for how it's set up (config_error: R2
// refusing the token or the bucket, a key's shape), which no later night mends by itself, else from the 26 hours. A heads-up (the bucket nearing R2's free tier, the repo's copy going
// stale) is said when its text changes, and is an alarm too: backup.py keeps figures out of it, so it's said once, and
// again only if it clears on a good night and comes back. A stale repo copy that isn't about the free tier's room (a
// token, an fsck, an upload) gets them one job per heads-up too, and so do invoices or agreements not copied off the
// server in time (the 7-year records). Only what backup.py wrote is shown: never a key.
import { readFileSync, statSync } from 'node:fs';
import { DATA_DIR } from './config.ts';
import { setting, remember } from './db.ts';
import { publish } from './events.ts';
import * as alarms from './alarms.ts';
import { createJob, findAgent } from './jobs.ts';
import { STANDING } from './jobcodes.ts';
import { DIR as SECRETS } from './secrets.ts';
import { infra, companyTime, roles } from './company.ts';

// who finds out why: the agent and their name
const fixer = () => roles().process, fixerName = () => findAgent(fixer())?.name ?? fixer();

export const KEYS = ['BACKUP_R2_ENDPOINT', 'BACKUP_R2_ACCESS_KEY_ID', 'BACKUP_R2_SECRET_ACCESS_KEY', 'BACKUP_AGE_RECIPIENT'];
const HOUR = 3600e3, DAY = 24 * HOUR, LATE = 26 * HOUR; // it runs around 02:30 UTC: a missed night shows by about 05:00
const RUN_LIMIT = 2 * HOUR; // backup.service's TimeoutStartSec: a night still in_progress past it was stopped mid-way
type Status = { ok_at?: string; tried_at?: string; state?: string; error?: string | null; warn?: string | null;
  repo_warn?: string | null; repo_error?: string | null; records_warn?: string | null; records_error?: string | null; in_progress?: boolean;
  config_error?: boolean | null }; // (config_error)

const status = (): Status => { try { return JSON.parse(readFileSync(`${DATA_DIR}/backup-status.json`, 'utf8')); } catch { return {}; } };
const line = (s: unknown) => String(s ?? '').replace(/[\p{Cc}\p{Cf}]+/gu, ' ').slice(0, 200);
// when all four of the board's keys were first in (the watch gives the first night a day from then), or null before. Kept
// in a setting: re-saving a key later (a new token after a failed night) mustn't restart the clock or look like a backup.
const keyed = () => {
  let at: number;
  try { at = Math.max(...KEYS.map(k => statSync(`${SECRETS}/${k}`).mtimeMs)); } catch { remember('backup.keyed', null); return null; }
  const was = Number(setting('backup.keyed'));
  if (was > 0) return was;
  remember('backup.keyed', String(at));
  return at;
};

// The feed's line, and the CEO's alarm while it's on
// (word: its job's task code word, jobcodes.ts.)
const tell = (alarm: string, word: string, title: string, text: string) => {
  publish({ type: 'log', agent: fixer(), text });
  alarms.raise(alarm, text, { title, urgent: false, word, prompt: `${text} The server's status report (hq report, "off-site backup") has the latest.` });
};

export function check(now = Date.now()) {
  const since = keyed();
  if (since === null) return; // the board's card isn't done yet: nothing to watch
  const s = status(), ok = Date.parse(s.ok_at ?? ''), last = Number.isFinite(ok) ? ok : since;
  const missed = Math.floor((now - last - LATE) / DAY) + 1; // 0 while fresh, 1 from 26 hours, 2 from 50, ...
  const streak = s.ok_at ?? `keys ${new Date(since).toISOString()}`;
  // (refused: the job before the 26 hours)
  const refused = s.state === 'failed' && !!s.config_error && Date.parse(s.tried_at ?? '') > last;
  // the job only queues: the alert says so (nobody is "on it" until it runs).
  const queued = (missed > 0 || refused) && setting('backup.job') !== streak;
  if (queued) {
    remember('backup.job', streak);
    // (word: its task code's, jobcodes.ts.)
    createJob({ agent: fixer(), word: STANDING.backupJob, title: `Off-site backup ${missed > 0 ? 'missed' : 'set up wrong'}: find out why (${Number.isFinite(ok) ? `last good ${s.ok_at}` : 'none yet'})`,
      prompt: `The nightly off-site backup (infra/backup.py, run by ${infra().SERVER_NAME}-backup.timer on the host; the note "Off-site backups") has no good backup ${Number.isFinite(ok) ? `since ${s.ok_at}` : 'since the board saved its keys'}. Last try: ${line(s.tried_at) || 'none recorded'}, ${line(s.state) || 'no state'}${s.error ? `: ${line(s.error)}` : ''}.${s.config_error ? ' It failed for how it\'s set up (the token, the bucket or a key), which no later night mends by itself.' : ''} The server's status report (hq report, "off-site backup") has the latest. Find out why and fix it. Only bring it to the board if it needs the board (the R2 token or bucket), as one card.` });
  }
  if (missed > 0) {
    if (setting('backup.missed') !== `${streak}|${missed}`) {
      remember('backup.missed', `${streak}|${missed}`);
      const why = s.error ? ` Last try: ${line(s.error)}.` : s.tried_at ? '' : ' It hasn\'t run at all.';
      const next = queued ? ` A job for ${fixerName()} is queued to find out why.` : ` A job for ${fixerName()} to find out why was queued already.`;
      tell('backup', STANDING.backup, 'The off-site backup failed', `No off-site backup ${Number.isFinite(ok) ? `since ${companyTime(ok)}` : 'yet'} (${missed} night${missed > 1 ? 's' : ''} missed).${why}${next}`);
    }
  } else if (setting('backup.missed')) {
    remember('backup.missed', null);
    // only a real backup is news
    const back = Number.isFinite(ok) ? `Off-site backups are back: the latest is from ${companyTime(ok)}.` : null;
    if (back) publish({ type: 'log', agent: fixer(), text: back });
    alarms.end('backup', back ? { title: 'Off-site backups are back', prompt: back } : undefined, now);
  }
  // A running night still has its repo's, records' and renders' copies to come, so their heads-ups and jobs wait for it to
  // end. A night the unit stopped keeps in_progress until the next run, so once the unit's time limit has passed it's
  // judged as it stands
  const running = s.in_progress && now - Date.parse(s.tried_at ?? '') < RUN_LIMIT;
  if (!running) headsUps(s, now);
}

// The night's heads-ups and their jobs: the repo's copy, the records and the bucket
function headsUps(s: Status, now: number) {
  // the repo's copy stale: its heads-up's text only changes with a new streak, so one job each. Not when the copy is just
  // too big for the free tier's room (that one is the board's, on its backup card)
  const repoJob = !!s.repo_warn && s.state === 'ok' && !(s.repo_error ?? '').startsWith('not uploaded:') && setting('backup.repo_job') !== s.repo_warn;
  if (repoJob) {
    remember('backup.repo_job', s.repo_warn!);
    // (word: its task code's, jobcodes.ts.)
    createJob({ agent: fixer(), word: STANDING.repoCopy, title: `Off-site backup: the repo's copy is stale, find out why (${line(s.repo_warn)})`,
      prompt: `The nightly off-site backup (infra/backup.py, run by ${infra().SERVER_NAME}-backup.timer on the host; the note "Off-site backups") still backs up the database, but its copy of the repo is stale: ${line(s.repo_warn)}. Last try: ${line(s.tried_at) || 'none recorded'}${s.repo_error ? `: ${line(s.repo_error)}` : ''}. The server's status report (hq report, "off-site backup") has the latest. Find out why and fix it. Only bring it to the board if it needs the board (SERVER_GITHUB_TOKEN, the R2 token or bucket), as one card.` });
  }
  // invoices and agreements not off the server in time (they're kept 7 years, and the backups keep a year): one job each
  const recordsJob = !!s.records_warn && setting('backup.records_job') !== s.records_warn;
  if (recordsJob) {
    remember('backup.records_job', s.records_warn!);
    // (word: its task code's, jobcodes.ts.)
    createJob({ agent: fixer(), word: STANDING.records, title: `Off-site backup: invoices or agreements not copied off the server, find out why`,
      prompt: `The nightly off-site backup (infra/backup.py; the note "Off-site backups", "The 7-year records") hasn't copied every mail to invoices@ and documents@ off the server: ${line(s.records_warn)}. Last try: ${line(s.tried_at) || 'none recorded'}${s.records_error ? `: ${line(s.records_error)}` : ''}. The server's status report (hq report, "off-site backup", records) has the latest. Find out why and fix it. Only bring it to the board if it needs the board (the R2 token or bucket, or room past the free tier), as one card.` });
  }
  if (s.warn && setting('backup.warn') !== s.warn) {
    remember('backup.warn', s.warn);
    const queued = [repoJob && 'why the repo\'s copy is stale', recordsJob && 'why the invoices and agreements aren\'t copied'].filter(Boolean);
    tell('backup.warn', STANDING.backupWarn, 'An off-site backup heads-up', `Off-site backup heads-up: ${line(s.warn)}.${queued.length ? ` A job for ${fixerName()} is queued to find out ${queued.join(', and ')}.` : ''}`);
  }
  // a good night without one clears it, so the same heads-up coming back later is told again (a failed night says nothing
  // about it, and neither does a night the unit stopped mid-way: its status leaves out the copies it never made)
  else if (!s.warn && s.state === 'ok' && !s.in_progress && setting('backup.warn')) {
    remember('backup.warn', null);
    alarms.end('backup.warn', undefined, now);
  }
}

const safe = () => { try { check(); } catch (err) { console.error('Backup watch:', err); } };
export const start = () => { setTimeout(safe, 60_000); setInterval(safe, HOUR / 2); };
