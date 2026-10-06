// The browser the employee uses in the preview: a sample shop site, drawn in
// the app's own live view, that the owner can watch, take over, use and hand
// back. It keeps the real browser tool's rules: the employee only acts while it
// has control, stops the moment the owner takes over, and never checks out --
// buying goes through an exact quote the owner approves.
//
// A published page cannot frame another site, so the site is drawn over the
// app's live-view frame, under the app's own shield: the app still decides
// when the page can be touched.
import type {Computer} from '../src/api';
import {h, mount} from '../src/dom';
import {emit, newId, preview, step} from './gateway';

interface Product {name: string; price: number; stock: string; pickup: string}
type Page = 'home' | 'results' | 'product' | 'cart';
interface Sim {
  id: string; runId: string; query: string; typical: number;
  page: Page; typed: string; searched: string; results: Product[]; product: Product | null;
  /** What the employee's pointer is on, as a selector. */
  pointer: string | null; note: string; stopped: boolean;
}

const sims = new Map<string, Sim>();
const record = (id: string) => preview.state.computer.find(c => c.id === id);
const ownerHas = (sim: Sim) => record(sim.id)?.control === 'owner';
const dollars = (n: number) => `$${n.toFixed(2)}`;
class Stopped extends Error {}

function catalog(query: string, typical: number): Product[] {
  const name = query.trim().charAt(0).toUpperCase() + query.trim().slice(1) || 'Item';
  const price = (n: number) => Math.max(0.49, Math.round(n * 100) / 100);
  return [
    {name, price: price(typical), stock: 'In stock, 42 at this store', pickup: 'Pickup today'},
    {name: `${name}, contractor 10-pack`, price: price(typical * 9.1), stock: 'In stock', pickup: 'Pickup tomorrow'},
    {name: `${name}, economy`, price: price(typical * 0.76), stock: 'Only 3 left', pickup: 'Delivery only'},
  ];
}

function search(sim: Sim, text: string) {
  sim.searched = text.trim(); sim.typed = text; sim.results = catalog(text, sim.typical);
  sim.page = 'results'; sim.product = null; sim.note = ''; sim.pointer = null;
  sync();
}
function open(sim: Sim, index: number) {
  sim.product = sim.results[index] ?? null; sim.page = sim.product ? 'product' : sim.page; sim.note = ''; sim.pointer = null;
  sync();
}

/**
 * Wait while the employee works. Its time stands still while the owner has
 * the browser, and a stop, or the end of the step's time, ends it.
 */
async function wait(sim: Sim, ms: number, signal: AbortSignal, deadline: number) {
  let left = ms;
  while (left > 0 || ownerHas(sim)) {
    if (sim.stopped || signal.aborted) throw new Stopped();
    if (Date.now() > deadline) throw new Error('out of time');
    await new Promise(resolve => setTimeout(resolve, 100));
    if (!ownerHas(sim)) left -= 100;
  }
}

/** The employee's part: search, look over the results, open the best one, read it. Picks up wherever the owner left the page. */
async function work(sim: Sim, signal: AbortSignal, deadline: number): Promise<Product> {
  const pause = (ms: number) => wait(sim, ms, signal, deadline);
  const point = (selector: string) => {sim.pointer = selector; sync();};
  for (;;) {
    await pause(0);
    if (sim.page === 'home') {
      step(sim.runId, `Searching shop.example for "${sim.query}"`);
      point('#vbp-q'); await pause(1000);
      while (sim.page === 'home' && sim.typed !== sim.query) {
        // Typed key by key; if the owner changed the box meanwhile, it starts over.
        if (!sim.query.startsWith(sim.typed)) sim.typed = '';
        sim.typed = sim.query.slice(0, sim.typed.length + 1); sync();
        await pause(110);
      }
      if (sim.page !== 'home') continue;
      point('#vbp-go'); await pause(700);
      if (sim.page === 'home') search(sim, sim.typed);
    } else if (sim.page === 'results') {
      step(sim.runId, `Looking over ${sim.results.length} results`);
      for (let i = 0; i < sim.results.length && sim.page === 'results'; i++) {point(`[data-result="${i}"]`); await pause(1100);}
      if (sim.page === 'results') open(sim, 0);
    } else if (sim.page === 'product' && sim.product) {
      step(sim.runId, `Reading the page for ${sim.product.name}`);
      point('#vbp-price'); await pause(1600);
      if (sim.page === 'product' && sim.product) return sim.product;
    } else {
      sim.note = 'Your employee does not check out. Buying goes through an exact quote you approve in the app.';
      point('#vbp-back'); await pause(1500);
      if (sim.page === 'cart') {sim.page = sim.product ? 'product' : 'home'; sim.note = ''; sync();}
    }
  }
}

/** Open a browser for one task and let the employee do it. Resolves with what it found, or why it stopped. */
export async function browse(runId: string, task: string, query: string, typical: number, signal: AbortSignal, budgetMs: number) {
  const id = newId('computer');
  const computer: Computer = {id, runId, task, status: 'starting', control: 'agent', liveEmbed: `about:blank#vbp-browser-${id}`};
  preview.state.computer.unshift(computer);
  const sim: Sim = {id, runId, query: query.slice(0, 80), typical, page: 'home', typed: '', searched: '', results: [], product: null, pointer: null, note: '', stopped: false};
  sims.set(id, sim);
  emit('computer.updated', {runId});
  const deadline = Date.now() + budgetMs;
  const end = (status: Computer['status']) => {computer.status = status; computer.control = 'agent'; sims.delete(id); emit('computer.updated', {runId}); sync();};
  step(runId, 'Opening the sample shop site');
  try {
    await wait(sim, 1500, signal, deadline);
    computer.status = 'working';
    emit('computer.updated', {runId});
    sync();
    const found = await work(sim, signal, deadline);
    end('completed');
    return {status: 'done', found: {...found, site: 'shop.example, a sample site'}, note: 'Preview: a sample shop site, not the real web. Its prices are not real.'};
  } catch {
    if (sim.stopped) {end('cancelled'); return {status: 'stopped by the owner', note: 'The owner stopped the browser.'};}
    end('closed');
    return signal.aborted ? {status: 'stopped', note: 'The task was stopped.'}
      : {status: 'ran out of time', note: 'The owner still had the browser when this step ran out of time, so it was closed.'};
  }
}

/** The app's Take over, Hand back and Stop, for a browser that is running. */
export function control(id: string, action: 'takeover' | 'handback' | 'stop'): boolean {
  const sim = sims.get(id), computer = record(id);
  if (!sim || !computer || computer.status !== 'working') return false;
  if (action === 'stop') sim.stopped = true;
  else {computer.control = action === 'takeover' ? 'owner' : 'agent'; emit('computer.updated', {runId: sim.runId});}
  sync();
  return true;
}

// --- drawing the site in the live view ------------------------------------

let site: HTMLElement | null = null;
let pointer: HTMLElement | null = null;

function page(sim: Sim): HTMLElement {
  const mine = () => ownerHas(sim);
  const act = (fn: () => void) => () => {if (mine()) {fn(); sync();}};
  const box = h('input', {id: 'vbp-q', class: 'vbp-input', type: 'search', placeholder: 'Search products', 'aria-label': 'Search the sample shop', autocomplete: 'off', enterkeyhint: 'search'});
  box.value = sim.typed;
  box.addEventListener('input', () => {if (mine()) sim.typed = box.value; else box.value = sim.typed;});
  const form = h('form', {class: 'vbp-search', role: 'search'}, box, h('button', {id: 'vbp-go', class: 'vbp-button', type: 'submit'}, 'Search'));
  form.addEventListener('submit', e => {e.preventDefault(); if (mine() && box.value.trim()) search(sim, box.value);});

  const p = sim.product;
  const body = sim.page === 'results'
    ? h('div', {class: 'vbp-body'},
        h('p', {class: 'vbp-muted', text: `${sim.results.length} results for "${sim.searched}"`}),
        ...sim.results.map((r, i) => h('button', {class: 'vbp-result', type: 'button', 'data-result': String(i), onclick: act(() => open(sim, i))},
          h('span', {class: 'vbp-name', text: r.name}), h('span', {class: 'vbp-price', text: dollars(r.price)}), h('span', {class: 'vbp-muted', text: `${r.stock} · ${r.pickup}`}))))
    : sim.page === 'product' && p
      ? h('div', {class: 'vbp-body'},
          h('button', {id: 'vbp-back', class: 'vbp-link', type: 'button', onclick: act(() => {sim.page = 'results';})}, '← Back to results'),
          h('h2', {text: p.name}), h('p', {id: 'vbp-price', class: 'vbp-big', text: dollars(p.price)}),
          h('p', {text: p.stock}), h('p', {text: p.pickup}),
          h('button', {id: 'vbp-add', class: 'vbp-button', type: 'button', onclick: act(() => {sim.page = 'cart';})}, 'Add to cart'))
      : sim.page === 'cart' && p
        ? h('div', {class: 'vbp-body'},
            h('h2', {text: 'Your cart'}), h('p', {text: `1 × ${p.name} · ${dollars(p.price)}`}),
            h('div', {class: 'vbp-row'},
              h('button', {id: 'vbp-checkout', class: 'vbp-button', type: 'button', onclick: act(() => {sim.note = 'This is a sample site: nothing can be bought here. In the app, buying goes through an exact quote you approve.';})}, 'Check out'),
              h('button', {id: 'vbp-back', class: 'vbp-link', type: 'button', onclick: act(() => {sim.page = 'product'; sim.note = '';})}, '← Back to the item')))
        : h('div', {class: 'vbp-body'}, h('h2', {text: 'Tools, fixings and supplies'}), h('p', {class: 'vbp-muted', text: 'Search the catalog above.'}));

  const path = sim.page === 'results' ? `search?q=${encodeURIComponent(sim.searched)}` : sim.page === 'product' && p ? `p/${encodeURIComponent(p.name.toLowerCase().replace(/\W+/g, '-'))}` : sim.page === 'cart' ? 'cart' : '';
  return h('div', {class: 'vbp-window'},
    h('div', {class: 'vbp-bar'}, h('span', {class: 'vbp-url', text: `https://shop.example/${path}`})),
    h('header', {class: 'vbp-head'}, h('strong', {text: 'Sample Hardware'}), h('span', {class: 'vbp-tag', text: 'Sample site'})),
    form,
    sim.note ? h('p', {class: 'vbp-note', role: 'status', text: sim.note}) : null,
    body);
}

/** Bring the drawn site in line with the browser the live view is showing. Cheap; runs often. */
export function sync() {
  const frame = document.querySelector<HTMLIFrameElement>('.live iframe.live-frame');
  if (!frame) return;
  site ??= h('div', {class: 'vbp-site'});
  // Straight after the frame, so the app's shield still covers it while the employee has control.
  if (site.previousElementSibling !== frame) frame.after(site);
  const id = /#vbp-browser-(.+)$/.exec(frame.getAttribute('src') ?? '')?.[1];
  const sim = id ? sims.get(id) : undefined;
  // Set only on a change: setting it at all is a mutation, which would wake this again.
  if (site.hidden !== (frame.hidden || !sim)) site.hidden = frame.hidden || !sim;
  if (!sim || site.hidden) return;

  const key = [sim.id, sim.page, sim.searched, sim.product?.name ?? '', sim.note].join('|');
  if (site.dataset.key !== key) {
    site.dataset.key = key;
    mount(site, page(sim));
    pointer = h('div', {class: 'vbp-pointer', 'aria-hidden': 'true'});
    site.append(pointer);
  }
  const box = site.querySelector<HTMLInputElement>('#vbp-q');
  if (box && document.activeElement !== box) box.value = sim.typed;
  const target = sim.pointer && !ownerHas(sim) ? site.querySelector<HTMLElement>(sim.pointer) : null;
  if (pointer!.hidden !== !target) pointer!.hidden = !target;
  if (target) {
    const outer = site.getBoundingClientRect(), inner = target.getBoundingClientRect();
    if (inner.bottom > outer.bottom || inner.top < outer.top) target.scrollIntoView({block: 'nearest'});
    const at = target.getBoundingClientRect();
    pointer!.style.transform = `translate(${at.left - outer.left + site.scrollLeft + Math.min(at.width / 2, 36)}px, ${at.top - outer.top + site.scrollTop + at.height / 2}px)`;
  }
}

/** Keep the drawn site in step with the live view, which the app opens, points and closes on its own. */
export function installLiveView() {
  new MutationObserver(sync).observe(document.body, {subtree: true, attributes: true, attributeFilter: ['src', 'hidden']});
}

export function stopBrowsing(runId: string) {
  for (const sim of sims.values()) if (sim.runId === runId) sim.stopped = true;
}
