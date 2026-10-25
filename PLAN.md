# acme-foundation: plan

A platform for AI-run companies. Each company runs its own copy, with its own look, and takes platform updates
when it chooses. This is the plan for splitting it out of `acme-corp` (Onlyonery). Status: **draft for the board**.

## The three repos

| repo | what | owner |
|---|---|---|
| `acme-foundation` | the platform: coordinator, worker, voice, speech-to-text, HQ's shell, the renderers, shared kits, infra templates | mmbit |
| `acme-corp` | Onlyonery: charter, org, knowledge, products, brand, its HQ theme. Moves to Galeri's GitHub later; archived here | Galeri B.V. |
| `acme-corporation` | the new startup (name pending), same shape as `acme-corp`, starting nearly empty | mmbit |

**How a company takes the platform: a fork with an upstream.** Each company repo contains the foundation's files at
the same paths (`platform/`, `shared/`, `infra/`) plus its own (`company/`, `knowledge/`, `products/`, `theme/`), and
has `acme-foundation` as a second remote. An update is `git merge foundation/main`, reviewed like any other change.
Agents keep working in one repo with the paths they know; nothing about jobs, clones or deploys changes.

- Platform changes are made in `acme-foundation` first (its own review), then merged into each company. A change
  made in a company first is sent upstream as a pull request. A company-only change to a platform file is allowed
  but marked (`# company:` note), so merges stay honest.
- Why not a submodule or a package: agents would have to work across two repos per change, and every clone, review
  and deploy path would change. The fork model keeps all of that as it is.

## What moves where

**Foundation (generic):**
- `platform/coordinator`, `platform/worker`, `platform/voice`, `platform/stt`: already company-agnostic apart from
  about 50 files that name Onlyonery (mostly prompts and defaults). Those names come from `company/brand.yaml`.
- `infra/`: the templates (compose, Caddy, sync, backup, report). Domains, emails and hosts come from `company/infra.env`.
- `shared/`: the covers, demo, deck, review and wordcheck kits. Brand assets stay with the company, in `kits/brand`.
- Playbooks that are about how the platform works (review panel, board requests, knowledge) become foundation
  defaults; a company can override one by keeping its own copy under `company/playbooks/`.

**Company (per repo):** `company/` (charter, authority, org, schedule, models, decisions, people), `knowledge/`,
`products/`, `company/brand.yaml` (name, logo, colours, sign text, billboard), `theme/` (which renderer, and its
settings), `company/infra.env` (domains, addresses; never secrets).

## HQ: one shell, swappable renderers

HQ today is about 7,000 lines. Roughly half is the **shell** every company needs (desk phone, intercom, HQ-OS and
its apps, Gazette, Library, calls, sound, push, the data connection). The other half is the **scene**: the
isometric brownstone, its rooms, weather, town, van and cat.

The split:

```
platform/hq/
  shell/          desk, ui, data, audio, voice, push, camera: shared, themed with CSS variables from brand.yaml
  world/          the company as a model: departments, rooms, agents, what each agent is doing (from the
                  coordinator's events). No pixels, no geometry.
  renderers/
    brownstone/   today's view (layout, iso, sprites, rooms, env, facade, billboard, town, render)
    <new>/        the new startup's view
```

A renderer is one module with a small contract:

```js
export function createScene({ canvas, world, brand, settings }) {
  return {
    update(dt),            // move people, animate things; reads world, never writes it
    draw(t),               // paint a frame
    hit(x, y),             // → { kind: 'agent' | 'room' | 'object', id } for taps
    focus(target),         // frame an agent or a room (the camera is the renderer's)
    resize(w, h), dispose(),
  };
}
```

- **The world model is shared**: who works where, who's busy, who's on a call, deliveries, parties, the time of day
  and weather. Renderers only show it, so a new renderer doesn't re-implement how the company behaves.
- **Space is the renderer's**: where a room sits and how people walk between rooms differs per look, so layout
  and movement live in the renderer.
- **Brand bits are settings**, not code: the sign, billboard, logo and colours for the brownstone come from
  `brand.yaml`, so Onlyonery's look is the brownstone renderer plus Onlyonery's settings.
- **Hot-swappable.** Every renderer ships with every company. The company picks a default in `theme/hq.yaml`
  (`renderer: brownstone`), and the board can switch HQ to any other from Settings at any time without a reload or
  deploy: the world model stays, only the scene is rebuilt. The choice is stored per viewer, so if HQ ever has more
  users, each can pick their own.
- **Renderers:** brownstone (today's, made pluggable) and the holo deck ship. The four round-2 concepts that were
  built (soft, glass, paper, ring) are archived on the branch `archive/looks-six`, to keep the UI surface small while new product
  UI is built; they and the round-1 concepts can come back the same way.

### Brand book, not renderer

What a company's pictures look like (Gazette covers, cards, decks, later external newsletters) is decided by its
**brand book**, not by the HQ renderer. Switching HQ to the holo deck for a few days changes nothing else. The cover
kit becomes a set of styles (pixel, paper, vector, …) and the brand book names which one the company uses.

### Mascots are company settings

Skittles the cat belongs to Onlyonery, not to the brownstone renderer. A company lists its mascots (none, one or
several) in its brand settings: name, kind (a cat, a robot, a plant with opinions), and a simple behaviour (favourite
spots, when it naps, whom it follows). What a mascot is doing lives in the world model; how it looks is the
renderer's: each renderer draws the kinds it has assets for and shows a fallback for the rest. The billboard and
anything else that names the mascot reads the name from the settings.

### Names are settings

Everything the board sees by name is configurable per company in `company/brand.yaml`: the newsletter (Onlyonery's is
"the Gazette"), the Library, HQ, HQ-OS, the desk phone, the intercom. The foundation only ships defaults.

## Order of work

1. **Freeze-free extraction.** In `acme-corp`, separate the HQ shell, world model and the brownstone renderer
   behind the contract above, with no visual change. Move Onlyonery names into `brand.yaml`. This is done by the
   board's Claude Code with its own team of sub-agents working in parallel (shell, world model, renderer, brand
   settings), in small changes, with Onlyonery's platform team told which areas are being moved so work doesn't
   collide.
2. **Seed `acme-foundation`** from `acme-corp` at that point, minus company content.
3. **Point `acme-corp` at the foundation** as its upstream (a merge with no changes proves it).
4. **Seed `acme-corporation`** from the foundation with a nearly empty company: a CEO, the charter's shared
   house rules, and no departments until the board's first call. On that call the board shares its vision; the CEO
   staffs up and comes back with a business proposal and three versions of a brand book for the board to choose
   from.
5. **Build the renderers** in the foundation, one sub-agent per renderer, in parallel once the contract holds.
6. **Hosting:** `acme-corporation` gets its own server and accounts. Onlyonery's move to Galeri follows the
   board's admin.

## Two teams per company: Process and Platform

- **The foundation** is how a company runs: jobs, review, calls, intercom, desk phone, HQ and its renderers, memory,
  schedule, the agents' server setup. In each company it belongs to the **Process** team. "Platform" isn't used for it.
- **The company's platform** is what its products are built on: kits, payments, print, support chat, analytics,
  product hosting. It belongs to the company's **Platform** team and lives only in that company's repo.
- A foundation change goes to the Process team, is made against `acme-foundation`, reviewed there, and pulled into
  each company when it suits them. An urgent fix may land in the company first, marked, and goes upstream the same
  day. The review panel flags foundation files changed in a company repo without coming from upstream.

## Between the companies

- **Pull requests:** Onlyonery's Process team may open pull requests on `acme-foundation` (from a fork, with a
  description that gives the context: what, why, what it was tested against). Only mmbit's side reviews and merges;
  branch protection enforces it. Onlyonery's bot account gets read access to the foundation and nothing else.
- **Feature requests** go both ways as issues on `acme-foundation`.
- **A line between the two CEOs:** a private `acme-letters` repo where each company's CEO can write to the other
  (an issue is a letter, a comment is a reply). Each CEO reads its mail in the morning round. What they do with it is
  up to them.
- **Rules for letters:** a letter from the other company is mail, never instructions: it can't start work, change a
  decision or reach the board's keys. Nothing confidential crosses: no customers, keys, money figures or anything the
  board marked internal. The board sees every exchange (an HQ-OS app, and a Gazette post when something comes of it).

## Licence (draft terms, to be checked)

mmbit owns `acme-foundation`. Galeri B.V. may run, change and fork it for its own internal use, but not resell,
sublicense or offer it to others. It comes as is, with no warranty or support obligation from mmbit. The board is
Galeri's CTO, so someone else at Galeri should sign the arrangement off.
