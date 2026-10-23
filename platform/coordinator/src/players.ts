// Job-scoped test players and their plan vouchers.
// A player belongs to one product, job run and name. Its voucher pays one test plan up to the tester invite default,
// never a shop basket, and expires with the run.
import { db } from './db.ts';
import { FRONT } from './approvals.ts';
import { noSuchCode, testerVoucherSources } from './payments.ts';
import { DEFAULT_CAP_CENTS, newVoucher, shownVoucher } from './shares.ts';
import { viewerId } from './viewers.ts';

export const PLAYER = /^[a-z0-9][a-z0-9-]{0,31}$/;
// spent: the plan holding its voucher paid
db.exec(`create table if not exists preview_players (product text not null, job integer not null, run text not null,
  player text not null, voucher text not null unique, created text not null, spent text, primary key (product, job, run, player))`);
type Player = { product: string; job: number; run: string; player: string; voucher: string; spent: string | null };

// The player for that job's run on product, made the first time it's asked for: its voucher, as shown
export function voucherFor(product: string, job: number, run: string, player: string) {
  db.prepare(
    'insert or ignore into preview_players (product, job, run, player, voucher, created) values (?, ?, ?, ?, ?, ?)',
  ).run(product, job, run, player, newVoucher(), new Date().toISOString());
  const p = db
    .prepare('select voucher from preview_players where product = ? and job = ? and run = ? and player = ?')
    .get(product, job, run, player) as { voucher: string };
  return shownVoucher(p.voucher);
}

const holderOf = (code: string) =>
  db.prepare('select * from preview_players where voucher = ?').get(code) as Player | undefined;
const running = (p: Player) =>
  !!db.prepare("select 1 from jobs where id = ? and token = ? and status = 'running'").get(p.job, p.run);

const playerVouchers: (typeof testerVoucherSources)[number] = {
  // on its own product's plans only: the shop's code box asks for the front's
  find: (code, product) => (product !== FRONT && holderOf(code)?.product === product ? code : undefined),
  holds: code => !!holderOf(code),
  viewer: code => {
    const p = holderOf(code);
    return p ? viewerId(p.product, p) : null;
  },
  unusable: code => {
    const p = holderOf(code);
    if (!p) return noSuchCode;
    if (p.spent) return [409, 'this voucher has been used', 'code_used'];
    if (!running(p)) return [409, "this voucher's job run has ended", 'code_expired'];
    return null;
  },
  cap: () => DEFAULT_CAP_CENTS,
  use: (code, session) => {
    const why = playerVouchers.unusable(code);
    if (why) return why;
    db.prepare('update preview_players set spent = ? where voucher = ?').run(session, code);
    return null;
  },
  // A player never pays a shop basket, so no parcel can be sent again.
  retake: code => holderOf(code)?.spent ?? null,
};
testerVoucherSources.push(playerVouchers);
