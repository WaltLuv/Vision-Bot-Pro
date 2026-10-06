import {api, type Run} from '../api';
import {h} from '../dom';
import {isTerminal} from '../store';
import {richText} from '../rich';
import type {Ctx} from './ctx';

/**
 * What the employee is doing right now, as it happens: the steps so far, the newest one live, and what the quick
 * search turned up before the full answer. A task that only says "Working" for half a minute feels broken even
 * when it is not; one that says "Opening homedepot.com…" a second after you asked does not.
 */
export function steps(run: Run): HTMLElement | null {
  const list = run.progress ?? [];
  // Before the first step arrives, say the task was received, so a tap is never met with nothing.
  const shown = list.length ? list : isTerminal(run) ? [] : [{at: run.createdAt ?? '', text: run.status === 'queued' ? 'Received' : 'Working on it'}];
  if (!shown.length) return null;
  const live = !isTerminal(run);
  return h('ol', {class: 'steps', 'aria-label': 'Progress'},
    ...shown.map((s, i) => h('li', {class: live && i === shown.length - 1 ? 'now' : 'done', text: s.text})));
}

const httpsOnly = (url: string) => {try {return new URL(url).protocol === 'https:' ? url : null;} catch {return null;}};
const host = (url: string) => {try {return new URL(url).hostname.replace(/^www\./, '');} catch {return url;}};

/** Early findings: the quick search's answer and its sources, shown while the employee checks them. */
export function findings(run: Run): HTMLElement | null {
  if (run.status === 'completed' || (!run.preview && !run.findings?.sources?.length)) return null;
  const sources = (run.findings?.sources ?? []).slice(0, 4);
  return h('div', {class: 'findings'},
    h('p', {class: 'eyebrow', text: 'Early findings'}),
    run.preview ? h('p', {class: 'result-text'}, ...richText(run.preview.length > 500 ? `${run.preview.slice(0, 500)}…` : run.preview)) : null,
    sources.length ? h('div', {class: 'sources'}, ...sources.map(s => {
      const url = httpsOnly(s.url);
      // A source opens in its own tab; one that is not https is shown, not linked.
      return url
        ? h('a', {class: 'source', href: url, target: '_blank', rel: 'noopener noreferrer'}, h('span', {class: 'source-host', text: host(url)}), h('span', {text: s.title || host(url)}))
        : h('span', {class: 'source', text: s.title || s.url});
    })) : null,
    h('p', {class: 'note', text: 'From a quick search. Your employee is checking these; the full answer follows.'}),
  );
}

const minutesLeft = (until: number) => Math.max(1, Math.round((until - Date.now()) / 60_000));

/** The live browser, as a card: what it is doing, and one tap to watch, take over or close it. */
export function liveBrowserCard(ctx: Ctx): HTMLElement | null {
  const open = ctx.state.computer.filter(x => ['queued', 'starting', 'working'].includes(x.status));
  const c = open.find(x => !x.lingerUntil) ?? open[0];
  if (!c) return null;
  const run = ctx.state.run?.find(r => r.id === c.runId);
  const latest = run?.progress?.at(-1)?.text;
  const yours = c.control === 'owner', after = !!c.lingerUntil;
  const close = async () => {
    try {await api.stopComputer(c.id); await ctx.refresh();}
    catch (err) {ctx.toast(err instanceof Error ? err.message : 'Could not close the browser.');}
  };
  return h('section', {class: `card live-card ${after ? '' : 'active'}`},
    h('p', {class: 'eyebrow', text: yours ? 'You have the browser' : after ? 'Task finished' : c.status === 'working' ? 'Live browser' : 'Starting a live browser…'}),
    h('h3', {text: c.task}),
    h('p', {class: 'note', text: after
      ? `It stays open about ${minutesLeft(c.lingerUntil!)} more minute${minutesLeft(c.lingerUntil!) === 1 ? '' : 's'}, so you can look around or take over.`
      : latest ?? 'Your employee is getting the browser ready.'}),
    c.session === 'account' ? h('p', {class: 'note', text: 'Using your saved sign-ins.'}) : null,
    h('div', {class: 'row wrap'},
      h('button', {class: 'primary', disabled: c.status !== 'working', onclick: () => ctx.watch(c.id)}, yours ? 'Back to the browser' : 'Watch it browse'),
      after ? h('button', {class: 'ghost', onclick: () => void close()}, 'Close browser') : null),
  );
}
