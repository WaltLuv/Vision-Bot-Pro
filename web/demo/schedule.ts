// Routines in the preview follow the gateway's own rules (gateway/src/employee/schedule.ts): the same repeat
// rules, the same next-run arithmetic across time zones and daylight-saving changes, and the same wording. Only
// the delivery differs: the preview can reach the owner's Gmail and Google Calendar, and nothing else.
import type {Delivery, Repeat} from '../src/api';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
export const DELIVERIES: Delivery[] = ['chat', 'gmail', 'outlook', 'slack', 'googlecalendar', 'notion', 'googlesheets', 'googledocs', 'microsoftteams', 'discord'];
const APP_NAME: Record<Delivery, string> = {chat: 'the app', gmail: 'Gmail', outlook: 'Outlook', slack: 'Slack', googlecalendar: 'Google Calendar', notion: 'Notion',
  googlesheets: 'Google Sheets', googledocs: 'Google Docs', microsoftteams: 'Microsoft Teams', discord: 'Discord'};

/** A repeat rule as the gateway accepts it, or null. */
export function validRepeat(value: unknown): Repeat | null {
  const r = value as Partial<Repeat> | null;
  if (!r || !['daily', 'weekdays', 'weekly'].includes(String(r.frequency))) return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(r.time))) return null;
  if (r.frequency === 'weekly' && !WEEKDAYS.includes(String(r.weekday))) return null;
  const timezone = String(r.timezone || 'UTC').slice(0, 64);
  try {new Intl.DateTimeFormat('en-US', {timeZone: timezone});} catch {return null;}
  return {frequency: r.frequency!, time: r.time!, timezone, ...(r.frequency === 'weekly' ? {weekday: r.weekday} : {})};
}

/** Where a routine's result should land, read from how the owner phrased it. No destination means the app itself. */
export function inferDelivery(text: string): Delivery {
  const t = text.toLowerCase();
  const rules: [RegExp, Delivery][] = [[/\bslack\b/, 'slack'], [/\b(microsoft )?teams\b/, 'microsoftteams'], [/\bdiscord\b/, 'discord'], [/\bnotion\b/, 'notion'],
    [/\b(google )?sheets?\b|\bspreadsheet\b/, 'googlesheets'], [/\bgoogle docs?\b/, 'googledocs'], [/\boutlook\b/, 'outlook'],
    [/\b(email|e-mail|mail|gmail)\s+(me|it|this|the)\b|\b(send|deliver)\b.*\b(email|e-mail|gmail|inbox)\b/, 'gmail'],
    [/\b(add|put|create|schedule)\b.*\b(calendar|event|meeting)\b|\bcalendar\b.*\b(event|invite)\b/, 'googlecalendar']];
  return rules.find(([re]) => re.test(t))?.[1] ?? 'chat';
}

/** The task a due run carries: the owner's request, plus where to put the result when it is not the app. */
export function routineTask(task: string, delivery: Delivery): string {
  if (delivery === 'chat') return task;
  const how = delivery === 'gmail' ? 'save it as a Gmail draft with draft_email, addressed to the owner if you know their address'
    : delivery === 'googlecalendar' ? 'add it to Google Calendar with add_calendar_event'
    : `deliver it with ${APP_NAME[delivery]}`;
  return `${task}\n\nWhen the result is ready, ${how}. The owner approves each delivery. If ${APP_NAME[delivery]} is not connected, say so in the result instead.`;
}

// Wall-clock parts of an instant in a time zone.
function parts(at: number, timeZone: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'long'})
    .formatToParts(new Date(at)).map(x => [x.type, x.value]));
  return {y: +p.year!, m: +p.month!, d: +p.day!, h: +p.hour!, min: +p.minute!, weekday: String(p.weekday).toLowerCase()};
}
// The instant a wall-clock time happens in a zone. Two passes settle the offset across a daylight-saving change.
function instant(y: number, m: number, d: number, h: number, min: number, timeZone: string) {
  let guess = Date.UTC(y, m - 1, d, h, min);
  for (let i = 0; i < 2; i++) {const p = parts(guess, timeZone); guess -= Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - Date.UTC(y, m - 1, d, h, min);}
  return guess;
}

/** The first time strictly after `after` that the rule fires. */
export function nextRun(rule: Repeat, after = Date.now()): string {
  const [h, min] = rule.time.split(':').map(Number) as [number, number];
  for (let day = 0; day <= 8; day++) {
    const p = parts(after + day * 86_400_000, rule.timezone), at = instant(p.y, p.m, p.d, h, min, rule.timezone), wd = parts(at, rule.timezone).weekday;
    if (at <= after) continue;
    if (rule.frequency === 'weekdays' && ['saturday', 'sunday'].includes(wd)) continue;
    if (rule.frequency === 'weekly' && wd !== rule.weekday) continue;
    return new Date(at).toISOString();
  }
  throw new Error('Unable to schedule this routine');
}

export function describeRepeat(rule: Repeat): string {
  const [h, m] = rule.time.split(':').map(Number) as [number, number];
  const time = `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  return rule.frequency === 'daily' ? `Every day at ${time}` : rule.frequency === 'weekdays' ? `Weekdays at ${time}`
    : `Every ${rule.weekday!.charAt(0).toUpperCase() + rule.weekday!.slice(1)} at ${time}`;
}
