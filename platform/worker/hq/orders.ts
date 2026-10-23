// Our live Print API orders as HQ last read them (the coordinator's orders.ts): one block each, or the route's JSON.
// Print API's times are Dutch time, HQ's UTC. No customer data: no addresses, names or text.
import { getUnlessRefused, orStop } from './api.ts';
import { euro, minute, plural, present, print, round, stop, text } from './output.ts';

export const orders = {
  help: `
   hq orders [YYYY-MM-DD | all] [--json]             our live Print API orders as HQ last read them (every hour): each
                                                     order's products, Print API status with its times, cancellation, the
                                                     invoice as placed, whether Print API bills it, and what HQ's own records
                                                     say. Placed since the date (Dutch time), the last 90 days by default.
                                                     No customer data: no addresses, names or text (their own reasons).
                                                     An order's id opens it on a product's site: only org.yaml's
                                                     roles.orders read them, and the job then holds customer data.`,

  async run(args: string[]) {
    let since = '';
    let asJson = false;
    for (const arg of args) {
      if (arg === '--json') asJson = true;
      else if (arg === 'all' || /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(arg)) since = arg;
      else stop('usage: hq orders [YYYY-MM-DD | all] [--json]');
    }
    const route = since ? `orders?since=${since}` : 'orders';
    const answer = await orStop(getUnlessRefused(route), "Couldn't read the orders from HQ.");
    if (asJson) return print(answer.replace(/\n+$/, ''));
    print(...ordersReport(JSON.parse(answer)));
  },
};

type Tax = { amount?: number | null; rate?: number | null };
type InvoicePart = { cost?: number | null; taxes: Tax[] };
type Order = {
  id: string;
  placed?: string;
  shop?: string;
  items: { productId?: string; quantity?: number; pageCount?: number; options?: { id?: string; value?: string }[] }[];
  status: string;
  history: { status: string; at?: string }[];
  cancellation?: { status?: string; accepted?: { at?: string; from: string } };
  shipping?: string;
  productionSpeed?: string;
  invoice?: Record<string, InvoicePart | null>;
  invoicingState?: string;
  ours: { from?: string; status: string; amount?: number };
  reprintOf?: string;
  firstSeen?: string;
  lastChecked?: string;
};
type OrdersRead = { keys?: unknown; synced?: string; error?: string; since: string; orders: Order[] };

const at = (time: string | null | undefined) => (time === null || time === undefined ? '?' : minute(time));

function ordersReport({ keys, synced, error, since, orders }: OrdersRead) {
  const placed = orders ?? [];
  if (!present(keys)) return ['No live Print API keys yet: no live orders to list.'];
  const lines = [
    present(synced)
      ? `HQ last read Print API at ${at(synced)} UTC (it reads every hour).`
      : "HQ hasn't read Print API yet (it does within the hour after the live keys are in).",
  ];
  if (present(error)) lines.push(`Last failure: ${text(error)}.`);
  if (placed.length === 0) {
    lines.push(`No orders placed since ${text(since)}.`);
  } else {
    const when = since === 'all' ? 'ever' : `since ${text(since)}`;
    lines.push(`${plural(placed.length, 'order')} placed ${when}, newest first. Print API's times are Dutch time.\n`);
  }
  for (const order of placed) lines.push(...orderBlock(order));
  return lines;
}

function orderBlock(order: Order) {
  const lines = [
    `${text(order.id)}  placed ${at(order.placed)}  shop: ${text(order.shop ?? 'unknown')}`,
    `  items: ${order.items.map(itemText).join(', ')}`,
    `  Print API: ${text(order.status)}${statusHistory(order.history)}`,
    `  cancellation: ${cancellation(order.cancellation)}`,
    `  shipping: ${text(order.shipping ?? '?')}, ${text(order.productionSpeed ?? '?')}`,
    `  invoice (as placed): ${present(order.invoice) ? invoiceParts(order.invoice) : 'none'}`,
    `  invoicing: ${text(order.invoicingState ?? '?')}`,
    `  ours: ${ours(order.ours)}`,
  ];
  if (present(order.reprintOf)) lines.push(`  reprint of: ${text(order.reprintOf)}`);
  lines.push(`  HQ first saw it ${at(order.firstSeen)} UTC, last checked ${at(order.lastChecked)} UTC`, '');
  return lines;
}

function itemText({ productId, quantity, pageCount, options }: Order['items'][number]) {
  const pages = (pageCount ?? 1) > 1 ? ` (${pageCount} pages)` : '';
  const chosen = present(options)
    ? ` [${options!.map(option => `${text(option.id ?? '?')}=${text(option.value ?? '?')}`).join(', ')}]`
    : '';
  return `${text(productId ?? '?')} ×${text(quantity ?? '?')}${pages}${chosen}`;
}

function statusHistory(history: Order['history']) {
  if ((history ?? []).length === 0) {
    return '  (no status history: HQ first read it more than a week after its last change)';
  }
  return `  (${history.map(step => `${text(step.status)} ${at(step.at)}`).join(' → ')})`;
}

function cancellation(cancelling: Order['cancellation']) {
  const accepted = cancelling?.accepted;
  const when = present(accepted) ? ` at ${at(accepted.at)} (${text(accepted.from)})` : '';
  return `${text(cancelling?.status ?? '?')}${when}`;
}

// Each part of the invoice with a cost (the total always), its VAT and its sum
function invoiceParts(invoice: Record<string, InvoicePart | null>) {
  const parts = ['production', 'shipping', 'handling', 'discount', 'total'].flatMap(name => {
    const part = invoice[name];
    if (part === null || part === undefined || (name !== 'total' && (part.cost ?? 0) === 0)) return [];
    const taxes = part.taxes.map(
      tax =>
        ` + VAT ${euro(tax.amount)} (${tax.rate === null || tax.rate === undefined ? '?' : round(tax.rate * 100)}%)`,
    );
    const sum = (part.cost ?? 0) + part.taxes.reduce((total, tax) => total + (tax.amount ?? 0), 0);
    return [`${name} ${euro(part.cost)}${taxes.join('')} = ${euro(sum)}`];
  });
  return parts.join('; ');
}

function ours({ from, status, amount }: Order['ours']) {
  if (from === 'payment') return `HQ payment ${text(status)}, ${euro(amount)}`;
  if (present(from)) return `${text(from)}: ${text(status)}${present(amount) ? `, ${euro(amount)}` : ''}`;
  return status;
}
