# DPIA template: the support chat (the care engine)

A data protection impact assessment (GDPR art. 35) for a company that switches on the care engine. **Copy this file
into the company's own knowledge base, complete every `<…>` and every "Your company" line, and keep it current.** What
it says about the engine is true of the engine as shipped (`platform/care/`, with HQ's side in
`platform/coordinator/src/care.ts`); what the company adds (its plug-in's tools, its apps' data, its legal entity, its
processors) is the company's to fill in. Where the engine leaves a choice open, this template says so rather than
deciding for you. It isn't legal advice: the company's own compliance owner reads it against its business and signs
it off.

A plug-in can change the picture: tools that look at more data, make decisions (refunds, reprints, vouchers) or ask for
photos add rows to sections 2 and 4. List each of the plug-in's tools in section 2.

## The outcome (complete last)

- **Your company:** whether the chat can go live as built, on which conditions, and whether any risk stays high (then
  the supervisory authority is consulted first, art. 36).
- **Controller:** `<legal entity, address>`. **Data protection officer:** `<name, or why none is needed (art. 37)>`.
- **Written by / reviewed by / date:** `<…>`. **Review:** after the first `<100>` real conversations, and whenever the
  engine, the plug-in or the model provider changes (section 9).

### Conditions before launch (a starting list; add your own)

| # | Condition | Where it's met |
|---|---|---|
| C1 | No customer personal data goes into an agent job that runs on the team's AI subscriptions (seats): a job gets the problem, not the person | the engine's question summaries are in general words; check the company's own tools and HQ's agent routes |
| C2 | The bug report's consent card has three buttons of equal weight; nothing leaves the device before "Send it" | the engine (`api.md`, "The bug report") |
| C3 | The chat says it's an AI before the customer types (AI Act art. 50), and links to the privacy page | the plug-in's greeting and About text |
| C4 | Health details are kept from the model as far as the word list reaches, and the privacy page says what happens past it (section 4b) | the plug-in's health lists, tested on the customers' own words |
| C5 | The chat goes live on an app only once email can be sent (codes, copies, the board's replies) | `switch-on.md`, step 4 |
| C6 | The legal pages change on the day the chat goes live on an app | the company |
| C7 | A sample of question-log lines is checked by hand for identifying details at the start and after every prompt change | the company |
| C8 | Every automatic decision a plug-in's tool makes says its rule in plain words, with the way to a person on the same screen (art. 22(3)) | the plug-in, if it decides anything |
| C9 | A procedure for an upload that may be illegal (section 7), if the plug-in asks for photos | the company's Care handling rules |
| C10 | Erasure reaches the model provider (section 8) | the company: the engine stores no provider request id |

## 1. Why a DPIA

Art. 35(1) asks for one where processing "using new technologies … is likely to result in a high risk". The EDPB's
criteria (WP248rev.01) say two of nine usually mean a DPIA is needed. The engine alone meets at least these:

| WP248 criterion | The chat | Met? |
|---|---|---|
| Sensitive or highly personal data | free-text messages can hold anything, health details included; a bug report's picture can show a name or an address | Yes |
| Matching or combining datasets | the conversation history joined across orders and devices per email address, with order data from the apps | Yes |
| Innovative use of new technology | a large language model that talks to customers and calls tools | Yes |
| Automated decisions with legal or similar effect | none in the engine; **Yes** if a plug-in's tool approves refunds, reprints or vouchers on its own | `<…>` |
| Large scale, vulnerable subjects, monitoring, scoring, blocking a right | `<your company: usually no>` | `<…>` |

Check your lead authority's own list of processing that needs a DPIA (several name AI customer support outright).

## 2. What the chat does with personal data

**Who's concerned:** customers and people about to order; people they mention; people visible in a bug report's
picture or a claim photo; the board, whose name signs its replies. `<Your company: anyone else, e.g. the people a
personalised product is about.>`

**How it flows:** browser → Caddy (`/__care/*` on the app's own host, or its shop's origin for a stall on a shelf,
`www/<slug>/__care/*`) → the care service (its own container and SQLite volume, on `<your server, its provider and
country>`) → the model provider's API for every model call; the service → each app's order endpoint (a minimal order
view; for a shop, every stall's at once on an order number or an email check);
the service → HQ's Care app for everything a person handles; the email service out; the company's inbound mail routing
→ HQ for replies in.

| # | What | Data | Purpose | Legal basis (suggested; confirm) | Who gets it | Kept (the engine's values) |
|---|---|---|---|---|---|---|
| P1 | The conversation | messages, the helper's replies, times, the app (for a shop, the shop and the stall each message came from), the session (by its hash) | answer questions, help with an order | contract (6(1)(b)); before an order, legitimate interest (6(1)(f)). Health details: section 4b | the model provider | 30 days after the last message if never linked to an email; 12 months if linked |
| P2 | Identity check | order number and email as typed, a 6-digit code (hashed), signed-link nonces, grant times | keep one customer's orders from another | legitimate interest and the contract; security (art. 32) | the email service (the code) | a code is valid 10 minutes and deleted after a day; an email grant lapses after 24 h idle, 7 days at most; nonces 8 days |
| P3 | Order lookups | the minimal view from the app (with the order's app, for a shop): id, reference, dates, title, status, carrier, tracking link, country, total, masked address | answer "where is it" | contract | the model provider (in the prompt) | not stored beyond the conversation; the total and masked address are dropped before the email is checked by code |
| P4 | History and summaries | earlier conversations per shop (the apps on one site share one chat) and email; a two-line summary of each | pick up where the customer left off | contract; legitimate interest | the model provider | with the conversation |
| P5 | Email to a person | the customer's words, the reply address, the conversation, a draft reply and its English translation | a person answers | contract; legitimate interest | the board (HQ's Care app); the model provider (the draft, never for a health case); the email service | the service's case 12 months; HQ's card 12 months after its last message |
| P6 | The bug report | a picture of the app's own page (form fields masked), the last ten minutes of a redacted event log, the helper's one line on what's wrong | fix a bug the customer reports | consent (6(1)(a), and ePrivacy art. 5(3) for reading from the browser) | the board, in HQ; never the model | until the bug is marked fixed, 90 days at most |
| P7 | Questions for the team | the question in general words; the customer's address for the answer | answer it by email once the knowledge base has it | contract; legitimate interest | the board; a team job sees only the general words | with the case: 12 months |
| P8 | Question log and counts | one generalised line per conversation (no link back to it); daily counts | improve the answers | legitimate interest for writing the line; then not personal data (section 6) | the company | no end date (anonymous); counts about 13 months |
| P9 | The cost ledger | per model call: app, conversation id, session, a keyed hash of the address, purpose, model, tokens, cost | cost control and caps | legitimate interest | the board (Care › Numbers) | stays when the conversation goes (no message text) |
| P10 | The session cookie | a random id (`__Host-`, `HttpOnly`, `Secure`, 30 days sliding) | reopen the chat on this device | strictly necessary (ePrivacy art. 5(3) exemption) | nobody | 30 days after last use |
| P11 | Tool log (previews and local runs only) | the model's tool calls, inputs cut to what an eval checks | test the chat before launch (the company's own tests, and the people on a tester invite, whose chats also reach Care as cases) | legitimate interest | the company's eval | 7 days; never kept for a live app |
| P12 | Rate limits | keys per session, address, email or order | stop abuse | legitimate interest; security | nobody | a day |
| `<P…>` | `<each plug-in tool: claim photos, remedies, vouchers, …>` | | | | | |

HQ's side, if the company uses it: emails to the inbox become Care cards (`<your retention for mail>`); a claim's
photos are kept with their card until 6 months after it closes.

## 3. Necessary and proportionate?

- **Less data where it can be less.** The model gets a minimal order view, never the full address; summaries instead of
  whole earlier transcripts; no bug report pictures or logs; no claim photos. The ledger holds ids and counts, never
  message text, and the address only as a keyed hash. The question log replaces transcripts as the dataset for
  improving answers.
- **Two identity levels.** Order number + email shows one order's status; history, other orders and anything that moves
  money need a code from the inbox or a signed link. The tools take no value the customer didn't type, and a button
  runs only what the server stored.
- **Short retention** (section 2), everything keyed by email and order, so one lookup answers an access request and
  one action erases it.
- **Transparency.** The first message says it's an AI; a notice in the chat links to the privacy page, which explains
  the chat, the processors, retention, the bug report and any automatic decision (`<your privacy page's section>`).
- **Rights.** "Delete this conversation" in the chat's menu: from this device, and from the service too (a chat linked
  to an email asks, and deleting the service's copy needs the email check; what already went to a person stays with
  HQ, and the board deletes it there on request, which deletes the service's copy too); access and erasure by email
  `<within a month, art. 12(3)>`; withdrawing the bug report consent by asking.
- **A person is always one step away**: "Email a person" in the chat's menu on every screen (drawn by the widget, not
  the model), on the outage card, and on any ask in words. `<With chatFirst: a first ask, and the menu, hear once that
  the chat can probably help better, with the email button beside it; an insist gets the email card at once; the
  outage card has it only on a stopped chat>`

## 4. Risks and measures

Likelihood and severity for the people concerned: remote / possible / likely, minimal / significant / serious.
Residuals are after the measures; **complete them for your company**.

| # | Risk to people | Measures in the engine | Your residual |
|---|---|---|---|
| R1 | Someone else sees a customer's orders or chats (a housemate with the packing slip, a shared tablet) | the two levels; codes only after a match, rate-limited; the email grant's 24 h / 7 days; the `__Host-` cookie held for the page that typed the proof; copies only to a code-checked address; drafts mention no order details when the address wasn't checked | `<…>` |
| R2 | A wrong answer about an order or about rights | facts from tools, rights only from the knowledge base; "I don't know yet, shall I ask the team?" instead of a guess; About says it can get things wrong; a person a tap away. A disclaimer doesn't cover you: test it (an eval) before launch | `<…>` |
| R3 | A wrong automatic decision, or one the customer can't contest | none in the engine. `<A plug-in that decides: rules that only say yes, a no goes to a person, the rule shown at the outcome (C8), the board can change any outcome>` | `<…>` |
| R4 | A health detail is processed without an art. 9 condition, or reaches the model | the health-detail check (section 4b): the word list holds a matching message before the model; the model's instruction to remove what the list missed | `<…>`: see 4b, this can't be "none" |
| R5 | Prompt injection leaks data or triggers an action | the model can't raise a grant; tools take no email argument; actions only from a server-stored button the customer taps; everything a customer sent shown as text in HQ; photos never shown to the model | `<…>` |
| R6 | Kept too long, or can't be erased, including copies at the model provider | the retention in section 2, swept hourly; one key for access and erasure; HQ's `erased` reaches the service's copy. **Gap**: section 8 | `<…>` |
| R7 | Transfer outside the EEA (the model provider) | `<your provider's transfer mechanism: SCCs or an adequacy decision; no training; its retention>`; the minimal order view; no photos or bug reports to the model | `<…>` |
| R8 | The bug report captures more than needed, or consent isn't free | a memory-only buffer, redacted before it's stored and again on the server; a picture of the app's own page with form fields masked, not a screen share; a preview before sending; equal buttons; asked once per conversation; the same help either way | `<…>` |
| R9 | Customer data in the team's agent jobs on seats, where the provider may not be your processor | a question reaches a team job in general words only; health cases go to no job. `<Your HQ routes and own tools: check each>` | `<…>` |
| R10 | The "anonymous" question log identifies someone | generalised lines, no quotes, names, dates, order numbers or places; no link back; a hand check of a sample (C7) | `<…>` |
| R11 | The way to a person doesn't work, so the rights exist only on paper | "Email a person" on every screen and on the outage card (`<with chatFirst: a stopped chat's>`); a reply time the board really meets (the plug-in's `busy.aim`), measured in HQ; no email promised before email works (C5) | `<…>` |
| R12 | The board's review becomes a rubber stamp for AI drafts | one card at a time, no "approve all"; the customer's words and the facts beside the draft; a translation; the sign-off says the AI helped | `<…>` |
| R13 | A breach of the care service | reachable only from Caddy; its volume not mounted into jobs or the repo; keys only in its container; spend caps. `<Your breach procedure: the board within hours; the authority within 72 hours (art. 33); customers if high risk (art. 34)>` | `<…>` |
| `<R…>` | `<the plug-in's own: photos, remedies>` | | |

### 4b. The health-detail check, and its honest limit

A customer may write a health detail ("I was in hospital", "I can't sleep"). That's data concerning health (art.
4(15)), and art. 9(1) prohibits processing it unless an art. 9(2) condition applies, whether or not you asked for it
(CJEU C-252/21 *Meta v Bundeskartellamt*, paras 68–69). In a shop's chat usually none does: explicit consent can't come
before a typed message is sent, a private chat isn't "manifestly made public", and the rest don't fit. Many model
providers' processor terms also list no special categories. So the engine keeps health details from the model as far
as it can, and offers the one route with consent:

1. **The word list, before the model.** The widget checks every message against the plug-in's health lists (all
   languages, whatever the page's) before it leaves the device, and the service checks again on every message and
   before every model call (a script that skips the widget gets no further). A match is held: the model never sees it.
   The customer edits it, or taps "Send it to a person instead": explicit consent (art. 9(2)(a)) for a person, not the
   model, to read it. That case gets no AI draft or summary, ever; HQ shows it as a health case, sends it to no model
   and no agent job, and its reply is signed without the AI line.
2. **The model's instruction, after it.** A message that matches no term goes to the model like any other. The model
   is told never to repeat or ask about a health detail and to call `remove_health_detail`; the service then blanks
   the message's text in its store and in later turns, and tells the customer. **The model has already read it by
   then: this is clean-up, not a guard.**

**So a health detail is kept from the model only if the list catches it.** Say so in this assessment and in the
privacy page; don't claim none ever reaches the model. `<Your company:>` the words your customers will really use
(their conditions, symptoms, life events), each tested with `healthTerm()`; false alarms counted after launch; the
residual stated plainly: a detail phrased so that both the list and the model miss it is processed without an art. 9(2)
condition, at the model provider for its retention period and in the service until the conversation's retention ends.
The notice under the first message asks customers to leave health details out.

## 5. Automated decisions (only if a plug-in makes them)

The engine decides nothing about a customer: it looks orders up and hands everything else to a person. A plug-in tool
that approves a refund, a reprint or a voucher on its own makes a decision "based solely on automated processing" with
a legal effect (art. 22). `<Your company: the exception you rely on, usually 22(2)(a), necessary for the contract; why
a person's check would be worse for the customer; the safeguards of 22(3): the way to a person on the same screen,
room to add their side, the rule stated at the time and on the privacy page; the fallback if the reasoning fails (a
person confirms each one).>` Explicit consent (22(2)(c)) is the wrong basis: a customer who says no would lose the quick
remedy, so it isn't free.

## 6. The question log: anonymous, and how it stays so

Writing a generalised line from a conversation is processing of it (legitimate interest, compatible with the chat's
purpose, art. 6(4)). The line itself is anonymous if nobody can single out, link or infer anything about a person from
it (WP29 Opinion 05/2014). The engine writes it generic by instruction, stores it with the app and the day only, and
leaves health details out. A hand check of a sample (C7); a line found with an identifying detail is deleted and the
prompt fixed.

## 7. Uploads that may be illegal (if the plug-in asks for photos)

`<Your company: the procedure, under your country's criminal law. A starting shape: photos never go to the model, and
reach a supplier only after a person has seen them; whoever sees a suspect image doesn't open, copy or forward it
again; one action freezes the file and holds the case; the board is told at once, in words, without the image, and
decides on reporting to the police; the file is deleted only when the police say so; nothing about it goes to an agent
job.>` Check whether the Digital Services Act reaches an upload only you see (usually not: it isn't disseminated), and
meet its art. 16 and 18 anyway.

## 8. Processors

| Processor | What it gets | Where | Agreement | Retention | Notes |
|---|---|---|---|---|---|
| `<model provider>` | every model call's prompt: the conversation, the minimal order view, summaries | `<…>` | `<its DPA, part of its commercial terms?>` | `<e.g. inputs deleted within 30 days; longer if flagged for misuse>` | an API key from an organisation in your legal name, never a seat; no training; no feedback on customer conversations |
| `<email service>` (`email.md`) | addresses, codes, answers, the board's replies | `<…>` | `<…>` | `<…>` | tracking off |
| `<server host>` | everything the service stores | `<…>` | `<…>` | | |
| `<DNS, mail routing, backups>` | inbound mail, backups | `<…>` | `<…>` | | |
| `<the apps' own suppliers a plug-in tool reaches>` | | | | | |

Before switching model provider: a processor agreement, a transfer mechanism, known retention and no training, terms
that allow a consumer-facing chat, and the privacy page changed the same day.

**Erasure at the model provider (art. 19).** The provider received the chats, so it's a recipient, and an erasure is
passed on unless that's impossible or disproportionate. Most providers delete API inputs within a set period, but keep
flagged ones longer, and you can't see which. **The engine stores no provider request id** (the ledger has the
conversation, the model and tokens only), so an erasure request can't name the calls. `<Your company: accept that and
say so (the provider's retention, the flagged-copy exception), or have the plug-in or a platform change store the
request ids, and keep them, without message text, as long as the provider may keep flagged copies.>`

## 9. Review after launch

After the first `<100>` real conversations, and whenever the design changes: re-read this against what the chat does,
with the numbers (the hand-over rate, "Did this help?", how often the health check held a message and how many were
false alarms, any health detail found in a sample of stored messages or question-log lines, every access, erasure or
complaint so far). A risk whose residual moved goes back through section 4 (art. 35(11)).

## 10. Sources to cite

GDPR art. 4(15), 5, 6, 7, 9, 12, 13, 17, 19, 22, 28, 30, 32–36, 44–46; WP29 WP248rev.01 (DPIAs), WP251rev.01
(automated decisions), Opinion 05/2014 (anonymisation); EDPB Guidelines 2/2023 (ePrivacy art. 5(3)); CJEU C-252/21;
the AI Act art. 50; your model provider's commercial terms, DPA and retention page; your email service's terms and DPA;
your lead authority's DPIA list.
