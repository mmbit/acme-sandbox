#!/bin/bash
# Writes the server's status report into HQ, which keeps two days of them: agents read them with hq report, the
# Overseer through /api/overseer/status (platform/coordinator/src/oversight.ts). Non-secret operational info only.
set -uo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)   # the server's checkout
# company/infra.env read as data (infra-env.sh), never sourced
. "$root/infra/infra-env.sh"
. /etc/$SERVER_NAME/env
dir=$(mktemp -d)
compose="docker compose -f $root/infra/compose.yaml -f $root/infra/generated/products.yaml"
{
  echo "# Server status ($(date -Is))"; echo
  # cat -s: dropping the build's "#" step lines leaves ~140 blank lines in a deploy log; squeeze them to one.
  echo '```'; grep -v "^#" "$1" | cat -s; echo; $compose ps -a
  # what each container runs with, and how often it restarted since it was created
  echo; docker inspect -f '{{.Name}} security_opt={{.HostConfig.SecurityOpt}} cap_drop={{.HostConfig.CapDrop}} read_only={{.HostConfig.ReadonlyRootfs}} restarts={{.RestartCount}}' $($compose ps -aq) 2>/dev/null | sed 's|^/||' | sort
  echo; echo "== memory"; free -m; docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' 2>/dev/null
  # the one disk holds Docker, every volume and the jobs' folders; at 100% the
  # coordinator's database stops writing, and below 10 GB free mail keeps attachment names only (mail.ts STORAGE)
  echo; echo "== disk (free space, then what holds it: Docker, the volumes, the jobs' folders and homes)"
  df -h --output=size,used,avail,pcent /; echo; docker system df 2>&1; echo
  # the biggest images, so a report says which grew
  docker image ls --format '{{.Size}} {{.Repository}}:{{.Tag}}' 2>&1 | sort -h | tail -n 8; echo
  work=$(docker volume inspect -f '{{.Mountpoint}}' infra_work 2>/dev/null)
  # the biggest folders two levels down (jobs/<n>, homes/<n>, legacy/...), and the other places that grow
  [ -n "$work" ] && timeout 120 nice ionice -c3 du -xh -d2 "$work" 2>/dev/null | sort -h | tail -n 12 | sed "s|$work|work volume|"
  # (imports: the board's unpacked zips)
  for v in hqdata imports voice seats; do d=$(docker volume inspect -f '{{.Mountpoint}}' "infra_$v" 2>/dev/null) && timeout 60 du -xsh "$d"; done
  timeout 60 du -xsh /var/lib/$SERVER_NAME /var/log 2>/dev/null
  # what runs, for the CVE check (shared/routines/cve-watch.md).
  echo; echo "== versions (the host, Docker, each running container's image, when it was built, its system and Node; security updates waiting, a reboot pending)"
  (. /etc/os-release; echo "$PRETTY_NAME, kernel $(uname -r)")
  echo "docker $(docker version -f '{{.Server.Version}}' 2>&1), compose $(docker compose version --short 2>&1)"
  for c in $($compose ps -q); do
    inside=$(timeout 10 docker exec "$c" sh -c '. /etc/os-release && echo "$PRETTY_NAME, $(if command -v node >/dev/null; then node --version; else echo "no node"; fi)"' 2>&1) ||
      inside="system and node unread: ${inside:-timed out}"
    built=$(docker image inspect -f '{{.Created}}' "$(docker inspect -f '{{.Image}}' "$c")" 2>&1) || built="unread: $built"
    echo "$(docker inspect -f '{{.Name}} {{.Config.Image}}' "$c" | sed 's|^/||') (built $built): $inside"
  done
  $compose exec -T caddy caddy version 2>&1 | sed 's/^/caddy /'
  # dist-upgrade: on Ubuntu a kernel update comes as a new package, which a plain upgrade holds back
  updates=$(apt-get -s dist-upgrade 2>&1) \
    && echo "security updates waiting: $(awk '/^Inst.*security/ { n++; s = s " " $2 } END { print n ? n ":" s : "none" }' <<< "$updates")" \
    || echo "security updates: apt-get failed: $updates"
  [ -f /var/run/reboot-required ] && echo "reboot pending for: $(tr '\n' ' ' < /var/run/reboot-required.pkgs 2>/dev/null)"
  # renders (infra/renders.py): how many are in the checkout, and the ones it couldn't find
  python3 -c "import json, sys; s = json.load(open(sys.argv[1])); print(f\"renders: {len(s['put'])} in place, {len(s['missing'])} missing\", *s['missing'][:10])" \
    "/var/lib/$SERVER_NAME/renders.json" 2>/dev/null
  # when each part of this run began, to line up with the loop's worst seconds
  steps="hq.db read ahead $(date -u +%T)"
  # hq.db read through once first, a plain read that takes none of SQLite's locks: after a deploy's build the file is off
  # the machine's memory, and a statement below that reads it from the disk holds every commit of HQ's back for seconds
  # (or past db.ts's busy timeout: "database is locked")
  hqdata=$(docker volume inspect -f '{{.Mountpoint}}' infra_hqdata 2>/dev/null) && timeout 60 nice cat "$hqdata/hq.db" > /dev/null
  steps+=", hq.db $(date -u +%T)"
  echo; echo "== board requests and seats"
  $compose exec -T coordinator node --disable-warning=ExperimentalWarning --input-type=module -e "
    import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync('/data/hq.db', { timeout: 5000 });
    // its statements over 100 ms, shown under HQ's speed: one on HQ's own tables holds HQ's writes back that long
    const SLOW_MS = 100, slow = [], prepare = db.prepare.bind(db);
    const timed = (sql, run) => (...params) => {
      const startedAt = Date.now();
      try { return run(...params); } finally {
        const ms = Date.now() - startedAt;
        if (ms >= SLOW_MS) slow.push({ at: new Date(startedAt).toISOString().slice(11, 19), ms, sql: sql.slice(0, 90) });
      }
    };
    db.prepare = sql => { const statement = prepare(sql); for (const method of ['all', 'get', 'run']) statement[method] = timed(sql, statement[method].bind(statement)); return statement; };
    // Every agent reads this report: the one of a job handed a customer's own details stays with its agent (memory.ts),
    // and a customer card's text never shows here.
    const said = (col, n) => \`iif(customers, '(holds a customer''s details)', substr(\${col},1,\${n}))\`;
    // the seconds from one time column to another, to a tenth
    const secs = (from, to) => \`round((julianday(\${to}) - julianday(\${from})) * 86400, 1)\`;
    console.table(db.prepare('select id, created, kind, seat, status, title, customers from requests order by id').all());
    console.log('company paused:', db.prepare(\"select value from settings where key = 'company.paused'\").get()?.value ?? 'no');
    // a seat's windows: the share used of each, and whether its week is paced (it takes only the board's word and work
    // that must start before its weekly reset).
    console.table(db.prepare(\"select id, engine, state, round(util * 100) || '%' as five_hour, round(week * 100) || '%' as week, case when pace is not null then 'till ' || datetime(week_resets / 1000, 'unixepoch') end as paced, note, case when until > 0 then datetime(until / 1000, 'unixepoch') end as until_utc from seats\").all());
    // an engine whose seat is ready and whose work waits, yet has started nothing for 15 minutes (coordinator stalls.ts)
    console.log('engines stalled:', db.prepare(\"select value from settings where key like 'stall.%'\").all().map(r => JSON.parse(r.value).line).filter(Boolean).join(' ') || 'none');
    // work a kind of run holds until the lent machine has finished one, then the runs open or ended in the last day, with why
    // (coordinator runs.ts)
    console.log('runs held:', JSON.parse(db.prepare(\"select value from settings where key = 'runs.held'\").get()?.value ?? '{}').line ?? 'none');
    console.table(db.prepare(\"select id, job, agent, kind, state, helper, created, ended, substr(why, 1, 100) why from helper_runs where state in ('waiting', 'running') or ended > strftime('%Y-%m-%dT%H:%M:%S', 'now', '-1 day') order by id\").all());
    // the CEO's hourly follow-through check that didn't start, ran on or ended without a verdict (coordinator followthrough.ts)
    console.log('follow-through check:', JSON.parse(db.prepare(\"select value from settings where key = 'followthrough.alarm'\").get()?.value ?? 'null')?.line ?? 'fine');
    // the board's seats in HQ: provider, paused, the switch, and its last changes with how they went (seats.ts)
    try {
      console.log('seats switch:', db.prepare(\"select value from settings where key = 'seats.use'\").get()?.value ?? 'none');
      console.table(db.prepare('select id, provider, paused, removing, added from seat_list').all());
      console.table(db.prepare(\"select id, seat, engine, what, status, substr(words, 1, 100) words, datetime(at / 1000, 'unixepoch') at_utc from seat_actions order by id desc limit 10\").all());
    } catch (err) { console.log('seats in HQ:', err.message); }
    console.table(db.prepare('select id, agent, kind, pr, round, after, status, attempts, substr(title,1,50) title, ' + said('result', 80) + ' result from jobs order by id desc limit 40').all());
    console.table(db.prepare('select number, author, round, status, substr(verdict,1,120) verdict from prs').all());
    const reviewRefusals = await import('./src/reviewrefusals.ts');
    console.log(reviewRefusals.report(db));
    // A pull request nobody is on: open or stuck, no job queued, running or waiting on it (a review, the consolidator's check, its
    // author's job on its branch), and the last one ended over an hour ago. HQ brings back a lost hand-off by itself
    // (review.ts reviveRounds).
    // It also brings back a ruled round's fix that was stopped, cancelled or failed before its push (review.ts reviveFixes).
    // What's left here waits for a person: \`hq review <n>\` for a stuck one.
    // and why, as HQ last found it (prs.why: why it's stuck, or why its ruling or lost
    // round isn't acted on), or else as its jobs show it
    console.log('== pull requests nobody is on (open or stuck, no job on them for over an hour, and why)');
    console.table(db.prepare(\"select p.number, p.branch, p.author, p.round, p.status, max(coalesce(j.finished, j.created)) last_job, substr(coalesce(p.why, \"
      + \"case when p.status = 'stuck' then 'stuck' when not exists (select 1 from jobs r where r.pr = p.number and r.kind in ('review', 'consolidate') and r.id > p.since) \"
      + \"then 'round ' || p.round || ' never reached the panel' else 'round ' || p.round || ': its runs ended with nothing acting on them' end), 1, 200) why from prs p \"
      + \"left join jobs j on j.pr = p.number or j.kind = 'work' and j.branch = p.branch where p.status in ('open', 'stuck') group by p.number \"
      + \"having coalesce(sum(j.status in ('queued', 'running', 'blocked')), 0) = 0 and coalesce(last_job, '') < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour') order by p.number\").all());
    // The blocking findings of each open or stuck pull request's last ruling for changes, whole: the tables cut a ruling
    // short, and its fix task names them
    console.log('== blocking findings of the last ruling for changes on each open or stuck pull request, whole');
    for (const r of db.prepare(\"select p.number, j.id job, j.round, j.customers, json_extract(j.output, '\$.blocking') blocking from prs p \"
      + \"join jobs j on j.id = (select max(c.id) from jobs c where c.pr = p.number and c.kind = 'consolidate' and c.status = 'done' \"
      + \"and json_valid(c.output) and json_extract(c.output, '\$.decision') = 'changes' and json_array_length(c.output, '\$.blocking') > 0) \"
      + \"where p.status in ('open', 'stuck') order by p.number\").all())
      console.log(\`PR #\${r.number}, round \${r.round}, ruling #\${r.job}: \${r.customers ? \"(holds a customer's details)\" : r.blocking}\`);
    // What products owe the board after its feedback (owed.ts), for whoever reads the status.
    try {
      console.log('== owed to the board (products whose feedback the board waits to see back: open, and closed in the last day)');
      console.table(db.prepare(\"select o.id, o.slug, o.agent, o.opened, o.job, j.status job_status, o.follow_ups, o.stalled, o.closed, substr(o.outcome,1,100) outcome from owed o left join jobs j on j.id = o.job where o.closed is null or o.closed > strftime('%Y-%m-%dT%H:%M:%S', 'now', '-1 day') order by o.id\").all());
    } catch { /* no owed table until the coordinator has started with owed.ts */ }
    // the latest 30 and every queued or running one, however old, with a queued
    // job's hold (a usage limit, a restart, a downtime yield: jobs.ts not_before) so a job that isn't starting says until when.
    // Their ids first, then each row by its id: a filter on the table itself reads every job's brief and output, and HQ's
    // writes wait for this connection's read.
    console.log('== work (not reviews, the latest 30 and all queued or running jobs, held_until in UTC)');
    console.table(db.prepare(\"with ids as materialized (select id from jobs where kind in ('work','chat') and status in ('queued', 'running') \"
      + \"union select * from (select id from jobs where kind in ('work','chat') order by id desc limit 30)) \"
      + \"select j.id, j.created, j.agent, j.status, j.after, case when j.status = 'queued' and j.not_before > strftime('%s', 'now') * 1000 then datetime(j.not_before / 1000, 'unixepoch') end held_until, \"
      + \"substr(j.title,1,90) title, \" + said('j.result', 160) + \" result from ids cross join jobs j on j.id = ids.id order by j.id desc\").all());
    // every job of the last day, reviews included: who queued it, what it cost, how it ended (the Overseer, 2026-10-17,
    // while it looks into how a day's work was planned)
    console.log('== every job of the last 24 hours (created or ended: queued_by null is HQ itself; cost_usd: Claude only)');
    // (the day's ids from the indexes first, as above)
    console.table(db.prepare(\"with ids (n) as (select id from jobs where kind != 'chat' and (created > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day') \"
      + \"or finished > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day'))) \"
      + \"select j.id, substr(j.created, 6, 11) created, j.agent, j.kind, j.status, j.queued_by by, j.after, j.pr, j.thread, \"
      + \"round(coalesce((select sum(u.cost) from usage u where u.job = j.id), 0), 2) cost_usd, substr(j.title, 1, 80) title \"
      + \"from ids cross join jobs j on j.id = ids.n order by j.id\").all());
    // the events queued jobs wait for (hq job --when: the coordinator's wakes.ts) and the last deploys it heard of
    try {
      console.log('== waiting for events (hq job --when, still waited for: an at is in ms), then the last 5 deploys HQ has heard of');
      console.table(db.prepare(\"select w.job, j.agent, w.kind, w.arg, datetime(w.since / 1000, 'unixepoch') since, substr(j.title,1,70) title \"
        + \"from wakes w join jobs j on j.id = w.job where w.met is null and j.status = 'queued' order by w.job\").all());
      console.table(db.prepare('select sha, fetched, finished, ok, recreated, reloaded from deploys order by finished desc limit 5').all());
    } catch { /* no wakes table until the coordinator has started with wakes.ts */ }
    // the open threads' windows (windows.ts): the time the board was given for each thread's work, the time aimed for
    // and who gave it, so whether one was set can be checked.
    try {
      console.log('== windows (open threads with one, in UTC: the deadline, the aim and who gave the board the time)');
      console.table(db.prepare(\"select id, datetime(deadline / 1000, 'unixepoch') deadline, datetime(aim / 1000, 'unixepoch') aim, deadline_by given_by \"
        + \"from threads where status = 'open' and deadline is not null order by deadline\").all());
    } catch { /* the aim column is added when the coordinator starts */ }
    console.log('== calls');
    console.table(db.prepare('select c.id, c.ts, c.agent, c.request, c.job, j.status, length(c.lines) chars from calls c left join jobs j on j.id = c.job order by c.id desc limit 10').all());
    // The book's judge (ink/bookjudge.ts) on the board's notes: each verdict on its target (g<group>, n<an old book's
    // note> or p<page>: a box typed on it), seconds from the save of the words it judged, the run its answer or try
    // started or joined (none: on a call, whose agent answers itself, or a pick), and that run's answers after it, a
    // slip it clipped or a typed box's answer typed on at its end, with the seconds to the first and last. 'none'
    // verdicts, most, only counted. No words and no why: a call's note can hold a customer's.
    const since = \"strftime('%Y-%m-%dT%H:%M:%S', 'now', '-2 days')\";
    console.log('== the book\'s judge (the last 2 days, in UTC: a verdict, its run and when its answers landed, in seconds)');
    console.table(db.prepare(\"select v.id, v.reply, coalesce('g' || v.grp, 'n' || v.note, 'p' || v.page) target, substr(v.created, 1, 19) judged, \"
      + secs('v.saved', 'v.created') + ' after_save_s, v.job, j.status, count(a.at) answers, ' + secs('v.created', 'min(a.at)') + ' first_s, '
      + secs('v.created', 'max(a.at)') + \" last_s, iif(v.wiped is null, '', 'wiped') wiped from ink_verdicts v left join jobs j on j.id = v.job \"
      + \"left join (select job, created at from book_slips union all select job, typed from book_typed_asks where typed is not null) a \"
      + \"on a.job = v.job and a.at >= v.created \"
      + \"where v.created > \" + since + \" and v.reply != 'none' group by v.id order by v.id desc\").all());
    console.log(\"'none' verdicts:\", db.prepare(\"select count(*) n from ink_verdicts where reply = 'none' and created > \" + since).get().n);
    // Every request Twilio made to the phone line and HQ's answer, never the caller's number (phone.ts): nothing at the
    // time of a call means Twilio never asked HQ (the number's webhook, the account, the number).
    try {
      console.log('== the phone line (Twilio\'s requests to HQ, the last 7 days, in UTC: the step and HQ\'s answer; no numbers)');
      console.table(db.prepare(\"select datetime(ts / 1000, 'unixepoch') at, step, answer from phone_asks where ts > (strftime('%s', 'now') - 7 * 86400) * 1000 order by ts desc limit 40\").all());
      console.log('Twilio account known (from a signed request):', db.prepare(\"select value from settings where key = 'twilio_account'\").get() ? 'yes' : 'no');
    } catch { /* the table is made when the coordinator starts */ }
    console.log('== mail (latest 10; no words: the sender is its domain only)');
    console.table(db.prepare(\"select id, received, recipient, substr(sender, instr(sender, '@') + 1) sender_domain, size from mail order by id desc limit 10\").all());
    // mail that arrived while storage was full or the disk low (mail.ts room()):
    // only its attachments' names were kept, or an invoice's or agreement's raw message wasn't, so ask the sender again.
    // (Customer mail past mail.ts's ATTACHMENT_DAYS, 180, keeps names only on purpose: sweep().)
    console.log('mail with files not kept (disk low or mail storage full):', db.prepare(\"select group_concat(id, ', ') ids from mail where attachments like '[\\\"%' and (keep is not null or received > strftime('%Y-%m-%dT%H:%M:%S', 'now', '-180 days')) or keep is not null and raw is null\").get().ids ?? 'none');
    // HQ's sends that didn't go: refused before they left (a broken address), by the email service, or never answered
    // (mailout.ts: why, no address), the last week. And one the service took and then couldn't deliver (its webhook,
    // mailout.ts).
    try {
      console.log('== email that didn\'t go (HQ\'s sends refused before they left, refused by the email service, never answered, or taken and not delivered, last 7 days; no addresses)');
      console.table(db.prepare(\"select id, ts, status, answer from mail_failures where ts > strftime('%Y-%m-%dT%H:%M:%S', 'now', '-7 days') order by id desc limit 20\").all());
      // (guests.ts deletes a guest's code the service refused, and keeps one whose send may have gone)
      const codes = db.prepare(\"select count(*) n, max(created) last from guest_codes where created > (strftime('%s', 'now') - 86400) * 1000\").get();
      console.log('guest sign-in codes that went, last 24 hours:', codes.n, codes.last ? \`(the latest \${new Date(codes.last).toISOString()})\` : '');
    } catch { /* no mail_failures table until the coordinator has started with it */ }
    // The bookkeeping copies (mailforward.ts): each mail's outcome, then one success event per outgoing email.
    // mailout.ts already masks addresses in failure reasons.
    console.log('== copies to the forward address (all records, sent 0 carries its reason)');
    console.table(db.prepare(\"select mail, substr(tried, 1, 19) tried, sent, status, failure why from mail_copies order by mail desc\").all());
    console.log('== forward-copy sends (one row per email, with its mail ids)');
    // (each email's line in the minute after its copies were marked sent, which HQ logs it right after: the copies first
    // (cross join), each one's minute by the events' time index, so the statement reads only those minutes of HQ's
    // biggest table.)
    console.table(db.prepare(\"select distinct e.id, e.ts, e.text from mail_copies c cross join events e indexed by events_ts on e.ts >= c.tried \"
      + \"and e.ts < strftime('%Y-%m-%dT%H:%M:%fZ', c.tried, '+1 minute') where c.sent = 1 and e.type = 'log' \"
      + \"and e.text like 'Mail: a copy of % went to the forward address' order by e.id\").all());
    // Each paid basket's confirmation email (basketmail.ts), the last 7 days: whether it went (rendered: test mode without
    // the service, so it never left), and HQ's log lines on basket emails. Ids and statuses only; a tester's order is

    try {
      console.log('== the shop\'s order confirmations, last 7 days (each paid basket: its email, tries, rendered, its parcel; then the log\'s lines on basket emails)');
      console.table(db.prepare(\"select p.id session, iif(substr(p.id, 1, 15) = 'cs_test_tester_', 'tester', p.mode) kind, substr(p.created,1,16) created, p.status payment, \"
        + \"e.status email, e.tries, e.rendered, substr(e.updated,1,16) email_updated, c.status parcel from payments p left join basket_emails e on e.session = p.id \"
        + \"left join parcels c on c.session = p.id where p.basket is not null and p.status not in ('open', 'expired') and p.created > strftime('%Y-%m-%dT%H:%M:%S', 'now', '-7 days') order by p.created desc limit 40\").all());
      // (an hour of the log per statement, newest first, so a waiting HQ write commits between hours)
      const basketLines = db.prepare(\"select substr(ts,1,19) ts, substr(text,1,220) text from events indexed by events_ts where ts >= ? and ts < ? and type = 'log' and text like 'Payments:%basket email%' order by ts desc\");
      const lines = [];
      for (let hour = 0, end = Date.now(); hour < 7 * 24 && lines.length < 40; hour++, end -= 3600e3)
        lines.push(...basketLines.all(new Date(end - 3600e3).toISOString(), new Date(end).toISOString()));
      console.table(lines.slice(0, 40));
    } catch { /* no basket_emails or parcels table until the coordinator has started with them */ }
    console.log('== intercom (openings)');
    // a line a customer-holding job wrote (chat.ts about_customer) shows as such.
    const aboutCustomer = db.prepare(\"select 1 from pragma_table_info('chat') where name = 'about_customer'\").get() ? 'about_customer' : '0';
    console.table(db.prepare(\"select id, ts, who, iif(\" + aboutCustomer + \" and shown is null, '(holds a customer''s details)', substr(coalesce(shown, text),1,160)) opening from chat order by id desc limit 12\").all());
    console.log('== usage, last 7 days (per UTC day and seat; input is the uncached part; cost_usd is the API-equivalent price Claude Code reports, none for Codex)');
    console.table(db.prepare(\"select substr(ts,1,10) day, seat, engine, count(distinct job) jobs, sum(input) input, sum(cache_write) cache_write, sum(cache_read) cache_read, sum(output) output, round(sum(cost),2) cost_usd from usage where ts >= date('now','-6 days') group by day, seat, engine order by day desc, seat\").all());
    // From here on a job's columns come from jobs_report (db.ts), named with indexed by: read from its rows, every job's
    // brief and report came off the disk, seconds while HQ's writes waited
    console.log('== usage per job (latest 25; a run is one start of the job, resumed after a limit or restart)');
    console.table(db.prepare('select u.job, j.agent, j.kind, count(*) runs, group_concat(distinct u.seat) seats, group_concat(distinct u.models) models, sum(u.input) input, sum(u.cache_write) cache_write, sum(u.cache_read) cache_read, sum(u.output) output, round(sum(u.cost),2) cost_usd, max(u.ts) finished from usage u join jobs j indexed by jobs_report on j.id = u.job group by u.job order by max(u.id) desc limit 25').all());
    // How much of a seat goes to the review loop, and to each other kind of job: the kinds are the coordinator's
    // (jobkinds.ts), as Numbers' Tokens dashboard reads them
    const hasOwn = db.prepare(\"select 1 from pragma_table_info('schedule_runs') where name = 'kind'\").get();
    const kindOf = (await import('./src/jobkinds.ts')).kindOf(!!hasOwn);
    const spend = \"iif(u.engine = 'codex', u.input + u.cache_read, u.cost)\";
    console.log('== usage per kind of job, last 7 days (per UTC day; share: of the day\\'s cost_usd for Claude, of its input + cache_read for Codex)');
    console.table(db.prepare(\"select substr(u.ts,1,10) day, u.engine, \" + kindOf + \" kind, count(distinct u.job) jobs, sum(u.input) input, sum(u.cache_write) cache_write, sum(u.cache_read) cache_read, sum(u.output) output, round(sum(u.cost),2) cost_usd, round(100.0 * sum(\" + spend + \") / sum(sum(\" + spend + \")) over (partition by substr(u.ts,1,10), u.engine), 1) share from usage u join jobs j indexed by jobs_report on j.id = u.job where u.ts >= date('now','-6 days') group by 1, 2, 3 order by day desc, u.engine, share desc\").all());
    console.log('== up-front context per kind of job, last 7 days (runs whose worker measured it, Claude only: opening, the first message\\'s whole context; written, the part its start or resume wrote to the cache; turns, its messages; upfront_share: opening × turns, of the same runs\\' input + cache_write + cache_read)');
    console.table(db.prepare(\"select u.engine, \" + kindOf + \" kind, count(*) runs, cast(median(u.opening) as integer) median_opening, cast(avg(u.opening) as integer) mean_opening, cast(avg(u.opening_written) as integer) mean_written, round(avg(u.turns), 1) mean_turns, round(100.0 * sum(u.opening * u.turns) / sum(u.input + u.cache_write + u.cache_read), 1) upfront_share from usage u join jobs j indexed by jobs_report on j.id = u.job where u.ts >= date('now','-6 days') and u.opening is not null group by 1, 2 order by u.engine, runs desc\").all());
    console.log('== resumed runs per kind of job, last 7 days (runs that took their session up again; idle: from the session\\'s previous run\\'s end to this run\\'s start; written: what the resume wrote to the cache again, Claude only)');
    console.table(db.prepare(\"select u.engine, \" + kindOf + \" kind, count(*) runs, round(avg(u.idle_ms) / 60000.0, 1) mean_idle_min, cast(avg(u.opening_written) as integer) mean_written, round(sum(u.cost), 2) cost_usd from usage u join jobs j indexed by jobs_report on j.id = u.job where u.ts >= date('now','-6 days') and u.resumed = 1 group by 1, 2 order by u.engine, sum(u.cost) desc\").all());
    console.log('== review loop per pull request, last 7 days (the top ten by its reviews\\' and checks\\' cost_usd; codex_tokens: their Codex input + cache_read; fixes: the author\\'s pr fix jobs)');
    // The fixes' cost is summed once and looked up per pull request: usage has no index on job, so a subquery per pull
    // request would read all of usage each time
    console.table(db.prepare(\"with fixes as materialized (select fj.pr, round(sum(f.cost),2) cost from usage f join jobs fj indexed by jobs_report on fj.id = f.job where fj.kind = 'work' and fj.pr is not null and fj.queued_by is null and coalesce(fj.stage, '') <> 'feedback' and f.ts >= date('now','-6 days') group by fj.pr) select j.pr, p.author, p.status, count(distinct u.job) reviews, count(distinct j.round) rounds, max(j.round) last_round, round(sum(u.cost),2) cost_usd, sum(iif(u.engine = 'codex', u.input + u.cache_read, 0)) codex_tokens, (select x.cost from fixes x where x.pr = j.pr) fixes_cost_usd from usage u join jobs j indexed by jobs_report on j.id = u.job left join prs p on p.number = j.pr where j.kind in ('review','consolidate') and j.pr is not null and u.ts >= date('now','-6 days') group by j.pr order by sum(u.cost) desc limit 10\").all());
    console.log('== push tests, last 14 days (one row per tested tree/base, reused results counted once; wall time includes helper waits, setup and failure comparison; old rows have no wall time)');
    console.table(db.prepare(\"select substr(at, 1, 10) day, count(*) runs, sum(report like 'Tests: none%') no_suites, sum(passed = 1) passed, sum(passed = 0) failed, count(began) timed, round(avg((julianday(at) - julianday(began)) * 86400), 1) mean_wall_s, round(max((julianday(at) - julianday(began)) * 86400), 1) max_wall_s from test_results where passed is not null and at >= date('now', '-13 days') group by day order by day desc\").all());
    console.log('== latest push suites (the stored runner reports, with suite times, setup/comparison and slowest files when available; no-suite pushes omitted)');
    const pushes = db.prepare(\"select job, at, passed, round((julianday(at) - julianday(began)) * 86400, 1) wall_s, report from test_results where passed is not null and report not like 'Tests: none%' order by at desc limit 10\").all();
    for (const push of pushes) console.log(JSON.stringify({ job: push.job, at: push.at, passed: push.passed, wall_s: push.wall_s }), '\n' + push.report);
    console.log('== review/check run wall time, last 14 days (started to finished; includes pauses, excludes jobs without a start)');
    console.table(db.prepare(\"select substr(finished, 1, 10) day, kind, engine, count(*) runs, round(avg((julianday(finished) - julianday(started)) * 1440), 1) mean_min, round(max((julianday(finished) - julianday(started)) * 1440), 1) max_min from jobs indexed by jobs_report where kind in ('review', 'consolidate') and status = 'done' and started is not null and finished >= date('now', '-13 days') group by day, kind, engine order by day desc, kind, engine\").all());
    // The reviewers' time on what the pipeline runs once for them (the worker's gates and tests): each step of a review
    // or a check, from its own log (log.ts, 14 days), lasts until the job's next step. Steps stand in for tokens. A step
    // counts as running them when its command names a runner with what it runs, so a sed or cat of a test file mostly
    // stays out, but a grep or sed that also names a runner still counts (a rough match). A Codex step loses its shell
    // wrapper (bash -lc) first, once: inside a subquery SQLite repeats the two replace() calls at every like test. An hour
    // of steps per statement, into this connection's own temp table, then the days from there: no statement holds HQ's
    // writes back for long.
    const stepKind = \"case when l.text not like '\$ %' then 'other' when l.text like '%npm ci%' or l.text like '%npm install%' or l.text like '%npm i %' or l.text like '%pip install%' or l.text like '%-m venv%' then 'install' when l.text like '%node %check.mjs%' then 'pages' when l.text like '%node --test%' or l.text like '%npm run gates%' or l.text like '%npm run tests%' or l.text like '%npm test%' or l.text like '%node %gates/gates.ts%' or l.text like '%node %gates/tests.ts%' or l.text like '%prettier -%' or l.text like '%npx eslint%' or l.text like '%eslint -%' or l.text like '%npx tsc%' or l.text like '%tsc -%' or l.text like '%unittest%' or l.text like '%pytest%' or l.text like '%python% %test_%.py%' or l.text like '%sh %test_%.sh%' or l.text like '%./test_%.sh%' or l.text like '%node %.test.%' then 'tests' else 'other' end\";
    console.log('== reviews\\' time on installs, gates and tests, last 14 days (per UTC day and engine; a review or check\\'s logged steps, each until its next one; pages: *check.mjs walks, which stay the reviewers\\')');
    db.exec('pragma temp_store = memory; create temp table steps (job, engine, day, k, m)');
    const stepsIn = db.prepare(\"with l as materialized (select l.id, l.job, l.ts, j.engine, replace(replace(l.text, '/bin/bash -lc ', ''), 'bash -lc ', '') text \"
      + \"from job_log l cross join jobs j indexed by jobs_report on j.id = l.job where l.ts >= ? and l.ts < ? and j.kind in ('review', 'consolidate')) insert into temp.steps \"
      + \"select l.job, l.engine, substr(l.ts, 1, 10), \" + stepKind + \", (julianday((select n.ts from job_log n where n.job = l.job and n.id > l.id order by n.id limit 1)) - julianday(l.ts)) * 1440 from l\");
    const oldestStep = db.prepare('select min(ts) ts from job_log').get().ts, hourMs = 3600e3;
    for (let windowEnd = Date.now(); oldestStep && Date.parse(oldestStep) < windowEnd; windowEnd -= hourMs) {
      stepsIn.run(new Date(windowEnd - hourMs).toISOString(), new Date(windowEnd).toISOString());
    }
    console.table(db.prepare(\"select day, engine, count(distinct job) jobs, round(sum(m)) minutes, round(sum(iif(k = 'install', m, 0))) install_min, round(sum(iif(k = 'tests', m, 0))) gates_tests_min, round(100.0 * sum(iif(k in ('install', 'tests'), m, 0)) / sum(m), 1) time_share, round(100.0 * sum(k in ('install', 'tests')) / count(*), 1) steps_share, count(distinct iif(k in ('install', 'tests'), job, null)) jobs_running_them, round(sum(iif(k = 'pages', m, 0))) pages_min from temp.steps where m is not null group by day, engine order by day desc, engine\").all());
    // Reviews that over-harden (the trust rule, the coordinator's trust.ts): a report without the rule's labels
    // counts as unlabelled
    console.log('== reviews that over-harden, last 14 days (per UTC day: the reviewers\\' findings by engine, labelled: carrying the trust rule\\'s fields, hides: on a line that carries on past a failure, never dismissed, trust and fallback: dismissed by the round; the consolidator\\'s verdicts by stage, its drops and blocking findings against hardening the change added; then the share of labelled findings that over-hardened, and each dismissal to check against its pull request)');
    // (the dismissals) (hides). A day per statement, by jobs_counts: the planner's pick, by status, read every done job's
    // row, and the fortnight's outputs at once held HQ's writes back half a second off a cold disk
    const reviewsOn = db.prepare(\"select substr(created, 1, 10) day, pr, agent, kind, engine, stage, output from jobs indexed by jobs_counts where kind in ('review', 'consolidate') and status = 'done' and created >= date('now', ?) and created < date('now', ?)\");
    const trust = (await import('./src/trust.ts')).reading(Array.from({ length: 14 }, (_, d) => reviewsOn.all(\`\${d - 13} days\`, \`\${d - 12} days\`)).flat());
    console.table(trust.reviews);
    console.table(trust.verdicts);
    console.log(trust.total);
    console.table(trust.dismissals);
    // What became of each review finding that reached an author, and the pre-existing ones (the coordinator's
    // findings.ts and outcomes.ts).
    const outcomes = (await import('./src/outcomes.ts')).reading(db.prepare(\"select substr(created, 1, 10) day, pr, kind, file, line, issue, by, outcome, right from findings where created >= date('now', '-13 days')\").all());
    console.log('== finding outcomes, last 14 days (each finding that reached an author, by the ruling after their fixes: fixed, not fixed, wrong: disputed and the author was right, stood: disputed and the reviewer was right, kept on purpose, open: not judged yet; noise: wrong and kept as a share of the judged ones; per engine, then per reviewer with their confirmed pre-existing findings)');
    console.table(outcomes.engines);
    console.table(outcomes.reviewers);
    console.log('== pre-existing findings, last 14 days (confirmed by review on code the change did not touch: never the author\\'s, the project\\'s follow-ups take them)');
    console.table(outcomes.preExisting);
    // Where a week went, for the month-end reading: per agent; by what the work was
    // for; per pull request, all it took (the work on its branch, its first round, then everything after: fixes, later
    // rounds and checks, bringing it up to date, a re-land); and what made jobs dear. A job's pull request is its own
    // (the review loop's jobs) or the one its branch opened. Foundation: one that touches the foundation's own folders.
    const prOf = \"coalesce(j.pr, (select max(p.number) from prs p where p.branch = coalesce(j.branch, 'job/' || j.id)))\";
    const core = \"exists (select 1 from json_each(p.files) f where f.value like 'platform/%' or f.value like 'infra/%' or f.value like 'shared/%' or f.value like '.github/%' or f.value = 'CODE_STYLE.md')\";
    const week = \"from (select u.job, u.engine, u.models, u.cache_write, u.cache_read, u.output, coalesce(u.cost, 0) cost, iif(u.engine = 'codex', u.input + u.cache_read, 0) codex, j.agent, \" + prOf + \" pr, iif(j.pr is null, 'work', iif(j.kind in ('review', 'consolidate') and j.round = 1, 'first', 'after')) part from usage u join jobs j indexed by jobs_report on j.id = u.job where u.ts >= date('now','-6 days')) x left join prs p on p.number = x.pr\";
    const shares = \"round(100.0 * sum(x.cost) / sum(sum(x.cost)) over (), 1) claude_share, sum(x.codex) codex_tokens, round(100.0 * sum(x.codex) / sum(sum(x.codex)) over (), 1) codex_share\";
    console.log('== usage per agent, last 7 days (shares: of Claude\\'s cost_usd, of Codex\\'s input + cache_read; resumed: runs after a limit or restart)');
    console.table(db.prepare(\"select x.agent, count(distinct x.job) jobs, count(*) - count(distinct x.job) resumed, round(sum(x.cost),2) cost_usd, \" + shares + \", sum(x.cache_write) cache_write, sum(x.cache_read) cache_read, sum(x.output) output \" + week + \" group by x.agent order by sum(x.cost) desc, codex_tokens desc\").all());
    console.log('== usage by what it was for, last 7 days (a pull request touching the foundation\\'s folders, any other, or none: chats, schedules, work that opened none)');
    console.table(db.prepare(\"select iif(x.pr is null, 'no pull request', iif(\" + core + \", 'foundation', 'other pull request')) for_what, count(distinct x.job) jobs, count(distinct x.pr) prs, round(sum(x.cost),2) cost_usd, \" + shares + \" \" + week + \" group by 1 order by 4 desc\").all());
    console.log('== usage per pull request, last 7 days (the top 20 by cost_usd, all its jobs; first: the work and round 1; after: fixes, later rounds, checks, up to date, re-lands)');
    console.table(db.prepare(\"select x.pr, p.author, p.status, iif(\" + core + \", 'yes', '') foundation, p.round rounds, count(distinct x.job) jobs, round(sum(iif(x.part = 'after', 0, x.cost)),2) first_usd, round(sum(iif(x.part = 'after', x.cost, 0)),2) after_usd, round(sum(x.cost),2) cost_usd, sum(x.codex) codex_tokens \" + week + \" where x.pr is not null group by x.pr order by sum(x.cost) desc limit 20\").all());
    console.log('== pull requests by status, last 7 days (after_share: of their cost_usd, what came after the first round)');
    console.table(db.prepare(\"select p.status, iif(\" + core + \", 'yes', '') foundation, count(distinct x.pr) prs, round(sum(x.cost),2) cost_usd, round(sum(x.cost) / count(distinct x.pr),2) per_pr_usd, round(100.0 * sum(iif(x.part = 'after', x.cost, 0)) / sum(x.cost), 1) after_share, sum(x.codex) codex_tokens, round(100.0 * sum(iif(x.part = 'after', x.codex, 0)) / sum(x.codex), 1) after_codex_share \" + week + \" where x.pr is not null group by 1, 2 order by 4 desc\").all());
    console.log('== the costliest jobs, last 7 days (the top 15; runs: starts, resumed after a limit or restart; models: helpers show as a second model)');
    console.table(db.prepare(\"select x.job, x.agent, x.pr, count(*) runs, group_concat(distinct x.models) models, sum(x.cache_write) cache_write, sum(x.cache_read) cache_read, sum(x.output) output, round(sum(x.cost),2) cost_usd \" + week + \" group by x.job order by sum(x.cost) desc limit 15\").all());
    console.log('== usage per product, since usage was recorded (pull requests touching products/<slug>/, all their jobs; one touching two counts for both)');
    console.table(db.prepare(\"select f.slug product, count(distinct f.pr) prs, count(distinct u.job) jobs, round(sum(u.cost),2) cost_usd, sum(iif(u.engine = 'codex', u.input + u.cache_read, 0)) codex_tokens from (select distinct p.number pr, substr(e.value, 10, instr(substr(e.value, 10), '/') - 1) slug from prs p, json_each(p.files) e where e.value like 'products/%/%') f join (select j.id job, \" + prOf + \" pr from jobs j indexed by jobs_report) jp on jp.pr = f.pr join usage u on u.job = jp.job group by f.slug order by 4 desc\").all());
    console.log('== usage per model, last 7 days (a run with helpers on another model shows both)');
    console.table(db.prepare(\"select x.models, x.engine, count(*) runs, round(sum(x.cost),2) cost_usd, \" + shares + \" \" + week + \" group by 1, 2 order by 4 desc, codex_tokens desc\").all());
    // Where the Codex seats' tokens went: a pull request's review rounds each run Codex jobs, so the busiest ones lead.
    console.log('== Codex jobs per pull request, yesterday (UTC day, the top ten; mostly their review panels)');
    console.table(db.prepare(\"select j.pr, count(distinct u.job) codex_jobs, count(distinct j.round) rounds, max(j.round) last_round, sum(u.input) input from usage u join jobs j indexed by jobs_report on j.id = u.job where u.engine = 'codex' and j.pr is not null and substr(u.ts,1,10) = date('now','-1 day') group by j.pr order by codex_jobs desc, input desc limit 10\").all());
    console.log('== HQ\'s speed, the last hour (the coordinator\'s /api routes that took the most time in all, in ms; then the event loop\'s worst minutes: how late it ran, so how long one request could wait behind another)');
    try {
      const timesByRoute = new Map();
      for (const r of db.prepare('select route, ms from route_times where at > ? order by ms').all(Date.now() - 3600e3))
        (timesByRoute.get(r.route) ?? timesByRoute.set(r.route, []).get(r.route)).push(r.ms);
      const percentile = (times, p) => Math.round(times[Math.min(times.length - 1, Math.floor(times.length * p))]);
      console.table([...timesByRoute].map(([route, times]) => ({ route, count: times.length, total: Math.round(times.reduce((sum, ms) => sum + ms, 0)),
        p50: percentile(times, 0.5), p95: percentile(times, 0.95), max: Math.round(times.at(-1)) })).sort((a, b) => b.total - a.total).slice(0, 15));
      // worst_at: when the minute's longest stall ended (latency.ts; none until the coordinator has added its column)
      const worstAt = db.prepare(\"select 1 from pragma_table_info('loop_delays') where name = 'worst_at'\").get() ? \"strftime('%H:%M:%S', worst_at / 1000, 'unixepoch')\" : 'null';
      console.table(db.prepare(\"select strftime('%H:%M', at / 1000, 'unixepoch') minute, \" + worstAt + \" worst_at, round(p50, 1) p50, round(p99, 1) p99, round(max) max from loop_delays where at > ? order by max desc limit 8\").all(Date.now() - 3600e3));
      // what held the server half a second or more, by name (latency.ts slow_holds)
      if (db.prepare(\"select 1 from sqlite_master where name = 'slow_holds'\").get())
        console.table(db.prepare(\"select strftime('%H:%M:%S', at / 1000, 'unixepoch') at, ms, name from slow_holds where at > ? order by at desc limit 25\").all(Date.now() - 3600e3));
      if (db.prepare(\"select 1 from sqlite_master where name = 'claim_observations'\").get()) {
        console.log('== bounded claim-plan cohorts (all reasons and durations, strict target 100 ms)');
        for (const row of db.prepare('select cohort from claim_observations order by rowid').all()) console.log(row.cohort);
      }
      console.log('this report: its statements over 100 ms (UTC start)' + (slow.length ? '' : ': none'));
      if (slow.length) console.table(slow);
    } catch (err) { console.log('(no numbers: ' + err.message + ')'); }"
  # This company's foundation changes not in the foundation yet, which the Overseer combines with every company's
  # (platform/coordinator/src/coming.ts)
  steps+=", foundation $(date -u +%T)"
  echo; echo "== coming to the foundation (marked changes on main, then open pull requests touching its paths: job, files, title)"
  timeout 60 $compose exec -T coordinator node --disable-warning=ExperimentalWarning --input-type=module -e "
    import { DatabaseSync } from 'node:sqlite'; import { coming, section } from '/app/platform/coordinator/src/coming.ts';
    console.log(section(await coming('/repo', new DatabaseSync('/data/hq.db', { timeout: 5000, readOnly: true }))));"
  echo; echo "== off-site backup (infra/backup.py, nightly around 02:30 UTC; see the note \"Off-site backups\")"
  python3 - /var/lib/$SERVER_NAME/backup/status.json <<'PY'
import json, sys
try: s = json.load(open(sys.argv[1]))
except (OSError, ValueError): sys.exit(print('no run yet'))
mb = lambda b: f'{(b or 0) / 1e6:.1f} MB'
print(f"last good: {s.get('ok_at') or 'never'}" + (f", {mb(s.get('ok_bytes'))} encrypted ({s.get('ok_key')}, {s.get('ok_files')} files, database {mb(s.get('ok_db_bytes'))}, {s.get('ok_seconds')} s)" if s.get('ok_at') else ''))
# (what each part of the last good backup weighs, and the database's biggest tables)
if s.get('ok_parts'):
    print('its parts:  compressed (files, before compression)')
    for name, p in sorted(s['ok_parts'].items(), key=lambda kv: -kv[1]['bytes']):
        print(f"  {name:<30} {mb(p['bytes']):>10}  ({p['files']} files, {mb(p['raw'])})")
if s.get('ok_big_files'): print(f"its big files: {s['ok_big_files']['files']} ({mb(s['ok_big_files']['raw'])}), each in the bucket once as big-files/; {s['ok_big_files']['new']} new that night ({mb(s['ok_big_files']['new_bytes'])} encrypted)")
if s.get('ok_tables'): print('its database, the biggest tables with their indexes: ' + ', '.join(f'{t} {mb(b)}' for t, b in sorted(s['ok_tables'].items(), key=lambda kv: -kv[1])))
print(f"last try:  {s.get('tried_at')}: {s.get('state')}" + (f" ({s['error']})" if s.get('error') else ''))
if 'bucket_bytes' in s: print(f"bucket:    {mb(s['bucket_bytes'])} of {(s.get('bucket_limit') or 10e9) / 1e9:.0f} GB, {s.get('bucket_daily')} daily + {s.get('bucket_monthly')} monthly + {s.get('bucket_records') or 0} records + {s.get('bucket_renders') or 0} renders + {s.get('bucket_big_files') or 0} big files")
if s.get('big_files_error'): print(f"big files last try: {s['big_files_error']}")
if 'records_pending' in s: print(f"records:   invoices@ and documents@ mail, each off the server once; last all in: {s.get('records_ok_at') or 'never'}, {s['records_pending']} still to go" + (f" (due since {s['records_since']})" if s.get('records_since') else ''))
if s.get('records_error'): print(f"records last try: {s['records_error']}")
if s.get('repo_ok_at'): print(f"repo:      {s['repo_ok_at']}: {s.get('repo_kind')}, {mb(s.get('repo_bytes'))} ({s.get('repo_key')}, {s.get('repo_refs')} branches and tags, main {(s.get('repo_head') or '')[:12]}, GitHub's as of {s.get('repo_github_at')})")
if s.get('repo_error'): print(f"repo last try: {s['repo_error']}")
# the renders' copy
if 'renders_pending' in s: print(f"renders:   the films and tracks git leaves out, each off the server once; last all in: {s.get('renders_ok_at') or 'never'}, {s['renders_pending']} still to go")
if s.get('renders_error'): print(f"renders last try: {s['renders_error']}")
if s.get('warn'): print(f"WARNING:   {s['warn']}")
PY
  # Whether Stripe takes live payments and pays them out, and what it still wants: GET /v1/account with the live key
  # (the key needs Accounts › Read), which only the coordinator holds; the key stays inside its container and only these
  # fields are printed. Then HQ's own live payments, without customer data, and how far the latest unpaid live checkouts
  # got at Stripe: types and codes only (infra/stripe_live.mjs, run by the container's node from stdin).
  steps+=", stripe $(date -u +%T)"
  echo; echo "== stripe, live (the account as the live key reads it, HQ's latest live payments, and how far its unpaid checkouts got: no customer data)"
  timeout 90 $compose exec -T coordinator node --disable-warning=ExperimentalWarning --input-type=module < "$root/infra/stripe_live.mjs"
  # Orders per ad label, for each running product that counts them (src/campaigns.ts: counts and euros, no customer
  # data), or page loads per ad label for a shop's own pages. Agents can't reach a product's database, and whoever runs
  # an ad test judges its stop-loss on these.
  steps+=", ad labels $(date -u +%T)"
  for p in $($compose ps --services --status running 2>/dev/null | grep '^product-'); do
    timeout 20 $compose exec -T "$p" test -f src/campaigns.ts 2>/dev/null || continue
    # its numbers as JSON, printed under their heading as table rows by infra/campaigns.py, which leaves
    # out anything else the product prints (every agent reads this report)
    echo   # (the heading comes from campaigns.py)
    timeout 30 $compose exec -T "$p" node --disable-warning=ExperimentalWarning src/campaigns.ts --json 2>/dev/null | python3 $root/infra/campaigns.py "${p#product-}"
  done
  # Page loads, visitors and visits on the live products that count through HQ, and every page load by where it came
  # from: infra/visitors.mjs, run by the coordinator's node from stdin.
  steps+=", visitors $(date -u +%T)"
  timeout 80 $compose exec -T coordinator node --disable-warning=ExperimentalWarning --input-type=module < "$root/infra/visitors.mjs"
  # A day's warnings and errors per service, counted: the tails below are 40 lines, so a night's fault scrolls out.
  steps+=", error counts $(date -u +%T)"
  echo; echo "== errors, last 24 hours (warnings and errors per service, counted; infra/log_errors.py)"
  # Product apps log customer data in free text (e-mail, order details) that this report can't scrub, so they get counts only.
  # So do the preview containers behind public products' preview doors.
  for s in $($compose ps --services --all 2>/dev/null); do
    echo "$s:"; mode=; case $s in product-*|preview-*) mode=--counts;; esac
    timeout 60 $compose logs --no-color --no-log-prefix --since 24h "$s" 2>/dev/null | python3 $root/infra/log_errors.py $mode
  done
  # through log_errors.py --tail, which keeps a Caddy line's level, message and error
  # but never its request (a shop's X-Order-Token header, the inbound mail's sender, a customer's IP: house rule 7).
  steps+=", log tails $(date -u +%T)"
  for s in caddy coordinator worker stt voice; do echo; echo "== $s (last 40 lines)"; $compose logs --no-color --tail 40 "$s" | python3 $root/infra/log_errors.py --tail; done
  # The board's calls, timed (the board asked for these numbers, not a quiet downgrade): infra/call-times.sh keeps them
  # across voice redeploys. The last 7 days, which the daily model-releases check reads.
  steps+=", call times $(date -u +%T)"
  $root/infra/call-times.sh
  echo; echo "== calls on the voice line, timed (the last 7 days)"
  awk -v since="$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%S)" '$1 >= since' /var/lib/$SERVER_NAME/call-times.log
  echo; echo "== this report's own steps (when each began, UTC; before hq.db: the containers and the disk; the copy into HQ follows the end)"
  echo "$steps, end $(date -u +%T)"
  echo '```'
} 2>&1 | sed -E 's/(sk-|sk_|rk_|whsec_|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{8,}|x-access-token:[^@ ]+@|Bearer [A-Za-z0-9._~+\/=-]{8,}/[redacted]/g' > "$dir/STATUS.md"   # never publish keys
# HQ keeps two days of reports for hq report and the Overseer's read (platform/coordinator/src/oversight.ts), each
# written whole and named by its UTC time. The coordinator's own user writes them in its data volume: root never writes
# there by path
gzip -c "$dir/STATUS.md" | timeout 60 $compose exec -T coordinator sh -c 'mkdir -p /data/status && cd /data/status &&
  cat > ".part-$0" && mv ".part-$0" "$0.md.gz" && find . -maxdepth 1 -type f -mmin +2880 -delete' \
  "$(date -u +%Y%m%dT%H%M%SZ)" || echo "report.sh: HQ didn't get this report" >&2
# The "server-status" branch is deleted, once, so nobody reads a stale report there
gone=/var/lib/$SERVER_NAME/status-branch-deleted
if [ ! -e "$gone" ]; then
  said=$(cd "$dir" && git init -q && git -c credential.https://github.com.helper=$root/infra/git-credential.sh \
    push -q "https://github.com/$REPO.git" --delete server-status 2>&1)   # token via the helper, not the URL
  if [ $? -eq 0 ] || grep -q "remote ref does not exist" <<< "$said"; then touch "$gone"; else echo "report.sh: $said" >&2; fi
fi
rm -rf "$dir"
