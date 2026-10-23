#!/bin/bash
# Git credential helper for the server checkout (sync.sh, report.sh): the token is read from the env file each
# time git needs it, so it never sits in .git/config or a remote URL (C1).
[ "$1" = get ] || exit 0
echo username=x-access-token
# company/infra.env read as data (infra-env.sh), never sourced
. "$(dirname "$0")/infra-env.sh"
sed -n 's/^GITHUB_TOKEN=/password=/p' "/etc/$SERVER_NAME/env"
