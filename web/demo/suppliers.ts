// The preview's suppliers: sample catalogs that answer a search the way the
// gateway's supplier registry does -- every connected supplier asked at once,
// normalized offers, suppliers that did not answer named, totals left unknown
// when a charge was not quoted, and a purchase only against an exact quote.
// Prices are made up from the item and a typical price; nothing here is a real
// listing, and the page says so.
import type {AccessMethod, Material, Offer, SupplierReport} from '../src/api';

export const SUPPLIERS: {id: string; name: string; method: AccessMethod; requires: string[]; connected: boolean}[] = [
  {id: 'amazon', name: 'Amazon', method: 'official_api', requires: ['AMAZON_API_KEY'], connected: true},
  {id: 'walmart', name: 'Walmart', method: 'official_api', requires: ['WALMART_API_KEY'], connected: true},
  {id: 'home_depot', name: 'The Home Depot', method: 'partner_api', requires: ['HOME_DEPOT_API_KEY'], connected: true},
  {id: 'lowes', name: "Lowe's", method: 'partner_api', requires: ['LOWES_API_KEY'], connected: true},
  {id: 'riverside_supply', name: 'Riverside Building Supply', method: 'partner_api', requires: ['RIVERSIDE_TOKEN'], connected: true},
  {id: 'pacific_fastener', name: 'Pacific Fastener Co.', method: 'partner_api', requires: ['PACIFIC_TOKEN'], connected: true},
  {id: 'northside_lumber', name: 'Northside Lumber', method: 'partner_api', requires: ['NORTHSIDE_TOKEN'], connected: false},
];

const TAX = 0.0725;
const cents = (n: number) => Math.round(n * 100) / 100;
const day = (ahead: number) => new Date(Date.now() + ahead * 86_400_000).toLocaleDateString('en-US', {weekday: 'long'});

/** A small deterministic generator, so the same search gives the same sample answer. */
function random(text: string) {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296;};
}

// How each sample catalog answers: its price level, charges, stock and how you get the item.
type Style = {factor: number; shipping: number | null; taxed: boolean; stock: [number | null, string]; pickup?: [string, string]; delivery: number; match?: Offer['matchQuality']; variant?: [string, string]};
const STYLES: Record<string, Style> = {
  riverside_supply: {factor: 0.95, shipping: 0, taxed: true, stock: [240, 'In stock'], pickup: ['Ready today', 'Riverside yard, 4 mi'], delivery: 2},
  pacific_fastener: {factor: 0.9, shipping: 12.5, taxed: true, stock: [1800, 'In stock'], delivery: 3},
  lowes: {factor: 1.06, shipping: 8.95, taxed: true, stock: [14, 'Low stock'], delivery: 4},
  home_depot: {factor: 1.14, shipping: 0, taxed: true, stock: [85, 'In stock'], pickup: ['Ready in 2 hours', 'Store #6142'], delivery: 3, match: 'candidate', variant: [', value pack', 'Pack size differs from what you asked for: check the count before buying']},
  walmart: {factor: 0.72, shipping: null, taxed: false, stock: [null, 'Available online'], delivery: 5, match: 'unverified', variant: [' assortment', 'Mixed sizes, not a single match']},
  amazon: {factor: 0.98, shipping: 0, taxed: true, stock: [null, 'In stock'], delivery: 2},
};

export interface Search {item: string; quantity: number; specification: string; typicalUnitPrice: number}

/** Ask every connected supplier for one item. One of them is always slow, as real ones are. */
export function compare(runId: string, search: Search): {material: Material; offers: Offer[]} {
  const now = new Date().toISOString();
  const rand = random(search.item.toLowerCase());
  const connected = SUPPLIERS.filter(s => s.connected);
  const slow = connected[Math.floor(rand() * connected.length)]!.id;
  const materialId = `material-${Date.now().toString(36)}`;
  const offers: Offer[] = [];
  const reports: SupplierReport[] = connected.map(s => {
    if (s.id === slow) return {id: s.id, name: s.name, method: s.method, status: 'timeout', offers: 0, checkedAt: now, detail: 'Did not answer in time'};
    const style = STYLES[s.id]!;
    const unitPrice = cents(Math.max(0.05, search.typicalUnitPrice * style.factor * (0.92 + rand() * 0.16)));
    const subtotal = cents(unitPrice * search.quantity);
    offers.push({
      id: `offer-${s.id}-${materialId}`, requestId: materialId, supplierId: s.id, supplier: s.name, method: s.method,
      sku: `${s.id.slice(0, 2).toUpperCase()}-${Math.floor(1000 + rand() * 9000)}`,
      product: `${search.item}${style.variant?.[0] ?? ''}`, specification: style.variant?.[1] ?? search.specification,
      url: 'https://example.com/', quantity: search.quantity, unitPrice, currency: 'USD',
      shipping: style.shipping, tax: style.taxed ? cents(subtotal * TAX) : null, fees: 0,
      inventory: style.stock[0], availability: style.stock[1],
      pickup: style.pickup ? {available: true, eta: style.pickup[0], location: style.pickup[1]} : {available: s.id === 'walmart' ? null : false, eta: '', location: ''},
      delivery: {available: true, eta: day(style.delivery), location: ''},
      observedAt: now, matchQuality: style.match ?? 'exact', confidence: style.match === 'unverified' ? 0.33 : style.match === 'candidate' ? 0.66 : 0.9,
    });
    return {id: s.id, name: s.name, method: s.method, status: 'ok', offers: 1, checkedAt: now};
  });
  const material: Material = {id: materialId, runId, description: search.quantity > 1 ? `${search.item}, ${search.quantity} off` : search.item,
    specification: search.specification, quantity: search.quantity, currency: 'USD', searchedAt: now, suppliers: reports};
  return {material, offers};
}

/** An offer's total when every charge is known, else null -- the same rule the app's comparison shows. */
export function offerTotal(o: Offer): number | null {
  if (o.shipping === null || o.tax === null || o.fees === null) return null;
  return cents(o.unitPrice * o.quantity + o.shipping + o.tax + o.fees);
}

/** The supplier's exact quote for one offer, in the purchase_order tool's own shape. */
export function quoteFor(o: Offer, quantity: number, wanted: 'pickup' | 'delivery') {
  const pickup = wanted === 'pickup' && o.pickup.available === true;
  const subtotal = cents(o.unitPrice * quantity);
  const delivery = pickup ? 0 : o.shipping ?? 9.95;
  const tax = cents(subtotal * TAX);
  return {
    supplier: o.supplier, quoteId: `Q-${o.sku}-${Math.floor(100 + Math.random() * 900)}`,
    items: [{sku: o.sku, name: o.product, quantity, unitPrice: o.unitPrice}],
    subtotal, tax, fees: 0, delivery, total: cents(subtotal + tax + delivery), currency: o.currency,
    fulfillment: pickup ? `Pickup at ${o.pickup.location} · ${o.pickup.eta.toLowerCase()}` : `Delivery · arrives ${o.delivery.eta || 'in a few days'}`,
    deliveryAddress: pickup ? o.pickup.location : 'Oakridge job site (sample address)',
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  };
}
export type Quote = ReturnType<typeof quoteFor>;

export const orderNumber = (q: Quote) => `${q.items[0]!.sku.split('-')[0]}-${Math.floor(10000 + Math.random() * 90000)}`;
