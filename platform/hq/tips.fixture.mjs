// The tips book's stand-in HQ, for tips-check.mjs and manual-check.mjs: HQ served on a free port in the looks it ships,
// the sample company's names, a card waiting for an answer, the rest of /api from HQ's mocks, and a Show me's ring.
import { serve } from './serve.mjs';
import { lookNames } from './looks.mjs';

export const server = await serve(),
  base = `http://localhost:${server.address().port}`;
export const LOOKS = lookNames();
// the sample company's names for its desk phone and intercom, the foundation's
export const NAMES = { phone: 'desk phone', intercom: 'intercom' };
export const TABLET = { width: 1180, height: 820 };
// the card that needs an answer (its created and urgency: each check's)
export const DECISION = {
  id: 3,
  agent: 'wren',
  kind: 'decision',
  title: 'A new bench for the garden?',
  body: 'About a bench.',
};

// What a check doesn't stand in for itself: the board's book, empty, then HQ's mocks (platform/hq/mock), else nothing
export async function mockedApi(r, path) {
  if (path === '/api/book') return r.fulfill({ json: { day: null, today: null, days: [], pages: [] } });
  const mocked = await r.fetch({ url: `${base}/mock${path.slice(4)}.json` });
  if (mocked.ok()) return r.fulfill({ response: mocked });
  if (path === '/api/seen') return r.fulfill({ json: {} });
  if (['/api/gazette', '/api/mail', '/api/review/products', '/api/requests/later'].includes(path))
    return r.fulfill({ json: [] });
  return r.fulfill({ status: 404, body: '' });
}

// A Show me step's ring and the control it points at (at: the control's selector, the first of them shown), as boxes
export const ringAndControl = (page, at) =>
  page.evaluate(
    at =>
      [
        document.querySelector('.showme-ring'),
        [...document.querySelectorAll(at)].find(e => e.getBoundingClientRect().width > 0),
      ].map(e => e.getBoundingClientRect().toJSON()),
    at,
  );
