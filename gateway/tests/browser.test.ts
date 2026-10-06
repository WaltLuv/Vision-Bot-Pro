import {test} from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import express from 'express';import {mkdtempSync,rmSync} from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Store} from '../src/employee/db.js';import {BrowserCapability,embeddableLiveUrl,validLiveViewHosts,liveFrameSources,browserClock,waitForBrowserSlot} from '../src/employee/browser.js';import {installEmployee} from '../src/employee/routes.js';import {tokenHash} from '../src/employee/auth.js';import {initStore} from '../src/store.js';

/**
 * Watching the employee browse, and taking the browser from it. The stand-in
 * below behaves like Browser Use's v4 API as its official SDK defines it:
 * runs can be created, polled and cancelled, but not paused; every run belongs
 * to a session, and a follow-up run in the session reuses the session's live
 * browser. The one rule above all: the gateway never tells the owner they have
 * the browser unless the provider actually stopped the employee.
 */
interface Service{url:string;calls:string[];created:any[];status:Record<string,string>;live:Record<string,string>;refuse:Set<string>;gate:Promise<void>|null;statusInFlight:number;close():Promise<void>}
async function browserUse():Promise<Service>{
 const svc={calls:[] as string[],created:[] as any[],status:{} as Record<string,string>,live:{} as Record<string,string>,refuse:new Set<string>(),gate:null,statusInFlight:0} as Service;
 const LIVE='https://live.browser-use.com/view?session=abc';
 const server=createServer(async(req,res)=>{
  const url=req.url??'',json=(code:number,v:unknown)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(v));};
  let raw='';for await(const chunk of req)raw+=chunk;
  if(req.method==='POST'&&url==='/api/v4/runs'){
   if(svc.refuse.has('create'))return json(500,{detail:'refused'});
   const body=JSON.parse(raw||'{}'),id=`bu-${svc.created.length+1}`;svc.created.push(body);svc.status[id]='running';svc.live[id]??=LIVE;
   return json(200,{id,status:'queued',sessionId:body.sessionId??'sess-1',workspaceId:'ws-1',eventsUrl:`/runs/${id}/events`});
  }
  const m=url.match(/^\/api\/v4\/runs\/([^/]+)(?:\/(\w+))?$/);if(!m)return json(404,{detail:'Not Found'});
  const [,id,action]=m;
  if(req.method==='POST'){
   if(action!=='cancel')return json(404,{detail:'Not Found'});   // v4 has no pause or resume
   svc.calls.push(`cancel:${id}`);
   if(svc.refuse.has('cancel'))return json(409,{detail:'refused'});
   svc.status[id!]='cancelled';return json(200,{id,status:'cancelled'});
  }
  if(action==='events')return json(200,{events:[{type:'browser.ready',data:{live_view_url:svc.live[id!]}}],hasMore:false});
  // A test can hold a status check open, to land a take-over while the answer is on its way.
  if(action==='status'){svc.statusInFlight++;if(svc.gate)await svc.gate;svc.statusInFlight--;return json(200,{status:svc.status[id!]});}
  return json(200,{id,status:svc.status[id!],result:svc.status[id!]==='completed'?`Found it (${id})`:null});
 });
 server.listen(0,'127.0.0.1');await new Promise<void>(r=>server.on('listening',()=>r()));
 svc.url=`http://127.0.0.1:${(server.address() as any).port}/api/v4`;
 svc.close=async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));};
 return svc;
}
const waitFor=async(check:()=>boolean,what:string,ms=15000)=>{const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,20));}throw Error(`Timed out waiting for ${what}`);};
function env(svc:Service){const keys={BROWSER_USE_API_KEY:'fixture-key',BROWSER_USE_API_BASE:svc.url,BROWSER_POLL_MS:'20'},saved:Record<string,string|undefined>={};for(const [k,v] of Object.entries(keys)){saved[k]=process.env[k];process.env[k]=v;}return ()=>{for(const [k,v] of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;};}
const ctx=(owner='alice',runId='run-1')=>({owner,runId,actionId:'a1',assertAuthorized:()=>{}});
const settle=()=>new Promise(r=>setTimeout(r,150));

test('you can watch, take the browser, hand it back, and the live link is gone when the job ends',async t=>{
 const svc=await browserUse(),restore=env(svc),db=new Store(':memory:'),browser=new BrowserCapability(db);
 t.after(async()=>{restore();db.close();await svc.close();});
 let ended=false;const job=browser.execute('Find the part',ctx());job.then(()=>{ended=true;},()=>{ended=true;});
 await waitFor(()=>!!db.list('alice','computer')[0]?.liveEmbed,'the live view');
 const id=db.list('alice','computer')[0].id;
 assert.equal(db.get('alice','computer',id)?.liveEmbed,'https://live.browser-use.com/view?session=abc');
 assert.equal(db.get('alice','computer',id)?.control,'agent','the employee drives until you take over');
 assert.equal(db.get('alice','computer',id)?.providerSession,'sess-1','the Browser Use session is kept, so the browser can be handed back');

 assert.equal((await browser.control('alice',id,'owner'))?.control,'owner');
 assert.deepEqual(svc.calls,['cancel:bu-1'],'taking over stops the employee\'s current run at the provider');
 await settle();
 assert.equal(ended,false,'stopping the employee\'s run to hand you the browser does not end the task');
 assert.equal(db.get('alice','computer',id)?.status,'working');
 await browser.control('alice',id,'owner');
 assert.deepEqual(svc.calls,['cancel:bu-1'],'a second tap does not stop it twice');
 assert.equal(await browser.control('bob',id,'owner'),undefined,'someone else\'s browser does not exist for you');

 await new Promise(r=>setTimeout(r,30));
 const back=await browser.control('alice',id,'agent');
 assert.equal(back?.control,'agent');
 assert.equal(svc.created.length,2,'handing back starts a follow-up run');
 assert.equal(svc.created[1].sessionId,'sess-1','in the same session, so Browser Use reuses the same live browser');
 assert.match(svc.created[1].task,/handed it back[\s\S]*Find the part/,'told to carry on with the original objective from where the page is now');
 assert.match(svc.created[1].task,/Stop before checkout/,'with the same guard rails as the first run');
 assert.equal(svc.created[1].browserSettings,undefined,'a live browser is reused as-is, so no settings are re-sent');
 assert.equal(back?.providerId,'bu-2');
 assert.ok(back?.pausedMs>=30,'time with you is recorded so it does not count against the employee');

 svc.status['bu-2']='completed';
 assert.deepEqual(await job,{text:'Found it (bu-2)',computerId:id},'the result is the follow-up run\'s');
 const done=db.get('alice','computer',id)!;
 assert.equal(done.status,'completed');
 assert.equal(done.liveUrl,undefined,'a finished job keeps no key to its browser');
 assert.equal(done.liveEmbed,undefined);
});

test('the app never claims you have the browser when the provider did not stop the employee',async t=>{
 const svc=await browserUse(),restore=env(svc),db=new Store(':memory:'),browser=new BrowserCapability(db);
 t.after(async()=>{restore();db.close();await svc.close();});
 let ended=false;const job=browser.execute('Find the part',ctx());job.then(()=>{ended=true;},()=>{ended=true;});
 await waitFor(()=>!!db.list('alice','computer')[0]?.liveEmbed,'the live view');
 const id=db.list('alice','computer')[0].id;
 svc.refuse.add('cancel');
 await assert.rejects(()=>browser.control('alice',id,'owner'),/still driving/);
 assert.equal(db.get('alice','computer',id)?.control,'agent','still the employee\'s: the stop was refused');
 assert.equal(db.get('alice','computer',id)?.handover,undefined,'and nothing is left half-handed-over');
 svc.refuse.delete('cancel');
 await browser.control('alice',id,'owner');
 svc.refuse.add('create');
 await assert.rejects(()=>browser.control('alice',id,'agent'),/stays paused for you/);
 assert.equal(db.get('alice','computer',id)?.control,'owner','still yours: the follow-up could not start');
 await settle();
 assert.equal(ended,false);
 await browser.cancel('alice',id);
 assert.equal(db.get('alice','computer',id)?.status,'cancelled','stopping while you hold the browser ends the job cleanly');
 assert.equal(svc.calls.filter(c=>c==='cancel:bu-1').length,2,'no second run to cancel: the employee\'s was already stopped');
 assert.equal(db.get('alice','computer',id)?.liveEmbed,undefined,'a cancelled job keeps no key to its browser');
});

test('a take-over that lands while a status check is on its way does not end the task',async t=>{
 const svc=await browserUse(),restore=env(svc),db=new Store(':memory:'),browser=new BrowserCapability(db);
 t.after(async()=>{restore();db.close();await svc.close();});
 let ended=false;const job=browser.execute('Find the part',ctx());job.then(()=>{ended=true;},()=>{ended=true;});
 await waitFor(()=>!!db.list('alice','computer')[0]?.liveEmbed,'the live view');
 const id=db.list('alice','computer')[0].id;
 let open!:()=>void;svc.gate=new Promise<void>(r=>{open=r;});
 await waitFor(()=>svc.statusInFlight>0,'a status check in flight');
 await browser.control('alice',id,'owner');
 open();svc.gate=null;
 await settle();
 assert.equal(ended,false,'the "cancelled" that check brings back was the take-over, not the end of the task');
 assert.equal(db.get('alice','computer',id)?.status,'working');
 assert.equal(db.get('alice','computer',id)?.control,'owner');
 await browser.cancel('alice',id);
});

test('a browser with no Browser Use session cannot be taken over, because it could not be handed back',async t=>{
 const svc=await browserUse(),restore=env(svc),db=new Store(':memory:'),browser=new BrowserCapability(db);
 t.after(async()=>{restore();db.close();await svc.close();});
 const c=db.put('alice','computer',{id:'comp-1',runId:'run-1',status:'working',providerId:'bu-9',control:'agent'});
 await assert.rejects(()=>browser.control('alice',c.id,'owner'),/can't be handed over/);
 assert.deepEqual(svc.calls,[],'the employee is not stopped for a hand-over that could never be returned');
});

test('stopping a run that had already finished is not left as a browser to clean up',async t=>{
 const svc=await browserUse(),restore=env(svc),db=new Store(':memory:'),browser=new BrowserCapability(db);
 t.after(async()=>{restore();db.close();await svc.close();});
 svc.status['bu-7']='completed';svc.refuse.add('cancel');
 db.put('alice','computer',{id:'comp-7',runId:'run-1',status:'working',providerId:'bu-7',control:'agent'});
 await browser.cancel('alice','comp-7');
 assert.equal(db.get('alice','computer','comp-7')?.status,'cancelled','not cleanup_pending, which would hold the only browser slot');
});

test('if a follow-up run gets a different browser, the phone is given that one to show',async t=>{
 const svc=await browserUse(),restore=env(svc),db=new Store(':memory:'),browser=new BrowserCapability(db);
 t.after(async()=>{restore();db.close();await svc.close();});
 const job=browser.execute('Find the part',ctx());job.catch(()=>{});
 await waitFor(()=>!!db.list('alice','computer')[0]?.liveEmbed,'the live view');
 const id=db.list('alice','computer')[0].id;
 await browser.control('alice',id,'owner');
 svc.live['bu-2']='https://live.browser-use.com/view?session=fresh';
 await browser.control('alice',id,'agent');
 await waitFor(()=>db.get('alice','computer',id)?.liveEmbed==='https://live.browser-use.com/view?session=fresh','the new live view');
 await browser.cancel('alice',id);
});

test('only a browser provider\'s own https pages are offered for embedding',async t=>{
 const saved=process.env.BROWSER_LIVE_VIEW_HOSTS;t.after(()=>{if(saved===undefined)delete process.env.BROWSER_LIVE_VIEW_HOSTS;else process.env.BROWSER_LIVE_VIEW_HOSTS=saved;});
 delete process.env.BROWSER_LIVE_VIEW_HOSTS;
 assert.equal(embeddableLiveUrl('https://live.browser-use.com/v?s=1'),'https://live.browser-use.com/v?s=1');
 assert.equal(embeddableLiveUrl('http://live.browser-use.com/v'),null,'never over plain http');
 assert.equal(embeddableLiveUrl('https://evilbrowser-use.com/v'),null,'a look-alike domain is not a subdomain');
 assert.equal(embeddableLiveUrl('https://user:pw@live.browser-use.com/v'),null);
 assert.equal(embeddableLiveUrl('https://cdn.other.net/v'),null);
 assert.equal(embeddableLiveUrl('javascript:alert(1)'),null);
 process.env.BROWSER_LIVE_VIEW_HOSTS='live.example.com';
 assert.equal(embeddableLiveUrl('https://live.example.com/v'),'https://live.example.com/v','an owner can allow another provider');
 assert.equal(liveFrameSources(),'https://browser-use.com https://*.browser-use.com https://browserbase.com https://*.browserbase.com https://live.example.com https://*.live.example.com');
 for(const bad of ['*',"'unsafe-inline'",'https://x.com','a b','localhost']){process.env.BROWSER_LIVE_VIEW_HOSTS=bad;assert.equal(validLiveViewHosts(),false,`${bad} must not reach the Content-Security-Policy`);}
});

test('a live view from a host that is not allowed is kept for the glasses apps but not offered to the phone',async t=>{
 const svc=await browserUse(),restore=env(svc),db=new Store(':memory:'),browser=new BrowserCapability(db);
 t.after(async()=>{restore();db.close();await svc.close();});
 svc.live['bu-1']='https://cdn.other.net/view?s=9';
 const job=browser.execute('Find the part',ctx());job.catch(()=>{});
 await waitFor(()=>!!db.list('alice','computer')[0]?.liveHost,'the live view');
 const r=db.list('alice','computer')[0];
 assert.equal(r.liveUrl,'https://cdn.other.net/view?s=9','the native apps still get the link they always had');
 assert.equal(r.liveEmbed,null,'the phone app is not handed it to frame');
 assert.equal(r.liveHost,'cdn.other.net','so the phone can say which host needs allowing');
 await browser.cancel('alice',r.id);
});

test('the agent\'s time limit stops while you drive, but a forgotten take-over still ends',()=>{
 const begun=0,min=60_000;
 assert.equal(browserClock({id:'c',control:'agent'},begun,14*min),null);
 assert.match(browserClock({id:'c',control:'agent'},begun,16*min)!,/time limit/);
 assert.equal(browserClock({id:'c',control:'owner',controlSince:5*min},begun,25*min),null,'20 minutes with you do not count');
 assert.equal(browserClock({id:'c',control:'agent',pausedMs:20*min},begun,30*min),null,'nor once handed back');
 assert.match(browserClock({id:'c',control:'owner',controlSince:0},begun,46*min)!,/left with you for too long/);
});

test('HTTP: take-over needs your session and CSRF token, and is invisible to another owner',async t=>{
 const svc=await browserUse(),restore=env(svc);
 const dir=mkdtempSync(path.join(os.tmpdir(),'vc-browser-http-'));process.env.EMPLOYEE_DATA_DIR=dir;process.env.EMPLOYEE_DB_PATH=path.join(dir,'employee.sqlite');initStore(path.join(dir,'legacy.json'));
 const app=express();app.use(express.json());const ids=new Map([['fixture-a','alice'],['fixture-b','bob']]);
 const e=installEmployee(app,(req,token)=>ids.get(token??req.header('authorization')?.slice(7)??'')??null,(owner,hash)=>[...ids].some(([tk,o])=>o===owner&&tokenHash(tk)===hash),async()=>({result:'ok'}));
 const server=app.listen(0);await new Promise<void>(r=>server.on('listening',r));const base=`http://127.0.0.1:${(server.address() as any).port}`;
 t.after(async()=>{e.stop();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));e.db.close();rmSync(dir,{recursive:true,force:true});delete process.env.EMPLOYEE_DB_PATH;delete process.env.EMPLOYEE_DATA_DIR;restore();await svc.close();});
 const login=async(token:string)=>{const r=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token})});return {cookie:r.headers.get('set-cookie')!.split(';')[0],csrf:(await r.json()).csrf as string};};
 const a=await login('fixture-a'),b=await login('fixture-b');
 svc.status['bu-0']='running';
 const c=e.db.put('alice','computer',{id:'comp-1',runId:'run-1',status:'working',providerId:'bu-0',providerSession:'sess-1',control:'agent',liveUrl:'https://live.browser-use.com/v?s=1',liveEmbed:'https://live.browser-use.com/v?s=1'});
 const post=(p:string,s:{cookie:string;csrf?:string})=>fetch(base+p,{method:'POST',headers:{'content-type':'application/json',cookie:s.cookie,...(s.csrf?{'x-csrf-token':s.csrf}:{})},body:'{}'});
 assert.equal((await post(`/api/computers/${c.id}/takeover`,{cookie:a.cookie})).status,403,'no CSRF token, no take-over');
 assert.equal((await post(`/api/computers/${c.id}/takeover`,b)).status,404,'another owner cannot even tell it exists');
 assert.deepEqual(svc.calls,[],'nothing reached the provider for either refusal');
 const ok=await post(`/api/computers/${c.id}/takeover`,a);assert.equal(ok.status,200);
 const body=await ok.json();assert.deepEqual(body,{id:'comp-1',status:'working',control:'owner'});
 assert.equal(JSON.stringify(body).includes('live.browser-use.com'),false,'the reply does not repeat the live link');
 assert.equal((await post(`/api/computers/${c.id}/handback`,a)).status,200);
 assert.deepEqual(svc.calls,['cancel:bu-0'],'taking over stopped the employee\'s run');
 assert.equal(svc.created[0]?.sessionId,'sess-1','handing back started a follow-up in the same session');
 svc.refuse.add('cancel');
 const refused=await post(`/api/computers/${c.id}/takeover`,a);assert.equal(refused.status,409);
 assert.match((await refused.json()).error.message,/still driving/);
});

test('the phone app may frame a live view host and nothing else, and still runs no inline script',async()=>{
 const {appContentSecurityPolicy}=await import('../src/csp.js');
 const csp=appContentSecurityPolicy();
 assert.match(csp,/frame-src https:\/\/browser-use\.com https:\/\/\*\.browser-use\.com https:\/\/browserbase\.com https:\/\/\*\.browserbase\.com;/);
 assert.doesNotMatch(csp,/frame-src[^;]*https:;/,'no longer any https page at all');
 assert.match(csp,/script-src 'self';/);
 assert.match(csp,/frame-ancestors 'none'/,'and nobody may frame the app itself');
});

// Voice and camera connect straight from the phone to LiveKit. A LiveKit on the same computer speaks plain ws:,
// which the policy blocked, so a local conversation could never start.
test('the phone app may connect to the configured LiveKit server, and the setting adds nothing else',async()=>{
 const {appContentSecurityPolicy}=await import('../src/csp.js');
 const before=process.env.LIVEKIT_URL;
 try{
  process.env.LIVEKIT_URL='ws://127.0.0.1:7880';
  assert.match(appContentSecurityPolicy(),/connect-src 'self' wss: ws:\/\/127\.0\.0\.1:7880 http:\/\/127\.0\.0\.1:7880;/);
  process.env.LIVEKIT_URL='wss://visionbot.livekit.cloud/some/path?x=1';
  // LiveKit Cloud also checks a failed connection with its regional host over https; that, and only that, is added.
  assert.match(appContentSecurityPolicy(),/connect-src 'self' wss: wss:\/\/visionbot\.livekit\.cloud https:\/\/visionbot\.livekit\.cloud https:\/\/\*\.livekit\.cloud;/,'the origin, and Cloud\'s regional hosts');
  process.env.LIVEKIT_URL='wss://livekit.example.com';
  assert.match(appContentSecurityPolicy(),/connect-src 'self' wss: wss:\/\/livekit\.example\.com https:\/\/livekit\.example\.com;/,'a self-hosted LiveKit adds just its origin');
  for(const bad of ["ws://a.example; script-src *","https://livekit.example","not a url"]){
   process.env.LIVEKIT_URL=bad;assert.match(appContentSecurityPolicy(),/connect-src 'self' wss:;/,bad);
  }
 }finally{if(before===undefined)delete process.env.LIVEKIT_URL;else process.env.LIVEKIT_URL=before;}
});

// A restart leaves nothing driving or watching a browser that was open. Its record must not keep the only slot,
// and an old queued request must not hold up every browser request behind it.
test('after a restart, browsers left open are stopped at their provider and their slots freed',async t=>{
 const svc=await browserUse(),restore=env(svc),db=new Store(':memory:'),released:string[]=[];
 const driven={release:async(owner:string,id:string,status:'closed'|'cancelled')=>{released.push(id);const {liveUrl:_u,liveEmbed:_e,...rest}=db.get(owner,'computer',id)!;db.put(owner,'computer',{...rest,status});}};
 t.after(async()=>{restore();db.close();await svc.close();});
 const LIVE='https://live.browser-use.com/view?session=abc',BB='https://www.browserbase.com/devtools/view';svc.status['bu-7']='running';
 const working=db.create('alice','computer',{runId:'run-1',status:'working',providerId:'bu-7',providerSession:'sess-1',control:'agent',liveUrl:LIVE,liveEmbed:LIVE});
 const queued=db.create('bob','computer',{runId:'run-2',status:'queued',task:'Look'});
 const driving=db.create('alice','computer',{runId:'run-3',status:'working',provider:'browserbase',providerId:'bb-1',control:'owner',liveUrl:BB,liveEmbed:BB});
 const done=db.create('alice','computer',{runId:'run-4',status:'closed'});
 await new BrowserCapability(db,driven).recover(20);
 assert.deepEqual(svc.calls,['cancel:bu-7'],'the Browser Use run is stopped at the provider');
 assert.deepEqual(released,[driving.id],'the Browserbase session is released');
 for(const [owner,id] of [['alice',working.id],['bob',queued.id],['alice',driving.id]] as const){
  const r=db.get(owner,'computer',id)!;assert.ok(['cancelled','closed'].includes(r.status),`${id} is no longer open`);assert.equal(r.liveEmbed,undefined,'and nobody holds its live link');
 }
 assert.equal(db.get('alice','computer',done.id)?.status,'closed','a browser already closed is left alone');
 const ticket=db.create('carol','computer',{runId:'run-5',status:'queued'});
 await waitForBrowserSlot(db,ticket,()=>{},Date.now()+1000);   // throws if anything from before the restart still holds the queue
});

test('after a restart, a browser that cannot be confirmed stopped is tried once more, then let go',async t=>{
 const svc=await browserUse(),restore=env(svc),db=new Store(':memory:');
 t.after(async()=>{restore();db.close();await svc.close();});
 svc.status['bu-9']='running';svc.refuse.add('cancel');
 const stale=db.create('alice','computer',{runId:'run-1',status:'working',providerId:'bu-9',control:'agent'});
 const recovering=new BrowserCapability(db).recover(300);
 await waitFor(()=>db.get('alice','computer',stale.id)?.status==='cleanup_pending','the first attempt');
 const fresh=db.create('alice','computer',{runId:'run-2',status:'working',providerId:'bu-10',control:'agent'});
 await recovering;
 assert.deepEqual(svc.calls,['cancel:bu-9','cancel:bu-9'],'tried twice, and nothing started since was touched');
 assert.equal(db.get('alice','computer',stale.id)?.status,'cancelled','then its slot is freed');
 assert.equal(db.get('alice','computer',fresh.id)?.status,'working','a browser started after the restart keeps running');
});

test('the gateway frees browsers left open by its previous process when it starts',async t=>{
 const svc=await browserUse(),restore=env(svc);
 const dir=mkdtempSync(path.join(os.tmpdir(),'vc-browser-boot-'));process.env.EMPLOYEE_DATA_DIR=dir;process.env.EMPLOYEE_DB_PATH=path.join(dir,'employee.sqlite');initStore(path.join(dir,'legacy.json'));
 const before=new Store(process.env.EMPLOYEE_DB_PATH);const left=before.create('alice','computer',{runId:'run-1',status:'queued',task:'Look'});before.close();
 const e=installEmployee(express(),()=>null,()=>false,async()=>({result:'ok'}));
 t.after(async()=>{e.stop();e.db.close();rmSync(dir,{recursive:true,force:true});delete process.env.EMPLOYEE_DB_PATH;delete process.env.EMPLOYEE_DATA_DIR;restore();await svc.close();});
 await waitFor(()=>e.db.get('alice','computer',left.id)?.status==='cancelled','the stale browser to be freed');
});
