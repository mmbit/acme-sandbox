# The helper's knowledge

One entry per file: the question as people ask it, the answer in the company's own words, its `source` (the public page
a customer could open) and a `verified` date. `shared/` is for every app; `<app>/` is one app's own (the folder is the
app's slug; CARE_KB maps another slug to it). A conversation sees `shared/` plus its own app's folder, never another
app's. The whole of it goes into the cached part of every request, so keep it small. Customers' words never go in here:
the team writes each answer itself.

An entry names a button or a step of the chat by its key in the widget's words (`public/i18n.js`): `{label:m_delete}`
becomes "Delete this conversation" in the customer's language, so the helper names the button as the customer sees it,
renamed or not. Never copy a label by hand. A key the chat doesn't have fails the company's own test (`kb.ts`
`unknownLabels()`).

Frontmatter: `question:`, `source:`, `verified:`, and `answers: "H-<n>"` once an entry answers a question a customer
asked (the service emails them the answer after the entry is merged). Values containing " #" are double-quoted.
