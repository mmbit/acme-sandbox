// The model's tool calls in one conversation, for the helper's eval against a deployed host (eval/README.md, "Against a host"):
// kept only on a local run and on a preview shop ('x@preview'), never for a live shop's customers. Each call:
// its name, its input cut to what the eval's checks read (an order number, the email check_order took, a reason, a case;
// never a note, a question, a code or a reply address), the session's grant level as it streamed in, and how it came
// out (the result's yes/no fields, never its data). The page in the conversation reads it back ('tools' in server.ts).
import { db, now } from './db.ts';
import { LOCAL } from './config.ts';
import { settings } from './company.ts';

// by the conversation's shop, and order_status's app
export const kept = (shop: string) => LOCAL || shop.endsWith('@preview');
const FIELDS: Record<string, string[]> = { check_order: ['order', 'email'], order_status: ['order', 'show_tracking', 'app'], my_orders: ['show'],
  ask_for_person: ['reason'] };
const WORDS = ['why', 'shown', 'error']; // the server's own words in a result, kept beside its yes/no fields

// a call as it streamed in: its row id, or null where nothing is kept
export function call(conv: { id: number; shop: string }, name: string, input: any, level: number) {
  if (!kept(conv.shop)) return null;
  const cut = Object.fromEntries((FIELDS[name] ?? settings.tools.find(x => x.def.name === name)?.log ?? []).filter(k => input?.[k] != null).map(k => [k, typeof input[k] === 'boolean' ? input[k] : String(input[k]).slice(0, 200)]));
  try { return Number(db.prepare('insert into tool_log (conversation, at, name, input, level) values (?, ?, ?, ?, ?)')
    .run(conv.id, now(), String(name).slice(0, 40), JSON.stringify(cut), level).lastInsertRowid); }
  catch { return null; } // a log never stops an answer (the conversation deleted mid-draft: its foreign key fails)
}
// how it came out: the tool's result (JSON), or 'not run' (an earlier call in the batch ended the answer)
export function result(id: number | null, content: string | 'not run') {
  if (id == null) return;
  let status: any = content;
  if (content !== 'not run') {
    let r: any = null; try { r = JSON.parse(content); } catch { /* not JSON: nothing kept */ }
    status = Object.fromEntries(Object.entries(r && typeof r === 'object' ? r : {})
      .filter(([k, v]) => typeof v === 'boolean' || (WORDS.includes(k) && typeof v === 'string')).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 120) : v]));
  }
  try { db.prepare('update tool_log set result = ? where id = ?').run(JSON.stringify(status), id); } catch { /* as above */ }
}
// result null: the draft was cut before the tool ran (a follow-up, a provider failure)
export const list = (conversation: number) => (db.prepare('select at, name, input, level, result from tool_log where conversation = ? order by id').all(conversation) as any[])
  .map(r => ({ at: r.at, name: r.name, input: JSON.parse(r.input), level: r.level, result: r.result == null ? null : JSON.parse(r.result) }));
