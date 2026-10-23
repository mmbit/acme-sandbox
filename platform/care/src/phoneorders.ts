// The orders the phone may tell of, from the stalls' `view`, each at the level a check opened: the postcode's
// (status only) or the code's (what's in it too). Read for order_status on a call and for an email answer after it.
import { withOrders, phoneStalls } from './config.ts';
import { now } from './db.ts';
import * as apps from './apps.ts';
import { settings, nameOf } from './company.ts';

// status: the postcode's (where it stands, its dates, carrier, whether there's tracking, the delivery rule); full: the
// code's, which adds what's in it, the price and the street and town it goes to
export type Level = 'status' | 'full';
export type Found = { items: ReturnType<typeof phoneOrder>[]; unsure: boolean };

// The orders a stall's number names, and those of the shop's other stalls under the same `number`: a basket's, the same
// payment's, which one check stands for. Each is given as it stands. null: the stall didn't answer
export async function ordersOf(shop: string, app: string, order: string, level: Level): Promise<Found | null> {
  const own = await viewsOf(app, order);
  return own?.length ? withBasket(shop, app, order, own, level) : null;
}

// The orders a number names at whichever of the shop's stalls has it, for an email answer: 'none' when every stall said
// it isn't theirs, null when one couldn't be asked and none had it
export async function findOrders(
  shop: string,
  order: string,
  level: Level,
): Promise<(Found & { app: string }) | 'none' | null> {
  let away = false;
  for (const app of phoneStalls(shop)) {
    const own = await viewsOf(app, order);
    if (own === null) away = true;
    if (own?.length) return { app, ...(await withBasket(shop, app, order, own, level)) };
  }
  return away ? null : 'none';
}

async function withBasket(shop: string, app: string, order: string, own: any[], level: Level): Promise<Found> {
  const others = own.some(v => v.number === order)
    ? await Promise.all(
        withOrders(app.endsWith('@preview') ? `${shop}@preview` : shop)
          .filter(other => other !== app)
          .map(async other => ({
            app: other,
            views: (await viewsOf(other, order))?.filter(v => v.number === order) ?? null,
          })),
      )
    : [];
  const items = [{ app, views: own }, ...others].flatMap(s =>
    (s.views ?? []).map(v => phoneOrder(s.app, order, v, level)),
  );
  // a stall that didn't answer may hold more of the basket
  return { items, unsure: others.some(s => s.views === null) };
}

// The orders an app's `view` gives for the number, or null when it didn't answer
async function viewsOf(app: string, order: string): Promise<any[] | null> {
  const r = await apps.call(app, 'view', { order });
  if (!r) return null;
  return (r.match === true ? (Array.isArray(r.orders) ? r.orders : [r.order]) : []).filter(
    (v: unknown) => v && typeof v === 'object',
  );
}

// One order of a stall's as the phone may tell it, with the plug-in's delivery rule. Never the name, postcode or email
// on it, nor what's printed on it: what it is is the view's `product`, never the chat's `title`
function phoneOrder(app: string, number: string, v: any, level: Level) {
  const status = {
    order: number,
    from: nameOf(app),
    status: v.status ?? null,
    placed_at: v.placed_at ?? null,
    ship_by: v.ship_by ?? null,
    shipped_at: v.shipped_at ?? null,
    delivered_at: v.delivered_at ?? null,
    carrier: v.carrier ?? null,
    tracking: !!v.tracking_url,
  };
  const full = {
    product: v.product ?? null,
    // how many of it, all in total_cents
    quantity: v.quantity ?? 1,
    total_cents: v.total_cents ?? null,
    // the street and town (the stall's address_masked)
    address: v.address_masked ?? null,
    country: v.country ?? null,
  };
  const delivery = settings.deliveryStatus?.({ ...v, app }, now());
  return { order: level === 'full' ? { ...status, ...full } : status, ...(delivery ? { delivery } : {}) };
}
