import {describe, expect, it, vi} from 'vitest';

const stopComputer = vi.fn(async () => {});
vi.mock('../src/api', async importOriginal => ({...(await importOriginal<typeof import('../src/api')>()), api: {stopComputer}}));
const {steps, findings, liveBrowserCard} = await import('../src/ui/progress');
const {autoWatch} = await import('../src/ui/live');
import type {Computer, Run} from '../src/api';
import type {Ctx} from '../src/ui/ctx';

const run = (over: Partial<Run>): Run => ({id: 'r1', task: 'Find drywall prices at Home Depot', status: 'working', createdAt: new Date().toISOString(), ...over}) as Run;

describe('progress as it happens', () => {
  it('says the task was received before the first step arrives, so a tap is never met with nothing', () => {
    expect(steps(run({status: 'queued'}))!.textContent).toBe('Received');
  });

  it('shows each step, the newest one live', () => {
    const el = steps(run({progress: [{at: '', text: 'Checking stores and prices'}, {at: '', text: 'Opening homedepot.com…'}]}))!;
    expect([...el.querySelectorAll('li')].map(li => `${li.className}:${li.textContent}`)).toEqual(['done:Checking stores and prices', 'now:Opening homedepot.com…']);
    expect(steps(run({status: 'completed', progress: [{at: '', text: 'Reading homedepot.com'}]}))!.querySelector('.now')).toBeNull();
  });

  it('shows early findings with their sources until the full answer lands, linking only https pages', () => {
    const r = run({preview: 'About $15 a sheet.', findings: {provider: 'api.tavily.com', query: 'drywall', ms: 900, sources: [
      {title: 'Drywall 1/2 in.', url: 'https://www.homedepot.com/p/1', snippet: ''}, {title: 'Odd page', url: 'http://plain.example/x', snippet: ''}]}});
    const el = findings(r)!;
    expect(el.textContent).toContain('About $15 a sheet.');
    const links = [...el.querySelectorAll('a')];
    expect(links.map(a => a.getAttribute('href'))).toEqual(['https://www.homedepot.com/p/1']);
    expect(links[0]!.getAttribute('rel')).toBe('noopener noreferrer');
    expect(el.textContent).toContain('Odd page');
    expect(findings({...r, status: 'completed'})).toBeNull();
  });
});

const ctxWith = (computer: Partial<Computer>[], runs: Partial<Run>[] = [], tab = 'today') => {
  const watched: string[] = [];
  const ctx = {tab, state: {computer, run: runs}, watch: (id: string) => watched.push(id), refresh: async () => {}, toast() {}} as unknown as Ctx;
  return {ctx, watched};
};

describe('the live browser card', () => {
  it('shows what the browser is doing and offers to watch it', () => {
    const {ctx, watched} = ctxWith([{id: 'c1', runId: 'r1', task: 'drywall', status: 'working', control: 'agent'}], [run({progress: [{at: '', text: 'Reading homedepot.com'}]})]);
    const el = liveBrowserCard(ctx)!;
    expect(el.textContent).toContain('Live browser');
    expect(el.textContent).toContain('Reading homedepot.com');
    [...el.querySelectorAll('button')].find(b => b.textContent === 'Watch it browse')!.click();
    expect(watched).toEqual(['c1']);
  });

  it('after the task, says how long it stays open and offers to close it now', async () => {
    const {ctx} = ctxWith([{id: 'c1', runId: 'r1', task: 'drywall', status: 'working', lingerUntil: Date.now() + 150_000}]);
    const el = liveBrowserCard(ctx)!;
    expect(el.textContent).toContain('Task finished');
    expect(el.textContent).toMatch(/stays open about 3 more minutes/);
    [...el.querySelectorAll('button')].find(b => b.textContent === 'Close browser')!.click();
    await vi.waitFor(() => expect(stopComputer).toHaveBeenCalledWith('c1'));
  });

  it('shows "starting" at once, before the live view exists', () => {
    const el = liveBrowserCard(ctxWith([{id: 'c1', runId: 'r1', task: 'drywall', status: 'starting'}]).ctx)!;
    expect(el.textContent).toContain('Starting a live browser');
    expect((el.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('the browser opens by itself', () => {
  it('once, for a new browser showing pages, and never for an old one or one left open after a task', () => {
    document.body.innerHTML = '';
    const fresh = {id: 'c-new', runId: 'r1', task: 'x', status: 'working' as const, liveEmbed: 'https://www.browserbase.com/x', createdAt: new Date().toISOString()};
    const old = {...fresh, id: 'c-old', createdAt: new Date(Date.now() - 10 * 60_000).toISOString()};
    const after = {...fresh, id: 'c-after', lingerUntil: Date.now() + 60_000};
    expect(autoWatchFor([old, after])).toBe(false);
    expect(autoWatchFor([fresh])).toBe(true);
  });
});
function autoWatchFor(computers: object[]) {
  const {ctx} = ctxWith(computers as Partial<Computer>[]);
  autoWatch(ctx);
  const dialog = document.querySelector('.live');
  const open = !!dialog && !(dialog as HTMLElement).hidden;
  if (open) (document.querySelector('.live-head button') as HTMLButtonElement).click();
  return open;
}
