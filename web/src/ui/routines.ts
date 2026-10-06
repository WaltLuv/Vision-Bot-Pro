import {api, newIdempotencyKey, type Delivery, type Repeat, type Workflow} from '../api';
import {h} from '../dom';
import {forgetEdits} from '../fields';
import {STATUS_LABEL} from '../store';
import type {Ctx} from './ctx';

export const DELIVERY_LABEL: Record<Delivery, string> = {
  chat: 'Here in the app', gmail: 'Gmail', outlook: 'Outlook', slack: 'Slack', googlecalendar: 'Google Calendar',
  notion: 'Notion', googlesheets: 'Google Sheets', googledocs: 'Google Docs', microsoftteams: 'Microsoft Teams', discord: 'Discord',
};
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface Idea {key: string; name: string; blurb: string; task: string; repeat: Omit<Repeat, 'timezone'>; delivery: Delivery}
/** Starting points for routines that suit field and property work. Each one fills the form; nothing runs until it is saved. */
export const IDEAS: Idea[] = [
  {key: 'gmail-digest', name: 'Morning email digest', blurb: 'Urgent owner and tenant email, summarised before you head out.', delivery: 'chat',
    task: 'Check my Gmail for emails from property owners, tenants and vendors since yesterday morning. Summarise anything urgent first, then list what needs a reply.', repeat: {frequency: 'weekdays', time: '07:30'}},
  {key: 'site-day', name: 'Today\'s site visits', blurb: 'Inspections and visits from your calendar, with addresses and prep notes.', delivery: 'chat',
    task: 'Look at today\'s Google Calendar and list each inspection, showing or site visit with its time, address and anything I should bring or prepare.', repeat: {frequency: 'weekdays', time: '07:00'}},
  {key: 'vendor-followup', name: 'Vendor follow-up', blurb: 'Draft follow-ups to vendors who have not confirmed a visit.', delivery: 'gmail',
    task: 'Review open work orders and my recent email. For each vendor who has not confirmed a visit, draft a short, polite follow-up email asking them to confirm a time.', repeat: {frequency: 'weekly', time: '09:00', weekday: 'monday'}},
  {key: 'slack-status', name: 'Weekly team update', blurb: 'A property status update posted to your maintenance channel.', delivery: 'slack',
    task: 'Write the weekly property status update: work orders opened and closed, anything overdue, and next week\'s inspections. Post it to the maintenance Slack channel.', repeat: {frequency: 'weekly', time: '16:00', weekday: 'friday'}},
  {key: 'notion-log', name: 'Inspection log', blurb: 'Today\'s inspections and findings, logged in Notion.', delivery: 'notion',
    task: 'Log today\'s completed inspections in Notion, one entry each with the property, what was found, photos taken and follow-ups needed.', repeat: {frequency: 'weekdays', time: '18:00'}},
  {key: 'sheet-tracker', name: 'Maintenance tracker', blurb: 'Keep the maintenance sheet current with new and closed work orders.', delivery: 'googlesheets',
    task: 'Update my maintenance tracker Google Sheet with work orders opened and completed today, including property, issue, vendor and status.', repeat: {frequency: 'weekdays', time: '17:30'}},
  {key: 'owner-report', name: 'Owner report draft', blurb: 'A weekly report per owner, drafted as a Google Doc.', delivery: 'googledocs',
    task: 'Draft this week\'s owner report as a Google Doc: work completed with costs, open issues, upcoming inspections and anything that needs the owner\'s decision.', repeat: {frequency: 'weekly', time: '10:00', weekday: 'friday'}},
  {key: 'price-watch', name: 'Material price watch', blurb: 'Prices and stock for materials on open jobs, with big changes flagged.', delivery: 'chat',
    task: 'Check current prices and stock for the materials on my open jobs at connected suppliers. Flag any price change over 10% or anything out of stock near me.', repeat: {frequency: 'weekdays', time: '06:30'}},
];

function workflowCard(ctx: Ctx, w: Workflow): HTMLElement {
  const run = async () => {
    try {await api.runWorkflow(w.id, newIdempotencyKey()); ctx.toast(`Started "${w.name}".`); await ctx.refresh();}
    catch (err) {ctx.toast(err instanceof Error ? err.message : 'That routine did not start.');}
  };
  const toggle = async () => {
    try {await api.setWorkflowEnabled(w.id, !w.enabled); await ctx.refresh();}
    catch (err) {ctx.toast(err instanceof Error ? err.message : 'That change did not go through.');}
  };
  const remove = async () => {
    if (!confirm(`Delete the routine "${w.name}"?`)) return;
    try {await api.removeWorkflow(w.id); await ctx.refresh();}
    catch (err) {ctx.toast(err instanceof Error ? err.message : 'That routine was not deleted.');}
  };
  const when = w.repeat
    ? `${w.schedule ?? 'Repeats'}${w.enabled && w.nextRunAt ? ` · next ${new Date(w.nextRunAt).toLocaleString(undefined, {weekday: 'short', hour: 'numeric', minute: '2-digit'})}` : ''}`
    : w.scheduledAt ? `Once, ${new Date(w.scheduledAt).toLocaleString()}` : 'Runs when you ask';
  return h('section', {class: 'card routine', 'data-workflow': w.id},
    h('p', {class: 'eyebrow', text: w.repeat && !w.enabled ? 'Paused' : `Delivers to ${DELIVERY_LABEL[w.delivery ?? 'chat']}`}),
    h('h3', {text: w.name}),
    h('p', {class: 'note', text: when}),
    h('p', {class: 'note', text: w.task}),
    w.lastRunStatus ? h('p', {class: 'note', text: `Last run: ${STATUS_LABEL[w.lastRunStatus] ?? w.lastRunStatus}${w.lastRunSummary ? ` · ${w.lastRunSummary}` : ''}`}) : null,
    w.delivery && w.delivery !== 'chat' ? h('p', {class: 'note', text: `Each delivery to ${DELIVERY_LABEL[w.delivery]} waits for your approval.`}) : null,
    h('div', {class: 'row wrap'},
      h('button', {class: 'primary', onclick: () => void run()}, 'Run now'),
      w.repeat ? h('button', {class: 'ghost', onclick: () => void toggle()}, w.enabled ? 'Pause' : 'Resume') : null,
      h('button', {class: 'ghost danger', onclick: () => void remove()}, 'Delete')),
  );
}

function select(label: string, options: [string, string][], value: string) {
  const el = h('select', {class: 'field', 'aria-label': label}, ...options.map(([v, text]) => h('option', {value: v, text})));
  el.value = value;
  return el;
}

/** Routines: Muse-style recurring goals ("every Friday, post the status to Slack"), run by your own server's scheduler. */
export function routines(ctx: Ctx): HTMLElement {
  const name = h('input', {class: 'field', 'aria-label': 'Routine name', placeholder: 'Morning email digest'});
  const task = h('textarea', {class: 'composer', rows: 3, 'aria-label': 'What it should do', placeholder: 'Check my Gmail for owner emails and summarise anything urgent'});
  const frequency = select('How often', [['weekdays', 'Weekdays'], ['daily', 'Every day'], ['weekly', 'Once a week']], 'weekdays');
  const weekday = select('Which day', WEEKDAYS.map(d => [d, cap(d)]), 'monday');
  const time = h('input', {class: 'field', type: 'time', 'aria-label': 'Time', value: '08:00'});
  const delivery = select('Deliver to', (Object.keys(DELIVERY_LABEL) as Delivery[]).map(d => [d, DELIVERY_LABEL[d]]), 'chat');
  let template: string | undefined;

  const use = (idea: Idea) => {
    template = idea.key;
    name.value = idea.name; task.value = idea.task; frequency.value = idea.repeat.frequency; time.value = idea.repeat.time;
    weekday.value = idea.repeat.weekday ?? 'monday'; delivery.value = idea.delivery;
    // Filled in for the owner, so it is theirs now: a background refresh must not wipe it.
    for (const el of [name, task, frequency, time, weekday, delivery]) el.dataset.edited = '1';
    name.scrollIntoView?.({behavior: 'smooth', block: 'center'});
  };

  const save = async () => {
    if (!name.value.trim() || !task.value.trim()) {ctx.toast('Give the routine a name and say what it should do.'); return;}
    if (!/^\d{2}:\d{2}$/.test(time.value)) {ctx.toast('Choose a time.'); return;}
    const repeat: Repeat = {frequency: frequency.value as Repeat['frequency'], time: time.value, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      ...(frequency.value === 'weekly' ? {weekday: weekday.value} : {})};
    try {
      const w = await api.addRoutine({name: name.value.trim(), task: task.value.trim(), repeat, delivery: delivery.value as Delivery, ...(template ? {template} : {})});
      forgetEdits();
      ctx.toast(`Saved. ${w.schedule ?? ''}`.trim());
      await ctx.refresh();
    } catch (err) {
      ctx.toast(err instanceof Error ? err.message : 'That routine was not saved.');
    }
  };

  const workflows = ctx.state.workflow;
  const needsApps = !ctx.connections?.apps;
  return h('div', {class: 'screen'},
    ...workflows.map(w => workflowCard(ctx, w)),
    h('section', {class: 'card'},
      h('h3', {text: workflows.length ? 'New routine' : 'Set up a routine'}),
      h('p', {class: 'note', text: 'Something your employee does on a schedule. It runs on your server, so your phone can be off.'}),
      h('label', {class: 'label', text: 'Name'}), name,
      h('label', {class: 'label', text: 'What it should do'}), task,
      h('div', {class: 'row wrap'}, frequency, weekday, time),
      h('label', {class: 'label', text: 'Deliver to'}), delivery,
      needsApps ? h('p', {class: 'note', text: 'Delivering to an app needs connected apps, which are not set up on this server yet. Results always appear here.'}) : null,
      h('div', {class: 'row'}, h('button', {class: 'primary', onclick: () => void save()}, 'Save routine')),
    ),
    h('section', {class: 'card'},
      h('h3', {text: 'Ideas'}),
      ...IDEAS.map(idea => h('div', {class: 'row-item idea', 'data-idea': idea.key},
        h('p', {class: 'task', text: idea.name}),
        h('button', {class: 'ghost', onclick: () => use(idea)}, 'Use this'),
        h('p', {class: 'note', text: `${idea.blurb} ${DELIVERY_LABEL[idea.delivery] === DELIVERY_LABEL.chat ? '' : `Delivers to ${DELIVERY_LABEL[idea.delivery]}.`}`.trim()}))),
    ),
  );
}
