import {api, type Row, type Run} from '../api';
import {h} from '../dom';
import {canResume, isTerminal, money, relativeTime, runArtifacts, runTitle, sortRuns, STATUS_LABEL, unreconciledActions} from '../store';
import {materialSection} from './offers';
import {richText} from '../rich';
import type {Ctx} from './ctx';

export function tasks(ctx: Ctx): HTMLElement {
  const runs = sortRuns(ctx.state.run);
  if (!runs.length) return h('div', {class: 'screen'}, h('section', {class: 'card'}, h('h3', {text: 'No tasks yet'}), h('p', {class: 'note', text: 'Anything you ask for shows up here with its result and evidence.'})));
  return h('div', {class: 'screen'}, ...runs.map(run => taskCard(ctx, run)));
}

function taskCard(ctx: Ctx, run: Run): HTMLElement {
  const evidence = runArtifacts(ctx.state.artifact, run.id);
  const stuck = unreconciledActions(ctx.state.action, run.id);
  return h('section', {class: 'card'},
    h('p', {class: 'eyebrow', text: `${STATUS_LABEL[run.status]} · ${relativeTime(run.completedAt ?? run.createdAt)}`}),
    h('h3', {text: runTitle(run)}),
    run.result ? h('p', {class: 'result-text'}, ...richText(run.result)) : null,
    run.error ? h('p', {class: 'note', text: run.error}) : null,
    stuck.length ? reconcilePanel(ctx, stuck[0]!.id, !isTerminal(run)) : null,
    // A supplier comparison belongs with the task that asked for it, so the
    // request, the prices and who was searched read as one thing.
    ...ctx.state.order.filter(o => o.runId === run.id).map(orderView),
    ...ctx.state.material.filter(m => m.runId === run.id).map(m => materialSection(m, ctx.state.offer.filter(o => o.requestId === m.id))),
    evidence.length ? h('div', {class: 'row wrap'}, ...evidence.map(a =>
      // Evidence opens in a new tab; the gateway serves it sandboxed with a
      // no-script CSP of its own, so an uploaded file cannot run in this origin.
      h('a', {class: 'chip', href: api.artifactUrl(a.id), target: '_blank', rel: 'noopener noreferrer', text: a.name || a.kind}))) : null,
    h('div', {class: 'row'},
      !isTerminal(run) ? h('button', {class: 'ghost danger', onclick: async () => {try {await api.cancel(run.id); await ctx.refresh();} catch (e) {ctx.toast(e instanceof Error ? e.message : 'Could not stop that.');}}}, 'Stop') : null,
      canResume(run, ctx.state.action) ? h('button', {class: 'ghost', onclick: async () => {try {await api.resume(run.id); await ctx.refresh();} catch (e) {ctx.toast(e instanceof Error ? e.message : 'Could not resume.');}}}, 'Resume') : null,
    ),
  );
}

// A restart can leave an external action whose outcome the server cannot know.
// It is never retried automatically; the person states what actually happened
// and that statement is stored as the evidence.
function reconcilePanel(ctx: Ctx, actionId: string, resumable: boolean): HTMLElement {
  const field = h('textarea', {class: 'composer', rows: 2, placeholder: 'What actually happened? (at least 10 characters)', 'aria-label': 'What actually happened', 'data-key': `reconcile:${actionId}`});
  return h('div', {class: 'reconcile'},
    h('p', {class: 'note', text: `This task started something outside the server and the result is unknown. Check it, then record what happened${resumable ? ' before resuming' : ''}.`}),
    field,
    h('button', {class: 'primary', onclick: async () => {
      try {await api.reconcile(actionId, field.value.trim()); await ctx.refresh();}
      catch (e) {ctx.toast(e instanceof Error ? e.message : 'That could not be recorded.');}
    }}, 'Record outcome'),
  );
}

// A placed order is what a purchase task has to show plainly: from whom, which
// order, for how much, how it arrives, and the supplier's own receipt. The
// receipt link comes from the supplier, so only an https one is offered.
function orderView(order: Row): HTMLElement {
  const receipt = typeof order.receiptUrl === 'string' && /^https:\/\//i.test(order.receiptUrl) ? order.receiptUrl : null;
  return h('div', {class: 'order'},
    h('p', {class: 'eyebrow', text: 'Order placed'}),
    h('p', {class: 'task', text: `${order.supplier} · order ${order.orderNumber}`}),
    h('p', {class: 'note', text: [money(Number(order.total), String(order.currency ?? 'USD')), order.status, order.fulfillment].filter(Boolean).join(' · ')}),
    receipt ? h('a', {class: 'chip', href: receipt, target: '_blank', rel: 'noopener noreferrer', text: 'Receipt'}) : null,
  );
}
