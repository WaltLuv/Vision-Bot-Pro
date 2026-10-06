import {z} from 'zod';import {connector} from './composio.js';
/**
 * Recurring routines: "every weekday morning, check Gmail for owner emails and summarise anything urgent". A routine
 * is a workflow with a repeat rule and a delivery. Each due run is an ordinary queued task, so it goes through the
 * same runtime, ToolGateway and approvals as anything typed on the phone; a delivery to an app is a send that waits
 * for the owner like any other.
 */
export const WEEKDAYS=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'] as const;
export const repeatSchema=z.object({frequency:z.enum(['daily','weekdays','weekly']),time:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),weekday:z.enum(WEEKDAYS).optional(),timezone:z.string().max(64).default('UTC')})
 .refine(r=>r.frequency!=='weekly'||!!r.weekday,{message:'A weekly routine needs a day'})
 .refine(r=>{try{new Intl.DateTimeFormat('en-US',{timeZone:r.timezone});return true;}catch{return false;}},{message:'Unknown time zone'});
export type Repeat=z.infer<typeof repeatSchema>;
export const DELIVERIES=['chat','gmail','outlook','slack','googlecalendar','notion','googlesheets','googledocs','microsoftteams','discord'] as const;
export type Delivery=typeof DELIVERIES[number];

/** Where a routine's result should land, read from how the owner phrased it. No destination means the app itself. */
export function inferDelivery(text:string):Delivery{
 const t=text.toLowerCase();
 const rules:[RegExp,Delivery][]=[[/\bslack\b/,'slack'],[/\b(microsoft )?teams\b/,'microsoftteams'],[/\bdiscord\b/,'discord'],[/\bnotion\b/,'notion'],[/\b(google )?sheets?\b|\bspreadsheet\b/,'googlesheets'],[/\bgoogle docs?\b/,'googledocs'],[/\boutlook\b/,'outlook'],
  [/\b(email|e-mail|mail|gmail)\s+(me|it|this|the)\b|\b(send|deliver)\b.*\b(email|e-mail|gmail|inbox)\b/,'gmail'],[/\b(add|put|create|schedule)\b.*\b(calendar|event|meeting)\b|\bcalendar\b.*\b(event|invite)\b/,'googlecalendar']];
 return rules.find(([re])=>re.test(t))?.[1]??'chat';
}

/** The task text a due run carries: the owner's request, plus where to put the result when it is not the app. */
export function routineTask(task:string,delivery:Delivery){
 if(delivery==='chat')return task;
 const app=connector(delivery);
 return `${task}\n\nWhen the result is ready, deliver it with ${app?.name??delivery} (a connected app): find the right action with app_actions_search, then use app_send, or app_update for a calendar event, sheet, doc or page. The owner approves each delivery. If ${app?.name??delivery} is not connected, say so in the result instead.`;
}

// Wall-clock parts of an instant in a time zone.
function parts(at:number,timeZone:string){const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',weekday:'long'}).formatToParts(new Date(at)).map(x=>[x.type,x.value]));return {y:+p.year,m:+p.month,d:+p.day,h:+p.hour,min:+p.minute,weekday:String(p.weekday).toLowerCase()};}
// The instant a wall-clock time happens in a zone. Two passes settle the offset across a daylight-saving change.
function instant(y:number,m:number,d:number,h:number,min:number,timeZone:string){let guess=Date.UTC(y,m-1,d,h,min);for(let i=0;i<2;i++){const p=parts(guess,timeZone);guess-=Date.UTC(p.y,p.m-1,p.d,p.h,p.min)-Date.UTC(y,m-1,d,h,min);}return guess;}
/** The first time strictly after `after` that the rule fires. */
export function nextRun(rule:Repeat,after=Date.now()):string{
 const [h,min]=rule.time.split(':').map(Number);
 for(let day=0;day<=8;day++){const p=parts(after+day*86_400_000,rule.timezone),at=instant(p.y,p.m,p.d,h,min,rule.timezone),wd=parts(at,rule.timezone).weekday;
  if(at<=after)continue;
  if(rule.frequency==='weekdays'&&['saturday','sunday'].includes(wd))continue;
  if(rule.frequency==='weekly'&&wd!==rule.weekday)continue;
  return new Date(at).toISOString();}
 throw Error('Unable to schedule this routine');
}
export function describeRepeat(rule:Repeat){const [h,m]=rule.time.split(':').map(Number),time=`${h%12||12}:${String(m).padStart(2,'0')} ${h<12?'AM':'PM'}`;return rule.frequency==='daily'?`Every day at ${time}`:rule.frequency==='weekdays'?`Weekdays at ${time}`:`Every ${rule.weekday![0].toUpperCase()+rule.weekday!.slice(1)} at ${time}`;}
