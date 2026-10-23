// A run's token use as the engine reports it: numbers and model names only, never text (Finance's seat economics).
// Each report is a running total for the whole session, so the last one of a run is what the worker sends; the
// coordinator (its usage.ts) stores what the run added since the job's previous report.
export type Tokens = { input: number; cacheWrite: number; cacheRead: number; output: number; cost?: number };
export type Usage = { models: Record<string, Tokens>; cost?: number };

// A token count or cost as reported, or 0 (exported for clis/)
export const count = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;

// `model` names Codex's model (its events don't); input is always the uncached part.
export function usageOf(e: any, model?: string | null): Usage | undefined {
  // Claude Code's result: tokens and API-equivalent price per model (team members included), and the total price.
  // Its input_tokens already leave out cache writes and reads.
  if (e?.type === 'result' && e.modelUsage && typeof e.modelUsage === 'object') return {
    models: Object.fromEntries(Object.entries(e.modelUsage).map(([m, u]: [string, any]) => [m, { input: count(u?.inputTokens),
      cacheWrite: count(u?.cacheCreationInputTokens), cacheRead: count(u?.cacheReadInputTokens), output: count(u?.outputTokens), cost: count(u?.costUSD) }])),
    cost: count(e.total_cost_usd) };
  // Codex's turn.completed: input_tokens include the cached ones.
  if (e?.type === 'turn.completed' && e.usage) {
    const u = e.usage, cached = count(u.cached_input_tokens);
    return { models: { [model || 'codex']: { input: Math.max(0, count(u.input_tokens) - cached), cacheWrite: count(u.cache_write_input_tokens),
      cacheRead: cached, output: count(u.output_tokens) } } };
  }
}

// Two sessions' running totals as one: a run that launched a second session (a reviewer asked whether its verdict
// stands, worker.ts).
export function sumUsage(first: Usage, second: Usage): Usage {
  const models = { ...first.models };
  for (const [model, tokens] of Object.entries(second.models)) {
    const earlier = models[model];
    models[model] = earlier ? sumTokens(earlier, tokens) : tokens;
  }
  return { models, cost: sumCost(first.cost, second.cost) };
}
function sumTokens(first: Tokens, second: Tokens): Tokens {
  const input = first.input + second.input, cacheWrite = first.cacheWrite + second.cacheWrite;
  const cacheRead = first.cacheRead + second.cacheRead, output = first.output + second.output;
  return { input, cacheWrite, cacheRead, output, cost: sumCost(first.cost, second.cost) };
}
// unknown only when neither knows it
const sumCost = (first?: number, second?: number) => first === undefined && second === undefined ? undefined : (first ?? 0) + (second ?? 0);
