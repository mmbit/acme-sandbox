// The manager a lent machine runs, installed once with its install command (HQ's Settings › Machines, README): it keeps
// the machine's helpers in step with HQ, a container per helper of each kind of run, so a new kind, a changed kind or new
// helper code needs nobody at the machine. Its own code is pinned by its hash in the install command, as it alone holds
// the Docker socket. The helpers' code follows HQ, since they reach nothing but HQ: they sit on a network of their own
// with no way out but a proxy that connects only to HQ's host and the package registries (FIXED, never HQ's to change),
// and never to a private address. A kind's helpers share that network, unless the kind keeps them `alone`: then each
// has one with the proxy alone beside it, so its runs reach no other helper.
// Everything it makes is named for its HQ, so a machine can lend itself to several.
// MANAGER=install (re)creates the manager's own container and exits; MANAGER=remove takes all of it away again.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';

const HQ_URL = process.env.HQ_URL ?? '';
const SOCKET = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock';
const KEY_FILE = process.env.KEY_FILE ?? '/state/key';
const TICK_MS = Number(process.env.TICK_MS ?? 60_000);
// (a test's HQ on a private address: the install command never sets it)
const HQ_PRIVATE = process.env.HQ_PRIVATE === '1';
const IMAGE = 'node:24.22.1-slim';
const PORT = 3128;
// The hosts a helper may reach through the proxy besides HQ's: the npm registry and PyPI, for a run's packages
const FIXED = ['registry.npmjs.org:443', 'pypi.org:443', 'files.pythonhosted.org:443'];

if (!/^https?:\/\/[^/]+$/.test(HQ_URL)) throw new Error("HQ_URL must be HQ's address");
const hq = new URL(HQ_URL);
// (as runs.ts names the volume in the install command)
const NAME = hq.host
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '');
const VOLUME = NAME;
const NETWORK = `${NAME}-net`;
const PROXY = `${NAME}-proxy`;
const MANAGER = `${NAME}-manager`;
const ALLOWED = [`${hq.hostname}:${hq.port || (hq.protocol === 'https:' ? 443 : 80)}`, ...FIXED];
// The pinned bootstrap that started this code (node -e), so the manager's container starts the same pinned code
const BOOTSTRAP = process.execArgv[process.execArgv.indexOf('-e') + 1];

const log = (...words) => console.log(new Date().toISOString(), ...words);

// One call to the Docker Engine API over its socket: the answer's JSON (a stream's last line), or null for a 404
function docker(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: SOCKET,
        method,
        path: `/v1.43${path}`,
        headers: { 'content-type': 'application/json', ...headers },
      },
      res => {
        let text = '';
        res.on('data', chunk => (text += chunk));
        res.on('end', () => {
          if (res.statusCode === 404) return resolve(null);
          if (res.statusCode >= 400)
            return reject(new Error(`docker ${method} ${path}: ${res.statusCode} ${text.slice(0, 300)}`));
          try {
            resolve(text.trim() ? JSON.parse(text.trim().split('\n').at(-1)) : {});
          } catch {
            resolve({});
          }
        });
      },
    );
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

// The proxy's code, run in its own container: CONNECT to an allowed host and port only, never to a private address
const proxyCode = (allowed, privateOk) => `const http=require('http'),net=require('net'),dns=require('dns').promises;
const ok=${JSON.stringify(allowed)};
const inside=a=>!${privateOk}&&(/^(10\\.|127\\.|169\\.254\\.|192\\.168\\.|172\\.(1[6-9]|2\\d|3[01])\\.|0\\.|100\\.(6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.)/.test(a)||/^(::1?$|::ffff:|f[cd]|fe[89ab])/i.test(a));
const s=http.createServer((q,r)=>{r.writeHead(403);r.end()});
s.on('connect',async(q,c)=>{c.on('error',()=>{});const [h,p]=q.url.split(':');
const all=await dns.lookup(h,{all:true}).catch(()=>[]);
if(!ok.includes(q.url)||!all.length||all.some(x=>inside(x.address))){c.end('HTTP/1.1 403 Forbidden\\r\\n\\r\\n');return}
const u=net.connect(+p,all[0].address,()=>{c.write('HTTP/1.1 200 Connection established\\r\\n\\r\\n');u.pipe(c);c.pipe(u)});u.on('error',()=>c.destroy())});
s.listen(${PORT});`;

// The helpers' bootstrap: the code HQ serves now, run as the helper (it reaches HQ through the proxy alone)
const HELPER_BOOT =
  "fetch(process.env.HQ_URL+'/api/helper/code',{redirect:'error'}).then(r=>{if(!r.ok)throw Error('no helper code: '+r.status);return r.text()})" +
  ".then(t=>{const f=require('os').tmpdir()+'/helper.mjs';require('fs').writeFileSync(f,t);return import(f)})";

const withEnv = env => Object.entries(env).map(([k, v]) => `${k}=${v}`);

function proxySpec() {
  return {
    Image: IMAGE,
    User: '1000:1000',
    Entrypoint: ['node'],
    Cmd: ['-e', proxyCode(ALLOWED, HQ_PRIVATE)],
    HostConfig: {
      RestartPolicy: { Name: 'unless-stopped' },
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      ReadonlyRootfs: true,
      Memory: 256 * 2 ** 20,
      PidsLimit: 64,
    },
  };
}

// A kind's helper, with the caps the start commands always had, on the closed network (one of its own when its kind
// keeps it alone, as it then tells HQ). A kind whose runs keep their sockets gets a cache for their packages, which
// outlives each run (npm and pip check what they read from it).
function helperSpec(kind, slot) {
  const proxy = `http://${PROXY}:${PORT}`;
  return {
    Image: kind.image,
    User: '0:0',
    Entrypoint: ['node'],
    Cmd: ['-e', HELPER_BOOT],
    Env: withEnv({
      HQ_URL,
      RUN_KIND: kind.name,
      HELPER_SLOT: slot,
      HELPER_LOCKED: 1,
      ...(kind.alone ? { HELPER_ALONE: 1 } : {}),
      NODE_USE_ENV_PROXY: 1,
      HTTPS_PROXY: proxy,
      HTTP_PROXY: proxy,
    }),
    HostConfig: {
      Init: true,
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: networkOf(kind, slot),
      CapDrop: ['ALL'],
      CapAdd: ['SETUID', 'SETGID'],
      SecurityOpt: ['no-new-privileges'],
      ReadonlyRootfs: true,
      Tmpfs: {
        '/tmp': 'size=64m,mode=755',
        '/work': `exec,mode=1777,size=${kind.diskGb}g`,
        ...(kind.sockets ? { '/cache': `mode=1777,size=${Math.max(1, Math.floor(kind.memoryGb / 4))}g` } : {}),
      },
      NanoCpus: Math.round(kind.cpus * 1e9),
      Memory: Math.round(kind.memoryGb * 2 ** 30),
      PidsLimit: 4096,
      Binds: [`${VOLUME}:/state`],
      ...(kind.gpus ? { DeviceRequests: [{ Driver: '', Count: -1, Capabilities: [['gpu']] }] } : {}),
    },
  };
}

async function pull(image) {
  if (await docker('GET', `/images/${encodeURIComponent(image)}/json`)) return;
  log(`pulling ${image}`);
  // (one pinned by its digest goes whole)
  const [name, tag = 'latest'] = image.includes('@') ? [image, ''] : image.split(/:(?=[^/:]+$)/);
  await docker(
    'POST',
    `/images/create?fromImage=${encodeURIComponent(name)}${tag ? `&tag=${encodeURIComponent(tag)}` : ''}`,
    undefined,
    await signIn(image),
  );
  if (!(await docker('GET', `/images/${encodeURIComponent(image)}/json`))) throw new Error(`${image} didn't pull`);
}

// Docker's sign-in for a kind's image on a private registry, from HQ for this pull alone, never kept (runs.ts pullAuth).
// The manager's own image is public.
async function signIn(image) {
  if (image === IMAGE) return {};
  const res = await fetch(`${HQ_URL}/api/helper/pull`, {
    method: 'POST',
    redirect: 'error',
    headers: { authorization: `Bearer ${key()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ image }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`HQ said ${res.status} to pulling ${image}`);
  const { auth } = await res.json();
  return auth ? { 'X-Registry-Auth': auth } : {};
}

// The container `name` as `spec` says, its spec's hash on a label: one with another hash goes, unless `keep` (a run)
async function ensure(name, spec, keep = false) {
  const want = hash(spec);
  const have = await docker('GET', `/containers/${name}/json`);
  if (have?.Config?.Labels?.['hq.spec'] === want) {
    if (!have.State.Running) await docker('POST', `/containers/${name}/start`);
    return;
  }
  if (have && keep) return log(`${name}: waits for its run to end before it changes`);
  await pull(spec.Image);
  if (have) await docker('DELETE', `/containers/${name}?force=true`);
  await docker('POST', `/containers/create?name=${name}`, { ...spec, Labels: { 'hq.spec': want, 'hq.manager': NAME } });
  await docker('POST', `/containers/${name}/start`);
  log(`${name}: ${have ? 'updated' : 'started'}`);
}

// The closed network a helper sits on: its kind's shared one, or its own when its kind keeps it alone
const networkOf = (kind, slot) => (kind.alone ? `${helperName(kind.name, slot)}-net` : NETWORK);

// A closed network (internal: no route out), with the proxy on it, which a new proxy container isn't yet
async function ensureNetwork(network) {
  const have = await docker('GET', `/networks/${network}`);
  if (!have)
    await docker('POST', '/networks/create', { Name: network, Internal: true, Labels: { 'hq.manager': NAME } });
  if (!Object.values(have?.Containers ?? {}).some(member => member.Name === PROXY))
    await docker('POST', `/networks/${network}/connect`, { Container: PROXY, EndpointConfig: { Aliases: [PROXY] } });
}

// The networks the manager made for this HQ, each with the names of the containers on it
async function networks() {
  const filters = encodeURIComponent(JSON.stringify({ label: [`hq.manager=${NAME}`] }));
  const listed = (await docker('GET', `/networks?filters=${filters}`)) ?? [];
  return Promise.all(
    listed.map(async ({ Id, Name }) => ({
      id: Id,
      name: Name,
      members: Object.values((await docker('GET', `/networks/${Id}`))?.Containers ?? {}).map(member => member.Name),
    })),
  );
}

const key = () => (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, 'utf8').trim() : '');

// What HQ wants on this machine: its kinds, and which helpers here have a run ({ kind, slot })
async function setup() {
  const res = await fetch(`${HQ_URL}/api/helper/setup`, {
    method: 'POST',
    redirect: 'error',
    headers: { authorization: `Bearer ${key()}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`HQ said ${res.status} to the setup`);
  return res.json();
}

const SAFE = /^[a-z][a-z0-9-]{0,30}$/;
const helperName = (kind, slot) => `${NAME}-${kind}_${slot}`;

// The containers whose label names this HQ's manager, and those an earlier start command made by hand for this HQ
async function ours() {
  const all = (await docker('GET', '/containers/json?all=true')) ?? [];
  const made = all.filter(c => c.Labels?.['hq.manager'] === NAME).map(c => c.Names[0].slice(1));
  const byHand = [];
  for (const c of all.filter(c => /^\/run-helper-[a-z]/.test(c.Names[0]) && !c.Labels?.['hq.manager'])) {
    const env = (await docker('GET', `/containers/${c.Id}/json`))?.Config?.Env ?? [];
    if (env.includes(`HQ_URL=${HQ_URL}`)) byHand.push(c.Names[0].slice(1));
  }
  return { made, byHand };
}

async function tick() {
  if (!key()) return log(`waiting for the key in ${KEY_FILE}`);
  const { kinds, busy = [] } = await setup();
  await ensure(PROXY, proxySpec());
  const wanted = new Set([MANAGER, PROXY]);
  const wantedNetworks = new Set();
  for (const kind of kinds) {
    if (!SAFE.test(kind.name) || typeof kind.image !== 'string') {
      log(`left out a kind HQ named oddly: ${kind.name}`);
      continue;
    }
    for (let slot = 1; slot <= Math.max(1, Number(kind.helpers) || 1); slot++) {
      const name = helperName(kind.name, slot);
      wanted.add(name);
      wantedNetworks.add(networkOf(kind, slot));
      const running = busy.some(one => one.kind === kind.name && one.slot === slot);
      await ensureNetwork(networkOf(kind, slot))
        .then(() => ensure(name, helperSpec(kind, slot), running))
        .catch(error => log(`${name}: ${error.message}`));
    }
  }
  // helpers of kinds HQ no longer has, and ones an old start command made by hand, go
  const { made, byHand } = await ours();
  for (const name of [...made.filter(name => !wanted.has(name)), ...byHand]) {
    await docker('DELETE', `/containers/${name}?force=true`);
    log(`${name}: removed (no such helper at HQ now)`);
  }
  // networks no helper sits on now go, once a helper still finishing its run on one has left it
  for (const network of await networks()) {
    if (wantedNetworks.has(network.name) || network.members.some(member => member !== PROXY)) continue;
    if (network.members.length)
      await docker('POST', `/networks/${network.id}/disconnect`, { Container: PROXY, Force: true });
    await docker('DELETE', `/networks/${network.id}`);
  }
}

// The manager's own container, from the code that started this (the old one replaced), with the key if the command
// carries one
async function install() {
  if (process.env.HELPER_KEY) {
    writeFileSync(`${KEY_FILE}.new`, `${process.env.HELPER_KEY}\n`, { mode: 0o600 });
    renameSync(`${KEY_FILE}.new`, KEY_FILE);
  }
  if (!BOOTSTRAP) throw new Error('run me from the install command');
  await pull(IMAGE);
  await docker('DELETE', `/containers/${MANAGER}?force=true`);
  await docker('POST', `/containers/create?name=${MANAGER}`, {
    Image: IMAGE,
    User: '0:0',
    Entrypoint: ['node'],
    Cmd: ['-e', BOOTSTRAP],
    Env: withEnv({ HQ_URL, ...(HQ_PRIVATE ? { HQ_PRIVATE: 1 } : {}) }),
    Labels: { 'hq.manager': NAME },
    HostConfig: {
      RestartPolicy: { Name: 'unless-stopped' },
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': 'size=16m' },
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      Binds: [`${SOCKET}:/var/run/docker.sock`, `${VOLUME}:/state`],
    },
  });
  await docker('POST', `/containers/${MANAGER}/start`);
  console.log(`Installed. The manager keeps this machine's helpers in step with ${HQ_URL} from now on.`);
}

// Everything the manager made for this HQ, itself and its key included
async function remove() {
  const { made, byHand } = await ours();
  for (const name of [...made, ...byHand]) await docker('DELETE', `/containers/${name}?force=true`);
  for (const network of await networks()) await docker('DELETE', `/networks/${network.id}`);
  await docker('DELETE', `/volumes/${VOLUME}`);
  console.log(`Removed this machine's helpers for ${HQ_URL}, and its key.`);
}

if (process.env.MANAGER === 'install') await install();
else if (process.env.MANAGER === 'remove') await remove();
else {
  log(`Manager started for ${HQ_URL}, helpers reach only ${ALLOWED.join(', ')}`);
  for (;;) {
    await tick().catch(error => log(`not in step yet: ${error.message}`));
    await new Promise(resolve => setTimeout(resolve, TICK_MS));
  }
}
