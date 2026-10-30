#!/usr/bin/env python3
"""Turns products/*/product.yaml into containers and web addresses (infra/products.md).

With --build-shared, exports the filtered shared context before product image builds.
Writes infra/generated/products.yaml (extra compose services) and infra/generated/products.caddy (sites). The extra
services include this server's run helpers, one per kind of run (run_helpers.py).
Live products are public on their shelf at <shop host>/<slug>/, or at their own domain when they have one, where their
shelf sends page loads. The shop host is www.<zone> unless the front is public at
its own domain. Their old <slug>.<zone> sends page loads to the shelf, or the own domain ("One address for the shop"
below).
Preview and test products are at <slug>.preview.<zone>, behind the board's preview login. /__review/* (the board's review mode,
shared/review/) goes to the coordinator on previews, outside the login: the coordinator checks the board's key itself.
The board's preview key (the pv cookie) is stripped before a request reaches the product: product code never sees it.

Going public is the board's call (house rule 2, AUTHORITY.md): without the board's approval record for a product
(written by the coordinator when the board presses Approve on the desk phone, platform/coordinator/src/approvals.ts),
it stays a preview on test partners whatever its manifest says, and the deploy log says why. A product takes orders
only with all of it: `status: live` and `partner_env: live` together, the launch record (live:<slug>), and payment
through HQ (`stripe` in needs.secrets). A public site has no preview login and no review mode.

With `status: live` and the board's site:<slug> or live:<slug> record but not everything a launch needs, the product is
not a preview: it's public at the same addresses, by the same Caddy rules, with ordering closed. It gets SHOP=closed
(the app should show that it opens soon instead of a checkout; no app reads SHOP yet), STATUS=live and
PARTNER_ENV=none, and no payments token or partner keys at all, so the apps' live guards make every payment and Print API
call fail. With a record but without `status: live` (partner_env: live alone), it stays a preview.

A public product's preview door has a container of its own, preview-<slug>: the
same image as a preview, on test partners with the shop open (STATUS=preview, PARTNER_ENV=test, SHOP=open), with its own
network, data volume and env file. So the board can place a whole test order there with Stripe's test card, the shelf on
the front's preview door included, while the public site takes real orders or none. No public container ever holds a
test-mode token. A preview has its one container behind its door.

Our own front door is the product FRONT (products/front, the "opening soon" page). Once it's public (`status: live`
and the board's site:front or live:front record, like any product), it's served at one host only: its own domain when
it has one we can serve, else www.<zone>. The zone's other hosts for it redirect there permanently, path and query
kept: the bare <zone>, front.<zone>, and www.<zone> when the front has a domain of its own. The public has one address
for it (the board's call), and a front with a domain of its own is never public under our zone's name. The shelves
move to that host with it. Before that none of these hosts
has a site, so the bare domain never redirects into the preview login or to a host that isn't there. No manifest can claim
these hosts ('www' is reserved and `domain:` only takes hosts outside the zone): this is Platform's mapping, not the
product's. The bare domain has no DNS record until the board adds one A record (@, DNS only, the server's address); the
MX and TXT records there are Cloudflare Email Routing's (hello@) and stay as they are.

Each product has a Docker network of its own that only Caddy joins (no coordinator, worker or other product), and
its keys reach it single-quoted in an env file, so Compose takes them literally.

The support chat's service, when the company has one (the care deployment with `chat: true`, below): a product whose
manifest says `care: true` gets
/__care/* on its hosts, live and preview, proxied to the service with X-Care-App set by Caddy to its slug (<slug>@preview
on the preview host); every site strips a client's copy, so the service believes the header alone. Caddy sets
X-Care-Shop beside it, the shop whose one chat session the host shares: `front`
on the shop host's shelves, `front@preview` on the front's preview door's, and the app itself everywhere else (a shop of one). The
service gets each shop's apps in CARE_SHOPS. With `care: true` in its manifest the front has the chat on its own pages
too, as the shop `front` (or `front@preview`). It has no orders, but it gets a token and its /api/care/* too, for what
the company's helper does in the shop's own basket. On the preview host
the chat is behind the board's login like the product, so a preview's chat isn't open to whoever finds its address.
/api/care/* goes to the product outside the login: the service asks for orders there with the product's CARE_TOKEN,
which the product checks itself. The service's own keys (CARE_KEYS, from the desk phone) and its line to
HQ reach the care deployments' containers alone, never a product's. The service's cookie (CARE_COOKIES, its names in
company/infra.env) and the board's never reach a product.

The care deployments: every product whose manifest says `engine: care`
(care_engines.py, which sync.sh reads too) is the platform's engine (platform/care), built from the repo's root by
platform/care/Dockerfile with that product's folder as its plug-in (the PLUGIN build argument, products/<slug>), so it's
deployed when the product has a manifest and the platform has the engine; every other product builds from its own
products/<slug>/app. Each has its own container, data volume and network, the model's keys and its credit. The one
with `chat: true` serves the shops' chat and owns the line to HQ (more than one saying so: no deploy); the rest answer
phone lines only, their calls' shop their own slug. The chat's gets its session cookie's current name as CARE_COOKIE:
the last of CARE_COOKIES, or __Host-care without any, and always __Host-.

The deployments' phone routes (platform/care, "The phone"): each listens for them on a second port, 8081. The voice line
reaches them through Caddy, which is on both their networks, at http://caddy:8081/<slug>: a port inside Docker only
(compose.yaml publishes 80 and 443 alone), plain http, that passes each deployment's /<slug>/phone/* to it as /phone/*
and nothing else. The voice line never joins a deployment's network, so nothing running there can open the voice line's
WebSocket. The voice line gets the deployments in CARE_ENGINES (each one's address, its `callsAtOnce`, 2 when the
manifest names none, and the name of its token's variable, care_engines.py's), and each one's token in that variable,
which the deployment gets as CARE_PHONE_TOKEN: sync.sh makes them like VOICE_TOKEN and Compose fills them in from its environment, so no other
container gets one, no file here holds one, and a product that reaches caddy:8081 without it gets the service's 401.
"""
import os, re, sys, glob, fnmatch, json, hmac, base64, hashlib, subprocess, shutil, tempfile, secrets as rand, yaml
from datetime import datetime
from company import INFRA, SKIPPED   # the server's names (company/infra.env), and keys whose line wasn't plain
import run_helpers
import care_engines

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
public_host = os.environ['PUBLIC_HOST']
# Our zone: none on a host named for the server's IP (<ip-with-dashes>.sslip.io, <ip>.nip.io), whose zone is everyone's.
# Products wait for a domain there: nothing but the run helpers is deployed. Keep this in step with ZONE in
# platform/coordinator/src/config.ts.
zone = '' if re.search(r'(^|\.)\d{1,3}([.-]\d{1,3}){3}(\.|$)', public_host) else public_host.split('.', 1)[1]
out = os.path.join(root, 'infra', 'generated')
os.makedirs(out, exist_ok=True)

# Keys the board entered on the desk phone (the coordinator's key store): a product gets the ones its
# needs.secrets names, for its partner_env, under the stack's names (PRINTAPI_TEST_CLIENT_ID → PRINTAPI_CLIENT_ID).
# The coordinator's data volume (sync.sh finds it): the key store, the approval records and the payments signing key.
hq_data = os.environ.get('HQ_DATA') or (os.path.dirname(os.environ['SECRETS_DIR']) if os.environ.get('SECRETS_DIR') else '')
secrets_dir = os.environ.get('SECRETS_DIR') or (os.path.join(hq_data, 'secrets') if hq_data else '')
env_dir = os.environ.get('PRODUCT_ENV_DIR', f"/etc/{INFRA['SERVER_NAME']}/product-env")
BASE_URLS = {'printapi': {'test': 'https://test.printapi.nl/v2', 'live': 'https://live.printapi.nl/v2'}}
# what needs.secrets may name. anthropiceval has a test key only (ANTHROPICEVAL_TEST_API_KEY, the one jobs get), so a
# product on live partners gets no model key
TOOLS = {'printapi', 'stripe', 'anthropiceval'}
# What needs.keys may ask for: a P-256 signing key (PKCS8 DER in base64, one line), or 32 random bytes in base64
KEY_KINDS = {'p256', 'random-32'}
# our front door, once public: at its own domain or else www.<zone>. The zone's other hosts for it redirect there
FRONT = 'front'
RESERVED = {'hq', 'www', 'mail', 'preview', 'cycles', public_host.split('.', 1)[0]}  # HQ's own labels, never a product slug
TRY = 'try-'   # ...nor the start of one: a try's versions' hosts (below.)
# its session cookie's names (company/infra.env CARE_COOKIES, comma-separated): plain cookie names, or no deploy, since
# they go into the patterns that keep them from a product
CARE_COOKIES = tuple(c for c in INFRA.get('CARE_COOKIES', '').split(',') if c)
if 'CARE_COOKIES' in SKIPPED:   # a skipped line mustn't fall back to the default name
    sys.exit("company/infra.env: CARE_COOKIES isn't a plain KEY=value line; not deploying")
if not all(re.fullmatch(r'[A-Za-z0-9_-]+', c) for c in CARE_COOKIES):
    sys.exit(f"company/infra.env: CARE_COOKIES {INFRA['CARE_COOKIES']!r} isn't plain cookie names; not deploying")
# the one it sets now: the last, or the engine's own default; always __Host- (only the app's own host can set it, so a
# sibling can't plant one), or no deploy. Earlier names are old ones, only stripped
CARE_COOKIE = CARE_COOKIES[-1] if CARE_COOKIES else '__Host-care'
if not CARE_COOKIE.startswith('__Host-'):
    sys.exit(f"company/infra.env: CARE_COOKIES' last name {CARE_COOKIE!r} doesn't start with __Host-; not deploying")
# a care deployment's image: the platform's engine from the repo's root, which copies the deployment's own plug-in
# folder (products/<slug>, its PLUGIN build argument, as above); every other product's is its own app/ (product_build,
# below)
CARE_BUILD = {'context': '..', 'dockerfile': 'platform/care/Dockerfile'}
# The kit folders a product's image may take in, as named build contexts: the company's own kits (KITS_DIR, as the
# coordinator reads it) and the foundation's shared/. The app's Dockerfile copies each kit it imports to its path in the
# repo under /repo, with the app at /repo/<APP>, so the import that works in a run from the repo works in the image too.
# Every deploy builds every image again, so a fix to a kit reaches every product that uses it.
# Shared is filtered and exported once before product builds.
KIT_CONTEXTS = {'kits': os.environ.get('KITS_DIR') or os.path.join(root, 'kits'), 'shared': os.path.join(out, 'shared')}
def build_shared():
    with tempfile.TemporaryDirectory(dir=out) as stage:
        tree = os.path.join(stage, 'shared')
        shutil.copytree(os.path.join(root, 'shared'), tree, symlinks=True)
        patterns = ('*.test.*', 'test_*', '*.md', '*-check.mjs', 'check.mjs')
        for folder, _, files in os.walk(tree):
            for name in files:
                path = os.path.join(folder, name)
                if not os.path.islink(path) and any(fnmatch.fnmatchcase(name, pattern) for pattern in patterns):
                    os.unlink(path)
        tools = ('gates', 'browser', 'onair', 'review', 'namecheck', 'readability',
                 'deck/build.mjs', 'deck/inlined.mjs',
                 'covers/render.mjs', 'covers/page.html', 'covers/examples', 'covers/reference.js', 'covers/reference.png',
                 'demo/ad.mjs', 'demo/away.mjs', 'demo/core.mjs', 'demo/drawn.mjs', 'demo/harsh.mjs', 'demo/mix.mjs',
                 'demo/mockup.mjs', 'demo/present.mjs', 'demo/preview.mjs', 'demo/prices.mjs', 'demo/record.mjs',
                 'demo/renders.mjs', 'demo/synth.mjs', 'demo/slides.html', 'demo/examples',
                 'metrics/lab.ts', 'sound/beds.mjs')
        for tool in tools:
            path = os.path.join(tree, tool)
            if os.path.isdir(path) and not os.path.islink(path):
                shutil.rmtree(path)
            elif os.path.lexists(path):
                os.unlink(path)
        if os.path.exists(KIT_CONTEXTS['shared']):
            shutil.rmtree(KIT_CONTEXTS['shared'])
        shutil.move(tree, KIT_CONTEXTS['shared'])

def product_build(slug):
    if slug in engines:
        return {**CARE_BUILD, 'args': {'PLUGIN': f'products/{slug}'}}
    # and `product`, the product's own folder (the app's parent), for code it keeps beside its app, copied the same way
    return {'context': f'../products/{slug}/app', 'args': {'APP': f'products/{slug}/app'},
            'additional_contexts': {**KIT_CONTEXTS, 'product': os.path.join(root, 'products', slug)}}
def dockerfile(slug):
    return os.path.join(root, *(CARE_BUILD['dockerfile'].split('/') if slug in engines else ('products', slug, 'app', 'Dockerfile')))
CARE_KEYS = ('CARE_ANTHROPIC_API_KEY', 'CARE_EMAIL_API_KEY')   # server keys (secrets.ts OWN): the deployments' alone
# the model's prepaid credit (company/infra.env, platform/care/src/config.ts CREDIT): dollars, the time they were there
# (YYYY-MM-DD, or with a UTC time), other keys' monthly limits on it. A wrong one stops the deploy rather than the service.
# A plan's monthly credit on it: dollars and its first billing cycle's start, both or neither
CREDIT_NAMES = ('CARE_CREDIT_USD', 'CARE_CREDIT_AT', 'CARE_CREDIT_OTHERS_USD', 'CARE_CREDIT_MONTHLY_USD', 'CARE_CREDIT_MONTHLY_FROM')
CARE_CREDIT = {k: INFRA[k] for k in CREDIT_NAMES if INFRA.get(k)}
def when(v):
    """A real date (YYYY-MM-DD) or UTC time (...THH:MM[:SS]Z): the shape alone lets 2026-13-01 through to the service's
    Date.parse, whose NaN stops it at start."""
    if not re.fullmatch(r'\d{4}-\d\d-\d\d(T\d\d:\d\d(:\d\d)?Z)?', v):
        return False
    try:
        datetime.strptime(v, {10: '%Y-%m-%d', 17: '%Y-%m-%dT%H:%MZ'}.get(len(v), '%Y-%m-%dT%H:%M:%SZ'))
        return True
    except ValueError:
        return False
def dollars(v):
    return bool(re.fullmatch(r'\d+(\.\d+)?', v))
if SKIPPED & set(CREDIT_NAMES) or CARE_CREDIT and not ('CARE_CREDIT_USD' in CARE_CREDIT and 'CARE_CREDIT_AT' in CARE_CREDIT
        and ('CARE_CREDIT_MONTHLY_USD' in CARE_CREDIT) == ('CARE_CREDIT_MONTHLY_FROM' in CARE_CREDIT)
        and all((when if k in ('CARE_CREDIT_AT', 'CARE_CREDIT_MONTHLY_FROM') else dollars)(v) for k, v in CARE_CREDIT.items())):
    sys.exit('company/infra.env: CARE_CREDIT_USD needs dollars and CARE_CREDIT_AT a date (CARE_CREDIT_OTHERS_USD dollars; '
             'CARE_CREDIT_MONTHLY_USD dollars with CARE_CREDIT_MONTHLY_FROM a date); not deploying')
HOST = re.compile(r'(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}')

def approved(slug, kind='live'):
    """The board's approval record for this product (live: the launch, site: the public site only), or None (fail
    closed on anything odd)."""
    if not os.path.isabs(hq_data):  # never a path relative to the repo, where a branch could put a file
        return None
    try:
        with open(os.path.join(hq_data, 'approvals', f'{kind}-{slug}.json')) as f:
            a = json.load(f)
        return a if a.get('grant') == f'{kind}:{slug}' else None
    except (OSError, ValueError, AttributeError):
        return None

def signed(text):
    """An HMAC under the coordinator's signing key (payments.ts), so a product's token only ever says who it is."""
    path = os.path.join(hq_data, 'payments.key')
    if not os.path.exists(path):  # first deploy: make it for the coordinator, owned like the rest of its volume
        with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as f:
            f.write(rand.token_hex(32))
        st = os.stat(hq_data)
        os.chown(path, st.st_uid, st.st_gid)
    key = open(path).read().strip()
    return hmac.new(key.encode(), text.encode(), hashlib.sha256).hexdigest()

def payments_token(slug, mode):
    """Stripe stays in the coordinator (payments.ts): the product only gets a token for its own slug and mode."""
    return signed(f'pay:{slug}:{mode}')

def read_key(path):
    # This runs as root on files the coordinator writes: never follow a link planted there.
    try:
        with open(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)) as f:
            return f.read(4096).strip()
    except OSError:
        return ''

# ---- a product's own keys (needs.keys): made here, kept in the coordinator's volume, never in the repo or a log
def keySpecs(slug, manifest):
    """needs.keys as {NAME: {kind, ring, generation}}. A name starts with the slug's (EXAMPLE_ for example), so it never
    shadows the platform's. A ring names where a p256 key's retired public halves go. An entry that breaks a rule is
    left out, and the deploy log says why."""
    asked = manifest.get('needs').get('keys') if isinstance(manifest.get('needs'), dict) else None
    if asked is None:
        return {}
    if not isinstance(asked, dict):
        print(f'{slug}: needs.keys isn\'t a mapping of names to kinds: no keys', file=sys.stderr)
        return {}
    prefix = slug.upper().replace('-', '_') + '_'
    named = lambda n: isinstance(n, str) and bool(re.fullmatch(r'[A-Z][A-Z0-9_]{1,63}', n)) and n.startswith(prefix)
    specs = {}
    for name, spec in asked.items():
        spec = spec if isinstance(spec, dict) else {}
        kind, ring, generation = spec.get('kind'), spec.get('ring'), spec.get('generation', 1)
        if not named(name):
            why = f'a key\'s name is upper case and starts with {prefix}'
        elif not isinstance(kind, str) or kind not in KEY_KINDS:
            why = f'its kind is one of {", ".join(sorted(KEY_KINDS))}'
        elif ring is not None and (kind != 'p256' or not named(ring) or ring == name or ring in asked
                                  or any(accepted['ring'] == ring for accepted in specs.values())):
            why = 'only a p256 key has a ring, named like a key and apart from every key and other ring'
        elif type(generation) is not int or generation < 1 or (kind == 'random-32' and generation != 1):
            why = 'its generation is a whole number from 1, and a random-32 key stays at 1 (what it sealed needs it)'
        elif generation > 1 and ring is None:
            why = 'a p256 key rotates only into a ring, which keeps its old public halves'
        else:
            specs[name] = {'kind': kind, 'ring': ring, 'generation': generation}
            continue
        print(f'{slug}: leaving out needs.keys {name!r}: {why}', file=sys.stderr)
    return specs

def productKeys(slug, specs, mode):
    """The env with the product's keys for this mode (live or preview: a key a preview signs with never passes for a
    live one), each made the first time it's needed and kept from then on. A p256 key changes only when the manifest
    raises its generation: the new key comes in and the old one's public half joins its ring. A key is never deleted,
    since what it signed or sealed still needs it, and none is made without HQ's data."""
    if not specs or not os.path.isabs(hq_data):
        return {}
    try:
        folder = keysFolder(slug, mode)
    except (OSError, ValueError) as e:
        print(f'{slug}: no keys for {mode}: {type(e).__name__}', file=sys.stderr)
        return {}
    env = {}
    try:
        for name, spec in specs.items():
            try:
                held = heldKey(slug, folder, mode, name, spec)
            except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError) as e:
                print(f'{slug}: no {name} for {mode}: {type(e).__name__}', file=sys.stderr)
                continue
            env[name] = held['key']
            if spec['ring']:
                env[spec['ring']] = json.dumps(held['retired'], separators=(',', ':'))
    finally:
        os.close(folder)
    return env

def keysFolder(slug, mode):
    """A descriptor of <HQ_DATA>/product-keys/<slug>/<mode>, root's alone. The coordinator owns HQ_DATA and can swap a
    folder on the way at any moment, so each is opened through the one before it, never through a link, and checked on
    the descriptor held: what's read, made and renamed afterwards is relative to it."""
    fd = os.open(hq_data, os.O_PATH | os.O_DIRECTORY)
    try:
        for part in ('product-keys', slug, mode):
            try:
                os.mkdir(part, 0o700, dir_fd=fd)
            except FileExistsError:
                pass
            inner = os.open(part, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = inner
            if os.fstat(fd).st_uid != os.geteuid():
                raise ValueError(f'{part} is not a folder of ours')
    except BaseException:
        os.close(fd)
        raise
    return fd

def heldKey(slug, folder, mode, name, spec):
    file = f'{name}.json'
    try:
        with open(os.open(file, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=folder)) as f:
            held = json.load(f)
    except FileNotFoundError:
        held = {'kind': spec['kind'], 'generation': spec['generation'], 'key': newKey(spec['kind']), 'retired': []}
        print(f'{slug}: made {name} for {mode}', file=sys.stderr)
        return saveKey(folder, file, held)
    if held['kind'] != spec['kind']:
        print(f'{slug}: {name} is kept as the {held["kind"]} key it is: a kept key never changes kind', file=sys.stderr)
    elif spec['generation'] > held['generation']:
        retired = [*held['retired'], publicJwk(held['key'])]
        held = {**held, 'generation': spec['generation'], 'key': newKey(held['kind']), 'retired': retired}
        print(f'{slug}: rotated {name} for {mode} to generation {spec["generation"]}', file=sys.stderr)
        return saveKey(folder, file, held)
    elif spec['generation'] < held['generation']:
        print(f'{slug}: {name} stays at generation {held["generation"]}: a key never goes back', file=sys.stderr)
    return held

def saveKey(folder, file, held):
    """Written whole under a new name, then renamed over the old, so a failed write never leaves half a key."""
    fresh = f'{file}.{rand.token_hex(8)}'
    with open(os.open(fresh, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=folder), 'w') as f:
        json.dump(held, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(fresh, file, src_dir_fd=folder, dst_dir_fd=folder)
    return held

def newKey(kind):
    if kind == 'random-32':
        return base64.b64encode(rand.token_bytes(32)).decode()
    pem = openssl('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256')
    return base64.b64encode(openssl('pkcs8', '-topk8', '-nocrypt', '-outform', 'DER', stdin=pem)).decode()

def publicJwk(key):
    """A p256 key's public half as a JWK. Its SubjectPublicKeyInfo ends in the uncompressed point: 04, x, y."""
    spki = openssl('pkey', '-inform', 'DER', '-pubout', '-outform', 'DER', stdin=base64.b64decode(key))
    if len(spki) != 91 or spki[-65] != 4:
        raise ValueError('not a P-256 public key')
    b64url = lambda b: base64.urlsafe_b64encode(b).rstrip(b'=').decode()
    return {'kty': 'EC', 'crv': 'P-256', 'x': b64url(spki[-64:-32]), 'y': b64url(spki[-32:])}

def openssl(*args, stdin=None):
    """The key goes in and out by pipe only, never as an argument."""
    return subprocess.run(['openssl', *args], input=stdin, capture_output=True, check=True).stdout

# file: the env file's name in env_dir, the slug's own unless it's for a public product's preview container
# keys: the product's own (productKeys), under every name the platform sets
def product_env(slug, needs, partner_env, metrics_mode, extra=None, file=None, keys=None):
    env = dict(keys or {})
    # Every product counts its page loads and orders for HQ's Numbers (metrics.ts), with a key for its own slug and mode:
    # live for a public site, preview otherwise (a public product's preview container too), so the board's own visits
    # never mix with real ones. They count their days on the company's clock, as HQ reads it: the deploy publishes it in
    # HQ's data volume before this runs (infra/sync.sh, the coordinator's clock.ts).
    if os.path.isabs(hq_data):
        env.update(METRICS_URL=f'https://{public_host}', METRICS_PRODUCT=slug, METRICS_MODE=metrics_mode,
                   METRICS_TOKEN=signed(f'metrics:{slug}:{metrics_mode}'),
                   METRICS_TIME_ZONE=open(os.path.join(hq_data, 'time-zone')).read())
    # Visitors and visits as well (shared/metrics/visitors.ts: a daily-salted hash, only on a live site), once the company
    # turns them on: company/infra.env's METRICS_VISITORS=on.
    if INFRA.get('METRICS_VISITORS') == 'on':
        env['METRICS_VISITORS'] = '1'
    for name in needs:
        prefix, mode = name.upper(), partner_env.upper()
        if name == 'stripe':  # never the key itself
            if os.path.isabs(hq_data):
                env.update(PAYMENTS_URL=f'https://{public_host}', PAYMENTS_PRODUCT=slug, PAYMENTS_MODE=partner_env,
                           PAYMENTS_TOKEN=payments_token(slug, partner_env))
            continue
        if name in BASE_URLS:
            env[f'{prefix}_BASE_URL'] = BASE_URLS[name][partner_env]
        for key in sorted(os.listdir(secrets_dir)) if os.path.isdir(secrets_dir) else []:
            if key.startswith(f'{prefix}_{mode}_'):
                env[f'{prefix}_{key[len(prefix) + len(mode) + 2:]}'] = read_key(os.path.join(secrets_dir, key))
    env.update(extra or {})   # the chat's token, or the service's own settings
    # Single-quoted, so Compose takes the value literally ($ isn't expanded). A ' or a line break can't be quoted.
    for k, v in list(env.items()):
        if not v or "'" in v or '\n' in v or '\r' in v:
            print(f"{slug}: skipping {k} (unreadable, or contains a quote or a line break)", file=sys.stderr)
            del env[k]
    path = os.path.join(env_dir, f'{file or slug}.env')
    if not env:  # nothing for it (a site with ordering closed): no old keys left lying around either
        if os.path.exists(path):
            os.remove(path)
        return None
    os.makedirs(env_dir, mode=0o700, exist_ok=True)
    with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as f:
        f.writelines(f"{k}='{v}'\n" for k, v in env.items())
    return path

# A product's memory: 256m unless its manifest asks for more (`memory: 384m`), up to MEMORY_MAX, so one manifest can't
# take the server's memory from the rest. Anything else is the default, and the deploy log says so.
MEMORY_MAX = 512
def memory(slug, p):
    m = p.get('memory')
    if m is None:
        return '256m'
    if isinstance(m, str) and re.fullmatch(r'[1-9][0-9]{2}m', m) and 256 <= int(m[:-1]) <= MEMORY_MAX:
        return m
    print(f'{slug}: memory {m!r} isn\'t 256m to {MEMORY_MAX}m: it gets 256m', file=sys.stderr)
    return '256m'

# A product's own domain: a plain host name outside our zone (every <slug>.<zone> is already some product's standard
# address, or HQ's) that no other product's manifest names too, whatever its status. Two site blocks for one host make
# Caddy refuse the whole config, and would let one product's checkout return to another's site. Keep this in step with
# servedDomain() in platform/coordinator/src/manifests.ts.
manifests = {path: care_engines.manifest(path)
             for path in sorted(glob.glob(os.path.join(root, 'products', '*', 'product.yaml')))}
# the care deployments, read as sync.sh reads them for their tokens
engines = set(care_engines.engines({care_engines.slug_of(path): p for path, p in manifests.items()}))
claims = {}
for p in manifests.values():
    if p and isinstance(p.get('domain'), str):
        claims[p['domain']] = claims.get(p['domain'], 0) + 1
def servable(domain):
    return bool(HOST.fullmatch(domain)) and domain != zone and not domain.endswith(f'.{zone}') and claims.get(domain) == 1

deploy = []   # (slug, manifest) of every product that gets a container: the loop is split in two, so
              # the chat's service is known before any product's env is written
floor_reports_only = set()   # script_floor: report-only (the floor, below)
for path, p in manifests.items():
    slug = care_engines.slug_of(path)
    if slug is None or p is None:
        continue
    if not os.path.exists(dockerfile(slug)):   # a care deployment's is the platform's
        print(f'skipping {slug}: no app/Dockerfile (a care plug-in folder needs engine: care)', file=sys.stderr)
        continue
    if slug in RESERVED or slug.startswith(TRY):
        print(f'skipping {slug}: a reserved name', file=sys.stderr)
        continue
    if not zone:
        continue
    deploy.append((slug, p))
    if p.get('script_floor') == 'report-only':
        floor_reports_only.add(slug)
    elif 'script_floor' in p:
        print(f'{slug}: unknown script_floor {p["script_floor"]!r}, enforcing the floor', file=sys.stderr)

# The shop's dated offers: the front's manifest may name a JSON list in its own
# folder (`offers: app/shop/offers.json`), the one its pages show. Every other product gets that list, compact, as
# SHOP_OFFERS, so a product sold in the shop charges an offer's price on the days the shop's pages show it. A file that
# isn't a plain JSON list in the front's folder (a link out of it, say) is left out, and the deploy log says so.
def shop_offers():
    front_dir = os.path.join(root, 'products', FRONT)
    name = (manifests.get(os.path.join(front_dir, 'product.yaml')) or {}).get('offers')
    if name is None:
        return None
    path = os.path.realpath(os.path.join(front_dir, str(name)))
    try:
        if not path.startswith(os.path.realpath(front_dir) + os.sep) or os.path.getsize(path) > 65536:
            raise ValueError('not a file of up to 64 KB in its folder')
        offers = json.load(open(path))
        if not isinstance(offers, list):
            raise ValueError('not a list')
    except (OSError, ValueError) as e:
        print(f'{FRONT}: leaving its offers out ({name}: {e})', file=sys.stderr)
        return None
    return json.dumps(offers, separators=(',', ':')).replace('$', '$$')   # Compose expands $ in the compose file
offers = shop_offers()

# What goes to a product never carries the board's preview key (pv), an outside reviewer's share (ps), an agent job's pass
#, the chat's cookie or a client's X-Care-App or
# X-Care-Shop; on the chat's own route, Caddy sets both itself. Every copy of a name goes (a sibling product can set a
# second pv on .preview.<zone>): the copies at the start of the header in one match, with their separators, and each
# later one with only the ; before it, so two side by side never share one.
COOKIE_DROP = lambda c: f'^(?:\\s*{c}=[^;]*(?:;|$))+\\s*|;\\s*{c}=[^;]*'
drop_cookie = lambda c: f'header_up Cookie `{COOKIE_DROP(c)}` ""'
TO_PRODUCT = ''.join(f'{drop_cookie(c)}\n' for c in dict.fromkeys(('pv', 'ps', 'pp', *CARE_COOKIES, CARE_COOKIE)))   # (the default too, when there are no names)
# The care deployments built here, and the one that serves the shops' chat: `chat: true`, at most one, or no deploy.
# None without one
deployments = sorted(slug for slug, _ in deploy if slug in engines)
chatty = [slug for slug, p in sorted(deploy, key=lambda d: d[0]) if slug in engines and p.get('chat') is True]
if len(chatty) > 1:
    sys.exit(f"products: {', '.join(chatty)} each say chat: true, and one deployment serves the shops' chat; not deploying")
chat_engine = chatty[0] if chatty else None
care_apps, care_tokens, care_names = {}, {}, {}   # for the service's env (after the loop), keyed like X-Care-App
care_later = {}   # each care deployment's own env's arguments, for after the loop
# ...and each shop's apps, keyed like X-Care-Shop: the public shelves with the chat, and the front's preview shelves
care_shops = {FRONT: [], f'{FRONT}@preview': []}

def indent(text, depth=1):
    return ''.join('\t' * depth + line if line.strip() else line for line in text.splitlines(True))

# Every way to a container holds a request while it restarts (the Caddyfile's `upstream`): a deploy never answers 502.
HOLD = '\timport upstream\n'
TO_HQ = 'reverse_proxy coordinator:8080 {\n' + HOLD + '}\n'
# The board's preview login. What it lets through carries who is looking, X-Viewer: an opaque id per viewer and product
# (the coordinator's viewers.ts), which site() takes off whatever comes from outside
VIEWER = '\tcopy_headers X-Viewer\n'
LOGIN = 'forward_auth coordinator:8080 {\n\turi /api/preview/check\n' + VIEWER + HOLD + '}\n'
# ...on a shelf, where handle_path has taken /<slug> off: the login sends the board back to the address it asked for
SHELF_LOGIN = 'forward_auth coordinator:8080 {\n\turi /api/preview/check\n\theader_up X-Forwarded-Uri {http.request.orig_uri}\n' + VIEWER + HOLD + '}\n'
# ...for the chat: the board's, and a tester invite's people, who shop the preview door as customers. Another outside
# reviewer's share (preview.ts) never reaches it, so their chat files nothing for the board and finds no real order
board_only = lambda login: login.replace('uri /api/preview/check\n', 'uri /api/preview/check?board=1\n')

# One address for the shop. Every public product other than FRONT is a shelf at <shop host>/<slug>/ (www.<zone>, or the
# front's own domain: above), from its own container: Caddy takes /<slug> off the path and tells the app its prefix in
# X-Forwarded-Prefix, so it can build links back to itself. Its old <slug>.<zone> sends page loads to its shelf with a
# permanent redirect (same path and query): a GET or HEAD the browser marks as a navigation, or one outside /api/ and
# /__care/ from a client that marks nothing. Everything else there keeps working until it ends: an open chat's stream, a
# checkout's POST, an API call from a page loaded before. A product's own domain stays a site of its own.
# Every shelf shares the shop host's origin, and with it the browser's storage, IndexedDB, Cache Storage and service
# workers: one script-running mistake in any app reads them all and can rewrite another app's offline release. So a
# product with a domain of its own isn't served on that origin: its shelf sends page loads there (and its old address
# straight there), and the rest keeps working until it ends, as above. The shop's links to it keep working, and a
# worker the shelf installed before is retired (retireWorker).
# The front's preview door (front.preview.<zone>) has every product as a shelf, behind the board's login and with review
# mode, so the board can walk the whole shop before it's public.
#
# The look switch: every request to a product carries X-Look, Caddy's own (it replaces a client's copy). It is `next`
# on the preview doors, and on the public hosts once the board has approved the product's launch (live:<slug>);
# `today` before that. So a public product stages its next look on its preview door until that Approve (the front's
# shop look, before the shop opens).
#
# The security floor, on every public host and on the front's preview door: scripts only from the host's own files
# (inline styles are fine; no inline script, no event-handler attribute, no eval, nothing from another site), nosniff,
# and every SVG answer sandboxed, so an SVG opened as a page runs nothing. All shelves share one origin: the floor stops
# injected script, but any shelf's own script can reach the shop's chat with the customer's cookie. So an app never
# serves a customer's upload back as HTML, and only our own files are scripts (infra/products.md).
SCRIPTS, REST = "script-src 'self'", "object-src 'none'; base-uri 'self'"
# A product whose own pages still run an inline script says `script_floor: report-only` in its manifest: on its pages the
# script rule then only reports (a header of its own, Report-Only), the rest of the floor stays enforced. Anything else,
# or nothing, enforces it all (floor_reports_only, above).
def floor(slug):
    policies = (f'header Content-Security-Policy "{REST}"\nheader Content-Security-Policy-Report-Only "{SCRIPTS}"\n'
                if slug in floor_reports_only else f'header Content-Security-Policy "{SCRIPTS}; {REST}"\n')
    return policies + '''header X-Content-Type-Options nosniff
header {
\tmatch header Content-Type image/svg+xml*
\t+Content-Security-Policy sandbox
}
'''

def proxy(name, look, door=False, prefix=None):
    """The way into a product's container. Caddy alone says which door the request came through, whether it's one of our
    own visits (the Caddyfile's own_device), which look to show and the shelf's prefix; the board's and the chat's
    cookies never go along."""
    # (X-Own-Device)
    told = [f'X-Look {look}', 'X-Preview-Door 1' if door else '-X-Preview-Door', 'X-Own-Device {vars.own_device}',
            f'X-Forwarded-Prefix {prefix}' if prefix else '-X-Forwarded-Prefix']
    return f'reverse_proxy {name}:8080 {{\n' + ''.join(f'\theader_up {t}\n' for t in told) + indent(TO_PRODUCT) + HOLD + '}\n'

# The browser's kits (the sound kit, the word check) are single files, served from the checkout on every product host and
# on the cycles host at their paths in the repo. An app imports one by that relative path (from app/public/,
# '../../../../shared/demo/foley.js'), which works in Node from the repo and in the browser, where the path stops at the
# host's root. So a kit change is live in every app at the next deploy, with no copy in any app. no-cache: a browser
# checks for a newer kit on every load (its ETag).
KITS = ('/shared/demo/foley.js', '/shared/wordcheck/wordcheck.js',   # (wordcheck)
        '/shared/handoff/handoff.js', '/shared/ask/ask.js',   # (ask)
        '/shared/notebook/notebook.js')
# and whatever else the company serves the same way (company/infra.env
# SERVED_FROM_REPO, comma-separated paths in the repo). A * stands for part of one name (Caddy's path.Match, after it
# cleans the path), so an entry starts with /, its folders have none and its file name never ends with one: a * there
# would reach past the folder.
SERVED = tuple(p for p in INFRA.get('SERVED_FROM_REPO', '').split(',') if p)
if 'SERVED_FROM_REPO' in SKIPPED:
    sys.exit("company/infra.env: SERVED_FROM_REPO isn't a plain KEY=value line; not deploying")
for entry in SERVED:
    if not re.fullmatch(r'(/[\w-][\w.-]*)*/[\w*-][\w.*-]*', entry) or entry.endswith('*'):
        sys.exit(f"company/infra.env: SERVED_FROM_REPO's {entry!r} isn't a path in the repo (/ then names, none starting "
                 "with a dot, a * only in the file name and never at its end); not deploying")
def kit_route(login=''):
    """The kits' routes on a host (login: the preview's), one each, sorted by Caddy as path routes, and /__hq-origin,
    outside the login, which names HQ's origin, the only one a kit framed by HQ talks to (shared/deck/deck.js,
    shared/notebook/notebook.js.)."""
    serve = indent(f'{login}header Cache-Control no-cache\nroot * /repo\nfile_server\n')
    return ''.join(f'handle {kit} {{\n' + serve + '}\n' for kit in (*KITS, *SERVED)) + HQ_ORIGIN
HQ_ORIGIN = f'handle /__hq-origin {{\n\theader Content-Type "text/plain; charset=utf-8"\n\trespond "https://{public_host}"\n}}\n'

def care_route(app, login='', shop=None):
    """The chat's route on a host of a product with `care: true` (app: the X-Care-App this host gets; login: the
    preview's; shop: its X-Care-Shop, the app itself unless the host is one of a shop's shelves). Its stream is Server-Sent Events: flushed as it comes."""
    return 'handle /__care/* {\n' + indent(f'''{login}reverse_proxy product-{chat_engine}:8080 {{
\theader_up X-Care-App {app}
\theader_up X-Care-Shop {shop or app}
\theader_up -X-Preview-Door
\t{drop_cookie("pv")}
\t{drop_cookie("ps")}
\t{drop_cookie("pp")}
\tflush_interval -1
{HOLD}}}
''') + '}\n'

# For the public there is no review mode: Caddy answers the template's review.js with the frame's scroll link alone
# (shared/watchalong/scrolllink.js, from the repo), which keeps a live page in step with staging beside it in HQ's
# viewer and reaches nothing else, so nothing on a public site reaches the coordinator. The board reviews on the preview.
REVIEW_OFF = '''handle /__review/review.js {
\theader Content-Type "text/javascript; charset=utf-8"
\theader Cache-Control no-cache
\troot * /repo
\trewrite * /shared/watchalong/scrolllink.js
\tfile_server
}
handle /__review/* {
\trespond 404
}
'''
# /__preview/handoff: a page's link for another device, which the coordinator checks itself (preview.ts handOn)
PREVIEW_REVIEW = ''.join(f'handle {path} {{\n' + indent(TO_HQ) + '}\n' for path in ('/__preview', '/__preview/handoff', '/__review/*'))
# A PDF in HQ's viewer: its frame is sandboxed (platform/hq/shell/desk.js), and Chrome shows no PDF in a sandboxed frame,
# only a page saying it's blocked. So on every preview host a PDF that loads as a frame's page is a download (the
# viewer's frame allows them): the page stays where it was and the file saves, whichever page links it and however. An
# app's own file name stays (an inline one turns attachment). In a tab of its own a PDF still opens as before.
PDF_IN_FRAME = '''@as_frame header Sec-Fetch-Dest iframe
header @as_frame {
\tmatch {
\t\theader Content-Type application/pdf*
\t\theader !Content-Disposition
\t}
\tContent-Disposition attachment
}
header @as_frame {
\tmatch header Content-Type application/pdf*
\tContent-Disposition ^inline attachment
}
'''

def site(hosts, body):
    """A site block: X-Care-App, X-Care-Shop and X-Viewer are only ever Caddy's own, and so is the word on our own visits
    (own_device). A request that can't be served gets the Caddyfile's `back_soon` page, never a bare 502."""
    # (own_device)
    return (f'{", ".join(hosts)} {{\n\tencode gzip\n\timport back_soon\n\timport own_device\n\trequest_header -X-Care-App\n\trequest_header -X-Care-Shop\n'
            + '\trequest_header -X-Viewer\n'
            + indent(body) + '}\n')

def public_site(hosts, slug, name, chat, look, redirectBaseUrl=None):
    """A public product at the root of its own host.

    redirectBaseUrl: where its old <slug>.<zone> sends page loads, either its shelf or its own domain.
    """
    pageRedirects = redirectPageLoads(redirectBaseUrl) if redirectBaseUrl else ''
    return site(hosts, pageRedirects + floor(slug) + REVIEW_OFF + (care_route(slug) if chat else '') + kit_route()
                + 'handle {\n' + indent(proxy(name, look)) + '}\n')

def shelf(slug, name, chat, look, door=False, productDomain=None):
    """A product's path on the shop host, or on the front's preview door (door: behind the login, with review mode, its notes
    filed under the product by the path: feedback.ts productOf). Its chat is the shop's: every shelf on the host shares
    one origin and so one session. productDomain: the product's domain, where the public shelf sends page loads."""
    login = SHELF_LOGIN if door else ''
    review = f'handle /{slug}/__review/* {{\n' + indent(TO_HQ) + '}\n' if door else ''
    app, shop = (f'{slug}@preview', f'{FRONT}@preview') if door else (slug, FRONT)
    pageRedirects = workerRetirement = ''
    if productDomain and not door:
        pageRedirects = redirectPageLoads(f'https://{productDomain}')
        workerRetirement = retireWorker(f'https://{productDomain}/', f'/{slug}/')
    inside = (pageRedirects + floor(slug) + ('' if door else REVIEW_OFF)
              + (care_route(app, board_only(login), shop) if chat else '') + workerRetirement
              + 'handle {\n' + indent(login + proxy(name, look, door, f'/{slug}')) + '}\n')
    return review + f'redir /{slug} /{slug}/{{?query}} permanent\nhandle_path /{slug}/* {{\n' + indent(inside) + '}\n'

def redirectPageLoads(redirectBaseUrl):
    """Redirects page loads permanently, keeping their path and query.

    GET and HEAD requests move when marked as navigations, or when unmarked and outside /api/ and /__care/. A worker's
    script is never a page load, marked or not (a browser without Sec-Fetch-Mode still sends Service-Worker).
    Other requests stay for open chats, checkout POSTs and API calls from pages loaded before.
    """
    return ('@page {\n\tmethod GET HEAD\n\theader Sec-Fetch-Mode navigate\n}\n'
            '@unmarked {\n\tmethod GET HEAD\n\theader !Sec-Fetch-Mode\n\theader !Service-Worker\n\tnot path /api/* /__care/*\n}\n'
            f'redir @page {redirectBaseUrl}{{uri}} permanent\nredir @unmarked {redirectBaseUrl}{{uri}} permanent\n')

def retireWorker(productUrl, shelfPrefix):
    """The answer to every service worker script asked for on the shelf of a product that moved to its own domain
    (productUrl, ending in /). shelfPrefix is the product's /<slug>/ path on the shop host. A worker the shelf installed
    before may answer page loads from its cache, so they never
    reach the redirect, but the browser still asks for the worker's script after one, and gets this one in its place. It
    takes over at once, unregisters and sends the pages it held to the same path on the product's domain, without
    touching what the app kept on the shop's shared origin. The platform provides no way to migrate or clear that data
    after the move. A product that keeps data on the device needs its domain before its first site: or live: Approve.
    A new registration on the shelf ends the same way. Service-Worker-Allowed lets the script replace a worker whose app
    widened its scope beyond the shelf: the browser refuses the update without it. The script still moves only the
    shelf's own pages. No brace pair in the script names one of Caddy's placeholders."""
    script = ('addEventListener("install", () => skipWaiting());\n'
              'addEventListener("activate", event => event.waitUntil(retire()));\n'
              'async function retire() {\n'
              '\tawait clients.claim();\n'
              '\tconst pages = await clients.matchAll({ type: "window" });\n'
              f'\tconst shelfPrefix = "{shelfPrefix}";\n'
              '\tawait registration.unregister();\n'
              '\tfor (const page of pages) {\n'
              '\t\tconst url = new URL(page.url);\n'
              '\t\tif (url.pathname.startsWith(shelfPrefix))\n'
              f'\t\t\tawait page.navigate("{productUrl}" + url.pathname.slice(shelfPrefix.length) + url.search + url.hash).catch(() => null);\n'
              '\t}\n'
              '}\n')
    return ('@worker header Service-Worker script\nhandle @worker {\n'
            '\theader Content-Type "text/javascript; charset=utf-8"\n\theader Cache-Control no-store\n'
            '\theader Service-Worker-Allowed /\n'
            f'\trespond `{script}` 200\n}}\n')

def preview_site(slug, name, chat, orders, shelves=''):
    """The board's own door, behind its login and with review mode. It stays when the product is public too, and name is
    then the product's preview container. It marks its requests with
    X-Preview-Door, the app's sign that the board is there (the shop's basket takes test payments only behind it, and a
    live app counts none of them: metrics.ts). With the chat, its route is
    behind the login too, and the order endpoint the service calls (orders: the product has one) is outside it (the
    product checks CARE_TOKEN). Only a plain /api/care/<name> as sent: no other spelling that Caddy's path matching would
    clean up to it skips the login (orders apart from chat). shelves: the front's
    door carries every product's (above), with the floor."""
    endpoint = ('@care-orders vars_regexp {http.request.uri} ^/api/care/[a-z]+(\\?.*)?$\n'
                'handle @care-orders {\n' + indent(proxy(name, 'next', door=True)) + '}\n') if orders else ''
    own = (floor(slug) if shelves else '') + LOGIN + proxy(name, 'next', door=True)
    return site([f'{slug}.preview.{zone}'], PDF_IN_FRAME + PREVIEW_REVIEW + (care_route(f'{slug}@preview', board_only(LOGIN)) if chat else '') + endpoint
                + kit_route(LOGIN) + shelves + 'handle {\n' + indent(own) + '}\n')

def attach_env(name, env_file):
    if env_file:
        services[name]['env_file'] = [env_file]
        # Compose doesn't notice a changed env_file on its own: this label makes it recreate the container.
        services[name]['labels'] = {f"{INFRA['SERVER_NAME']}.env-hash": hashlib.sha256(open(env_file, 'rb').read()).hexdigest()[:16]}

def add_container(slug, name, environment, mem_limit):
    """A container of the product's image (environment: its STATUS, PARTNER_ENV and SHOP), with a data volume of its own
    and a network of its own that only Caddy joins: no coordinator, no worker, no other product. HQ_ORIGIN identifies
    HQ's origin for the app's preview framing policy."""
    services[name] = {
        'build': product_build(slug),
        'restart': 'unless-stopped',
        'networks': [name],
        'environment': {'PRODUCT': slug, **environment, 'PORT': '8080', 'DATA_DIR': '/data',
                        'HQ_ORIGIN': f'https://{public_host}'},
        'volumes': [f'{name}-data:/data'],
        'mem_limit': mem_limit, 'cpus': 0.5,
        # an init as PID 1 passes a deploy's SIGTERM on: node as PID 1 ignores it, so Docker would wait its full 10 s
        'init': True,
        'logging': {'driver': 'journald'},   # kept 14 days at most, like compose.yaml's
        # Hardened: no capabilities, no setuid way up, and a read-only image. A product writes only to its data volume, and
        # /tmp (SQLite's temp files; Care's ImageMagick, whose policy keeps it off disk) is a small tmpfs.
        'security_opt': ['no-new-privileges:true'], 'cap_drop': ['ALL'], 'read_only': True,
        'tmpfs': ['/tmp:size=64m,mode=1777'],
    }
    if offers is not None and slug != FRONT and slug not in engines:
        services[name]['environment']['SHOP_OFFERS'] = offers
    networks[name], volumes[f'{name}-data'] = {}, {}

services, volumes, networks, sites = {}, {}, {}, []
shopShelves, doorShelves, front = [], [], {}   # public and preview shelves, added after the loop
shopSlugs, doorSlugs = [], []   # their slugs, for the front's containers (SHELVES, after the loop)
shopClosed = []   # the public shelves whose ordering is closed (SHELVES_CLOSED).
# the shelves' host: the front's own domain once it's public there, so the front comes first. Keep this in step with
# shopHost() in platform/coordinator/src/approvals.ts
shopHost = f'www.{zone}'
for slug, p in sorted(deploy, key=lambda d: d[0] != FRONT):
    status = p.get('status', 'preview')
    if status not in ('preview', 'test', 'live'):  # it becomes STATUS in the compose file, where ${...} would expand
        print(f'{slug}: unknown status {status!r}, serving it as a preview', file=sys.stderr)
        status = 'preview'
    secrets = p.get('needs').get('secrets') if isinstance(p.get('needs'), dict) else None
    needs = [n for n in secrets if isinstance(n, str) and n in TOOLS] if isinstance(secrets, list) else []
    wants_live = status == 'live' or p.get('partner_env') == 'live'
    why = None
    if wants_live and not approved(slug):
        why = 'the board has not approved its launch'
    elif wants_live and 'stripe' not in needs:
        # a live product takes payment through HQ's payments tool only: without it, its checkout would be a stand-in
        # that "pays" every order, and live Print API would print them at our cost
        why = 'it does not declare stripe in needs.secrets'
    elif wants_live and not (status == 'live' and p.get('partner_env') == 'live'):
        # a public site on test partners takes test payments and places orders nobody prints; live partners behind the
        # preview login would take real money from nobody. Live is both or neither.
        why = 'going live needs both status: live and partner_env: live'
    live = wants_live and not why
    # short of a launch, status: live with the board's site (or launch) approval is a public site with ordering closed
    closed = not live and status == 'live' and bool(approved(slug, 'site') or approved(slug))
    if why:   # (no payments token)
        print(f'{slug}: wants to go live, but {why}: ' + ('a public site with ordering closed (no payments, no partner keys)'
              if closed else 'staying a preview on test partners'), file=sys.stderr)
    if status == 'live' and not (live or closed):
        status = 'preview'
    partner_env = 'live' if live else 'none' if closed else 'test'
    name = f'product-{slug}'
    add_container(slug, name, {'STATUS': status, 'PARTNER_ENV': partner_env, 'SHOP': 'closed' if closed else 'open'}, memory(slug, p))
    # The container behind its preview door: a public product's test-mode one (above), under a name no product's takes
    door_name = f'preview-{slug}' if status == 'live' and slug not in engines else name
    if door_name != name:
        add_container(slug, door_name, {'STATUS': 'preview', 'PARTNER_ENV': 'test', 'SHOP': 'open'}, services[name]['mem_limit'])
    # The chat, for a product that opts in: a token for its own slug and mode (live
    # for a public site), which the product checks when the service asks for orders; the service gets them all (below).
    # Without HQ's data the service knows no app, so no host gets the route. The front has no orders, but the service
    # reaches the shop's basket there, so it gets a token and its endpoint too.
    chat = chat_engine is not None and p.get('care') is True and slug not in engines and os.path.isabs(hq_data)
    mode = 'live' if status == 'live' else 'preview'
    extra = {'CARE_TOKEN': signed(f'care:{slug}:{mode}')} if chat else {}
    # ...and the one its preview door's container holds (the same container for a preview)
    door_extra = {'CARE_TOKEN': signed(f'care:{slug}:preview')} if chat else {}
    if slug in engines:   # a care deployment's env is written once every product's token is known
        if slug == chat_engine:
            services[name]['environment']['CARE_COOKIE'] = CARE_COOKIE   # its cookie's current name
        else:   # no CARE_SHOPS or CARE_APPS to take the phone's shop from: its calls are conversations of its own slug
            services[name]['environment']['CARE_PHONE_SHOP'] = slug
        care_later[slug] = ([] if closed else needs, partner_env, mode)
    else:   # its own keys whether or not it takes orders: what they signed and sealed outlives a closed shop
        specs = keySpecs(slug, p)
        keys = productKeys(slug, specs, mode)
        attach_env(name, product_env(slug, [] if closed else needs, partner_env, mode, extra, keys=keys))
        if door_name != name:   # in an env file whose name no slug can take (an @);
            doorKeys = productKeys(slug, specs, 'preview')
            attach_env(door_name, product_env(slug, needs, 'test', 'preview', door_extra, f'{slug}@preview', keys=doorKeys))
    if extra:
        care_names[slug] = p['name'] if isinstance(p.get('name'), str) else slug
        # the preview door takes the token its container holds. The service
        # resolves ./api/care/<name> against these, so each ends in a slash
        care_apps[f'{slug}@preview'], care_tokens[f'{slug}@preview'] = f'https://{slug}.preview.{zone}/', door_extra['CARE_TOKEN']
    look = 'next' if approved(slug) else 'today'   # on its public hosts (the switch, above)
    # its sites: the shelves, the front at the shop's host, the old address
    if status == 'live':
        standard, domain, own = f'www.{zone}' if slug == FRONT else f'{slug}.{zone}', p.get('domain'), None
        if isinstance(domain, str) and domain != standard:
            if servable(domain):
                own = domain
            else:
                print(f'{slug}: ignoring domain {domain!r}: not a host of its own we can serve', file=sys.stderr)
        if extra:   # the service reaches the product (and sends customers' links) at its own domain when it has one
            # (the front at the shop's root)
            at = own or (standard if slug == FRONT else f'{shopHost}/{slug}')
            care_apps[slug], care_tokens[slug] = f'https://{at}/', extra['CARE_TOKEN']
        if slug == FRONT:   # the shop's own pages, its shelves added after the loop; {uri} is Caddy's path plus query
            # its chat inside the floor, as on a shelf
            pages = care_route(FRONT) + 'handle {\n' + indent(proxy(name, look)) + '}\n' if chat else proxy(name, look)
            shopHost = own or standard
            front['public'] = ([shopHost], 'handle {\n' + indent(floor(slug) + pages) + '}\n')
            redirectHosts = ', '.join([zone, *([standard] if own else []), f'{slug}.{zone}'])
            sites.append(f'''{redirectHosts} {{
\tredir https://{shopHost}{{uri}} permanent
}}
''')
        else:
            shopShelves.append(shelf(slug, name, chat, look, productDomain=own))
            shopSlugs.append(slug)
            if closed:
                shopClosed.append(slug)
            if chat:
                care_shops[FRONT].append(slug)
            redirectBaseUrl = f'https://{own}' if own else f'https://{shopHost}/{slug}'
            sites.append(public_site([standard], slug, name, chat, look, redirectBaseUrl=redirectBaseUrl))
            if own:
                sites.append(public_site([own], slug, name, chat, look))
    if slug == FRONT:
        # its door's chat, with its care endpoint once it has a token; its name is
        # the shop's
        front['door'], front['chat'] = (door_name, chat, bool(extra)), chat
        front['name'] = p['name'] if isinstance(p.get('name'), str) else slug
    else:
        if slug not in engines and p.get('platform') is not True:
            doorShelves.append(shelf(slug, door_name, chat, 'next', door=True))
            doorSlugs.append(slug)
            if chat:
                care_shops[f'{FRONT}@preview'].append(f'{slug}@preview')
        sites.append(preview_site(slug, door_name, chat, bool(extra)))

# A preview container's env file goes with the container (its product back to a preview, or gone): no old keys left
for path in glob.glob(os.path.join(glob.escape(env_dir), '*@preview.env')):
    if f'preview-{os.path.basename(path)[:-len("@preview.env")]}' not in services:
        os.remove(path)

# The shop's host (www, or the front's own domain): the front's own pages at its root, and every public product's
# shelf. The front's preview door: every product's. Each front container is told the slugs of the shelves on its host
# (SHELVES, comma-separated), so its pages list only what its host serves: a product joins the public shop with the
# board's launch record, never before. The shop's host's container is told which of them take no orders yet too
# (SHELVES_CLOSED: a site record alone, or a launch short of what it needs), so it never sells what a shelf won't take
if 'door' in front:
    sites.append(preview_site(FRONT, *front['door'], ''.join(doorShelves)))
    services[front['door'][0]]['environment']['SHELVES'] = ','.join(doorSlugs)
if 'public' in front:
    services[f'product-{FRONT}']['environment']['SHELVES'] = ','.join(shopSlugs)
    services[f'product-{FRONT}']['environment']['SHELVES_CLOSED'] = ','.join(shopClosed)
if shopShelves or 'public' in front:
    hosts, front_pages = front.get('public', ([f'www.{zone}'], 'handle {\n\trespond 404\n}\n'))
    sites.append(site(hosts, REVIEW_OFF + kit_route() + ''.join(shopShelves) + front_pages))

# Venture cycle presentations (products/_cycles/<date>/presentation/) are pages agents write, like the products:
# they're served on the preview domain behind the preview login, never on HQ's own origin. From the checkout Caddy
# mounts whole (compose.yaml says why).
# Only HQ (and the cycles pages themselves, an ad's mock-ups) may frame them, and /__hq-origin tells a deck which page
# is HQ's, the only one it talks to (shared/deck/deck.js). The board's review mode works on them as on a product's door:
# /__review/* goes to the coordinator, outside the login, which checks the board's key itself (feedback.ts). Their pages
# (HTML) come from the coordinator too, behind the login: it adds review mode to each, so a page an agent wrote, or a demo
# a deck opens, never goes without it (server.ts cyclePage).
if zone:   # (they wait for a domain too)
    sites.append(f'''cycles.preview.{zone} {{
\tencode gzip
\timport back_soon
\theader Content-Security-Policy "frame-ancestors 'self' https://{public_host}"
{indent(PDF_IN_FRAME)}{indent(PREVIEW_REVIEW)}{indent(kit_route(LOGIN))}\t# the kits' routes indented with the rest
\t# its pages come from the coordinator, with review mode added
\t@page path */ *.html
\thandle @page {{
\t\tforward_auth coordinator:8080 {{
\t\t\turi /api/preview/check
{indent(HOLD, 2)}\t\t}}
{indent(TO_HQ, 2)}\t}}
\thandle {{
\t\tforward_auth coordinator:8080 {{
\t\t\turi /api/preview/check
{indent(HOLD, 2)}\t\t}}
\t\t# a deck's files keep their names when it's rebuilt: no-cache, so a browser checks for a newer one on every load
\t\t# (its ETag), as for the kits
\t\theader Cache-Control no-cache
\t\troot * /repo/products/_cycles
\t\tfile_server
\t}}
}}
''')

# A try's versions (the coordinator's ink/trypreview.ts): each at try-<n>.preview.<zone>, behind the preview login,
# served by the coordinator from the version's own files. Versions come and go between deploys, so the one site takes
# every host no other site names and gets a host's certificate when it's first asked for, once the coordinator says it's
# a version that's there (the Caddyfile's on_demand_tls ask); any other host gets none, as before. It's the catch-all,
# never *.preview.<zone>: Caddy gets no certificate of its own for a host a wildcard site covers, so every named preview
# host would wait on the ask, which refuses it (infra/test_caddy.sh shakes hands with each). /__preview, the login's way
# back with the key, is outside it, as on a product's preview.
if zone:
    sites.append(site(['https://'], 'tls {\n\ton_demand\n}\nhandle /__preview {\n' + indent(TO_HQ) + '}\nhandle {\n'
                      + indent('forward_auth coordinator:8080 {\n\turi /api/preview/check\n' + HOLD + '}\n' + TO_HQ) + '}\n'))

# The care deployments. Each gets its own keys from the desk phone and the
# credit; the chat's (chat_engine) every opted-in product's token and address too (JSON keyed like X-Care-App), each
# shop's apps (keyed like X-Care-Shop), its names and the line to HQ. The line is the chat's alone: HQ's Care app has one
# queue of cases, drafts and redrafts, numbered by the deployment that files them, so one deployment owns it. Nothing
# here goes to any other container.
quoted = lambda v: json.dumps(v, sort_keys=True).replace("'", '\\u0027')   # the env file can't hold a '
for engine in deployments:
    care_env = {}
    if os.path.isabs(hq_data):
        if engine == chat_engine:
            # a shop with no app is left out, and so is the front's door when there's no front to serve it. The shop's
            # name (and the front's own chat's) is the front's
            shops = {shop: sorted(apps) for shop, apps in care_shops.items() if apps and (shop == FRONT or 'door' in front)}
            if shops or front.get('chat'):
                care_names[FRONT] = front.get('name', FRONT)
            care_env = {'CARE_APPS': quoted(care_apps), 'CARE_SHOPS': quoted(shops), 'CARE_TOKENS': quoted(care_tokens),
                        'CARE_NAMES': quoted(care_names), 'CARE_HQ_URL': f'https://{public_host}', 'CARE_HQ_TOKEN': signed('care:hq')}
    care_env.update(CARE_CREDIT)
    for k in CARE_KEYS:
        if secrets_dir and os.path.lexists(os.path.join(secrets_dir, k)):
            care_env[k] = read_key(os.path.join(secrets_dir, k))
    attach_env(f'product-{engine}', product_env(engine, *care_later[engine], care_env))

# The phone (above): each deployment's token by name, for Compose to fill in (the same in its container and the voice
# line's), its address on Caddy's inside port, its calls at once and its token's name in CARE_ENGINES, and the inside
# port's routes. The replies stream (NDJSON), and a voice line that hangs up mid-reply closes the request
phone_token = care_engines.token_name
def calls_at_once(slug, p):
    n = p.get('callsAtOnce', 2)
    if type(n) is not int or n < 1:
        sys.exit(f"products: {slug}'s callsAtOnce {n!r} isn't a whole number from 1; not deploying")
    return n
phone_line = {}
if deployments:
    for engine in deployments:
        services[f'product-{engine}']['environment']['CARE_PHONE_TOKEN'] = f'${{{phone_token(engine)}:-}}'
    engines_env = {slug: {'url': f'http://caddy:8081/{slug}', 'calls': calls_at_once(slug, dict(deploy)[slug]),
                          'token': phone_token(slug)} for slug in deployments}
    phone_line = {'voice': {'environment': {'CARE_ENGINES': json.dumps(engines_env, separators=(',', ':')),
                                            **{phone_token(slug): f'${{{phone_token(slug)}:-}}' for slug in deployments}}}}
    # each deployment's /phone/* under its own /<slug>/, which handle_path takes off; anything else: 404
    routes = ''.join(f'''handle_path /{engine}/* {{
\thandle /phone/* {{
\t\treverse_proxy product-{engine}:8081 {{
\t\t\tflush_interval -1
\t\t}}
\t}}
\thandle {{
\t\trespond 404
\t}}
}}
''' for engine in deployments)
    sites.append('http://:8081 {\n\trequest_header -X-Care-App\n\trequest_header -X-Care-Shop\n'
                 + indent(routes + 'handle {\n\trespond 404\n}\n') + '}\n')

# Rendering the manifests alone needs no builder. Deploys export the shared context before Compose builds products.
if '--build-shared' in sys.argv and any(name not in {f'product-{slug}' for slug in deployments} for name in services):
    build_shared()

with open(os.path.join(out, 'products.yaml'), 'w') as f:
    caddy = {'caddy': {'networks': ['voice', *networks]}}   # merged into compose.yaml's caddy service (not on default: auth.ts)
    helpers = run_helpers.services(hq_data)   # (products' services are product-* and preview-*)
    yaml.safe_dump({'services': {**caddy, **phone_line, **services, **helpers}, 'volumes': volumes, 'networks': networks}, f, sort_keys=False)
with open(os.path.join(out, 'products.caddy'), 'w') as f:
    f.write('# Generated by infra/products.py. Do not edit.\n' + '\n'.join(sites))
print(f'{len(services)} product(s): ' + ', '.join(services) if services else 'no products yet' if zone else
      f'products wait for a domain: {public_host} is named for the server\'s IP, which gives them no addresses of their own')
