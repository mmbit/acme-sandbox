// The care service's plug-in, its server side: a working minimal example. The
// engine (platform/care) loads it at start from CARE_COMPANY_DIR, which is this folder unless set. Every export is
// optional: a missing one is the engine's default (platform/care/src/company.ts lists them all, and
// platform/care/README.md says what each one does). This one speaks English only, has no tools of its own (no remedies),
// and says a person replies within 2 working days, as its widget's words and its kb do.

// the model the helper runs on (the ledger's price table must know it: platform/care/src/ledger.ts)
export const model = 'claude-sonnet-5-5';
// who runs it, in the prompts for the board and the team, and the address the service's email comes from
export const company = 'Example & Co';
export const shop = "{company}'s shop for {thing}s";
export const about = '{company} is a small company that makes things to order (its shops: {shops}).';
export const sender = 'Pebble <help@example.com>';
// the counting day and the dates in emails (keep it the same as company/org.yaml's timeZone, which HQ counts by)
export const timeZone = 'Europe/London';
// a person's reply: 2 working days (the texts' "we aim to reply within 2"), busy when more than 30 emails wait or one has waited 2 days
export const busy = { waiting: 30, days: 2, aim: 2 };
