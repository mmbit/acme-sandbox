#!/bin/sh
# Push tests, gates or authored checks on a lent helper (lent.ts sends them, origin/main is the base).
# Set up the worker image's tools and Python's yaml, then run tests.ts, gates.ts or checks (the first argument) with
# the arguments after it. The packages come through the manager's proxy, cached on the helper (npm and the wheel's hash
# check what they read from it).
set -eu
# The worker's Chromium takes from the bundle's libraries (tools) only those the helper lacks: every program here runs
# with the path, and the helper's own C library has to stay, the one its loader matches.
if [ -d "$PWD/../ms-playwright" ]; then
  export PLAYWRIGHT_BROWSERS_PATH="$PWD/../ms-playwright"
  libraries="$PWD/../browser-libraries"
  mkdir -p "$libraries"
  linked() { ls "$libraries" | wc -l; }
  before=-1
  while [ "$before" != "$(linked)" ]; do # until a pass links nothing new (a library linked can need more)
    before=$(linked)
    for shell in "$PLAYWRIGHT_BROWSERS_PATH"/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell; do
      LD_LIBRARY_PATH="$libraries" ldd "$shell" | awk '/=> not found/ { print $1 }' | while read -r name; do
        if [ -e "$PWD/../tools/$name" ]; then ln -sf "$PWD/../tools/$name" "$libraries/$name"; fi
      done
    done
  done
  export LD_LIBRARY_PATH="$libraries${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
script="$1"
shift
fail() { echo "The $script check could not run on the helper: $1"; exit 2; }
# Return an empty artifact even when dependency setup fails before the command runs.
if [ "$script" = checks ]; then
  tar -czf ../check-files.tar.gz --files-from /dev/null
fi
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
export PYTHONPATH="$HOME/python" GATES_HOME="$tools"
if [ "$script" = checks ]; then
  npm ci --prefix shared/browser $quiet >/dev/null || fail "npm ci of Playwright"
  ln -s "$tools/node_modules" node_modules
  ln -s "$tools/platform/coordinator/node_modules" platform/coordinator/node_modules
  exec node "$PWD/../check-command.ts" "$@"
fi
exec node "shared/gates/$script" --base origin/main "$@"
