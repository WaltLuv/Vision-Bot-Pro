import {api, type Computer} from '../api';
import {h} from '../dom';
import type {Ctx} from './ctx';

// Watching the employee's browser, and taking it over.
//
// The live view is the browser provider's own page, framed. The rest of the app
// rebuilds its screen on every gateway event, and an <iframe> that is taken out
// of the page and put back reloads: the view reconnects, flickers and loses your
// place mid-typing. So this screen is built once, lives outside the rebuilt
// tree, and updateLive() changes it in place.
//
// Control follows the server only. The cover over the view comes down after the
// gateway says the provider paused the employee, never on the tap itself: two
// drivers on one browser is how a click lands on the wrong button.

const RUNNING = new Set<Computer['status']>(['queued', 'starting', 'working', 'cleanup_pending']);
const ENDED: Partial<Record<Computer['status'], string>> = {completed: 'Finished.', failed: 'The browser job did not finish.', cancelled: 'Stopped.', closed: 'Closed.'};

let watching: string | null = null;
let current: Ctx | null = null;
let busy = false;
let shownSrc = '';
let lastControl: Computer['control'];
// Browserbase's live view posts this when it loses the browser; a frozen picture should not pass for a live one.
let disconnected = false;
let view: ReturnType<typeof build> | null = null;

function build() {
  // `allow="autoplay"` is what Browser Use's own embed example sets for its live view.
  const frame = h('iframe', {class: 'live-frame', title: "Your employee's browser", referrerpolicy: 'no-referrer', allow: 'autoplay', sandbox: 'allow-scripts allow-same-origin allow-forms'});
  const shield = h('div', {class: 'live-shield', title: 'Take over to use this browser yourself'});
  const message = h('p', {class: 'live-message'});
  const status = h('p', {class: 'live-status', role: 'status', 'aria-live': 'polite'});
  const back = h('button', {class: 'ghost', onclick: () => closeLive()}, '← Back');
  // Handlers use whichever context rendered last, not the one that existed when the screen was built.
  const take = h('button', {class: 'primary', onclick: () => current && void move(current, 'takeover')}, 'Take over');
  const give = h('button', {class: 'primary', onclick: () => current && void move(current, 'handback')}, 'Hand back');
  const stop = h('button', {class: 'ghost danger', onclick: () => current && void stopIt(current)}, 'Stop');
  const note = h('p', {class: 'note'});
  const root = h('div', {class: 'live', role: 'dialog', 'aria-modal': 'true', 'aria-label': "Your employee's browser", hidden: true},
    h('header', {class: 'live-head'}, back, status),
    h('div', {class: 'live-stage'}, frame, shield, message),
    h('footer', {class: 'live-foot'}, h('div', {class: 'row wrap'}, take, give, stop), note));
  document.addEventListener('keydown', e => {if (e.key === 'Escape' && watching) closeLive();});
  window.addEventListener('message', e => {
    if (e.source === frame.contentWindow && e.data === 'browserbase-disconnected') {disconnected = true; if (current) updateLive(current);}
  });
  document.body.append(root);
  return {root, frame, shield, message, status, back, take, give, stop, note};
}

/** Open the live view of one browser job. */
export function watchBrowser(ctx: Ctx, computerId: string) {
  view ??= build();
  watching = computerId;
  lastControl = undefined;
  updateLive(ctx);
  view.back.focus();
}

export function closeLive() {
  watching = null;
  if (!view) return;
  show('');
  view.root.hidden = true;
}

// Only ever assigned when it changes: re-assigning the same src reloads the page too.
function show(src: string) {
  if (!view || src === shownSrc) return;
  shownSrc = src;
  disconnected = false;
  view.frame.src = src || 'about:blank';
}

async function move(ctx: Ctx, kind: 'takeover' | 'handback') {
  if (!watching || busy) return;
  busy = true; updateLive(ctx);
  try {
    await (kind === 'takeover' ? api.takeOver(watching) : api.handBack(watching));
    await ctx.refresh();
  } catch (err) {
    ctx.toast(err instanceof Error ? err.message : 'That did not work. Try again.');
  } finally {
    busy = false; updateLive(ctx);
  }
}

async function stopIt(ctx: Ctx) {
  if (!watching || busy) return;
  busy = true; updateLive(ctx);
  try {await api.stopComputer(watching); await ctx.refresh();}
  catch (err) {ctx.toast(err instanceof Error ? err.message : 'Could not stop it.');}
  finally {busy = false; updateLive(ctx);}
}

/** The newest thing the employee said it is doing on this browser's task, such as "Opening homedepot.com…". */
function latestStep(ctx: Ctx, c: Computer): string | undefined {
  return ctx.state.run?.find(r => r.id === c.runId)?.progress?.at(-1)?.text;
}

/**
 * Open the live view by itself the first time a browser for a task you just gave starts showing pages: the
 * browser is the progress, so you should not have to go looking for it. Once per browser, and only for one that
 * started in the last couple of minutes, so reopening the app does not throw you into an old one.
 */
const autoShown = new Set<string>();
export function autoWatch(ctx: Ctx, now = Date.now()) {
  if (watching || ctx.tab !== 'today' || !autoWatchOn()) return;
  const c = ctx.state.computer.find(x => x.status === 'working' && x.liveEmbed && !x.lingerUntil && !autoShown.has(x.id) && now - Date.parse(String(x.createdAt ?? 0)) < 120_000);
  if (!c) return;
  autoShown.add(c.id);
  watchBrowser(ctx, c.id);
}
const AUTO_KEY = 'vb.autoWatch';
export function autoWatchOn(): boolean {try {return localStorage.getItem(AUTO_KEY) !== 'off';} catch {return true;}}
export function setAutoWatch(on: boolean) {try {localStorage.setItem(AUTO_KEY, on ? 'on' : 'off');} catch {/* a private window keeps the default */}}

/** Bring the screen in line with the latest state. Cheap and idempotent; called after every render. */
export function updateLive(ctx: Ctx) {
  current = ctx;
  if (!view) return;
  if (!watching) {view.root.hidden = true; return;}
  view.root.hidden = false;
  const c = ctx.state.computer.find(x => x.id === watching);
  const running = !!c && RUNNING.has(c.status);
  const working = running && c!.status === 'working';
  const src = working ? c!.liveEmbed ?? '' : '';
  const yours = working && c!.control === 'owner';
  show(src);

  view.frame.hidden = !src;
  view.shield.hidden = !src || yours;
  view.take.hidden = !src || yours;
  view.give.hidden = !yours;
  view.stop.hidden = !running;
  view.stop.textContent = c?.lingerUntil ? 'Close browser' : 'Stop';
  for (const b of [view.take, view.give, view.stop]) b.disabled = busy;

  let status: string, message = '', note = '';
  if (!c) {status = 'This browser session has ended.';}
  else if (!running) {status = ENDED[c.status] ?? 'This browser session has ended.';}
  else if (!working) {status = c.status === 'cleanup_pending' ? 'Stopping…' : 'Starting a browser…';}
  else if (yours) {status = "You're in control. Your employee is paused until you hand it back."; note = "Anything you type goes to that website. Hand back when you're done.";}
  else if (src && disconnected) {status = 'The live view lost its connection to the browser.'; note = 'The browser may have closed. Stop ends the whole task.';}
  else if (src && c.lingerUntil) {status = 'Task finished. The browser stays open a few minutes: look around or take over.'; note = 'Close browser ends it now.';}
  else if (src) {const step = latestStep(ctx, c); status = step ? `Your employee is browsing: ${step}` : 'Your employee is browsing. Tap Take over to use it yourself.'; note = step ? 'Tap Take over to use it yourself. Stop ends the whole task.' : 'Stop ends the whole task.';}
  else if (c.liveHost) {status = 'Your employee is browsing.'; message = `Its live view comes from ${c.liveHost}, which this app is not set up to show.`; note = 'Whoever runs your server can allow it with BROWSER_LIVE_VIEW_HOSTS.';}
  else {status = 'Your employee is browsing.'; message = 'Waiting for the live view…';}
  view.status.textContent = status;
  view.message.textContent = message;
  view.message.hidden = !message;
  view.note.textContent = note;

  // Typing should land in the website the moment control is really yours.
  if (yours && lastControl !== 'owner') view.frame.focus();
  lastControl = c?.control;
}
