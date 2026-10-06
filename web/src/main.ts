import './styles.css';
import {api, ApiError, setCsrf, subscribe, type Connections, type State} from './api';
import {Camera} from './camera';
import {h, mount} from './dom';
import {rebuildKeepingEdits, trackEdits} from './fields';
import {coalesce} from './coalesce';
import {applyCard, applyTranscript, dismissCard, emptyState} from './store';
import {RealtimeSession, type Card, type SessionState, type TranscriptEntry} from './realtime';
import type {Ctx, Tab} from './ui/ctx';
import {login} from './ui/login';
import {today} from './ui/today';
import {tasks} from './ui/tasks';
import {employee} from './ui/employee';
import {settings} from './ui/settings';
import {routines} from './ui/routines';
import {appNeededBanner} from './ui/connectors';
import {autoWatch, updateLive, watchBrowser} from './ui/live';

const root = document.getElementById('app')!;
trackEdits(root);
let stopStream: (() => void) | null = null;

const ctx: Ctx = {
  state: emptyState(),
  connections: null,
  apps: null,
  appNeeded: null,
  streamOnline: false,
  sessionState: 'idle',
  camera: new Camera(),
  cameraMultiple: false,
  transcript: [],
  cards: [],
  tab: 'today',
  busy: false,
  owner: '',
  session: null as unknown as RealtimeSession,
  go(tab) {ctx.tab = tab; render();},
  watch(computerId) {watchBrowser(ctx, computerId);},
  // Never throws. A failed refresh leaves the last good view on screen and the
  // event stream brings it up to date; letting it reject blanked the app. A
  // burst of events is one fetch, not one each.
  refresh: coalesce(async () => {
    try {
      const [state, connections] = await Promise.all([api.state(), api.connections().catch(() => ctx.connections)]);
      ctx.state = state as State;
      ctx.connections = (connections ?? null) as Connections | null;
      if (ctx.connections?.apps) ctx.apps = (await api.composioTools().catch(() => null))?.tools ?? ctx.apps;
    } catch {/* keep what is on screen */}
    render();
  }),
  rerender: () => render(),
  toast,
  async signOut() {
    await api.logout().catch(() => {});
    stopStream?.();
    await ctx.session.disconnect().catch(() => {});
    ctx.camera.stop();
    location.reload();
  },
};

ctx.session = new RealtimeSession({
  onState(state: SessionState, detail?: string) {ctx.sessionState = state; ctx.sessionDetail = detail; render();},
  onTranscript(entry: TranscriptEntry) {ctx.transcript = applyTranscript(ctx.transcript, entry); render();},
  onCard(card: Card) {ctx.cards = applyCard(ctx.cards, card); render();},
  onDismissCard(uuid: string) {ctx.cards = dismissCard(ctx.cards, uuid); render();},
});

const TABS: {id: Tab; label: string}[] = [
  {id: 'today', label: 'Today'},
  {id: 'tasks', label: 'Tasks'},
  {id: 'routines', label: 'Routines'},
  {id: 'employee', label: 'Employee'},
  {id: 'settings', label: 'Settings'},
];

function shell(): HTMLElement {
  const screen = ctx.tab === 'tasks' ? tasks(ctx) : ctx.tab === 'routines' ? routines(ctx) : ctx.tab === 'employee' ? employee(ctx) : ctx.tab === 'settings' ? settings(ctx) : today(ctx);
  return h('div', {class: 'app'},
    !ctx.streamOnline ? h('div', {class: 'banner', role: 'status', text: 'Offline — reconnecting…'}) : null,
    h('main', {class: 'main'}, appNeededBanner(ctx), screen),
    h('nav', {class: 'tabs', role: 'tablist'}, ...TABS.map(t =>
      h('button', {class: `tab ${ctx.tab === t.id ? 'on' : ''}`, role: 'tab', 'aria-selected': String(ctx.tab === t.id), onclick: () => ctx.go(t.id)}, t.label))),
  );
}

function render() {
  rebuildKeepingEdits(root, ctx.tab, () => mount(root, shell()));
  autoWatch(ctx);
  updateLive(ctx);
}

function toast(message: string) {
  const node = h('div', {class: 'toast', role: 'status', text: message});
  document.body.append(node);
  setTimeout(() => node.remove(), 4000);
}

async function start(owner: string) {
  ctx.owner = owner;
  ctx.cameraMultiple = await ctx.camera.hasMultipleCameras();
  // A camera that stopped by itself shows as off, with Start camera, not as a frozen frame.
  ctx.camera.onEnded = () => {void ctx.session.unpublishCamera(); render();};
  // Show the app before its contents arrive. Waiting on the first load meant one
  // slow or refused request left you on the sign-in screen as if never signed in.
  render();
  void ctx.refresh().then(() => returnedFromApp());
  stopStream = subscribe(
    event => {
      // The event says something changed and names the run; the authoritative
      // record is refetched rather than patched locally, so the UI can never
      // drift from the server's view of a run's status.
      if (event.type === 'connector.needed') ctx.appNeeded = event.connector;
      if (event.type) void ctx.refresh();
    },
    online => {ctx.streamOnline = online; render();},
  );
  render();
}

/**
 * Back from an app's sign-in page (/?connected=gmail): confirm with the server rather than trusting the address,
 * say how it went, and tidy the address so a reload does not check again.
 */
async function returnedFromApp() {
  const id = new URLSearchParams(location.search).get('connected');
  if (!id) return;
  history.replaceState(null, '', location.pathname);
  ctx.tab = 'settings';
  try {
    const r = await api.checkComposioConnection(id);
    toast(r.status === 'connected' ? `${r.name} is connected${r.connectedLabel ? ` as ${r.connectedLabel}` : ''}.` : `${r.name} is not connected yet. Try again from Connected apps.`);
  } catch (err) {
    toast(err instanceof Error ? err.message : 'That app could not be checked.');
  }
  await ctx.refresh();
}

async function boot() {
  mount(root, h('div', {class: 'screen centered'}, h('p', {class: 'note', text: 'Loading…'})));
  for (let attempt = 0; ; attempt++) {
    try {
      const session = await api.session();
      setCsrf(session.csrf);
      await start(session.owner);
      return;
    } catch (err) {
      // Only "not signed in" means show the sign-in screen. A rate limit or a
      // gateway still starting is temporary, and signing someone out over it is
      // both wrong and alarming.
      if (err instanceof ApiError && err.status === 401) {
        mount(root, login(owner => void start(owner)));
        return;
      }
      mount(root, h('div', {class: 'screen centered'}, h('section', {class: 'card'},
        h('h3', {text: 'Reconnecting…'}),
        h('p', {class: 'note', text: 'Your employee is there. This phone just cannot reach it for a moment.'}))));
      await new Promise(r => setTimeout(r, Math.min(8000, 1000 * 2 ** attempt)));
    }
  }
}

// Registered from the built bundle, so it is an external script under the
// gateway's script-src 'self' policy.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

void boot();
