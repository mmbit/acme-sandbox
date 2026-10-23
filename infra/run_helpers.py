"""This server's run helpers (platform/helper/README.md): one compose service per kind of run org.yaml's `runs.kinds`
declares, built from the kind's image (platform/helper/Dockerfile), so a run that falls back here has its kind's tools.
Every one has the server's caps and the same sandbox, whatever the kind asks for on the lent machine: no GPUs, and the
`runs` network, which has the coordinator alone and no way out. products.py writes them into generated/products.yaml.
The kinds are those HQ takes, as it read them: the coordinator writes their names and images to run-kinds.json in its
data volume (runs.ts publishKinds), and sync.sh deploys again when that file changes, so org.yaml has one reader. Until
the coordinator has written it (a new server), this server has the helper of a company that declares none, `default`.
"""
import json, os, re
from company import INFRA   # the server's names (company/infra.env)

DEFAULT_IMAGE = 'node:24.22.1-slim'
KIND_NAME = re.compile(r'[a-z][a-z0-9-]{0,23}')
IMAGE_NAME = re.compile(r'[a-z0-9][a-z0-9._/:@-]{0,199}')


def services(hq_data):
    return {f'run-helper-{name}': {
        'build': {'context': '../platform/helper', 'args': {'IMAGE': image}},
        'logging': {'driver': 'journald'},   # kept 14 days at most, like compose.yaml's
        'restart': 'unless-stopped',
        'init': True,   # reaps what a run leaves behind once kill(-1) ends it
        'cap_drop': ['ALL'],
        'cap_add': ['SETUID', 'SETGID'],   # (each run as uid 1000)
        'security_opt': ['no-new-privileges:true'],
        'read_only': True,
        'tmpfs': ['/tmp:size=64m,mode=755', '/work:exec,mode=1777,size=1g'],
        'cpus': 4,
        'mem_limit': '3g',   # /work's files count in it
        'memswap_limit': '3g',
        'pids_limit': 4096,
        'environment': {'HQ_URL': 'http://coordinator:8080', 'RUN_KIND': name},
        'volumes': [f"/etc/{INFRA['SERVER_NAME']}/runs-token:/state/key:ro"],   # its key (sync.sh), root's alone
        'networks': ['runs'],
    } for name, image in kinds(hq_data).items()}


def kinds(hq_data):
    """The kinds HQ takes: name -> image, each checked again against its rules, as for anything read from HQ_DATA."""
    if not os.path.isabs(hq_data):   # never a path relative to the repo, where a branch could put a file
        return {'default': DEFAULT_IMAGE}
    try:
        with open(os.path.join(hq_data, 'run-kinds.json')) as f:
            published = json.load(f)
    except (OSError, ValueError):
        return {'default': DEFAULT_IMAGE}
    named = lambda kind, key, rule: (isinstance(kind, dict) and isinstance(kind.get(key), str)
                                     and rule.fullmatch(kind[key]))
    return {kind['name']: kind['image'] for kind in (published if isinstance(published, list) else [])
            if named(kind, 'name', KIND_NAME) and named(kind, 'image', IMAGE_NAME)}
