#!/bin/sh
# Browser render dependencies inside the helper's closed network.
set -eu
npm ci --prefix shared/browser --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error >/dev/null
ln -s ../../shared/browser/node_modules platform/coordinator/node_modules
exec node shared/browser/onhelper.ts "$1"
