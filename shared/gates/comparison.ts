// Base test comparisons shared by worker-started pushes. The owning runner keeps the ticket out of suite environments
// and helper bundles.

type Compared = { failed: Set<string>; passed: Set<string>; notInstalled: Map<string, string> };
type Claim = { test: string; failed?: boolean; yours?: boolean; running?: number };
const POLL_MS = 5000;

export async function compareBase(
  base: string,
  environment: string,
  tests: string[],
  run: (tests: Set<string>) => Promise<Compared>,
) {
  const ticket = process.env.TESTS_COMPARISON;
  if (!ticket) return run(new Set(tests));
  const code = JSON.parse(ticket);
  if (code.commit !== base) throw new Error('The comparison ticket names a different base commit');
  const call = async (action: string, tests: unknown) => {
    const answer = await fetch(`${process.env.HQ_URL}/api/agent/tests/base/${action}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.HQ_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...code, environment, tests }),
    });
    if (!answer.ok) throw new Error(`The base comparison ${action} failed: HTTP ${answer.status}`);
    return answer.json();
  };
  const compared: Compared = { failed: new Set(), passed: new Set(), notInstalled: new Map() };
  let pending = tests;
  let reused = 0;
  while (pending.length) {
    const claims = (await call('claim', pending)) as Claim[];
    for (const claim of claims) {
      if (claim.failed === undefined) continue;
      (claim.failed ? compared.failed : compared.passed).add(claim.test);
      reused++;
    }
    const owned = claims.filter(claim => claim.yours).map(claim => claim.test);
    if (owned.length) await compareOwned(owned, compared, run, call);
    pending = claims.filter(claim => claim.running).map(claim => claim.test);
    if (pending.length) await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
  console.log(`Base comparison: ${reused} kept, ${tests.length - reused} run`);
  return compared;
}

async function compareOwned(
  tests: string[],
  compared: Compared,
  run: (tests: Set<string>) => Promise<Compared>,
  call: (action: string, tests: unknown) => Promise<unknown>,
) {
  let completed = false;
  try {
    const ran = await run(new Set(tests));
    const outcomes = tests.map(test => ({
      test,
      failed: ran.notInstalled.size && !ran.passed.has(test) ? null : ran.failed.has(test),
    }));
    await call('done', outcomes);
    completed = true;
    for (const outcome of outcomes) {
      if (outcome.failed !== null) (outcome.failed ? compared.failed : compared.passed).add(outcome.test);
    }
    for (const [pkg, why] of ran.notInstalled) compared.notInstalled.set(pkg, why);
  } finally {
    if (!completed)
      await call(
        'done',
        tests.map(test => ({ test, failed: null })),
      );
  }
}
