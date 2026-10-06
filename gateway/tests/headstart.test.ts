import {test} from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {spawn,type ChildProcess} from 'node:child_process';import {mkdtempSync,rmSync,existsSync} from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Store} from '../src/employee/db.js';import {ToolGateway} from '../src/employee/tools.js';import {BrowserbaseBrowsers} from '../src/employee/browserbase.js';import {BrowserCapability} from '../src/employee/browser.js';
import {ruleRoute,routeTask,jevRoute,searchQuery} from '../src/employee/route.js';import {search,searchApi} from '../src/employee/web.js';import {HeadStart} from '../src/employee/headstart.js';import {RunQueue} from '../src/employee/runs.js';
import {employeeContext} from '../src/employee/capabilities.js';

const env=(vars:Record<string,string|undefined>)=>{const saved=Object.fromEntries(Object.keys(vars).map(k=>[k,process.env[k]]));for(const [k,v] of Object.entries(vars))if(v===undefined)delete process.env[k];else process.env[k]=v;return ()=>{for(const [k,v] of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;};};
const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json'}});

test('the rules route at once: stores and prices to a live browser at the store, apps and actions away from it',()=>{
 const cases:[string,string,boolean][]=[
  ['Find prices for drywall at Home Depot','procurement_browser',true],['How much is a Moen 1222 cartridge?','procurement_browser',true],['Is 1/2 inch plywood in stock at Lowe\'s near me','procurement_browser',true],
  ['Open https://permits.example.gov and check permit 4411','visible_browser',true],['Fill out the warranty form on the Carrier website','visible_browser',true],
  ['What is the weather forecast for Austin today','search_then_answer',true],['Check my Gmail for owner emails','connected_app',false],['Text Sam that I am on my way','approval_action',false],
  ['Write a friendly note thanking a tenant','quick_answer',false]];
 for(const [task,route,browser] of cases){const r=ruleRoute(task);assert.equal(r.route,route,task);assert.equal(r.needsVisibleBrowser,browser,task);}
 const hd=ruleRoute('Find prices for drywall at Home Depot');assert.equal(hd.startUrl,'https://www.homedepot.com/s/drywall');assert.equal(hd.session,'guest');
 assert.equal(ruleRoute('Check the status of my order on Amazon').session,'account','a task about the owner\'s own account uses their sign-ins');
 assert.equal(ruleRoute('Look at https://example.com/a?b=1 please').startUrl,'https://example.com/a?b=1');
 assert.equal(searchQuery('Can you find me prices for 5/8 drywall at Home Depot?'),'prices for 5/8 drywall');
});

test('Jev is asked only where the rules guessed, within a time limit, and its pick is used only when it is sure',async()=>{
 const restore=env({TYPESAFE_API_KEY:'ts_fixture_key_0123456789',TYPESAFE_API_BASE:'https://jev.test',JEV_TIMEOUT_MS:'300'});
 try{
  const asked:any[]=[];let reply:any={answers:{route:{type:'choice',choice:'procurement_browser',confidence:0.92}}},delay=0;
  const http=(async(url:string,init:RequestInit)=>{asked.push({url,init,body:JSON.parse(String(init.body))});if(delay)await new Promise((r,j)=>{const t=setTimeout(r,delay);init.signal?.addEventListener('abort',()=>{clearTimeout(t);j(init.signal!.reason);});});return json(reply);}) as typeof fetch;
  const r=await routeTask('Need something for the leaky bathroom sink, compare options',http);
  assert.equal(r.route,'procurement_browser');assert.equal(r.source,'jev');assert.equal(r.needsVisibleBrowser,true);
  assert.equal(asked[0].url,'https://jev.test/v1/systemone');assert.equal(new Headers(asked[0].init.headers).get('authorization'),'Bearer ts_fixture_key_0123456789');
  assert.equal(asked[0].body.questions.route.type,'choice');assert.deepEqual(Object.keys(asked[0].body.questions.route.criteria).length,6);
  asked.length=0;await routeTask('Find prices for drywall at Home Depot',http);assert.equal(asked.length,0,'a certain rule needs no second opinion');
  reply={answers:{route:{type:'choice',choice:'visible_browser',confidence:0.31}}};assert.equal(await jevRoute('something vague',http),null,'unsure is no answer');
  reply={answers:{route:{type:'choice',choice:'launch_rockets',confidence:0.99}}};assert.equal(await jevRoute('something vague',http),null,'an unknown route is no answer');
  reply={answers:{route:{type:'choice',choice:'visible_browser',confidence:0.99}}};delay=2000;const t0=Date.now();
  const slow=await routeTask('Need something for the leaky bathroom sink, compare options',http);assert.ok(Date.now()-t0<1000,'a slow Jev never holds the task up');assert.equal(slow.source,'rules');
 }finally{restore();}
});

test('each search API gets the request it expects, the key in a header, and its answer is read back',async()=>{
 const sent:any[]=[];const http=(async(url:string,init:RequestInit={})=>{sent.push({url,init});const u=String(url);
  if(u.includes('tavily'))return json({answer:'About $15 a sheet.',results:[{title:'Drywall',url:'https://a.example/d',content:'1/2 in. $14.98'}]});
  if(u.includes('serper'))return json({organic:[{title:'Drywall',link:'https://b.example/d',snippet:'$15.28'}]});
  if(u.includes('exa.ai'))return json({results:[{title:'Drywall',url:'https://c.example/d',highlights:['$13.50 per sheet']}]});
  return json({web:{results:[{title:'Drywall',url:'https://d.example/d',description:'$16'}]}});}) as typeof fetch;
 for(const [provider,host,first,snippet] of [['tavily','api.tavily.com','https://a.example/d','1/2 in. $14.98'],['serper','google.serper.dev','https://b.example/d','$15.28'],['exa','api.exa.ai','https://c.example/d','$13.50 per sheet'],['brave','api.search.brave.com','https://d.example/d','$16']] as const){
  const restore=env({SEARCH_API_KEY:'search_fixture_key_0123456789',SEARCH_PROVIDER:provider,SEARCH_ENDPOINT:undefined});
  try{sent.length=0;assert.equal(searchApi(),provider);const r=await search('drywall price',http);
   assert.equal(new URL(sent[0].url).hostname,host);assert.ok(!sent[0].url.includes('search_fixture_key'),'the key is never in the address');
   assert.ok(JSON.stringify(sent[0].init.headers).includes('search_fixture_key_0123456789'));
   assert.equal(r.results[0]!.url,first);assert.equal(r.results[0]!.snippet,snippet);
   if(provider==='tavily')assert.equal(r.answer,'About $15 a sheet.');
   if(provider!=='brave')assert.equal(sent[0].init.method,'POST');
  }finally{restore();}
 }
 const restore=env({SEARCH_PROVIDER:undefined,SEARCH_ENDPOINT:'https://api.tavily.com/search'});try{assert.equal(searchApi(),'tavily','the endpoint names the provider when SEARCH_PROVIDER does not');}finally{restore();}
});

// ------------------------------------------------------------------ the head start, against a real browser
const CHROMIUM=process.env.CHROMIUM_PATH??'/opt/pw-browsers/chromium';
const skip=existsSync(CHROMIUM)?false:'no Chromium to stand in for the remote browser (set CHROMIUM_PATH)';
const LIVE='https://www.browserbase.com/devtools-fullscreen/inspector.html?wss=connect.browserbase.com/debug/bb-1';
function site(){const server=createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(`<!doctype html><title>Drywall 1/2 in. 4x8</title><h1>Drywall 1/2 in. 4x8</h1><p>$14.98 each, 212 in stock</p><p>${req.url}</p>`);});server.listen(0,'127.0.0.1');return new Promise<{url:string;close():void}>(r=>server.on('listening',()=>r({url:`http://127.0.0.1:${(server.address() as any).port}`,close:()=>{server.closeAllConnections();server.close();}})));}
function chromium(dir:string){return new Promise<{ws:string;proc:ChildProcess}>((resolve,reject)=>{const proc=spawn(CHROMIUM,['--headless=new','--no-sandbox','--remote-debugging-port=0',`--user-data-dir=${dir}`,'--no-proxy-server','about:blank'],{stdio:['ignore','ignore','pipe'],detached:true});let err='';proc.stderr!.on('data',d=>{err+=d;const m=err.match(/DevTools listening on (ws:\/\/\S+)/);if(m)resolve({ws:m[1]!,proc});});proc.on('exit',()=>reject(Error('Chromium exited: '+err.slice(-300))));});}
function browserbaseApi(connectUrl:string){
 const seen={created:[] as any[],released:[] as any[],contexts:[] as number[]};
 const server=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=raw?JSON.parse(raw):{};const out=(v:unknown)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(v));};
  if(req.method==='POST'&&req.url==='/v1/contexts'){seen.contexts.push(1);return out({id:'ctx-1'});}
  if(req.method==='POST'&&req.url==='/v1/sessions'){seen.created.push(body);await new Promise(r=>setTimeout(r,50));return out({id:`bb-${seen.created.length}`,connectUrl});}
  const m=req.url?.match(/^\/v1\/sessions\/([^/?]+)(\/debug)?/);if(!m){res.statusCode=404;return res.end('{}');}
  if(m[2])return out({debuggerFullscreenUrl:LIVE});if(req.method==='POST'){seen.released.push(m[1]);return out({id:m[1]});}out({id:m[1]});});
 server.listen(0,'127.0.0.1');return new Promise<typeof seen&{url:string;close():void}>(r=>server.on('listening',()=>r({...seen,url:`http://127.0.0.1:${(server.address() as any).port}`,close:()=>{server.closeAllConnections();server.close();}})));
}
const stop=async(proc:ChildProcess)=>{if(proc.exitCode!==null)return;const exited=new Promise(r=>proc.once('exit',r));try{process.kill(-proc.pid!,'SIGKILL');}catch{proc.kill('SIGKILL');}await exited;};
const until=async(check:()=>boolean,what:string,ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,25));}throw Error(`Timed out waiting for ${what}`);};

test('a web task gets its live browser and a quick search at once, before the employee starts, and the employee picks both up',{skip,timeout:120000},async t=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'vc-hs-')),shop=await site(),remote=await chromium(dir),api=await browserbaseApi(remote.ws);
 const restore=env({BROWSERBASE_API_KEY:'fixture-browserbase-key-0123456789',BROWSERBASE_API_BASE:api.url,SEARCH_API_KEY:'search_fixture_key_0123456789',SEARCH_PROVIDER:'tavily',TYPESAFE_API_KEY:undefined,HEADSTART_BROWSER:undefined});
 const db=new Store(':memory:'),tools=new ToolGateway(db),bb=new BrowserbaseBrowsers(db);bb.register(tools);const computers=new BrowserCapability(db,bb);
 t.after(async()=>{for(const c of db.list('alice','computer'))await bb.release('alice',c.id,'closed').catch(()=>{});db.close();shop.close();api.close();await stop(remote.proc);rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});restore();});
 const searchHttp=(async()=>{await new Promise(r=>setTimeout(r,30));return json({answer:'1/2 in. drywall is about $15 a sheet.',results:[{title:'Drywall 1/2 in. 4x8',url:`${shop.url}/drywall`,content:'$14.98 each'}]});}) as typeof fetch;
 const head=new HeadStart(db,bb,searchHttp);let started=0;
 const q=new RunQueue(db,async(owner,run,signal)=>{await head.ready(run.id);started=Date.now();const latest=db.get(owner,'run',run.id)!;
  // The employee reads the page the head start opened, without opening a browser of its own.
  const page=await tools.wait(owner,run.id,'browser_read',{},'read-1',signal);return {result:`${employeeContext(db,owner,latest).includes('do not call browser_open')?'reused':'not told'} | ${page.text.match(/\$[^\n]*stock/)?.[0]}`};});
 q.onCreated=(owner,run)=>head.begin(owner,run);
 const t0=Date.now();const run=q.create('alice',{task:'Find prices for 1/2 inch drywall',context:{source:'phone'}},'k1');
 await until(()=>db.list('alice','computer').length>0,'the browser record');assert.ok(Date.now()-t0<1000,`the browser shows within a second (${Date.now()-t0}ms)`);
 await until(()=>db.list('alice','computer')[0]!.status==='working','the live view');
 const c=db.list('alice','computer')[0]!;assert.equal(c.liveEmbed,LIVE);assert.equal(c.session,'guest');assert.equal(c.runId,run.id);
 void q.tick();await until(()=>db.get('alice','run',run.id)!.status==='completed','the task',30000);
 const done=db.get('alice','run',run.id)!;
 assert.equal(done.route.route,'procurement_browser');assert.equal(done.preview,'1/2 in. drywall is about $15 a sheet.','early findings land before the answer');
 assert.equal(done.findings.sources[0].url,`${shop.url}/drywall`);assert.ok(done.browserAt.startsWith(`${shop.url}/drywall`),'the browser went to the best result');
 assert.deepEqual(done.progress.map((p:any)=>p.text.replace(/[\d.]+s$/,'Ns')),['Checking stores and prices','Opening a live browser…','Found 1 source in Ns',`Opening 127.0.0.1…`,'Reading 127.0.0.1']);
 assert.match(done.result,/^reused \| \$14\.98 each, 212 in stock$/);
 assert.equal(api.created.length,1,'one browser for the task, shared by the head start and the employee');
 assert.ok(db.list('alice','artifact').some(a=>a.kind==='search_results'));
 await computers.cleanup();assert.ok(db.list('alice','computer')[0]!.lingerUntil,'kept open after the answer');assert.equal(api.released.length,0);
});

test('the head start respects the owner: no browser when they said never, and saved sign-ins only when they said always',{skip,timeout:120000},async t=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'vc-hs2-')),remote=await chromium(dir),api=await browserbaseApi(remote.ws);
 const restore=env({BROWSERBASE_API_KEY:'fixture-browserbase-key-0123456789',BROWSERBASE_API_BASE:api.url,SEARCH_API_KEY:undefined,GEMINI_API_KEY:undefined,GOOGLE_API_KEY:undefined,TYPESAFE_API_KEY:undefined,EMPLOYEE_DATA_DIR:dir,SIGNIN_VAULT_KEY:'v'.repeat(40)});
 const db=new Store(':memory:'),bb=new BrowserbaseBrowsers(db),head=new HeadStart(db,bb);const q=new RunQueue(db,async()=>({result:'x'}));q.onCreated=(o,r)=>head.begin(o,r);
 t.after(async()=>{for(const o of ['alice','bob'])for(const c of db.list(o,'computer'))await bb.release(o,c.id,'closed').catch(()=>{});db.close();api.close();await stop(remote.proc);rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});restore();});
 db.put('alice','policy',{id:'p-a',tool:'browser_open',policy:'never'});
 const a=q.create('alice',{task:'Find prices for drywall at Home Depot'},'k1');await head.ready(a.id);
 assert.equal(db.list('alice','computer').length,0);assert.equal(api.created.length,0);
 db.put('bob','policy',{id:'p-b',tool:'browser_open',policy:'allow'});
 const b=q.create('bob',{task:'Check the status of my order on Amazon'},'k2');await head.ready(b.id,30000);
 assert.equal(db.list('bob','computer')[0]!.session,'account');
 q.cancel('bob',b.id);await new BrowserCapability(db,bb).cleanup();assert.equal(api.released.length,1,'a stopped task\'s browser closes at once, not after the linger');
 const c=q.create('bob',{task:'Find prices for drywall at Home Depot'},'k3');await head.ready(c.id,30000);
 assert.equal(db.list('bob','computer').at(0)!.session,'guest','a guest browser carries no sign-ins');
 // A task stopped before its browser was needed opens nothing more.
 const d=q.create('bob',{task:'Find prices for tile at Lowe\'s'},'k4');q.cancel('bob',d.id);await head.ready(d.id,5000);
 assert.ok(!db.list('bob','computer').some(x=>x.runId===d.id&&x.status==='working'));
});
