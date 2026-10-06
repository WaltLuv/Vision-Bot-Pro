import {describe, expect, it, vi} from 'vitest';

const saved: unknown[] = [];
vi.mock('../src/api', async importOriginal => ({...(await importOriginal<typeof import('../src/api')>()), api: {
  addRoutine: vi.fn(async (r: unknown) => {saved.push(r); return {id: 'w1', schedule: 'Every Friday at 4:00 PM'};}),
  runWorkflow: vi.fn(async () => ({})), setWorkflowEnabled: vi.fn(async () => ({})), removeWorkflow: vi.fn(async () => {}),
}}));
const {routines, IDEAS} = await import('../src/ui/routines');
const {approvalCard} = await import('../src/ui/approvals');
import type {Approval, Workflow} from '../src/api';
import type {Ctx} from '../src/ui/ctx';

const ctx = (workflow: Partial<Workflow>[] = []) => ({state: {workflow}, connections: {apps: true}, toast() {}, refresh: async () => {}} as unknown as Ctx);

describe('routines', () => {
  it('shows each routine with its schedule, delivery, last result and controls', () => {
    const el = routines(ctx([{id: 'w1', name: 'Friday status', task: 'Post the status', enabled: true, repeat: {frequency: 'weekly', time: '16:00', weekday: 'friday', timezone: 'UTC'},
      schedule: 'Every Friday at 4:00 PM', delivery: 'slack', lastRunStatus: 'completed', lastRunSummary: 'Posted 6 updates'}]));
    const card = el.querySelector('[data-workflow="w1"]')!;
    expect(card.textContent).toContain('Every Friday at 4:00 PM');
    expect(card.textContent).toContain('Delivers to Slack');
    expect(card.textContent).toContain('Last run: Done · Posted 6 updates');
    expect(card.textContent).toContain('Each delivery to Slack waits for your approval.');
    expect([...card.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Run now', 'Pause', 'Delete']);
  });

  it('an idea fills the form, and saving sends the repeat in this phone\'s time zone', async () => {
    const el = routines(ctx());
    expect(el.querySelectorAll('[data-idea]').length).toBe(IDEAS.length);
    (el.querySelector('[data-idea="slack-status"] button') as HTMLButtonElement).click();
    expect((el.querySelector('[aria-label="Routine name"]') as HTMLInputElement).value).toBe('Weekly team update');
    expect((el.querySelector('[aria-label="Deliver to"]') as HTMLSelectElement).value).toBe('slack');
    [...el.querySelectorAll('button')].find(b => b.textContent === 'Save routine')!.click();
    await new Promise(r => setTimeout(r, 0));
    expect(saved[0]).toMatchObject({name: 'Weekly team update', delivery: 'slack', template: 'slack-status', repeat: {frequency: 'weekly', time: '16:00', weekday: 'friday', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone}});
  });
});

describe('connected-app approvals', () => {
  const approval = (tool: string, effect: Approval['effect']) => approvalCard({id: 'a1', runId: 'r1', tool, label: 'Send with a connected app', effect, status: 'pending', expiresAt: Date.now() + 60_000,
    details: {app: 'slack', action: 'SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL', arguments: {channel: '#maintenance', text: 'Unit 4B leak fixed'}}} as Approval, () => {}, () => {});
  it('names the app, the action and each argument, and never offers standing permission', () => {
    const el = approval('app_send', 'communication');
    const terms = [...el.querySelectorAll('dt')].map((dt, i) => `${dt.textContent}: ${el.querySelectorAll('dd')[i]!.textContent}`);
    expect(terms).toEqual(['App: Slack', 'Action: Sends a message to a slack channel', 'Channel: #maintenance', 'Text: Unit 4B leak fixed']);
    expect([...el.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Allow once', 'Not now']);
    expect([...approval('app_update', 'write').querySelectorAll('button')].map(b => b.textContent)).toEqual(['Allow once', 'Not now']);
  });
});
