#!/usr/bin/env python3
"""The care deployments: the products whose product.yaml says `engine: care` (infra/products.md, "The support chat").

Each is the platform's care engine (platform/care) with that product's folder as its plug-in, a container of its own,
and a phone token of its own. products.py builds them with this reading, and sync.sh makes their tokens with it
(`python3 infra/care_engines.py` prints each slug and its token's variable name, one deployment per line), so the two
never disagree.
"""
import glob, os, re, sys, yaml

# a product's folder name as products.py takes it: a slug, never one starting with _ (the template, the cycles' pages)
SLUG = re.compile(r'[a-z0-9][a-z0-9-]{0,40}')

def slug_of(path):
    """The slug of products/<slug>/product.yaml, or None for a folder that is no product's."""
    slug = os.path.basename(os.path.dirname(path))
    return slug if SLUG.fullmatch(slug) else None

def manifest(path, quiet=False):
    """A product.yaml as a mapping, or None (one that doesn't parse says so on stderr, unless quiet)."""
    try:
        p = yaml.safe_load(open(path)) or {}
    except yaml.YAMLError as e:
        if not quiet:
            print(f'skipping {os.path.basename(os.path.dirname(path))}: {e}', file=sys.stderr)
        return None
    return p if isinstance(p, dict) else None

def engines(manifests):
    """The care deployments' slugs, sorted, from {slug: manifest or None}."""
    return sorted(slug for slug, p in manifests.items() if slug and p and p.get('engine') == 'care')

def token_name(slug):
    """The variable a deployment's phone token goes by: sync.sh exports it, Compose fills it in, and CARE_ENGINES names
    it for the voice line."""
    return 'CARE_PHONE_TOKEN_' + slug.upper().replace('-', '_')

def read(root):
    paths = sorted(glob.glob(os.path.join(root, 'products', '*', 'product.yaml')))
    return engines({slug_of(path): manifest(path, quiet=True) for path in paths})

if __name__ == '__main__':
    print(''.join(f'{slug} {token_name(slug)}\n' for slug in read(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))), end='')
