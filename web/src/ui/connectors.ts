import {api, type AppConnection, type AppStatus} from '../api';
import {h} from '../dom';
import type {Ctx} from './ctx';

export const APP_STATUS_LABEL: Record<AppStatus, string> = {
  not_connected: 'Not connected',
  pending: 'Waiting for sign-in',
  connected: 'Connected',
  failed: 'Sign-in failed',
  revoked: 'Disconnected',
};
const CATEGORY_ORDER = ['Email', 'Calendar', 'Messaging', 'Documents', 'Social'];

/**
 * Leave for the app's own sign-in page. Same tab rather than a popup: an installed PWA on a phone blocks or loses
 * popups, and the provider sends the person straight back to /?connected=<app>, where the status is checked.
 */
export async function connectApp(ctx: Ctx, id: string, go: (url: string) => void = url => location.assign(url)) {
  try {
    const r = await api.startComposioConnection(id);
    if (r.connectUrl) {go(r.connectUrl); return;}
    ctx.toast(`${r.name} is connected${r.connectedLabel ? ` as ${r.connectedLabel}` : ''}.`);
    await ctx.refresh();
  } catch (err) {
    ctx.toast(err instanceof Error ? err.message : 'That app could not be connected.');
  }
}

async function check(ctx: Ctx, id: string) {
  try {
    const r = await api.checkComposioConnection(id);
    ctx.toast(r.status === 'connected' ? `${r.name} is connected${r.connectedLabel ? ` as ${r.connectedLabel}` : ''}.` : `${r.name}: ${APP_STATUS_LABEL[r.status].toLowerCase()}.`);
    await ctx.refresh();
  } catch (err) {
    ctx.toast(err instanceof Error ? err.message : 'That status could not be checked.');
  }
}

async function disconnect(ctx: Ctx, app: AppConnection) {
  if (!confirm(`Disconnect ${app.name}? Your employee will no longer be able to use it until you connect it again.`)) return;
  try {
    await api.disconnectComposio(app.id);
    ctx.toast(`${app.name} is disconnected.`);
    await ctx.refresh();
  } catch (err) {
    ctx.toast(err instanceof Error ? err.message : 'That app could not be disconnected.');
  }
}

function appRow(ctx: Ctx, app: AppConnection): HTMLElement {
  const on = app.status === 'connected';
  const who = on && (app.connectedEmail || app.connectedLabel);
  return h('div', {class: 'row-item app-row', 'data-app': app.id},
    h('p', {class: 'task', text: app.name}),
    h('span', {class: `pill ${on ? 'ok' : app.status === 'pending' ? '' : 'warn'}`, text: APP_STATUS_LABEL[app.status]}),
    h('p', {class: 'note', text: who ? `${app.description} Connected as ${who}.` : app.description}),
    h('div', {class: 'row wrap'},
      on
        ? h('button', {class: 'ghost', onclick: () => void check(ctx, app.id)}, 'Check')
        : h('button', {class: 'primary', onclick: () => void connectApp(ctx, app.id)}, app.status === 'pending' || app.status === 'failed' ? 'Try again' : 'Connect'),
      app.status === 'pending' ? h('button', {class: 'ghost', onclick: () => void check(ctx, app.id)}, 'Refresh status') : null,
      on ? h('button', {class: 'ghost danger', onclick: () => void disconnect(ctx, app)}, 'Disconnect') : null,
    ),
  );
}

/** Settings → Connected apps. Reads are used freely; anything that sends, changes or deletes asks you first. */
export function connectorsCard(ctx: Ctx): HTMLElement | null {
  if (!ctx.connections?.apps) return h('section', {class: 'card'},
    h('h3', {text: 'Connected apps'}),
    h('p', {class: 'note', text: 'Gmail, Slack, Calendar, Notion and other apps are not set up on this server yet.'}));
  const apps = ctx.apps ?? [];
  const groups = CATEGORY_ORDER.map(cat => ({cat, list: apps.filter(a => a.category === cat)})).filter(g => g.list.length);
  return h('section', {class: 'card'},
    h('h3', {text: 'Connected apps'}),
    h('p', {class: 'note', text: 'Your employee reads from connected apps when a task needs it. Sending, changing or deleting anything waits for your approval every time.'}),
    !apps.length ? h('p', {class: 'note', text: 'Loading your apps…'}) : null,
    ...groups.flatMap(g => [h('p', {class: 'eyebrow', text: g.cat}), ...g.list.map(a => appRow(ctx, a))]),
  );
}

/** Shown when a task needed an app that is not connected: one tap to fix it. */
export function appNeededBanner(ctx: Ctx): HTMLElement | null {
  const app = ctx.appNeeded ? ctx.apps?.find(a => a.id === ctx.appNeeded) : undefined;
  if (!app || app.status === 'connected') return null;
  return h('section', {class: 'card app-needed', role: 'status'},
    h('p', {class: 'task', text: `Your employee needs ${app.name} for a task.`}),
    h('div', {class: 'row wrap'},
      h('button', {class: 'primary', onclick: () => void connectApp(ctx, app.id)}, `Connect ${app.name}`),
      h('button', {class: 'ghost', onclick: () => {ctx.appNeeded = null; ctx.rerender();}}, 'Not now')),
  );
}
