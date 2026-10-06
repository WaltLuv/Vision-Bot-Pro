import {beforeEach, describe, expect, it, vi} from 'vitest';

const calls: string[] = [];
vi.mock('../src/api', async importOriginal => ({...(await importOriginal<typeof import('../src/api')>()), api: {
  startComposioConnection: vi.fn(async (id: string) => {calls.push('connect:' + id); return id === 'slack'
    ? {id, name: 'Slack', status: 'connected', connectedLabel: 'ops-team', connectUrl: null}
    : {id, name: 'Gmail', status: 'pending', connectUrl: 'https://connect.composio.dev/link/abc'};}),
  checkComposioConnection: vi.fn(async (id: string) => {calls.push('check:' + id); return {id, name: 'Gmail', status: 'connected', connectedLabel: 'walter@example.com'};}),
  disconnectComposio: vi.fn(async (id: string) => {calls.push('disconnect:' + id); return {id, status: 'revoked'};}),
}}));
const {connectorsCard, connectApp, appNeededBanner} = await import('../src/ui/connectors');
import type {AppConnection} from '../src/api';
import type {Ctx} from '../src/ui/ctx';

const app = (id: string, name: string, category: string, over: Partial<AppConnection> = {}): AppConnection =>
  ({id, name, category, description: `${name} things.`, status: 'not_connected', connectedLabel: null, connectedEmail: null, lastCheckedAt: null, ...over});
function context(over: Partial<Ctx> = {}) {
  const toasts: string[] = [];
  const ctx = {connections: {apps: true}, apps: [
    app('gmail', 'Gmail', 'Email', {status: 'connected', connectedEmail: 'walter@example.com'}),
    app('googlecalendar', 'Google Calendar', 'Calendar', {status: 'pending'}),
    app('slack', 'Slack', 'Messaging'),
  ], appNeeded: null, toast: (m: string) => toasts.push(m), refresh: async () => {}, rerender() {}, ...over} as unknown as Ctx;
  return {ctx, toasts};
}
beforeEach(() => {calls.length = 0;});

describe('connected apps', () => {
  it('groups apps, says who each is connected as, and offers the right action for each state', () => {
    const el = connectorsCard(context().ctx)!;
    expect([...el.querySelectorAll('.eyebrow')].map(e => e.textContent)).toEqual(['Email', 'Calendar', 'Messaging']);
    const row = (id: string) => el.querySelector(`[data-app="${id}"]`)!;
    const buttons = (id: string) => [...row(id).querySelectorAll('button')].map(b => b.textContent);
    expect(row('gmail').textContent).toContain('Connected as walter@example.com');
    expect(buttons('gmail')).toEqual(['Check', 'Disconnect']);
    expect(buttons('googlecalendar')).toEqual(['Try again', 'Refresh status']);
    expect(row('googlecalendar').querySelector('.pill')!.textContent).toBe('Waiting for sign-in');
    expect(buttons('slack')).toEqual(['Connect']);
    expect(el.textContent).toContain('waits for your approval every time');
  });

  it('says plainly when the server has no connected apps, rather than showing buttons that cannot work', () => {
    const el = connectorsCard(context({connections: {apps: false} as never}).ctx)!;
    expect(el.textContent).toContain('not set up on this server yet');
    expect(el.querySelector('button')).toBeNull();
  });

  it('goes to the app\'s sign-in page, or confirms at once when already signed in there', async () => {
    const {ctx, toasts} = context();const went: string[] = [];
    await connectApp(ctx, 'gmail', url => went.push(url));
    expect(went).toEqual(['https://connect.composio.dev/link/abc']);
    await connectApp(ctx, 'slack', url => went.push(url));
    expect(went).toHaveLength(1);
    expect(toasts).toContain('Slack is connected as ops-team.');
  });

  it('asks to connect an app a task needed, and stays quiet once it is connected', () => {
    expect(appNeededBanner(context({appNeeded: 'slack'}).ctx)!.textContent).toContain('needs Slack');
    expect(appNeededBanner(context({appNeeded: 'gmail'}).ctx)).toBeNull();
    expect(appNeededBanner(context().ctx)).toBeNull();
  });
});
