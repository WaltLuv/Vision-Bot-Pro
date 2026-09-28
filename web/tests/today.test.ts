import {beforeEach, describe, expect, it, vi} from 'vitest';

const execute = vi.fn(async () => ({id: 'run-1', status: 'queued'}));
vi.mock('../src/api', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  api: {execute},
  newIdempotencyKey: () => 'key',
}));

const {today} = await import('../src/ui/today');
const {mount} = await import('../src/dom');
import type {Ctx} from '../src/ui/ctx';

// The screen is rebuilt on every gateway event, and the first one lands right
// after sign-in. Whatever the owner is typing must survive that: a rebuilt box
// used to come back empty, and Send then quietly sent nothing.

function makeCtx(busy = false): Ctx {
  return {
    owner: 'owner', busy, streamOnline: true, cards: [], transcript: [], sessionDetail: '',
    state: {run: [], approval: [], computer: [], artifact: [], action: [], agent: [], memory: [], contact: [], material: [], offer: []},
    camera: {running: false, state: {status: 'off', stream: null}},
    session: {live: false},
    rerender() {}, toast() {}, async refresh() {}, go() {},
  } as unknown as Ctx;
}

const root = () => document.body.querySelector('#app') as HTMLElement;
const box = () => root().querySelector<HTMLTextAreaElement>('textarea[aria-label="Ask or assign something"]')!;
const render = (ctx: Ctx) => mount(root(), today(ctx));
const type = (text: string) => {box().value = text; box().dispatchEvent(new Event('input'));};

describe('today: what you type survives updates', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
    execute.mockClear();
    render(makeCtx());
    type('');
  });

  it('keeps the text when the screen is rebuilt', () => {
    const ctx = makeCtx();
    render(ctx);
    type('Order two boxes of M6 bolts');
    render(ctx);
    expect(box().value).toBe('Order two boxes of M6 bolts');
  });

  it('keeps the cursor in the box, at the same place', async () => {
    const ctx = makeCtx();
    render(ctx);
    type('Order two boxes');
    box().focus();
    box().setSelectionRange(6, 6);
    const before = box();
    render(ctx);
    await Promise.resolve();
    expect(box()).not.toBe(before);
    expect(document.activeElement).toBe(box());
    expect([box().selectionStart, box().selectionEnd]).toEqual([6, 6]);
  });

  it('does not take the cursor when the box did not have it', async () => {
    const ctx = makeCtx();
    render(ctx);
    render(ctx);
    await Promise.resolve();
    expect(document.activeElement).not.toBe(box());
  });

  it('sends what was typed, and a rebuild after sending does not bring it back', async () => {
    const ctx = makeCtx();
    render(ctx);
    type('Check the smoke alarms');
    [...root().querySelectorAll('button')].find(b => b.textContent === 'Send')!.click();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect((execute.mock.calls[0] as unknown[])[0]).toBe('Check the smoke alarms');
    render(ctx);
    expect(box().value).toBe('');
  });

  it('gives the text back when the task did not go through', async () => {
    execute.mockRejectedValueOnce(new Error('Too many requests. Try again in a minute.'));
    const ctx = makeCtx();
    render(ctx);
    type('Compare prices for deck screws');
    [...root().querySelectorAll('button')].find(b => b.textContent === 'Send')!.click();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    await Promise.resolve(); await Promise.resolve();
    render(ctx);
    expect(box().value).toBe('Compare prices for deck screws');
  });

  it('keeps the text, unsent, when Enter is pressed while busy', () => {
    const ctx = makeCtx(true);
    render(ctx);
    type('Price M6 bolts');
    box().dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', cancelable: true}));
    expect(execute).not.toHaveBeenCalled();
    expect(box().value).toBe('Price M6 bolts');
  });
});
