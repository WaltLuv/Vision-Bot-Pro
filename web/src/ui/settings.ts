import {api} from '../api';
import {h} from '../dom';
import {ACCESS_METHOD_LABEL} from '../store';
import type {Ctx} from './ctx';
import {connectorsCard} from './connectors';
import {autoWatchOn, setAutoWatch} from './live';

/**
 * Suppliers are a list, not a single on/off capability. Which ones are
 * connected decides how complete any price comparison can be, so the set is
 * shown plainly rather than reduced to "shopping: ready".
 */
function suppliersCard(ctx: Ctx): HTMLElement {
  const suppliers = ctx.connections?.suppliers ?? [];
  const connected = suppliers.filter(s => s.connected);
  return h('section', {class: 'card'},
    h('h3', {text: 'Suppliers'}),
    h('p', {class: 'note', text: connected.length
      ? `${connected.length} of ${suppliers.length} connected. Every search asks all connected suppliers at once.`
      : 'No suppliers connected yet. Prices cannot be compared until at least one is.'}),
    ...suppliers.map(s => h('div', {class: 'row-item'},
      h('p', {class: 'task', text: s.name}),
      h('span', {class: `pill ${s.connected ? 'ok' : 'warn'}`, text: s.connected ? ACCESS_METHOD_LABEL[s.method] : 'Not connected'}),
      s.connected ? null : h('p', {class: 'note', text: `Needs ${s.requires.join(', ')}`}))),
  );
}

// Capabilities are described by what they let the employee do. Provider and
// model names stay out of the product surface: which engine runs the work is a
// server-side decision, and naming vendors here would invite the impression it
// is a user setting.
const CAPABILITIES: {key: 'realtime' | 'sms' | 'voice' | 'browser' | 'search'; label: string; blurb: string}[] = [
  {key: 'realtime', label: 'Voice and camera conversation', blurb: 'Talk to it and let it see what you see.'},
  {key: 'sms', label: 'Text messages', blurb: 'Drafts a message and sends it only after you approve.'},
  {key: 'voice', label: 'Phone calls', blurb: 'Places a call with an objective you approve first.'},

  {key: 'browser', label: 'Using a browser', blurb: 'Works through sites on your behalf, with the session under your control.'},
  {key: 'search', label: 'Searching the web', blurb: 'Looks things up when a task needs it. Without it, give it a web address to read.'},
];

let installPrompt: (Event & {prompt(): Promise<void>}) | null = null;
window.addEventListener('beforeinstallprompt', e => {e.preventDefault(); installPrompt = e as Event & {prompt(): Promise<void>};});

const ENGINE_NAME: Record<string, string> = {
  anthropic: 'Claude, hosted by Anthropic.',
  hermes: 'Hermes, running on your own server.',
  claude: 'Claude Code, signed in with your Claude subscription.',
};

export function settings(ctx: Ctx): HTMLElement {
  const c = ctx.connections;
  // Readiness follows the runtime this owner is actually set to. Credentials for
  // the OTHER one do not make tasks work, and saying "Ready" because some engine
  // somewhere is configured is how you find out at task time instead of here.
  // The server says which engine it will use; the profile is only a fallback for an older gateway.
  const runtime = c?.runtime ?? ctx.state.agent[0]?.runtime ?? 'anthropic';
  const engineReady = !!c && !!c[runtime];
  const engineName = ENGINE_NAME[runtime] ?? ENGINE_NAME.anthropic;

  return h('div', {class: 'screen'},
    h('section', {class: 'card'},
      h('h3', {text: 'This device'}),
      h('p', {class: 'note', text: `Signed in as ${ctx.owner}.`}),
      installPrompt ? h('button', {class: 'primary', onclick: async () => {await installPrompt?.prompt(); installPrompt = null; ctx.rerender();}}, 'Add to home screen') : h('p', {class: 'note', text: 'Add this page to your home screen from your browser menu to use it like an app.'}),
      h('p', {class: 'note', text: ctx.streamOnline ? 'Connected to your employee.' : 'Offline. Anything you send will fail until the connection returns.'}),
    ),
    h('section', {class: 'card'},
      h('h3', {text: 'What it can do'}),
      h('div', {class: 'row-item'},
        h('p', {class: 'task', text: 'Carrying out tasks'}),
        h('span', {class: `pill ${engineReady ? 'ok' : 'warn'}`, text: engineReady ? 'Ready' : 'Not set up'}),
        h('p', {class: 'note', text: engineReady ? engineName : `${engineName} Not connected yet.`})),
      ...CAPABILITIES.map(cap => h('div', {class: 'row-item'},
        h('p', {class: 'task', text: cap.label}),
        h('span', {class: `pill ${c?.[cap.key] ? 'ok' : 'warn'}`, text: c?.[cap.key] ? 'Ready' : 'Not set up'}),
        h('p', {class: 'note', text: cap.blurb}))),
      c?.mcp?.length ? h('p', {class: 'note', text: `Connected tools: ${c.mcp.map(m => m.id).join(', ')}`}) : null,
      // The gateway reports a tool-config problem here; it is an operator fault,
      // not something the person did, so it is phrased that way.
      c?.mcpError ? h('p', {class: 'note', text: 'Some connected tools are misconfigured on the server.'}) : null,
    ),
    speedCard(ctx),
    signinsCard(ctx),
    connectorsCard(ctx),
    suppliersCard(ctx),
    h('section', {class: 'card'},
      h('h3', {text: 'Account'}),
      h('div', {class: 'row wrap'},
        h('button', {class: 'ghost', onclick: () => void ctx.signOut()}, 'Sign out'),
        h('button', {class: 'ghost danger', onclick: () => void wipe(ctx)}, 'Delete everything'),
      ),
      h('p', {class: 'note', text: 'Deleting removes your tasks, files, memory and conversations from the server and signs you out on every device. It cannot be undone.'}),
    ),
  );
}

const SEARCH_NAME: Record<string, string> = {tavily: 'Tavily', serper: 'Serper (Google results)', exa: 'Exa', brave: 'Brave Search', gemini: 'Google, through Gemini'};
/** What makes web tasks fast: a quick search, a live browser that opens at once, and how tasks are routed. */
function speedCard(ctx: Ctx): HTMLElement {
  const c = ctx.connections;
  const box = h('input', {type: 'checkbox', id: 'auto-watch'});
  box.checked = autoWatchOn();
  box.addEventListener('change', () => setAutoWatch(box.checked));
  const row = (label: string, ok: boolean, okText: string, blurb: string) => h('div', {class: 'row-item'},
    h('p', {class: 'task', text: label}), h('span', {class: `pill ${ok ? 'ok' : 'warn'}`, text: ok ? okText : 'Not set up'}), h('p', {class: 'note', text: blurb}));
  return h('section', {class: 'card'},
    h('h3', {text: 'Web tasks'}),
    row('Quick search', !!c?.searchProvider, SEARCH_NAME[c?.searchProvider ?? ''] ?? 'Ready', 'Runs the moment you ask, so early findings show in seconds. A search API key (Tavily, Serper, Exa or Brave) is fastest.'),
    row('Live browser', !!c?.liveBrowser, 'Ready', 'Opens as soon as a task needs the web, so you can watch every step and take over.'),
    row('Fast routing', !!c, c?.router === 'jev' ? 'Rules + Jev' : 'Rules', 'Decides in a moment whether a task needs the web, a store, your apps or your approval.'),
    h('label', {class: 'check', for: 'auto-watch'}, box, h('span', {}, h('span', {class: 'title', text: 'Show the browser as soon as it opens'}), h('span', {class: 'sub', text: 'On this phone. Off: tap Watch it browse when you want to see it.'}))),
  );
}

/** Saved retailer sign-ins (Pro Xtra, Lowe's Pro): which stores, and a way to forget them. Never the cookies. */
function signinsCard(ctx: Ctx): HTMLElement {
  const s = ctx.signins;
  const forget = async () => {
    if (!confirm('Forget your saved store sign-ins? Your employee will need you to sign in again for Pro pricing.')) return;
    try {await api.forgetSignins(); await ctx.refresh(); ctx.toast('Saved sign-ins forgotten.');}
    catch (err) {ctx.toast(err instanceof Error ? err.message : 'Those could not be forgotten.');}
  };
  const name = (d: string) => ({'homedepot.com': 'The Home Depot', 'lowes.com': "Lowe's"} as Record<string, string>)[d] ?? d;
  return h('section', {class: 'card'},
    h('h3', {text: 'Store sign-ins'}),
    !s?.enabled ? h('p', {class: 'note', text: 'Saved sign-ins are not set up on this server, so Pro Xtra and volume pricing are not available. Price lookups still work.'})
      : s.saved.length ? h('p', {class: 'note', text: `Signed in to ${s.saved.map(name).join(' and ')}${s.savedAt ? `, saved ${new Date(s.savedAt).toLocaleDateString()}` : ''}. Used only for Pro pricing and building a cart; never to pay.`})
      : h('p', {class: 'note', text: `None yet. When your employee needs your ${s.domains.map(name).join(' or ')} account, tap Take over in the live browser and sign in yourself. It is kept, encrypted, for next time.`}),
    s?.saved.length ? h('div', {class: 'row'}, h('button', {class: 'ghost danger', onclick: () => void forget()}, 'Forget saved sign-ins')) : null,
  );
}

async function wipe(ctx: Ctx) {
  if (!confirm('Delete all of your tasks, files, memory and conversations? You will be signed out everywhere. This cannot be undone.')) return;
  try {
    await api.deleteEverything();
    location.reload();
  } catch (err) {
    ctx.toast(err instanceof Error ? err.message : 'That could not be deleted.');
  }
}
