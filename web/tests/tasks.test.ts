import {describe, expect, it, vi} from 'vitest';

vi.mock('../src/api', async importOriginal => ({...(await importOriginal<typeof import('../src/api')>()), api: {cancel: vi.fn(), resume: vi.fn(), reconcile: vi.fn(), artifactUrl: (id: string) => `/api/artifacts/${id}/content`}}));
const {tasks} = await import('../src/ui/tasks');
const {mount} = await import('../src/dom');
import type {Ctx} from '../src/ui/ctx';

// A purchase task shows the order it placed, not only a sentence about it.
function render(order: Record<string, unknown>) {
  document.body.innerHTML = '<div id="app"></div>';
  const ctx = {
    state: {run: [{id: 'r1', task: 'Order deck screws', status: 'completed', result: 'Ordered.'}], order: [{id: 'o1', runId: 'r1', ...order}],
      artifact: [], action: [], material: [], offer: []},
    toast() {}, refresh: async () => {}, go() {},
  } as unknown as Ctx;
  mount(document.getElementById('app')!, tasks(ctx));
  return document.getElementById('app')!;
}

describe('tasks: a placed order', () => {
  it('shows supplier, order number, total, status, fulfilment and the receipt', () => {
    const app = render({supplier: 'Riverside Building Supply', orderNumber: 'RBS-669737', total: 79.26, currency: 'USD', status: 'confirmed',
      fulfillment: 'Pickup at the Riverside yard, ready in 1 hour', receiptUrl: 'https://riverside.example.test/orders/Q-1'});
    expect(app.textContent).toContain('Order placed');
    expect(app.textContent).toContain('Riverside Building Supply · order RBS-669737');
    expect(app.textContent).toContain('$79.26 · confirmed · Pickup at the Riverside yard, ready in 1 hour');
    const receipt = [...app.querySelectorAll('a')].find(a => a.textContent === 'Receipt')!;
    expect(receipt.getAttribute('href')).toBe('https://riverside.example.test/orders/Q-1');
    expect(receipt.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('offers no link for a receipt address that is not https', () => {
    const app = render({supplier: 'Riverside', orderNumber: 'X1', total: 5, currency: 'USD', status: 'confirmed', receiptUrl: 'javascript:alert(1)'});
    expect([...app.querySelectorAll('a')].some(a => a.textContent === 'Receipt')).toBe(false);
  });
});
