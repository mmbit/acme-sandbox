import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Docker's Engine API as the manager uses it, on a Unix socket: containers and networks by name, each container on
// the networks its NetworkMode and connects put it on
function playedDocker(socket) {
  const containers = new Map();
  const networks = new Map();
  const network = key => networks.get(key) ?? [...networks.values()].find(one => one.Id === key);
  const join = (net, name) => (net.Containers[`${name}-id`] = { Name: name });
  const answer = (res, status, body = {}) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    const url = new URL(req.url.replace(/^\/v1\.43/, ''), 'http://docker');
    const [, what, name, action] = url.pathname.split('/').map(decodeURIComponent);
    if (what === 'images') return answer(res, 200);
    if (what === 'containers' && name === 'json')
      return answer(
        res,
        200,
        [...containers].map(([one, c]) => ({ Names: [`/${one}`], Labels: c.Config.Labels })),
      );
    if (what === 'containers' && name === 'create') {
      const made = url.searchParams.get('name');
      containers.set(made, { Config: { Labels: body.Labels, Env: body.Env ?? [] }, spec: body, State: {} });
      if (body.HostConfig?.NetworkMode) join(network(body.HostConfig.NetworkMode), made);
      return answer(res, 201);
    }
    if (what === 'containers') {
      const c = containers.get(name);
      if (!c) return answer(res, 404);
      if (req.method === 'GET') return answer(res, 200, c);
      if (action === 'start') c.State.Running = true;
      if (req.method === 'DELETE') {
        containers.delete(name);
        for (const net of networks.values()) delete net.Containers[`${name}-id`];
      }
      return answer(res, 204);
    }
    if (!name) {
      const label = JSON.parse(url.searchParams.get('filters')).label[0].split('=');
      return answer(
        res,
        200,
        [...networks.values()].filter(net => net.Labels[label[0]] === label[1]).map(({ Id, Name }) => ({ Id, Name })),
      );
    }
    if (name === 'create') {
      networks.set(body.Name, { ...body, Id: `${body.Name}-id`, Containers: {} });
      return answer(res, 201);
    }
    const net = network(name);
    if (!net) return answer(res, 404);
    if (req.method === 'GET') return answer(res, 200, net);
    if (action === 'connect') join(net, body.Container);
    if (action === 'disconnect') delete net.Containers[`${body.Container}-id`];
    if (req.method === 'DELETE') {
      if (Object.keys(net.Containers).length) return answer(res, 403, { message: 'has active endpoints' });
      networks.delete(net.Name);
    }
    return answer(res, 200);
  });
  return { server: server.listen(socket), containers, networks };
}

test('a kind that keeps its helpers alone gets a network for each, with the proxy alone beside it; the others share theirs, and a network no helper needs goes', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'manager-'));
  const docker = playedDocker(join(dir, 'docker.sock'));
  t.after(() => docker.server.close());
  let setups = 0;
  const hq = http
    .createServer((req, res) => {
      setups++;
      res.end(
        JSON.stringify({
          kinds: [
            {
              name: 'tests',
              image: 'tests:1',
              cpus: 1,
              memoryGb: 4,
              diskGb: 1,
              helpers: 2,
              sockets: true,
              alone: false,
            },
            {
              name: 'model',
              image: 'model:1',
              cpus: 1,
              memoryGb: 4,
              diskGb: 1,
              helpers: 1,
              sockets: true,
              alone: true,
            },
          ],
          busy: [],
        }),
      );
    })
    .listen(0, '127.0.0.1');
  t.after(() => hq.close());
  await new Promise(resolve => hq.once('listening', resolve));
  const { port } = hq.address();
  const name = `127-0-0-1-${port}`;
  writeFileSync(join(dir, 'key'), 'helper_key\n');
  // as an older manager left it: every helper on the one network, and one of a kind HQ no longer has on its own
  const labels = { 'hq.manager': name };
  docker.networks.set(`${name}-net`, { Name: `${name}-net`, Id: 'shared-id', Labels: labels, Containers: {} });
  docker.networks.set(`${name}-gone_1-net`, {
    Name: `${name}-gone_1-net`,
    Id: 'gone-id',
    Labels: labels,
    Containers: {},
  });
  docker.containers.set(`${name}-model_1`, { Config: { Labels: { ...labels, 'hq.spec': 'old' } }, State: {} });
  docker.networks.get(`${name}-net`).Containers[`${name}-model_1-id`] = { Name: `${name}-model_1` };
  docker.networks.get(`${name}-gone_1-net`).Containers[`${name}-proxy-id`] = { Name: `${name}-proxy` };

  const manager = spawn(process.execPath, [join(import.meta.dirname, 'manager.mjs')], {
    env: {
      PATH: process.env.PATH,
      HQ_URL: `http://127.0.0.1:${port}`,
      DOCKER_SOCKET: join(dir, 'docker.sock'),
      KEY_FILE: join(dir, 'key'),
      TICK_MS: '100',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => manager.kill());
  let said = '';
  manager.stdout.on('data', chunk => (said += chunk));
  // (its second setup: the first tick has ended)
  while (setups < 2) await new Promise(resolve => setTimeout(resolve, 20));

  const members = net =>
    Object.values(docker.networks.get(net)?.Containers ?? {})
      .map(member => member.Name)
      .sort();
  const model = docker.containers.get(`${name}-model_1`);
  assert.equal(model.spec.HostConfig.NetworkMode, `${name}-model_1-net`);
  assert.ok(model.Config.Env.includes('HELPER_ALONE=1'), 'it tells HQ so');
  assert.equal(docker.networks.get(`${name}-model_1-net`).Internal, true);
  assert.deepEqual(members(`${name}-model_1-net`), [`${name}-model_1`, `${name}-proxy`], 'the proxy alone beside it');
  assert.deepEqual(members(`${name}-net`), [`${name}-proxy`, `${name}-tests_1`, `${name}-tests_2`]);
  for (const slot of [1, 2])
    assert.ok(!docker.containers.get(`${name}-tests_${slot}`).Config.Env.includes('HELPER_ALONE=1'));
  assert.equal(docker.networks.get(`${name}-gone_1-net`), undefined, 'the proxy let off it, and it went');
  assert.doesNotMatch(said, /not in step/, said);
});
