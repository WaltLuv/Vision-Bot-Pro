import {test} from 'node:test';import assert from 'node:assert/strict';import express from 'express';import {mkdtempSync,rmSync} from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Store} from '../src/employee/db.js';import {ToolGateway} from '../src/employee/tools.js';import {ComposioClient,Connectors,registerComposio,actionKind,composioUser} from '../src/employee/composio.js';
import {inferDelivery,nextRun,routineTask,describeRepeat} from '../src/employee/schedule.js';

process.env.COMPOSIO_API_KEY='ck_fixture_key_0123456789';process.env.PUBLIC_BASE_URL='https://bot.example.com';

// A stand-in for Composio's REST API: records every call and answers like the real one does.
function fakeComposio(over:{execute?:(slug:string,body:any)=>any}={}){
 const calls:{method:string;path:string;body:any;key:string|null}[]=[];const accounts=new Map<string,any>();
 const http=(async(url:string|URL|Request,init:RequestInit={})=>{
  const u=new URL(String(url)),method=init.method??'GET',body=init.body?JSON.parse(String(init.body)):undefined;calls.push({method,path:u.pathname+u.search,body,key:new Headers(init.headers).get('x-api-key')});
  const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
  if(u.pathname==='/api/v3.1/auth_configs')return json({items:[{id:'ac_disabled',status:'DISABLED',toolkit:{slug:u.searchParams.get('toolkit_slug')}},{id:'ac_'+u.searchParams.get('toolkit_slug'),status:'ENABLED',toolkit:{slug:u.searchParams.get('toolkit_slug')}}]});
  if(u.pathname==='/api/v3.1/connected_accounts/link'){const id='ca_'+(accounts.size+1);accounts.set(id,{id,status:'INITIATED',user_id:body.user_id,toolkit:{slug:body.auth_config_id.slice(3)}});return json({connected_account_id:id,redirect_url:'https://connect.composio.dev/link/abc',link_token:'lt',expires_at:'2030-01-01T00:00:00Z'});}
  if(u.pathname==='/api/v3.1/connected_accounts'&&method==='GET')return json({items:[...accounts.values()].filter(a=>a.status==='ACTIVE'&&a.user_id===u.searchParams.get('user_ids')&&a.toolkit.slug===u.searchParams.get('toolkit_slugs'))});
  const one=u.pathname.match(/^\/api\/v3\.1\/connected_accounts\/(.+)$/);
  if(one){const a=accounts.get(one[1]);if(!a)return json({error:{message:'not found'}},404);if(method==='DELETE'){accounts.delete(one[1]);return json({success:true});}return json(a);}
  if(u.pathname==='/api/v3.1/tools')return json({items:[{slug:'GMAIL_FETCH_EMAILS',name:'Fetch emails',description:'List emails',input_parameters:{type:'object'}},{slug:'GMAIL_SEND_EMAIL',name:'Send email',description:'Send',input_parameters:{type:'object'}},{slug:'COMPOSIO_SEARCH_TOOLS',name:'Meta',description:'x'}]});
  const exec=u.pathname.match(/^\/api\/v3\.1\/tools\/execute\/(.+)$/);
  if(exec)return over.execute?over.execute(exec[1],body):json({successful:true,error:null,data:{ok:true,slug:exec[1]}});
  return json({error:{message:'no route'}},404);
 }) as typeof fetch;
 const activate=(id:string,email='walter@example.com')=>accounts.set(id,{...accounts.get(id),status:'ACTIVE',data:{email}});
 return {calls,accounts,http,activate};
}
function setup(over={}){const f=fakeComposio(over),db=new Store(':memory:'),t=new ToolGateway(db),apps=new Connectors(db,new ComposioClient(f.http));registerComposio(t,db,apps);db.put('a','run',{id:'r',status:'working'});return {...f,db,t,apps};}
async function connected(s:ReturnType<typeof setup>,id='gmail'){const r=await s.apps.connect('a',id);const accountId=[...s.accounts.keys()].at(-1)!;s.activate(accountId);await s.apps.status('a',id);return {r,accountId};}

test('actions are classified by what they do, strongest effect first, unknown verbs never as reads',()=>{
 const cases:[string,string,string][]=[['GMAIL_FETCH_EMAILS','gmail','read'],['GMAIL_SEND_EMAIL','gmail','communication'],['GMAIL_REPLY_TO_THREAD','gmail','communication'],['GMAIL_CREATE_EMAIL_DRAFT','gmail','write'],['GMAIL_MOVE_TO_TRASH','gmail','destructive'],
  ['GOOGLECALENDAR_FIND_FREE_SLOTS','googlecalendar','read'],['GOOGLECALENDAR_CREATE_EVENT','googlecalendar','write'],['GOOGLECALENDAR_DELETE_EVENT','googlecalendar','destructive'],['SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL','slack','communication'],
  ['SLACK_CHAT_POST_MESSAGE','slack','communication'],['GOOGLESHEETS_BATCH_GET','googlesheets','read'],['GOOGLESHEETS_BATCH_UPDATE','googlesheets','write'],['NOTION_SEARCH_NOTION_PAGE','notion','read'],['GMAIL_SOMETHING_NEW','gmail','write'],['NOTION_PAY_INVOICE','notion','financial']];
 for(const [slug,toolkit,kind] of cases)assert.equal(actionKind(slug,toolkit),kind,slug);
});

test('connecting returns a one-time sign-in link and records a pending connection, keyed to an id that is not the owner\'s email',async()=>{
 const s=setup();const r=await s.apps.connect('walter@example.com','gmail');
 assert.equal(r.status,'pending');assert.equal(r.connectUrl,'https://connect.composio.dev/link/abc');
 const link=s.calls.find(c=>c.path==='/api/v3.1/connected_accounts/link')!;
 assert.equal(link.body.auth_config_id,'ac_gmail','the enabled auth config, never a disabled one');
 assert.equal(link.body.user_id,composioUser('walter@example.com'));assert.ok(!JSON.stringify(s.calls).includes('walter@example.com'),'the owner\'s address never reaches the provider');
 assert.equal(link.body.callback_url,'https://bot.example.com/?connected=gmail');
 assert.ok(s.calls.every(c=>c.key==='ck_fixture_key_0123456789'),'every call is authenticated server-side');
 assert.ok(!('connectedAccountId' in r)&&!('connectionRequestId' in r),'account ids stay on the server');
 s.db.close();
});

test('a fixed auth config from the environment wins over discovery',async()=>{
 const s=setup();process.env.COMPOSIO_SLACK_AUTH_CONFIG_ID='ac_fixed_slack';try{await s.apps.connect('a','slack');assert.equal(s.calls.find(c=>c.path.endsWith('/link'))!.body.auth_config_id,'ac_fixed_slack');assert.ok(!s.calls.some(c=>c.path.startsWith('/api/v3.1/auth_configs')));}finally{delete process.env.COMPOSIO_SLACK_AUTH_CONFIG_ID;s.db.close();}
});

test('status follows the provider: pending, then connected as the signed-in account, then revoked on disconnect',async()=>{
 const s=setup();await s.apps.connect('a','gmail');
 assert.equal((await s.apps.status('a','gmail')).status,'pending');
 s.activate('ca_1');const c=await s.apps.status('a','gmail');
 assert.equal(c.status,'connected');assert.equal(c.connectedEmail,'walter@example.com');
 assert.equal(s.apps.list('a').find(x=>x.id==='gmail')!.status,'connected');
 assert.equal(s.apps.list('b').find(x=>x.id==='gmail')!.status,'not_connected','another owner sees nothing of it');
 const d=await s.apps.disconnect('a','gmail');assert.equal(d.status,'revoked');assert.ok(s.calls.some(x=>x.method==='DELETE'&&x.path==='/api/v3.1/connected_accounts/ca_1'));
 assert.equal((await s.apps.disconnect('a','gmail')).status,'revoked','disconnecting twice is harmless');
 // Revoked at the provider (deleted from the Composio dashboard): the next check says so instead of claiming connected.
 await connected(s);s.accounts.clear();assert.equal((await s.apps.status('a','gmail')).status,'revoked');
 s.db.close();
});

test('a read runs at once against the owner\'s pinned account, and leaves a run log and a receipt',async()=>{
 const s=setup();const {accountId}=await connected(s);
 const r=await s.t.invoke('a','r','app_read',{app:'gmail',action:'GMAIL_FETCH_EMAILS',arguments:{query:'from:owner'}},'k1');
 assert.equal(r.data.slug,'GMAIL_FETCH_EMAILS');
 const exec=s.calls.find(c=>c.path.startsWith('/api/v3.1/tools/execute/'))!;
 assert.equal(exec.body.connected_account_id,accountId);assert.equal(exec.body.user_id,composioUser('a'));assert.deepEqual(exec.body.arguments,{query:'from:owner'});
 assert.equal(s.db.list('a','connector_run')[0].status,'completed');
 assert.ok(s.db.list('a','artifact').some(x=>x.kind==='tool_receipt'));
 assert.equal(s.db.list('a','approval').length,0);
 s.db.close();
});

test('search lists only the app\'s own actions, each labelled with what it does',async()=>{
 const s=setup();const r=await s.t.invoke('a','r','app_actions_search',{app:'gmail',query:'send'},'k');
 assert.deepEqual(r.map((x:any)=>[x.action,x.kind]),[['GMAIL_FETCH_EMAILS','read'],['GMAIL_SEND_EMAIL','communication']]);
 s.db.close();
});

test('a send waits for approval of its exact arguments, every time, and changed arguments need a new approval',async()=>{
 const s=setup();await connected(s,'slack');
 const args={app:'slack',action:'SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL',arguments:{channel:'#maintenance',text:'Unit 4B leak fixed'}};
 const pending=await s.t.invoke('a','r','app_send',args,'k1');assert.ok(pending.approvalId);
 assert.ok(!s.calls.some(c=>c.path.includes('/tools/execute/')),'nothing is sent before the decision');
 const approval=s.db.get('a','approval',pending.approvalId)!;assert.equal(approval.effect,'communication');assert.deepEqual(approval.details,args);assert.equal(approval.label,'Send with a connected app');
 assert.throws(()=>s.t.decide('a',pending.approvalId,'always'),/own approval/,'no standing permission to send');
 await assert.rejects(s.t.invoke('a','r','app_send',{...args,arguments:{channel:'#all',text:'x'}},'k1'),/changed/);
 s.t.decide('a',pending.approvalId,'once');
 await s.t.invoke('a','r','app_send',args,'k1');
 const sent=s.calls.filter(c=>c.path.includes('/tools/execute/'));assert.equal(sent.length,1);assert.deepEqual(sent[0].body.arguments,args.arguments);
 const again=await s.t.invoke('a','r','app_send',{...args,arguments:{channel:'#maintenance',text:'Second update'}},'k2');assert.ok(again.approvalId,'a different message is a different approval');
 s.db.close();
});

test('a write to an app also waits for approval, though local writes do not',async()=>{
 const s=setup();await connected(s,'googlecalendar');
 const r=await s.t.invoke('a','r','app_update',{app:'googlecalendar',action:'GOOGLECALENDAR_CREATE_EVENT',arguments:{summary:'Inspect 12 Elm'}},'k');
 assert.ok(r.approvalId);assert.equal(s.db.get('a','approval',r.approvalId)!.effect,'write');
 s.db.close();
});

test('the model cannot route an action through the wrong door, another app, or payments',async()=>{
 const s=setup();await connected(s);
 await assert.rejects(s.t.invoke('a','r','app_read',{app:'gmail',action:'GMAIL_SEND_EMAIL',arguments:{}},'a1'),/sends a message; use app_send/);
 await assert.rejects(s.t.invoke('a','r','app_read',{app:'gmail',action:'SLACK_LIST_ALL_CHANNELS',arguments:{}},'a2'),/not a Gmail action/);
 await assert.rejects(s.t.invoke('a','r','app_read',{app:'gmail',action:'gmail_fetch_emails',arguments:{}},'a3'));
 await assert.rejects(s.t.invoke('a','r','app_read',{app:'dropbox',action:'DROPBOX_LIST',arguments:{}},'a4'));
 const pay=await s.t.invoke('a','r','app_update',{app:'gmail',action:'GMAIL_PAY_INVOICE',arguments:{}},'a5');s.t.decide('a',pay.approvalId,'once');
 await assert.rejects(s.t.invoke('a','r','app_update',{app:'gmail',action:'GMAIL_PAY_INVOICE',arguments:{}},'a5'),/shopping approvals/);
 assert.ok(!s.calls.some(c=>c.path.includes('/tools/execute/')));
 s.db.close();
});

test('an app that is not connected is refused with a way to fix it, and the phone is told',async()=>{
 const s=setup();
 await assert.rejects(s.t.invoke('a','r','app_read',{app:'notion',action:'NOTION_SEARCH_NOTION_PAGE',arguments:{}},'k'),/Notion is not connected.*Settings/);
 assert.ok(s.db.events('a').some(e=>e.type==='connector.needed'&&e.connector==='notion'));
 s.db.close();
});

test('a refusal from the app is a clean failure; a server error on a send is uncertain and never repeated',async()=>{
 let mode:'refuse'|'crash'='refuse';
 const s=setup({execute:()=>mode==='refuse'?new Response(JSON.stringify({successful:false,error:'channel_not_found',data:{}}),{status:200}):new Response('{}',{status:502})});
 await connected(s,'slack');
 const args={app:'slack',action:'SLACK_CHAT_POST_MESSAGE',arguments:{channel:'#nope',text:'hi'}};
 let p=await s.t.invoke('a','r','app_send',args,'k1');s.t.decide('a',p.approvalId,'once');
 await assert.rejects(s.t.invoke('a','r','app_send',args,'k1'),/channel_not_found/);
 assert.equal(s.db.list('a','action').find(a=>a.name==='app_send')!.status,'failed');
 mode='crash';const args2={...args,arguments:{channel:'#ops',text:'hi'}};
 p=await s.t.invoke('a','r','app_send',args2,'k2');s.t.decide('a',p.approvalId,'once');
 await assert.rejects(s.t.invoke('a','r','app_send',args2,'k2'),/HTTP 502/);
 assert.equal(s.db.list('a','action').find(a=>a.args.arguments.channel==='#ops')!.status,'uncertain');
 await assert.rejects(s.t.invoke('a','r','app_send',args2,'k2'),/reconciliation/);
 s.db.close();
});

test('routines: the next run lands on the right local time, across daylight saving, and only on the right days',()=>{
 // 2026-03-07 is a Saturday; New York springs forward on Sunday 2026-03-08.
 const sat=Date.parse('2026-03-07T15:00:00Z');
 assert.equal(nextRun({frequency:'daily',time:'08:00',timezone:'America/New_York'},sat),'2026-03-08T12:00:00.000Z','8 AM EDT the next morning');
 assert.equal(nextRun({frequency:'weekdays',time:'08:00',timezone:'America/New_York'},sat),'2026-03-09T12:00:00.000Z','skips the weekend');
 assert.equal(nextRun({frequency:'weekly',time:'16:30',weekday:'friday',timezone:'UTC'},sat),'2026-03-13T16:30:00.000Z');
 assert.equal(nextRun({frequency:'daily',time:'15:00',timezone:'UTC'},sat),'2026-03-08T15:00:00.000Z','strictly after, never the same instant twice');
 assert.equal(describeRepeat({frequency:'weekly',time:'08:05',weekday:'monday',timezone:'UTC'}),'Every Monday at 8:05 AM');
});

test('routines: delivery is read from the request, and a delivery is spelled out for the employee',()=>{
 assert.equal(inferDelivery('Every Friday send the property status to the maintenance Slack channel'),'slack');
 assert.equal(inferDelivery('Each morning email me a summary of new work orders'),'gmail');
 assert.equal(inferDelivery('Add the inspections to my calendar as events'),'googlecalendar');
 assert.equal(inferDelivery('Log the inspection in Notion'),'notion');
 assert.equal(inferDelivery('Update the maintenance spreadsheet'),'googlesheets');
 assert.equal(inferDelivery('Check my inbox for owner emails and summarise anything urgent'),'chat','reading the inbox is not delivering to it');
 assert.equal(routineTask('Summarise','chat'),'Summarise');
 assert.match(routineTask('Summarise','slack'),/deliver it with Slack.*app_send.*approves each delivery/s);
});

test('HTTP: connected apps behind auth and CSRF, owner-scoped, and routines with a repeat and a delivery',async()=>{
 const f=fakeComposio();const fake=express();fake.use(express.json());fake.all(/.*/,async(req,res)=>{const r=await f.http('http://x'+req.originalUrl,{method:req.method,headers:{'x-api-key':String(req.header('x-api-key'))},body:['GET','DELETE'].includes(req.method)?undefined:JSON.stringify(req.body)});res.status(r.status).type('json').send(await r.text());});
 const fakeServer=fake.listen(0);await new Promise<void>(r=>fakeServer.on('listening',r));process.env.COMPOSIO_API_BASE=`http://127.0.0.1:${(fakeServer.address() as any).port}`;
 const dir=mkdtempSync(path.join(os.tmpdir(),'vc-composio-'));process.env.EMPLOYEE_DATA_DIR=dir;process.env.EMPLOYEE_DB_PATH=path.join(dir,'employee.sqlite');
 const {installEmployee}=await import('../src/employee/routes.js');const {initStore}=await import('../src/store.js');const {tokenHash}=await import('../src/employee/auth.js');initStore(path.join(dir,'legacy.json'));
 const app=express();app.use(express.json());const ids=new Map([['fixture-a','alice'],['fixture-b','bob']]);
 const e=installEmployee(app,(req,token)=>ids.get(token??req.header('authorization')?.slice(7)??'')??null,(owner,hash)=>[...ids].some(([t,o])=>o===owner&&tokenHash(t)===hash),async(_o,run)=>({result:'done: '+run.task}));
 const server=app.listen(0);await new Promise<void>(r=>server.on('listening',r));const base=`http://127.0.0.1:${(server.address() as any).port}`;
 const req=(method:string,url:string,headers:Record<string,string>,data?:unknown)=>fetch(base+url,{method,headers:{'Content-Type':'application/json',...headers},body:data===undefined?undefined:JSON.stringify(data)});
 try{
  assert.equal((await req('GET','/api/composio/tools',{})).status,401);
  const login=await req('POST','/api/auth/login',{},{token:'fixture-a'});const cookie=login.headers.get('set-cookie')!.split(';')[0],csrf=(await login.json()).csrf;const auth={cookie,'x-csrf-token':csrf};
  const list=await (await req('GET','/api/composio/tools',auth)).json();assert.equal(list.enabled,true);assert.equal(list.tools.length,11);assert.ok(list.tools.every((t:any)=>t.status==='not_connected'));
  assert.equal((await req('POST','/api/composio/tools/gmail/connect',{cookie},{})).status,403,'CSRF required');
  const started=await (await req('POST','/api/composio/tools/gmail/connect',auth,{})).json();assert.equal(started.status,'pending');assert.match(started.connectUrl,/^https:\/\//);
  assert.equal((await req('POST','/api/composio/tools/dropbox/connect',auth,{})).status,409);
  f.activate('ca_1');const status=await (await req('GET','/api/composio/tools/gmail/status',auth)).json();assert.equal(status.status,'connected');assert.equal(status.connectedEmail,'walter@example.com');
  assert.equal((await (await req('GET','/api/composio/connections',auth)).json()).connections.length,1);
  assert.equal((await (await req('GET','/api/composio/connections',{Authorization:'Bearer fixture-b'})).json()).connections.length,0,'bob sees none of alice\'s connections');
  assert.equal((await (await req('GET','/api/connections',auth)).json()).apps,true);
  assert.ok(e.tools.tools.has('app_send'),'governed app tools are registered when connected apps are set up');
  assert.equal((await (await req('POST','/api/composio/tools/gmail/disconnect',auth,{})).json()).status,'revoked');
  process.env.COMPOSIO_ENABLED='false';assert.equal((await req('POST','/api/composio/tools/gmail/connect',auth,{})).status,503);delete process.env.COMPOSIO_ENABLED;

  const created=await req('POST','/api/workflows',auth,{name:'Friday status',task:'Send the weekly property status to the maintenance Slack channel',repeat:{frequency:'weekly',time:'16:00',weekday:'friday',timezone:'America/Chicago'}});
  assert.equal(created.status,201);const w=await created.json();assert.equal(w.delivery,'slack');assert.equal(w.schedule,'Every Friday at 4:00 PM');assert.ok(Date.parse(w.nextRunAt)>Date.now());
  assert.equal((await req('POST','/api/workflows',auth,{name:'x',task:'y',repeat:{frequency:'weekly',time:'16:00',timezone:'UTC'}})).status,400,'weekly needs a day');
  const paused=await (await req('PATCH','/api/workflows/'+w.id,auth,{enabled:false})).json();assert.equal(paused.enabled,false);
  assert.equal((await req('PATCH','/api/workflows/'+w.id,{Authorization:'Bearer fixture-b'},{enabled:true})).status,404);
  const run=await (await req('POST',`/api/workflows/${w.id}/run`,{...auth,'idempotency-key':'wf-1'},{})).json();assert.match(run.task,/deliver it with Slack/);assert.equal(run.title,'Friday status');
  // Due now: the scheduler starts it once, moves the next run forward, and records how it went.
  e.db.put('alice','workflow',{...e.db.get('alice','workflow',w.id)!,enabled:true,nextRunAt:new Date(Date.now()-1000).toISOString()});
  for(let i=0;i<60&&!e.db.get('alice','workflow',w.id)!.lastRunStatus;i++)await new Promise(r=>setTimeout(r,100));
  const after=e.db.get('alice','workflow',w.id)!;assert.equal(after.runsCount,2);assert.ok(Date.parse(after.nextRunAt)>Date.now());assert.equal(after.lastRunStatus,'completed');assert.match(after.lastRunSummary,/^done: /);
  assert.equal(e.db.list('alice','run').filter(r=>r.context?.source==='workflow').length,2,'one scheduled run, not one per tick');
 }finally{e.stop();server.close();fakeServer.close();e.db.close();rmSync(dir,{recursive:true,force:true});delete process.env.COMPOSIO_API_BASE;}
});
