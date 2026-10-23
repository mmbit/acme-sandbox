# Venture cycle

How the company turns a brief into live products. Only the board starts a cycle, with a brief: the number of concepts
(N), an optional theme, and constraints. The cycle lead runs it: the head of the department that makes new products
(the founding hires name it in `org.yaml`).

The cycle runs end to end on its own and has one board gate, at the end, marked 🔶: the board sees finished, working
products and what they could earn, never just ideas. Plan in AI time: a whole cycle takes hours, not days.

## How the team runs

One cycle is one job for the cycle lead, in one session. The lead briefs a team of named sub-agents
(`subagent_type: "team-member"`), one per concept, each with its name, its `people/` file, its phase instructions and
AGENTS.md's "What you're capable of", word for word. Members may start their own helpers, briefed the same way. The lead
talks to members by name; members commit under their own names and keep their `people/` file current, so a member can
be picked up in a later job. At the board gate the lead doesn't end the job: `hq ask` files the request and `hq wait`
waits for the answer.

## 0. Brief

The board's brief goes in `products/_cycles/<date>/BRIEF.md`. The lead names N venture agents with new, never-used
names, adds them to `org.yaml` and creates their `people/` files. An agent whose product launches stays on as its owner;
the others move to the alumni list.

## 1. Shared knowledge (the lead)

Before anyone pitches, make sure `knowledge/` is current. Update it; don't redo it.

- **The production partner's spec:** authentication, ordering flow, catalogue endpoints, artwork requirements
  (dimensions, DPI, bleed, formats), shipping options and regions, order status and webhooks, the test environment,
  with working example requests.
- **The catalogue:** product categories, base prices, lead times, personalisation limits and unusual products.
- **Conventions:** stack, project structure, credentials (environment only), test environment, definition of done.

## 2. Research and pitch (venture agents, independently)

Venture agents don't talk to each other in this phase, and nobody shares other agents' ideas, so concepts develop
without steering. Each researches its market first (trends, existing products, competitors) and lets the research shape
the idea, not just justify it. Then it writes `products/<slug>/PITCH.md`, signed:

- **Concept and brand:** name, one-liner, tone.
- **Products:** the partner's actual products, with unit economics (base cost, shipping, payment fees, retail price,
  margin per order).
- **Target customer:** who buys it, and why they want the physical object rather than a digital version.
- **Market and competition:** trends, the closest existing products, and evidence that no major competitor does this.
- **Hook:** the moment in a 9:16 ad that makes someone think "I want to try that".
- **Signature UX:** the experience at the heart of the app, described concretely.
- **Conversion path:** from ad to paid order in as few steps as possible.
- **Forecast:** what it could earn, so the board can set its ad spend. From sourced comparables: cost per click or per
  thousand views, the landing-to-order conversion rate, and so the cost per order; against the margin per order, the
  break-even cost per order. Then orders, revenue and profit per month at a suggested test budget, in a low, expected
  and high case, every assumption with its source.
- **Operational risk:** what can go wrong in production, support and compliance, and how it's handled.

## 3. Review (the lead)

- **Uniqueness across the portfolio:** a different product category, audience and core mechanic, live products
  included.
- **Feasibility** with the partner's actual products and file requirements.
- **Revenue:** the unit economics work, the reason to buy is real, and the forecast's assumptions are sourced and sane.
  Reject ideas that rest on novelty nobody would pay for, and forecasts that rest on numbers nobody looked up.
- **The research holds up.** Push back on thin evidence.
- **Virality:** send back pitches that play it safe.
- **The charter:** no dark patterns needed to make it work, no IP or compliance landmines.

To send a pitch back, message its agent by name with specific feedback; repeat until all N are approved, and log every
decision in `DECISIONS.md`. The pitches stay inside the team: the lead is the gate.

## 4. Build (venture agents)

Venture agents may now message each other and share tools through `kits/` and its registry (check it before building
anything general-purpose). Shared tools must never make the products converge in identity. Before building, read the
craft library's notes on what you're making (`shared/craft/`). Each agent builds:

1. **The app:** polished, full of spring animations, conversion-optimised, with sound effects crafted like foley at its
   key moments (and a mute toggle), and the partner integrated end to end in the test environment: design, preview,
   checkout and order submission.
2. **The ad:** 9:16, 15 to 30 seconds, rendered with audio, its hook the one in the pitch.
3. **A README:** how to run it, the order flow, known gaps.

Code goes through the review panel. Spec changes are proposed to the lead, not worked around.

## 5. Final review and presentation (the lead)

For each product the lead checks the build against the pitch, confirms a test order goes through and that the ad
matches the hook. Then the presentation: an interactive deck built with the shared deck tool (`shared/deck/`) at
`products/_cycles/<date>/presentation/index.html`, visuals and key points rather than paragraphs, portrait first
(`shared/craft/decks.md` has the checks):

1. **The ads first**, each playing in the deck.
2. **Each concept**, a few slides: the product and its signature experience (real screenshots and recordings), the
   market (customer, trend, gap, with the research's numbers), the unit economics and the forecast as simple visuals,
   the main risk, and a button to try the preview.
3. **The close:** which to launch first and why, and the test budget suggested for each.

Every number comes from the pitches and the build; nothing is invented for the deck.

🔶 **Board gate.** One desk-phone request (`hq ask`, kind decision, `--back <slug>` for each product) whose body starts
with the deck's address, `https://cycles.preview.<zone>/<date>/presentation/`, then per product its preview link, its
ad, and a short card: the one-liner, the price, the margin, the expected monthly profit at its test budget, and the main
risk. The board answers per product: launch, kill, or feedback. Feedback has one owner, the product's owner, who fixes
it and brings the product back (the Board requests playbook).

## 6. Launch and learn

The launch checklist, a production deploy (approved), then an ad test with a board-approved budget and stop-loss rule,
set from the forecast. After the agreed window, the CEO proposes to kill, iterate or scale on cost per order,
conversion, margin and customer feedback, and the forecast is checked against what happened.
