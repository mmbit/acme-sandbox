"""This server's run helpers (platform/helper/README.md): one compose service per kind of run org.yaml's `runs.kinds`
declares, built from the kind's image (platform/helper/Dockerfile), so a run that falls back here has its kind's tools.
Every one has the server's caps and the same sandbox, whatever the kind asks for on the lent machine: no GPUs, and the
`runs` network, which has the coordinator and no route out. Socket kinds use the manager's registry proxy.
products.py writes them into generated/products.yaml.
The kinds are those HQ takes, as it read them: the coordinator writes their names and images to run-kinds.json in its
data volume (runs.ts publishKinds), and sync.sh deploys again when that file changes, so org.yaml has one reader. Until
the coordinator has written it (a new server), this server has the helper of a company that declares none, `default`.
"""
import json, os, re
from company import INFRA   # the server's names (company/infra.env)

DEFAULT_IMAGE = 'node:24.22.1-slim'
KIND_NAME = re.compile(r'[a-z][a-z0-9-]{0,23}')
IMAGE_NAME = re.compile(r'[a-z0-9][a-z0-9._/:@-]{0,199}')
# A kind's serverImage: a compose service of this server alone, as runs.ts allows it. Compose reads any other build
# context as a path or URL, which would put this host's files in the image.
SERVER_IMAGE = re.compile(r'service:[a-z][a-z0-9-]{0,23}')


def services(hq_data):
    declared = kinds(hq_data)
    helpers = {f'run-helper-{name}': helper(name, kind) for name, kind in declared.items()}
    if any(kind.get('sockets') for kind in declared.values()):
        helpers['run-proxy'] = {
            'build': {'context': '../platform/helper'},
            'entrypoint': ['node', '/opt/helper/manager.mjs'],
            # (manager.mjs refuses to start without HQ's address, though the proxy alone never calls it)
            'environment': {'HQ_URL': 'http://coordinator:8080', 'MANAGER': 'proxy'},
            'restart': 'unless-stopped',
            'init': True,
            'user': '1000:1000',
            'cap_drop': ['ALL'],
            'security_opt': ['no-new-privileges:true'],
            'read_only': True,
            'mem_limit': '256m',
            'pids_limit': 64,
            'networks': ['runs', 'default'],
        }
    return helpers


def helper(name, kind):
    """A kind's helper on this server, built from its image or its serverImage, and behind the proxy if it keeps sockets."""
    build = {'context': '../platform/helper', 'args': {'IMAGE': kind['image']}}
    if kind.get('serverImage'):
        build['args']['IMAGE'] = 'run-base'
        build['additional_contexts'] = {'run-base': kind['serverImage']}
    environment = {'HQ_URL': 'http://coordinator:8080', 'RUN_KIND': name}
    memory_gb = 3   # /cache's files count in it
    tmpfs = ['/tmp:size=64m,mode=755']
    if kind.get('sockets'):
        environment.update({'HELPER_LOCKED': '1', 'HTTPS_PROXY': 'http://run-proxy:3128', 'HTTP_PROXY': 'http://run-proxy:3128'})
        # Its packages' downloads and the base its runs stand on outlive each run here: a quarter of its memory, as
        # manager.mjs gives a lent machine's.
        tmpfs.append(f'/cache:mode=1777,size={memory_gb * 1024 // 4}m')
    return {
        'build': build,
        'logging': {'driver': 'journald'},   # kept 14 days at most, like compose.yaml's
        'restart': 'unless-stopped',
        'init': True,   # reaps what a run leaves behind once kill(-1) ends it
        'cap_drop': ['ALL'],
        'cap_add': ['SETUID', 'SETGID'],   # (each run as uid 1000)
        'security_opt': ['no-new-privileges:true'],
        'read_only': True,
        'tmpfs': tmpfs,
        'cpus': 4,
        'mem_limit': f'{memory_gb}g',
        'memswap_limit': f'{memory_gb}g',
        'pids_limit': 4096,
        'environment': environment,
        # its key (sync.sh), root's alone, and the runs' workspace on disk: a push's checkout, tools and packages take
        # over 2 GB, which in memory would leave its runs too little of the 3 GB
        'volumes': [f"/etc/{INFRA['SERVER_NAME']}/runs-token:/state/key:ro", f'run-helper-{name}-work:/work'],
        'networks': ['runs'],
    }


def volumes(helpers):
    """The named volumes the helpers mount (compose's top-level volumes): each one's workspace, as helper() names it"""
    return {mount.split(':')[0]: {} for service in helpers.values() for mount in service.get('volumes', [])
            if not mount.startswith('/')}


def kinds(hq_data):
    """The kinds HQ takes, each checked again against its rules, as for anything read from HQ_DATA."""
    if not os.path.isabs(hq_data):   # never a path relative to the repo, where a branch could put a file
        return {'default': {'image': DEFAULT_IMAGE}}
    try:
        with open(os.path.join(hq_data, 'run-kinds.json')) as f:
            published = json.load(f)
    except (OSError, ValueError):
        return {'default': {'image': DEFAULT_IMAGE}}
    named = lambda kind, key, rule: (isinstance(kind, dict) and isinstance(kind.get(key), str)
                                     and rule.fullmatch(kind[key]))
    checked = lambda kind: (named(kind, 'name', KIND_NAME) and named(kind, 'image', IMAGE_NAME)
                            and ('serverImage' not in kind or named(kind, 'serverImage', SERVER_IMAGE)))
    return {kind['name']: {'image': kind['image'], 'sockets': kind.get('sockets') is True,
                           'serverImage': kind.get('serverImage')}
            for kind in (published if isinstance(published, list) else []) if checked(kind)}
