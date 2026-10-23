// Content-free counters over native worker events.
import {
  classify,
  type Labels,
  type Lookup,
  type Source,
  type Command,
  type Activity,
  type Category,
  type UnknownReason,
  type Diagnostic,
} from './calls.ts';

export type Count = {
  calls: number;
  failed: number;
  completed: number;
  milliseconds: number;
  untilNextMilliseconds: number;
};
export type Metrics = {
  version: 4;
  complete: boolean;
  resumed: boolean;
  calls: number;
  completed: number;
  failed: number;
  milliseconds: number;
  unknownReasons: Partial<Record<UnknownReason, Count>>;
  diagnostics: Partial<Record<Diagnostic, Count>>;
  firstCall: Labels | null;
  startupBoundary: Labels | null;
  unknown: number;
  pending: number;
  startupCalls: number;
  startupMilliseconds: number | null;
  firstToolMilliseconds: number | null;
  startup: Partial<Record<Lookup, Count>>;
  lookups: Partial<Record<Lookup, Count>>;
  sources: Partial<Record<Source, Count>>;
  commands: Partial<Record<Command, Count>>;
  activities: Partial<Record<Activity, Count>>;
};
type Pending = { at: number; labels: Labels; startup: boolean };

export const measurement = (started: number, complete = true) => new Measurement(started, complete);

// A measurement lives for one worker run. Replay after takeover is explicitly incomplete.
class Measurement {
  started: number;
  metrics: Metrics;
  pending = new Map<string, Pending>();
  seen = new Set<string>();
  boundary = false;
  resumed = false;
  previous: Pending | undefined;

  constructor(started: number, complete: boolean) {
    this.started = started;
    this.metrics = initialMetrics(complete);
  }

  observe(event: any, at = Date.now()) {
    if (event.parent_tool_use_id) return;
    if (event.type === 'assistant')
      for (const block of event.message?.content ?? [])
        if (block.type === 'tool_use') this.begin(block.id, block.name, block.input, at);
    if (event.type === 'user')
      for (const block of event.message?.content ?? [])
        if (block.type === 'tool_result') this.end(block.tool_use_id, block.is_error === true, at);
    if (event.item) this.observeCodex(event, at);
  }

  snapshot(): Metrics {
    return structuredClone({ ...this.metrics, resumed: this.resumed, pending: this.pending.size });
  }

  private observeCodex(event: any, at: number) {
    const item = event.item;
    if (['agent_message', 'reasoning', 'todo_list', 'error'].includes(item.type)) return;
    if (!['item.started', 'item.updated', 'item.completed'].includes(event.type)) return;
    const names: Record<string, string> = {
      command_execution: 'Bash',
      file_change: 'Edit',
      web_search: 'WebSearch',
      mcp_tool_call: 'CodexMCP',
    };
    const name = names[item.type] ?? 'CodexTool';
    const input = item.type === 'command_execution' ? { command: item.command } : {};
    this.begin(item.id, name, input, at);
    if (event.type !== 'item.completed') return;
    const exitFailed = typeof item.exit_code === 'number' ? item.exit_code !== 0 : null;
    const statusFailed = item.status === 'failed' ? true : item.status === 'completed' ? false : null;
    const failed = item.type === 'command_execution' ? exitFailed : statusFailed;
    this.end(item.id, failed, at);
  }

  private begin(id: string, name: string, input: any, at: number) {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.closeInterval(at);
    const labels = classify(name, input),
      metrics = this.metrics;
    metrics.calls++;
    metrics.firstCall ??= labels;
    metrics.firstToolMilliseconds ??= Math.max(0, at - this.started);
    if (labels.unknownReasons.length) metrics.unknown++;
    if (!this.boundary && labels.boundary) {
      this.boundary = true;
      metrics.startupBoundary = labels;
      metrics.startupMilliseconds = Math.max(0, at - this.started - metrics.firstToolMilliseconds);
    }
    if (!this.boundary && labels.lookups.length) metrics.startupCalls++;
    const startup = !this.boundary;
    this.previous = { at, labels, startup };
    this.pending.set(id, this.previous);
    this.each(labels, startup, (counts, key) => {
      (counts[key] ??= count()).calls++;
    });
  }

  private closeInterval(at: number) {
    if (!this.previous) return;
    const previous = this.previous;
    this.each(previous.labels, previous.startup, (counts, key) => {
      counts[key]!.untilNextMilliseconds += Math.max(0, at - previous.at);
    });
  }

  private end(id: string, failed: boolean | null, at: number) {
    const call = this.pending.get(id);
    if (!call) return;
    if (failed !== null) {
      this.metrics.completed++;
      this.metrics.failed += Number(failed);
      this.metrics.milliseconds += Math.max(0, at - call.at);
      this.each(call.labels, call.startup, (counts, key) => {
        counts[key]!.completed++;
        counts[key]!.failed += Number(failed);
        counts[key]!.milliseconds += Math.max(0, at - call.at);
      });
    }
    this.pending.delete(id);
  }

  private each(
    labels: Labels,
    startup: boolean,
    visit: (counts: Partial<Record<Category, Count>>, key: Category) => void,
  ) {
    for (const key of new Set(labels.unknownReasons)) visit(this.metrics.unknownReasons, key);
    for (const key of new Set(labels.diagnostics)) visit(this.metrics.diagnostics, key);
    if (startup) for (const key of new Set(labels.lookups)) visit(this.metrics.startup, key);
    for (const group of ['lookups', 'sources', 'commands', 'activities'] as const)
      for (const key of new Set<Category>(labels[group])) visit(this.metrics[group], key);
  }
}

function initialMetrics(complete: boolean): Metrics {
  return {
    version: 4,
    complete,
    resumed: false,
    calls: 0,
    completed: 0,
    failed: 0,
    milliseconds: 0,
    unknownReasons: {},
    diagnostics: {},
    firstCall: null,
    startupBoundary: null,
    unknown: 0,
    pending: 0,
    startupCalls: 0,
    startupMilliseconds: null,
    firstToolMilliseconds: null,
    startup: {},
    lookups: {},
    sources: {},
    commands: {},
    activities: {},
  };
}

const count = (): Count => ({ calls: 0, failed: 0, completed: 0, milliseconds: 0, untilNextMilliseconds: 0 });
