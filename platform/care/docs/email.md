# Sending email

The platform sends email through one transactional email service, with one key. Two senders use it:

- **The care service** (`platform/care/src/email.ts`): sign-in codes and signed links, the helper's answers by email,
  "email me a copy of this chat", an answer to a question once the knowledge base has it. From the plug-in's `sender`.
- **HQ** (`platform/coordinator/src/mailout.ts`): the board's replies from the Care app (with a reply-to per case,
  `case-<n>@<domain>`), a gated tool's email to a customer, a guest's sign-in code, and a product's own order emails
  (`ordermail.ts`: "paid", "shipped", in the product's words from `products/<slug>/care/order-emails.yaml`, to the
  address the order was paid with, with the files the product names there, PDF, PNG or JPEG; how a product asks for
  one: the top of `ordermail.ts`). From `hello@` the company's mail domain.

Mail **in** is separate and unchanged: Cloudflare Email Routing sends every message to the domain to HQ
(`infra/mail/worker.js`), which is how a customer's reply to `case-<n>@` lands on its card. The sending service never
receives mail.

## The service: Lettermint

Lettermint is the one built in (another service is one entry in `mailout.ts`'s `services` and a sender in `email.ts`).
Why it: an EU company running its own infrastructure in the EU only; its data processing agreement is part of its
terms; open and click tracking are off unless switched on (and plain-text mail can't be tracked at all); it deletes
sent mail after 28 days; one plain HTTPS call with one header; a real sandbox mode; and it needs no change to the SPF
record Cloudflare's Email Routing uses. Check its current terms, prices and sub-processors before the board signs up:
they change.

**Price** (check the pricing page): a free plan with a monthly limit and one domain covers building and testing; before
the chat goes live in a shop, the smallest paid plan, with "Disable overages" on so mail past the limit is refused
rather than billed. On the free plan, mail past the limit is refused too: a sign-in code would fail, so watch the volume.

**What compliance checks first** (for the company's DPIA, `dpia-template.md`, "Processors"): a processor agreement in
the online terms; where the mail is processed and stored; how long content and logs are kept, and no marketing or
model-training use; tracking off; the account in the company's legal name.

## What the board does (one desk-phone card, about 20 minutes)

1. Sign up at Lettermint with its own email; the team in the company's legal name.
2. Domains › Add domain: the company's mail domain (`<zone>` below: `brand.yaml`'s `mail.domain`, the public one, not
   a domain in `mail.also`, which only receives).
3. In Cloudflare (`<zone>` › DNS › Records › Add record) the records below.
4. Verify the domain in Lettermint.
5. The compliance form: what the mail is (order and support email: sign-in codes, replies to customers, order updates;
   no marketing), the website, the expected volume.
6. Projects › a new project (say "Care", live). On its transactional route: open and click tracking off, and content
   redaction on if the plan offers it.
7. A Project API token for that project, saved on the desk phone as `CARE_EMAIL_API_KEY`.
8. Webhooks › one for the whole project (no route picked): the URL `https://<HQ's host>/api/list/notices`, the events
   `message.hard_bounced`, `message.failed`, `message.suppressed` and `message.policy_rejected` (an email it took and
   couldn't deliver), and `message.unsubscribed` and `suppression.added` (an address that left a list through its own
   leave link); its signing secret (`whsec_…`) saved on the desk phone as `EMAIL_WEBHOOK_SECRET`. One webhook, as HQ
   keeps one secret. Without it HQ never hears of an email that didn't arrive, and sends no list email.

Then the company sets `EMAIL_SERVICE=lettermint` in `company/infra.env` (step 3 of `switch-on.md`). Both are needed:
HQ sends only with the service named **and** the key in; until then its test mode sends nothing and live mode refuses
(503), and the care service fails a send without a key everywhere but a local run, so nobody is told a code is on its
way when nothing went.

## The DNS records, in Cloudflare

Send from the domain itself (`hello@<zone>`, the plug-in's sender at `<zone>`), not a `mail.` subdomain: customers see
the address they write to, and the `case-<n>@` reply-to addresses stay on the domain Email Routing serves. Every CNAME
is **DNS only** (grey cloud). The DKIM targets are made per account: copy them from Lettermint's page for the domain.

| Type | Name | Content / target | What it's for |
|---|---|---|---|
| CNAME | `lm1._domainkey` | the lm1 target Lettermint shows | DKIM: the domain's signature on every message |
| CNAME | `lm2._domainkey` | the lm2 target Lettermint shows | the second key, so Lettermint rotates keys with no DNS change |
| CNAME | `lm-bounces` | `bounces.lmta.net` (as Lettermint shows) | the bounce (return-path) address; carries SPF for Lettermint |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@<zone>` | DMARC, report only to start |

- **Leave the existing SPF record alone.** The apex keeps its one SPF TXT, Email Routing's
  (`v=spf1 include:_spf.mx.cloudflare.net ~all`). Lettermint's SPF lives behind `lm-bounces`; a second SPF record at
  the apex would break SPF for both. The MX records stay as they are.
- **DMARC**: if the domain has no `_dmarc` record yet, start at `p=none` (reports only, nothing rejected). The reports
  go to `dmarc@<zone>`, which Email Routing delivers to HQ's Mail. Don't set `aspf=s`: Lettermint's bounce address is a
  subdomain, and strict SPF alignment blocks verification. After a few weeks of clean reports, move to `p=quarantine`,
  then `p=reject`. If the domain already has a DMARC record, keep it and add only what Lettermint asks for.
- If Lettermint offers Domain Connect for Cloudflare, it can add the records in one go; check `_dmarc` afterwards.
- An older account may show one DKIM TXT instead of two CNAMEs: add whatever its page shows.

## How the code sends

- **Plain text only**, one recipient per message, `track_opens`/`track_clicks` false on every message, to
  `https://api.lettermint.co/v1/send` with the `x-lettermint-token` header. Addresses with a comma, a name part or a
  line break, and subjects with a line break, are refused before anything is sent.
- **The sender**: the care service sends from the plug-in's `sender` (`'Name <someone@<zone>>'`), and only that domain
  may be a sender; HQ sends from `hello@<zone>` under the company's name. Keep both on the one verified domain.
- **The AI mark**: an email with the model's words in it (an answer, a copy of a chat that has some) carries the header
  `AI-Disclosure: mode=machine-generated`, in Lettermint's `headers` and in the local outbox (README.md, "The AI
  mark"). Lettermint doesn't say it keeps a custom header: check it on the first real test mail.
- **No key**: a local run of the care service keeps the message in an outbox (the harness, the tests) and logs its
  kind, a masked address and the subject (so a tester can read a code); HQ's test mode returns the rendered email to the caller.
- **Attachments** (HQ's claim email with its photos): base64, within the service's per-message limit (25 MB with the
  base64 included at Lettermint).
- **Tests** run against a local stand-in for the API: `CARE_EMAIL_API` points the care service's sender at it,
  `EMAIL_API` HQ's, `CARE_EMAIL_SERVICE` names the service for HQ in tests. For a real end-to-end try before launch, a
  Lettermint sandbox project accepts mail, delivers nothing and uses no quota.
- The key is a server key: it reaches the care container and the coordinator, never a product or an agent job.
- **Taken isn't delivered**: Lettermint's yes means it took the email; a bounce, a suppressed address or its own spam
  filter comes later, on its webhook (step 8). HQ keeps the id Lettermint gives each send with the send's `about` (which
  email, never an address: "the basket email for cs_…"), checks the signature (HMAC-SHA256 over `<t>.<body>`, 5 minutes'
  tolerance), and for those four events keeps the failure with the others (`mail_failures`, in the status report's "email
  that didn't go") and logs `NEEDS A PERSON` once per email, naming it.
