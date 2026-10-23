import { mkdirSync } from 'node:fs';

export const PORT = Number(process.env.PORT ?? 8080);
export const REPO_DIR = process.env.REPO_DIR ?? new URL('../../..', import.meta.url).pathname;
// The company's own code (kits.ts): next to the platform's, in the repo as in the coordinator's image, whatever REPO_DIR is
export const KITS_DIR = process.env.KITS_DIR ?? new URL('../../../kits', import.meta.url).pathname;
export const DATA_DIR = process.env.DATA_DIR ?? `${REPO_DIR}/.data`;
// The zips the board uploads, unpacked (zips.ts): a volume of its own, which the worker mounts read-only at the same path
export const IMPORTS_DIR = process.env.IMPORTS_DIR ?? `${DATA_DIR}/imports`;
// What a restored copy must never bring back (metrics.ts's stop token): a folder in the host's memory, outside every data
// volume, disk snapshot and backup (infra/compose.yaml). Without one, every start counts as a restore's.
export const RUN_DIR = process.env.RUN_DIR ?? '';
// The most IMPORTS_DIR may hold, and the disk the zips must leave free, in GB (a company's own in company/infra.env)
export const IMPORTS_MAX_GB = Number(process.env.IMPORTS_MAX_GB || 10);
export const IMPORTS_MIN_FREE_GB = Number(process.env.IMPORTS_MIN_FREE_GB || 5);
export const PUBLIC_HOST = process.env.PUBLIC_HOST ?? 'localhost';
// The company's zone, the hosts HQ, its products and their previews share (hq.<zone>, <slug>.preview.<zone>); empty on
// localhost, and on a host named for the server's IP (<ip-with-dashes>.sslip.io, <ip>.nip.io): that zone is everyone's,
// so HQ's cookies stay on its own host and products wait for a domain. Keep this in step with infra/products.py's zone.
// (with mailout, payments, approvals, manifests and pages reading it, not copies)
export const ZONE = /(^|\.)\d{1,3}([.-]\d{1,3}){3}(\.|$)/.test(PUBLIC_HOST) ? '' : PUBLIC_HOST.split('.').slice(1).join('.');
export const ORIGIN = PUBLIC_HOST === 'localhost' ? `http://localhost:${PORT}` : `https://${PUBLIC_HOST}`;
export const COMMIT = process.env.GIT_COMMIT ?? 'dev';
export const WORKER_TOKEN = process.env.WORKER_TOKEN ?? '';
export const VOICE_TOKEN = process.env.VOICE_TOKEN ?? '';   // the voice line's (platform/voice): its /api/voice/* routes only
// This server's own run helpers' (platform/helper, one per kind: infra/run_helpers.py): their /api/helper/* routes only.
export const RUNS_TOKEN = process.env.RUNS_TOKEN ?? '';

mkdirSync(DATA_DIR, { recursive: true });
