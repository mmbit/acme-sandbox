#!/bin/sh
# A push's tests or gates on a lent machine's helper of the `tests` kind (lent.ts sends them, from the repo the bundle
# holds, its origin/main the base): first what the worker's image has for them (platform/worker/Dockerfile), the gates'
# tools laid out as the repo and Python's yaml, then the check's script (tests.ts or gates.ts, the first argument) with
# the arguments after it. The packages come through the manager's proxy, cached on the helper (npm and the wheel's hash
# check what they read from it).
set -e
script="$1"
shift
fail() { echo "The $script check could not run on the helper: $1"; exit 2; }
tools="$HOME/gates"
mkdir -p "$tools/platform/coordinator"
cp package.json package-lock.json "$tools/"
cp platform/coordinator/package.json platform/coordinator/package-lock.json "$tools/platform/coordinator/"
quiet='--ignore-scripts --no-audit --no-fund --no-update-notifier --loglevel=error'
(cd "$tools" && npm ci $quiet >/dev/null) || fail "npm ci of the gates' tools"
(cd "$tools/platform/coordinator" && npm ci --omit=dev $quiet >/dev/null &&
  rm -rf node_modules/onnxruntime-node node_modules/onnxruntime-web) || fail "npm ci of the coordinator's packages"
python3 - <<'PY' || fail "Python's yaml"
import hashlib, io, os, urllib.request, zipfile
url = ('https://files.pythonhosted.org/packages/75/e4/2c27590dfc9992f73aabbeb9241ae20220bd9452df27483b6e56d3975cc5/'
       'PyYAML-6.0.2-cp311-cp311-manylinux_2_17_x86_64.manylinux2014_x86_64.whl')
sha = '3ad2a3decf9aaba3d29c8f537ac4b243e36bef957511b4766cb0057d32b0be85'
kept = os.path.join(os.environ.get('npm_config_cache', os.path.expanduser('~')), '..', 'pyyaml.whl')
data = open(kept, 'rb').read() if os.path.exists(kept) else b''
if hashlib.sha256(data).hexdigest() != sha:
    data = urllib.request.urlopen(url, timeout=120).read()
    if hashlib.sha256(data).hexdigest() != sha:
        raise SystemExit('the wheel is not the one pinned')
    try:
        open(kept, 'wb').write(data)
    except OSError:
        pass
zipfile.ZipFile(io.BytesIO(data)).extractall(os.path.expanduser('~/python'))
PY
PYTHONPATH="$HOME/python" GATES_HOME="$tools" exec node "shared/gates/$script" --base origin/main "$@"
