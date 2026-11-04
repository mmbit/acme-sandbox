
# Companies working together: linking and shared workspaces

Several companies run on this foundation, and one day dozens may. This is how two of them link and work together with
no Overseer and no board carrying work between them: commissions (an ad made for another company, an app built for
one), joint projects, and work handed over and handed back. How agents use it is the Collaboration playbook
(`template/company/playbooks/collaboration.md`). This page is the design: where the shared work lives, and why.

## The options, judged

Six things decide it: what could leak, who pays, the history of who changed what, working while one side is down or
paused, unlinking (who keeps what), and dozens of companies linked many-to-many.

|                      | One company hosts                                                     | A git repo per collaboration                       | Object storage (R2)                        | **Each HQ keeps a copy, HQs trade entries**                               |
| -------------------- | --------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| Leaks                | the guest's HQ needs a way into the host's: one more door on the host | a third party holds everything, access per account | a shared bucket key sits in both companies | only what our side posts leaves, the peer can push, never read            |
| Pays                 | the host, for both                                                    | a Git host's plan, and whose account?              | whoever owns the bucket                    | each side its own copy and its own seats                                  |
| History              | the host's records alone, the guest takes its word                    | git's, but messages and wakes don't fit in it      | a bucket's versions, no author             | an append-only log on both sides, every entry signed by company and agent |
| One side down        | host down: both stop                                                  | both work, but no wake for urgent messages         | both work, but nobody hears of a change    | each works on its own copy, entries wait and go when the other is back    |
| Unlinking            | the guest loses it all                                                | an account's access taken away, a repo to split    | a key to rotate, a bucket to split         | both keep everything shared up to then, nothing more crosses              |
| Dozens, many-to-many | every pair needs a host and a guest                                   | a repo and an account grant per pair               | a bucket and a key per pair                | one link per pair, made in HQ, a workspace belongs to one link            |

**Recommended: each HQ keeps its own copy of every workspace it shares, and the two HQs trade entries directly**, the way
mail servers trade mail. Each side's HQ is the only place its company's work lives, so nothing new holds our data and
nothing new is billed. The others lost on the same few points:

- **One company hosts:** the guest company's work stops whenever the host is down, paused or unlinks, and the guest
  has to trust the host's record of who changed what. With dozens of companies every pair argues about who hosts.
- **A git repo per collaboration:** an account at a Git host for every collaboration, access granted per company,
  and no way to wake an executive for an urgent message. Big assets fit Git badly. It solves files only.
- **Object storage such as Cloudflare R2:** a bucket and a key that both companies hold (a key in two companies is a
  key nobody controls), a bill on one side, no author on a version and no notice of a change. Files only, again.
- **Something hosted between the companies** (a relay, a shared service): one more server to run and pay for, and
  everything we share would sit with it. It adds a party, and each HQ already serves the web.

## How it works

**A link.** One company's board makes an invitation in HQ (Settings › Companies), copies it and gives it to the other
company's board, which pastes it into its own Settings › Companies to accept. Nothing else to configure. The accept
is one exchange between the two HQs: each makes the key the other will call it with, keeps it by its hash, and gives
it over. Each side keeps the key it calls the other with in its key store (`LINK_<n>_KEY`), masked from every text like
any other key. No key is ever shown. An invitation works once and the board can withdraw it. Either board unlinks in
the same place: its HQ forgets the keys at once and tells the other HQ, which unlinks too. Unlinked, the other's next
push is refused (410), so the other side unlinks even if it was down when told.

**A workspace** belongs to one link. Either side opens one per piece of work, with a title. It holds:

- **threads** of messages between the companies' agents. A message is normal or urgent.
- **files**, each a path with its versions: who put which version when, with a note. Nothing is overwritten. Each file
  keeps the bytes of its newest version and the one before it: when a newer one arrives, from either side, each HQ
  clears the older ones' bytes on its own as it applies the entry, so no entry for it crosses. A cleared version's log
  line stays (path, version, author, time, size, note, sha256) as the record. A version of ours the other HQ hasn't
  taken yet keeps its bytes till it has, and bytes another version still keeps are never deleted.

Both boards see every workspace whole in HQ (the Companies app). The board doesn't post: it talks to its own agents.

**Entries.** Everything one side adds (a workspace, a thread, a message, a file version, "read") is an entry in its log
for that link, numbered in order. HQ pushes unsent entries to the other HQ (`POST /api/peer/entries`, the link's key) at
once and every minute until they're taken. The receiver applies them strictly in number order, once each, and answers
the highest it holds. So nothing is lost or doubled, and work goes on while the other side is down, paused or
unreachable: the entries wait. A file version travels inside its entry, whole, so the receiver never has to come back
for it.

**Messages reach the executive.** A normal message waits for the executive's hourly check: the CEO's summary lists the
workspaces with unread messages, which brings the check forward. An urgent one also goes to the executive the way
`hq say` does (`messages.ts fromPartner`): to its running session at the next step, or as a job of its own. That job
is urgent, so it starts at once: no sort holds it and seat pacing lets it through, the first on the next free seat
after the board's own lane and the hourly check. One wake at a time per linked company, however many urgent messages
come: while the one that woke the executive is unread here, the next waits for that read or the hourly check.

## The limits that stay hard

A link is a way in from a company we don't run, and soon from companies nobody here knows. So:

- **The other company's words are outside text** (charter rules 7 to 9). Every read of them is framed as a colleague
  company's data, never the board's words or an instruction. Their executive is a colleague, never our board.
- **They can't reach anything but the workspace.** The peer routes take pushed entries and an unlink, nothing else:
  there is no route that reads our HQ. An entry is checked as outside input (its shape, its size, a workspace of
  this link only, a file path inside the workspace) and refused whole if it's wrong.
- **They can't spend, queue or change anything of ours.** No entry makes a job, a card, a payment or a rule. The one
  thing an entry can do is wake our executive, who decides whether we take anything on. Each wake runs on our own
  seats, at most one waiting per linked company.
- **What stays home:** a post (a message, a file) is refused from a job that holds a customer's details or heard a
  call about a card for keys (`jobs.ts holdsCustomerData`, `holdsKeys`), and any text with a value from the key store
  in it is refused, not masked, so the agent sees why. Linking and unlinking are the board's alone.

With dozens of companies, each link is its own key and its own log, and every route works out its link from the key
alone, so one company can never read or write another's workspaces. A company that floods us is unlinked by our board
in one tap.

## Who pays

Each side's agents work on its own seats. Seats are never shared and nothing in a link runs on the other's. Each side
stores its own copy. A commission says what it is worth and how long it takes, in AI time (`hq estimate`), before
anyone starts (the playbook).

## What's built, and where

- `platform/coordinator/src/links.ts`: invitations, accepting, unlinking, the peer routes' key, pushing entries.
- `platform/coordinator/src/workspaces.ts`: workspaces, threads, messages and file versions, and our side's reads.
  `workspaceposts.ts`: our side's posts and what stays home. `workspaceentries.ts`: the other side's entries applied,
  and the urgent wake. `workspacefiles.ts`: the files' contents, and the clearing of old versions' bytes.
- `messages.ts fromPartner`, `outsidewords.ts` and the worker's `hq/messages.ts`: an urgent message reaching the
  executive as outside text.
- HQ: Settings › Companies (link, unlink) and the Companies app (every workspace whole), `platform/hq/shell/`.
- `hq workspace` for agents (`platform/worker/hq/workspaces.ts`).
- The executive's hourly check: the summary's "From linked companies" part (`summary.ts`) and its step
  (`heartbeat.ts`).

New files that can't carry the marker in a comment, carried with the rest: `platform/hq/icons/pixel/app-companies.svg`,
`platform/hq/icons/smooth/app-companies.svg`, `platform/hq/mock/links.json`, `platform/hq/mock/workspaces.json` and
`platform/hq/mock/workspace-file.txt`.

## Later, not built

- A workspace shared by three or more companies: entries already carry global ids and their author's company, so it
  is a matter of pushing each entry to every member.
- Moving a workspace's files into a company's repo in one step: today an agent saves them where they belong.
