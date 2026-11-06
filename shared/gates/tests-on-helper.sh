#!/bin/sh
# Push tests, gates or authored checks on a lent helper (lent.ts sends them, origin/main is the base).
# Set up the worker image's tools, then run tests.ts, gates.ts or checks (the first argument) with the arguments after
# it. The packages come through the manager's proxy, cached on the helper (npm checks what it reads from it).
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
    for browser in "$PLAYWRIGHT_BROWSERS_PATH"/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell \
      "$PLAYWRIGHT_BROWSERS_PATH"/chromium-*/chrome-linux64/chrome; do
      [ -e "$browser" ] || continue
      LD_LIBRARY_PATH="$libraries" ldd "$browser" | awk '/=> not found/ { print $1 }' | while read -r name; do
        if [ -e "$PWD/../tools/$name" ]; then ln -sf "$PWD/../tools/$name" "$libraries/$name"; fi
      done
    done
  done
  for shell in "$PLAYWRIGHT_BROWSERS_PATH"/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell; do
    [ -e "$shell" ] && export BROWSER_HEADLESS_SHELL="$shell"
    break
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
export GATES_HOME="$tools"
if [ "$script" = checks ]; then
  npm ci --prefix shared/browser $quiet >/dev/null || fail "npm ci of Playwright"
  ln -s "$tools/node_modules" node_modules
  ln -s "$tools/platform/coordinator/node_modules" platform/coordinator/node_modules
  exec node "$PWD/../check-command.ts" "$@"
fi
exec node "shared/gates/$script" --base origin/main "$@"
