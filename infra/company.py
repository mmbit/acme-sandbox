"""The company's names on its server (company/infra.env: plain KEY=value lines, never secrets), for infra's Python."""
import os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # the checkout (/opt/<SERVER_NAME> on the server)
# only plain KEY=value lines, as infra/infra-env.sh takes them for the shell
LINE = re.compile(r'([A-Z_][A-Z0-9_]*)=([A-Za-z0-9._,:@/*?+-]*)')
NAMES = {'SERVER_NAME', 'SERVER', 'BACKUP_BUCKET'}   # folders, units and buckets: one plain name, never a path
NAME = re.compile(r'[a-z0-9][a-z0-9-]*')
SKIPPED = set()   # keys whose line was skipped: a setting that matters fails closed on it (products.py, backup.py)


# INFRA_ENV names another file: a test brings its own company's
def read(path=os.environ.get('INFRA_ENV') or os.path.join(ROOT, 'company', 'infra.env')):
    found = {}
    with open(path) as f:
        for n, line in enumerate((l.rstrip('\r\n') for l in f), 1):
            if not line or line.startswith('#'):
                continue
            m = LINE.fullmatch(line)
            if m and m[1] in NAMES and not NAME.fullmatch(m[2]):
                print(f'company/infra.env line {n} skipped: {m[1]} must be one plain name (a-z, 0-9, -)', file=sys.stderr)
                SKIPPED.add(m[1])
            elif m:
                found[m[1]] = m[2]
            else:
                print(f'company/infra.env line {n} skipped: not a plain KEY=value line', file=sys.stderr)
                SKIPPED.add(line.split('=', 1)[0].strip())
    return found


INFRA = read()
