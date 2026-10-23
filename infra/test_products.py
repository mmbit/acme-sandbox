#!/usr/bin/env python3
"""python3 infra/test_products.py: runs products.py on made-up products in a throwaway folder (no real keys).

Checks that going live needs the board's approval record, that live keys and live payments follow it, that a live site
has no preview login or review mode, and that the Stripe key itself never reaches a product. A site-only approval
(site:<slug>) puts the site up with ordering closed: public, but no payments and no partner keys at all.
Also: each product on a network of its own that only Caddy joins (L5), keys taken literally (L6), and nothing from a
manifest that Compose would expand. With DOCKER_COMPOSE=/path/to/docker-compose (the standalone release binary, no
daemon needed) it checks the last two in Compose's own rendering too. The deploy command exports the filtered shared
context without Docker. With DOCKER_BUILDS=1 it also copies that context into a consumer image using Docker BuildKit.
The support chat: its route and tokens for products with `care: true` only, its
service's keys in that service's env file alone, and its service on a network no product shares. The service is built
from the platform's engine (platform/care/Dockerfile, the repo's root as context), with its cookie's name in CARE_COOKIE,
and every other product from its own app/, with the repo's kits/ and shared/ and its own folder as named contexts. Its
shops: X-Care-Shop on every chat route, each shop's apps in CARE_SHOPS, and the front's own chat,
which has no orders.
The server's sync: saving a Print API or chat key redeploys, any other key doesn't.
The shop's dated offers: the file the front's manifest names, to every other product as SHOP_OFFERS, never from outside
the front's folder.
A public product's preview door: a test-mode container of its own, its keys and tokens apart from the public one's, and
its env file gone with it.
A product's own keys (needs.keys): made once per mode, kept, rotated only by a raised generation into the ring, and never
in the log.
"""
import base64, hashlib, hmac, json, os, re, shutil, subprocess, sys, tempfile, yaml

here = os.path.dirname(os.path.abspath(__file__))
tmp = tempfile.mkdtemp(prefix='products-test-')
root, data, envs = os.path.join(tmp, 'repo'), os.path.join(tmp, 'hqdata'), os.path.join(tmp, 'env')
os.makedirs(os.path.join(root, 'infra'))
shutil.copy(os.path.join(here, 'products.py'), os.path.join(root, 'infra'))
shutil.copy(os.path.join(here, 'company.py'), os.path.join(root, 'infra'))
shutil.copy(os.path.join(here, 'run_helpers.py'), os.path.join(root, 'infra'))
os.makedirs(os.path.join(root, 'company'))
open(os.path.join(root, 'company', 'infra.env'), 'w').write('SERVER_NAME=testco\nSERVER=testco-1\nBACKUP_BUCKET=testco-backups\nCARE_COOKIES=natter,__Host-natter\n')   # a test company's
os.makedirs(os.path.join(data, 'secrets'))
os.makedirs(os.path.join(data, 'approvals'))
for k, v in {'PRINTAPI_TEST_CLIENT_ID': 'test-id', 'PRINTAPI_LIVE_CLIENT_ID': 'LIVE-ID', 'STRIPE_TEST_RESTRICTED_KEY': 'rk_test_x',
             'STRIPE_LIVE_RESTRICTED_KEY': 'rk_live_SECRET', 'ANTHROPICEVAL_TEST_API_KEY': 'eval-key'}.items():
    open(os.path.join(data, 'secrets', k), 'w').write(v)
with open(os.path.join(root, 'company', 'org.yaml'), 'w') as f:
    yaml.safe_dump({'company': {'timeZone': 'Europe/Lisbon'}}, f)
subprocess.run(['node', os.path.join(here, '..', 'platform', 'coordinator', 'src', 'clock.ts')],
               env={**os.environ, 'REPO_DIR': root, 'DATA_DIR': data}, check=True)

# the chat's engine in the platform: the service is built from it, not from a products/care/app
care_dockerfile = os.path.join(root, 'platform', 'care', 'Dockerfile')
os.makedirs(os.path.dirname(care_dockerfile))
open(care_dockerfile, 'w').write('FROM scratch\n')

def product(slug, **manifest):
    d = os.path.join(root, 'products', slug, 'app')
    os.makedirs(d, exist_ok=True)
    open(os.path.join(d, 'Dockerfile'), 'w').write('FROM scratch\n')
    yaml.safe_dump(manifest, open(os.path.join(root, 'products', slug, 'product.yaml'), 'w'))

def run(hq_data=data, build_shared=False, host='hq.company.test', said=None):
    env = {**os.environ, 'PUBLIC_HOST': host, 'HQ_DATA': hq_data, 'PRODUCT_ENV_DIR': envs}
    env.pop('SECRETS_DIR', None)
    r = subprocess.run([sys.executable, os.path.join(root, 'infra', 'products.py'),
                        *(['--build-shared'] if build_shared else [])], env=env, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    if said is not None:   # (what it printed)
        said.append(r.stdout)
    gen = os.path.join(root, 'infra', 'generated')
    return yaml.safe_load(open(os.path.join(gen, 'products.yaml'))), open(os.path.join(gen, 'products.caddy')).read(), r.stderr

def envfile(slug):
    p = os.path.join(envs, f'{slug}.env')
    lines = [l.rstrip('\n').split('=', 1) for l in open(p)] if os.path.exists(p) else []
    assert all(len(v) >= 2 and v[0] == v[-1] == "'" for _, v in lines), f'{slug}.env: a value is not single-quoted (L6)'
    return {k: v[1:-1] for k, v in lines}

def keys_only_for_counting(slug):
    """A product with nothing to pay or print with still counts for HQ's Numbers: its env file holds only METRICS_*."""
    return all(k.startswith('METRICS_') for k in envfile(slug))

def test_payments_only(slug):
    """The preview container of a public product that only takes payments: counting, and a test-mode payments token
."""
    e = envfile(f'{slug}@preview')
    return e.get('PAYMENTS_MODE') == 'test' and e.get('PAYMENTS_TOKEN') == hmac.new(key.encode(), f'pay:{slug}:test'.encode(), hashlib.sha256).hexdigest() \
        and all(k.startswith(('METRICS_', 'PAYMENTS_')) for k in e)

unshelved = lambda block: re.sub(r'\n\thandle_path /.*?\n\t}\n', '\n', block, flags=re.S)   # a host's own routes only

def site(caddy, host):
    start = caddy.index(host + ' {') if host + ' {' in caddy else caddy.index(host + ', ')
    return caddy[start:caddy.index('\n}\n', start)]

def shelf(caddy, host, slug):
    """A product's path in a host's site (www's, or the front's preview door), or ''."""
    block, head = site(caddy, host), f'\thandle_path /{slug}/* {{'
    return block[block.index(head):block.index('\n\t}\n', block.index(head))] if head in block else ''

failures = 0
def check(what, ok):
    global failures
    print(('ok   ' if ok else 'FAIL ') + what)
    failures += not ok

product('pebblet', status='live', domain='pebblet.company.test', partner_env='live', needs={'secrets': ['printapi', 'stripe', 'anthropiceval']})
product('hello', status='preview', partner_env='live', needs={'secrets': ['printapi', 'stripe', 'github']})
product('hq', status='live')
product('sneaky', status='live', domain='x.test {\n\trespond 200\n}', needs={'secrets': ['stripe']})
product('freebie', status='live', partner_env='live', needs={'secrets': ['printapi']})
product('halfway', status='live', partner_env='test', needs={'secrets': ['printapi', 'stripe']})
live_one = dict(status='live', partner_env='live', needs={'secrets': ['stripe']})
product('grabby', domain='pebblet.company.test', **live_one)   # another product's standard address
product('apex', domain='company.test', **live_one)
product('plum', domain='plum.shop', **live_one)
product('kiwi', domain='shared.shop', **live_one)
product('lime', status='preview', domain='shared.shop')          # names kiwi's domain too: nobody gets it
product('sprout', status='live', partner_env='live', domain='sprout.shop', needs={'secrets': ['printapi', 'stripe']})
product('shy', status='preview', needs={'secrets': ['printapi', 'stripe']})
product('front', status='live', partner_env='test', needs={'secrets': ['stripe']},   # our front door (www and the bare domain),
        script_floor='report-only')                                                   # its script rule only reported
product('wwwgrab', domain='www.company.test', **live_one)                    # tries to take www itself
# Site blocks without the generated header.
siteBlocks = lambda caddy: caddy.split('\n', 1)[1].split('\n\n')
apex_site = lambda caddy: next((b for b in siteBlocks(caddy) if b.lstrip('\n').startswith(('company.test {', 'company.test, '))), None)

# 1. nobody approved anything: everything stays a preview on test partners
compose, caddy, log = run()
b, h = compose['services']['product-pebblet'], compose['services']['product-hello']
check('unapproved live product stays a preview', b['environment']['STATUS'] == 'preview' and 'pebblet.company.test {' not in caddy
      and 'pebblet.company.test,' not in caddy and 'forward_auth' in site(caddy, 'pebblet.preview.company.test'))
check('the deploy log says why', 'pebblet: wants to go live' in log and 'hello: wants to go live' in log)
check('unapproved partner_env live gets test partners', b['environment']['PARTNER_ENV'] == 'test' and h['environment']['PARTNER_ENV'] == 'test'
      and envfile('pebblet').get('PRINTAPI_CLIENT_ID') == 'test-id' and envfile('pebblet')['PRINTAPI_BASE_URL'].startswith('https://test.'))
e = envfile('pebblet')
key = open(os.path.join(data, 'payments.key')).read().strip()
check('stripe gives a test payments token, never a Stripe key', e.get('PAYMENTS_MODE') == 'test' and e.get('PAYMENTS_URL') == 'https://hq.company.test'
      and e.get('PAYMENTS_TOKEN') == hmac.new(key.encode(), b'pay:pebblet:test', hashlib.sha256).hexdigest()
      and not any('STRIPE' in k or v.startswith('rk_') for k, v in e.items()))
check('anthropiceval on test partners: the test model key under its stack name',
      e.get('ANTHROPICEVAL_API_KEY') == 'eval-key' and not any('_TEST_' in k for k in e))
check('unknown tools are ignored', not any(k.startswith('GITHUB') for k in envfile('hello')))
check("every product container gets HQ's origin for its preview framing policy",
      all(svc['environment'].get('HQ_ORIGIN') == 'https://hq.company.test' for n, svc in compose['services'].items() if n.startswith(('product-', 'preview-'))))
check('reserved slug hq is skipped', 'product-hq' not in compose['services'])
check('previews keep their shop open (test partners)', b['environment']['SHOP'] == 'open' and 'sprout.shop' not in caddy)
check('front not approved: a preview, no www, no bare domain', compose['services']['product-front']['environment']['STATUS'] == 'preview'
      and 'www.company.test' not in caddy and apex_site(caddy) is None and 'front.company.test' not in caddy.replace('front.preview.', ''))
check("front not approved: its one container lists its preview door's shelves, every product's",
      'hello' in compose['services']['product-front']['environment']['SHELVES'].split(','))
check('sprout starts as a preview with test keys', envfile('sprout').get('PRINTAPI_CLIENT_ID') == 'test-id')
check('nothing public: no preview container, one container behind each preview door',
      not any(n.startswith('preview-') for n in compose['services']) and not any(f.endswith('@preview.env') for f in os.listdir(envs)))

# 2. a file in the repo can't approve (HQ_DATA missing), and a malformed record doesn't count
os.makedirs(os.path.join(root, 'approvals'))
json.dump({'grant': 'live:pebblet'}, open(os.path.join(root, 'approvals', 'live-pebblet.json'), 'w'))
compose, caddy, _ = run(hq_data='')
check('no HQ_DATA: no approval, no payments token', compose['services']['product-pebblet']['environment']['STATUS'] == 'preview'
      and 'PAYMENTS_TOKEN' not in envfile('pebblet'))
json.dump({'grant': 'live:hello'}, open(os.path.join(data, 'approvals', 'live-pebblet.json'), 'w'))
json.dump({'grant': 'live:sprout'}, open(os.path.join(data, 'approvals', 'site-sprout.json'), 'w'))
compose, caddy, _ = run()
check("another product's grant doesn't count", compose['services']['product-pebblet']['environment']['STATUS'] == 'preview')
check("a site record naming another grant doesn't count", compose['services']['product-sprout']['environment']['STATUS'] == 'preview'
      and 'sprout.company.test {' not in caddy)
json.dump({'grant': 'site:sprout'}, open(os.path.join(root, 'approvals', 'site-sprout.json'), 'w'))
compose, _, _ = run(hq_data='')
check('no HQ_DATA: a site record in the repo does nothing', compose['services']['product-sprout']['environment']['STATUS'] == 'preview')

# 2b. the board approved Sprout's site only: public, ordering closed, nothing to pay or print with
json.dump({'grant': 'site:sprout', 'request': 31}, open(os.path.join(data, 'approvals', 'site-sprout.json'), 'w'))
json.dump({'grant': 'site:shy'}, open(os.path.join(data, 'approvals', 'site-shy.json'), 'w'))
compose, caddy, log = run()
sp, pub = compose['services']['product-sprout'], site(caddy, 'sprout.company.test')
check('site only: public, same Caddy rules as live, with its own domain', pub.startswith('sprout.company.test {')
      and site(caddy, 'sprout.shop').startswith('sprout.shop {')
      and 'forward_auth' not in pub and 'coordinator' not in pub and 'respond * "/* review mode: off */" 200' in pub
      and 'reverse_proxy product-sprout:8080' in pub)
check('site only: SHOP=closed, STATUS=live (the live guards fail every payment and Print API call), no partners',
      sp['environment']['SHOP'] == 'closed' and sp['environment']['STATUS'] == 'live' and sp['environment']['PARTNER_ENV'] == 'none')
check('site only: no payments token and no Print API keys, not even test ones (the old ones are gone)',
      keys_only_for_counting('sprout') and envfile('sprout').get('METRICS_MODE') == 'live')
check('site only: the deploy log says ordering is closed', 'sprout: wants to go live, but the board has not approved its launch: a public site with ordering closed' in log)
json.dump({'grant': 'site:front'}, open(os.path.join(data, 'approvals', 'site-front.json'), 'w'))
compose, caddy, _ = run()
fr, apex = site(caddy, 'www.company.test'), apex_site(caddy)
# www only, front.<zone> redirects with the bare domain
check('front, site approved: public at www only, like any public site', fr.startswith('www.company.test {')
      and 'forward_auth' not in fr and 'reverse_proxy product-front:8080' in fr and 'respond * "/* review mode: off */" 200' in fr
      and compose['services']['product-front']['environment']['SHOP'] == 'closed')
check("front, site approved: no payments token on www, a test one in the container behind its preview door",
      keys_only_for_counting('front') and test_payments_only('front'))
check('front, site approved: the bare domain and front.<zone> redirect every path to www, and do nothing else',
      apex.strip('\n') == 'company.test, front.company.test {\n\tredir https://www.company.test{uri} permanent\n}'
      and caddy.count('front.company.test') == 1)
check('front keeps the board\'s preview door', 'forward_auth' in site(caddy, 'front.preview.company.test'))
check('site only: the board keeps its preview door', 'reverse_proxy coordinator:8080' in site(caddy, 'sprout.preview.company.test'))
sh = compose['services']['product-shy']
check('a site approval without status: live does nothing', sh['environment']['STATUS'] == 'preview' and sh['environment']['SHOP'] == 'open'
      and 'shy.company.test' not in caddy and envfile('shy').get('PAYMENTS_MODE') == 'test')

# 3. the board approved Pebblet's launch
json.dump({'grant': 'live:pebblet', 'request': 30, 'approved': '2026-09-28T10:00:00Z'}, open(os.path.join(data, 'approvals', 'live-pebblet.json'), 'w'))
json.dump({'grant': 'live:sneaky'}, open(os.path.join(data, 'approvals', 'live-sneaky.json'), 'w'))
for slug in ['freebie', 'halfway', 'grabby', 'apex', 'plum', 'kiwi', 'wwwgrab']:
    json.dump({'grant': f'live:{slug}'}, open(os.path.join(data, 'approvals', f'live-{slug}.json'), 'w'))
compose, caddy, log = run()
b = compose['services']['product-pebblet']
live = site(caddy, 'pebblet.company.test')
check('approved: live status and live partners', b['environment']['STATUS'] == 'live' and b['environment']['PARTNER_ENV'] == 'live'
      and envfile('pebblet').get('PRINTAPI_CLIENT_ID') == 'LIVE-ID' and envfile('pebblet')['PRINTAPI_BASE_URL'].startswith('https://live.'))
check('approved: live payments token, still no Stripe key', envfile('pebblet').get('PAYMENTS_MODE') == 'live'
      and envfile('pebblet')['PAYMENTS_TOKEN'] == hmac.new(key.encode(), b'pay:pebblet:live', hashlib.sha256).hexdigest()
      and 'rk_live_SECRET' not in open(os.path.join(envs, 'pebblet.env')).read())
check('each product counts with a key for its own slug and mode: live for a public site, preview otherwise',
      envfile('pebblet').get('METRICS_TOKEN') == hmac.new(key.encode(), b'metrics:pebblet:live', hashlib.sha256).hexdigest()
      and envfile('pebblet')['METRICS_MODE'] == 'live' and envfile('pebblet')['METRICS_URL'] == 'https://hq.company.test'
      and envfile('hello').get('METRICS_TOKEN') == hmac.new(key.encode(), b'metrics:hello:preview', hashlib.sha256).hexdigest()
      and envfile('freebie').get('METRICS_MODE') == 'live' and envfile('freebie')['METRICS_PRODUCT'] == 'freebie')
check("each product counts its days on the company's clock", envfile('pebblet').get('METRICS_TIME_ZONE') == 'Europe/Lisbon')
os.rename(os.path.join(data, 'time-zone'), os.path.join(tmp, 'time-zone'))
unpublished = subprocess.run([sys.executable, os.path.join(root, 'infra', 'products.py')], capture_output=True, text=True,
                             env={**os.environ, 'PUBLIC_HOST': 'hq.company.test', 'HQ_DATA': data, 'PRODUCT_ENV_DIR': envs})
os.rename(os.path.join(tmp, 'time-zone'), os.path.join(data, 'time-zone'))
check("without the company's clock published, no product is given one: the deploy stops",
      unpublished.returncode != 0 and 'time-zone' in unpublished.stderr)
check('live site: no preview login, no review mode, nothing to the coordinator', 'forward_auth' not in live and 'coordinator' not in live
      and 'respond * "/* review mode: off */" 200' in live and 'reverse_proxy product-pebblet:8080' in live)
check('the board keeps its preview door with review mode', 'reverse_proxy coordinator:8080' in site(caddy, 'pebblet.preview.company.test'))
check('a live product counts nothing from the preview door: the door marks its requests, the public host strips the mark',
      'header_up X-Preview-Door 1' in site(caddy, 'pebblet.preview.company.test')
      and 'header_up -X-Preview-Door' in live and 'X-Preview-Door 1' not in live)
check('hello (not approved) still on test', compose['services']['product-hello']['environment']['PARTNER_ENV'] == 'test')
f = compose['services']['product-freebie']
check('approved but no stripe in needs.secrets: public with ordering closed, no partner keys, no stand-in checkout',
      f['environment']['STATUS'] == 'live' and f['environment']['SHOP'] == 'closed' and f['environment']['PARTNER_ENV'] == 'none'
      and keys_only_for_counting('freebie') and 'freebie.company.test {' in caddy and 'freebie: wants to go live, but it does not declare stripe' in log)
hw = compose['services']['product-halfway']
check('launch approved, status live but partner_env test: public site with ordering closed, no payments, no keys',
      hw['environment']['STATUS'] == 'live' and hw['environment']['SHOP'] == 'closed' and hw['environment']['PARTNER_ENV'] == 'none'
      and keys_only_for_counting('halfway') and 'halfway.company.test {' in caddy and 'halfway: wants to go live, but going live needs both' in log)
check('launch approved and complete: SHOP=open', b['environment']['SHOP'] == 'open')
check('site only is still closed after other launches', compose['services']['product-sprout']['environment']['SHOP'] == 'closed')
# the launch on top of the site approval: ordering opens
json.dump({'grant': 'live:sprout'}, open(os.path.join(data, 'approvals', 'live-sprout.json'), 'w'))
compose, caddy, _ = run()
sp = compose['services']['product-sprout']
check('site then launch: live partners, live payments, shop open', sp['environment']['SHOP'] == 'open' and sp['environment']['PARTNER_ENV'] == 'live'
      and envfile('sprout').get('PAYMENTS_MODE') == 'live' and envfile('sprout').get('PRINTAPI_CLIENT_ID') == 'LIVE-ID')
addresses = [h for line in caddy.splitlines() if line.endswith(' {') and not line.startswith(('\t', '#')) for h in line[:-2].split(', ')]
check('every host has exactly one site block', len(addresses) == len(set(addresses)))
check("a domain under our zone is refused (another product's address, the apex)", site(caddy, 'grabby.company.test').startswith('grabby.company.test {')
      and site(caddy, 'apex.company.test').startswith('apex.company.test {') and "grabby: ignoring domain 'pebblet.company.test'" in log)
check('no product claims www or the bare domain: only front has them', "wwwgrab: ignoring domain 'www.company.test'" in log
      and site(caddy, 'wwwgrab.company.test').startswith('wwwgrab.company.test {') and addresses.count('www.company.test') == 1
      and caddy.count('\ncompany.test, ') == 1)
check('a domain of its own is served, as a site of its own', site(caddy, 'plum.shop').startswith('plum.shop {'))
check('a domain two manifests name is served for neither', 'shared.shop' not in caddy and "kiwi: ignoring domain 'shared.shop'" in log)
check('a domain with Caddy syntax in it is refused', 'respond 200' not in caddy and "ignoring domain" in log)

# 3b. one address for the shop: every public product but the front is a shelf on
# www, its old address sends page loads there, and the front's preview door has every product as a shelf
product('engine', status='preview', platform=True)   # a piece of the platform: never a shelf
compose, caddy, log = run()
www, door = site(caddy, 'www.company.test'), site(caddy, 'front.preview.company.test')
public = ['apex', 'freebie', 'grabby', 'halfway', 'kiwi', 'pebblet', 'plum', 'sneaky', 'sprout', 'wwwgrab']
check('www: a shelf for each public product, none for a preview or the front itself',
      all(shelf(caddy, 'www.company.test', s) for s in public) and not any(shelf(caddy, 'www.company.test', s) for s in ['hello', 'shy', 'front'])
      and www.count('\thandle_path /') == len(public))
fresh = shelf(caddy, 'www.company.test', 'pebblet')
check('a shelf: the app told its prefix, no login, no review mode, the floor enforced',
      'header_up X-Forwarded-Prefix /pebblet' in fresh and 'reverse_proxy product-pebblet:8080' in fresh and 'forward_auth' not in fresh
      and 'respond * "/* review mode: off */" 200' in fresh and '\theader Content-Security-Policy "script-src \'self\'' in fresh
      and 'redir /pebblet /pebblet/{?query} permanent' in www)
plain = site(caddy, 'freebie.company.test')
check("the old address sends page loads to the shelf, path and query kept",
      'redir @page https://www.company.test/freebie{uri} permanent' in plain and 'redir @unmarked https://www.company.test/freebie{uri} permanent' in plain
      and 'header Sec-Fetch-Mode navigate' in plain and 'not path /api/* /__care/*' in plain and 'reverse_proxy product-freebie:8080' in plain
      and 'redir @' not in shelf(caddy, 'www.company.test', 'freebie'))
# a product with a domain of its own isn't served on the shop's origin, whose storage and service workers every shelf
# shares: its shelf and its old address send page loads there, the rest stays until it ends
old, own, moved = site(caddy, 'sprout.company.test'), site(caddy, 'sprout.shop'), shelf(caddy, 'www.company.test', 'sprout')
check("a product with its own domain: its old address sends page loads straight there, the domain stays its own",
      'redir @page https://sprout.shop{uri} permanent' in old and 'redir @unmarked https://sprout.shop{uri} permanent' in old
      and 'www.company.test/sprout' not in old and 'redir' not in own
      and 'reverse_proxy product-sprout:8080' in old and 'reverse_proxy product-sprout:8080' in own)
check("...and its shelf sends page loads there too, path and query kept; the rest stays, the shop still lists it",
      'redir @page https://sprout.shop{uri} permanent' in moved and 'redir @unmarked https://sprout.shop{uri} permanent' in moved
      and 'header Sec-Fetch-Mode navigate' in moved and 'not path /api/* /__care/*' in moved
      and 'reverse_proxy product-sprout:8080' in moved and 'header_up X-Forwarded-Prefix /sprout' in moved
      and 'sprout' in compose['services']['product-front']['environment']['SHELVES'].split(','))
# what the retiring worker does in a browser: products/carrel/app/domain-check.mjs
check("...and every worker script asked for there gets the retiring worker, at any scope its app gave it, "
      "where an app's own shelf and the door keep the app's",
      '@worker header Service-Worker script' in moved and 'handle @worker {' in moved and 'header Service-Worker-Allowed /' in moved
      and 'header !Service-Worker' in moved and '@worker' not in shelf(caddy, 'www.company.test', 'pebblet')
      and '@worker' not in shelf(caddy, 'front.preview.company.test', 'sprout'))
check("...but the front's preview door keeps it a shelf, behind the board's login",
      'redir @' not in shelf(caddy, 'front.preview.company.test', 'sprout') and 'redir @' not in site(caddy, 'front.preview.company.test')
      and 'reverse_proxy preview-sprout:8080' in shelf(caddy, 'front.preview.company.test', 'sprout'))
shelved = [s for s in compose['services'] if s.startswith('product-') and s not in ('product-front', 'product-engine', 'product-care')]
check("the front's preview door: every product a shelf behind the login, with review mode by its path (not the platform's own)",
      all(shelf(caddy, 'front.preview.company.test', s[len('product-'):]) for s in shelved) and door.count('\thandle_path /') == len(shelved)
      and all(f'handle /{s[len("product-"):]}/__review/* {{\n\t\treverse_proxy coordinator:8080' in door for s in shelved)
      and all('forward_auth coordinator:8080' in shelf(caddy, 'front.preview.company.test', s[len('product-'):]) for s in shelved)
      and 'header_up X-Preview-Door 1' in shelf(caddy, 'front.preview.company.test', 'hello'))
shelves = lambda name: compose['services'][name].get('environment', {}).get('SHELVES')
check("the front lists only its host's shelves: www's container the public products', its preview door's every product's",
      sorted(shelves('product-front').split(',')) == public and sorted(shelves('preview-front').split(',')) == sorted(s[len('product-'):] for s in shelved)
      and all(shelves(s) is None for s in compose['services'] if s not in ('product-front', 'preview-front')))
closedShelves = [s for s in public if compose['services'][f'product-{s}']['environment']['SHOP'] == 'closed']
check("...and www's container which of them take no orders yet",
      closedShelves == ['freebie', 'halfway', 'sneaky']
      and sorted(compose['services']['product-front']['environment']['SHELVES_CLOSED'].split(',')) == closedShelves
      and 'SHELVES_CLOSED' not in compose['services']['preview-front'].get('environment', {}))
look = lambda block, name: re.findall(rf'reverse_proxy (?:product|preview)-{name}:8080 {{\n\t+header_up X-Look (\w+)', block)
check("the look switch: next on every preview door, and on a public host only with the board's launch record",
      set(look(caddy, 'pebblet')) == {'next'} and set(look(www, 'sprout')) == {'next'} and set(look(site(caddy, 'freebie.company.test'), 'freebie')) == {'next'}
      and look(www, 'front') == ['today'] and look(door, 'front') == ['next'] and set(look(caddy, 'hello')) == {'next'})
json.dump({'grant': 'site:sprout'}, open(os.path.join(data, 'approvals', 'site-sprout.json'), 'w'))
os.remove(os.path.join(data, 'approvals', 'live-sprout.json'))
_, caddy2, _ = run()
check('the look switch: a site record alone keeps today on the public hosts, next on the preview door',
      set(look(site(caddy2, 'sprout.company.test'), 'sprout')) == {'today'} and set(look(shelf(caddy2, 'www.company.test', 'sprout'), 'sprout')) == {'today'}
      and set(look(site(caddy2, 'sprout.preview.company.test'), 'sprout')) == {'next'})
json.dump({'grant': 'live:sprout'}, open(os.path.join(data, 'approvals', 'live-sprout.json'), 'w'))
check('every way to a product sets the look, and the prefix only on a shelf (a client\'s copy never gets through)',
      len(re.findall('reverse_proxy (product|preview)-', caddy)) - len(re.findall('reverse_proxy product-care:8080', caddy)) == caddy.count('header_up X-Look ')
      == caddy.count('header_up -X-Forwarded-Prefix') + caddy.count('header_up X-Forwarded-Prefix /'))
floors = lambda block: block.count('header Content-Security-Policy "')   # one enforced policy in every floor
check('the floor: on every public site, every shelf and the front\'s door; nosniff and sandboxed SVG with it; not on other previews',
      floors(old) == floors(own) == 1 and floors(www) == len(public) + 1 and floors(door) == len(shelved) + 1
      and floors(site(caddy, 'hello.preview.company.test')) == 0
      and www.count('header X-Content-Type-Options nosniff') == www.count('+Content-Security-Policy sandbox') == len(public) + 1)
check("the floor: script_floor: report-only only reports the script rule on that product's own pages, the rest enforced there; all of it on the shelves",
      www.count('Content-Security-Policy-Report-Only "script-src \'self\'"') == www.count('Report-Only') == 1
      and door.count('Content-Security-Policy-Report-Only "script-src \'self\'"') == door.count('Report-Only') == 1
      and www.count('header Content-Security-Policy "object-src \'none\'; base-uri \'self\'"') == 1
      and door.count('header Content-Security-Policy "object-src \'none\'; base-uri \'self\'"') == 1
      and 'Report-Only' not in old)
product('front', status='live', partner_env='test', needs={'secrets': []})
_, enforced, _ = run()
product('front', status='live', partner_env='test', needs={'secrets': []}, script_floor='off')
_, unknown, warned = run()
check('the floor: enforced everywhere without script_floor, and with an unknown value (the deploy log says so)',
      'Report-Only' not in enforced and 'Report-Only' not in unknown and "front: unknown script_floor 'off', enforcing the floor" in warned
      and site(enforced, 'www.company.test').count('header Content-Security-Policy "') == len(public) + 1)
product('front', status='live', partner_env='test', needs={'secrets': []}, script_floor='report-only')

# 3c. a public product's preview door has a test-mode container of its own
compose, caddy, log = run()
svc, mac = compose['services'], lambda text: hmac.new(key.encode(), text.encode(), hashlib.sha256).hexdigest()
public_container, preview_container = svc['product-pebblet'], svc['preview-pebblet']
check('a live product: its public container live with the shop open, its preview container on test partners with the shop open',
      {k: public_container['environment'][k] for k in ('PRODUCT', 'STATUS', 'PARTNER_ENV', 'SHOP')}
      == {'PRODUCT': 'pebblet', 'STATUS': 'live', 'PARTNER_ENV': 'live', 'SHOP': 'open'}
      and {k: preview_container['environment'][k] for k in ('PRODUCT', 'STATUS', 'PARTNER_ENV', 'SHOP')}
      == {'PRODUCT': 'pebblet', 'STATUS': 'preview', 'PARTNER_ENV': 'test', 'SHOP': 'open'})
same = ('build', 'restart', 'mem_limit', 'cpus', 'logging', 'security_opt', 'cap_drop', 'read_only', 'tmpfs')
check('the preview container: the same image, memory and hardening, its own network, data volume and env file',
      all(preview_container[k] == public_container[k] for k in same) and preview_container['networks'] == ['preview-pebblet']
      and preview_container['volumes'] == ['preview-pebblet-data:/data'] and 'preview-pebblet-data' in compose['volumes']
      and preview_container['env_file'] == [os.path.join(envs, 'pebblet@preview.env')] and public_container['env_file'] == [os.path.join(envs, 'pebblet.env')]
      and preview_container['labels'] != public_container['labels'])
live_env, door_env = envfile('pebblet'), envfile('pebblet@preview')
check('the preview container: test payments, test partner keys and preview counting, nothing live',
      door_env.get('PAYMENTS_MODE') == 'test' and door_env.get('PAYMENTS_TOKEN') == mac('pay:pebblet:test')
      and door_env.get('PRINTAPI_CLIENT_ID') == 'test-id' and door_env['PRINTAPI_BASE_URL'].startswith('https://test.')
      and door_env.get('METRICS_MODE') == 'preview' and door_env.get('METRICS_TOKEN') == mac('metrics:pebblet:preview')
      and not any(v in open(os.path.join(envs, 'pebblet@preview.env')).read() for v in ('LIVE-ID', mac('pay:pebblet:live'), mac('metrics:pebblet:live'))))
check('anthropiceval live: no model key in the public container (no live name), the test one behind its preview door',
      not any(k.startswith('ANTHROPICEVAL') for k in live_env) and door_env.get('ANTHROPICEVAL_API_KEY') == 'eval-key')
check('the public container: nothing of test mode',
      live_env.get('PAYMENTS_MODE') == 'live' and live_env.get('PRINTAPI_CLIENT_ID') == 'LIVE-ID'
      and not any(v in open(os.path.join(envs, 'pebblet.env')).read() for v in ('test-id', mac('pay:pebblet:test'), mac('metrics:pebblet:preview'))))
ways = lambda block: set(re.findall(r'reverse_proxy ((?:product|preview)-[a-z]+):8080', block)) - {'product-care'}
check('its preview door and its shelf on the front\'s go to the preview container; www\'s shelf, its old address and its own domain to the public one',
      ways(site(caddy, 'pebblet.preview.company.test')) == {'preview-pebblet'}
      and ways(shelf(caddy, 'front.preview.company.test', 'pebblet')) == {'preview-pebblet'}
      and ways(shelf(caddy, 'www.company.test', 'pebblet')) == {'product-pebblet'} and ways(site(caddy, 'pebblet.company.test')) == {'product-pebblet'}
      and ways(site(caddy, 'sprout.shop')) == {'product-sprout'} and ways(shelf(caddy, 'www.company.test', 'sprout')) == {'product-sprout'}
      and ways(site(caddy, 'sprout.preview.company.test')) == {'preview-sprout'})
check("the front's preview door: its own pages from its preview container, www's from the public one",
      ways(unshelved(site(caddy, 'front.preview.company.test'))) == {'preview-front'} and ways(unshelved(site(caddy, 'www.company.test'))) == {'product-front'})
hw, door_hw = svc['product-halfway'], svc['preview-halfway']
check('a closed product: its public container without payments or partner keys, its preview door a working test shop',
      hw['environment']['SHOP'] == 'closed' and keys_only_for_counting('halfway') and door_hw['environment']['SHOP'] == 'open'
      and door_hw['environment']['PARTNER_ENV'] == 'test' and envfile('halfway@preview').get('PAYMENTS_TOKEN') == mac('pay:halfway:test')
      and envfile('halfway@preview').get('PRINTAPI_CLIENT_ID') == 'test-id' and ways(site(caddy, 'halfway.preview.company.test')) == {'preview-halfway'})
check('a preview keeps its one container behind its door', 'preview-hello' not in svc and not os.path.exists(os.path.join(envs, 'hello@preview.env'))
      and ways(site(caddy, 'hello.preview.company.test')) == {'product-hello'} and ways(shelf(caddy, 'front.preview.company.test', 'hello')) == {'product-hello'})
check('a preview container for each public product, none for a preview', sorted(n for n in svc if n.startswith('preview-'))
      == sorted(f'preview-{s}' for s in [*public, 'front']))

# 4. networks (L5), literal keys (L6), and manifests that try to smuggle something into the compose file
compose, _, _ = run()
products = [n for n in compose['services'] if n.startswith(('product-', 'preview-'))]   # (preview-)
check('each product on a network of its own, and nothing else', all(compose['services'][n]['networks'] == [n] for n in products)
      and set(compose['networks']) == set(products))
check('Caddy joins every product network, and the voice line\'s', compose['services']['caddy']['networks'] == ['voice', *products])
# the voice line trusts Caddy's forward_auth for the board's session: no job may reach it past Caddy
stack = yaml.safe_load(open(os.path.join(here, 'compose.yaml')))['services']
nets = lambda n: set(stack[n].get('networks', ['default']))
check('compose.yaml: the worker and the voice line share no network', not nets('worker') & nets('voice'))
check('compose.yaml: only Caddy and the coordinator join the voice line', sorted(n for n in stack if 'voice' in nets(n)) == ['caddy', 'coordinator', 'voice'])
# the coordinator believes X-Forwarded-For only from the address `caddy` resolves to: one network in common, no worker on it
check('compose.yaml: Caddy and the coordinator share only the voice line', nets('caddy') & nets('coordinator') == {'voice'})
secret = os.path.join(data, 'secrets')
open(os.path.join(secret, 'PRINTAPI_TEST_SECRET'), 'w').write('live-secret$WORKER_TOKEN')
open(os.path.join(secret, 'PRINTAPI_TEST_QUOTE'), 'w').write("it's")
open(os.path.join(secret, 'PRINTAPI_TEST_LINES'), 'w').write('one\nEVIL=two')
open(os.path.join(tmp, 'outside'), 'w').write('not-a-key')
os.symlink(os.path.join(tmp, 'outside'), os.path.join(secret, 'PRINTAPI_TEST_LINK'))
product('dollar', status='${WORKER_TOKEN}', partner_env='test', needs={'secrets': ['printapi']})
product('listy', status='preview', needs=['printapi'])
product('stringy', status='preview', needs={'secrets': 'stripe'})
product('numbery', status='preview', needs={'secrets': [7, ['printapi'], 'printapi']})
# a manifest's memory: 256m to 512m, anything else the default
product('roomy', status='preview', memory='384m')
product('greedy', status='preview', memory='8g')
product('huge', status='preview', memory='4096m')
product('tiny', status='preview', memory='64m')
product('numeric', status='preview', memory=384)
before = compose['services']['product-shy'].get('labels')
compose, _, log = run()
products = [n for n in compose['services'] if n.startswith(('product-', 'preview-'))]
e = envfile('dollar')
check('a key with $ in it stays literal', e.get('PRINTAPI_SECRET') == 'live-secret$WORKER_TOKEN'
      and "PRINTAPI_SECRET='live-secret$WORKER_TOKEN'" in open(os.path.join(envs, 'dollar.env')).read())
check("keys with a quote or a line break are skipped, and the log says so", 'PRINTAPI_QUOTE' not in e and 'PRINTAPI_LINES' not in e
      and 'EVIL' not in e and 'dollar: skipping PRINTAPI_QUOTE' in log and 'dollar: skipping PRINTAPI_LINES' in log)
check('a symlink in the key store is not followed', 'not-a-key' not in open(os.path.join(envs, 'dollar.env')).read())
check('an unknown status (with ${...} in it) becomes a preview', compose['services']['product-dollar']['environment']['STATUS'] == 'preview'
      and '$' not in json.dumps(compose['services']['product-dollar']['environment']) and "dollar: unknown status" in log)
check('odd needs: no crash, only the tool names in a list count', keys_only_for_counting('listy')
      and keys_only_for_counting('stringy') and envfile('numbery').get('PRINTAPI_CLIENT_ID') == 'test-id')
mem = lambda slug: compose['services'][f'product-{slug}']['mem_limit']
check('memory: 256m by default, a manifest may ask for up to 512m, anything else gets 256m and the log says why',
      mem('listy') == '256m' and mem('roomy') == '384m' and all(mem(s) == '256m' for s in ('greedy', 'huge', 'tiny', 'numeric'))
      and all(f'{s}: memory' in log for s in ('greedy', 'huge', 'tiny', 'numeric')) and 'roomy: memory' not in log)
check('every product is hardened: no capabilities, no setuid way up, a read-only image with a small /tmp', products and all(
      compose['services'][n].get('security_opt') == ['no-new-privileges:true'] and compose['services'][n].get('cap_drop') == ['ALL']
      and compose['services'][n].get('read_only') is True and compose['services'][n].get('tmpfs') == ['/tmp:size=64m,mode=1777'] for n in products))
check('a changed key changes the env-hash label, so Compose recreates the container',
      before and compose['services']['product-shy']['labels'] != before)
# 5. the support chat: the service, a live product and a preview with the chat, and
# products that can't have it (front, the service itself, one that didn't opt in, one that wrote something other than true)
product('care', status='preview', partner_env='test', needs={'secrets': ['printapi']})
product('pebblet', status='live', domain='pebblet.shop', partner_env='live', needs={'secrets': ['printapi', 'stripe']}, care=True, name='Pebblet')
product('sprig', status='preview', care=True, name="Sprig's")
product('front', status='live', partner_env='test', needs={'secrets': []}, care=True, name='Testco')   # the shop's own pages
product('plum', domain='plum.shop', care='yes', **live_one)
product('fern', care=True, **live_one)   # live with the chat, no domain: on its shelf
json.dump({'grant': 'live:fern'}, open(os.path.join(data, 'approvals', 'live-fern.json'), 'w'))
open(os.path.join(secret, 'CARE_ANTHROPIC_API_KEY'), 'w').write('sk-ant-api03-MODELKEY')
open(os.path.join(secret, 'CARE_EMAIL_API_KEY'), 'w').write('LETTERMINT-KEY-0123456789')
compose, caddy, log = run()
# the service is the platform's engine, every other product its own app/
check("the service's image: the platform's engine, from the repo's root", compose['services']['product-care']['build']
      == {'context': '..', 'dockerfile': 'platform/care/Dockerfile'})
kit_contexts = {'kits': os.path.join(root, 'kits'), 'shared': os.path.join(root, 'infra', 'generated', 'shared')}
# the build contexts: the kits' folders and the product's own
def build_contexts(slug):
    return {**kit_contexts, 'product': os.path.join(root, 'products', slug)}
product_builds = {name[len('product-'):]: service['build'] for name, service in compose['services'].items()
                  if name.startswith('product-') and name != 'product-care'}
check("every other product builds from its own app folder, the kit folders and its own folder beside it, and its place in the repo",
      all(build == {'context': f'../products/{slug}/app', 'args': {'APP': f'products/{slug}/app'},
                    'additional_contexts': build_contexts(slug)}
          for slug, build in product_builds.items()))
# The real deploy caller exports a clean context, including after a module or tool has been removed.
shutil.copytree(os.path.join(here, '..', 'shared'), os.path.join(root, 'shared'))
for path in ['nested/probe.test.js', 'nested/test_probe.py', 'nested/test_probe.sh', 'nested/README.md',
             'nested/browser-check.mjs', 'nested/check.mjs', 'gates/probe.ts']:
    file = os.path.join(root, 'shared', path)
    os.makedirs(os.path.dirname(file), exist_ok=True)
    open(file, 'w').write('development fixture')
os.makedirs(kit_contexts['shared'])
open(os.path.join(kit_contexts['shared'], 'removed.js'), 'w').write('stale export')
built, _, _ = run(build_shared=True)
shipped = built['services']['product-pebblet']['build']['additional_contexts']['shared']
paths = {os.path.relpath(os.path.join(folder, name), shipped)
         for folder, _, files in os.walk(shipped) for name in files}
check('the shared context omits tests, shell tests, Markdown, browser checks and gates',
      not any(path.startswith(('nested/', 'gates/')) for path in paths))
check('the shared context omits HQ and production tools, including tools beside runtime modules',
      not any(path.startswith(('onair/', 'review/', 'namecheck/', 'readability/', 'browser/',
                               'demo/examples/', 'covers/examples/')) for path in paths)
      and not paths.intersection({'deck/build.mjs', 'deck/inlined.mjs', 'covers/render.mjs',
                                  'demo/record.mjs', 'demo/ad.mjs', 'metrics/lab.ts', 'sound/beds.mjs'}))
check('a fresh shared context discards files removed since the previous export', 'removed.js' not in paths)
check('shared runtime modules retain their relative imports and browser assets',
      {'demo/foley.js', 'demo/runtime.js', 'sound/engine.js', 'sound/foley.js', 'deck/deck.js',
       'deck/deck.css', 'metrics/metrics.ts', 'format/format.js', 'quiet/quiet.ts',
       'markdown/table.ts', 'markdown/package-lock.json'}.issubset(paths))
imported = subprocess.run(['node', '--input-type=module', '-e',
    "for (const path of process.argv.slice(1)) await import(path)",
    *[os.path.join(shipped, path) for path in ['metrics/metrics.ts', 'sound/engine.js', 'routes/routes.ts']]],
    cwd=tmp, capture_output=True, text=True)
check('Node resolves transitive shared imports from the exported context alone', imported.returncode == 0)

if os.environ.get('DOCKER_BUILDS'):
    consumer = os.path.join(tmp, 'consumer')
    os.mkdir(consumer)
    open(os.path.join(consumer, 'Dockerfile'), 'w').write('FROM scratch\nCOPY --from=shared . /repo/shared\n')
    image = os.path.join(tmp, 'image')
    subprocess.run(['docker', 'buildx', 'build', '--build-context', f'shared={shipped}',
                    '--output', f'type=local,dest={image}', consumer], check=True)
    copied = os.path.join(image, 'repo', 'shared')
    check('product images copy the whole filtered shared context',
          paths == {os.path.relpath(os.path.join(folder, name), copied)
                    for folder, _, files in os.walk(copied) for name in files})
else:
    print('skip consumer image build (set DOCKER_BUILDS=1 with Docker BuildKit available)')

check("the service gets its cookie's current name (the last of CARE_COOKIES), no product does",
      compose['services']['product-care']['environment'].get('CARE_COOKIE') == '__Host-natter'
      and not any('CARE_COOKIE' in v.get('environment', {}) for n, v in compose['services'].items() if n != 'product-care'))
c, svc = envfile('care'), compose['services']
check('a product with the chat gets a token for its own slug and mode: live for a public site, preview otherwise',
      envfile('pebblet').get('CARE_TOKEN') == mac('care:pebblet:live') and envfile('sprig').get('CARE_TOKEN') == mac('care:sprig:preview'))
check('no token for a product without care: true (or with anything else), or for the service itself',
      not any('CARE_TOKEN' in envfile(s) for s in ['plum', 'care', 'hello', 'shy']))
# (a live product's @preview token is its preview container's); the front's too
check("the service gets every token, keyed like X-Care-App: each door's is the one its container holds",
      json.loads(c.get('CARE_TOKENS', '{}')) == {'pebblet': mac('care:pebblet:live'), 'pebblet@preview': mac('care:pebblet:preview'),
                                                 'fern': mac('care:fern:live'), 'fern@preview': mac('care:fern:preview'),
                                                 'sprig@preview': mac('care:sprig:preview'),
                                                 'front': mac('care:front:live'), 'front@preview': mac('care:front:preview')})
check("a live product's preview container holds its preview token, its public one the live token, neither the other's",
      envfile('pebblet@preview').get('CARE_TOKEN') == mac('care:pebblet:preview') and envfile('pebblet').get('CARE_TOKEN') == mac('care:pebblet:live')
      and mac('care:pebblet:live') not in open(os.path.join(envs, 'pebblet@preview.env')).read()
      and envfile('front@preview').get('CARE_TOKEN') == mac('care:front:preview'))
check("the service gets each one's address: a live product's own domain or else its shelf, the preview host for @preview",
      json.loads(c.get('CARE_APPS', '{}')) == {'pebblet': 'https://pebblet.shop/', 'pebblet@preview': 'https://pebblet.preview.company.test/',
                                               'fern': 'https://www.company.test/fern/', 'fern@preview': 'https://fern.preview.company.test/',
                                               'sprig@preview': 'https://sprig.preview.company.test/',
                                               'front': 'https://www.company.test/', 'front@preview': 'https://front.preview.company.test/'})
check("the service gets each one's name, a ' in it too, and the shop's (the front's)",
      json.loads(c.get('CARE_NAMES', '{}')) == {'pebblet': 'Pebblet', 'fern': 'fern', 'sprig': "Sprig's", 'front': 'Testco'})
check("the service gets each shop's apps, keyed like X-Care-Shop: www's shelves with the chat (an own domain too), the front's door's",
      json.loads(c.get('CARE_SHOPS', '{}')) == {'front': ['fern', 'pebblet'], 'front@preview': ['fern@preview', 'pebblet@preview', 'sprig@preview']})
check('the service gets its line to HQ', c.get('CARE_HQ_URL') == 'https://hq.company.test' and c.get('CARE_HQ_TOKEN') == mac('care:hq'))
check("the service gets its own keys, and its manifest's test partners as any product", c.get('CARE_ANTHROPIC_API_KEY') == 'sk-ant-api03-MODELKEY'
      and c.get('CARE_EMAIL_API_KEY') == 'LETTERMINT-KEY-0123456789' and c.get('PRINTAPI_CLIENT_ID') == 'test-id')
others = [f for f in os.listdir(envs) if f != 'care.env']
check("the service's keys and its HQ token are in its env file alone", others and not any(
    v in open(os.path.join(envs, f)).read() for f in others for v in ['MODELKEY', 'LETTERMINT', mac('care:hq')]))
check("no product's env file holds another product's chat token", mac('care:pebblet:preview') not in open(os.path.join(envs, 'pebblet.env')).read()
      and mac('care:pebblet:live') not in open(os.path.join(envs, 'sprig.env')).read())
on_care = [n for n, v in svc.items() if 'product-care' in v.get('networks', [])]
check("the service's listener: on a network of its own, which only Caddy joins (no product can reach it)",
      svc['product-care']['networks'] == ['product-care'] and sorted(on_care) == ['caddy', 'product-care'])
# the phone
check("the voice line reaches the service's phone routes through Caddy's inside port, on no network of the service's",
      svc['voice'] == {'environment': {'CARE_URL': 'http://caddy:8081', 'CARE_PHONE_TOKEN': '${CARE_PHONE_TOKEN:-}'}}
      and svc['product-care']['environment']['CARE_PHONE_TOKEN'] == '${CARE_PHONE_TOKEN:-}')
check("the phone token reaches no product and no other service, and no env file names it",
      sorted(n for n, v in svc.items() if 'CARE_PHONE_TOKEN' in json.dumps(v)) == ['product-care', 'voice']
      and not any('CARE_PHONE' in open(os.path.join(envs, f)).read() for f in os.listdir(envs)))
phone_site = site(caddy, 'http://:8081')
check("Caddy's inside port: plain http, /phone/* to the service's phone port, streamed, 404 for the rest, and no other site reaches 8081",
      phone_site.startswith('http://:8081 {') and 'handle /phone/* {\n\t\treverse_proxy product-care:8081 {\n\t\t\tflush_interval -1' in phone_site
      and 'handle {\n\t\trespond 404' in phone_site and caddy.count(':8081') == 2)
pv, pub, sp = site(caddy, 'pebblet.preview.company.test'), site(caddy, 'pebblet.company.test'), site(caddy, 'sprig.preview.company.test')
own, www, door = site(caddy, 'pebblet.shop'), shelf(caddy, 'www.company.test', 'fern'), shelf(caddy, 'front.preview.company.test', 'sprig')
route = lambda block: block[block.index('handle /__care/*'):].split('\n\t}')[0] if 'handle /__care/*' in block else ''
check('the route on every host of a product with the chat, X-Care-App set per host kind, behind the login on a preview only',
      'header_up X-Care-App pebblet@preview' in route(pv) and 'header_up X-Care-App pebblet\n' in route(pub)
      and 'header_up X-Care-App pebblet\n' in route(own) and 'header_up X-Care-App sprig@preview' in route(sp)
      and 'header_up X-Care-App fern\n' in route(www) and 'header_up X-Care-App sprig@preview' in route(door)
      and all('reverse_proxy product-care:8080' in route(b) and 'flush_interval -1' in route(b) for b in (pv, pub, own, sp, www, door))
      and all(route(b).index('forward_auth coordinator:8080') < route(b).index('reverse_proxy') for b in (pv, sp, door))
      and not any('forward_auth' in route(b) for b in (pub, own, www)))
check("X-Care-Shop: the front on www's shelves, front@preview on its door's, the app itself on a host of its own or its preview",
      'header_up X-Care-Shop front\n' in route(www) and 'header_up X-Care-Shop front@preview\n' in route(door)
      and 'header_up X-Care-Shop pebblet\n' in route(pub) and 'header_up X-Care-Shop pebblet\n' in route(own)
      and 'header_up X-Care-Shop pebblet@preview\n' in route(pv) and 'header_up X-Care-Shop sprig@preview\n' in route(sp))
check('the order endpoint outside the login on a preview with the chat, only as a plain /api/care/<name>',
      '@care-orders vars_regexp {http.request.uri} ^/api/care/[a-z]+(\\?.*)?$' in sp and 'handle @care-orders' in pv)
check("a live product's order endpoint on its preview door: to its preview container",
      'handle @care-orders {\n\t\treverse_proxy preview-pebblet:8080' in pv)
check("the chat on a preview host, a shelf's on the front's door too, asks for the board (a tester's share passes: preview.ts)",
      all('uri /api/preview/check?board=1\n' in route(b) for b in (pv, sp, door))
      and not any('check?board=1' in b.replace(route(b), '') for b in (pv, sp, door)) and 'check?board=1' not in route(pub) + route(www))
viewed = [site(caddy, h) for h in ('pebblet.preview.company.test', 'sprig.preview.company.test', 'front.preview.company.test',
                                   'pebblet.company.test', 'www.company.test', 'pebblet.shop')]
check("X-Viewer: taken off every request a site gets, and set from the preview check behind each of its logins",
      all('\n\trequest_header -X-Viewer\n' in b for b in viewed)
      and all(b.count('uri /api/preview/check') == b.count('copy_headers X-Viewer') > 0 for b in viewed[:3]))
nochat = [unshelved(site(caddy, h)) for h in ['plum.preview.company.test', 'plum.company.test', 'front.company.test',
                                   'care.preview.company.test', 'hello.preview.company.test']]
check('no chat route, no order endpoint, on a product without it, front.<zone>, or the service\'s own host',
      not any('\n\thandle /__care' in b or 'care-orders' in b or 'X-Care-App ' in b for b in nochat))
# the front's own pages
front_www, front_door = unshelved(site(caddy, 'www.company.test')), unshelved(site(caddy, 'front.preview.company.test'))
check("the front with care: true: the chat on its own pages as the shop, inside the floor on www, behind the login on its door",
      re.search(r'header_up X-Care-App front\n\t+header_up X-Care-Shop front\n', route(front_www))
      and re.search(r'header_up X-Care-App front@preview\n\t+header_up X-Care-Shop front@preview\n', route(front_door))
      and front_www.index('header Content-Security-Policy') < front_www.index('handle /__care/*')
      and route(front_door).index('forward_auth coordinator:8080') < route(front_door).index('reverse_proxy'))
check("the front has no orders, but the service reaches the shop's basket there: its token, its door's endpoint, at www's root",
      envfile('front').get('CARE_TOKEN') == mac('care:front:live') and 'handle @care-orders' in front_door
      and {k: v for k, v in json.loads(c['CARE_APPS']).items() if k.startswith('front')}
      == {'front': 'https://www.company.test/', 'front@preview': 'https://front.preview.company.test/'})
# the front with a domain of its own: its one public host, and the shop's; the zone's hosts only redirect there
product('front', status='live', partner_env='test', needs={'secrets': []}, care=True, name='Testco', domain='testco.shop')
_, ownDomainCaddy, _ = run()
www_body = site(caddy, 'www.company.test')[len('www.company.test'):]
check("the front with its own domain: www's whole site there (its pages, chat, shelves, kit routes, review off)",
      site(ownDomainCaddy, 'testco.shop').startswith('testco.shop {') and site(ownDomainCaddy, 'testco.shop')[len('testco.shop'):] == www_body
      and shelf(ownDomainCaddy, 'testco.shop', 'fern') and 'respond * "/* review mode: off */" 200' in www_body and 'handle /__care/*' in www_body)
check("...and www, the bare domain and front.<zone> redirect every path there, path and query kept, and do nothing else",
      apex_site(ownDomainCaddy).strip('\n') == 'company.test, www.company.test, front.company.test {\n\tredir https://testco.shop{uri} permanent\n}'
      and ownDomainCaddy.count('www.company.test') == 1)
check("...a moved product's old address sends page loads to its shelf there, not through www",
      'redir @page https://testco.shop/fern{uri} permanent\n' in site(ownDomainCaddy, 'fern.company.test')
      and 'redir @unmarked https://testco.shop/fern{uri} permanent\n' in site(ownDomainCaddy, 'fern.company.test'))
check("...and the service reaches the front and its shelves there; a product's own domain stays its own",
      {k: v for k, v in json.loads(envfile('care')['CARE_APPS']).items() if '@' not in k}
      == {'front': 'https://testco.shop/', 'fern': 'https://testco.shop/fern/', 'pebblet': 'https://pebblet.shop/'})
product('front', status='live', partner_env='test', needs={'secrets': []}, name='Testco')
_, caddy2, _ = run()
check('the front without care: true: no chat on its own pages (its shelves keep theirs, the shop keeps its name)',
      not any('/__care' in unshelved(site(caddy2, h)) for h in ['www.company.test', 'front.preview.company.test'])
      and 'X-Care-Shop front\n' in shelf(caddy2, 'www.company.test', 'fern') and json.loads(envfile('care')['CARE_NAMES'])['front'] == 'Testco')
os.remove(os.path.join(root, 'products', 'front', 'product.yaml'))
open(os.path.join(envs, 'ghost@preview.env'), 'w').write("PAYMENTS_TOKEN='old'\n")   # a product long gone
compose, _, _ = run()
check("a preview container's env file goes with it",
      'preview-front' not in compose['services'] and not os.path.exists(os.path.join(envs, 'front@preview.env'))
      and not os.path.exists(os.path.join(envs, 'ghost@preview.env')) and os.path.exists(os.path.join(envs, 'pebblet@preview.env')))
check("no front: www's shelves are still the shop, under the front's slug, and there's no door to list",
      json.loads(envfile('care')['CARE_SHOPS']) == {'front': ['fern', 'pebblet']} and json.loads(envfile('care')['CARE_NAMES'])['front'] == 'front')
product('front', status='live', partner_env='test', needs={'secrets': []}, care=True, name='Testco')
blocks = [b for b in caddy.split('\n}\n') if 'reverse_proxy product-' in b]   # every site with a way to a product or the chat
check("every site strips a client's X-Care-Shop",
      len(blocks) > 10 and all('\n\trequest_header -X-Care-Shop\n' in b for b in blocks))
check("every site strips a client's X-Care-App, and every way to a product drops pv and the chat's cookie",
      all('request_header -X-Care-App' in site(caddy, h) for h in ['pebblet.company.test', 'pebblet.preview.company.test', 'care.preview.company.test', 'plum.company.test'])
      # (the phone's inside port carries no browser's cookies)
      and len(re.findall('reverse_proxy (product|preview)-', caddy)) - len(re.findall('reverse_proxy product-care:8080 {\n\t+header_up X-Care-App', caddy))
          - caddy.count('reverse_proxy product-care:8081') ==
          caddy.count('header_up Cookie `^(?:\\s*natter=[^;]*(?:;|$))+\\s*|;\\s*natter=[^;]*` ""')
          == caddy.count('header_up Cookie `^(?:\\s*__Host-natter=[^;]*(?:;|$))+\\s*|;\\s*__Host-natter=[^;]*` ""'))
# the patterns as Caddy gets them (Go's RE2 and Python's re agree on these), on a product's way in: every copy goes, side
# by side, first, last or between others, and nothing else does
drops = re.findall(r'header_up Cookie `([^`]*)` ""', site(caddy, 'pebblet.company.test').split('reverse_proxy product-pebblet')[1])
def to_product(header):
    for d in drops:
        header = re.sub(d, '', header)
    return header
# ps: an outside reviewer's share
check("ps goes wherever pv goes", caddy.count('(?:\\s*pv=[^;]*') == caddy.count('(?:\\s*ps=[^;]*') > 10)
# pp: an agent job's pass
check("pp goes wherever pv goes", caddy.count('(?:\\s*pv=[^;]*') == caddy.count('(?:\\s*pp=[^;]*'))
check("the cookie patterns drop every copy of pv, ps, pp and the chat's cookie, and keep the rest", len(drops) == 5 and all(
    to_product(h) == want for h, want in [
        ('natter=s1; natter=s2', ''), ('pv=a; pv=b; t=1', 't=1'), ('__Host-natter=s1; __Host-natter=s2', ''),
        ('t=1; pv=a; pv=b', 't=1'), ('t=1; natter=a; natter=b; u=2', 't=1; u=2'), ('pv=a; t=1; pv=b', 't=1'),
        ('pv=a;pv=b;pv=c', ''), ('natter=1; pv=2; __Host-natter=3; t=4', 't=4'), ('t=1; __Host-natter=a;__Host-natter=b', 't=1'),
        ('xpv=1; pv=2; anatter=3; b__Host-natter=4', 'xpv=1; anatter=3; b__Host-natter=4'), ('t=1; pvx=2', 't=1; pvx=2'),
        ('ps=a; pv=b; t=1; ps=c', 't=1'), ('pp=a; t=1; pp=b', 't=1')]))
os.remove(care_dockerfile)   # a manifest (and an old products/care/app) isn't enough
compose, caddy, _ = run()
check("a products/care manifest without the platform's engine: no service, no route, no tokens", 'product-care' not in compose['services']
      and os.path.exists(os.path.join(root, 'products', 'care', 'app', 'Dockerfile'))
      and 'handle /__care' not in caddy and 'CARE_TOKEN' not in envfile('pebblet') and 'product-pebblet' in compose['services'])
open(care_dockerfile, 'w').write('FROM scratch\n')
os.remove(os.path.join(root, 'products', 'care', 'product.yaml'))
compose, caddy, _ = run()
check('without the service: no route, no tokens', 'handle /__care' not in caddy and 'CARE_TOKEN' not in envfile('pebblet'))
check("without the service the voice line stays on its own network, without the phone's token",
      'voice' not in compose['services'] and 'CARE_PHONE' not in json.dumps(compose) and ':8081' not in caddy)
def with_cookies(line):   # products.py with another company/infra.env (INFRA_ENV): its exit code and its Caddyfile
    f = os.path.join(tmp, 'other-infra.env')
    open(f, 'w').write('SERVER_NAME=testco\n' + line)
    env = {**os.environ, 'PUBLIC_HOST': 'hq.company.test', 'HQ_DATA': data, 'PRODUCT_ENV_DIR': envs, 'INFRA_ENV': f}
    r = subprocess.run([sys.executable, os.path.join(root, 'infra', 'products.py')], env=env, capture_output=True, text=True)
    return r.returncode, open(os.path.join(root, 'infra', 'generated', 'products.caddy')).read()
code, plain = with_cookies('')
routes = len(re.findall('reverse_proxy (product|preview)-', plain))   # (preview-)
to_product = routes - plain.count('header_up X-Care-App')
check("a company without CARE_COOKIES: pv and the engine's default __Host-care are dropped on every product route",
      code == 0 and plain.count('header_up Cookie `^(?:\\s*pv=') == routes
      and plain.count('header_up Cookie `^(?:\\s*__Host-care=') == to_product > 0)
check("CARE_COOKIES that aren't plain cookie names: no deploy",
      all(with_cookies(f'CARE_COOKIES={v}\n')[0] == 1 for v in ('a`b', 'a.*', 'a;b', 'a=b')))
check("CARE_COOKIES whose last name isn't __Host-: no deploy (an old plain name before it is only stripped)",
      with_cookies('CARE_COOKIES=chat\n')[0] == 1 and with_cookies('CARE_COOKIES=__Host-chat,chat\n')[0] == 1
      and with_cookies('CARE_COOKIES=chat,__Host-chat\n')[0] == 0)
product('care', status='preview', partner_env='test')
with_cookies('')   # no names, the engine's default (the one Caddy strips)
bare = yaml.safe_load(open(os.path.join(root, 'infra', 'generated', 'products.yaml')))['services']['product-care']
check("a company without CARE_COOKIES: the service gets the default it's stripped under", bare['environment'].get('CARE_COOKIE') == '__Host-care')
# the model's prepaid credit
check('the prepaid credit reaches the care service as it is in infra.env',
      with_cookies('CARE_CREDIT_USD=20\nCARE_CREDIT_AT=2026-10-02\nCARE_CREDIT_OTHERS_USD=3\n')[0] == 0
      and [l for l in open(os.path.join(envs, 'care.env')).read().splitlines() if l.startswith('CARE_CREDIT')]
      == ["CARE_CREDIT_USD='20'", "CARE_CREDIT_AT='2026-10-02'", "CARE_CREDIT_OTHERS_USD='3'"])
check('a credit without its date, a date that isn\'t one (or doesn\'t exist), or dollars that aren\'t: no deploy',
      all(with_cookies(l)[0] == 1 for l in ('CARE_CREDIT_USD=20\n', 'CARE_CREDIT_USD=20\nCARE_CREDIT_AT=2.10.2026\n',
                                             'CARE_CREDIT_USD=20\nCARE_CREDIT_AT=2026-13-01\n', 'CARE_CREDIT_USD=20\nCARE_CREDIT_AT=2026-10-32\n',
                                             'CARE_CREDIT_USD=20\nCARE_CREDIT_AT=2026-10-07T25:00Z\n',
                                             'CARE_CREDIT_USD=$20\nCARE_CREDIT_AT=2026-10-02\n', 'CARE_CREDIT_AT=2026-10-02\n')))
check('a credit read at a UTC time, with or without seconds: deploys',
      all(with_cookies(f'CARE_CREDIT_USD=20\nCARE_CREDIT_AT={t}\n')[0] == 0 for t in ('2026-10-07T14:30Z', '2026-10-07T14:30:05Z')))
# a plan's monthly credit on the same account
check("a plan's monthly credit reaches the care service with its first cycle's start",
      with_cookies('CARE_CREDIT_USD=20\nCARE_CREDIT_AT=2026-10-09\nCARE_CREDIT_MONTHLY_USD=200\nCARE_CREDIT_MONTHLY_FROM=2026-11-02\n')[0] == 0
      and [l for l in open(os.path.join(envs, 'care.env')).read().splitlines() if l.startswith('CARE_CREDIT_MONTHLY')]
      == ["CARE_CREDIT_MONTHLY_USD='200'", "CARE_CREDIT_MONTHLY_FROM='2026-11-02'"])
check("a monthly credit without its start, a start without dollars, or one that isn't a date: no deploy",
      all(with_cookies(f'CARE_CREDIT_USD=20\nCARE_CREDIT_AT=2026-10-09\n{l}')[0] == 1
          for l in ('CARE_CREDIT_MONTHLY_USD=200\n', 'CARE_CREDIT_MONTHLY_FROM=2026-11-02\n',
                    'CARE_CREDIT_MONTHLY_USD=200\nCARE_CREDIT_MONTHLY_FROM=2\n', 'CARE_CREDIT_MONTHLY_USD=$200\nCARE_CREDIT_MONTHLY_FROM=2026-11-02\n')))
# 6. the shop's dated offers: the front's file, compact, to every other product
front_yaml = os.path.join(root, 'products', 'front', 'product.yaml')
front_manifest = yaml.safe_load(open(front_yaml))
shop_dir = os.path.join(root, 'products', 'front', 'app', 'shop')
offers_list = [{'id': 'black-friday', 'from': '2026-11-23', 'until': '2026-11-30', 'offers': [{'thing': 'pebblet-mug', 'packs': {'1': 1995}}]}]
os.makedirs(shop_dir, exist_ok=True)
json.dump(offers_list, open(os.path.join(shop_dir, 'offers.json'), 'w'), indent=2)
product_envs = lambda compose: {n: v['environment'] for n, v in compose['services'].items() if n.startswith(('product-', 'preview-'))}
compose, _, log = run()
check('no offers named: no product gets SHOP_OFFERS', not any('SHOP_OFFERS' in e for e in product_envs(compose).values()))
yaml.safe_dump({**front_manifest, 'offers': 'app/shop/offers.json'}, open(front_yaml, 'w'))
compose, _, log = run()
e = product_envs(compose)
check("the front's offers: every other product gets them as one compact line",
      e['product-pebblet'].get('SHOP_OFFERS') == json.dumps(offers_list, separators=(',', ':')) and json.loads(e['product-shy']['SHOP_OFFERS']) == offers_list)
check("the offers go to neither the front nor the chat's service", 'SHOP_OFFERS' not in e['product-front'] and 'SHOP_OFFERS' not in e.get('product-care', {}))
check("a preview container gets them as its product does",
      e['preview-pebblet'].get('SHOP_OFFERS') == e['product-pebblet']['SHOP_OFFERS'] and 'SHOP_OFFERS' not in e['preview-front'])
os.symlink(os.path.join(root, 'infra', 'company.py'), os.path.join(shop_dir, 'out.json'))
for name, why in (('../../../infra/products.py', 'outside its folder'), ('app/shop/out.json', 'through a link out of its folder'),
                  ('app/shop/missing.json', 'missing'), ('app/Dockerfile', 'not JSON')):
    yaml.safe_dump({**front_manifest, 'offers': name}, open(front_yaml, 'w'))
    compose, _, log = run()
    check(f'offers {why}: left out, and the deploy log says so', f'front: leaving its offers out ({name}' in log
          and not any('SHOP_OFFERS' in v for v in product_envs(compose).values()))
json.dump([{'id': 'x', 'note': '${WORKER_TOKEN}'}], open(os.path.join(shop_dir, 'offers.json'), 'w'))
yaml.safe_dump({**front_manifest, 'offers': 'app/shop/offers.json'}, open(front_yaml, 'w'))
compose, _, log = run()
check('a $ in the offers is kept literally (Compose would expand it)', '$${WORKER_TOKEN}' in product_envs(compose)['product-pebblet']['SHOP_OFFERS'])
yaml.safe_dump(front_manifest, open(front_yaml, 'w'))

# 7. a product's own keys (needs.keys): made once on the server, one per mode, rotated only by a raised generation
def nodeSigns(privateDer, jwks):
    """Whether a Node app can sign with the env's p256 key and verify that signature with the given public JWKs."""
    script = ("const c = require('node:crypto'); const [der, jwks] = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));"
              "const key = c.createPrivateKey({ key: Buffer.from(der, 'base64'), format: 'der', type: 'pkcs8' });"
              "const sig = c.sign('sha256', Buffer.from('order'), { key, dsaEncoding: 'ieee-p1363' });"
              "console.log(jwks.some(k => c.verify('sha256', Buffer.from('order'),"
              " { key: c.createPublicKey({ key: k, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, sig)))")
    r = subprocess.run(['node', '-e', script], input=json.dumps([privateDer, jwks]), capture_output=True, text=True)
    return r.stdout.strip() == 'true'
def publicOf(privateDer):
    script = ("const c = require('node:crypto'); const der = require('node:fs').readFileSync(0, 'utf8');"
              "const k = c.createPublicKey(c.createPrivateKey({ key: Buffer.from(der, 'base64'), format: 'der', type: 'pkcs8' }));"
              "console.log(JSON.stringify(k.export({ format: 'jwk' })))")
    return json.loads(subprocess.run(['node', '-e', script], input=privateDer, capture_output=True, text=True, check=True).stdout)
lampKeys = {'LAMP_SIGNING_KEY': {'kind': 'p256', 'ring': 'LAMP_PUBLIC_KEYS'}, 'LAMP_RECOVERY_KEY': {'kind': 'random-32'},
             'PAYMENTS_TOKEN': {'kind': 'random-32'}, 'LAMP_ODD': {'kind': 'rsa'}, 'LAMP_SEALS': {'kind': 'random-32', 'generation': 2},
             'LAMP_LIST': {'kind': []}, 'LAMP_MAPPING': {'kind': {'bad': 'p256'}},
             'LAMP_Z_DUPLICATE_KEY': {'kind': 'p256', 'ring': 'LAMP_PUBLIC_KEYS'}}
lamp = lambda **keys: product('lamp', status='live', partner_env='live', needs={'secrets': ['stripe'], 'keys': {**lampKeys, **keys}})
lamp()
json.dump({'grant': 'live:lamp'}, open(os.path.join(data, 'approvals', 'live-lamp.json'), 'w'))
compose, caddy, log = run()
liveKeys, doorKeys = envfile('lamp'), envfile('lamp@preview')
signing, recovery = liveKeys.get('LAMP_SIGNING_KEY', ''), liveKeys.get('LAMP_RECOVERY_KEY', '')
check('needs.keys: a p256 key a Node app signs with, and an empty ring', nodeSigns(signing, [publicOf(signing)])
      and liveKeys.get('LAMP_PUBLIC_KEYS') == '[]')
check('needs.keys: a random-32 key is 32 bytes in base64', len(base64.b64decode(recovery, validate=True)) == 32)
check('needs.keys: the preview door has keys of its own, so a test order never signs a live licence',
      doorKeys['LAMP_SIGNING_KEY'] != signing and doorKeys['LAMP_RECOVERY_KEY'] != recovery
      and not nodeSigns(doorKeys['LAMP_SIGNING_KEY'], [publicOf(signing)]))
check("needs.keys: invalid names, kinds, generations and duplicate rings are left out while valid keys deploy",
      envfile('lamp')['PAYMENTS_TOKEN'] == hmac.new(key.encode(), b'pay:lamp:live', hashlib.sha256).hexdigest()
      and all(n not in liveKeys and f"lamp: leaving out needs.keys '{n}'" in log
              for n in ('LAMP_ODD', 'LAMP_SEALS', 'LAMP_LIST', 'LAMP_MAPPING', 'LAMP_Z_DUPLICATE_KEY'))
      and "lamp: leaving out needs.keys 'PAYMENTS_TOKEN'" in log)
generated = json.dumps(compose) + caddy + log
check('needs.keys: no key in the deploy log or the generated files', not any(
      v in generated for v in (signing, recovery, doorKeys['LAMP_SIGNING_KEY'], doorKeys['LAMP_RECOVERY_KEY'])))
kept = os.path.join(data, 'product-keys', 'lamp', 'live')
check("needs.keys: kept in HQ's data, root's alone (0700 folder, 0600 files)",
      os.stat(kept).st_mode & 0o777 == 0o700 and os.stat(os.path.join(kept, 'LAMP_SIGNING_KEY.json')).st_mode & 0o777 == 0o600)
run()
check('needs.keys: the next deploy keeps every key', envfile('lamp') == liveKeys and envfile('lamp@preview') == doorKeys)
lamp(LAMP_SIGNING_KEY={'kind': 'p256', 'ring': 'LAMP_PUBLIC_KEYS', 'generation': 2})
_, _, log = run()
rotated = envfile('lamp')
ring = json.loads(rotated['LAMP_PUBLIC_KEYS'])
check('needs.keys: a raised generation rotates the p256 key, its old public half in the ring',
      rotated['LAMP_SIGNING_KEY'] != signing and ring == [publicOf(signing)] and nodeSigns(signing, ring)
      and 'lamp: rotated LAMP_SIGNING_KEY for live to generation 2' in log)
check('needs.keys: a rotation leaves the recovery key as it was', rotated['LAMP_RECOVERY_KEY'] == recovery)
lamp(LAMP_SIGNING_KEY={'kind': 'p256', 'ring': 'LAMP_PUBLIC_KEYS'}, LAMP_RECOVERY_KEY={'kind': 'p256'})
_, _, log = run()
check('needs.keys: a lowered generation or a new kind changes no key', envfile('lamp') == rotated
      and 'LAMP_SIGNING_KEY stays at generation 2' in log and 'LAMP_RECOVERY_KEY is kept as the random-32 key' in log)
lamp(LAMP_SIGNING_KEY={'kind': 'p256', 'generation': 3})
run()
check('needs.keys: a p256 key without a ring never rotates (its old signatures would fail)',
      'LAMP_SIGNING_KEY' not in envfile('lamp') and json.load(open(os.path.join(kept, 'LAMP_SIGNING_KEY.json')))['generation'] == 2)
shutil.rmtree(os.path.join(data, 'product-keys', 'lamp'))
os.symlink(tmp, os.path.join(data, 'product-keys', 'lamp'))
lamp()
_, _, log = run()
check('needs.keys: a link planted on the way is refused, never followed',
      'LAMP_RECOVERY_KEY' not in envfile('lamp') and 'lamp: no keys for live' in log and not os.path.exists(os.path.join(tmp, 'live')))
os.remove(os.path.join(data, 'product-keys', 'lamp'))
run()
recovery = envfile('lamp')['LAMP_RECOVERY_KEY']
planted = os.path.join(tmp, 'planted')
os.makedirs(os.path.join(planted, 'live'))
json.dump({'kind': 'random-32', 'generation': 1, 'key': 'UExBTlRFRA==', 'retired': []},
          open(os.path.join(planted, 'live', 'LAMP_RECOVERY_KEY.json'), 'w'))
# The coordinator swaps product-keys/lamp for a link just after the deploy has looked at it.
swapper = f"""
import os, runpy, sys
sys.path.insert(0, {os.path.join(root, 'infra')!r})
lamp, real, swapped = os.path.join({data!r}, 'product-keys', 'lamp'), (os.lstat, os.fstat), []
held = os.path.realpath(lamp)
def swap():
    if not swapped:
        swapped.append(lamp)
        os.rename(lamp, lamp + '.moved')
        os.symlink({planted!r}, lamp)
def lstat(path, *a, **k):
    st = real[0](path, *a, **k)
    if str(path) == lamp: swap()
    return st
def fstat(fd):
    st = real[1](fd)
    if os.readlink(f'/proc/self/fd/{{fd}}') == held: swap()
    return st
os.lstat, os.fstat = lstat, fstat
runpy.run_path({os.path.join(root, 'infra', 'products.py')!r}, run_name='__main__')
"""
r = subprocess.run([sys.executable, '-c', swapper], capture_output=True, text=True,
                   env={**os.environ, 'PUBLIC_HOST': 'hq.company.test', 'HQ_DATA': data, 'PRODUCT_ENV_DIR': envs})
check('needs.keys: a folder swapped for a link after its check never serves a planted key',
      r.returncode == 0 and os.path.islink(os.path.join(data, 'product-keys', 'lamp'))
      and envfile('lamp').get('LAMP_RECOVERY_KEY') == recovery)
os.remove(os.path.join(data, 'product-keys', 'lamp'))
shutil.rmtree(os.path.join(root, 'products', 'lamp'))
os.remove(os.path.join(data, 'approvals', 'live-lamp.json'))

# This server's run helpers (run_helpers.py): one per kind HQ takes, as the coordinator publishes them (runs.ts
# publishKinds, run-kinds.json in HQ_DATA), built from the kind's image, with the server's caps and sandbox whatever the
# kind asks for
runHelpers = lambda compose: {n: v for n, v in compose['services'].items() if n.startswith('run-helper')}
published = os.path.join(data, 'run-kinds.json')
publish = lambda kinds: open(published, 'w').write(json.dumps(kinds))
helpers = runHelpers(run()[0])
check("run helpers: before HQ has published its kinds, one for the default kind, on the platform's image",
      list(helpers) == ['run-helper-default'] and helpers['run-helper-default']['build']['args'] == {'IMAGE': 'node:24.22.1-slim'})
publish([{'name': 'simulation', 'image': 'node:24.22.1-slim'}, {'name': 'render', 'image': 'registry.example/render@sha256:0a1b'},
         {'name': 'true', 'image': 'node:24.22.1-slim'}])
helpers = runHelpers(run()[0])
check("run helpers: one per kind HQ published, built from the kind's image",
      {n: v['build'] for n, v in helpers.items()} == {
          f'run-helper-{kind}': {'context': '../platform/helper', 'args': {'IMAGE': image}}
          for kind, image in [('simulation', 'node:24.22.1-slim'), ('render', 'registry.example/render@sha256:0a1b'), ('true', 'node:24.22.1-slim')]})
check("run helpers: each takes its kind's runs, with the server's caps, no GPUs, the sandbox, and the runs network alone",
      all(v['environment'] == {'HQ_URL': 'http://coordinator:8080', 'RUN_KIND': n[len('run-helper-'):]}
          and (v['cpus'], v['mem_limit'], v['memswap_limit'], v['pids_limit']) == (4, '3g', '3g', 4096)
          and v['tmpfs'] == ['/tmp:size=64m,mode=755', '/work:exec,mode=1777,size=1g'] and v['networks'] == ['runs']
          and v['cap_drop'] == ['ALL'] and v['cap_add'] == ['SETUID', 'SETGID'] and v['read_only'] is True
          and v['security_opt'] == ['no-new-privileges:true'] and v['volumes'] == ['/etc/testco/runs-token:/state/key:ro']
          and 'gpu' not in json.dumps(v).lower() for n, v in helpers.items()))
publish([{'name': 'Films', 'image': 'node'}, {'name': 'shell', 'image': 'node;rm -rf /'}, {'name': 'no-image', 'image': 10},
         {'name': 'render'}, 'bare', {'name': 'fine', 'image': 'node:24.22.1-slim'}])
check("run helpers: none for a published name or image outside runs.ts's rules", list(runHelpers(run()[0])) == ['run-helper-fine'])
for text, why in [('{"default": "node:24.22.1-slim"}', 'a published map'), ('[]', 'no kinds published')]:
    open(published, 'w').write(text)
    check(f'run helpers: none for {why}', runHelpers(run()[0]) == {})
open(published, 'w').write('[{"name": "render"')
check('run helpers: the default kind for a published file that does not parse', list(runHelpers(run()[0])) == ['run-helper-default'])
check('run helpers: the default kind, and no file read, for an HQ_DATA that is not an absolute path',
      list(runHelpers(run(hq_data='hqdata')[0])) == ['run-helper-default'])

# The same, from org.yaml through the coordinator's own reading of it (runs.ts publishKinds): what YAML 1.2 makes of
# on, off, no and True, a tag of the company's own elsewhere in the file, and a YAML 1.1 document
coordinator = os.path.join(os.path.dirname(here), 'platform', 'coordinator')
org = os.path.join(root, 'company', 'org.yaml')
def published_by_hq(text):
    open(org, 'w').write(text)
    hq_data = tempfile.mkdtemp(dir=tmp)
    r = subprocess.run(['node', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e',
                        "(await import('./src/runs.ts')).publishKinds(); process.exit(0)"],
                       cwd=coordinator, env={**os.environ, 'REPO_DIR': root, 'DATA_DIR': hq_data}, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    shutil.copy(os.path.join(hq_data, 'run-kinds.json'), published)
    return {n[len('run-helper-'):]: v['build']['args']['IMAGE'] for n, v in runHelpers(run()[0]).items()}
if os.path.exists(os.path.join(coordinator, 'node_modules', 'yaml')) and shutil.which('node'):
    check("run helpers from org.yaml: YAML 1.2's on, off, no and True, and runs.ts's name and image rules",
          published_by_hq('''runs:
  kinds:
    simulation: { image: node:24.22.1-slim, cpus: 24, memoryGb: 40 }
    render: { image: registry.example/render@sha256:0a1b, cpus: 32, diskGb: 100, gpus: true }
    bare:
    on: {}
    off: { about: yes }
    no: { cpus: 1e1 }
    True: { about: 2026-10-16 }
    bad-cpus: { cpus: "24" }
    Films: { image: node }
    shell: { image: "node;rm -rf /" }
    9lives: {}
''') == {'simulation': 'node:24.22.1-slim', 'render': 'registry.example/render@sha256:0a1b', 'bare': 'node:24.22.1-slim',
           'on': 'node:24.22.1-slim', 'off': 'node:24.22.1-slim', 'no': 'node:24.22.1-slim', 'true': 'node:24.22.1-slim'})
    check('run helpers from org.yaml: a tag of its own elsewhere in the file leaves the kinds as HQ takes them',
          published_by_hq('label: !text example\nruns:\n  kinds:\n    render: {}\n') == {'render': 'node:24.22.1-slim'})
    check("run helpers from org.yaml: a YAML 1.1 document's kinds named as HQ reads them (on is true)",
          published_by_hq('%YAML 1.1\n---\nruns:\n  kinds:\n    on: {}\n    render: {}\n') == {'true': 'node:24.22.1-slim', 'render': 'node:24.22.1-slim'})
    check('run helpers from org.yaml: none for a kinds list, which runs.ts refuses',
          published_by_hq('runs:\n  kinds:\n    - simulation\n') == {})
    check('run helpers from org.yaml: the default kind for a kind named twice, which HQ reads as no file',
          published_by_hq('runs:\n  kinds:\n    render: {}\n    render: {}\n') == {'default': 'node:24.22.1-slim'})
    os.remove(org)
else:
    print('skipped: run helpers from org.yaml through the coordinator (no platform/coordinator/node_modules)')
os.remove(published)

compose, _, _ = run()
products = [n for n in compose['services'] if n.startswith(('product-', 'preview-'))]

if os.environ.get('DOCKER_COMPOSE'):
    ci = os.path.join(root, 'infra')
    stack = open(os.path.join(here, 'compose.yaml')).read().replace('/etc/${SERVER_NAME}/env', os.path.join(tmp, 'server.env'))
    open(os.path.join(ci, 'compose.yaml'), 'w').write(stack)
    open(os.path.join(tmp, 'server.env'), 'w').write('REPO=x/y\n')
    r = subprocess.run([os.environ['DOCKER_COMPOSE'], '-f', os.path.join(ci, 'compose.yaml'), '-f', os.path.join(ci, 'generated', 'products.yaml'),
                        'config', '--format', 'json'], capture_output=True, text=True, cwd=ci,
                       env={**os.environ, 'WORKER_TOKEN': 'W0RKER', 'VOICE_TOKEN': 'V01CE', 'CARE_PHONE_TOKEN': 'PH0NE', 'PUBLIC_HOST': 'hq.company.test'})
    check('docker-compose config renders the stack', r.returncode == 0)
    if r.returncode == 0:
        c = json.loads(r.stdout)
        svc = c['services']
        check('compose: products only on their own network', all(list(svc[n]['networks']) == [n] for n in products))
        check("compose: a preview container reads its own env file",
              svc['preview-pebblet']['environment'].get('PAYMENTS_MODE') == 'test' and svc['product-pebblet']['environment'].get('PAYMENTS_MODE') == 'live')
        check("compose: the chat's service shares a network with Caddy only",
              sorted(n for n, v in svc.items() if 'product-care' in v.get('networks', {})) == ['caddy', 'product-care'])
        check("compose: the phone token goes to the voice line and the chat's service only, and the voice line asks Caddy",
              sorted(n for n, v in svc.items() if 'PH0NE' in json.dumps(v)) == ['product-care', 'voice']
              and svc['voice']['environment'].get('CARE_URL') == 'http://caddy:8081' and list(svc['voice']['networks']) == ['voice'])
        check("compose: no container publishes a port but Caddy's 80 and 443 (Caddy's 8081 stays inside)",
              sorted((n, int(p['published'])) for n, v in svc.items() for p in v.get('ports', [])) == [('caddy', 443), ('caddy', 80)]
              or sorted((n, int(p['published'])) for n, v in svc.items() for p in v.get('ports', [])) == [('caddy', 80), ('caddy', 443)])
        check('compose: Caddy on the voice line\'s and every product network, not default', set(svc['caddy']['networks']) == {'voice', *products})
        check('compose: Caddy and the coordinator share only the voice line', set(svc['caddy']['networks']) & set(svc['coordinator']['networks']) == {'voice'})
        check('compose: the worker and the voice line share no network', not set(svc['worker']['networks']) & set(svc['voice']['networks']))
        check("compose: the run helper's one network has the coordinator and no way out",
              list(svc['run-helper-default']['networks']) == ['runs'] and c['networks']['runs'].get('internal') is True
              and sorted(n for n, v in svc.items() if 'runs' in v.get('networks', {})) == ['coordinator', 'run-helper-default'])
        check("compose: a product's image gets the kit folders and its own folder as named contexts, and its place in the repo",
              all(svc[n]['build'].get('additional_contexts') == build_contexts(n[8:]) and svc[n]['build']['args'] == {'APP': f'products/{n[8:]}/app'}
                  for n in products if n != 'product-care'))
        check('compose: only Caddy and the coordinator join the voice line', sorted(n for n, v in svc.items() if 'voice' in v.get('networks', {})) == ['caddy', 'coordinator', 'voice'])
        # compose writes a literal $ as $$ in what it renders; an expanded one would show the token
        check('compose: the key with $ reaches the product literally', svc['product-dollar']['environment']['PRINTAPI_SECRET'] == 'live-secret$$WORKER_TOKEN')
        check('compose: no service but the worker and the coordinator gets the worker token',
              [n for n, v in svc.items() if 'W0RKER' in json.dumps(v)] == ['coordinator', 'worker'])
        check('compose: the voice token goes to the voice line and the coordinator only',
              sorted(n for n, v in svc.items() if 'V01CE' in json.dumps(v)) == ['coordinator', 'voice'])
        check('compose: the worker takes no new privileges', svc['worker'].get('security_opt') == ['no-new-privileges:true'])
        check('compose: the voice line sees no seats volume and no work volume', not any(
            m.get('source') in ('seats', 'work') for m in svc['voice']['volumes']))
else:
    print('skip docker-compose checks (set DOCKER_COMPOSE=/path/to/docker-compose)')

# sync.sh's fingerprint: a key products.py puts in a container's env redeploys it when saved, others don't
sync = open(os.path.join(here, 'sync.sh')).read()
m = re.search(r'^approvals=\$\(.*?\| cut -c1-64\)$', sync, re.S | re.M)
assert m, 'sync.sh: the approvals fingerprint was not found'
fingerprint = m.group(0) + '; echo "$approvals"'
kept = os.path.join(tmp, 'kept')
os.makedirs(os.path.join(kept, 'approvals'))
os.makedirs(os.path.join(kept, 'secrets'))
def deployed_as():
    return subprocess.run(['bash', '-c', fingerprint], cwd=root, env={'PATH': '/usr/bin:/bin', 'HQ_DATA': kept},
                          capture_output=True, text=True).stdout.strip()
def saved(name, value):
    before = deployed_as()
    open(os.path.join(kept, 'secrets', name), 'w').write(value)
    return deployed_as() != before
check("sync.sh: saving the live Print API keys redeploys", saved('PRINTAPI_LIVE_CLIENT_ID', 'LIVE-ID')
      and saved('PRINTAPI_LIVE_CLIENT_SECRET', 'LIVE-SECRET'))
check("sync.sh: so does the support chat's key", saved('CARE_ANTHROPIC_API_KEY', 'k'))
check("sync.sh: so does the test model key", saved('ANTHROPICEVAL_TEST_API_KEY', 'k'))
check("sync.sh: a key no container gets doesn't",
      len(deployed_as()) == 64 and not saved('STRIPE_LIVE_RESTRICTED_KEY', 'rk_live_x'))

check('visitors and visits stay off unless the company turns them on', 'METRICS_VISITORS' not in envfile('pebblet'))
with open(os.path.join(root, 'company', 'infra.env'), 'a') as f:
    f.write('METRICS_VISITORS=on\n')
run()
check("company/infra.env's METRICS_VISITORS=on tells every product to count them",
      envfile('pebblet').get('METRICS_VISITORS') == '1' and envfile('hello').get('METRICS_VISITORS') == '1')

# A company without a domain (HQ at <ip-with-dashes>.sslip.io, or nip.io's dotted IP) has no zone: no product, chat or
# cycles' pages, nothing on a <slug>.sslip.io host, the run helpers still deployed, and one line saying products wait
for host in ('203-0-113-7.sslip.io', '203.0.113.7.nip.io'):
    said = []
    compose, caddy, _ = run(host=host, said=said)
    check(f'{host}: no product, preview door or chat is deployed, the run helpers are',
          not [s for s in compose['services'] if s.startswith(('product-', 'preview-'))] and any(s.startswith('run-helper-') for s in compose['services']))
    check(f'{host}: no site at all, so nothing reaches a host of the shared zone', caddy.strip() == '# Generated by infra/products.py. Do not edit.')
    check(f'{host}: one plain line says the products wait for a domain', said[0].strip().splitlines()
          == [f"products wait for a domain: {host} is named for the server's IP, which gives them no addresses of their own"])

shutil.rmtree(tmp)
print('all good' if not failures else f'{failures} failed')
sys.exit(1 if failures else 0)
