# Reads company/infra.env (the company's names on its server: plain KEY=value lines, never secrets) into exported
# variables, for infra's shell scripts, several of which run as root. Sourced (`. infra/infra-env.sh`), never run.
# The file is data, never shell: a line is taken only when it's exactly KEY=value with the value made of letters,
# digits and . _ , : @ / * ? + -. Anything else (a $( ), a quote, a space, a ;) is skipped and named on stderr, and
# nothing in it is evaluated. The names that become folders, units and buckets (SERVER_NAME, SERVER, BACKUP_BUCKET) must
# also be one plain name (a-z, 0-9 and -), never a path: harden.sh installs files as root under them. A skipped line
# leaves its key unset and in INFRA_ENV_SKIPPED, so a script that needs it says so and stops, and one whose key has a
# default fails closed on it rather than taking the default (sync.sh's SEATS, checked after the fetch, so the next merge
# can fix the file). infra/company.py reads it the same way for Python.
# INFRA_ENV names another file (the tests').
# Only the names in INFRA_ENV_KEYS become variables: a plain value under PATH, BASH_ENV, LD_PRELOAD, GIT_CONFIG_GLOBAL,
# DOCKER_HOST or the server env file's own REPO/BRANCH/GITHUB_TOKEN would steer root as surely as a $( ). A key the
# scripts need goes on this list (an infra/ change, the high-risk panel); other well-formed keys are for the coordinator
# and infra's Python (company.ts, company.py), which read them as data: here they're left out, and named on stderr.
# SERVED_FROM_REPO (products.py's routes), so the company's file reads whole. BACKUP_PRODUCTS_MB, BACKUP_BUCKET_GB (backup.py:
# the latter), BACKUP_RENDERS_GB (backup.py).
# IMPORTS_MAX_GB, IMPORTS_MIN_FREE_GB (compose.yaml's coordinator, zips.ts). CODEX_SEAT_RUNS (compose.yaml's worker).
# EMAIL_LIST_ROUTE (listmail.ts). METRICS_VISITORS (products.py).
# DEPLOY_BUILD_RESERVE_GB (compose.yaml): the measured temporary build peak, excluded from job disk shares.
# WORKER_MEMORY (compose.yaml): finite worker RAM and combined RAM/swap ceiling, in Compose byte-size syntax.
INFRA_ENV_KEYS=' SERVER_NAME SERVER BACKUP_BUCKET BACKUP_LEFT_OUT BACKUP_PRODUCTS_MB BACKUP_BUCKET_GB BACKUP_RENDERS_GB AGENT_EMAIL_DOMAIN AGENTS_EMAIL CARE_COOKIES EMAIL_SERVICE PAYMENT_METHODS SEATS SEAT_MOVES CARE_CREDIT_USD CARE_CREDIT_AT CARE_CREDIT_OTHERS_USD CARE_CREDIT_MONTHLY_USD CARE_CREDIT_MONTHLY_FROM SERVED_FROM_REPO IMPORTS_MAX_GB IMPORTS_MIN_FREE_GB DEPLOY_BUILD_RESERVE_GB CODEX_SEAT_RUNS EMAIL_LIST_ROUTE METRICS_VISITORS WORKER_MEMORY '
infra_env_file=${INFRA_ENV:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/company/infra.env}
INFRA_ENV_SKIPPED=' '
if [ -r "$infra_env_file" ]; then
  infra_env_n=0
  while IFS= read -r infra_env_line || [ -n "$infra_env_line" ]; do
    infra_env_n=$((infra_env_n + 1))
    infra_env_line=${infra_env_line%$'\r'}
    case $infra_env_line in ''|'#'*) continue ;; esac
    if [[ $infra_env_line =~ ^([A-Z_][A-Z0-9_]*)=([A-Za-z0-9._,:@/*?+-]*)$ ]]; then
      infra_env_key=${BASH_REMATCH[1]} infra_env_value=${BASH_REMATCH[2]}
      if [[ $infra_env_key =~ ^(SERVER_NAME|SERVER|BACKUP_BUCKET)$ && ! $infra_env_value =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
        echo "company/infra.env line $infra_env_n skipped: $infra_env_key must be one plain name (a-z, 0-9, -)" >&2
        INFRA_ENV_SKIPPED+="$infra_env_key "
        continue
      fi
      [[ $INFRA_ENV_KEYS == *" $infra_env_key "* ]] ||
        { echo "company/infra.env line $infra_env_n: $infra_env_key isn't one infra's scripts read; left out" >&2; continue; }
      printf -v "$infra_env_key" '%s' "$infra_env_value"
      export "$infra_env_key"
    else
      echo "company/infra.env line $infra_env_n skipped: not a plain KEY=value line" >&2
      infra_env_key=${infra_env_line%%=*}
      INFRA_ENV_SKIPPED+="${infra_env_key//[[:space:]]/} "
    fi
  done < "$infra_env_file"
  unset infra_env_line infra_env_n infra_env_key infra_env_value
else
  echo "company/infra.env not found ($infra_env_file)" >&2
fi
unset infra_env_file
