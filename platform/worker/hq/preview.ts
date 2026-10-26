// hq preview: a command run with a view-only pass to one product's preview (the coordinator's preview.ts createPass), to check
// it as a visitor sees it, or (--player) as the job's own test player. The pass and the player's
// voucher go to the command in its environment alone, never on a command line, in a file or printed (charter rule 8).
// (--player)
import { spawnSync } from 'node:child_process';
import { constants } from 'node:os';
import * as api from './api.ts';
import { stop, text, warn } from './output.ts';

const USAGE = 'usage: hq preview <product slug> [--player <name>] -- <command> [args...]';

export const preview = {
  help: `
   hq preview <slug> -- <command> [args...]          runs the command with a view-only pass to that product's preview,
                                                     good for an hour and never past this job's run: HQ_PREVIEW_URL is
                                                     its address, HQ_PREVIEW_COOKIE its cookie. For Playwright, split
                                                     the cookie at the first = and call addCookies with url set to
                                                     HQ_PREVIEW_URL, httpOnly: true, secure: true and sameSite: 'Lax'.
                                                     No review mode, chat, other host or HQ. HQ
                                                     keeps who had one, and this job's log says so
   hq preview <slug> --player <name> -- <command>    the same pass, as this run's own test player of that name
                                                     (lowercase, digits, dashes): the product knows it as a player,
                                                     never the board or a tester, the same on every pass this run
                                                     with that name, and as the company's own (a product's company
                                                     test purchase). On a product with plans HQ_PREVIEW_VOUCHER is its
                                                     tester's voucher: one plan once in test mode, up to the default
                                                     tester invite amount. A new
                                                     name is a new player with a voucher of its own`,

  async run([slug, ...rest]: string[]) {
    const player = rest[0] === '--player' ? rest[1] : undefined;
    const [dashes, ...command] = player === undefined ? rest : rest.slice(2);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug ?? '') || player === '' || dashes !== '--' || !command.length) stop(USAGE);
    const answer = await api.orNoAnswer(
      api.call('preview-passes', { body: api.withSpeaker({ slug, ...(player ? { player } : {}) }), timeoutMs: 30_000 }),
    );
    if (api.isRefusal(answer.status)) stop(`No pass: ${api.errorIn(answer.body, 'refused')}.`);
    const pass = api.isSuccess(answer.status) ? api.parseOrNull(answer.body) : null;
    if (typeof pass?.cookie !== 'string' || typeof pass.url !== 'string')
      stop(`No pass: HQ didn't give one (HTTP ${api.httpCode(answer.status)}).`);
    const voucher = typeof pass.voucher === 'string' ? ', with its voucher,' : '';
    const access = player ? `test player ${player}'s pass${voucher}` : 'view-only pass';
    warn(`hq preview: a ${access} to ${pass.url} until ${text(pass.expires)} or this run's end.`);
    const environment: NodeJS.ProcessEnv = { ...process.env, HQ_PREVIEW_URL: pass.url, HQ_PREVIEW_COOKIE: pass.cookie };
    delete environment.HQ_PREVIEW_VOUCHER;
    if (player && typeof pass.voucher === 'string') environment.HQ_PREVIEW_VOUCHER = pass.voucher;
    const run = spawnSync(command[0], command.slice(1), {
      stdio: 'inherit',
      env: environment,
    });
    if (run.error) stop(`hq preview: ${command[0]}: ${run.error.message}`, 127);
    return run.status ?? 128 + constants.signals[run.signal!];
  },
};
