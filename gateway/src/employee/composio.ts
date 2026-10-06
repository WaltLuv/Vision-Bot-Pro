import {createHash} from 'node:crypto';import {z} from 'zod';
import {Store,type Row} from './db.js';import {Refused,ToolGateway} from './tools.js';import {publicUrl} from './config.js';import {redactText} from './redact.js';
/**
 * Connected apps through Composio: the owner links Gmail, Slack, Calendar and the rest once, and the employee then
 * acts on them through the same governed ToolGateway as every other capability. The model never sees the Composio
 * key or an account id; it names an app and an action, and this module checks both, classifies the action's effect
 * from its name, and runs it against the owner's own pinned account. Anything that is not a plain read waits for
 * an approval of its exact arguments, every time.
 *
 * Plain REST rather than the SDK, like the other adapters here: one injectable fetch to test against, nothing
 * extra bundled. COMPOSIO_API_BASE is overridable for a proxy and for testing against a stand-in.
 */
export type ConnectorStatus='not_connected'|'pending'|'connected'|'failed'|'revoked';
export type Category='Email'|'Calendar'|'Messaging'|'Documents'|'Social';
export interface Connector{id:string;name:string;toolkit:string;category:Category;description:string}
export const connectors:Connector[]=[
 {id:'gmail',name:'Gmail',toolkit:'gmail',category:'Email',description:'Read and send email through your Gmail account.'},
 {id:'outlook',name:'Outlook',toolkit:'outlook',category:'Email',description:'Read and send email through your Outlook account.'},
 {id:'googlecalendar',name:'Google Calendar',toolkit:'googlecalendar',category:'Calendar',description:'Check your schedule and add the events you approve.'},
 {id:'slack',name:'Slack',toolkit:'slack',category:'Messaging',description:'Read channel context and send the team updates you approve.'},
 {id:'microsoftteams',name:'Microsoft Teams',toolkit:'microsoft_teams',category:'Messaging',description:'Read and send Teams messages you approve.'},
 {id:'discord',name:'Discord',toolkit:'discord',category:'Messaging',description:'Read servers and post the messages you approve.'},
 {id:'notion',name:'Notion',toolkit:'notion',category:'Documents',description:'Search pages and keep inspection or job logs.'},
 {id:'googlesheets',name:'Google Sheets',toolkit:'googlesheets',category:'Documents',description:'Read and update trackers such as a maintenance log.'},
 {id:'googledocs',name:'Google Docs',toolkit:'googledocs',category:'Documents',description:'Read documents and draft reports.'},
 {id:'instagram',name:'Instagram',toolkit:'instagram',category:'Social',description:'Read your account and post what you approve.'},
 {id:'youtube',name:'YouTube',toolkit:'youtube',category:'Social',description:'Read your channel and videos.'},
];
const ids=connectors.map(c=>c.id) as [string,...string[]];
export const connector=(id:string)=>connectors.find(c=>c.id===id);
export const composioEnabled=()=>!!process.env.COMPOSIO_API_KEY&&process.env.COMPOSIO_ENABLED!=='false';
/** The id Composio knows this owner by: stable, and not their email address. */
export const composioUser=(owner:string)=>'vb_'+createHash('sha256').update('composio:'+owner).digest('hex').slice(0,32);
const recordId=(owner:string,id:string)=>createHash('sha256').update(`connector:${owner}:${id}`).digest('hex');

export type ActionKind='read'|'write'|'communication'|'destructive'|'financial';
const has=(words:string[],list:string)=>words.some(w=>list.split('|').includes(w));
/**
 * What an action does, from its slug (GMAIL_SEND_EMAIL, GOOGLECALENDAR_DELETE_EVENT). Strongest effect wins, so
 * GMAIL_MOVE_TO_TRASH is destructive although MOVE alone is a write, and an action whose verb is not recognised
 * is a write: it waits for approval rather than being trusted as a read.
 */
export function actionKind(slug:string,toolkit:string):ActionKind{
 const words=slug.slice(toolkit.length+1).split('_');
 if(has(words,'PAY|PAYMENT|PAYOUT|PURCHASE|CHARGE|REFUND|TRANSFER|CHECKOUT|BUY|INVOICE'))return 'financial';
 if(has(words,'DELETE|REMOVE|TRASH|ARCHIVE|PURGE|CLEAR|REVOKE|BAN|KICK|DESTROY|ERASE|UNSUBSCRIBE|LEAVE|CANCEL|EMPTY'))return 'destructive';
 if(has(words,'SEND|SENDS|REPLY|FORWARD|POST|POSTS|INVITE|SHARE|PUBLISH|NOTIFY|BROADCAST|DM'))return 'communication';
 if(has(words,'CREATE|CREATES|UPDATE|UPDATES|ADD|ADDS|INSERT|PATCH|SET|MODIFY|EDIT|UPLOAD|APPEND|MOVE|COPY|RENAME|DRAFT|MARK|STAR|LABEL|APPLY|ACCEPT|DECLINE|RESPOND|SCHEDULE|WRITE|REPLACE|MERGE|JOIN|PIN|REACT|SUBSCRIBE|IMPORT|QUICK'))return 'write';
 if(has(words,'LIST|GET|GETS|FETCH|FETCHES|SEARCH|SEARCHES|FIND|FINDS|READ|RETRIEVE|RETRIEVES|QUERY|LOOKUP|COUNT|DESCRIBE|CHECK|VIEW|DOWNLOAD|EXPORT'))return 'read';
 return 'write';
}

export class ComposioError extends Error{constructor(readonly status:number,message:string){super(message);}}
export class ComposioClient{
 constructor(readonly http:typeof fetch=fetch){}
 base(){return (process.env.COMPOSIO_API_BASE??'https://backend.composio.dev').replace(/\/$/,'');}
 async call(method:string,path:string,body?:unknown):Promise<any>{
  const key=process.env.COMPOSIO_API_KEY;if(!key||!composioEnabled())throw new Refused('Connected apps are not set up on this server');
  const r=await this.http(this.base()+path,{method,redirect:'error',signal:AbortSignal.timeout(30_000),headers:{'x-api-key':key,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
  const text=await r.text();let data:any={};try{data=text?JSON.parse(text):{};}catch{}
  // The provider's own message helps the owner fix a setup fault (a missing scope, a disabled auth config); it is
  // redacted and cut short because it is quoted back to a phone.
  if(!r.ok)throw new ComposioError(r.status,redactText(`Connected apps service returned HTTP ${r.status}${typeof data?.error?.message==='string'?': '+data.error.message.slice(0,200):''}`));
  return data;
 }
 async authConfig(toolkit:string,id:string):Promise<string>{
  const fixed=process.env[`COMPOSIO_${id.toUpperCase()}_AUTH_CONFIG_ID`];if(fixed)return fixed;
  const configs=await this.call('GET',`/api/v3.1/auth_configs?${new URLSearchParams({toolkit_slug:toolkit})}`);
  const match=(configs.items??[]).find((c:any)=>c.status!=='DISABLED'&&String(c.toolkit?.slug??'').toLowerCase()===toolkit);
  if(!match?.id)throw new Refused(`No Composio auth config is set up for ${toolkit}. Create one in the Composio dashboard or set COMPOSIO_${id.toUpperCase()}_AUTH_CONFIG_ID.`);
  return String(match.id);
 }
 link(owner:string,authConfigId:string,callback:string){return this.call('POST','/api/v3.1/connected_accounts/link',{auth_config_id:authConfigId,user_id:composioUser(owner),callback_url:callback});}
 async active(owner:string,toolkit:string):Promise<any[]>{return (await this.call('GET',`/api/v3.1/connected_accounts?${new URLSearchParams({user_ids:composioUser(owner),toolkit_slugs:toolkit,statuses:'ACTIVE'})}`)).items??[];}
 account(id:string){return this.call('GET',`/api/v3.1/connected_accounts/${encodeURIComponent(id)}`);}
 remove(id:string){return this.call('DELETE',`/api/v3.1/connected_accounts/${encodeURIComponent(id)}`);}
 async search(toolkit:string,query:string):Promise<any[]>{return (await this.call('GET',`/api/v3.1/tools?${new URLSearchParams({toolkit_slug:toolkit,limit:'10',...(query?{search:query}:{})})}`)).items??[];}
 execute(owner:string,slug:string,accountId:string,args:Record<string,unknown>){return this.call('POST',`/api/v3.1/tools/execute/${encodeURIComponent(slug)}`,{user_id:composioUser(owner),connected_account_id:accountId,arguments:args});}
}

const mapStatus=(s?:string):ConnectorStatus=>{const v=String(s??'').toUpperCase();return v==='ACTIVE'?'connected':['INITIATED','INITIALIZING'].includes(v)?'pending':v==='FAILED'?'failed':['EXPIRED','INACTIVE','REVOKED'].includes(v)?'revoked':'pending';};
const accountEmail=(a:any)=>[a?.data?.email,a?.params?.email,a?.data?.user_email,a?.state?.val?.email].find(v=>typeof v==='string'&&v.includes('@'))??null;
const accountLabel=(a:any)=>[a?.alias,a?.word_id,accountEmail(a)].find(v=>typeof v==='string'&&v)??null;
/** What the phone sees about a connection: never an account id or a provider URL beyond the one-time connect link. */
export const publicConnection=(c:Connector,r?:Row)=>({id:c.id,name:c.name,category:c.category,description:c.description,status:(r?.status??'not_connected') as ConnectorStatus,connectedLabel:r?.connectedLabel??null,connectedEmail:r?.connectedEmail??null,lastCheckedAt:r?.lastCheckedAt??null,connectedAt:r?.connectedAt??null});

export class Connectors{
 constructor(readonly db:Store,readonly client=new ComposioClient()){}
 get(owner:string,id:string){return this.db.get(owner,'connector_connection',recordId(owner,id));}
 list(owner:string){return connectors.map(c=>publicConnection(c,this.get(owner,c.id)));}
 private save(owner:string,c:Connector,patch:Record<string,unknown>){const prior=this.get(owner,c.id);return this.db.put(owner,'connector_connection',{createdAt:new Date().toISOString(),...prior,id:recordId(owner,c.id),provider:'composio',connectorId:c.id,toolkit:c.toolkit,...patch,lastCheckedAt:new Date().toISOString()});}
 private known(id:string){const c=connector(id);if(!c)throw new Refused('Unknown app');return c;}
 private connected(owner:string,c:Connector,account:any){const prior=this.get(owner,c.id);return this.save(owner,c,{status:'connected',connectedAccountId:String(account.id),connectionRequestId:null,connectedLabel:accountLabel(account),connectedEmail:accountEmail(account),connectedAt:prior?.status==='connected'?prior.connectedAt:new Date().toISOString()});}
 async connect(owner:string,id:string){
  const c=this.known(id),existing=(await this.client.active(owner,c.toolkit))[0];
  if(existing)return {...publicConnection(c,this.connected(owner,c,existing)),connectUrl:null};
  const link=await this.client.link(owner,await this.client.authConfig(c.toolkit,c.id),`${publicUrl()}/?connected=${encodeURIComponent(c.id)}`);
  const url=String(link.redirect_url??'');if(!/^https:\/\//.test(url))throw Error('The connected apps service did not return a sign-in link');
  const r=this.save(owner,c,{status:'pending',connectedAccountId:null,connectionRequestId:link.connected_account_id?String(link.connected_account_id):null,connectedLabel:null,connectedEmail:null});
  this.db.event(owner,'connector.updated',{connector:c.id,status:'pending'});return {...publicConnection(c,r),connectUrl:url};
 }
 async status(owner:string,id:string){
  const c=this.known(id),prior=this.get(owner,c.id),active=await this.client.active(owner,c.toolkit);
  // Prefer the account this owner already uses, so a second login elsewhere never silently swaps it.
  const account=active.find(a=>a.id===prior?.connectedAccountId||a.id===prior?.connectionRequestId)??active[0];
  let r:Row;
  if(account)r=this.connected(owner,c,account);
  else if(prior?.connectedAccountId||prior?.connectionRequestId){
   let found:any=null;try{found=await this.client.account(prior.connectedAccountId??prior.connectionRequestId);}catch(e){if(!(e instanceof ComposioError&&e.status===404))throw e;}
   const status=found?mapStatus(found.status):'revoked';
   r=status==='connected'?this.connected(owner,c,found):this.save(owner,c,{status,...(status==='pending'?{}:{connectedAccountId:null,connectionRequestId:null})});
  }else r=this.save(owner,c,{status:'not_connected'});
  if(r.status!==prior?.status)this.db.event(owner,'connector.updated',{connector:c.id,status:r.status});
  return publicConnection(c,r);
 }
 async disconnect(owner:string,id:string){
  const c=this.known(id),prior=this.get(owner,c.id),account=prior?.connectedAccountId??prior?.connectionRequestId;
  if(account)try{await this.client.remove(account);}catch(e){if(!(e instanceof ComposioError&&e.status===404))throw e;}
  const r=this.save(owner,c,{status:'revoked',connectedAccountId:null,connectionRequestId:null,connectedLabel:null,connectedEmail:null});
  this.db.event(owner,'connector.updated',{connector:c.id,status:'revoked'});return publicConnection(c,r);
 }
}

const MAX_RESULT=20_000;
const clip=(data:unknown)=>{const text=JSON.stringify(data??null);return text.length<=MAX_RESULT?data:{truncated:true,text:text.slice(0,MAX_RESULT)};};
const actionSchema=z.object({app:z.enum(ids),action:z.string().trim().regex(/^[A-Z][A-Z0-9_]{2,120}$/,'Use the action slug exactly as search returned it'),arguments:z.record(z.string(),z.unknown()).default({})});
const KINDS:{id:string;kind:Exclude<ActionKind,'financial'>;effect:'read'|'write'|'communication'|'destructive';title:string;description:string}[]=[
 {id:'app_read',kind:'read',effect:'read',title:'Read from a connected app',description:'Run a read-only action (list, get, search) in a connected app such as Gmail, Calendar, Slack, Notion or Sheets. Find the action with app_actions_search first.'},
 {id:'app_update',kind:'write',effect:'write',title:'Change data in a connected app',description:'Create or update something in a connected app (a calendar event, a draft, a sheet row, a Notion page). Needs the owner\'s approval of these exact arguments.'},
 {id:'app_send',kind:'communication',effect:'communication',title:'Send with a connected app',description:'Send, post or reply through a connected app (email, Slack, Teams, Discord). Needs the owner\'s approval of these exact arguments.'},
 {id:'app_delete',kind:'destructive',effect:'destructive',title:'Delete in a connected app',description:'Delete, archive or trash something in a connected app. Needs the owner\'s approval of these exact arguments.'},
];
export function registerComposio(t:ToolGateway,db:Store,conn=new Connectors(db)){
 t.register({id:'apps_connected',description:'List the owner\'s apps (Gmail, Slack, Google Calendar, Notion, Sheets, Docs, Outlook, Teams, Discord, Instagram, YouTube) and which ones are connected',effect:'read',schema:z.object({}),run:async(_a,c)=>conn.list(c.owner).map(({id,name,category,status,connectedLabel})=>({app:id,name,category,status,account:connectedLabel}))});
 t.register({id:'app_actions_search',description:'Find the actions a connected app offers for a use case. Returns each action slug, what it needs, and whether it reads, changes, sends or deletes',effect:'read',schema:z.object({app:z.enum(ids),query:z.string().trim().max(300).default('')}),run:async(a)=>{const c=connector(a.app)!;return (await conn.client.search(c.toolkit,a.query)).filter(x=>typeof x.slug==='string'&&x.slug.startsWith(c.toolkit.toUpperCase()+'_')).map(x=>({action:x.slug,name:x.name,description:String(x.description??'').slice(0,500),kind:actionKind(x.slug,c.toolkit),parameters:clip(x.input_parameters)}));}});
 for(const k of KINDS)t.register({id:k.id,title:k.title,description:k.description,effect:k.effect,alwaysAsk:k.kind!=='read',schema:actionSchema,run:async(a,c)=>{
  const app=connector(a.app)!,prefix=app.toolkit.toUpperCase()+'_';
  if(!a.action.startsWith(prefix))throw new Refused(`${a.action} is not a ${app.name} action`);
  const kind=actionKind(a.action,app.toolkit);
  if(kind==='financial')throw new Refused('Payments and purchases go through the shopping approvals, not a connected app');
  if(kind!==k.kind)throw new Refused(`${a.action} ${kind==='read'?'only reads':kind==='write'?'changes data':kind==='communication'?'sends a message':'deletes data'}; use ${KINDS.find(x=>x.kind===kind)!.id}`);
  const record=conn.get(c.owner,app.id);
  if(record?.status!=='connected'||!record.connectedAccountId){db.event(c.owner,'connector.needed',{runId:c.runId,connector:app.id});throw new Refused(`${app.name} is not connected. Ask the owner to connect it in Settings, under Connected apps, then try again.`);}
  const log=db.create(c.owner,'connector_run',{runId:c.runId,actionId:c.actionId,provider:'composio',connector:app.id,action:a.action,kind,inputSummary:JSON.stringify(a.arguments).slice(0,500),status:'running'});
  if(k.kind!=='read')c.assertAuthorized();
  let r:any;
  try{r=await conn.client.execute(c.owner,a.action,record.connectedAccountId,a.arguments);}
  catch(e){
   // A 4xx is the service refusing the request, so nothing happened. A timeout or 5xx may have acted: uncertain, never retried.
   const refused=e instanceof Refused||e instanceof ComposioError&&e.status<500;
   db.put(c.owner,'connector_run',{...log,status:k.kind==='read'||refused?'failed':'uncertain',errorMessage:e instanceof Error?e.message:'Request failed'});
   throw refused&&!(e instanceof Refused)?new Refused((e as Error).message):e;
  }
  // Composio answered and said it did not do it: nothing happened, so this is a refusal, not an uncertain outcome.
  if(!r?.successful){const message=redactText(String(r?.error??'The app did not accept that action')).slice(0,300);db.put(c.owner,'connector_run',{...log,status:'failed',errorMessage:message});throw new Refused(`${app.name}: ${message}`);}
  const data=clip(r.data);db.put(c.owner,'connector_run',{...log,status:'completed',outputSummary:JSON.stringify(data).slice(0,500)});
  return {app:app.id,action:a.action,data};
 }});
}
