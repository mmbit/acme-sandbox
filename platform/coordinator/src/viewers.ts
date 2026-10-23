// Who is looking at a product's preview, as the product may know them: a stable, opaque id per viewer, the board's, one
// tester's on a share, or an agent job's test player (a pass's, players.ts: its job, run and name), different for
// every product and never an email (house rule 7). Caddy hands it to the product in X-Viewer (preview.ts check,
// infra/products.py).
import { signed } from './payments.ts';

export type Viewer = 'board' | { share: number; guest: string } | { job: number; run: string; player: string };
const named = (who: Viewer) =>
  who === 'board'
    ? 'board'
    : 'share' in who
      ? `share:${who.share}:${who.guest.toLowerCase()}`
      : `pass:${who.job}:${who.run}:${who.player}`;
export const viewerId = (slug: string, who: Viewer) => `vw_${signed(`viewer:${slug}:${named(who)}`).slice(0, 32)}`;
