#!/usr/bin/env python3
"""python3 infra/test_provision.py: provision.sh names the Hetzner firewall for its server.

The fixed name "web" would have two companies in one Hetzner project share one firewall. provision.sh runs for an
existing server against a fake Hetzner API: a curl on PATH that answers from a JSON file of servers and firewalls.
It also holds every call to a time limit, and the wait on an action (hetzner.sh, shared with resize.sh) to Hetzner's own
error or no reply. resize.sh runs against the same fake: an action Hetzner
failed moves it on to the next type, one whose outcome is unknown stops it with the server off.
It needs the real jq provision.sh runs on (the worker's image has it); without one it skips.
"""
import json, os, shutil, subprocess, tempfile, unittest

here = os.path.dirname(os.path.abspath(__file__))
FAKE_CURL = r'''#!/usr/bin/env python3
import json, os, sys, urllib.parse
args, method, body, url, timed, i = sys.argv[1:], 'GET', None, None, False, 0
while i < len(args):
    if args[i] == '-X': method = args[i + 1]; i += 1
    elif args[i] == '-d': body = json.loads(args[i + 1]); i += 1
    elif args[i] in ('-H', '--connect-timeout'): i += 1
    elif args[i] == '--max-time': timed = True; i += 1
    elif args[i].startswith('https://'): url = urllib.parse.urlparse(args[i])
    i += 1
state = json.load(open(os.environ['FAKE_HETZNER']))
path, query = url.path.removeprefix('/v1'), dict(urllib.parse.parse_qsl(url.query))
servers, firewalls, out = state['servers'], state['firewalls'], {}
by_id = lambda rows: next(r for r in rows if r['id'] == int(path.split('/')[2]))
state['untimed'] += not timed
if method != 'GET':
    state['writes'] += 1
if method == 'GET' and path == '/servers':
    out = {'servers': [s for s in servers if s['name'] == query['name']]}
elif method == 'GET' and path == '/firewalls' and query['name'] in state['failing']:
    out = {'error': {'code': 'rate_limit_exceeded', 'message': 'limit of requests per hour reached'}}
elif method == 'GET' and path == '/firewalls':
    out = {'firewalls': [f for f in firewalls if f['name'] == query['name']]}
elif method == 'POST' and path == '/firewalls':
    firewalls.append({'id': 100 + len(firewalls), 'name': body['name'], 'rules': body['rules'], 'applied_to': []})
    out = {'firewall': firewalls[-1]}
elif method == 'PUT' and path.startswith('/firewalls/'):
    by_id(firewalls).update(body)
    out = {'firewall': by_id(firewalls)}
elif method == 'GET' and path.startswith('/servers/'):
    out = {'server': by_id(servers)}
elif method == 'GET' and path == '/server_types':
    out = {'server_types': [{'name': query['name'], 'disk': 160,
                             'prices': [{'location': 'nbg1', 'price_monthly': {'gross': '20.0000'}}]}]}
elif method == 'POST' and '/actions/' in path:
    # the action as the test names it ("change_type cx43"): it ends as 'ends' says, success by default
    command = ' '.join([path.split('/')[-1]] + ([body['server_type']] if body and 'server_type' in body else []))
    state['calls'].append(command)
    if command == 'apply_to_resources':
        for r in body['apply_to']:
            by_id(firewalls)['applied_to'].append(r)
            next(s for s in servers if s['id'] == r['server']['id'])['public_net']['firewalls'].append({'id': by_id(firewalls)['id']})
    else:
        target = by_id(servers)
        if command.startswith('change_type'):
            target['server_type']['name'] = body['server_type']
            target['primary_disk_size'] = 160 if body['upgrade_disk'] else target['primary_disk_size']
        target['status'] = 'running' if command == 'poweron' else 'off'
    action = {'id': len(state['actions']) + 1, 'command': command, 'status': 'running', 'error': None}
    state['actions'].append(dict(action, **state['ends'].get(command, {'status': 'success'})))
    out = {'actions': [action]} if command == 'apply_to_resources' else {'action': action}
elif method == 'GET' and path.startswith('/actions/'):
    action = state['actions'][int(path.split('/')[2]) - 1]
    state['lookups'] += 1
    if 'actions-hang' in state['failing'] or 'hang ' + action['command'] in state['failing']:
        json.dump(state, open(os.environ['FAKE_HETZNER'], 'w'))
        sys.exit('curl: (28) Operation timed out after 30000 milliseconds with 0 bytes received')
    elif 'actions' in state['failing']:
        out = {'error': {'code': 'rate_limit_exceeded', 'message': 'limit of requests per hour reached'}}
    else:
        out = {'action': action}
json.dump(state, open(os.environ['FAKE_HETZNER'], 'w'))
print(json.dumps(out))
'''
OLD_RULES = [{'direction': 'in', 'protocol': 'tcp', 'port': '443', 'source_ips': ['192.0.2.0/24']}]


def server(id, name, firewalls, type='cx33'):
    return {'id': id, 'name': name, 'backup_window': '22-02', 'server_type': {'name': type},
            'location': {'name': 'nbg1'}, 'status': 'running', 'primary_disk_size': 80,
            'public_net': {'ipv4': {'ip': '192.0.2.1'}, 'firewalls': [{'id': f} for f in firewalls]}}


def firewall(id, name, servers):
    return {'id': id, 'name': name, 'rules': OLD_RULES,
            'applied_to': [{'type': 'server', 'server': {'id': s}} for s in servers]}


@unittest.skipUnless(shutil.which('jq'), 'needs jq on PATH, as provision.sh does')
class FakeHetzner(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='provision-test-')
        bin_dir = os.path.join(self.tmp.name, 'bin')
        os.mkdir(bin_dir)
        with open(os.path.join(bin_dir, 'curl'), 'w') as f:
            f.write(FAKE_CURL)
        os.chmod(os.path.join(bin_dir, 'curl'), 0o755)
        env_file = os.path.join(self.tmp.name, 'infra.env')
        with open(env_file, 'w') as f:
            f.write('SERVER_NAME=testco\nSERVER=testco-1\n')
        self.state_file = os.path.join(self.tmp.name, 'hetzner.json')
        jq_dir = os.path.dirname(shutil.which('jq'))
        self.env = {'PATH': f'{bin_dir}:{jq_dir}:/usr/bin:/bin', 'INFRA_ENV': env_file, 'FAKE_HETZNER': self.state_file,
                    'HCLOUD_TOKEN': 'test'}

    def tearDown(self):
        self.tmp.cleanup()

    def run_script(self, script, servers, firewalls, failing=(), ends={}):
        with open(self.state_file, 'w') as f:
            json.dump({'servers': servers, 'firewalls': firewalls, 'failing': list(failing), 'writes': 0, 'untimed': 0, 'actions': [],
                       'ends': ends, 'calls': [], 'lookups': 0}, f)
        run = subprocess.run(['bash', script], env=self.env, capture_output=True, text=True)
        with open(self.state_file) as f:
            state = json.load(f)
        self.assertEqual(state['untimed'], 0, 'every Hetzner call has a time limit')
        return run, state


class FirewallNamedForItsServer(FakeHetzner):
    def run_provision(self, servers, firewalls, failing=(), ends={}):
        return self.run_script(os.path.join(here, 'provision.sh'), servers, firewalls, failing, ends)

    def provision(self, servers, firewalls):
        run, state = self.run_provision(servers, firewalls)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        return state, {f['name']: f for f in state['firewalls']}

    def guarding(self, state, server_id):
        return [f['id'] for f in next(s for s in state['servers'] if s['id'] == server_id)['public_net']['firewalls']]

    def test_a_firewall_named_for_the_server_is_kept_as_it_is(self):
        state, firewalls = self.provision([server(1, 'testco-1', [7])], [firewall(7, 'testco', [1])])
        self.assertEqual(state['writes'], 0)
        self.assertEqual(list(firewalls), ['testco'])

    def test_an_old_web_firewall_guarding_this_server_alone_is_renamed_and_keeps_its_rules(self):
        state, firewalls = self.provision([server(1, 'testco-1', [7])], [firewall(7, 'web', [1])])
        self.assertEqual(list(firewalls), ['testco'])
        self.assertEqual(firewalls['testco']['rules'], OLD_RULES)
        self.assertEqual(self.guarding(state, 1), [7])

    def test_a_web_firewall_another_server_shares_stays_and_this_server_gets_its_own(self):
        state, firewalls = self.provision([server(1, 'testco-1', [7]), server(2, 'acme-1', [7])], [firewall(7, 'web', [1, 2])])
        self.assertEqual(firewalls['web'], firewall(7, 'web', [1, 2]))
        self.assertEqual(self.guarding(state, 1), [7, firewalls['testco']['id']])
        self.assertEqual(self.guarding(state, 2), [7])
        self.assertEqual({r.get('port') for r in firewalls['testco']['rules']}, {'80', '443', None})

    def test_with_no_firewall_one_named_for_the_server_is_made_and_applied(self):
        state, firewalls = self.provision([server(1, 'testco-1', [])], [])
        self.assertEqual(list(firewalls), ['testco'])
        self.assertEqual(self.guarding(state, 1), [firewalls['testco']['id']])

    def test_an_apply_hetzner_fails_after_accepting_it_stops_the_run(self):
        failed = {'status': 'error', 'error': {'code': 'firewall_resource_not_found', 'message': 'server not found'}}
        run, state = self.run_provision([server(1, 'testco-1', [])], [], ends={'apply_to_resources': failed})
        self.assertNotEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn('::error::Could not apply the firewall testco to testco-1: server not found', run.stderr)
        self.assertNotIn('applied', run.stdout)

    def test_an_error_reply_to_an_action_lookup_stops_the_run_at_once(self):
        run, state = self.run_provision([server(1, 'testco-1', [])], [], failing=['actions'])
        self.assertNotEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn('::error::Could not apply the firewall testco to testco-1: no state for action 1: limit of requests',
                      run.stderr)
        self.assertNotIn('applied', run.stdout)

    def test_an_action_lookup_with_no_reply_stops_the_run(self):
        run, state = self.run_provision([server(1, 'testco-1', [])], [], failing=['actions-hang'])
        self.assertNotEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn('Operation timed out', run.stderr)
        self.assertIn('::error::Could not apply the firewall testco to testco-1: no reply about action 1', run.stderr)
        self.assertNotIn('applied', run.stdout)
        self.assertEqual(state['lookups'], 2, 'one more try of the lookup')

    def test_an_error_reply_to_a_firewall_lookup_stops_the_run_before_any_write(self):
        for name in ['testco', 'web']:
            with self.subTest(failing=name):
                run, state = self.run_provision([server(1, 'testco-1', [7])], [firewall(7, 'web', [1])], failing=[name])
                self.assertNotEqual(run.returncode, 0, run.stdout + run.stderr)
                self.assertIn(f'::error::Could not look up the firewall {name}: limit of requests', run.stderr)
                self.assertEqual(state['writes'], 0)


class ResizeStopsOnAnUnknownOutcome(FakeHetzner):
    """resize.sh with the board's types cx43 cpx42 cpx41: a copy of it, with its own server-type and server-disk."""

    def run_resize(self, servers, disk='keep', failing=(), ends={}, cap='MAX_EUR=35\n'):
        with open(self.env['INFRA_ENV'], 'a') as f:
            f.write(cap)
        infra = os.path.join(self.tmp.name, 'infra')
        os.makedirs(infra, exist_ok=True)
        for name in ['resize.sh', 'hetzner.sh', 'infra-env.sh']:
            shutil.copy(os.path.join(here, name), infra)
        with open(os.path.join(infra, 'server-type'), 'w') as f:
            f.write('cx43 cpx42 cpx41\n')
        with open(os.path.join(infra, 'server-disk'), 'w') as f:
            f.write(disk + '\n')
        return self.run_script(os.path.join(infra, 'resize.sh'), servers, [], failing, ends)

    def test_a_type_hetzner_failed_moves_on_to_the_next(self):
        failed = {'status': 'error', 'error': {'code': 'server_type_unavailable', 'message': 'cx43 is sold out here'}}
        run, state = self.run_resize([server(1, 'testco-1', [])], ends={'change_type cx43': failed})
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertEqual(state['calls'], ['shutdown', 'change_type cx43', 'change_type cpx42', 'poweron'])
        self.assertIn('testco-1 is now a cpx42 and running', run.stdout)

    def test_a_type_change_with_no_reply_about_it_stops_with_the_server_off(self):
        run, state = self.run_resize([server(1, 'testco-1', [])], failing=['hang change_type cx43'])
        self.assertEqual(run.returncode, 2, run.stdout + run.stderr)
        self.assertEqual(state['calls'], ['shutdown', 'change_type cx43'])
        self.assertIn('::error::Could not make testco-1 a cx43: no reply about action 2', run.stderr)
        self.assertIn('::error::Stopped with testco-1 off', run.stderr)

    def test_a_disk_growth_with_no_reply_about_it_stops_with_the_server_off(self):
        run, state = self.run_resize([server(1, 'testco-1', [], type='cx43')], disk='grow',
                                     failing=['hang change_type cx43'])
        self.assertEqual(run.returncode, 2, run.stdout + run.stderr)
        self.assertEqual(state['calls'], ['shutdown', 'change_type cx43'])
        self.assertIn('::error::Could not grow the disk of testco-1: no reply about action 2', run.stderr)
        self.assertNotIn("didn't grow", run.stdout)

    def test_every_type_over_the_cap_is_skipped(self):
        run, state = self.run_resize([server(1, 'testco-1', [])], cap='MAX_EUR=19.5\n')
        self.assertEqual(state['calls'], [])
        self.assertIn('cx43: not offered here or over the cap (20.0000)', run.stdout)

    def test_no_cap_in_company_infra_env_changes_nothing(self):
        for cap in ('', 'MAX_EUR=lots\n'):
            with self.subTest(cap=cap):
                run, state = self.run_resize([server(1, 'testco-1', [])], cap=cap)
                self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
                self.assertEqual(state['lookups'] + len(state['calls']), 0)
                self.assertIn('::error::company/infra.env has no MAX_EUR', run.stderr)


if __name__ == '__main__':
    unittest.main()
