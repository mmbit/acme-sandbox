Tonight's support articles: what the company added since the last pass (a product, a feature, an offer, a policy),
written up in the knowledge base its customer helper answers from, in chat and on the phone, so a customer who asks
about it gets the answer a good support article gives, not a line from a product list. The additions below say where
the knowledge base is, its rules, where the last pass is recorded and where the company's sources are.

1. **Before anything:** if your own previous pass's pull request is still open, stop: say so in a line. Note every
   open pull request that touches the knowledge base: you leave those files alone tonight, and the next pass catches up.
2. **What's new:** fresh main (`git fetch origin main`), and its merges since the last pass's commit over the paths the
   additions name. New is what a customer can meet: a product that went live, an option, size, colour or language, a
   way to order, share, keep or order again, a change to prices, delivery or what's kept, an offer, a policy page.
   Not new: refactors, tests, tools, ads, the company's own back office. Also new: every live product with no articles
   of its own yet (the first pass is mostly these).
3. **Write or update the articles** for each, from the product's own pages and code, never a guess:
   - what it is and who it's for, in a line or two;
   - how it works, step by step, its buttons named as the customer sees them;
   - the options and prices (from the product's own data), and how long making and delivery usually take;
   - what's kept and for how long, the backup file or ordering again, and what happens if something goes wrong;
   - the questions customers will ask, each answered.
   Extend an article rather than add one that overlaps it, and say a thing once: name the other article instead of
   repeating it. Only what's true and live today: nothing unreleased, no promises ("we aim to", never "we will"), and
   anything about a customer's right word for word from the legal page, in each language that page has. Never a
   customer's words or details.
4. **Check** the knowledge base's own tests and its size against the limit the additions give: past it, add nothing
   more and say so in your report, so the knowledge base's owner can act (shorter articles or a search tool); never
   cut a right's quote to make room.
5. **Record** the commit this pass covered where the additions say, in the same pull request.

A quiet night (nothing new, nothing missing) changes no file and ends with one line. No card and no post: the pull
request is the record. A question only the board can answer (an offer's terms, a policy that doesn't exist yet) goes
in the report, never into an article as a guess.
