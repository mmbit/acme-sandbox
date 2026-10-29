// Each agent's model as the board picks it on the agent's page in HQ: its main model, and one optional fallback its work
// moves to while the main model's seats are out or short.
import { db } from './db.ts';
import { org, roles, yamlFile } from './company.ts';
import { listProviders, listSeats } from './seats.ts';

// A model the board can pick: its id as its CLI asks for it, its plain name, and the provider whose seats run it. A seat
// runs it when it takes that provider's engine's work on that provider's CLI (`runner`).
export type Choice = { id: string; name: string; provider: string; engine: string; cli: string };
type AgentPick = { main: Choice | null; fallback: Choice | null };
type FileAgent = {
  id: string;
  name?: string;
  engine?: string;
  model?: string;
  effort?: string;
  autocompact?: unknown;
  temp?: boolean;
};

const MODEL = /^[\w.:/@-]{1,100}$/;
// The engines seats run: work for an agent on any other (org.yaml's `engine: api`) is refused (jobs.ts noSeat).
export const SEAT_ENGINES = ['claude', 'codex'];
export const runner = (c: { engine: string; cli?: string | null }) => `${c.engine}:${c.cli ?? c.engine}`;

// The company's list: company/models.yaml `choices`, each provider's models by id with their plain names. A provider
// that isn't one of the seats' (seats.ts listProviders) is left out.
export function listChoices(): Choice[] {
  const listed = yamlFile('company/models.yaml').choices;
  if (!listed || typeof listed !== 'object') return [];
  const providers = listProviders();
  return Object.entries(listed as Record<string, unknown>).flatMap(([provider, models]) => {
    const p = providers.find(x => x.id === provider);
    if (!p || !models || typeof models !== 'object') return [];
    return Object.entries(models as Record<string, unknown>)
      .filter(([id, name]) => MODEL.test(id) && typeof name === 'string')
      .map(([id, name]) => ({ id, name: String(name), provider, engine: p.engine, cli: p.cli }));
  });
}

// HQ's agent pages: the models on the list (`seated`: a seat of the board's runs it) and each agent's main model and
// fallback as they stand, the files' model where the board picked none (`picked` false). `engine`: the one engine its main model must stay
// on, a reviewer's (panelEngine), else null.
export function listAgentModels() {
  const choices = listChoices(),
    files = yamlFile('company/models.yaml'),
    seats = listSeats() as { engine: string; cli?: string | null; removing?: boolean }[],
    seated = new Set(seats.filter(s => !s.removing).map(runner));
  const picks = loadPicks(choices);
  const models = Object.fromEntries(
    fileAgents()
      .filter(a => !a.temp && SEAT_ENGINES.includes(String(a.engine)))
      .map(a => {
        const own = asPicked(a, picks);
        const main = own.model ?? files[own.engine!]?.model ?? null;
        // (picked: the board's own main model, which alone has a CLI: asPicked)
        return [a.id, { main, picked: own.cli !== null, fallback: own.fallback?.id ?? null, engine: panelEngine(a) }];
      }),
  );
  return { choices: choices.map(c => ({ ...c, seated: seated.has(runner(c)) })), models };
}

// The board's pick for an agent. The main model must be on the list; the fallback may be none, and runs on other seats
// than the main model. Queued work that hasn't started goes with a new main model; running work finishes where it is.
export function setAgentModels(id: string, main: unknown, fallback: unknown) {
  const agent = fileAgents().find(a => a.id === id);
  if (!agent || agent.temp || !SEAT_ENGINES.includes(String(agent.engine))) return "There's no such agent.";
  const choices = listChoices();
  const choiceOf = (modelId: unknown) =>
    modelId == null || modelId === '' ? null : choices.find(c => c.id === modelId);
  const mainPick = choiceOf(main),
    fallbackPick = choiceOf(fallback);
  if (mainPick === undefined || fallbackPick === undefined) return "That model isn't on the list.";
  const keep = panelEngine(agent);
  if (mainPick && keep && mainPick.engine !== keep)
    return `${agent.name ?? agent.id} is one of the review panel's ${engineName(keep)} reviewers: its main model stays a ${engineName(keep)} one, so the panel keeps its mix.`;
  const engine = mainPick?.engine ?? String(agent.engine),
    cli = mainPick?.cli ?? null;
  if (fallbackPick && runner(fallbackPick) === runner({ engine, cli }))
    return 'Pick a fallback at another provider: this one runs on the same seats.';
  if (!mainPick && !fallbackPick) db.prepare('delete from agent_models where agent = ?').run(agent.id);
  else
    db.prepare(
      'insert into agent_models (agent, main, fallback, at) values (?, ?, ?, ?) on conflict(agent) do update set main = excluded.main, fallback = excluded.fallback, at = excluded.at',
    ).run(agent.id, mainPick?.id ?? null, fallbackPick?.id ?? null, new Date().toISOString());
  // (a Codex job's seat is chosen for its own CLI: on another, the claim chooses again)
  db.prepare(
    `update jobs set engine = ?, cli = ?, for_seat = null where agent = ? and status = 'queued' and kind = 'work'
      and started is null and engine in ('claude', 'codex') and engine_only is null and (engine != ? or cli is not ?)`,
  ).run(engine, cli, agent.id, engine, cli);
  return { ok: true };
}

// An agent of org.yaml as it runs: the board's main model decides its engine, CLI and model, and an effort or
// auto-compact window the files set for another engine gives way to that engine's own. Its fallback rides along.
export function asPicked<A extends FileAgent>(agent: A, picks = loadPicks()) {
  const { main, fallback } = picks.get(agent.id) ?? { main: null, fallback: null };
  const keep = panelEngine(agent);
  if (!main || (keep && main.engine !== keep)) return { ...agent, cli: null, fallback };
  const same = main.engine === agent.engine;
  return {
    ...agent,
    engine: main.engine,
    cli: main.cli,
    model: main.id,
    effort: same ? agent.effort : undefined,
    autocompact: same ? agent.autocompact : undefined,
    fallback,
  };
}

// HQ's org chart: each agent on the engine it runs on now
export function withPicks<O extends { departments?: { agents?: FileAgent[] }[] }>(chart: O) {
  const picks = loadPicks();
  for (const d of chart.departments ?? []) d.agents = d.agents?.map(a => ({ ...a, engine: asPicked(a, picks).engine }));
  return chart;
}

// The agents whose fallback runs on a seat of this engine and CLI (jobs.ts claim)
export function fallingBackTo(engine: string, cli: string) {
  return [...loadPicks()]
    .filter(([, p]) => p.fallback && runner(p.fallback) === runner({ engine, cli }))
    .map(([a]) => a);
}

// A reviewer's main model stays on its org.yaml engine: review.ts makes the panel's Claude/Codex mix from its reviewers'
// engines (AUTHORITY's 2 Claude + 2 Codex on high-risk changes), and a pick on another engine would change it. A pick
// made before the agent became a reviewer counts as none. Its fallback is free: reviews never fall back.
const panelEngine = (a: FileAgent) => (roles().reviewers.includes(a.id) ? String(a.engine) : null);
const engineName = (engine: string) => engine.charAt(0).toUpperCase() + engine.slice(1);

const fileAgents = () => ((org().departments ?? []) as { agents?: FileAgent[] }[]).flatMap(d => d.agents ?? []);

// Every pick, with its models looked up: a model no longer on the list counts as none picked
function loadPicks(choices = listChoices()) {
  const rows = db.prepare('select agent, main, fallback from agent_models').all() as {
    agent: string;
    main: string | null;
    fallback: string | null;
  }[];
  const find = (id: string | null) => choices.find(c => c.id === id) ?? null;
  return new Map<string, AgentPick>(rows.map(r => [r.agent, { main: find(r.main), fallback: find(r.fallback) }]));
}

// A lighter model for a small, fully specified job (hq job --model), which its queuer judges from the job's scope as it
// judges its size: one the company lists as lighter for the engine (models.yaml's `lighter` under it), on the seats of
// the engine's own model, by its id, its name or its name's first word (sonnet). A run that finds the work bigger than it
// looked hands it up to the agent's own model in a new session (jobs.ts handUp). An engine with no list takes no
// --model, and an agent on another model than its engine's own (a lighter worker already, or the board's pick) takes
// none. The choice, or why not in the queuer's words.
export function lighterChoice(id: string, asked: string): Choice | string {
  const own = fileAgents().find(a => a.id === id);
  if (!own) return `there's no agent ${id} to queue it for`;
  const a = asPicked(own),
    engine = String(a.engine),
    name = own.name ?? id;
  const main = engineModel(engine),
    lighter = lighterChoices(engine);
  if (!lighter.length)
    return `--model takes a lighter model models.yaml lists for ${name}'s engine, and ${engine} lists none`;
  if ((a.model ?? main) !== main)
    return `${name} runs on ${choiceName(a.model ?? '')} already, not ${engine}'s own model: queue it without --model`;
  const word = asked.trim().toLowerCase();
  const said = (c: Choice) => [c.id, c.name, c.name.split(/\s+/)[0]].map(w => w.toLowerCase()).includes(word);
  const matching = lighter.filter(said);
  if (matching.length === 1) return matching[0];
  if (main && [main, choiceName(main), choiceName(main).split(/\s+/)[0]].some(w => w.toLowerCase() === word))
    return `${choiceName(main)} is ${name}'s own model: queue it without --model`;
  return `--model takes a lighter model models.yaml lists for ${engine}: ${lighter.map(c => `${c.id} (${c.name})`).join(', ')}`;
}
// The engine's own model and the lighter ones models.yaml lists for it, on the same seats, for the briefing's line on
// --model (jobs.ts claimed).
const engineModel = (engine: string): string | undefined => yamlFile('company/models.yaml')[engine]?.model;
export function lighterChoices(engine: string) {
  const file = yamlFile('company/models.yaml')[engine],
    on = listChoices().find(c => c.id === file?.model);
  const listed: string[] = file?.lighter ?? [];
  if (!on) return [];
  return listChoices().filter(c => listed.includes(c.id) && runner(c) === runner(on));
}
export const choiceName = (id: string) => listChoices().find(c => c.id === id)?.name ?? id;
