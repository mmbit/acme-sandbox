// The other company in links.test.ts: a second coordinator in a process of its own, serving on the port PORT names so
// its address (config.ts ORIGIN) answers. It prints what the test needs as one JSON line, then serves until killed.
//
//   PORT=<free port> COMPANY_NAME=<made-up name> node src/links.fixture.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { harness } from './harness.ts';

// The test company under a name of its own (company/brand.yaml's name is what a link shows the other side)
export function named(repo: string, name: string) {
  const file = `${repo}/company/brand.yaml`;
  writeFileSync(file, readFileSync(file, 'utf8').replace(/^name: .*$/m, `name: ${name}`));
}

// What the test reads from the other company's process
export type OtherCompany = { address: string; cookie: string; ceo: { token: string; agent: string }; dataDir: string };

if (import.meta.main) {
  const h = await harness('links-b', { before: repo => named(repo, process.env.COMPANY_NAME!) });
  const { app } = await import('./server.ts');
  const { ORIGIN } = await import('./config.ts');
  await new Promise(listening => createServer(app).listen(Number(process.env.PORT), () => listening(null)));
  // (on claude: an urgent message reaches a running session)
  const ceo = await h.start({ agent: 'juno', engine: 'claude' });
  const other: OtherCompany = {
    address: ORIGIN,
    cookie: h.boardCookie,
    ceo: { token: ceo.token, agent: ceo.agent },
    dataDir: h.dataDir,
  };
  console.log(JSON.stringify(other));
  // (exit, so fixture.ts removes this process's temp folder)
  process.on('SIGTERM', () => process.exit(0));
}
