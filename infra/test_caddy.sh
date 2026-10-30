#!/bin/bash
# bash infra/test_caddy.sh: runs the real Caddyfile in a real Caddy (CADDY=path, or caddy on PATH; from its GitHub
# release, no Docker) in front of stand-ins for the coordinator and the voice line, which log the path the way the
# coordinator routes it. Checks L2 (no worker, agent or voice API on HQ's host, however the path is spelled) and that
# everything else still reaches its service.
# With PYTHON (or python3) able to import yaml, it also runs the product sites
# infra/products.py generates for made-up products in front of stand-ins for them and the support chat's service: the
# chat's route and its headers, behind a preview's login, the order endpoint outside it, and what never reaches a product.
set -uo pipefail
caddy=${CADDY:-$(command -v caddy)} || { echo "skipped: no caddy (set CADDY=/path/to/caddy)"; exit 0; }
here=$(cd "$(dirname "$0")" && pwd) tmp=$(mktemp -d) port=$((20000 + RANDOM % 20000))
trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$tmp"' EXIT
mkdir "$tmp/gen" && echo '# none' > "$tmp/gen/products.caddy"
cat > "$tmp/stub.mjs" <<'JS'
import http from 'node:http';
// preview, every public product's preview container
for (const [name, port] of [['coordinator', +process.argv[2]], ['voice', +process.argv[3]], ['product', +process.argv[4]], ['care', +process.argv[5]], ['front', +process.argv[6]], ['preview', +process.argv[7]]])
  http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;   // as platform/coordinator/src/server.ts routes
    // the ask before an on-demand certificate: only a try's version's host
    if (path === '/api/preview/try-host') { res.writeHead(/^try-\d+\./.test(new URL(req.url, 'http://x').searchParams.get('domain') ?? '') ? 200 : 404); return res.end(); }
    if (path === '/api/me') { res.writeHead(req.headers.cookie === 'hq=board' ? 200 : 401); return res.end(); }
    // (the board's viewer id, X-Viewer, with its 200)
    if (path === '/api/preview/check' && req.headers['x-forwarded-uri']) { const board = /(^|; )pv=board(;|$)/.test(req.headers.cookie ?? ''); res.writeHead(board ? 200 : 401, { 'x-login-returns': req.headers['x-forwarded-uri'], ...(board ? { 'x-viewer': 'vw_board' } : {}) }); return res.end(); }
    if (name === 'care' && path === '/__care/api/stream') {   // two events a second apart, as the chat's stream sends them
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: one\n\n');
      return setTimeout(() => res.end('data: two\n\n'), 1000);
    }
    // (the front's own stand-in, the shelf headers, SVGs)
    // a product and the chat's service say what reached them (host, path as sent, headers; the shop's two when asked with
    // x-show); anyone else an X-Care-App. A product's .svg is an SVG, its .pdf a PDF (named.pdf with its own inline name)
    const h = req.headers, site = name !== 'coordinator' && name !== 'voice';
    const shown = [...(site ? ['x-care-app', 'x-care-shop', 'x-preview-door', 'x-hq-watch', 'x-own-device', 'cookie'] : ['x-care-app']), ...(h['x-show'] ? ['x-forwarded-prefix', 'x-look'] : []),
      ...(h['x-show-viewer'] ? ['x-viewer'] : [])];
    const seen = shown.filter(k => h[k]).map(k => ` ${k}=${h[k]}`).join('');
    const typed = !site ? {} : path.endsWith('.svg') ? { 'content-type': 'image/svg+xml' } : !path.endsWith('.pdf') ? {}
      : { 'content-type': 'application/pdf', ...(path.endsWith('/named.pdf') ? { 'content-disposition': 'inline; filename="menu.pdf"' } : {}) };
    res.writeHead(200, typed); res.end(`${name} ${site ? h.host + req.url : path}${seen}`);
  }).listen(port, '127.0.0.1');
JS
stubs() { node "$tmp/stub.mjs" $((port + 1)) $((port + 2)) $((port + 3)) $((port + 4)) $((port + 5)) $((port + 6)) & stub=$!; }
stubs
# the hold through a restart shortened to 2 s, so the calm page after it shows within the test; the server's own address
# is 127.0.0.2 here, for the own_device checks
sed -e "s#/etc/caddy/generated#$tmp/gen#" -e "s#root \* /repo/infra#root * $here#" -e "s#lb_try_duration 30s#lb_try_duration 2s#" -e "s#remote_ip private_ranges#remote_ip 127.0.0.2#" -e "s#coordinator:8080#127.0.0.1:$((port + 1))#g" -e "s#voice:8080#127.0.0.1:$((port + 2))#g" \
  "$here/Caddyfile" > "$tmp/Caddyfile"
# the product sites: a chat service, a shop with the chat (public, with a domain of its own, so on both kinds of host),
# a stall (public on its shelf alone), a preview with the chat, and one without.
# Plain http on this port; Caddy picks the site by Host.
py=${PYTHON:-python3}
if $py -c 'import yaml' 2>/dev/null; then
  r=$tmp/repo; mkdir -p "$r/infra" "$r/company" "$r/platform/care" "$tmp/hq/secrets" "$tmp/hq/approvals" "$tmp/env"
  touch "$r/platform/care/Dockerfile"   # the chat's service is built from the platform's engine
  cp "$here/products.py" "$here/company.py" "$here/run_helpers.py" "$here/care_engines.py" "$r/infra/"; printf 'SERVER_NAME=testco\nCARE_COOKIES=natter,__Host-natter\nSERVED_FROM_REPO=/theme/web/*.css\n' > "$r/company/infra.env"
  # (two care deployments: the chat's, and one that answers phone lines only)
  for m in 'care:{status: preview, engine: care, chat: true}' 'desk:{status: preview, engine: care}' 'shop:{status: live, partner_env: live, domain: shop.example, care: true, needs: {secrets: [stripe]}}' \
           'stall:{status: live, partner_env: live, care: true, needs: {secrets: [stripe]}}' \
           'sprig:{status: preview, care: true}' 'plain:status: preview' 'front:{status: live, script_floor: report-only, care: true}'; do
    mkdir -p "$r/products/${m%%:*}/app"; touch "$r/products/${m%%:*}/app/Dockerfile"; echo "${m#*:}" > "$r/products/${m%%:*}/product.yaml"
  done
  echo '{"grant": "live:shop"}' > "$tmp/hq/approvals/live-shop.json"
  echo '{"grant": "live:stall"}' > "$tmp/hq/approvals/live-stall.json"   # public, on its shelf alone
  echo '{"grant": "site:front"}' > "$tmp/hq/approvals/site-front.json"   # our front door, public
  printf 'company: {timeZone: Europe/Amsterdam}\n' > "$r/company/org.yaml"
  REPO_DIR="$r" DATA_DIR="$tmp/hq" node "$here/../platform/coordinator/src/clock.ts" || exit 1
  # the browser's kits in the checkout, which Caddy serves from /repo (the word check)
  mkdir -p "$r/shared/demo" "$r/shared/wordcheck" && printf 'export const kit = 1;' > "$r/shared/demo/foley.js"
  # the frame's scroll link, a public site's answer to the template's review.js
  mkdir -p "$r/shared/watchalong" && printf '/* scroll link */' > "$r/shared/watchalong/scrolllink.js"
  printf 'export const words = 1;' > "$r/shared/wordcheck/wordcheck.js"
  # what the company serves the same way (SERVED_FROM_REPO), next to its notes
  mkdir -p "$r/theme/web" && printf ':root{}' > "$r/theme/web/spacing.css" && printf 'notes' > "$r/theme/web/README.md"
  printf 'secret' > "$r/company/secret.css"
  PUBLIC_HOST=hq.example.test HQ_DATA=$tmp/hq PRODUCT_ENV_DIR=$tmp/env $py "$r/infra/products.py" > /dev/null 2>&1
  # (the phone's inside port, on a port of its own here; the try versions' catch-all on the preview hosts, as HQ's own
  # site is this port's catch-all.)
  to=(-e "s#coordinator:8080#127.0.0.1:$((port + 1))#g" -e "s#product-care:8080#127.0.0.1:$((port + 4))#g" -e "s#product-front:8080#127.0.0.1:$((port + 5))#g"
      -e "s#product-[a-z]+:8080#127.0.0.1:$((port + 3))#g" -e "s#preview-[a-z]+:8080#127.0.0.1:$((port + 6))#g" -e "s#root \* /repo#root * $r#")   # (preview-)
  sed -E -e "s#^http://:8081 \{#http://:$((port + 7)) {#" -e "s#product-care:8081#127.0.0.1:$((port + 4))#g" -e "s#product-desk:8081#127.0.0.1:$((port + 3))#g" \
    -e "s#^https:// \{#http://*.preview.example.test:$port {#" \
    -e "s#^([a-z][^\t{]*) \{#\1 {#" -e "/^http:/!{/^[a-z*]/s#([*a-z0-9.-]+)(,| \{)#http://\1:$port\2#g}" -e "/^\ttls \{/,/^\t\}/d" \
    "${to[@]}" "$r/infra/generated/products.caddy" > "$tmp/gen/products.caddy"
fi
PUBLIC_HOST=:$port "$caddy" run --config "$tmp/Caddyfile" --adapter caddyfile > "$tmp/caddy.log" 2>&1 &
for _ in $(seq 50); do curl -s -o /dev/null "http://127.0.0.1:$port/" && break; sleep 0.1; done

failures=0
get() { curl -s --path-as-is -w ' %{http_code}' "${@:2}" "http://127.0.0.1:$port$1"; }
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got '$2', want '$3'"; failures=$((failures + 1)); fi; }
for p in /api/worker/claim /API/Worker/claim /api/worker%2Fclaim /api/%77orker/claim /api/./worker/claim /x/../api/worker/claim \
         /api/%2e/worker/claim //api/worker/claim /api//worker/claim '/api/worker/claim?x=1' /api/worker /api/agent/event \
         /api/Agent/job /api/voice/call-context /api/voice/call-ticket '/api/%76oice/call-end'; do
  check "$p: 404" "$(get "$p")" " 404"
done
# spellings Caddy doesn't match: they must not reach an internal route either (the coordinator 404s them)
for p in '/api\worker/claim' '/api/worker;x/claim' '/api/voice;x/call-ticket'; do
  r=$(get "$p"); [[ $r =~ ^coordinator\ /api/(worker|agent|voice)/ ]] && check "$p: no internal route" "$r" "not internal" || check "$p: no internal route" ok ok
done
for p in /api/mail/inbound /api/twilio/voice /api/pay/checkout /api/preview/check /; do check "$p: coordinator" "$(get "$p")" "coordinator $p 200"; done
# the board's dictation (intercom, desk phone) is HQ's own /api/voice, not the voice line's API
check 'POST /api/voice?lang=en (the board dictating): coordinator' "$(get '/api/voice?lang=en' -X POST -H 'Cookie: hq=board')" 'coordinator /api/voice 200'
check '/voice/twilio: voice line' "$(get /voice/twilio)" 'voice /voice/twilio 200'
check '/voice/ws without the board: refused' "$(get /voice/ws)" ' 401'
check '/voice/ws as the board: voice line' "$(get /voice/ws -H 'Cookie: hq=board')" 'voice /voice/ws 200'
# a join link's page and its room: public, each checks the link's token
check '/voice/join without the board: voice line' "$(get /voice/join)" 'voice /voice/join 200'
check '/join/<token>: coordinator' "$(get /join/abc_DEF-123)" 'coordinator /join/abc_DEF-123 200'

# the support chat
if [ -f "$tmp/repo/infra/generated/products.caddy" ]; then
  at() { local host=$1 path=$2; shift 2; get "$path" -H "Host: $host" "$@"; }
  check 'adapt: the generated sites are a valid config' "$(PUBLIC_HOST=:$port "$caddy" adapt --config "$tmp/Caddyfile" --adapter caddyfile > /dev/null 2>&1 && echo ok)" ok
  # a preview's chat is behind the login (products.py), so these checks log in
  check 'preview with the chat: /__care without the login, refused' "$(at sprig.preview.example.test /__care/api/health -H 'Cookie: natter=s1')" ' 401'
  check 'preview with the chat: /__care for the board, X-Care-App and X-Care-Shop <slug>@preview, forged ones replaced, no pv' \
    "$(at sprig.preview.example.test /__care/api/health -H 'X-Care-App: shop' -H 'X-Care-Shop: front' -H 'Cookie: pv=board; natter=s1')" \
    'care sprig.preview.example.test/__care/api/health x-care-app=sprig@preview x-care-shop=sprig@preview cookie=natter=s1 200'
  check 'public host: X-Care-App and X-Care-Shop <slug> (a shop of one), and the door mark never goes along' \
    "$(at shop.example.test /__care/widget.js -H 'X-Care-App: sprig@preview' -H 'X-Care-Shop: front' -H 'X-Preview-Door: 1')" 'care shop.example.test/__care/widget.js x-care-app=shop x-care-shop=shop 200'
  check "the product's own domain: X-Care-App <slug>" "$(at shop.example /__care/api/health)" 'care shop.example/__care/api/health x-care-app=shop x-care-shop=shop 200'
  check "a live product's preview door: the chat behind the login" "$(at shop.preview.example.test /__care/api/health)" ' 401'
  check "a live product's preview door, the board: <slug>@preview" "$(at shop.preview.example.test /__care/api/health -H 'Cookie: pv=board')" \
    'care shop.preview.example.test/__care/api/health x-care-app=shop@preview x-care-shop=shop@preview 200'
  check 'the order endpoint: to the product outside the login, without the chat cookie, pv or a forged X-Care-App or X-Care-Shop' \
    "$(at sprig.preview.example.test /api/care/match -X POST -H 'X-Care-App: sprig' -H 'X-Care-Shop: sprig' -H 'Cookie: pv=board; natter=s1; theme=dark')" \
    'product sprig.preview.example.test/api/care/match x-preview-door=1 cookie=theme=dark 200'
  for p in /api/care/../orders/1 /api/orders/1/..%2f..%2fcare/match /api/care/match/../../orders/1 /API/Care/match /api/care/%6datch \
           /api/care//match /api/care/match/x /api/care; do
    check "$p on a preview: behind the login" "$(at sprig.preview.example.test "$p")" ' 401'
  done
  check 'the login still guards the rest of a preview with the chat' "$(at sprig.preview.example.test /api/orders/1)" ' 401'
  check 'the board through the login: pv and the chat cookie stripped, no X-Care-App or X-Care-Shop' \
    "$(at sprig.preview.example.test /x -H 'Cookie: natter=s1; pv=board' -H 'X-Care-App: sprig' -H 'X-Care-Shop: sprig')" 'product sprig.preview.example.test/x x-preview-door=1 200'
  # its own domain from here on: the old shop.<zone> sends page loads to the shelf
  check 'a public site: the chat cookie never reaches the product, nor X-Care-App or X-Care-Shop' \
    "$(at shop.example /x -H 'Cookie: a=1; natter=s1; b=2' -H 'X-Care-App: shop' -H 'X-Care-Shop: shop')" 'product shop.example/x cookie=a=1; b=2 200'
  check 'the chat cookie by its __Host- name never reaches a product, anywhere in the header' \
    "$(at shop.example /x -H 'Cookie: __Host-natter=s1; a=1; __Host-natter=s2; b__Host-natter=3')" 'product shop.example/x cookie=a=1; b__Host-natter=3 200'
  # two copies side by side (a sibling product can set a second pv on .preview.<zone>): neither reaches a product
  for c in 'natter=s1; natter=s2' 'pv=a; pv=board; t=1' '__Host-natter=s1; __Host-natter=s2' 't=1; pv=a; pv=board' 't=1; natter=s1;natter=s2; u=2'; do
    want=$(sed -E 's/(^|; ?)(pv|natter|__Host-natter)=[^;]*//g; s/^; //' <<< "$c")
    check "side by side, '$c': only '$want' reaches the product" "$(at shop.example /x -H "Cookie: $c")" \
      "product shop.example/x${want:+ cookie=$want} 200"
  done
  check 'side by side through the login: both pv copies stripped' \
    "$(at sprig.preview.example.test /x -H 'Cookie: pv=board; pv=board; theme=dark')" 'product sprig.preview.example.test/x x-preview-door=1 cookie=theme=dark 200'
  check 'side by side on the chat route: both pv copies stripped, its cookie kept' \
    "$(at sprig.preview.example.test /__care/api/health -H 'Cookie: pv=a; pv=board; natter=s1')" \
    'care sprig.preview.example.test/__care/api/health x-care-app=sprig@preview x-care-shop=sprig@preview cookie=natter=s1 200'
  check 'the order endpoint: no __Host- chat cookie either' \
    "$(at sprig.preview.example.test /api/care/act -X POST -H 'Cookie: pv=board; __Host-natter=s1')" 'product sprig.preview.example.test/api/care/act x-preview-door=1 200'
  check 'the chat route keeps the __Host- cookie' "$(at shop.example.test /__care/api/health -H 'Cookie: __Host-natter=s1')" \
    'care shop.example.test/__care/api/health x-care-app=shop x-care-shop=shop cookie=__Host-natter=s1 200'
  check 'a product without the chat: /__care is its own path, behind the login, with no X-Care-App' \
    "$(at plain.preview.example.test /__care/api/health -H 'X-Care-App: plain' -H 'Cookie: pv=board')" 'product plain.preview.example.test/__care/api/health x-preview-door=1 200'
  check 'a product without the chat: no order endpoint outside the login' "$(at plain.preview.example.test /api/care/match)" ' 401'
  check "the service's own host: behind the login, X-Care-App stripped" "$(at care.preview.example.test /__care/api/health -H 'X-Care-App: shop')" ' 401'
  check "the service's own host, the board: X-Care-App and X-Care-Shop stripped" \
    "$(at care.preview.example.test /__care/api/health -H 'X-Care-App: shop' -H 'X-Care-Shop: front' -H 'Cookie: pv=board')" 'care care.preview.example.test/__care/api/health x-preview-door=1 200'
  check "HQ's host: X-Care-App stripped" "$(get /x -H 'X-Care-App: shop')" 'coordinator /x 200'
  # the stream: the first event arrives before the second is sent (a second later), gzip asked for or not
  for enc in identity gzip; do
    first=$(timeout 5 curl -sN --compressed -H "Host: sprig.preview.example.test" -H 'Cookie: pv=board' -H "Accept-Encoding: $enc" "http://127.0.0.1:$port/__care/api/stream" |
      { start=$(date +%s%N); IFS= read -r line; echo "$line $(( ($(date +%s%N) - start) / 1000000 ))"; })
    check "the stream ($enc): the first event at once" "$(awk '{print $1, $2, ($3 < 700 ? "soon" : "late " $3 "ms")}' <<< "$first")" 'data: one soon'
  done
  # our front door: public at www only; front.<zone> and the bare zone send every path there for good; review mode only
  # on the board's preview door
  # the front has its own stand-in
  check 'front: www serves it' "$(at www.example.test /)" 'front www.example.test/ 200'
  for h in front.example.test example.test; do
    check "front: $h redirects to www, path and query kept" "$(at $h '/a/b?lang=nl' -o /dev/null -w '%{redirect_url} %{http_code}')" 'https://www.example.test/a/b?lang=nl 301'
  done
  check 'front: no review mode on www (the scroll link alone)' "$(at www.example.test /__review/review.js)" '/* scroll link */ 200'
  check "front: the board's preview door keeps it" "$(at front.preview.example.test /__review/review.js)" 'coordinator /__review/review.js 200'
  # the front with care: true: the chat on the shop's own pages, as the shop. No orders, but the service's endpoint for
  # the shop's basket
  check "front: its own chat on www, X-Care-App and X-Care-Shop front, forged ones replaced" \
    "$(at www.example.test /__care/api/health -H 'X-Care-App: shop' -H 'X-Care-Shop: shop')" 'care www.example.test/__care/api/health x-care-app=front x-care-shop=front 200'
  check "front: its own chat on its door, behind the login" "$(at front.preview.example.test /__care/api/health)" ' 401'
  check "front: its own chat on its door, the board: front@preview" "$(at front.preview.example.test /__care/api/health -H 'Cookie: pv=board' -H 'X-Care-Shop: front')" \
    'care front.preview.example.test/__care/api/health x-care-app=front@preview x-care-shop=front@preview 200'
  check "front: the service's endpoint on its door: its preview container, outside the login" \
    "$(at front.preview.example.test /api/care/magnet -X POST -H 'Cookie: natter=s1; theme=dark')" \
    'preview front.preview.example.test/api/care/magnet x-preview-door=1 cookie=theme=dark 200'
  for p in /api/care/../orders/1 /API/Care/magnet /api/care/%6dagnet /api/care//magnet /api/care/magnet/x /api/care; do
    check "front: $p on its door: behind the login" "$(at front.preview.example.test "$p")" ' 401'
  done
  # one address for the shop: a public product is a shelf at www/<slug>/ (one without a domain of its own: below)
  check 'shelf: the app gets its own path, its prefix and its look, a forged prefix replaced' \
    "$(at www.example.test '/stall/a/b?c=1' -H 'X-Show: 1' -H 'X-Forwarded-Prefix: /sprig' -H 'X-Look: next' -H 'Cookie: pv=board; t=1')" \
    'product www.example.test/a/b?c=1 cookie=t=1 x-forwarded-prefix=/stall x-look=next 200'
  check 'shelf: its bare path gains the slash, query kept' "$(at www.example.test '/stall?c=1' -o /dev/null -D - | tr -d '\r' | grep -i '^location:')" 'Location: /stall/?c=1'
  # every shelf's chat is the shop's: one session across www
  check 'shelf: its chat, X-Care-App <slug>, X-Care-Shop the front, forged ones replaced' \
    "$(at www.example.test /stall/__care/api/health -H 'X-Care-App: sprig@preview' -H 'X-Care-Shop: shop')" 'care www.example.test/__care/api/health x-care-app=stall x-care-shop=front 200'
  check 'shelf: no review mode (the scroll link alone)' "$(at www.example.test /stall/__review/review.js)" '/* scroll link */ 200'
  check 'shelf: no review notes either' "$(at www.example.test /stall/__review/notes -X POST)" ' 404'
  # HQ's watch marks its requests with its mark for the app, which the app checks (shared/metrics): it goes along as sent
  check "HQ's watch: its mark reaches a shelf and a product's own domain" \
    "$(at www.example.test /stall/x -H 'X-HQ-Watch: m1') | $(at shop.example /x -H 'X-HQ-Watch: m1')" \
    'product www.example.test/x x-hq-watch=m1 200 | product shop.example/x x-hq-watch=m1 200'
  check 'www: a preview has no shelf (the front answers its path)' "$(at www.example.test /sprig/x -H 'X-Show: 1')" 'front www.example.test/sprig/x x-look=today 200'
  check "www: the front's pages, no prefix, today's look (no launch record), a forged look replaced" \
    "$(at www.example.test /about -H 'X-Show: 1' -H 'X-Look: next' -H 'X-Forwarded-Prefix: /shop')" 'front www.example.test/about x-look=today 200'
  # the old address: page loads move to the shelf, the rest keeps working there
  moved() { local host=$1; shift; at "$host" "$@" -o /dev/null -w '%{redirect_url} %{http_code}'; }
  check 'old address: a page load moves to the shelf, path and query kept' "$(moved stall.example.test '/order?o=1' -H 'Sec-Fetch-Mode: navigate')" 'https://www.example.test/stall/order?o=1 301'
  check 'old address: so does a client that marks nothing' "$(moved stall.example.test /order)" 'https://www.example.test/stall/order 301'
  check 'old address: a HEAD too' "$(moved stall.example.test / -I -H 'Sec-Fetch-Mode: navigate')" 'https://www.example.test/stall/ 301'
  check 'old address of a product with its own domain: a page load goes straight there' "$(moved shop.example.test '/order?o=1' -H 'Sec-Fetch-Mode: navigate')" 'https://shop.example/order?o=1 301'
  check "old address: a page's fetch stays" "$(at shop.example.test /api/orders/1 -H 'Sec-Fetch-Mode: cors')" 'product shop.example.test/api/orders/1 200'
  check "old address: a page's script stays" "$(at shop.example.test /app.js -H 'Sec-Fetch-Mode: no-cors')" 'product shop.example.test/app.js 200'
  check 'old address: an API call that marks nothing stays' "$(at shop.example.test /api/orders/1)" 'product shop.example.test/api/orders/1 200'
  check 'old address: a POST stays (a checkout)' "$(at shop.example.test /api/pay -X POST -H 'Sec-Fetch-Mode: navigate')" 'product shop.example.test/api/pay 200'
  check "old address: an open chat's stream stays" "$(at shop.example.test /__care/api/health)" 'care shop.example.test/__care/api/health x-care-app=shop x-care-shop=shop 200'
  check "the product's own domain: no move" "$(at shop.example /order -H 'Sec-Fetch-Mode: navigate')" 'product shop.example/order 200'
  # a product with its own domain isn't served on the shop's origin (its storage and service worker would be every
  # shelf's): its shelf sends page loads there, and the rest keeps working until it ends, as at the old address
  check 'shelf of a product with its own domain: a page load moves there, path and query kept' \
    "$(moved www.example.test '/shop/order?o=1' -H 'Sec-Fetch-Mode: navigate')" 'https://shop.example/order?o=1 301'
  check 'shelf of a product with its own domain: so does a client that marks nothing, and a HEAD' \
    "$(moved www.example.test /shop/order) | $(moved www.example.test /shop/ -I -H 'Sec-Fetch-Mode: navigate')" 'https://shop.example/order 301 | https://shop.example/ 301'
  check "shelf of a product with its own domain: a page's fetch and script stay" \
    "$(at www.example.test /shop/api/orders/1 -H 'Sec-Fetch-Mode: cors') | $(at www.example.test /shop/app.js -H 'Sec-Fetch-Mode: no-cors')" \
    'product www.example.test/api/orders/1 200 | product www.example.test/app.js 200'
  # a worker its shelf installed before answers page loads from its cache, so the browser's next ask for its script
  # gets the retiring worker, from a browser that marks it or not
  retiring() {
    local responseBody contentType allowedScope statusCode
    responseBody=$(at www.example.test "$@" -H 'Service-Worker: script' -D "$tmp/head")
    contentType=$(grep -io '^content-type: text/javascript' "$tmp/head")
    allowedScope=$(tr -d '\r' < "$tmp/head" | grep -i '^service-worker-allowed:')
    statusCode=${responseBody##* }
    echo "$contentType $allowedScope $statusCode"
  }
  check "shelf of a product with its own domain: a worker's script is the retiring worker at any scope, never the app's" \
    "$(retiring /shop/sw.js -H 'Sec-Fetch-Mode: same-origin' -H 'Sec-Fetch-Dest: serviceworker') | $(retiring /shop/a/sw.js)" \
    'Content-Type: text/javascript Service-Worker-Allowed: / 200 | Content-Type: text/javascript Service-Worker-Allowed: / 200'
  check 'service worker scripts still reach the own domain and a shelf without its own domain' \
    "$(at shop.example /sw.js -H 'Sec-Fetch-Mode: same-origin' -H 'Service-Worker: script') | $(at www.example.test /stall/sw.js -H 'Sec-Fetch-Mode: same-origin' -H 'Service-Worker: script')" \
    'product shop.example/sw.js 200 | product www.example.test/sw.js 200'
  check "front's preview door: a product with its own domain keeps its worker behind the login" \
    "$(at front.preview.example.test /shop/sw.js -H 'Sec-Fetch-Mode: same-origin' -H 'Service-Worker: script') | $(at front.preview.example.test /shop/sw.js -H 'Sec-Fetch-Mode: same-origin' -H 'Service-Worker: script' -H 'Cookie: pv=board')" \
    ' 401 | preview front.preview.example.test/sw.js x-preview-door=1 200'
  check 'shelf of a product with its own domain: an API call that marks nothing and a POST stay' \
    "$(at www.example.test /shop/api/orders/1) | $(at www.example.test /shop/api/pay -X POST -H 'Sec-Fetch-Mode: navigate')" \
    'product www.example.test/api/orders/1 200 | product www.example.test/api/pay 200'
  check "shelf of a product with its own domain: an open chat stays, the shop's" "$(at www.example.test /shop/__care/api/health)" \
    'care www.example.test/__care/api/health x-care-app=shop x-care-shop=front 200'
  # the front's preview door: every product a shelf, behind the login, with review mode filed by its path
  check "front's door: a shelf behind the login" "$(at front.preview.example.test /sprig/x)" ' 401'
  check "front's door: the login returns to the shelf's address" \
    "$(at front.preview.example.test '/sprig/order?x=1' -o /dev/null -D - | tr -d '\r' | grep -i '^x-login-returns:')" 'X-Login-Returns: /sprig/order?x=1'
  check "a preview's login returns to its address" \
    "$(at sprig.preview.example.test '/order?x=1' -o /dev/null -D - | tr -d '\r' | grep -i '^x-login-returns:')" 'X-Login-Returns: /order?x=1'
  check "front's door: a shelf for the board, the door's mark, next look" "$(at front.preview.example.test /sprig/x -H 'Cookie: pv=board' -H 'X-Show: 1')" \
    'product front.preview.example.test/x x-preview-door=1 x-forwarded-prefix=/sprig x-look=next 200'
  # a public product's door, the front's included, goes to its preview container
  check "front's door: its own pages from its preview container, the next look" "$(at front.preview.example.test / -H 'Cookie: pv=board' -H 'X-Show: 1')" \
    'preview front.preview.example.test/ x-preview-door=1 x-look=next 200'
  check "front's door: a public product's shelf from its preview container" "$(at front.preview.example.test /shop/x -H 'Cookie: pv=board' -H 'X-Show: 1')" \
    'preview front.preview.example.test/x x-preview-door=1 x-forwarded-prefix=/shop x-look=next 200'
  check "a public product's own preview door: its preview container" "$(at shop.preview.example.test /x -H 'Cookie: pv=board')" \
    'preview shop.preview.example.test/x x-preview-door=1 200'
  check "a public product's order endpoint on its preview door: its preview container, outside the login" \
    "$(at shop.preview.example.test /api/care/match -X POST)" 'preview shop.preview.example.test/api/care/match x-preview-door=1 200'
  check "front's door: a shelf's review notes go to the coordinator with its path, outside the login" \
    "$(at front.preview.example.test /sprig/__review/notes -X POST)" 'coordinator /sprig/__review/notes 200'
  check "front's door: a shelf's chat, behind the login, X-Care-App <slug>@preview, X-Care-Shop front@preview" \
    "$(at front.preview.example.test /sprig/__care/api/health -H 'Cookie: pv=board' -H 'X-Care-Shop: sprig@preview')" 'care front.preview.example.test/__care/api/health x-care-app=sprig@preview x-care-shop=front@preview 200'
  check "front's door: no shelf for the chat's service" "$(at front.preview.example.test /care/x -H 'Cookie: pv=board')" 'preview front.preview.example.test/care/x x-preview-door=1 200'
  # who is looking
  check "X-Viewer: the preview check's, on a preview and a shelf on the front's door; a client's own never" \
    "$(at sprig.preview.example.test /x -H 'Cookie: pv=board' -H 'X-Show-Viewer: 1' -H 'X-Viewer: vw_forged') | $(at front.preview.example.test /sprig/x -H 'Cookie: pv=board' -H 'X-Show-Viewer: 1' -H 'X-Viewer: vw_forged')" \
    'product sprig.preview.example.test/x x-preview-door=1 x-viewer=vw_board 200 | product front.preview.example.test/x x-preview-door=1 x-viewer=vw_board 200'
  check "X-Viewer: none on a public host or shelf, or a preview's order endpoint outside the login, whatever the client sends" \
    "$(at shop.example /x -H 'X-Show-Viewer: 1' -H 'X-Viewer: vw_forged') | $(at www.example.test /stall/x -H 'X-Show-Viewer: 1' -H 'X-Viewer: vw_forged') | $(at sprig.preview.example.test /api/care/match -X POST -H 'X-Show-Viewer: 1' -H 'X-Viewer: vw_forged')" \
    'product shop.example/x 200 | product www.example.test/x 200 | product sprig.preview.example.test/api/care/match x-preview-door=1 200'
  # our own visits (the Caddyfile's own_device): the board's device HQ marked, and the server itself (127.0.0.2 here)
  check "our own visits: the device HQ marked, on a public host and a shelf; the server's own requests" \
    "$(at shop.example /x -H 'Cookie: theme=dark; hq-own-device=1') | $(at www.example.test /stall/x -H 'Cookie: hq-own-device=1') | $(at www.example.test /stall/x --interface 127.0.0.2)" \
    'product shop.example/x x-own-device=1 cookie=theme=dark; hq-own-device=1 200 | product www.example.test/x x-own-device=1 cookie=hq-own-device=1 200 | product www.example.test/x x-own-device=1 200'
  check "a visitor's: no mark, whatever the client sends, and a lookalike cookie isn't the mark" \
    "$(at shop.example /x -H 'X-Own-Device: 1') | $(at www.example.test /stall/x -H 'Cookie: hq-own-device=10; my-hq-own-device=1')" \
    'product shop.example/x 200 | product www.example.test/x cookie=hq-own-device=10; my-hq-own-device=1 200'
  # the security floor
  policy() { at "$@" -o /dev/null -D - | tr -d '\r' | grep -iE '^(content-security-policy(-report-only)?|x-content-type-options):' | LC_ALL=C sort | paste -sd '|'; }
  floor="Content-Security-Policy: script-src 'self'; object-src 'none'; base-uri 'self'|X-Content-Type-Options: nosniff"
  check 'floor: on a shelf' "$(policy www.example.test /stall/x)" "$floor"
  check "floor: on a shelf of the front's door" "$(policy front.preview.example.test /sprig/x -H 'Cookie: pv=board')" "$floor"
  check 'floor: on the old address and the own domain' "$(policy shop.example.test /api/x)|$(policy shop.example /x)" "$floor|$floor"
  check "floor: on a shelf's chat" "$(policy www.example.test /stall/__care/widget.js)" "$floor"
  check "floor: on the front's own chat, as on its pages" "$(policy www.example.test /__care/widget.js)" \
    "Content-Security-Policy-Report-Only: script-src 'self'|Content-Security-Policy: object-src 'none'; base-uri 'self'|X-Content-Type-Options: nosniff"
  check "floor: the script rule only reported on the front's own pages (script_floor: report-only), the rest enforced" "$(policy www.example.test /)" \
    "Content-Security-Policy-Report-Only: script-src 'self'|Content-Security-Policy: object-src 'none'; base-uri 'self'|X-Content-Type-Options: nosniff"
  check 'floor: an SVG is sandboxed' "$(policy www.example.test /stall/i.svg)" \
    "Content-Security-Policy: sandbox|Content-Security-Policy: script-src 'self'; object-src 'none'; base-uri 'self'|X-Content-Type-Options: nosniff"
  check "floor: not on another product's own preview" "$(policy sprig.preview.example.test /x -H 'Cookie: pv=board')" ''
  # the sound kit: from the checkout on every product host and the cycles host, behind a preview's login, never cached
  # unchecked; the rest of shared/ isn't served
  check 'kit: a public site serves it from the checkout' "$(at shop.example /shared/demo/foley.js)" 'export const kit = 1; 200'
  check 'kit: a browser checks for a newer one on every load' \
    "$(at shop.example /shared/demo/foley.js -o /dev/null -D - | tr -d '\r' | grep -i '^cache-control:')" 'Cache-Control: no-cache'
  check 'kit: on a preview, behind the login' "$(at sprig.preview.example.test /shared/demo/foley.js)" ' 401'
  check 'kit: on a preview, the board' "$(at sprig.preview.example.test /shared/demo/foley.js -H 'Cookie: pv=board')" 'export const kit = 1; 200'
  check 'kit: the cycles host, behind the login' "$(at cycles.preview.example.test /shared/demo/foley.js)" ' 401'
  check 'kit: the cycles host, the board' "$(at cycles.preview.example.test /shared/demo/foley.js -H 'Cookie: pv=board')" 'export const kit = 1; 200'
  check 'kit: nothing else of shared/ (the product answers)' "$(at shop.example /shared/demo/mix.mjs)" 'product shop.example/shared/demo/mix.mjs 200'
  check 'kit: the word check too, on a public site' "$(at shop.example /shared/wordcheck/wordcheck.js)" 'export const words = 1; 200'
  check "kit: the word check on www, where a shelf's page imports it" "$(at www.example.test /shared/wordcheck/wordcheck.js)" 'export const words = 1; 200'
  check 'kit: the word check on a preview, behind the login' "$(at sprig.preview.example.test /shared/wordcheck/wordcheck.js)" ' 401'
  # the theme's CSS the same way, and nothing else of theme/
  check 'theme: a public site serves its CSS from the checkout' "$(at shop.example /theme/web/spacing.css)" ':root{} 200'
  check "theme: on www, where a shelf's page links it" "$(at www.example.test /theme/web/spacing.css)" ':root{} 200'
  check 'theme: never cached unchecked' \
    "$(at shop.example /theme/web/spacing.css -o /dev/null -D - | tr -d '\r' | grep -i '^cache-control:')" 'Cache-Control: no-cache'
  check 'theme: on a preview, behind the login' "$(at sprig.preview.example.test /theme/web/spacing.css)" ' 401'
  check 'theme: on a preview, the board' "$(at sprig.preview.example.test /theme/web/spacing.css -H 'Cookie: pv=board')" ':root{} 200'
  check 'theme: the cycles host, the board' "$(at cycles.preview.example.test /theme/web/spacing.css -H 'Cookie: pv=board')" ':root{} 200'
  check 'theme: not its notes (the product answers)' "$(at shop.example /theme/web/README.md)" 'product shop.example/theme/web/README.md 200'
  for p in /theme/web/../../company/secret.css /theme/web/..%2f..%2fcompany%2fsecret.css /theme/web/%2e%2e/%2e%2e/company/secret.css; do
    check "theme: no way out of its folder ($p)" "$(at shop.example "$p")" "product shop.example$p 200"
  done
  # a SERVED_FROM_REPO entry that could reach past its folder, or isn't a path, stops the deploy
  for v in '/theme/web/*' '*.css' '/*/x.css' '/theme/../company/x.css' '/theme/.git/x' 'theme/web/a.css'; do
    printf 'SERVER_NAME=testco\nSERVED_FROM_REPO=%s\n' "$v" > "$tmp/bad.env"
    INFRA_ENV=$tmp/bad.env PUBLIC_HOST=hq.example.test HQ_DATA=$tmp/hq PRODUCT_ENV_DIR=$tmp/env $py "$tmp/repo/infra/products.py" > /dev/null 2>&1
    check "served from the repo: no deploy on $v" "$?" 1
  done
  # the cycle decks: framed by HQ and the cycles pages only, on every answer, and told HQ's origin
  check 'cycles: /__hq-origin names HQ, outside the login' "$(at cycles.preview.example.test /__hq-origin)" 'https://hq.example.test 200'
  # (every host that serves the kits names HQ.)
  check "a product's preview: /__hq-origin names HQ, outside the login" "$(at sprig.preview.example.test /__hq-origin)" 'https://hq.example.test 200'
  check 'a public site: /__hq-origin names HQ' "$(at shop.example /__hq-origin)" 'https://hq.example.test 200'
  for c in '' 'Cookie: pv=board'; do
    check "cycles: frame-ancestors on a page${c:+ (the board)}" \
      "$(at cycles.preview.example.test /2026-01-01/presentation/ ${c:+-H "$c"} -o /dev/null -D - | tr -d '\r' | grep -i '^content-security-policy:')" \
      "Content-Security-Policy: frame-ancestors 'self' https://hq.example.test"
  done
  # a try's versions: any other preview host goes to the coordinator, behind the
  # login, which serves a version's own files there; the login's way back outside it; a product's own host still wins
  check "try host: behind the login" "$(at try-7.preview.example.test /)" ' 401'
  check "try host: the board reaches the coordinator" "$(at try-7.preview.example.test /shell/main.js -H 'Cookie: pv=board')" 'coordinator /shell/main.js 200'
  check "try host: the login's way back, outside it" "$(at try-7.preview.example.test '/__preview?c=x')" 'coordinator /__preview 200'
  check "try host: a product's preview is still its own" "$(at plain.preview.example.test / -H 'Cookie: pv=board')" 'product plain.preview.example.test/ x-preview-door=1 200'
  # review mode on the cycles' pages too: the coordinator decides, outside the login
  check 'cycles: review mode goes to the coordinator' "$(at cycles.preview.example.test /__review/review.js)" 'coordinator /__review/review.js 200'
  check 'cycles: so do its notes' "$(at cycles.preview.example.test /__review/notes -X POST)" 'coordinator /__review/notes 200'
  # its pages come from the coordinator, which adds review mode to each, behind the login; everything else is Caddy's files
  for p in /2026-01-01/shop/ /2026-01-01/shop/index.html; do
    check "cycles: the page $p from the coordinator" "$(at cycles.preview.example.test $p -H 'Cookie: pv=board')" "coordinator $p 200"
    check "cycles: the page $p behind the login" "$(at cycles.preview.example.test $p)" ' 401'
  done
  check 'cycles: a file that is no page stays with Caddy' "$(at cycles.preview.example.test /2026-01-01/shop/shop.js -H 'Cookie: pv=board')" ' 404'
  # a deck's files keep their names when it's rebuilt: a browser checks for a newer one on every load
  mkdir -p "$tmp/repo/products/_cycles/2026-01-01/zine" && printf 'export const zine = 1;' > "$tmp/repo/products/_cycles/2026-01-01/zine/zine.js"
  check 'cycles: a file, the board' "$(at cycles.preview.example.test /2026-01-01/zine/zine.js -H 'Cookie: pv=board')" 'export const zine = 1; 200'
  check 'cycles: a file is never cached unchecked' \
    "$(at cycles.preview.example.test /2026-01-01/zine/zine.js -H 'Cookie: pv=board' -o /dev/null -D - | tr -d '\r' | grep -i '^cache-control:')" 'Cache-Control: no-cache'
  check 'cycles: a file, behind the login' "$(at cycles.preview.example.test /2026-01-01/zine/zine.js)" ' 401'
  # a PDF in HQ's viewer: Chrome shows none in its sandboxed frame, so a PDF that loads as a frame's page on a preview host
  # saves (Content-Disposition), an app's own name kept; in a tab of its own, or on a public site, it stays as it was
  printf '%%PDF-1.4' > "$tmp/repo/products/_cycles/2026-01-01/zine/zine.pdf"
  saves() { at "$@" -o /dev/null -D - | tr -d '\r' | grep -i '^content-disposition:' || echo none; }
  framed='Sec-Fetch-Dest: iframe'
  check 'a PDF in a frame: saves on a preview' "$(saves sprig.preview.example.test /a.pdf -H 'Cookie: pv=board' -H "$framed")" 'Content-Disposition: attachment'
  check "a PDF in a frame: an app's inline name turns attachment" "$(saves sprig.preview.example.test /named.pdf -H 'Cookie: pv=board' -H "$framed")" \
    'Content-Disposition: attachment; filename="menu.pdf"'
  check "a PDF in a frame: on the front door's shelf" "$(saves front.preview.example.test /sprig/a.pdf -H 'Cookie: pv=board' -H "$framed")" 'Content-Disposition: attachment'
  check 'a PDF in a frame: a cycles file' "$(saves cycles.preview.example.test /2026-01-01/zine/zine.pdf -H 'Cookie: pv=board' -H "$framed")" 'Content-Disposition: attachment'
  check 'a PDF in a tab of its own: opens as before' \
    "$(saves sprig.preview.example.test /a.pdf -H 'Cookie: pv=board' -H 'Sec-Fetch-Dest: document') | $(saves cycles.preview.example.test /2026-01-01/zine/zine.pdf -H 'Cookie: pv=board')" 'none | none'
  check 'a frame: anything but a PDF as it was' \
    "$(saves sprig.preview.example.test /x -H 'Cookie: pv=board' -H "$framed") | $(saves cycles.preview.example.test /2026-01-01/zine/zine.js -H 'Cookie: pv=board' -H "$framed")" 'none | none'
  check 'a PDF in a frame: a public site as it was' "$(saves shop.example /a.pdf -H "$framed")" 'none'
  # the phone's routes: on Caddy's inside port only, which the voice line asks
  inside() { curl -s --path-as-is -w ' %{http_code}' "${@:2}" "http://127.0.0.1:$((port + 7))$1"; }
  check "the inside port: /care/phone/turn reaches the chat's service's phone port as /phone/turn" \
    "$(inside /care/phone/turn -X POST -H 'Authorization: Bearer t' -H 'Content-Type: application/json' -d '{}')" "care 127.0.0.1:$((port + 7))/phone/turn 200"
  check "the inside port: /desk/phone/start reaches the other deployment's phone port as /phone/start" \
    "$(inside /desk/phone/start -X POST -H 'Authorization: Bearer t' -d '{}')" "product 127.0.0.1:$((port + 7))/phone/start 200"
  check 'the inside port: nothing else' \
    "$(inside /__care/api/health) | $(inside /api/care/match -X POST) | $(inside /) | $(inside /phonex) | $(inside /phone/turn -X POST) | $(inside /care/x) | $(inside /care/phonex) | $(inside /desk/__care/api/health) | $(inside /carex/phone/turn -X POST) | $(inside /shop/phone/turn -X POST)" \
    ' 404 |  404 |  404 |  404 |  404 |  404 |  404 |  404 |  404 |  404'
  check "the public hosts: /phone/* never reaches the chat's service" \
    "$(get /phone/turn -X POST) | $(at shop.example /phone/turn -X POST) | $(at www.example.test /phone/start -X POST)" \
    'coordinator /phone/turn 200 | product shop.example/phone/turn 200 | front www.example.test/phone/start 200'

  # Every host a site names has a certificate of its own, never one on demand, which the ask refuses it: the same sites on
  # their own addresses over TLS, from a local CA. A try's version gets its own when first asked for, any other host
  # none.
  mkdir -p "$tmp/tls/gen" && https=$((port + 9))
  sed -E -e "s#^http://:8081 \{#http://:$((port + 8)) {#" "${to[@]}" "$tmp/repo/infra/generated/products.caddy" > "$tmp/tls/gen/products.caddy"
  sed -e "0,/^{/s##{\n\tadmin off\n\tlocal_certs\n\tskip_install_trust\n\thttp_port $((port + 10))\n\thttps_port $https#" -e "s#$tmp/gen#$tmp/tls/gen#" \
    "$tmp/Caddyfile" > "$tmp/tls/Caddyfile"
  XDG_DATA_HOME=$tmp/tls XDG_CONFIG_HOME=$tmp/tls PUBLIC_HOST=hq.example.test "$caddy" run --config "$tmp/tls/Caddyfile" --adapter caddyfile > "$tmp/tls/caddy.log" 2>&1 &
  # (curl's exit: 0 the handshake went through, 35 it was refused)
  shake() { curl -sk --noproxy '*' --max-time 5 -o /dev/null --resolve "$1:$https:127.0.0.1" "https://$1:$https/__hq-origin"; echo $?; }
  named=$(grep -E '^[^#[:space:]].* \{$' "$tmp/repo/infra/generated/products.caddy" | grep -v '^http' | sed 's/ {$//; s/, /\n/g')
  check 'tls: the hosts read from the generated sites' "$(grep -cx 'cycles\.preview\.example\.test\|front\.preview\.example\.test' <<< "$named")" 2
  for h in hq.example.test $named; do
    for _ in $(seq 50); do [ "$(shake "$h")" = 0 ] && break; sleep 0.1; done   # (issued as Caddy starts)
    check "tls: $h has a certificate of its own" "$(shake "$h")" 0
  done
  check "tls: a try's version gets one on demand" "$(shake try-7.preview.example.test)" 0
  check 'tls: any other host none' "$(shake nope.preview.example.test)" 35
  [ $failures = 0 ] || grep '"level":"error"' "$tmp/tls/caddy.log" | head -5
else
  echo "skipped the product sites: $py can't import yaml (set PYTHON to one that can)"
fi

# A deploy restarting a container: Caddy holds the request until it's back, whatever the method, and one it can't serve
# gets the calm page (a page load) or a short line (anything else), 503 with Retry-After, never a bare 502.
kill "$stub"
wait "$stub" 2>/dev/null
get / -X POST > "$tmp/held-post" &
get /x > "$tmp/held-get" &
(
  sleep 1
  stubs
  echo "$stub" > "$tmp/stub.pid"
  wait
) &
sleep 1.8
check 'a restart: a GET held until the coordinator is back' "$(cat "$tmp/held-get")" 'coordinator /x 200'
check 'a restart: a POST too' "$(cat "$tmp/held-post")" 'coordinator / 200'
kill "$(cat "$tmp/stub.pid")"
sleep 0.3
page=$(get /x -D "$tmp/page-head"); head=$(tr -d '\r' < "$tmp/page-head" | grep -iE '^(retry-after|cache-control):' | LC_ALL=C sort | paste -sd '|')
check 'still away after the hold: the calm page, 503, no-store, Retry-After' "$(grep -o '<title>.*</title>' <<< "$page") ${page##* }|$head" \
  '<title>Back in a moment</title> 503|Cache-Control: no-store|Retry-After: 5'
check 'still away: the page reloads itself' "$(grep -c 'http-equiv="refresh"' <<< "$page")" 1
check 'still away: a POST gets the short line' "$(get / -X POST)" 'Back in a moment: please try again in a few seconds. 503'
if [ -f "$tmp/repo/infra/generated/products.caddy" ]; then
  check "still away: a product's shelf, the calm page too" "$(get /stall/x -H 'Host: www.example.test' | grep -o '<title>.*</title>\| [0-9]*$' | paste -sd ' ')" '<title>Back in a moment</title>  503'
  check "still away: a preview's login (the coordinator), the calm page" "$(get /x -H 'Host: sprig.preview.example.test' | grep -o '<title>.*</title>\| [0-9]*$' | paste -sd ' ')" '<title>Back in a moment</title>  503'
fi
echo "$([ $failures = 0 ] && echo 'all good' || echo "$failures failed")"
exit $((failures > 0))
