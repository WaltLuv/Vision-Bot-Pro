import {describe, expect, it} from 'vitest';
import type {Fulfillment, Material, Offer, SupplierReport} from '../src/api';
import {fulfillmentLabel, MATCH_LABEL, money, offerTotal, supplierSummary} from '../src/store';
import {materialSection} from '../src/ui/offers';

const offer = (over: Partial<Offer> = {}): Offer => ({
  id: 'o1', supplierId: 'home_depot', supplier: 'The Home Depot', method: 'partner_api',
  sku: 'HD-1', product: 'M6 bolt 20-pack', url: 'https://homedepot.example.test/p/HD-1',
  specification: '', quantity: 2, unitPrice: 8.47, currency: 'USD',
  shipping: 5.99, tax: 1.35, fees: 0, inventory: 42, availability: 'In stock',
  pickup: {available: true, eta: 'Ready today', location: 'Store #1234'},
  delivery: {available: true, eta: 'Tue, 3 Jun', location: ''},
  observedAt: new Date().toISOString(), matchQuality: 'exact', confidence: 0.9, ...over,
});
const report = (over: Partial<SupplierReport> = {}): SupplierReport =>
  ({id: 'home_depot', name: 'The Home Depot', method: 'partner_api', status: 'ok', offers: 1, checkedAt: new Date().toISOString(), ...over});

describe('offer totals', () => {
  it('adds up every component the supplier quoted', () => {
    expect(offerTotal(offer())).toEqual({subtotal: 16.94, total: 24.28});
  });

  // Adding up what we happen to know and calling it "total" is how someone ends
  // up comparing a shipped price against an unshipped one.
  it.each(['shipping', 'tax', 'fees'] as const)('refuses to state a total when %s is not quoted', field => {
    const result = offerTotal(offer({[field]: null}));
    expect(result.total).toBeNull();
    expect(result.subtotal).toBe(16.94);
  });

  it('multiplies by quantity rather than quoting a unit price as the total', () => {
    expect(offerTotal(offer({quantity: 5, shipping: 0, tax: 0, fees: 0})).total).toBe(42.35);
  });
});

describe('fulfillment', () => {
  // "We did not say" and "no" must not read alike; only one of them means a
  // person should stop looking for a pickup option.
  it('separates a channel the supplier did not report from one it declined', () => {
    expect(fulfillmentLabel({available: null, eta: '', location: ''}, 'Pickup')).toBe('Pickup: not reported');
    expect(fulfillmentLabel({available: false, eta: '', location: ''}, 'Pickup')).toBe('Pickup: not available');
    expect(fulfillmentLabel(undefined as unknown as Fulfillment, 'Delivery')).toBe('Delivery: not reported');
  });

  it('states where and when when the supplier said so', () => {
    expect(fulfillmentLabel({available: true, eta: 'Ready today', location: 'Store #1234'}, 'Pickup'))
      .toBe('Pickup · Store #1234 · Ready today');
  });
});

describe('supplier summary', () => {
  it('counts who answered and keeps the most recent check time', () => {
    const s = supplierSummary([
      report({id: 'home_depot', checkedAt: '2026-09-12T10:00:00.000Z'}),
      report({id: 'walmart', name: 'Walmart', checkedAt: '2026-09-12T10:05:00.000Z'}),
    ]);
    expect(s).toMatchObject({total: 2, answered: 2, complete: true});
    expect(s.checkedAt).toBe('2026-09-12T10:05:00.000Z');
  });

  it('names who is missing, so a short list is not mistaken for a complete one', () => {
    const s = supplierSummary([report(), report({id: 'lowes', name: "Lowe's", status: 'failed', offers: 0})]);
    expect(s.complete).toBe(false);
    expect(s.missing.map(m => m.name)).toEqual(["Lowe's"]);
  });

  it('treats a search with no suppliers at all as incomplete', () => {
    expect(supplierSummary([]).complete).toBe(false);
    expect(supplierSummary(undefined).total).toBe(0);
  });
});

describe('the rendered comparison', () => {
  const material = (over: Partial<Material> = {}): Material =>
    ({id: 'm1', description: 'M6 bolts', specification: '20-pack stainless', quantity: 2, currency: 'USD', ...over});

  it('says how many suppliers answered and names the ones that did not', () => {
    const node = materialSection(material({suppliers: [report(), report({id: 'lowes', name: "Lowe's", status: 'failed'})]}), [offer()]);
    const text = node.textContent ?? '';
    expect(text).toContain('1 of 2 suppliers answered');
    expect(text).toContain("Lowe's");
    expect(text).toMatch(/There may be better prices than these/);
  });

  it('does not warn when every supplier answered', () => {
    const node = materialSection(material({suppliers: [report()]}), [offer()]);
    expect(node.textContent).not.toMatch(/There may be better prices/);
  });

  it('shows a total when one is known and explains its absence when not', () => {
    expect(materialSection(material(), [offer()]).textContent).toContain('$24.28');
    const unknown = materialSection(material(), [offer({shipping: null})]).textContent ?? '';
    expect(unknown).toMatch(/Total not known/);
    expect(unknown).toContain('shipping');
    expect(unknown).not.toContain('$24.28');
  });

  it('flags a weak match rather than presenting it as the item asked for', () => {
    const node = materialSection(material(), [offer({matchQuality: 'candidate'})]);
    expect(node.textContent).toContain(MATCH_LABEL.candidate);
  });

  it('ranks an exact match above a cheaper uncertain one', () => {
    const node = materialSection(material(), [
      offer({id: 'cheap', supplier: 'Walmart', unitPrice: 1, matchQuality: 'candidate'}),
      offer({id: 'right', supplier: 'The Home Depot', matchQuality: 'exact'}),
    ]);
    const suppliers = [...node.querySelectorAll('.offer .supplier')].map(n => n.textContent);
    expect(suppliers).toEqual(['The Home Depot', 'Walmart']);
  });

  it('puts the lowest price first when no total is known, and a known total before an unknown one', () => {
    const unknown = {shipping: null, tax: null, fees: null, matchQuality: 'candidate' as const, method: 'web_search' as const};
    const node = materialSection(material(), [
      offer({id: 'a', supplier: 'Lowe\'s B', unitPrice: 31.47, ...unknown}),
      offer({id: 'b', supplier: 'Amazon', unitPrice: 24.97, ...unknown}),
      offer({id: 'c', supplier: 'Lowe\'s', unitPrice: 27.48, ...unknown}),
      offer({id: 'd', supplier: 'Riverside', unitPrice: 30, matchQuality: 'candidate'}),
    ]);
    expect([...node.querySelectorAll('.offer .supplier')].map(n => n.textContent)).toEqual(['Riverside', 'Amazon', "Lowe's", "Lowe's B"]);
  });

  it('says where to confirm and buy a price found on a store\'s website', () => {
    const text = materialSection(material(), [offer({method: 'web_search', supplier: "Lowe's", quantity: 1, shipping: null, tax: null, fees: null, pickup: {available: null, eta: '', location: ''}, delivery: {available: null, eta: '', location: ''}})]).textContent ?? '';
    expect(text).toContain("Found by web search on the store's own page. Confirm the price there, and buy it there: its checkout shows shipping and tax.");
    expect(text).not.toContain('A supplier quote confirms it');
    expect(text).not.toContain("Lowe's's");
    // Just the price the page showed: no column of things the page did not say, and never a made-up total.
    expect(text).not.toMatch(/not quoted|not reported|Total not known/);
    expect(text).toContain('1 × $8.47');
  });

  it('still shows what a store\'s page did say about shipping and pickup', () => {
    const text = materialSection(material(), [offer({method: 'browser', shipping: 0, tax: null, fees: null, pickup: {available: true, eta: 'Today', location: 'Main St.'}})]).textContent ?? '';
    expect(text).toContain('Shipping');
    expect(text).toContain('Pickup · Main St. · Today');
    expect(text).not.toMatch(/Delivery: not reported/);
  });

  // Supplier-supplied text is untrusted like any other external content.
  it('renders supplier text as text, never as markup', () => {
    const node = materialSection(material(), [offer({product: '<img src=x onerror=alert(1)>Bolt'})]);
    expect(node.querySelector('img')).toBeNull();
    expect(node.textContent).toContain('<img src=x onerror=alert(1)>Bolt');
  });

  it('links out to the supplier without handing it the referrer or window', () => {
    const link = materialSection(material(), [offer()]).querySelector('a');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link?.getAttribute('target')).toBe('_blank');
  });
});

describe('money', () => {
  it('formats in the offer currency', () => {
    expect(money(24.28, 'USD')).toMatch(/24\.28/);
    expect(money(24.28, 'NOTACURRENCY')).toBe('24.28 NOTACURRENCY');
  });
});
